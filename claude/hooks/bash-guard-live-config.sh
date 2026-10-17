#!/bin/bash
# Zweck: WARNT (blockt NICHT) vor Test-artigen Schreibzugriffen auf die echte
#        Workbench-Settings-Datei (~/.claude/workbench/settings.json) oder vor
#        Eingaben/Kommandos gegen eine LIVE-tmux-Session, wenn der Aufruf nach
#        einem Test aussieht, aber keine Test-Isolation (HOME=$(mktemp -d),
#        -L wbtest) erkennbar ist.
# Event: PreToolUse, matcher Bash + Write + Edit.
# Warum: ECHTER Vorfall — ein Worker hat `workerLayout` zum Testen auf
#        "window" und zurueckgeschaltet, dabei wanderten vier laufende Worker
#        des Nutzers in ein tmux-Fenster ohne Client — fuer ihn sahen sie aus,
#        als liefen keine Worker. CLAUDE.md: "Tests fassen nie die Live-
#        Umgebung an und nie das Fenster des Nutzers."
# Policy: bewusst NUR warnen (nie deny) — die Heuristik "sieht nach Test aus"
#        ist unscharf (Pfad-/Kommando-Substring-Suche), ein falscher Block
#        waere schlimmer als eine verpasste Warnung (siehe Auftrag). Wer die
#        Warnung sieht und weiss, dass es kein Test ist, ignoriert sie einfach
#        — es gibt keinen Override-Mechanismus noetig, weil nichts blockiert.
set -euo pipefail

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || true
[ -z "$tool_name" ] && exit 0

REAL_LIVE_SETTINGS="$HOME/.claude/workbench/settings.json"

looks_like_test_context() {
  # Testmarker im cwd (grobe Heuristik, bewusst konservativ).
  echo "$cwd" | grep -Eqi '(^|/)tests?(/|$)|test' 2>/dev/null
}

warn() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: $reason,
      additionalContext: $reason
    },
    systemMessage: $reason
  }'
  exit 0
}

# Ablehnen kann dieser Hook seit 2026-08-07 auch — fuer genau eine Sache, siehe
# unten. Ohne jq geschrieben, damit ein fehlendes jq einen Deny nicht stumm
# schaltet (dieselbe Lehre wie bei bash-guard-secrets, 2026-07-28).
deny() {
  /usr/bin/python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse", "permissionDecision": "deny",
    "permissionDecisionReason": sys.argv[1]}}))
' "$1"
  exit 0
}

