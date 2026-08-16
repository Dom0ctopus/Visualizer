import { useRef } from 'react'
import type { SegmentationLayer } from '../types'

interface SegmentationPanelProps {
  segmentations: SegmentationLayer[]
  disabled: boolean
  busy: boolean
  onAddSegmentation: (file: File) => void
  onOpacityChange: (id: string, opacity: number) => void
  onToggleVisibility: (id: string) => void
  onRemove: (id: string) => void
}

export function SegmentationPanel({
  segmentations,
  disabled,
  busy,
  onAddSegmentation,
  onOpacityChange,
  onToggleVisibility,
  onRemove
}: SegmentationPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files) {
      Array.from(files).forEach((f) => onAddSegmentation(f))
    }
    e.target.value = ''
  }

  return (
    <section className="panel">
      <h2 className="panel-title">Segmentations</h2>
      <input
        ref={inputRef}
        type="file"
        accept=".nrrd,.nhdr"
        multiple
        className="hidden-input"
        onChange={handleFileChange}
      />
      <button
        className="btn btn-primary"
        disabled={disabled || busy}
        title={disabled ? 'Load a volume first' : undefined}
        onClick={() => inputRef.current?.click()}
      >
        Add Segmentation (.nrrd)…
      </button>

      {segmentations.length === 0 ? (
        <p className="empty-hint">No segmentations loaded.</p>
      ) : (
        <ul className="layer-list">
          {segmentations.map((seg) => (
            <li key={seg.id} className="layer-row">
              <span className="color-swatch" style={{ background: seg.color }} />
              <div className="layer-main">
                <div className="layer-name" title={seg.name}>
                  {seg.name}
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={seg.opacity}
                  onChange={(e) => onOpacityChange(seg.id, Number(e.target.value))}
                />
              </div>
              <button
                className="icon-btn"
                title={seg.visible ? 'Hide layer' : 'Show layer'}
                onClick={() => onToggleVisibility(seg.id)}
              >
                {seg.visible ? 'Hide' : 'Show'}
              </button>
              <button className="icon-btn" title="Remove layer" onClick={() => onRemove(seg.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
