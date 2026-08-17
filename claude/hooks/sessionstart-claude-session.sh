#!/bin/bash
# Zweck: schreibt bei jedem Session-Start die LEBENDE Unterhaltungs-Kennung in
#        die Zustandsdatei der Workbench-Sitzung, in der dieser Pane sitzt.
# Event: SessionStart (alle Quellen: startup, resume, clear, compact, fork).
#
# WARUM (Absturz vom 10.08., nachgemessen am 11.08.):
#   `wb-code` merkt sich die Unterhaltung genau zweimal -- beim Anlegen der
#   Sitzung (ueber den Beobachter `record_conversation`) und bei einem
#   ausdruecklichen `--resume`. Danach nie wieder. Jedes `/clear` in einem
#   laufenden Pane beginnt aber eine NEUE Unterhaltung, von der die
#   Zustandsdatei nichts erfaehrt. Am 10.08. stand deshalb in der Zustandsdatei
#   einer Sitzung noch die Unterhaltung 6e1c68fd vom 09.08., waehrend im Pane
#   laengst 0c65dfdd lief; nach der Kernel-Panik hat die Wiederherstellung die alte,
#   82 MB grosse Unterhaltung fortgesetzt und blieb an Claudes Rueckfrage
#   „Resume from summary or full session" stehen (die beiden Grenzen dafuer
#   stehen gemessen in app/src/main/revive.ts).
#
#   SessionStart ist die einzige Stelle, die JEDE dieser Unterhaltungen sieht --
#   auch die, die kein Werkzeug des Hauses gestartet hat. Deshalb hier und nicht
#   in `wb-code`.
#
# Nicht-blockierend: SessionStart kann laut Doku ohnehin nicht blockieren; dieser
#        Haken schreibt nur ein Feld und endet immer mit 0.
# Aufraeumen: nichts. Er legt keine Datei an -- gibt es keine Zustandsdatei fuer
#        diesen Pane, tut er gar nichts (siehe „NIE NEU ANLEGEN" unten).
#
# AUSROLLREIHENFOLGE, falls diese Datei auf einer Maschine neu eingerichtet wird:
#        erst `shell/wb-state` nach ~/.local/bin (eine aeltere installierte
#        Fassung kennt `by-tmux` noch nicht), dann diese Datei nach
#        ~/.claude/hooks/, dann der Eintrag unter `hooks.SessionStart` in
#        settings.json mit `"timeout": 5`. Anders herum laeuft der Haken ins
#        Leere, ohne es zu sagen.
set -uo pipefail

input=$(cat)

# --- Was NICHT diese Sitzung ist: der Druckmodus ------------------------------
# Jedes `claude -p` aus dem Orchestrator-Pane loest ebenfalls SessionStart aus,
# mit einer frischen Kennung. `shell/wb-dod:173` ist der gemessene Fall: der
# Orchestrator beurteilt dort ein Worker-Ergebnis mit
# `claude -p --model claude-haiku-4-5`, der Kindprozess erbt TMUX_PANE, die Rolle
# des Panes ist `orchestrator` -- und ohne diese Schranke stuende danach die
# Kennung einer zweizeiligen Haiku-Unterhaltung in der Zustandsdatei. Weil ihr
# Transcript im selben Projektordner liegt, liefe `--resume` sogar durch und
# stellte lautlos das Falsche wieder her. Der Haken machte diesen Fall also
# SCHLECHTER als die veraltete Kennung, die er ersetzt.
#
# WORAN ES SICH ERKENNEN LAESST, gemessen am 11.08. gegen claude 2.1.226, beide
# Faelle mit gesaeuberter Elternumgebung (`env -u CLAUDE_CODE_*`), abgegriffen im
# SessionStart-Haken selbst:
#
#   interaktiv (echter Orchestrator)   ENTRYPOINT=cli      CHILD_SESSION=1
#   claude -p (Druckmodus)             ENTRYPOINT=sdk-cli  CHILD_SESSION=1
#
# `CLAUDE_CODE_CHILD_SESSION` steht in BEIDEN Faellen und taugt deshalb nicht --
# eine Schranke darauf haette auch die interaktive Sitzung gesperrt, also genau
# die, der dieser Haken dienen soll. Uebrig bleibt `CLAUDE_CODE_ENTRYPOINT`.
#
# Gefragt wird nach dem ERLAUBTEN Wert und nicht nach dem verbotenen: ein
# kuenftiger Einstiegspunkt, den heute niemand kennt, schreibt dann von selbst
# nichts, statt stillschweigend mitzuschreiben. Der Preis ist benannt: eine CLI,
# die die Variable gar nicht setzt, laesst den Haken untaetig -- das ist der
# Zustand von vor dem Haken und damit die harmlose Richtung.
[ "${CLAUDE_CODE_ENTRYPOINT:-}" = "cli" ] || exit 0

