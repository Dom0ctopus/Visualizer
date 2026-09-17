import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchVolumeInfo, readZSlice, type SliceResult, type VolumeInfo } from '../lib/zarrClient'

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

// See the settle-timer comment inside the slice-fetch effect below for why
// this exists. Short enough to feel immediate for a single scroll step,
// long enough that a fast multi-step scroll only ever decodes the slice
// actually landed on.
const SLICE_SETTLE_DELAY_MS = 40

/**
 * Drives the custom, itk-vtk-viewer-free slice display: reads full-
 * resolution 2D slices directly out of the same OME-Zarr store (see
 * src/lib/zarrClient.ts), sidestepping itk-vtk-viewer's use2D slice-
 * stepping path entirely -- that path hits a hard internal voxel-count
 * cap on scans this large and corrupts the display rather than falling
 * back gracefully (see the useItkVtkViewer.ts history for how that was
 * diagnosed). No multiscale/downsampling involved here: every slice comes
 * from the finest (original-resolution) level.
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
    // session -- a signature of a cloud-sync service (iCloud Drive/
    // Dropbox/OneDrive "optimize storage") evicting and re-downloading a
    // scan's thousands of small chunk files on demand, not anything in
    // this code. Under that condition, prefetching adjacent slices just
    // adds more requests competing for the same intermittently-slow I/O
    // that the visible, user-waited-on fetch needs -- pure downside, no
    // upside, when fetch latency (not decode or render) is the
    // bottleneck. It's cheap to bring back if a future profile shows
    // fetches are consistently fast and prefetch would actually help.
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
  }, [zarrUrl, volumeInfo, zIndex])

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
    error
  }
}
