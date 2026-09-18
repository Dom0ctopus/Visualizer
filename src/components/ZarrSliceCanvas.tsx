import { useEffect, useMemo, useRef } from 'react'
import type { SliceOverlay } from '../hooks/useSegmentationOverlays'
import type { SliceResult } from '../lib/zarrClient'

export interface CanvasPan {
  x: number
  y: number
}

interface ZarrSliceCanvasProps {
  slice: SliceResult | null
  windowMin: number
  windowMax: number
  onWheelStep: (delta: number) => void
  /** Segmentation label-map overlays to alpha-composite on top of the base
   *  grayscale slice, in order (later entries painted over earlier ones) --
   *  see useSegmentationOverlays.ts. An overlay's own grid is commonly
   *  smaller than `slice` (a cropped segmentation export) and positioned via
   *  its own offsetX/offsetY; pixels outside its bounds simply show the
   *  base slice underneath. */
  overlays?: SliceOverlay[]
  /** Display zoom/pan, applied as a CSS transform on the canvas element --
   *  entirely separate from the pixel data drawn into it, so panning/
   *  zooming never re-triggers the (expensive, native-resolution) redraw
   *  loop below. Controlled from the parent so the sidebar's zoom buttons
   *  and this component's own drag/ctrl+scroll gestures drive the same
   *  state. */
  zoom: number
  pan: CanvasPan
  onZoomChange: (zoom: number) => void
  onPanChange: (pan: CanvasPan) => void
}

// Integer typed arrays only ever take one of a small, known set of raw
// values, so window/level can be precomputed once per (windowMin, windowMax)
// change into a lookup table indexed directly by the raw value -- turning
// the per-pixel cost from a few floating-point ops + a round() into a single
// array read. Signed types are offset so index 0 is their minimum value.
// Float arrays (rare for scan data) fall back to computing per pixel, since
// their range isn't practically enumerable.
function lutRangeFor(data: SliceResult['data']): { size: number; offset: number } | null {
  if (data instanceof Uint8Array) return { size: 256, offset: 0 }
  if (data instanceof Int8Array) return { size: 256, offset: 128 }
  if (data instanceof Uint16Array) return { size: 65536, offset: 0 }
  if (data instanceof Int16Array) return { size: 65536, offset: 32768 }
  return null
}

function buildLut(size: number, offset: number, windowMin: number, windowMax: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size)
  const range = Math.max(1e-6, windowMax - windowMin)
  for (let i = 0; i < size; i++) {
    const value = i - offset
    const t = Math.min(1, Math.max(0, (value - windowMin) / range))
    lut[i] = Math.round(t * 255)
  }
  return lut
}

/**
 * Draws one full-resolution 2D slice (read directly from the OME-Zarr store
 * by useZarrSliceViewer, bypassing itk-vtk-viewer's slice machinery
 * entirely -- see that hook's own comment for why) onto a plain 2D canvas,
 * applying window/level ourselves since there's no library UI doing it here.
 */
const ZOOM_FACTOR_PER_WHEEL_NOTCH = 1.1
const MIN_ZOOM = 0.1
const MAX_ZOOM = 20

