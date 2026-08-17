---
name: session-end
description: >-
  End-of-session knowledge flush — bring EVERYTHING up to date before the session
  closes: vault session note, topic notes, project docs, auto-memory, rule
  persistence, vault git commit+push, worker cleanup, honest final report.
  Use this AUTOMATICALLY and UNPROMPTED whenever the user signals the session is
  ending, in any phrasing or language: "ich beende die session", "session zu",
  "wir machen Schluss", "das war's für heute", "Feierabend", "ich gehe",
  "update alles final", "wrap up", "I'm done for today", "end the session",
  "bye" at the end of work — even if he never says the word "skill" or "session-end".
  Also run it when an orchestrator tells a worker to wrap up. Applies to the
  orchestrator AND every Claude worker/teammate. Do not wait to be asked twice:
  if the user's message plausibly means "we're closing", run this skill.
---

# Session-End — kompletter Wissens-Flush

Ziel: NULL Wissensverlust. Nach diesem Skill kann jede künftige Session (auch eine
fremde) nahtlos weitermachen, nur aus Vault + Docs + Memory. Uncommitteter Vault-Stand
oder ungeschriebene Erkenntnisse am Session-Ende sind ein Bug (Standing Rule 2026-07-10).

Arbeite die Schritte in dieser Reihenfolge ab. Überspringe einen Schritt nur, wenn er
nachweislich leer ist — und sage das dann im Report ("nichts zu tun"), statt ihn
stillschweigend wegzulassen.

## 1. Ernte: Was hat die Session produziert?

Geh die Session gedanklich durch und sammle:
- Entscheidungen (auch verworfene Optionen mit Grund)
- Setups/Fixes/Builds (was, wo, wie verifiziert)
- Neue Regeln/Präferenzen, die der Nutzer geäußert hat
- Offene Punkte / nächste Schritte / Dinge, die nur der Nutzer tun kann
- Gotchas und Fehlerbilder mit Fix (die teuersten Wissensverluste!)

Orchestrator zusätzlich: alle Worker-/Teammate-Result-Files dieser Session gelesen und
deren Erkenntnisse in die Ernte aufgenommen? Ungelesene results = Wissensverlust.

### 1a. Harvest-Manifest erstellen (Pflicht, Brain 3.0)

Aus der Ernte oben ein kompaktes **Harvest-Manifest** schreiben — Bullet-Liste,
zwei Teile:
- **Entities**: substanziell Neues pro Entity/Tool/Thema/Entscheidung, je 1 Zeile
  `<Entity-Name>: <was ist neu>` (+ optional Zielbranch, wenn nicht offensichtlich).
- **Files**: Dateien mit Dauerwert (Kuration nach [[BRAIN3-PLAN]]: Verträge, Doku,
  Paper, Referenzbilder, Diagramme, wichtige Exporte — kein Quellcode, keine
  Build-Artefakte, keine Wegwerf-Screenshots), je 1 Zeile
  `<Filepfad> — <Dauerwert-Grund> — Zielbranch: <branch>`.

Substanz-Filter statt Zahlen-Cap (Entscheidung 2026-07-12): alles, was das
Substanz-Kriterium erfüllt, kommt rein — kein künstliches Limit auf N Einträge.
Trivialkram (Tippfehler-Fixes, Nicht-Entscheidungen) bleibt draußen.

**Vault-Filing macht IMMER der Orchestrator selbst (der Nutzer, 2026-07-27).** Diese
Anweisung ersetzt die frühere Delegationsregel an einen billigen Worker — kein
`claude-worker haiku:low`, kein `pi-worker ornith` für das Ablegen im Vault, auch
nicht bei knappem Kontingent oder großem Manifest. Wer die Session geführt hat,
kennt die Zusammenhänge, die Widersprüche zu bestehenden Notes und das, was NICHT
im Manifest steht; ein billiger Worker legt ab, was dasteht, und der Rest fällt
still weg. Das Brain ist der Ort, an dem Wissensverlust dauerhaft wird.

Das Manifest aus 1a bleibt trotzdem Pflicht: es ist die Checkliste, gegen die der
Orchestrator sein eigenes Filing prüft. `~/.claude/skills/brain-harvest/SKILL.md`
beschreibt weiterhin das mechanische Vorgehen (Entity-Notes, `_assets/`-Stubs,
MOC-Verlinkung) — der Orchestrator arbeitet es selbst ab.

