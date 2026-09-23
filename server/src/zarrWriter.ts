import Blosc from 'numcodecs/blosc'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeOrthogonalCopies } from './orthogonalCopies.js'

// How many voxels wide/tall/deep the smallest pyramid level should still be,
// and the hard cap on how many levels we generate for a very large volume --
// matches typical multiscale viewers (a handful of halvings is enough for any
// reasonable screen size) without walking all the way down to a 1-voxel cube.
const MIN_LEVEL_DIMENSION = 48
const MAX_LEVELS = 6

// itk-vtk-viewer enforces a hard cap on how many voxels it will decode for
// a single image update -- confirmed empirically via its own console error
// ("Voxel count over max ... Max: 268435456", exactly 2^28), not a
// documented option. This was originally (mis-)understood to be sensitive to
// chunk size -- it isn't: rigorous testing (changing chunk size while
// holding everything else fixed) showed the exact same "Requested" voxel
// count regardless of chunk size, proving the cap is on a pyramid *level*'s
// total voxel count, not on how that level happens to be chunked. It governs
// which level the Volume pane can load, so cube-ish chunk sizing here is
// purely about making a whole level's worth of chunks cheap to fetch
// together for that pane -- it has no bearing on the cap itself. Only
// coarser (non-finest) levels use this: the finest level is chunked for
// slice reads instead (see finestChunkShape below), since the Volume pane
// never loads scale0 on real-world scan sizes anyway.
const MIN_CHUNK_SIZE = 4
const MAX_CHUNK_SIZE = 64
const CUBE_CHUNK_VOXEL_BUDGET = 268_435_456 * 0.5

function chunkSizeFor(size: readonly [number, number, number]): number {
  const [a, b] = [...size].sort((x, y) => y - x)
  const largestInPlaneProduct = a * b
  const budget = Math.floor(CUBE_CHUNK_VOXEL_BUDGET / largestInPlaneProduct)
  return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, budget))
}

// The custom slice viewer (src/lib/zarrClient.ts's readZSlice) starts at
// pyramid level 1 (2x downsampled) rather than level 0 -- native-resolution
// per-slice reads had a real per-step latency floor that turned out to
// persist even after ruling out every specific cause found (chunk layout,
// cache growth, cloud-sync storage, Node's I/O thread pool size). It's
// since grown a level picker (native/2x/4x/8x, for fast fly-through
// browsing at whichever resolution the user wants) plus the ability to
// drill into a bounded native-resolution window around a chosen slice --
// see useZarrSliceViewer.ts's setLevel/inspectNativeHere. Every level that
// picker exposes needs this same chunking, or switching to it would
// silently reintroduce the many-small-chunks-per-slice problem below.
//
// Chunking small cubes (like the levels past SLICE_OPTIMIZED_LEVEL_COUNT
// still use) meant a single slice read had to fetch+blosc-decode every
// small X/Y tile spanning the slice's full width and height -- dozens of
// small requests for one slice. Since chunk size has no bearing on the
// Volume pane's voxel cap (see above) and these levels are never read by
// that pane, they're free to be optimized purely for slice reads instead:
// one chunk per Z index, so reading any slice is always exactly one chunk
// fetch with zero wasted bytes.
//
// That full-extent chunk is capped in bytes, though: a genuinely native-
// resolution scan can be tens of thousands of pixels per side, which would
// otherwise make every single chunk write a many-hundred-megabyte blosc
// encode call -- risking exhausting the blosc WASM module's linear memory
// (which only ever grows, never shrinks, across the many thousands of
// sequential calls one conversion makes) well before any single call's own
// size would trip a hard limit. Splitting into full-width row bands once a
// full slice would exceed this keeps every encode call bounded, at the cost
// of a handful of chunk fetches per slice instead of one -- only for scans
// large enough to need it; a typical scan's full slice still fits under this
// easily and keeps the single-chunk-per-Z behavior unchanged.
const MAX_SLICE_CHUNK_BYTES = 64 * 1024 * 1024

