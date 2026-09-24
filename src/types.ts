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
  /** Surface-mesh generation for the 3D "Surface meshes" tab -- see the
   *  server's surfaceMesh.ts. */
  meshStatus?: ZarrStatus
  meshError?: string
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
  /** Displayed color (0-255), per the active color scheme. */
  color: [number, number, number]
  /** The color from the segmentation file (3D Slicer). */
  sourceColor: [number, number, number]
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
 * A loaded segmentation's runtime state: the 2D panes composite segment
 * colors directly from `segments` (see useSegmentationOverlays.ts), and both
 * 3D tabs (merged voxel label image, surface meshes) drive visibility/opacity
 * from the same state.
 */
export interface ZarrLoadedSegmentation {
  recordId: string
  name: string
  layerCount: number
  segments: SegmentState[]
}
