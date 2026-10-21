import type { CaptureTarget } from '../components/CaptureBar'
import { startCompositeRecording, type CanvasRecording } from './capture'
import { drawScaleBar } from './scaleBar'

/** Starts recording a view, with a scale bar that follows the zoom; with
 *  `fit`, cropped to the subject (see CaptureTarget.contentRect). Null when
 *  there's nothing to record yet. */
export function startViewRecording(view: CaptureTarget, fit: boolean): CanvasRecording | null {
  const canvas = view.canvas()
  if (!canvas) return null
  const crop = fit ? (view.contentRect?.() ?? null) : null
  // The scale bar's mm-per-pixel is the full view's; a crop shows part of
  // that height.
  const heightShare = crop ? crop.height / canvas.height : 1
  return startCompositeRecording(
    canvas,
    view.onFrame,
    view.requestRender,
    (ctx, w, h) => {
      const mm = view.viewHeightMm()
      drawScaleBar(ctx, w, h, mm === null ? null : mm * heightShare)
    },
    crop
  )
}
