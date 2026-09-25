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
  on: (event: string, callback: () => void) => void
  setLabelImageLookupTable: (lookupTable: string) => void
  /** PNG data URL of the render (the vtk.js view's captureImage). */
  captureImage: () => Promise<string>
  /** itk-vtk-viewer's continuous-rotation toggle. */
  setRotateEnabled: (enabled: boolean) => void
  getViewProxy: () => {
    getInteractorStyle3D: () => { setCenterOfRotation: (center: [number, number, number]) => void }
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
  getProperty: () => { getRGBTransferFunction: (component: number) => VtkColorTransferFunction | null }
  getMapper: () => { getInputData: () => { getPointData: () => { getScalars: () => { getNumberOfComponents: () => number } | null } } | null } | null
}

// The name of itk-vtk-viewer's default categorical palette.
const DEFAULT_LABEL_PALETTE = 'glasbey'

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
  // applyLabelColors (defined below) for the loaders above it.
  const applyLabelColorsRef = useRef<() => void>(() => {})

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
            // Catches the first label render, before the transfer function
            // is hooked (see applyLabelColors).
            window.setTimeout(() => applyLabelColorsRef.current(), 0)
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
    applyLabelColorsRef.current()
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
      viewProxy.renderLater()
    }
  }, [])

  useEffect(() => {
    applyLabelColorsRef.current = applyLabelColors
  }, [applyLabelColors])

  /** Segment colors (RGB 0-1) per merged label value, or null for
   *  itk-vtk-viewer's own palette. */
  const setLabelColors = useCallback(
    (colors: Map<number, [number, number, number]> | null) => {
      const wasOverriding = labelColorsRef.current !== null
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
      setTurntable: (on) => {
        const viewer = volumeViewerRef.current
        if (typeof viewer?.setRotateEnabled === 'function') viewer.setRotateEnabled(on)
      }
    }),
    []
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
    captureTarget,
    setLabelColors,
    applyLabelColors
  }
}
