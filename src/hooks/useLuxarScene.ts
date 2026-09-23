import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLuxarScene, fetchLuxarStatus, type LuxarSceneStatus, type LuxarStatus } from '../lib/api'

const STATUS_RECHECK_MS = 15_000
const SCENE_POLL_MS = 2000

/** Whether the server can build Luxar scenes. Re-checked while it can't, so
 *  running `npm run setup:luxar` shows up without a reload. */
export function useLuxarStatus(): LuxarStatus | null {
  const [status, setStatus] = useState<LuxarStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer = 0
    const check = async () => {
      try {
        const s = await fetchLuxarStatus()
        if (cancelled) return
        setStatus(s)
        if (!s.available || !s.gsplats) timer = window.setTimeout(check, STATUS_RECHECK_MS)
      } catch {
        if (!cancelled) timer = window.setTimeout(check, STATUS_RECHECK_MS)
      }
    }
    void check()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])
  return status
}

/**
 * One Luxar scene's status. `requestKey` identifies the inputs (null
 * disables); whenever it changes, `request` is called to look the scene up
 * (or start it), and a pending scene is then polled until it settles.
 * `run` issues another request (e.g. build or rebuild) for the same inputs.
 */
export function useLuxarScene(requestKey: string | null, request: () => Promise<LuxarSceneStatus>) {
  const [scene, setScene] = useState<LuxarSceneStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const requestRef = useRef(request)
  requestRef.current = request

  const run = useCallback(async (fn?: () => Promise<LuxarSceneStatus>) => {
    const generation = generationRef.current
    try {
      const s = await (fn ?? requestRef.current)()
      if (generation === generationRef.current) {
        setScene(s)
        setError(null)
      }
    } catch (e) {
      if (generation === generationRef.current) setError(e instanceof Error ? e.message : 'Luxar request failed')
    }
  }, [])

  useEffect(() => {
    generationRef.current++
    setScene(null)
    setError(null)
    if (requestKey !== null) void run()
  }, [requestKey, run])

  const pendingKey = scene?.status === 'pending' ? scene.key : null
  useEffect(() => {
    if (!pendingKey) return
    const generation = generationRef.current
    const timer = window.setInterval(async () => {
      try {
        const s = await fetchLuxarScene(pendingKey)
        if (generation === generationRef.current) setScene(s)
      } catch {
        // Transient; the next tick retries.
      }
    }, SCENE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [pendingKey])

  return { scene, error, run }
}
