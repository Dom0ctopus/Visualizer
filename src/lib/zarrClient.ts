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
    arrayMetaCache.set(levelUrl, p)
  }
  return p
}

// Keyed by chunk URL, so scrolling within the same chunk (the common case --
// a chunk spans many Z slices at once) never re-fetches; crossing into a new
// chunk only fetches the handful of chunk files that cover it.
//
// Bounded by total decoded bytes (not entry count): at native resolution a
// single finest-level chunk is now a full Z-slice (see server/src/zarrWriter.ts's
// finestChunkShape), potentially tens of MB each, and scrolling through a
// long stack -- especially with prefetch (useZarrSliceViewer.ts) and a
// segmentation overlay's own separate chunks (useSegmentationOverlays.ts)
// both adding to this same cache -- would otherwise grow it without bound
// for the lifetime of the page. Evicts least-recently-used entries (a Map
// iterates in insertion order, and re-set-ing an accessed entry moves it to
// the end) once the budget is exceeded.
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
    const res = await fetch(key)
    if (!res.ok) throw new Error(`Failed to fetch chunk ${key} (${res.status})`)
    const compressed = new Uint8Array(await res.arrayBuffer())
    let raw: Uint8Array
    if (meta.compressor) {
      const codec = Blosc.fromConfig(meta.compressor)
      raw = (await codec.decode(compressed)) as Uint8Array
    } else {
      raw = compressed
    }
    chunkByteSizes.set(key, raw.byteLength)
    chunkCacheBytes += raw.byteLength
    evictChunkCacheIfNeeded()
    return new ctor(raw.buffer, raw.byteOffset, raw.byteLength / ctor.BYTES_PER_ELEMENT)
  })()
  chunkCache.set(key, p)
  return p
}

export interface VolumeInfo {
  /** Path segment (e.g. "scale0") of the finest resolution level -- the one
   *  this reader always uses, so slices come back at full native resolution
   *  with no downsampling. */
  finestLevelPath: string
  /** [z, y, x] */
  size: [number, number, number]
  dtype: string
}

/** Fetches just enough metadata to know the volume's full-resolution
 *  dimensions -- scale0 is always the finest (first) dataset written by
 *  server/src/zarrConvert.ts, but this reads it from .zattrs rather than
 *  assuming the literal path, in case that ever changes. */
export async function fetchVolumeInfo(zarrBaseUrl: string): Promise<VolumeInfo> {
  const attrs = await fetchZattrs(zarrBaseUrl)
  const finestLevelPath = attrs.multiscales[0].datasets[0].path
  const meta = await fetchZarray(`${zarrBaseUrl}/${finestLevelPath}`)
  return { finestLevelPath, size: meta.shape, dtype: meta.dtype }
}

export interface SliceResult {
  width: number
  height: number
  data: TypedArray
}

/** Reads one full-resolution Z-plane slice, fetching (and caching) only the
 *  chunks that actually cover it -- not the whole volume. */
export async function readZSlice(zarrBaseUrl: string, finestLevelPath: string, zIndex: number): Promise<SliceResult> {
  const levelUrl = `${zarrBaseUrl}/${finestLevelPath}`
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
  return { width: shapeX, height: shapeY, data: out }
}
