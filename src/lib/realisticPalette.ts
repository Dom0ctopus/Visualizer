/**
 * "Real to life" segment colors: general tissue-type colors (nervous
 * tissue, muscle, gut wall, gland, gonad, ...) sampled from photographs of
 * fresh dissections, matched to segments by name. The classes are kinds of
 * tissue, not one species' organs, so they apply to any specimen; organs
 * of the same kind share a class (e.g. crop, caecum and intestine are all
 * "gut wall").
 *
 * Sources: Á. Guerra, "Functional Anatomy: Macroscopic Anatomy and
 * Post-Mortem Techniques", Figs 3.9, 3.12, 3.19 (fresh cephalopod
 * dissections), and a dark-field brain photograph (panel b of a supplied
 * figure). Each color is the median of glare/shadow-trimmed samples on the
 * labeled tissue. "measured" colors were corrected for white balance and
 * exposure against a white background in the photo; "uncorrected" ones had
 * no white reference. Every sample and the script that reproduces them are
 * in docs/real-to-life-palette/.
 */

export type TissueConfidence = 'measured' | 'uncorrected'

export interface Tissue {
  id: string
  label: string
  /** sRGB 0-255. */
  color: [number, number, number]
  confidence: TissueConfidence
  /** Where the color was sampled. */
  source: string
}