// How many of the finest pyramid levels (0-indexed, counting from the
// finest) get the slice-optimized chunking above -- must cover every level
// the slice viewer's level picker exposes (native/2x/4x/8x -- see
// src/lib/zarrClient.ts and useZarrSliceViewer.ts). Levels past this stay
// on the cube-ish chunking below, unaffected (they're deep enough into the
// pyramid that the Volume pane picking one to load whole is far more
// likely, and cube chunking is friendlier to loading a whole level's worth
// of chunks together than one-chunk-per-Z is).
export const SLICE_OPTIMIZED_LEVEL_COUNT = 4

function sliceOptimizedChunkShape(size: readonly [number, number, number], bytesPerElement: number): [number, number, number] {
  const [sx, sy] = size
  const bytesPerRow = sx * bytesPerElement
  const maxRows = Math.max(1, Math.floor(MAX_SLICE_CHUNK_BYTES / bytesPerRow))
  const chunkY = Math.min(sy, maxRows)
  return [1, chunkY, sx] // [z, y, x], matching writeZarrArrayV2's chunkShape order
}

// Both itk-vtk-viewer and @itk-viewer/io's zarr readers unconditionally
// blosc-decompress every chunk regardless of what a .zarray's own
// "compressor" field says -- writing plain/uncompressed chunks (compressor:
// null, which is otherwise valid Zarr v2) silently decodes to nothing, no
// error, just an image object with no voxel data. So every chunk below is
// actually blosc-compressed, and the .zarray compressor descriptor mirrors
// these exact codec parameters (Zarr v2 requires that: readers configure
// their decompressor from that metadata).
const BLOSC_CONFIG = { id: 'blosc', cname: 'zstd', clevel: 5, shuffle: 1 } as const
const bloscCodec = Blosc.fromConfig(BLOSC_CONFIG)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TypedArrayConstructor = (new (...args: any[]) => TypedArray) & { BYTES_PER_ELEMENT: number }
export type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array

/** size is [x, y, z] (ITK convention, fastest-varying axis first); data is a
 *  flat z-major (C-order) buffer matching that -- index = z*sy*sx + y*sx + x. */
export interface Level {
  data: TypedArray
  size: [number, number, number]
}

export function zarrDtypeFor(componentType: string): { dtype: string; ctor: TypedArrayConstructor } {
  switch (componentType) {
    case 'uint8':
      return { dtype: '|u1', ctor: Uint8Array }
    case 'int8':
      return { dtype: '|i1', ctor: Int8Array }
    case 'uint16':
      return { dtype: '<u2', ctor: Uint16Array }
    case 'int16':
      return { dtype: '<i2', ctor: Int16Array }
    case 'uint32':
      return { dtype: '<u4', ctor: Uint32Array }
    case 'int32':
      return { dtype: '<i4', ctor: Int32Array }
    case 'float32':
      return { dtype: '<f4', ctor: Float32Array }
    case 'float64':
      return { dtype: '<f8', ctor: Float64Array }
    default:
      throw new Error(`Unsupported voxel component type: ${componentType}`)
  }
}

export type DownsampleFn = (level: Level, ctor: TypedArrayConstructor) => Level

// Halves each axis by averaging 2x2x2 blocks, clamping at the edge for odd
// dimensions (so the last row/column/slice is duplicated rather than reading
// out of bounds) -- a plain box filter is enough for a first working
// multiscale pyramid; it does not need to match any particular viewer's own
// antialiasing choice since these levels exist purely for GPU memory
// savings, not for their own visual fidelity. Only valid for continuous
// intensity data -- see downsample2xNearest for label maps.
export function downsample2xAverage(level: Level, ctor: TypedArrayConstructor): Level {
  const [sx, sy, sz] = level.size
  const dx = Math.max(1, Math.floor(sx / 2))
  const dy = Math.max(1, Math.floor(sy / 2))
  const dz = Math.max(1, Math.floor(sz / 2))
  const src = level.data
  const out = new ctor(dx * dy * dz)
  for (let z = 0; z < dz; z++) {
    const z0 = Math.min(z * 2, sz - 1)
    const z1 = Math.min(z * 2 + 1, sz - 1)
    for (let y = 0; y < dy; y++) {
      const y0 = Math.min(y * 2, sy - 1)
      const y1 = Math.min(y * 2 + 1, sy - 1)
      const rowBase0 = z0 * sy * sx + y0 * sx
      const rowBase1 = z0 * sy * sx + y1 * sx
      const rowBase2 = z1 * sy * sx + y0 * sx
      const rowBase3 = z1 * sy * sx + y1 * sx
      const outRowBase = z * dy * dx + y * dx
      for (let x = 0; x < dx; x++) {
        const x0 = Math.min(x * 2, sx - 1)
        const x1 = Math.min(x * 2 + 1, sx - 1)
        const sum =
          src[rowBase0 + x0] +
          src[rowBase0 + x1] +
          src[rowBase1 + x0] +
          src[rowBase1 + x1] +
          src[rowBase2 + x0] +
          src[rowBase2 + x1] +
          src[rowBase3 + x0] +
          src[rowBase3 + x1]
        out[outRowBase + x] = Math.round(sum / 8)
      }
    }
  }
  return { data: out, size: [dx, dy, dz] }
}

