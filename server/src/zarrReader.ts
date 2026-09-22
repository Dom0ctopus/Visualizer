import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Blosc from 'numcodecs/blosc'
import { type Level, type TypedArray, type TypedArrayConstructor } from './zarrWriter.js'

interface ZarrArrayMeta {
  shape: [number, number, number] // z, y, x -- see zarrWriter.ts's writeZarrArrayV2
  chunks: [number, number, number]
  dtype: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compressor: any
}

interface OmeZarrDataset {
  path: string
  coordinateTransformations: Array<{ type: string; scale?: number[]; translation?: number[] }>
}

interface OmeZarrAttrs {
  multiscales: Array<{ datasets: OmeZarrDataset[] }>
}

/** Mirrors src/lib/zarrClient.ts's dtypeCtor -- kept separate since this
 *  reads zarr back into Node Buffers rather than fetch() ArrayBuffers, but
 *  the dtype string vocabulary (zarrWriter.ts's zarrDtypeFor) is identical. */
function dtypeCtor(dtype: string): TypedArrayConstructor {
  switch (dtype) {
    case '|u1':
      return Uint8Array
    case '|i1':
      return Int8Array
    case '<u2':
      return Uint16Array
    case '<i2':
      return Int16Array
    case '<u4':
      return Uint32Array
    case '<i4':
      return Int32Array
    case '<f4':
      return Float32Array
    case '<f8':
      return Float64Array
    default:
      throw new Error(`Unsupported zarr dtype: ${dtype}`)
  }
}

export interface ZarrLevelInfo {
  index: number
  levelPath: string
  /** [z, y, x], this level's own voxel dimensions. */
  size: [number, number, number]
  dtype: string
  /** [z, y, x] physical origin (mm), from this level's own NGFF
   *  "translation" transform -- see zarrWriter.ts's writeMultiscaleGroup. */
  origin: [number, number, number]
  /** [z, y, x] physical voxel size (mm), this level's own NGFF "scale". */
  spacing: [number, number, number]
}

/** Lists every pyramid level's own geometry directly from disk -- the
 *  server-side, filesystem-reading counterpart to src/lib/zarrClient.ts's
 *  fetchPyramidLevels (which reads the same NGFF metadata over HTTP from
 *  the browser). Used by segmentationMergeConvert.ts to pick a reference
 *  resolution and align each input layer to it by physical position. */
export async function readZarrLevels(zarrGroupPath: string): Promise<ZarrLevelInfo[]> {
  const attrs = JSON.parse(await readFile(path.join(zarrGroupPath, '.zattrs'), 'utf8')) as OmeZarrAttrs
  const datasets = attrs.multiscales[0].datasets
  const levels: ZarrLevelInfo[] = []
  for (let i = 0; i < datasets.length; i++) {
    const levelPath = datasets[i].path
    const zarray = JSON.parse(await readFile(path.join(zarrGroupPath, levelPath, '.zarray'), 'utf8')) as ZarrArrayMeta
    const scale = datasets[i].coordinateTransformations.find((t) => t.type === 'scale')?.scale ?? [1, 1, 1]
    const translation = datasets[i].coordinateTransformations.find((t) => t.type === 'translation')?.translation ?? [0, 0, 0]
    levels.push({
      index: i,
      levelPath,
      size: zarray.shape,
      dtype: zarray.dtype,
      spacing: [scale[0], scale[1], scale[2]],
      origin: [translation[0], translation[1], translation[2]]
    })
  }
  return levels
}

/**
 * Reads one whole zarr array level into a single in-memory Level (X
 * fastest-varying, matching zarrWriter.ts's own Level convention), decoding
 * every chunk file. Only intended for levels small enough to comfortably
 * hold in memory at once -- callers (segmentationMergeConvert.ts) pick a
 * suitably coarse reference level specifically so this is always true, the
 * same way the rest of this codebase already holds one whole pyramid level
 * in memory at a time during conversion.
 */
export async function readWholeZarrLevel(zarrGroupPath: string, level: ZarrLevelInfo): Promise<Level> {
  const levelDir = path.join(zarrGroupPath, level.levelPath)
  const zarray = JSON.parse(await readFile(path.join(levelDir, '.zarray'), 'utf8')) as ZarrArrayMeta
  const [shapeZ, shapeY, shapeX] = zarray.shape
  const [chunkZ, chunkY, chunkX] = zarray.chunks
  const ctor = dtypeCtor(zarray.dtype)
  const codec = zarray.compressor ? Blosc.fromConfig(zarray.compressor) : null

  const out = new ctor(shapeX * shapeY * shapeZ) as TypedArray
  const nChunksZ = Math.ceil(shapeZ / chunkZ)
  const nChunksY = Math.ceil(shapeY / chunkY)
  const nChunksX = Math.ceil(shapeX / chunkX)

  for (let bz = 0; bz < nChunksZ; bz++) {
    for (let by = 0; by < nChunksY; by++) {
      for (let bx = 0; bx < nChunksX; bx++) {
        let raw: Uint8Array
        try {
          const compressed = await readFile(path.join(levelDir, `${bz}.${by}.${bx}`))
          raw = codec ? ((await codec.decode(new Uint8Array(compressed))) as Uint8Array) : new Uint8Array(compressed)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // every chunk is written by this app's own writer, but tolerate a missing one as all-fill (0)
          throw e
        }
        const chunkData = new ctor(raw.buffer, raw.byteOffset, raw.byteLength / ctor.BYTES_PER_ELEMENT)
        const rowLen = Math.min(chunkX, shapeX - bx * chunkX)
        const rowsInChunk = Math.min(chunkY, shapeY - by * chunkY)
        const slicesInChunk = Math.min(chunkZ, shapeZ - bz * chunkZ)
        for (let z = 0; z < slicesInChunk; z++) {
          const gz = bz * chunkZ + z
          for (let y = 0; y < rowsInChunk; y++) {
            const gy = by * chunkY + y
            const srcOffset = z * chunkY * chunkX + y * chunkX
            const dstOffset = gz * shapeY * shapeX + gy * shapeX + bx * chunkX
            out.set(chunkData.subarray(srcOffset, srcOffset + rowLen), dstOffset)
          }
        }
      }
    }
  }
  return { data: out, size: [shapeX, shapeY, shapeZ] }
}

/** Picks the finest (smallest-index) level whose total voxel count doesn't
 *  exceed `budget`, falling back to the coarsest available level if even
 *  that doesn't fit -- used both for the merge's own output reference grid
 *  (bounded well under itk-vtk-viewer's known voxel cap) and for choosing
 *  which of an input layer's own levels to read. */
export function pickLevelUnderBudget(levels: ZarrLevelInfo[], budget: number): ZarrLevelInfo {
  const sorted = [...levels].sort((a, b) => a.index - b.index)
  for (const level of sorted) {
    const voxels = level.size[0] * level.size[1] * level.size[2]
    if (voxels <= budget) return level
  }
  return sorted[sorted.length - 1]
}
