import { nrrdReadImageNode } from '@itk-wasm/image-io'
import Blosc from 'numcodecs/blosc'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

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

// The finest pyramid level is the only one the custom slice viewer reads
// (src/lib/zarrClient.ts's readZSlice, one Z-slice at a time) -- everything
// coarser is only ever read by the itk-vtk-viewer Volume pane. Chunking it
// in small cubes (like the coarser levels) meant a single slice read had to
// fetch+blosc-decode every small X/Y tile spanning the slice's full width
// and height -- dozens of small requests for one slice, which is what made
// scrolling slow. Since chunk size has no bearing on the Volume pane's
// voxel cap (see above) and this level is never read by that pane, its
// chunk shape is free to be optimized purely for slice reads: one chunk per
// Z index, spanning the full X/Y extent, so reading any slice is always
// exactly one chunk fetch with zero wasted bytes.
function finestChunkShape(size: readonly [number, number, number]): [number, number, number] {
  const [sx, sy] = size
  return [1, sy, sx] // [z, y, x], matching writeZarrArrayV2's chunkShape order
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
type TypedArrayConstructor = new (...args: any[]) => TypedArray
type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array

/** size is [x, y, z] (ITK convention, fastest-varying axis first); data is a
 *  flat z-major (C-order) buffer matching that -- index = z*sy*sx + y*sx + x. */
interface Level {
  data: TypedArray
  size: [number, number, number]
}

function zarrDtypeFor(componentType: string): { dtype: string; ctor: TypedArrayConstructor } {
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

// Halves each axis by averaging 2x2x2 blocks, clamping at the edge for odd
// dimensions (so the last row/column/slice is duplicated rather than reading
// out of bounds) -- a plain box filter is enough for a first working
// multiscale pyramid; it does not need to match any particular viewer's own
// antialiasing choice since these levels exist purely for GPU memory
// savings, not for their own visual fidelity.
function downsample2x(level: Level, ctor: TypedArrayConstructor): Level {
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
function reversedAxes(direction: ArrayLike<number>): [boolean, boolean, boolean] {
  return [direction[0] < 0, direction[4] < 0, direction[8] < 0]
}

// Physically reverses whichever axes are flagged, so the written array
// always increases with true physical position -- letting a plain
// identity-direction reader (which is what every OME-Zarr consumer here
// assumes, since we don't write RFC-4 orientation metadata) display it
// correctly. Returns the origin adjusted to match: the new index-0 voxel
// along a flipped axis is what used to be the last one.
function applyAxisFlips(
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

function buildPyramid(base: Level, ctor: TypedArrayConstructor): Level[] {
  const levels = [base]
  const maxDim = Math.max(...base.size)
  let factor = 2
  let current = base
  while (maxDim / factor >= MIN_LEVEL_DIMENSION && levels.length < MAX_LEVELS) {
    current = downsample2x(current, ctor)
    levels.push(current)
    factor *= 2
  }
  return levels
}

// Zarr v2 requires every stored chunk file to hold exactly `chunks`-shaped
// data, so a level whose dimensions don't divide evenly needs its edge
// chunks padded with the fill value (0) up to the full chunk shape.
async function writeZarrArrayV2(
  dirPath: string,
  level: Level,
  dtype: string,
  ctor: TypedArrayConstructor,
  isFinest: boolean
): Promise<void> {
  const [sx, sy, sz] = level.size
  // Zarr array shape/chunk order matches the axis order in the OME-NGFF
  // multiscales metadata (z, y, x) -- see convertNrrdToOmeZarr below.
  const shape = [sz, sy, sx]
  const chunkShape = isFinest
    ? finestChunkShape(level.size)
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
 * Converts an uploaded NRRD volume into a chunked, multiscale OME-Zarr (NGFF
 * 0.4 / Zarr v2) store on disk -- so the itk-vtk-viewer engine can pick
 * whichever resolution level fits in memory instead of requiring the whole
 * volume to fit in one WebGL 3D texture up front, the way niivue does.
 *
 * Written by hand rather than through @fideus-labs/ngff-zarr: that library
 * (and the zarrita version it's built on) only ever writes Zarr v3 storage --
 * the "version" option controls just the OME metadata dialect, not the
 * underlying array format -- while itk-vtk-viewer's bundled reader (and, as
 * of this writing, @itk-viewer/io's too) only understands Zarr v2's
 * .zattrs/.zgroup/.zarray layout. Until the viewer side catches up to Zarr
 * v3, writing NGFF 0.4 directly is the only combination that round-trips.
 */
export async function convertNrrdToOmeZarr(nrrdPath: string, outputZarrPath: string): Promise<void> {
  const { image } = await nrrdReadImageNode(nrrdPath)
  if (!image.data) throw new Error('NRRD file has no voxel data')
  const { dtype, ctor } = zarrDtypeFor(image.imageType.componentType)
  const [sx, sy, sz] = image.size
  const rawBase: Level = { data: image.data as TypedArray, size: [sx, sy, sz] }

  const spacing = image.spacing.length === 3 ? image.spacing : [1, 1, 1]
  const rawOrigin = image.origin.length === 3 ? image.origin : [0, 0, 0]
  // image.direction is always floating-point in practice (a 3x3 direction-
  // cosine matrix); itk-wasm's TypedArray union is broader only to cover
  // other fields like index arrays.
  const direction = image.direction as unknown as Float64Array
  const { level: base, origin } = applyAxisFlips(rawBase, rawOrigin, spacing, reversedAxes(direction), ctor)

  const levels = buildPyramid(base, ctor)

  await mkdir(outputZarrPath, { recursive: true })
  await writeFile(path.join(outputZarrPath, '.zgroup'), JSON.stringify({ zarr_format: 2 }))

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
        type: 'average'
      }
    ]
  }
  await writeFile(path.join(outputZarrPath, '.zattrs'), JSON.stringify(zattrs))

  for (let i = 0; i < levels.length; i++) {
    await writeZarrArrayV2(path.join(outputZarrPath, `scale${i}`), levels[i], dtype, ctor, i === 0)
  }
}
