import { useEffect, useRef, useState } from 'react'
import { fetchLibrary, zarrUrl } from '../lib/api'
import { useItkVtkViewer } from '../hooks/useItkVtkViewer'
import { useSegmentationMerge3D } from '../hooks/useSegmentationMerge3D'
import { useSegmentationOverlays } from '../hooks/useSegmentationOverlays'
import { useZarrSegmentations } from '../hooks/useZarrSegmentations'
import { useZarrSliceViewer } from '../hooks/useZarrSliceViewer'
import { SearchBar } from './SearchBar'
import { SegmentTree } from './SegmentTree'
import { ZarrSliceCanvas, type CanvasPan } from './ZarrSliceCanvas'
import type { LibraryRecord, SegmentationRecord, VolumeRecord } from '../types'

const POLL_INTERVAL_MS = 1500
const ZOOM_BUTTON_FACTOR = 1.25

function statusLabel(record: VolumeRecord | SegmentationRecord): string {
  switch (record.zarrStatus) {
    case 'ready':
      return 'ready'
    case 'failed':
      return 'conversion failed'
    case 'pending':
      return 'converting…'
    default:
      return 'not converted'
  }
}

interface HoveredSegment {
  name: string
  clientX: number
  clientY: number
}

const DEFAULT_PAN: CanvasPan = { x: 0, y: 0 }

/**
 * A second, parallel viewer built on itk-vtk-viewer/vtk.js for the 3D
 * render, plus a custom canvas-based reader for the slice views -- see the
 * conversation history for why the slice side isn't itk-vtk-viewer too:
 * its use2D/ZPlane mode hits a hard internal voxel-count cap on scans this
 * large and corrupts the display when the slice position changes, with no
 * public API workaround found. useZarrSliceViewer reads 2D slices directly
 * out of the same OME-Zarr store instead, sidestepping that mode entirely
 * -- at the cost of building the window/level and scroll-to-slice UI
 * ourselves. It starts at pyramid level 1 (2x downsampled in each axis),
 * not the true finest level: native-resolution per-slice reads had a real
 * per-step latency floor that persisted even after ruling out every
 * specific cause found (chunk layout, cache growth, cloud-sync storage,
 * Node's I/O thread pool size). Every pyramid level is pickable from the
 * "Resolution" panel below for fast fly-through browsing, and
 * "Inspect here" (on the Axial pane specifically -- see
 * useZarrSliceViewer.ts's own comment on why the other two planes don't
 * have an equivalent) drills into native resolution for a bounded
 * neighborhood around wherever the user actually wants detail. The 3D
 * Volume pane is unaffected either way, since it already auto-selects
 * whichever level fits its own voxel budget.
 *
 * The left column shows all three orthogonal planes (axial, coronal,
 * sagittal) at once, each independently scrollable/zoomable/pannable, next
 * to the 3D render on the right -- see useZarrSliceViewer.ts and
 * useSegmentationOverlays.ts for how a slice/overlay along any of the three
 * axes is read directly out of the zarr store.
 *
 * Segmentation overlays: each 2D pane composites every loaded segmentation's
 * own layers directly (useSegmentationOverlays.ts), with each segment's
 * exact 3D-Slicer-defined color and opacity -- full parity with the niivue
 * engine there. Hovering any of the three panes looks up the segment name
 * at the cursor from that same per-pixel overlay data (ZarrSliceCanvas's
 * onHoverLabel) and shows it both in a tooltip near the cursor and in a
 * status bar above the panes -- the 3D pane has no equivalent, since it's a
 * separate WebGL viewer library without per-pixel picking exposed here.
 * The 3D pane instead drives itk-vtk-viewer's own built-in labelImage
 * overlay, which only ever holds one label image at a time and colors it by
 * a fixed categorical palette rather than arbitrary per-label RGB (see
 * useItkVtkViewer.ts's loadLabelImageUrl comment) -- so every loaded
 * segmentation/layer is combined server-side into one merged label image
 * first (useSegmentationMerge3D.ts, segmentationMergeConvert.ts) rather than
 * showing only the first one, though still in itk-vtk-viewer's own colors
 * rather than the slice panes' / 3D-Slicer's.
 *
 * Volumes/segmentations are only loadable here once the server's background
 * NRRD -> OME-Zarr conversion (kicked off on upload, see
 * server/src/zarrConvert.ts and segmentationZarrConvert.ts) finishes -- this
 * polls the library while any record is still converting.
 */
