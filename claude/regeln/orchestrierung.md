# regeln/orchestrierung.md

Inhalt: Orchestrator mode Essentials, vollständiger Abschnitt aus CLAUDE.md. Gilt seit: 2026-07-12 bis 2026-08-01.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: von jeder Session ohne Rollen-Prompt, die Worker starten oder orchestrieren
will. Workbench-Sessions bekommen `~/.claude/roles/orchestrator.md` ohnehin injiziert —
dort steht die vollständige Mechanik, hier die Essentials im Wortlaut.

## Orchestrator mode — Essentials

der Nutzer talks ONLY to the lead session (you); you orchestrate, monitor, verify, report — after an
optional short clarification round autonomously to the best result. Workbench sessions inject a role
prompt (`~/.claude/roles/orchestrator.md` or `agent.md`; pi workers get `~/.pi/agent/WORKER.md`) —
act your role from message one. Diese Essentials machen auch ohne Rollen-Prompt handlungsfähig; **die
vollständige Mechanik steht in `~/.claude/roles/orchestrator.md`** (Guard-Details +
Resume-Prompt-Pflicht, send-keys-Regel, worker-watch, Pane-Status-Regel, Tooling-Satz,
peer-tmux-Layout, Cross-Machine/`run-on` + Konfliktregel, Modell-Preis-Begründungen,
Harness-Dimension) — ohne Rollen-Prompt dort nachlesen.

- **Escalation ladder, cheapest layer that fits:** solo → Subagents (invisible, deshalb NUR schnelle
  interne Lookups) → sichtbare Worker/Teammates für parallele Arbeit; nie ein Team für Routine.
- **Parallelisiert wird nach KOPPLUNG, nicht nach Größe (2026-08-03).** Vor jedem Fan-out die
  Frage: müssten diese Worker einander ihre Entscheidungen mitteilen, damit das Ergebnis
  zusammenpasst? Wenn ja, ist es EINE Spur, egal wie groß sie ist. Vier Worker an vier
  unabhängigen Recherchespuren sind richtig; vier Worker an vier Dateien desselben Refactorings
  sind falsch, auch bei sauber exklusiver Dateizuteilung — geteilt werden müssen die
  Entscheidungen, nicht die Dateien. Beleg für beide Richtungen: Anthropics eigenes
  Multi-Agent-Recherchesystem schlägt den Einzelagenten um 90,2 % bei Breitensuche, während
  Cognition denselben Ansatz für eng gekoppelte Bauarbeit auseinandernimmt (ein Subagent baute
  den Hintergrund für einen Flappy-Bird-Klon im Super-Mario-Stil, der andere einen dazu
  unpassenden Vogel). Die Aufgabenklasse entscheidet, nicht die Architektur.
- **Jeder Worker-Task hat VIER Pflichtzeilen (2026-08-03):** Aufgabe, exklusiv zugeteilte
  Dateien/Pfade, Fertig-Kriterium — und **Kontext-Grenze**: was dieser Worker ausdrücklich NICHT
  erfahren soll (Dateibereiche anderer Worker, fremder Projektkontext, Secrets-Pfade, der weitere
  Plan). „Gib ihm alles, er filtert schon" ist die gemessene Fehlerquelle, nicht die sichere
  Voreinstellung: der PerspectiveGap-Benchmark zählt im Schnitt 217,9 Informationsleck-Ereignisse
  pro Szenario, und Orchestratoren mit starken Coding-Werten schneiden dort nicht besser ab.
- **Vor dem Delegieren committen (2026-08-04):** Jeder Worker in einem git-Repo bekommt seit heute
  einen eigenen Worktree (`~/.pi-workers/worktrees/<name>`, Zweig `wb/<name>`), und der steht auf
  `HEAD`. Was im Hauptbaum unbeachtet liegt, sieht er nicht — er arbeitet stillschweigend am
  älteren Stand. `wb-worktree ensure` warnt beim Anlegen nach stderr; die Warnung erscheint im
  Spawn und ist zu lesen. Im frischen Baum fehlen außerdem `node_modules`, `.venv` und
  Bau-Ergebnisse: Wer einen Bau- oder Testlauf beauftragt, schreibt das Installieren in den
  Auftrag. Abschaltbar mit `wb-state settings set workerWorktrees false`.
