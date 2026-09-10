import type { ParsedNrrdHeader } from './nrrdHeader.js'
import type { SegmentInfo, SystemInfo } from './types.js'

const SEGMENT_KEY_RE = /^Segment(\d+)_(\w+)$/
const FALLBACK_COLOR: [number, number, number] = [239, 68, 68]

interface RawSegment {
  index: number
  name?: string
  colorText?: string
  labelValueText?: string
  layerText?: string
}

/**
 * Parses 3D Slicer's per-segment key/value metadata (Segment0_Name,
 * Segment0_Color, Segment0_LabelValue, Segment0_Layer, ...) into a flat
 * list of segments.
 */
export function extractSegments(header: ParsedNrrdHeader): SegmentInfo[] {
  const raw = new Map<number, RawSegment>()

  for (const [key, value] of Object.entries(header.keyValuePairs)) {
    const match = SEGMENT_KEY_RE.exec(key)
    if (!match) continue
    const index = Number(match[1])
    const entry = raw.get(index) ?? { index }
    switch (match[2]) {
      case 'Name':
        entry.name = value
        break
      case 'Color':
        entry.colorText = value
        break
      case 'LabelValue':
        entry.labelValueText = value
        break
      case 'Layer':
        entry.layerText = value
        break
    }
    raw.set(index, entry)
  }

  const segments: SegmentInfo[] = []
  for (const index of [...raw.keys()].sort((a, b) => a - b)) {
    const entry = raw.get(index)!
    const labelValue = entry.labelValueText !== undefined ? Number(entry.labelValueText) : index + 1
    const layer = entry.layerText !== undefined ? Number(entry.layerText) : 0
    if (!Number.isFinite(labelValue) || !Number.isFinite(layer)) continue
    segments.push({
      name: entry.name?.trim() || `Segment ${index + 1}`,
      labelValue,
      layer,
      color: parseColor(entry.colorText)
    })
  }
  return segments
}

function parseColor(text: string | undefined): [number, number, number] {
  if (text) {
    const parts = text.split(/\s+/).map(Number)
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      return [Math.round(parts[0] * 255), Math.round(parts[1] * 255), Math.round(parts[2] * 255)]
    }
  }
  return FALLBACK_COLOR
}

// Only "_" is treated as a deliberate system/segment separator. Hyphens, colons,
// and slashes show up naturally inside real anatomical names (e.g. "cerebro-branchial")
// and produced false-positive splits when treated as delimiters.
const SYSTEM_DELIMITERS = ['_']

/**
 * Groups segments into "systems" by splitting each segment's name on the first
 * recognized delimiter, e.g. "Skeletal_Femur" -> system "Skeletal", segment "Femur".
 * Names with no recognizable delimiter fall into a single "Ungrouped" system.
 */
export function groupIntoSystems(segments: SegmentInfo[]): SystemInfo[] {
  const systemMap = new Map<string, SegmentInfo[]>()

  for (const seg of segments) {
    const { system, label } = splitSystemFromName(seg.name)
    const list = systemMap.get(system) ?? []
    list.push({ ...seg, name: label })
    systemMap.set(system, list)
  }

  return [...systemMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, segs]) => ({
      name,
      segments: segs.sort((a, b) => a.name.localeCompare(b.name))
    }))
}

function splitSystemFromName(rawName: string): { system: string; label: string } {
  for (const delim of SYSTEM_DELIMITERS) {
    const idx = rawName.indexOf(delim)
    if (idx > 0 && idx < rawName.length - delim.length) {
      const system = rawName.slice(0, idx).trim()
      const label = rawName.slice(idx + delim.length).trim()
      if (system && label && !/^\d+$/.test(system)) {
        return { system: prettify(system), label: prettify(label) }
      }
    }
  }
  return { system: 'Ungrouped', label: prettify(rawName) }
}

function prettify(s: string): string {
  return s.replace(/_/g, ' ').trim()
}
