import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchMeshManifest, meshFileUrl, regenerateMeshes, type MeshManifest } from '../lib/api'
import { disposeOitMaterial, OitRenderer } from '../lib/oitRenderer'
import { scaleBarFor } from '../lib/scaleBar'
import { tissueFinish, type TissueFinish } from '../lib/realisticPalette'
import type { SegmentationRecord, ZarrLoadedSegmentation } from '../types'
import { CaptureBar, type CaptureTarget } from './CaptureBar'

interface MeshViewerProps {
  segmentations: ZarrLoadedSegmentation[]
  /** Library records, for each loaded segmentation's meshStatus. */
  records: SegmentationRecord[]
  /** Whether this tab is showing. Hidden, it skips rendering entirely. */
  active: boolean
  /** The segment under the pointer (null when none), as the 2D panes report it. */
  onHoverLabel?: (info: { name: string; clientX: number; clientY: number } | null) => void
}

interface LoadedMeshes {
  manifest: MeshManifest
  /** Keyed by segment key (`${layer}:${labelValue}`), matching SegmentState.key. */
  meshes: Map<string, THREE.Mesh>
}

/** Soft tissue: a satin, wet-looking surface. Hard structures (beak,
 *  cartilage): a clear-coated surface with crisp highlights, so they read
 *  as hard at a glance. */
function makeMaterial(finish: TissueFinish): THREE.MeshStandardMaterial {
  if (finish === 'hard') {
    return new THREE.MeshPhysicalMaterial({ roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide })
  }
  return new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide })
}

// Drops an attribute's CPU-side copy once three.js has uploaded it to the
// GPU. Meshes here can total tens of millions of triangles -- gigabytes of
// JS memory kept for nothing, since nothing re-reads them after upload.
function releaseAfterUpload(this: THREE.BufferAttribute) {
  ;(this as unknown as { array: unknown }).array = null
}

/** The flat, unlit material a mesh is drawn with for hover picking, kept
 *  on the mesh so picking doesn't create (and recompile) one per move. */
function pickMaterial(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
  const data = mesh.userData as { pickMaterial?: THREE.MeshBasicMaterial }
  data.pickMaterial ??= new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false })
  return data.pickMaterial
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose()
  ;(mesh.material as THREE.Material).dispose()
  ;(mesh.userData as { pickMaterial?: THREE.Material }).pickMaterial?.dispose()
  disposeOitMaterial(mesh)
}

function parseMeshFile(buffer: ArrayBuffer): THREE.BufferGeometry {
  const [vertexCount, triangleCount] = new Uint32Array(buffer, 0, 2)
  const positions = new Float32Array(buffer, 8, vertexCount * 3)
  const indices = new Uint32Array(buffer, 8 + vertexCount * 12, triangleCount * 3)
  const geometry = new THREE.BufferGeometry()
  const position = new THREE.BufferAttribute(positions, 3)
  const index = new THREE.BufferAttribute(indices, 1)
  geometry.setAttribute('position', position)
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  position.onUpload(releaseAfterUpload)
  index.onUpload(releaseAfterUpload)
  ;(geometry.getAttribute('normal') as THREE.BufferAttribute).onUpload(releaseAfterUpload)
  return geometry
}

/**
 * The "Surface meshes" 3D tab: per-segment surfaces generated on the server
 * (server/src/surfaceMesh.ts), rendered with three.js in each segment's own
 * color and opacity, driven by the same segment tree as the 2D panes.
 * Coordinates are physical mm in the scans' LPS space, so +z (superior) is
 * up and the default camera looks from anterior.
 */
