import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchVolumeInfo, loadFullVolume, readZSlice, type FullVolumeData, type SliceResult, type VolumeInfo } from '../lib/zarrClient'

// Full type-range defaults (rather than scanning the volume for its actual
// min/max up front, which would mean downloading everything just to show a
// slider) -- narrow, real-valued data just starts with headroom on both
// ends of the window, same as the niivue engine's initial full-range default.
function naturalRangeFor(dtype: string): [number, number] {
  switch (dtype) {
    case '|u1':
      return [0, 255]
    case '|i1':
      return [-128, 127]
    case '<u2':
      return [0, 65535]
    case '<i2':
      return [-32768, 32767]
    case '<u4':
      return [0, 4294967295]
    case '<i4':
      return [-2147483648, 2147483647]
    case '<f4':
    case '<f8':
      return [0, 1]
    default:
      return [0, 255]
  }
}

function bytesPerElementFor(dtype: string): number {
  switch (dtype) {
    case '|u1':
    case '|i1':
      return 1
    case '<u2':
    case '<i2':
      return 2
    case '<u4':
    case '<i4':
    case '<f4':
      return 4
    case '<f8':
      return 8
    default:
      return 1
  }
}

// See the settle-timer comment inside the slice-fetch effect below for why
// this exists. Short enough to feel immediate for a single scroll step,
// long enough that a fast multi-step scroll only ever decodes the slice
// actually landed on. Not used at all once the full volume is loaded into
// memory (see fullVolumeData below) -- there's no network/decode cost left
// to debounce against.
const SLICE_SETTLE_DELAY_MS = 40

export type FullVolumeLoadState = 'idle' | 'loading' | 'loaded' | 'error'

/**
 * Drives the custom, itk-vtk-viewer-free slice display: reads full-
 * resolution 2D slices directly out of the same OME-Zarr store (see
 * src/lib/zarrClient.ts), sidestepping itk-vtk-viewer's use2D slice-
 * stepping path entirely -- that path hits a hard internal voxel-count
 * cap on scans this large and corrupts the display rather than falling
 * back gracefully (see the useItkVtkViewer.ts history for how that was
 * diagnosed). No multiscale/downsampling involved here: every slice comes
 * from the finest (original-resolution) level.
 *
 * Two modes: by default, each Z step lazily fetches+decodes just that
 * slice's chunk (readZSlice) -- low memory, but with a real per-step
 * latency floor that's especially visible when the underlying storage's
 * I/O is slow or inconsistent. Calling loadFullVolumeIntoMemory switches
 * to 3D Slicer's own strategy instead: fetch the whole volume once into a
 * single in-memory array, after which every Z step is a synchronous
 * subarray() view with no network call at all. That trade (one large
 * up-front download/decode and holding the whole raw volume in browser
 * memory, possibly several GB) is opt-in on purpose -- see
 * loadFullVolume's own comment in zarrClient.ts.
 */
