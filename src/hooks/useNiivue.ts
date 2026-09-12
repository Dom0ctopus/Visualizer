import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAG_MODE, Niivue, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import { deleteLibraryFile, fetchLibrary, fileUrl, uploadSegmentation, uploadVolume } from '../lib/api'
import { buildLutForBucket, opacityBucket } from '../lib/segmentationLut'
import { buildTransferFunctionColormap, parseCtvoxTransferFunction, type ParsedTransferFunction } from '../lib/transferFunction'
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

// The 2D engine's canvas covers the whole viewer area but only draws into 3 of the
// 4 visual quadrants -- the top-left is left blank so the 3D engine's own (smaller,
// absolutely-positioned) canvas can sit on top of it, giving the same 2x2 look as
// before while the two engines stay fully independent.
const GAP = 0.006
const LAYOUT_2D: Array<{ sliceType: SLICE_TYPE; position: [number, number, number, number] }> = [
  { sliceType: SLICE_TYPE.CORONAL, position: [0.5 + GAP / 2, 0, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0.5 + GAP / 2, 0.5 - GAP / 2, 0.5 - GAP / 2] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.5 + GAP / 2, 0.5 + GAP / 2, 0.5 - GAP / 2, 0.5 - GAP / 2] }
]
const LAYOUT_3D: Array<{ sliceType: SLICE_TYPE; position: [number, number, number, number] }> = [
  { sliceType: SLICE_TYPE.RENDER, position: [0, 0, 1, 1] }
]

function bucketKey(layer: number, bucket: number): string {
  return `${layer}:${bucket}`
}