function hex(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

export const TISSUES: Record<string, Tissue> = {
  nervous: { id: 'nervous', label: 'Nervous tissue', color: hex('#d2cdc7'), confidence: 'uncorrected', source: 'brain and optic lobes (dark-field brain photo)' },
  muscle: { id: 'muscle', label: 'Muscle', color: hex('#a68d76'), confidence: 'uncorrected', source: 'buccal mass (Guerra Fig 3.12)' },
  heart: { id: 'heart', label: 'Heart', color: hex('#e3bea0'), confidence: 'measured', source: 'systemic heart (Guerra Fig 3.9)' },
  branchialHeart: { id: 'branchialHeart', label: 'Branchial heart', color: hex('#6a6a73'), confidence: 'measured', source: 'branchial hearts (Guerra Fig 3.9)' },
  vessel: { id: 'vessel', label: 'Blood vessel', color: hex('#d2b799'), confidence: 'measured', source: 'dorsal aorta, gill vessels (Guerra Fig 3.9)' },
  gill: { id: 'gill', label: 'Gill', color: hex('#9e8778'), confidence: 'measured', source: 'gills (Guerra Fig 3.9)' },
  gutWall: { id: 'gutWall', label: 'Gut wall', color: hex('#ae8e6a'), confidence: 'uncorrected', source: 'crop, caecum, intestine (Guerra Fig 3.12)' },
  stomach: { id: 'stomach', label: 'Stomach', color: hex('#906c50'), confidence: 'uncorrected', source: 'stomach (Guerra Fig 3.12)' },
  digestiveGland: { id: 'digestiveGland', label: 'Liver / digestive gland', color: hex('#644d39'), confidence: 'uncorrected', source: 'digestive gland (Guerra Fig 3.12)' },
  exocrineGland: { id: 'exocrineGland', label: 'Exocrine gland', color: hex('#caa677'), confidence: 'uncorrected', source: 'salivary glands (Guerra Fig 3.12)' },
  pigmented: { id: 'pigmented', label: 'Pigmented sac', color: hex('#2d3d4b'), confidence: 'uncorrected', source: 'ink sac (Guerra Fig 3.12)' },
  gonad: { id: 'gonad', label: 'Gonad', color: hex('#dcb295'), confidence: 'measured', source: 'testis (Guerra Fig 3.19b)' },
  reproductiveTract: {
    id: 'reproductiveTract',
    label: 'Reproductive tract / accessory gland',
    color: hex('#e0bb9c'),
    confidence: 'measured',
    source: 'spermatophoric gland and sac, sac gland, terminal organ (Guerra Fig 3.19b)'
  }
}

/** Name keywords -> tissue class, most specific first (e.g. "branchial
 *  heart" before "heart", reproductive glands before the generic "gland").
 *  Matched against "<system> <segment name>". */
const KEYWORDS: Array<[RegExp, string]> = [
  [/\bink\b|melan|pigment/i, 'pigmented'],
  [/digestive gland|midgut gland|hepat|\bliver\b/i, 'digestiveGland'],
  [/stomach|gizzard|proventric/i, 'stomach'],
  [/\bcrop\b|o?esophag|intestin|c(a)?ecum|spiral|colon|rectum|\banus\b|\banal\b|\bgut\b|duoden|ileum|jejun|bowel/i, 'gutWall'],
  [/branchial heart|gill heart|accessory heart/i, 'branchialHeart'],
  [/\bheart\b|ventric|auricle|atri(um|al)\b|cardiac/i, 'heart'],
  [/aort|arter|\bveins?\b|vena|vessel|sinus|capillar|vascul/i, 'vessel'],
  [/\bgills?\b|branchia|lamell|ctenidi/i, 'gill'],
  [/test(is|es)|ovar|gonad/i, 'gonad'],
  [/spermatophor|needham|terminal organ|penis|vas deferens|seminal|oviduct|uter|nidamental|prostat|accessory gland|sac gland/i, 'reproductiveTract'],
  [/salivary|pancrea|\bgland/i, 'exocrineGland'],
  [/muscle|mantle|\barms?\b|tentacle|funnel|siphon|buccal|beak|radula|\bjaw|pharyn|tongue|\bfoot\b/i, 'muscle'],
  [/brain|ganglion|ganglia|nerve|lobe|cerebr|spinal|\bcord\b|neur|optic|commissur/i, 'nervous']
]

/** Segmentation file name -> the tissue class its segments belong to. It
 *  settles names that are ambiguous out of context (a brain's "buccal"
 *  lobes are nervous tissue, not buccal muscle) and covers segments no
 *  keyword matches. */
const FILE_DOMAINS: Array<[RegExp, string]> = [
  [/brain|supra\s*eso|supereso|sub\s*eso|\bcns\b|nerv|neur|ganglia/i, 'nervous'],
  [/cardio|vascul|circulat|heart/i, 'vessel'],
  [/reprod|gonad|\bmale\b|female/i, 'reproductiveTract'],
  [/digest|buccal|\bgut\b|aliment/i, 'gutWall']
]

function domainFor(fileName: string): string | null {
  for (const [pattern, tissue] of FILE_DOMAINS) if (pattern.test(fileName)) return tissue
  return null
}

/** A small deterministic lightness step per segment, so segments sharing a
 *  tissue (e.g. the brain's lobes) stay distinguishable. */
function nudge(color: [number, number, number], name: string): [number, number, number] {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  const factor = 0.88 + 0.24 * ((h >>> 0) % 1000) / 1000
  return color.map((c) => Math.max(0, Math.min(255, Math.round(c * factor)))) as [number, number, number]
}

export interface RealisticMatch {
  tissue: Tissue
  color: [number, number, number]
  /** How the tissue was chosen. */
  via: 'name' | 'file'
}

/** The real-to-life color for a segment, or null if neither its name nor
 *  its file identifies a tissue. */
export function realisticColor(segmentName: string, system: string, fileName: string): RealisticMatch | null {
  const domain = domainFor(fileName)
  const text = `${system} ${segmentName}`
  let tissueId: string | null = null
  let via: 'name' | 'file' = 'name'
  if (domain === 'nervous') {
    // Everything in a brain segmentation is nervous tissue, whatever its
    // name suggests.
    tissueId = 'nervous'
    via = 'file'
  } else {
    tissueId = KEYWORDS.find(([pattern]) => pattern.test(text))?.[1] ?? null
    if (!tissueId && domain) {
      tissueId = domain
      via = 'file'
    }
  }
  if (!tissueId) return null
  const tissue = TISSUES[tissueId]
  return { tissue, color: nudge(tissue.color, text), via }
}
