---
name: design-harvest
description: Capture UI/design elements and design tokens from existing websites to reuse as inspiration when building new sites. Use when the user wants to "harvest"/"grab"/"analyze" the design of a site, pull UI elements or styling from reference sites, build a design reference library, or gather visual inspiration before designing a website. Extracts screenshots + palette/typography/spacing/component patterns into a structured reference library. Harvests patterns and tokens — never copies copyrighted assets wholesale.
---

# design-harvest

Turn live websites into a structured **design reference library** — screenshots + extracted
design tokens (palette, typography, spacing, radii, shadows) + key component patterns — so a
new site can be designed from real references instead of guesswork. Built for harvesting
*inspiration and patterns* for future sites (e.g. a school's website, or a studio's own site).

## Copyright guardrail (read first)
Harvest **patterns + design tokens** (colors, type scale, spacing, layout/interaction ideas) —
these are not copyrightable. **Do NOT** lift a site's exact CSS, images, logos, copy, or
proprietary components wholesale; that's trade-dress/copyright risk. The output is raw material
for an **original** synthesis, not a clone. Never harvest anything behind a login or paywall.

## Workflow

### 1. Scope
Confirm with the user: the target URL(s), and what they're building (so the synthesis is aimed).
Pick a project slug for the output folder (e.g. `school-site`, `studio-site`).

### 2. Harvest each site (use the Playwright MCP tools)
For each URL:
- `browser_navigate` to the URL; resize to a desktop width (e.g. 1440) and let it settle.
- **Screenshots:** `browser_take_screenshot` full-page, plus a few targeted shots (hero,
  nav, a card/section, footer). Mobile width (390) too if responsive design matters.
- **Design tokens:** run `scripts/extract_design_tokens.js` via `browser_evaluate` (paste the
  function as the argument). It returns JSON: top palette colors (text/bg/border by frequency),
  font families/sizes/weights/line-heights, a spacing scale, border-radii, shadows, and any
  `:root` CSS variables. Save it as `tokens.json`.
- **Component patterns (optional):** for 1–2 standout components, capture the rendered
  structure/notes (layout, states, interaction) — describe the *pattern*, don't copy the markup.
- **Name the macrostructure and archetypes, don't just say "modern/clean".** Research into
  competing anti-slop skills (merged into `design-research/bausteine/`, 2026-07-29) shows the
  field naming structures instead of vague adjectives — e.g. Nutlope's `hallmark` skill catalogs
  21 named macrostructures (`bento-grid`, `component-playground`, …) and 40+ named component
  archetypes (hero variants h1-h9, nav variants n1-n13, footer variants ft1-ft8, etc.). Adopt the
  same habit here: in `notes.md`, name the overall page structure you're looking at (e.g. "bento
  grid of feature cards", "full-bleed scroll narrative", "split-screen hero") and the archetype of
  each standout component (e.g. "sticky nav with inline search", "centered hero with single strong
  image + short tagline"), instead of settling for "modern" or "clean" — those two words carry no
  decision.
- Write a short `notes.md`: what's good here, what's worth borrowing, what to avoid.

### 3. Save to the reference library
```
design-references/<project>/
  <site-slug>/
    screenshots/        full.png, hero.png, nav.png, …
    tokens.json         extractor output
    notes.md            what to borrow / avoid
  BRIEF.md              cross-site synthesis (step 4)
```
(Default the library to the current repo unless the user wants it elsewhere.)

### 4. Synthesize a design brief
After harvesting all sites, write `BRIEF.md`: a recommended, **original** direction for the new
site — a proposed palette, type scale, spacing rhythm, component approach, and the few concrete
ideas worth borrowing from each reference (cited). This is the deliverable the design work uses.
Pair with the **frontend-design** skill when actually building the UI.

### 5. Turn the design brief into the Reference building block
`BRIEF.md` is raw material, not yet a prompt. Convert it into the **Referenz** part of the
four-part build prompt (Aesthetik/Referenz/Intent/Guardrails — see
`design-research/bausteine/vier-bausteine-prompt.md` for the full pattern and a worked example;
merged from two independent research sources, 2026-07-29):

- **Aesthetik**: the named design family the palette/type/component choices in `BRIEF.md` add up
  to (use the macrostructure/archetype vocabulary from step 2, not "modern/clean").
- **Referenz**: the harvested site URLs/screenshots, carried forward with the explicit instruction
  that must travel with them: take the FEELING (palette, rhythm, structure), never copy the
  harvested site's content or exact layout.
- **Intent** and **Guardrails** don't come from the harvest — pull Intent from what the user is
  actually building and for whom, and Guardrails from `BRIEF.md`'s "what to avoid" notes plus any
  known anti-patterns worth banning outright (adapt to the project; don't copy a fixed list).

## Notes
- If the Playwright MCP isn't available, fall back to the `claude-in-chrome` browser tools, or a
  standalone Playwright Python/Node script (`browser_evaluate` equivalent = `page.evaluate`).
- `extract_design_tokens.js` samples up to ~6000 elements and ranks by frequency, so the top
  entries approximate the site's actual design system. It reads computed styles only — no network
  scraping of assets.
- Keep the library free of any personal data.
