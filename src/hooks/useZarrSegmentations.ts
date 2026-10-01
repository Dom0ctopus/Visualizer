import { useCallback, useRef, useState } from 'react'
import { realisticColor } from '../lib/realisticPalette'
import type { SegmentationRecord, SegmentState, ZarrLoadedSegmentation } from '../types'

/** 'slicer': each segment's color from its file. 'realistic': colors
 *  sampled from dissection photos, matched by tissue (realisticPalette.ts);
 *  segments it can't match keep their file color. */
export type ColorScheme = 'slicer' | 'realistic'

function schemeColor(scheme: ColorScheme, seg: Pick<SegmentState, 'name' | 'system' | 'sourceColor'>, fileName: string): [number, number, number] {
  if (scheme === 'realistic') return realisticColor(seg.name, seg.system, fileName)?.color ?? seg.sourceColor
  return seg.sourceColor
}

const DEFAULT_SEGMENT_OPACITY = 0.6

/**
 * Segment visibility/opacity state, as plain React state: the 2D panes
 * (useSegmentationOverlays.ts) and both 3D tabs read directly from it, so
 * there's nothing to rebuild on an edit.
 */
export function useZarrSegmentations() {
  const [segmentations, setSegmentations] = useState<ZarrLoadedSegmentation[]>([])
  const [colorScheme, setColorSchemeState] = useState<ColorScheme>('slicer')
  const colorSchemeRef = useRef<ColorScheme>('slicer')

  const loadSegmentationRecord = useCallback((record: SegmentationRecord) => {
    const allSegments = record.systems.flatMap((sys) => sys.segments.map((seg) => ({ ...seg, system: sys.name })))
    const segments: SegmentState[] = allSegments.map((seg) => ({
      key: `${seg.layer}:${seg.labelValue}`,
      system: seg.system,
      name: seg.name,
      labelValue: seg.labelValue,
      layer: seg.layer,
      color: schemeColor(colorSchemeRef.current, { name: seg.name, system: seg.system, sourceColor: seg.color }, record.name),
      sourceColor: seg.color,
      visible: true,
      opacity: DEFAULT_SEGMENT_OPACITY
    }))
    const loaded: ZarrLoadedSegmentation = {
      recordId: record.id,
      name: record.name,
      layerCount: record.layerCount,
      segments
    }
    setSegmentations((prev) => [...prev, loaded])
  }, [])

  const removeSegmentation = useCallback((recordId: string) => {
    setSegmentations((prev) => prev.filter((s) => s.recordId !== recordId))
  }, [])

  const setColorScheme = useCallback((scheme: ColorScheme) => {
    colorSchemeRef.current = scheme
    setColorSchemeState(scheme)
    setSegmentations((prev) =>
      prev.map((l) => ({ ...l, segments: l.segments.map((seg) => ({ ...seg, color: schemeColor(scheme, seg, l.name) })) }))
    )
  }, [])

  const clearAll = useCallback(() => {
    setSegmentations([])
  }, [])

  const updateSegments = useCallback(
    (recordId: string, predicate: (seg: SegmentState) => boolean, updater: (seg: SegmentState) => SegmentState) => {
      setSegmentations((prev) =>
        prev.map((l) => {
          if (l.recordId !== recordId) return l
          return { ...l, segments: l.segments.map((seg) => (predicate(seg) ? updater(seg) : seg)) }
        })
      )
    },
    []
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

  /** Several segments of one file at once (the tree's file and system rows
   *  while a search filter shows only some of their segments). */
  const setSegmentsVisible = useCallback(
    (recordId: string, keys: ReadonlySet<string>, visible: boolean) => {
      updateSegments(
        recordId,
        (s) => keys.has(s.key),
        (s) => ({ ...s, visible })
      )
    },
    [updateSegments]
  )

  const setSegmentsOpacity = useCallback(
    (recordId: string, keys: ReadonlySet<string>, opacity: number) => {
      updateSegments(
        recordId,
        (s) => keys.has(s.key),
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

  return {
    segmentations,
    loadSegmentationRecord,
    removeSegmentation,
    clearAll,
    setSegmentVisible,
    setSegmentOpacity,
    setSystemVisible,
    setSystemOpacity,
    setFileVisible,
    setSegmentsVisible,
    setSegmentsOpacity,
    setFileOpacity,
    colorScheme,
    setColorScheme
  }
}
