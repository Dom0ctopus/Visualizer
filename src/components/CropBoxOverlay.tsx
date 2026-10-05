import { useEffect, useRef, useState } from 'react'
import type { CropTarget } from '../hooks/useItkVtkViewer'
import { BOX_EDGES, boxCorners, boxFromBounds, boxPlanes, faceCenter, faceOutwardNormal, moveFace, rotateBox, type CropBox, type Vec3 } from '../lib/cropBox'

/** Box rotation per pixel of Shift+drag. */
const RADIANS_PER_PIXEL = 0.008

/** An automatic wipe: the selected face sweeps at a constant speed, `in`
 *  across the box until it's a thin slab, `out` back to the volume's edge.
 *  `id` makes each request distinct; `stop` halts one in progress. */
export interface WipeCommand {
  id: number
  face: number
  direction: 'in' | 'out' | 'stop'
  seconds: number
}

/**
 * The voxel render's crop box (lib/cropBox.ts), drawn over the render: its
 * edges, and a handle in the middle of each face. Drag a handle to move
 * that face in or out; Shift+drag anywhere in the view to turn the box about
 * its center (left-right about the screen's vertical, up-down about its
 * horizontal), so its faces can cut through the volume at any angle; in
 * rotate mode plain drags do the same. Otherwise plain drags turn the camera. Keyed by volume, so a new volume starts with
 * a box around all of it; `resetToken` changes reset it too.
 */
