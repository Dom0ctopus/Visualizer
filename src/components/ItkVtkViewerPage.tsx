import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  deleteLibraryFile,
  fetchJobs,
  fetchLibrary,
  uploadSegmentation,
  uploadVolume,
  zarrUrl,
  type JobKind,
  type JobQueueState,
  type MergeProgress
} from '../lib/api'
import { useItkVtkViewer } from '../hooks/useItkVtkViewer'
import { useSegmentationMerge3D } from '../hooks/useSegmentationMerge3D'
import { useSegmentationOverlays } from '../hooks/useSegmentationOverlays'
import { useZarrSegmentations } from '../hooks/useZarrSegmentations'
import { useZarrSliceViewer } from '../hooks/useZarrSliceViewer'
import { CaptureBar } from './CaptureBar'
import { LiveScaleBar } from './LiveScaleBar'
import { MeshViewer } from './MeshViewer'
import { SearchBar } from './SearchBar'
import { SegmentTree } from './SegmentTree'
import { ZarrSliceCanvas, type CanvasPan, type OrientationLabels } from './ZarrSliceCanvas'
import { focusKey, matchSegments, segmentTarget } from '../lib/focus'
import { realisticColor } from '../lib/realisticPalette'
import type { LibraryRecord, SegmentationRecord, VolumeRecord, ZarrLoadedSegmentation } from '../types'

const POLL_INTERVAL_MS = 1500
const ZOOM_BUTTON_FACTOR = 1.25
const DEFAULT_PAN: CanvasPan = { x: 0, y: 0 }

// Plane colors follow 3D Slicer's convention (axial red, sagittal yellow,
// coronal green): a crosshair line in one pane is drawn in the color of the
// plane it represents.
const AXIAL_COLOR = '#e85b5b'
const CORONAL_COLOR = '#62c462'
const SAGITTAL_COLOR = '#e8c547'

// Stored arrays increase with physical LPS position on every axis (see
// server/src/zarrWriter.ts's applyAxisFlips): +x = patient left, +y =
// posterior, +z = superior. Axial is displayed radiologically (patient right
// on screen left, anterior up); coronal/sagittal are flipped vertically so
// superior is up.
const AXIAL_LABELS: OrientationLabels = { left: 'R', right: 'L', top: 'A', bottom: 'P' }
const CORONAL_LABELS: OrientationLabels = { left: 'R', right: 'L', top: 'S', bottom: 'I' }
const SAGITTAL_LABELS: OrientationLabels = { left: 'A', right: 'P', top: 'S', bottom: 'I' }

type RenderTab = 'voxel' | 'mesh'


