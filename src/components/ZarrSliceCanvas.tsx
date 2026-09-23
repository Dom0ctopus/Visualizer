import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SliceOverlay } from '../hooks/useSegmentationOverlays'
import { containerToPixel, findHoveredSegmentName, imageRect, pixelToContainer, type ViewGeometry } from '../lib/sliceGeometry'
import { SliceRenderer } from '../lib/sliceRenderer'
import type { SliceResult } from '../lib/zarrClient'

export interface CanvasPan {
  x: number
  y: number
}

export interface SliceCrosshair {
  /** Storage pixel of the linked cursor within this plane. */
  x: number
  y: number
  /** Color of the vertical line (constant x) and horizontal line (constant y). */
  colorX: string
  colorY: string
}

export interface OrientationLabels {
  left: string
  right: string
  top: string
  bottom: string
}

interface ZarrSliceCanvasProps {
  slice: SliceResult | null
  windowMin: number
  windowMax: number
  onWheelStep: (delta: number) => void
  /** Label-map overlays composited over the slice in order (later on top) --
   *  see useSegmentationOverlays.ts. */
  overlays?: SliceOverlay[]
  zoom: number
  pan: CanvasPan
  onZoomChange: (zoom: number) => void
  onPanChange: (pan: CanvasPan) => void
  /** Segment name under the cursor, or null over background/hidden labels/
   *  outside the image. clientX/clientY position a tooltip. */
  onHoverLabel?: (info: { name: string; clientX: number; clientY: number } | null) => void
  /** Physical size (mm) of one pixel [along width, along height]. */
  pixelSpacing: [number, number]
  /** Draw storage row 0 at the bottom (coronal/sagittal, so superior is up). */
  flipY?: boolean
  crosshair?: SliceCrosshair | null
  /** A click (press and release without dragging) at a storage pixel. */
  onPick?: (pixel: { x: number; y: number }) => void
  labels?: OrientationLabels
}

const ZOOM_FACTOR_PER_WHEEL_NOTCH = 1.1
const MIN_ZOOM = 0.1
const MAX_ZOOM = 20
const CLICK_SLOP_PX = 4

/**
 * One 2D pane: a WebGL2 canvas (see sliceRenderer.ts) plus an SVG layer for
 * the linked crosshair and orientation labels. Scroll steps through slices,
 * ctrl/cmd+scroll zooms, drag pans, click moves the linked cursor.
 */
