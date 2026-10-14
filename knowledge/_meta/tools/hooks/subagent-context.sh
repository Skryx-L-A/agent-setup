#!/usr/bin/env bash
# SubagentStart hook: spielt KERN-Anfang und geltende Fallen des Projekts in native Subagenten ein.
# Ereignis, Felder und Ausgabeformat: Claude-Code-Doku Hooks, Abschnitt SubagentStart.
# Muss nie fehlschlagen: immer Exit 0, bei jedem Fehler ohne Ausgabe. Logik in subagent_context.py.

here="$(cd "$(dirname "$0")" && pwd)"
command -v python3 >/dev/null 2>&1 || exit 0
# Gast-Sitzung wie in session-context.sh: WB_PERSON oder die tmux-Option @wb_person (faengt Worker-Panes
# und Sitzungen, deren Umgebung ein spaeter angehaengter Client ueberschrieben hat).
if [ -z "${WB_PERSON:-}" ] && [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
  WB_PERSON="$(tmux display-message -p -t "$TMUX_PANE" '#{@wb_person}' 2>/dev/null)"
  export WB_PERSON
fi
python3 "$here/subagent_context.py" 2>/dev/null || true
exit 0
