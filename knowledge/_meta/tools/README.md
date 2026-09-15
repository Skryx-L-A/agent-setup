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
- **Exclusions**: `.git`, `.obsidian`, `.claude`, `90-secrets`, `tools`,
  `__pycache__`, lock/cache files, plus a vault-root `.brainignore`
  (gitignore syntax).
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
# brain pipeline – die ganze Kette in einem Befehl

`brain pipeline run` faehrt Gaertner und Traum hintereinander: erst
`gardener run --phase all`, danach `dream run`. Beide Werkzeuge gab es
vorher schon einzeln; `brain pipeline` reiht sie nur richtig aneinander und
haelt vor dem Traum an, wenn der Gaertner mit einem echten Fehler endet –
ein teilweise gelungener Gaertnerlauf (irgendwo unterwegs ist ein Modell
ausgefallen, Exit 0 mit "partial" im Bericht) gilt dabei als gut genug zum
Weitermachen.

Vorher steht `brain pipeline run --dry-run`. Er veraendert nichts: kein
Server startet, kein Modell wird gefragt, keine Datei im Vault wird
angefasst. Er prueft, ob mindestens 20 GiB Speicher frei sind (derselbe
Boden, den `wb-belegung` selbst durchsetzt), ob das MLX-Modell und die
beiden Ollama-Modelle lokal vorliegen, ob der Gaertner oder der Traum schon
eine Sperre haelt, und ob der Vault unversionierte fremde Aenderungen
traegt (das haelt den Lauf nicht auf, wird aber vorher gezeigt). Am Ende
steht eine Zeitspanne, keine feste Zahl: 5,78 Sekunden je Verknuepfungsurteil
sind gemessen, ein Volllauf urteilt grob ueber 300 bis 600 Paare – macht
rund 29 bis 58 Minuten fuer den urteilslastigen Teil des Gaertnerlaufs.
Extraktion, Einbetten und der Traum selbst zaehlen darin nicht mit, weil
dafuer keine vergleichbare Messung vorliegt.

Das Zeitbudget eines Gaertnerlaufs steht auf 45 Minuten. Die geschaetzte
Dauer allein fuer den urteilslastigen Teil liegt bei 29 bis 58 Minuten, und
ein voller Lauf trifft die Grenze deshalb leicht mitten in der Arbeit.
`--budget-minutes N` setzt das Budget fuer einen einzelnen Lauf. Die
Voreinstellung bleibt unberuehrt. Den Schalter tragen `gardener run`,
`brain gardener run` und `brain pipeline run` gleichermassen. Weicht der
genutzte Wert ab, steht er im Bericht unter der Phasenzeile.

Bis zum 04.09.2026 schnitt die Zeitgrenze still ab. Sechs Stellen im
Gaertner prueften sie mit drei verschiedenen Reaktionen, und der Bericht
erwaehnte sie an keiner. Ein Lauf, der bei Notiz 200 von 413 aufhoerte,
schrieb `last_run` als Erfolg. Man sah es ihm nicht an. Jetzt traegt die
Kopfzeile `(ANGEHALTEN - Zeitbudget erschoepft)`, ein eigener Abschnitt
nennt jede angehaltene Phase mit ihrem Fortschritt, und `last-run.json`
haelt dieselbe Liste samt dem genutzten Budget fest. Hoert das Einbetten
vorzeitig auf, steht das gesondert dabei. Die aehnlichkeitsbasierten Phasen
danach halten selbst nicht an und arbeiten stillschweigend nur mit den
Notizen, die einen Vektor bekommen haben.

- **Zwei Modellwege, in dieser Reihenfolge gebraucht.** Der MLX-Server
  (Qwen3.8-27B, Port 8080/8081) bedient die fuenf schlauen Gaertner-Phasen
  (linking/consolidate/maintain/synth/mine) und `brain contradict`. Ollama
  bedient den Rest: `embeddinggemma` fuer Einbettungen, `ornith:9b` fuer
  Sidecar- und Ingest-Zusammenfassungen. 48 GB insgesamt, ein grosses
  Modell zur Zeit.
- **Jedes Werkzeug sorgt fuer seinen eigenen Server.** `gardener run` und
  `brain contradict` provisionieren den MLX-Server vor den Phasen, die ihn
  brauchen, und geben ihn danach wieder frei – aber nur, wenn sie ihn selbst
  gestartet haben. Ein Server, den jemand anderes gerade benutzt, bleibt
  unangetastet stehen (siehe `gardener/gardener/mlx_server.py`).
- **Ein Abbruch ist am Bericht erkennbar, nicht am Schweigen.** Scheitert
  die Provisionierung selbst, steht das im Gaertner-Bericht unter "MLX-Server
  konnte nicht bereitgestellt werden" – ein eigener Abschnitt, getrennt von
  einem Server, der unterwegs gestorben ist ("Ollama nicht erreichbar",
  derselbe Mechanismus bedient beide lokalen Modellwege).
- **Fortsetzen heisst: denselben Befehl noch einmal aufrufen.** `brain
  gardener status` zeigt Sperrstatus und trennt den letzten VERSUCH vom
  letzten vollstaendigen ERFOLG. `brain dream status` zeigt den Stand im
  Buch; ein abgebrochener `dream run` hinterlaesst offene Einheiten dort,
  und der naechste Lauf setzt genau da fort.

CLI: `brain pipeline run [--dry-run] [--verbose]` (Umsetzung
`braincli/braincli/pipeline.py`, Tests `braincli/tests/test_pipeline.py`).
