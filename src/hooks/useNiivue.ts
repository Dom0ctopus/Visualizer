import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAG_MODE, Niivue, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import { deleteLibraryFile, fetchLibrary, fileUrl, uploadSegmentation, uploadVolume } from '../lib/api'
import { buildLutForBucket, opacityBucket } from '../lib/segmentationLut'
import { buildTransferFunctionColormap, parseCtvoxTransferFunction } from '../lib/transferFunction'
import type {
  BaseVolumeInfo,
  CrosshairInfo,
  LibraryRecord,
  LoadedSegmentation,
  SegmentationRecord,
  SegmentState,
  VolumeRecord
} from '../types'

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

const DEFAULT_SEGMENT_OPACITY = 0.6
const CROSSHAIR_WIDTH_VISIBLE = 0.6
// niivue's own scene defaults (INITIAL_SCENE_DATA), used to snap the 3D camera
// back to its starting orientation.
const DEFAULT_RENDER_AZIMUTH = 110
const DEFAULT_RENDER_ELEVATION = 10

// 2x2 grid with the 3D render pane top-left: render | coronal, axial | sagittal
const GAP = 0.006
const LAYOUT: Array<{ sliceType: SLICE_TYPE; position: [number, number, number, number] }> = [
  { sliceType: SLICE_TYPE.RENDER, position: [0, 0, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0.5 + GAP / 2, 0, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0.5 + GAP / 2, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.5 + GAP / 2, 0.5 + GAP / 2, 0.5 - GAP / 2, 0.5 - GAP / 2] }
]

function applyLayout(nv: Niivue): void {
  nv.setCustomLayout(LAYOUT)
}

function bucketKey(layer: number, bucket: number): string {
  return `${layer}:${bucket}`
}

