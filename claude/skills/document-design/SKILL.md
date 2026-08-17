---
name: document-design
description: Design and typeset documents that go out of the house — Bericht, Angebot, Lebenslauf, Whitepaper, Handbuch, Präsentation, Deck, Einladung, Zertifikat, Broschüre, Exposé; report, proposal, CV/résumé, whitepaper, manual, presentation, slide deck, invitation, certificate, brochure, one-pager. Use WHENEVER a request produces a PDF, a printed page, a slide deck or any fixed-page document, in German or English, even if the user only says "mach mir ein PDF", "schreib das Angebot", "Folien für morgen" or "put this in a document". Decides the genre first, writes down the layout decisions, builds with Typst/Touying, and never calls a document finished before every page has been rendered to an image and looked at.
---

# document-design

Documents are the things that actually leave the house: the offer a client reads, the CV
in a stack of forty, the report someone forwards. They fail differently from web UI —
a page has a fixed frame, no scroll, no hover, no responsive fallback, and the reader
cannot resize their way out of a bad measure. This skill is how a document gets designed
instead of generated.

Two rules carry the whole thing. Everything else is detail.

## Rule 1 — this document gets its own layout

Content may be carried over from a previous version, a sample or a template. **The layout
is decided anew, every time.** A document produced by filling in a shipped template is
the thing this skill exists to prevent — that is why the templates here **do not compile**
until their `tokens.typ` has been rewritten and its gate flipped:

```
error: Layout for this document has not been decided yet.
       Open tokens.typ, replace every value with your own decision for THIS document,
       write the reason on each `why:` line, then set design-decided = true.
```

Flipping the flag without rewriting the values passes the compiler and fails the rule.
The `why:` lines are the check: a value you cannot justify in half a sentence is a
default someone else chose.

## Rule 2 — "it compiled" is not a quality statement

A compiler checks that the source is valid. It does not check whether the line is too
long, whether a heading is stranded at the foot of a page, whether the table left the
type area, or whether a font was silently substituted. **Every page is rendered to an
image and looked at before the document is finished.** No exceptions for small documents,
none for deadlines.

---

## Workflow

### 1. Name the genre (before the first character)

Read `reference/genres.md` and place the request in one of six: **Lesestrecke ·
Nachschlagewerk · Entscheidungsvorlage · Selbstdarstellung · Anlass · Vortragsstütze**.
The genre answers who reads it, how long, and in which order — and that answers almost
every layout question that follows. If the request straddles two, pick the one that wins
and say so. One question to the user is enough: *"Wer liest das, und wie lange?"*

### 2. Pick the tool (recommendation, not a menu)

| Situation | Use | Why |
|---|---|---|
| Anything multi-page: Bericht, Angebot, Handbuch, Whitepaper, CV | **Typst 0.15.1** | deterministic typesetting, PDF *and* page PNGs locally, one command |
| Slide deck, PDF is the deliverable | **Touying 0.7.4** (on Typst) | same typography as the documents, stable output, no browser |
| Slide deck where motion or free layout decides | **Slidev** | web-native, real animation; not editable in PowerPoint |
| Recipient must edit the file themselves | **PPTX/DOCX**, and only then | absolute coordinates, font substitution, overflow — always render to PDF and check |
| Fast, uniform briefings from Markdown | Marp | quick and repetitive-looking; fine for internal |
| Cloud generators (Gamma & co.) | only with explicit approval | data leaves the house |

The two templates in `templates/` are the starting points: `templates/report` (multi-page,
baseline grid, margin column, tables, figures) and `templates/deck` (Touying, own theme
rather than a shipped one). They ship the **mechanics**; their look is an example and gets
replaced.

**HTML/CSS print routes, measured against Typst on the same content (2026-07-29,
`~/AI/design-research/vergleich/`, one document rendered three ways from one shared
`content.json`, every page looked at, `pdffonts` on all three):**

| | Typst 0.15.1 | WeasyPrint 69.0 | Paged.js (pagedjs-cli) |
|---|---|---|---|
| Build time (median of 3) | 0.10 s | 0.65 s | 1.85 s |
| Runtime dependency | none | Python | Node + Chromium |
| Font embedding | 3/3 clean | 4 expected **+ 1 silent fallback** (Hiragino Sans, one missing glyph) | 4/4 clean |
| Table page-break, head repeats | yes, but only outside `figure()` (see below) | yes, no manual work | broken: head does not repeat despite correct CSS |
| Footnote numbering | correct | correct, spec-accurate | broken: repeated footnotes on a page share one number |
| Fights needed to get there | 6 (see full report) | 2 | 5 |

Typst stays the recommendation: fastest by 6–18×, no runtime to install, and the
only one of the three with clean font embedding in this run. **WeasyPrint is a
reasoned second choice** — more spec-accurate on footnotes and repeating table
heads than Typst, no manual column tuning — but it silently substituted a system
font for one missing glyph, exactly the failure this skill warns about elsewhere:
if HTML/CSS is used for print, `pdffonts` after every export is not optional.
**Paged.js is not recommended for production** — its footnote numbering and
table-head repetition are confirmed silent bugs, not missing polish, on the exact
CSS that produces correct output in WeasyPrint. Full comparison, all three PDFs
and page images: `~/.pi-workers/results/vergleich/20260729-213630.md`.

