# Design skills — and the two tools they call

Four skills in `claude/skills/` cover the part of the work where an agent has to produce something
a person will *look at*: a website, a report, a proposal, a deck, a CV.

| Skill | What it owns |
|---|---|
| `design-bausteine` | The procedure between a brief and a deliverable: a four-part build prompt (aesthetic / reference / intent / guardrails), a fan-out from five directions to three variants to one, and a **capped** self-audit at the end |
| `design-critique` | The heavier review before something goes outside: two forced, isolated assessments — one reads the design, one *measures* it — and a single bounded fix round |
| `document-design` | Documents and decks: genre first, layout decisions written down, Typst / Touying / PPTX / DOCX, and no document called finished before every page has been rendered to an image and looked at |
| `design-harvest`, `framer-inspiration` | Gathering the reference material the first skill turns into a brief |

They work on their own. Two of them are stronger with a companion tool, and both companions are in
`shell/` — but only as the four-line wrapper that finds them:

- **`slop-detect`** — a deterministic lint over web source (Astro, HTML, JSX/TSX, Vue, Svelte,
  CSS) for the patterns that mark a generated frontend: side-tab accent borders, nested cards,
  icon-tile stacks, gradient text, numbered section labels without an order, bounce easing,
  em-dash overuse, contrast below AA. No model, no network, so it costs nothing to run on every
  change. `design-critique` uses it for the measuring half.
- **`docrender`** — renders a document (Typst source, PDF, DOCX, PPTX, ODT, ODP), rasterises
  every page, and reports what is visually wrong: margins, silent font substitution, text
  contrast, size inconsistency, orphaned headings, hyphenated headings, widow/orphan lines,
  measure in characters per line, missing folios. `document-design` calls it as its last step.

## Why only the wrapper is here

Both are separate projects with their own test suites, and they do not belong in a setup
bundle — vendored here, they would drift out of sync with their own repositories within days. So
`shell/docrender` and `shell/slop-detect` are four lines each: a comment naming the project they
come from, and one `exec` into the path where it is expected. Open either file to see the path it
wants, put your checkout there or edit the line, and the skills find the tool by name.

**Both skills work without them, and say so explicitly rather than skipping the step:**

- `document-design` has an *"If the tool is not installed"* section: render as usual, then walk
  `reference/antipatterns.md` — its *"Running the catalogue"* section carries the manual
  `pdffonts` / `pdftotext` / `pdftohtml` commands for the mechanical half — and record in the
  report that the tool was unavailable.
- `design-critique` says the same for `slop-detect`: compute the WCAG contrast of every
  text-on-background pair by hand (opacity utilities like `text-x/60` are where the real
  failures hide), count the measure, read spacing off the render, check heading levels for gaps.

That is the honest arrangement: the skills carry the judgement, the tools only make the
mechanical half cheap. If you write your own equivalents, the skills will use them — both are
invoked by name from `PATH`, not by path, and the shipped wrapper is a name you may repoint at
anything that answers the same way.

## The finding that shaped these skills

The skills were not written from opinion. An A/B test built the same brief twice on the same
stack — once with a plain frontend-design skill, once with a well-regarded anti-slop skill
(52k stars) driving it:

- **The output was not prettier.** Both pages passed all 58 of that skill's own mechanical rules
  with zero hits. Neither looked generated.
- **Both pages shipped the same real defects** — a contact form with no email field, a phone
  number that was not a `tel:` link, no mobile navigation. Only the page that ran a *mandatory
  critique* found them. The other had them too, undetected.
- **The mechanical rule that mattered most did not fire on either page.** Both had a genuine
  contrast failure (4.24:1 and 4.44:1 against the 4.5:1 floor, caused by Tailwind opacity
  utilities). That skill's contrast rule lives only in its browser-injection path and never ran
  in the static scan.
- **The model's own critique reported invented numbers.** It gave three contrast ratios; two of
  the three were wrong. Not vague — confidently wrong.

Three rules came out of that, and they are why the skills are shaped the way they are:

1. **The value is a forced second look, not a better first draft.** Hence two isolated
   assessments in `design-critique` instead of asking one agent to check itself.
2. **Never trust a model's measurements.** Anything numeric — contrast, measure, spacing — gets
   recomputed. `slop-detect` exists because a regex is cheaper and more honest than a guess.
3. **Cap the loop.** One build, one batched inspection covering desktop and mobile together, one
   fix round, then stop. Open-ended self-QA costs money without improving the result — a single
   landing page's mandatory critique ran up roughly 178,000 extra tokens.

A fourth rule came out of building the tools: **false findings are more expensive than missing
rules.** `docrender` initially reported 49 findings per document on its own house template
style — a margin column read as a too-narrow margin, a full-bleed title page as clipped content,
two grey levels apart as a contrast failure. Four calibration rounds against real, independently
built documents brought that to zero or one. A tool nobody trusts does not get run; a tool that
finds nothing is worse than one with false positives.
