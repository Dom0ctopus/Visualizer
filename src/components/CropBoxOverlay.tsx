import { useEffect, useRef } from 'react'
import type { CropTarget } from '../hooks/useItkVtkViewer'
import { BOX_EDGES, boxCorners, boxFromBounds, boxPlanes, faceCenter, faceOutwardNormal, moveFace, rotateBox, type CropBox, type Vec3 } from '../lib/cropBox'

/** Box rotation per pixel of Shift+drag. */
const RADIANS_PER_PIXEL = 0.008

/**
 * The voxel render's crop box (lib/cropBox.ts), drawn over the render: its
 * edges, and a handle in the middle of each face. Drag a handle to move
 * that face in or out; Shift+drag anywhere in the view to turn the box about
 * its center (left-right about the screen's vertical, up-down about its
 * horizontal), so its faces can cut through the volume at any angle. Plain
 * drags still turn the camera. Keyed by volume, so a new volume starts with
 * a box around all of it; `resetToken` changes reset it too.
 */
export function CropBoxOverlay({ target, enabled, resetToken }: { target: CropTarget; enabled: boolean; resetToken: number }) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const boxRef = useRef<CropBox | null>(null)
  const appliedRef = useRef(false)
  const resetRef = useRef(resetToken)

  useEffect(() => {
    const svg = svgRef.current
    if (!enabled) {
      if (appliedRef.current) target.setPlanes(null)
      appliedRef.current = false
      return
    }
    const bounds = target.bounds()
    if (!svg || !bounds) return
    if (!boxRef.current || resetRef.current !== resetToken) boxRef.current = boxFromBounds(bounds)
    resetRef.current = resetToken
    const minHalf = 0.01 * Math.max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4])
    const lines = [...svg.querySelectorAll('line')]
    const handles = [...svg.querySelectorAll('circle')]

    const draw = () => {
      const box = boxRef.current
      const points = box && target.project([...boxCorners(box), ...[0, 1, 2, 3, 4, 5].map((f) => faceCenter(box, f))], svg)
      svg.style.display = points ? '' : 'none'
      if (!points) return
      BOX_EDGES.forEach(([a, b], i) => {
        lines[i].setAttribute('x1', String(points[a][0]))
        lines[i].setAttribute('y1', String(points[a][1]))
        lines[i].setAttribute('x2', String(points[b][0]))
        lines[i].setAttribute('y2', String(points[b][1]))
      })
      handles.forEach((handle, f) => {
        handle.setAttribute('cx', String(points[8 + f][0]))
        handle.setAttribute('cy', String(points[8 + f][1]))
      })
    }
    const apply = () => {
      if (!boxRef.current) return
      target.setPlanes(boxPlanes(boxRef.current))
      appliedRef.current = true
      draw()
    }
    apply()
    const stopFrames = target.onFrame(draw)

    // Drag a face handle: move that face along its outward direction, by
    // the drag's component along that direction on screen.
    const onHandleDown = (e: PointerEvent) => {
      const face = Number((e.target as Element).getAttribute('data-face'))
      const start = boxRef.current
      if (!start || Number.isNaN(face) || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const handle = e.target as Element
      handle.setPointerCapture(e.pointerId)
      const center = faceCenter(start, face)
      const normal = faceOutwardNormal(start, face)
      const length = Math.max(...start.half)
      const ends = target.project([center, [center[0] + normal[0] * length, center[1] + normal[1] * length, center[2] + normal[2] * length]], svg)
      if (!ends) return
      const perMm = [(ends[1][0] - ends[0][0]) / length, (ends[1][1] - ends[0][1]) / length]
      const perMm2 = perMm[0] ** 2 + perMm[1] ** 2
      if (perMm2 < 1e-6) return // the face points straight at the camera
      target.beginInteraction()
      const onMove = (m: PointerEvent) => {
        const mm = ((m.clientX - e.clientX) * perMm[0] + (m.clientY - e.clientY) * perMm[1]) / perMm2
        boxRef.current = moveFace(start, face, mm, minHalf)
        apply()
      }
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove as EventListener)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        target.endInteraction()
      }
      handle.addEventListener('pointermove', onMove as EventListener)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    }
    svg.addEventListener('pointerdown', onHandleDown)

    // Shift+drag in the view: turn the box. Caught on the way down to the
    // render's own mouse handling, which never sees it (so the camera stays).
    const container = target.container()
    const onShiftDown = (e: PointerEvent) => {
      if (!e.shiftKey || e.button !== 0 || !boxRef.current) return
      e.preventDefault()
      e.stopPropagation()
      let last = [e.clientX, e.clientY]
      target.beginInteraction()
      const onMove = (m: PointerEvent) => {
        const axes = target.cameraAxes()
        const box = boxRef.current
        if (!axes || !box) return
        const [dx, dy] = [m.clientX - last[0], m.clientY - last[1]]
        last = [m.clientX, m.clientY]
        // The face toward the viewer follows the pointer.
        let turned = rotateBox(box, axes.up as Vec3, dx * RADIANS_PER_PIXEL)
        turned = rotateBox(turned, axes.right as Vec3, dy * RADIANS_PER_PIXEL)
        boxRef.current = turned
        apply()
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        target.endInteraction()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    }
    container?.addEventListener('pointerdown', onShiftDown, true)

    return () => {
      stopFrames()
      svg.removeEventListener('pointerdown', onHandleDown)
      container?.removeEventListener('pointerdown', onShiftDown, true)
    }
  }, [target, enabled, resetToken])

  // Unmounting (a new volume) ends the crop.
  useEffect(
    () => () => {
      if (appliedRef.current) target.setPlanes(null)
    },
    [target]
  )

  return (
    <svg ref={svgRef} className="crop-box-overlay" style={{ display: enabled ? '' : 'none' }} aria-hidden="true">
      {BOX_EDGES.map((_, i) => (
        <line key={i} className="crop-box-edge" />
      ))}
      {[0, 1, 2, 3, 4, 5].map((face) => (
        <circle key={face} className="crop-box-handle" r={6} data-face={face}>
          <title>Drag to move this face · Shift+drag in the view to rotate the box</title>
        </circle>
      ))}
    </svg>
  )
}