Worker im Wrap-up delegieren ohnehin nichts: sie schreiben ihre Erkenntnisse ins
Result-File und übergeben sie damit an den Orchestrator (siehe Schritt-Aufteilung
am Ende).

## 2. Regel-Kalibrierung (Standing Rule 2026-07-10, erweitert 2026-08-03)

Dieser Schritt hat zwei Hälften, und die zweite ist die, die bisher gefehlt hat.

### 2a. Hinzufügen

Jede in der Session vereinbarte Regel/Präferenz, die nicht explizit session-only war:
- global → `~/.claude/CLAUDE.md` (Standing rules) und/oder `~/Knowledge/10-global/`
- projektbezogen → Projekt-CLAUDE.md und/oder `20-projects/<projekt>/`
- betrifft Agent-Rollen → auch `~/.claude/roles/orchestrator.md` / `agent.md` /
  `~/.pi/agent/WORKER.md`
Im Report kurz bestätigen, was wohin persistiert wurde.

Eine neue Regel gehört nur dann in eine immer geladene Datei, wenn sie ohne Auslöser gilt.
Alles, was erst bei einer bestimmten Tätigkeit greift, kommt nach `~/.claude/regeln/<thema>.md`
und wird im Verweisbaum von CLAUDE.md mit seinem Auslöser eingetragen.

### 2b. Wegnehmen — Pflicht, nicht Kür

Zwischen dem 25.07. und dem 03.08.2026 wuchsen CLAUDE.md und der Orchestrator-Rollen-Prompt
von zusammen 34.228 auf 70.458 Zeichen. Jede Session fügte hinzu, keine nahm weg. Das Werkzeug
dagegen (`claude-md-lint`) existierte die ganze Zeit und lief nie. Deshalb steht der Schritt
jetzt hier, mit einer Zahl statt eines Vorsatzes.

```bash
wb-hygiene     # Größen gegen die Obergrenze, wb-consistency, claude-md-lint, status-freshness
```
Exit 1 heißt: in dieser Session ist etwas zu tun. Derselbe Befehl läuft montags 9 Uhr als
launchd-Job (`agent-workbench.wb-hygiene`) und legt seinen Bericht in
`~/.local/state/wb-hygiene-report.md` ab.

**Obergrenze: je 16.000 eigene Bytes** (generierte Blöcke zählen nicht mit, sie sind nicht
kürzbar). `wb-hygiene` misst und meldet das. Wird eine davon
überschritten, wird in dieser Session gekürzt — nicht vertagt. Kürzen heißt hier auslagern
nach `regeln/`, nicht streichen; die stehende Anweisung „nie bestehende Anweisungen löschen"
(2026-07-17) gilt unverändert.

