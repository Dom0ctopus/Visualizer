import type { SegmentState } from '../types'

export interface LabelLut {
  /** Indexed by labelValue*4 -> [r, g, b, alpha(0-255)]. A label with no
   *  visible segment (or not present at all) has alpha 0, i.e. fully
   *  transparent -- so compositing can look it up unconditionally without
   *  a separate "does this label exist" check. */
  lut: Uint8ClampedArray
  /** Indexed by labelValue -> that segment's display name, or '' if the
   *  label doesn't correspond to any known segment. Parallel to `lut`, kept
   *  as a plain array (not a Map) so a mouse-hover lookup is a single
   *  indexed read, same cost as the color lookup it happens alongside. */
  names: string[]
  /** Indexed by labelValue -> 1 if the segment is in the search focus set
   *  (outlined in the 2D panes); null when no focus is active. */
  focus: Uint8Array | null
}

/** Search focus as the 2D overlays apply it. */
export interface OverlayFocus {
  isFocused: (segment: SegmentState) => boolean
  /** Opacity multiplier for segments outside the focus set. */
  fade: number
}

/**
 * Builds a direct label -> RGBA lookup table for one segmentation layer's
 * segments, for the 2D panes' compositing (ZarrSliceCanvas): each segment's
 * exact opacity and 3D-Slicer-defined color go straight into the table.
 */
export function buildLabelLut(segmentsInLayer: SegmentState[], focus: OverlayFocus | null = null): LabelLut {
  const maxLabel = Math.max(0, ...segmentsInLayer.map((s) => s.labelValue))
  const lut = new Uint8ClampedArray((maxLabel + 1) * 4)
  const names = new Array<string>(maxLabel + 1).fill('')
  const focusFlags = focus ? new Uint8Array(maxLabel + 1) : null
  for (const seg of segmentsInLayer) {
    if (!seg.visible || seg.opacity <= 0 || seg.labelValue < 0) continue
    const focused = focus?.isFocused(seg) ?? false
    if (focusFlags && focused) focusFlags[seg.labelValue] = 1
    const i = seg.labelValue * 4
    lut[i] = seg.color[0]
    lut[i + 1] = seg.color[1]
    lut[i + 2] = seg.color[2]
    lut[i + 3] = Math.round(seg.opacity * (focus && !focused ? focus.fade : 1) * 255)
    // Same visibility/opacity gate as the color above -- a hover shouldn't
    // report the name of a segment that's currently hidden (alpha 0), since
    // there's nothing actually drawn there to be hovering over.
    names[seg.labelValue] = seg.name
  }
  return { lut, names, focus: focusFlags }
}
