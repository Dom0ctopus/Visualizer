import { useCallback, useEffect, useRef, useState } from 'react'
import { cmapper, DRAG_MODE, Niivue, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import { deleteLibraryFile, fetchLibrary, fileUrl, uploadSegmentation, uploadVolume } from '../lib/api'
import { buildLutForLayer } from '../lib/segmentationLut'
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

const CTVOX_COLORMAP_NAME = 'ctvox-transfer-function'

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

const DEFAULT_SEGMENT_OPACITY = 0.6
const CROSSHAIR_WIDTH_VISIBLE = 0.6

// 2x2 grid with the 3D render pane top-right: coronal | render, axial | sagittal
const GAP = 0.006
const LAYOUT: Array<{ sliceType: SLICE_TYPE; position: [number, number, number, number] }> = [
  { sliceType: SLICE_TYPE.CORONAL, position: [0, 0, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.RENDER, position: [0.5 + GAP / 2, 0, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0.5 + GAP / 2, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.5 + GAP / 2, 0.5 + GAP / 2, 0.5 - GAP / 2, 0.5 - GAP / 2] }
]

function applyLayout(nv: Niivue): void {
  nv.setCustomLayout(LAYOUT)
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
      dragModePrimary: DRAG_MODE.crosshair
    })
    nvRef.current = nv

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

  const loadSegmentationRecord = useCallback(async (record: SegmentationRecord) => {
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

    const volumeIdsByLayer: Record<number, string> = {}
    for (const layer of layers) {
      const segmentsInLayer = segmentStates.filter((s) => s.layer === layer)
      const { lut, min, max } = buildLutForLayer(segmentsInLayer)
      const vol = await nv.addVolumeFromUrl({
        url: fileUrl(record.id),
        // Keep the real filename (and its extension) so niivue's format detection works;
        // layer identity is tracked separately via volumeIdsByLayer.
        name: record.name,
        frame4D: layer,
        opacity: 1,
        colormapLabel: { lut, min, max }
      })
      volumeIdsByLayer[layer] = vol.id
    }
    // Re-assert each volume's colormapLabel after all volumes are loaded and
    // force a redraw. Setting colormapLabel via addVolumeFromUrl's own options
    // doesn't reliably take effect on first paint (the same fix a visibility
    // toggle applies afterward, via rebuildLayerLut) — doing it here up front
    // avoids needing that extra toggle before colors render correctly.
    for (const layer of layers) {
      const idx = nv.volumes.findIndex((v) => v.id === volumeIdsByLayer[layer])
      if (idx < 0) continue
      const segmentsInLayer = segmentStates.filter((s) => s.layer === layer)
      nv.volumes[idx].colormapLabel = buildLutForLayer(segmentsInLayer)
    }
    nv.updateGLVolume()

    setSegmentations((prev) => [
      ...prev,
      { recordId: record.id, name: record.name, layerCount: record.layerCount, volumeIdsByLayer, segments: segmentStates }
    ])
  }, [])

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

  const rebuildLayerLut = useCallback((loaded: LoadedSegmentation, layer: number) => {
    const nv = nvRef.current
    if (!nv) return
    const volId = loaded.volumeIdsByLayer[layer]
    const idx = nv.volumes.findIndex((v) => v.id === volId)
    if (idx < 0) return
    const segmentsInLayer = loaded.segments.filter((s) => s.layer === layer)
    nv.volumes[idx].colormapLabel = buildLutForLayer(segmentsInLayer)
    nv.updateGLVolume()
  }, [])

  const updateSegments = useCallback(
    (recordId: string, predicate: (seg: SegmentState) => boolean, updater: (seg: SegmentState) => SegmentState) => {
      // The map callback below must stay pure -- React (in StrictMode) can invoke a
      // setState updater function more than once per commit. Rebuilding the LUT and
      // touching niivue's GL state is a real side effect, so it's captured here and
      // fired exactly once, after setSegmentations returns, rather than from inside
      // the updater itself.
      let changed: LoadedSegmentation | null = null
      const affectedLayers = new Set<number>()

      setSegmentations((prev) =>
        prev.map((loaded) => {
          if (loaded.recordId !== recordId) return loaded
          const segments = loaded.segments.map((seg) => {
            if (!predicate(seg)) return seg
            affectedLayers.add(seg.layer)
            return updater(seg)
          })
          const next = { ...loaded, segments }
          changed = next
          return next
        })
      )

      if (changed) {
        affectedLayers.forEach((layer) => rebuildLayerLut(changed!, layer))
      }
    },
    [rebuildLayerLut]
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
    setSegmentations((prev) => {
      const loaded = prev.find((s) => s.recordId === recordId)
      if (loaded) {
        for (const volId of Object.values(loaded.volumeIdsByLayer)) {
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
      const cmap = buildTransferFunctionColormap(tf)
      cmapper.addColormap(CTVOX_COLORMAP_NAME, cmap)
      nv.volumes[0].colormap = CTVOX_COLORMAP_NAME
      nv.updateGLVolume()
      setTransferFunctionActive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transfer function.')
    }
  }, [])

  const clearTransferFunction = useCallback(() => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    nv.volumes[0].colormap = 'gray'
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
    nv.updateGLVolume()
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
    clearAll
  }
}
