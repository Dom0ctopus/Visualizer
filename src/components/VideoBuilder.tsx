import { useEffect, useState } from 'react'
import {
  FACE_NAMES,
  fitToLength,
  newId,
  newStep,
  schedule,
  type CameraState,
  type FocusList,
  type SequenceStep,
  type StepKind,
  type VideoSequence
} from '../lib/sequence'

const STEP_LABELS: Record<StepKind, string> = {
  rotate: 'Rotate',
  hold: 'Hold',
  focus: 'Focus list',
  clearFocus: 'Clear focus',
  wipe: 'Crop wipe',
  blend: 'Blend fade'
}
const STEP_KINDS = Object.keys(STEP_LABELS) as StepKind[]

const blankSequence = (): VideoSequence => ({ id: newId(), name: 'New video', startView: null, steps: [] })

/** What's playing: where it's got to, and whether it's being recorded. */
export interface PlaybackState {
  seconds: number
  total: number
  recording: boolean
}

/**
 * Builds a video as a list of timed steps (lib/sequence.ts) -- turn the
 * view, hold, focus a saved list, clear the focus, crop wipes, blend fades,
 * each after the one before or alongside it -- and plays it, or records it.
 * Editors can save sequences; everyone can load and play them.
 */
export function VideoBuilder({
  editor,
  lists,
  sequences,
  onSave,
  onDelete,
  getCamera,
  onPlay,
  onStop,
  playback
}: {
  editor: boolean
  lists: FocusList[]
  sequences: VideoSequence[]
  onSave: (sequence: VideoSequence) => Promise<void>
  onDelete: (id: string) => Promise<void>
  getCamera: () => CameraState | null
  onPlay: (sequence: VideoSequence, record: boolean, fit: boolean) => void
  onStop: () => void
  playback: PlaybackState | null
}) {
  const [draft, setDraft] = useState<VideoSequence>(blankSequence)
  const [addKind, setAddKind] = useState<StepKind>('rotate')
  const [targetLength, setTargetLength] = useState(30)
  const [fit, setFit] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!note) return
    const timer = window.setTimeout(() => setNote(null), 2500)
    return () => window.clearTimeout(timer)
  }, [note])

  const { starts, ends, total } = schedule(draft.steps)
  const playing = playback !== null
  const saved = sequences.some((s) => s.id === draft.id)

  const setSteps = (change: (steps: SequenceStep[]) => SequenceStep[]) => setDraft((d) => ({ ...d, steps: change(d.steps) }))
  const updateStep = (id: string, patch: Partial<SequenceStep>) =>
    setSteps((steps) => steps.map((s) => (s.id === id ? ({ ...s, ...patch } as SequenceStep) : s)))
  const moveStep = (index: number, by: number) =>
    setSteps((steps) => {
      const next = [...steps]
      const [step] = next.splice(index, 1)
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, step)
      return next
    })
  const changeKind = (step: SequenceStep, kind: StepKind) =>
    setSteps((steps) => steps.map((s) => (s.id === step.id ? { ...newStep(kind, lists), id: s.id, withPrevious: s.withPrevious } : s)))

  const save = async () => {
    try {
      await onSave(draft)
      setNote('Saved')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not save')
    }
  }
  const remove = async () => {
    try {
      await onDelete(draft.id)
      setDraft(blankSequence())
      setNote('Deleted')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not delete')
    }
  }
  const missingList = draft.steps.some((s) => s.kind === 'focus' && !lists.some((l) => l.id === s.listId))

  const stepParams = (step: SequenceStep) => {
    switch (step.kind) {
      case 'rotate':
        return (
          <>
            <input
              className="crop-wipe-seconds"
              type="number"
              step={15}
              value={step.degrees}
              aria-label="Degrees to turn"
              onChange={(e) => updateStep(step.id, { degrees: Number(e.target.value) || 0 })}
            />
            <span>° (like the turntable; negative: the other way)</span>
          </>
        )
      case 'focus':
        return (
          <>
            <select value={step.listId} aria-label="Focus list" onChange={(e) => updateStep(step.id, { listId: e.target.value })}>
              {!lists.some((l) => l.id === step.listId) && <option value={step.listId}>{lists.length ? '(pick a list)' : '(no saved lists)'}</option>}
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.keys.length})
                </option>
              ))}
            </select>
            <label className="video-step-check">
              <input type="checkbox" checked={step.add} onChange={(e) => updateStep(step.id, { add: e.target.checked })} />
              add to focus
            </label>
          </>
        )
      case 'wipe':
        return (
          <>
            <select value={step.face} aria-label="Crop box face" onChange={(e) => updateStep(step.id, { face: Number(e.target.value) })}>
              {FACE_NAMES.map((name, face) => (
                <option key={face} value={face}>
                  {name} face
                </option>
              ))}
            </select>
            <select value={step.direction} aria-label="Wipe direction" onChange={(e) => updateStep(step.id, { direction: e.target.value as 'in' | 'out' })}>
              <option value="in">in</option>
              <option value="out">out</option>
            </select>
          </>
        )
      case 'blend':
        return (
          <>
            <input
              className="crop-wipe-seconds"
              type="number"
              min={0}
              max={100}
              value={Math.round(step.from * 100)}
              aria-label="Blend from, percent"
              onChange={(e) => updateStep(step.id, { from: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)) })}
            />
            <span>→</span>
            <input
              className="crop-wipe-seconds"
              type="number"
              min={0}
              max={100}
              value={Math.round(step.to * 100)}
              aria-label="Blend to, percent"
              onChange={(e) => updateStep(step.id, { to: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)) })}
            />
            <span>%</span>
          </>
        )
      case 'hold':
        return <span>keep everything as it is</span>
      case 'clearFocus':
        return <span>the rest fades back in</span>
    }
  }

  return (
    <div className="video-builder">
      <div className="video-row">
        <select
          value={saved ? draft.id : ''}
          aria-label="Saved videos"
          disabled={playing}
          onChange={(e) => {
            const found = sequences.find((s) => s.id === e.target.value)
            setDraft(found ? structuredClone(found) : blankSequence())
          }}
        >
          <option value="">{saved ? 'New video' : 'Unsaved video'}</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input className="video-name" value={draft.name} aria-label="Video name" disabled={playing} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      </div>

      <div className="video-row">
        <span className="render-toolbar-label">Start view</span>
        <span className="video-hint">{draft.startView ? 'saved camera' : 'wherever the view is'}</span>
        <button
          className="btn btn-secondary btn-small"
          disabled={playing}
          title="Start the video from the camera as it is now (position, angle, zoom)"
          onClick={() => {
            const camera = getCamera()
            if (camera) setDraft((d) => ({ ...d, startView: camera }))
            else setNote('Load a volume first')
          }}
        >
          Use current
        </button>
        {draft.startView && (
          <button className="icon-btn" disabled={playing} onClick={() => setDraft((d) => ({ ...d, startView: null }))}>
            Clear
          </button>
        )}
      </div>

      <ol className="video-steps">
        {draft.steps.map((step, i) => (
          <li key={step.id} className={step.withPrevious && i > 0 ? 'video-step with-previous' : 'video-step'}>
            <div className="video-row">
              <select value={step.kind} aria-label="Step" disabled={playing} onChange={(e) => changeKind(step, e.target.value as StepKind)}>
                {STEP_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {STEP_LABELS[k]}
                  </option>
                ))}
              </select>
              <input
                className="crop-wipe-seconds"
                type="number"
                min={0}
                max={3600}
                step={0.5}
                value={step.seconds}
                disabled={playing}
                aria-label="Seconds"
                title={step.kind === 'focus' || step.kind === 'clearFocus' ? 'How long the focus fades' : 'How long this step takes'}
                onChange={(e) => updateStep(step.id, { seconds: Math.max(0, Number(e.target.value) || 0) })}
              />
              <span>s</span>
              <span className="video-step-time" title="When it runs">
                {starts[i].toFixed(1)}–{ends[i].toFixed(1)}s
              </span>
              <button className="icon-btn" disabled={playing || i === 0} aria-label="Move up" onClick={() => moveStep(i, -1)}>
                ↑
              </button>
              <button className="icon-btn" disabled={playing || i === draft.steps.length - 1} aria-label="Move down" onClick={() => moveStep(i, 1)}>
                ↓
              </button>
              <button className="icon-btn" disabled={playing} aria-label="Remove step" onClick={() => setSteps((steps) => steps.filter((s) => s.id !== step.id))}>
                ✕
              </button>
            </div>
            <div className="video-row video-step-params">{stepParams(step)}</div>
            {i > 0 && (
              <label className="video-step-check" title="Start together with the step above instead of after everything before it has finished">
                <input type="checkbox" checked={step.withPrevious} disabled={playing} onChange={(e) => updateStep(step.id, { withPrevious: e.target.checked })} />
                at the same time as the step above
              </label>
            )}
          </li>
        ))}
      </ol>
      {draft.steps.length === 0 && <p className="video-hint">Add steps below: they run one after another, or alongside the step above.</p>}

      <div className="video-row">
        <select value={addKind} aria-label="Step to add" disabled={playing} onChange={(e) => setAddKind(e.target.value as StepKind)}>
          {STEP_KINDS.map((k) => (
            <option key={k} value={k}>
              {STEP_LABELS[k]}
            </option>
          ))}
        </select>
        <button className="btn btn-secondary btn-small" disabled={playing} onClick={() => setSteps((steps) => [...steps, newStep(addKind, lists)])}>
          Add step
        </button>
      </div>

      <div className="video-row">
        <span>
          Length <b>{total.toFixed(1)} s</b>
        </span>
        <span className="video-hint">· fit to</span>
        <input
          className="crop-wipe-seconds"
          type="number"
          min={1}
          max={3600}
          value={targetLength}
          aria-label="Desired length in seconds"
          onChange={(e) => setTargetLength(Math.max(1, Number(e.target.value) || 1))}
        />
        <span>s</span>
        <button
          className="btn btn-secondary btn-small"
          disabled={playing || total <= 0}
          title="Scale every step's duration so the video runs this long"
          onClick={() => setSteps((steps) => fitToLength(steps, targetLength))}
        >
          Fit
        </button>
      </div>

      {missingList && <p className="video-hint">A focus step has no saved list to use.</p>}

      {playback ? (
        <div className="video-row">
          <progress className="video-progress" max={playback.total || 1} value={playback.seconds} />
          <span className="video-step-time">
            {playback.seconds.toFixed(1)} / {playback.total.toFixed(1)}s
          </span>
          <button className="btn btn-secondary btn-small active" onClick={onStop}>
            {playback.recording ? 'Stop & save' : 'Stop'}
          </button>
        </div>
      ) : (
        <div className="video-row">
          <button className="btn btn-secondary btn-small" disabled={draft.steps.length === 0} title="Play the video in the voxel render without recording" onClick={() => onPlay(draft, false, fit)}>
            Preview
          </button>
          <button className="btn btn-primary btn-small" disabled={draft.steps.length === 0} title="Play the video and record the voxel render; the file downloads at the end" onClick={() => onPlay(draft, true, fit)}>
            Record
          </button>
          <label className="video-step-check" title="Crop the recording to the volume (with room for it to turn), like the capture bar's Fit">
            <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
            Fit
          </label>
          {editor && (
            <>
              <button className="btn btn-secondary btn-small video-save" disabled={!draft.name.trim()} onClick={() => void save()}>
                Save
              </button>
              {saved && (
                <button className="icon-btn" onClick={() => void remove()}>
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      )}
      {note && <p className="video-hint">{note}</p>}
    </div>
  )
}
