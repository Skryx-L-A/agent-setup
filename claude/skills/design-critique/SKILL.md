---
name: design-critique
description: Review a client-facing or public UI before release when a stranger will judge it and the consequences justify a focused design check. Read the design and verify measurable claims, then make one bounded fix pass.
license: Own work; the two-isolated-assessment mechanism and the anti-loop cap were validated in an A/B test against pbakaus/impeccable (Apache-2.0) — see ~/AI/design-research/ab-test/. No text or code copied from that project.
---

# Design critique

Use this final review for a concrete public or client-facing surface, not for routine in-progress
feedback or a private change. `design-bausteine` remains the lighter build-time finish pass.

## Set the review boundary

Name the route or files, the release context, and the mode from `reference/modes.md`.
Read `reference/craft-floor.md` before assessing quality. Use a second independent perspective only
when it is available and justified by the release risk or an explicit request; otherwise make one
ordered pass and say that no independent pass was available.

## Read, then measure

1. Read the implementation and inspect the rendered desktop and mobile result together. Assess
   specificity, hierarchy, information architecture, typography, colour, states, and copy against
   the selected mode. Report two or three concrete strengths and three to five prioritised defects.
2. Verify every reported measurement instead of trusting an estimate. Use an available static
   analyser and browser tool when they answer the question; otherwise calculate or inspect the
   relevant contrast, overflow, line length, spacing, heading structure, and console output by hand.
   Record the method and any unavailable capability.
3. For text over an image, gradient, or video, inspect composed frames at the actual text lines;
   a declared foreground/background pair cannot prove contrast there. If the sibling `scroll-welt`
   skill is installed, its `reference/seiten-pruefung.md` supplies the detailed procedure.

## Fix once and report

Merge reading and measurement into one prioritised fix list. Apply one focused fix batch, then run
only the confirmation needed to establish that the changed defect is resolved. Do not add another
review round by habit; `~/.claude/regeln/verifikation.md` controls whether an additional check is
warranted. Report severity, evidence, corrections, remaining limits, and whether the review had an
independent perspective.
