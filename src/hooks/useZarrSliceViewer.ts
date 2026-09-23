import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_LEVEL_INDEX,
  fetchPyramidLevels,
  readCoronalSlice,
  readSagittalSlice,
  readZSlice,
  type PyramidLevel,
  type SliceResult
} from '../lib/zarrClient'

// Full type-range defaults (rather than scanning the volume for its actual
// min/max up front, which would mean downloading everything just to show a
// slider) -- narrow, real-valued data just starts with headroom on both
// ends of the window.
function naturalRangeFor(dtype: string): [number, number] {
  switch (dtype) {
    case '|u1':
      return [0, 255]
    case '|i1':
      return [-128, 127]
    case '<u2':
      return [0, 65535]
    case '<i2':
      return [-32768, 32767]
    case '<u4':
      return [0, 4294967295]
    case '<i4':
      return [-2147483648, 2147483647]
    case '<f4':
    case '<f8':
      return [0, 1]
    default:
      return [0, 255]
  }
}

// See the settle-timer comment inside each slice-fetch effect below for why
// this exists. Short enough to feel immediate for a single scroll step,
// long enough that a fast multi-step scroll only ever decodes the slice
// actually landed on.
const SLICE_SETTLE_DELAY_MS = 40

// How many native-resolution (level 0) Z slices to load on each side of the
// current position when "inspecting" -- see inspectNativeHere below.
const DEFAULT_INSPECT_RADIUS = 50

export interface DetailWindow {
  /** Z bounds (in level 0's own coordinates) the user can navigate within
   *  while inspecting -- native-resolution reads outside this range are
   *  never requested, so the cost of "drilling in" stays bounded to
   *  roughly 2*radius+1 slices regardless of how deep the full stack is. */
  zMin: number
  zMax: number
  /** Where to snap back to on exitDetailWindow(). */
  returnLevelIndex: number
  returnZIndex: number
}

type Axis = 'z' | 'y' | 'x'

/**
 * One settle-delayed fetch for a single plane -- see SLICE_SETTLE_DELAY_MS's
 * comment on useZarrSliceViewer for why the delay exists. A standalone hook
 * (module scope, not nested inside useZarrSliceViewer) called once per axis
 * below, each with its own timer/request-id pair, so a coronal scrub
 * in-flight fetch is never cancelled by an unrelated axial one.
 */
function useSliceEffect(
  axis: Axis,
  index: number,
  zarrUrl: string | null,
  currentLevel: PyramidLevel | null,
  read: (zarrUrl: string, levelPath: string, index: number) => Promise<SliceResult>,
  setSlice: (s: SliceResult | null) => void,
  setError: (e: string | null) => void,
  setLoading?: (l: boolean) => void
) {
  const timerRef = useRef<number | null>(null)
  const reqRef = useRef(0)
  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!zarrUrl || !currentLevel) return

    // A fast scroll fires many index changes in quick succession. Without a
    // settle delay, every intermediate one used to kick off its own
    // fetch+decode immediately -- the requestId guard below only discards
    // an already-finished *result*, it doesn't stop the decode work itself
    // from running to completion for every discarded frame. Only the index
    // actually settled on now triggers a fetch.
    const requestId = ++reqRef.current
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setLoading?.(true)
      read(zarrUrl, currentLevel.levelPath, index)
        .then((result) => {
          if (reqRef.current !== requestId) return
          setSlice(result)
          setError(null)
        })
        .catch((e) => {
          if (reqRef.current !== requestId) return
          setError(e instanceof Error ? e.message : `Failed to load ${axis} slice`)
        })
        .finally(() => {
          if (reqRef.current === requestId) setLoading?.(false)
        })
    }, SLICE_SETTLE_DELAY_MS)

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zarrUrl, currentLevel, index])
}

/**
 * Drives the custom, itk-vtk-viewer-free 3-plane (axial/coronal/sagittal)
 * slice display: reads 2D slices directly out of the same OME-Zarr store
 * (see src/lib/zarrClient.ts), sidestepping itk-vtk-viewer's use2D
 * slice-stepping path entirely -- that path hits a hard internal
 * voxel-count cap on scans this large and corrupts the display rather than
 * falling back gracefully (see the useItkVtkViewer.ts history for how that
 * was diagnosed).
 *
 * Starts at a downsampled pyramid level (see zarrClient.ts's
 * DEFAULT_LEVEL_INDEX) rather than true native resolution, for scrolling
 * responsiveness -- native per-slice reads had a real per-step latency
 * floor that persisted after ruling out every specific cause found (chunk
 * layout, cache growth, cloud-sync storage, Node's I/O thread pool size).
 * Rather than lose native detail entirely, this exposes every pyramid
 * level as a pickable "fly-through" resolution (setLevel) plus a way to
 * drill into native resolution for a bounded neighborhood around wherever
 * the user actually wants detail (inspectNativeHere) -- browse fast at a
 * coarse level, then zoom in only where it matters, at a cost proportional
 * to that neighborhood's size, not the whole stack. The 3D Volume pane is
 * unaffected either way, since it already auto-selects whichever level it
 * needs on its own.
 *
 * The detail window / native-resolution drill-in only applies to the axial
 * (Z) plane, matching the original latency investigation this was built
 * for -- a coronal or sagittal slice already needs one chunk fetch per Z
 * index regardless of level (see readCoronalSlice/readSagittalSlice's own
 * comments), so there's no equivalent "whole-stack" cost to bound there in
 * the same way.
 */
