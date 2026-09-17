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
    if (!zarrUrl || !volumeInfo) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    readZSlice(zarrUrl, volumeInfo.finestLevelPath, zIndex)
      .then((result) => {
        if (requestIdRef.current !== requestId) return
        setSlice(result)
        setError(null)
        // Now that each Z index is its own chunk (see zarrConvert.ts), the
        // adjacent slices a user is about to scroll to are cheap to warm
        // into zarrClient's chunk cache ahead of time -- fire-and-forget,
        // errors here don't matter since the same read is retried for real
        // (with its own error handling) if the user actually steps there.
        const maxZ = volumeInfo.size[0] - 1
        if (zIndex - 1 >= 0) void readZSlice(zarrUrl, volumeInfo.finestLevelPath, zIndex - 1)
        if (zIndex + 1 <= maxZ) void readZSlice(zarrUrl, volumeInfo.finestLevelPath, zIndex + 1)
      })
      .catch((e) => {
        if (requestIdRef.current !== requestId) return
        setError(e instanceof Error ? e.message : 'Failed to load slice')
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false)
      })
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
