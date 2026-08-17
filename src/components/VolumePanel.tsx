import type { BaseVolumeInfo } from '../types'

interface VolumePanelProps {
  baseVolume: BaseVolumeInfo
  onWindowLevelChange: (calMin: number, calMax: number) => void
  onResetWindowLevel: () => void
}

export function VolumePanel({ baseVolume, onWindowLevelChange, onResetWindowLevel }: VolumePanelProps) {
  const range = Math.max(1e-6, baseVolume.dataMax - baseVolume.dataMin)
  const step = range / 500

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
      </div>
    </section>
  )
}
