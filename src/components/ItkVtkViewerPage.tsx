import { useEffect, useRef, useState } from 'react'
import { fetchLibrary, zarrUrl } from '../lib/api'
import { useItkVtkViewer } from '../hooks/useItkVtkViewer'
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
 * A second, parallel viewer built on itk-vtk-viewer/vtk.js instead of
 * niivue -- see the conversation with the user for the reasoning: vtk.js's
 * volume mapper supports GPU-memory bricking that niivue's single-3D-texture
 * approach can't, and its pipeline keeps a slice view's window/level and a
 * volume's transfer function as genuinely separate objects on the same data,
 * rather than needing the dual-engine/canvas-blit workaround useNiivue.ts
 * uses for the same independence.
 *
 * Deliberately scoped down from the niivue engine: no segmentation overlays,
 * no custom transfer function import -- just independent window/level on a
 * plain volume, to prove out the architecture. Segments/TF can follow later.
 *
 * Volumes are only loadable here once the server's background NRRD -> OME-
 * Zarr conversion (kicked off on upload, see server/src/zarrConvert.ts)
 * finishes -- this polls the library while any volume is still converting.
 */
export function ItkVtkViewerPage() {
  const [library, setLibrary] = useState<LibraryRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const pollTimerRef = useRef<number | null>(null)

  const { sliceContainerRef, volumeContainerRef, scriptReady, busy, error: viewerError, loadedName, loadZarrUrl } =
    useItkVtkViewer()

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

  return (
    <div className="app-body">
      <div className="viewer itk-viewer-split">
        <div className="itk-viewer-pane">
          <div className="itk-viewer-pane-label">Slice View</div>
          <div ref={sliceContainerRef} className="itk-viewer-container" />
        </div>
        <div className="itk-viewer-pane">
          <div className="itk-viewer-pane-label">3D Render</div>
          <div ref={volumeContainerRef} className="itk-viewer-container" />
        </div>
      </div>

      <aside className="sidebar">
        {(error || viewerError) && <div className="error-banner">{error ?? viewerError}</div>}

        <section className="panel">
          <h2 className="panel-title">Volumes (itk-vtk-viewer)</h2>
          <p className="panel-hint">
            Each volume is converted on upload into a chunked, multiscale OME-Zarr pyramid, so this engine can pick a
            resolution level that fits in memory instead of requiring the whole scan to fit in one GPU texture up
            front the way the niivue engine does. No segmentation overlays or custom transfer functions here yet --
            this exists to prove out independent slice / 3D window-level control on vtk.js's pipeline.
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
                  onClick={() => loadZarrUrl(zarrUrl(record.id), record.name)}
                >
                  Load
                </button>
              </li>
            ))}
          </ul>
        </section>

        {loadedName && (
          <section className="panel">
            <h2 className="panel-title">Loaded</h2>
            <p className="panel-hint">{loadedName}</p>
            <p className="panel-hint">
              Each pane above has its own window/level editor (drag the histogram curve) -- they're independent vtk.js
              pipelines, so adjusting one never affects the other.
            </p>
          </section>
        )}
      </aside>
    </div>
  )
}
