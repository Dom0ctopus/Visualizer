import { useRef } from 'react'
import type { BaseVolumeInfo } from '../types'

interface VolumePanelProps {
  baseVolume: BaseVolumeInfo
  onWindowLevel: (calMin: number, calMax: number) => void
  onResetWindowLevel: () => void
  transferFunctionActive: boolean
  onLoadTransferFunction: (file: File) => void
  onClearTransferFunction: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onResetZoom: () => void
}

export function VolumePanel({
  baseVolume,
  onWindowLevel,
  onResetWindowLevel,
  transferFunctionActive,
  onLoadTransferFunction,
  onClearTransferFunction,
  onZoomIn,
  onZoomOut,
  onResetZoom
}: VolumePanelProps) {
  const tfInputRef = useRef<HTMLInputElement | null>(null)
  const sliderStep = Math.max((baseVolume.dataMax - baseVolume.dataMin) / 1000, 0.01)

  return (
    <section className="panel">
      <h2 className="panel-title">Volume</h2>
      <div className="volume-info">
        <div className="volume-name" title={baseVolume.name}>
          {baseVolume.name}
        </div>

        <p className="tf-hint">
          Window/level: {baseVolume.calMin.toFixed(1)} &ndash; {baseVolume.calMax.toFixed(1)}
        </p>

        <label className="tf-hint" htmlFor="window-min-slider">
          Min
        </label>
        <input
          id="window-min-slider"
          className="window-slider"
          type="range"
          min={baseVolume.dataMin}
          max={baseVolume.dataMax}
          step={sliderStep}
          value={baseVolume.calMin}
          onChange={(e) => onWindowLevel(Math.min(Number(e.target.value), baseVolume.calMax), baseVolume.calMax)}
        />

        <label className="tf-hint" htmlFor="window-max-slider">
          Max
        </label>
        <input
          id="window-max-slider"
          className="window-slider"
          type="range"
          min={baseVolume.dataMin}
          max={baseVolume.dataMax}
          step={sliderStep}
          value={baseVolume.calMax}
          onChange={(e) => onWindowLevel(baseVolume.calMin, Math.max(Number(e.target.value), baseVolume.calMin))}
        />

        <button className="btn btn-secondary btn-small" onClick={onResetWindowLevel}>
          Reset Window/Level
        </button>

        <p className="tf-hint">Slice zoom</p>
        <div className="tf-row">
          <button className="btn btn-secondary btn-small" onClick={onZoomOut} title="Zoom out">
            &minus;
          </button>
          <button className="btn btn-secondary btn-small" onClick={onZoomIn} title="Zoom in">
            +
          </button>
          <button className="btn btn-secondary btn-small" onClick={onResetZoom}>
            Reset Zoom
          </button>
        </div>

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
            Custom opacity curve applied to the 3D render. Background still showing? Raise the Min slider above it --
            the curve re-applies live.
          </p>
        )}
      </div>
    </section>
  )
}
