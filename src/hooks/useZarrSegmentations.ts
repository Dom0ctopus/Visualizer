import { useCallback, useState } from 'react'
import type { SegmentationRecord, SegmentState, ZarrLoadedSegmentation } from '../types'

const DEFAULT_SEGMENT_OPACITY = 0.6

/**
 * Segment visibility/opacity state, as plain React state: the 2D panes
 * (useSegmentationOverlays.ts) and both 3D tabs read directly from it, so
 * there's nothing to rebuild on an edit.
 */
export function useZarrSegmentations() {
  const [segmentations, setSegmentations] = useState<ZarrLoadedSegmentation[]>([])

  const loadSegmentationRecord = useCallback((record: SegmentationRecord) => {
    const allSegments = record.systems.flatMap((sys) => sys.segments.map((seg) => ({ ...seg, system: sys.name })))
    const segments: SegmentState[] = allSegments.map((seg) => ({
      key: `${seg.layer}:${seg.labelValue}`,
      system: seg.system,
      name: seg.name,
      labelValue: seg.labelValue,
      layer: seg.layer,
      color: seg.color,
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
    setFileOpacity
  }
}