**Two measured gaps in Typst itself, now documented instead of assumed:**

- **No `orphans`/`widows` property exists in Typst 0.15** — there is no way to even
  declare "keep 3 lines together" the way CSS's `orphans: 3; widows: 3` does.
  `reference/typesetting.md` §9 and `reference/antipatterns.md` P3 cover the
  mitigation (layout discipline + the page-image look), but it is discipline and
  an eye, not an engine feature — say so instead of assuming the tool catches it.
- **`figure()` cannot break across pages, and neither can a `block(breakable: false)`**
  (the pattern this skill's own `dtable()` in `templates/report/layout.typ` uses)
  — a table long enough to need two pages does not error, it silently loses every
  row past the page edge. Confirmed here: a 30-row table wrapped in `figure()` on a
  page too short for it compiled with exit 0 and one page, rows gone with no
  warning; the same rows as a raw `table(..)` with `table.header(..)`, outside
  `figure()`, broke correctly across 5 pages with the head repeated. Decide at
  the tokens stage whether a table could ever exceed one page; if yes, build it
  breakable from the start (`reference/typesetting.md` §7, `reference/antipatterns.md` N4).

### 2b. Office specifically: when, and when not

PPTX/DOCX is the weakest path this skill builds — absolute coordinates instead of
flowing text, silent font substitution on the recipient's machine, no page compiler
to catch an overflow. It exists here because a document the recipient cannot open or
cannot edit is worthless regardless of how well it is set. Four situations decide it,
in order:

1. **The recipient must edit the file themselves** (they will add rows, change
   numbers, redline it in Word) → Office. This is the only reason that overrides
   everything below.
2. **The recipient only reads it** → PDF from Typst, always. Nothing about Office
   is better for a reader; it is only better for an editor.
3. **A client corporate template exists** (`.dotx`/`.potx`) → Office, and the
   template *is* the design decision — see "Corporate templates" below. Do not
   design a new layout on top of someone else's brand system.
4. **None of the above** → Typst. Build the Office file only as an *additional*
   export, and only if explicitly asked for one — never as the default because it
   felt like the safer format.

**Where it stays behind Typst even when chosen correctly:** there is no baseline
grid, no automatic reflow (a placeholder that overflows does so invisibly in the
source, not at compile time), font embedding requires post-processing the OOXML
package by hand (`scripts/officefonts.py` — neither python-docx nor python-pptx
supports it), and — found while building this branch, not assumed — **PPTX font
embedding cannot be confirmed by rendering it locally**: LibreOffice Impress does
not appear to read a pptx's own embedded fonts on import, so `docrender`'s
font-fallback check and the "look at every page" step both lose their power to
verify typography on a deck specifically. See
`reference/antipatterns-office.md` "Known gaps" for the full, empirical finding.
Choose Office because the recipient needs it, not because it feels safer than Typst.

The generators are in `templates/office-report/` (a DOCX, `python-docx`) and
`templates/office-deck/` (a PPTX, `python-pptx`) — a Python **generator**, not a
filled-in document, with the identical gate as the Typst templates:
`tokens.py` with `# why:` comments and a `DESIGN_DECIDED` flag that must be `True`
before `report.py`/`deck.py` will write anything. Fonts must be static Regular/Bold
instances (`scripts/make-static-fonts.sh` turns a variable font into them — Office,
unlike Typst, does not interpolate a variable font's weight axis). A PPTX slide is
16:9 at **10 × 5.625 inches**, not 13.3in wide — check this on any deck built by
hand, it is a common and documented mistake. `./build.sh` in either template folder
generates, converts through LibreOffice, rasterises, and prints the same `docrender`
invocation the Typst templates use (`docrender review deck.pptx …`), with the PPTX
font-fallback caveat above already printed in the script's own output.

**Corporate templates** (a client's `.dotx`/`.potx`): not what the generators above
build. Render the template's own placeholders as thumbnails first
(`soffice --headless --convert-to png`), inventory what already exists, then fill
those placeholders with `python-docx`/`python-pptx` — never lay a new text frame
over an existing one. The template *is* the design contract; the job is content,
not layout.

### 3. Write the decisions down

Copy the template, then work through `tokens.typ` top to bottom: page and margins,
vertical grid, measure in characters, fonts, size scale, ink, detail decisions. Every
value gets a `why:`. Starting values with the reasoning behind them:
`reference/typesetting.md`. Fonts, licensing and how to choose a pairing without falling
back on a default: `reference/fonts.md`.

Set the gate to `true` only when the file is genuinely yours.

### 4. Write the content, styled by nothing

Content goes in the entry file (`report.typ`, `deck.typ`) with headings, paragraphs,
tables and figures — no sizes, no colours, no spacing. A `#text(size: …)` in the content
file means a decision is in the wrong place.

Images: generated locally with `bild` (see the house rule), diagrams as SVG. Never stock,
never a placeholder, never an abstract image standing in for a missing thought.

### 5. Build, render, and look

```bash
./build.sh report.typ      # PDF + build/pages/page-N.png + text extract + font check
```

Then **read every page image**. This is the review step; nothing else substitutes for it.

`docrender` does the mechanical half first — margins, font fallback, contrast, size
consistency, orphan headings, missing folios, and every Typst compiler warning, each with
a page number and an exact fix:

```bash
# `docrender` is on PATH (~/.local/bin). Fall back to the project venv only if that
# wrapper is missing: <repo>/doc-render-review/.venv/bin/docrender
docrender review build/report.pdf --expected-fonts "Faustina,Archivo" \
      --json-out build/review.json --text-out build/review.txt
```

It also takes the source directly (`docrender review report.typ`), which additionally turns
compiler warnings into findings — the better call while you are still building. Useful
flags: `--min-margin-mm` (18), `--min-contrast` (4.5), `--fail-on {high,medium,low}`
(medium), `--vision {auto,ollama,claude,none}`, `--out DIR` for the rendered pages.

**What the exit code means:**

- **0** — nothing at or above `--fail-on`. You still look at the page images; the tool
  does not judge whether the document is *designed*, only whether it is broken.
- **1** — findings. Read them, decide per finding: fix it, or record why it stands. Two
  known false-positive shapes on well-made documents, both seen on this skill's own
  example: a **photograph** trips the contrast tile check (it measures ink against paper,
  and a photo is neither), and the **dominant-size check counts text runs, not
  characters**, so a page full of body text can be flagged as deviating from pages full of
  table rows and captions. Say so in the report instead of "fixing" a correct document.
- **2** — the tool failed (bad input, render failed, missing tool). Run
  `docrender tools` for what is missing and its `brew` hint; do not read exit 2 as "clean".

**Vision layer:** `--vision auto` tries a local Ollama model, then the `claude` CLI, then
runs mechanical-only. A local model costs memory — run `check-resources` first, and
`ollama stop <model>` after. It is the only path that catches squeezed table columns.

`docrender fix report.typ` can apply the fixes itself (Typst sources only, hard-capped at
two rounds). Use it for mechanical defects; keep design decisions in your own hands.

**If the tool is not installed** (`docrender: command not found`, or the venv path above
does not exist): render as usual with `./build.sh`, then do the same checks by eye against
`reference/antipatterns.md` — its "Running the catalogue" section carries the manual
commands for the mechanical part — and state in your report that the tool was unavailable.
Never silently skip the review because the helper is missing.

Either way, finish by walking `reference/antipatterns.md` yourself. The rules that decide
whether a document looks made or generated — density, three equal boxes, a caption that
restates its heading, a stock image standing in for a missing thought — are the ones no
tool checks.

### 6. Fix once, confirm once, stop

Change only what the review named, in the source, and render again. **At most two rounds.**
A third round is not polishing, it is looking for something to do. (The rule is borrowed
from impeccable's anti-loop rule and holds just as well on paper.)

### 7. Hand-off checks

- `scripts/check-fonts.sh build/*.pdf` — only the intended fonts, all embedded.
- Greyscale test if it may be photocopied: `magick page-1.png -colorspace Gray x.png`.
- `pdftotext -layout` — reading order and structure intact.
- License files for the fonts present in the project.
- Date and version on anything that leaves the house.

---

## Files

| Path | Load when |
|---|---|
| `reference/genres.md` | always, at step 1 |
| `reference/typesetting.md` | at step 3, for concrete starting values |
| `reference/antipatterns.md` | at step 5, and again after the fix round |
| `reference/antipatterns-office.md` | at step 5, for a DOCX/PPTX document — read together with `antipatterns.md`, not instead of it |
| `reference/fonts.md` | when choosing or fetching fonts |
| `templates/report/` | any multi-page document |
| `templates/deck/` | any PDF slide deck |
| `templates/office-report/` | recipient must edit a multi-page document (step 2b) |
| `templates/office-deck/` | recipient must edit a slide deck, or a corporate `.potx` exists |
| `scripts/get-fonts.sh` | fetch libre fonts + license into `fonts/` |
| `scripts/check-fonts.sh` | after every export |
| `scripts/make-static-fonts.sh` | before using a variable font in either office template — Office needs static Regular/Bold files |
| `scripts/officefonts.py` | the DOCX/PPTX font-embedding engine both office templates call; not invoked directly |
| `beispiel/` | a worked three-page report: decided tokens, real content, rendered pages |

## Guardrails

- No emoji in any document, ever.
- Media is generated locally (`bild`, `video`, `tts`) — never a paid cloud model.
- Fonts are self-hosted and libre-licensed, with the license file in the project.
- Cloud document services only with explicit approval; the content leaves the house.
- A shipped template is a starting point. A shipped template used unchanged is a copy —
  and the recipient of the second document will recognise the first.
- Office is the exception path, not the default (step 2b) — pick it because the
  recipient must edit the file, not because it feels safer than a PDF.
- A pptx font-fallback finding from `docrender` is not proof of a real fallback —
  confirm against the file's own embedded-font XML before "fixing" a correct deck
  (`reference/antipatterns-office.md`, "Known gaps").
