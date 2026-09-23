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
}

/**
 * Builds a direct label -> RGBA lookup table for one segmentation layer's
 * segments, for the itk-vtk-viewer engine's own slice-pane compositing
 * (ZarrSliceCanvas). Unlike the niivue engine's buildLutForBucket (which has
 * to pack segments into opacity-rounded "buckets" because niivue's
 * per-volume opacity is the only analog blending knob it has), this canvas
 * compositing controls the blend math directly, so each segment's own exact
 * (not rounded) opacity and exact 3D-Slicer-defined color can go straight
 * into the table -- true segment-color parity in this pane, unlike the 3D
 * Volume pane (see useItkVtkViewer.ts's label-image comments for why that
 * one can't match).
 */
export function buildLabelLut(segmentsInLayer: SegmentState[]): LabelLut {
  const maxLabel = Math.max(0, ...segmentsInLayer.map((s) => s.labelValue))
  const lut = new Uint8ClampedArray((maxLabel + 1) * 4)
  const names = new Array<string>(maxLabel + 1).fill('')
  for (const seg of segmentsInLayer) {
    if (!seg.visible || seg.opacity <= 0 || seg.labelValue < 0) continue
    const i = seg.labelValue * 4
    lut[i] = seg.color[0]
    lut[i + 1] = seg.color[1]
    lut[i + 2] = seg.color[2]
    lut[i + 3] = Math.round(seg.opacity * 255)
    // Same visibility/opacity gate as the color above -- a hover shouldn't
    // report the name of a segment that's currently hidden (alpha 0), since
    // there's nothing actually drawn there to be hovering over.
    names[seg.labelValue] = seg.name
  }
  return { lut, names }
}