# --- Wer darf hier ueberhaupt schreiben? -------------------------------------
# NUR DER ORCHESTRATOR-PANE. Die Kennung, um die es geht, ist das Feld
# `claudeSessionId` der SITZUNG; die Unterhaltungen der Worker stehen an anderer
# Stelle (`workers[].claudeSessionId`, geschrieben von `wb-state add-worker`).
# Ein Worker, der seine eigene Kennung in das Sitzungsfeld schriebe, wuerde den
# Fortsetzen-Knopf auf seinen Chat zeigen lassen -- der Fehler waere schlimmer
# als der, den dieser Haken behebt.
[ -n "${TMUX_PANE:-}" ] || exit 0

tmux_bin() {
  # Ein Prozess, der nicht aus einer Login-Shell stammt, hat den Ordner des
  # Paketverwalters nicht im PATH -- dieselbe Vorsicht wie in
  # app/src/main/pfad.ts. Eine feste Liste solcher Ordner steht hier bewusst
  # NICHT: `hooks/` geht mit ins Paket, wenn die Werkbank weitergegeben wird,
  # und muss deshalb frei von maschinenspezifischen Pfaden bleiben (Zusage 19
  # in hooks/tests/test-hooks.sh).
  #
  # Stattdessen wird der Server gefragt, in dem dieser Pane sitzt: `$TMUX`
  # traegt Socket, PID des Servers und Sitzungsnummer, durch Kommas getrennt.
  # Ueber die PID nennt `lsof` den vollen Pfad genau der tmux-Binaerdatei, die
  # diesen Pane wirklich haelt -- richtiger als jede geratene Liste, und ohne
  # einen Pfad zu behaupten, den es auf einer fremden Maschine nicht gibt.
  # `ps -o comm=` taugt dafuer NICHT: es druckt argv[0], und ein Server, der
  # als `tmux` gestartet wurde, meldet dann `tmux` ohne Verzeichnis (gemessen
  # 11.08.). `lsof` liegt in /usr/sbin und ist damit auch unter dem nackten
  # PATH eines launchd-Laufs erreichbar.
  local p pid
  p="$(command -v tmux 2>/dev/null)" && { printf '%s' "$p"; return 0; }
  pid="${TMUX%,*}"; pid="${pid##*,}"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  p="$(/usr/sbin/lsof -p "$pid" -a -d txt -Fn 2>/dev/null | grep -m1 '^n/' | cut -c2-)"
  [ -n "$p" ] && [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  return 1
}
TMUX_BIN="$(tmux_bin)" || exit 0

# Die Kodierung reist mit dem Aufruf (Befund 07.08.): ohne UTF-8-Zeichenklasse
# gibt tmux in `-F`/`-p`-Formaten Zeichen aus, mit denen niemand gerechnet hat.
tm() { LC_ALL=C.UTF-8 LC_CTYPE=UTF-8 "$TMUX_BIN" "$@"; }

rolle=""
if [ -x "$HOME/.local/bin/wb-rolle" ]; then
  # Die EINE Stelle, die Rollen liest -- sie kennt beide Quellen (Pane-Option
  # und Register) und sagt in der Zeile `effektiv`, was wirklich gilt.
  rolle=$("$HOME/.local/bin/wb-rolle" lesen "$TMUX_PANE" 2>/dev/null \
            | awk -F'\t' '$1=="effektiv"{print $2}')
fi
# Fehlt das Werkzeug (Maschine noch nicht abgeglichen), bleibt die Pane-Option --
# derselbe Rueckfall, den `wb-code` beim Setzen der Rolle schon fuehrt.
[ -n "$rolle" ] || rolle=$(tm display-message -p -t "$TMUX_PANE" '#{@wb_role}' 2>/dev/null)
[ "$rolle" = "orchestrator" ] || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$session_id" ] || exit 0

# --- Welche Zustandsdatei ist die richtige? ----------------------------------
# Der tmux-Sessionname, NICHT das Arbeitsverzeichnis. In einem Ordner koennen
# mehrere Workbench-Sitzungen liegen (SPEC-V2 B: die Zustandsdatei eines Ordners
# neben derselben Datei mit angehaengtem Sitzungsschluessel, `…__<schluessel>.json`),
# und ein Pane weiss selbst nicht, welche davon
# er ist. `wb-state by-tmux` beantwortet genau das und gibt Ordner UND
# sessionKey zurueck -- dasselbe Paar, mit dem `wb-code` seine Datei anspricht.
#
# UND ZWAR DER BASISNAME. `#{session_name}` ist INSTABIL, sobald das Fenster in
# einer Sessiongruppe haengt -- und genau das tut es, sobald der Worker-Tab
# offen ist: '<sess>' und '<sess>-view' teilen sich dieselben Fenster, und
# derselbe Pane meldet je nach Aufrufzeitpunkt mal das eine, mal das andere
# (gemessen 2026-08-04 in Produktion, 2026-08-06 und 2026-08-11 auf eigenem
# Socket, dort fuenfmal von fuenf die '-view'-Schwester). `#{session_group}` ist
# dagegen fuer BEIDE Mitglieder der Name der Basis und leer, solange nie eine
# '-view' entstand -- dann ist die Session trivial ihre eigene Basis. Uebernommen
# aus `base_session_name()` in shell/context-guard und shell/pi-worker, die
# dieselbe Messung mit derselben Begruendung tragen, statt hier neu erfunden.
#
# ES HAENGT ZWEIERLEI DARAN, nicht nur das Finden: `wb-state touch` setzt
# `tmuxSession` bedingungslos (shell/wb-state:291). Wer nur die Suche auf die
# Basis umstellt und weiter den '-view'-Namen an `touch` gibt, schreibt den
# Sitzungsnamen in der Zustandsdatei um -- die App findet die LEBENDE Sitzung
# danach nicht mehr in ihrer tmux-Liste, fuehrt sie als beendet und meldet sie
# ueber die Lebensspur als verloren. Deshalb geht unten derselbe `$sess` an
# beide Aufrufe.
base_session_name() {   # <pane-id> -> Basis-Sessionname (Gruppenname, sonst der eigene)
  local pane="$1" name grp
  name=$(tm display-message -p -t "$pane" '#{session_name}' 2>/dev/null)
  grp=$(tm display-message -p -t "$pane" '#{session_group}' 2>/dev/null)
  printf '%s' "${grp:-$name}"
}
sess=$(base_session_name "$TMUX_PANE")
[ -n "$sess" ] || exit 0
[ -x "$HOME/.local/bin/wb-state" ] || exit 0

zuordnung=$("$HOME/.local/bin/wb-state" by-tmux "$sess" 2>/dev/null)
# NIE NEU ANLEGEN: Ohne Zuordnung gehoert dieser Pane zu keiner Sitzung der
# Workbench (eine von Hand gestartete tmux-Session etwa). `wb-state touch` wuerde
# eine Zustandsdatei erfinden, und die stuende danach als beendete Sitzung in der
# linken Spalte.
[ -n "$zuordnung" ] || exit 0
dir="${zuordnung%%|*}"
key="${zuordnung#*|}"
[ -n "$dir" ] || exit 0

if [ -n "$key" ]; then
  "$HOME/.local/bin/wb-state" touch "$dir" "$sess" --key "$key" --claude-session "$session_id" >/dev/null 2>&1
else
  "$HOME/.local/bin/wb-state" touch "$dir" "$sess" --claude-session "$session_id" >/dev/null 2>&1
fi

exit 0
