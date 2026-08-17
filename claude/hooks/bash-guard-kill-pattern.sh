#!/bin/bash
# Zweck: blockt zu breite pkill/killall/kill $(pgrep …)/tmux kill-server/
#        tmux kill-session-Aufrufe.
# Event: PreToolUse, matcher Bash.
# Warum: ECHTER Vorfall — `pkill -f "tmux attach -t =wb-"` in einem Testskript
#        hat den LIVE-Client des Nutzers zweimal beendet (Muster endete auf den
#        Praefix "wb-", traf dadurch JEDE Session mit dem Praefix). CLAUDE.md:
#        "Kein Kill-Muster, das ueber die eigenen Testprozesse hinausreicht."
#        Vault: [[incident-2026-07-25-killmuster-beendete-live-client]].
# Fix nach Review 2026-07-28 (H5): zwei Luecken behoben.
#        (1) `tmux kill-server`/`tmux kill-session` toeten eine LIVE-Session
#            noch direkter als pkill/killall, waren aber komplett vom Trigger
#            ausgenommen — jetzt mit aufgenommen.
#        (2) die Allowlist pruefte "wbtest" gegen die GANZE Kommandozeile, ein
#            Substring irgendwo (Kommentar `# wbtest`, verkettetes
#            `; echo wbtest`) hob den Default-Deny fuer den GESAMTEN Befehl
#            auf. Jetzt wird die Kommandozeile zuerst in Teilbefehle
#            zerlegt (an `;`/`&&`/`||`/`|` UND an Kommentaren `#`), und jeder
#            Teilbefehl einzeln geprueft — die Allowlist muss im SELBEN
#            Teilbefehl stehen wie das gefaehrliche Kommando, nicht irgendwo
#            im Rest der Zeile.
# Policy: Start als HARTER Block (default-deny), ausser das Muster ist
#        nachweislich eng (eigener Test-Socket/-Sessionname mit Suffix, oder
#        eine konkrete PID). Dokumentierter Umweg bei False Positive: die
#        konkrete PID nennen (`kill 12345`) statt Musterabgleich.
# Fix nach Stresstest 2026-07-28 (B01/B02/B13): die Zeilen-Regex oben erkannte
#        nur den Kommandonamen als WORT, nicht seine SEMANTIK — Variablen-
#        Indirektion ($P wobei P=pkill), Aufruf ueber absoluten Pfad/mit
#        Backslash, `eval`/`bash -c` mit dem Kommando als Zeichenkette,
#        `pgrep | xargs kill` und ein `for … in $(pgrep …); do kill … done`
#        kamen alle glatt durch (B01) — UND dieselbe Wort-Regex loeste aus,
#        sobald "pkill" irgendwo als TEXT vorkam (`echo pkill`, `grep -r
#        pkill .`), nicht nur wenn es ausgefuehrt wird (B13, hat am
#        2026-07-28 den eigenen Testaufruf und einen orchestrierenden Prompt
#        blockiert, obwohl beide das Wort nur als Daten enthielten). Und ohne
#        `jq` im PATH gab `jq -r … || exit 0` lautlos frei (B02).
#        Jetzt macht `lib/kill_pattern_classify.py` eine echte Zerlegung
#        (Shell-Tokenizer, Teilbefehle an ;/&&/||/|/Zeilenumbruch, einfache
#        Variablen aufgeloest, `eval`/`<shell> -c` rekursiv in denselben
#        Klassifizierer geschickt, `pgrep`/`ps` als Quelle fuer eine
#        nachfolgende `kill`/`xargs kill` erkannt) und entscheidet NUR anhand
#        des Kommandos in KOMMANDOPOSITION jedes Teilbefehls — ein Name, der
#        bloss als Argument/Text auftaucht, zaehlt nicht. Statisch nicht
#        aufloesbare Formen (eval mit `$(...)`-Inhalt, Pipe in einen nackten
#        Interpreter wie `| bash`) bleiben bewusst geblockt — Durchlassen ist
#        bei denen die einzige falsche Antwort. Ohne jq: das Skript ist reines
#        Python3 (json-Modul statt jq), kein externes Binary mehr im Weg.
set -uo pipefail

# Eigenes Verzeichnis robust bestimmen: `${BASH_SOURCE[0]%/*}` liefert bei einem
# Aufruf OHNE Pfadpraefix den Dateinamen selbst — dann sucht der Hook seine
# Hilfsdatei unter <skript>/lib/ und stirbt (fail-closed, aber unnoetig).
HOOKSELFDIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# HAERTUNG 2026-07-28 (Stress-Befund B02, zweite Runde): Interpreter und Leser werden
# ABSOLUT aufgerufen. Ein gestripptes PATH (im Stresstest nur `bash`) liess sonst schon
# `cat` und `python3` fehlschlagen — der Hook konnte die Eingabe nicht einmal lesen und
# endete auf 0, also ERLAUBEN. Ein Deny-Hook, der sein Werkzeug nicht findet, blockt.

/usr/bin/python3 "$HOOKSELFDIR/lib/kill_pattern_classify.py"
exit $?