export function useNiivue() {
  const canvas2dRef = useRef<HTMLCanvasElement | null>(null)
  // nv3d's real canvas -- kept off-screen (see index.css .viewer-3d-source) and
  // mirrored onto canvas3dDisplayRef below. Two simultaneously on-screen/composited
  // WebGL2 canvases from two independent Niivue instances corrupts unrelated regions
  // of the OTHER canvas under this environment's software (SwiftShader) GL renderer
  // (confirmed directly: the 2D engine's axial tile renders solid black purely from
  // the 3D engine's canvas being visible on-screen elsewhere on the page, regardless
  // of whether their positions actually overlap) -- moving the real 3D canvas
  // off-screen (so the browser only ever composites one on-screen WebGL canvas at a
  // time) reproducibly fixes it.
  const canvas3dRef = useRef<HTMLCanvasElement | null>(null)
  // Plain 2D canvas, visually positioned where the 3D inset appears -- continuously
  // repainted from canvas3dRef's (off-screen) real canvas via drawImage, and the
  // target of forwarded pointer/wheel events so orbit/zoom/reset still work.
  const canvas3dDisplayRef = useRef<HTMLCanvasElement | null>(null)
  const nv2dRef = useRef<Niivue | null>(null)
  const nv3dRef = useRef<Niivue | null>(null)
  const blitRafRef = useRef<number | null>(null)

  const [ready, setReady] = useState(false)
  // Window/level info for the 2D slice engine.
  const [baseVolume, setBaseVolume] = useState<BaseVolumeInfo | null>(null)
  // Window/level info for the 3D render engine -- independent of the slices, and
  // what the transfer function's floor/ceiling anchor against.
  const [renderVolume, setRenderVolume] = useState<BaseVolumeInfo | null>(null)
  const [segmentations, setSegmentations] = useState<LoadedSegmentation[]>([])
  const [crosshair, setCrosshair] = useState<CrosshairInfo | null>(null)
  const [crosshairVisible, setCrosshairVisibleState] = useState(false)
  const [library, setLibrary] = useState<LibraryRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [transferFunctionActive, setTransferFunctionActive] = useState(false)
  // The active transfer function's curve data, kept around so the 3D window/level
  // sliders can re-bake it against new cal_min/cal_max live -- otherwise the curve's
  // domain is frozen at whatever the window happened to be when the .tf file was
  // loaded, leaving no way to interactively push the floor above a noisy background.
  const activeTransferFunctionRef = useRef<ParsedTransferFunction | null>(null)

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
    const nv2d = new Niivue({
      backColor: [0.07, 0.08, 0.1, 1],
      show3Dcrosshair: false,
      crosshairWidth: 0,
      isColorbar: false,
      isOrientCube: false,
      isRadiologicalConvention: false,
      multiplanarPadPixels: 2,
      multiplanarShowRender: SHOW_RENDER.NEVER,
      dragAndDropEnabled: true,
      // Click-drag-to-window (dragMode: contrast) was inconsistent in practice --
      // window/level is set via explicit min/max sliders instead (see VolumePanel).
      dragMode: DRAG_MODE.none,
      dragModePrimary: DRAG_MODE.crosshair,
      forceDevicePixelRatio: -1
    })
    const nv3d = new Niivue({
      backColor: [0.07, 0.08, 0.1, 1],
      isColorbar: false,
      isOrientCube: false,
      dragAndDropEnabled: false,
      // Retina/HiDPI displays otherwise render at 2x+ pixel density, which multiplies
      // the 3D view's per-frame ray-marching cost accordingly; forcing 1x keeps
      // interactive rotation responsive at a barely-noticeable sharpness cost.
      forceDevicePixelRatio: -1
    })
    nv2dRef.current = nv2d
    nv3dRef.current = nv3d
    if (import.meta.env.DEV) {
      ;(window as unknown as { __nv2d: Niivue; __nv3d: Niivue }).__nv2d = nv2d
      ;(window as unknown as { __nv2d: Niivue; __nv3d: Niivue }).__nv3d = nv3d
    }

    nv2d.onLocationChange = (data: unknown) => {
      const loc = data as { mm?: number[]; values?: Array<{ name: string; value: number }> }
      if (!loc.mm) return
      setCrosshair({
        mm: [round(loc.mm[0] ?? 0), round(loc.mm[1] ?? 0), round(loc.mm[2] ?? 0)],
        values: (loc.values ?? []).map((v) => ({ name: v.name, value: v.value }))
      })
    }

    // Fires whenever niivue changes cal_min/cal_max on its own (e.g. a double-click
    // reset). Syncs the displayed window -- the sliders call setSliceWindowLevel
    // directly and don't depend on this.
    nv2d.onIntensityChange = (volume) => {
      setBaseVolume((prev) => (prev ? { ...prev, calMin: volume.cal_min ?? prev.calMin, calMax: volume.cal_max ?? prev.calMax } : prev))
    }

    let attached = 0
    const onOneAttached = () => {
      attached++
      if (attached === 2) setReady(true)
    }

    if (canvas2dRef.current) {
      nv2d.attachToCanvas(canvas2dRef.current).then(() => {
        nv2d.setCustomLayout(LAYOUT_2D)
        onOneAttached()
      })
    }

    // niivue's own event-forwarding cleanup functions, populated once the display
    // canvas is wired up below and torn down alongside the two engines.
    let removeForwardedEvents: (() => void) | null = null

    if (canvas3dRef.current) {
      // A canvas's WebGL2 context attributes are locked in on its first getContext()
      // call; niivue's own initGL() would otherwise create one without
      // preserveDrawingBuffer, leaving the backbuffer cleared by the time the blit
      // loop below tries to read it each frame.
      const isAntiAlias = navigator.hardwareConcurrency > 6
      canvas3dRef.current.getContext('webgl2', { alpha: true, antialias: isAntiAlias, preserveDrawingBuffer: true })
      nv3d.attachToCanvas(canvas3dRef.current).then(() => {
        nv3d.setCustomLayout(LAYOUT_3D)
        onOneAttached()

        const real = canvas3dRef.current
        const display = canvas3dDisplayRef.current
        if (real && display) {
          const displayCtx = display.getContext('2d')
          if (displayCtx) {
            const tick = () => {
              if (display.width !== real.width || display.height !== real.height) {
                display.width = real.width
                display.height = real.height
              }
              displayCtx.drawImage(real, 0, 0)
              blitRafRef.current = requestAnimationFrame(tick)
            }
            blitRafRef.current = requestAnimationFrame(tick)
          }

          // The display canvas is what's actually on-screen/clickable, so orbit-drag,
          // scroll-zoom, and double-click-reset need their events relayed onto the
          // real (off-screen) canvas niivue is actually listening on, translated into
          // that canvas's own local coordinate space.
          const toRealCoords = (clientX: number, clientY: number) => {
            const displayRect = display.getBoundingClientRect()
            const realRect = real.getBoundingClientRect()
            const fx = (clientX - displayRect.left) / displayRect.width
            const fy = (clientY - displayRect.top) / displayRect.height
            return { clientX: realRect.left + fx * realRect.width, clientY: realRect.top + fy * realRect.height }
          }
          const forwardMouse = (type: string, e: MouseEvent) => {
            const { clientX, clientY } = toRealCoords(e.clientX, e.clientY)
            real.dispatchEvent(
              new MouseEvent(type, { clientX, clientY, button: e.button, buttons: e.buttons, bubbles: true, cancelable: true })
            )
          }
          const onPointerDown = (e: PointerEvent) => {
            display.setPointerCapture(e.pointerId)
            forwardMouse('mousedown', e)
          }
          const onPointerMove = (e: PointerEvent) => forwardMouse('mousemove', e)
          const onPointerUp = (e: PointerEvent) => {
            forwardMouse('mouseup', e)
            if (display.hasPointerCapture(e.pointerId)) display.releasePointerCapture(e.pointerId)
          }
          const onDblClick = (e: MouseEvent) => forwardMouse('dblclick', e)
          const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const { clientX, clientY } = toRealCoords(e.clientX, e.clientY)
            real.dispatchEvent(
              new WheelEvent('wheel', {
                clientX,
                clientY,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                deltaZ: e.deltaZ,
                deltaMode: e.deltaMode,
                bubbles: true,
                cancelable: true
              })
            )
          }
          const onContextMenu = (e: MouseEvent) => e.preventDefault()

          display.addEventListener('pointerdown', onPointerDown)
          display.addEventListener('pointermove', onPointerMove)
          display.addEventListener('pointerup', onPointerUp)
          display.addEventListener('dblclick', onDblClick)
          display.addEventListener('wheel', onWheel, { passive: false })
          display.addEventListener('contextmenu', onContextMenu)
          removeForwardedEvents = () => {
            display.removeEventListener('pointerdown', onPointerDown)
            display.removeEventListener('pointermove', onPointerMove)
            display.removeEventListener('pointerup', onPointerUp)
            display.removeEventListener('dblclick', onDblClick)
            display.removeEventListener('wheel', onWheel)
            display.removeEventListener('contextmenu', onContextMenu)
          }
        }
      })
    }

    refreshLibrary()

    // React StrictMode (dev only) mounts, cleans up, then remounts this effect --
    // without actually tearing down each Niivue instance's event listeners here,
    // the discarded first pair stays fully attached to the same canvases alongside
    // the second pair (confirmed directly: NIIVUE VERSION logged 4 times for what
    // should be 2 instances), leaving duplicate render loops and mouse handlers
    // competing over the same canvas elements.
    return () => {
      if (blitRafRef.current !== null) cancelAnimationFrame(blitRafRef.current)
      blitRafRef.current = null
      removeForwardedEvents?.()
      nv2d.cleanup()
      nv3d.cleanup()
      nv2dRef.current = null
      nv3dRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearAll = useCallback(() => {
    const nv2d = nv2dRef.current
    const nv3d = nv3dRef.current
    if (!nv2d || !nv3d) return
    while (nv2d.volumes.length > 0) {
      nv2d.removeVolume(nv2d.volumes[nv2d.volumes.length - 1])
    }
    while (nv3d.volumes.length > 0) {
      nv3d.removeVolume(nv3d.volumes[nv3d.volumes.length - 1])
    }
    setBaseVolume(null)
    setRenderVolume(null)
    setSegmentations([])
    setCrosshair(null)
    setError(null)
    activeTransferFunctionRef.current = null
    setTransferFunctionActive(false)
  }, [])

  const loadVolumeRecord = useCallback(
    async (record: VolumeRecord) => {
      const nv2d = nv2dRef.current
      const nv3d = nv3dRef.current
      if (!nv2d || !nv3d) return
      clearAll()
      const [vol2d, vol3d] = await Promise.all([
        nv2d.addVolumeFromUrl({ url: fileUrl(record.id), name: record.name, colormap: 'gray' }),
        nv3d.addVolumeFromUrl({ url: fileUrl(record.id), name: record.name, colormap: 'gray' })
      ])
      // Default the window to the volume's full observed range rather than niivue's
      // own auto-window (a robust/percentile estimate) -- for a scan dominated by
      // background, that auto-window can clip the max well below the data's actual
      // bright/dense material (observed directly: max landing at 167 against a real
      // max of 255), hiding real structure by default.
      const dataMin2d = vol2d.global_min ?? vol2d.cal_min ?? 0
      const dataMax2d = vol2d.global_max ?? vol2d.cal_max ?? 0
      vol2d.cal_min = dataMin2d
      vol2d.cal_max = dataMax2d
      setBaseVolume({ id: vol2d.id, name: record.name, dataMin: dataMin2d, dataMax: dataMax2d, calMin: dataMin2d, calMax: dataMax2d })

      const dataMin3d = vol3d.global_min ?? vol3d.cal_min ?? 0
      const dataMax3d = vol3d.global_max ?? vol3d.cal_max ?? 0
      vol3d.cal_min = dataMin3d
      vol3d.cal_max = dataMax3d
      setRenderVolume({ id: vol3d.id, name: record.name, dataMin: dataMin3d, dataMax: dataMax3d, calMin: dataMin3d, calMax: dataMax3d })

      nv2d.updateGLVolume()
      nv3d.updateGLVolume()
    },
    [clearAll]
  )

  // Segments sharing a layer and an opacity value (rounded to the nearest percent)
  // are packed into one niivue volume, using that volume's own `.opacity` property
  // to drive visible transparency. colormapLabel's alpha channel only supports
  // binary/edge-anti-aliasing visibility in niivue's 3D renderer, not analog
  // blending, so it is used here for color + per-label masking only (always at
  // full alpha for included labels).
  const rebuildLayerVolumesForEngine = useCallback(
    async (
      nv: Niivue,
      loaded: LoadedSegmentation,
      layer: number,
      volumeIdsByBucket: Record<string, string>
    ): Promise<Record<string, string>> => {
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
        const existingId = volumeIdsByBucket[key]
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

      for (const [key, volId] of Object.entries(volumeIdsByBucket)) {
        if (!key.startsWith(`${layer}:`) || key in result) continue
        const idx = nv.volumes.findIndex((v) => v.id === volId)
        if (idx >= 0) nv.removeVolumeByIndex(idx)
      }

      nv.updateGLVolume()
      return result
    },
    []
  )

  // Rebuilds one layer's bucket volumes in both the 2D and 3D engines (each holds
  // its own independent copy), returning the updated id maps for each.
  const rebuildLayerVolumesBoth = useCallback(
    async (
      loaded: LoadedSegmentation,
      layer: number
    ): Promise<{ ids2d: Record<string, string>; ids3d: Record<string, string> }> => {
      const nv2d = nv2dRef.current
      const nv3d = nv3dRef.current
      const [ids2d, ids3d] = await Promise.all([
        nv2d ? rebuildLayerVolumesForEngine(nv2d, loaded, layer, loaded.volumeIdsByBucket2d) : Promise.resolve({}),
        nv3d ? rebuildLayerVolumesForEngine(nv3d, loaded, layer, loaded.volumeIdsByBucket3d) : Promise.resolve({})
      ])
      return { ids2d, ids3d }
    },
    [rebuildLayerVolumesForEngine]
  )

  const loadSegmentationRecord = useCallback(
    async (record: SegmentationRecord) => {
      const nv2d = nv2dRef.current
      const nv3d = nv3dRef.current
      if (!nv2d || !nv3d) return

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
        volumeIdsByBucket2d: {},
        volumeIdsByBucket3d: {},
        segments: segmentStates
      }

      for (const layer of layers) {
        const { ids2d, ids3d } = await rebuildLayerVolumesBoth(loaded, layer)
        loaded = {
          ...loaded,
          volumeIdsByBucket2d: { ...loaded.volumeIdsByBucket2d, ...ids2d },
          volumeIdsByBucket3d: { ...loaded.volumeIdsByBucket3d, ...ids3d }
        }
      }

      setSegmentations((prev) => [...prev, loaded])
    },
    [rebuildLayerVolumesBoth]
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
      if (!nv2dRef.current || !nv3dRef.current) return
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

          let volumeIdsByBucket2d = loaded.volumeIdsByBucket2d
          let volumeIdsByBucket3d = loaded.volumeIdsByBucket3d
          for (const layer of layers) {
            const { ids2d, ids3d } = await rebuildLayerVolumesBoth(
              { ...loaded, volumeIdsByBucket2d, volumeIdsByBucket3d },
              layer
            )
            volumeIdsByBucket2d = { ...volumeIdsByBucket2d }
            volumeIdsByBucket3d = { ...volumeIdsByBucket3d }
            for (const key of Object.keys(volumeIdsByBucket2d)) {
              if (key.startsWith(`${layer}:`)) delete volumeIdsByBucket2d[key]
            }
            for (const key of Object.keys(volumeIdsByBucket3d)) {
              if (key.startsWith(`${layer}:`)) delete volumeIdsByBucket3d[key]
            }
            volumeIdsByBucket2d = { ...volumeIdsByBucket2d, ...ids2d }
            volumeIdsByBucket3d = { ...volumeIdsByBucket3d, ...ids3d }
          }

          const finalIds2d = volumeIdsByBucket2d
          const finalIds3d = volumeIdsByBucket3d
          segmentationsRef.current = segmentationsRef.current.map((l) =>
            l.recordId === recordId ? { ...l, volumeIdsByBucket2d: finalIds2d, volumeIdsByBucket3d: finalIds3d } : l
          )
          setSegmentations((prev) =>
            prev.map((l) => (l.recordId === recordId ? { ...l, volumeIdsByBucket2d: finalIds2d, volumeIdsByBucket3d: finalIds3d } : l))
          )
        }
      } finally {
        rebuildInFlightRef.current.delete(recordId)
        if (rebuildQueuedRef.current.delete(recordId)) {
          void runRebuild(recordId)
        }
      }
    },
    [rebuildLayerVolumesBoth]
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
    const nv2d = nv2dRef.current
    const nv3d = nv3dRef.current
    if (!nv2d || !nv3d) return
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
        for (const volId of Object.values(loaded.volumeIdsByBucket2d)) {
          const idx = nv2d.volumes.findIndex((v) => v.id === volId)
          if (idx >= 0) nv2d.removeVolumeByIndex(idx)
        }
        for (const volId of Object.values(loaded.volumeIdsByBucket3d)) {
          const idx = nv3d.volumes.findIndex((v) => v.id === volId)
          if (idx >= 0) nv3d.removeVolumeByIndex(idx)
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

  // Floor is the render window's minimum (cal_min), so background the user has
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
  const applyActiveTransferFunction = useCallback(() => {
    const nv3d = nv3dRef.current
    const tf = activeTransferFunctionRef.current
    if (!nv3d || !tf || nv3d.volumes.length === 0) return
    const vol = nv3d.volumes[0]
    const dataMin = vol.cal_min ?? vol.global_min ?? 0
    const dataMax = Math.max(vol.global_max ?? vol.cal_max ?? 255, dataMin + 1)
    vol.colormapLabel = buildTransferFunctionColormap(tf, dataMin, dataMax)
    nv3d.updateGLVolume()
  }, [])

  const setSliceWindowLevel = useCallback((calMin: number, calMax: number) => {
    const nv2d = nv2dRef.current
    if (!nv2d || nv2d.volumes.length === 0) return
    const vol = nv2d.volumes[0]
    vol.cal_min = calMin
    vol.cal_max = calMax
    nv2d.updateGLVolume()
    setBaseVolume((prev) => (prev ? { ...prev, calMin, calMax } : prev))
  }, [])

  const resetSliceWindowLevel = useCallback(() => {
    const nv2d = nv2dRef.current
    if (!nv2d || nv2d.volumes.length === 0) return
    const vol = nv2d.volumes[0]
    // Reset to the volume's full observed range, matching the load-time default --
    // not niivue's own robust auto-window, which can clip well below the data's
    // actual bright/dense material for a scan dominated by background.
    setSliceWindowLevel(vol.global_min ?? 0, vol.global_max ?? 0)
  }, [setSliceWindowLevel])

  const setRenderWindowLevel = useCallback(
    (calMin: number, calMax: number) => {
      const nv3d = nv3dRef.current
      if (!nv3d || nv3d.volumes.length === 0) return
      const vol = nv3d.volumes[0]
      vol.cal_min = calMin
      vol.cal_max = calMax
      // Re-bake the active transfer function (if any) against the new window --
      // otherwise the curve's domain stays frozen at whatever it was when the .tf
      // file was loaded, leaving no way to interactively push the floor above a
      // noisy background.
      applyActiveTransferFunction()
      nv3d.updateGLVolume()
      setRenderVolume((prev) => (prev ? { ...prev, calMin, calMax } : prev))
    },
    [applyActiveTransferFunction]
  )

  const resetRenderWindowLevel = useCallback(() => {
    const nv3d = nv3dRef.current
    if (!nv3d || nv3d.volumes.length === 0) return
    const vol = nv3d.volumes[0]
    setRenderWindowLevel(vol.global_min ?? 0, vol.global_max ?? 0)
  }, [setRenderWindowLevel])

  const loadTransferFunction = useCallback(
    async (file: File) => {
      const nv3d = nv3dRef.current
      if (!nv3d || nv3d.volumes.length === 0) return
      setError(null)
      try {
        const buffer = await file.arrayBuffer()
        const tf = parseCtvoxTransferFunction(buffer)
        activeTransferFunctionRef.current = tf
        applyActiveTransferFunction()
        setTransferFunctionActive(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load transfer function.')
      }
    },
    [applyActiveTransferFunction]
  )

  const clearTransferFunction = useCallback(() => {
    const nv3d = nv3dRef.current
    if (!nv3d || nv3d.volumes.length === 0) return
    activeTransferFunctionRef.current = null
    nv3d.volumes[0].colormapLabel = null
    nv3d.updateGLVolume()
    setTransferFunctionActive(false)
  }, [])

  const setCrosshairVisible = useCallback((visible: boolean) => {
    const nv2d = nv2dRef.current
    if (!nv2d) return
    nv2d.opts.crosshairWidth = visible ? CROSSHAIR_WIDTH_VISIBLE : 0
    nv2d.drawScene()
    setCrosshairVisibleState(visible)
  }, [])

  const resetView = useCallback(() => {
    const nv2d = nv2dRef.current
    const nv3d = nv3dRef.current
    if (!nv2d || !nv3d) return
    nv2d.setCustomLayout(LAYOUT_2D)
    // Snap 2D pan/zoom back to niivue's defaults, in case the user has scrolled
    // themselves somewhere disorienting.
    nv2d.scene.pan2Dxyzmm = [0, 0, 0, 1]
    nv2d.updateGLVolume()

    nv3d.setCustomLayout(LAYOUT_3D)
    nv3d.scene.volScaleMultiplier = 1.0
    nv3d.setRenderAzimuthElevation(DEFAULT_RENDER_AZIMUTH, DEFAULT_RENDER_ELEVATION)
    nv3d.updateGLVolume()
  }, [])

  // Mirrors niivue's own internal wheel-zoom math (WheelController.calculateZoom /
  // calculatePanOffsetAfterZoom) so the buttons below feel identical to scroll-zoom,
  // without touching niivue's default scroll-to-change-slice behavior.
  const zoomBy = useCallback((direction: 1 | -1) => {
    const nv2d = nv2dRef.current
    if (!nv2d || nv2d.volumes.length === 0) return
    const currentZoom = nv2d.scene.pan2Dxyzmm[3]
    let newZoom = currentZoom * (1 + 10 * (0.01 * direction))
    newZoom = Math.max(0.1, Math.round(newZoom * 10) / 10)
    const zoomChange = currentZoom - newZoom
    const mm = nv2d.frac2mm(nv2d.scene.crosshairPos)
    nv2d.scene.pan2Dxyzmm[0] += zoomChange * mm[0]
    nv2d.scene.pan2Dxyzmm[1] += zoomChange * mm[1]
    nv2d.scene.pan2Dxyzmm[2] += zoomChange * mm[2]
    nv2d.scene.pan2Dxyzmm[3] = newZoom
    nv2d.drawScene()
  }, [])

  const zoomIn = useCallback(() => zoomBy(1), [zoomBy])
  const zoomOut = useCallback(() => zoomBy(-1), [zoomBy])
  const resetZoom = useCallback(() => {
    const nv2d = nv2dRef.current
    if (!nv2d) return
    nv2d.scene.pan2Dxyzmm = [0, 0, 0, 1]
    nv2d.drawScene()
  }, [])

  return {
    canvas2dRef,
    canvas3dRef,
    canvas3dDisplayRef,
    ready,
    busy,
    error,
    baseVolume,
    renderVolume,
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
    setSliceWindowLevel,
    resetSliceWindowLevel,
    setRenderWindowLevel,
    resetRenderWindowLevel,
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
