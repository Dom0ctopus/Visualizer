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

/** State of the background NRRD -> OME-Zarr multiscale conversion the server
 *  runs on upload, for the itk-vtk-viewer engine -- see the server's
 *  zarrConvert.ts. Absent means conversion hasn't been attempted (e.g. an
 *  upload from before this existed). */
export type ZarrStatus = 'pending' | 'ready' | 'failed'

export interface VolumeRecord extends LibraryRecordBase {
  kind: 'volume'
  zarrStatus?: ZarrStatus
  zarrError?: string
}

export interface SegmentationRecord extends LibraryRecordBase {
  kind: 'segmentation'
  dimension: number
  layerCount: number
  systems: SystemInfo[]
  /** State of the background NRRD -> per-layer OME-Zarr label-map
   *  conversion the server runs on upload, for the itk-vtk-viewer engine --
   *  see the server's segmentationZarrConvert.ts. */
  zarrStatus?: ZarrStatus
  zarrError?: string
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

export function groupByLayer(segments: SegmentState[]): Map<number, SegmentState[]> {
  const map = new Map<number, SegmentState[]>()
  for (const seg of segments) {
    const list = map.get(seg.layer) ?? []
    list.push(seg)
    map.set(seg.layer, list)
  }
  return map
}

/**
 * The itk-vtk-viewer engine's own loaded-segmentation state -- deliberately
 * lighter than niivue's LoadedSegmentation (no per-bucket niivue volume ids,
 * since this engine's rendering isn't niivue-based): the slice pane
 * composites segment colors directly from `segments` itself (see
 * useSegmentationOverlays.ts), and the 3D pane drives itk-vtk-viewer's own
 * built-in labelImage overlay from the same state (see useItkVtkViewer.ts).
 */
export interface ZarrLoadedSegmentation {
  recordId: string
  name: string
  layerCount: number
  segments: SegmentState[]
}

export interface LoadedSegmentation {
  recordId: string
  name: string
  layerCount: number
  /**
   * niivue volume id for each (layer, opacity-percent-bucket) pair in use, keyed
   * as `${layer}:${bucket}` where bucket is an integer 1-100. Segments sharing a
   * layer and rounded opacity are packed into one volume so that niivue's
   * per-volume `.opacity` (which blends correctly) can drive the visible
   * transparency -- colormapLabel's own alpha channel does not support analog
   * blending in the 3D renderer.
   *
   * The 2D slice views and the 3D render are separate niivue engines (so their
   * contrast/transfer-function settings can't cross-affect each other -- see
   * useNiivue), each holding its own copy of these bucket volumes.
   */
  volumeIdsByBucket2d: Record<string, string>
  volumeIdsByBucket3d: Record<string, string>
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
