import Blosc from 'numcodecs/blosc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypedArrayConstructor = (new (...args: any[]) => TypedArray) & { BYTES_PER_ELEMENT: number }
type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array

interface ZarrCompressor {
  id: string
  cname: string
  clevel: number
  shuffle: number
}

interface ZarrArrayMeta {
  shape: [number, number, number] // z, y, x -- matches server/src/zarrConvert.ts's axis order
  chunks: [number, number, number]
  dtype: string
  compressor: ZarrCompressor | null
}

interface OmeZarrDataset {
  path: string
  coordinateTransformations: Array<{ type: string; scale?: number[]; translation?: number[] }>
}

interface OmeZarrAttrs {
  multiscales: Array<{ datasets: OmeZarrDataset[] }>
}

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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`)
  return res.json() as Promise<T>
}

const attrsCache = new Map<string, Promise<OmeZarrAttrs>>()
function fetchZattrs(zarrBaseUrl: string): Promise<OmeZarrAttrs> {
  let p = attrsCache.get(zarrBaseUrl)
  if (!p) {
    p = fetchJson<OmeZarrAttrs>(`${zarrBaseUrl}/.zattrs`)
    attrsCache.set(zarrBaseUrl, p)
  }
  return p
}

const arrayMetaCache = new Map<string, Promise<ZarrArrayMeta>>()
function fetchZarray(levelUrl: string): Promise<ZarrArrayMeta> {
  let p = arrayMetaCache.get(levelUrl)
  if (!p) {
    p = fetchJson<ZarrArrayMeta>(`${levelUrl}/.zarray`)
    // Failures aren't cached: an orthogonal copy that doesn't exist yet (still
    // being backfilled on the server) should be picked up once it lands.
    p.catch(() => arrayMetaCache.delete(levelUrl))
    arrayMetaCache.set(levelUrl, p)
  }
  return p
}

/**
 * The array to read a coronal/sagittal slice from: the level's axis-chunked
 * copy (`scale0_coronal` / `scale0_sagittal`, see server/src/
 * orthogonalCopies.ts) when present -- a handful of chunks per slice -- or
 * the level itself otherwise (coarse cube-chunked levels, which don't have
 * copies, or a store whose copies are still being backfilled). The generic
 * readers below handle either chunk layout.
 */
async function orthogonalLevelUrl(zarrBaseUrl: string, levelPath: string, axis: 'coronal' | 'sagittal'): Promise<string> {
  const copyUrl = `${zarrBaseUrl}/${levelPath}_${axis}`
  try {
    await fetchZarray(copyUrl)
    return copyUrl
  } catch {
    return `${zarrBaseUrl}/${levelPath}`
  }
}

// Keyed by chunk URL, so scrolling within the same chunk (the common case --
// a chunk spans many Z slices at once) never re-fetches; crossing into a new
// chunk only fetches the handful of chunk files that cover it.
//
// Bounded by total decoded bytes (not entry count): a single slice-level
// chunk is a full Z-slice (see server/src/zarrWriter.ts's
// sliceOptimizedChunkShape), potentially several MB each, and scrolling
// through a long stack -- especially with a segmentation overlay's own
// separate chunks (useSegmentationOverlays.ts) also adding to this same
// cache -- would otherwise grow it without bound for the lifetime of the
// page. Evicts least-recently-used entries (a Map iterates in insertion
// order, and re-set-ing an accessed entry moves it to the end) once the
// budget is exceeded.
const CHUNK_CACHE_BYTE_BUDGET = 512 * 1024 * 1024
const chunkCache = new Map<string, Promise<TypedArray>>()
let chunkCacheBytes = 0
const chunkByteSizes = new Map<string, number>()

function touchChunkCache(key: string): void {
  const p = chunkCache.get(key)
  if (!p) return
  chunkCache.delete(key)
  chunkCache.set(key, p)
}

function evictChunkCacheIfNeeded(): void {
  for (const key of chunkCache.keys()) {
    if (chunkCacheBytes <= CHUNK_CACHE_BYTE_BUDGET) break
    chunkCache.delete(key)
    chunkCacheBytes -= chunkByteSizes.get(key) ?? 0
    chunkByteSizes.delete(key)
  }
}

function fetchChunk(levelUrl: string, bz: number, by: number, bx: number, meta: ZarrArrayMeta): Promise<TypedArray> {
  const key = `${levelUrl}/${bz}.${by}.${bx}`
  if (chunkCache.has(key)) {
    touchChunkCache(key)
    return chunkCache.get(key)!
  }
  const ctor = dtypeCtor(meta.dtype)
  const p = (async () => {
    const t0 = performance.now()
    const res = await fetch(key)
    if (!res.ok) throw new Error(`Failed to fetch chunk ${key} (${res.status})`)
    const compressedBuf = await res.arrayBuffer()
    const t1 = performance.now()
    const compressed = new Uint8Array(compressedBuf)
    let raw: Uint8Array
    if (meta.compressor) {
      const codec = Blosc.fromConfig(meta.compressor)
      raw = (await codec.decode(compressed)) as Uint8Array
    } else {
      raw = compressed
    }
    const t2 = performance.now()
    // Temporary diagnostic instrumentation -- see the scroll-performance
    // investigation in the project history. Prints once per uncached chunk
    // fetch (cache hits skip this entirely, so scrolling within an
    // already-visited chunk won't spam the console) so a slow step can be
    // attributed to network/server time vs. blosc decode time rather than
    // guessed at.
    console.log(
      `[zarr-perf] chunk ${key.split('/').slice(-4).join('/')}: fetch ${(t1 - t0).toFixed(1)}ms (${(compressedBuf.byteLength / 1024).toFixed(0)}KB compressed), decode ${(t2 - t1).toFixed(1)}ms (${(raw.byteLength / 1024).toFixed(0)}KB raw)`
    )
    chunkByteSizes.set(key, raw.byteLength)
    chunkCacheBytes += raw.byteLength
    evictChunkCacheIfNeeded()
    return new ctor(raw.buffer, raw.byteOffset, raw.byteLength / ctor.BYTES_PER_ELEMENT)
  })()
  chunkCache.set(key, p)
  return p
}

// Default starting level: 1 (2x downsampled in each axis), not 0 (true
// native resolution) -- a deliberate tradeoff. Per-slice lazy reads at
// native resolution had a real per-step latency floor that persisted after
// ruling out every specific cause found (chunk layout, unbounded cache
// growth, cloud-sync storage, Node's I/O thread pool size). Levels are now
// user-selectable (see useZarrSliceViewer.ts's level picker and
// inspectNativeHere), so this is just the starting point, not a hard
// limit -- level 0 is one click away, bounded to a small Z window around
// wherever the user actually wants detail (see readZSliceRange below)
// rather than paid for across the whole stack. See server/src/
// zarrWriter.ts's SLICE_OPTIMIZED_LEVEL_COUNT, which must cover every
// level this picker exposes so switching between them doesn't silently
// reintroduce the many-small-chunks-per-slice problem that chunking
// scheme was built to avoid.
export const DEFAULT_LEVEL_INDEX = 1

export interface VolumeInfo {
  /** Path segment (e.g. "scale1") of the level this reader uses for slice
   *  access. */
  levelPath: string
  /** [z, y, x], in that level's own (downsampled) voxel dimensions. */
  size: [number, number, number]
  dtype: string
  /** [z, y, x] physical origin (mm) of voxel (0,0,0) at this level -- read
   *  from the level's own NGFF "translation" transform (see
   *  server/src/zarrWriter.ts's writeMultiscaleGroup). Used to align a
   *  segmentation overlay whose exported extent is a physical sub-region of
   *  the volume (common for 3D Slicer segmentations, which by default crop
   *  each layer to the bounding box of its segmented voxels) rather than
   *  assuming every layer shares the volume's own pixel grid exactly. */
  origin: [number, number, number]
  /** [z, y, x] physical voxel size (mm) at this level -- the level's own
   *  NGFF "scale" transform. */
  spacing: [number, number, number]
}

function parseTransforms(dataset: OmeZarrDataset): { origin: [number, number, number]; spacing: [number, number, number] } {
  const scale = dataset.coordinateTransformations.find((t) => t.type === 'scale')?.scale ?? [1, 1, 1]
  const translation = dataset.coordinateTransformations.find((t) => t.type === 'translation')?.translation ?? [0, 0, 0]
  return {
    spacing: [scale[0], scale[1], scale[2]],
    origin: [translation[0], translation[1], translation[2]]
  }
}

export interface PyramidLevel extends VolumeInfo {
  index: number
  /** 2**index -- every level in this pyramid is downsampled uniformly in
   *  all 3 axes by this much relative to level 0 (see
   *  server/src/zarrWriter.ts's buildPyramid). */
  downsampleFactor: number
}

/** Lists every pyramid level's own dimensions -- for a level picker UI, and
 *  for mapping a Z index from one level's coordinates into another's
 *  (multiply/divide by the two levels' downsampleFactor). */
export async function fetchPyramidLevels(zarrBaseUrl: string): Promise<PyramidLevel[]> {
  const attrs = await fetchZattrs(zarrBaseUrl)
  const datasets = attrs.multiscales[0].datasets
  const levels: PyramidLevel[] = []
  for (let i = 0; i < datasets.length; i++) {
    const levelPath = datasets[i].path
    const meta = await fetchZarray(`${zarrBaseUrl}/${levelPath}`)
    const { origin, spacing } = parseTransforms(datasets[i])
    levels.push({ index: i, levelPath, size: meta.shape, dtype: meta.dtype, origin, spacing, downsampleFactor: 2 ** i })
  }
  return levels
}

/** Fetches just enough metadata to know one level's dimensions -- falls
 *  back to the coarsest available level if the volume doesn't have as many
 *  pyramid levels as requested (a small test volume might only have one). */
export async function fetchVolumeInfo(zarrBaseUrl: string, levelIndex: number): Promise<VolumeInfo> {
  const attrs = await fetchZattrs(zarrBaseUrl)
  const datasets = attrs.multiscales[0].datasets
  const dataset = datasets[Math.min(levelIndex, datasets.length - 1)]
  const meta = await fetchZarray(`${zarrBaseUrl}/${dataset.path}`)
  const { origin, spacing } = parseTransforms(dataset)
  return { levelPath: dataset.path, size: meta.shape, dtype: meta.dtype, origin, spacing }
}

export interface SliceResult {
  width: number
  height: number
  data: TypedArray
}

/** Reads one Z-plane slice (at VolumeInfo's chosen level), fetching (and
 *  caching) only the chunks that actually cover it -- not the whole volume. */
export async function readZSlice(zarrBaseUrl: string, levelPath: string, zIndex: number): Promise<SliceResult> {
  const sliceT0 = performance.now()
  const levelUrl = `${zarrBaseUrl}/${levelPath}`
  const meta = await fetchZarray(levelUrl)
  const [shapeZ, shapeY, shapeX] = meta.shape
  const [chunkZ, chunkY, chunkX] = meta.chunks
  if (zIndex < 0 || zIndex >= shapeZ) throw new Error(`z index ${zIndex} out of range [0, ${shapeZ})`)

  const bz = Math.floor(zIndex / chunkZ)
  const localZ = zIndex - bz * chunkZ
  const nChunksY = Math.ceil(shapeY / chunkY)
  const nChunksX = Math.ceil(shapeX / chunkX)

  const ctor = dtypeCtor(meta.dtype)
  const out = new ctor(shapeX * shapeY)

  const fetches: Promise<void>[] = []
  for (let by = 0; by < nChunksY; by++) {
    for (let bx = 0; bx < nChunksX; bx++) {
      fetches.push(
        fetchChunk(levelUrl, bz, by, bx, meta).then((chunkData) => {
          const rowLen = Math.min(chunkX, shapeX - bx * chunkX)
          const rowsInChunk = Math.min(chunkY, shapeY - by * chunkY)
          for (let y = 0; y < rowsInChunk; y++) {
            const gy = by * chunkY + y
            const srcOffset = localZ * chunkY * chunkX + y * chunkX
            const dstOffset = gy * shapeX + bx * chunkX
            out.set(chunkData.subarray(srcOffset, srcOffset + rowLen), dstOffset)
          }
        })
      )
    }
  }
  await Promise.all(fetches)
  console.log(
    `[zarr-perf] readZSlice z=${zIndex} total ${(performance.now() - sliceT0).toFixed(1)}ms (${nChunksY * nChunksX} chunk(s), ${shapeX}x${shapeY})`
  )
  return { width: shapeX, height: shapeY, data: out }
}

/**
 * Reads one Y-plane (coronal) slice: fixed Y, varying Z (rows) and X
 * (columns), from the level's coronal-chunked copy when present (see
 * orthogonalLevelUrl). Handles any chunk layout, so it also works (slowly --
 * one chunk per Z index) against an axial-chunked array.
 */
export async function readCoronalSlice(zarrBaseUrl: string, levelPath: string, yIndex: number): Promise<SliceResult> {
  const sliceT0 = performance.now()
  const levelUrl = await orthogonalLevelUrl(zarrBaseUrl, levelPath, 'coronal')
  const meta = await fetchZarray(levelUrl)
  const [shapeZ, shapeY, shapeX] = meta.shape
  const [chunkZ, chunkY, chunkX] = meta.chunks
  if (yIndex < 0 || yIndex >= shapeY) throw new Error(`y index ${yIndex} out of range [0, ${shapeY})`)

  const by = Math.floor(yIndex / chunkY)
  const localY = yIndex - by * chunkY
  const nChunksZ = Math.ceil(shapeZ / chunkZ)
  const nChunksX = Math.ceil(shapeX / chunkX)

  const ctor = dtypeCtor(meta.dtype)
  const out = new ctor(shapeX * shapeZ)

  const fetches: Promise<void>[] = []
  for (let bz = 0; bz < nChunksZ; bz++) {
    for (let bx = 0; bx < nChunksX; bx++) {
      fetches.push(
        fetchChunk(levelUrl, bz, by, bx, meta).then((chunkData) => {
          const rowsInChunkZ = Math.min(chunkZ, shapeZ - bz * chunkZ)
          const colsInChunk = Math.min(chunkX, shapeX - bx * chunkX)
          for (let lz = 0; lz < rowsInChunkZ; lz++) {
            const gz = bz * chunkZ + lz
            const srcOffset = lz * chunkY * chunkX + localY * chunkX
            const dstOffset = gz * shapeX + bx * chunkX
            out.set(chunkData.subarray(srcOffset, srcOffset + colsInChunk), dstOffset)
          }
        })
      )
    }
  }
  await Promise.all(fetches)
  console.log(
    `[zarr-perf] readCoronalSlice y=${yIndex} total ${(performance.now() - sliceT0).toFixed(1)}ms (${nChunksZ * nChunksX} chunk(s), ${shapeX}x${shapeZ})`
  )
  return { width: shapeX, height: shapeZ, data: out }
}

/**
 * Reads one X-plane (sagittal) slice: fixed X, varying Z (rows) and Y
 * (columns), from the level's sagittal-chunked copy when present (see
 * orthogonalLevelUrl). Handles any chunk layout, like readCoronalSlice.
 */
export async function readSagittalSlice(zarrBaseUrl: string, levelPath: string, xIndex: number): Promise<SliceResult> {
  const sliceT0 = performance.now()
  const levelUrl = await orthogonalLevelUrl(zarrBaseUrl, levelPath, 'sagittal')
  const meta = await fetchZarray(levelUrl)
  const [shapeZ, shapeY, shapeX] = meta.shape
  const [chunkZ, chunkY, chunkX] = meta.chunks
  if (xIndex < 0 || xIndex >= shapeX) throw new Error(`x index ${xIndex} out of range [0, ${shapeX})`)

  const bx = Math.floor(xIndex / chunkX)
  const localX = xIndex - bx * chunkX
  const nChunksZ = Math.ceil(shapeZ / chunkZ)
  const nChunksY = Math.ceil(shapeY / chunkY)

  const ctor = dtypeCtor(meta.dtype)
  const out = new ctor(shapeY * shapeZ)

  const fetches: Promise<void>[] = []
  for (let bz = 0; bz < nChunksZ; bz++) {
    for (let by = 0; by < nChunksY; by++) {
      fetches.push(
        fetchChunk(levelUrl, bz, by, bx, meta).then((chunkData) => {
          const rowsInChunkZ = Math.min(chunkZ, shapeZ - bz * chunkZ)
          const rowsInChunkY = Math.min(chunkY, shapeY - by * chunkY)
          for (let lz = 0; lz < rowsInChunkZ; lz++) {
            const gz = bz * chunkZ + lz
            const dstRowBase = gz * shapeY + by * chunkY
            const srcZBase = lz * chunkY * chunkX
            for (let ly = 0; ly < rowsInChunkY; ly++) {
              out[dstRowBase + ly] = chunkData[srcZBase + ly * chunkX + localX]
            }
          }
        })
      )
    }
  }
  await Promise.all(fetches)
  console.log(
    `[zarr-perf] readSagittalSlice x=${xIndex} total ${(performance.now() - sliceT0).toFixed(1)}ms (${nChunksZ * nChunksY} chunk(s), ${shapeY}x${shapeZ})`
  )
  return { width: shapeY, height: shapeZ, data: out }
}
