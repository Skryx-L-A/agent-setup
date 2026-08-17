# regeln/maschinen.md

Inhalt: Peer-Rechner-Zugang, Projekt-Routing und Cross-Machine-Arbeit. Gilt seit: 2026-07-19.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor etwas auf der anderen Maschine läuft (`ssh peer`, `run-on`, Offload,
Maschinenwechsel), ein Projekt dorthin geroutet wird oder dort orchestriert wird, und
bevor Worker der anderen Maschine sichtbar gemacht werden. Die Konfliktregel beim
Ressourcenstreit steht weiter unten in dieser Datei, im Abschnitt Cross-Machine Compute.

## Standing grants — Maschinen

- **Full access to the Nobara Linux PC `Peer-Rechner` — always available, use it (granted 2026-07-19).**
  the user's second live machine (RTX 4070 SUPER, Nobara/Fedora, user `person-1`), a full peer of this
  Mac (same person → Brain/projects/secrets/state all shared). Reach it via **Tailscale-SSH
  `ssh peer`** (no key needed once the Mac is on the tailnet; IP <peer-ip>, MagicDNS
  `peer.tailnet.example.ts.net`); fallback key `~/.ssh/peer_remote` (via Syncthing `secrets-sync`, never
  via git). Runbook on the box: `~/REMOTE-ACCESS.md`; vault `10-global/peer-remote-access.md`,
  `10-global/two-machine-sync.md`, `10-global/peer-current-machine.md`. Secrets/state sync runs over
  **Syncthing P2P** (folders `vault-secrets` → `~/Knowledge/90-secrets`, `secrets-sync` →
  `~/.secrets-sync`), never GitHub. Machine switch: `msync-handoff` (leaving) / `msync-arrive`
  (arriving). Normal write/destructive rules apply on Peer-Rechner too (verify, snapshot). Peer-Rechner RAM has a
  marginal single-bit error — suspect RAM/XMP first on unexplained instability ([[faulty-ram]]).
- **Peer-Rechner project-routing + auto-offload (2026-07-19), do it automatically:** **a machine-bound project (incl. the
  its live service paper-trader) is Peer-Rechner-only** — if the user wants to work on it, start and manage the
  session ON peer, not the Mac. Offload long/independent/persistent or 12GB-fitting CUDA jobs to peer
  unprompted when it spares the Mac (say why); keep big media/LLM models on the Mac (12GB VRAM too
  small). On peer: orchestrator sessions in tmux **`wb-orch`**, your command shell in **`main`** (two
  VSCode tabs "peer — orchestrator" / "peer — control"), started via **`orch-launch`** from `main` so
  the command stays visible — **`orch-launch` existiert AUSSCHLIESSLICH auf peer**
  (`peer:~/.local/bin/orch-launch`), auf dem Mac gibt es den Befehl nicht; dort startest du
  Orchestrator/Worker regulär über `wb-code` (Session) und `claude-worker` (Spawns). Full how-to:
  unten in dieser Datei, Abschnitt „Peer-Rechner — zweite Live-Maschine".

