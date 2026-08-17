---
title: "SQLite-WAL auf dem Netzlaufwerk — warum der Index jetzt lokal liegt"
type: decision
branch: 20-projects/beispielprojekt
tags: [sqlite, index, messung]
created: "2026-05-14"
aliases: ["WAL-Umzug", "Index-Umzug"]
beleg: gemessen
review-after: "2027-05"
related: ["[[beispielprojekt STATUS]]"]
---

Für künftige Sessions: lies das, bevor Du den Suchindex wieder auf ein gemountetes Laufwerk
legst — die Idee kommt alle paar Monate wieder und ist zweimal gemessen worden.

Der Suchindex lag bis zum 14.05. auf dem NFS-Mount `/mnt/team`, damit beide Rechner denselben
Index benutzen. Das funktionierte, solange nur einer schrieb. Sobald der zweite Rechner
gleichzeitig indexierte, brach jeder dritte Lauf mit `database is locked` ab.

Gemessen an denselben 1.842 Dateien, dreimal je Variante:

| Ort | Index-Lauf | Abbrüche in 30 Läufen |
|---|---|---|
| NFS-Mount, WAL | 4 min 12 s | 11 |
| NFS-Mount, journal_mode=DELETE | 9 min 38 s | 0 |
| lokale SSD, WAL | 51 s | 0 |

Der Grund steht in der SQLite-Dokumentation und ist keine Eigenheit dieses Aufbaus: WAL braucht
gemeinsamen Speicher zwischen den Prozessen, und den gibt es über NFS nicht. Auf `DELETE`
umzustellen beseitigt die Abbrüche und kostet den Faktor elf gegenüber lokal — dafür ist der
Index zu heiß.

**Entscheidung:** Der Index liegt lokal, je Rechner einer. Geteilt wird der Quelltext der Notizen
über git, nicht der abgeleitete Index. Ein Index, der sich in 51 Sekunden neu bauen lässt, ist
kein Gut, das man synchronisieren muss.

Was dagegen spricht und trotzdem hingenommen wird: nach einem `git pull` ist der lokale Index
kurz veraltet. Der Hook in `_meta/tools/git-hooks/` stößt den Neubau an, das dauert die genannte
knappe Minute, und in dieser Minute findet die Suche die neuesten Notizen noch nicht.

relates-to [[beispielprojekt STATUS]]
supersedes [[index-auf-netzlaufwerk]]