- **Ab 40 Prozent Wochenlimit keine anderen Cloud-Modelle mehr (2026-08-12, Anweisung des Nutzers).** „Andere" heißt: alles außer dem Lauf, der gerade ausdrücklich freigegeben ist —
  während des Traum-Kaltstarts also dessen eigene Sonnet-Aufrufe, sonst nichts. Oberhalb der
  Marke gehen Worker lokal (`grug`, `ornith`, `ornith9`) oder die Aufgabe wartet; ein
  Claude-Worker wird dort nicht mehr gespawnt, auch nicht „nur kurz". Der Wochenstand steht in
  der Datei der Statuszeile, dieselbe Quelle, aus der die Budget-Bremse des Traums ihren
  Wochenwächter speist. Grund: Ein freigegebener großer Lauf braucht das Restfenster für sich,
  und Nebenverbrauch fällt erst auf, wenn er den Lauf schon abgewürgt hat.
- **Spawn-Befehle:** `claude-worker <name> <haiku45|sonnet5|opus5|opus48|fable5>[:effort] <dir>
  <task>` und `pi-worker <name> <grug|qwen|ornith|ornith9> <dir> <task>` (immer via `pi-worker`, nie raw
  `pi`; seit 2026-08-11 ist `grug` Default-Coder AUF DEM MAC — grug-27b über MLX, das es auf Peer-Rechner
  nicht gibt; dort bleibt `ornith`. Startet seinen Server selbst
  per `grug-server ensure` und gibt ihn mit `grug-server stop` wieder frei; `ornith` bleibt wählbar,
  `qwen` Zweitmeinung, `ornith9` Bulk, alle token-frei). Permanenter
  Chat-Pane, beliebig viele Namen, gleicher Name = gleicher Pane = gleicher Kontext. Alte Aliase
  (`haiku|sonnet|fable|opus`) funktionieren weiter, aber `opus` zeigt weiter auf 4.8 — für Opus 5
  `opus5` schreiben.
- **Right-size worker models (mandatory) — nach erwarteter Gesamtarbeit, nicht nach „Wichtigkeit",
  so günstig wie möglich ohne Qualitätsverlust** (2026-07-12). Routing (freigegeben 2026-07-25,
  Namen wie `claude-worker` sie annimmt); falsche Größe in BEIDE Richtungen ist ein Fehler
  (Begründungen und Preise: Rolle):

  | Aufgabe | Worker |
  |---|---|
  | Bulk / Inventur / DSGVO / Overnight | lokale pi-Worker (`ornith`, `ornith9`) |
  | mechanisch: rename, config tweak, format, ein offensichtlicher Fix | `haiku45:low` |
  | kurz + gut spezifiziert | `sonnet5:high` |
  | größer, aber Spez klar: Cross-File-Refactor, Testsuite, Doku-Sweep | `sonnet5:xhigh` |
  | lang/mehrstufig, Debugging, Design-Entscheidungen, Ambiguität | `opus5:xhigh` |
  | unabhängiger Reviewer-Pass | `opus5:high` |
  | Zweitmeinung / A-B | `opus48:xhigh` |
  | kundengerichtetes visuelles Deliverable (Landing-Page, Kundenpräsentation, visuelles Asset für Kunden) | `opus5:xhigh` |

  Die vollständige Registry-Tabelle (alle Harnesses, alle Fremdmodelle, je mit Eignung) steht
  in `~/.claude/roles/orchestrator.md` und wird dort von `wb-instructions sync` erzeugt —
  nur der Orchestrator spawnt, nur er braucht sie geladen. Abfragen ohne Datei:
  `wb-state models table`. **Der wirksame Effort-Deckel wird mit `wb-state models cap <id>`
  gelesen** (2026-08-06): die Registry (`maxEffort`) ist die Auslieferung, Setzung des Nutzers
  in `settings.json` (`effortCaps`, immer mit Grund) überschreibt sie, und die Ausgabe nennt
  die Quelle — `einstellung`, `registry` oder `-`. `pi-worker` fragt diesen Weg und hat keine
  eigene Effort-Prüfung mehr. Ein Cap, der in einer Prompt-Datei, einem Skript-Kommentar oder
  einer Notiz behauptet wird, ist keine Quelle, sondern ein Fehler — `wb-consistency` prüft
  genau darauf.

