# Anti-patterns — Office (DOCX/PPTX) specific

The catalogue in `antipatterns.md` applies here too — a table still gets a cage,
a caption still restates its heading, regardless of file format. This file adds
the failure modes that are specific to editable-Office output: absolute
coordinates instead of flowing text, silent font substitution, and the shipped
templates' own default look.

## Typography and fonts

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| O1 | `default-office-look` — Calibri body / Cambria headings / the Office theme blue, unchanged | open the file, or `pdffonts` after LibreOffice conversion | choose and embed real fonts (`scripts/make-static-fonts.sh` + `scripts/officefonts.py`), same as any other document here | slop |
| O2 | `variable-font-in-office` — a variable TTF (`Archivo[wdth,wght].ttf`) used directly as the embedded/regular file | Word/PowerPoint render only the file's default instance; bold looks synthesised (smeared), not drawn | instance static Regular/Bold files first (`scripts/make-static-fonts.sh`) — confirmed necessary while building this template, Typst does not need this step | slop |
| O3 | `glyph-not-in-font` — a character the chosen face doesn't contain (typographic dashes, box-drawing, some punctuation) | `pdffonts` on the converted PDF shows an EXTRA font family beyond the two you embedded | found on this template's own title page: a `─` rule character silently fell back to Helvetica because Archivo has no U+2500 glyph, even though the run's declared font was correct. Draw rules and bars, don't type them (a 1-cell table border, or a shape) | quality |

## Layout — DOCX

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| O4 | `full-width-body` (T1 restated for Office) — a symmetric ~25mm margin on A4 measures ~100+ characters per line | `pdftotext` char count, or **docrender** | Office has no note column the way the Typst templates do; widen ONE margin on its own to narrow the column (see `templates/office-report/tokens.py` `MARGIN_MM`) | slop |
| O5 | `default-furniture-distance` — header/footer left at Word's own default distance (~12.5mm) while the body margin is set wider | **docrender** (`--min-furniture-margin-mm`, default 18mm) | set `section.header_distance`/`section.footer_distance` explicitly — they are independent of the page margin in python-docx and default lower than most margin decisions | quality |
| O6 | `table-cage` (N1 restated) — Word/Excel's pasted-table look: full grid, header shading, banded rows | look | `scripts/officefonts.py`'s sibling table helper draws two horizontal rules only (head, foot) — see `templates/office-report/layout_docx.py` `_no_borders`/`_hline` | slop |

## Layout — PPTX

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| O7 | `wrong-16x9` — slide sized 13.33 × 7.5in | check `prs.slide_width`/`slide_height` | 16:9 on-screen is **10 × 5.625in**, not 13.33in wide — a documented mistake even in Anthropic's own pptx skill | slop |
| O8 | `text-overflow-invisible` — a placeholder's text runs past its frame with no wrap/reflow warning anywhere in the source | look at the rendered slide, not the source | this template enforces a hard, checked character budget per placeholder (`tokens.py` `BUDGET_CHARS`) instead of autofit/shrink-to-fit — a build-time failure that names the slide, not a silently shrunk font | slop |
| O9 | `table-row-as-rule` — a 1-row/1-cell table with a thin (e.g. 3pt) filled row, used to draw an accent bar | render and look: PowerPoint enforces a MINIMUM row height from the cell's default font size, ignoring an explicit small height request | found while building this template's section-slide rule (it collapsed onto the title text below it) — use a plain rectangle autoshape (`MSO_SHAPE.RECTANGLE`) instead, which has no such floor | quality |
| O10 | `default-powerpoint-slide` — bullet list on every slide, textbox touching the slide edge, three equal icon+heading+two-lines boxes | look | one thought per slide (genres.md #6); keep every text frame inside the margin (docrender's pptx floor is 12mm, this template uses 15mm); vary the shape that carries the point instead of repeating the same box three times | slop |

## Corporate templates (`.dotx`/`.potx`)

Not covered by the generators here — a client-supplied template is a design
contract, not a starting point to restyle. Render its placeholders as thumbnails
first (`soffice --headless --convert-to png`), inventory what exists, then fill
those placeholders with `python-docx`/`python-pptx` (`doc.styles`,
`slide.placeholders[idx]`) rather than adding new text frames on top. Anti-pattern:
laying a fresh textbox over an existing placeholder because it was easier than
finding the placeholder's index — the result carries two competing font/colour
systems in one file. See genre item 1 in `SKILL.md` — a supplied corporate
template overrides the wide-margin/note-column advice above; its own margins are
the design contract.

## Known gaps in the local verification loop

Both found empirically while building this branch, not from documentation:

- **PPTX font embedding cannot be confirmed by rendering it locally.** The
  embedding this project writes (`scripts/officefonts.py`) is spec-correct — the
  same mechanism, checked byte-for-byte, works for DOCX (verified: LibreOffice
  Writer used the real embedded font, `pdffonts` showed it, not a fallback).
  LibreOffice **Impress does not read a pptx's own embedded fonts** on import: a
  deck with "Archivo" and "Faustina" embedded and referenced on every run still
  rendered in `Arial-Black`/`LiberationSans-Italic`/`ArialUnicodeMS` end to end —
  three different system substitutes standing in for three different requested
  styles, none of them the fallback candidates for a *missing* embed. `docrender`
  goes through the same LibreOffice conversion, so its font-fallback check on a
  `.pptx` **will report a finding on a correctly-embedded deck**, a false positive
  bigger than the two already known (`antipatterns.md`, T4/T11). Judge a pptx font
  finding by inspecting the file's own XML (`ppt/presentation.xml`
  `embeddedFontLst`, `ppt/fonts/*.fntdata` present) rather than trusting the
  rendered PNG — or accept the residual risk and confirm in real PowerPoint if
  font fidelity in the deck matters as much as its editability.
- **Rendered PPTX page images inherit the same gap.** The "look at every page"
  step (`SKILL.md` step 5) still catches layout, overflow and colour problems on
  a pptx, but it CANNOT confirm typography the way it can for a PDF or a DOCX —
  say so in the hand-off if the deck's font choice is part of what was promised.