export function CropBoxOverlay({
  target,
  enabled,
  resetToken,
  rotateMode,
  hidden = false,
  selectedFace = null,
  onSelectFace,
  wipe = null,
  onWipeEnd
}: {
  target: CropTarget
  enabled: boolean
  resetToken: number
  /** Plain drags turn the box too (not just Shift+drags). */
  rotateMode: boolean
  /** The outline and handles hidden (the crop stays; Shift+drag still turns
   *  the box) -- e.g. while recording. */
  hidden?: boolean
  /** The face picked for wipes (by clicking its dot), highlighted. */
  selectedFace?: number | null
  onSelectFace?: (face: number | null) => void
  wipe?: WipeCommand | null
  /** A wipe finished or was stopped. */
  onWipeEnd?: () => void
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const boxRef = useRef<CropBox | null>(null)
  const appliedRef = useRef(false)
  const resetRef = useRef(resetToken)
  // Turned on before the volume is ready to measure: try again shortly.
  const [retry, setRetry] = useState(0)
  const rotateModeRef = useRef(rotateMode)
  useEffect(() => {
    rotateModeRef.current = rotateMode
  }, [rotateMode])
  const callbacksRef = useRef({ onSelectFace, onWipeEnd, selectedFace })
  useEffect(() => {
    callbacksRef.current = { onSelectFace, onWipeEnd, selectedFace }
  }, [onSelectFace, onWipeEnd, selectedFace])
  // Set up by the main effect, for wipes: the box re-applied, and its limits.
  const geometryRef = useRef<{ apply: () => void; minHalf: number; bounds: number[] } | null>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!enabled) {
      if (appliedRef.current) target.setPlanes(null)
      appliedRef.current = false
      return
    }
    const bounds = target.bounds()
    if (!svg || !bounds) {
      const timer = window.setTimeout(() => setRetry((n) => n + 1), 300)
      return () => window.clearTimeout(timer)
    }
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
    geometryRef.current = { apply, minHalf, bounds }
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
      // A press that doesn't move is a click: it picks this face for wipes.
      let moved = false
      const onMove = (m: PointerEvent) => {
        if (!moved && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 3) return
        moved = true
        const mm = ((m.clientX - e.clientX) * perMm[0] + (m.clientY - e.clientY) * perMm[1]) / perMm2
        boxRef.current = moveFace(start, face, mm, minHalf)
        apply()
      }
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove as EventListener)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        target.endInteraction()
        if (!moved) {
          const { onSelectFace, selectedFace } = callbacksRef.current
          onSelectFace?.(selectedFace === face ? null : face)
        }
      }
      handle.addEventListener('pointermove', onMove as EventListener)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    }
    svg.addEventListener('pointerdown', onHandleDown)

    // Shift+drag (or any drag in rotate mode) in the view: turn the box.
    // Caught at the window, before any element's handler, and so are the
    // moves that follow: the render's own mouse handling (where Shift+drag
    // pans the camera) sees neither, so the camera can't move meanwhile.
    const container = target.container()
    const onShiftDown = (e: PointerEvent) => {
      if (!(e.shiftKey || rotateModeRef.current) || e.button !== 0 || !boxRef.current || !container?.contains(e.target as Node)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      let last = [e.clientX, e.clientY]
      target.beginInteraction()
      const onMove = (m: PointerEvent) => {
        m.stopImmediatePropagation()
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
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        target.endInteraction()
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
    }
    window.addEventListener('pointerdown', onShiftDown, true)

    return () => {
      stopFrames()
      svg.removeEventListener('pointerdown', onHandleDown)
      window.removeEventListener('pointerdown', onShiftDown, true)
    }
  }, [target, enabled, resetToken, retry])

  // Wipes: the face's offset follows the clock, not the frame count, so a
  // slow frame shows the face further along instead of slowing the wipe.
  useEffect(() => {
    if (!wipe || wipe.direction === 'stop') {
      if (wipe) callbacksRef.current.onWipeEnd?.()
      return
    }
    const geometry = geometryRef.current
    const start = boxRef.current
    if (!geometry || !start || !enabled) {
      callbacksRef.current.onWipeEnd?.()
      return
    }
    const { face } = wipe
    const axis = face >> 1
    const normal = faceOutwardNormal(start, face)
    let distance: number
    if (wipe.direction === 'in') {
      distance = -2 * (start.half[axis] - geometry.minHalf)
    } else {
      // Out to where the face plane clears every corner of the volume.
      const [x0, x1, y0, y1, z0, z1] = geometry.bounds
      const corners: Vec3[] = [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [z0, z1].map((z): Vec3 => [x, y, z])))
      const along = (p: Vec3) => p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2]
      distance = Math.max(...corners.map(along)) - along(faceCenter(start, face))
    }
    if (Math.abs(distance) < 1e-6) {
      callbacksRef.current.onWipeEnd?.()
      return
    }
    // Stepped by a ~60 Hz timer rather than animation frames, which a busy
    // GPU can hold back; the render itself still draws at most once a frame
    // (the planes just move on between frames).
    const duration = Math.max(0.1, wipe.seconds) * 1000
    const t0 = performance.now()
    let timer = 0
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / duration)
      boxRef.current = moveFace(start, face, distance * t, geometry.minHalf)
      geometry.apply()
      if (t < 1) timer = window.setTimeout(step, 16)
      else callbacksRef.current.onWipeEnd?.()
    }
    step()
    return () => window.clearTimeout(timer)
    // A new command (its id) starts a wipe; enabled is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wipe?.id])

  // Unmounting (a new volume) ends the crop.
  useEffect(
    () => () => {
      if (appliedRef.current) target.setPlanes(null)
    },
    [target]
  )

  return (
    <svg ref={svgRef} className="crop-box-overlay" style={{ display: enabled ? '' : 'none', visibility: hidden ? 'hidden' : undefined }} aria-hidden="true">
      {BOX_EDGES.map((_, i) => (
        <line key={i} className="crop-box-edge" />
      ))}
      {[0, 1, 2, 3, 4, 5].map((face) => (
        <circle key={face} className={face === selectedFace ? 'crop-box-handle selected' : 'crop-box-handle'} r={face === selectedFace ? 8 : 6} data-face={face}>
          <title>Drag to move this face · click to pick it for a wipe · Shift+drag in the view to rotate the box</title>
        </circle>
      ))}
    </svg>
  )
}
