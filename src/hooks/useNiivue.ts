import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAG_MODE, Niivue, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import type { NVImage } from '@niivue/niivue'
import { buildSegmentationLut, paletteColorCss } from '../lib/segmentationColors'
import type { BaseVolumeInfo, CrosshairInfo, SegmentationLayer } from '../types'

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

export function useNiivue() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<Niivue | null>(null)

  const [ready, setReady] = useState(false)
  const [baseVolume, setBaseVolume] = useState<BaseVolumeInfo | null>(null)
  const [segmentations, setSegmentations] = useState<SegmentationLayer[]>([])
  const [crosshair, setCrosshair] = useState<CrosshairInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const nv = new Niivue({
      backColor: [0.07, 0.08, 0.1, 1],
      show3Dcrosshair: true,
      isColorbar: false,
      isOrientCube: false,
      isRadiologicalConvention: false,
      multiplanarPadPixels: 2,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      dragAndDropEnabled: true,
      dragMode: DRAG_MODE.contrast,
      dragModePrimary: DRAG_MODE.crosshair
    })
    nvRef.current = nv

    nv.onLocationChange = (data: unknown) => {
      const loc = data as { mm?: number[]; values?: Array<{ name: string; value: number }> }
      if (!loc.mm) return
      setCrosshair({
        mm: [round(loc.mm[0] ?? 0), round(loc.mm[1] ?? 0), round(loc.mm[2] ?? 0)],
        values: (loc.values ?? []).map((v) => ({ name: v.name, value: v.value }))
      })
    }

    if (canvasRef.current) {
      nv.attachToCanvas(canvasRef.current).then(() => {
        nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
        setReady(true)
      })
    }

    return () => {
      nvRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearAll = useCallback(() => {
    const nv = nvRef.current
    if (!nv) return
    while (nv.volumes.length > 0) {
      nv.removeVolume(nv.volumes[nv.volumes.length - 1] as NVImage)
    }
    setBaseVolume(null)
    setSegmentations([])
    setCrosshair(null)
    setError(null)
  }, [])

  const loadBaseVolume = useCallback(
    async (file: File) => {
      const nv = nvRef.current
      if (!nv) return
      setBusy(true)
      setError(null)
      try {
        clearAll()
        await nv.loadFromFile(file)
        const vol = nv.volumes[0]
        if (!vol) throw new Error('Volume failed to load')
        vol.colormap = 'gray'
        vol.opacity = 1
        nv.updateGLVolume()
        setBaseVolume({
          id: vol.id,
          name: file.name,
          dataMin: vol.global_min ?? vol.cal_min ?? 0,
          dataMax: vol.global_max ?? vol.cal_max ?? 0,
          calMin: vol.cal_min ?? 0,
          calMax: vol.cal_max ?? 0
        })
        nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load volume. Is this a valid NRRD file?')
      } finally {
        setBusy(false)
      }
    },
    [clearAll]
  )

  const addSegmentation = useCallback(
    async (file: File) => {
      const nv = nvRef.current
      if (!nv) return
      setBusy(true)
      setError(null)
      try {
        const beforeCount = nv.volumes.length
        await nv.loadFromFile(file)
        const vol = nv.volumes[nv.volumes.length - 1]
        if (!vol || nv.volumes.length === beforeCount) {
          throw new Error('Segmentation failed to load')
        }
        const maxLabel = Math.max(1, Math.round(vol.global_max ?? 1))
        const layerIndex = beforeCount - 1
        const { lut, min, max } = buildSegmentationLut(maxLabel, layerIndex)
        vol.colormapLabel = { lut, min, max } as NVImage['colormapLabel']
        vol.opacity = 0.6
        nv.updateGLVolume()
        setSegmentations((prev) => [
          ...prev,
          {
            id: vol.id,
            name: file.name,
            color: paletteColorCss(layerIndex),
            opacity: 0.6,
            visible: true,
            labelCount: maxLabel
          }
        ])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load segmentation. Is this a valid NRRD file?')
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const findVolumeIndex = useCallback((id: string) => {
    const nv = nvRef.current
    if (!nv) return -1
    return nv.volumes.findIndex((v) => v.id === id)
  }, [])

  const setSegmentationOpacity = useCallback(
    (id: string, opacity: number) => {
      const nv = nvRef.current
      if (!nv) return
      const idx = findVolumeIndex(id)
      if (idx < 0) return
      nv.setOpacity(idx, opacity)
      setSegmentations((prev) => prev.map((s) => (s.id === id ? { ...s, opacity, visible: opacity > 0 } : s)))
    },
    [findVolumeIndex]
  )

  const toggleSegmentationVisibility = useCallback(
    (id: string) => {
      const nv = nvRef.current
      if (!nv) return
      const idx = findVolumeIndex(id)
      if (idx < 0) return
      setSegmentations((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s
          const nextVisible = !s.visible
          nv.setOpacity(idx, nextVisible ? s.opacity : 0)
          return { ...s, visible: nextVisible }
        })
      )
    },
    [findVolumeIndex]
  )

  const removeSegmentation = useCallback(
    (id: string) => {
      const nv = nvRef.current
      if (!nv) return
      const idx = findVolumeIndex(id)
      if (idx < 0) return
      nv.removeVolumeByIndex(idx)
      setSegmentations((prev) => prev.filter((s) => s.id !== id))
    },
    [findVolumeIndex]
  )

  const setWindowLevel = useCallback((calMin: number, calMax: number) => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    const vol = nv.volumes[0]
    vol.cal_min = calMin
    vol.cal_max = calMax
    nv.updateGLVolume()
    setBaseVolume((prev) => (prev ? { ...prev, calMin, calMax } : prev))
  }, [])

  const resetWindowLevel = useCallback(() => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    const vol = nv.volumes[0]
    vol.calMinMax()
    setWindowLevel(vol.cal_min ?? 0, vol.cal_max ?? 0)
  }, [setWindowLevel])

  const resetView = useCallback(() => {
    const nv = nvRef.current
    if (!nv) return
    nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
    nv.updateGLVolume()
  }, [])

  return {
    canvasRef,
    ready,
    busy,
    error,
    baseVolume,
    segmentations,
    crosshair,
    loadBaseVolume,
    addSegmentation,
    setSegmentationOpacity,
    toggleSegmentationVisibility,
    removeSegmentation,
    setWindowLevel,
    resetWindowLevel,
    resetView,
    clearAll
  }
}
