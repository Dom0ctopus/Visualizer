import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureTarget } from '../components/CaptureBar'
import { dataUrlToBlob } from '../lib/capture'
import type { CropPlane, Vec3 } from '../lib/cropBox'
import { pickVolumeLabel, type PickableViewProxy } from '../lib/volumePick'
import { fetchPyramidLevels, type PyramidLevel } from '../lib/zarrClient'

// itk-vtk-viewer ships as a legacy global-script webpack bundle, not an
// ESM/CJS module -- its own type declarations use `declare namespace
// itkVtkViewer`, matching its documented <script src="..."> embedding
// pattern. So it's loaded here via a plain <script> tag (served from
// public/itk-vtk-viewer, synced from node_modules by
// scripts/sync-itk-vtk-viewer.mjs) rather than `import`-ed.
interface ItkVtkViewerInstance {
  setViewMode: (mode: 'ZPlane' | 'YPlane' | 'XPlane' | 'Volume') => void
  setUICollapsed: (collapsed: boolean) => void
  // Label-image (segmentation) overlay API, confirmed by reading
  // itk-vtk-viewer's own bundled source (its TypeScript types don't cover
  // this) -- see useItkVtkViewer's own loadLabelImageUrl/setLabelWeights
  // comments for what each one actually does and the real limits found
  // there (single label image, preset-only colors, no arbitrary per-label
  // RGB).
  setLabelImage: (image: URL) => Promise<void>
  setLabelImageWeights: (weights: Map<number, number>) => void
  setLabelImageLabelNames: (names: Map<number, string>) => void
  // Cropping-planes API, confirmed by reading itk-vtk-viewer's own bundled
  // source -- see loadLabelImageUrl's own comment for why resetCroppingPlanes
  // gets called after a label image reload.
  getCroppingPlanesEnabled: () => boolean
  setCroppingPlanesEnabled: (enabled: boolean) => void
  resetCroppingPlanes: () => void
  // Sets the displayed pyramid level and turns off itk-vtk-viewer's own
  // framerate-driven level switching ("Framerate-pick").
  setImageScale: (scale: number) => void
  getLabelImageBlend: () => number
  setLabelImageBlend: (blend: number) => void
  setBackgroundColor: (rgb: [number, number, number]) => void
  setImageColorMap: (colorMap: string) => void
  // The volume's (component 0's) intensity range for the color and opacity
  // maps, and the data range it can span.
  getImageColorRange: () => [number, number] | undefined
  setImageColorRange: (range: [number, number]) => void
  getImageColorRangeBounds: () => [number, number] | undefined
  // Its "sample distance" slider (0-1, 0 = densest sampling), volume
  // scattering slider (0-1), and the opacity curve's points ([x, y], both
  // 0-1 over the intensity range).
  setImageVolumeSampleDistance: (distance: number) => void
  setImageVolumeScatteringBlend: (blend: number) => void
  setImagePiecewiseFunctionPoints: (points: Array<[number, number]>) => void
  getImageVolumeSampleDistance: () => number
  getImageVolumeScatteringBlend: () => number
  getImagePiecewiseFunctionPoints: () => Array<[number, number]> | undefined
  on: (event: string, callback: () => void) => void
  setLabelImageLookupTable: (lookupTable: string) => void
  /** PNG data URL of the render (the vtk.js view's captureImage). */
  captureImage: () => Promise<string>
  /** itk-vtk-viewer's continuous-rotation toggle. */
  setRotateEnabled: (enabled: boolean) => void
  getViewProxy: () => {
    getInteractorStyle3D: () => {
      setCenterOfRotation: (center: [number, number, number]) => void
      /** Fires when the user starts rotating, panning or zooming. */
      onStartInteractionEvent: (callback: () => void) => { unsubscribe: () => void }
    }
    getRenderer: () => { resetCamera: (bounds?: number[]) => boolean }
    getRepresentations: () => Array<{ getVolumes?: () => VtkVolume[] }>
    renderLater: () => void
  }
  // No delete/destroy/dispose exists (checked against its bundled source);
  // see clearViewer for how a replaced viewer's resources are released.
}

// The slices of vtk.js objects reached through getViewProxy() for
// applyLabelColors below.
interface VtkColorTransferFunction {
  removeAllPoints: () => void
  addRGBPointLong: (x: number, r: number, g: number, b: number, midpoint: number, sharpness: number) => void
  setMappingRange: (min: number, max: number) => void
  onModified: (callback: () => void) => { unsubscribe: () => void }
  modified: () => void
}
interface VtkVolume {
  getProperty: () => {
    getRGBTransferFunction: (component: number) => VtkColorTransferFunction | null
    getScalarOpacity: (component: number) => { modified: () => void } | null
  }
  getMapper: () => { getInputData: () => { getPointData: () => { getScalars: () => { getNumberOfComponents: () => number } | null } } | null } | null
}

// The slice of the vtk.js camera used for the turntable and scale bar.
interface VtkCamera {
  getPosition: () => number[]
  getFocalPoint: () => number[]
  getViewUp: () => number[]
  setPosition: (x: number, y: number, z: number) => void
  setFocalPoint: (x: number, y: number, z: number) => void
  getDistance: () => number
  getViewAngle: () => number
  getParallelProjection: () => boolean
  getParallelScale: () => number
}
interface VtkCameraView {
  getCamera: () => VtkCamera
  getRenderer: () => { resetCameraClippingRange: () => void }
  renderLater: () => void
  /** Its interactor fires a render event right after each frame is drawn. */
  getInteractor: () => { onRenderEvent: (callback: () => void) => { unsubscribe: () => void } }
}

/** What CropBoxOverlay needs from the voxel render. */
export interface CropTarget {
  /** The whole volume's world bounds (mm), voxel edges included:
   *  [xmin, xmax, ymin, ymax, zmin, zmax]; null before a volume loads. */
  bounds: () => number[] | null
  /** Crops the render to the inside of six planes; null for no crop. */
  setPlanes: (planes: CropPlane[] | null) => void
  /** World points -> CSS pixels relative to `element`'s top-left. */
  project: (points: Vec3[], element: Element) => Array<[number, number]> | null
  /** The camera's screen-up and screen-right directions in world space. */
  cameraAxes: () => { up: Vec3; right: Vec3 } | null
  /** Called after every frame; returns an unsubscribe. */
  onFrame: (callback: () => void) => () => void
  /** The element the render's mouse handling listens on. */
  container: () => HTMLElement | null
  /** While a box is dragged, frames render at interactive quality (as while
   *  rotating the camera); ended, the next frame is full quality. */
  beginInteraction: () => void
  endInteraction: () => void
}

// The slices of the vtk.js view proxy CropTarget uses.
interface VtkCropView {
  getCamera: () => VtkCamera & { getDirectionOfProjection: () => number[] }
  getRenderer: () => unknown
  getOpenGLRenderWindow: () => {
    getSize: () => number[]
    getCanvas: () => HTMLCanvasElement | null
    worldToDisplay: (x: number, y: number, z: number, renderer: unknown) => number[]
  }
  getInteractor: () => { requestAnimation: (requestor: object) => void; cancelAnimation: (requestor: object) => void }
  getRepresentations: () => Array<{ getVolumes?: () => Array<{ getMapper: () => { getClippingPlanes: () => VtkPlane[] } }> }>
  renderLater: () => void
}
interface VtkPlane {
  setOrigin: (x: number, y: number, z: number) => void
  setNormal: (x: number, y: number, z: number) => void
}

/** The specimen's extent about an axis through `center` along unit `up`:
 *  its height range along the axis and its largest distance from it --
 *  from the displayed image's voxels above its null (minimum) value,
 *  sampled down to a few million. Null when there's no image or no such
 *  voxel. */
