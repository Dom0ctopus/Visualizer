export interface SegmentInfo {
  name: string
  labelValue: number
  layer: number
  color: [number, number, number]
}

export interface SystemInfo {
  name: string
  segments: SegmentInfo[]
}

interface LibraryRecordBase {
  id: string
  name: string
  sizeBytes: number
  uploadedAt: string
}

export interface VolumeRecord extends LibraryRecordBase {
  kind: 'volume'
}

export interface SegmentationRecord extends LibraryRecordBase {
  kind: 'segmentation'
  dimension: number
  layerCount: number
  systems: SystemInfo[]
}

export type LibraryRecord = VolumeRecord | SegmentationRecord

/** Runtime state for one segment (a single label value within one layer of a segmentation file). */
export interface SegmentState {
  /** Stable identity within a loaded segmentation: `${layer}:${labelValue}`. */
  key: string
  system: string
  name: string
  labelValue: number
  layer: number
  color: [number, number, number]
  visible: boolean
  opacity: number
}

export interface SystemGroup {
  name: string
  segments: SegmentState[]
}

export function groupBySystem(segments: SegmentState[]): SystemGroup[] {
  const map = new Map<string, SegmentState[]>()
  for (const seg of segments) {
    const list = map.get(seg.system) ?? []
    list.push(seg)
    map.set(seg.system, list)
  }
  return [...map.entries()].map(([name, segs]) => ({ name, segments: segs }))
}

export interface LoadedSegmentation {
  recordId: string
  name: string
  layerCount: number
  /** niivue volume id for each distinct layer index present in this file. */
  volumeIdsByLayer: Record<number, string>
  segments: SegmentState[]
}

export interface BaseVolumeInfo {
  id: string
  name: string
  dataMin: number
  dataMax: number
  calMin: number
  calMax: number
}

export interface CrosshairValue {
  name: string
  value: number
}

export interface CrosshairInfo {
  mm: [number, number, number]
  values: CrosshairValue[]
}
