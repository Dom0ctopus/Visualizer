import { useEffect, useLayoutEffect, useRef, type DependencyList } from 'react'

/**
 * Runs `run` whenever `deps` change, with at most one call in flight: changes
 * that arrive while a call is running collapse into a single follow-up using
 * the newest `run`. Every completed result is delivered in order, so a fast
 * scroll shows intermediate slices as quickly as they load instead of
 * waiting for input to pause (a debounce) or queueing up every step.
 *
 * `resetKey` identifies the data source (e.g. volume + pyramid level). When
 * it changes, or `run` is null, results still in flight are discarded
 * instead of delivered.
 */
export function useLatestAsync<T>(
  run: (() => Promise<T>) | null,
  deps: DependencyList,
  resetKey: string,
  onResult: (result: T) => void,
  onError: (error: unknown) => void
): void {
  const state = useRef({ inFlight: false, pending: null as (() => Promise<T>) | null, generation: 0, resetKey })
  const handlers = useRef({ onResult, onError })
  useLayoutEffect(() => {
    handlers.current = { onResult, onError }
  })

  useEffect(() => {
    const s = state.current
    if (s.resetKey !== resetKey || !run) {
      s.resetKey = resetKey
      s.generation++
      s.pending = null
    }
    if (!run) return
    const start = (job: () => Promise<T>) => {
      s.inFlight = true
      const generation = s.generation
      job()
        .then(
          (result) => {
            if (generation === s.generation) handlers.current.onResult(result)
          },
          (error) => {
            if (generation === s.generation) handlers.current.onError(error)
          }
        )
        .finally(() => {
          s.inFlight = false
          const next = s.pending
          s.pending = null
          if (next) start(next)
        })
    }
    if (s.inFlight) s.pending = run
    else start(run)
    // deps are supplied by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
