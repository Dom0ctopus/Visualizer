import type { SliceOverlay } from '../hooks/useSegmentationOverlays'

/**
 * Maps a client-space point to a canvas's own bitmap pixel coordinates,
 * accounting for both object-fit:contain letterboxing (the canvas's CSS box
 * can be a different aspect ratio than its backing bitmap -- see
 * ZarrSliceCanvas's .zarr-slice-canvas) and any CSS transform already baked
 * into `rect` (getBoundingClientRect reflects a transform on its own, so
 * this needs no separate correction for zoom/pan). Returns null when the
 * point falls in the letterboxed margin, i.e. genuinely outside the image.
 *
 * Pulled out of ZarrSliceCanvas as a pure function (no DOM/React
 * dependency beyond the plain numbers callers extract from
 * getBoundingClientRect/canvas.width/height) so it's directly unit-testable
 * without a real browser -- this sandbox's headless Chromium reliably
 * deadlocks once itk-vtk-viewer's WebGL 3D pane is driven through a real
 * page (see the project history), which is unavoidable in an end-to-end
 * test of hover here since loading a segmentation always also feeds
 * itk-vtk-viewer's cumulative 3D merge.
 */
export function clientToPixel(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  bitmapW: number,
  bitmapH: number
): { x: number; y: number } | null {
  if (bitmapW === 0 || bitmapH === 0) return null
  if (rect.width === 0 || rect.height === 0) return null
  const contentScale = Math.min(rect.width / bitmapW, rect.height / bitmapH)
  const contentW = bitmapW * contentScale
  const contentH = bitmapH * contentScale
  const marginX = (rect.width - contentW) / 2
  const marginY = (rect.height - contentH) / 2
  const localX = clientX - rect.left - marginX
  const localY = clientY - rect.top - marginY
  const x = Math.floor(localX / contentScale)
  const y = Math.floor(localY / contentScale)
  if (x < 0 || x >= bitmapW || y < 0 || y >= bitmapH) return null
  return { x, y }
}

/**
 * Finds whichever overlay's label is topmost (last-composited, same order
 * ZarrSliceCanvas's own render loop paints them in) and actually visible
 * (non-empty name) at a given base-slice pixel -- or null for background/
 * hidden/out-of-bounds. Pulled out alongside clientToPixel for the same
 * unit-testability reason.
 */
export function findHoveredSegmentName(overlays: SliceOverlay[], pixel: { x: number; y: number }): string | null {
  for (let i = overlays.length - 1; i >= 0; i--) {
    const overlay = overlays[i]
    const ox = Math.round(pixel.x * overlay.scaleX + overlay.offsetX)
    const oy = Math.round(pixel.y * overlay.scaleY + overlay.offsetY)
    if (ox < 0 || ox >= overlay.width || oy < 0 || oy >= overlay.height) continue
    const label = overlay.data[oy * overlay.width + ox]
    if (overlay.lut[label * 4 + 3] === 0) continue
    const name = overlay.names[label]
    if (name) return name
  }
  return null
}