export function useZarrSliceViewer(zarrUrl: string | null) {
  const [volumeInfo, setVolumeInfo] = useState<VolumeInfo | null>(null)
  const [zIndex, setZIndexState] = useState(0)
  const [slice, setSlice] = useState<SliceResult | null>(null)
  const [windowMin, setWindowMin] = useState(0)
  const [windowMax, setWindowMax] = useState(255)
  const [dataRange, setDataRange] = useState<[number, number]>([0, 255])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [fullVolumeData, setFullVolumeData] = useState<FullVolumeData | null>(null)
  const [fullVolumeLoadState, setFullVolumeLoadState] = useState<FullVolumeLoadState>('idle')
  const [fullVolumeProgress, setFullVolumeProgress] = useState(0)

  const volumeInfoRef = useRef<VolumeInfo | null>(null)
  const requestIdRef = useRef(0)
  const settleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    volumeInfoRef.current = volumeInfo
  }, [volumeInfo])

  useEffect(() => {
    setVolumeInfo(null)
    setSlice(null)
    setError(null)
    setFullVolumeData(null)
    setFullVolumeLoadState('idle')
    setFullVolumeProgress(0)
    if (!zarrUrl) return
    let cancelled = false
    fetchVolumeInfo(zarrUrl)
      .then((info) => {
        if (cancelled) return
        setVolumeInfo(info)
        const range = naturalRangeFor(info.dtype)
        setDataRange(range)
        setWindowMin(range[0])
        setWindowMax(range[1])
        setZIndexState(Math.floor(info.size[0] / 2))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load volume info')
      })
    return () => {
      cancelled = true
    }
  }, [zarrUrl])

  useEffect(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    if (!zarrUrl || !volumeInfo) return

    // Fast path: once the whole volume is loaded into memory, a Z slice
    // is just a view into it -- synchronous, no debounce needed since
    // there's no network/decode cost left to avoid wasting.
    if (fullVolumeData) {
      const [, shapeY, shapeX] = fullVolumeData.size
      const planeSize = shapeY * shapeX
      const view = fullVolumeData.data.subarray(zIndex * planeSize, (zIndex + 1) * planeSize)
      setSlice({ width: shapeX, height: shapeY, data: view })
      setError(null)
      return
    }

    // A fast scroll fires many zIndex changes in quick succession. Without
    // a settle delay, every intermediate one used to kick off its own
    // full-resolution fetch+decode immediately -- the requestId guard
    // below only discards an already-finished *result*, it doesn't stop
    // the decode work itself from running to completion for every
    // discarded frame. On a native-resolution scan that's a lot of wasted
    // large blosc decodes piling up, which is what made scrolling feel
    // like it locked up. Only the zIndex actually settled on now triggers
    // a fetch.
    //
    // This used to also fire-and-forget prefetch reads for the two
    // neighboring Z indices once the main one resolved. Removed after
    // [zarr-perf] instrumentation showed individual chunk fetch times for
    // identical file sizes varying from ~5ms to 1.5+ seconds in one real
    // session -- environmental I/O variance, not anything in this code
    // (see loadFullVolume above for the actual fix for that: load once,
    // stop depending on per-step fetch latency entirely). Under that
    // condition, prefetching adjacent slices just adds more requests
    // competing for the same intermittently-slow I/O that the visible,
    // user-waited-on fetch needs -- pure downside, no upside.
    const requestId = ++requestIdRef.current
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      setLoading(true)
      readZSlice(zarrUrl, volumeInfo.finestLevelPath, zIndex)
        .then((result) => {
          if (requestIdRef.current !== requestId) return
          setSlice(result)
          setError(null)
        })
        .catch((e) => {
          if (requestIdRef.current !== requestId) return
          setError(e instanceof Error ? e.message : 'Failed to load slice')
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false)
        })
    }, SLICE_SETTLE_DELAY_MS)

    return () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
    }
  }, [zarrUrl, volumeInfo, zIndex, fullVolumeData])

  const setZIndex = useCallback((z: number) => {
    const info = volumeInfoRef.current
    const maxZ = info ? info.size[0] - 1 : 0
    setZIndexState(Math.min(maxZ, Math.max(0, Math.round(z))))
  }, [])

  const stepZIndex = useCallback(
    (delta: number) => {
      setZIndexState((prev) => {
        const info = volumeInfoRef.current
        const maxZ = info ? info.size[0] - 1 : 0
        return Math.min(maxZ, Math.max(0, prev + delta))
      })
    },
    []
  )

  const loadFullVolumeIntoMemory = useCallback(async () => {
    if (!zarrUrl || !volumeInfo || fullVolumeLoadState === 'loading') return
    setFullVolumeLoadState('loading')
    setFullVolumeProgress(0)
    setError(null)
    try {
      const result = await loadFullVolume(zarrUrl, volumeInfo.finestLevelPath, (done, total) => {
        setFullVolumeProgress(done / total)
      })
      setFullVolumeData(result)
      setFullVolumeLoadState('loaded')
    } catch (e) {
      setFullVolumeLoadState('error')
      setError(e instanceof Error ? e.message : 'Failed to load the full volume into memory')
    }
  }, [zarrUrl, volumeInfo, fullVolumeLoadState])

  const fullVolumeBytes = volumeInfo
    ? volumeInfo.size[0] * volumeInfo.size[1] * volumeInfo.size[2] * bytesPerElementFor(volumeInfo.dtype)
    : 0

  return {
    volumeInfo,
    zIndex,
    setZIndex,
    stepZIndex,
    slice,
    windowMin,
    windowMax,
    setWindowMin,
    setWindowMax,
    dataRange,
    loading,
    error,
    fullVolumeLoadState,
    fullVolumeProgress,
    fullVolumeBytes,
    loadFullVolumeIntoMemory
  }
}