function specimenSweep(
  view: unknown,
  center: number[],
  up: number[]
): { hMin: number; hMax: number; radius: number } | null {
  type Image = {
    getDimensions: () => number[]
    getPointData: () => { getScalars: () => { getData: () => ArrayLike<number>; getNumberOfComponents: () => number; getRange: (c: number) => number[] } }
    indexToWorld: (ijk: number[], out: number[]) => number[]
  }
  const image = (view as { getRepresentations: () => Array<{ getVolumes?: () => Array<{ getMapper: () => { getInputData: () => Image | null } }> }> })
    .getRepresentations()
    .flatMap((r) => r.getVolumes?.() ?? [])[0]
    ?.getMapper()
    .getInputData()
  if (!image) return null
  const [nx, ny, nz] = image.getDimensions()
  const scalars = image.getPointData().getScalars()
  const data = scalars.getData()
  const comps = scalars.getNumberOfComponents()
  const nullValue = scalars.getRange(0)[0]
  const origin = image.indexToWorld([0, 0, 0], [0, 0, 0])
  const ex = image.indexToWorld([1, 0, 0], [0, 0, 0]).map((v, i) => v - origin[i])
  const ey = image.indexToWorld([0, 1, 0], [0, 0, 0]).map((v, i) => v - origin[i])
  const ez = image.indexToWorld([0, 0, 1], [0, 0, 0]).map((v, i) => v - origin[i])
  const step = Math.max(1, Math.round(Math.cbrt((nx * ny * nz) / 4e6)))
  let hMin = Infinity
  let hMax = -Infinity
  let r2Max = 0
  const p = [0, 0, 0]
  for (let k = 0; k < nz; k += step)
    for (let j = 0; j < ny; j += step) {
      const row = (k * ny + j) * nx
      for (let i = 0; i < nx; i += step) {
        if (data[(row + i) * comps] <= nullValue) continue
        for (let a = 0; a < 3; a++) p[a] = origin[a] + i * ex[a] + j * ey[a] + k * ez[a] - center[a]
        const h = p[0] * up[0] + p[1] * up[1] + p[2] * up[2]
        if (h < hMin) hMin = h
        if (h > hMax) hMax = h
        const r2 = (p[0] - h * up[0]) ** 2 + (p[1] - h * up[1]) ** 2 + (p[2] - h * up[2]) ** 2
        if (r2 > r2Max) r2Max = r2
      }
    }
  if (!Number.isFinite(hMin)) return null
  // Sampled every `step` voxels: pad by that much.
  const pad = step * Math.max(Math.hypot(...ex), Math.hypot(...ey), Math.hypot(...ez))
  return { hMin: hMin - pad, hMax: hMax + pad, radius: Math.sqrt(r2Max) + pad }
}

/** Turntable speed: one full turn per this many seconds. */
const TURNTABLE_SECONDS_PER_TURN = 24

/** `point` rotated by `angle` (radians) about the axis through `center`
 *  along unit vector `axis` (Rodrigues' formula). */
function rotateAbout(point: number[], center: number[], axis: number[], angle: number): [number, number, number] {
  const v = [point[0] - center[0], point[1] - center[1], point[2] - center[2]]
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dot = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2]
  const cross = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]]
  return [0, 1, 2].map((i) => center[i] + v[i] * cos + cross[i] * sin + axis[i] * dot * (1 - cos)) as [number, number, number]
}

// The name of itk-vtk-viewer's default categorical palette.
const DEFAULT_LABEL_PALETTE = 'glasbey'

// How often label weight/name updates reach itk-vtk-viewer while a slider
// is being dragged: each one re-renders the whole labeled volume.
const LABEL_UPDATE_THROTTLE_MS = 150

// While segment edits are coming in, the voxel render samples this many
// times more coarsely, back to full quality this long after the last one
// (see beginEditQuality).
const EDIT_SAMPLING_FACTOR = 4
const EDIT_SETTLE_MS = 500

/** Label changes waiting to be sent to itk-vtk-viewer (see
 *  scheduleLabelUpdate); `blend` re-applies the search focus's blend. */
interface LabelUpdate {
  weights?: Map<number, number>
  names?: Map<number, string>
  blend?: true
  /** The user's own label blend (the toolbar slider). */
  userBlend?: number
}

function sameEntries<K, V>(a: Map<K, V>, b: Map<K, V> | null): boolean {
  if (!b || a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

// itk-vtk-viewer's hard limits for one image update (read from its source:
// "Voxel count over max" / "Image byte count over max").
// The voxel render's starting look (its own panel can change all of it):
// the densest sampling, a touch of volume scattering, and an opacity curve
// rising steeply over the darkest fifth of the range, then gently.
const DEFAULT_SAMPLE_DISTANCE = 0
const DEFAULT_SCATTERING = 0.05
const DEFAULT_OPACITY_POINTS: Array<[number, number]> = [
  [0, 0],
  [0.22, 0.44],
  [0.95, 0.57]
]

/** A volume's look in the voxel render (an editor's saved default, see
 *  server/src/renderDefaults.ts), minus the blend fade the page owns. */
export interface RenderLook {
  opacityPoints: Array<[number, number]>
  /** Null: the volume's whole range. */
  colorRange: [number, number] | null
  sampleDistance: number
  scattering: number
  labelBlend: number
}

const ITK_MAX_VOXELS = 268_435_456
const ITK_MAX_BYTES = 536_870_912

function bytesPerElement(dtype: string): number {
  return Number(dtype.slice(2)) || 1
}

/** Finest level itk-vtk-viewer will accept for the whole volume. */
function finestDisplayableScale(levels: PyramidLevel[]): number {
  for (const level of levels) {
    const voxels = level.size[0] * level.size[1] * level.size[2]
    if (voxels <= ITK_MAX_VOXELS && voxels * bytesPerElement(level.dtype) <= ITK_MAX_BYTES) return level.index
  }
  return levels.length - 1
}

interface ItkVtkViewerGlobal {
  createViewer: (container: HTMLElement, options: { image: URL; rotate?: boolean }) => Promise<ItkVtkViewerInstance>
}

declare global {
  interface Window {
    itkVtkViewer?: ItkVtkViewerGlobal
  }
}

// The "CDN" build (itkVtkViewerCDN.js) hardcodes its itk-wasm/image-io/
// mesh-io pipeline asset URLs to cdn.jsdelivr.net at build time, with no
// runtime override -- wrong for a self-hosted app regardless of network
// policy. This build instead derives those paths from its own script tag's
// URL (webpack's auto-detected publicPath), so serving it from
// public/itk-vtk-viewer resolves everything -- including the Blosc/zarr
// decompression pipeline both toolkits require -- from that same local
// directory synced by scripts/sync-itk-vtk-viewer.mjs.
const SCRIPT_URL = '/itk-vtk-viewer/itkVtkViewer.js'
let scriptLoadPromise: Promise<void> | null = null

function loadItkVtkViewerScript(): Promise<void> {
  if (window.itkVtkViewer) return Promise.resolve()
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_URL
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load itk-vtk-viewer script'))
      document.head.appendChild(script)
    })
  }
  return scriptLoadPromise
}

/**
 * Drives the "Voxel render" 3D tab. The slice panes used to be a second
 * itk-vtk-viewer instance in use2D/ZPlane mode, but that mode hits a hard
 * internal voxel-count cap on scans this large and corrupts the display
 * instead of falling back gracefully when the slice position changes --
 * confirmed not fixable through its public API (tried pinning its internal
 * scale-refinement state; held steady with no effect on the underlying
 * crash). The slice pane is now ZarrSliceCanvas + useZarrSliceViewer, a
 * custom canvas reader that bypasses itk-vtk-viewer entirely for slices.
 * This hook still owns the volume pane since "Volume" view mode never
 * showed any of these problems.
 */
