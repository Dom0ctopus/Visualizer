import { useRef } from 'react'
import type { LibraryRecord } from '../types'

interface LibraryPanelProps {
  library: LibraryRecord[]
  busy: boolean
  onUploadVolume: (file: File) => void
  onUploadSegmentation: (file: File) => void
  onLoad: (record: LibraryRecord) => void
  onRemove: (record: LibraryRecord) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function LibraryPanel({ library, busy, onUploadVolume, onUploadSegmentation, onLoad, onRemove }: LibraryPanelProps) {
  const volumeInputRef = useRef<HTMLInputElement | null>(null)
  const segInputRef = useRef<HTMLInputElement | null>(null)

  return (
    <section className="panel">
      <h2 className="panel-title">Library (server-backed)</h2>

      <div className="library-upload-row">
        <input
          ref={volumeInputRef}
          type="file"
          accept=".nrrd,.nhdr"
          className="hidden-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUploadVolume(file)
            e.target.value = ''
          }}
        />
        <button className="btn btn-primary btn-small" disabled={busy} onClick={() => volumeInputRef.current?.click()}>
          Upload Volume…
        </button>

        <input
          ref={segInputRef}
          type="file"
          accept=".nrrd,.nhdr"
          multiple
          className="hidden-input"
          onChange={(e) => {
            const files = e.target.files
            if (files) Array.from(files).forEach((f) => onUploadSegmentation(f))
            e.target.value = ''
          }}
        />
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => segInputRef.current?.click()}>
          Upload Segmentation…
        </button>
      </div>

      {library.length === 0 ? (
        <p className="empty-hint">No files on the server yet. Upload a volume to begin.</p>
      ) : (
        <ul className="library-list">
          {library.map((record) => (
            <li key={record.id} className="library-row">
              <span className={`library-kind library-kind-${record.kind}`}>{record.kind === 'volume' ? 'VOL' : 'SEG'}</span>
              <div className="library-main">
                <div className="library-name" title={record.name}>
                  {record.name}
                </div>
                <div className="library-meta">
                  {formatSize(record.sizeBytes)}
                  {record.kind === 'segmentation' &&
                    ` · ${record.systems.reduce((n, s) => n + s.segments.length, 0)} segments`}
                </div>
              </div>
              <button className="icon-btn" disabled={busy} onClick={() => onLoad(record)}>
                Load
              </button>
              <button
                className="icon-btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove "${record.name}" from the server library? This deletes the uploaded file.`)) {
                    onRemove(record)
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
