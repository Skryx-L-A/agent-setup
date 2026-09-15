---
name: document-design
description: Design and typeset a PDF, printed page, slide deck, or other fixed-page document when the user asks for a deliverable that people will read or present. Decide the genre and layout for this document, then render and inspect the completed pages.
---

# Document design

Every document gets a layout chosen for its audience and genre. Reuse content or mechanics when
helpful, but do not treat a shipped visual template as a finished design decision.

## Build the document

1. Read `reference/genres.md` and name the genre before writing: it determines reader, sequence,
   density, and hierarchy. Ask only for an audience or use constraint that materially changes it.
2. Choose an available format for the recipient: use the stable local typesetting route for a
   reading deliverable; use DOCX/PPTX when the recipient must edit it or provides a corporate
   template; use a cloud service only with applicable authorization.
3. Write the layout decisions down before styling content: page, measure, type, spacing, colour,
   images, and their reasons. Load `reference/typesetting.md` and `reference/fonts.md` when making
   those choices. Keep document content free of one-off styling overrides.
4. Build with the chosen project's existing template or toolchain. For an Office corporate template,
   inspect its placeholders and fill them; do not draw a competing layout over the brand system.
5. Render the completed document and inspect every page image. Fix concrete defects at their source
   and render the affected result again. This visual inspection is the document's acceptance check;
   use available mechanical helpers as support, never install a tool merely to run them.

## Delivery

Check reading order, required fonts, dates, versions, and accessibility or printing needs that are
material to this document. Apply additional checks only where `~/.claude/regeln/verifikation.md`
gives a reason; do not add a generic second review. State unavailable tooling or residual limits.

## References

| Resource from this skill root | Load when |
| --- | --- |
| `reference/genres.md` | choosing the document genre |
| `reference/typesetting.md` | deciding layout values or complex tables |
| `reference/antipatterns.md` | inspecting rendered pages |
| `reference/antipatterns-office.md` | producing DOCX/PPTX or using a corporate template |
| `reference/fonts.md` | choosing or licensing fonts |
| `reference/historical-workflow-2026-09-12.md` | a Typst, Office, render-helper, or known-engine edge case needs the detailed established procedure |

## Guardrails

- Keep content, visual design, and reproducible mechanics separate.
- Use the media route in `~/.claude/regeln/medien.md` (GPT images first, local fallbacks) and appropriately licensed fonts.
- Do not claim a rendered page or a tool check succeeded without seeing its result.
- The historical reference preserves the former detailed workflow; its relative resources resolve
  from this skill root, not from its own directory.
