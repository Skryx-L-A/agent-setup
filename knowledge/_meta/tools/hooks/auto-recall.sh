#!/bin/sh
# UserPromptSubmit hook: semantic recall from the Knowledge vault via `brain search`.
# Contract: NEVER blocks the prompt. Any error, timeout, or empty result -> silent exit 0.

BRAIN_BIN="$HOME/Knowledge/_meta/tools/braincli/.venv/bin/brain"
TIMEOUT_SECONDS="1.5"
K="4"
# gemessen 2026-07-29 ueber die 37 Eval-Fragen (hook_gates in BASELINE.json):
# 0.35 -> Praezision 36,2 %, Trefferquote 91,9 %
# 0.40 -> Praezision 40,5 %, Trefferquote 86,5 %  <- gewaehlt
# 0.45 -> Praezision 46,7 %, Trefferquote 75,7 %  (zu viel Verlust)
SCORE_THRESHOLD="0.40"
# Wie weit ein Treffer hinter dem besten zurueckliegen darf (cosine).
RELATIVE_MARGIN="0.08"
MAX_HITS="3"
SNIPPET_CHARS="150"
# Abschlag fuer eine Notiz aus einem anderen Projekt als dem der Sitzung, und
# die Mindestmenge eigener Prosa, die eine Seite tragen muss, um eingespielt zu
# werden. Beide Werte sind gemessen am 10.08.2026 ueber die 37 Eval-Fragen:
# 0.03 raeumt den belegten Vorfall ab (eine Workbench-Sitzungsnotiz mit 0,42 im
# Spieleprojekt) und kostet im Normalfall - Sitzung sitzt im Projekt der Frage -
# nichts; 0.06 und 0.10 kosten zusaetzlich Trefferquote, ohne mehr zu raeumen.
# 120 Zeichen liegen mitten in einer Plateau-Zone: von 100 bis 185 verwirft der
# Filter dieselben vier Seiten, und keine davon ist Ziel einer Eval-Frage.
PROJECT_PENALTY="0.03"
PROSE_MIN="120"
# Umgang mit abgeloesten Aussagen (2026-08-11): suppress haelt eine Notiz
# zurueck, deren Aussagen alle abgeloest sind, und markiert die teilweise
# abgeloeste; mark haelt nichts zurueck; off schaltet beides ab. Begruendung
# steht im Kopf von auto-recall-format.py.
RECALL_VALIDITY="suppress"
VAULT_DIR="$HOME/Knowledge"

[ -x "$BRAIN_BIN" ] || exit 0
# Portable timeout: gtimeout on macOS (coreutils), timeout on Linux.
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN=gtimeout
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN=timeout
else exit 0
fi
command -v python3 >/dev/null 2>&1 || exit 0

input="$(cat)"
prompt="$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    p = data.get("prompt", "")
    if isinstance(p, str):
        sys.stdout.write(p)
except Exception:
    pass
' 2>/dev/null)"

# Das Arbeitsverzeichnis der Sitzung steht im selben JSON und ist die einzige
# Auskunft darueber, in welchem Projekt der Hook gerade feuert. Ohne sie spielte
# er in einem Spieleprojekt Notizen zu fremden Projekten ein (belegt 19.07.2026).
# Faellt das Feld weg, bleiben die Filter aus und der Hook laeuft wie vorher.
session_cwd="$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    c = data.get("cwd", "")
    if isinstance(c, str):
        sys.stdout.write(c)
except Exception:
    pass
' 2>/dev/null)"
[ -n "$session_cwd" ] || session_cwd="$PWD"

[ -n "$prompt" ] || exit 0

result="$("$TIMEOUT_BIN" "$TIMEOUT_SECONDS" "$BRAIN_BIN" search "$prompt" -k "$K" --json 2>/dev/null)"
[ -n "$result" ] || exit 0

printf '%s' "$result" | WB_THRESHOLD="$SCORE_THRESHOLD" WB_RELATIVE_MARGIN="$RELATIVE_MARGIN" WB_MAX_HITS="$MAX_HITS" WB_SNIPPET_CHARS="$SNIPPET_CHARS" WB_CWD="$session_cwd" WB_PROMPT="$prompt" WB_VAULT="$VAULT_DIR" WB_PROJECT_PENALTY="$PROJECT_PENALTY" WB_PROSE_MIN="$PROSE_MIN" WB_RECALL_VALIDITY="$RECALL_VALIDITY" python3 "$(dirname "$0")/auto-recall-format.py" 2>/dev/null

exit 0
