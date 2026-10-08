import { memo, useRef, useState, type MouseEvent } from 'react'
import { focusKey } from '../lib/focus'
import { groupBySystem } from '../types'
import type { SegmentState, SystemGroup } from '../types'
import { TreeRow } from './TreeRow'

/** The minimal shape SegmentTree needs -- kept structural rather than tied
 *  to ZarrLoadedSegmentation so the tree UI stays independent of rendering. */
export interface SegmentTreeItem {
  recordId: string
  name: string
  segments: SegmentState[]
}

interface SegmentTreeProps {
  segmentations: SegmentTreeItem[]
  filterText: string
  onSegmentVisible: (recordId: string, key: string, visible: boolean) => void
  onSegmentOpacity: (recordId: string, key: string, opacity: number) => void
  onSystemVisible: (recordId: string, systemName: string, visible: boolean) => void
  onSystemOpacity: (recordId: string, systemName: string, opacity: number) => void
  onFileVisible: (recordId: string, visible: boolean) => void
  onFileOpacity: (recordId: string, opacity: number) => void
  /** Several segments of one file: what file and system rows act on while
   *  a search filter shows only some of their segments. */
  onSegmentsVisible: (recordId: string, keys: ReadonlySet<string>, visible: boolean) => void
  onSegmentsOpacity: (recordId: string, keys: ReadonlySet<string>, opacity: number) => void
  onRemoveFile: (recordId: string) => void
  /** Segments highlighted for focusing, by focusKey. */
  selected: ReadonlySet<string>
  onSelectionChange: (selected: ReadonlySet<string>) => void
}

const IS_MAC_LABEL = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'

function colorCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`
}

function avgOpacity(segments: Array<Pick<SegmentState, 'opacity' | 'visible'>>): number {
  const visible = segments.filter((s) => s.visible)
  const source = visible.length > 0 ? visible : segments
  if (source.length === 0) return 0
  return source.reduce((sum, s) => sum + s.opacity, 0) / source.length
}

function filterSystems(systems: SystemGroup[], fileMatches: boolean, filter: string): SystemGroup[] {
  if (!filter || fileMatches) return systems
  return systems
    .map((sys) => {
      if (sys.name.toLowerCase().includes(filter)) return sys
      const segs = sys.segments.filter((seg) => seg.name.toLowerCase().includes(filter))
      return segs.length > 0 ? { ...sys, segments: segs } : null
    })
    .filter((s): s is SystemGroup => s !== null)
}

/** Memoized: the page re-renders on every 2D scroll step, and the tree's
 *  inputs (segment state, search text, stable callbacks) don't change then. */
export const SegmentTree = memo(function SegmentTree({
  segmentations,
  filterText,
  onSegmentVisible,
  onSegmentOpacity,
  onSystemVisible,
  onSystemOpacity,
  onFileVisible,
  onFileOpacity,
  onSegmentsVisible,
  onSegmentsOpacity,
  onRemoveFile,
  selected,
  onSelectionChange
}: SegmentTreeProps) {
  // Collapsed files/systems, by key (see fileKey/systemKey); all start expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // Where a Shift+click range starts: the last segment clicked without Shift.
  const anchorRef = useRef<string | null>(null)

  if (segmentations.length === 0) {
    return <p className="empty-hint">No segmentations loaded yet.</p>
  }

  const filter = filterText.trim().toLowerCase()
  const fileKey = (recordId: string) => `f:${recordId}`
  const systemKey = (recordId: string, system: string) => `s:${recordId}:${system}`
  // While searching, matches always show, whatever is collapsed.
  const isExpanded = (key: string) => filter.length > 0 || !collapsed.has(key)
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const allGroupKeys = segmentations.flatMap((l) => [fileKey(l.recordId), ...groupBySystem(l.segments).map((sys) => systemKey(l.recordId, sys.name))])
  const anyExpanded = allGroupKeys.some((k) => !collapsed.has(k))

  // What the tree shows, file by file (after the search and collapsing),
  // and its segment rows in screen order, for Shift+click ranges.
  const views = segmentations.flatMap((loaded) => {
    const fileMatches = filter.length === 0 || loaded.name.toLowerCase().includes(filter)
    const systems = filterSystems(groupBySystem(loaded.segments), fileMatches, filter)
    return filter && systems.length === 0 ? [] : [{ loaded, systems }]
  })
  const shownRows: string[] = []
  for (const { loaded, systems } of views) {
    if (!isExpanded(fileKey(loaded.recordId))) continue
    const flat = systems.length === 1 && systems[0].name === 'Ungrouped'
    for (const system of systems) {
      if (!flat && !isExpanded(systemKey(loaded.recordId, system.name))) continue
      for (const seg of system.segments) shownRows.push(focusKey(loaded.recordId, seg.key))
    }
  }

  /** Click: select just this one (or nothing, if it already was) ·
   *  Shift+click: add the range from the last clicked one ·
   *  Cmd/Ctrl+click: add or remove this one. */
  const selectRow = (key: string, e: MouseEvent) => {
    const anchor = anchorRef.current
    if (e.shiftKey && anchor !== null && shownRows.includes(anchor)) {
      const [a, b] = [shownRows.indexOf(anchor), shownRows.indexOf(key)].sort((x, y) => x - y)
      onSelectionChange(new Set([...selected, ...shownRows.slice(a, b + 1)]))
      return
    }
    anchorRef.current = key
    const next = new Set(e.metaKey || e.ctrlKey || e.shiftKey ? selected : [])
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      if (next.has(key)) next.delete(key)
      else next.add(key)
    } else if (!(selected.size === 1 && selected.has(key))) next.add(key)
    onSelectionChange(next)
  }
  /** Shift or Cmd/Ctrl+click on a file or system: select all of its shown
   *  segments, or deselect them if they all were. */
  const selectGroup = (recordId: string, segs: SegmentState[]) => {
    const keys = segs.map((seg) => focusKey(recordId, seg.key))
    const next = new Set(selected)
    if (keys.every((k) => next.has(k))) keys.forEach((k) => next.delete(k))
    else keys.forEach((k) => next.add(k))
    onSelectionChange(next)
  }
  const leafRow = (recordId: string, seg: SegmentState, depth: number) => {
    const key = focusKey(recordId, seg.key)
    return (
      <TreeRow
        key={seg.key}
        depth={depth}
        label={seg.name}
        color={colorCss(seg.color)}
        checked={seg.visible}
        opacity={seg.opacity}
        onToggle={(checked) => onSegmentVisible(recordId, seg.key, checked)}
        onOpacityChange={(o) => onSegmentOpacity(recordId, seg.key, o)}
        selected={selected.has(key)}
        onSelect={(e) => selectRow(key, e)}
      />
    )
  }

  return (
    <div className="segment-tree">
      <div className="segment-tree-actions">
        <span className="segment-tree-hint" title="Click a segment to select it · Shift+click: a range · ⌘/Ctrl+click: add or remove one · Shift or ⌘/Ctrl+click a file or system: all of it">
          Click to select · Shift: range · {IS_MAC_LABEL}: add
        </span>
        <button
          className="icon-btn"
          disabled={filter.length > 0}
          title={filter ? 'Clear the search to collapse or expand' : undefined}
          onClick={() => setCollapsed(anyExpanded ? new Set(allGroupKeys) : new Set())}
        >
          {anyExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {views.map(({ loaded, systems }) => {

        // While searching, a file or system row stands for -- and toggles --
        // only the segments the search shows under it, not the hidden rest.
        const shownSegments = filter ? systems.flatMap((sys) => sys.segments) : loaded.segments
        const keysOf = (segs: SegmentState[]) => new Set(segs.map((seg) => seg.key))
        const fileChecked = shownSegments.every((s) => s.visible)
        const fileIndeterminate = !fileChecked && shownSegments.some((s) => s.visible)

        return (
          <div key={loaded.recordId} className="segment-tree-file">
            <TreeRow
              depth={0}
              label={loaded.name}
              checked={fileChecked}
              indeterminate={fileIndeterminate}
              opacity={avgOpacity(shownSegments)}
              onToggle={(checked) =>
                filter ? onSegmentsVisible(loaded.recordId, keysOf(shownSegments), checked) : onFileVisible(loaded.recordId, checked)
              }
              onOpacityChange={(o) => (filter ? onSegmentsOpacity(loaded.recordId, keysOf(shownSegments), o) : onFileOpacity(loaded.recordId, o))}
              onRemove={() => onRemoveFile(loaded.recordId)}
              onSelect={() => selectGroup(loaded.recordId, shownSegments)}
              badge={String(loaded.segments.length)}
              expanded={isExpanded(fileKey(loaded.recordId))}
              onExpandToggle={() => toggle(fileKey(loaded.recordId))}
            />
            {!isExpanded(fileKey(loaded.recordId))
              ? null
              : systems.length === 1 && systems[0].name === 'Ungrouped'
              ? // No real grouping was detected for this file — skip the redundant
                // "Ungrouped" wrapper and list segments directly under the file.
                systems[0].segments.map((seg) => leafRow(loaded.recordId, seg, 1))
              : systems.map((system) => {
                  const sysChecked = system.segments.every((s) => s.visible)
                  const sysIndeterminate = !sysChecked && system.segments.some((s) => s.visible)
                  return (
                    <div key={system.name}>
                      <TreeRow
                        depth={1}
                        label={system.name}
                        checked={sysChecked}
                        indeterminate={sysIndeterminate}
                        opacity={avgOpacity(system.segments)}
                        onToggle={(checked) =>
                          filter
                            ? onSegmentsVisible(loaded.recordId, keysOf(system.segments), checked)
                            : onSystemVisible(loaded.recordId, system.name, checked)
                        }
                        onOpacityChange={(o) =>
                          filter ? onSegmentsOpacity(loaded.recordId, keysOf(system.segments), o) : onSystemOpacity(loaded.recordId, system.name, o)
                        }
                        badge={String(system.segments.length)}
                        expanded={isExpanded(systemKey(loaded.recordId, system.name))}
                        onExpandToggle={() => toggle(systemKey(loaded.recordId, system.name))}
                        onSelect={() => selectGroup(loaded.recordId, system.segments)}
                      />
                      {isExpanded(systemKey(loaded.recordId, system.name)) &&
                        system.segments.map((seg) => leafRow(loaded.recordId, seg, 2))}
                    </div>
                  )
                })}
          </div>
        )
      })}
    </div>
  )
})
