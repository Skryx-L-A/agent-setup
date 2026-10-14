#!/bin/bash
# profil-sperre.sh -- PreToolUse fuer jedes Werkzeug (Matcher "*"): ein
# Agentenzug haelt Werkzeugliste, Bash-Muster, Hausliste gesperrter Programme,
# Kontextgrenze und Weltgrenze seines Profils ein (docs/AGENTS-PLAN.md,
# Abschnitt 3 "Die Sperre" und Abschnitt 8 Regel 5; docs/AGENTS-SPERREN.md).
#
# Die gesamte Logik liegt in lib/profil_sperre.py; dieses Skript ist der
# schmale Einstieg.
#
# NICHT REGISTRIERT: die Registrierung laeuft ueber
# profil-sperre.settings-snippet.json neben dieser Datei -- der Traeger oder
# der Orchestrator traegt den Eintrag beim Ausrollen ein.
#
# Umgebung (setzt der Traeger, siehe agents_traeger._zugumgebung):
# WB_AGENT_ZUG markiert den Agentenkontext; WB_AGENT_ID und WB_WELT binden ihn.
# Fehlen alle drei ausserhalb eines Zuges, tut das Skript nichts. Dazu kommen
# WB_AGENT_PROFIL, WB_WELT_PROJEKT, WB_AGENT_WORKTREE, WB_AGENT_TMP und aus der
# Skills-Umgebung WB_SKILL_PFADE und WB_SKILL_BIBLIOTHEK. Die Hausliste kommt
# aus wb-profil auf dem PATH (oder WB_PROFIL_BIN).
#
# Verhalten: die stdout MUSS durchgehen (Verweigerung als
# hookSpecificOutput.permissionDecision=deny-JSON); stderr geht nach
# <WB_WELT>/agents/<id>/profil-sperre.log, sonst nach /dev/null.
#
# Frist: FAIL-CLOSED wie Rollen- und Skills-Sperre. Der Kern verweigert bei
# seinem eigenen Alarm (7 s) selbst. Haengt er trotzdem, beendet diese Huelle
# nach 8 s seine Prozessgruppe samt Kindern und schreibt selbst ein deny-JSON,
# vor der 10-Sekunden-Grenze des Settings-Eintrags. Ebenso verweigert die
# Huelle, wenn der Kern fehlt oder ohne Entscheidung mit einem Fehler endet.
set -uo pipefail

HOOKS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOKS_DIR/lib/profil_sperre.py"
FRIST=8

verweigern() {
  printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Profil-Sperre: %s"}}\n' "$1"
  exit 0
}

# WB_AGENT_ZUG stammt aus der nur lesbar eingebundenen Zugbeschreibung. Der
# Agent kann die Elternumgebung, aus der der Harness den Hook startet, nicht
# entfernen. Im so markierten Zug ist eine fehlende Bindung deshalb ein Fehler.
if [ -n "${WB_AGENT_ZUG:-}" ] && { [ -z "${WB_AGENT_ID:-}" ] || [ -z "${WB_WELT:-}" ]; }; then
  verweigern "Agentenzug ohne Bindung: WB_AGENT_ID und WB_WELT muessen beide gesetzt sein."
fi

# Ohne Agentenzug greift der Hook nicht -- keine Ausgabe.
[ -n "${WB_AGENT_ID:-}" ] || [ -n "${WB_WELT:-}" ] || exit 0

[ -f "$LIB" ] || verweigern "Pruefkern lib/profil_sperre.py fehlt -- ohne Pruefung ist nichts erlaubt."
command -v python3 >/dev/null 2>&1 || verweigern "python3 fehlt -- ohne Pruefung ist nichts erlaubt."
command -v perl >/dev/null 2>&1 || verweigern "perl fehlt, der Zeitwaechter kann den Kern nicht sicher begrenzen."

log_ziel=""
if [[ "${WB_AGENT_ID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] && [ -d "${WB_WELT:-}/agents/$WB_AGENT_ID" ] \
   && [ ! -L "${WB_WELT:-}/agents/$WB_AGENT_ID" ]; then
  log_ziel="$WB_WELT/agents/$WB_AGENT_ID/profil-sperre.log"
fi

# Die Entscheidung des Kerns laeuft ueber eine Pipe in die Command-
# Substitution, nie ueber eine Datei: jede Datei im TMPDIR kann der Agent mit
# derselben UID leeren oder ersetzen, und eine leere Ausgabe hiesse "erlaubt".
# Ebenso meldet der Waechter eine abgelaufene Frist ueber seinen Exit-Status
# (FRIST_CODE), nicht ueber eine Marker-Datei.
#
# Das Log oeffnet perl ohne zu blockieren und ohne einem Symlink zu folgen;
# nur eine regulaere Datei nimmt stderr auf, sonst /dev/null. Ein FIFO als Log
# haelt den Hook damit nicht bis zur Frist des Harness auf.
#
# stdin ausdruecklich weiterreichen: ein Hintergrundjob bekaeme ohne
# Job-Steuerung sonst /dev/null, der Kern saehe kein Hook-JSON und liesse
# alles durch. Perl setzt vor exec eine eigene Prozessgruppe, damit ein
# Signal an -$pid auch einen haengenden Unterprozess der Pruefung trifft.
FRIST_CODE=124
exec 3<&0
entscheidung="$(
  perl -e '
    use Fcntl;
    my $log = shift;
    if ($log ne "" && sysopen(my $fh, $log, O_WRONLY | O_APPEND | O_CREAT | O_NONBLOCK | O_NOFOLLOW, 0666)) {
      open(STDERR, ">&", $fh) if -f $fh;
      close($fh);
    }
    setpgrp(0, 0) or die "setpgrp: $!";
    exec @ARGV' "$log_ziel" python3 "$LIB" <&3 2>/dev/null &
  pid=$!
  exec 3<&-

  # Der Waechter haengt nicht an der Pipe (sonst wartete die Substitution auf
  # sein Ende) und nimmt sein eigenes sleep mit, wenn er gehen soll. Hat er
  # einmal zugeschlagen, ignoriert er TERM und endet mit FRIST_CODE.
  (
    sleep "$FRIST" & schlaf=$!
    trap 'kill "$schlaf" 2>/dev/null; exit 0' TERM
    wait "$schlaf"
    kill -0 "$pid" 2>/dev/null || exit 0
    trap '' TERM
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 0.2
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    exit "$FRIST_CODE"
  ) </dev/null >/dev/null 2>&1 &
  waechter=$!

  wait "$pid" 2>/dev/null
  status=$?
  # Ein zurueckgebliebenes Kind der Pruefung hielte die Pipe offen und den
  # Hook ohne Frist fest; es geht mit der Prozessgruppe.
  kill -KILL -- "-$pid" 2>/dev/null
  kill -TERM "$waechter" 2>/dev/null
  wait "$waechter" 2>/dev/null
  [ $? -eq "$FRIST_CODE" ] && exit "$FRIST_CODE"
  exit "$status"
)"
status=$?
exec 3<&-

if [ "$status" -eq "$FRIST_CODE" ]; then
  verweigern "Pruefung hat ihre Frist ueberschritten; ihre Prozessgruppe wurde beendet, der Zugriff bleibt gesperrt."
fi
if [ "$status" -ne 0 ] && [ -z "$entscheidung" ]; then
  verweigern "Pruefkern endete mit Status $status ohne Entscheidung -- ohne Pruefung ist nichts erlaubt."
fi
[ -z "$entscheidung" ] || printf '%s\n' "$entscheidung"
exit 0