- **Vorher ansagen, wenn Arbeit auf der ANDEREN Maschine anfängt (2026-08-04, nach seinem
  „Warum arbeitet der Worker auf PEER-RECHNER? Wir haben gerade am Mac-Build gearbeitet"):** Der
  Standing Grant erlaubt den Zugriff, er ersetzt aber nicht die Ansage. Ein Halbsatz wie
  „peer ist frei" ist keine — gesagt wird, WAS dort anfängt und WARUM, bevor es anfängt. Dasselbe
  gilt für Builds und Releases: berührt eine Auslieferung eine Plattform, die er selbst testen
  muss, sagt man ihm Bescheid, statt es beiläufig mitlaufen zu lassen („dann sage mir Du
  Bescheid, dann muss ich ihn da auch noch testen"). Er entscheidet dann über die Reihenfolge —
  am selben Tag hat er den Peer-Rechner-Teil bewusst nach hinten geschoben, um den Mac fertigzumachen.

## Aus der Orchestrator-Rolle ausgelagert (2026-08-03)

Die folgenden drei Abschnitte standen bis heute im Wortlaut in
`~/.claude/roles/orchestrator.md`. Sie gelten unverändert; gelesen werden sie beim selben
Auslöser wie der Rest dieser Datei.

## Worker der anderen Maschine sichtbar machen

- **Seit 2026-08-13 macht das `wb-remote-view` von selbst — die Handgriffe darunter bleiben der
  Notausgang.** Auslöser war Befund des Nutzers, dass ein per `orch-launch` auf peer gestarteter
  Worker (`demo-worker`) nachweislich arbeitete und im Worker-Tab des Macs nie zu sehen war: sein
  Wort dazu war „es sollte trotzdem funktionieren". Was jetzt automatisch passiert:
  * Jeder Spawn meldet sich. `pi-worker` ruft am Ende `wb-remote-view --announce` — auf JEDEM
    Weg, also auch für die Worker, die `orch-launch` auf peer startet und die nie durch
    `wb-ssh-worker` laufen. Die andere Maschine holt sich daraufhin ihren Spiegel. Der Aufruf
    ist abgekoppelt und gedrosselt; ein Spawn kann daran nicht scheitern.
  * `wb-remote-view [<mac|peer>]` stellt die Sicht her und PRÜFT sie: View-Session auf dem Ziel
    (gruppiert, `window-size latest`), lokal ein Spiegel-Pane `@wb_worker REMOTE-<maschine>`,
    `wb-grid`, `select-window` auf die lokale `-view`-Session, danach die vier Kontrollen aus
    dem Handverfahren. Exit 0 heißt: wirklich sichtbar. Exit 1 sagt, woran es liegt.
  * **Ein Spiegel je entfernter SESSION, nicht je Worker.** Jede Session drüben, in der Worker
    laufen — `wb-orch` und `wb-<ordner>-<hash>` NEBENEINANDER —, bekommt ihren eigenen
    Spiegel-Pane `@wb_worker REMOTE-<maschine>-<session>`. Die alten Sichten `view-SSH-<name>`
    je Worker gibt es nicht mehr.
  * Läuft in einer gespiegelten Session drüben kein Worker mehr, wird IHR Spiegel-Pane
    ENTFERNT, die übrigen bleiben (`wb-close` meldet es, der Kontext-Guard prüft es alle drei
    Minuten nach). Ein Spiegel, der eine Sicht behauptet, die es nicht gibt, ist schlechter als
    keiner.
  * **In eine unbeaufsichtigte Session wird nichts hineingebaut.** Kommt der Auftrag über ssh
    (die Ansage der anderen Maschine), gibt es dort kein `$TMUX_PANE` und keinen Menschen, der
    wählt; ohne angehängten Client sagt das Werkzeug das und baut nichts. Sonst landete ein
    fremder Pane mitten in einer laufenden Sitzung — auf peer wäre das Polarschern-Orchestrator des Nutzers gewesen.
  * Zwei gleichzeitige Aufrufe legen keinen zweiten Spiegel an: eine `mkdir`-Sperre je
    Zielmaschine umschließt Anlage UND Abbau.
  * Von Hand nachhelfen: `wb-remote-view peer` (herstellen) bzw. `wb-remote-view peer --check`
    (nur berichten, ändert nichts).
- **REMOTE gespawnte Worker im lokalen Terminal-Tab anzeigen — UNGEFRAGT, sofort nach dem Spawn
  (2026-07-25, seine Anweisung „ich will die Worker hier in einem Terminal-Tab sehen"):** Worker, die
  per `orch-launch`/`ssh` auf der ANDEREN Maschine laufen, sind in seinem Terminal per Default
  UNSICHTBAR — `tmux list-clients` auf dem Ziel liefert dann leer, und genau das ist im ersten Anlauf
  passiert (sechs Worker liefen ohne einen einzigen attachten Client). Verfahren, jedes Mal:
  1. Auf dem Ziel eine Gruppen-View-Session anlegen, damit die Größe seines Fensters die
     Worker-Panes nicht verformt: `tmux has-session -t wb-orch-view || tmux new-session -d -t wb-orch
     -s wb-orch-view; tmux set -t wb-orch-view window-size latest`.
  2. Lokal das `workers`-Fenster SEINER laufenden Session auf das Ziel attachen. Der Platzhalter dort
     ist eine `zsh -c … while :; do sleep 3600; done`-Schleife, KEIN interaktiver Prompt — `send-keys`
     verpufft, also den Pane ersetzen:
     `tmux respawn-pane -k -t <pane> 'ssh -t peer "tmux attach -t wb-orch-view"'`.
     `tmux new-window -d` bzw. `respawn-pane` wechseln sein aktives Fenster nicht (Fokus-Regel).
  3. **Sein Worker-Tab hängt an der lokalen `-view`-Session — dort muss das `workers`-Fenster
     AKTIV geschaltet werden (2026-07-30, zweiter Vorfall derselben Art).** Ein neu angelegtes
     `workers`-Fenster ist für ihn unsichtbar, solange kein Client es anzeigt: `tmux new-window -d`
     erzeugt es, aktiviert es aber bewusst nicht, und die beiden Clients (Basis-Session +
     `-view`-Session) bleiben auf Fenster 1 stehen. Deshalb nach jedem Neuanlegen zwingend
     `tmux select-window -t <session>-view:workers` — auf der **`-view`**-Session, nicht auf der
     Basis-Session (die ist sein Orchestrator-Tab, dort verschiebt es seinen Fokus). Fällt beim
     Aufräumen der letzte Pane des `workers`-Fensters weg, stirbt das ganze Fenster mit; dann neu
     anlegen UND wieder aktiv schalten.
  4. VERIFIZIEREN, nicht annehmen: `tmux list-clients` auf dem Ziel muss die View-Session zeigen,
     `tmux list-windows -t <session>-view` muss für `workers` `#{window_active}` = 1 melden, und
     ein `capture-pane` des lokalen Panes muss die Worker-Titelleiste enthalten.
  Dazu: `orch-launch` setzt auf JEDEN gestarteten Pane `@wb_role orchestrator` (auch auf reine
  Worker), wodurch `wb-grid` das Layout falsch aufteilt — nach dem Spawn die Worker-Panes auf
  `tmux set -p -t <pane> @wb_role worker` zurücksetzen und Leichen alter Sessions schließen.

## Peer-Rechner — zweite Live-Maschine (Zugang + Projekt-Routing: oben in dieser Datei)

`ssh peer` (Tailscale-SSH, kein Key/Passwort), always-on: sleep maskiert, linger aktiv, tmux
boot-fest. Details: Vault [[peer-remote-access]], [[two-machine-sync]], [[peer-current-machine]].

- **a machine-bound project = Peer-Rechner-ONLY**, weil Code + ~74 GB Datalake + Broker-Keys + der Live-Trader dort
  liegen. Andere Projekte laufen auf dem Mac, außer der Nutzer sagt anders oder peer ist klar
  sinnvoller.
- **Auto-Offload-Ausnahme:** große Medien-/LLM-Modelle NICHT auf peer (12 GB VRAM zu klein —
  bild/video/Qwen/LTX-2, 35B-Coder bleiben Mac/MLX). Kleine CUDA-Audio (tts/stt) läuft auf peer.
- **Sichtbare Orchestrierung auf peer — IMMER zwei getrennte tmux-Sessions:** **`wb-orch`** = NUR
  Orchestrator-Sessions + ihre Worker (der Nutzer beobachtet ungestört); **`main`** = Steuer-/
  Befehls-Shell, DEINE peer-Kommandos gehen hierher (`tmux send-keys -t main`), damit der Nutzer sieht,
  was du schickst. Orchestrator und Befehle NIE in derselben Session mischen.
- Orchestrator/Worker IMMER mit **`orch-launch <name> <model> <dir> <task>`** starten — dieser Befehl
  liegt NUR unter `peer:~/.local/bin/orch-launch`, es gibt ihn auf dem Mac nicht — zwingt sie in
  `wb-orch`; gespawnte Worker erben `wb-orch` (über `TMUX_PANE`).
  `orch-launch` aus `main` heraus aufrufen (send-keys), Befehl bleibt sichtbar.
  **Kein `SSH-`-Präfix heißt hier das GEGENTEIL von „läuft lokal" (2026-07-30, Rückfrage des Nutzers):** `SSH-<name>` tragen nur Worker, die per `claude-worker --on peer` vom Mac aus
  ferngestartet und ins lokale Grid gespiegelt werden — der Pane lebt dann auf dem Mac und wird
  per SSH fernbedient. Über `orch-launch` auf peer gestartete Worker heißen schlicht `<name>`
  und laufen als normale lokale Prozesse dort. Wenn er fragt, ist der Beleg ein Dreizeiler:
  `ssh peer 'hostname; ps -eo pid,etime,args | grep "[c]laude --model"'` plus
  `readlink /proc/<pane_pid>/cwd`.
- der Nutzer sieht beides in zwei VSCode-Tabs: „peer — orchestrator" (→ wb-orch) + „peer — control"
  (→ main). `wb-orch` ist boot-fest (User-Service `tmux-orch.service`). Die send-keys-Regel (oben)
  gilt auch hier.

## Cross-Machine Compute — Ressourcen-Check + best-fit Routing (2026-07-19)

Mac und Peer-Rechner sind volle Peers (gleiche Person, alles geteilt). Auf welcher der beiden Du sitzt,
sagt Dir der Maschinen-Kopf in `~/.claude/CLAUDE.md` — die andere ist jeweils die entfernte
(diese Datei liegt auf beiden Maschinen gleich; bis 2026-08-03 stand hier „DU sitzt auf dem Mac",
was sich von peer aus falsch las). Jeder
Orchestrator darf per `ssh` / `run-on` Jobs auf der ANDEREN Maschine starten: vom Mac `ssh peer` /
`run-on peer …`, von peer `ssh mac` / `run-on mac …` (Tailscale-SSH, permanent, kein Key). Beide
Maschinen haben den Vault `~/Knowledge` geklont+gesynct → Worker haben Brain-Zugriff.

- **best-fit-Routing (automatisch, nicht fragen):** große lokale Modelle — bild / video / 35B-Coder /
  MLX — laufen auf dem **Mac** (48 GB unified); kleine CUDA-/7B-Jobs, die in peers 12 GB VRAM passen,
  gehen nach **peer**. Schwere/eigenständige/persistente Jobs bevorzugt auf die gerade FREIE Maschine
  offloaden (kurz melden warum).
- `check-resources` vor jedem Modell-Start (Pflicht: `regeln/lokale-modelle.md`) — hier die Flags:
  maschinen-erkennend, JSON / `--human` / `--guard`; zeigt freie VRAM/RAM, laufende GPU-Prozesse,
  geladene ollama-Modelle, PROTECTED-Liste.
- **`run-on <mac|peer> [--force] <cmd>`** ist das sichere Ausführungs-Primitive: es liest
  `check-resources` auf dem Ziel und VERWEIGERT einen Modell-/Heavy-Start, der einen PROTECTED-
  Prozess verdrängen würde (exit 3) bzw. bei offensichtlich zu wenig frei (exit 4). Die
  Urteils-Entscheidung triffst DU (Konfliktregel unten); `run-on` erzwingt nur die Sicherheit,
  `--force` erst NACH dieser Entscheidung.
- **a protected service wird NIE verdrängt/gestoppt** (systemd-User-Service `a protected service` auf peer, RoBERTa
  Polarschern-Veto für a machine-bound project; werktags bei Market-Open ~5,6 GB VRAM resident, Prozesspfad
  `.../news-llm/…`). check-resources listet es als PROTECTED, run-on verweigert.
- **Konfliktregel (exakt, nie eigenmächtig killen):** Belegung mit `check-resources` prüfen → wenn ein
  Prozess evtl. beendbar wäre: **der Nutzer FRAGEN** (nie selbst killen) → sonst den Job auf der EIGENEN
  Maschine laufen lassen → sonst andere Lösung (kleineres Modell, später) → sonst begründeter
  Vorschlag an den Nutzer / warten, NICHT eigenmächtig fortfahren.

## Text mit Backticks nie durch eine Shell-Ebene schicken (2026-07-30)

In `ssh '…python3 -c "…"'` führt die entfernte Shell Backticks als Command-Substitution aus und
ersetzt sie durch Leerstellen. Das hat eine fertige Markdown-Datei stillschweigend zerstört,
während der Schreibvorgang Erfolg meldete — der Rückgabewert war 0, der Inhalt war weg.

Richtig ist: Skript per `Write` lokal anlegen, mit `scp` übertragen, dort ausführen. Danach die
Zieldatei auf leere Backtick-Paare prüfen, statt dem Exit-Code zu glauben.

Gilt für jede Shell-Ebene, nicht nur für `ssh` — auch lokal in `bash -c "…"` und in jedem
Kommando, dessen Text durch eine weitere Auswertung läuft.

Hergang: [[session-2026-07-29-30-verlustanalyse]].