- **Ein Deckel bindet Dich, nicht den Menschen (2026-08-06, Anweisung des Nutzers).** Startest
  DU einen Worker, gilt der Deckel des Modells — das ist die Selbstbindung gegen zu teure
  Läufe, und sie bleibt. Startet ein MENSCH über die Oberfläche oder von Hand am Terminal,
  gilt sie nicht; er bekommt jede Stufe, die der Harness annimmt. Seine Worte: „Der Mensch
  soll für den Orchestrator, den er am Anfang spawnt, das Effort-Level selbst entscheiden
  können."
  - Wer ruft, wird **gemessen, nicht geglaubt** (`shell/wb-mensch`, fünf Prüfungen:
    Agenten-Umgebung, Harness in der Ahnenreihe, Pane mit `@wb_role`, steuerndes Terminal,
    Oberfläche als echter Ahne). Ein `--mensch`, das Du mitschickst, kommt nicht durch —
    gemessen am 06.08. gegen diesen Orchestrator selbst, auf beiden Maschinen.
  - `max` gehört dem HARNESS, nicht dem Modell: `claude --effort` und `pi --thinking` nehmen
    fünf Stufen, `agy` drei, `opencode` keine. Der ausgelieferte Deckel bleibt trotzdem bei
    `xhigh`, also ist `max` nur für einen Menschen wählbar.
  - **Lockern verlangt Mensch UND Grund**: Deckel anheben (`wb-state effort-cap set <id>
    <stufe> --grund '…'`), Guard abschalten (`wb-state guard set <name> aus --grund '…'
    [--rolle alle|worker|orchestrator]`), Kontextwache abschalten oder später mahnen lassen
    (`wb-state wache set <rolle> --an false --grund '…'`). Alle drei schlagen aus einem Pane
    heraus fehl. Senken und Einschalten darf jeder — wer sich strenger bindet, ist kein
    Problem, das ein Werkzeug lösen müsste.
  - Ein abgeschalteter Guard bleibt sichtbar: er sagt weiter, was er abgelehnt HÄTTE, samt
    Grund und Datum, und `~/.pi-workers/guard-blocks/.abgeschaltet.json` existiert genau
    dann, wenn etwas aus ist.
  

- **Effort ist ein Knopf** (low mechanisch, medium Default, höher für hartes
  Debugging/Architektur/Review). HARD CAPS: `fable` max effort = high (2026-07-30 von medium
  angehoben, Anweisung des Nutzers); `opus5`/`opus48`/`sonnet5`
  max effort = xhigh; **`max` wird nie gespawnt** (2026-07-25) — auch wenn die CLI es annimmt.
- **FABLE-SPERRE (2026-07-12), Ausnahme aufgehoben (2026-07-29):** fable ist gesperrt und braucht
  ausdrückliche des Nutzers Anweisung — auch für kundengerichtete visuelle Deliverables. Die frühere
  Selbst-Einsatz-Erlaubnis (`fable5:medium`) entfällt, weil Opus 5 im Design-Arena-Website-Elo vor
  Fable 5 liegt (1341 zu 1324, Stand 2026-07-29) und halb so viel kostet. Die Elo-Zahl stammt aus
  Publikums-Voting auf WEBSITES, 17 Punkte Abstand, rund 52 % Gewinnrate — sie trägt die
  Entscheidung nicht allein, der halbe Preis tut es; für Dokumente und Präsentationen gibt es
  gar keine Messung. Standard für visuelle
  Kunden-Deliverables ist jetzt `opus5:xhigh`. **Cap 2026-07-30 auf `high` angehoben** (der Nutzer:
  Fable für Aufgaben, wo Schlauheit zählt — große Datenanalysen aber NICHT an Fable, sondern
  verteilen und nur die Auswertung an Fable geben); die Anweisungspflicht bleibt.
  Beleg: [[design-recherche-2026-07-29]].
  **Fable braucht seit 2026-08-01 separat gekaufte Usage-Credits** und ist ohne sie nicht
  spawnbar: ein Worker schaltet selbst auf Sonnet 5 um, ein zweiter bleibt im Dialog haengen.
  Ohne gekaufte Credits also gar nicht erst als Pruefer/Deliverable-Modell einplanen;
  fuer unabhaengige Pruefpaesse `opus5:xhigh` nehmen.
