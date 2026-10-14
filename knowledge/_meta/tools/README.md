---
id: 01KYMQ8BVBC0HVVJ0P51S6REJ7
schema: 4
title: README
type: note
permalink: main/_meta/tools/readme
class: meta
---

# Sidecar layer

Every non-`.md` file in the vault gets a sibling `<name>.<ext>.md` note (e.g.
`vertrag.pdf` -> `vertrag.pdf.md`) describing what it contains, so an agent can
skip opening the real file unless it actually needs to. Implementation:
`_meta/tools/gardener/gardener/sidecar.py`.

- **Extraction is local only**: pdftotext (PDF), macOS `textutil` (doc/rtf),
  direct read (text/CSV/JSON/code), Ollama vision `qwen3-vl:8b` (images),
  `ffprobe` metadata only for audio/video (no stt by default). A type nobody
  can extract still gets a sidecar - metadata plus a placeholder, never none.
- **Idempotent**: `sha256` in the sidecar's frontmatter decides. Unchanged ->
  skipped. Changed -> only the `<!-- wb:auto:start/end -->` block is
  regenerated; anything a human added outside it (e.g. wikilinks) survives.
  `human-edited: true` in the frontmatter protects a sidecar completely.
- **Legacy-safe**: pre-existing hand/ingest-written `_assets/*.md` stubs
  (`type: asset`, `_meta/templates/asset-stub.md` convention) are recognized and
  only get missing frontmatter fields added - their body is never touched.
