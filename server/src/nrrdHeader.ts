import { gunzip } from 'node:zlib'
import { open, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const gunzipAsync = promisify(gunzip)

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

/**
 * Reads a whole (single-file, attached-data) NRRD's header and raw voxel
 * payload -- for the segmentation converter, which needs the actual voxel
 * data (to slice out each layer of a multi-layer label map itself), unlike
 * readNrrdHeader above which only needs the first ~1MB to find field/segment
 * metadata. Regular intensity volumes go through itk-wasm's own reader
 * instead (see zarrConvert.ts) for its broader format/edge-case handling;
 * this direct reader exists only because 3D Slicer's multi-layer label map
 * convention (extra "list"-kind axes holding independent 3D layers) isn't
 * something itk-wasm's generic NRRD reader is exercised against here, while
 * this file's own field parsing already has everything needed to read it
 * directly and unambiguously.
 */
export async function readNrrdHeaderAndData(filePath: string): Promise<{ header: ParsedNrrdHeader; data: Buffer }> {
  const buf = await readFile(filePath)
  let headerEnd = -1
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] === 10 && buf[i] === 10) {
      headerEnd = i - 1
      break
    }
  }
  if (headerEnd < 0) throw new Error('Could not find end of NRRD header (no blank line separator)')
  const text = buf.subarray(0, headerEnd).toString('utf8')
  const header = parseNrrdHeaderText(text)
  if (header.fields['data file']) {
    throw new Error('Detached NRRD data files (.nhdr) are not supported for segmentations')
  }
  const rawPayload = buf.subarray(headerEnd + 2)
  const encoding = (header.fields['encoding'] ?? 'raw').toLowerCase()
  if (encoding.includes('raw')) {
    return { header, data: rawPayload }
  }
  if (encoding.includes('gz')) {
    return { header, data: await gunzipAsync(rawPayload) }
  }
  throw new Error(`Unsupported NRRD encoding for segmentation: ${encoding}`)
}