// Label maps hold discrete, unordered category ids -- averaging two label
// values together (e.g. bone=3 and skin=5 -> 4) produces a meaningless new
// label, not a blend, and silently corrupts the segmentation at every level
// above the finest. Picking one representative voxel (the block's own
// nearest/corner sample, the standard "nearest neighbor" decimation used by
// every segmentation viewer for this exact reason) keeps every value in a
// downsampled level a real label that existed in the source data.
export function downsample2xNearest(level: Level, ctor: TypedArrayConstructor): Level {
  const [sx, sy, sz] = level.size
  const dx = Math.max(1, Math.floor(sx / 2))
  const dy = Math.max(1, Math.floor(sy / 2))
  const dz = Math.max(1, Math.floor(sz / 2))
  const src = level.data
  const out = new ctor(dx * dy * dz)
  for (let z = 0; z < dz; z++) {
    const sz2 = Math.min(z * 2, sz - 1)
    for (let y = 0; y < dy; y++) {
      const sy2 = Math.min(y * 2, sy - 1)
      const srcRowBase = sz2 * sy * sx + sy2 * sx
      const outRowBase = z * dy * dx + y * dx
      for (let x = 0; x < dx; x++) {
        const sx2 = Math.min(x * 2, sx - 1)
        out[outRowBase + x] = src[srcRowBase + sx2]
      }
    }
  }
  return { data: out, size: [dx, dy, dz] }
}

// Like downsample2xNearest, but each 2x2x2 block takes its most common
// *nonzero* label (background only if the whole block is background).
// Nearest decimation keeps one voxel of eight, so a 1-2 voxel wide vessel
// survives each halving only where it happens to cross that one sampled
// corner -- after two halvings it's scattered specks. This keeps any
// structure that touches a block.
export function downsample2xLabelMode(level: Level, ctor: TypedArrayConstructor): Level {
  const [sx, sy, sz] = level.size
  const dx = Math.max(1, Math.floor(sx / 2))
  const dy = Math.max(1, Math.floor(sy / 2))
  const dz = Math.max(1, Math.floor(sz / 2))
  const src = level.data
  const out = new ctor(dx * dy * dz)
  const block = new Float64Array(8)
  for (let z = 0; z < dz; z++) {
    const z0 = Math.min(z * 2, sz - 1) * sy * sx
    const z1 = Math.min(z * 2 + 1, sz - 1) * sy * sx
    for (let y = 0; y < dy; y++) {
      const y0 = Math.min(y * 2, sy - 1) * sx
      const y1 = Math.min(y * 2 + 1, sy - 1) * sx
      const outRow = z * dy * dx + y * dx
      for (let x = 0; x < dx; x++) {
        const x0 = Math.min(x * 2, sx - 1)
        const x1 = Math.min(x * 2 + 1, sx - 1)
        block[0] = src[z0 + y0 + x0]
        block[1] = src[z0 + y0 + x1]
        block[2] = src[z0 + y1 + x0]
        block[3] = src[z0 + y1 + x1]
        block[4] = src[z1 + y0 + x0]
        block[5] = src[z1 + y0 + x1]
        block[6] = src[z1 + y1 + x0]
        block[7] = src[z1 + y1 + x1]
        let best = 0
        let bestCount = 0
        for (let i = 0; i < 8; i++) {
          const v = block[i]
          if (v === 0 || v === best) continue
          let count = 1
          for (let j = i + 1; j < 8; j++) if (block[j] === v) count++
          if (count > bestCount) {
            best = v
            bestCount = count
          }
        }
        out[outRow + x] = best
      }
    }
  }
  return { data: out, size: [dx, dy, dz] }
}

