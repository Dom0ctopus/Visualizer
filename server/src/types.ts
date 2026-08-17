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

interface RecordCommon {
  id: string
  name: string
  storedFilename: string
  sizeBytes: number
  uploadedAt: string
}

export interface VolumeRecord extends RecordCommon {
  kind: 'volume'
}

export interface SegmentationRecord extends RecordCommon {
  kind: 'segmentation'
  dimension: number
  layerCount: number
  systems: SystemInfo[]
}

export type LibraryRecord = VolumeRecord | SegmentationRecord
