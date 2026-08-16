export interface BaseVolumeInfo {
  id: string
  name: string
  dataMin: number
  dataMax: number
  calMin: number
  calMax: number
}

export interface SegmentationLayer {
  id: string
  name: string
  color: string
  opacity: number
  visible: boolean
  labelCount: number
}

export interface CrosshairValue {
  name: string
  value: number
}

export interface CrosshairInfo {
  mm: [number, number, number]
  values: CrosshairValue[]
}