export function ZarrSliceCanvas({
  slice,
  windowMin,
  windowMax,
  onWheelStep,
  overlays,
  zoom,
  pan,
  onZoomChange,
  onPanChange,
  onHoverLabel,
  pixelSpacing,
  flipY = false,
  crosshair,
  onPick,
  labels
}: ZarrSliceCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<SliceRenderer | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [glError, setGlError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const geometry: ViewGeometry | null = slice
    ? {
        containerWidth: size.width,
        containerHeight: size.height,
        imageWidth: slice.width,
        imageHeight: slice.height,
        pixelSpacing,
        zoom,
        pan,
        flipY
      }
    : null

  // Latest values for the native event listeners below, which are attached
  // once rather than on every change.
  const latest = useRef({ geometry, overlays, zoom, pan, onZoomChange, onPanChange, onWheelStep, onHoverLabel, onPick })
  useLayoutEffect(() => {
    latest.current = { geometry, overlays, zoom, pan, onZoomChange, onPanChange, onWheelStep, onHoverLabel, onPick }
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      rendererRef.current = new SliceRenderer(canvas)
    } catch (e) {
      setGlError(e instanceof Error ? e.message : 'Failed to initialize WebGL2')
    }
    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      setSize({ width: container.clientWidth, height: container.clientHeight })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    if (!canvas || !renderer) return
    const dpr = window.devicePixelRatio || 1
    const bw = Math.max(1, Math.round(size.width * dpr))
    const bh = Math.max(1, Math.round(size.height * dpr))
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    try {
      renderer.setSlice(slice)
      renderer.setOverlays(overlays ?? [])
      setGlError(null)
    } catch (e) {
      setGlError(e instanceof Error ? e.message : 'Failed to upload slice to the GPU')
      return
    }
    const frame = requestAnimationFrame(() => {
      renderer.draw({
        rect: geometry ? imageRect(geometry) : { left: 0, top: 0, width: 0, height: 0 },
        cssWidth: size.width,
        cssHeight: size.height,
        windowMin,
        windowMax,
        flipY
      })
    })
    return () => cancelAnimationFrame(frame)
    // geometry is derived from the listed deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, overlays, windowMin, windowMax, zoom, pan, size, pixelSpacing[0], pixelSpacing[1], flipY])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const local = (e: MouseEvent) => {
      const r = container.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const l = latest.current
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY > 0 ? 1 / ZOOM_FACTOR_PER_WHEEL_NOTCH : ZOOM_FACTOR_PER_WHEEL_NOTCH
        l.onZoomChange(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, l.zoom * factor)))
      } else {
        l.onWheelStep(e.deltaY > 0 ? 1 : -1)
      }
    }

    let pressed = false
    let moved = false
    let start = { x: 0, y: 0 }
    let panStart: CanvasPan = { x: 0, y: 0 }

    const hover = (e: PointerEvent) => {
      const l = latest.current
      if (!l.onHoverLabel) return
      const p = l.geometry ? containerToPixel(local(e).x, local(e).y, l.geometry) : null
      const name = p ? findHoveredSegmentName(l.overlays ?? [], p) : null
      l.onHoverLabel(name ? { name, clientX: e.clientX, clientY: e.clientY } : null)
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      pressed = true
      moved = false
      start = { x: e.clientX, y: e.clientY }
      panStart = latest.current.pan
      container.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (pressed) {
        const dx = e.clientX - start.x
        const dy = e.clientY - start.y
        if (!moved && Math.hypot(dx, dy) > CLICK_SLOP_PX) {
          moved = true
          setDragging(true)
        }
        if (moved) latest.current.onPanChange({ x: panStart.x + dx, y: panStart.y + dy })
      }
      hover(e)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!pressed) return
      pressed = false
      setDragging(false)
      if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId)
      const l = latest.current
      if (!moved && l.onPick && l.geometry) {
        const p = containerToPixel(local(e).x, local(e).y, l.geometry)
        if (p) l.onPick(p)
      }
    }
    const onPointerLeave = () => latest.current.onHoverLabel?.(null)

    container.addEventListener('wheel', onWheel, { passive: false })
    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointerleave', onPointerLeave)
    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [])

  let lines = null
  if (geometry && crosshair) {
    const r = imageRect(geometry)
    const pt = pixelToContainer(crosshair.x, crosshair.y, geometry)
    const top = Math.max(0, r.top)
    const bottom = Math.min(size.height, r.top + r.height)
    const left = Math.max(0, r.left)
    const right = Math.min(size.width, r.left + r.width)
    lines = (
      <>
        {pt.x >= left && pt.x <= right && <line x1={pt.x} x2={pt.x} y1={top} y2={bottom} stroke={crosshair.colorX} />}
        {pt.y >= top && pt.y <= bottom && <line x1={left} x2={right} y1={pt.y} y2={pt.y} stroke={crosshair.colorY} />}
      </>
    )
  }

  return (
    <div ref={containerRef} className={dragging ? 'zarr-slice-view dragging' : 'zarr-slice-view'}>
      <canvas ref={canvasRef} className="zarr-slice-canvas" />
      <svg className="zarr-slice-overlay" width={size.width} height={size.height} shapeRendering="crispEdges">
        {lines}
      </svg>
      {labels && slice && (
        <>
          <span className="orientation-label orientation-left">{labels.left}</span>
          <span className="orientation-label orientation-right">{labels.right}</span>
          <span className="orientation-label orientation-top">{labels.top}</span>
          <span className="orientation-label orientation-bottom">{labels.bottom}</span>
        </>
      )}
      {glError && <div className="zarr-slice-error">{glError}</div>}
    </div>
  )
}