export function ZarrSliceCanvas({
  slice,
  windowMin,
  windowMax,
  onWheelStep,
  overlays,
  zoom,
  pan,
  onZoomChange,
  onPanChange
}: ZarrSliceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Reused across renders so scrolling through many slices at the same
  // dimensions doesn't allocate a fresh backing buffer every frame.
  const imageDataRef = useRef<ImageData | null>(null)
  // Mirrors of the latest zoom/pan/callback props, read from inside the
  // wheel/drag event listeners below -- those are attached once (empty
  // dep array) rather than re-attached on every zoom/pan change, so drag
  // and ctrl+scroll stay responsive to the values that were current at
  // the moment of the gesture without needing to constantly detach/
  // reattach native listeners.
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  const onZoomChangeRef = useRef(onZoomChange)
  const onPanChangeRef = useRef(onPanChange)
  const onWheelStepRef = useRef(onWheelStep)
  useEffect(() => {
    zoomRef.current = zoom
    panRef.current = pan
    onZoomChangeRef.current = onZoomChange
    onPanChangeRef.current = onPanChange
    onWheelStepRef.current = onWheelStep
  }, [zoom, pan, onZoomChange, onPanChange, onWheelStep])

  const lutRange = slice ? lutRangeFor(slice.data) : null
  const lut = useMemo(
    () => (lutRange ? buildLut(lutRange.size, lutRange.offset, windowMin, windowMax) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lutRange?.size, lutRange?.offset, windowMin, windowMax]
  )

  useEffect(() => {
    const renderT0 = performance.now()
    const canvas = canvasRef.current
    if (!canvas || !slice) return
    const { width, height, data } = slice
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let imageData = imageDataRef.current
    if (!imageData || imageData.width !== width || imageData.height !== height) {
      imageData = ctx.createImageData(width, height)
      imageDataRef.current = imageData
    }
    const out = imageData.data
    // Only overlays whose (possibly smaller, possibly offset) footprint
    // actually overlaps the base slice's bounds need to be considered per
    // pixel below -- see useSegmentationOverlays.ts for why an overlay's
    // grid commonly differs in size/position from the base slice's.
    const activeOverlays = (overlays ?? []).filter(
      (o) => o.offsetX < width && o.offsetX + o.width > 0 && o.offsetY < height && o.offsetY + o.height > 0
    )

    for (let y = 0; y < height; y++) {
      const rowBase = y * width
      for (let x = 0; x < width; x++) {
        const i = rowBase + x
        let gray: number
        if (lut) {
          gray = lut[data[i] + lutRange!.offset]
        } else {
          const range = Math.max(1e-6, windowMax - windowMin)
          const t = Math.min(1, Math.max(0, (data[i] - windowMin) / range))
          gray = Math.round(t * 255)
        }
        let r = gray
        let g = gray
        let b = gray
        for (const overlay of activeOverlays) {
          const ox = x - overlay.offsetX
          const oy = y - overlay.offsetY
          if (ox < 0 || ox >= overlay.width || oy < 0 || oy >= overlay.height) continue
          const label = overlay.data[oy * overlay.width + ox]
          const lutOffset = label * 4
          const alphaByte = overlay.lut[lutOffset + 3]
          if (alphaByte === 0) continue
          const alpha = alphaByte / 255
          r = overlay.lut[lutOffset] * alpha + r * (1 - alpha)
          g = overlay.lut[lutOffset + 1] * alpha + g * (1 - alpha)
          b = overlay.lut[lutOffset + 2] * alpha + b * (1 - alpha)
        }
        const o = i * 4
        out[o] = r
        out[o + 1] = g
        out[o + 2] = b
        out[o + 3] = 255
      }
    }
    const pixelLoopDone = performance.now()
    ctx.putImageData(imageData, 0, 0)
    // Temporary diagnostic instrumentation -- see the scroll-performance
    // investigation in the project history. Separates the CPU pixel loop
    // from the canvas upload so a slow frame can be attributed correctly.
    console.log(
      `[zarr-perf] canvas redraw ${width}x${height}, ${activeOverlays.length} overlay(s): pixel loop ${(pixelLoopDone - renderT0).toFixed(1)}ms, putImageData ${(performance.now() - pixelLoopDone).toFixed(1)}ms`
    )
  }, [slice, windowMin, windowMax, lut, lutRange, overlays])

  // React's synthetic wheel handler is passive by default (a React 17+
  // change for scroll-performance), so calling preventDefault() from a JSX
  // onWheel prop is a no-op with a console warning -- attach real,
  // non-passive native listeners instead. Attached once (empty dep array)
  // and reading the *Ref mirrors above so a scroll or drag gesture always
  // sees the latest zoom/pan without needing to reattach listeners on
  // every value change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Plain scroll steps through Z (matching 3D-Slicer); holding
    // ctrl/cmd -- the standard "pinch/scroll to zoom" modifier browsers
    // themselves use for page zoom -- zooms the slice view instead, about
    // its own center (not the cursor: this is a lightweight display
    // transform, not a full viewport-anchored zoom, and center-anchored
    // is simple to get right without visual verification in this
    // sandbox's headless environment -- see the surrounding session's own
    // WebGL-testing limitations).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY > 0 ? 1 / ZOOM_FACTOR_PER_WHEEL_NOTCH : ZOOM_FACTOR_PER_WHEEL_NOTCH
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current * factor))
        onZoomChangeRef.current(nextZoom)
      } else {
        onWheelStepRef.current(e.deltaY > 0 ? 1 : -1)
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // Plain left-button drag pans -- translate() is applied in outer
    // (unscaled) CSS pixels regardless of the current zoom (see this
    // component's own transform below), so a 1:1 mapping from mouse
    // movement to pan delta is correct at any zoom level without needing
    // to divide by zoom here.
    let dragging = false
    let dragStart = { x: 0, y: 0 }
    let panStart: CanvasPan = { x: 0, y: 0 }
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      dragging = true
      dragStart = { x: e.clientX, y: e.clientY }
      panStart = panRef.current
      canvas.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      onPanChangeRef.current({ x: panStart.x + (e.clientX - dragStart.x), y: panStart.y + (e.clientY - dragStart.y) })
    }
    const onPointerUp = (e: PointerEvent) => {
      dragging = false
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)

    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="zarr-slice-canvas"
      style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
    />
  )
}
