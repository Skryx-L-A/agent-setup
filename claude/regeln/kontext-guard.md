# regeln/kontext-guard.md

Inhalt: Bedienung des Kontext-Guards und wie Kontext-Auslastung gemessen wird. Gilt seit: 2026-07-14 bis 2026-07-27.
Diese Datei ist ausgelagert aus `~/.claude/roles/orchestrator.md`; sie gilt
unverändert weiter.

Auslöser: bevor Du den Guard startest, prüfst, beendest oder eine neue Fassung installierst,
und bevor Du die Kontext-Auslastung eines Panes beurteilst. Die Schwellen selbst
(Worker 80 %, Orchestrator Warnung 75 %) stehen in `regeln/orchestrierung.md` und im
Kopf der Orchestrator-Rolle — hier steht, wie man sie durchsetzt.

## Guard-Bedienung

- **GUARD-BEDIENUNG — auswendig, weil `contextGuardAutostart` auf `false` BLEIBT (Entscheidung des Nutzers 2026-07-27).** Niemand startet ihn für dich; vergisst du ihn, merkt es keiner, bis ein
  Worker still schlechter geworden ist. Deshalb gehört der Start in denselben Handgriff wie der erste
  Spawn:
  ```
  PROJECT=<projektdir> nohup ~/.local/bin/context-guard --auto %0 \
    >> ~/.local/state/context-guard-<tmux-session>.log 2>&1 &
  ```
  `%0` ist DEIN Pane (`tmux display -p '#{pane_id}'`). `--auto` liest die Worker-Liste bei JEDEM Poll
  aus der Session — später gespawnte Worker sind ohne Neustart abgedeckt, du startest also genau
  einen pro Session und nie einen zweiten (zwei tippen `/compact` doppelt).
  - **Prüfen statt annehmen — aber nicht mit `pgrep -f` (korrigiert 2026-08-03):** jedes Muster
    auf `context-guard` trifft AUCH die eigene Claude-Sitzung, weil diese Zeile hier im
    Rollen-Prompt steht und der Prompt im argv landet. Der `[c]`-Trick hilft nicht, er ist nur
    ein Regex und passt auf denselben Text. Gemessen: `pgrep -f '[c]ontext-guard --auto' | wc -l`
    lieferte 20, echte Guards liefen 5. Zählen über den Interpreter, der wirklich das Skript
    ausführt:
    ```
    ps -eo pid,comm,args | awk '$2 ~ /^(bash|zsh|sh)$/ && /bin\/context-guard/'
    ```
    Für DIESE Session muss genau eine Zeile mit der eigenen Pane-ID (`tmux display -p
    '#{pane_id}'`) dabei sein. Zeilen mit fremden Pane-IDs gehören anderen Sessions — vor dem
    Beenden gegen `tmux list-panes -a` prüfen, ob deren Pane noch lebt; nur ein Guard ohne
    lebenden Pane ist eine Waise.
  - **Beenden:** `context-guard --stop [<pane|session>]` (ohne Ziel = diese Workbench),
    `--stop --all` für alle. Die Stopdatei liegt unter
    `~/.local/state/wb-context-guard/<socket>-<session>.stop`; der Guard sieht sie erst beim nächsten
    Poll (60 s) und räumt sie nicht ab — **erst löschen, wenn er WIRKLICH weg ist**, sonst hebst du
    den Stop auf. Hängt er, per PID beenden und mit `pgrep` gegenprüfen.
  - **Nach jedem Installieren einer neuen `context-guard`-Fassung:** laufenden Guard ZUERST mit dem
    ALTEN Mechanismus beenden, dann installieren, dann neu starten. Ändert sich der Pfad der
    Stopdatei, erreicht `--stop` die alte Instanz nie wieder; und bash liest ein laufendes Skript
    lazy nach — eine in-place überschriebene Datei führt ab dem Schnitt Müll aus.
  - Ein Guard ohne erreichbares tmux startet nicht mehr (früher: stiller `unknown-$$`-Slug,
    unstoppbar). Sein Log ist die Wahrheit über sein Handeln, nicht der Pane-Text.

## Kompaktieren

- **NIEMAND KOMPAKTIERT SICH SELBST (2026-07-14):** der Guard tippt `/compact` — für einen Worker wie
  für dich — und schickt danach zwingend einen Resume-Prompt (auf `HANDOFF-<name>.md` bzw.
  SESSION-STATE.md + GOALS/QUALITY/PERF-STATE), sonst sitzt der frisch komprimierte Pane ohne Auftrag
  da und scheitert lautlos. Beide Hälften gehören zusammen: ohne Resume-Prompt keine Kompaktierung.

## Auslastung messen

- **Auslastung richtig messen (2026-07-25, gemessen):** in der Statuszeile steht das Zahlenpaar
  `<benutzt>/<gesamt>` (z. B. `485k/1.0M`) — DAS ist die Quelle, weil es exakte Prozente erlaubt und
  damit 75 % überhaupt darstellbar macht. Der Balken (`▓▓▓▓░░░░░░`) taugt nur grob, zehn Stufen. Die
  Zeichenkette „context used" gibt es NICHT — danach zu greppen liefert immer leer. In einem SCHMALEN
  Pane (48–51 Spalten, langer Pfad) ist die Statuszeile VOR dem Balken abgeschnitten und liefert gar
  nichts: dann ist die Auslastung UNBEKANNT, nicht „0 %", und Unbekannt darf NIE als „alles gut"
  gelesen werden (ein blinder Guard fiel so 38 Minuten nicht auf) — Pane verbreitern oder anders
  messen.

## Sentinel

- **Sentinel erst NACH dem Guard-Start setzen (2026-07-29):** `context-guard` verwirft ein
  `.wb-knowledge-saved`, das älter ist als er selbst, entfernt es und kompaktiert NICHT —
  richtig ist: Guard starten, dann `touch`. Gemessen, als der Guard einer Session unbemerkt
  gestorben war und bei 87 % neu gestartet werden musste. (Stand bis 2026-08-10 in
  `~/.claude/CLAUDE.md`, Abschnitt Secrets; dorthin gehörte sie nie — sie betrifft den Guard.)
