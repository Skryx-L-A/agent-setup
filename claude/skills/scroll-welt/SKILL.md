---
name: scroll-welt
description: "Build a scroll-controlled camera journey through connected scenes using code, local video or both. Use for cinematic scroll, scrollytelling or fly-through landing pages."
---

# scroll-welt

Establish subject, audience, brand, scene sequence and camera path from the request. Ask only for missing creative choices that materially change the result. Choose code animation, local video or a mix from the actual quality, resource and motion needs; do not start a long generation job implicitly. Image generation follows `~/.claude/regeln/medien.md`.

Before implementing a scene driver, read the `render(t, ctx)` contract and relevant build section below. Render must be a pure function of scroll position, support reverse scrolling, use CSS pixels rather than multiplying DPR twice, reproduce seam frames and expose a ready promise for asset/shader preparation. Preserve reduced-motion fallback and the engine's lifecycle.

Use the existing engine and prompt references from this skill root. Resolve only the selected camera/video architecture; do not load every alternative. Inspect the affected motion once when visual behavior is the deliverable. Performance or frame-lock qualification is justified when choosing that path, but no automatic second judge, five variants or repeated review on a text-only change. Existing relevant evidence remains valid.

## Details nach Bedarf

Die folgenden Abschnitte bewahren konkrete Verfahren und Herkunft. Nur den zur Handlung passenden Abschnitt laden. Relative Befehls- und Ressourcenpfade darin beziehen sich auf den ursprünglichen Skillordner. Historische Modell-/Prüfvorgaben sind durch den Einstieg und aktuelle Hausregeln ersetzt.

- [Wegwahl](references/review-20260912/01.md)
- [Zwei Hürden auf dem lokalen Videoweg – ungeschönt](references/review-20260912/02.md)
- [Interview](references/review-20260912/03.md)
- [Vertrag für render(t, ctx)](references/review-20260912/04.md)
- [Bauschritte je Weg](references/review-20260912/05.md)
- [Das Nahtgesetz](references/review-20260912/06.md)
- [Telefon](references/review-20260912/07.md)
- [QA](references/review-20260912/08.md)
- [Gotchas](references/review-20260912/09.md)
- [Damit nicht jede Seite dieselbe Seite wird](references/review-20260912/10.md)
- [Einhängen in design-bausteine](references/review-20260912/11.md)
- [Referenzen](references/review-20260912/12.md)
