import { buildPyramid, downsample2xNearest, writeMultiscaleGroup, type Level, type TypedArray } from './zarrWriter.js'
import { readWholeZarrLevel, readZarrLevels, type ZarrLevelInfo } from './zarrReader.js'

/**
 * Scans a whole layer's native data for the tight bounding box of its
 * actual nonzero content, in that layer's own LOCAL [x, y, z] voxel
 * indices -- as opposed to its declared array shape, which segmentation
 * files in this app are commonly exported at full scan dimensions
 * regardless of how much of that volume the segmented structure actually
 * occupies (see convertSegmentationMergeToOmeZarr's own comment on why
 * this matters for widespread-but-sparse structures like vasculature).
 * Returns null if the layer has no nonzero voxels at all.
 */
function scanContentBbox(data: TypedArray, size: [number, number, number]): { min: [number, number, number]; max: [number, number, number] } | null {
  const [sx, sy] = size
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) continue
    const z = Math.floor(i / (sy * sx))
    const y = Math.floor((i - z * sy * sx) / sx)
    const x = i - z * sy * sx - y * sx
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  if (maxX < 0 || !Number.isFinite(minX)) return null
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
}

/**
 * One step of 6-connected (face-neighbor) dilation: any voxel that's
 * currently background (0) but has at least one nonzero face-neighbor
 * adopts that neighbor's value. Reads from an unmodified snapshot so the
 * dilation grows by exactly one voxel in this single pass, not an
 * uncontrolled cascade. This is the "padding voxels" step requested
 * alongside scatter-based resampling (see the main function's per-layer
 * loop): scattering already guarantees no native voxel of a thin structure
 * is silently dropped, but a >1x downsample factor can still leave a
 * single-voxel-wide structure as a lightly dashed line wherever
 * consecutive native voxels happened to land on non-adjacent reference
 * cells -- one dilation pass reliably bridges gaps of that size, and makes
 * genuinely thin structures a little more visible in the 3D render besides.
 */
function dilateOnce(data: Uint16Array, sx: number, sy: number, sz: number): void {
  const snapshot = data.slice()
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      const rowBase = z * sy * sx + y * sx
      for (let x = 0; x < sx; x++) {
        const i = rowBase + x
        if (snapshot[i] !== 0) continue
        if (x > 0 && snapshot[i - 1] !== 0) {
          data[i] = snapshot[i - 1]
        } else if (x < sx - 1 && snapshot[i + 1] !== 0) {
          data[i] = snapshot[i + 1]
        } else if (y > 0 && snapshot[i - sx] !== 0) {
          data[i] = snapshot[i - sx]
        } else if (y < sy - 1 && snapshot[i + sx] !== 0) {
          data[i] = snapshot[i + sx]
        } else if (z > 0 && snapshot[i - sy * sx] !== 0) {
          data[i] = snapshot[i - sy * sx]
        } else if (z < sz - 1 && snapshot[i + sy * sx] !== 0) {
          data[i] = snapshot[i + sy * sx]
        }
      }
    }
  }
}

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
 * Resolution: the OUTPUT reference grid is sized to the PHYSICAL EXTENT of
 * the included segmentations' ACTUAL nonzero content (their union bounding
 * box, scanned from real data -- see scanContentBbox), not their declared
 * array extent and not the whole base volume. Segmentation files here are
 * commonly exported at the full scan's own dimensions regardless of how
 * much of that space is actually labeled, and a widespread-but-sparse
 * structure (vasculature, nerves -- can touch most of the body while the
 * labeled voxels themselves are a tiny fraction of it) would size the
 * reference grid the same as the whole volume if extent alone were used,
 * undoing the resolution benefit entirely. The grid starts at the base
 * volume's own native (finest) voxel spacing and only coarsens (by
 * successive 2x, matching every other pyramid this app builds) if the
 * content bbox at that spacing would exceed REFERENCE_VOXEL_BUDGET -- a
 * small or genuinely localized structure can still fit fully native even
 * though its declared array spans the whole scan; something that truly is
 * spread through most of the volume converges toward roughly the
 * resolution the base volume itself displays at (e.g. its own "level 2").
 *
 * Every INPUT layer, regardless of the above, is always read at its OWN
 * native level (level 0) -- never a coarser level of its own pyramid, even
 * one that would technically fit the same voxel budget. Reading a
 * pre-downsampled level would mean resampling already-nearest-neighbor-
 * quantized data a second time onto the reference grid -- two independent
 * lossy quantization passes stacked on each other, which visibly
 * fragments/blocks thin structures (blood vessels, nerves) far more than
 * either pass alone. Reading native data and letting ONE resample onto the
 * reference grid do all the quantization keeps that to a single pass, even
 * when the output ends up at a coarser (e.g. level-2-equivalent)
 * resolution than the input. This does mean reading the same
 * amount of data this app's own per-segmentation conversion already reads
 * once during upload (see segmentationZarrConvert.ts) -- a real cost, but
 * not a new class of one.
 */
