import { useEffect, useMemo, useRef, useState } from 'react'
import { useLatestAsync } from './useLatestAsync'
import { segZarrUrl } from '../lib/api'
import { buildLabelLut } from '../lib/segmentationOverlay'
import {
  fetchVolumeInfo,
  readCoronalSlice,
  readSagittalSlice,
  readZSlice,
  type SliceResult,
  type VolumeInfo
} from '../lib/zarrClient'
import { groupByLayer, type ZarrLoadedSegmentation } from '../types'

export interface SliceOverlay {
  width: number
  height: number
  data: SliceResult['data']
  lut: Uint8ClampedArray
  /** Indexed by labelValue -> segment name, for mouse-hover lookups (see
   *  ZarrSliceCanvas's onHoverLabel). Parallel to `lut` -- see
   *  segmentationOverlay.ts's own comment on LabelLut.names. */
  names: string[]
  /** Maps a base-slice pixel (x, y) to this overlay's own nearest voxel via
   *  `round(x * scaleX + offsetX)`, `round(y * scaleY + offsetY)` -- an
   *  affine transform derived from each grid's own physical origin/spacing
   *  (see this file's own comment on physical-space alignment), general
   *  enough to cover both a plain pixel translation (a cropped export at
   *  the same voxel size) and a genuine resolution difference (a
   *  segmentation authored against a resampled ROI volume, at a coarser or
   *  finer spacing than the master scan). `x`/`y` here are in the BASE
   *  SLICE's own 2D coordinate frame, which represents different physical
   *  axis pairs depending on the plane (axial: x, y; coronal: x, z;
   *  sagittal: y, z) -- this struct doesn't need to know which, since the
   *  affine mapping and the compositing loop that uses it are already
   *  axis-agnostic. */
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
}

export interface OrthogonalPositions {
  z: number
  y: number
  x: number
}

export interface OrthogonalOverlays {
  axial: SliceOverlay[]
  coronal: SliceOverlay[]
  sagittal: SliceOverlay[]
}

type Plane = 'axial' | 'coronal' | 'sagittal'

// Assembled overlay slices, keyed by source array + plane + position. An
// opacity/visibility edit only changes the color table, so handing the
// renderer the *same* slice object lets it keep its uploaded label texture
// (it caches textures by data identity -- see sliceRenderer.ts) instead of
// re-uploading every layer's slice in all three panes on each slider tick.
const SLICE_CACHE_LIMIT = 48
const sliceCache = new Map<string, Promise<SliceResult>>()

function cachedSlice(key: string, load: () => Promise<SliceResult>): Promise<SliceResult> {
  const hit = sliceCache.get(key)
  if (hit) {
    sliceCache.delete(key)
    sliceCache.set(key, hit)
    return hit
  }
  const p = load()
  sliceCache.set(key, p)
  p.catch(() => {
    if (sliceCache.get(key) === p) sliceCache.delete(key)
  })
  while (sliceCache.size > SLICE_CACHE_LIMIT) sliceCache.delete(sliceCache.keys().next().value!)
  return p
}

async function loadPlaneOverlays(
  plane: Plane,
  index: number,
  segmentations: ZarrLoadedSegmentation[],
  base: VolumeInfo,
  levelIndex: number,
  infoCache: Map<string, Promise<VolumeInfo>>
): Promise<{ overlays: SliceOverlay[]; error: string | null }> {
  const jobs = segmentations.flatMap((seg) =>
    [...groupByLayer(seg.segments)]
      .filter(([, segsInLayer]) => segsInLayer.some((s) => s.visible && s.opacity > 0))
      .map(async ([layer, segsInLayer]): Promise<SliceOverlay | string | null> => {
        const layerUrl = `${segZarrUrl(seg.recordId)}/layer${layer}`
        const cacheKey = `${layerUrl}:${levelIndex}`
        let infoPromise = infoCache.get(cacheKey)
        if (!infoPromise) {
          infoPromise = fetchVolumeInfo(layerUrl, levelIndex)
          infoCache.set(cacheKey, infoPromise)
        }
        try {
          const info = await infoPromise
          // Physical bounding boxes (mm) must overlap on every axis -- two
          // grids that never occupy the same space aren't the same scan.
          const noOverlap = [0, 1, 2].some((axis) => {
            const baseMax = base.origin[axis] + (base.size[axis] - 1) * base.spacing[axis]
            const segMax = info.origin[axis] + (info.size[axis] - 1) * info.spacing[axis]
            return segMax < base.origin[axis] || info.origin[axis] > baseMax
          })
          if (noOverlap) {
            return `Segmentation "${seg.name}" (layer ${layer}) doesn't physically overlap the loaded volume at all -- they don't appear to be the same scan.`
          }
          // Per-axis affine map from a base voxel index to this layer's own
          // nearest voxel -- see this file's header comment. [z, y, x] order.
          const scale = [0, 1, 2].map((axis) => base.spacing[axis] / info.spacing[axis])
          const offset = [0, 1, 2].map((axis) => (base.origin[axis] - info.origin[axis]) / info.spacing[axis])
          // The plane's fixed axis, and the axes of its rows and columns.
          const [fixed, rowAxis, colAxis] = plane === 'axial' ? [0, 1, 2] : plane === 'coronal' ? [1, 0, 2] : [2, 0, 1]
          const segIndex = Math.round(index * scale[fixed] + offset[fixed])
          if (segIndex < 0 || segIndex >= info.size[fixed]) return null
          const read = plane === 'axial' ? readZSlice : plane === 'coronal' ? readCoronalSlice : readSagittalSlice
          const slice = await cachedSlice(`${plane}|${layerUrl}|${info.levelPath}|${segIndex}`, () => read(layerUrl, info.levelPath, segIndex))
          const { lut, names } = buildLabelLut(segsInLayer)
          return {
            width: slice.width,
            height: slice.height,
            data: slice.data,
            lut,
            names,
            scaleX: scale[colAxis],
            scaleY: scale[rowAxis],
            offsetX: offset[colAxis],
            offsetY: offset[rowAxis]
          }
        } catch (e) {
          infoCache.delete(cacheKey)
          return e instanceof Error ? e.message : `Failed to load segmentation overlay for "${seg.name}"`
        }
      })
  )
  const results = await Promise.all(jobs)
  const overlays = results.filter((r): r is SliceOverlay => r !== null && typeof r !== 'string')
  const error = results.find((r): r is string => typeof r === 'string') ?? null
  return { overlays, error }
}