- **Exclusions**: `.git`, `.obsidian`, `.claude`, `secrets`, `tools`,
  `__pycache__`, lock/cache files, plus a vault-root `.brainignore`
  (gitignore syntax). Hidden files (`.space.yml`, a worktree's `.git` file) and
  structured data files (`.yaml`, `.yml`, `.json`, `.tsv`) in the knowledge
  branches `10-global`, `20-projects`, `30-topics`, `40-people` get no sidecar:
  they are tool configuration (`FALLEN.yaml` for the tripwire, `.space.yml` for
  spaces), readable as they are, and a sidecar would go stale with every
  pipeline write. The same types below `_assets/` or outside the knowledge
  branches (e.g. `00-sources/`) keep theirs (`config.SIDECAR_DATA_SUFFIXES`).
- **CLI**: `brain sidecar scan|generate|check` (see `braincli/braincli/cli.py`);
  `check` exits non-zero on missing/stale sidecars (pre-commit gate). Also
  runs as the gardener phase `sidecar` inside a full `gardener --once` pass.
# brain undo – Ruecknahme eines Maschinenschreibvorgangs

`brain undo "<satz>"` beantwortet die Frage, die ein Mensch tatsaechlich stellt:
nimm zurueck, was der Traum gestern an dieser Notiz getan hat. Umsetzung:
`braincli/braincli/undo.py`, Tests `braincli/tests/test_undo.py` (nur gegen
Wegwerf-Repositories).

- **Zuordnung braucht zwei Zeugen.** `applied.json` sagt, welcher Lauf welche
  Notiz angefasst hat; die git-Historie hat die frueheren Bytes. Der git-Autor
  taugt nicht zur Unterscheidung, weil der Gaertner unter eigener des Nutzers
  Identitaet committet (`config.GIT_AUTHOR`) – unterscheidbar ist allein die
  Commit-Nachricht, und die ist Konvention, kein Beweis. Widersprechen sich die
  beiden Quellen, wird nichts zurueckgesetzt, sondern der Widerspruch benannt.
- **Vier Verweigerungen**, jede mit eigenem Text: `unverankert` (kein Commit zur
  Lauf-Kennung), `angelegt` (die Notiz stammt vom Lauf selbst – es wird nie
  geloescht), `fremdanteil` (nach dem Lauf hat ein Mensch an der Datei
  gearbeitet), `gemischt` (der Commit des Laufs enthaelt Dateien, die
  `applied.json` nicht nennt), dazu `unsauber` und `unveraendert`.
- **Immer erst zeigen.** Ohne `--yes` und ohne Terminal bleibt es bei der
  Vorschau. Ausgefuehrt wird als NEUER Commit; die Ruecknahme ist ueber
  `brain undo --last` selbst wieder ruecknehmbar.
- **Der Index gehoert dazu.** `search.load_all_embeddings` laedt Vektoren OHNE
  Hash-Vergleich: ohne Nachziehen liefert die Suche weiter den
  zurueckgenommenen Text. `brain undo` bettet die Notiz neu ein; ist kein Modell
  erreichbar, loescht es den veralteten Vektor und sagt das.
- **Pruefprotokoll** (nach ChronoMem, arXiv 2607.27773) nach jeder Ruecknahme:
  Datei, Historie, Index, Verhalten (eine Sonde aus Woertern, die nur im
  zurueckgenommenen Text standen) und Ruecknehmbarkeit. Exit-Code 3, wenn eine
  Pruefung nicht gruen ist – 1 bleibt der Absturz.
# brain run – die eine lokale Pipeline (Brain 5)

`brain run` vereint Gärtner und Traum in einem Lauf: eine Sperre (`state/brain-run.lock`), eine
Lauf-ID, ein Bericht (`00-sources/brain-run-<lauf-id>.md`), ein Commit. Nie Push, nie Löschen.

    brain run [--profil all|gardener|lehren|dream] [--stufen S,S] [--limit N]
              [--klassen transkript,worker,doku,memory] [--projekt P]
              [--dry-run [--mit-modell]] [--json] [--budget-minutes N] [--remote peer]
    brain run status [--json]

- **Profile:** `gardener` = Pflegephasen des Gärtners (Einbetten, Verlinken, Konsolidieren,
  Pflege/MOC/Hubs, Ingest, Sidecar, Synth, Owner, Lint/Audit; `mine` entfällt; die Pflege hält
  `Stand: JJJJ-MM`-Marker aktuell, nie an `KERN.md`, siehe „Gärtner-Regeln“ unten). `lehren` (Alias
  `dream`) = Ernte → Erkennen (Ereignis-Detektor v2) → Extrahieren (peer `gemma4:12b`, Rückfall
  `qwen3.5:9b`) → Großmodell (Mac-Splash, nur für `wartet-grossmodell`, nur wenn erreichbar) →
  Projektwahl (Einheiten ohne Projekt: erst Regeln aus `_meta/projekte.tsv`, dann `gemma4:12b` als
  Lückenfüller, Ergebnis nur als `projekt_vorschlag` in der Review-Queue; `BRAIN_PROJEKT_LUECKE=0`
  schaltet das Modell ab) → Abgleichen (Einbettung `embeddinggemma`; Kosinus ≥ 0,62 = `gleich` ohne
  Modell, gemessen 0,91 gegen 0,75 mit Modell, `_meta/tools/eval/jev-pipeline/`;
  `BRAIN_ABGLEICH_COS_ALLEIN=0` = altes Paarurteil `gemma4:12b` ab 0,65; ohne erreichbare Einbettung
  bricht die Stufe ab und bucht nichts) → Prüfen (p3, siehe unten) → Schreiben.
  `all` = beides. Nachlauf nach einem kaputten Abgleich: `brain run abgleich-nachlauf --bis-lauf <id>
  [--dry-run]` setzt Pakete zurück (löscht nichts), danach `--stufen abgleichen,schreiben`.
- **Quellen der Ernte:** Transkripte `~/.claude/projects/**/*.jsonl`, Worker-Ergebnisse
  `~/.pi-workers/results`, freigegebene Projektdoku `~/AI/<p>`, Claude-Auto-Memory
  `~/.claude/projects/*/memory/*.md`. `--remote peer` liest Transkripte und Memory der anderen
  Maschine per ssh, schreibt dort nichts. Geheimnis-Tor vor jeder Verarbeitung.
- **Projekt-Zuordnung (deterministisch, kein Modell):** Transkript und Memory über den
  Arbeitsordner → `git remote` → `_meta/projekte.tsv`; ohne Remote wie der Startkontext über den
  Ordnernamen (`ordner:<name>`-Zeilen, sonst gleichnamiges Projekt); ein gelöschter Worker-Worktree
  (auch dessen Scratchpad) über die Ergebnisse des gleichnamigen Workers. Worker-Ergebnisse in
  dieser Reihenfolge, die erste Stufe mit Treffer entscheidet: bestehender Worktree, Pfade im
  Auftrag (`~/AI/<repo>`, `<your-github-user>/<repo>`, Worktree), Worker-Name (`anlass-p3`), Pfade im
  Ergebnis, Vault-Pfade (`20-projects/<p>`, `_meta/tools/`, mindestens dreimal), Projektnamen als
  Wort (mindestens dreimal; Namen aus Ordnern, `KERN.md`-Tags und -Aliasen, Repo-Namen und
  `name:<wort>`-Zeilen der Tabelle), zuletzt gleichlautende Pfadbelege von mindestens zwei
  Geschwister-Ergebnissen desselben Workers innerhalb von zwei Tagen. Mehrere Projekte ohne klare
  Mehrheit (mindestens 3 Nennungen und dreimal so viele wie das nächste) ergeben kein Projekt.
- **Auswahl und Reihenfolge:** `--klassen` beschränkt Ernte und Stufen auf Quellklassen,
  `--projekt <p>` die Stufen auf ein Projekt (die Ernte bleibt vollständig). Die Stufen arbeiten
  immer in Backlog-Reihenfolge: Claude-Memory → Transkripte (neueste zuerst) → Worker-Ergebnisse →
  Projektdoku, innerhalb jeder Klasse `a machine-bound project` zuerst.
- **Durchsatz:** Ereignisfenster, die höchstens sechs Sätze auseinanderliegen, gehen in einem
  Aufruf ans Modell (Detektor `ereignisse-v2-luecke6`). `engines.yaml` → `stufen.extraktion.
  nebenlaeufig` hält so viele Fenster gleichzeitig im Flug (peer: 2, passend zu
  `OLLAMA_NUM_PARALLEL=2` im Benutzerdienst `~/.config/systemd/user/ollama.service.d/
  brain-parallel.conf`); das Buch schreibt nur der Hauptfaden, ein Fenster je Transaktion.
- **Fremdtext und geschlossene Projekte (p3, ohne Modell):** Harness-, Auftragsvorlagen- und
  Skill-Text (Peer-Eskalationsabsatz, `[Protokoll]`/`[Arbeitsverzeichnis]`, Guard- und Harness-Fehler,
  `user:`-Turns eines geladenen Skills oder Slash-Befehls) verlässt die Ereignisfenster, bevor das
  Modell sie sieht (`gardener/lauf/fremdtext.py`; `BRAIN_FREMDTEXT=0` schaltet ab). Projekte mit einer
  Zeile `geschlossen:<projekt>` in `_meta/projekte.tsv` bekommen keine Fenster und keinen
  Modellaufruf mehr (Einheit `leer`, Grund `projekt-geschlossen`).
- **Prüfen (p3):** jedes Paket der Arten entscheidung/fehler/lehre in `abgeglichen` (und als
  Rückstand in `vorgeschlagen`) wird genau einmal geprüft; Ergebnis in `lauf_pakete.pruefung`
  (JSON). Reihenfolge: geschlossenes Projekt → alle Belegsätze Fremdtext oder nur `werkzeug:`-Zeilen →
  lokaler Entscheider (`engines.yaml` → `stufen.pruefen`: Modell, Frage, optional LR-Gewichte
  `pruefen-gewichte.json`, `schwelle`). Unter der Schwelle: Status `verworfen-auto` mit Grund und
  Score, nichts wird gelöscht; `brain run status` zählt sie. `schreiben` zeigt nur behaltene Pakete
  und wartet mit frischen, noch ungeprüften. `BRAIN_PRUEFEN=0` schaltet den Modellteil ab (dann
  wird wie vor p3 geschrieben). Ohne erreichbaren Motor scheitert die Stufe wie `abgleichen`.
  Messung: `_meta/tools/eval/vorschlaege-qualitaet/BEFUNDE.md`.
- **Übernehmen (p3):** `brain run uebernehmen [--ok ID[,ID]…] [--dry-run] [--liste F]… [--zellen F]
  [--buch KOPIE] [--ohne-einbettung] [--json]`. Seit 10.10.2026 geht nichts ohne ausdrückliches OK
  in `FALLEN.yaml`, die Entscheidungsnotiz oder KERN: **ohne `--ok`** listet der Befehl nur die
  bereiten Vorschläge mit Auswahlgrundlage und Quelleinheit und schreibt nichts (das Buch bleibt
  unberührt); **mit `--ok`** (Paket-IDs `brain-<id>` oder Präfix ab 10 Zeichen) überträgt er genau
  diese Pakete, und nur wenn die Rolle des Aufrufers als Orchestrator oder Mensch gemessen ist
  (`freigabe.pruefe`; sonst Exit 3). Das OK steht bei jedem Eintrag (FALLEN-Kommentar,
  Entscheidungstabelle, KERN-Zeile) und im Buch. Bereit sind (a) einzeln cloud-geprüfte richtige
  Pakete (Vorgabe: `eval/vorschlaege-stichprobe/richtig.tsv` und
  `eval/vorschlaege-qualitaet/kontrolle-richtig.tsv`) und (b) die behaltenen Pakete jeder Zelle,
  die die Kontrollstichprobe mit mindestens 90 % und Wilson-Untergrenze 0,8 belegt
  (`zellen-beleg.json`; die Grenzen prüft der Befehl selbst). Vorher werden Duplikate
  zusammengeführt (Textgleichheit, Einbettung ab `gleich_cos`, schon in FALLEN/KERN = Duplikat).
  Ziele: fehler/lehre mit Gegenmittel → `FALLEN.yaml`, eigener Abschnitt `# brain:uebernommen`,
  `status: gilt` (PyYAML und Tripwire-Lader prüfen, bestehende Einträge bleiben byte-gleich);
  entscheidung (und Lehren ohne Gegenmittel) → Markerblock in `ENTSCHEIDUNGEN-UND-FALLEN.md`;
  höchstens 5 Entscheidungen je Projekt zusätzlich unter `## Gilt` in `KERN.md`, nur solange der
  Körper der Datei (Text nach dem Frontmatter, wie `brain doctor` und der Sessionstart zählen)
  höchstens 3 200 Zeichen hat. Kann die KERN-Zeile nicht geschrieben werden (das Schreibtor lehnt
  `KERN.md` ab: Meldung unter „NICHT geschrieben“; `KERN.md` fehlt: Meldung unter `kern_voll`),
  gilt die Entscheidung nicht als übernommen und kommt beim nächsten `--ok` erneut dran. Buchstatus
  `uebernommen`, danach regeneriert `schreiben` die Vorschlagsblöcke. Sperre wie `brain run`, ein
  Commit, kein Push. `--dry-run` zeigt die Mengen je Datei und schreibt nichts; `--buch` liest eine
  Kopie (nur mit `--dry-run`).
- **Schreiben (nur Vorschläge):** `20-projects/<p>/FALLEN.yaml` (eigener Abschnitt am Ende,
  `status: vorgeschlagen`, der Tripwire liest nur `gilt`), Markerblock
  `<!-- brain:vorschlaege:start/end -->` in `20-projects/<p>/ENTSCHEIDUNGEN-UND-FALLEN.md` (Datei
  wird bei Bedarf mit `class: derived` angelegt) und in `review-queue.md` (KERN-Vorschläge einzeln).
  Paarurteile und Projektvorschläge (`projektwahl`) nur zu Paketen, die `pruefen` behalten hat
  (bei `BRAIN_PRUEFEN=0` alle), als eigene Abschnitte im Markerblock von
  `20-projects/<p>/brain-vorschlaege.md` (von Suche, Recall und Realitätsprüfung ausgenommen);
  die Queue trägt je Projekt nur eine `Sammelzeile` mit Anzahl und Verweis (g3, 24.09.: vorher
  1,5 MB mit rund 2 400 Projektvorschlägen und 2 100 Paarurteilen, danach wenige KB). Jede Datei
  wird je Lauf höchstens einmal geschrieben; auch der Gärtner sammelt seine Queue-Zeilen und
  schreibt die Queue einmal am Ende. `review-queue.md` ist von `brain doctor` Realität
  ausgenommen (zitiert Pfade fremder Sitzungen). Jede Zeile: Datum, Typ, Quelle
  `<quelle>#<segment>` mit Satz-IDs. Übernehmen:
  FALLEN-Eintrag über den Abschnitt verschieben und `status: gilt` setzen; der nächste Lauf
  erkennt ihn als `uebernommen`.
- **Rückkanal aus der Brain-App:** Der Block `<!-- brain-app:entschieden:start/end -->` in
  `review-queue.md` bleibt Eigentum der App. Beim nächsten Schreiben setzt `brain run` Pakete mit
  ihrem `[paket <Präfix>]` auf `abgelehnt` oder `erledigt` und regeneriert die drei Vorschlagsorte
  ohne sie. Ein angenommener KERN-Vorschlag gilt erst als `uebernommen`, wenn seine normalisierte
  Aussage unter `## Gilt` in `20-projects/<p>/KERN.md` steht. Läufer-Jobs setzen
  `BRAIN_RUN_AUSGELOEST_VON`: ihr Commit autorisiert `brain-pipeline` und trägt zusätzlich
  `Co-authored-by: <Auslöser>`; manuelle Läufe behalten die bisherige Identität.
- **Trockenlauf:** `--dry-run` lädt kein Modell und schreibt nichts in Vault oder Zustand (Buch nur
  im Speicher, Motoren nur per `/api/tags` geprüft). `--dry-run --mit-modell` rechnet die
  Modellstufen trotzdem, zur Zeitmessung, ebenfalls ohne Schreibzugriff. Ausnahme, gewollt: die
  Gärtner-Stufe führt weiter ihre Logdatei `_meta/tools/gardener/logs/gardener-<Datum>.log`, und
  `gardener --once --dry-run` legt dort zusätzlich den Bericht `gardener-report-<Datum>.md` ab
  (`logs/` ist gitignoriert; `tests/test_dry_run.py` sichert, dass der Bericht dort und nicht im
  Vault landet).
- **Fortsetzen:** Abbruch mit Strg-C oder SIGTERM ist sicher; der nächste Lauf macht dort weiter.
  Buch: `state/dream/dream.db` (Tabellen `lauf_*`, die alten `units` bleiben unverändert und sind
  übernommen). `brain run status` zeigt Zustände und letzten Lauf.
- **Aliase:** `brain gardener run …` = `--profil gardener` (alle alten Flags), `brain dream run` =
  `--profil dream`, `brain pipeline run` = `--profil all`. Die Einzelschritte `brain dream
  status|harvest|…` bleiben.
- **`--json`:** eine JSON-Zeile je Ereignis (`start`, `stufe`, `fortschritt` mit ETA, `fehler`),
  zuletzt `abschluss` mit Status, Exit-Code, Zählungen und Bericht; Schema in
  `gardener/lauf/ausgabe.py`.

## Gärtner-Regeln (g4, 2026-09-24, nach dem ersten echten Lauf)

Anlass: `brain run --profil gardener` vom 24.09.2026 lief 2 h 32 min statt 45 min, legte
`30-topics/zwei/` und `30-topics/eine/` an, schrieb in das gitignorierte `IDENTITY.md` und
meldete 25 Notizen fälschlich als „changed on disk mid-run“. Tests:
`gardener/tests/test_g4_gaertner_qualitaet.py`.

- **Richter-Motor:** die schlauen Phasen (linking, consolidate, HOT.md, synth, mine) urteilen
  über Splash (`wb-splash-server`, Port 8000), sobald das Werkzeug da ist; ein laufender
  Splash wird als Gast benutzt und nicht gestoppt, einen selbst gestarteten stoppt der Lauf.
  `GARDENER_JUDGE_ENGINE=mlx` holt den alten MLX-Weg (`grug-server`, Port 8080) zurück. Vorher
  startete der Gärtner seinen eigenen MLX-Server neben dem laufenden Splash: zwei 27B-Modelle.
- **Denkstufe:** linking urteilt ohne Denken (`reasoning_effort: none`, vier Ströme, rund 5 s
  je Paar); die schreibenden Stellen mit `GARDENER_JUDGE_EFFORT` (Vorgabe `low`; Splash denkt
  ohne Angabe auf `xhigh` und lief so in `finish_reason=length` oder die 300-s-Grenze).
- **Zeit:** linking darf höchstens die Hälfte des verbleibenden Budgets nehmen
  (`config.LINKING_BUDGET_SHARE`); synth und die HOT.md-Zusammenfassung prüfen das Budget vor
  jedem Aufruf. Nach einer Zeitüberschreitung wird nicht wiederholt, zwei in Folge beenden die
  Modellphasen des Laufs. linking prüft Deckel (`MAX_NEW_LINKS_PER_NOTE`), Schreibbarkeit und
  lokale Dateien, bevor es das Modell fragt; eine geschützte Quelle (Sitzung, fremder Autor)
  wird zum Ziel getauscht.
- **Themenseiten:** Funktionswörter (Zahlwörter, Artikel, Pronomen, Partikeln; deutsch und
  englisch) und Dateiartnamen (`kern`, `handoff`, `entscheidungen-und-fallen`) benennen kein
  Thema; ebenso wenig ein Wort, das Teil eines bestehenden Zweignamens ist (`claude`,
  `workbench`) oder eine Person aus `40-people/` meint (auch im Genitiv: `des nutzers`). Das
  großgeschriebene erste Wort eines Satztitels (mehr als drei Wörter) zählt nicht als
  Substantiv, und das Namenswort muss in mindestens 30 % der Titel des Clusters stehen
  (`topics.NAME_MIN_SHARE`; gemessen: `konto` 5 von 69, `zwei` 8 von 84). synth legt
  keine Seite an, wenn der Richter nicht antwortet, und keinen neuen Cluster ohne belegten
  Fakt; eine Seite mit dem Platzhalter „noch keine belastbare Zusammenfassung“ wird beim
  nächsten Lauf erneut erzeugt, auch bei gleichen Quellen.
- **Lokale Dateien:** `IDENTITY.md`, `HANDOFF-*.md` und alles, was git im jeweiligen Repo
  (Wurzel oder Space) ignoriert, schreibt der Gärtner nie und verlinkt es in keiner Richtung.
  Der Commit filtert ignorierte Pfade vorher heraus und meldet sie; scheitert `git add`,
  werden die eigenen Pfade wieder aus dem Index genommen, und `brain run` meldet den Fehler
  (`fehler`-Ereignis, Status `fehler`, Exit 1) statt „status ok“.
- **Richter-Antworten:** gelesen wird das erste vollständige JSON-Objekt der Antwort
  (Vorspann, Codezaun und ein überzähliges `}` dahinter stören nicht); `„Wort"` mit ASCII-
  Schlusszeichen wird vorher zu `„Wort“` repariert. Splashs erzwungene JSON-Grammatik
  (`response_format`) ist dafür ungeeignet: mit Denken endet sie gemessen in endlosem Leerraum.
- **Eigener Stempel:** Das Schreibtor stempelt `id:`/`schema:`. Weicht die Platte vom
  erwarteten Text nur um diesen eigenen Stempel ab, ist das keine fremde Änderung.
- **`Stand: JJJJ-MM`:** der Monat der letzten inhaltlichen Änderung, also des neuesten Commits,
  dessen Diff mehr als Marker, `## Relations`-Zeilen und gestempelte Frontmatter-Felder (`id`,
  `schema`, `permalink`, `stand`, `owner`) berührt. Vorhandene Marker (Frontmatter `stand:` und
  eigene `Stand:`-Zeilen) werden vorgezogen, nie zurückgesetzt und nie verdoppelt; ein
  `Stand:` mitten im Fließtext gehört dem Menschen und bleibt.

## Gärtner-Anpassungen (g5, 2026-09-24)

Grundsatz (der Nutzer, 24.09.): Was nicht richtig funktioniert, wird an die neue Lage angepasst,
nicht entfernt. Messungen: `eval/v2-gaertner/BEFUNDE.md`, Abschnitt 7.

- **Themenseiten in der Suche:** Seiten mit `class: derived` (Themen-Synthese, `brain-vorschlaege.md`)
  bleiben im Index und per Pfad lesbar, ranken aber unter ihren Quellen: Sie belegen in BM25
  und in der Einbettungsliste keinen Rang und keinen IDF-Anteil der Quellnotizen, und ihre
  fusionierte Punktzahl wird mit `search.DERIVED_FACTOR` (0,5) multipliziert. Auf der
  Prüfhälfte ist das genauso gut wie Entfernen. Rückweg: `BRAIN_SEARCH_DERIVED_FACTOR=1.0`.
- **Phasen:** synth, consolidate, sidecar und owner bleiben in `--phase all`; `mine` bleibt,
  wie seit Brain 5, nur auf Aufruf (die Lehren gewinnt `brain run --profil lehren`).
- **Lesewärme:** „Meistgelesen“ und „Vergessene Schätze“ in HOT.md sowie `cold-note` lesen
  zusätzlich die Lesezugriffe aus Claude- und Codex-Transkripten (Read-Werkzeug, `cat`/`sed`/
  `head` usw. auf eine Vault-Datei). Je Notiz und Minute zählt die größere der beiden Zahlen
  aus Hook-Log und Transkript. Zwischenspeicher: `state/transcript-heat.json`. Rückweg:
  `GARDENER_HEAT_TRANSCRIPTS=0`.
- **Tote Links:** Lint löst Links wie Obsidian auf: Pfad-Links (auch Teilpfade), Groß-/
  Kleinschreibung, Umlaute, Bindestrich/Leerzeichen/Unterstrich, Projektordner mit MOC,
  Platzhalter und Links in Code gelten nicht als tot. Ziele, die als Claude-Auto-Memory-Datei
  existieren (`config.MEMORY_GLOB`), führt der Health-Report als eigene Kategorie
  `memory-ziel`: Das Wissen liegt außerhalb des Vaults und ist Eingabe für die Lehren-Pipeline.
- **MOC-Suchschicht:** Die embed-Phase erneuert `braincli/state/extra-embeddings.db` nach dem
  Gärtner-Index; `brain doctor` meldet MOCs ohne aktuellen Vektor („MOC-Suchschicht veraltet“).

# brain server – Client-Fallback auf den my-server-Standby (F6)

`brain server status [--frisch] [--json]` zeigt je Eintrag der Serverliste Erreichbarkeit, Rolle,
Epoche und ob Forgejo antwortet, dazu, wohin Git gerade zeigt. `brain server waehlen [--still]
[--frisch]` waehlt nach der Regel des Client-Fallbacks (eigener Server bleibt, solange nutzbar;
sonst der nutzbare mit der hoechsten Epoche; keiner nutzbar = nichts aendern) und setzt dann im
Vault und in jedem Space-Repo aus `.brain/spaces.lock` **repo-lokal** `url.<standby>.insteadOf
<peer>` fuer SSH und HTTPS, bzw. entfernt die eigenen Eintraege wieder. Remote-URLs, globale
Git-Konfiguration und fremde insteadOf-Eintraege bleiben unberuehrt. Umsetzung
`braincli/braincli/server.py`, Tests `braincli/tests/test_server.py` (Fake-Server, Wegwerf-Repos).

- **Serverliste:** `braincli/server.json` (erster Eintrag = peer, die Heimat). Standby-SSH-Nutzer
  `brain-standby`: Forgejos eingebauter SSH-Server nimmt nur `BUILTIN_SSH_SERVER_USER` an, Vorgabe
  `RUN_USER`, und `brain-failover` setzt `RUN_USER=brain-standby`.
- **Kosten:** jede Pruefung hoechstens 2 s (parallel, auch bei haengender Namensaufloesung); das
  Ergebnis liegt mit Zeitstempel in `_meta/tools/state/server-wahl.json` und gilt 10 min.
- **Automatik:** `session-context.sh` startet `brain server waehlen --still` im Hintergrund
  (verzoegert den Start nicht, `BRAIN_SERVER_WAHL_AUS=1` schaltet es ab) und gibt nur dann eine Zeile
  aus, wenn der gespeicherte Stand sagt, dass Git gerade auf den Standby zeigt. `brain doctor`
  meldet einen aktiven Umweg als Befund `server_umweg`.
- Dienstseite (`/health`, CORS) und App: `braindienst/README.md`, Abschnitt „Client-Fallback".

# brain search – Einbettungsmodell wählen (s1, 2026-09-24)

`brain search` rechnet die semantische Hälfte mit genau einem Einbettungsmodell. Standard ist
`embeddinggemma` mit dem Gärtner-Index (`gardener/state/gardener.db` plus MOC-Nebenspeicher).
`qwen3-embedding-0.6b` ist eingebaut, aber Opt-in, weil sein Qualitätsgewinn über den echten Pfad
nicht gesichert ist (Test-ΔnDCG@10 +0,013 [−0,018; +0,044]); Messung und Ursachen:
`eval/suche-einbettung/BEFUNDE.md`. Umsetzung `braincli/braincli/einbettung.py`, Tests
`braincli/tests/test_einbettung.py`.

- **Wählen:** `BRAIN_EMBED_MODELL=qwen3-embedding-0.6b` (Rückweg `embeddinggemma` oder Variable
  weglassen). Ein unbekannter Wert fällt auf den Standard zurück, damit Suche und Hook nie scheitern.
- **Eigener Index je Modell:** `braincli/state/index-<modell>.db`, Kopf mit Modell, Ollama-Tag und
  -Digest, Dimension, Anfragepräfix und Dokumentvorschrift. Die Suche liest nur einen Index, dessen
  Kopf passt; fehlt er, läuft die ganze semantische Seite über embeddinggemma und `--json` sagt es
  (`embed_model`, `embed_model_fallback`). Vektoren zweier Modelle werden nie gemischt.
- **Bauen:** `brain index bauen [--modell M] [--voll]` baut `index-<modell>.db.neu` daneben und
  tauscht erst am Ende per `os.replace`. Unveränderte Notizen werden übernommen, aber nur bei
  gleichem Kopf und gleichem Ollama-Digest; ein Abbruch lässt den alten Index stehen.
  `brain index status` zeigt Kopf und Veraltung. Der Index wird nicht automatisch nachgezogen;
  `brain doctor` und `brain search` melden Veraltung des aktiven Modells mit `brain index bauen` als
  Abhilfe. `brain undo` zieht eigene Indizes mit.
- **Ollama:** Anfragen tragen das Originalpräfix `Instruct: …\nQuery:`, Dokumente keins; Abschnitte
  einzeln, je normiert, gemittelt, erneut normiert. `num_ctx` 4096 bei jedem Aufruf (sonst 4 GB statt
  2,15 GB und Neuladen). `BRAIN_SEARCH_KEEP_ALIVE` gilt wie bisher.
- **Recall-Hook:** Schwelle je Modell (`MODEL_GATES` in `hooks/auto-recall.sh`, Qwen 0,60/0,04);
  ein Modell ohne gemessene Schwelle spielt nichts ein.

# Auftrags-Recall, Recall-Dedup, Notiz-Lint, Nutzungsmonitor (v2-ki-nutzung, 2026-09-24)

Grundlage und Messungen: `eval/v2-ki-nutzung/BEFUNDE.md`, Auftragsmessung
`eval/v2-ki-nutzung/auftrag_recall_hook.py` mit Urteilen in `auftrag-recall-hook-urteile.yaml`.
Jedes Stück lässt sich über die Umgebung abschalten.

- **Auftrags-Recall (T2, `hooks/auftrag_query.py`):** Nennt ein Prompt eine existierende `.md` unter
  einem Scratchpad oder `tasks/`, sucht `auto-recall.sh` auf dem Auftrag statt auf dem Zeiger:
  Überschrift plus 500 Zeichen, Standardabsätze über eine exakte Vorlagenliste entfernt, `K=8`,
  Schwelle, Marge und `MAX_HITS` wie sonst. Weg fallen Notizen, die Auftrag oder Projekt-KERN nennen,
  sowie was der SessionStart einspielt. Nennt der Auftrag selbst zwei Vault-Notizen, schweigt der Hook.
  Kopfzeile „Brain-Recall zum Auftrag". Abschalter `BRAIN_RECALL_AUFTRAG=0`.
- **Recall-Dedup (T3):** Eine Notiz kommt je `session_id` nur einmal; Zustand in
  `state/recall-dedup/<session>.json` (Ort: `AWB_RECALL_STATE_DIR`). `session-context.sh` löscht ihn
  bei SessionStart `compact`/`clear` und räumt Zustände älter als 7 Tage. Abschalter
  `BRAIN_RECALL_DEDUP=0`.
- **Notiz-Lint (#4, `git-hooks/notiz_lint.py`, `git-hooks/pre-commit`):** Warnt beim Commit neuer oder
  geänderter Wissensnotizen ohne `title`, `type`, `branch`, `created`, `beleg` (gemessen|berichtet)
  oder ohne erste Zeile „Für künftige Sessions“; Quellen, `sessions/`, KERN/MOC/STATUS und erzeugte
  Seiten nie. Blockiert nie. Installation für Kern und alle Spaces (Symlink, fremde Hooks bleiben):
  `sh _meta/tools/git-hooks/install-notiz-lint.sh [~/Knowledge]`; Kern-Worktrees teilen die Hooks des
  Kerns, Spaces brauchen den eigenen Eintrag. Abschalter `BRAIN_NOTIZ_LINT=0`. `brain doctor` meldet
  dieselben Befunde für die letzten 14 Tage (`notiz_lint`, nie „important“).
  Seit 14.10. zusätzlich ein KERN-Hinweis: Liegt eine `KERN.md` im Commit über 3200 Zeichen Körper (Zählung wie
  `brain doctor`), schlägt der Hook FALLEN.yaml oder eine Entscheidungsnotiz für neue Lehren vor; blockiert nie,
  Abschalter `BRAIN_KERN_HINWEIS=0` (Idee 3c der Brain-Prüfung).
- **Nutzungsmonitor (#6, `brain doctor`, Abschnitt `nutzung`):** Aus den Claude-Transkripten dieser
  Maschine der letzten 7 Tage: Anteil maschineller Auslöser des Auto-Recalls (Alarm über 10 %,
  erscheint dann in der SessionStart-Zeile „Vault-Pflege“), Anteil nichttrivialer Sitzungen mit
  `brain search` vor dem ersten Edit getrennt nach Haupt und Worker, Tripwire-Auslösungen.
  Inkrementell über `state/nutzung-cache.json` (Byte-Offset je Transkript): kalt rund 2 s, danach
  0,05 s. Nur die Maschine, auf der `brain doctor` läuft. Abschalter `BRAIN_NUTZUNG=0`.
