---
name: framer-inspiration
description: Pull modern web-design inspiration from Framer's public galleries (the "Made in Framer" showcase, the template marketplace, and live *.framer.website demos) before and while building any website. Use this WHENEVER building, designing, redesigning, restyling, or mocking up a website, landing page, marketing site, portfolio, blog, agency/business site, web app frontend, or any web UI — even if the user never mentions Framer. Run it at the start of the design/build, automatically, without being asked.
---

# framer-inspiration

Framer hosts some of the best-designed sites on the web. Use its **public, login-free
galleries** as a living moodboard so every site you build starts from real, polished,
modern references instead of generic AI defaults.

This skill is the **inspiration front-half** of a website build. After gathering
references here, you build in the user's own stack (Astro, Next, plain HTML/CSS, etc.) —
**not** inside Framer.

## Honest constraints (read once)

- Framer is a GUI SaaS builder. It has **no site-building CLI** and **no public read API**.
  Its AI features (Wireframer, Workshop, Server API, MCP plugin) all need a Framer login +
  an open editor — unusable from here.
- The **only** login-free way to use Framer is reading its **public hosted pages**. That is
  exactly what this skill does. Treat everything as **inspiration**: study layout, section
  order, type scale, color, spacing, and motion — **never copy assets, text, or code**.

## When to run

Automatically, at the start of any website/web-UI design or build — no prompt needed.
The global rule in `~/.claude/CLAUDE.md` mandates this; this skill is how you satisfy it.
Skip only if the user explicitly says not to, or the task has nothing to do with web UI.

## Workflow

### 1. Read the brief → niche + style
From the user's request, infer the **site type** (portfolio / agency / business /
ecommerce / blog / landing-page) and the **desired look** (dark, colorful, minimal,
animations, grid, large-type). If unclear, pick the closest and note the assumption.

### 2. Resolve the Framer URLs (deterministic)
Run the bundled CLI — it maps the brief to the right public gallery URLs:

```bash
framer-inspo "dark animated SaaS landing page for an AI startup"
framer-inspo --urls "minimal photographer portfolio"   # URLs only, for scripting
framer-inspo --list                                     # all categories + styles
```

(`framer-inspo` is on PATH; source lives next to this file. It needs no login/network —
it just emits the correct `framer.com/gallery/...` and marketplace URLs.)

URL shapes it returns:
- Showcase by type: `https://www.framer.com/gallery/categories/<type>/`
- Showcase by look: `https://www.framer.com/gallery/styles/<style>/`
- All showcased sites: `https://www.framer.com/gallery/`
- Templates (full multi-page designs, each with a live demo): `https://www.framer.com/marketplace/templates/`

### 3. Gather references
Fetch the resolved gallery pages (WebFetch is fine). Pick **3–6** examples that fit the
brief. Each showcase entry and each template links to a **live demo** (usually
`<name>.framer.website`) — open the demos for the real layout + motion, not just a thumbnail.

For richer extraction (screenshots + design tokens: palette, type scale, spacing, radii,
shadows, component patterns), **hand the chosen live-demo URLs to the `design-harvest`
skill** instead of re-inventing it. `framer-inspiration` finds *what* to look at;
`design-harvest` extracts *the tokens*.

### 4. Synthesize an Inspiration Brief
Produce a short brief that will steer the build:
- 3–6 reference URLs + one line each on why it fits.
- Layout pattern: hero style, section order, nav/footer approach.
- Type system: heading vs body scale, weight/contrast, any display type.
- Color direction: background/foreground, accent usage, dark/light.
- Motion ideas: scroll reveals, hovers, transitions worth echoing.
- 2–3 distinctive details worth adapting (not copying).

### 5. Turn the Inspiration Brief into the Reference building block
The Inspiration Brief from step 4 is raw material, not yet a prompt. Convert it into the
**Referenz** part of the four-part build prompt (Aesthetik/Referenz/Intent/Guardrails — see
`design-research/bausteine/vier-bausteine-prompt.md` for the full pattern and a worked example;
merged from two independent research sources, 2026-07-29). Concretely:

- **Aesthetik**: name the design family the chosen references share (e.g. "atmospheric-editorial",
  "brutalist-warm") — not "modern and clean", that names nothing decidable.
- **Referenz**: the 3-6 URLs/screenshots from step 3, carried forward verbatim, plus the explicit
  instruction that ships with them every time: *take the FEELING, never copy content or layout.*
- **Intent** and **Guardrails** do not come from Framer — pull Intent from the user's brief
  (what's being built, for whom, what action should follow) and Guardrails from the project's
  brand constraints plus known anti-patterns worth banning outright (e.g. no purple/violet
  gradients, no default Inter, no 3D SaaS blobs — adapt to the actual project, these are examples
  of how concrete a guardrail must be to work, not a fixed list to copy).

Emit this as a short, four-part block the build step consumes directly — don't leave the mapping
implicit in prose.

### 6. Build
Carry the four-part prompt (built in step 5) into the build in the user's own stack. Pair with the
`frontend-design` skill for polished, non-generic implementation. Re-derive everything in
the user's code/brand — Framer is the muse, not the source.

For genuinely new designs with real creative range (not a small iteration on an already-fixed
look), consider the **fan-out procedure** instead of a single build: build 5 aesthetic directions
in parallel (worker grid) or in sequence (solo session), compare side by side, narrow to 3 layout
variants of the winner, then 1 — see `design-research/bausteine/faecher-verfahren.md` for the full
procedure in both operating modes.

## Guardrails
- Inspiration and patterns only. No wholesale copying of copyrighted layouts, assets, copy, or code.
- Respect the user's existing brand/palette/stack — Framer trends never override a project's identity.
- No emojis in any UI/output you produce for the user's apps (global rule).
- If the galleries are unreachable, say so and fall back to `design-harvest` on other reference sites — don't silently skip inspiration.
