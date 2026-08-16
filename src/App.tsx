import { useNiivue } from './hooks/useNiivue'
import { Viewer } from './components/Viewer'
import { VolumePanel } from './components/VolumePanel'
import { SegmentationPanel } from './components/SegmentationPanel'
import { CrosshairPanel } from './components/CrosshairPanel'

function App() {
  const {
    canvasRef,
    busy,
    error,
    baseVolume,
    segmentations,
    crosshair,
    loadBaseVolume,
    addSegmentation,
    setSegmentationOpacity,
    toggleSegmentationVisibility,
    removeSegmentation,
    setWindowLevel,
    resetWindowLevel,
    resetView,
    clearAll
  } = useNiivue()

  return (
    <div className="app">
      <header className="app-header">
        <h1>Micro-CT Visualizer</h1>
        <div className="app-header-actions">
          <button className="btn btn-secondary btn-small" onClick={resetView} disabled={!baseVolume}>
            Reset View
          </button>
          <button className="btn btn-secondary btn-small" onClick={clearAll} disabled={!baseVolume}>
            Clear All
          </button>
        </div>
      </header>

      <div className="app-body">
        <Viewer canvasRef={canvasRef} />

        <aside className="sidebar">
          {error && <div className="error-banner">{error}</div>}

          <VolumePanel
            baseVolume={baseVolume}
            busy={busy}
            onLoadVolume={loadBaseVolume}
            onWindowLevelChange={setWindowLevel}
            onResetWindowLevel={resetWindowLevel}
          />

          <SegmentationPanel
            segmentations={segmentations}
            disabled={!baseVolume}
            busy={busy}
            onAddSegmentation={addSegmentation}
            onOpacityChange={setSegmentationOpacity}
            onToggleVisibility={toggleSegmentationVisibility}
            onRemove={removeSegmentation}
          />

          <CrosshairPanel crosshair={crosshair} />

          {!baseVolume && (
            <section className="panel panel-hint">
              <p>Load a volume NRRD file to begin. The viewer shows axial, coronal, sagittal, and 3D render panes.</p>
              <p>Then add one or more segmentation NRRD files as color-coded overlays.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}

export default App
