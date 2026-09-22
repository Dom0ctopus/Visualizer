import { buildPyramid, downsample2xNearest, writeMultiscaleGroup, type Level } from './zarrWriter.js'
import { pickLevelUnderBudget, readWholeZarrLevel, readZarrLevels } from './zarrReader.js'

// Comfortably under itk-vtk-viewer's own hard voxel cap (2^28 =
// 268,435,456, confirmed by reading its bundled source -- see
// zarrWriter.ts's own comment on CUBE_CHUNK_VOXEL_BUDGET) so the merged
// label image itk-vtk-viewer actually loads is never the thing that trips
// it, and so this conversion (which resamples every included layer across
// every reference voxel) stays fast enough to run on demand.
const REFERENCE_VOXEL_BUDGET = 96_000_000

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
 * Resolution: built at whichever of the base volume's own pyramid levels
 * is the finest one still comfortably under itk-vtk-viewer's voxel cap
 * (REFERENCE_VOXEL_BUDGET) -- not the volume's native resolution, which
 * would make this both very slow (resampling scales with reference voxel
 * count times layer count) and pointless, since the 3D pane could never
 * load a finer label image than that anyway. Each input layer is read at
 * whichever of ITS OWN levels similarly fits, then resampled onto the
 * reference grid via the same nearest-neighbor, physical-origin/spacing
 * affine mapping useSegmentationOverlays.ts uses for the 2D pane -- so a
 * cropped export or a coarser-spacing ROI segmentation (see that file's own
 * comment) merges in correctly aligned, not just ones that already share
 * the volume's exact grid.
 */
export async function convertSegmentationMergeToOmeZarr(
  volumeZarrGroupPath: string,
  layers: MergeLayerInput[],
  outputZarrPath: string
): Promise<{ mapping: MergedSegmentMapping[] }> {
  const baseLevels = await readZarrLevels(volumeZarrGroupPath)
  const refLevel = pickLevelUnderBudget(baseLevels, REFERENCE_VOXEL_BUDGET)
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
