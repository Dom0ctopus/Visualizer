/**
 * "Real to life" segment colors: tissue colors sampled from photographs of
 * fresh dissections, matched to segments by name.
 *
 * Source: Á. Guerra, "Functional Anatomy: Macroscopic Anatomy and
 * Post-Mortem Techniques" (Figs 3.9, 3.12, 3.19; Octopus vulgaris). Each
 * color is the median of the sampled tissue region(s) with glare and deep
 * shadow trimmed. Figs 3.9 and 3.19b were photographed on white foam, which
 * was used to correct white balance and exposure ("measured"); Fig 3.12 is
 * a cut-out with no white reference, so its colors are as printed
 * ("uncorrected"). Nervous tissue appears in none of the figures, so its
 * color is a placeholder until a reference photo is sampled ("provisional").
 * The sampling script and review sheet live outside the app (see the
 * README's Real-to-life colors section).
 */

export type TissueConfidence = 'measured' | 'uncorrected' | 'provisional'

export interface Tissue {
  id: string
  label: string
  /** sRGB 0-255. */
  color: [number, number, number]
  confidence: TissueConfidence
  source: string
}

function hex(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

const FIG_3_9 = 'Guerra Fig 3.9 (O. vulgaris respiratory/circulatory), white-balanced'
const FIG_3_12 = 'Guerra Fig 3.12 (O. vulgaris digestive system), uncorrected'
const FIG_3_19 = 'Guerra Fig 3.19b (O. vulgaris male reproductive), white-balanced'

export const TISSUES: Record<string, Tissue> = {
  gill: { id: 'gill', label: 'Gill', color: hex('#9e8778'), confidence: 'measured', source: FIG_3_9 },
  gillVessel: { id: 'gillVessel', label: 'Gill vessel', color: hex('#ccb295'), confidence: 'measured', source: FIG_3_9 },
  branchialHeart: { id: 'branchialHeart', label: 'Branchial heart', color: hex('#6a6a73'), confidence: 'measured', source: FIG_3_9 },
  systemicHeart: { id: 'systemicHeart', label: 'Systemic heart', color: hex('#e3bea0'), confidence: 'measured', source: FIG_3_9 },
  vessel: { id: 'vessel', label: 'Blood vessel', color: hex('#d4ccc0'), confidence: 'measured', source: `${FIG_3_9} (dorsal aorta)` },
  digestiveGland: { id: 'digestiveGland', label: 'Digestive gland', color: hex('#644d39'), confidence: 'uncorrected', source: FIG_3_12 },
  inkSac: { id: 'inkSac', label: 'Ink sac', color: hex('#2d3d4b'), confidence: 'uncorrected', source: FIG_3_12 },
  salivaryGland: { id: 'salivaryGland', label: 'Salivary gland', color: hex('#caa677'), confidence: 'uncorrected', source: `${FIG_3_12} (posterior salivary glands)` },
  buccalMass: { id: 'buccalMass', label: 'Buccal mass', color: hex('#a68d76'), confidence: 'uncorrected', source: FIG_3_12 },
  crop: { id: 'crop', label: 'Crop / oesophagus', color: hex('#ad855a'), confidence: 'uncorrected', source: FIG_3_12 },
  stomach: { id: 'stomach', label: 'Stomach', color: hex('#906c50'), confidence: 'uncorrected', source: FIG_3_12 },
  caecum: { id: 'caecum', label: 'Caecum', color: hex('#ae8e6a'), confidence: 'uncorrected', source: FIG_3_12 },
  intestine: { id: 'intestine', label: 'Intestine', color: hex('#b9906b'), confidence: 'uncorrected', source: FIG_3_12 },
  testis: { id: 'testis', label: 'Testis', color: hex('#dcb295'), confidence: 'measured', source: FIG_3_19 },
  spermatophoricGland: { id: 'spermatophoricGland', label: 'Spermatophoric gland', color: hex('#e2bf9f'), confidence: 'measured', source: FIG_3_19 },
  needhamsSac: { id: 'needhamsSac', label: "Spermatophoric (Needham's) sac", color: hex('#e7b79a'), confidence: 'measured', source: FIG_3_19 },
  spermatophoricSacGland: { id: 'spermatophoricSacGland', label: 'Spermatophoric sac gland', color: hex('#b18168'), confidence: 'measured', source: FIG_3_19 },
  terminalOrgan: { id: 'terminalOrgan', label: 'Terminal organ', color: hex('#dfcfc0'), confidence: 'measured', source: FIG_3_19 },
  nervous: {
    id: 'nervous',
    label: 'Nervous tissue',
    color: hex('#ddd4c4'),
    confidence: 'provisional',
    source: 'Placeholder (fresh CNS is a translucent cream-white); no reference photo sampled yet'
  }
}

/** Name keywords -> tissue, most specific first (e.g. "branchial heart"
 *  before "heart", "sac gland" before "sac"). Matched against
 *  "<system> <segment name>". */
const KEYWORDS: Array<[RegExp, string]> = [
  [/\bink\b/i, 'inkSac'],
  [/digestive gland|hepatopancrea|\bliver\b/i, 'digestiveGland'],
  [/salivary|\bpsg\b|\basg\b/i, 'salivaryGland'],
  [/stomach/i, 'stomach'],
  [/c(a)?ecum|spiral/i, 'caecum'],
  [/\bcrop\b|o?esophag/i, 'crop'],
  [/intestin|rectum|\banus\b|\banal\b|hindgut/i, 'intestine'],
  [/buccal|beak|radula|mandib/i, 'buccalMass'],
  [/branchial heart|gill heart/i, 'branchialHeart'],
  [/systemic heart|ventricle|auricle|atri(um|al)\b|\bheart\b/i, 'systemicHeart'],
  [/(afferent|efferent)\s+(branchial|gill)|branchial\s+(vein|vessel|arter)|gill vessel/i, 'gillVessel'],
  [/\bgills?\b|branchia|lamell|ctenidi/i, 'gill'],
  [/aort|arter|\bveins?\b|vena|vessel|sinus|capillar/i, 'vessel'],
  [/sac gland|accessory gland|prostat/i, 'spermatophoricSacGland'],
  [/needham|spermatophor(e|ic)?\s+sac|storage sac/i, 'needhamsSac'],
  [/spermatophor|vas deferens|seminal/i, 'spermatophoricGland'],
  [/terminal organ|penis/i, 'terminalOrgan'],
  [/test(is|es)|gonad/i, 'testis'],
  [/lobe|ganglion|nerve|commissur|connective|neuropil|brain|cerebr|optic|vertical|basal/i, 'nervous']
]

/** Segmentation file name -> the tissue domain its segments belong to. A
 *  domain decides segments whose names are ambiguous out of context (the
 *  brain's "buccal" lobes are nervous tissue, not buccal mass) and those
 *  no keyword matches. */
const FILE_DOMAINS: Array<[RegExp, string]> = [
  [/brain|supra\s*eso|supereso|sub\s*eso|cns|nerv|neur|ganglia/i, 'nervous'],
  [/cardio|vascul|circulat|heart/i, 'vessel'],
  [/reprod|testis|gonad|\bmale\b|female/i, 'testis'],
  [/digest|buccal|\bgut\b|aliment/i, 'crop']
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