export function MeshViewer({ segmentations, records, active, onHoverLabel }: MeshViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    render: () => void
    oit: OitRenderer
    bounds: THREE.Sphere
  } | null>(null)
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget | null>(null)
  const scaleBarRef = useRef<HTMLDivElement | null>(null)
  const loadedRef = useRef(new Map<string, LoadedMeshes>())
  const loadingRef = useRef(new Set<string>())
  const fittedKeyRef = useRef('')
  const activeRef = useRef(active)
  const hoverRef = useRef({ segmentations, onHoverLabel })
  useEffect(() => {
    hoverRef.current = { segmentations, onHoverLabel }
  }, [segmentations, onHoverLabel])
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio || 1)
    renderer.setClearColor(0x000000)
    container.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000)
    camera.up.set(0, 0, 1)
    camera.position.set(0, -500, 0)
    scene.add(camera)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 0.9))
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6)
    headlight.position.set(0.3, 0.2, 1)
    camera.add(headlight)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    const oit = new OitRenderer(renderer)
    const allMeshes = function* () {
      for (const { meshes } of loadedRef.current.values()) yield* meshes.values()
    }
    // Clip planes hugging the scene's bounding sphere, refit every frame:
    // depth precision depends on the far/near ratio, and fixed planes (sized
    // for zooming anywhere) waste most of it, so nearly coincident surfaces
    // (neighbouring segments) flicker as the view rotates.
    const bounds = new THREE.Sphere(new THREE.Vector3(), 0)
    const fitClipPlanes = () => {
      if (bounds.radius <= 0) return
      const distance = camera.position.distanceTo(bounds.center)
      const margin = bounds.radius * 1.02
      camera.near = Math.max(distance - margin, margin * 0.001)
      camera.far = distance + margin
      camera.updateProjectionMatrix()
    }
    // Physical height (mm) shown at the orbit target's distance.
    const viewHeightMm = () => 2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const updateScaleBar = () => {
      const el = scaleBarRef.current
      if (!el) return
      const bar = scaleBarFor(bounds.radius > 0 ? viewHeightMm() : null, container.clientWidth, container.clientHeight, 0.18)
      el.style.display = bar ? '' : 'none'
      if (!bar) return
      ;(el.firstElementChild as HTMLElement).textContent = bar.label
      ;(el.lastElementChild as HTMLElement).style.width = `${bar.pixels}px`
    }
    // Frame listeners (recordings): called right after each render, while
    // the canvas's pixels are still readable.
    const frameListeners = new Set<(canvas: HTMLCanvasElement) => void>()
    const renderNow = () => {
      fitClipPlanes()
      oit.render(scene, camera, allMeshes())
      for (const listener of frameListeners) listener(renderer.domElement)
      updateScaleBar()
    }
    let frame = 0
    const render = () => {
      if (frame || !activeRef.current) return
      frame = requestAnimationFrame(() => {
        frame = 0
        renderNow()
      })
    }
    controls.addEventListener('change', render)
    threeRef.current = { renderer, scene, camera, controls, render, oit, bounds }

    // Turntable: OrbitControls' auto-rotation, stepped every frame.
    let spinFrame = 0
    const spin = () => {
      spinFrame = requestAnimationFrame(spin)
      if (activeRef.current) controls.update()
    }
    setCaptureTarget({
      canvas: () => renderer.domElement,
      snapshot: () =>
        new Promise((resolve) => {
          // Rendered and read in the same task, while the drawing buffer is
          // still intact.
          renderNow()
          renderer.domElement.toBlob((blob) => resolve(blob), 'image/png')
        }),
      viewHeightMm: () => (bounds.radius > 0 ? viewHeightMm() : null),
      onFrame: (draw) => {
        frameListeners.add(draw)
        return () => frameListeners.delete(draw)
      },
      requestRender: () => render(),
      // OrbitControls' auto-rotation: about the up axis through the orbit
      // target, like a horizontal drag. Same speed as the voxel render's.
      setTurntable: (on) => {
        controls.autoRotate = on
        controls.autoRotateSpeed = 60 / 24
        cancelAnimationFrame(spinFrame)
        spinFrame = 0
        if (on) spin()
      }
    })

    // Hover identification by GPU picking: render the one pixel under the
    // pointer with every mesh in a flat color encoding its index, and read it
    // back. The meshes' CPU-side geometry is released after upload (see
    // releaseAfterUpload), so ray casting against it isn't possible; this is
    // exact (the frontmost visible surface) and costs one 1x1 render.
    const pickTarget = new THREE.WebGLRenderTarget(1, 1)
    const pickPixel = new Uint8Array(4)
    const pick = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null
      const entries: Array<{ recordId: string; key: string }> = []
      const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = []
      for (const [recordId, { meshes }] of loadedRef.current) {
        for (const [key, mesh] of meshes) {
          if (!mesh.visible) continue
          entries.push({ recordId, key })
          const id = entries.length
          // Linear, so the bytes read back are exactly the id.
          const material = pickMaterial(mesh)
          material.color.setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, THREE.LinearSRGBColorSpace)
          swapped.push([mesh, mesh.material])
          mesh.material = material
        }
      }
      if (entries.length === 0) return null
      const clearColor = renderer.getClearColor(new THREE.Color())
      const clearAlpha = renderer.getClearAlpha()
      try {
        camera.setViewOffset(rect.width, rect.height, x, y, 1, 1)
        renderer.setClearColor(0x000000, 1)
        renderer.setRenderTarget(pickTarget)
        renderer.render(scene, camera)
        renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel)
      } finally {
        renderer.setRenderTarget(null)
        renderer.setClearColor(clearColor, clearAlpha)
        camera.clearViewOffset()
        for (const [mesh, material] of swapped) mesh.material = material
      }
      const hit = entries[pickPixel[0] + (pickPixel[1] << 8) + (pickPixel[2] << 16) - 1]
      if (!hit) return null
      const segment = hoverRef.current.segmentations.find((l) => l.recordId === hit.recordId)?.segments.find((seg) => seg.key === hit.key)
      return segment?.name ?? null
    }
    let hoverFrame = 0
    let lastPointer: PointerEvent | null = null
    const onPointerMove = (e: PointerEvent) => {
      lastPointer = e
      if (e.buttons !== 0) {
        // Rotating/panning: no picking mid-drag.
        hoverRef.current.onHoverLabel?.(null)
        return
      }
      if (hoverFrame || !hoverRef.current.onHoverLabel) return
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0
        const p = lastPointer
        if (!p || !activeRef.current) return
        const name = pick(p.clientX, p.clientY)
        hoverRef.current.onHoverLabel?.(name ? { name, clientX: p.clientX, clientY: p.clientY } : null)
      })
    }
    const onPointerLeave = () => {
      lastPointer = null
      hoverRef.current.onHoverLabel?.(null)
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)

    const observer = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      oit.setSize()
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      render()
    })
    observer.observe(container)

    const loaded = loadedRef.current
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      cancelAnimationFrame(hoverFrame)
      cancelAnimationFrame(spinFrame)
      setCaptureTarget(null)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      pickTarget.dispose()
      oit.dispose()
      controls.dispose()
      for (const entry of loaded.values()) {
        for (const mesh of entry.meshes.values()) disposeMesh(mesh)
      }
      loaded.clear()
      renderer.dispose()
      renderer.domElement.remove()
      threeRef.current = null
    }
  }, [])

  useEffect(() => {
    activeRef.current = active
    if (active) threeRef.current?.render()
  }, [active])

  const statusById = new Map(records.map((r) => [r.id, r]))
  const readyIds = segmentations.filter((s) => statusById.get(s.recordId)?.meshStatus === 'ready').map((s) => s.recordId)
  const readyKey = readyIds.join(',')

  // Load meshes for newly ready segmentations; drop ones no longer loaded.
  useEffect(() => {
    const three = threeRef.current
    if (!three) return
    const wanted = new Set(readyIds)
    for (const [id, entry] of loadedRef.current) {
      if (wanted.has(id)) continue
      for (const mesh of entry.meshes.values()) {
        three.scene.remove(mesh)
        disposeMesh(mesh)
      }
      loadedRef.current.delete(id)
    }
    for (const id of readyIds) {
      if (loadedRef.current.has(id) || loadingRef.current.has(id)) continue
      loadingRef.current.add(id)
      void (async () => {
        try {
          const manifest = await fetchMeshManifest(id)
          const meshes = new Map<string, THREE.Mesh>()
          await Promise.all(
            manifest.segments.map(async (entry) => {
              const res = await fetch(meshFileUrl(id, entry.file))
              if (!res.ok) throw new Error(`Failed to fetch mesh ${entry.file} (${res.status})`)
              const geometry = parseMeshFile(await res.arrayBuffer())
              const mesh = new THREE.Mesh(geometry, makeMaterial('soft'))
              meshes.set(`${entry.layer}:${entry.labelValue}`, mesh)
            })
          )
          if (!threeRef.current) return
          for (const mesh of meshes.values()) threeRef.current.scene.add(mesh)
          loadedRef.current.set(id, { manifest, meshes })
          setVersion((v) => v + 1)
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to load surface meshes')
        } finally {
          loadingRef.current.delete(id)
        }
      })()
    }
    // readyKey captures readyIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey])

  // Apply segment color/visibility/opacity, and fit the camera when the set
  // of loaded meshes changes.
  useEffect(() => {
    const three = threeRef.current
    if (!three) return
    for (const seg of segmentations) {
      const entry = loadedRef.current.get(seg.recordId)
      if (!entry) continue
      for (const s of seg.segments) {
        const mesh = entry.meshes.get(s.key)
        if (!mesh) continue
        const hard = tissueFinish(s.name, s.system, seg.name) === 'hard'
        if ((mesh.material instanceof THREE.MeshPhysicalMaterial) !== hard) {
          ;(mesh.material as THREE.Material).dispose()
          mesh.material = makeMaterial(hard ? 'hard' : 'soft')
        }
        const material = mesh.material as THREE.MeshStandardMaterial
        mesh.visible = s.visible && s.opacity > 0
        material.color.setRGB(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255, THREE.SRGBColorSpace)
        material.opacity = s.opacity
        material.transparent = s.opacity < 0.99
        material.depthWrite = s.opacity >= 0.99
      }
    }

    const loadedKey = [...loadedRef.current.keys()].sort().join(',')
    if (loadedKey && loadedKey !== fittedKeyRef.current) {
      fittedKeyRef.current = loadedKey
      const box = new THREE.Box3()
      for (const { manifest } of loadedRef.current.values()) {
        box.expandByPoint(new THREE.Vector3(...manifest.boundsMin))
        box.expandByPoint(new THREE.Vector3(...manifest.boundsMax))
      }
      const center = box.getCenter(new THREE.Vector3())
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(three.camera.fov / 2))
      three.oit.setDepthScale(distance)
      three.bounds.set(center, radius)
      three.camera.position.set(center.x, center.y - distance, center.z)
      three.camera.updateProjectionMatrix()
      three.controls.target.copy(center)
      three.controls.update()
    }
    three.render()
  }, [segmentations, version])

  let triangles = 0
  for (const { manifest } of loadedRef.current.values()) triangles += manifest.segments.reduce((n, s) => n + s.triangleCount, 0)
  const pending = segmentations.filter((s) => {
    const status = statusById.get(s.recordId)?.meshStatus
    return status === 'pending' || status === undefined
  })
  const failed = segmentations.filter((s) => statusById.get(s.recordId)?.meshStatus === 'failed')

  return (
    <div className="mesh-viewer">
      <div ref={containerRef} className="mesh-viewer-canvas" />
      <div ref={scaleBarRef} className="scale-bar" style={{ display: 'none' }} aria-label="Scale bar">
        <span className="scale-bar-label" />
        <span className="scale-bar-line" />
      </div>
      {triangles > 0 && <CaptureBar target={captureTarget} name="surface-meshes" />}
      <div className="mesh-viewer-status">
        {segmentations.length === 0 && <span>Load a segmentation to see its surface meshes.</span>}
        {pending.length > 0 && <span>Generating surface meshes for {pending.map((s) => s.name).join(', ')}…</span>}
        {failed.map((s) => (
          <span key={s.recordId}>
            Meshes failed for {s.name}: {statusById.get(s.recordId)?.meshError ?? 'unknown error'}{' '}
            <button className="btn btn-secondary btn-small" onClick={() => void regenerateMeshes(s.recordId)}>
              Retry
            </button>
          </span>
        ))}
        {triangles > 0 && <span className="mesh-viewer-count">{triangles.toLocaleString()} triangles</span>}
        {error && <span className="mesh-viewer-error">{error}</span>}
      </div>
    </div>
  )
}
