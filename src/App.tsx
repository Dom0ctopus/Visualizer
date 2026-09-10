import { useState } from 'react'
import { useNiivue } from './hooks/useNiivue'
import { Viewer } from './components/Viewer'
import { LibraryPanel } from './components/LibraryPanel'
import { VolumePanel } from './components/VolumePanel'
import { SearchBar } from './components/SearchBar'
import { SegmentTree } from './components/SegmentTree'
import { CrosshairPanel } from './components/CrosshairPanel'

function App() {
  const [searchText, setSearchText] = useState('')

  const {
    canvasRef,
    busy,
    error,
    baseVolume,
    segmentations,
    crosshair,
    crosshairVisible,
    setCrosshairVisible,
    library,
    uploadAndLoadVolume,
    uploadAndLoadSegmentation,
    loadFromLibrary,
    setSegmentVisible,
    setSegmentOpacity,
    setSystemVisible,
    setSystemOpacity,
    setFileVisible,
    setFileOpacity,
    removeSegmentation,
    setWindowLevel,
    resetWindowLevel,
    transferFunctionActive,
    loadTransferFunction,
    clearTransferFunction,
    resetView,
    clearAll
  } = useNiivue()

  return (
    <div className="app">
      <header className="app-header">
        <h1>Micro-CT Visualizer</h1>
        <div className="app-header-actions">
          <label className="crosshair-toggle">
            <input
              type="checkbox"
              checked={crosshairVisible}
              onChange={(e) => setCrosshairVisible(e.target.checked)}
              disabled={!baseVolume}
            />
            Crosshair
          </label>
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

          <LibraryPanel
            library={library}
            busy={busy}
            onUploadVolume={uploadAndLoadVolume}
            onUploadSegmentation={uploadAndLoadSegmentation}
            onLoad={loadFromLibrary}
          />

          {baseVolume && (
            <VolumePanel
              baseVolume={baseVolume}
              onWindowLevelChange={setWindowLevel}
              onResetWindowLevel={resetWindowLevel}
              transferFunctionActive={transferFunctionActive}
              onLoadTransferFunction={loadTransferFunction}
              onClearTransferFunction={clearTransferFunction}
            />
          )}

          <section className="panel">
            <h2 className="panel-title">Segmentations</h2>
            <SearchBar
              value={searchText}
              onChange={setSearchText}
              segmentations={segmentations}
              onSegmentVisible={setSegmentVisible}
            />
            <SegmentTree
              segmentations={segmentations}
              filterText={searchText}
              onSegmentVisible={setSegmentVisible}
              onSegmentOpacity={setSegmentOpacity}
              onSystemVisible={setSystemVisible}
              onSystemOpacity={setSystemOpacity}
              onFileVisible={setFileVisible}
              onFileOpacity={setFileOpacity}
              onRemoveFile={removeSegmentation}
            />
          </section>

          <CrosshairPanel crosshair={crosshair} />

          {!baseVolume && (
            <section className="panel panel-hint">
              <p>Upload a volume NRRD file to begin. The viewer shows axial, coronal, sagittal, and 3D render panes.</p>
              <p>
                Then upload one or more Slicer-exported segmentation NRRD files &mdash; each labeled segment appears in the
                tree below, grouped by system, with its own visibility and opacity.
              </p>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}

export default App
