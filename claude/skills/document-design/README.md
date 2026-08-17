# document-design

A Claude Code skill for the documents that leave the house — Bericht, Angebot,
Lebenslauf, Whitepaper, Handbuch, Präsentation, Einladung, Zertifikat.

The setup already has plenty for websites (`project-kit:website`, `framer-inspiration`,
`design-harvest`, `frontend-design`) and nothing comparable for fixed pages. This closes
that gap. It is not a template pack: it is a way of working that ends with someone
looking at every rendered page.

## What it does

1. **Names the genre first.** Six document genres, each with the one thing that decides
   its quality — a report is not a whitepaper is not an invitation (`reference/genres.md`).
2. **Forces the layout decision.** The templates refuse to compile until `tokens.typ` has
   been rewritten for this document and every value carries a reason. This enforces the
   house rule that a document gets its own layout each time; a template that fills itself
   in violates it.
3. **Gives concrete starting values.** Measure, margins, baseline grid, size scale, ink,
   tables, figures, hyphenation — numbers, not principles (`reference/typesetting.md`).
4. **Ships a checkable anti-pattern catalogue.** 29 rules for printed pages, each with a
   measurement or a look, cross-referenced to what `docrender` checks mechanically
   (`reference/antipatterns.md`).
5. **Makes "render and look" the last step**, wired to the real `docrender`
   (`~/AI/design-tools/doc-render-review`) for the mechanical half, and to the
   catalogue by eye for everything a tool cannot judge.
6. **Adds an Office branch for when the recipient must edit the file.** Generators, not
   filled-in documents (`templates/office-report`, `templates/office-deck`) — same gate,
   same "render and look" discipline, with the weaknesses of PPTX/DOCX written down
   rather than hidden (`reference/antipatterns-office.md`).

## Layout

```
SKILL.md                 the skill itself (frontmatter + workflow)
reference/
  genres.md              six document genres and what decides quality in each
  typesetting.md         starting values: measure, margins, grid, scale, ink, tables
  antipatterns.md        29 checkable print anti-patterns, wired to docrender
  antipatterns-office.md Office-specific anti-patterns + the PPTX font-verification gap
  fonts.md               licensing, fetching, and choosing a pairing (no default pairing)
templates/
  report/                multi-page Typst: tokens · layout · content · build.sh
  deck/                  Touying deck with its own theme, not a shipped one
  office-report/         DOCX generator (python-docx): tokens.py · layout_docx.py · report.py
  office-deck/           PPTX generator (python-pptx): tokens.py · layout_pptx.py · deck.py
scripts/
  get-fonts.sh           fetch libre TTF + license from google/fonts into ./fonts
  check-fonts.sh         prove the PDF uses the fonts you chose, all embedded
  make-static-fonts.sh   variable font -> static Regular/Bold, required for Office embedding
  officefonts.py         DOCX/PPTX font-embedding engine (post-processes the OOXML package)
tests/run.sh             19 tests: both scripts, both gates, the example, the docrender wiring,
                         and the office branch's own gates/build/font-embedding/budget check
beispiel/                a worked three-page report, rendered and reviewed
.venv-office/            python-docx/python-pptx/fonttools for the office branch (not committed policy-wise, local only)
```

## Install

The orchestrator installs it after review — **do not copy it yourself**:

```bash
cp -r ~/AI/design-tools/document-design ~/.claude/skills/document-design
```

Everything is self-contained; `SKILL.md` references the other files by relative path.

## Requirements

- `typst` 0.15.1 (`brew install typst`)
- `poppler` for `pdftotext` / `pdffonts` (`brew install poppler`)
- `imagemagick` for the greyscale check (optional)
- network on first use for `scripts/get-fonts.sh` and for the Touying package
- `bild` (~/.local/bin) for images — local generation, never a cloud model
- Office branch only: `python-docx`, `python-pptx`, `fonttools` (a `.venv-office` next to
  this README has them already) and `libreoffice` (`brew install --cask libreoffice`) for
  the render-and-check step

## Using it directly

```bash
cp -r templates/report ~/AI/<projekt>/angebot && cd ~/AI/<projekt>/angebot
../../design-tools/document-design/scripts/get-fonts.sh ofl/<family> ofl/<other>
$EDITOR tokens.typ          # decide, write the why: lines, flip the gate
./build.sh report.typ       # PDF + page PNGs + font check
# then look at build/pages/*.png — that is the review, not an extra
```

## Using it directly (Office — only when the recipient must edit)

```bash
cp -r templates/office-report ~/AI/<projekt>/angebot && cd ~/AI/<projekt>/angebot
../../design-tools/document-design/scripts/make-static-fonts.sh fonts/<Variable>.ttf fonts
$EDITOR tokens.py                                   # decide, write the why: comments, flip the gate
OFFICE_PY=../../design-tools/document-design/.venv-office/bin/python3 ./build.sh
# then look at build/pages/*.png — same review step, same discipline as the Typst path
```

## Test

```bash
tests/run.sh                # 19 tests, throwaway dirs, no live state touched
NO_NETWORK=1 tests/run.sh   # skips the two that download
```

## Diese Installation

Installierte Fassung. Nicht mitkopiert, weil sie hier nichts nuetzen: beispiel/ (erprobter
Bericht), tests/run.sh, .venv-office/ — alle drei im Quellprojekt ~/AI/design-tools/document-design/
(Repo <your-github-user>/document-design, privat).

Der Office-Zweig braucht Python mit python-docx, python-pptx, fonttools:

    python3 -m venv .venv-office && .venv-office/bin/pip install python-docx python-pptx fonttools
    OFFICE_PY=.venv-office/bin/python3 ./build.sh

Der Pruefschritt ruft docrender (Repo <your-github-user>/doc-render-review, privat). Fehlt es, macht der
Skill die mechanischen Pruefungen von Hand — siehe den Abschnitt "If the tool is not installed" in
SKILL.md. Aenderungen im Quellprojekt machen, danach SKILL.md, README.md, reference/, scripts/ und
templates/ hierher kopieren.
