#!/bin/bash
# reviewer-sperre.sh -- PreToolUse/Write|Edit|NotebookEdit, /Bash und
# /Skill: haelt die Werkzeug- und Bash-Muster-Sperre einer Rolle (nicht nur
# des Reviewers) mechanisch nach, weil Worker mit uebersprungenen
# Berechtigungen laufen und dort nur Verweigerungen und Hooks greifen.
#
# Event: PreToolUse, drei Matcher (Write|Edit|NotebookEdit, Bash, Skill),
# derselbe Aufruf. Die gesamte Logik liegt in lib/reviewer_sperre.py;
# dieses Skript ist der schmale Einstieg. Siehe docs/AGENTS-PLAN.md,
# Abschnitt 4 "Rollen im Team", Absatz "Wie die Sperre haelt".
#
# NICHT REGISTRIERT: die Registrierung laeuft ueber
# reviewer-sperre.settings-snippet.json neben dieser Datei -- der
# Orchestrator traegt die Eintraege beim Ausrollen in die lebende
# ~/.claude/settings.json ein.
#
# Umgebung: WB_AUFGABE_ID (ohne gueltige Aufgabe keine Ausgabe), WB_ROLLE
# (fehlt sie, tut das Skript nichts -- keine Rolle, keine Sperre),
# WB_AUFGABE_BASE (Basis fuer wb-profil --base, sonst
# $HOME), WB_AUFGABE_PROJEKT (optional, fuer projektueberlagerte Rollen),
# WB_ERGEBNISPFAD (Ergebnispfad-Fallback fuer Rollen mit Schreibsperre,
# wenn das Auftragsbuch auftraege.tsv nichts liefert).
#
# Verhalten: die stdout MUSS durchgehen (Verweigerung als
# hookSpecificOutput.permissionDecision=deny-JSON); nur stderr geht in
# eine Logdatei: <base>/.local/state/wb-reviewer-sperre/<rolle>.log.
#
# Frist: diese Sandbox ist FAIL-CLOSED. Der Kern verweigert bei seinem
# eigenen Alarm (7 s) selbst. Haengt er trotzdem, beendet diese Huelle nach
# 8 s seine Prozessgruppe samt Kindern und schreibt selbst ein deny-JSON --
# beides vor der 10-Sekunden-Grenze des Settings-Eintrags, nach der Claude
# Code das Werkzeug sonst ohne Entscheidung laufen liesse. Ebenso verweigert
# die Huelle, wenn der Kern fehlt oder mit einem Fehler endet. Ergebnis-Beleg
# und Testschutz bleiben absichtlich fail-open, siehe hooks/README.md.
set -uo pipefail

HOOKS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOKS_DIR/lib/reviewer_sperre.py"
FRIST=8

verweigern() {
  printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Rollen-Sperre: %s"}}\n' "$1"
  exit 0
}

# Ohne Werkbank-Aufgabe und ohne Rolle greift der Hook nicht -- keine Ausgabe.
[[ "${WB_AUFGABE_ID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || exit 0
[[ "${WB_AUFGABE_ID}" == *..* ]] && exit 0
[ -n "${WB_ROLLE:-}" ] || exit 0

[ -f "$LIB" ] || verweigern "Pruefkern lib/reviewer_sperre.py fehlt -- ohne Pruefung ist nichts erlaubt."
command -v python3 >/dev/null 2>&1 || verweigern "python3 fehlt -- ohne Pruefung ist nichts erlaubt."
command -v perl >/dev/null 2>&1 || verweigern "perl fehlt, der Zeitwaechter kann den Kern nicht sicher begrenzen."

log_ziel=""
if [[ "$WB_ROLLE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  base="${WB_AUFGABE_BASE:-}"
  [ -z "$base" ] && base="$HOME"
  logdir="$base/.local/state/wb-reviewer-sperre"
  if mkdir -p "$logdir" 2>/dev/null; then
    log_ziel="$logdir/$WB_ROLLE.log"
  fi
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
