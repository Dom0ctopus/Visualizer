import { useRef } from 'react'
import type { BaseVolumeInfo } from '../types'

interface RenderPanelProps {
  renderVolume: BaseVolumeInfo
  onWindowLevel: (calMin: number, calMax: number) => void
  onResetWindowLevel: () => void
  transferFunctionActive: boolean
  onLoadTransferFunction: (file: File) => void
  onClearTransferFunction: () => void
}

export function RenderPanel({
  renderVolume,
  onWindowLevel,
  onResetWindowLevel,
  transferFunctionActive,
  onLoadTransferFunction,
  onClearTransferFunction
}: RenderPanelProps) {
  const tfInputRef = useRef<HTMLInputElement | null>(null)
  const sliderStep = Math.max((renderVolume.dataMax - renderVolume.dataMin) / 1000, 0.01)

  return (
    <section className="panel">
      <h2 className="panel-title">3D Render</h2>
      <div className="volume-info">
        <p className="tf-hint">
          Window/level: {renderVolume.calMin.toFixed(1)} &ndash; {renderVolume.calMax.toFixed(1)} (independent of the slice
          views)
        </p>

        <label className="tf-hint" htmlFor="render-window-min-slider">
          Min
        </label>
        <input
          id="render-window-min-slider"
          className="window-slider"
          type="range"
          min={renderVolume.dataMin}
          max={renderVolume.dataMax}
          step={sliderStep}
          value={renderVolume.calMin}
          onChange={(e) => onWindowLevel(Math.min(Number(e.target.value), renderVolume.calMax), renderVolume.calMax)}
        />

        <label className="tf-hint" htmlFor="render-window-max-slider">
          Max
        </label>
        <input
          id="render-window-max-slider"
          className="window-slider"
          type="range"
          min={renderVolume.dataMin}
          max={renderVolume.dataMax}
          step={sliderStep}
          value={renderVolume.calMax}
          onChange={(e) => onWindowLevel(renderVolume.calMin, Math.max(Number(e.target.value), renderVolume.calMin))}
        />

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
        {transferFunctionActive && (
          <p className="tf-hint">
            Custom opacity curve applied to the 3D render only. Background still showing? Raise the Min slider above it --
            the curve re-applies live.
          </p>
        )}
      </div>
    </section>
  )
}
