import { useEffect, useRef, useState } from 'react'
import { segZarrUrl } from '../lib/api'
import { buildLabelLut } from '../lib/segmentationOverlay'
import { fetchVolumeInfo, readZSlice, type SliceResult, type VolumeInfo } from '../lib/zarrClient'
import { groupByLayer, type ZarrLoadedSegmentation } from '../types'

export interface SliceOverlay {
  width: number
  height: number
  data: SliceResult['data']
  lut: Uint8ClampedArray
}

/**
 * For the current Z index, reads (and caches) the matching Z-slice out of
 * every visible segmentation layer's own label-map zarr store, pairing each
 * with a color/opacity lookup table built from that layer's segment state --
 * see ZarrSliceCanvas.tsx for how these get composited onto the base slice.
 *
 * A segmentation's label-map grid is assumed to exactly match its source
 * volume's grid (true for a 3D Slicer segmentation exported against the
 * loaded scan, which is the only way this app's upload flow produces one) --
 * an overlay whose width/height don't match the base slice is dropped
 * rather than resampled, since that mismatch would mean the files don't
 * actually describe the same volume.
 */
export function useSegmentationOverlays(segmentations: ZarrLoadedSegmentation[], zIndex: number) {
  const [overlays, setOverlays] = useState<SliceOverlay[]>([])
  const [error, setError] = useState<string | null>(null)
  const volumeInfoCacheRef = useRef(new Map<string, Promise<VolumeInfo>>())
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (segmentations.length === 0) {
      setOverlays([])
      setError(null)
      return
    }

    const requestId = ++requestIdRef.current
    let cancelled = false

    async function run() {
      const results: SliceOverlay[] = []
      let lastError: string | null = null

      for (const seg of segmentations) {
        const byLayer = groupByLayer(seg.segments)
        for (const [layer, segsInLayer] of byLayer) {
          const anyVisible = segsInLayer.some((s) => s.visible && s.opacity > 0)
          if (!anyVisible) continue

          const layerUrl = `${segZarrUrl(seg.recordId)}/layer${layer}`
          let infoPromise = volumeInfoCacheRef.current.get(layerUrl)
          if (!infoPromise) {
            infoPromise = fetchVolumeInfo(layerUrl)
            volumeInfoCacheRef.current.set(layerUrl, infoPromise)
          }

          try {
            const info = await infoPromise
            if (zIndex < 0 || zIndex >= info.size[0]) continue
            const slice = await readZSlice(layerUrl, info.finestLevelPath, zIndex)
            const { lut } = buildLabelLut(segsInLayer)
            results.push({ width: slice.width, height: slice.height, data: slice.data, lut })
          } catch (e) {
            volumeInfoCacheRef.current.delete(layerUrl)
            lastError = e instanceof Error ? e.message : `Failed to load segmentation overlay for "${seg.name}"`
          }
        }
      }

      if (cancelled || requestIdRef.current !== requestId) return
      setOverlays(results)
      setError(lastError)
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [segmentations, zIndex])

  return { overlays, error }
}
