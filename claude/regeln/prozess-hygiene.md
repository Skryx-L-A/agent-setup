# regeln/prozess-hygiene.md

Inhalt: was gestartet wird, wird auch beendet (volle Aufzählung) und geteilte MCP-Server. Gilt seit: 2026-07-20 / 2026-07-28.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor ein länger laufender Prozess gestartet wird (Server, Watcher, Modell,
Background-Job, Tunnel), nach jeder abgeschlossenen Teilaufgabe, vor dem Sessionende —
und nach einem Plugin-Update. Der Merksatz steht weiter in CLAUDE.md; hier steht die
vollständige Aufzählung samt NIE-beenden-Liste.

## Standing rules — Prozess-Hygiene

- **Ein laufendes Shell-Skript wird nicht bearbeitet (2026-08-16).** Bash liest die Datei über
  einen Byte-Versatz nach; eine Änderung im Kopf verschiebt alles dahinter, und der laufende
  Prozess setzt an einer sinnlosen Stelle fort — ohne Fehlermeldung. Erst beenden, dann ändern,
  dann neu starten ([[session-2026-08-16-abend-fenstergrenze-und-aufseher]]).
- **Ein abgelöster Prozess bekommt einen Eigentümer (2026-08-11).** Statt `nohup <befehl> &
  disown` heißt es `wb-nohup <name> -- <befehl> [args…]`: das trägt PID, Startbefehl, Startzeit,
  Worker und Pane ein, und `wb-waisen` liest den Eintrag, statt aus Verbindungen zu raten. Grund:
  in der Nacht zum 11.08. überlebte ein Modellserver mit 21,9 GB das Ende seines Panes, und
  niemandem fiel es auf. `wb-waisen` beendet nie selbst; den `kill`-Befehl schlägt es nur vor, wo
  der Eigentümer nachweislich tot ist UND keine Benutzung gemessen wurde (offene Verbindung,
  CPU-Bewegung oder **wachsender** Speicher — ein ladendes Modell sieht sonst zwanzig Minuten aus
  wie eine Leiche).
- **Vor einem großen Modellstart wird belegt (2026-08-11).** `wb-belegung nimm --modell <m>
  --gewichte-gb <n> --parallel <n> --kontext <n> --zweck "<…>"`, nach dem Laden `wb-belegung
  geladen <kennung>`, danach `wb-belegung gib <kennung>`. Belegt wird die SPITZE (Gewichte +
  gleichzeitige Anfragen × Kontext × KV je Token + Zuschlag), nicht das Gewicht: zwei Kernel-Paniken
  in einer Nacht entstanden genau in dieser Lücke, ausgelöst durch GPU-Speichermangel. Ein Nein
  nennt den Halter; `wb-post` ist der Weg, ihn anzusprechen.
- **Prozess-Hygiene: was gestartet wird, wird auch beendet (2026-07-20).** Alles, was Orchestrator
  oder Worker starten, wird beendet, sobald es nicht mehr gebraucht wird — sofort nach der
  Teilaufgabe, nicht erst am Sessionende: Dev-/Preview-/API-Server, Watcher, Test-Runner,
  Playwright/Chromium, Tunnels, Background-Jobs (`&`, `nohup`, `run_in_background`), geladene lokale
  Modelle (`ollama stop <modell>`, llama-server), temporäre tmux-Panes/-Sessions fertiger Worker.
  Auf BEIDEN Maschinen (Mac und Peer-Rechner), auch für per `ssh`/`run-on` remote gestartete Jobs. Worker:
  eigene Prozesse beenden VOR dem Result-File und dort nennen, was beendet wurde. Orchestrator: nach
  jeder abgeschlossenen Teilaufgabe und vor dem Sessionende selbst auf Waisen prüfen und beenden
  (`ps`/`pgrep -af`, `lsof -i -P | grep LISTEN`, `ollama ps`, `tmux ls`, auf peer zusätzlich
  `nvidia-smi`). Beendigung wird VERIFIZIERT, nie angenommen: Prozess weg, Port frei, VRAM/RAM
  zurück. **NIE beendet werden:** Prozesse des Users (Apps, Editoren, Browser-Fenster, Discord/Steam,
  another service/whisper-server, laufende Aufnahmen), geschützte Dienste (a protected service auf Peer-Rechner) und alles, was
  `check-resources` als PROTECTED listet — dort gilt die Konfliktregel: im Zweifel der Nutzer fragen,
  nie eigenmächtig killen. Vor dem Beenden eines Panes/Workers dessen Wissen sichern
  (Result-File/Handoff), bei uncommitteten Änderungen Snapshot nach
  `~/.local/trash-snapshots/<datum>-<name>/`.

- **MCP-Server laufen geteilt, nicht pro Session (2026-07-28):** `basic-memory` und `playwright`
  hängen als HTTP-Server an LaunchAgents (Ports 8766/8767, nur 127.0.0.1) — stdio startete je
  Session eigene Prozesse (gemessen: 72 Stück, 6,6 GB). Bedienung: `mcp-shared status|restart|reap`;
  nach einem Plugin-Update `mcp-shared apply`, sonst fällt Playwright auf stdio zurück.

- **Kein Prozess läuft dauerhaft, nur solange er gebraucht wird (2026-08-16, globale des Nutzers Regel: „ich will das die wächter nicht dauerhaft aktiv sind… das gilt für alle
  prozesse um systemressourcen zu sparen").** Betrifft ausdrücklich die Wächter — Kontext-Guard,
  `traum-wache.sh`, Beobachter auf Meldedateien, Wartelaufe — und jeden Hintergrundjob: sie
  werden ZUM ANLASS gestartet und beendet, sobald der Anlass weg ist, nicht auf Vorrat
  gehalten. Konkret: keine Wache ohne laufenden Lauf, kein Kontext-Guard ohne laufende Worker,
  kein Wartelauf, dessen Ziel schon fertig ist. Wer einen Wächter startet, plant sein Ende mit;
  ein Wächter, der nach dem Ende seines Schützlings weiterläuft, ist selbst eine Waise.
  Unberührt bleiben die geteilten Dienste, die es aus Sparsamkeit GIBT (`mcp-shared`,
  LaunchAgents) — sie ersetzen viele Einzelprozesse und sind der Grund, nicht der Verstoß.
