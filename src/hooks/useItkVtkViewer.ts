import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureTarget } from '../components/CaptureBar'
import { dataUrlToBlob } from '../lib/capture'
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

/** Label changes waiting to be sent to itk-vtk-viewer (see
 *  scheduleLabelUpdate); `blend` re-applies the search focus's blend. */
interface LabelUpdate {
  weights?: Map<number, number>
  names?: Map<number, string>
  blend?: true
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
    renderFrameRef.current = 0
    rotationCenterRef.current = null
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
            const range: [number, number] | undefined = levels[0].dtype === '|u1' ? [0, 255] : volumeViewer.getImageColorRangeBounds()
            if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return
            rangeSet = [range[0], range[1]]
            if (current && current[0] === range[0] && current[1] === range[1]) return
            volumeViewer.setImageColorRange(rangeSet)
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
                // The starting look, once the image exists (its settings
                // live with the image in itk-vtk-viewer).
                if (!lookApplied && volumeViewer.getImageColorRangeBounds()) {
                  volumeViewer.setImageVolumeSampleDistance(DEFAULT_SAMPLE_DISTANCE)
                  volumeViewer.setImageVolumeScatteringBlend(DEFAULT_SCATTERING)
                  volumeViewer.setImagePiecewiseFunctionPoints(DEFAULT_OPACITY_POINTS)
                  lookApplied = true
                }
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
          onImageUpdate()
        } catch (e) {
          console.warn('Could not apply itk-vtk-viewer defaults:', e)
        }
        volumeViewerRef.current = volumeViewer
        const pendingLabelImage = pendingLabelImageUrlRef.current
        if (pendingLabelImage) void loadLabelImageUrlRef.current(pendingLabelImage)
        if (import.meta.env.DEV) (window as unknown as { __itkViewer?: ItkVtkViewerInstance }).__itkViewer = volumeViewer
        setLoadedName(name)
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
    const { weights, names, blend } = pendingLabelUpdate.current
    pendingLabelUpdate.current = {}
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
      if (blend) applyFocusBlendRef.current()
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
    clearVolume: clearViewer,
    loadZarrUrl,
    loadLabelImageUrl,
    setLabelWeights,
    setLabelNames,
    pickLabelName,
    setFocusBlend,
    captureTarget,
    setLabelColors,
    applyLabelColors
  }
}