export function useItkVtkViewer() {
  const volumeContainerRef = useRef<HTMLDivElement | null>(null)
  const volumeViewerRef = useRef<ItkVtkViewerInstance | null>(null)
  // applyLabelColors (defined below) for the loaders above it.
  const applyLabelColorsRef = useRef<() => void>(() => {})
  /** The mouse-rotation center (the whole volume's center); the turntable
   *  spins about it too. */
  const rotationCenterRef = useRef<[number, number, number] | null>(null)
  /** The whole volume's world bounds, voxel edges included (CropTarget). */
  const volumeBoundsRef = useRef<number[] | null>(null)
  /** The crop box's planes while it's on (re-applied whenever
   *  itk-vtk-viewer swaps in a new image, which resets its planes). */
  const cropPlanesRef = useRef<CropPlane[] | null>(null)
  const applyCropPlanesRef = useRef<() => void>(() => {})
  /** Whether itk-vtk-viewer has a label image fully set up. Label weights
   *  or names sent before that make its applyLabelImageWeights throw inside
   *  its state machine ("reading 'has'"), which can leave the 3D view stuck,
   *  so updates wait for this (see scheduleLabelUpdate). */
  const labelImageReadyRef = useRef(false)
  /** Search focus's share of the label blend (see setFocusBlend): the
   *  strength, and the user's own blend from before focusing. */
  const focusBlendRef = useRef<{ strength: number; base: number } | null>(null)
  const applyFocusBlendRef = useRef<() => void>(() => {})
  /** A label image requested before the viewer existed (the merge can
   *  finish before a large volume has loaded); loaded once it does. */
  const pendingLabelImageUrlRef = useRef<string | null>(null)
  const loadLabelImageUrlRef = useRef<(url: string) => Promise<void>>(async () => {})
  const flushLabelUpdateRef = useRef<() => void>(() => {})
  const turntableFrameRef = useRef(0)

  // Voxel-render frames. Every frame of a large labeled volume is expensive
  // (seconds of GPU time when search focus lets rays cross the whole
  // volume), and vtk.js's renderLater doesn't coalesce -- it's
  // setTimeout(render) -- so one focus change used to draw ~10 full frames
  // back to back, enough GPU work for macOS to reset the GPU. So this
  // file's own redraws go through scheduleRender, at most one per animation
  // frame, and skipped when itk-vtk-viewer already drew one since.
  const renderCountRef = useRef(0)
  const renderFrameRef = useRef(0)
  const scheduleRender = useCallback(() => {
    if (renderFrameRef.current) return
    const countAtRequest = renderCountRef.current
    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = 0
      if (renderCountRef.current !== countAtRequest) return
      try {
        volumeViewerRef.current?.getViewProxy().renderLater()
      } catch {
        // viewer mid-update
      }
    })
  }, [])

  const [scriptReady, setScriptReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedName, setLoadedName] = useState<string | null>(null)
  /** The user's label blend, for the toolbar slider: itk-vtk-viewer's own
   *  value, or during a search focus the value the focus builds on. */
  const [labelBlend, setLabelBlendState] = useState(0.5)
  const labelBlendRef = useRef(0.5)
  labelBlendRef.current = labelBlend
  /** The volume's saved look (setRenderLook), applied as it loads; the
   *  built-in defaults when null. */
  const renderLookRef = useRef<RenderLook | null>(null)
  /** Re-applies the look to the current viewer (set per viewer). */
  const applyLookNowRef = useRef<() => void>(() => {})
  /** Bumped for every viewer created (a Reload too), so per-viewer UI like
   *  the crop box starts over with it. */
  const [viewerGeneration, setViewerGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadItkVtkViewerScript()
      .then(() => {
        if (!cancelled) setScriptReady(true)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load itk-vtk-viewer')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // itk-vtk-viewer has no teardown API, so a replaced viewer (Reload, or
  // loading a different volume) would otherwise keep its whole GPU volume
  // alive for the rest of the session. Losing its WebGL contexts releases
  // that memory; its canvases are then detached with the rest of its DOM.
  const clearViewer = useCallback(() => {
    labelImageReadyRef.current = false
    cancelAnimationFrame(turntableFrameRef.current)
    turntableFrameRef.current = 0
    cancelAnimationFrame(renderFrameRef.current)
    if (editQualityRef.current) window.clearTimeout(editQualityRef.current.timer)
    editQualityRef.current = null
    renderFrameRef.current = 0
    rotationCenterRef.current = null
    volumeBoundsRef.current = null
    cropPlanesRef.current = null
    volumeViewerRef.current = null
    const container = volumeContainerRef.current
    if (container) {
      for (const canvas of container.querySelectorAll('canvas')) {
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
        gl?.getExtension('WEBGL_lose_context')?.loseContext()
      }
      container.replaceChildren()
    }
    setLoadedName(null)
  }, [])

  // Tears down the viewer instance on unmount only (stable ref, no deps).
  useEffect(() => clearViewer, [clearViewer])

  const loadZarrUrl = useCallback(
    async (url: string, name: string) => {
      if (!window.itkVtkViewer || !volumeContainerRef.current) return
      setBusy(true)
      setError(null)
      try {
        clearViewer()
        const absoluteUrl = new URL(url, window.location.href)
        const volumeViewer = await window.itkVtkViewer.createViewer(volumeContainerRef.current, {
          image: absoluteUrl,
          rotate: false
        })
        volumeViewer.setViewMode('Volume')
        ;(volumeViewer.getViewProxy() as unknown as VtkCameraView).getInteractor().onRenderEvent(() => {
          renderCountRef.current++
        })
        // itk-vtk-viewer only auto-collapses its (fairly wide) native control
        // panel on genuinely small screens (window.screen.availWidth < 768),
        // which never applies to our side-by-side split -- the pane is
        // narrow, but the browser window itself is normal desktop width, so
        // its own heuristic never fires and the full panel crowds the pane.
        // Force the same compact mode its own hamburger-menu toggle uses.
        volumeViewer.setUICollapsed(true)
        // Pin the finest level itk-vtk-viewer can hold. Left on its default
        // framerate-driven picking, it keeps trying finer levels that exceed
        // its voxel cap ("Could not update image ... Voxel count over max")
        // and switching levels mid-session, which also changes which level
        // of the label image it shows (it fetches both at the same index).
        // The level is still changeable from itk-vtk-viewer's own UI.
        volumeViewer.setBackgroundColor([0, 0, 0])
        try {
          const levels = await fetchPyramidLevels(url)
          volumeViewer.setImageScale(finestDisplayableScale(levels))
          // The volume loads progressively, chunk by chunk, and
          // itk-vtk-viewer sets its mouse-rotation center from whatever has
          // loaded so far -- a corner of the volume. Re-center it on the
          // whole volume (physical center of level 0; VolumeInfo is [z, y, x])
          // after every progressive update.
          const { origin, size, spacing } = levels[0]
          const center: [number, number, number] = [2, 1, 0].map((a) => origin[a] + ((size[a] - 1) * spacing[a]) / 2) as [number, number, number]
          rotationCenterRef.current = center
          let colorMapApplied = false
          let lookApplied = false
          // The camera frames the whole volume. itk-vtk-viewer frames
          // whatever has loaded so far -- one end of the specimen, close up --
          // and only fetches the part in view, so the rest never loaded until
          // the user zoomed out. Re-framed after each progressive update until
          // the user moves the camera themselves.
          const x = [origin[2], origin[2] + (size[2] - 1) * spacing[2]]
          const y = [origin[1], origin[1] + (size[1] - 1) * spacing[1]]
          const z = [origin[0], origin[0] + (size[0] - 1) * spacing[0]]
          const volumeBounds = [Math.min(...x), Math.max(...x), Math.min(...y), Math.max(...y), Math.min(...z), Math.max(...z)]
          volumeBoundsRef.current = volumeBounds.map((v, i) => v + (i % 2 ? 0.5 : -0.5) * Math.abs(spacing[2 - (i >> 1)]))
          let userMovedCamera = false
          volumeViewer
            .getViewProxy()
            .getInteractorStyle3D()
            .onStartInteractionEvent(() => {
              userMovedCamera = true
            })
          const frameWholeVolume = () => {
            if (userMovedCamera) return
            const view = volumeViewer.getViewProxy()
            view.getRenderer().resetCamera(volumeBounds)
            view.renderLater()
          }
          // The intensity range starts at the volume's whole range, not
          // itk-vtk-viewer's default middle 60% (0.2-0.8 of it): for 8-bit
          // scans exactly 0-255, otherwise the data's own min-max. Redone as
          // finer levels load (their min-max can be wider), until the user
          // sets a range of their own.
          let rangeSet: [number, number] | null = null
          const applyFullRange = () => {
            const current = volumeViewer.getImageColorRange()
            if (rangeSet && current && (current[0] !== rangeSet[0] || current[1] !== rangeSet[1])) return
            const range: [number, number] | undefined =
              renderLookRef.current?.colorRange ?? (levels[0].dtype === '|u1' ? [0, 255] : volumeViewer.getImageColorRangeBounds())
            if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return
            rangeSet = [range[0], range[1]]
            if (current && current[0] === range[0] && current[1] === range[1]) return
            volumeViewer.setImageColorRange(rangeSet)
          }
          // The saved look (or the built-in defaults) -- its curve, sampling
          // and scattering; the range follows via applyFullRange.
          const applyLook = () => {
            const look = renderLookRef.current
            volumeViewer.setImageVolumeSampleDistance(look?.sampleDistance ?? DEFAULT_SAMPLE_DISTANCE)
            volumeViewer.setImageVolumeScatteringBlend(look?.scattering ?? DEFAULT_SCATTERING)
            volumeViewer.setImagePiecewiseFunctionPoints(look?.opacityPoints ?? DEFAULT_OPACITY_POINTS)
            lookApplied = true
          }
          applyLookNowRef.current = () => {
            if (!volumeViewer.getImageColorRangeBounds()) return // applied once the image is in
            rangeSet = null
            applyFullRange()
            applyLook()
          }
          const onImageUpdate = () => {
            // Catches the first label render, before the transfer function
            // is hooked (see applyLabelColors). The range goes in after
            // itk-vtk-viewer has set its own default for the new image.
            window.setTimeout(() => {
              applyLabelColorsRef.current()
              hookLabelOpacityRef.current()
              try {
                applyFullRange()
                frameWholeVolume()
                applyCropPlanesRef.current()
                // The starting look, once the image exists (its settings
                // live with the image in itk-vtk-viewer).
                if (!lookApplied && volumeViewer.getImageColorRangeBounds()) applyLook()
              } catch {
                // viewer mid-update; next image update
              }
            }, 0)
            try {
              volumeViewer.getViewProxy().getInteractorStyle3D().setCenterOfRotation(center)
              if (!colorMapApplied) {
                volumeViewer.setImageColorMap('Grayscale')
                colorMapApplied = true
              }
            } catch (e) {
              console.warn('Could not apply 3D view defaults yet:', e)
            }
          }
          volumeViewer.on('renderedImageAssigned', onImageUpdate)
          // Keep the toolbar's blend slider in step with itk-vtk-viewer's own
          // (its menu, a new label image). A search focus raises the blend
          // itself; the slider keeps showing the user's value then.
          volumeViewer.on('labelImageBlendChanged', () => {
            const focus = focusBlendRef.current
            const value = focus ? focus.base : volumeViewer.getLabelImageBlend()
            if (typeof value === 'number') setLabelBlendState(value)
          })
          onImageUpdate()
        } catch (e) {
          console.warn('Could not apply itk-vtk-viewer defaults:', e)
        }
        volumeViewerRef.current = volumeViewer
        const pendingLabelImage = pendingLabelImageUrlRef.current
        if (pendingLabelImage) void loadLabelImageUrlRef.current(pendingLabelImage)
        if (import.meta.env.DEV) (window as unknown as { __itkViewer?: ItkVtkViewerInstance }).__itkViewer = volumeViewer
        setLoadedName(name)
        setViewerGeneration((n) => n + 1)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load volume into itk-vtk-viewer')
      } finally {
        setBusy(false)
      }
    },
    [clearViewer]
  )

  // Loads one segmentation layer as itk-vtk-viewer's built-in labelImage
  // overlay on the currently-loaded volume. Real limits found by reading
  // the library's own source (its public types don't document any of
  // this): a viewer instance holds exactly one label image, so only one
  // segmentation layer can show here at a time -- see
  // ItkVtkViewerPage.tsx's own comment for which one it picks. Per label,
  // the public API controls visibility/opacity (setLabelImageWeights, a
  // Map<labelValue, 0-1>) and display names (setLabelImageLabelNames),
  // which setLabelWeights/setLabelNames below drive from the segment tree.
  // Colors have no public per-label method (only a palette name, assigned
  // by rank); setLabelColors below sets them another way.
  const loadLabelImageUrl = useCallback(async (url: string) => {
    const viewer = volumeViewerRef.current
    if (!viewer) {
      pendingLabelImageUrlRef.current = url
      return
    }
    pendingLabelImageUrlRef.current = null
    const absoluteUrl = new URL(url, window.location.href)
    labelImageReadyRef.current = false
    // A new label image starts without names; resend them even if unchanged.
    sentNamesRef.current = null
    await viewer.setLabelImage(absoluteUrl)
    if (viewer !== volumeViewerRef.current) return // replaced meanwhile
    // setLabelImage reveals its own dedicated UI groups (label weight
    // sliders, a second colormap editor, etc) regardless of the earlier
    // setUICollapsed(true) call in loadZarrUrl -- confirmed directly: the
    // full native toolbar/histogram/opacity-editor came back the moment a
    // label image was attached, squeezing the slice pane next to it.
    //
    // A plain re-assertion of setUICollapsed(true) here does NOT fix that,
    // even though it looks like it should -- confirmed by reading
    // itk-vtk-viewer's own source: setUICollapsed only sends its internal
    // "TOGGLE_UI_COLLAPSED" event when the requested value actually differs
    // from its current state (`e !== S.uiCollapsed && k.send(...)`), and by
    // this point the viewer's own state is already `true` from loadZarrUrl,
    // so calling setUICollapsed(true) again is a silent no-op -- the newly-
    // revealed groups never get hidden. Toggling it off and back on forces
    // two real state transitions, so the entry action that hides
    // "collapsible" groups actually re-runs against the now-larger set of
    // groups the label image just added.
    viewer.setUICollapsed(false)
    viewer.setUICollapsed(true)

    // The "cumulative 3D view" merge (useSegmentationMerge3D.ts) rebuilds
    // this label image with different geometry (origin/size/spacing) every
    // time the set of loaded segmentations changes -- its reference grid is
    // sized to whatever's currently included, not a fixed extent. itk-vtk-
    // viewer's cropping tool tracks its planes against an internal
    // "cropping virtual image" whose own dimensions get recomputed from the
    // loaded images -- confirmed by reading its source -- so swapping in a
    // label image with different bounds can leave previously-set crop
    // planes referring to extent values that no longer mean the same
    // physical region: dragging a plane back out doesn't necessarily
    // restore what it used to reveal. Resetting to the (safe, always
    // correct) uncropped state after every reload avoids that silently
    // wrong state; only doing it while cropping is actually enabled avoids
    // any unnecessary work/render when it was never touched.
    if (viewer.getCroppingPlanesEnabled()) viewer.resetCroppingPlanes()

    // A label-image reload can leave the render in a different-looking
    // state that re-applying the blend fixes (the same thing moving the
    // "label image blend" slider does). setLabelImageBlend ignores an
    // unchanged value, so nudge it off and back.
    const blend = viewer.getLabelImageBlend()
    if (typeof blend === 'number') {
      viewer.setLabelImageBlend(blend > 0.5 ? blend - 0.01 : blend + 0.01)
      viewer.setLabelImageBlend(blend)
    }
    applyLabelColorsRef.current()
    // Label weights and names that arrived while loading.
    labelImageReadyRef.current = true
    hookLabelOpacityRef.current()
    flushLabelUpdateRef.current()
    applyFocusBlendRef.current()
  }, [])
  useEffect(() => {
    loadLabelImageUrlRef.current = loadLabelImageUrl
  }, [loadLabelImageUrl])

  // Opacity and focus sliders fire continuously, and each update itk-vtk-
  // viewer applies redraws the whole labeled volume. Only the latest values
  // matter, so they're sent at most every LABEL_UPDATE_THROTTLE_MS -- and
  // only on an animation frame, which the browser holds back while the GPU
  // is still busy with earlier frames, so slow frames slow the updates
  // down instead of queueing up behind each other.
  const pendingLabelUpdate = useRef<LabelUpdate>({})
  const labelUpdateScheduled = useRef(false)
  const labelUpdateTimer = useRef(0)
  const labelUpdateFrame = useRef(0)
  const scheduleLabelUpdate = useCallback((update: LabelUpdate) => {
    Object.assign(pendingLabelUpdate.current, update)
    if (labelUpdateScheduled.current) return
    labelUpdateScheduled.current = true
    labelUpdateTimer.current = window.setTimeout(() => {
      labelUpdateFrame.current = requestAnimationFrame(() => {
        labelUpdateScheduled.current = false
        flushLabelUpdateRef.current()
      })
    }, LABEL_UPDATE_THROTTLE_MS)
  }, [])
  const sentNamesRef = useRef<Map<number, string> | null>(null)

  // Edits (segment visibility/opacity, focus) redraw the whole voxel render
  // at full quality, and a burst of them -- an opacity drag, clicks in a
  // row -- queued full-quality frames back to back: with dense sampling and
  // scattering on a large scan, enough GPU work for macOS to reset the GPU
  // (the page froze, then the browser crashed). So while edits are coming
  // in, frames sample EDIT_SAMPLING_FACTOR times more coarsely (cheap), and
  // EDIT_SETTLE_MS after the last one a single full-quality frame follows.
  // Only the mapper's sample distance changes -- a shader parameter, no
  // recompile -- and itk-vtk-viewer's own setting is left alone. vtk.js bakes
  // the sample distance into its opacity texture (per-sample opacity is
  // corrected for the step length) but rebuilds that texture only when an
  // opacity function changes, so each switch marks it stale: without that,
  // the full-quality frames after an edit used the coarse frames' (4x more
  // opaque per sample) table until the opacity curve was next touched.
  const editQualityRef = useRef<{ full: number; coarse: number; timer: number } | null>(null)
  const volumeMapper = () => {
    try {
      const view = volumeViewerRef.current?.getViewProxy() as unknown as
        | { getRepresentations: () => Array<{ getVolumes?: () => Array<{ getMapper: () => { getSampleDistance: () => number; setSampleDistance: (d: number) => void } }> }> }
        | undefined
      return view?.getRepresentations().flatMap((r) => r.getVolumes?.() ?? [])[0]?.getMapper() ?? null
    } catch {
      return null
    }
  }
  const endEditQuality = () => {
    const edit = editQualityRef.current
    editQualityRef.current = null
    if (!edit) return
    window.clearTimeout(edit.timer)
    const mapper = volumeMapper()
    // Unless something else changed it meanwhile (the sample distance
    // slider, a new resolution level).
    if (mapper && mapper.getSampleDistance() === edit.coarse) {
      mapper.setSampleDistance(edit.full)
      markLabelOpacityStale()
    }
    scheduleRender()
  }
  const beginEditQuality = () => {
    const mapper = volumeMapper()
    if (!mapper) return
    let edit = editQualityRef.current
    if (edit && mapper.getSampleDistance() !== edit.coarse) {
      // Changed underneath us: that's the new full-quality value.
      window.clearTimeout(edit.timer)
      edit = null
    }
    if (!edit) {
      const full = mapper.getSampleDistance()
      edit = { full, coarse: full * EDIT_SAMPLING_FACTOR, timer: 0 }
      mapper.setSampleDistance(edit.coarse)
      markLabelOpacityStale()
      editQualityRef.current = edit
    }
    window.clearTimeout(edit.timer)
    edit.timer = window.setTimeout(endEditQuality, EDIT_SETTLE_MS)
  }
  /** Makes the next voxel frame rebuild the opacity texture (see flush). */
  const markLabelOpacityStale = () => {
    try {
      for (const representation of volumeViewerRef.current?.getViewProxy().getRepresentations?.() ?? []) {
        representation.getVolumes?.()?.[0]?.getProperty().getScalarOpacity(0)?.modified()
      }
    } catch {
      // viewer mid-update
    }
  }
  // Sends the pending update -- only once the label image is set up (it
  // stays pending until then; loadLabelImageUrl flushes it).
  flushLabelUpdateRef.current = () => {
    const viewer = volumeViewerRef.current
    if (!viewer || !labelImageReadyRef.current) return
    const { weights, names, blend, userBlend } = pendingLabelUpdate.current
    pendingLabelUpdate.current = {}
    beginEditQuality()
    const rendersBefore = renderCountRef.current
    try {
      // Each of these makes itk-vtk-viewer redraw, so unchanged names (the
      // usual case: a visibility, opacity or focus change) aren't resent.
      if (names && !sameEntries(names, sentNamesRef.current)) {
        viewer.setLabelImageLabelNames(names)
        sentNamesRef.current = names
      }
      if (weights) {
        // vtk.js rebuilds the volume's opacity texture (all components) only
        // when component 0's opacity function changes -- the same cache-key
        // quirk as colors (see applyLabelColors) -- so without this, new label
        // weights (hiding a segment, an opacity change, search focus) never
        // reach the voxel render. Marked before the weights go in, so the
        // redraw itk-vtk-viewer makes for them already rebuilds it (the
        // listener in hookLabelOpacity covers its later rewrites).
        markLabelOpacityStale()
        viewer.setLabelImageWeights(weights)
      }
      if (userBlend !== undefined) {
        // During a search focus it's the blend the focus builds on (and
        // restores when it ends); otherwise the blend itself.
        const focus = focusBlendRef.current
        if (focus) focus.base = userBlend
        else if (blendToRestoreRef.current !== null) blendToRestoreRef.current = userBlend
        else viewer.setLabelImageBlend(userBlend)
      }
      if (blend || userBlend !== undefined) applyFocusBlendRef.current()
    } catch (e) {
      console.warn('Could not update label weights yet:', e)
    }
    // Draw once if itk-vtk-viewer didn't.
    if (renderCountRef.current === rendersBefore) scheduleRender()
  }
  useEffect(
    () => () => {
      window.clearTimeout(labelUpdateTimer.current)
      cancelAnimationFrame(labelUpdateFrame.current)
    },
    []
  )

  // Label colors. itk-vtk-viewer's API only takes a palette *name* and
  // assigns its colors by rank of each label value present, so the voxel
  // render can't match the segment colors the 2D panes and meshes use through
  // it. But it writes that palette into a vtk color transfer function on the
  // volume (applyLookupTable in its source), which is reachable through the
  // view proxy: the segment colors are written into it directly, keyed by
  // label value. itk-vtk-viewer rewrites the function whenever it re-applies
  // its palette (every progressive image update), so a modification listener
  // on the function writes the segment colors back once that rewrite is done
  // (vtk.js objects are frozen, so its methods can't be wrapped instead).
  // itk's own slice views share the same function, so they match too.
  // Label opacities (segment weights, search focus) have the same problem as
  // colors: vtk.js rebuilds the volume's opacity texture only when component
  // 0's opacity function changes. So a listener on the label component's
  // opacity function marks component 0's modified whenever the label one
  // really changes -- whenever itk-vtk-viewer gets round to applying new
  // weights, which can be after any fixed point we'd pick. Right away, not
  // later: itk-vtk-viewer redraws straight after rewriting the function, and
  // that frame has to see it. It doesn't draw itself; whoever changed the
  // weights does (see flush).
  const hookedOpacities = useRef(new WeakSet<object>())
  const hookLabelOpacity = useCallback(() => {
    const viewer = volumeViewerRef.current
    if (!viewer) return
    try {
      const viewProxy = viewer.getViewProxy()
      for (const representation of viewProxy.getRepresentations?.() ?? []) {
        const volume = representation.getVolumes?.()?.[0]
        const components = volume?.getMapper()?.getInputData()?.getPointData()?.getScalars()?.getNumberOfComponents() ?? 0
        if (!volume || components < 2) continue
        const property = volume.getProperty()
        const labelOpacity = property.getScalarOpacity(components - 1) as ({ onModified: (cb: () => void) => unknown } & object) | null
        if (!labelOpacity || hookedOpacities.current.has(labelOpacity)) continue
        hookedOpacities.current.add(labelOpacity)
        // Once per burst: itk-vtk-viewer rewrites the function point by
        // point, and marking it once is enough for the frame after.
        let marked = false
        labelOpacity.onModified(() => {
          if (marked) return
          marked = true
          property.getScalarOpacity(0)?.modified()
          queueMicrotask(() => {
            marked = false
          })
        })
      }
    } catch {
      // viewer mid-update; hooked on the next image update
    }
  }, [])
  const hookLabelOpacityRef = useRef(hookLabelOpacity)
  useEffect(() => {
    hookLabelOpacityRef.current = hookLabelOpacity
  }, [hookLabelOpacity])

  const labelColorsRef = useRef<Map<number, [number, number, number]> | null>(null)
  const hookedFunctions = useRef(new WeakSet<VtkColorTransferFunction>())
  const applyingColors = useRef(false)
  const reapplyScheduled = useRef(false)

  const applyLabelColors = useCallback(() => {
    const viewer = volumeViewerRef.current
    const colors = labelColorsRef.current
    if (!viewer || !colors || colors.size === 0) return
    let viewProxy: ReturnType<ItkVtkViewerInstance['getViewProxy']>
    try {
      viewProxy = viewer.getViewProxy()
    } catch {
      return
    }
    for (const representation of viewProxy.getRepresentations?.() ?? []) {
      const volume = representation.getVolumes?.()?.[0]
      const components = volume?.getMapper()?.getInputData()?.getPointData()?.getScalars()?.getNumberOfComponents() ?? 0
      // The label image is fused in as the last component; with only one
      // component there's no label image (yet), and the image's own color
      // map must be left alone.
      if (!volume || components < 2) continue
      const ctf = volume.getProperty().getRGBTransferFunction(components - 1)
      if (!ctf) continue
      if (!hookedFunctions.current.has(ctf)) {
        hookedFunctions.current.add(ctf)
        ctf.onModified(() => {
          // Ignore our own writes; coalesce itk's point-by-point rewrite
          // into one re-apply after it finishes.
          if (applyingColors.current || reapplyScheduled.current || !labelColorsRef.current) return
          reapplyScheduled.current = true
          queueMicrotask(() => {
            reapplyScheduled.current = false
            applyLabelColorsRef.current()
          })
        })
      }
      const values = [...colors.keys()].sort((a, b) => a - b)
      applyingColors.current = true
      try {
        ctf.removeAllPoints()
        // Background, as itk-vtk-viewer sets it.
        ctf.addRGBPointLong(0, 0, 0, 0, 0.5, 1.0)
        for (const value of values) {
          const [r, g, b] = colors.get(value)!
          ctf.addRGBPointLong(value, r, g, b, 0.5, 1.0)
        }
        ctf.setMappingRange(0, values[values.length - 1])
        // vtk.js rebuilds the volume's color texture (all components) only
        // when component 0's function changes -- its cache key is that
        // function's modified time alone -- so without this a recolor after
        // the first render never reaches the screen.
        volume.getProperty().getRGBTransferFunction(0)?.modified()
      } finally {
        applyingColors.current = false
      }
      scheduleRender()
    }
  }, [scheduleRender])

  useEffect(() => {
    applyLabelColorsRef.current = applyLabelColors
  }, [applyLabelColors])

  /** Segment colors (RGB 0-1) per merged label value, or null for
   *  itk-vtk-viewer's own palette. */
  const setLabelColors = useCallback(
    (colors: Map<number, [number, number, number]> | null) => {
      const previous = labelColorsRef.current
      // Unchanged (a visibility, opacity or focus change): nothing to redo.
      if (colors && previous && colors.size === previous.size && [...colors].every(([label, rgb]) => previous.get(label)?.every((c, i) => c === rgb[i]))) return
      const wasOverriding = previous !== null
      labelColorsRef.current = colors
      if (colors) {
        applyLabelColors()
      } else if (wasOverriding) {
        // Make itk-vtk-viewer rewrite its own palette (setting an unchanged
        // name is a no-op, so switch away and back).
        const viewer = volumeViewerRef.current
        viewer?.setLabelImageLookupTable('glasbey_light')
        viewer?.setLabelImageLookupTable(DEFAULT_LABEL_PALETTE)
      }
    },
    [applyLabelColors]
  )

  // Search focus in the voxel render. Fading the other segments' label
  // weights alone isn't enough: in itk-vtk-viewer's proportional opacity
  // mode a label weight only scales tissue opacity between (1 - blend) and
  // 1, so at the default blend everything outside the focus -- other
  // segments and unlabeled tissue -- stays clearly visible. So the focus
  // strength also raises the label blend, intersecting with the user's own:
  // effective = 1 - (1 - blend) * (1 - strength)^2. 0 leaves the blend as
  // it was; 1 leaves only the focused segments. Steeper than the 2D fade: a
  // volume render accumulates opacity along each ray, so tissue has to fade
  // much further before it stops reading as solid. The user's blend is
  // restored when the focus ends. Sent with the label weights (see
  // scheduleLabelUpdate): each blend change redraws the volume too.
  const blendToRestoreRef = useRef<number | null>(null)
  applyFocusBlendRef.current = () => {
    const viewer = volumeViewerRef.current
    if (!viewer || !labelImageReadyRef.current) return
    const focus = focusBlendRef.current
    try {
      if (focus) {
        viewer.setLabelImageBlend(1 - (1 - focus.base) * (1 - focus.strength) ** 2)
      } else if (blendToRestoreRef.current !== null) {
        viewer.setLabelImageBlend(blendToRestoreRef.current)
        blendToRestoreRef.current = null
      }
    } catch (e) {
      console.warn('Could not apply the focus blend yet:', e)
    }
  }
  const setFocusBlend = useCallback(
    (strength: number | null) => {
      const viewer = volumeViewerRef.current
      const current = focusBlendRef.current
      if (strength === null) {
        if (!current) return
        focusBlendRef.current = null
        blendToRestoreRef.current = current.base
      } else {
        // The user's own blend: from before this focus, or before one that
        // ended but whose restore hasn't been sent yet.
        const base =
          current?.base ?? blendToRestoreRef.current ?? (viewer && labelImageReadyRef.current ? viewer.getLabelImageBlend() : 0.5)
        focusBlendRef.current = { strength, base: typeof base === 'number' ? base : 0.5 }
        blendToRestoreRef.current = null
      }
      scheduleLabelUpdate({ blend: true })
    },
    [scheduleLabelUpdate]
  )

  // Background (label 0) must come first, at 0: itk-vtk-viewer builds the
  // label opacity function from the map in order and only anchors 0 -> 0 when
  // the map's first key is 0. Otherwise background inherits the first
  // segment's opacity, so every unlabeled voxel counts as partly labeled and
  // the blend slider no longer fades unlabeled tissue out.
  const setLabelWeights = useCallback(
    (weights: Map<number, number>) => {
      const ordered = new Map<number, number>([[0, 0]])
      for (const [label, weight] of weights) if (label !== 0) ordered.set(label, weight)
      scheduleLabelUpdate({ weights: ordered })
    },
    [scheduleLabelUpdate]
  )
  const labelNamesRef = useRef(new Map<number, string>())
  /** The toolbar's label blend slider. */
  const setLabelBlend = useCallback(
    (blend: number) => {
      setLabelBlendState(blend)
      scheduleLabelUpdate({ userBlend: blend })
    },
    [scheduleLabelUpdate]
  )
  /** The blend set right away, not throttled like the slider -- for the
   *  blend fade, one step per ~16 ms. The slider follows every ~100 ms (and
   *  on the `final` step), not on every step, sparing the page re-renders. */
  const blendStateTimeRef = useRef(0)
  const setLabelBlendNow = useCallback(
    (blend: number, final = false) => {
      const viewer = volumeViewerRef.current
      const now = performance.now()
      if (final || now - blendStateTimeRef.current > 100) {
        blendStateTimeRef.current = now
        setLabelBlendState(blend)
      }
      if (!viewer || !labelImageReadyRef.current) {
        scheduleLabelUpdate({ userBlend: blend })
        return
      }
      try {
        const focus = focusBlendRef.current
        if (focus) focus.base = blend
        else if (blendToRestoreRef.current !== null) blendToRestoreRef.current = blend
        else viewer.setLabelImageBlend(blend)
        applyFocusBlendRef.current()
      } catch {
        // viewer mid-update
      }
    },
    [scheduleLabelUpdate]
  )
  /** Apply a volume's saved look (null: the built-in defaults). */
  const setRenderLook = useCallback(
    (look: RenderLook | null) => {
      renderLookRef.current = look
      try {
        applyLookNowRef.current()
      } catch {
        // viewer mid-update; applied as the image loads
      }
      if (look) setLabelBlend(look.labelBlend)
    },
    [setLabelBlend]
  )
  /** The current look, for saving as the volume's default. */
  const getRenderLook = useCallback((): RenderLook | null => {
    const viewer = volumeViewerRef.current
    if (!viewer) return null
    try {
      const points = viewer.getImagePiecewiseFunctionPoints()
      const range = viewer.getImageColorRange()
      if (!points) return null
      return {
        opacityPoints: points.map(([x, y]) => [x, y] as [number, number]),
        colorRange: range ? [range[0], range[1]] : null,
        sampleDistance: viewer.getImageVolumeSampleDistance(),
        scattering: viewer.getImageVolumeScatteringBlend(),
        labelBlend: labelBlendRef.current
      }
    } catch {
      return null
    }
  }, [])
  const setLabelNames = useCallback(
    (names: Map<number, string>) => {
      labelNamesRef.current = names
      scheduleLabelUpdate({ names })
    },
    [scheduleLabelUpdate]
  )

  /** Snapshot / recording / turntable access to the render (CaptureBar). */
  const captureTarget = useMemo<CaptureTarget>(
    () => ({
      canvas: () => {
        try {
          return (volumeViewerRef.current?.getViewProxy() as unknown as PickableViewProxy | undefined)?.getOpenGLRenderWindow().getCanvas() ?? null
        } catch {
          return null
        }
      },
      snapshot: async () => {
        const viewer = volumeViewerRef.current
        return viewer ? dataUrlToBlob(await viewer.captureImage()) : null
      },
      // Not itk-vtk-viewer's own rotate animation, which spins about the
      // camera's focal point: this orbits the camera about the screen's
      // vertical axis through the mouse-rotation center, i.e. exactly a
      // continuous horizontal drag.
      setTurntable: (on) => {
        cancelAnimationFrame(turntableFrameRef.current)
        turntableFrameRef.current = 0
        if (!on) return
        let last = performance.now()
        const step = (time: number) => {
          turntableFrameRef.current = requestAnimationFrame(step)
          const dt = Math.min(0.25, (time - last) / 1000)
          last = time
          const viewer = volumeViewerRef.current
          if (!viewer || dt <= 0) return
          try {
            const view = viewer.getViewProxy() as unknown as VtkCameraView
            const camera = view.getCamera()
            const up = camera.getViewUp()
            const length = Math.hypot(up[0], up[1], up[2]) || 1
            const axis = up.map((c) => c / length)
            const center = rotationCenterRef.current ?? camera.getFocalPoint()
            const angle = (-2 * Math.PI * dt) / TURNTABLE_SECONDS_PER_TURN
            camera.setPosition(...rotateAbout(camera.getPosition(), center, axis, angle))
            camera.setFocalPoint(...rotateAbout(camera.getFocalPoint(), center, axis, angle))
            view.getRenderer().resetCameraClippingRange()
            view.renderLater()
          } catch {
            // viewer mid-update; try again next frame
          }
        }
        turntableFrameRef.current = requestAnimationFrame(step)
      },
      onFrame: (draw) => {
        const viewer = volumeViewerRef.current
        if (!viewer) return () => {}
        const view = viewer.getViewProxy() as unknown as VtkCameraView & PickableViewProxy
        const canvas = view.getOpenGLRenderWindow().getCanvas()
        const subscription = view.getInteractor().onRenderEvent(() => {
          if (canvas) draw(canvas)
        })
        return () => subscription.unsubscribe()
      },
      requestRender: scheduleRender,
      // Where the specimen can be on screen while it turns about the
      // screen's vertical axis through the volume's center (the turntable,
      // and left-right drags): the cylinder it sweeps, projected, plus a
      // small margin. Measured from the displayed image's own voxels -- every
      // voxel above the null (minimum) value, sampled -- not the volume's
      // box, which in a masked scan is mostly empty space.
      contentRect: () => {
        const viewer = volumeViewerRef.current
        const bounds = volumeBoundsRef.current
        if (!viewer || !bounds) return null
        try {
          const view = viewer.getViewProxy() as unknown as VtkCropView
          const renderWindow = view.getOpenGLRenderWindow()
          const [width, height] = renderWindow.getSize()
          const camera = view.getCamera()
          const dir = camera.getDirectionOfProjection()
          const upRaw = camera.getViewUp()
          const right = [dir[1] * upRaw[2] - dir[2] * upRaw[1], dir[2] * upRaw[0] - dir[0] * upRaw[2], dir[0] * upRaw[1] - dir[1] * upRaw[0]]
          const rl = Math.hypot(right[0], right[1], right[2]) || 1
          for (let i = 0; i < 3; i++) right[i] /= rl
          const up = [right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]]
          const center = rotationCenterRef.current ?? [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2]
          const extent = specimenSweep(view, center, up)
          if (!extent) return null
          const { hMin, hMax, radius } = extent
          let x0 = Infinity
          let x1 = -Infinity
          let y0 = Infinity
          let y1 = -Infinity
          for (let k = 0; k < 24; k++) {
            const a = (k / 24) * 2 * Math.PI
            const c = Math.cos(a) * radius
            const sn = Math.sin(a) * radius
            for (const h of [hMin, hMax]) {
              const p = [0, 1, 2].map((i) => center[i] + up[i] * h + right[i] * c + dir[i] * sn)
              const d = renderWindow.worldToDisplay(p[0], p[1], p[2], view.getRenderer())
              x0 = Math.min(x0, d[0])
              x1 = Math.max(x1, d[0])
              y0 = Math.min(y0, height - d[1])
              y1 = Math.max(y1, height - d[1])
            }
          }
          const margin = 0.04 * Math.max(x1 - x0, y1 - y0)
          const left = Math.max(0, Math.floor(x0 - margin))
          const top = Math.max(0, Math.floor(y0 - margin))
          const rect = { x: left, y: top, width: Math.min(width, Math.ceil(x1 + margin)) - left, height: Math.min(height, Math.ceil(y1 + margin)) - top }
          return rect.width > 16 && rect.height > 16 ? rect : null
        } catch {
          return null
        }
      },
      viewHeightMm: () => {
        try {
          const view = volumeViewerRef.current?.getViewProxy() as unknown as VtkCameraView | undefined
          const camera = view?.getCamera()
          if (!camera) return null
          if (camera.getParallelProjection()) return 2 * camera.getParallelScale()
          return 2 * camera.getDistance() * Math.tan((camera.getViewAngle() * Math.PI) / 360)
        } catch {
          return null
        }
      }
    }),
    [scheduleRender]
  )

  // The crop box (CropBoxOverlay). It drives the volume mapper's six
  // clipping planes -- the ones itk-vtk-viewer's own (axis-aligned) cropping
  // tool uses; the shader has room for no more -- turned to the box's angle.
  applyCropPlanesRef.current = () => {
    const planes = cropPlanesRef.current
    const viewer = volumeViewerRef.current
    if (!planes || !viewer) return
    try {
      const view = viewer.getViewProxy() as unknown as VtkCropView
      const mapperPlanes = view.getRepresentations().flatMap((r) => r.getVolumes?.() ?? [])[0]?.getMapper().getClippingPlanes() ?? []
      if (mapperPlanes.length !== 6) return
      planes.forEach((plane, i) => {
        mapperPlanes[i].setOrigin(...plane.origin)
        mapperPlanes[i].setNormal(...plane.normal)
      })
      scheduleRender()
    } catch {
      // viewer mid-update; re-applied on the next image update
    }
  }
  const cropInteraction = useRef({})
  const cropTarget = useMemo<CropTarget>(
    () => ({
      bounds: () => {
        if (volumeBoundsRef.current) return volumeBoundsRef.current
        try {
          const view = volumeViewerRef.current?.getViewProxy() as unknown as
            | { getRepresentations: () => Array<{ getVolumes?: () => Array<{ getMapper: () => { getInputData: () => { getBounds: () => number[] } | null } }> }> }
            | undefined
          const bounds = view?.getRepresentations().flatMap((r) => r.getVolumes?.() ?? [])[0]?.getMapper().getInputData()?.getBounds()
          return bounds && bounds.every(Number.isFinite) && bounds[1] > bounds[0] ? bounds : null
        } catch {
          return null
        }
      },
      setPlanes: (planes) => {
        const viewer = volumeViewerRef.current
        cropPlanesRef.current = planes
        if (!viewer) return
        if (planes) {
          // One crop at a time: itk-vtk-viewer's tool moves the same planes.
          if (viewer.getCroppingPlanesEnabled()) viewer.setCroppingPlanesEnabled(false)
          applyCropPlanesRef.current()
        } else {
          viewer.resetCroppingPlanes()
          scheduleRender()
        }
      },
      project: (points, element) => {
        const viewer = volumeViewerRef.current
        if (!viewer) return null
        try {
          const view = viewer.getViewProxy() as unknown as VtkCropView
          const renderWindow = view.getOpenGLRenderWindow()
          const canvas = renderWindow.getCanvas()
          if (!canvas) return null
          const [width, height] = renderWindow.getSize()
          const c = canvas.getBoundingClientRect()
          const e = element.getBoundingClientRect()
          if (!width || !height || !c.width || !c.height) return null
          return points.map((p) => {
            const d = renderWindow.worldToDisplay(p[0], p[1], p[2], view.getRenderer())
            return [c.left - e.left + (d[0] * c.width) / width, c.top - e.top + ((height - d[1]) * c.height) / height]
          })
        } catch {
          return null
        }
      },
      cameraAxes: () => {
        const viewer = volumeViewerRef.current
        if (!viewer) return null
        const camera = (viewer.getViewProxy() as unknown as VtkCropView).getCamera()
        const d = camera.getDirectionOfProjection()
        const u = camera.getViewUp()
        const right: Vec3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]
        const r = Math.hypot(...right) || 1
        const unitRight = right.map((v) => v / r) as Vec3
        const up: Vec3 = [
          unitRight[1] * d[2] - unitRight[2] * d[1],
          unitRight[2] * d[0] - unitRight[0] * d[2],
          unitRight[0] * d[1] - unitRight[1] * d[0]
        ]
        return { up, right: unitRight }
      },
      onFrame: (callback) => {
        const viewer = volumeViewerRef.current
        if (!viewer) return () => {}
        const subscription = (viewer.getViewProxy() as unknown as VtkCameraView).getInteractor().onRenderEvent(callback)
        return () => subscription.unsubscribe()
      },
      container: () => volumeContainerRef.current,
      beginInteraction: () => {
        try {
          ;(volumeViewerRef.current?.getViewProxy() as unknown as VtkCropView | undefined)?.getInteractor().requestAnimation(cropInteraction.current)
        } catch {
          // no viewer
        }
      },
      endInteraction: () => {
        try {
          ;(volumeViewerRef.current?.getViewProxy() as unknown as VtkCropView | undefined)?.getInteractor().cancelAnimation(cropInteraction.current)
          scheduleRender()
        } catch {
          // no viewer
        }
      }
    }),
    [scheduleRender]
  )

  if (import.meta.env.DEV) (window as unknown as { __captureTarget?: CaptureTarget }).__captureTarget = captureTarget

  /** The segment name the voxel render shows at a screen point, or null
   *  (see lib/volumePick.ts). */
  const pickLabelName = useCallback((clientX: number, clientY: number): string | null => {
    const viewer = volumeViewerRef.current
    if (!viewer) return null
    try {
      const label = pickVolumeLabel(viewer.getViewProxy() as unknown as PickableViewProxy, clientX, clientY)
      return label === null ? null : (labelNamesRef.current.get(label) ?? null)
    } catch {
      return null // viewer mid-update
    }
  }, [])

  return {
    volumeContainerRef,
    scriptReady,
    busy,
    error,
    loadedName,
    viewerGeneration,
    clearVolume: clearViewer,
    loadZarrUrl,
    loadLabelImageUrl,
    setLabelWeights,
    setLabelNames,
    pickLabelName,
    setFocusBlend,
    labelBlend,
    setLabelBlend,
    setLabelBlendNow,
    setRenderLook,
    getRenderLook,
    captureTarget,
    cropTarget,
    setLabelColors,
    applyLabelColors
  }
}
