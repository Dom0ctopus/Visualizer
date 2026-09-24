# Real-to-life palette: provenance

The "Real to life" color scheme (`src/lib/realisticPalette.ts`) colors segments by **general tissue type**: nervous tissue, muscle, heart, branchial heart, blood vessel, gill, gut wall, stomach, liver/digestive gland, exocrine gland, pigmented sac, renal tissue, gonad, reproductive tract, beak/chitin and cartilage. The classes describe kinds of tissue, not one species' organs, so they apply to any specimen. Organs of the same kind share a class (crop, caecum and intestine are all "gut wall"), and segments are matched to classes by name keywords (`liver`, `ovary`, `spinal cord`, `mantle`, …) and by their segmentation file.

## Sources

Colors were sampled from photographs of fresh dissections:

- Á. Guerra, "Functional Anatomy: Macroscopic Anatomy and Post-Mortem Techniques", Figs 3.9 (respiratory/circulatory), 3.12 (digestive) and 3.19 (male reproductive): cephalopod dissections on white foam or as cut-outs.
- M. Nixon & J. Z. Young, *The Brains and Lives of Cephalopods*: a dark-field brain photograph, for nervous tissue.
- Guerra Fig 3.19a at higher resolution, for the renal tissue (the salmon lobes between the branchial hearts and the testis).
- A photograph of an *O. vulgaris* upper beak (from "Reproductive development versus estimated age and size in a wild Mediterranean population of *Octopus vulgaris*"), for beak/chitin.
- Cartilage: no photograph; described as whitish-grey.

The figures themselves are not included here.

## Method (`sample_reference_colors.py`)

1. For each labeled structure, one or more rectangles were placed on the tissue, clear of label text, glare and lighting casts (coordinates are in `samples.json`, in pixels of the images as supplied).
2. Within each rectangle, the brightest 15% (glare) and darkest 5% (shadow) of pixels by luminance are dropped, and pure-white page pixels around cut-out figures are ignored; the median of the rest is the sample.
3. Where a photo has a white background (the foam in Figs 3.9 and 3.19b), its median color gives per-channel gains mapping it to near-white (235), correcting white balance and exposure ("measured"). A photo without one but showing a tissue already measured that way is calibrated against it: Fig 3.19a (tray lighting) is calibrated so its gills match the gills measured in Fig 3.9 ("measured", noted as calibrated). Photos with neither (Fig 3.12, the brain and beak photos, whose white backgrounds are digital cut-outs) are used as printed ("uncorrected").
4. Each organ sample is assigned to a general tissue class; a class's color is the median of its samples, preferring white-balanced ones.

`samples.json` records every sample (figure, rectangle, raw and corrected color, white-balanced or not) and the resulting class palette. Re-running `python sample_reference_colors.py <figures dir> <output dir>` on the same images reproduces it.

## Known gaps

- Lower confidence ("uncorrected"): nervous tissue, muscle, gut wall, stomach, liver/digestive gland, exocrine gland, pigmented sac, beak. Cartilage is from a description only ("described").
- Muscle is sampled from a buccal mass only; body-wall muscle (mantle, arms) can look different.
- Tissue types with no sample yet (e.g. skin) are left unmatched and keep their file colors.

To add a reference: add the image and its rectangle(s) to `sample_reference_colors.py` (with the organ's class in `GENERAL`), re-run it, and copy the class color into `realisticPalette.ts`.

## Surface finish

Each class also has a finish used for 3D shading in the Basic mesh viewer: hard structures (beak/chitin, cartilage) get a clear-coated material with crisp highlights so they read as hard; soft tissue keeps a satin finish. The finish follows the tissue type in either color scheme.
