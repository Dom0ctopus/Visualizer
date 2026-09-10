import { useRef } from 'react'
import type { BaseVolumeInfo } from '../types'

interface VolumePanelProps {
  baseVolume: BaseVolumeInfo
  onResetWindowLevel: () => void
  transferFunctionActive: boolean
  onLoadTransferFunction: (file: File) => void
  onClearTransferFunction: () => void
}

export function VolumePanel({
  baseVolume,
  onResetWindowLevel,
  transferFunctionActive,
  onLoadTransferFunction,
  onClearTransferFunction
}: VolumePanelProps) {
  const tfInputRef = useRef<HTMLInputElement | null>(null)

  return (
    <section className="panel">
      <h2 className="panel-title">Volume</h2>
      <div className="volume-info">
        <div className="volume-name" title={baseVolume.name}>
          {baseVolume.name}
        </div>

        <p className="tf-hint">
          Window/level: {baseVolume.calMin.toFixed(1)} &ndash; {baseVolume.calMax.toFixed(1)} (click-drag on the image to adjust)
        </p>

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
