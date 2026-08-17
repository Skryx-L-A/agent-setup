---
name: design-critique
description: "Use for a final, before-it-ships design review of a UI surface that goes outside the house — a client landing page, a public site, anything a stranger will judge. Runs two isolated assessments (one reads the design, one measures it) and a bounded fix pass. Not for routine in-progress feedback during a build; that is design-bausteine's lighter self-audit."
license: Own work; the two-isolated-assessment mechanism and the anti-loop cap were validated in an A/B test against pbakaus/impeccable (Apache-2.0) — see ~/AI/design-research/ab-test/. No text or code copied from that project.
---

# design-critique

Ein schwerer, bewusst seltener Schritt: vor Arbeit, die das Haus verlaesst (Kundenseite, oeffentliche
Website, alles was ein Fremder beurteilt), einmal ernsthaft pruefen — nicht bei jedem Zwischenstand.
Fuer den leichten, immer laufenden Abschluss eines Bauauftrags siehe `design-bausteine`s
Selbst-Audit (0-100, kurze Fixliste); dieses Skill ist die schwere Variante daneben, nicht ihr Ersatz.

Herkunft: der A/B-Test von impeccable gegen unseren `frontend-design`-Skill
(`~/AI/design-research/ab-test/`) hat gezeigt, dass der Wert nicht in impeccables 827-zeiliger
`critique.md` liegt, sondern im MECHANISMUS: eine erzwungene, isolierte zweite Bewertung fing einen
echten Fehler (fehlendes Kontaktformularfeld), den die eigene "critique-as-you-build"-Anweisung des
`frontend-design`-Skills beim selben Auftrag NICHT gefangen hat. Dieses Skill uebernimmt den
Mechanismus, nicht die Zeremonie.

## Die harte Warnung zuerst

**Einer LLM-Bewertung wird bei Messwerten nicht geglaubt — nachgerechnet, nie geschaetzt.** Im
selben A/B-Test hat ein isolierter Kritik-Subagent Kontrastwerte gemeldet (2.3:1, 2.9:1, 3.9:1),
die bei eigener Nachrechnung falsch waren (echte Werte: 4.24:1, 5.82:1, 8.04:1 — nur einer der drei
faellt tatsaechlich durch). Die Richtung war fuer einen Fall richtig, die konkreten Zahlen fuer zwei
von drei falsch. Jede Zahl, die Assessment A nennt (Kontrast, Zeilenlaenge, Abstand, Breakpoint),
wird von Assessment B mit `slop-detect` und echten Messungen bestaetigt oder korrigiert, bevor sie
in den Bericht geht.

## Wann NICHT

- Waehrend eines laufenden Baus, fuer schnelles Feedback — das ist `design-bausteine`s
  Selbst-Audit, kein zwei-Passes-Verfahren.
- Fuer eine Aenderung, die niemand ausserhalb des Hauses sieht.

## Setup

1. Ziel klaeren: eine konkrete Datei/Route, nicht "die App".
2. Modus bestimmen (Persuade/Operate/Read/Experience) — siehe
   [reference/modes.md](reference/modes.md). Er entscheidet, welche Kriterien unten ueberhaupt
   gelten.
3. Falls ein Sub-Agent/Task-Werkzeug verfuegbar ist: Assessment A und B als zwei ISOLIERTE
   Sub-Agenten starten, die einander nicht sehen. Ohne Sub-Agent-Werkzeug: nacheinander im
   Hauptkontext, aber die erste Zeile des Berichts nennt das offen
   (`DEGRADIERT: ein Kontext (<Grund>)`) — ein stiller Ausfall der Isolation ist ein
   fehlgeschlagener Durchlauf.

## Assessment A — liest

Code lesen, dann das gerenderte Ergebnis ansehen — Desktop UND Mobil in EINER gebuendelten Runde
(siehe Deckel unten), nie als offene Nachschau-Schleife. Bewerten:

- **Spezifitaet:** koennte ein unverwandtes Produkt diese Komposition unveraendert benutzen?
  Diese Frage zuerst beantworten, bevor irgendetwas anderes bewertet wird.
- **Ganzheitlich:** Hierarchie, Informationsarchitektur, Typografie, Farbe, Zustaende, Text,
  Randfaelle — gegen den gewaehlten Modus.
