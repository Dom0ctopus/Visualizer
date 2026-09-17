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
 * loaded scan, which is the only way this app's upload flow produces one).
 * `baseVolumeInfo` (the loaded volume's own VolumeInfo, from
 * useZarrSliceViewer) is compared against each layer's own size up front so
 * a genuine mismatch -- e.g. a segmentation uploaded that doesn't actually
 * correspond to the loaded volume -- surfaces as a clear, persistent error
 * instead of the overlay just silently never appearing on every frame with
 * nothing to explain why.
 */
// A fast scroll fires many zIndex changes in quick succession; without a
// settle delay, every one of them used to kick off a full-resolution
// decode chain immediately -- and unlike the requestId guard below (which
// only discards an already-finished result), the decode work itself still
// ran to completion for every discarded frame. On a native-resolution
// scan that's a lot of wasted large blosc decodes piling up, which is
// exactly what made scrolling feel like it "locked up" once a
// segmentation was loaded. Only the zIndex the user actually settles on
// now triggers a fetch.
const SETTLE_DELAY_MS = 80

export function useSegmentationOverlays(segmentations: ZarrLoadedSegmentation[], zIndex: number, baseVolumeInfo: VolumeInfo | null) {
  const [overlays, setOverlays] = useState<SliceOverlay[]>([])
  const [error, setError] = useState<string | null>(null)
  const volumeInfoCacheRef = useRef(new Map<string, Promise<VolumeInfo>>())
  const requestIdRef = useRef(0)
  const settleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }

    if (segmentations.length === 0 || !baseVolumeInfo) {
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
            const [, baseY, baseX] = baseVolumeInfo!.size
            const [, segY, segX] = info.size
            if (segY !== baseY || segX !== baseX) {
              lastError = `Segmentation "${seg.name}" (layer ${layer}) is ${segX}x${segY} in X/Y, but the loaded volume is ${baseX}x${baseY} -- they don't appear to be the same scan, so this overlay can't be aligned to it.`
              continue
            }
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

    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      void run()
    }, SETTLE_DELAY_MS)

    return () => {
      cancelled = true
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
    }
  }, [segmentations, zIndex, baseVolumeInfo])

  return { overlays, error }
}