/** One plane's overlays, reloaded (latest-wins) only when that plane's own
 *  position, the loaded segmentations, or the base level change. */
function usePlaneOverlays(
  plane: Plane,
  index: number,
  segmentations: ZarrLoadedSegmentation[],
  base: VolumeInfo | null,
  levelIndex: number,
  infoCache: Map<string, Promise<VolumeInfo>>
): { overlays: SliceOverlay[]; error: string | null } {
  const [state, setState] = useState<{ overlays: SliceOverlay[]; error: string | null }>({ overlays: [], error: null })
  const active = segmentations.length > 0 && base !== null
  useLatestAsync(
    active ? () => loadPlaneOverlays(plane, index, segmentations, base, levelIndex, infoCache) : null,
    [segmentations, index, base, levelIndex],
    base ? `${levelIndex}|${base.size.join(',')}|${base.origin.join(',')}|${base.spacing.join(',')}` : '',
    setState,
    (e) => setState((prev) => ({ ...prev, error: e instanceof Error ? e.message : 'Failed to load segmentation overlays' }))
  )
  useEffect(() => {
    if (!active) setState({ overlays: [], error: null })
  }, [active])
  return state
}

/**
 * For the current (z, y, x) cursor position, reads the matching slice out of
 * every visible segmentation layer's own label-map zarr store along each of
 * the three orthogonal planes -- each plane loaded independently and
 * latest-wins (usePlaneOverlays), all layers in parallel -- pairing each with a color/name
 * lookup table built from that layer's segment state -- see
 * ZarrSliceCanvas.tsx for how these get composited onto (and, for names,
 * queried from) the base slice, and useZarrSliceViewer.ts for where axial/
 * coronal/sagittal slices of the BASE volume come from.
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
 * segOrigin) / segSpacing` -- applied once per axis (z, y, x) per layer,
 * then reused across all three planes: the plane whose axis is "fixed"
 * uses the mapped index to pick which slice to read; the other two mapped
 * axes become that plane's own SliceOverlay scaleX/scaleY/offsetX/offsetY.
 * Landing outside a layer's own extent (including entirely missing
 * coverage on the fixed axis) just contributes nothing to that plane, which
 * isn't an error. The one case actually flagged as a real mismatch is the
 * layer's physical bounding box not overlapping the base volume's at all on
 * some axis -- two grids that never occupy the same physical space aren't
 * the same scan, however each one is internally sampled.
 *
 * `levelIndex` must be the same pyramid level the base volume is currently
 * showing (useZarrSliceViewer's own levelIndex) -- since the user can now
 * switch levels or drill into a native-resolution detail window, the
 * overlay has to follow along to whichever level's dimensions
 * baseVolumeInfo actually describes, or every frame would look like a
 * mismatch.
 */
export function useSegmentationOverlays(
  segmentations: ZarrLoadedSegmentation[],
  positions: OrthogonalPositions,
  baseVolumeInfo: VolumeInfo | null,
  levelIndex: number
) {
  const infoCache = useRef(new Map<string, Promise<VolumeInfo>>()).current
  const axial = usePlaneOverlays('axial', positions.z, segmentations, baseVolumeInfo, levelIndex, infoCache)
  const coronal = usePlaneOverlays('coronal', positions.y, segmentations, baseVolumeInfo, levelIndex, infoCache)
  const sagittal = usePlaneOverlays('sagittal', positions.x, segmentations, baseVolumeInfo, levelIndex, infoCache)
  const overlays = useMemo<OrthogonalOverlays>(
    () => ({ axial: axial.overlays, coronal: coronal.overlays, sagittal: sagittal.overlays }),
    [axial.overlays, coronal.overlays, sagittal.overlays]
  )
  return { overlays, error: axial.error ?? coronal.error ?? sagittal.error }
}
