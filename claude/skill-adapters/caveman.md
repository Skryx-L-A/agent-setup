# Caveman-Adapter

Gilt für die 27 im Katalog genannten Caveman-Payloads einschließlich der
registrierten Claude-Varianten. Inhaltliche Duplikate bleiben eine Quelle;
Wrapper werden nicht als eigene Skills übernommen.

- `caveman`: knappe, klare Sprache nach Hausstil; Mode-Dateien oder Vendor-
  Slash-Kommandos nur, wenn der laufende Harness sie tatsächlich anbietet.
- `caveman-commit`, `caveman-review`, `investigate-first`, `lean-build`,
  `migration`, `safe-refactor`, `surgical-patch`, `verify-and-stop`: Fachablauf
  unverändert, aber ohne Emoji-Schweregrade oder behauptete Claude-Details.
- `cavecrew`, `caveman-explore`: Suche/Lesen ist die Fähigkeit. Fehlen benannte
  Subagenten oder Explore-Tools, führt der Hauptagent die fokussierte Suche aus.
- `caveman-compress`, `caveman-learn`, `caveman-optimize`: nur Vorschlag,
  Diff oder Messplan. Änderungen und Optimierungsläufe folgen Hausfreigaben.
- `caveman-discover`, `caveman-evidence-review`, `caveman-manage`,
  `caveman-setup`: Cloudmetriken, Gateway und Experimente nur bei vorhandener
  Fähigkeit. Sonst ist der offene Fallback „keine Telemetrie vorhanden“.
- `caveman-help`, `caveman-stats`: reine Vendor-Hilfe oder Hook-Auswertung;
  auslagern, nicht simulieren.

Die Prüfregel in `~/.claude/regeln/verifikation.md` ersetzt Vendor-Routinen für
pauschale Baselines, Vorher/Nachher-Evals oder Review-Schleifen.

## Registrierte Claude-Commands und Rollen

- `cavecrew-builder`: Fachabsicht „kleinster bestehender Diff“; die
  Anbietergrenze von zwei Dateien und die benannten Edit-Tools gelten nur, wenn
  der laufende Harness sie tatsächlich bietet. Ein passender gelesener Diff ist
  ein angemessener Beleg; keine pauschale Testsuite.
- `cavecrew-investigator`: reine Lokalisierung. Fehlende `Explore`-, `Bash`-
  oder Haiku-Mechanik wird durch fokussierte Suche des Hauptagents ersetzt;
  keine feste Modellzuweisung und kein automatisches Spawn.
- `cavecrew-reviewer`: begrenzter Review bei Auftrag oder konkretem Risiko.
  Emoji-Schweregrade und die feste Haiku-Bindung werden nicht übernommen.
- `caveman`, `caveman-commit`, `caveman-review`, `caveman-stats`: nur die
  fachliche Absicht bei vorhandener Runtime. Moduswechsel oder Hook-Statistik
  wird nicht simuliert.
- `caveman-init`: Vendor-Adapter. Die Quelle fordert Repository-Schreibzugriff
  und außerhalb des eigenen Checkouts einen Download mit Pipe-Ausführung
  (`.../commands/caveman-init.md:6-13`). Der portable Weg bleibt: vorhandene
  Projektanweisungen lesen, konkreten Diff vorbereiten und nur unter den
  bestehenden Änderungsregeln schreiben.

