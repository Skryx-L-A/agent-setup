# Fonts — licensing, fetching, and choosing without a house pairing

## The rules that never change

1. **Self-hosted.** The font files live in the project, in `fonts/`. Never a system font,
   never a webfont CDN, never "it looks right on my machine".
2. **Libre-licensed.** OFL-1.1 or Apache-2.0. The **license file ships with the project**,
   next to the fonts (`scripts/get-fonts.sh` fetches it automatically).
3. **Typst always with `--font-path fonts --ignore-system-fonts`.** Without the second
   flag a typo in a family name silently resolves to something installed on this machine
   and to nothing on the next one.
4. **Check after every export.** `scripts/check-fonts.sh build/*.pdf` — a fallback is
   invisible in the source and obvious in the PDF's font list.

## Where the files come from

**[verified]** The `@fontsource-variable/*` packages that most guides recommend ship
**WOFF2 only**. That is the right thing for HTML and Slidev, and useless for Typst, PPTX
and DOCX, which need TTF/OTF. So:

| Target | Source | Format |
|---|---|---|
| Typst, PPTX, DOCX | `github.com/google/fonts` (or the foundry's release) | TTF/OTF |
| HTML, Slidev, Marp | `@fontsource-variable/<family>` | WOFF2 |

```bash
scripts/get-fonts.sh ofl/faustina ofl/archivo          # into ./fonts, with OFL.txt
typst fonts --font-path fonts --ignore-system-fonts --variants
```

That last command is not optional: **the family name Typst reports is the name your
document must ask for.** A family with an optical-size axis is often called something you
would not guess — `Newsreader` is reported as **"Newsreader 16pt"** (verified), and
`font: "Newsreader"` falls back silently.

**[verified]** Typst 0.15.1 does interpolate the weight axis of a variable font: one
`Faustina[wght].ttf` covers 300–800 with real, drawn weights, not synthesised ones. One
variable file is usually a better answer than six static weights.

## Choosing — a method, not a recommendation

There is deliberately **no default pairing in this skill**. A default pairing applied to
every document produces exactly the uniform look the skill exists to prevent. Work the
method instead; it takes five minutes.

1. **Pick the text face from the reading mode** (see `genres.md`).
   Continuous reading wants a text face with a large x-height and short extenders, tested
   at the actual size. Reference material tolerates — sometimes prefers — a sans with
   unmistakable figures. An occasion piece may be led by a display face, with a quiet
   text face underneath.
2. **The second face must differ in structure, not in name.** Compare stress (diagonal vs
   vertical), aperture, and skeleton. Test: set one word in both at the same size. If you
   have to look twice to tell them apart, one of them is redundant — use one family with
   more weights instead.
3. **Prefer range over count.** A variable family with weight *and* width (e.g. a
   grotesque with `wdth`) can carry headings, labels, tables and folios by itself.
4. **Check the figures.** Tabular lining figures are required for anything with a table;
   old-style figures suit continuous prose. A family without a tabular set is disqualified
   for a document with numbers in columns.
5. **Check the language.** German needs ä ö ü ß and the capital ẞ; check €, and the
   quotes „ " ‚ '. Render a test line with all of them before committing.
6. **Check it at size.** Render a page at the real size and look at it at 100 %, not
   zoomed. A face that is elegant at 40 pt can be unreadable at 9 pt, and vice versa.
7. **Write down why.** The `why:` line in `tokens.typ` for `font-text` and `font-display`
   is where a choice becomes a decision.

## Practical shortlist to start the search from

Libre, print-capable, and deliberately *not* a ranked recommendation — start here, then
choose against the method above.

- **Text serifs:** Faustina, Newsreader, Source Serif 4, Spectral, Literata, Vollkorn,
  EB Garamond, Petrona, Crimson Pro.
- **Text and label sans:** Archivo, Public Sans, IBM Plex Sans, Inter, Work Sans,
  Libre Franklin, Space Grotesk.
- **Display / occasion:** Fraunces, Bodoni Moda, Playfair Display, Instrument Serif,
  Big Shoulders.
- **Mono:** IBM Plex Mono, JetBrains Mono, Space Mono.

Inter and Source Serif 4 are a perfectly good pair, and they are also the pair everyone
uses. If a document is meant to look like the sender rather than like a template, spend
the five minutes.

## Failure modes worth knowing

- A missing weight is **synthesised** (smeared) rather than refused — look at the render.
- `Italic` files must be fetched too; Typst does not slant a roman for you correctly.
- PPTX/DOCX embed by name and substitute on the recipient's machine: for those formats
  the safe answer is a font the recipient has, or an exported PDF.
- Subsetting is fine; a **non-embedded** font in the PDF is not — `check-fonts.sh` fails
  the build on it.
