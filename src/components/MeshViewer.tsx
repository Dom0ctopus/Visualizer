import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchMeshManifest, meshFileUrl, regenerateMeshes, type MeshManifest } from '../lib/api'
import { tissueFinish, type TissueFinish } from '../lib/realisticPalette'
import type { SegmentationRecord, ZarrLoadedSegmentation } from '../types'

interface MeshViewerProps {
  segmentations: ZarrLoadedSegmentation[]
  /** Library records, for each loaded segmentation's meshStatus. */
  records: SegmentationRecord[]
  /** Whether this tab is showing. Hidden, it skips rendering entirely. */
  active: boolean
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
export function MeshViewer({ segmentations, records, active }: MeshViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    render: () => void
  } | null>(null)
  const loadedRef = useRef(new Map<string, LoadedMeshes>())
  const loadingRef = useRef(new Set<string>())
  const fittedKeyRef = useRef('')
  const activeRef = useRef(active)
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
    let frame = 0
    const render = () => {
      if (frame || !activeRef.current) return
      frame = requestAnimationFrame(() => {
        frame = 0
        renderer.render(scene, camera)
      })
    }
    controls.addEventListener('change', render)
    threeRef.current = { renderer, scene, camera, controls, render }

    const observer = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      render()
    })
    observer.observe(container)

    const loaded = loadedRef.current
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      controls.dispose()
      for (const entry of loaded.values()) {
        for (const mesh of entry.meshes.values()) {
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material).dispose()
        }
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
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
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
      three.camera.near = distance / 100
      three.camera.far = distance * 10
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
