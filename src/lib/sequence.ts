/**
 * Video sequences: timed steps -- turning the view, holding, focusing a saved
 * focus list, clearing the focus, crop wipes, blend fades -- played back by
 * the clock, e.g. while recording. Each step starts when everything before
 * it has finished, or with the step before it ("with previous"), so steps
 * can overlap: turn the view while a focus fades in. Saved on the server
 * (server/src/savedItems.ts, which has the same types).
 */

type Vec3 = [number, number, number]

/** A vtk.js camera, enough to put the view back exactly. */
export interface CameraState {
  position: Vec3
  focalPoint: Vec3
  viewUp: Vec3
  viewAngle: number
  parallelScale: number
}

export interface FocusList {
  id: string
  name: string
  /** Segments, by lib/focus.ts's focusKey. */
  keys: string[]
}

export type StepKind = 'rotate' | 'hold' | 'focus' | 'clearFocus' | 'wipe' | 'blend'

export type SequenceStep = { id: string; withPrevious: boolean; seconds: number } & (
  | { kind: 'rotate'; degrees: number }
  | { kind: 'hold' }
  | { kind: 'focus'; listId: string; add: boolean }
  | { kind: 'clearFocus' }
  | { kind: 'wipe'; face: number; direction: 'in' | 'out' }
  | { kind: 'blend'; from: number; to: number }
)

export interface VideoSequence {
  id: string
  name: string
  /** The camera the sequence starts from; null: wherever the view is. */
  startView: CameraState | null
  steps: SequenceStep[]
}

/** A short random id (crypto.randomUUID needs a secure context, which a
 *  LAN address isn't). */
export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** The crop box's faces, as CropBoxOverlay numbers them. */
export const FACE_NAMES = ['−X', '+X', '−Y', '+Y', '−Z', '+Z']

export function newStep(kind: StepKind, lists: FocusList[]): SequenceStep {
  const base = { id: newId(), withPrevious: false }
  switch (kind) {
    case 'rotate':
      return { ...base, kind, degrees: 360, seconds: 12 }
    case 'hold':
      return { ...base, kind, seconds: 2 }
    case 'focus':
      return { ...base, kind, listId: lists[0]?.id ?? '', add: false, seconds: 3 }
    case 'clearFocus':
      return { ...base, kind, seconds: 3 }
    case 'wipe':
      return { ...base, kind, face: 5, direction: 'in', seconds: 6 }
    case 'blend':
      return { ...base, kind, from: 0.2, to: 0.9, seconds: 4 }
  }
}

/** When each step starts and ends (seconds from the start), and the total. */
export function schedule(steps: SequenceStep[]): { starts: number[]; ends: number[]; total: number } {
  const starts: number[] = []
  const ends: number[] = []
  let doneAt = 0 // when everything so far has finished
  steps.forEach((step, i) => {
    const start = step.withPrevious && i > 0 ? starts[i - 1] : doneAt
    starts.push(start)
    ends.push(start + step.seconds)
    doneAt = Math.max(doneAt, start + step.seconds)
  })
  return { starts, ends, total: doneAt }
}

/** The steps with every duration scaled so the whole runs `total` seconds. */
export function fitToLength(steps: SequenceStep[], total: number): SequenceStep[] {
  const current = schedule(steps).total
  if (current <= 0 || total <= 0) return steps
  const k = total / current
  return steps.map((s) => ({ ...s, seconds: Math.round(s.seconds * k * 10) / 10 }))
}

/** What playing a sequence does to the page. */
export interface SequenceActions {
  /** Sets up the start: the start view, no focus, a fresh crop box if the
   *  sequence wipes. */
  prepare: (sequence: VideoSequence) => Promise<void>
  /** Turns the view by `radians` like the turntable (and a sideways drag). */
  rotateBy: (radians: number) => void
  /** The label blend, set now (`final` on a step's last value). */
  setBlend: (blend: number, final: boolean) => void
  /** Focuses a saved list (or adds it), fading over `seconds`. */
  focus: (listId: string, add: boolean, seconds: number) => void
  clearFocus: (seconds: number) => void
  wipe: (face: number, direction: 'in' | 'out', seconds: number) => void
  /** Stops anything still running (a wipe, a fade) when playback is cut short. */
  stopAll: () => void
}

export interface Playback {
  stop: () => void
  /** Resolves when the sequence ends or is stopped (true: it ran to the end). */
  done: Promise<boolean>
}

/**
 * Plays a sequence by the clock: steps start on time and progress by
 * elapsed time, so a slow frame shows things further along rather than
 * slowing the video down. Ticks on a timer, not animation frames, like the
 * wipes and fades it drives.
 */
export function playSequence(sequence: VideoSequence, actions: SequenceActions, onProgress?: (seconds: number, total: number) => void): Playback {
  const { starts, total } = schedule(sequence.steps)
  let stopped = false
  let timer = 0
  let finish: (completed: boolean) => void = () => {}
  const done = new Promise<boolean>((resolve) => (finish = resolve))
  // Per step: started yet, and for gradual ones the progress applied so far.
  const started = sequence.steps.map(() => false)
  const applied = sequence.steps.map(() => 0)

  const tick = (t0: number) => {
    if (stopped) return
    const now = (performance.now() - t0) / 1000
    sequence.steps.forEach((step, i) => {
      if (now < starts[i]) return
      const progress = step.seconds > 0 ? Math.min(1, (now - starts[i]) / step.seconds) : 1
      if (!started[i]) {
        started[i] = true
        if (step.kind === 'focus') actions.focus(step.listId, step.add, step.seconds)
        else if (step.kind === 'clearFocus') actions.clearFocus(step.seconds)
        else if (step.kind === 'wipe') actions.wipe(step.face, step.direction, step.seconds)
      }
      if (step.kind === 'rotate' && applied[i] < 1) {
        actions.rotateBy((((progress - applied[i]) * step.degrees) / 180) * Math.PI)
        applied[i] = progress
      } else if (step.kind === 'blend' && applied[i] < 1) {
        actions.setBlend(step.from + (step.to - step.from) * progress, progress >= 1)
        applied[i] = progress
      }
    })
    onProgress?.(Math.min(now, total), total)
    if (now >= total) {
      stopped = true
      finish(true)
    } else timer = window.setTimeout(() => tick(t0), 16)
  }

  void actions.prepare(sequence).then(
    () => {
      if (stopped) return
      onProgress?.(0, total)
      tick(performance.now())
    },
    () => {
      stopped = true
      finish(false)
    }
  )
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      window.clearTimeout(timer)
      actions.stopAll()
      finish(false)
    },
    done
  }
}