function formatElapsed(ms: number): string {
  // Clamped: `now` ticks once a second, so it can trail a fresh start time.
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Where a record's job of this kind stands in the server's queue, e.g.
 *  "running · 2m 05s · layer 2/5, slice 64/800" or "queued, 2 jobs ahead". */
function jobPhrase(jobs: JobQueueState | null, recordId: string, kind: JobKind, now: number): string | null {
  if (!jobs) return null
  const { running, queued } = jobs
  const mine = running.find((r) => r.recordId === recordId && r.kind === kind)
  if (mine) {
    return `running · ${formatElapsed(now - mine.startedAt)}${mine.progress ? ` · ${mine.progress}` : ''}`
  }
  const position = queued.findIndex((j) => j.recordId === recordId && j.kind === kind)
  if (position < 0) return null
  const ahead = position + (running.length > 0 ? 1 : 0)
  return ahead === 0 ? 'queued, starting' : `queued, ${ahead} job${ahead === 1 ? '' : 's'} ahead`
}

function statusLabel(record: VolumeRecord | SegmentationRecord, jobs: JobQueueState | null, now: number): string {
  switch (record.zarrStatus) {
    case 'ready': {
      if (record.kind !== 'segmentation') return 'ready'
      if (record.meshStatus === 'failed') return 'ready · meshes failed'
      if (record.meshStatus !== 'pending') return 'ready'
      const phrase = jobPhrase(jobs, record.id, 'meshes', now)
      return `ready · meshes ${phrase ?? 'pending'}`
    }
    case 'failed':
      return 'conversion failed'
    case 'pending': {
      const phrase = jobPhrase(jobs, record.id, 'convert', now)
      return phrase ? `converting: ${phrase}` : 'converting…'
    }
    default:
      return 'not converted'
  }
}

/** What the server's background queue is doing right now, if anything. */
function JobQueueLine({ jobs, now }: { jobs: JobQueueState | null; now: number }) {
  if (!jobs || jobs.running.length === 0) return null
  const { running, queued } = jobs
  return (
    <>
      {running.map((job, i) => (
        <p key={job.kind + job.recordId} className="tf-hint job-queue-line" title={queued.map((j) => j.label).join('\n')}>
          Server working on: {job.label} · {formatElapsed(now - job.startedAt)}
          {job.progress ? ` · ${job.progress}` : ''}
          {i === running.length - 1 && queued.length > 0 ? ` · ${queued.length} more queued` : ''}
        </p>
      ))}
    </>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** "Building combined voxel render… resampling layer 2 of 5 (40%) · 3m 12s",
 *  ticking every second so it's visible the server is still working. */
function MergeStatusLine({ progress, since }: { progress: MergeProgress | null; since: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  let detail = 'starting'
  if (progress?.phase === 'writing') detail = 'writing output'
  else if (progress) detail = `${progress.phase} layer ${progress.layer} of ${progress.layerCount} (${Math.round(progress.fraction * 100)}%)`
  return (
    <p className="tf-hint">
      Building combined voxel render… {detail}
      {since !== null && ` · ${formatElapsed(now - since)}`}
    </p>
  )
}

/** How the "Real to life" scheme covers the loaded segments. */
function RealisticCoverage({ segmentations }: { segmentations: ZarrLoadedSegmentation[] }) {
  let total = 0
  const unmatched: string[] = []
  const uncorrected = new Set<string>()
  const byFile: string[] = []
  for (const l of segmentations) {
    for (const seg of l.segments) {
      total++
      const match = realisticColor(seg.name, seg.system, l.name)
      if (!match) unmatched.push(`${seg.name} (${l.name})`)
      else {
        if (match.tissue.confidence === 'uncorrected') uncorrected.add(match.tissue.label)
        if (match.via === 'file') byFile.push(`${seg.name} -> ${match.tissue.label}`)
      }
    }
  }
  const details = [
    unmatched.length ? `Unmatched (file colors):\n  ${unmatched.join('\n  ')}` : '',
    byFile.length ? `Matched by file, not name:\n  ${byFile.join('\n  ')}` : '',
    uncorrected.size ? `Sampled without a white reference (lower confidence): ${[...uncorrected].join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  return (
    <p className="tf-hint color-scheme-hint" title={details || undefined}>
      {total - unmatched.length} of {total} segments colored by tissue type
      {unmatched.length > 0 && `; ${unmatched.length} unmatched keep their file colors`}
      {details && ' (hover for details)'}
    </p>
  )
}

interface HoveredSegment {
  name: string
  clientX: number
  clientY: number
}

/**
 * The app: three linked 2D panes (axial/coronal/sagittal) read directly from
 * each volume's OME-Zarr pyramid (useZarrSliceViewer, useSegmentationOverlays,
 * WebGL-composited by ZarrSliceCanvas), next to a 3D pane with two tabs:
 *
 *  - "Voxel render": itk-vtk-viewer volume rendering, with every loaded
 *    segmentation merged server-side into one label image
 *    (useSegmentationMerge3D, segmentationMergeConvert.ts) since
 *    itk-vtk-viewer only holds one label image -- colored by its own palette.
 *  - "Surface meshes": per-segment surfaces generated server-side
 *    (surfaceMesh.ts), in each segment's own color (MeshViewer).
 *
 * Uploads are converted to OME-Zarr on the server in the background; this
 * polls the library while anything is still converting.
 *
 * The 2D panes start at pyramid level 1 for responsive scrolling; every level
 * is pickable from the "Resolution" panel, and "Inspect here" drills into
 * native resolution for a bounded Z neighborhood (see useZarrSliceViewer.ts).
 */
export function ItkVtkViewerPage() {
  const [library, setLibrary] = useState<LibraryRecord[]>([])
  const [jobs, setJobs] = useState<JobQueueState | null>(null)
  // Ticks elapsed times in job status text while the server is busy.
  const [now, setNow] = useState(() => Date.now())
  const jobsRunning = (jobs?.running.length ?? 0) > 0
  useEffect(() => {
    if (!jobsRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [jobsRunning])
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
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
  const [crosshairVisible, setCrosshairVisible] = useState(true)
  const [renderTab, setRenderTab] = useState<RenderTab>('voxel')
  // Mounted on first use (its own WebGL context), then kept mounted.
  const [meshTabOpened, setMeshTabOpened] = useState(false)
  // Voxel render label colors: the segments' own (matching the 2D panes,
  // meshes and segment tree) or itk-vtk-viewer's categorical palette.
  const [voxelColors, setVoxelColors] = useState<'segments' | 'palette'>('segments')
  const pollTimerRef = useRef<number | null>(null)
  const volumeInputRef = useRef<HTMLInputElement | null>(null)
  const segInputRef = useRef<HTMLInputElement | null>(null)

  const {
    volumeContainerRef,
    scriptReady,
    busy,
    error: viewerError,
    loadedName,
    clearVolume,
    loadZarrUrl,
    loadLabelImageUrl,
    setLabelWeights,
    setLabelNames,
    setLabelColors,
    pickLabelName,
    captureTarget,
    setFocusBlend
  } = useItkVtkViewer()

  // Hover in the voxel render names the segment under the pointer, as in
  // the 2D panes (lib/volumePick.ts casts the ray). Throttled to one pick
  // per frame; nothing while dragging (rotating) or on other tabs.
  const voxelHoverRef = useRef({ active: false, pick: pickLabelName })
  useEffect(() => {
    voxelHoverRef.current = { active: renderTab === 'voxel', pick: pickLabelName }
  }, [renderTab, pickLabelName])
  useEffect(() => {
    const container = volumeContainerRef.current
    if (!container) return
    let frame = 0
    let last: PointerEvent | null = null
    const onMove = (e: PointerEvent) => {
      last = e
      if (e.buttons !== 0) {
        setHoveredSegment(null)
        return
      }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const p = last
        if (!p || !voxelHoverRef.current.active) return
        const name = voxelHoverRef.current.pick(p.clientX, p.clientY)
        setHoveredSegment(name ? { name, clientX: p.clientX, clientY: p.clientY } : null)
      })
    }
    const onLeave = () => {
      last = null
      setHoveredSegment(null)
    }
    container.addEventListener('pointermove', onMove)
    container.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerleave', onLeave)
    }
  }, [volumeContainerRef])
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
  const volumeInfoRef = useRef(volumeInfo)
  useEffect(() => {
    volumeInfoRef.current = volumeInfo
  }, [volumeInfo])

  const zarrSeg = useZarrSegmentations()

  // --- Search focus (lib/focus.ts) -------------------------------------------
  // The focused segments (by focusKey) and how strongly everything else
  // fades (0: not at all, 1: gone), shared by every view.
  const [focusKeys, setFocusKeys] = useState<ReadonlySet<string> | null>(null)
  const [focusStrength, setFocusStrength] = useState(0.85)
  const focusSpec = useMemo(() => (focusKeys ? { keys: focusKeys, fade: 1 - focusStrength } : null), [focusKeys, focusStrength])
  // The voxel render fades on a steeper curve: it accumulates opacity along
  // each ray, so a segment at 15% opacity still looks solid through its
  // thickness (see useItkVtkViewer's setFocusBlend for the blend's share).
  const voxelFocusSpec = useMemo(() => (focusKeys ? { keys: focusKeys, fade: (1 - focusStrength) ** 3 } : null), [focusKeys, focusStrength])
  const [focusError, setFocusError] = useState<string | null>(null)
  // The voxel render's share: focus also raises its label blend.
  useEffect(() => {
    setFocusBlend(focusKeys ? focusStrength : null)
  }, [focusKeys, focusStrength, setFocusBlend])

  const { overlays, error: overlayError } = useSegmentationOverlays(
    zarrSeg.segmentations,
    { z: zIndex, y: yIndex, x: xIndex },
    volumeInfo,
    levelIndex,
    focusSpec
  )
  const { status: mergeStatus, error: mergeError, progress: mergeProgress, pendingSince: mergePendingSince } = useSegmentationMerge3D(
    activeVolumeId,
    zarrSeg.segmentations,
    loadLabelImageUrl,
    setLabelWeights,
    setLabelNames,
    setLabelColors,
    voxelColors === 'segments',
    voxelFocusSpec
  )

  const findSegment = (recordId: string, key: string) =>
    zarrSeg.segmentations.find((l) => l.recordId === recordId)?.segments.find((s) => s.key === key)

  /** Moves the 2D panes to one segment (its center; see segmentTarget). */
  const [centeredKey, setCenteredKey] = useState<string | null>(null)
  const centerOn = async (recordId: string, key: string) => {
    const segment = findSegment(recordId, key)
    if (!segment) return
    setCenteredKey(focusKey(recordId, key))
    setFocusError(null)
    try {
      const target = await segmentTarget({ recordId, layer: segment.layer, labelValue: segment.labelValue })
      const info = volumeInfoRef.current
      if (!target || !info) return
      const index = (axis: number) => Math.max(0, Math.min(info.size[axis] - 1, Math.round((target[axis] - info.origin[axis]) / info.spacing[axis])))
      setZIndex(index(0))
      setYIndex(index(1))
      setXIndex(index(2))
    } catch (e) {
      setFocusError(e instanceof Error ? e.message : `Could not locate ${segment.name}`)
    }
  }

  /** Focuses the search's matches (replacing the focus set, or adding to it),
   *  makes sure they're visible, and centers the 2D panes on the first of
   *  them (when adding, the first newly added one). */
  const applyFocus = (add: boolean) => {
    const matches = matchSegments(zarrSeg.segmentations, searchText)
    if (matches.length === 0) return
    const previous = add && focusKeys ? focusKeys : new Set<string>()
    const keys = new Set(previous)
    for (const m of matches) keys.add(focusKey(m.recordId, m.key))
    setFocusKeys(keys)
    for (const m of matches) {
      const seg = findSegment(m.recordId, m.key)
      if (seg && !seg.visible) zarrSeg.setSegmentVisible(m.recordId, m.key, true)
    }
    const first = matches.find((m) => !previous.has(focusKey(m.recordId, m.key))) ?? matches[0]
    void centerOn(first.recordId, first.key)
  }
  const clearFocus = () => {
    setFocusKeys(null)
    setFocusError(null)
    setCenteredKey(null)
  }
  const removeFromFocus = (key: string) => {
    if (!focusKeys) return
    const next = new Set(focusKeys)
    next.delete(key)
    if (next.size === 0) clearFocus()
    else setFocusKeys(next)
  }
  // The focused segments, in the order they were focused.
  const focusList = focusKeys
    ? [...focusKeys].flatMap((key) => {
        const [recordId, segmentKey] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
        const loaded = zarrSeg.segmentations.find((l) => l.recordId === recordId)
        const segment = loaded?.segments.find((s) => s.key === segmentKey)
        return segment && loaded ? [{ key, recordId, segment, file: loaded.name }] : []
      })
    : []
  const focusCount = focusList.length
  const focusSlider = (
    <label className="focus-slider" title="How much everything outside the focus fades (0: not at all; 100%: hidden)">
      <span className="render-toolbar-label">Focus</span>
      <input type="range" min={0} max={1} step={0.01} value={focusStrength} onChange={(e) => setFocusStrength(Number(e.target.value))} />
      <b>{Math.round(focusStrength * 100)}%</b>
    </label>
  )

  const refreshLibrary = useCallback(async () => {
    try {
      const [records, jobState] = await Promise.all([fetchLibrary(), fetchJobs()])
      setLibrary(records)
      setJobs(jobState)
      setNow(Date.now())
      return records
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach the backend server.')
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const records = await refreshLibrary()
      if (cancelled) return
      const anyPending = records?.some((r) => r.zarrStatus === 'pending' || (r.kind === 'segmentation' && r.meshStatus === 'pending'))
      pollTimerRef.current = window.setTimeout(poll, anyPending ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 4)
    }
    poll()
    return () => {
      cancelled = true
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    }
  }, [refreshLibrary])

  const volumes = library.filter((r): r is VolumeRecord => r.kind === 'volume')
  const segmentationRecords = library.filter((r): r is SegmentationRecord => r.kind === 'segmentation')

  // The same color choice in every 3D tab's toolbar as in the Segments
  // panel; the voxel render adds itk-vtk-viewer's own palette.
  const colorToggle = (withPalette: boolean) => (
    <>
      <span className="render-toolbar-label">Colors</span>
      <div className="segmented">
        <button
          className={zarrSeg.colorScheme === 'slicer' && !(withPalette && voxelColors === 'palette') ? 'active' : ''}
          title="Each segment's color from its segmentation file, as in the 2D panes and segment tree"
          onClick={() => {
            zarrSeg.setColorScheme('slicer')
            setVoxelColors('segments')
          }}
        >
          Segmentation
        </button>
        <button
          className={zarrSeg.colorScheme === 'realistic' && !(withPalette && voxelColors === 'palette') ? 'active' : ''}
          title="General tissue-type colors sampled from dissection photographs (see the Segments panel)"
          onClick={() => {
            zarrSeg.setColorScheme('realistic')
            setVoxelColors('segments')
          }}
        >
          Real to life
        </button>
        {withPalette && (
          <button
            className={voxelColors === 'palette' ? 'active' : ''}
            title="itk-vtk-viewer's categorical palette (colors don't correspond to the segment tree)"
            onClick={() => setVoxelColors('palette')}
          >
            Palette
          </button>
        )}
      </div>
    </>
  )

  const resetSliceView = () => {
    setAxialZoom(1)
    setAxialPan(DEFAULT_PAN)
    setCoronalZoom(1)
    setCoronalPan(DEFAULT_PAN)
    setSagittalZoom(1)
    setSagittalPan(DEFAULT_PAN)
  }

  const handleLoad = (record: VolumeRecord) => {
    const url = zarrUrl(record.id)
    setActiveZarrUrl(url)
    setActiveVolumeId(record.id)
    resetSliceView()
    loadZarrUrl(url, record.name)
  }

  const handleUpload = async (files: File[], kind: 'volume' | 'segmentation') => {
    setError(null)
    setUploading((n) => n + files.length)
    for (const file of files) {
      try {
        if (kind === 'volume') await uploadVolume(file)
        else await uploadSegmentation(file)
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to upload ${file.name}`)
      } finally {
        setUploading((n) => n - 1)
        void refreshLibrary()
      }
    }
  }

  const handleRemove = async (record: LibraryRecord) => {
    if (!window.confirm(`Remove "${record.name}" from the server library? This deletes the uploaded file and its converted data.`)) return
    setError(null)
    if (record.kind === 'volume' && record.id === activeVolumeId) {
      clearVolume()
      setActiveZarrUrl(null)
      setActiveVolumeId(null)
    }
    if (record.kind === 'segmentation') zarrSeg.removeSegmentation(record.id)
    try {
      await deleteLibraryFile(record.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove file from the library.')
    }
    void refreshLibrary()
  }

  const openTab = (tab: RenderTab) => {
    setRenderTab(tab)
    if (tab === 'mesh') setMeshTabOpened(true)
  }

  const zoomAll = (factor: number) => {
    const apply = (z: number) => Math.min(20, Math.max(0.1, z * factor))
    setAxialZoom(apply)
    setCoronalZoom(apply)
    setSagittalZoom(apply)
  }

  const sliderStep = Math.max((dataRange[1] - dataRange[0]) / 1000, 0.01)
  const combinedError = error ?? viewerError ?? sliceError ?? overlayError ?? mergeError
  // VolumeInfo spacing is [z, y, x].
  const spacing = volumeInfo?.spacing ?? [1, 1, 1]

  return (
    <div className="app-body">
      <div className="viewer itk-viewer-split">
        <div className="itk-viewer-hover-bar">
          <span className="itk-viewer-hover-text">
            {hoveredSegment ? (
              <>
                <span className="itk-viewer-hover-bar-label">Segment:</span> {hoveredSegment.name}
              </>
            ) : (
              'Hover a segment in any view to see its name · click a 2D pane to move the linked cursor'
            )}
          </span>
          <label className="crosshair-toggle">
            <input type="checkbox" checked={crosshairVisible} onChange={(e) => setCrosshairVisible(e.target.checked)} />
            Crosshair
          </label>
        </div>
        <div className="itk-viewer-columns">
          <div className="itk-viewer-left-column">
            <div className="itk-viewer-pane">
              <div className="itk-viewer-pane-label" style={{ '--pane-color': AXIAL_COLOR } as CSSProperties}>
                Axial
              </div>
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
                  pixelSpacing={[spacing[2], spacing[1]]}
                  crosshair={crosshairVisible ? { x: xIndex, y: yIndex, colorX: SAGITTAL_COLOR, colorY: CORONAL_COLOR } : null}
                  onPick={(p) => {
                    setXIndex(p.x)
                    setYIndex(p.y)
                  }}
                  labels={AXIAL_LABELS}
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
              <div className="itk-viewer-pane-label" style={{ '--pane-color': CORONAL_COLOR } as CSSProperties}>
                Coronal
              </div>
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
                  pixelSpacing={[spacing[2], spacing[0]]}
                  flipY
                  crosshair={crosshairVisible ? { x: xIndex, y: zIndex, colorX: SAGITTAL_COLOR, colorY: AXIAL_COLOR } : null}
                  onPick={(p) => {
                    setXIndex(p.x)
                    setZIndex(p.y)
                  }}
                  labels={CORONAL_LABELS}
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
              <div className="itk-viewer-pane-label" style={{ '--pane-color': SAGITTAL_COLOR } as CSSProperties}>
                Sagittal
              </div>
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
                  pixelSpacing={[spacing[1], spacing[0]]}
                  flipY
                  crosshair={crosshairVisible ? { x: yIndex, y: zIndex, colorX: CORONAL_COLOR, colorY: AXIAL_COLOR } : null}
                  onPick={(p) => {
                    setYIndex(p.x)
                    setZIndex(p.y)
                  }}
                  labels={SAGITTAL_LABELS}
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
            <div className="render-tabs">
              <button className={renderTab === 'voxel' ? 'render-tab active' : 'render-tab'} onClick={() => openTab('voxel')}>
                Voxel render
              </button>
              <button className={renderTab === 'mesh' ? 'render-tab active' : 'render-tab'} onClick={() => openTab('mesh')}>
                Surface meshes
              </button>
            </div>
            <div className="itk-viewer-container">
              {/* Both tabs stay mounted and sized (visibility, not display:none),
                  so switching never reloads or re-lays-out either renderer. */}
              <div className={renderTab === 'voxel' ? 'render-tab-panel' : 'render-tab-panel inactive'}>
                <div ref={volumeContainerRef} className="itk-volume-container" />
                {loadedName && <LiveScaleBar viewHeightMm={captureTarget.viewHeightMm} active={renderTab === 'voxel'} />}
                {loadedName && <CaptureBar target={captureTarget} name={`${loadedName.replace(/\.[^.]*$/, '')}-voxel`} />}
                {zarrSeg.segmentations.length > 0 && (
                  <div className="render-toolbar">
                    {colorToggle(true)}
                    {focusKeys && focusSlider}
                    {mergeStatus === 'pending' && <span className="render-toolbar-hint">Colors apply once the combined label map is built</span>}
                  </div>
                )}
              </div>
              {meshTabOpened && (
                <div className={renderTab === 'mesh' ? 'render-tab-panel' : 'render-tab-panel inactive'}>
                  <MeshViewer
                    segmentations={zarrSeg.segmentations}
                    records={segmentationRecords}
                    active={renderTab === 'mesh'}
                    onHoverLabel={setHoveredSegment}
                    focus={focusSpec}
                  />
                  {zarrSeg.segmentations.length > 0 && (
                    <div className="render-toolbar">
                      {colorToggle(false)}
                      {focusKeys && focusSlider}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {hoveredSegment && (
        <div className="itk-viewer-hover-tooltip" style={{ left: hoveredSegment.clientX + 14, top: hoveredSegment.clientY + 14 }}>
          {hoveredSegment.name}
        </div>
      )}

      <aside className="sidebar">
        {combinedError && <div className="error-banner">{combinedError}</div>}

        <section className="panel">
          <h2 className="panel-title">Upload</h2>
          <div className="library-upload-row">
            <input
              ref={volumeInputRef}
              type="file"
              accept=".nrrd,.nhdr"
              className="hidden-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                if (files.length) void handleUpload(files, 'volume')
              }}
            />
            <button className="btn btn-primary btn-small" onClick={() => volumeInputRef.current?.click()}>
              Upload Volume…
            </button>
            <input
              ref={segInputRef}
              type="file"
              accept=".nrrd,.nhdr"
              multiple
              className="hidden-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                if (files.length) void handleUpload(files, 'segmentation')
              }}
            />
            <button className="btn btn-secondary btn-small" onClick={() => segInputRef.current?.click()}>
              Upload Segmentation…
            </button>
          </div>
          {uploading > 0 && <p className="tf-hint upload-status">Uploading {uploading} file{uploading === 1 ? '' : 's'}…</p>}
          <JobQueueLine jobs={jobs} now={now} />
          <p className="panel-hint upload-hint">
            NRRD volumes and 3D Slicer segmentation NRRDs. Each is converted on the server into a multiscale OME-Zarr
            pyramid (and, for segmentations, surface meshes) before it can be loaded.
          </p>
        </section>

        <section className="panel">
          <h2 className="panel-title">Volumes</h2>
          {volumes.length === 0 && <p className="empty-hint">No volumes yet. Upload one above.</p>}
          <ul className="library-list">
            {volumes.map((record) => (
              <li key={record.id} className="library-row">
                <span className="library-kind library-kind-volume">VOL</span>
                <div className="library-main">
                  <div className="library-name" title={record.name}>
                    {record.name}
                  </div>
                  <div className="library-meta" title={record.zarrError}>
                    {formatSize(record.sizeBytes)} · {statusLabel(record, jobs, now)}
                    {record.zarrStatus === 'failed' && record.zarrError ? `: ${record.zarrError}` : ''}
                  </div>
                </div>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={!scriptReady || busy || record.zarrStatus !== 'ready'}
                  onClick={() => handleLoad(record)}
                >
                  {record.id === activeVolumeId ? 'Reload' : 'Load'}
                </button>
                <button className="icon-btn" onClick={() => void handleRemove(record)} title="Remove from library">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2 className="panel-title">Segmentations</h2>
          {mergeStatus === 'pending' && <MergeStatusLine progress={mergeProgress} since={mergePendingSince} />}
          {segmentationRecords.length === 0 && <p className="empty-hint">No segmentations yet. Upload one above.</p>}
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
                      {formatSize(record.sizeBytes)} · {statusLabel(record, jobs, now)}
                      {record.zarrStatus === 'failed' && record.zarrError ? `: ${record.zarrError}` : ''}
                    </div>
                  </div>
                  <button
                    className="btn btn-secondary btn-small"
                    disabled={record.zarrStatus !== 'ready' || alreadyLoaded}
                    onClick={() => zarrSeg.loadSegmentationRecord(record)}
                  >
                    {alreadyLoaded ? 'Loaded' : 'Load'}
                  </button>
                  <button className="icon-btn" onClick={() => void handleRemove(record)} title="Remove from library">
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        {zarrSeg.segmentations.length > 0 && (
          <section className="panel">
            <h2 className="panel-title">Segments</h2>
            <div className="color-scheme-row">
              <span className="render-toolbar-label">Colors</span>
              <div className="segmented">
                <button
                  className={zarrSeg.colorScheme === 'slicer' ? 'active' : ''}
                  title="Each segment's color from its segmentation file"
                  onClick={() => zarrSeg.setColorScheme('slicer')}
                >
                  Segmentation
                </button>
                <button
                  className={zarrSeg.colorScheme === 'realistic' ? 'active' : ''}
                  title="General tissue-type colors (nervous tissue, muscle, gut, gland, ...) sampled from dissection photographs, matched to segments by name"
                  onClick={() => zarrSeg.setColorScheme('realistic')}
                >
                  Real to life
                </button>
              </div>
            </div>
            {zarrSeg.colorScheme === 'realistic' && <RealisticCoverage segmentations={zarrSeg.segmentations} />}
            <SearchBar
              value={searchText}
              onChange={setSearchText}
              segmentations={zarrSeg.segmentations}
              onSegmentVisible={zarrSeg.setSegmentVisible}
              onFocus={applyFocus}
              onClearFocus={clearFocus}
              focusActive={focusKeys !== null}
            />
            {focusKeys && (
              <div className="focus-summary">
                <div className="focus-summary-row">
                  <span>
                    Focused on <b>{focusCount}</b> segment{focusCount === 1 ? '' : 's'}
                  </span>
                  <button className="icon-btn" onClick={clearFocus} title="Clear the focus (Esc in the search box)">
                    Clear
                  </button>
                </div>
                {focusSlider}
                <ul className="focus-list" aria-label="Focused segments">
                  {focusList.map(({ key, recordId, segment, file }) => (
                    <li key={key} className={key === centeredKey ? 'focus-item centered' : 'focus-item'}>
                      <button
                        className="focus-item-name"
                        title={`${file} · ${segment.system} · ${segment.name}\nClick to center the 2D panes on it`}
                        onClick={() => void centerOn(recordId, segment.key)}
                      >
                        <span className="color-swatch" style={{ background: `rgb(${segment.color.join(',')})` }} />
                        <span className="focus-item-label">{segment.name}</span>
                      </button>
                      <button className="focus-item-remove" aria-label={`Remove ${segment.name} from the focus`} onClick={() => removeFromFocus(key)}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                {focusError && <p className="render-toolbar-hint">{focusError}</p>}
              </div>
            )}
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
              <button className="btn btn-secondary btn-small" onClick={() => zoomAll(1 / ZOOM_BUTTON_FACTOR)} title="Zoom out (all panes)">
                &minus;
              </button>
              <button className="btn btn-secondary btn-small" onClick={() => zoomAll(ZOOM_BUTTON_FACTOR)} title="Zoom in (all panes)">
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
