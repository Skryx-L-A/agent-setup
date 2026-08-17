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
