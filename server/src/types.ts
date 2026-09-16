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

/** Conversion state of the background NRRD -> OME-Zarr multiscale conversion
 *  kicked off on upload, for the itk-vtk-viewer engine -- see zarrConvert.ts.
 *  Absent/undefined means conversion hasn't been attempted (e.g. an upload
 *  from before this existed). */
export type ZarrStatus = 'pending' | 'ready' | 'failed'

export interface VolumeRecord extends RecordCommon {
  kind: 'volume'
  zarrStatus?: ZarrStatus
  zarrError?: string
}

/** What's persisted to disk for a segmentation: no parsed metadata, so
 *  improvements to the parser/grouping logic apply to existing uploads
 *  without needing a re-upload. */
export interface StoredSegmentationRecord extends RecordCommon {
  kind: 'segmentation'
}

export type StoredRecord = VolumeRecord | StoredSegmentationRecord

/** What's sent over the wire: a stored segmentation record enriched with
 *  metadata freshly parsed from the source file on every request. */
export interface SegmentationRecord extends StoredSegmentationRecord {
  dimension: number
  layerCount: number
  systems: SystemInfo[]
}

export type LibraryRecord = VolumeRecord | SegmentationRecord
