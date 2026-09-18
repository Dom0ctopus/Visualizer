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
  /** Pixel offset of this overlay's (0,0) voxel within the base slice's own
   *  grid, at the base slice's current pixel dimensions -- see this file's
   *  own comment on physical-space alignment for why this is usually
   *  nonzero. */
  offsetX: number
  offsetY: number
}

/**
 * For the current Z index, reads (and caches) the matching Z-slice out of
 * every visible segmentation layer's own label-map zarr store, pairing each
 * with a color/opacity lookup table built from that layer's segment state --
 * see ZarrSliceCanvas.tsx for how these get composited onto the base slice.
 *
 * A segmentation's label-map grid is NOT assumed to share the base volume's
 * exact pixel dimensions -- 3D Slicer's default segmentation export crops
 * each layer to the physical bounding box of its own segmented voxels
 * (often much smaller than the full scan), rather than exporting at the
 * full reference-volume extent. What IS assumed is that both grids sit on
 * the same physical voxel lattice (same voxel spacing, and an integer
 * number of voxels between the two grids' origins) -- true whenever the
 * segmentation was actually exported against the loaded scan, regardless of
 * how the two extents were cropped relative to each other. Each layer's own
 * VolumeInfo (spacing + origin, both read from the zarr store's NGFF
 * "scale"/"translation" transforms -- see zarrClient.ts) is used to compute
 * its pixel offset within the base grid; a real incompatibility --
 * different voxel spacing, or an origin that isn't an integer number of
 * voxels away -- surfaces as a clear, persistent error, while a
 * segmentation that's simply cropped (including one with no data at all at
 * the current Z) just contributes nothing to this slice, which isn't an
 * error.
 *
 * `levelIndex` must be the same pyramid level the base volume is currently
 * showing (useZarrSliceViewer's own levelIndex) -- since the user can now
 * switch levels or drill into a native-resolution detail window, the
 * overlay has to follow along to whichever level's dimensions
 * baseVolumeInfo actually describes, or every frame would look like a
 * mismatch.
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

export function useSegmentationOverlays(
  segmentations: ZarrLoadedSegmentation[],
  zIndex: number,
  baseVolumeInfo: VolumeInfo | null,
  levelIndex: number
) {
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
          const cacheKey = `${layerUrl}:${levelIndex}`
          let infoPromise = volumeInfoCacheRef.current.get(cacheKey)
          if (!infoPromise) {
            infoPromise = fetchVolumeInfo(layerUrl, levelIndex)
            volumeInfoCacheRef.current.set(cacheKey, infoPromise)
          }

          try {
            const info = await infoPromise
            const base = baseVolumeInfo!

            // Voxel spacing must match (within a small relative tolerance) at
            // this level -- a real difference means the two grids aren't the
            // same physical resolution at all, which a pixel offset alone
            // can't reconcile.
            const spacingMismatch = [0, 1, 2].some((axis) => {
              const tol = 1e-3 * Math.max(base.spacing[axis], 1e-9)
              return Math.abs(info.spacing[axis] - base.spacing[axis]) > tol
            })
            if (spacingMismatch) {
              lastError = `Segmentation "${seg.name}" (layer ${layer}) has a different voxel size than the loaded volume (${info.spacing.join('x')} mm vs ${base.spacing.join('x')} mm) -- they don't appear to be the same scan.`
              continue
            }

            // Offset (in voxels) of this layer's origin from the base
            // volume's origin, per axis [z, y, x]. 3D Slicer segmentations
            // are commonly exported cropped to the bounding box of their own
            // segmented voxels rather than at the full scan extent, so this
            // is expected to be nonzero -- only a non-integer offset (the
            // two grids not sharing a lattice) is treated as a real mismatch.
            const offset = [0, 1, 2].map((axis) => (info.origin[axis] - base.origin[axis]) / base.spacing[axis])
            const nonIntegerOffset = offset.some((o) => Math.abs(o - Math.round(o)) > 0.05)
            if (nonIntegerOffset) {
              lastError = `Segmentation "${seg.name}" (layer ${layer}) isn't aligned to the loaded volume's voxel grid (offset ${offset.map((o) => o.toFixed(2)).join(', ')} voxels) -- they don't appear to be the same scan.`
              continue
            }
            const [offsetZ, offsetY, offsetX] = offset.map(Math.round)

            const segZ = zIndex - offsetZ
            if (segZ < 0 || segZ >= info.size[0]) continue // outside this layer's cropped Z range -- nothing to draw, not an error

            const [, baseY, baseX] = base.size
            const [, segY, segX] = info.size
            const overlapsXY = offsetX < baseX && offsetX + segX > 0 && offsetY < baseY && offsetY + segY > 0
            if (!overlapsXY) continue // outside this layer's cropped X/Y footprint -- nothing to draw, not an error

            const slice = await readZSlice(layerUrl, info.levelPath, segZ)
            const { lut } = buildLabelLut(segsInLayer)
            results.push({ width: slice.width, height: slice.height, data: slice.data, lut, offsetX, offsetY })
          } catch (e) {
            volumeInfoCacheRef.current.delete(cacheKey)
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
  }, [segmentations, zIndex, baseVolumeInfo, levelIndex])

  return { overlays, error }
}
