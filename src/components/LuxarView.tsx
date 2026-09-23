import { useEffect, useRef, useState } from 'react'
import type { LayerPatch, LayerSummary, LuxarApp } from '@luxar/viewer'

interface LuxarViewProps {
  /** The .luxar.zarr archive to show; null keeps whatever is loaded. */
  src: string | null
  /** Whether the view is on screen (input is disabled while hidden). */
  visible: boolean
  /** Desired per-layer appearance, keyed by layer name; applied after each
   *  load and whenever it changes. Layers not listed are left alone. */
  layerPatches?: Map<string, LayerPatch>
}

/**
 * Luxar's browser viewer (@luxar/viewer), for the Luxar-backed 3D tabs.
 * Luxar supports one viewer per page, so both tabs share this one and
 * switch its dataset. The library (~1MB, plus workers) is loaded on first
 * use rather than with the app.
 */
export function LuxarView({ src, visible, layerPatches }: LuxarViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const appRef = useRef<LuxarApp | null>(null)
  // Serializes init/switchDataset/dispose, which are async.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())
  const loadedSrcRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [layersVersion, setLayersVersion] = useState(0)

  useEffect(() => {
    return () => {
      chainRef.current = chainRef.current.then(() => {
        appRef.current?.dispose()
        appRef.current = null
        loadedSrcRef.current = null
      })
    }
  }, [])

  useEffect(() => {
    if (!src) return
    const absolute = new URL(src, window.location.href).href
    chainRef.current = chainRef.current.then(async () => {
      if (loadedSrcRef.current === absolute) return
      setLoading(true)
      setError(null)
      try {
        if (!appRef.current) {
          const [{ LuxarApp }] = await Promise.all([import('@luxar/viewer'), import('@luxar/viewer/styles.css')])
          const app = new LuxarApp()
          app.on('dataset-loaded', () => {
            setLoading(false)
            setLayersVersion((v) => v + 1)
          })
          // Luxar only provisions GPU picking (which drives its hover
          // tooltips) when a selection listener exists at load time.
          app.on('selection', () => {})
          app.on('dataset-error', ({ error: e }) => {
            setLoading(false)
            setError(e instanceof Error ? e.message : String(e))
          })
          appRef.current = app
          // Dev builds: reachable from the console / browser tests.
          if (import.meta.env.DEV) (window as unknown as { __luxarApp?: LuxarApp }).__luxarApp = app
          await app.init({ canvas: canvasRef.current!, container: containerRef.current!, src: absolute, updateBrowserUrl: false })
        } else {
          await appRef.current.switchDataset(absolute)
        }
        loadedSrcRef.current = absolute
      } catch (e) {
        setLoading(false)
        setError(e instanceof Error ? e.message : 'Failed to start the Luxar viewer')
      }
    })
  }, [src])

  useEffect(() => {
    const app = appRef.current
    if (!app || loadedSrcRef.current === null) return
    app.setInputEnabled(visible)
    if (visible) app.resize()
  }, [visible, layersVersion])

  useEffect(() => {
    const app = appRef.current
    if (!app || !layerPatches || loadedSrcRef.current === null) return
    let layers: LayerSummary[]
    try {
      layers = app.getLayers()
    } catch {
      return
    }
    for (const layer of layers) {
      const patch = layerPatches.get(layer.name)
      if (!patch) continue
      const changed = (Object.keys(patch) as Array<keyof LayerPatch>).some((k) => patch[k] !== layer[k as keyof LayerSummary])
      if (changed) app.setLayer(layer.path, patch)
    }
  }, [layerPatches, layersVersion])

  return (
    <div ref={containerRef} className="luxar-view">
      <canvas ref={canvasRef} className="luxar-view-canvas" />
      {(loading || error) && <div className="luxar-view-status">{error ? `Luxar viewer: ${error}` : 'Loading Luxar scene…'}</div>}
    </div>
  )
}
