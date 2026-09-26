import { useEffect, useRef } from 'react'
import { scaleBarFor } from '../lib/scaleBar'

/**
 * A live scale bar for a 3D view whose camera changes outside React (the
 * itk-vtk-viewer voxel render): checks the view's scale once a frame while
 * active and updates the DOM only when it changes. Measured at the camera's
 * focal plane, the same as the bar drawn into captures.
 */
export function LiveScaleBar({ viewHeightMm, active }: { viewHeightMm: () => number | null; active: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host || !active) return
    let frame = 0
    let last = ''
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const bar = scaleBarFor(viewHeightMm(), host.clientWidth, host.clientHeight, 0.18)
      const key = bar ? `${bar.label}|${bar.pixels.toFixed(1)}` : ''
      if (key === last) return
      last = key
      el.style.display = bar ? '' : 'none'
      if (!bar) return
      ;(el.firstElementChild as HTMLElement).textContent = bar.label
      ;(el.lastElementChild as HTMLElement).style.width = `${bar.pixels}px`
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [viewHeightMm, active])
  return (
    <div ref={ref} className="scale-bar" style={{ display: 'none' }} aria-label="Scale bar">
      <span className="scale-bar-label" />
      <span className="scale-bar-line" />
    </div>
  )
}