// itk-wasm's `image.spacing` is always a positive magnitude per axis --
// whether that axis's index actually increases or decreases in physical
// space (e.g. a NRRD with a negative "space directions" component) lives
// separately in `image.direction`, a 3x3 direction-cosine matrix. Our zarr
// writer only ever records spacing + origin (no direction/orientation
// metadata), so an axis stored "reversed" in the source file was silently
// read as if it were forward -- showing up as a flipped/upside-down render
// despite niivue (which does account for direction) displaying the same
// file correctly. Diagonal entries are invariant to row- vs column-major
// layout, so reading indices 0/4/8 of the flattened 3x3 matrix is safe
// without needing to know the wasm build's convention.
export function reversedAxes(direction: ArrayLike<number>): [boolean, boolean, boolean] {
  return [direction[0] < 0, direction[4] < 0, direction[8] < 0]
}

// Physically reverses whichever axes are flagged, so the written array
// always increases with true physical position -- letting a plain
// identity-direction reader (which is what every OME-Zarr consumer here
// assumes, since we don't write RFC-4 orientation metadata) display it
// correctly. Returns the origin adjusted to match: the new index-0 voxel
// along a flipped axis is what used to be the last one.
export function applyAxisFlips(
  level: Level,
  origin: number[],
  spacing: number[],
  flip: [boolean, boolean, boolean],
  ctor: TypedArrayConstructor
): { level: Level; origin: number[] } {
  if (!flip.some(Boolean)) return { level, origin }
  const [sx, sy, sz] = level.size
  const [flipX, flipY, flipZ] = flip
  const src = level.data
  const out = new ctor(src.length)
  for (let z = 0; z < sz; z++) {
    const sz2 = flipZ ? sz - 1 - z : z
    for (let y = 0; y < sy; y++) {
      const sy2 = flipY ? sy - 1 - y : y
      const srcRowBase = sz2 * sy * sx + sy2 * sx
      const dstRowBase = z * sy * sx + y * sx
      if (flipX) {
        for (let x = 0; x < sx; x++) out[dstRowBase + x] = src[srcRowBase + (sx - 1 - x)]
      } else {
        out.set(src.subarray(srcRowBase, srcRowBase + sx), dstRowBase)
      }
    }
  }
  // A reversed axis maps row -> physical position as `origin - row*spacing`
  // (row 0 sits at `origin`, the *largest* physical coordinate on that axis).
  // After reversing the array, the new row 0 is the old last row, whose true
  // physical position was `origin - (N-1)*spacing` -- so that's the new
  // origin the flipped, now-identity-direction array must use.
  const newOrigin = origin.map((o, axis) => (flip[axis] ? o - (level.size[axis] - 1) * spacing[axis] : o))
  return { level: { data: out, size: level.size }, origin: newOrigin }
}

export function buildPyramid(base: Level, ctor: TypedArrayConstructor, downsample: DownsampleFn): Level[] {
  const levels = [base]
  const maxDim = Math.max(...base.size)
  let factor = 2
  let current = base
  while (maxDim / factor >= MIN_LEVEL_DIMENSION && levels.length < MAX_LEVELS) {
    current = downsample(current, ctor)
    levels.push(current)
    factor *= 2
  }
  return levels
}