# Die Ablagen, die kein Agent anfassen darf — dieselbe Liste wie im Guard
# `freigabe-pfad` in bash-guard.py, hier fuer den Weg ueber die Datei-Werkzeuge.
# BEFUND (Durchsicht 2026-08-07, gemessen): eine selbst geschriebene Freigabe in
# ~/.pi-workers/guard-grants/ liess einen angehaltenen `sudo`-Befehl durchlaufen.
# Der Bash-Weg dorthin ist gesperrt; ohne diese Zeilen bliebe Write/Edit offen,
# und eine Sperre mit einer offenen Tuer daneben ist keine.
GESCHUETZT=(
  "${AWB_GUARD_GRANTS_DIR:-$HOME/.pi-workers/guard-grants}"
  "$HOME/.pi-workers/.freigabe-schluessel"
  "${AWB_ROLLEN_DIR:-$HOME/.pi-workers/rollen}"
  "${XDG_CONFIG_HOME:-$HOME/.config}/agent-workbench/skript-ausnahmen.conf"
)
pfad_geschuetzt() {   # <datei>
  local ziel="$1" p
  for p in "${GESCHUETZT[@]}"; do
    case "$ziel" in
      "$p"|"$p"/*) return 0 ;;
    esac
  done
  return 1
}

# Das Geraeteregister der Mobil-App (2026-10-14, Auftrag wz-mobilguard), wie
# `mobil-pfad` in bash-guard.py. Der Kern liest auth-state.json bei jeder
# Pruefung von Platte; ein dort eingetragenes Geraet spricht fuer den Menschen.
# Verglichen wird das aufgeloeste Ziel (Symlinks, APFS-Schreibweise) in
# Kleinschrift, damit ~/.claude/Workbench/MOBILE oder ein Link dorthin nicht
# vorbeigeht.
MOBIL_HINWEIS="Das Geraeteregister der Mobil-App (~/.claude/workbench/mobile/) fuehrt allein der Kern der Werkbank; ein Telefon koppelt ein Mensch am Mac (Kopplung mit Code). Ein selbst eingetragenes Geraet spraeche fuer den Menschen, deshalb liest und schreibt ein Agent dort nichts. Blockiert von mobil-pfad"
# Forkarm gebaut (gemessen 14.10.: mit tr/sed/basename je Aufruf 55 ms statt
# 19 ms je Write): Vergleich ohne Gross/Klein ueber nocasematch, Pfadzerlegung
# mit Parameterexpansion; aufgeloest (ein Fork) nur bei Symlink oder "..".
MOBIL="$HOME/.claude/workbench/mobile"
aufgeloest() {   # <pfad>: Symlinks des laengsten vorhandenen Anfangs aufgeloest
  local p="$1" rest=""
  case "$p" in /*) ;; *) p="${cwd:-$PWD}/$p" ;; esac
  if [ -e "$p" ] && realpath "$p" 2>/dev/null; then return 0; fi
  while [ ! -d "$p" ] && [ -n "$p" ] && [ "$p" != / ]; do
    rest="/${p##*/}$rest"
    p="${p%/*}"
  done
  [ -n "$p" ] || p=/
  printf '%s%s' "$(cd "$p" 2>/dev/null && pwd -P || printf '%s' "$p")" "$rest"
}
hat_symlink() {   # <pfad>: liegt auf dem Weg ein Symlink? Nur Builtins, kein Fork.
  local p="$1"
  while [ -n "$p" ] && [ "$p" != / ]; do
    [ -L "$p" ] && return 0
    p="${p%/*}"
  done
  return 1
}
mobil_geschuetzt() {   # <datei>
  local ziel="$1" m rc=1 real="$MOBIL"
  case "$ziel" in /*) ;; *) ziel="${cwd:-$PWD}/$ziel" ;; esac
  # Muster ueber Variablen: Bash 3.2 laesst sonst den Rueckstrich im Ersatz stehen.
  local zz='//' pp='/./'
  while [[ "$ziel" == *//* ]]; do ziel="${ziel//$zz//}"; done
  while [[ "$ziel" == */./* ]]; do ziel="${ziel//$pp//}"; done
  # Der Normalfall (kein Symlink, kein ..) kommt ohne Fork aus.
  if [[ "$ziel" == */../* || "$ziel" == */.. ]] || hat_symlink "$ziel"; then
    ziel=$(aufgeloest "$ziel")
  fi
  if hat_symlink "$MOBIL"; then
    real=$(aufgeloest "$MOBIL")
  fi
  shopt -s nocasematch
  for m in "$MOBIL" "$real"; do
    case "$ziel" in
      "$m"|"$m"/*) rc=0 ;;
    esac
  done
  shopt -u nocasematch
  return $rc
}

case "$tool_name" in
  Read|Grep|Glob|NotebookRead)
    # Nur wirksam, wenn der Matcher diese Werkzeuge einschliesst (lebende
    # Einstellungen; bisher Write|Edit). Lesen: Zaehler, Nonces, Journal.
    if [ "$tool_name" = Glob ]; then
      # Bei Glob ist das Muster selbst ein Pfad (`~/.claude/workbench/mobile/*`).
      muster=$(printf '%s' "$input" | jq -r '.tool_input.pattern // empty' 2>/dev/null) || muster=""
      shopt -s nocasematch
      case "$muster" in
        *workbench/mobile*) deny "$MOBIL_HINWEIS ($tool_name mit Muster $muster)." ;;
      esac
      shopt -u nocasematch
    fi
    file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // empty' 2>/dev/null) || exit 0
    [ -z "$file_path" ] && exit 0
    case "$file_path" in "~"|"~/"*) file_path="$HOME${file_path#\~}" ;; esac
    if mobil_geschuetzt "$file_path"; then
      deny "$MOBIL_HINWEIS ($tool_name auf $file_path)."
    fi
    # Der Freigabe-Schluessel signiert seit 14.10. auch die Geraeteliste;
    # lesend gesperrt wie im Bash-Zweig von freigabe-pfad.
    if pfad_geschuetzt "$file_path"; then
      deny "Der Pfad liegt in einer geschuetzten Ablage ($file_path); ein Agent liest dort nichts. Blockiert von freigabe-pfad ($tool_name)."
    fi
    # Grep/Glob ueber ~/.claude/workbench steigen ins Register hinab.
    if [ "$tool_name" = Grep ] || [ "$tool_name" = Glob ]; then
      if mobil_geschuetzt "${file_path%/}/mobile"; then
        deny "$MOBIL_HINWEIS ($tool_name ueber den Elternordner $file_path)."
      fi
    fi
    ;;
  Write|Edit|MultiEdit|NotebookEdit)
    file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null) || exit 0
    [ -z "$file_path" ] && exit 0
    case "$file_path" in "~"|"~/"*) file_path="$HOME${file_path#\~}" ;; esac
    if mobil_geschuetzt "$file_path"; then
      deny "$MOBIL_HINWEIS ($tool_name auf $file_path)."
    fi
    if pfad_geschuetzt "$file_path"; then
      deny "Der Pfad liegt in einer geschuetzten Ablage ($file_path). Freigaben erteilt ein Mensch — im Programmfenster oder mit \`wb-freigabe erteilen <pane> <grund>\`; das Rollenregister fuehrt \`wb-rolle\`. Beide messen die Herkunft, statt sie zu glauben. Blockiert von freigabe-pfad (Write/Edit)."
    fi
    if [ "$file_path" = "$REAL_LIVE_SETTINGS" ]; then
      if looks_like_test_context; then
        warn "WARNUNG bash-guard-live-config: Schreibzugriff auf die ECHTE Workbench-Settings ($REAL_LIVE_SETTINGS) aus einem nach-Test-aussehenden Kontext (cwd enthaelt 'test'), aber kein Hinweis auf HOME=\$(mktemp -d)-Isolation erkennbar. Falls das ein Test ist: HOME umleiten statt der echten Datei. Falls kein Test: ignorieren."
      fi
    fi
    ;;
  Bash)
    command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
    [ -z "$command" ] && exit 0
    # tmux send-keys/attach gegen eine Session mit dem Live-Praefix "wb-",
    # ohne eigenen Test-Socket (-L wbtest / TMUX_TMPDIR).
    if echo "$command" | grep -Eq 'tmux[[:space:]]+.*(send-keys|attach)' \
       && echo "$command" | grep -Eqi '=?wb-' \
       && ! echo "$command" | grep -Eqi 'wbtest|-L[[:space:]]+wbtest|TMUX_TMPDIR'; then
      if looks_like_test_context || echo "$command" | grep -Eqi 'test'; then
        warn "WARNUNG bash-guard-live-config: tmux-Kommando gegen eine Session mit Live-Praefix 'wb-' aus einem nach-Test-aussehenden Kontext, aber kein eigener Test-Socket (-L wbtest) und kein HOME-Redirect erkennbar. Falls das ein Test ist: eigenen Socket verwenden (tmux -L wbtest ...). Falls kein Test: ignorieren."
      fi
    fi
    # Direkter Schreibversuch auf die echte Settings-Datei via Bash (z.B. cat >, echo >, cp).
    if echo "$command" | grep -F -- "$REAL_LIVE_SETTINGS" >/dev/null 2>&1 \
       && echo "$command" | grep -Eq '(>|>>|cp[[:space:]]+.*[[:space:]]|mv[[:space:]]+.*[[:space:]])' \
       && ! echo "$command" | grep -Eqi 'HOME=|mktemp'; then
      if looks_like_test_context || echo "$command" | grep -Eqi 'test'; then
        warn "WARNUNG bash-guard-live-config: Bash-Kommando schreibt moeglicherweise direkt auf die ECHTE Workbench-Settings ($REAL_LIVE_SETTINGS) aus einem nach-Test-aussehenden Kontext, ohne erkennbares HOME=\$(mktemp -d). Falls das ein Test ist: HOME umleiten. Falls kein Test: ignorieren."
      fi
    fi
    ;;
esac

exit 0
