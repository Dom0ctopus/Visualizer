import { open } from 'node:fs/promises'

export interface ParsedNrrdHeader {
  /** Standard "key: value" field descriptors, lowercased keys. */
  fields: Record<string, string>
  /** Custom "key:=value" pairs (e.g. 3D Slicer's per-segment metadata). */
  keyValuePairs: Record<string, string>
}

// NRRD headers are plain text and small; this is generous headroom so we never
// need to read the (potentially huge) voxel payload just to find the header end.
const MAX_HEADER_BYTES = 1_000_000

export async function readNrrdHeader(filePath: string): Promise<ParsedNrrdHeader> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(MAX_HEADER_BYTES)
    const { bytesRead } = await handle.read(buf, 0, MAX_HEADER_BYTES, 0)
    const slice = buf.subarray(0, bytesRead)

    // Header ends at the first blank line (two consecutive newlines).
    let headerEnd = slice.length
    for (let i = 1; i < slice.length; i++) {
      if (slice[i - 1] === 10 && slice[i] === 10) {
        headerEnd = i - 1
        break
      }
    }
    const text = slice.subarray(0, headerEnd).toString('utf8')
    return parseNrrdHeaderText(text)
  } finally {
    await handle.close()
  }
}

export function parseNrrdHeaderText(text: string): ParsedNrrdHeader {
  const lines = text.split('\n')
  if (!lines[0]?.startsWith('NRRD')) {
    throw new Error('Not a valid NRRD file (missing magic header)')
  }

  const fields: Record<string, string> = {}
  const keyValuePairs: Record<string, string> = {}

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line.length === 0 || line.startsWith('#')) continue

    // Key/value pairs use "key:=value" (no space required); field descriptors
    // use "field: value". Check for ":=" first since it's the more specific form.
    const kvIdx = line.indexOf(':=')
    if (kvIdx >= 0) {
      keyValuePairs[line.slice(0, kvIdx).trim()] = line.slice(kvIdx + 2).trim()
      continue
    }

    const fieldIdx = line.indexOf(':')
    if (fieldIdx >= 0) {
      fields[line.slice(0, fieldIdx).trim().toLowerCase()] = line.slice(fieldIdx + 1).trim()
    }
  }

  return { fields, keyValuePairs }
}
