import { buildPyramid, downsample2xNearest, writeMultiscaleGroup, type Level } from './zarrWriter.js'
import { pickLevelUnderBudget, readWholeZarrLevel, readZarrLevels, type ZarrLevelInfo } from './zarrReader.js'

// As close to itk-vtk-viewer's own hard voxel cap (2^28 = 268,435,456,
// confirmed by reading its bundled source -- see zarrWriter.ts's own
// comment on CUBE_CHUNK_VOXEL_BUDGET) as safely possible, rather than an
// arbitrary rounder/smaller number -- a real scan's pyramid levels jump by
// 8x in voxel count per halving, so being meaningfully more conservative
// than necessary here doesn't buy a proportionally small resolution loss,
// it can skip an entire level: a first version of this set the budget to
// 96,000,000, which for a scan whose own natural "fits under the cap"
// level was ~147.6M voxels meant silently falling back a full level
// further (~18.4M voxels, 8x fewer) than what a single segmentation
// displayed at on its own -- visibly blocky/fragmented thin structures
// (e.g. blood vessels) in the merged cumulative view that weren't blocky
// before. 0.9x leaves enough margin for the pyramid's edge-padding/rounding
// without giving up a whole level for scans like that one.
const REFERENCE_VOXEL_BUDGET = Math.floor(268_435_456 * 0.9)

export interface MergeLayerInput {
  /** e.g. `${segZarrPathFor(id)}/layer${n}` -- one complete multiscale
   *  group, same layout as any other segmentation layer. */
  segZarrGroupPath: string
  /** Every original label value in this layer to include in the merge
   *  (typically all of them -- the caller decides which to include, not
   *  this function, so a segment's later visibility/opacity toggle can be
   *  driven by itk-vtk-viewer's own per-label weights instead of requiring
   *  a re-merge). */
  labelValues: number[]
}

export interface MergedSegmentMapping {
  /** The label value actually written into the merged output. */
  globalLabelValue: number
  /** Index into the `layers` array this function was called with, so the
   *  caller (which already knows what each index corresponds to) can map
   *  this back to a (segmentation, layer) pair without this function
   *  needing to know or return anything about the caller's own record ids. */
  layerIndex: number
  originalLabelValue: number
}

/**
 * Combines multiple segmentation layers -- potentially from different
 * segmentation files, at different resolutions/origins/crops (see
 * useSegmentationOverlays.ts's own comment on why that's normal, not an
 * error) -- into ONE label-map OME-Zarr pyramid, so itk-vtk-viewer's 3D
 * pane (which only ever holds a single label image at a time) can display
 * every loaded segmentation/layer at once instead of just the first one's
 * first layer.
 *
 * Each layer keeps its original label values internally, but those aren't
 * globally unique across different segmentation files -- two unrelated
 * segmentations can both use labelValue 1 for their first segment, and
 * naively writing both into one array would make them indistinguishable.
 * So every included (layer, originalLabelValue) pair gets its own fresh,
 * globally-unique output value instead, returned as `mapping` -- the
 * caller uses that to drive itk-vtk-viewer's per-label
 * setLabelImageWeights/setLabelImageLabelNames from its own segment state.
 *
 * Resolution: sized to the PHYSICAL EXTENT the included segmentations
 * actually occupy (their union bounding box), not the whole base volume --
 * segmentation files in practice are often small cropped ROIs (see
 * useSegmentationOverlays.ts's own comment on why), so covering the whole
 * volume's extent at a shared resolution wastes most of the voxel budget on
 * empty background and forces a coarser resolution than the segmentation
 * data actually needs. The reference grid starts at the base volume's own
 * native (finest) voxel spacing -- there's no real information to be
 * gained rendering label data finer than the scan it was segmented from --
 * and only coarsens (by successive 2x, matching every other pyramid this
 * app builds) if the union bbox at that spacing would exceed
 * REFERENCE_VOXEL_BUDGET. A small ROI segmentation's own bbox can easily
 * fit natively; segmentations spanning most of the volume converge toward
 * roughly the same resolution the old whole-volume-sized reference grid
 * used. Each input layer is read at whichever of ITS OWN levels fits
 * REFERENCE_VOXEL_BUDGET in memory, then resampled onto the reference grid
 * via the same nearest-neighbor, physical-origin/spacing affine mapping
 * useSegmentationOverlays.ts uses for the 2D pane -- so a cropped export or
 * a coarser-spacing ROI segmentation merges in correctly aligned, not just
 * ones that already share the volume's exact grid.
 */
