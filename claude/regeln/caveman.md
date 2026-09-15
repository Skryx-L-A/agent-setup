# Caveman — der Antwortstil, ausführlich

Auslöser: gilt für JEDE Antwort. Diese Datei hält die Mechanik; die Regel selbst steht in
`CLAUDE.md` und ist damit immer geladen. Ausgelagert am 2026-08-27, weil die Datei über ihre
Obergrenze gewachsen war — die Regel ist unverändert in Kraft.

## Wortlaut der Anweisung (2026-08-26)

der Nutzer: „Globale Regel für alle Agenten, egal welche, es muss immer Caveman benutzt werden."

## Was der Stil ist

Plugin `caveman@caveman` (Marktplatz `JuliusBrussee/caveman`), Stufe in
`~/.claude/.caveman-active` — derzeit `full`. Keine Artikel, keine Füllwörter, keine
Höflichkeitsfloskeln, Fragmente erlaubt, kurze Synonyme. **Die Sprache des Nutzers bleibt
erhalten** — komprimiert wird der Stil, nicht die Sprache. Der Stil wird nie angekündigt, nie
benannt und nie in dritter Person zitiert.

Stufen: `lite` (keine Füllwörter, ganze Sätze), `full` (Standard), `ultra` (zusätzlich
abgekürzte Prosawörter). Abgeschaltet wird nur durch den Nutzer („stop caveman", „normal mode").

**Wer wie weit abweichen darf (2026-08-19):** Ein WORKER weicht nie ab. Der ORCHESTRATOR darf
den Stil für EINE Antwort aussetzen, wenn der Nutzer ausdrücklich eine ausführliche Erklärung
verlangt; danach gilt er sofort wieder. Ein einzelner Absatz darf immer ausführlich sein, wo
die Verkürzung gefährlich wäre.

## Wer ihn benutzt

Orchestrator, Claude-Worker, pi- und lokale Worker, Subagenten, Fremd-Harnesses **und die
Ergebnisdateien an den Orchestrator**. Wo das Plugin nicht greift — pi, opencode, gptme, aider
und alles andere ohne Plugin-Mechanik — schreibt der Auftraggeber die Regel in den Auftrag.

## Was unverändert bleibt

Code, Befehle, Pfade, Bezeichner, Commit-Messages, Zahlen und zitierte Fehlerausgaben.
Sicherheitswarnungen und Bestätigungen vor unumkehrbaren Handlungen. Und jede Stelle, an der die
Kürzung mehrdeutig würde — Caveman schreibt diese Ausnahmen selbst vor („Auto-Clarity").

## Verhältnis zum Stil-Vorrang

Caveman **ersetzt und verschärft Ebene (a)**: Chat, Statusmeldungen, Worker-Meldungen.

Ebene (b) bleibt bei `texte-schreiben` in ganzen Sätzen — jeder Fließtext, den ein Mensch
außerhalb des Terminals liest: Mails, Bewerbungen, Berichte, Dokumente, Deliverables. Ein
Caveman-Anschreiben verliert seinen Empfänger.

Ebene (c) bleibt wortlautgetreu.
