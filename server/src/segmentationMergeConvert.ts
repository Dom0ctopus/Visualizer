import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { downsample2xLabelMode, writeZarrArrayV2, type Level, type TypedArray } from './zarrWriter.js'
import { readZarrLevels, readZRange, type ZarrLevelInfo } from './zarrReader.js'

/**
 * Expands `min`/`max` (local [x, y, z] voxel indices) to cover the nonzero
 * voxels of one band of slices starting at z0.
 */
function scanBandBbox(band: TypedArray, sx: number, sy: number, nz: number, z0: number, min: number[], max: number[]): void {
  for (let z = 0; z < nz; z++) {
    const zBase = z * sy * sx
    for (let y = 0; y < sy; y++) {
      const rowBase = zBase + y * sx
      for (let x = 0; x < sx; x++) {
        if (band[rowBase + x] === 0) continue
        if (x < min[0]) min[0] = x
        if (x > max[0]) max[0] = x
        if (y < min[1]) min[1] = y
        if (y > max[1]) max[1] = y
        if (z0 + z < min[2]) min[2] = z0 + z
        if (z0 + z > max[2]) max[2] = z0 + z
      }
    }
  }
}

// Slices read (and processed) at a time. Keeps memory bounded by a band
// rather than a whole native-resolution layer, and gives the event loop a
// turn between bands so the server keeps serving requests during a merge.
const MERGE_BAND_SLICES = 16

export interface MergeProgress {
  phase: 'scanning' | 'resampling' | 'writing'
  /** 1-based layer being processed, of layerCount. */
  layer: number
  layerCount: number
  /** 0..1 through the current layer (or the write). */
  fraction: number
}

export class MergeCancelledError extends Error {
  constructor() {
    super('Merge superseded by a newer request')
  }
}

export interface MergeOptions {
  onProgress?: (progress: MergeProgress) => void
  /** Polled between bands; returning true stops the merge with MergeCancelledError. */
  isCancelled?: () => boolean
}

/**
 * Fills the straight-line path between two ALREADY-SCATTERED reference
 * positions with `value`, excluding the endpoints themselves (the caller
 * has already set those). Used to connect two native-adjacent voxels
 * (see the main per-layer loop) whose downsampled reference positions
 * landed more than one cell apart -- closing exactly the gap a >1x
 * downsample factor can introduce between two voxels that were touching
 * in the source data, along the true path between them specifically,
 * rather than isotropic dilation (which pads sideways in every direction
 * equally, and visibly drifts a curved/sinuous path off its real position
 * since it fattens the *whole* curve rather than just bridging the actual
 * gaps in it).
 */
