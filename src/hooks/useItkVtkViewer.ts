import { useCallback, useEffect, useRef, useState } from 'react'

// itk-vtk-viewer ships as a legacy global-script webpack bundle, not an
// ESM/CJS module -- its own type declarations use `declare namespace
// itkVtkViewer`, matching its documented <script src="..."> embedding
// pattern. So it's loaded here via a plain <script> tag (served from
// public/itk-vtk-viewer, synced from node_modules by
// scripts/sync-itk-vtk-viewer.mjs) rather than `import`-ed.
interface ItkVtkViewerInstance {
  setViewMode: (mode: 'ZPlane' | 'YPlane' | 'XPlane' | 'Volume') => void
  setUICollapsed: (collapsed: boolean) => void
  setRotateEnabled: (enabled: boolean) => void
  getZSlice: () => number
  setZSlice: (value: number) => void
  delete: () => void
}

interface ItkVtkViewerGlobal {
  createViewer: (
    container: HTMLElement,
    options: { image: URL; rotate?: boolean; use2D?: boolean }
  ) => Promise<ItkVtkViewerInstance>
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

// Finds whichever <input type=range> in the panel currently holds the
// closest value to `targetValue` -- used only to read a sensible min/max/
// step for calibrating the wheel step below. The panel has several other
// range inputs (opacity, sample distance, gradient opacity...), and there's
// no stable selector distinguishing "the Z slider" from those without
// depending on itk-vtk-viewer's generated class names, so matching by
// value against the number we already trust from getZSlice() sidesteps
// that rather than guessing.
function findSliderNear(container: HTMLElement, targetValue: number): HTMLInputElement | null {
  const sliders = container.querySelectorAll<HTMLInputElement>('input[type="range"]')
  let best: HTMLInputElement | null = null
  let bestDiff = Infinity
  for (const slider of sliders) {
    const diff = Math.abs(Number(slider.value) - targetValue)
    if (diff < bestDiff) {
      best = slider
      bestDiff = diff
    }
  }
  return best
}

// itk-vtk-viewer's own wheel handler zooms the camera even in use2D/ZPlane
// mode -- there's no public option to repoint it at slice-stepping instead.
// Calls the viewer's own setZSlice/getZSlice directly rather than faking a
// drag on the native slider: dispatching synthetic input/change events on
// it was tried first and corrupted the viewer's internal xstate machine
// (rapid-fire wheel events synthesizing many overlapping value changes
// produced "Cannot read properties of undefined" and "Did not find image to
// compare" errors) -- the public setter is the same call the slider's own
// handler ends up making, without that state-machine risk. Attached on the
// capture phase at the outermost container -- an ancestor of everything
// itk-vtk-viewer renders inside it -- so it intercepts before the
// library's own bubble-phase listener (wherever exactly it's bound
// underneath) ever sees the event.
function attachWheelToZSlice(container: HTMLElement, viewer: ItkVtkViewerInstance): () => void {
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const current = viewer.getZSlice()
    const slider = findSliderNear(container, current)
    const min = slider ? Number(slider.min) : -Infinity
    const max = slider ? Number(slider.max) : Infinity
    const range = max - min
    const step = slider && Number(slider.step) > 0 ? Number(slider.step) : Number.isFinite(range) ? range / 200 : 1
    const next = Math.min(max, Math.max(min, current + step * (e.deltaY > 0 ? 1 : -1)))
    viewer.setZSlice(next)
  }
  container.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => container.removeEventListener('wheel', onWheel, { capture: true })
}

export function useItkVtkViewer() {
  const sliceContainerRef = useRef<HTMLDivElement | null>(null)
  const volumeContainerRef = useRef<HTMLDivElement | null>(null)
  const sliceViewerRef = useRef<ItkVtkViewerInstance | null>(null)
  const volumeViewerRef = useRef<ItkVtkViewerInstance | null>(null)
  const detachWheelRef = useRef<(() => void) | null>(null)

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

  const clearViewers = useCallback(() => {
    detachWheelRef.current?.()
    detachWheelRef.current = null
    sliceViewerRef.current?.delete()
    volumeViewerRef.current?.delete()
    sliceViewerRef.current = null
    volumeViewerRef.current = null
    if (sliceContainerRef.current) sliceContainerRef.current.replaceChildren()
    if (volumeContainerRef.current) volumeContainerRef.current.replaceChildren()
    setLoadedName(null)
  }, [])

  // Tears down both viewer instances on unmount only (stable ref, no deps).
  useEffect(() => clearViewers, [clearViewers])

  const loadZarrUrl = useCallback(
    async (url: string, name: string) => {
      if (!window.itkVtkViewer || !sliceContainerRef.current || !volumeContainerRef.current) return
      setBusy(true)
      setError(null)
      try {
        clearViewers()
        const absoluteUrl = new URL(url, window.location.href)
        const [sliceViewer, volumeViewer] = await Promise.all([
          // use2D switches this instance to itk-vtk-viewer's dedicated
          // orthogonal-slice mode (à la a 3D Slicer 2D view) -- without it,
          // the slice plane is just an object floating in the same free
          // trackball-orbit camera the volume view uses, so scroll zooms
          // the camera instead of paging through slices and dragging orbits
          // around to look behind the plane rather than panning across it.
          window.itkVtkViewer.createViewer(sliceContainerRef.current, { image: absoluteUrl, rotate: false, use2D: true }),
          window.itkVtkViewer.createViewer(volumeContainerRef.current, { image: absoluteUrl, rotate: false })
        ])
        sliceViewer.setViewMode('ZPlane')
        sliceViewer.setRotateEnabled(false)
        volumeViewer.setViewMode('Volume')
        // itk-vtk-viewer only auto-collapses its (fairly wide) native control
        // panel on genuinely small screens (window.screen.availWidth < 768),
        // which never applies to our side-by-side split -- each pane is
        // narrow, but the browser window itself is normal desktop width, so
        // its own heuristic never fires and the full panel crowds the pane.
        // Force the same compact mode its own hamburger-menu toggle uses.
        sliceViewer.setUICollapsed(true)
        volumeViewer.setUICollapsed(true)
        if (sliceContainerRef.current) detachWheelRef.current = attachWheelToZSlice(sliceContainerRef.current, sliceViewer)
        sliceViewerRef.current = sliceViewer
        volumeViewerRef.current = volumeViewer
        setLoadedName(name)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load volume into itk-vtk-viewer')
      } finally {
        setBusy(false)
      }
    },
    [clearViewers]
  )

  return {
    sliceContainerRef,
    volumeContainerRef,
    scriptReady,
    busy,
    error,
    loadedName,
    loadZarrUrl
  }
}
