/**
 * Scale bars for the 3D views and their captures. A view's scale is the
 * physical height (mm, the scans' units) it shows at the camera's focal
 * plane; the bar is the longest 1/2/5 x 10^n length that fits in a fraction
 * of the view's width.
 */

/** Largest 1, 2 or 5 x 10^n not above `max`. */
export function niceLength(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 0
  const power = 10 ** Math.floor(Math.log10(max))
  for (const step of [5, 2, 1]) if (step * power <= max) return step * power
  return power
}

/** "500 µm", "2 mm", "1.5 cm"-free: mm from 1 mm up, µm below. */
export function formatLength(mm: number): string {
  const trim = (n: number) => String(Number(n.toPrecision(6)))
  return mm >= 1 ? `${trim(mm)} mm` : `${trim(mm * 1000)} µm`
}

export interface ScaleBar {
  /** Bar length in pixels of the view it was computed for. */
  pixels: number
  label: string
}

/** The scale bar for a view `widthPx` x `heightPx` showing `viewHeightMm`. */
export function scaleBarFor(viewHeightMm: number | null, widthPx: number, heightPx: number, maxFraction = 0.2): ScaleBar | null {
  if (!viewHeightMm || !(viewHeightMm > 0) || heightPx <= 0) return null
  const mmPerPx = viewHeightMm / heightPx
  const mm = niceLength(widthPx * maxFraction * mmPerPx)
  if (!mm) return null
  return { pixels: mm / mmPerPx, label: formatLength(mm) }
}

/** Draws a scale bar in the bottom-right corner of a capture. */
export function drawScaleBar(ctx: CanvasRenderingContext2D, width: number, height: number, viewHeightMm: number | null): void {
  const bar = scaleBarFor(viewHeightMm, width, height)
  if (!bar) return
  const s = Math.max(1, Math.min(width, height) / 700) // scale with output size
  const margin = 24 * s
  const x1 = width - margin
  const x0 = x1 - bar.pixels
  const y = height - margin
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)'
  ctx.shadowBlur = 4 * s
  ctx.strokeStyle = '#f5f6f9'
  ctx.fillStyle = '#f5f6f9'
  ctx.lineWidth = 2 * s
  ctx.lineCap = 'butt'
  ctx.beginPath()
  ctx.moveTo(x0, y - 5 * s)
  ctx.lineTo(x0, y)
  ctx.lineTo(x1, y)
  ctx.lineTo(x1, y - 5 * s)
  ctx.stroke()
  ctx.font = `600 ${Math.round(13 * s)}px -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', Roboto, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText(bar.label, (x0 + x1) / 2, y - 8 * s)
  ctx.restore()
}
