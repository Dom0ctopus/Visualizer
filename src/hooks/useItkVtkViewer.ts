import { useCallback, useEffect, useRef, useState } from 'react'
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
  on: (event: string, callback: () => void) => void
  getViewProxy: () => {
    getInteractorStyle3D: () => { setCenterOfRotation: (center: [number, number, number]) => void }
  }
  // No delete/destroy/dispose exists (checked against its bundled source);
  // see clearViewer for how a replaced viewer's resources are released.
}

// How often label weight/name updates reach itk-vtk-viewer while a slider
// is being dragged: each one re-renders the whole labeled volume.
const LABEL_UPDATE_THROTTLE_MS = 150

// itk-vtk-viewer's hard limits for one image update (read from its source:
// "Voxel count over max" / "Image byte count over max").
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
          let colorMapApplied = false
          const onImageUpdate = () => {
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
  // ItkVtkViewerPage.tsx's own comment for which one it picks. Colors also
  // can't be set per-label through any public method: setLabelImageLookupTable
  // only accepts the *name* of a built-in categorical palette (e.g.
  // "glasbey", its own default), assigned by rank order of each unique
  // label value present in the data -- there is no arbitrary-RGB path, so
  // colors here will not match the segment's own 3D-Slicer-defined color
  // the way the slice pane's own compositing does (see
  // useSegmentationOverlays.ts). What *is* fully controllable per label is
  // visibility/opacity (setLabelImageWeights, a Map<labelValue, 0-1>) and
  // display names (setLabelImageLabelNames), which is what
  // setLabelWeights/setLabelNames below drive from this app's own segment
  // tree state.
  const loadLabelImageUrl = useCallback(async (url: string) => {
    const viewer = volumeViewerRef.current
    if (!viewer) return
    const absoluteUrl = new URL(url, window.location.href)
    await viewer.setLabelImage(absoluteUrl)
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
  }, [])

  // Opacity sliders fire continuously; forwarding every tick made
  // itk-vtk-viewer re-render the full labeled volume dozens of times a
  // second. Only the latest values matter, so send them at most every
  // LABEL_UPDATE_THROTTLE_MS.
  const pendingLabelUpdate = useRef<{ weights?: Map<number, number>; names?: Map<number, string> }>({})
  const labelUpdateTimer = useRef<number | null>(null)
  const scheduleLabelUpdate = useCallback((update: { weights?: Map<number, number>; names?: Map<number, string> }) => {
    Object.assign(pendingLabelUpdate.current, update)
    if (labelUpdateTimer.current !== null) return
    labelUpdateTimer.current = window.setTimeout(() => {
      labelUpdateTimer.current = null
      const { weights, names } = pendingLabelUpdate.current
      pendingLabelUpdate.current = {}
      const viewer = volumeViewerRef.current
      if (!viewer) return
      if (names) viewer.setLabelImageLabelNames(names)
      if (weights) viewer.setLabelImageWeights(weights)
    }, LABEL_UPDATE_THROTTLE_MS)
  }, [])
  useEffect(
    () => () => {
      if (labelUpdateTimer.current !== null) window.clearTimeout(labelUpdateTimer.current)
    },
    []
  )

  const setLabelWeights = useCallback((weights: Map<number, number>) => scheduleLabelUpdate({ weights }), [scheduleLabelUpdate])
  const setLabelNames = useCallback((names: Map<number, string>) => scheduleLabelUpdate({ names }), [scheduleLabelUpdate])

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
    setLabelNames
  }
}
