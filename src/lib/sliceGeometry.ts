import type { SliceOverlay } from '../hooks/useSegmentationOverlays'

/**
 * Everything needed to map between a 2D pane's container (CSS pixels,
 * relative to its top-left) and the slice's own storage pixels. Shared by
 * the WebGL renderer (to place the image), the crosshair/label overlay, and
 * pointer handling (hover, click-to-navigate), so all three always agree.
 */
export interface ViewGeometry {
  containerWidth: number
  containerHeight: number
  /** Storage dimensions of the slice. */
  imageWidth: number
  imageHeight: number
  /** Physical size (mm) of one pixel: [along width, along height]. */
  pixelSpacing: [number, number]
  zoom: number
  pan: { x: number; y: number }
  /** Draw storage row 0 at the bottom instead of the top. */
  flipY: boolean
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the image sits in its container: fit (contain) to the container by
 * its *physical* aspect ratio -- so anisotropic voxels display at their real
 * proportions rather than as square pixels -- then scaled by `zoom` about
 * the container center and shifted by `pan`.
 */
export function imageRect(g: ViewGeometry): Rect {
  const physW = g.imageWidth * g.pixelSpacing[0]
  const physH = g.imageHeight * g.pixelSpacing[1]
  if (physW <= 0 || physH <= 0 || g.containerWidth <= 0 || g.containerHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const fit = Math.min(g.containerWidth / physW, g.containerHeight / physH)
  const width = physW * fit * g.zoom
  const height = physH * fit * g.zoom
  return {
    left: g.containerWidth / 2 + g.pan.x - width / 2,
    top: g.containerHeight / 2 + g.pan.y - height / 2,
    width,
    height
  }
}

/** Container point -> storage pixel, or null when outside the image. */
export function containerToPixel(px: number, py: number, g: ViewGeometry): { x: number; y: number } | null {
  const r = imageRect(g)
  if (r.width === 0 || r.height === 0) return null
  const x = Math.floor(((px - r.left) / r.width) * g.imageWidth)
  const displayRow = Math.floor(((py - r.top) / r.height) * g.imageHeight)
  if (x < 0 || x >= g.imageWidth || displayRow < 0 || displayRow >= g.imageHeight) return null
  return { x, y: g.flipY ? g.imageHeight - 1 - displayRow : displayRow }
}

/** Storage pixel center -> container point. */
export function pixelToContainer(x: number, y: number, g: ViewGeometry): { x: number; y: number } {
  const r = imageRect(g)
  const displayRow = g.flipY ? g.imageHeight - 1 - y : y
  return {
    x: r.left + ((x + 0.5) / g.imageWidth) * r.width,
    y: r.top + ((displayRow + 0.5) / g.imageHeight) * r.height
  }
}

/**
 * Finds whichever overlay's label is topmost (last-composited, the same
 * order the renderer draws them in) and actually visible (non-empty name)
 * at a given base-slice storage pixel -- or null for background, hidden
 * labels, or positions outside every overlay's own grid.
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
