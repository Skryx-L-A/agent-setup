#!/bin/bash
# Zweck: blockt Kompaktierung, wenn fuer diesen Pane weder ein frisches
#        HANDOFF-<name>.md (Worker) noch SESSION-STATE.md/.wb-knowledge-saved
#        (Orchestrator) existiert.
# Event: PreCompact.
# Warum: die gesamte Kontext-Mechanik (75%/80%-Schwellen, Handoff-Pflicht vor
#        Kompaktierung) ist heute NUR durch context-guards eigenes Timing
#        durchgesetzt — kein technisches Netz, falls der Guard mal nicht
#        laeuft. CLAUDE.md: "Warnung bei 75% ... SESSION-STATE.md ...
#        Sentinel-Datei ... danach kompaktiert der Guard SOFORT."
# Scope: greift NUR, wenn dieser Pane ueber die tmux-Pane-Option @wb_role als
#        "worker" oder "orchestrator" markiert ist (dieselbe Erkennung wie
#        push-gate-worker). Ein ganz normaler, nicht orchestrierter Claude-
#        Code-Lauf (kein @wb_role gesetzt) hat gar keine Handoff-Konvention —
#        dort wuerde ein Hard-Block nur nerven, ohne dass die Regel ueberhaupt
#        gilt. Dadurch bleibt das Blast-Radius auf die Workbench-Mechanik
#        begrenzt, fuer die die Regel geschrieben wurde.
# Override (WICHTIG, sonst sperrt sich der Nutzer selbst aus):
#        - Datei ~/.claude/.allow-compact anlegen (touch), ODER
#        - Env-Var CLAUDE_ALLOW_COMPACT=1 setzen
#        Beides umgeht den Gate fuer genau diesen Kompaktierungsversuch.
# Fix nach Review 2026-07-28 (H4): der Hook las das Trigger-Feld nie und
#        blockte dadurch auch die AUTOMATISCHE Kompaktierung (Harness will
#        wegen Kontextdruck kompaktieren, Worker hat gerade DESHALB kein
#        frisches Handoff geschrieben -> Pane haette in die Kontextwand
#        laufen koennen, statt sich zu retten). Jetzt: bei `auto` wird NUR
#        gewarnt (stderr), nie geblockt. Nur bei `manual` (oder wenn das
#        Trigger-Feld fehlt/unbekannt ist — sicherheitshalber wie manual
#        behandelt) gilt weiter der Gate. Feldname laut Doku-Fetch
#        "compaction_reason", der Review fand am echten Code "trigger" —
#        beide werden gelesen, falls sich der Name je unterscheidet.
set -euo pipefail

input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
[ -z "$cwd" ] && cwd="$PWD"
trigger=$(printf '%s' "$input" | jq -r '.trigger // .compaction_reason // empty' 2>/dev/null) || trigger=""

if [ "$trigger" = "auto" ]; then
  echo "precompact-handoff-gate: automatische Kompaktierung (Kontextdruck) — Gate greift nur bei manueller Kompaktierung, hier nur Warnung: kein Handoff/SESSION-STATE geprueft, kein Block." >&2
  exit 0
fi

# Override zuerst pruefen — schnell raus, kein Lockout-Risiko.
if [ -f "$HOME/.claude/.allow-compact" ] || [ "${CLAUDE_ALLOW_COMPACT:-}" = "1" ]; then
  exit 0
fi

# Nur greifen, wenn dieser Pane als Worker oder Orchestrator markiert ist.
#
# Zwei Rollenquellen, strengste Lesart (Befund 2026-08-07, gemessen: die Pane-Option
# allein durfte der Bewachte selbst loeschen, und danach griff dieses Gate gar nicht
# mehr -- ein Worker konnte ohne Uebergabe kompaktieren). Worker ist, wen EINE der
# beiden Quellen so nennt; das Register (lib/rollen.py) liegt neben diesem Hook.
role=""
HOOKDIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
  role=$(tmux display -p -t "$TMUX_PANE" '#{@wb_role}' 2>/dev/null || true)
  if [ -f "$HOOKDIR/lib/rollen.py" ]; then
    reg=$(/usr/bin/python3 "$HOOKDIR/lib/rollen.py" lesen "$TMUX_PANE" 2>/dev/null \
          | awk -F'\t' '$1=="register"{print $2}')
    if [ "$reg" = "worker" ] || { [ -z "$role" ] && [ -n "$reg" ]; }; then
      role="$reg"
    fi
  fi
fi
case "$role" in
  worker|orchestrator) : ;;
  *) exit 0 ;;
esac

# Fix 2026-07-29: der Gate hatte DEN NUTZER selbst ausgesperrt. Bei einem WORKER tippt
# `/compact` der context-guard, nie ein Mensch — dort ist der harte Block genau
# richtig, denn er erzwingt das Handoff. Im ORCHESTRATOR-Pane dagegen kommt eine
# manuelle Kompaktierung praktisch immer von ihm; ein Gate, das den Menschen
# ausbremst, ist falsch gewichtet. Deshalb ab hier: Orchestrator wird gewarnt und
# durchgelassen, Worker weiterhin geblockt.
HUMAN_ROLE=""
[ "$role" = "orchestrator" ] && HUMAN_ROLE=1

now=$(date +%s)
one_hour_ago=$((now - 3600))

fresh_file_exists() {
  local f="$1"
  [ -f "$f" ] || return 1
  local mtime
  # GNU zuerst (2026-08-04): `stat -f` ist bei BSD ein Formatschalter, bei GNU dagegen
  # "Dateisystem statt Datei". GNU scheitert deshalb nicht still, sondern druckt vorher
  # einen ganzen Dateisystem-Block; der landete hier in $mtime und ergab
  # "1785838301: integer expected". BSD kennt `-c` nicht und faellt sauber durch.
  mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) || return 1
  [ "$mtime" -ge "$one_hour_ago" ]
}

ok=0
if [ "$role" = "worker" ]; then
  # Irgendein HANDOFF-*.md im cwd, seit der letzten Stunde geaendert.
  while IFS= read -r -d '' f; do
    if fresh_file_exists "$f"; then
      ok=1
      break
    fi
  done < <(find "$cwd" -maxdepth 1 -name 'HANDOFF-*.md' -print0 2>/dev/null)
else
  # Orchestrator: SESSION-STATE.md frisch, ODER Sentinel .wb-knowledge-saved vorhanden.
  if fresh_file_exists "$cwd/SESSION-STATE.md"; then
    ok=1
  elif [ -f "$cwd/.wb-knowledge-saved" ]; then
    ok=1
  fi
fi

if [ "$ok" = "1" ]; then
  exit 0
fi

if [ -n "$HUMAN_ROLE" ]; then
  echo "precompact-handoff-gate: WARNUNG — kein frisches SESSION-STATE.md und kein .wb-knowledge-saved in $cwd. Es wird trotzdem kompaktiert (manuelle Kompaktierung im Orchestrator-Pane kommt vom Menschen und wird nie geblockt). Wissen danach zuegig sichern." >&2
  exit 0
fi

echo "precompact-handoff-gate: Kompaktierung blockiert — kein frisches HANDOFF-<name>.md in $cwd (letzte Stunde). Erst Handoff schreiben, dann kompaktieren. Override: touch ~/.claude/.allow-compact oder CLAUDE_ALLOW_COMPACT=1." >&2
exit 2
