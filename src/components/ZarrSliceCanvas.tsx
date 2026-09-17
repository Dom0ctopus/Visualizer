import { useEffect, useMemo, useRef } from 'react'
import type { SliceResult } from '../lib/zarrClient'

interface ZarrSliceCanvasProps {
  slice: SliceResult | null
  windowMin: number
  windowMax: number
  onWheelStep: (delta: number) => void
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
export function ZarrSliceCanvas({ slice, windowMin, windowMax, onWheelStep }: ZarrSliceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Reused across renders so scrolling through many slices at the same
  // dimensions doesn't allocate a fresh backing buffer every frame.
  const imageDataRef = useRef<ImageData | null>(null)

  const lutRange = slice ? lutRangeFor(slice.data) : null
  const lut = useMemo(
    () => (lutRange ? buildLut(lutRange.size, lutRange.offset, windowMin, windowMax) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lutRange?.size, lutRange?.offset, windowMin, windowMax]
  )

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
    let imageData = imageDataRef.current
    if (!imageData || imageData.width !== width || imageData.height !== height) {
      imageData = ctx.createImageData(width, height)
      imageDataRef.current = imageData
    }
    const out = imageData.data
    if (lut) {
      const offset = lutRange!.offset
      for (let i = 0; i < data.length; i++) {
        const gray = lut[data[i] + offset]
        const o = i * 4
        out[o] = gray
        out[o + 1] = gray
        out[o + 2] = gray
        out[o + 3] = 255
      }
    } else {
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
    }
    ctx.putImageData(imageData, 0, 0)
  }, [slice, windowMin, windowMax, lut, lutRange])

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
