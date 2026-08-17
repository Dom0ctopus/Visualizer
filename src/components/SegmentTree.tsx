import { groupBySystem } from '../types'
import type { LoadedSegmentation, SegmentState, SystemGroup } from '../types'
import { TreeRow } from './TreeRow'

interface SegmentTreeProps {
  segmentations: LoadedSegmentation[]
  filterText: string
  onSegmentVisible: (recordId: string, key: string, visible: boolean) => void
  onSegmentOpacity: (recordId: string, key: string, opacity: number) => void
  onSystemVisible: (recordId: string, systemName: string, visible: boolean) => void
  onSystemOpacity: (recordId: string, systemName: string, opacity: number) => void
  onFileVisible: (recordId: string, visible: boolean) => void
  onFileOpacity: (recordId: string, opacity: number) => void
  onRemoveFile: (recordId: string) => void
}

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

export function SegmentTree({
  segmentations,
  filterText,
  onSegmentVisible,
  onSegmentOpacity,
  onSystemVisible,
  onSystemOpacity,
  onFileVisible,
  onFileOpacity,
  onRemoveFile
}: SegmentTreeProps) {
  if (segmentations.length === 0) {
    return <p className="empty-hint">No segmentations loaded yet.</p>
  }

  const filter = filterText.trim().toLowerCase()

  return (
    <div className="segment-tree">
      {segmentations.map((loaded) => {
        const fileMatches = filter.length === 0 || loaded.name.toLowerCase().includes(filter)
        const systems = filterSystems(groupBySystem(loaded.segments), fileMatches, filter)
        if (filter && systems.length === 0) return null

        const fileChecked = loaded.segments.every((s) => s.visible)
        const fileIndeterminate = !fileChecked && loaded.segments.some((s) => s.visible)

        return (
          <div key={loaded.recordId} className="segment-tree-file">
            <TreeRow
              depth={0}
              label={loaded.name}
              checked={fileChecked}
              indeterminate={fileIndeterminate}
              opacity={avgOpacity(loaded.segments)}
              onToggle={(checked) => onFileVisible(loaded.recordId, checked)}
              onOpacityChange={(o) => onFileOpacity(loaded.recordId, o)}
              onRemove={() => onRemoveFile(loaded.recordId)}
              badge={String(loaded.segments.length)}
            />
            {systems.map((system) => {
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
                    onToggle={(checked) => onSystemVisible(loaded.recordId, system.name, checked)}
                    onOpacityChange={(o) => onSystemOpacity(loaded.recordId, system.name, o)}
                    badge={String(system.segments.length)}
                  />
                  {system.segments.map((seg) => (
                    <TreeRow
                      key={seg.key}
                      depth={2}
                      label={seg.name}
                      color={colorCss(seg.color)}
                      checked={seg.visible}
                      opacity={seg.opacity}
                      onToggle={(checked) => onSegmentVisible(loaded.recordId, seg.key, checked)}
                      onOpacityChange={(o) => onSegmentOpacity(loaded.recordId, seg.key, o)}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