export async function convertSegmentationMergeToOmeZarr(
  volumeZarrGroupPath: string,
  layers: MergeLayerInput[],
  outputZarrPath: string
): Promise<{ mapping: MergedSegmentMapping[] }> {
  const baseLevels = await readZarrLevels(volumeZarrGroupPath)
  const nativeSpacing = baseLevels.find((l) => l.index === 0)!.spacing

  const includedLayers = layers
    .map((layer, originalIndex) => ({ ...layer, originalIndex }))
    .filter((l) => l.labelValues.length > 0)
  const layerLevel0s = await Promise.all(
    includedLayers.map(async (l) => (await readZarrLevels(l.segZarrGroupPath)).find((lv) => lv.index === 0)!)
  )

  // Union of every included layer's own physical bounding box, in [z, y, x]
  // mm. Computed from each layer's ACTUAL nonzero content (scanning its
  // native data), not its declared array extent -- segmentation files here
  // are commonly exported at the full scan's own dimensions regardless of
  // how much of that space the segmented structure occupies (confirmed
  // directly: a real cardiovascular/nerve segmentation's declared shape
  // matched the whole scan's own dimensions). Using the declared extent
  // for a widespread-but-sparse structure like vasculature -- which can
  // touch most of the body even though the labeled voxels themselves are a
  // tiny fraction of it -- would size the reference grid the same as the
  // old whole-volume approach and undo the resolution benefit entirely.
  // Each layer's data is read once here to scan it, then discarded (not
  // held) -- the resample loop below reads it again -- trading extra I/O
  // for bounded memory use regardless of how many layers are included, a
  // deliberate choice given how directly this app has already been bitten
  // by unbounded memory growth this session.
  const bboxMin: [number, number, number] = [Infinity, Infinity, Infinity]
  const bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < includedLayers.length; i++) {
    const level = layerLevel0s[i]
    const data = await readWholeZarrLevel(includedLayers[i].segZarrGroupPath, level)
    const content = scanContentBbox(data.data, data.size)
    if (!content) continue // no nonzero voxels in this layer at all
    const [minX, minY, minZ] = content.min
    const [maxX, maxY, maxZ] = content.max
    // content.min/max are [x, y, z] local voxel indices; level.origin/
    // spacing are [z, y, x] -- convert each local axis to its matching
    // physical [z, y, x] axis.
    const localMin = [minZ, minY, minX]
    const localMax = [maxZ, maxY, maxX]
    for (const axis of [0, 1, 2] as const) {
      bboxMin[axis] = Math.min(bboxMin[axis], level.origin[axis] + localMin[axis] * level.spacing[axis])
      bboxMax[axis] = Math.max(bboxMax[axis], level.origin[axis] + localMax[axis] * level.spacing[axis])
    }
  }

  // Every included layer was entirely empty (no nonzero voxels at all) --
  // write a minimal, valid (if useless) 1-voxel grid rather than let
  // Infinity/-Infinity propagate into NaN sizes below.
  if (!Number.isFinite(bboxMax[0])) {
    bboxMin[0] = bboxMin[1] = bboxMin[2] = 0
    bboxMax[0] = bboxMax[1] = bboxMax[2] = 0
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

  for (let i = 0; i < includedLayers.length; i++) {
    const { segZarrGroupPath, labelValues, originalIndex: layerIndex } = includedLayers[i]
    const segLevel = layerLevel0s[i]
    const segData = await readWholeZarrLevel(segZarrGroupPath, segLevel)
    const [segSizeX, segSizeY, segSizeZ] = segData.size

    const labelToGlobal = new Map<number, number>()
    for (const originalLabelValue of labelValues) {
      const globalLabelValue = nextGlobalLabel++
      labelToGlobal.set(originalLabelValue, globalLabelValue)
      mapping.push({ globalLabelValue, layerIndex, originalLabelValue })
    }

    // Forward ("scatter") mapping from this layer's own native voxel index
    // to a reference voxel index -- the inverse of a "gather" (for each
    // reference voxel, sample its one nearest source voxel), which is what
    // this used to be. Gather silently drops any source voxel that isn't
    // exactly the one nearest sample point for its reference cell -- fatal
    // for a structure only 1-2 voxels wide (blood vessels, nerves): most of
    // its native voxels are never anyone's "nearest" and just vanish,
    // fragmenting a continuous vessel into disconnected specks regardless
    // of how the reference resolution is chosen. Scatter instead visits
    // EVERY native voxel once and marks wherever it lands -- a thin
    // structure's full native path, not just whichever points happened to
    // be sampled, so a continuous run of native voxels can only ever
    // produce a continuous (or, worst case near a >1 factor, lightly
    // dashed -- see the dilation pass below) run of reference voxels.
    // [z, y, x] order, matching ZarrLevelInfo.
    const scaleZ = segLevel.spacing[0] / refLevel.spacing[0]
    const scaleY = segLevel.spacing[1] / refLevel.spacing[1]
    const scaleX = segLevel.spacing[2] / refLevel.spacing[2]
    const offsetZ = (segLevel.origin[0] - refLevel.origin[0]) / refLevel.spacing[0]
    const offsetY = (segLevel.origin[1] - refLevel.origin[1]) / refLevel.spacing[1]
    const offsetX = (segLevel.origin[2] - refLevel.origin[2]) / refLevel.spacing[2]

    for (let sz = 0; sz < segSizeZ; sz++) {
      const rz = Math.round(sz * scaleZ + offsetZ)
      if (rz < 0 || rz >= refZ) continue
      const srcZBase = sz * segSizeY * segSizeX
      const dstZBase = rz * refY * refX
      for (let sy = 0; sy < segSizeY; sy++) {
        const ry = Math.round(sy * scaleY + offsetY)
        if (ry < 0 || ry >= refY) continue
        const srcRowBase = srcZBase + sy * segSizeX
        const dstRowBase = dstZBase + ry * refX
        for (let sx = 0; sx < segSizeX; sx++) {
          const srcVal = segData.data[srcRowBase + sx]
          if (srcVal === 0) continue
          const rx = Math.round(sx * scaleX + offsetX)
          if (rx < 0 || rx >= refX) continue
          const globalLabelValue = labelToGlobal.get(srcVal)
          // Later layers in the input list win on overlap -- an arbitrary
          // but deterministic tie-break, since itk-vtk-viewer's label image
          // has no independent concept of "on top" the way the 2D pane's
          // ordered overlay list does.
          if (globalLabelValue !== undefined) combined[dstRowBase + rx] = globalLabelValue
        }
      }
    }
  }

  dilateOnce(combined, refX, refY, refZ)

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