interface ItkVtkViewerPageProps {
  /** Mirrors App.tsx's niivue `.app-body`'s own `hidden` attribute, applied
   *  directly to this component's root element instead of an extra wrapper
   *  div around it (App.tsx used to render one) -- that wrapper had no
   *  className/flex properties of its own, so as a plain block-level child
   *  of `.app`'s flex column it never grew to fill available height, which
   *  left this component's own `.app-body` sized to its full content
   *  height (everything in the sidebar, uncapped) instead of being
   *  constrained to the viewport -- the actual cause of the sidebar's
   *  segment list running off the bottom with no way to scroll to it. */
  hidden?: boolean
}

export function ItkVtkViewerPage({ hidden }: ItkVtkViewerPageProps) {
  const [library, setLibrary] = useState<LibraryRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [activeZarrUrl, setActiveZarrUrl] = useState<string | null>(null)
  const [activeVolumeId, setActiveVolumeId] = useState<string | null>(null)
  const [axialZoom, setAxialZoom] = useState(1)
  const [axialPan, setAxialPan] = useState<CanvasPan>(DEFAULT_PAN)
  const [coronalZoom, setCoronalZoom] = useState(1)
  const [coronalPan, setCoronalPan] = useState<CanvasPan>(DEFAULT_PAN)
  const [sagittalZoom, setSagittalZoom] = useState(1)
  const [sagittalPan, setSagittalPan] = useState<CanvasPan>(DEFAULT_PAN)
  const [hoveredSegment, setHoveredSegment] = useState<HoveredSegment | null>(null)
  const pollTimerRef = useRef<number | null>(null)

  const {
    volumeContainerRef,
    scriptReady,
    busy,
    error: viewerError,
    loadedName,
    loadZarrUrl,
    loadLabelImageUrl,
    setLabelWeights,
    setLabelNames
  } = useItkVtkViewer()
  const {
    levels,
    levelIndex,
    volumeInfo,
    detailWindow,
    zIndex,
    setZIndex,
    stepZIndex,
    yIndex,
    setYIndex,
    stepYIndex,
    xIndex,
    setXIndex,
    stepXIndex,
    setLevel,
    inspectNativeHere,
    exitDetailWindow,
    axialSlice,
    coronalSlice,
    sagittalSlice,
    windowMin,
    windowMax,
    setWindowMin,
    setWindowMax,
    dataRange,
    error: sliceError
  } = useZarrSliceViewer(activeZarrUrl)

  const zarrSeg = useZarrSegmentations()
  const { overlays, error: overlayError } = useSegmentationOverlays(
    zarrSeg.segmentations,
    { z: zIndex, y: yIndex, x: xIndex },
    volumeInfo,
    levelIndex
  )
  const { status: mergeStatus, error: mergeError } = useSegmentationMerge3D(
    activeVolumeId,
    zarrSeg.segmentations,
    loadLabelImageUrl,
    setLabelWeights,
    setLabelNames
  )

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const records = await fetchLibrary()
        if (cancelled) return
        setLibrary(records)
        const anyPending = records.some((r) => 'zarrStatus' in r && r.zarrStatus === 'pending')
        pollTimerRef.current = window.setTimeout(poll, anyPending ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 4)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to reach the backend server.')
      }
    }
    poll()

    return () => {
      cancelled = true
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    }
  }, [])

  const volumes = library.filter((r): r is VolumeRecord => r.kind === 'volume')
  const segmentationRecords = library.filter((r): r is SegmentationRecord => r.kind === 'segmentation')

  const handleLoad = (record: VolumeRecord) => {
    const url = zarrUrl(record.id)
    setActiveZarrUrl(url)
    setActiveVolumeId(record.id)
    setAxialZoom(1)
    setAxialPan(DEFAULT_PAN)
    setCoronalZoom(1)
    setCoronalPan(DEFAULT_PAN)
    setSagittalZoom(1)
    setSagittalPan(DEFAULT_PAN)
    loadZarrUrl(url, record.name)
  }

  const resetSliceView = () => {
    setAxialZoom(1)
    setAxialPan(DEFAULT_PAN)
    setCoronalZoom(1)
    setCoronalPan(DEFAULT_PAN)
    setSagittalZoom(1)
    setSagittalPan(DEFAULT_PAN)
  }

  const handleLoadSegmentation = (record: SegmentationRecord) => {
    zarrSeg.loadSegmentationRecord(record)
  }

  const sliderStep = Math.max((dataRange[1] - dataRange[0]) / 1000, 0.01)
  const combinedError = error ?? viewerError ?? sliceError ?? overlayError ?? mergeError

  return (
    <div className="app-body" hidden={hidden}>
      <div className="viewer itk-viewer-split">
        <div className="itk-viewer-hover-bar">
          {hoveredSegment ? (
            <>
              <span className="itk-viewer-hover-bar-label">Segment:</span> {hoveredSegment.name}
            </>
          ) : (
            'Hover a segment in any 2D pane to see its name'
          )}
        </div>
        <div className="itk-viewer-columns">
          <div className="itk-viewer-left-column">
            <div className="itk-viewer-pane">
              <div className="itk-viewer-pane-label">Axial</div>
              <div className="itk-viewer-container">
                <ZarrSliceCanvas
                  slice={axialSlice}
                  windowMin={windowMin}
                  windowMax={windowMax}
                  onWheelStep={stepZIndex}
                  overlays={overlays.axial}
                  zoom={axialZoom}
                  pan={axialPan}
                  onZoomChange={setAxialZoom}
                  onPanChange={setAxialPan}
                  onHoverLabel={setHoveredSegment}
                />
              </div>
              {volumeInfo && (
                <div className="zarr-slice-controls">
                  <span className="tf-hint">
                    Z: {zIndex} / {detailWindow ? detailWindow.zMax : volumeInfo.size[0] - 1}
                    {detailWindow ? ` (native, ${detailWindow.zMin}-${detailWindow.zMax})` : ''}
                  </span>
                  <input
                    type="range"
                    className="window-slider"
                    min={detailWindow ? detailWindow.zMin : 0}
                    max={detailWindow ? detailWindow.zMax : volumeInfo.size[0] - 1}
                    step={1}
                    value={zIndex}
                    onChange={(e) => setZIndex(Number(e.target.value))}
                  />
                  {detailWindow ? (
                    <button className="btn btn-secondary btn-small" onClick={exitDetailWindow}>
                      Back to overview
                    </button>
                  ) : (
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => inspectNativeHere()}
                      title="Load native resolution for the 50 slices on each side of this one"
                    >
                      Inspect here
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="itk-viewer-pane">
              <div className="itk-viewer-pane-label">Coronal</div>
              <div className="itk-viewer-container">
                <ZarrSliceCanvas
                  slice={coronalSlice}
                  windowMin={windowMin}
                  windowMax={windowMax}
                  onWheelStep={stepYIndex}
                  overlays={overlays.coronal}
                  zoom={coronalZoom}
                  pan={coronalPan}
                  onZoomChange={setCoronalZoom}
                  onPanChange={setCoronalPan}
                  onHoverLabel={setHoveredSegment}
                />
              </div>
              {volumeInfo && (
                <div className="zarr-slice-controls">
                  <span className="tf-hint">
                    Y: {yIndex} / {volumeInfo.size[1] - 1}
                  </span>
                  <input
                    type="range"
                    className="window-slider"
                    min={0}
                    max={volumeInfo.size[1] - 1}
                    step={1}
                    value={yIndex}
                    onChange={(e) => setYIndex(Number(e.target.value))}
                  />
                </div>
              )}
            </div>

            <div className="itk-viewer-pane">
              <div className="itk-viewer-pane-label">Sagittal</div>
              <div className="itk-viewer-container">
                <ZarrSliceCanvas
                  slice={sagittalSlice}
                  windowMin={windowMin}
                  windowMax={windowMax}
                  onWheelStep={stepXIndex}
                  overlays={overlays.sagittal}
                  zoom={sagittalZoom}
                  pan={sagittalPan}
                  onZoomChange={setSagittalZoom}
                  onPanChange={setSagittalPan}
                  onHoverLabel={setHoveredSegment}
                />
              </div>
              {volumeInfo && (
                <div className="zarr-slice-controls">
                  <span className="tf-hint">
                    X: {xIndex} / {volumeInfo.size[2] - 1}
                  </span>
                  <input
                    type="range"
                    className="window-slider"
                    min={0}
                    max={volumeInfo.size[2] - 1}
                    step={1}
                    value={xIndex}
                    onChange={(e) => setXIndex(Number(e.target.value))}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="itk-viewer-pane itk-viewer-pane-3d">
            <div className="itk-viewer-pane-label">3D Render</div>
            <div ref={volumeContainerRef} className="itk-viewer-container" />
          </div>
        </div>
      </div>

      {hoveredSegment && (
        <div
          className="itk-viewer-hover-tooltip"
          style={{ left: hoveredSegment.clientX + 14, top: hoveredSegment.clientY + 14 }}
        >
          {hoveredSegment.name}
        </div>
      )}

      <aside className="sidebar">
        {combinedError && <div className="error-banner">{combinedError}</div>}

        <section className="panel">
          <h2 className="panel-title">Volumes (itk-vtk-viewer)</h2>
          <p className="panel-hint">
            Each volume is converted on upload into a chunked, multiscale OME-Zarr pyramid. The 3D render picks a
            resolution level that fits in memory instead of requiring the whole scan to fit in one GPU texture up
            front the way the niivue engine does; the slice panes read 2D slices from the same store's 2x-downsampled
            level, traded for scrolling that keeps up regardless of the source scan's native resolution.
          </p>
          {volumes.length === 0 && (
            <p className="empty-hint">Upload a volume from the main viewer's library panel -- it'll show up here once converted.</p>
          )}
          <ul className="library-list">
            {volumes.map((record) => (
              <li key={record.id} className="library-row">
                <span className="library-kind library-kind-volume">VOL</span>
                <div className="library-main">
                  <div className="library-name" title={record.name}>
                    {record.name}
                  </div>
                  <div className="library-meta" title={record.zarrError}>
                    {statusLabel(record)}
                    {record.zarrStatus === 'failed' && record.zarrError ? `: ${record.zarrError}` : ''}
                  </div>
                </div>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={!scriptReady || busy || record.zarrStatus !== 'ready'}
                  onClick={() => handleLoad(record)}
                >
                  Load
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2 className="panel-title">Segmentations (itk-vtk-viewer)</h2>
          <p className="panel-hint">
            Every 2D pane composites every loaded segmentation with its own exact colors and opacities. The 3D render
            shows a cumulative view of every loaded segmentation and layer combined, rebuilt on the server whenever
            the set of loaded segmentations changes -- colored with itk-vtk-viewer's own built-in palette instead of
            each segment's defined color, a limitation of its label-image API, not a missing feature here.
          </p>
          {mergeStatus === 'pending' && <p className="tf-hint">Building combined 3D view…</p>}
          {segmentationRecords.length === 0 && (
            <p className="empty-hint">Upload a segmentation from the main viewer's library panel -- it'll show up here once converted.</p>
          )}
          <ul className="library-list">
            {segmentationRecords.map((record) => {
              const alreadyLoaded = zarrSeg.segmentations.some((s) => s.recordId === record.id)
              return (
                <li key={record.id} className="library-row">
                  <span className="library-kind library-kind-segmentation">SEG</span>
                  <div className="library-main">
                    <div className="library-name" title={record.name}>
                      {record.name}
                    </div>
                    <div className="library-meta" title={record.zarrError}>
                      {statusLabel(record)}
                      {record.zarrStatus === 'failed' && record.zarrError ? `: ${record.zarrError}` : ''}
                    </div>
                  </div>
                  <button
                    className="btn btn-secondary btn-small"
                    disabled={record.zarrStatus !== 'ready' || alreadyLoaded}
                    onClick={() => handleLoadSegmentation(record)}
                  >
                    {alreadyLoaded ? 'Loaded' : 'Load'}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        {zarrSeg.segmentations.length > 0 && (
          <section className="panel">
            <h2 className="panel-title">Segments</h2>
            <SearchBar
              value={searchText}
              onChange={setSearchText}
              segmentations={zarrSeg.segmentations}
              onSegmentVisible={zarrSeg.setSegmentVisible}
            />
            <SegmentTree
              segmentations={zarrSeg.segmentations}
              filterText={searchText}
              onSegmentVisible={zarrSeg.setSegmentVisible}
              onSegmentOpacity={zarrSeg.setSegmentOpacity}
              onSystemVisible={zarrSeg.setSystemVisible}
              onSystemOpacity={zarrSeg.setSystemOpacity}
              onFileVisible={zarrSeg.setFileVisible}
              onFileOpacity={zarrSeg.setFileOpacity}
              onRemoveFile={zarrSeg.removeSegmentation}
            />
          </section>
        )}

        {levels && levels.length > 1 && (
          <section className="panel">
            <h2 className="panel-title">Resolution</h2>
            <p className="panel-hint">
              Fly through at a coarser level for speed, then "Inspect here" (on the Axial pane) to drill into native
              resolution around wherever you land.
            </p>
            <div className="tf-row resolution-levels">
              {levels.map((level) => (
                <button
                  key={level.index}
                  className={level.index === levelIndex ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'}
                  onClick={() => setLevel(level.index)}
                  title={`${level.size[2]}x${level.size[1]}x${level.size[0]}`}
                >
                  {level.index === 0 ? 'Native' : `${level.downsampleFactor}x`}
                </button>
              ))}
            </div>
          </section>
        )}

        {volumeInfo && (
          <section className="panel">
            <h2 className="panel-title">Slice Window/Level</h2>
            <p className="tf-hint">
              {windowMin.toFixed(1)} &ndash; {windowMax.toFixed(1)}
            </p>
            <label className="tf-hint" htmlFor="zarr-slice-min-slider">
              Min
            </label>
            <input
              id="zarr-slice-min-slider"
              className="window-slider"
              type="range"
              min={dataRange[0]}
              max={dataRange[1]}
              step={sliderStep}
              value={windowMin}
              onChange={(e) => setWindowMin(Math.min(Number(e.target.value), windowMax))}
            />
            <label className="tf-hint" htmlFor="zarr-slice-max-slider">
              Max
            </label>
            <input
              id="zarr-slice-max-slider"
              className="window-slider"
              type="range"
              min={dataRange[0]}
              max={dataRange[1]}
              step={sliderStep}
              value={windowMax}
              onChange={(e) => setWindowMax(Math.max(Number(e.target.value), windowMin))}
            />
            <p className="tf-hint">Applies to all three 2D panes. Scroll any pane to page through its own axis.</p>

            <p className="tf-hint">Slice zoom &amp; pan</p>
            <div className="tf-row">
              <button
                className="btn btn-secondary btn-small"
                onClick={() => {
                  setAxialZoom((z) => Math.max(0.1, z / ZOOM_BUTTON_FACTOR))
                  setCoronalZoom((z) => Math.max(0.1, z / ZOOM_BUTTON_FACTOR))
                  setSagittalZoom((z) => Math.max(0.1, z / ZOOM_BUTTON_FACTOR))
                }}
                title="Zoom out (all panes)"
              >
                &minus;
              </button>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => {
                  setAxialZoom((z) => Math.min(20, z * ZOOM_BUTTON_FACTOR))
                  setCoronalZoom((z) => Math.min(20, z * ZOOM_BUTTON_FACTOR))
                  setSagittalZoom((z) => Math.min(20, z * ZOOM_BUTTON_FACTOR))
                }}
                title="Zoom in (all panes)"
              >
                +
              </button>
              <button className="btn btn-secondary btn-small" onClick={resetSliceView}>
                Reset
              </button>
            </div>
            <p className="tf-hint">Or ctrl/cmd+scroll a pane to zoom it individually, and drag to pan it.</p>
          </section>
        )}

        {loadedName && (
          <section className="panel">
            <h2 className="panel-title">Loaded</h2>
            <p className="panel-hint">{loadedName}</p>
          </section>
        )}
      </aside>
    </div>
  )
}