function fillLine(
  data: Uint16Array,
  refX: number,
  refY: number,
  refZ: number,
  z0: number,
  y0: number,
  x0: number,
  z1: number,
  y1: number,
  x1: number,
  value: number
): void {
  const steps = Math.max(Math.abs(z1 - z0), Math.abs(y1 - y0), Math.abs(x1 - x0))
  for (let t = 1; t < steps; t++) {
    const z = Math.round(z0 + ((z1 - z0) * t) / steps)
    const y = Math.round(y0 + ((y1 - y0) * t) / steps)
    const x = Math.round(x0 + ((x1 - x0) * t) / steps)
    if (z < 0 || z >= refZ || y < 0 || y >= refY || x < 0 || x >= refX) continue
    data[z * refY * refX + y * refX + x] = value
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
 * box, scanned from real data -- see scanBandBbox), not their declared
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
  outputZarrPath: string,
  options: MergeOptions = {}
): Promise<{ mapping: MergedSegmentMapping[] }> {
  const report = options.onProgress ?? (() => {})
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new MergeCancelledError()
  }
  const baseLevels = await readZarrLevels(volumeZarrGroupPath)
  const nativeSpacing = baseLevels.find((l) => l.index === 0)!.spacing

  // A segmentation's reported layerCount (server/src/index.ts's
  // enrichSegmentationRecord) comes from the HIGHEST layer any segment's
  // metadata declares itself on (Segment0_Layer, ...) -- not from how many
  // layers actually got written to disk during conversion, which is
  // segmentationZarrConvert.ts's own read of the NRRD's real "list axis"
  // size. A file whose header declares a segment on a layer beyond what its
  // own data actually contains (seen in practice) would otherwise crash the
  // whole merge on one missing directory; skip that one layer instead; with
  // a clear warning, so a metadata quirk in one segmentation doesn't take
  // down the cumulative view for every other segmentation that's fine.
  const candidateLayers = layers
    .map((layer, originalIndex) => ({ ...layer, originalIndex }))
    .filter((l) => l.labelValues.length > 0)
  const resolvedLayers = await Promise.all(
    candidateLayers.map(async (l) => {
      try {
        const level0 = (await readZarrLevels(l.segZarrGroupPath)).find((lv) => lv.index === 0)
        return level0 ? { layer: l, level0 } : null
      } catch (e) {
        console.warn(`Cumulative 3D view: skipping missing layer at ${l.segZarrGroupPath}:`, e instanceof Error ? e.message : e)
        return null
      }
    })
  )
  const includedLayers = resolvedLayers.filter((r) => r !== null).map((r) => r.layer)
  const layerLevel0s = resolvedLayers.filter((r) => r !== null).map((r) => r.level0)

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
  // Each layer is streamed a band of slices at a time here to scan it, then
  // streamed again by the resample loop below -- trading extra I/O for
  // memory bounded by a band, however large the layers are.
  const bboxMin: [number, number, number] = [Infinity, Infinity, Infinity]
  const bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < includedLayers.length; i++) {
    const level = layerLevel0s[i]
    const arrayDir = path.join(includedLayers[i].segZarrGroupPath, level.levelPath)
    const [sz, sy, sx] = level.size
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let z0 = 0; z0 < sz; z0 += MERGE_BAND_SLICES) {
      checkCancelled()
      report({ phase: 'scanning', layer: i + 1, layerCount: includedLayers.length, fraction: z0 / sz })
      const nz = Math.min(MERGE_BAND_SLICES, sz - z0)
      scanBandBbox(await readZRange(arrayDir, z0, nz), sx, sy, nz, z0, min, max)
    }
    if (!Number.isFinite(max[0])) continue // no nonzero voxels in this layer at all
    const [minX, minY, minZ] = min
    const [maxX, maxY, maxZ] = max
    // min/max are [x, y, z] local voxel indices; level.origin/spacing are
    // [z, y, x] -- convert each local axis to its matching physical axis.
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
    const arrayDir = path.join(segZarrGroupPath, segLevel.levelPath)
    const [segSizeZ, segSizeY, segSizeX] = segLevel.size

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
    // produce a continuous (or, at a >1x factor, lightly dashed -- see the
    // fillLine calls below, which bridge exactly that) run of reference
    // voxels.
    // [z, y, x] order, matching ZarrLevelInfo.
    const scaleZ = segLevel.spacing[0] / refLevel.spacing[0]
    const scaleY = segLevel.spacing[1] / refLevel.spacing[1]
    const scaleX = segLevel.spacing[2] / refLevel.spacing[2]
    const offsetZ = (segLevel.origin[0] - refLevel.origin[0]) / refLevel.spacing[0]
    const offsetY = (segLevel.origin[1] - refLevel.origin[1]) / refLevel.spacing[1]
    const offsetX = (segLevel.origin[2] - refLevel.origin[2]) / refLevel.spacing[2]

    for (let z0 = 0; z0 < segSizeZ; z0 += MERGE_BAND_SLICES) {
      checkCancelled()
      report({ phase: 'resampling', layer: i + 1, layerCount: includedLayers.length, fraction: z0 / segSizeZ })
      const nz = Math.min(MERGE_BAND_SLICES, segSizeZ - z0)
      // One extra slice past the band, for the z+1 neighbor check below.
      const bandData = await readZRange(arrayDir, z0, Math.min(nz + 1, segSizeZ - z0))
      for (let sz = z0; sz < z0 + nz; sz++) {
        const rz = Math.round(sz * scaleZ + offsetZ)
        if (rz < 0 || rz >= refZ) continue
        const srcZBase = (sz - z0) * segSizeY * segSizeX
        const dstZBase = rz * refY * refX
        for (let sy = 0; sy < segSizeY; sy++) {
          const ry = Math.round(sy * scaleY + offsetY)
          if (ry < 0 || ry >= refY) continue
          const srcRowBase = srcZBase + sy * segSizeX
          const dstRowBase = dstZBase + ry * refX
          for (let sx = 0; sx < segSizeX; sx++) {
            const srcVal = bandData[srcRowBase + sx]
            if (srcVal === 0) continue
            const rx = Math.round(sx * scaleX + offsetX)
            if (rx < 0 || rx >= refX) continue
            const globalLabelValue = labelToGlobal.get(srcVal)
            if (globalLabelValue === undefined) continue
            // Later layers in the input list win on overlap -- an arbitrary
            // but deterministic tie-break, since itk-vtk-viewer's label image
            // has no independent concept of "on top" the way the 2D panes'
            // ordered overlay list does.
            combined[dstRowBase + rx] = globalLabelValue

            // Connect to the 3 "forward" native neighbors (covers every
            // face-adjacent pair exactly once across the whole loop) that
            // share this same label -- if their own downsampled positions
            // land more than one reference cell away, fillLine bridges
            // exactly that gap along the true path between them. See
            // fillLine's own comment for why this is more accurate than
            // isotropic dilation for a curved/sinuous structure.
            if (sx + 1 < segSizeX && bandData[srcRowBase + sx + 1] === srcVal) {
              const nrx = Math.round((sx + 1) * scaleX + offsetX)
              fillLine(combined, refX, refY, refZ, rz, ry, rx, rz, ry, nrx, globalLabelValue)
            }
            if (sy + 1 < segSizeY && bandData[srcRowBase + segSizeX + sx] === srcVal) {
              const nry = Math.round((sy + 1) * scaleY + offsetY)
              fillLine(combined, refX, refY, refZ, rz, ry, rx, rz, nry, rx, globalLabelValue)
            }
            if (sz + 1 < segSizeZ && bandData[srcRowBase + segSizeY * segSizeX + sx] === srcVal) {
              const nrz = Math.round((sz + 1) * scaleZ + offsetZ)
              fillLine(combined, refX, refY, refZ, rz, ry, rx, nrz, ry, rx, globalLabelValue)
            }
          }
        }
      }
    }
  }

  checkCancelled()
  report({ phase: 'writing', layer: includedLayers.length, layerCount: includedLayers.length, fraction: 0 })
  const kMin = Math.round(Math.log2(factor))
  await writeAlignedLabelPyramid(outputZarrPath, { data: combined, size: [refX, refY, refZ] }, refLevel, kMin, Math.max(kMin, baseLevels.length - 1))

  return { mapping }
}