- **2-3 Staerken**, konkret benannt.
- **3-5 Prioritaetsprobleme**, je mit P0-P3-Schweregrad, was falsch ist, warum es zaehlt, und ein
  konkreter Fix.

Jede Zahl in diesem Bericht (Kontrastverhaeltnis, Zeichenzahl, Abstand) ist als **vorlaeufig**
markiert, bis Assessment B sie bestaetigt.

## Assessment B — misst

Rechnet nach, statt zu schaetzen. Isoliert von Assessment A, sieht dessen Bericht nicht.

1. `slop-detect` gegen das Ziel laufen lassen:
   ```bash
   slop-detect --json <ziel-dateien-oder-verzeichnis>
   ```
   Alle Funde mit Datei/Zeile/Regel/Fix zurueckgeben, exit code nennen (0 sauber, 1 Funde,
   2 Aufrufproblem).

   **Ist das Werkzeug nicht da** (`slop-detect: command not found`): den mechanischen Teil von
   Hand machen, statt ihn zu ueberspringen. Das Minimum, das Assessment B ausmacht — Kontrast
   jedes Textfarbe-auf-Hintergrund-Paars nach der WCAG-Formel nachrechnen (besonders bei
   Opacity-Utilities wie `text-x/60`, dort steckte in der Messung, aus der dieser Skill kommt,
   der echte Fehler), Zeilenlaenge in Zeichen zaehlen, Abstaende aus dem gerenderten Ergebnis
   lesen, Ueberschriftenebenen auf Luecken pruefen. Im Bericht ausdruecklich sagen, dass ohne
   Detektor gearbeitet wurde: eine Bewertung ohne mechanische Gegenprobe ist schwaecher, und der
   Leser muss das wissen. Das Werkzeug liegt in einem eigenen Repo
   (`<your-github-user>/slop-detect`, privat) und ist nicht Teil dieses Skills.
2. Wo ein Browser-Werkzeug verfuegbar ist: Ziel bei Desktop- UND Mobilbreite in EINEM Durchgang
   rendern (nicht zwei getrennte Sitzungen), auf echten Umbruch/Ueberlauf pruefen, Konsole lesen.
3. Jede von Assessment A behauptete Zahl gegenpruefen: Kontrast selbst nachrechnen (oder per
   `slop-detect`s `low-contrast`-Regel, die genau das tut), Zeilenlaenge zaehlen, Abstand aus dem
   gerenderten Ergebnis lesen. Eine Abweichung wird gemeldet, nicht stillschweigend uebernommen.

## Zusammenfuehren

Keine Konkatenation. Wo sich A und B einig sind: staerker gewichten. Wo B eine Zahl aus A
korrigiert: die korrigierte Zahl nennen UND dass sie korrigiert wurde — das ist selbst eine
nuetzliche Information ueber die Verlaesslichkeit der Bewertung. Wo `slop-detect` etwas fand, das A
nicht bemerkt hat (oder umgekehrt): beides nennen, keine Seite automatisch bevorzugen.

Bericht: 3-5 priorisierte Probleme (P0 zuerst), was staerker gewichtet und was korrigiert wurde,
ein Fix je Problem. Kein Score-Theater, keine zehn Heuristiken, keine Personas — wenn eine Zielgruppe
fuer die Bewertung wichtig ist, wird sie im Modus/Auftrag benannt, nicht in einer generischen
Persona-Liste erfunden.

## Der Deckel

Eine Bau-Runde. Eine gebuendelte Inspektion, Desktop und Mobil zusammen, keine getrennten
Nachschau-Passes. Eine Fix-Runde auf die gemeldeten Probleme. Danach Schluss — keine weitere,
ungefragte Pruefrunde. Wortlaut, an dem sich das orientiert: *"Build fully, inspect once with a
batched round, fix everything it shows in one batch, confirm with at most one more round, and stop
polishing."* Passt direkt zu unserer bestehenden Opus-5-Gegenmassnahme (nicht ungefragt
nachverifizieren) — dieselbe Disziplin, hier auf Design-Iteration angewendet.

## Vor jeder Bewertung lesen

[reference/craft-floor.md](reference/craft-floor.md) — der harte Pflichtstandard, gegen den
Assessment A urteilt.
[reference/modes.md](reference/modes.md) — welcher Modus gilt und was er an Kriterien freigibt/
ausschliesst.
