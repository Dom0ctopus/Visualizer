import type { SegmentState } from '../types'

export interface Lut {
  lut: Uint8ClampedArray
  min: number
  max: number
}

/**
 * Builds a discrete label lookup table for one layer of a segmentation volume:
 * unlisted label values are fully transparent, and each segment's entry uses its
 * own color with alpha driven by that segment's visibility/opacity state.
 */
export function buildLutForLayer(segmentsInLayer: SegmentState[]): Lut {
  const maxLabel = Math.max(1, ...segmentsInLayer.map((s) => s.labelValue))
  const entries = maxLabel + 1
  const lut = new Uint8ClampedArray(entries * 4)
  for (const seg of segmentsInLayer) {
    const i = seg.labelValue * 4
    if (seg.labelValue < 0 || i + 3 >= lut.length) continue
    lut[i] = seg.color[0]
    lut[i + 1] = seg.color[1]
    lut[i + 2] = seg.color[2]
    lut[i + 3] = seg.visible ? Math.round(seg.opacity * 255) : 0
  }
  return { lut, min: 0, max: entries - 1 }
}
