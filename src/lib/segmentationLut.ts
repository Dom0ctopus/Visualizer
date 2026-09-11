import type { SegmentState } from '../types'

export interface Lut {
  lut: Uint8ClampedArray
  min: number
  max: number
}

/**
 * Builds a discrete label lookup table for one opacity-bucket volume: each listed
 * segment's label gets its own color at full alpha (that volume's own `.opacity`
 * property is what drives visible transparency -- see LoadedSegmentation.volumeIdsByBucket),
 * and every other label value is fully transparent.
 *
 * `allSegmentsInLayer` (every segment in the layer, not just this bucket's) sizes the
 * table: niivue packs all loaded volumes' label colormaps into one shared texture atlas,
 * so sibling bucket volumes for the same layer must all upload identically-sized tables --
 * otherwise a shorter table leaves stale/undefined texture data at the higher label
 * indices other buckets rely on, corrupting their colors.
 */
export function buildLutForBucket(segmentsInBucket: SegmentState[], allSegmentsInLayer: SegmentState[]): Lut {
  const maxLabel = Math.max(1, ...allSegmentsInLayer.map((s) => s.labelValue))
  const entries = maxLabel + 1
  const lut = new Uint8ClampedArray(entries * 4)
  for (const seg of segmentsInBucket) {
    const i = seg.labelValue * 4
    if (seg.labelValue < 0 || i + 3 >= lut.length) continue
    lut[i] = seg.color[0]
    lut[i + 1] = seg.color[1]
    lut[i + 2] = seg.color[2]
    lut[i + 3] = 255
  }
  return { lut, min: 0, max: entries - 1 }
}

/** Rounds a 0..1 opacity to an integer percent bucket 0-100 (0 means invisible). */
export function opacityBucket(opacity: number): number {
  return Math.max(0, Math.min(100, Math.round(opacity * 100)))
}
