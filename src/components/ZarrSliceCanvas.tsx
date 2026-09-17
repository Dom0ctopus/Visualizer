import { useEffect, useRef } from 'react'
import type { SliceResult } from '../lib/zarrClient'

interface ZarrSliceCanvasProps {
  slice: SliceResult | null
  windowMin: number
  windowMax: number
  onWheelStep: (delta: number) => void
}

/**
 * Draws one full-resolution 2D slice (read directly from the OME-Zarr store
 * by useZarrSliceViewer, bypassing itk-vtk-viewer's slice machinery
 * entirely -- see that hook's own comment for why) onto a plain 2D canvas,
 * applying window/level ourselves since there's no library UI doing it here.
 */
export function ZarrSliceCanvas({ slice, windowMin, windowMax, onWheelStep }: ZarrSliceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !slice) return
    const { width, height, data } = slice
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const imageData = ctx.createImageData(width, height)
    const out = imageData.data
    const range = Math.max(1e-6, windowMax - windowMin)
    for (let i = 0; i < data.length; i++) {
      const t = Math.min(1, Math.max(0, (data[i] - windowMin) / range))
      const gray = Math.round(t * 255)
      const o = i * 4
      out[o] = gray
      out[o + 1] = gray
      out[o + 2] = gray
      out[o + 3] = 255
    }
    ctx.putImageData(imageData, 0, 0)
  }, [slice, windowMin, windowMax])

  // React's synthetic wheel handler is passive by default (a React 17+
  // change for scroll-performance), so calling preventDefault() from a JSX
  // onWheel prop is a no-op with a console warning -- attach a real,
  // non-passive native listener instead so scrolling the page doesn't
  // happen at the same time as stepping through slices.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      onWheelStep(e.deltaY > 0 ? 1 : -1)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onWheelStep])

  return <canvas ref={canvasRef} className="zarr-slice-canvas" />
}
