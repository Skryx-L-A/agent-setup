---
name: setup-audit
description: Runs this workbench's own hygiene tools (wb-hygiene, which bundles wb-consistency, claude-md-lint, and status-freshness) and adds the one layer none of them can do mechanically — judging CLAUDE.md, regeln/*.md, roles/*.md, models.json, and the skills directory against the six context-engineering shifts (rules to judgement, examples to interfaces, upfront to progressive disclosure, repetition to one home, CLAUDE.md-memory to auto-memory, simple specs to rich references). Reports findings with exact file:line, changes nothing until der Nutzer approves. This is a checkup of THIS workbench's own setup, not a generic codebase audit. Triggers: "/setup-audit", "setup audit", "Setup-Audit", "audit unser Setup", "prüf das Setup", "Kontext-Checkup", "context checkup", "Regel-Audit", "then and now audit", "context engineering audit", "extended doctor", "doctor plus".
---

# Setup Audit

A periodic checkup for this workbench's own context: CLAUDE.md, `regeln/*.md`, `roles/*.md`,
`~/.claude/workbench/models.json`, and `~/.claude/skills/*`. Adapted from a foreign skill
(robonuggets/doctor-plus) that runs `claude doctor` plus a workspace audit against six
context-engineering shifts. Its two soundest ideas carry over unchanged: **audit principles,
not keywords**, and **safety/money/approval rules are never "too strict."** Everything else
about it was rewritten — see below.

## What changed from the foreign skill, and why

- **Mechanical checks are not reimplemented.** The foreign skill audits size, duplication, and
  dangling references itself, in prose. This setup already has `wb-hygiene` (bundles
  `wb-consistency`, `claude-md-lint`, `status-freshness`) doing that mechanically. Part 1 below
  calls it and reads its output — it does not re-derive what it already measures.
- **The six shifts stay, reworded for a router setup.** The foreign skill's table assumed one flat
  CLAUDE.md. Here CLAUDE.md is a router with a Verweisbaum into `regeln/*.md`, two role prompts,
  and a generated model registry — the shift descriptions below point at those specific files.
- **"Repeats to tool descriptions" narrowed to "one home over repetition."** `wb-consistency`'s
  check 2 already catches drifted *generated* blocks (the ones wrapped in
  `<!-- marker:start/end -->` with a declared hash). It does **not** catch a hand-written
  paragraph copy-pasted into two files without a marker — that gap is exactly what Part 2's
  judgement pass exists for.
- **Dropped:** the foreign skill's generic "map the workspace, don't assume the layout" framing.
  This setup's layout is fixed and documented (CLAUDE.md's own Verweisbaum) — reading that table
  IS the map.

## Part 1 — mechanical layer (call it, don't rebuild it)

1. Run `wb-hygiene` (no args; read-only, exit 1 only if size cap or `wb-consistency` found
   something). Read its four sections and carry the findings forward — do not re-grep for size,
   duplicate generated blocks, or dangling `` `tool-name` `` references yourself.
   - If `wb-hygiene` is missing or fails outright, fall back to running `wb-consistency`,
     `claude-md-lint`, and `status-freshness` individually and say so.
2. Run `claude doctor` via Bash with a 60s timeout. Summarize its findings if it completes; if it
   hangs or wants an interactive screen, note "run `/doctor` yourself for the built-in half" and
   move on. Never block on it.

## Part 2 — the six shifts (the judgement layer no tool runs)

Scope: whatever loads as context in a real session — `~/.claude/CLAUDE.md`, every file in
`regeln/` (each has its own trigger line — check whether the trigger still matches a real tool or
rule), `roles/agent.md` and `roles/orchestrator.md` (both load in full, in different session
types), `~/.claude/workbench/models.json`, and `~/.claude/skills/*/SKILL.md` (loaded by
description only until invoked — that IS progressive disclosure; judge the description, not the
body, for shift 3). Exclude `~/.claude/workbench/sessions/`, `locks/`, and anything under
`~/.local/state/`.

**Judge the principle, not the surface pattern.** A file can smell fine and still break a shift;
something can look verbose and still be a deliberate, reasoned tradeoff (several rule files here
explain their own reasoning inline — that explanation is itself evidence to weigh, not something
to ignore because it's prose).

1. **Judgement over rules** — is a directive constraining a matter of taste/style where judgement
   would serve better, or do two directives pull against each other? Never flag secrets handling,
   e-mail send approval, snapshot-before-destructive-ops, push authority, `wb-shot`/recording
   rules, or the test-isolation rules in `regeln/tests-und-eingriffe.md` — those are exactly the
   safety/money/approval class this shift explicitly exempts.
2. **Interfaces over examples** — do skills or tools teach through a worked example where a
   cleaner interface would carry the point? (`wb-request`'s enforced `--files/--done/--why/--est`
   flags are the setup's own good example of this shift already applied — use it as the bar, not
   as something to re-flag.)
3. **Progressive disclosure over upfront loading** — does every line in an always-loaded file
   (CLAUDE.md, both role prompts, any `regeln/*.md` actually loaded unconditionally) earn its
   place, versus detail that's only occasionally needed sitting where it loads every session?
4. **One home over repetition** — same instruction restated in two files with no single
   authoritative source, especially where `wb-consistency` can't see it because there's no
   generated-block marker to compare (hand-written prose duplication is invisible to check 2 by
   construction — that's this shift's actual territory).
5. **Auto-memory over guidance-file memory** — are facts about der Nutzer, a project, or a decision
   sitting as prose in a `regeln/*.md` file or CLAUDE.md instead of the memory system, where nothing
   about them requires always-loaded reliability?
6. **Rich references over simple specs** — is an active build or check steered by a plain
   markdown description where a cheap higher-fidelity reference already exists or would (code, a
   config schema, a generated table, a test) — or, conversely, has this setup already done this
   well somewhere worth citing as the bar (the `models.json` registry driving the generated
   routing table is this setup's own good example)?

## Part 3 — report, then wait

One findings table: shift, verdict (PASS/FLAG), worst offender with `file:line`, suggested fix.
**Show everything first, change nothing until der Nutzer approves.** After approval, apply one shift
at a time and re-verify. A finding with no file and no cited passage is not a finding — cut it.
A zero-hit shift is not proof of a clean pass until the always-loaded set (CLAUDE.md + both role
prompts + whatever `regeln/*.md` files a session-start actually loads) has actually been read this
run, not recalled from a prior one.