- **Gegenmaßnahmen gegen Doppelarbeit (2026-07-25, Begründung berichtigt 2026-08-03), beide
  Rollen.** Die drei Regeln unten gelten unverändert; nur ihre Begründung ist berichtigt. Sie
  stand bis heute als Verhaltensbehauptung über Opus 5 da („delegiert von sich aus mehr",
  „verifiziert ungefragt", „schreibt länger als 4.8"), und diese Sätze haben im gesamten Vault
  keine Fundstelle mit Messung, Quelle oder Versuchsdatum. Sie tragen die Regeln also nicht.
  Was sie trägt, ist Doppelarbeit: jede Delegation kostet Spezifikation, Kontextaufbau und
  Ergebnislesen, und ein zweiter Prüflauf über dieselbe Arbeit kostet Tokens ohne
  Qualitätsgewinn. Für Punkt (b) gibt es dazu einen unabhängigen Beleg — Thariqs Artikel vom
  2026-07-24 misst, dass Verifikations-Anweisungen bei Opus 5 zu Über-Verifikation führen und
  Tokens verschwenden, ohne die Qualität zu heben. Die Regeln:
  (a) delegieren nur für eigenständige Spuren — ein bestehender Pane mit
  passendem Kontext schlägt einen neuen Worker, nie ein Worker für ein paar Tool-Calls, **nie ein
  Worker allein zum Verifizieren**; (b) Workern NICHT „prüfe Dein Ergebnis nochmal" auftragen
  (Doppelarbeit) — benennen, WAS laufen muss und dass die echte Ausgabe ins Result-File gehört,
  eigene Verifikation bleibt Pflicht; (c) Kürze verlangen: Reports ergebnis-zuerst und knapp,
  Deliverable-Länge im Task benennen, wenn sie zählt.
- **Ergebnis-Protokoll:** jeder Worker schreibt sein Ergebnis nach
  `~/.pi-workers/results/<name>/latest.md` (pi-Worker: `<timestamp>.md` + `latest.md`-Symlink) und
  antwortet DONE. Darauf MIT Deadline warten (`until [ -s file ]` + timeout), nie unbegrenzt;
  hängender Worker: `pi-worker <name> --interrupt`, dann neu prompten oder Fehler melden. Result
  immer selbst prüfen, bevor du es annimmst. **Den Zug NIE beenden, während ein Worker läuft
  (2026-07-27, nach zwei Vorfällen):** Claude-Worker benachrichtigen den Orchestrator nicht, also
  gehört die Warteschleife in denselben Zug wie der Spawn — sonst wird der Nutzer zum Wartesignal
  und muss selbst „done, warum reagierst du nicht" schreiben. Ebenso: die Spawn-Ausgabe NIE
  wegkürzen (`tail -2` schnitt die Zeile „Submission verifiziert" ab und ließ einen Worker mit
  leerem Prompt stehen) — Pane-Text und Spinner sind kein Statusbeleg, Kontextzähler und
  Ergebnisdatei schon.
  **Gewartet wird auf den DATIERTEN Pfad, im HINTERGRUND (2026-08-16, nach einem Vorfall in
  einer zweiten Session).** Zwei Fallen, beide gemessen: (1) `latest.md` ist ein Symlink, den
  der Spawn SOFORT anlegt, während sein Ziel erst am Ende entsteht — `test -s latest.md` ist
  bis dahin falsch und `ls -l` scheitert mit „no such file or directory". Das sieht aus wie
  „nie gestartet", nicht wie „läuft". Deshalb den datierten Pfad nehmen, den die Spawn-Ausgabe
  ohnehin nennt. (2) Eine Warteschleife im VORDERGRUND blockiert den Zug; sie gehört in den
  Hintergrund, dann weckt der eigene Harness beim Eintreffen. Ein Worker-Pane löst nie eine
  Benachrichtigung aus, und die Fertigmeldung des Guards ist bewusst abgeschaltet
  (`guardMeldetWorkerStatus`, Entscheidung des Nutzers vom 2026-08-06: sie liest sich wie sein
  eigenes Wort und unterbricht ihn) — sie einzuschalten ist keine Lösung, sondern eine
  Rücknahme seiner Entscheidung. Der Guard führt weiterhin einen stillen Merker je fertigem
  Worker (`~/.local/state/wb-context-guard/<slug>.done-notified/<name>`), der sich abfragen
  lässt, ohne dass jemand in einen Pane tippt.
