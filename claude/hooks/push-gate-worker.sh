#!/bin/bash
# Zweck: blockt `git push` und `gh pr create`, wenn der eigene tmux-Pane als
#        Worker markiert ist (@wb_role=worker).
# Event: PreToolUse, matcher Bash.
# Warum: "Push authority: nur der Orchestrator entscheidet und fuehrt git
#        push/PRs/Publishing aus" ist heute reine Rollenprompt-Anweisung
#        (WORKER.md: "NEVER git push"), kein technisches Gate.
# Erkennung: `tmux display -p -t "$TMUX_PANE" "#{@wb_role}"` — dieselbe Option,
#        die claude-worker/pi-worker beim Spawn setzen (siehe wb-close,
#        pi-worker: "tmux set -p -t \"$pane\" @wb_role worker"). Bewusst OHNE
#        Aenderung an den Spawn-Skripten (die baut gerade ein anderer Worker
#        um) — reines Read-Only-Abfragen der bereits gesetzten Pane-Option.
# Fail-open: kein TMUX_PANE / kein tmux / Option nicht gesetzt -> erlauben
#        (kein eindeutiger Treffer, siehe Auftrag: deny nur bei eindeutigem
#        Treffer, nie bei einem Parse-/Erkennungsfehler).
# Fix nach Review 2026-07-28 (M10): `git push` wurde nur erkannt, wenn "git"
#        UNMITTELBAR von "push" gefolgt wird — `git -C <dir> push` (genau die
#        Form, die vault-sync selbst benutzt) fiel komplett durch. Jetzt
#        liest find_git_invocation() den ersten Nicht-Options-Token nach
#        "git" als echtes Unterkommando (kennt -C/-c/--git-dir=/--work-tree=).
# Fix nach Stresstest 2026-07-28 (B11/B02): die eigentliche Push-Erkennung lief
#        ueber `read -a toks <<< "$seg"` auf der KOMPLETTEN Kommandozeile —
#        keine Quote-Behandlung, keine Teilbefehl-Zerlegung. `git` als absoluter
#        Pfad (/usr/bin/git), `git push` in `eval "…"`/`bash -c "…"` (die
#        umschliessenden Anfuehrungszeichen blieben als Zeichen im Token
#        haengen, "git" traf dann nie exakt) und `git $VAR` mit VAR=push aus
#        einer vorherigen Zuweisung kamen alle durch. Jetzt macht
#        `lib/push_gate_classify.py` dieselbe echte Zerlegung wie
#        bash-guard-kill-pattern (gemeinsam in lib/cmdshell.py): Shell-
#        Tokenizer, Teilbefehle, aufgeloeste einfache Variablen, `eval`/
#        `<shell> -c` rekursiv. `-C <dir>` blieb dabei erhalten (M10). Und:
#        kein `jq` mehr — Python3 (json-Modul) fuer Parsen und Ausgabe.
set -uo pipefail

# Eigenes Verzeichnis robust bestimmen: `${BASH_SOURCE[0]%/*}` liefert bei einem
# Aufruf OHNE Pfadpraefix den Dateinamen selbst — dann sucht der Hook seine
# Hilfsdatei unter <skript>/lib/ und stirbt (fail-closed, aber unnoetig).
HOOKSELFDIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# HAERTUNG 2026-07-28 (Stress-Befund B02, zweite Runde): Interpreter und Leser werden
# ABSOLUT aufgerufen. Ein gestripptes PATH (im Stresstest nur `bash`) liess sonst schon
# `cat` und `python3` fehlschlagen — der Hook konnte die Eingabe nicht einmal lesen und
# endete auf 0, also ERLAUBEN. Ein Deny-Hook, der sein Werkzeug nicht findet, blockt.

HOOKDIR="$HOOKSELFDIR"
input=$(/bin/cat)
push_hit=$(printf '%s' "$input" | /usr/bin/python3 "$HOOKDIR/lib/push_gate_classify.py" 2>/dev/null)
[ "$push_hit" = "1" ] || exit 0

# Zwei Rollenquellen, strengste Lesart (Befund 2026-08-07, gemessen: ein Worker, der
# `tmux set -p -t <sein pane> -u @wb_role` ausfuehrte, durfte danach pushen). Worker
# ist, wen EINE der beiden Quellen so nennt -- die Pane-Option oder das Register in
# lib/rollen.py. Fehlt das Modul, bleibt es bei der Option: nie schwaecher als vorher.
role=""
if [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
  role=$(tmux display -p -t "$TMUX_PANE" '#{@wb_role}' 2>/dev/null || true)
  if [ "$role" != "worker" ] && [ -f "$HOOKDIR/lib/rollen.py" ]; then
    reg=$(/usr/bin/python3 "$HOOKDIR/lib/rollen.py" lesen "$TMUX_PANE" 2>/dev/null \
          | awk -F'\t' '$1=="register"{print $2}')
    [ "$reg" = "worker" ] && role=worker
  fi
fi

if [ "$role" = "worker" ]; then
  /usr/bin/python3 -c '
import json
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            "Push-Authority-Regel: nur der Orchestrator pusht/erstellt PRs. Dieser "
            "Pane ist als @wb_role=worker markiert. Verifizierte Arbeit ans "
            "Orchestrator-Pane zurueckgeben. Blockiert von push-gate-worker."
        ),
    }
}))
'
fi

exit 0