Dazu bei jedem Sessionende drei Fragen an den bestehenden Bestand, mit nummerierten
Vorschlägen an den Nutzer (er antwortet „nimm 1 und 3"):

1. **Welche Regel ist heute im Weg gewesen?** Eine Regel, die eine sinnvolle Handlung
   verhindert oder zu einer Umgehung geführt hat, wird zur Änderung vorgeschlagen.
2. **Welche Regel hat sich erledigt?** Ein Apparat, den in zwei Wochen niemand benutzt hat;
   ein Werkzeug, dessen Aufgabe etwas Neueres übernommen hat; eine Vorsichtsregel, deren
   Ursache nachweislich behoben ist. Beleg dazusagen, nicht vermuten.
3. **Welche Regel steht doppelt?** `wb-consistency` beantwortet das maschinell. Jede Aussage
   bekommt genau einen Ort; alle anderen Stellen verweisen dorthin.

Wenn nichts wegzunehmen ist, steht das so im Report — mit der Zahl aus `claude-md-lint`
daneben. „Nichts gefunden" ohne Zahl gilt als übersprungener Schritt.

### 2c. Testsuiten — laufen sie noch?

Anlass (2026-08-04): mindestens zehn Testskripte unter `shell/tests/` und
`~/.claude/hooks/tests/`, jedes einzeln von Hand gestartet — genau die Lücke, die 2b
für die Regeldateien schließt, hier für die Testsuiten selbst.

```bash
shell/tests/run-all.sh    # alle Shell-Suiten + npm run check in extension/, eine Tabelle
```

Exit ungleich 0 heißt: mindestens eine Suite ist rot. Derselbe Aufruf läuft sonntags
20 Uhr als launchd-Job (`agent-workbench.wb-testsuite`) und legt seinen Bericht in
`~/.local/state/wb-testsuite-report.md` ab. Suiten, die eine besondere Umgebung
brauchen (lokales Modell, angehefteter tmux-Client), stehen dort als SKIP mit Grund,
nicht als PASS oder FAIL. Ein rotes Ergebnis wird im Abschluss-Report genannt, nicht
stillschweigend übergangen — Reparatur ist ein eigener Task, kein Sessionende-Schritt.

## 3. Vault (`~/Knowledge`)

- EINE destillierte Session-Note in den richtigen Branch (`10-global/` oder
  `20-projects/<projekt>/`), nach `templates/note.md`, mit typed wikilinks.
  Existiert für heute schon eine Session-Note: erweitern statt zweite anlegen.
- Betroffene Themen-Notes AKTUALISIEREN (rewrite-over-append: bestehenden Text
  umschreiben, Widersprüche auflösen, Recency-Marker `Stand: YYYY-MM` setzen) —
  nicht nur anhängen. Typische Kandidaten: local-audio-models, Architektur-Notes,
  Projekt-MOCs/overviews.
- Niemals Secrets außerhalb `90-secrets/`; `90-secrets/` niemals committen/syncen.
- **Widerspruchsprüfung — nur noch einreihen, nicht mehr scannen (geändert 2026-08-04):**
  `brain contradict --queue-add <geänderte-Notiz-Pfade>` — hängt die in dieser
  Session geschriebenen/geänderten Notizen dedupliziert an
  `_meta/state/contradiction-queue.txt` an, Millisekunden statt Minuten. Der
  eigentliche Scan (`brain contradict --since ... --write`, lokales Modell,
  ~100 s je Notiz) lief bis 2026-08-04 SYNCHRON genau hier und blockierte damit
  jedes Sessionende — Anweisung des Nutzers: runter vom kritischen Pfad, dafür
  regelmäßig statt gar nicht. Abgearbeitet wird die Warteschlange jetzt
  **montags/mittwochs automatisch über `brain-maintain`** (launchd) oder **von
  Hand sofort per `brain contradict --queue --write`**. Befunde landen weiterhin
  in `_meta/state/contradictions.json` und `review-queue.md` (Vault-Wurzel), Marker
  in beiden betroffenen Notizen. Auflösen nach `10-global/contradiction-rules.md` —
  was die Regeln decken, löst der Orchestrator selbst; `status: escalated` kommt
  in den Abschluss-Report an den Nutzer. Ein Marker, den niemand anfasst, ist
  wertlos.

## 4. Projekt-Doku

Für jedes in der Session berührte Projekt dessen eigene Doku-Konvention bedienen:
TASKS.md/DONE.md, PROGRESS.md, Briefs, READMEs — was das Projekt nutzt. Erledigtes
raus aus offenen Listen, Neues rein. Auch externe Statusdateien (z.B. SD-Karten-
PROGRESS.md) zählen, wenn sie Source of Truth sind.

## 5. Auto-Memory (`~/.claude/projects/.../memory/`)

Nur wenn sich user-/feedback-/projekt-Fakten geändert haben: betroffene Memory-Datei
aktualisieren (Duplikate vermeiden — bestehende Datei updaten) + MEMORY.md-Indexzeile
anpassen. Memory bleibt minimal; Details gehören in den Vault, Memory darf dorthin
zeigen.

## 5a. LOG.md — Einzeiler (append-only)

Eine Zeile an `~/Knowledge/LOG.md` anhängen (Datei anlegen falls sie noch nicht
existiert, Header `# LOG` reicht): `YYYY-MM-DD | <Projekt/Branch> | <Einzeiler was
passiert ist>`. Nie bestehende Zeilen editieren oder löschen — append-only
Chronik-Rückgrat, grep-bar (`rg "<projekt>" ~/Knowledge/LOG.md`).

## 6. Vault-Git: committen + pushen

```bash
cd ~/Knowledge && git add -A && git status --short   # prüfen: keine Secrets!
git commit -m "<englische Message>"                   # Author <your-github-user>, KEIN Co-Author-Trailer
git push
```
Danach verifizieren: `git status` clean, kein unpushed Commit. Push schlägt fehl
(offline?): committen, Fehlschlag ehrlich reporten, Push als offenen Punkt notieren.

## 7. Projekt-Repos: Stand reporten, nicht eigenmächtig pushen

Für berührte Projekt-Repos `git status` prüfen. Uncommittete Änderungen im Report
nennen. Committen/Pushen nur nach den normalen Regeln (Push-Autorität: nur
Orchestrator, nach Verifikation; Worker geben verifizierte Arbeit zurück). Kein
stilles Liegenlassen: der Report muss den Repo-Zustand ehrlich benennen.

## 8. Worker & Prozesse aufräumen (Orchestrator)

- **Erst messen, dann behaupten (2026-08-11).** Dieser Schritt beginnt mit zwei Befehlen,
  nicht mit einer Erinnerung. Am 10.08. meldete ein Sessionende „kein Worker, keine
  Waisen", während ein Worker noch 43 Minuten weiterrechnete und ein Modellserver mit
  21,9 GB das Pane-Ende überlebte — beides hätte hier gestanden:
  ```bash
  tmux list-panes -a -F '#{pane_id} #{@wb_worker} #{@wb_role}' | awk 'NF>2'   # lebende Worker
  wb-waisen                                                                   # Hintergrundprozesse ohne lebenden Besitzer
  ```
  `wb-waisen` trennt dabei die bestätigte Waise (Eigentümer-Pane tot, keine Benutzung
  gemessen) vom unregistrierten Verdachtsfall und schlägt nur bei der ersten ein Beenden
  vor. Beendet wird von Hand über die genannte PID, nie über ein Muster.
- Laufende Worker: Wrap-up anstoßen (Result-File schreiben lassen, mit Deadline
  warten), dann fertige Claude-Worker-Panes schließen. pi-Worker-Panes dürfen offen
  bleiben (lokal, token-frei) — bei Session-Ende aber auch die schließen.
- Keine verwaisten Hintergrundjobs/Downloads ohne Eintrag bei den offenen Punkten.

Worker, die dieses Skill per Wrap-up-Anweisung ausführen: Schritte 1, 1a (Manifest
ins Result-File statt selbst delegieren), 3 (nur eigene Erkenntnisse ins Result-File
bzw. auf Anweisung in den Vault), 7, 8a; Schritte 2/5/5a/6 gehören dem Orchestrator —
stattdessen Erkenntnisse im Result-File an ihn übergeben.

## 8a. Fertig-Kriterium selbst prüfen — nur Worker, nur wenn eins bekannt ist (2026-08-04)

`wb-dod` (`~/.local/bin/wb-dod`) prüft ein Result-File gegen sein Fertig-Kriterium
über ein zweites, billiges Modell — gebaut am 2026-08-03, bis heute aber von
nirgends aufgerufen. Hier ist der Aufrufer: Ist ein Fertig-Kriterium bekannt (im
Task-Prompt/Protokoll-Block genannt, oder von `pi-worker --dod` schon als
`~/.pi-workers/results/<eigener-name>/.dod` hinterlegt), läuft **einmal**, NACHDEM
das Result-File geschrieben ist und BEVOR DONE geantwortet wird:

```bash
wb-dod <eigener-worker-name> ["<Fertig-Kriterium, falls nicht schon in .dod>"]
```

Ersetzt nicht die eigene Verifikation (Regel: "verifiziere EINMAL richtig, dann
stopp") — es ist ein zweiter, unabhängiger Blick, der ein übersehenes Kriterium
nie stillschweigend durchwinkt. Ein NICHT-ERFUELLT heißt: die genannte Lücke vor
dem Report noch schließen oder im Report ehrlich als offen benennen — nicht
ignorieren. Bewusst NICHT als Hook auf jeden Turn/jeden Bash-Aufruf verdrahtet:
ein Modellaufruf pro Turn wäre teuer und laut (die Hook-Kette wurde gerade erst
auf einen einzigen Prozess konsolidiert, `bash-guard.py`), und ein Fertig-
Kriterium existiert ohnehin erst am Ende einer Aufgabe, nicht bei jedem
Werkzeugaufruf — ein einziger Lauf am natürlichen Abschlusspunkt ist die
sparsame, aber noch wirksame Variante. Kein Fertig-Kriterium bekannt: Schritt
entfällt, nichts zu tun.

## 9. Abschluss-Report an den Nutzer

Outcome-first, kurz:
- Was wurde wohin persistiert (Vault-Commit-Hash, geänderte Dateien)
- Regel-Persistenz-Bestätigung (falls Schritt 2 etwas hatte)
- Offene Punkte, die IHN brauchen
- Ehrlich: was fehlgeschlagen/übersprungen wurde und warum
Erst nach diesem Report ist die Session beendbar.
