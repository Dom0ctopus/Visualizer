import { useEffect, useRef, useState } from 'react'
import { fetchSegmentationMergeStatus, mergeZarrUrl, requestSegmentationMerge, type MergedSegmentMapping } from '../lib/api'
import { groupByLayer, type ZarrLoadedSegmentation } from '../types'

const POLL_INTERVAL_MS = 1000

interface LayerKey {
  recordId: string
  layer: number
}

/**
 * Drives the itk-vtk-viewer 3D pane's single label-image slot from EVERY
 * loaded segmentation's EVERY layer combined ("cumulative" view), instead
 * of just the first loaded segmentation's first layer -- see the server's
 * segmentationMergeConvert.ts for why and how multiple, possibly
 * differently-resolved segmentation layers get combined into one image
 * itk-vtk-viewer can actually load.
 *
 * A merge is a real (potentially slow) server-side re-conversion, so this
 * only triggers one when the SET of loaded (segmentation, layer) pairs
 * actually changes -- not on every visibility/opacity edit, which stays
 * instant via itk-vtk-viewer's own per-label setLabelImageWeights, driven
 * from the label mapping the last successful merge returned.
 */
export function useSegmentationMerge3D(
  volumeId: string | null,
  segmentations: ZarrLoadedSegmentation[],
  loadLabelImageUrl: (url: string) => Promise<void>,
  setLabelWeights: (weights: Map<number, number>) => void,
  setLabelNames: (names: Map<number, string>) => void
) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'ready' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const mappingRef = useRef<MergedSegmentMapping[]>([])
  const layerOrderRef = useRef<LayerKey[]>([])
  const pollTimerRef = useRef<number | null>(null)
  const requestIdRef = useRef(0)

  // Stable key describing exactly which (segmentation, layer) pairs are
  // currently loaded, regardless of their visibility/opacity -- a merge
  // only needs rebuilding when THIS changes.
  const layerSetKey = segmentations
    .flatMap((seg) => [...groupByLayer(seg.segments).keys()].map((layer) => `${seg.recordId}:${layer}`))
    .sort()
    .join(',')

  useEffect(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (!volumeId || segmentations.length === 0) {
      setStatus('idle')
      setError(null)
      return
    }

    const requestId = ++requestIdRef.current
    let cancelled = false

    const layerOrder: LayerKey[] = []
    const layers = segmentations.flatMap((seg) => {
      const byLayer = groupByLayer(seg.segments)
      return [...byLayer.entries()].map(([layer, segs]) => {
        layerOrder.push({ recordId: seg.recordId, layer })
        return { segmentationId: seg.recordId, layer, labelValues: segs.map((s) => s.labelValue) }
      })
    })

    async function poll() {
      try {
        const result = await fetchSegmentationMergeStatus()
        if (cancelled || requestIdRef.current !== requestId) return
        if (result.status === 'pending') {
          pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS)
          return
        }
        if (result.status === 'ready') {
          mappingRef.current = result.mapping ?? []
          layerOrderRef.current = layerOrder
          setStatus('ready')
          setError(null)
          await loadLabelImageUrl(mergeZarrUrl())
        } else if (result.status === 'failed') {
          setStatus('failed')
          setError(result.error ?? 'Cumulative view failed to build')
        }
      } catch (e) {
        if (!cancelled && requestIdRef.current === requestId) {
          setStatus('failed')
          setError(e instanceof Error ? e.message : 'Failed to check cumulative view status')
        }
      }
    }

    setStatus('pending')
    setError(null)
    void (async () => {
      try {
        await requestSegmentationMerge(volumeId, layers)
        if (cancelled || requestIdRef.current !== requestId) return
        pollTimerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS)
      } catch (e) {
        if (!cancelled && requestIdRef.current === requestId) {
          setStatus('failed')
          setError(e instanceof Error ? e.message : 'Failed to start cumulative view')
        }
      }
    })()

    return () => {
      cancelled = true
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeId, layerSetKey])

  // Live weight/name updates whenever segment visibility/opacity/name state
  // changes -- cheap (no re-merge), using the last successful merge's own
  // mapping (mappingRef/layerOrderRef, refs rather than effect deps since
  // they're only ever written by the effect above, on a successful merge).
  useEffect(() => {
    if (status !== 'ready' || mappingRef.current.length === 0) return
    const weights = new Map<number, number>()
    const names = new Map<number, string>()
    for (const { globalLabelValue, layerIndex, originalLabelValue } of mappingRef.current) {
      const key = layerOrderRef.current[layerIndex]
      if (!key) continue
      const seg = segmentations.find((s) => s.recordId === key.recordId)
      const segment = seg?.segments.find((s) => s.layer === key.layer && s.labelValue === originalLabelValue)
      if (!segment) continue
      weights.set(globalLabelValue, segment.visible ? segment.opacity : 0)
      names.set(globalLabelValue, segment.name)
    }
    setLabelWeights(weights)
    setLabelNames(names)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, segmentations, setLabelWeights, setLabelNames])

  return { status, error }
}