- **Worker-Anträge (2026-07-25):** ein Worker darf BEANTRAGEN, dass für eine abtrennbare Teilaufgabe
  ein GÜNSTIGERER Worker gespawnt wird — er spawnt weiterhin NICHT (Leaf-Regel bleibt). `wb-request`
  legt den Antrag als JSON in `~/.pi-workers/requests/` ab, der Orchestrator entscheidet und legt
  `approved`/`rejected` + ein Satz Begründung als `.decision` daneben, dann spawnt er das Kind. Fünf
  Kriterien, jede Verletzung ist ein Ablehnungsgrund: **nur abwärts** (opus5 → sonnet5/haiku45/pi,
  sonnet5 → haiku45/pi; gleiche/höhere Stufe und fable5 als Ziel ungültig) · **Größengate** ≥ 10
  Dateien ODER ≥ 15 Minuten eigener Arbeit UND vollständig schriftlich spezifizierbar (sonst frisst
  der Overhead die Ersparnis) · **erste Wahl lokaler pi-Worker, nicht haiku** (mechanischer Bulk:
  lokal 100 % billiger statt 80 %) · **Pflichtangaben** Name, Zielmodell + Effort, Verzeichnis,
  EXKLUSIV zugeteilte Dateien/Pfade (sonst kollidieren zwei Worker in denselben Dateien), Aufgabe,
  Fertig-Kriterium, warum abtrennbar, geschätzter Umfang — ohne Datei-Grenzen und Fertig-Kriterium
  abgelehnt · **max. 2 offene Anträge/Kinder** pro Antragsteller, der blockiert dabei nicht, sondern
  arbeitet an dem weiter, was er selbst kann. Breites READ-ONLY-Suchen braucht keinen Antrag
  (Subagent billiger als Pane plus Antragsumweg).
- **Kontext (Regeln 2026-07-13 und 2026-07-14, der Nutzer):** niemand kann sich selbst komprimieren
  (`/compact` ist ein Slash-Befehl in der Inputbox), und ein voller Worker scheitert nicht sichtbar,
  er wird still schlechter. Sobald Worker laufen, startet der Orchestrator UNGEFRAGT
  `PROJECT=<projektdir> context-guard <orch-pane> <pane:name>…` (`~/.local/bin`). Worker ab **80 %**
  schreiben erst eine vollständige Übergabe nach `HANDOFF-<name>.md`, dann kompaktiert der Guard sie
  (Worker-Schwelle unverändert). Für den Orchestrator gilt seit 2026-07-25: **Warnung bei 75 %** —
  dann sofort Vault-Notiz + **SESSION-STATE.md** im Projekt aktualisieren und, sobald das Wissen
  gesichert ist, die Sentinel-Datei `$PROJECT/.wb-knowledge-saved` selbst anlegen; der Guard
  kompaktiert daraufhin **SOFORT** (nicht erst bei 80 %) und schickt zwingend einen Resume-Prompt,
  damit ohne Nutzer-Input weitergearbeitet wird — danach liest er SESSION-STATE.md und macht ohne
  Rückfrage weiter. Der User darf NIE derjenige sein, der an volle Kontexte erinnert.
- **Agent lifecycle — reuse, then close:** Folgearbeit an den Pane, dessen Kontext passt; fertige
  Claude-Worker, die diese Session klar nicht mehr gebraucht werden, schließen (kurz sagen);
  pi-Panes (token-frei) länger offen halten.
- **Worker-Sichtbarkeit ist Pflicht, auch remote (2026-07-25, seine Anweisung):** direkt nach jedem
  Spawn muss der Nutzer die laufenden Worker in einem Terminal-Tab SEHEN — ungefragt herstellen und
  verifizieren, nicht annehmen. Auf der anderen Maschine (`orch-launch` auf peer) heißt das: dort eine
  Gruppen-View-Session anlegen und sein lokales `workers`-Fenster per `tmux respawn-pane -k` darauf
  attachen (der Platzhalter dort ist eine Sleep-Schleife, `send-keys` verpufft), danach
  `tmux list-clients` auf dem Ziel prüfen. „Läuft, aber unsichtbar" = Fehler. Verfahren im Detail:
  `regeln/maschinen.md` (vier Schritte für entfernte Worker) und `regeln/worker-panes.md`
  (Sichtbarkeit auf der eigenen Maschine).