export function useNiivue() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<Niivue | null>(null)

  const [ready, setReady] = useState(false)
  const [baseVolume, setBaseVolume] = useState<BaseVolumeInfo | null>(null)
  const [segmentations, setSegmentations] = useState<LoadedSegmentation[]>([])
  const [crosshair, setCrosshair] = useState<CrosshairInfo | null>(null)
  const [crosshairVisible, setCrosshairVisibleState] = useState(false)
  const [library, setLibrary] = useState<LibraryRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [transferFunctionActive, setTransferFunctionActive] = useState(false)

  // Mirrors `segmentations` for the debounced rebuild pipeline below, which needs to
  // read the latest segment state from a timer callback without depending on
  // useCallback's closure over a stale `segmentations` value.
  const segmentationsRef = useRef<LoadedSegmentation[]>([])
  useEffect(() => {
    segmentationsRef.current = segmentations
  }, [segmentations])

  // Per-recordId bookkeeping for the debounced/serialized volume rebuild below --
  // see updateSegments/scheduleRebuild/runRebuild.
  const dirtyLayersRef = useRef<Map<string, Set<number>>>(new Map())
  const rebuildTimersRef = useRef<Map<string, number>>(new Map())
  const rebuildInFlightRef = useRef<Set<string>>(new Set())
  const rebuildQueuedRef = useRef<Set<string>>(new Set())

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await fetchLibrary())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach the backend server.')
    }
  }, [])

  useEffect(() => {
    const nv = new Niivue({
      backColor: [0.07, 0.08, 0.1, 1],
      show3Dcrosshair: false,
      crosshairWidth: 0,
      isColorbar: false,
      isOrientCube: false,
      isRadiologicalConvention: false,
      multiplanarPadPixels: 2,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      dragAndDropEnabled: true,
      dragMode: DRAG_MODE.contrast,
      dragModePrimary: DRAG_MODE.crosshair,
      // Retina/HiDPI displays otherwise render at 2x+ pixel density, which multiplies
      // the 3D view's per-frame ray-marching cost accordingly; forcing 1x keeps
      // interactive rotation responsive at a barely-noticeable sharpness cost.
      forceDevicePixelRatio: -1
    })
    nvRef.current = nv
    if (import.meta.env.DEV) {
      ;(window as unknown as { __nv: Niivue }).__nv = nv
    }

    nv.onLocationChange = (data: unknown) => {
      const loc = data as { mm?: number[]; values?: Array<{ name: string; value: number }> }
      if (!loc.mm) return
      setCrosshair({
        mm: [round(loc.mm[0] ?? 0), round(loc.mm[1] ?? 0), round(loc.mm[2] ?? 0)],
        values: (loc.values ?? []).map((v) => ({ name: v.name, value: v.value }))
      })
    }

    if (canvasRef.current) {
      nv.attachToCanvas(canvasRef.current).then(() => {
        applyLayout(nv)
        setReady(true)
      })
    }

    refreshLibrary()

    return () => {
      nvRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearAll = useCallback(() => {
    const nv = nvRef.current
    if (!nv) return
    while (nv.volumes.length > 0) {
      nv.removeVolume(nv.volumes[nv.volumes.length - 1])
    }
    setBaseVolume(null)
    setSegmentations([])
    setCrosshair(null)
    setError(null)
    setTransferFunctionActive(false)
  }, [])

  const loadVolumeRecord = useCallback(
    async (record: VolumeRecord) => {
      const nv = nvRef.current
      if (!nv) return
      clearAll()
      const vol = await nv.addVolumeFromUrl({ url: fileUrl(record.id), name: record.name, colormap: 'gray' })
      setBaseVolume({
        id: vol.id,
        name: record.name,
        dataMin: vol.global_min ?? vol.cal_min ?? 0,
        dataMax: vol.global_max ?? vol.cal_max ?? 0,
        calMin: vol.cal_min ?? 0,
        calMax: vol.cal_max ?? 0
      })
      applyLayout(nv)
    },
    [clearAll]
  )

  // Segments sharing a layer and an opacity value (rounded to the nearest percent)
  // are packed into one niivue volume, using that volume's own `.opacity` property
  // to drive visible transparency. colormapLabel's alpha channel only supports
  // binary/edge-anti-aliasing visibility in niivue's 3D renderer, not analog
  // blending, so it is used here for color + per-label masking only (always at
  // full alpha for included labels).
  const rebuildLayerVolumes = useCallback(
    async (nv: Niivue, loaded: LoadedSegmentation, layer: number): Promise<Record<string, string>> => {
      const segmentsInLayer = loaded.segments.filter((s) => s.layer === layer)
      const byBucket = new Map<number, SegmentState[]>()
      for (const seg of segmentsInLayer) {
        if (!seg.visible || seg.opacity <= 0) continue
        const bucket = opacityBucket(seg.opacity)
        if (bucket <= 0) continue
        const list = byBucket.get(bucket) ?? []
        list.push(seg)
        byBucket.set(bucket, list)
      }

      const result: Record<string, string> = {}
      for (const [bucket, segs] of byBucket) {
        const key = bucketKey(layer, bucket)
        const { lut, min, max } = buildLutForBucket(segs, segmentsInLayer)
        const existingId = loaded.volumeIdsByBucket[key]
        const existingIdx = existingId ? nv.volumes.findIndex((v) => v.id === existingId) : -1
        if (existingIdx >= 0) {
          nv.volumes[existingIdx].colormapLabel = { lut, min, max }
          nv.volumes[existingIdx].opacity = bucket / 100
          result[key] = existingId!
        } else {
          const vol = await nv.addVolumeFromUrl({
            url: fileUrl(loaded.recordId),
            // Keep the real filename (and its extension) so niivue's format detection
            // works; layer/bucket identity is tracked separately via volumeIdsByBucket.
            name: loaded.name,
            frame4D: layer,
            opacity: bucket / 100,
            colormapLabel: { lut, min, max }
          })
          // Re-assert colormapLabel after creation and force a redraw: setting it via
          // addVolumeFromUrl's own options doesn't reliably take effect on first paint.
          const idx = nv.volumes.findIndex((v) => v.id === vol.id)
          if (idx >= 0) nv.volumes[idx].colormapLabel = { lut, min, max }
          result[key] = vol.id
        }
      }

      for (const [key, volId] of Object.entries(loaded.volumeIdsByBucket)) {
        if (!key.startsWith(`${layer}:`) || key in result) continue
        const idx = nv.volumes.findIndex((v) => v.id === volId)
        if (idx >= 0) nv.removeVolumeByIndex(idx)
      }

      nv.updateGLVolume()
      return result
    },
    []
  )

  const loadSegmentationRecord = useCallback(
    async (record: SegmentationRecord) => {
      const nv = nvRef.current
      if (!nv) return

      const allSegments = record.systems.flatMap((sys) => sys.segments.map((seg) => ({ ...seg, system: sys.name })))
      const layers = [...new Set(allSegments.map((s) => s.layer))].sort((a, b) => a - b)

      const segmentStates: SegmentState[] = allSegments.map((seg) => ({
        key: `${seg.layer}:${seg.labelValue}`,
        system: seg.system,
        name: seg.name,
        labelValue: seg.labelValue,
        layer: seg.layer,
        color: seg.color,
        visible: true,
        opacity: DEFAULT_SEGMENT_OPACITY
      }))

      let loaded: LoadedSegmentation = {
        recordId: record.id,
        name: record.name,
        layerCount: record.layerCount,
        volumeIdsByBucket: {},
        segments: segmentStates
      }

      for (const layer of layers) {
        const layerIds = await rebuildLayerVolumes(nv, loaded, layer)
        loaded = { ...loaded, volumeIdsByBucket: { ...loaded.volumeIdsByBucket, ...layerIds } }
      }

      setSegmentations((prev) => [...prev, loaded])
    },
    [rebuildLayerVolumes]
  )

  const uploadAndLoadVolume = useCallback(
    async (file: File) => {
      setBusy(true)
      setError(null)
      try {
        const record = await uploadVolume(file)
        await loadVolumeRecord(record)
        setLibrary((prev) => [...prev, record])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load volume. Is this a valid NRRD file?')
      } finally {
        setBusy(false)
      }
    },
    [loadVolumeRecord]
  )

  const uploadAndLoadSegmentation = useCallback(
    async (file: File) => {
      setBusy(true)
      setError(null)
      try {
        const record = await uploadSegmentation(file)
        await loadSegmentationRecord(record)
        setLibrary((prev) => [...prev, record])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load segmentation. Is this a valid NRRD file?')
      } finally {
        setBusy(false)
      }
    },
    [loadSegmentationRecord]
  )

  const loadFromLibrary = useCallback(
    async (record: LibraryRecord) => {
      setBusy(true)
      setError(null)
      try {
        if (record.kind === 'volume') {
          await loadVolumeRecord(record)
        } else {
          await loadSegmentationRecord(record)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load from the library.')
      } finally {
        setBusy(false)
      }
    },
    [loadVolumeRecord, loadSegmentationRecord]
  )

  // Runs (or re-runs) the pending volume rebuild for one segmentation file, always
  // reading the freshest segment state and dirty-layer set at the moment it actually
  // executes. Only one rebuild runs at a time per recordId -- a request that arrives
  // while one is already in flight is coalesced into a single follow-up pass instead
  // of starting a second, overlapping rebuild (which is what let concurrent slider
  // drag events race each other and leave niivue's volumes out of sync with React
  // state, showing as opacity changes only "sometimes" taking effect).
  const runRebuild = useCallback(
    async (recordId: string) => {
      const nv = nvRef.current
      if (!nv) return
      if (rebuildInFlightRef.current.has(recordId)) {
        rebuildQueuedRef.current.add(recordId)
        return
      }
      rebuildInFlightRef.current.add(recordId)
      try {
        for (;;) {
          const layers = dirtyLayersRef.current.get(recordId)
          if (!layers || layers.size === 0) break
          dirtyLayersRef.current.set(recordId, new Set())
          const loaded = segmentationsRef.current.find((s) => s.recordId === recordId)
          if (!loaded) break

          let volumeIdsByBucket = loaded.volumeIdsByBucket
          for (const layer of layers) {
            const layerIds = await rebuildLayerVolumes(nv, { ...loaded, volumeIdsByBucket }, layer)
            volumeIdsByBucket = { ...volumeIdsByBucket }
            for (const key of Object.keys(volumeIdsByBucket)) {
              if (key.startsWith(`${layer}:`)) delete volumeIdsByBucket[key]
            }
            volumeIdsByBucket = { ...volumeIdsByBucket, ...layerIds }
          }

          const finalIds = volumeIdsByBucket
          segmentationsRef.current = segmentationsRef.current.map((l) =>
            l.recordId === recordId ? { ...l, volumeIdsByBucket: finalIds } : l
          )
          setSegmentations((prev) => prev.map((l) => (l.recordId === recordId ? { ...l, volumeIdsByBucket: finalIds } : l)))
        }
      } finally {
        rebuildInFlightRef.current.delete(recordId)
        if (rebuildQueuedRef.current.delete(recordId)) {
          void runRebuild(recordId)
        }
      }
    },
    [rebuildLayerVolumes]
  )

  // Debounces the actual GL rebuild so a fast slider drag (which fires onChange
  // continuously) doesn't spawn a volume-creation fetch per pixel of movement --
  // only once ~120ms after the user pauses or releases.
  const scheduleRebuild = useCallback(
    (recordId: string) => {
      const existing = rebuildTimersRef.current.get(recordId)
      if (existing !== undefined) window.clearTimeout(existing)
      const timer = window.setTimeout(() => {
        rebuildTimersRef.current.delete(recordId)
        void runRebuild(recordId)
      }, 120)
      rebuildTimersRef.current.set(recordId, timer)
    },
    [runRebuild]
  )

  const updateSegments = useCallback(
    (recordId: string, predicate: (seg: SegmentState) => boolean, updater: (seg: SegmentState) => SegmentState) => {
      // Which layers are affected is determined structurally (by key/system/etc, via
      // `predicate`), which doesn't change as opacity/visibility are edited -- so it's
      // safe to read this from the ref mirror rather than from React's state updater.
      // That distinction matters: setSegmentations' updater callback isn't guaranteed
      // to run synchronously (React can defer it to the actual render pass), so a
      // variable populated *inside* the updater and read immediately after the call
      // -- the previous approach here -- was frequently still at its initial value,
      // silently dropping the dirty-layer marking on most calls during a fast drag.
      const loaded = segmentationsRef.current.find((l) => l.recordId === recordId)
      if (!loaded) return
      const affectedLayers = new Set<number>()
      for (const seg of loaded.segments) {
        if (predicate(seg)) affectedLayers.add(seg.layer)
      }
      if (affectedLayers.size === 0) return

      setSegmentations((prev) =>
        prev.map((l) => {
          if (l.recordId !== recordId) return l
          return { ...l, segments: l.segments.map((seg) => (predicate(seg) ? updater(seg) : seg)) }
        })
      )

      const layers = dirtyLayersRef.current.get(recordId) ?? new Set<number>()
      for (const layer of affectedLayers) layers.add(layer)
      dirtyLayersRef.current.set(recordId, layers)
      scheduleRebuild(recordId)
    },
    [scheduleRebuild]
  )

  const setSegmentVisible = useCallback(
    (recordId: string, key: string, visible: boolean) => {
      updateSegments(
        recordId,
        (s) => s.key === key,
        (s) => ({ ...s, visible })
      )
    },
    [updateSegments]
  )

  const setSegmentOpacity = useCallback(
    (recordId: string, key: string, opacity: number) => {
      updateSegments(
        recordId,
        (s) => s.key === key,
        (s) => ({ ...s, opacity, visible: opacity > 0 })
      )
    },
    [updateSegments]
  )

  const setSystemVisible = useCallback(
    (recordId: string, systemName: string, visible: boolean) => {
      updateSegments(
        recordId,
        (s) => s.system === systemName,
        (s) => ({ ...s, visible })
      )
    },
    [updateSegments]
  )

  const setSystemOpacity = useCallback(
    (recordId: string, systemName: string, opacity: number) => {
      updateSegments(
        recordId,
        (s) => s.system === systemName,
        (s) => ({ ...s, opacity, visible: opacity > 0 })
      )
    },
    [updateSegments]
  )

  const setFileVisible = useCallback(
    (recordId: string, visible: boolean) => {
      updateSegments(
        recordId,
        () => true,
        (s) => ({ ...s, visible })
      )
    },
    [updateSegments]
  )

  const setFileOpacity = useCallback(
    (recordId: string, opacity: number) => {
      updateSegments(
        recordId,
        () => true,
        (s) => ({ ...s, opacity, visible: opacity > 0 })
      )
    },
    [updateSegments]
  )

  const removeSegmentation = useCallback((recordId: string) => {
    const nv = nvRef.current
    if (!nv) return
    // Drop any pending/queued rebuild for this file -- its volumes are about to be
    // removed, so a stale rebuild firing afterward would just recreate them.
    const timer = rebuildTimersRef.current.get(recordId)
    if (timer !== undefined) window.clearTimeout(timer)
    rebuildTimersRef.current.delete(recordId)
    dirtyLayersRef.current.delete(recordId)
    rebuildQueuedRef.current.delete(recordId)

    setSegmentations((prev) => {
      const loaded = prev.find((s) => s.recordId === recordId)
      if (loaded) {
        for (const volId of Object.values(loaded.volumeIdsByBucket)) {
          const idx = nv.volumes.findIndex((v) => v.id === volId)
          if (idx >= 0) nv.removeVolumeByIndex(idx)
        }
      }
      return prev.filter((s) => s.recordId !== recordId)
    })
  }, [])

  const removeFromLibrary = useCallback(
    async (record: LibraryRecord) => {
      setError(null)
      try {
        await deleteLibraryFile(record.id)
        setLibrary((prev) => prev.filter((r) => r.id !== record.id))
        if (record.kind === 'segmentation') {
          removeSegmentation(record.id)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to remove file from the library.')
      }
    },
    [removeSegmentation]
  )

  const setWindowLevel = useCallback((calMin: number, calMax: number) => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    const vol = nv.volumes[0]
    vol.cal_min = calMin
    vol.cal_max = calMax
    nv.updateGLVolume()
    setBaseVolume((prev) => (prev ? { ...prev, calMin, calMax } : prev))
  }, [])

  const resetWindowLevel = useCallback(() => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    const vol = nv.volumes[0]
    vol.calMinMax()
    setWindowLevel(vol.cal_min ?? 0, vol.cal_max ?? 0)
  }, [setWindowLevel])

  const loadTransferFunction = useCallback(async (file: File) => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    setError(null)
    try {
      const buffer = await file.arrayBuffer()
      const tf = parseCtvoxTransferFunction(buffer)
      const vol = nv.volumes[0]
      // Floor is the current window's minimum (cal_min), so background the user has
      // already windowed out stays excluded. Ceiling is global_max -- the actual
      // observed maximum voxel value in this dataset -- rather than a guess at the
      // datatype's theoretical maximum (2^bits-1): that guess is only correct for
      // unsigned data that actually spans its full range, and for anything else
      // (signed types, or real data that never reaches the type's ceiling) it can
      // wildly overshoot, compressing the entire real data range into a razor-thin
      // sliver near the bottom of the table. Since gray = t*gain, "near the bottom"
      // means every voxel's mapped color comes out near-black regardless of the
      // curve's actual shape -- reproducing the same solid-block look this is meant
      // to fix, just black instead of white. global_max can never be exceeded by the
      // data by definition, so it's always correctly scaled.
      const dataMin = vol.cal_min ?? vol.global_min ?? 0
      const dataMax = Math.max(vol.global_max ?? vol.cal_max ?? 255, dataMin + 1)
      vol.colormapLabel = buildTransferFunctionColormap(tf, dataMin, dataMax)
      nv.updateGLVolume()
      setTransferFunctionActive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transfer function.')
    }
  }, [])

  const clearTransferFunction = useCallback(() => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    nv.volumes[0].colormapLabel = null
    nv.updateGLVolume()
    setTransferFunctionActive(false)
  }, [])

  const setCrosshairVisible = useCallback((visible: boolean) => {
    const nv = nvRef.current
    if (!nv) return
    nv.opts.crosshairWidth = visible ? CROSSHAIR_WIDTH_VISIBLE : 0
    nv.opts.show3Dcrosshair = visible
    nv.drawScene()
    setCrosshairVisibleState(visible)
  }, [])

  const resetView = useCallback(() => {
    const nv = nvRef.current
    if (!nv) return
    applyLayout(nv)
    // Snap 2D pan/zoom and the 3D camera back to niivue's defaults, in case the
    // user has scrolled/dragged themselves somewhere disorienting.
    nv.scene.pan2Dxyzmm = [0, 0, 0, 1]
    nv.scene.volScaleMultiplier = 1.0
    nv.setRenderAzimuthElevation(DEFAULT_RENDER_AZIMUTH, DEFAULT_RENDER_ELEVATION)
    nv.updateGLVolume()
  }, [])

  // Mirrors niivue's own internal wheel-zoom math (WheelController.calculateZoom /
  // calculatePanOffsetAfterZoom) so the buttons below feel identical to scroll-zoom,
  // without touching niivue's default scroll-to-change-slice behavior.
  const zoomBy = useCallback((direction: 1 | -1) => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    const currentZoom = nv.scene.pan2Dxyzmm[3]
    let newZoom = currentZoom * (1 + 10 * (0.01 * direction))
    newZoom = Math.max(0.1, Math.round(newZoom * 10) / 10)
    const zoomChange = currentZoom - newZoom
    const mm = nv.frac2mm(nv.scene.crosshairPos)
    nv.scene.pan2Dxyzmm[0] += zoomChange * mm[0]
    nv.scene.pan2Dxyzmm[1] += zoomChange * mm[1]
    nv.scene.pan2Dxyzmm[2] += zoomChange * mm[2]
    nv.scene.pan2Dxyzmm[3] = newZoom
    nv.drawScene()
  }, [])

  const zoomIn = useCallback(() => zoomBy(1), [zoomBy])
  const zoomOut = useCallback(() => zoomBy(-1), [zoomBy])
  const resetZoom = useCallback(() => {
    const nv = nvRef.current
    if (!nv) return
    nv.scene.pan2Dxyzmm = [0, 0, 0, 1]
    nv.drawScene()
  }, [])

  return {
    canvasRef,
    ready,
    busy,
    error,
    baseVolume,
    segmentations,
    crosshair,
    crosshairVisible,
    setCrosshairVisible,
    library,
    refreshLibrary,
    uploadAndLoadVolume,
    uploadAndLoadSegmentation,
    loadFromLibrary,
    removeFromLibrary,
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
    zoomIn,
    zoomOut,
    resetZoom,
    clearAll
  }
}
