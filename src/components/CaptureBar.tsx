import { useEffect, useRef, useState } from 'react'
import { captureFilename, downloadBlob, recordingSupported, startCanvasRecording, type CanvasRecording } from '../lib/capture'

export interface CaptureTarget {
  /** The WebGL canvas to record. */
  canvas: () => HTMLCanvasElement | null
  /** A PNG of the current view. */
  snapshot: () => Promise<Blob | null>
  /** Turns continuous auto-rotation on or off. */
  setTurntable: (on: boolean) => void
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Snapshot / record / turntable controls for a 3D view. Files download
 * straight away, named after the view and the time.
 */
export function CaptureBar({ target, name }: { target: CaptureTarget | null; name: string }) {
  const [recording, setRecording] = useState<{ rec: CanvasRecording; since: number } | null>(null)
  const [turntable, setTurntable] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recordingRef = useRef(recording)
  recordingRef.current = recording

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [recording])

  // Leaving the view (or unmounting) ends a recording and the turntable.
  useEffect(
    () => () => {
      void recordingRef.current?.rec.stop()
    },
    []
  )
  // Only touches the view once the turntable has been used.
  const turntableUsed = useRef(false)
  useEffect(() => {
    if (!target || (!turntable && !turntableUsed.current)) return
    turntableUsed.current = true
    try {
      target.setTurntable(turntable)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Turntable unavailable')
    }
  }, [target, turntable])

  const snapshot = async () => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const blob = await target.snapshot()
      if (blob) downloadBlob(blob, captureFilename(name, 'png'))
      else setError('Nothing to capture yet')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snapshot failed')
    } finally {
      setBusy(false)
    }
  }

  const toggleRecording = async () => {
    setError(null)
    if (recording) {
      setRecording(null)
      const blob = await recording.rec.stop()
      downloadBlob(blob, captureFilename(name, recording.rec.extension))
      return
    }
    const canvas = target?.canvas()
    if (!canvas) {
      setError('Nothing to record yet')
      return
    }
    try {
      setRecording({ rec: startCanvasRecording(canvas), since: Date.now() })
      setNow(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording failed')
    }
  }

  return (
    <div className="capture-bar" role="toolbar" aria-label="Capture">
      <button className="capture-button" disabled={!target || busy} onClick={() => void snapshot()} title="Save a PNG of the current view">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7 4.5 8.2 3h3.6L13 4.5h2.5A1.5 1.5 0 0 1 17 6v8.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V6a1.5 1.5 0 0 1 1.5-1.5Z" />
          <circle cx="10" cy="10.2" r="3" />
        </svg>
        Snapshot
      </button>
      {recordingSupported() && (
        <button
          className={recording ? 'capture-button capture-recording' : 'capture-button'}
          disabled={!target}
          onClick={() => void toggleRecording()}
          title={recording ? 'Stop and save the recording' : 'Record the view as a video (rotate, zoom or use Turntable while recording)'}
        >
          <span className="capture-dot" aria-hidden="true" />
          {recording ? `Stop · ${formatDuration(now - recording.since)}` : 'Record'}
        </button>
      )}
      <button
        className={turntable ? 'capture-button active' : 'capture-button'}
        disabled={!target}
        aria-pressed={turntable}
        onClick={() => setTurntable((t) => !t)}
        title="Rotate the view continuously, e.g. for a turntable recording"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M16 10a6 6 0 1 1-2-4.47" />
          <path d="M14.5 2.8 14 5.6l2.8.4" />
        </svg>
        Turntable
      </button>
      {error && <span className="capture-error">{error}</span>}
    </div>
  )
}