- **Deploy authority wie Push authority (2026-08-04):** Worker rollen NICHTS nach `~/.local/bin`
  aus; das tut der Orchestrator nach der Abnahme. Grund: `~/.local/bin` ist zwischen allen
  Worktrees geteilt, also hebelt ein Deploy aus einem Worktree die Deploy-gegen-Repo-Prüfung
  (`betriebslauf2.sh`) bei JEDEM anderen gleichzeitig laufenden Worker aus und färbt dessen Lauf
  rot. Gemessen am 04.08., als zwei Worker parallel liefen. Die Worktree-Isolierung trennt
  Dateien, nicht gemeinsame Zustände — dasselbe gilt für den Testlauf selbst, der keinen zweiten
  gleichzeitigen verträgt.
- **Push authority:** nur der Orchestrator entscheidet und führt `git push`/PRs/Publishing aus, nach
  eigener Verifikation. Teammates, Subagents und pi-Worker pushen NIE — sie geben verifizierte Arbeit
  zurück; Auto-Push von Background-Agents vermeiden/entsprechend konfigurieren.
- **Kann ein Auftrag eine GUI berühren, steht das Testfenster IM Auftrag (2026-08-04):** Die Regel
  „nie in Fenstern des Nutzers testen" (`regeln/tests-und-eingriffe.md`) gilt für jeden Worker, aber
  ein Worker, der ein CLI-Flag prüfen will, denkt nicht an sie. Am 04.08. hat einer dreimal
  `code --open-url` gegen das laufende VS Code geschickt; mein Auftrag sagte nur „nicht
  installieren". Wer eine GUI, ein Fenster oder eine laufende Anwendung berühren könnte, bekommt
  den Weg ausdrücklich vorgeschrieben: eigenes Fenster im Hintergrund, `-g`, eigenes Profil.
- **Den OPEN-Abschnitt eines Worker-Berichts vollständig lesen (2026-08-04):** Dort steht, was
  nicht geklappt hat und was der Worker selbst für fragwürdig hält — auch ein eingestandener
  Regelverstoß. Er steht am Ende, nach den Testzahlen, und wird deshalb übersehen; genau so ist
  mir der obige Fall entgangen, bis ein Reviewer ihn fand.
- **Ein NEUER Auftrag geht über das Werkzeug, nicht über `tmux send-keys` (2026-08-05, gemessen).**
  `pi-worker`/`claude-worker` mit demselben Namen verwenden den bestehenden Pane samt Kontext weiter
  UND schreiben eine Zeile ins Auftragsbuch (`~/.pi-workers/results/<name>/auftraege.tsv`): eigener
  Ergebnispfad je Auftrag, nicht je Spawn. Ein per `send-keys` eingeworfener Auftrag erzeugt keine
  Zeile und keinen neuen Ergebnispfad — dann kann nichts mehr unterscheiden, ob „Auftrag 2 fertig"
  oder „Auftrag 1 nachgebessert" wurde, und eine Fertigmeldung wird zum Ratespiel.
  **Ausgenommen bleibt, was den LAUFENDEN Auftrag ändert:** Korrektur, Rücknahme, Nachtrag. Das ist
  kein neuer Auftrag, gehört in denselben Zug und geht weiterhin per `--interrupt` plus `send-keys`.
- **Fernsteuerung: Orchestrator immer an, Worker immer aus (2026-08-05, Anweisung des Nutzers).**
  Orchestrator-Sessions starten mit `--remote-control <name>`, damit er sie vom Handy oder über
  `claude.ai/code` weiterführen kann; Worker- und Wegwerf-Panes starten ohne. Die ROLLE
  entscheidet, nicht der Aufrufer — auch ein per `wb-revive`/`wb-autorevive` wiederbelebter
  Orchestrator behält sie, sonst fehlt sie genau nach einem Absturz. Das Flag braucht ein echtes
  TTY: in einer Pipe fällt der Aufruf auf `--print` zurück und bricht ab.
- Offline (no internet): the user runs `pilocal` (pi + Qwen) directly; you are not available.
