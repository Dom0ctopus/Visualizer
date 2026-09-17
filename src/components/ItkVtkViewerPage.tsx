import { useEffect, useRef, useState } from 'react'
import { fetchLibrary, zarrUrl } from '../lib/api'
import { useItkVtkViewer } from '../hooks/useItkVtkViewer'
import { useZarrSliceViewer } from '../hooks/useZarrSliceViewer'
import { ZarrSliceCanvas } from './ZarrSliceCanvas'
import type { LibraryRecord, VolumeRecord } from '../types'

const POLL_INTERVAL_MS = 1500

function statusLabel(record: VolumeRecord): string {
  switch (record.zarrStatus) {
    case 'ready':
      return 'ready'
    case 'failed':
      return 'conversion failed'
    case 'pending':
      return 'converting…'
    default:
      return 'not converted'
  }
}

/**
 * A second, parallel viewer built on itk-vtk-viewer/vtk.js for the 3D
 * render, plus a custom canvas-based reader for the slice view -- see the
 * conversation history for why the slice side isn't itk-vtk-viewer too:
 * its use2D/ZPlane mode hits a hard internal voxel-count cap on scans this
 * large and corrupts the display when the slice position changes, with no
 * public API workaround found. useZarrSliceViewer reads full-resolution 2D
 * slices directly out of the same OME-Zarr store instead, sidestepping
 * that mode entirely -- true zero-downsampling for slices, at the cost of
 * building the window/level and scroll-to-slice UI ourselves.
 *
 * Deliberately scoped down from the niivue engine otherwise: no
 * segmentation overlays, no custom transfer function import -- just
 * independent window/level on a plain volume, to prove out the
 * architecture. Segments/TF can follow later.
 *
 * Volumes are only loadable here once the server's background NRRD -> OME-
 * Zarr conversion (kicked off on upload, see server/src/zarrConvert.ts)
 * finishes -- this polls the library while any volume is still converting.
 */
export function ItkVtkViewerPage() {
  const [library, setLibrary] = useState<LibraryRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [activeZarrUrl, setActiveZarrUrl] = useState<string | null>(null)
  const pollTimerRef = useRef<number | null>(null)

  const { volumeContainerRef, scriptReady, busy, error: viewerError, loadedName, loadZarrUrl } = useItkVtkViewer()
  const {
    volumeInfo,
    zIndex,
    setZIndex,
    stepZIndex,
    slice,
    windowMin,
    windowMax,
    setWindowMin,
    setWindowMax,
    dataRange,
    error: sliceError
  } = useZarrSliceViewer(activeZarrUrl)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const records = await fetchLibrary()
        if (cancelled) return
        setLibrary(records)
        const anyPending = records.some((r) => r.kind === 'volume' && r.zarrStatus === 'pending')
        pollTimerRef.current = window.setTimeout(poll, anyPending ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 4)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to reach the backend server.')
      }
    }
    poll()

    return () => {
      cancelled = true
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    }
  }, [])

  const volumes = library.filter((r): r is VolumeRecord => r.kind === 'volume')

  const handleLoad = (record: VolumeRecord) => {
    const url = zarrUrl(record.id)
    setActiveZarrUrl(url)
    loadZarrUrl(url, record.name)
  }

  const sliderStep = Math.max((dataRange[1] - dataRange[0]) / 1000, 0.01)

  return (
    <div className="app-body">
      <div className="viewer itk-viewer-split">
        <div className="itk-viewer-pane">
          <div className="itk-viewer-pane-label">Slice View</div>
          <div className="itk-viewer-container">
            <ZarrSliceCanvas slice={slice} windowMin={windowMin} windowMax={windowMax} onWheelStep={stepZIndex} />
          </div>
          {volumeInfo && (
            <div className="zarr-slice-controls">
              <span className="tf-hint">
                Z: {zIndex} / {volumeInfo.size[0] - 1}
              </span>
              <input
                type="range"
                className="window-slider"
                min={0}
                max={volumeInfo.size[0] - 1}
                step={1}
                value={zIndex}
                onChange={(e) => setZIndex(Number(e.target.value))}
              />
            </div>
          )}
        </div>
        <div className="itk-viewer-pane">
          <div className="itk-viewer-pane-label">3D Render</div>
          <div ref={volumeContainerRef} className="itk-viewer-container" />
        </div>
      </div>

      <aside className="sidebar">
        {(error || viewerError || sliceError) && <div className="error-banner">{error ?? viewerError ?? sliceError}</div>}

        <section className="panel">
          <h2 className="panel-title">Volumes (itk-vtk-viewer)</h2>
          <p className="panel-hint">
            Each volume is converted on upload into a chunked, multiscale OME-Zarr pyramid. The 3D render picks a
            resolution level that fits in memory instead of requiring the whole scan to fit in one GPU texture up
            front the way the niivue engine does; the slice view reads full native-resolution 2D slices directly
            from the same store. No segmentation overlays or custom transfer functions here yet -- this exists to
            prove out independent slice / 3D window-level control.
          </p>
          {volumes.length === 0 && (
            <p className="empty-hint">Upload a volume from the main viewer's library panel -- it'll show up here once converted.</p>
          )}
          <ul className="library-list">
            {volumes.map((record) => (
              <li key={record.id} className="library-row">
                <span className="library-kind library-kind-volume">VOL</span>
                <div className="library-main">
                  <div className="library-name" title={record.name}>
                    {record.name}
                  </div>
                  <div className="library-meta">{statusLabel(record)}</div>
                </div>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={!scriptReady || busy || record.zarrStatus !== 'ready'}
                  onClick={() => handleLoad(record)}
                >
                  Load
                </button>
              </li>
            ))}
          </ul>
        </section>

        {volumeInfo && (
          <section className="panel">
            <h2 className="panel-title">Slice Window/Level</h2>
            <p className="tf-hint">
              {windowMin.toFixed(1)} &ndash; {windowMax.toFixed(1)}
            </p>
            <label className="tf-hint" htmlFor="zarr-slice-min-slider">
              Min
            </label>
            <input
              id="zarr-slice-min-slider"
              className="window-slider"
              type="range"
              min={dataRange[0]}
              max={dataRange[1]}
              step={sliderStep}
              value={windowMin}
              onChange={(e) => setWindowMin(Math.min(Number(e.target.value), windowMax))}
            />
            <label className="tf-hint" htmlFor="zarr-slice-max-slider">
              Max
            </label>
            <input
              id="zarr-slice-max-slider"
              className="window-slider"
              type="range"
              min={dataRange[0]}
              max={dataRange[1]}
              step={sliderStep}
              value={windowMax}
              onChange={(e) => setWindowMax(Math.max(Number(e.target.value), windowMin))}
            />
            <p className="tf-hint">Scroll the slice pane to page through Z, independently of the 3D render's own window/level.</p>
          </section>
        )}

        {loadedName && (
          <section className="panel">
            <h2 className="panel-title">Loaded</h2>
            <p className="panel-hint">{loadedName}</p>
          </section>
        )}
      </aside>
    </div>
  )
}
