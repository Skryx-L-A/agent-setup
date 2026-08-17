---
name: design-bausteine
description: The verfahren between a design brief and a finished visual deliverable — turning a request into a four-part build prompt (Aesthetik/Referenz/Intent/Guardrails), deciding whether to fan out multiple directions before committing, and closing with a capped self-audit. Use for ANY visual build or redesign with real creative range — website, landing page, document, report, presentation, deck, CV, poster — in German or English ("baue eine Website", "gestalte eine Praesentation", "entwirf ein Dokument", "design a landing page", "mock up a deck"). This is NOT for gathering inspiration (that's framer-inspiration) or extracting tokens from one existing site (that's design-harvest) — it is the step in between and after: brief → build order → variants → acceptance. Run it whenever a build starts, and again at the end to close it out.
---

# design-bausteine

Drei Muster aus unabhaengigen Design-Recherchen (`~/AI/design-research/BEFUND.md`, 2026-07-29),
zu einem Verfahren zusammengefuehrt: wie ein Bau-Auftrag formuliert wird, wie viele Richtungen
vor der Festlegung geprueft werden, und wie ein Ergebnis als fertig gilt statt nur als gebaut.

Dieser Skill ist **kein** Ersatz fuer die Skills, die er umklammert — er ruft sie an der
richtigen Stelle auf, statt sie zu wiederholen:

| Skill | Rolle | Wann |
|---|---|---|
| `framer-inspiration` | Web-Inspiration sammeln | vor Schritt 1, wenn die Referenz fehlt |
| `design-harvest` | Tokens/Makrostruktur EINER Seite ernten | vor Schritt 1, wenn eine konkrete Seite als Vorbild dient |
| `frontend-design` | tatsaechlich bauen (Web) | Schritt 3 |
| `document-design` | tatsaechlich bauen (Dokument/Deck) | Schritt 3, statt Web-Zweig |
| `scroll-welt` | Scroll-Kameraflug bauen (Code-Parallaxe, lokales Video oder Mischung) | Schritt 3, wenn Scroll selbst die Kamera treibt — vor `frontend-design` |
| `tweaks-bar` (Werkzeug, kein Skill) | Feinjustieren am laufenden Dev-Server | Schritt 4 |
| `design-critique` | schwerer, erzwungener Zwei-Pass-Review fuer Kundenfront | nach Schritt 5, bei Bedarf |

## Workflow

### 1. Aesthetik/Referenz/Intent/Guardrails formulieren

Vor dem ersten Pixel: `reference/vier-bausteine-prompt.md`. Ein Einzeiler laesst das Modell
raten — es raet generisch. Fehlt die Referenz (Baustein 2), erst `framer-inspiration` oder
`design-harvest` laufen lassen; beide enden mit einem fertigen Referenz-Absatz, der hier direkt
eingesetzt wird.

### 2. Entscheiden: One-Shot oder Faecher?

Bei echtem Gestaltungsspielraum (neue Website, neues Dokumenten-Layout, keine kleine Iteration
an einem schon festgelegten Design): `reference/faecher-verfahren.md` — fuenf Richtungen parallel
(Worker-Grid) oder sequenziell (Solo-Sitzung), auf drei verengen, dann eine waehlen. Bei einer
kleinen, klar umrissenen Aenderung direkt zu Schritt 3.

### 3. Bauen

Web: `frontend-design`. Dokument/Deck: `document-design` (eigenes Genre, eigene `tokens.typ`,
render-und-ansehen-Pflicht — siehe dort). Dieser Skill trifft hier keine eigenen Entscheidungen,
er hat die Eingabe (Schritt 1) und die Anzahl Richtungen (Schritt 2) bereits geklaert.

### 4. Feinjustieren (Faecher-Stufe 3)

Web: `tweaks-bar` starten (eigenes Repo, `<your-github-user>/tweaks-bar`) — Overlay-Panel am Dev-Server,
Design-Tokens live per CSS Custom Properties vergleichen statt fuer jede Nuance neu zu prompten.
Dokument: gezielter Wert in `tokens.typ`, neu rendern (`document-design` Schritt 6, gedeckelt auf
zwei Runden).

### 5. Selbst-Audit, gedeckelt

Vor dem Melden/Ausliefern: `reference/selbst-audit.md`. Score 0-100 je Kategorie, Fixliste, ein
Fix-Batch, **maximal eine Bestaetigungsrunde** — kein drittes Audit. Fuer Kundenfront/oeffentliche
Arbeit zusaetzlich `design-critique` (schwerer, erzwungener Zwei-Pass, siehe Abgrenzung in
`reference/selbst-audit.md`).

## Reference

| Datei | Wann laden |
|---|---|
| `reference/vier-bausteine-prompt.md` | Schritt 1, immer |
| `reference/faecher-verfahren.md` | Schritt 2, bei echtem Gestaltungsspielraum |
| `reference/selbst-audit.md` | Schritt 5, immer |

## Guardrails

- Referenz heisst Gefuehl uebernehmen, nie Inhalt/Layout/Code kopieren — gilt in jedem der drei
  Bausteine.
- Kein Selbst-Audit ohne Deckel: zwei Runden, dann melden statt weiter polieren.
- Keine Emojis in Auftraegen, Prompts oder Ergebnisdateien.
- Bausteine sind Vorlagen, keine Checklisten zum Abhaken — die Platzhalter muessen mit echten,
  projektspezifischen Entscheidungen gefuellt werden, nicht mit den Beispielwerten aus den
  Referenzdateien.
