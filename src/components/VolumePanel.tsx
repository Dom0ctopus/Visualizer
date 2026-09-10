import { useRef } from 'react'
import type { BaseVolumeInfo } from '../types'

interface VolumePanelProps {
  baseVolume: BaseVolumeInfo
  onWindowLevelChange: (calMin: number, calMax: number) => void
  onResetWindowLevel: () => void
  transferFunctionActive: boolean
  onLoadTransferFunction: (file: File) => void
  onClearTransferFunction: () => void
}

export function VolumePanel({
  baseVolume,
  onWindowLevelChange,
  onResetWindowLevel,
  transferFunctionActive,
  onLoadTransferFunction,
  onClearTransferFunction
}: VolumePanelProps) {
  const range = Math.max(1e-6, baseVolume.dataMax - baseVolume.dataMin)
  const step = range / 500
  const tfInputRef = useRef<HTMLInputElement | null>(null)

  return (
    <section className="panel">
      <h2 className="panel-title">Volume</h2>
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

        <div className="tf-row">
          <input
            ref={tfInputRef}
            type="file"
            accept=".tf"
            className="hidden-input"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onLoadTransferFunction(file)
              e.target.value = ''
            }}
          />
          <button className="btn btn-secondary btn-small" onClick={() => tfInputRef.current?.click()}>
            Load Transfer Function (.tf)…
          </button>
          {transferFunctionActive && (
            <button className="btn btn-secondary btn-small" onClick={onClearTransferFunction}>
              Clear
            </button>
          )}
        </div>
        {transferFunctionActive && <p className="tf-hint">Custom opacity curve applied to the 3D render.</p>}
      </div>
    </section>
  )
}
