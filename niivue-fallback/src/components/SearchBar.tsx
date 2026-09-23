import type { SegmentTreeItem } from './SegmentTree'

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  segmentations: SegmentTreeItem[]
  onSegmentVisible: (recordId: string, key: string, visible: boolean) => void
}

export function SearchBar({ value, onChange, segmentations, onSegmentVisible }: SearchBarProps) {
  const filter = value.trim().toLowerCase()

  const matches: Array<{ recordId: string; key: string }> = []
  if (filter) {
    for (const loaded of segmentations) {
      for (const seg of loaded.segments) {
        if (seg.name.toLowerCase().includes(filter) || seg.system.toLowerCase().includes(filter)) {
          matches.push({ recordId: loaded.recordId, key: seg.key })
        }
      }
    }
  }

  const applyToMatches = (visible: boolean) => {
    matches.forEach((m) => onSegmentVisible(m.recordId, m.key, visible))
  }

  return (
    <div className="search-bar">
      <input
        type="search"
        placeholder="Search segments or systems…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="search-input"
      />
      {filter && (
        <div className="search-actions">
          <span className="search-count">
            {matches.length} match{matches.length === 1 ? '' : 'es'}
          </span>
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
