import { useRef } from 'react'
import type { BaseVolumeInfo } from '../types'

interface VolumePanelProps {
  baseVolume: BaseVolumeInfo | null
  busy: boolean
  onLoadVolume: (file: File) => void
  onWindowLevelChange: (calMin: number, calMax: number) => void
  onResetWindowLevel: () => void
}

export function VolumePanel({ baseVolume, busy, onLoadVolume, onWindowLevelChange, onResetWindowLevel }: VolumePanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onLoadVolume(file)
    e.target.value = ''
  }

  const range = baseVolume ? Math.max(1e-6, baseVolume.dataMax - baseVolume.dataMin) : 1
  const step = range / 500

  return (
    <section className="panel">
      <h2 className="panel-title">Volume</h2>
      <input
        ref={inputRef}
        type="file"
        accept=".nrrd,.nhdr,.nii,.nii.gz"
        className="hidden-input"
        onChange={handleFileChange}
      />
      <button className="btn btn-primary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {baseVolume ? 'Replace Volume…' : 'Load Volume (.nrrd)…'}
      </button>

      {baseVolume && (
        <div className="volume-info">
          <div className="volume-name" title={baseVolume.name}>
            {baseVolume.name}
          </div>

          <label className="field">
            <span>
              Window min <b>{baseVolume.calMin.toFixed(1)}</b>
            </span>
            <input
              type="range"
              min={baseVolume.dataMin}
              max={baseVolume.dataMax}
              step={step}
              value={baseVolume.calMin}
              onChange={(e) => onWindowLevelChange(Number(e.target.value), baseVolume.calMax)}
            />
          </label>

          <label className="field">
            <span>
              Window max <b>{baseVolume.calMax.toFixed(1)}</b>
            </span>
            <input
              type="range"
              min={baseVolume.dataMin}
              max={baseVolume.dataMax}
              step={step}
              value={baseVolume.calMax}
              onChange={(e) => onWindowLevelChange(baseVolume.calMin, Number(e.target.value))}
            />
          </label>

          <button className="btn btn-secondary btn-small" onClick={onResetWindowLevel}>
            Reset Window/Level
          </button>
        </div>
      )}
    </section>
  )
}