// Zarr v2 requires every stored chunk file to hold exactly `chunks`-shaped
// data, so a level whose dimensions don't divide evenly needs its edge
// chunks padded with the fill value (0) up to the full chunk shape.
export async function writeZarrArrayV2(
  dirPath: string,
  level: Level,
  dtype: string,
  ctor: TypedArrayConstructor,
  sliceOptimized: boolean
): Promise<void> {
  const [sx, sy, sz] = level.size
  // Zarr array shape/chunk order matches the axis order in the OME-NGFF
  // multiscales metadata (z, y, x) -- see writeMultiscaleGroup below.
  const shape = [sz, sy, sx]
  const chunkShape = sliceOptimized
    ? sliceOptimizedChunkShape(level.size, ctor.BYTES_PER_ELEMENT)
    : (() => {
        const chunkSize = chunkSizeFor(level.size)
        return [Math.min(chunkSize, sz), Math.min(chunkSize, sy), Math.min(chunkSize, sx)] as [number, number, number]
      })()
  await mkdir(dirPath, { recursive: true })
  await writeFile(
    path.join(dirPath, '.zarray'),
    JSON.stringify({
      zarr_format: 2,
      shape,
      chunks: chunkShape,
      dtype,
      compressor: BLOSC_CONFIG,
      fill_value: 0,
      order: 'C',
      filters: null
    })
  )

  const [cz, cy, cx] = chunkShape
  const nChunksZ = Math.ceil(sz / cz)
  const nChunksY = Math.ceil(sy / cy)
  const nChunksX = Math.ceil(sx / cx)
  const data = level.data

  for (let bz = 0; bz < nChunksZ; bz++) {
    for (let by = 0; by < nChunksY; by++) {
      for (let bx = 0; bx < nChunksX; bx++) {
        const buffer = new ctor(cz * cy * cx)
        const rowLen = Math.min(cx, sx - bx * cx)
        for (let z = 0; z < cz; z++) {
          const gz = bz * cz + z
          if (gz >= sz) break
          for (let y = 0; y < cy; y++) {
            const gy = by * cy + y
            if (gy >= sy) break
            const srcOffset = gz * sy * sx + gy * sx + bx * cx
            const dstOffset = z * cy * cx + y * cx
            buffer.set(data.subarray(srcOffset, srcOffset + rowLen), dstOffset)
          }
        }
        const rawBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        const compressed = await bloscCodec.encode(rawBytes)
        await writeFile(path.join(dirPath, `${bz}.${by}.${bx}`), compressed)
      }
    }
  }
}

/**
 * Writes one complete OME-Zarr (NGFF 0.4 / Zarr v2) multiscale group --
 * .zgroup, .zattrs, and every level's chunked array -- to outputPath.
 * Shared by the intensity-volume converter (zarrConvert.ts, average
 * downsampling) and the segmentation label-map converter
 * (segmentationZarrConvert.ts, nearest-neighbor downsampling, one group per
 * layer): both need the exact same container format, since the frontend's
 * zarrClient.ts and itk-vtk-viewer read them identically either way.
 */
export async function writeMultiscaleGroup(
  outputPath: string,
  levels: Level[],
  dtype: string,
  ctor: TypedArrayConstructor,
  spacing: number[],
  origin: number[],
  multiscaleType: 'average' | 'nearest',
  options: { orthogonalCopies?: boolean } = {}
): Promise<void> {
  const orthogonalCopies = options.orthogonalCopies ?? true
  await mkdir(outputPath, { recursive: true })
  await writeFile(path.join(outputPath, '.zgroup'), JSON.stringify({ zarr_format: 2 }))

  const datasets = levels.map((_level, i) => {
    const scaleFactor = 2 ** i
    return {
      path: `scale${i}`,
      coordinateTransformations: [
        { type: 'scale', scale: [spacing[2] * scaleFactor, spacing[1] * scaleFactor, spacing[0] * scaleFactor] },
        { type: 'translation', translation: [origin[2], origin[1], origin[0]] }
      ]
    }
  })

  const zattrs = {
    multiscales: [
      {
        version: '0.4',
        name: 'image',
        axes: [
          { name: 'z', type: 'space', unit: 'millimeter' },
          { name: 'y', type: 'space', unit: 'millimeter' },
          { name: 'x', type: 'space', unit: 'millimeter' }
        ],
        datasets,
        type: multiscaleType
      }
    ]
  }
  await writeFile(path.join(outputPath, '.zattrs'), JSON.stringify(zattrs))

  for (let i = 0; i < levels.length; i++) {
    const levelDir = path.join(outputPath, `scale${i}`)
    const sliceOptimized = i < SLICE_OPTIMIZED_LEVEL_COUNT
    await writeZarrArrayV2(levelDir, levels[i], dtype, ctor, sliceOptimized)
    // Only the slice-optimized levels need them: coarser levels are
    // cube-chunked, so every plane is already a small number of chunks.
    if (orthogonalCopies && sliceOptimized) {
      const level = levels[i]
      const [sx, sy] = level.size
      await writeOrthogonalCopies(levelDir, level.size, dtype, ctor, (z0, nz) =>
        level.data.subarray(z0 * sy * sx, (z0 + nz) * sy * sx) as TypedArray
      )
    }
  }
}
