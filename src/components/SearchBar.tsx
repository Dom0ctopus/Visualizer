import { matchSegments } from '../lib/focus'
import type { SegmentTreeItem } from './SegmentTree'

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  segmentations: SegmentTreeItem[]
  onSegmentVisible: (recordId: string, key: string, visible: boolean) => void
  /** Focus the matches: replace the focus set, or add to it. */
  onFocus: (add: boolean) => void
  onClearFocus: () => void
  focusActive: boolean
}

export function SearchBar({ value, onChange, segmentations, onSegmentVisible, onFocus, onClearFocus, focusActive }: SearchBarProps) {
  const filter = value.trim().toLowerCase()
  const matches = matchSegments(segmentations, value)

  const applyToMatches = (visible: boolean) => {
    matches.forEach((m) => onSegmentVisible(m.recordId, m.key, visible))
  }

  return (
    <div className="search-bar">
      <input
        type="search"
        placeholder="Search segments or systems…"
        title="Enter: focus the matches · Shift+Enter: add them to the focus · Esc: clear the focus"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches.length > 0) {
            e.preventDefault()
            onFocus(e.shiftKey)
          } else if (e.key === 'Escape' && focusActive) {
            e.preventDefault()
            onClearFocus()
          }
        }}
        className="search-input"
      />
      {filter && (
        <div className="search-actions">
          <span className="search-count">
            {matches.length} match{matches.length === 1 ? '' : 'es'}
          </span>
          <button
            className="btn btn-secondary btn-small"
            disabled={matches.length === 0}
            title="Focus the views on the matches (Enter)"
            onClick={() => onFocus(false)}
          >
            Focus
          </button>
          {focusActive && (
            <button
              className="btn btn-secondary btn-small"
              disabled={matches.length === 0}
              title="Add the matches to the focus (Shift+Enter)"
              onClick={() => onFocus(true)}
            >
              Add
            </button>
          )}
          <button className="btn btn-secondary btn-small" disabled={matches.length === 0} onClick={() => applyToMatches(true)}>
            Show
          </button>
          <button className="btn btn-secondary btn-small" disabled={matches.length === 0} onClick={() => applyToMatches(false)}>
            Hide
          </button>
        </div>
      )}
    </div>
  )
}
