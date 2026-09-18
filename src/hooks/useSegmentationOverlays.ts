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
  /** Maps a base-slice pixel (x, y) to this overlay's own nearest voxel via
   *  `round(x * scaleX + offsetX)`, `round(y * scaleY + offsetY)` -- an
   *  affine transform derived from each grid's own physical origin/spacing
   *  (see this file's own comment on physical-space alignment), general
   *  enough to cover both a plain pixel translation (a cropped export at
   *  the same voxel size) and a genuine resolution difference (a
   *  segmentation authored against a resampled ROI volume, at a coarser or
   *  finer spacing than the master scan). */
  scaleX: number
  scaleY: number
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
 * pixel dimensions, origin, or even voxel spacing. Two real 3D Slicer
 * workflows produce a segmentation whose grid differs from the master
 * volume's: (1) the default segmentation export crops each layer to the
 * physical bounding box of its own segmented voxels, and (2) a segmentation
 * built against a transformed/cropped ROI volume (Slicer's "Crop Volume"
 * with resampling, commonly used to work at a coarser, faster-to-segment
 * resolution) has its own, usually coarser, spacing entirely -- but is
 * still meant to overlay onto the master volume it was cropped from. Both
 * are legitimate, not errors.
 *
 * What's trusted instead is each grid's own physical origin/spacing
 * (already read from the zarr store's NGFF "scale"/"translation"
 * transforms -- see zarrClient.ts), exactly like Slicer itself trusts each
 * node's IJKToRAS transform to align otherwise-unrelated grids in a shared
 * physical space. For each axis, a base voxel index maps to this layer's
 * own nearest voxel via `index * (baseSpacing / segSpacing) + (baseOrigin -
 * segOrigin) / segSpacing` -- see SliceOverlay's own comment for the X/Y
 * form of this used at composite time, and this file's Z handling below.
 * Landing outside a layer's own extent (including entirely missing Z
 * coverage) just contributes nothing to that slice, which isn't an error.
 * The one case actually flagged as a real mismatch is the layer's physical
 * bounding box not overlapping the base volume's at all on some axis --
 * two grids that never occupy the same physical space aren't the same
 * scan, however each one is internally sampled.
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

            // Physical bounding boxes (in mm) must actually overlap on every
            // axis -- two grids that never occupy the same physical space
            // aren't the same scan, no matter how each is internally
            // sampled. This is independent of the current level/slice.
            const noOverlap = [0, 1, 2].some((axis) => {
              const baseMin = base.origin[axis]
              const baseMax = base.origin[axis] + (base.size[axis] - 1) * base.spacing[axis]
              const segMin = info.origin[axis]
              const segMax = info.origin[axis] + (info.size[axis] - 1) * info.spacing[axis]
              return segMax < baseMin || segMin > baseMax
            })
            if (noOverlap) {
              lastError = `Segmentation "${seg.name}" (layer ${layer}) doesn't physically overlap the loaded volume at all -- they don't appear to be the same scan.`
              continue
            }

            // Per-axis affine mapping from a base voxel index to this
            // layer's own nearest voxel index -- see this file's own header
            // comment. [z, y, x] order, matching VolumeInfo.size/origin/spacing.
            const scale = [0, 1, 2].map((axis) => base.spacing[axis] / info.spacing[axis])
            const offset = [0, 1, 2].map((axis) => (base.origin[axis] - info.origin[axis]) / info.spacing[axis])

            const segZ = Math.round(zIndex * scale[0] + offset[0])
            if (segZ < 0 || segZ >= info.size[0]) continue // outside this layer's own Z coverage -- nothing to draw, not an error

            const slice = await readZSlice(layerUrl, info.levelPath, segZ)
            const { lut } = buildLabelLut(segsInLayer)
            results.push({
              width: slice.width,
              height: slice.height,
              data: slice.data,
              lut,
              scaleY: scale[1],
              scaleX: scale[2],
              offsetY: offset[1],
              offsetX: offset[2]
            })
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