/**
 * Writes the merged label map so that its pyramid index k has the same
 * voxel spacing as the base volume's index k. itk-vtk-viewer fetches the
 * label image at the *same scale index* as the volume it's displaying
 * (confirmed in its source: `[image, labelImage].map(i => i.getImage(scale,
 * bounds))`), and on a real scan it can only display the volume at the
 * coarsest-but-one or so level (its 2^28 voxel cap) -- so if the merge's
 * own index 0 were the finest grid, itk would never show it: it would show
 * the merge's index-2 (or whatever) level instead, two more halvings away.
 *
 * The finest grid built (`finest`, at native spacing * 2^kMin) is written
 * at index kMin; indices below kMin (finer than we can afford to build)
 * alias that same array. Coarser indices are downsampled with
 * downsample2xLabelMode so thin structures survive them too. Arrays are
 * cube-chunked: itk-vtk-viewer loads whole regions, never single slices.
 */
async function writeAlignedLabelPyramid(
  outputPath: string,
  finest: Level,
  refLevel: ZarrLevelInfo,
  kMin: number,
  coarsestIndex: number
): Promise<void> {
  await mkdir(outputPath, { recursive: true })
  await writeFile(path.join(outputPath, '.zgroup'), JSON.stringify({ zarr_format: 2 }))
  let level = finest
  for (let k = kMin; k <= coarsestIndex; k++) {
    if (k > kMin) level = downsample2xLabelMode(level, Uint16Array)
    await writeZarrArrayV2(path.join(outputPath, `scale${k}`), level, '<u2', Uint16Array, false)
  }
  const datasets = []
  for (let k = 0; k <= coarsestIndex; k++) {
    const source = Math.max(k, kMin)
    const f = 2 ** (source - kMin)
    datasets.push({
      path: `scale${source}`,
      coordinateTransformations: [
        { type: 'scale', scale: [refLevel.spacing[0] * f, refLevel.spacing[1] * f, refLevel.spacing[2] * f] },
        { type: 'translation', translation: [refLevel.origin[0], refLevel.origin[1], refLevel.origin[2]] }
      ]
    })
  }
  const zattrs = {
    multiscales: [
      {
        version: '0.4',
        name: 'labels',
        axes: [
          { name: 'z', type: 'space', unit: 'millimeter' },
          { name: 'y', type: 'space', unit: 'millimeter' },
          { name: 'x', type: 'space', unit: 'millimeter' }
        ],
        datasets,
        type: 'mode'
      }
    ]
  }
  await writeFile(path.join(outputPath, '.zattrs'), JSON.stringify(zattrs))
}