export async function convertSegmentationMergeToOmeZarr(
  volumeZarrGroupPath: string,
  layers: MergeLayerInput[],
  outputZarrPath: string
): Promise<{ mapping: MergedSegmentMapping[] }> {
  const baseLevels = await readZarrLevels(volumeZarrGroupPath)
  const nativeSpacing = baseLevels.find((l) => l.index === 0)!.spacing

  const includedLayers = layers.filter((l) => l.labelValues.length > 0)
  const layerLevel0s = await Promise.all(
    includedLayers.map(async (l) => (await readZarrLevels(l.segZarrGroupPath)).find((lv) => lv.index === 0)!)
  )

  // Union of every included layer's own physical bounding box, in [z, y, x]
  // mm -- origin is the box's near corner; "origin + (size-1)*spacing" is
  // its own last voxel's corner, the same convention
  // useSegmentationOverlays.ts's overlap check uses.
  const bboxMin: [number, number, number] = [Infinity, Infinity, Infinity]
  const bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const level of layerLevel0s) {
    for (const axis of [0, 1, 2] as const) {
      bboxMin[axis] = Math.min(bboxMin[axis], level.origin[axis])
      bboxMax[axis] = Math.max(bboxMax[axis], level.origin[axis] + (level.size[axis] - 1) * level.spacing[axis])
    }
  }

  // Coarsen from native spacing by successive doublings until the union
  // bbox fits the voxel budget at that resolution.
  let factor = 1
  let refSize: [number, number, number] = [0, 0, 0]
  for (;;) {
    refSize = [0, 1, 2].map(
      (axis) => Math.floor((bboxMax[axis] - bboxMin[axis]) / (nativeSpacing[axis] * factor)) + 1
    ) as [number, number, number]
    const voxelCount = refSize[0] * refSize[1] * refSize[2]
    if (voxelCount <= REFERENCE_VOXEL_BUDGET || factor > 1024) break
    factor *= 2
  }
  const refSpacing: [number, number, number] = [nativeSpacing[0] * factor, nativeSpacing[1] * factor, nativeSpacing[2] * factor]
  const refLevel: ZarrLevelInfo = { index: 0, levelPath: 'scale0', size: refSize, dtype: '<u2', origin: bboxMin, spacing: refSpacing }
  const [refZ, refY, refX] = refLevel.size

  const combined = new Uint16Array(refX * refY * refZ)
  const mapping: MergedSegmentMapping[] = []
  let nextGlobalLabel = 1

  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const { segZarrGroupPath, labelValues } = layers[layerIndex]
    if (labelValues.length === 0) continue

    const segLevels = await readZarrLevels(segZarrGroupPath)
    const segLevel = pickLevelUnderBudget(segLevels, REFERENCE_VOXEL_BUDGET)
    const segData = await readWholeZarrLevel(segZarrGroupPath, segLevel)
    const [segSizeX, segSizeY, segSizeZ] = segData.size

    const labelToGlobal = new Map<number, number>()
    for (const originalLabelValue of labelValues) {
      const globalLabelValue = nextGlobalLabel++
      labelToGlobal.set(originalLabelValue, globalLabelValue)
      mapping.push({ globalLabelValue, layerIndex, originalLabelValue })
    }

    // Per-axis affine mapping from a reference voxel index to this layer's
    // own nearest voxel index -- see useSegmentationOverlays.ts's
    // SliceOverlay comment for the identical 2D-pane formula this mirrors.
    // [z, y, x] order, matching ZarrLevelInfo.
    const scaleZ = refLevel.spacing[0] / segLevel.spacing[0]
    const scaleY = refLevel.spacing[1] / segLevel.spacing[1]
    const scaleX = refLevel.spacing[2] / segLevel.spacing[2]
    const offsetZ = (refLevel.origin[0] - segLevel.origin[0]) / segLevel.spacing[0]
    const offsetY = (refLevel.origin[1] - segLevel.origin[1]) / segLevel.spacing[1]
    const offsetX = (refLevel.origin[2] - segLevel.origin[2]) / segLevel.spacing[2]

    for (let z = 0; z < refZ; z++) {
      const sz = Math.round(z * scaleZ + offsetZ)
      if (sz < 0 || sz >= segSizeZ) continue
      for (let y = 0; y < refY; y++) {
        const sy = Math.round(y * scaleY + offsetY)
        if (sy < 0 || sy >= segSizeY) continue
        const dstRowBase = z * refY * refX + y * refX
        const srcRowBase = sz * segSizeY * segSizeX + sy * segSizeX
        for (let x = 0; x < refX; x++) {
          const sx = Math.round(x * scaleX + offsetX)
          if (sx < 0 || sx >= segSizeX) continue
          const srcVal = segData.data[srcRowBase + sx]
          if (srcVal === 0) continue
          const globalLabelValue = labelToGlobal.get(srcVal)
          // Later layers in the input list win on overlap -- an arbitrary
          // but deterministic tie-break, since itk-vtk-viewer's label image
          // has no independent concept of "on top" the way the 2D pane's
          // ordered overlay list does.
          if (globalLabelValue !== undefined) combined[dstRowBase + x] = globalLabelValue
        }
      }
    }
  }

  const combinedLevel: Level = { data: combined, size: [refX, refY, refZ] }
  const pyramidLevels = buildPyramid(combinedLevel, Uint16Array, downsample2xNearest)
  await writeMultiscaleGroup(
    outputZarrPath,
    pyramidLevels,
    '<u2',
    Uint16Array,
    [refLevel.spacing[2], refLevel.spacing[1], refLevel.spacing[0]],
    [refLevel.origin[2], refLevel.origin[1], refLevel.origin[0]],
    'nearest'
  )

  return { mapping }
}