export function useZarrSliceViewer(zarrUrl: string | null) {
  const [levels, setLevels] = useState<PyramidLevel[] | null>(null)
  const [levelIndex, setLevelIndexState] = useState(DEFAULT_LEVEL_INDEX)
  const [zIndex, setZIndexState] = useState(0)
  const [yIndex, setYIndexState] = useState(0)
  const [xIndex, setXIndexState] = useState(0)
  const [detailWindow, setDetailWindow] = useState<DetailWindow | null>(null)
  const [axialSlice, setAxialSlice] = useState<SliceResult | null>(null)
  const [coronalSlice, setCoronalSlice] = useState<SliceResult | null>(null)
  const [sagittalSlice, setSagittalSlice] = useState<SliceResult | null>(null)
  const [windowMin, setWindowMin] = useState(0)
  const [windowMax, setWindowMax] = useState(255)
  const [dataRange, setDataRange] = useState<[number, number]>([0, 255])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mirrors of state read from inside callbacks (setZIndex/stepZIndex/
  // setLevel/inspectNativeHere) without depending on them in a way that'd
  // make those callbacks' identities change every render.
  const levelsRef = useRef<PyramidLevel[] | null>(null)
  const levelIndexRef = useRef(levelIndex)
  const zIndexRef = useRef(zIndex)
  const yIndexRef = useRef(yIndex)
  const xIndexRef = useRef(xIndex)
  const detailWindowRef = useRef<DetailWindow | null>(null)

  useEffect(() => {
    levelsRef.current = levels
  }, [levels])
  useEffect(() => {
    levelIndexRef.current = levelIndex
  }, [levelIndex])
  useEffect(() => {
    zIndexRef.current = zIndex
  }, [zIndex])
  useEffect(() => {
    yIndexRef.current = yIndex
  }, [yIndex])
  useEffect(() => {
    xIndexRef.current = xIndex
  }, [xIndex])
  useEffect(() => {
    detailWindowRef.current = detailWindow
  }, [detailWindow])

  const currentLevel = levels?.[Math.min(levelIndex, levels.length - 1)] ?? null

  useEffect(() => {
    setLevels(null)
    setLevelIndexState(DEFAULT_LEVEL_INDEX)
    setDetailWindow(null)
    setAxialSlice(null)
    setCoronalSlice(null)
    setSagittalSlice(null)
    setError(null)
    if (!zarrUrl) return
    let cancelled = false
    fetchPyramidLevels(zarrUrl)
      .then((ls) => {
        if (cancelled) return
        setLevels(ls)
        const initialIndex = Math.min(DEFAULT_LEVEL_INDEX, ls.length - 1)
        setLevelIndexState(initialIndex)
        const initial = ls[initialIndex]
        const range = naturalRangeFor(initial.dtype)
        setDataRange(range)
        setWindowMin(range[0])
        setWindowMax(range[1])
        setZIndexState(Math.floor(initial.size[0] / 2))
        setYIndexState(Math.floor(initial.size[1] / 2))
        setXIndexState(Math.floor(initial.size[2] / 2))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load volume info')
      })
    return () => {
      cancelled = true
    }
  }, [zarrUrl])

  // One settle-delayed fetch effect per plane -- see SLICE_SETTLE_DELAY_MS's
  // comment. Each plane scrolls independently (a coronal scrub shouldn't
  // cancel an in-flight axial fetch), so these can't share a single timer/
  // requestId the way a single-plane viewer could. Only the axial (Z) plane
  // drives the shared `loading` flag, matching its pre-existing meaning
  // (the detail-window/inspect UI only ever cared about Z).
  useSliceEffect('z', zIndex, zarrUrl, currentLevel, readZSlice, setAxialSlice, setError, setLoading)
  useSliceEffect('y', yIndex, zarrUrl, currentLevel, readCoronalSlice, setCoronalSlice, setError)
  useSliceEffect('x', xIndex, zarrUrl, currentLevel, readSagittalSlice, setSagittalSlice, setError)

  const clampIndex = useCallback((v: number, axis: Axis, levelIdx: number, window: DetailWindow | null) => {
    const ls = levelsRef.current
    const level = ls?.[Math.min(levelIdx, ls.length - 1)]
    const sizeAxis = axis === 'z' ? 0 : axis === 'y' ? 1 : 2
    const hardMax = level ? level.size[sizeAxis] - 1 : 0
    const lo = axis === 'z' && window && levelIdx === 0 ? Math.max(0, window.zMin) : 0
    const hi = axis === 'z' && window && levelIdx === 0 ? Math.min(hardMax, window.zMax) : hardMax
    return Math.min(hi, Math.max(lo, Math.round(v)))
  }, [])

  const clampZ = useCallback((z: number, levelIdx: number, window: DetailWindow | null) => clampIndex(z, 'z', levelIdx, window), [clampIndex])

  const setZIndex = useCallback(
    (z: number) => {
      setZIndexState(clampZ(z, levelIndexRef.current, detailWindowRef.current))
    },
    [clampZ]
  )

  const stepZIndex = useCallback(
    (delta: number) => {
      setZIndexState((prev) => clampZ(prev + delta, levelIndexRef.current, detailWindowRef.current))
    },
    [clampZ]
  )

  const setYIndex = useCallback(
    (y: number) => {
      setYIndexState(clampIndex(y, 'y', levelIndexRef.current, null))
    },
    [clampIndex]
  )

  const stepYIndex = useCallback(
    (delta: number) => {
      setYIndexState((prev) => clampIndex(prev + delta, 'y', levelIndexRef.current, null))
    },
    [clampIndex]
  )

  const setXIndex = useCallback(
    (x: number) => {
      setXIndexState(clampIndex(x, 'x', levelIndexRef.current, null))
    },
    [clampIndex]
  )

  const stepXIndex = useCallback(
    (delta: number) => {
      setXIndexState((prev) => clampIndex(prev + delta, 'x', levelIndexRef.current, null))
    },
    [clampIndex]
  )

  /** Switches the fly-through level, remapping the current position on all
   *  three axes proportionally so the view stays roughly centered on the
   *  same physical location. Exits any active (Z-only) detail window --
   *  deliberately picking a level manually means leaving inspection mode. */
  const setLevel = useCallback(
    (newIndex: number) => {
      const ls = levelsRef.current
      if (!ls) return
      const clampedIndex = Math.max(0, Math.min(ls.length - 1, newIndex))
      const oldLevel = ls[Math.min(levelIndexRef.current, ls.length - 1)]
      const newLevel = ls[clampedIndex]
      const factorRatio = oldLevel.downsampleFactor / newLevel.downsampleFactor
      setDetailWindow(null)
      setLevelIndexState(clampedIndex)
      setZIndexState(clampIndex(zIndexRef.current * factorRatio, 'z', clampedIndex, null))
      setYIndexState(clampIndex(yIndexRef.current * factorRatio, 'y', clampedIndex, null))
      setXIndexState(clampIndex(xIndexRef.current * factorRatio, 'x', clampedIndex, null))
    },
    [clampIndex]
  )

  /** Drills into native resolution (level 0) for a bounded neighborhood
   *  around the current Z position -- radius slices on each side, mapped
   *  from the current level's Z coordinate into level 0's. Reading is
   *  still one slice at a time (readZSlice), same as always; this only
   *  bounds which Z values the UI lets the user navigate to, so a native-
   *  resolution read is never requested outside that neighborhood. */
  const inspectNativeHere = useCallback(
    (radius: number = DEFAULT_INSPECT_RADIUS) => {
      const ls = levelsRef.current
      if (!ls || ls.length === 0) return
      const current = ls[Math.min(levelIndexRef.current, ls.length - 1)]
      const native = ls[0]
      const nativeZ = Math.round(zIndexRef.current * current.downsampleFactor)
      const zMin = Math.max(0, nativeZ - radius)
      const zMax = Math.min(native.size[0] - 1, nativeZ + radius)
      const window: DetailWindow = {
        zMin,
        zMax,
        returnLevelIndex: levelIndexRef.current,
        returnZIndex: zIndexRef.current
      }
      setDetailWindow(window)
      setLevelIndexState(0)
      setZIndexState(clampZ(nativeZ, 0, window))
    },
    [clampZ]
  )

  const exitDetailWindow = useCallback(() => {
    const window = detailWindowRef.current
    if (!window) return
    setDetailWindow(null)
    setLevelIndexState(window.returnLevelIndex)
    setZIndexState(clampZ(window.returnZIndex, window.returnLevelIndex, null))
  }, [clampZ])

  return {
    levels,
    levelIndex,
    volumeInfo: currentLevel,
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
    loading,
    error
  }
}
