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
  delete: () => void
}

interface ItkVtkViewerGlobal {
  createViewer: (
    container: HTMLElement,
    options: { image: URL; rotate?: boolean }
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

export function useItkVtkViewer() {
  const sliceContainerRef = useRef<HTMLDivElement | null>(null)
  const volumeContainerRef = useRef<HTMLDivElement | null>(null)
  const sliceViewerRef = useRef<ItkVtkViewerInstance | null>(null)
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

  const clearViewers = useCallback(() => {
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
          window.itkVtkViewer.createViewer(sliceContainerRef.current, { image: absoluteUrl, rotate: false }),
          window.itkVtkViewer.createViewer(volumeContainerRef.current, { image: absoluteUrl, rotate: false })
        ])
        sliceViewer.setViewMode('ZPlane')
        volumeViewer.setViewMode('Volume')
        // itk-vtk-viewer only auto-collapses its (fairly wide) native control
        // panel on genuinely small screens (window.screen.availWidth < 768),
        // which never applies to our side-by-side split -- each pane is
        // narrow, but the browser window itself is normal desktop width, so
        // its own heuristic never fires and the full panel crowds the pane.
        // Force the same compact mode its own hamburger-menu toggle uses.
        sliceViewer.setUICollapsed(true)
        volumeViewer.setUICollapsed(true)
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
