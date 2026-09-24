# Real-to-life palette: provenance

The "Real to life" color scheme (`src/lib/realisticPalette.ts`) uses tissue colors sampled from photographs of fresh *Octopus vulgaris* dissections in Á. Guerra, "Functional Anatomy: Macroscopic Anatomy and Post-Mortem Techniques", Figs 3.9 (respiratory/circulatory), 3.12 (digestive) and 3.19 (male reproductive). The figures themselves are not included here.

## Method (`sample_reference_colors.py`)

1. For each labeled structure, one or more rectangles were placed on the tissue, clear of label text and glare (coordinates are in `samples.json`, in pixels of the page images as supplied).
2. Within each rectangle, the brightest 15% (glare) and darkest 5% (shadow) of pixels by luminance are dropped, and pure-white page pixels around cut-out figures are ignored; the median of the rest is the sample.
3. Figs 3.9 and 3.19b were photographed on white foam. The foam's median color in two background regions per figure gives per-channel gains that map it to near-white (235), correcting white balance and exposure ("measured"). Fig 3.12 is a cut-out on a white page with no reference, so its samples are as printed ("uncorrected"). The in-situ panel 3.19a (tray lighting, no white reference) is only used where no corrected sample of that tissue exists.
4. A tissue's color is the median of its samples.

`samples.json` records every sample: figure, rectangle, raw and corrected color, and whether it was white-balanced. Re-running `python sample_reference_colors.py <figures dir> <output dir>` on the same figures reproduces it.

## Known gaps

- **Nervous tissue** (all brain lobes) appears in none of these figures; its color is a provisional placeholder until a reference photo is sampled.
- Structures not photographed (muscle, mantle, arms, renal sacs, and others) keep their segmentation-file colors.
- Lower confidence: spermatophoric sac gland and terminal organ (small regions close to their labels).
- The references are *O. vulgaris*; colors may differ somewhat for other species or life stages.

To add a reference: add the figure and its rectangle(s) to `sample_reference_colors.py`, re-run it, and update the tissue's color and source in `realisticPalette.ts`.
