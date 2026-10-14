#!/bin/sh
# UserPromptSubmit hook: semantic recall from the Knowledge vault via `brain search`.
# Contract: NEVER blocks the prompt. Any error, timeout, or empty result -> silent exit 0.

# WB_BRAIN_BIN overrides the binary (measure_recall.py uses it to point at a
# worktree checkout's own code instead of the installed main-vault brain);
# unset in normal operation, so production behavior is unchanged.
BRAIN_BIN="${WB_BRAIN_BIN:-$HOME/Knowledge/_meta/tools/braincli/.venv/bin/brain}"
# 2,0 s statt 1,5 s (2026-09-23): auf peer lag eine warme Suche knapp ueber 1,5 s.
TIMEOUT_SECONDS="2.0"
# Messhebel fuer die Frist (2026-09-28, b6-zugang): BRAIN_RECALL_FRIST, z.B. 0.1 im Test, der
# pruefen soll, dass `brain doctor` eine Frist-Leerquote meldet. Nur Zahlen, sonst ignoriert.
case "${BRAIN_RECALL_FRIST:-}" in ''|*[!0-9.]*|*.*.*) ;; *) TIMEOUT_SECONDS="$BRAIN_RECALL_FRIST" ;; esac
K="4"
# gemessen 2026-07-29 ueber die 37 Eval-Fragen (hook_gates in BASELINE.json):
# 0.35 -> Praezision 36,2 %, Trefferquote 91,9 %
# 0.40 -> Praezision 40,5 %, Trefferquote 86,5 %  (gewaehlt bis 2026-09-23)
# 0.45 -> Praezision 46,7 %, Trefferquote 75,7 %  (zu viel Verlust)
# Neu gemessen 2026-09-23 (Relevanztor i5, Goldset 48 Prompts/189 Paare, Pruefhaelfte getrennt,
# eval/relevanztor/BEFUNDE.md): 0.44 + Marge 0.10 -> Rauschen -31 je 100 Prompts [95 %: -59; -6],
# Treffer -9 [-19; 0], Praezision 0,51 -> 0,58; Replay (6.720 Eingaben) Rauschen 24,3 -> 21,0,
# Vorwarnquote unveraendert 0,70. Ein Logprob-Entscheider auf peer schlug das nicht.
SCORE_THRESHOLD="0.44"
# Wie weit ein Treffer hinter dem besten zurueckliegen darf (cosine).
RELATIVE_MARGIN="0.10"
# Messhebel (2026-09-23, Relevanztor i5): beide Werte lassen sich ueber die Umgebung
# ueberschreiben, damit Replay und Goldset andere Werte gegen den echten Hook messen.
# Ohne Variable gilt das Obige; ein nicht-numerischer Wert wird ignoriert.
# Seit 2026-09-24 gelten sie fuer das Modell, das die Suche tatsaechlich benutzt hat.
THRESHOLD_OVERRIDE=""
MARGIN_OVERRIDE=""
case "${BRAIN_RECALL_THRESHOLD:-}" in ''|*[!0-9.]*|*.*.*) ;; *) THRESHOLD_OVERRIDE="$BRAIN_RECALL_THRESHOLD" ;; esac
case "${BRAIN_RECALL_MARGIN:-}" in ''|*[!0-9.]*|*.*.*) ;; *) MARGIN_OVERRIDE="$BRAIN_RECALL_MARGIN" ;; esac
# Schwelle/Marge weiterer Einbettungsmodelle (BRAIN_EMBED_MODELL), "modell=schwelle/marge,...".
# Die obigen Werte gelten fuer embeddinggemma. Ein Modell, das hier fehlt, spielt nichts ein.
# qwen3-embedding-0.6b (2026-09-24, eval/suche-einbettung/hook-schwelle.json): auf Dev (80 Fragen
# des j1-Goldpools) gewaehlt, hoechste Praezision bei hoechstens 5 Treffern je 100 unter gemma
# 0,44/0,10. Test (120): Rauschen -23 je 100 [95 %: -37; -11], Treffer -7 [-18; +6].
# Auf echten Chateingaben (r1, eval/recall-qwen/BEFUNDE.md) verliert 0,60/0,04 dagegen gesichert
# Treffer (Goldset-Test -59 je 100 [-84; -34]) bei gleicher Trennschaerfe (AUC 0,70 zu 0,71).
# Deshalb laeuft der Hook weiter mit embeddinggemma; der Eintrag gilt nur bei gesetzter Variable.
MODEL_GATES="qwen3-embedding-0.6b=0.60/0.04"
# Tor fuer starke Worttreffer (2026-09-28, b6-zugang, Plan Z1): ein Treffer ohne ausreichende
# cosine kommt trotzdem durch, wenn er in der Fusion auf Rang 1..WORT_RANG steht und die
# normierte Fusionszahl (score, bester Treffer = 1,0) mindestens WORT_SCORE traegt und BM25
# ihn gefunden hat (WORT_MATCH text = nur reine BM25-Treffer, beide = auch hybride unter dem
# Tor), oder - bei WORT_TITEL=1 - wenn sein Titel ein Wort des Prompts traegt.
# AUS (BRAIN_RECALL_WORT=1 schaltet ein), gemessen am 28.09. auf dem Relevanztor-Goldset mit
# 35 nachbeurteilten Paaren (~/.pi-workers/results/b6-zugang/messung/): keine der 31 Varianten
# schlaegt den heutigen Hook auf Dev (Netto Treffer minus Rauschen <= 0). Die Dev-Wahl der
# weiten Familie (Rang 1, auch hybrid) kostet auf Test gesichert Rauschen: Treffer +18,8
# [95 %: +6,3; +34,4], Rauschen +21,9 [+9,4; +37,5] je 100 Prompts (Bootstrap 5000, Seed 7).
# Reine Texttreffer stehen im Goldset nie auf Rang 1. Messhebel BRAIN_RECALL_WORT_RANG/
# _SCORE/_TITEL/_MATCH.
WORT_RANG="1"
WORT_SCORE="0.0"
WORT_TITEL="0"
WORT_MATCH="beide"
case "${BRAIN_RECALL_WORT_MATCH:-}" in text|beide) WORT_MATCH="$BRAIN_RECALL_WORT_MATCH" ;; esac
case "${BRAIN_RECALL_WORT_RANG:-}" in ''|*[!0-9]*) ;; *) WORT_RANG="$BRAIN_RECALL_WORT_RANG" ;; esac
case "${BRAIN_RECALL_WORT_SCORE:-}" in ''|*[!0-9.]*|*.*.*) ;; *) WORT_SCORE="$BRAIN_RECALL_WORT_SCORE" ;; esac
case "${BRAIN_RECALL_WORT_TITEL:-}" in 0|1) WORT_TITEL="$BRAIN_RECALL_WORT_TITEL" ;; esac
MAX_HITS="3"
SNIPPET_CHARS="120"
# Reranker-Tor mit kurzer Anfrage (b22-recall-bau, 30.09.; Mechanik im Kopf des Abschnitts in
# auto-recall-format.py, Messung _meta/tools/eval/recall-v2/BEFUNDE-bau.md). Die Werte sind die
# Dev-Wahl (eval/recall-v2/bau/wahl.json): BGE-Score auf den ersten 300 Zeichen, Kosinus 0,40,
# Score >= -3, Rettung >= 1, hoechstens 1 Einspielung. Messhebel: BRAIN_RECALL_RERANK=0|1,
# BRAIN_RECALL_RERANK_MIN/_GAP/_RETTUNG/_KOSINUS (Zahl, "aus" schaltet die Stufe ab),
# _QUERY_CHARS, _MAX_HITS, _ORDNUNG kosinus|rerank, _STOERUNG heute|nichts, _BUDGET_MS
# (Zeitbudget des Dienstaufrufs; peer und Mac rufen denselben Dienst, Vorgabe 800 ms).
# AN seit 30.09. (Test recall-v2, 150 Eingaben, gepaart 5000/Seed 7): Praezision Grad>=1 71,9 ->
# 89,5 % (+17,5 Pp [+8,9; +26,2]), Trefferquote 11 -> 14 (+2,0 [-0,7; +5,3]), Rauschen -22 je 100;
# Replay events-v2 49/82 -> 49/82. Vorbehalt: auf Dev v2 (100) fiel die Trefferquote 13 -> 6
# (lange Eingaben, Grad-2-Notiz mit hohem Kosinus und niedrigem Score); ueber alle 250 -1,6 Pp [-4,4; +1,2].
RERANK="1"
RERANK_MIN="-3"
RERANK_GAP=""
RERANK_RETTUNG="1"
RERANK_KOSINUS="0.40"
RERANK_QUERY_CHARS="300"
RERANK_MAX_HITS="1"
RERANK_ORDNUNG="kosinus"
RERANK_STOERUNG="heute"
RERANK_BUDGET_MS="800"
zahl() { case "$1" in ''|-|*[!0-9.-]*|?*-*|*.*.*) return 1 ;; *) return 0 ;; esac; }
case "${BRAIN_RECALL_RERANK:-}" in 0|1) RERANK="$BRAIN_RECALL_RERANK" ;; esac
case "${BRAIN_RECALL_RERANK_MIN:-}" in aus) RERANK_MIN="" ;; *) zahl "${BRAIN_RECALL_RERANK_MIN:-}" && RERANK_MIN="$BRAIN_RECALL_RERANK_MIN" ;; esac
case "${BRAIN_RECALL_RERANK_GAP:-}" in aus) RERANK_GAP="" ;; *) zahl "${BRAIN_RECALL_RERANK_GAP:-}" && RERANK_GAP="$BRAIN_RECALL_RERANK_GAP" ;; esac
case "${BRAIN_RECALL_RERANK_RETTUNG:-}" in aus) RERANK_RETTUNG="" ;; *) zahl "${BRAIN_RECALL_RERANK_RETTUNG:-}" && RERANK_RETTUNG="$BRAIN_RECALL_RERANK_RETTUNG" ;; esac
case "${BRAIN_RECALL_RERANK_KOSINUS:-}" in aus) RERANK_KOSINUS="" ;; *) zahl "${BRAIN_RECALL_RERANK_KOSINUS:-}" && RERANK_KOSINUS="$BRAIN_RECALL_RERANK_KOSINUS" ;; esac
case "${BRAIN_RECALL_RERANK_QUERY_CHARS:-}" in ''|0|*[!0-9]*) ;; *) RERANK_QUERY_CHARS="$BRAIN_RECALL_RERANK_QUERY_CHARS" ;; esac
case "${BRAIN_RECALL_RERANK_MAX_HITS:-}" in ''|0|*[!0-9]*) ;; *) RERANK_MAX_HITS="$BRAIN_RECALL_RERANK_MAX_HITS" ;; esac
case "${BRAIN_RECALL_RERANK_ORDNUNG:-}" in kosinus|rerank) RERANK_ORDNUNG="$BRAIN_RECALL_RERANK_ORDNUNG" ;; esac
case "${BRAIN_RECALL_RERANK_STOERUNG:-}" in heute|nichts) RERANK_STOERUNG="$BRAIN_RECALL_RERANK_STOERUNG" ;; esac
case "${BRAIN_RECALL_RERANK_BUDGET_MS:-}" in ''|*[!0-9]*) ;; *) RERANK_BUDGET_MS="$BRAIN_RECALL_RERANK_BUDGET_MS" ;; esac
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

# Gast-Sitzung (2026-09-26, wb-gast-tor): eine Sitzung, die ein Gast ueber das Gast-Tor auf
# diesem Konto gestartet hat, traegt WB_PERSON in der Umgebung und @wb_person als
# tmux-Sitzungsoption. Die Option faengt auch Worker-Panes und Sitzungen, deren Umgebung ein
# spaeter angehaengter Client ueberschrieben hat. Nur Kleinbuchstaben, Ziffern, _ und -.
gast="${WB_PERSON:-}"
if [ -z "$gast" ] && [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
  gast="$(tmux display-message -p -t "$TMUX_PANE" '#{@wb_person}' 2>/dev/null)"
fi
case "$gast" in ''|*[!a-z0-9_-]*) gast="" ;; esac
# In einer Gast-Sitzung sucht der Recall nur in den mit dem Gast geteilten Spaces, nie im Kern
# (BRAIN5-PLAN Nr. 39; Liste per BRAIN_GAST_SPACES ueberschreibbar).
SPACE_ARGS=""
if [ -n "$gast" ]; then
  SPACE_ARGS="--space ${BRAIN_GAST_SPACES:-a project,a machine-bound project,a project,uebersetzer,ttsapp,peltier-eismaschine,lumenpt}"
fi

[ -x "$BRAIN_BIN" ] || exit 0
# Portable timeout: gtimeout on macOS (coreutils), timeout on Linux.
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN=gtimeout
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN=timeout
else exit 0
fi
command -v python3 >/dev/null 2>&1 || exit 0

input="$(cat)"
# Ein python-Start statt drei (2026-09-28, b6-zugang): Zeile 1 Startzeit fuer das
# Nutzungsprotokoll, Zeile 2 session_id, Zeile 3 cwd, danach der Prompt.
#
# Das Arbeitsverzeichnis der Sitzung steht im selben JSON und ist die einzige
# Auskunft darueber, in welchem Projekt der Hook gerade feuert. Ohne sie spielte
# er in einem Spieleprojekt Notizen zu fremden Projekten ein (belegt 19.07.2026).
# Faellt das Feld weg, bleiben die Filter aus und der Hook laeuft wie vorher.
# Die session_id dient der Dedup je Kontextfenster (T3); fehlt sie, wird nicht dedupliziert.
# Zeile 4 (b7-recall, 29.09.): Name der Filterregel aus recall_eingabe.py, die den Prompt als
# maschinell erkennt (leer = Mensch; "!" = Modul fehlt, dann gilt der alte case-Filter unten).
meta="$(printf '%s' "$input" | WB_HOOK_DIR="$(dirname "$0")" python3 -c '
import json, os, sys, time
sys.stdout.write("%.3f\n" % time.time())
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
def feld(k):
    v = data.get(k, "")
    return v.replace("\n", " ") if isinstance(v, str) else ""
prompt = data.get("prompt") if isinstance(data.get("prompt"), str) else ""
try:
    sys.path.insert(0, os.environ.get("WB_HOOK_DIR", "."))
    from recall_eingabe import maschinell
    regel = maschinell(prompt) or ""
except Exception:
    regel = "!"
sys.stdout.write(feld("session_id") + "\n" + feld("cwd") + "\n" + regel + "\n" + prompt)
' 2>/dev/null)"
t0="$(printf '%s\n' "$meta" | sed -n 1p)"
session_id="$(printf '%s\n' "$meta" | sed -n 2p)"
session_cwd="$(printf '%s\n' "$meta" | sed -n 3p)"
regel="$(printf '%s\n' "$meta" | sed -n 4p)"
prompt="$(printf '%s\n' "$meta" | sed '1,4d')"
[ -n "$session_cwd" ] || session_cwd="$PWD"

# Nutzungsprotokoll (Firmenniveau-Plan M3, 2026-09-28): je Aufruf eine Zeile mit Leer-Grund und
# Dauer, im Hintergrund geschrieben (Mehrzeit gemessen < 20 ms). Anfragetext nur geschwaerzt,
# lokal, gitignoriert (der Nutzer 28.09.). Abschalter: BRAIN_NUTZUNGSLOG=0.
# protokoll <grund> [detail] ; liest das Such-JSON aus $result und den Formatiererbericht aus $nl_datei.
nl_datei=""
if [ "${BRAIN_NUTZUNGSLOG:-1}" != "0" ]; then
  nl_datei="${TMPDIR:-/tmp}/brain-recall-$$.json"
fi
protokoll() {
  [ -n "$nl_datei" ] || return 0
  ( printf '%s' "${result:-}" | WB_NL_GRUND="$1" WB_NL_DETAIL="${2:-}" WB_NL_T0="$t0" \
      WB_NL_DATEI="$nl_datei" WB_NL_PROMPT="$prompt" WB_NL_CWD="$session_cwd" WB_NL_VAULT="$VAULT_DIR" \
      python3 "$(dirname "$0")/nutzung_hook.py" & ) </dev/null >/dev/null 2>&1
}

[ -n "$prompt" ] || exit 0

# Auftrags-Recall (v2-ki-nutzung T2, 2026-09-24): nennt der Prompt eine Auftragsdatei unter einem
# Scratchpad oder tasks/, wird statt des Zeigers der Auftrag selbst gesucht (Ueberschrift + 500
# Zeichen ohne Standardabsaetze, auftrag_query.py). Das gilt auch fuer Sitzungsnachrichten, die
# der Filter unten sonst verwirft. Notizen, die der Auftrag oder der Projekt-KERN schon nennt,
# entfallen im Formatierer. Nennt der Auftrag selbst schon zwei Vault-Notizen, schweigt der Hook
# (Auftraggeber hat gesucht). Abschalter: BRAIN_RECALL_AUFTRAG=0.
auftrag_file=""
# Den python-Start spart sich der Hook, wenn der Prompt keinen der Ablageorte nennt, die
# auftrag_query.task_file() ueberhaupt annimmt (b7-recall, 29.09.: ein Start weniger je Eingabe).
auftrag_ort=0
case "$prompt" in *scratchpad/*|*tasks/*|*.auftrag.txt*) auftrag_ort=1 ;; esac
if [ "${BRAIN_RECALL_AUFTRAG:-1}" != "0" ] && [ "$auftrag_ort" = 1 ]; then
  auftrag="$(printf '%s' "$prompt" | "$TIMEOUT_BIN" 1 python3 "$(dirname "$0")/auftrag_query.py" 2>/dev/null)"
  if [ -n "$auftrag" ]; then
    auftrag_file="$(printf '%s\n' "$auftrag" | sed -n 1p)"
    auftrag_query="$(printf '%s\n' "$auftrag" | sed -n 2p)"
    [ -n "$auftrag_file" ] && [ -z "$auftrag_query" ] && { protokoll filter auftrag-genannt; exit 0; }
    # K=8 statt 4: schon genannte Notizen fallen erst nach der Suche weg und belegten sonst die
    # Plaetze (Myproject-KERN verlinkt z.B. fast alle Rechtsnotizen; mit K=4 blieb dort nichts).
    if [ -n "$auftrag_file" ]; then prompt="$auftrag_query"; K="8"; fi
  fi
fi
# Maschinelle Eingaben sind keine Fragen (2026-09-23): Hintergrund-Meldungen, Nachrichten anderer
# Sitzungen und Worker-Zeiger landeten als "Prompt" hier und spielten bei jeder Meldung dieselben
# unpassenden Notizen ein. Nur Text, den ein Mensch oder Auftraggeber als Aufgabe schreibt, zaehlt.
# Seit 2026-09-23 stellt das Harness Nachrichten anderer Sitzungen als "Another Claude session sent a
# message:" voran (57 % der Einspielungen danach waren solche Nachrichten, v2-ki-nutzung 24.09.).
# Seit 2026-09-29 (b7-recall) stehen die Regeln mit je einem Schalter in recall_eingabe.py
# (BRAIN_RECALL_FILTER_<REGEL>=0), dazu Orchestrator-Nachrichten, Kontextwache, Fortsetzungs-Texte
# nach der Kompaktierung und Gedaechtnis-Konsolidierung. Der case unten gilt nur, wenn das Modul
# fehlt (regel "!"), damit ein unvollstaendiger Hook-Ordner nicht mehr einspielt als vorher.
if [ -z "$auftrag_file" ]; then
  if [ "$regel" = "!" ]; then
    case "$prompt" in
      *"<task-notification>"*|*"[SYSTEM NOTIFICATION"*|"<cross-session-message"*|*"<system-reminder>"*|"[Cross-session"*|"[wb-freigabe]"*) protokoll filter maschinell; exit 0 ;;
      "Another Claude session sent a message"*|*"<cross-session-message from="*) protokoll filter maschinell; exit 0 ;;
    esac
  elif [ -n "$regel" ]; then
    protokoll filter "maschinell:$regel"; exit 0
  fi
fi

# Anfragekappe (b7-recall, 29.09.): die Suche dauert mit der Laenge des Prompts (warm gemessen
# 1.000 Zeichen 0,44 s, 4.000 0,59 s, 8.000 0,80 s, 40.000 1,6-2,0 s); zwei Frist-Faelle am 28.09.
# waren lange Vorlagen. Die laengste menschliche Eingabe der Stichprobe hatte 1.018 Zeichen.
# BRAIN_RECALL_MAX_CHARS ueberschreibt (0 = keine Kappe); gesucht wird mit den ersten Zeichen.
MAX_CHARS="4000"
case "${BRAIN_RECALL_MAX_CHARS:-}" in ''|*[!0-9]*) ;; *) MAX_CHARS="$BRAIN_RECALL_MAX_CHARS" ;; esac
query="$prompt"
if [ "$MAX_CHARS" -gt 0 ] && [ "${#query}" -gt "$MAX_CHARS" ]; then
  query="$(printf '%s' "$query" | python3 -c 'import sys; n=int(sys.argv[1]); sys.stdout.write(sys.stdin.read()[:n])' "$MAX_CHARS" 2>/dev/null)"
  [ -n "$query" ] || query="$prompt"
fi

# shellcheck disable=SC2086
# BRAIN_NUTZUNGSLOG_QUELLE=hook: `brain search` protokolliert diesen Aufruf nicht selbst als Kanal
# search - er steht unten als Kanal recall mit Leer-Grund und Gesamtdauer.
# --no-rerank (29.09.): der Reranker ist Standard von `brain search`, aber fuer den Recall nicht
# gemessen (Frist 2,0 s, Budget 1 s ueber das Tailnet); der Hook bleibt beim Rangkern.
# Eigener warmer Suchprozess (Lane `recall`, 09.10.): in einer Woche liefen 16 von 106 Recall-Suchen in die
# Frist, meist die erste nach 30 min Leerlauf (Prozess und Einbettungsmodell kalt) oder eine hinter einer langen
# Suche mit Reranker und LLM-Sortierung im gemeinsamen Prozess. Die Lane hat ihren eigenen Prozess, bleibt
# BRAIN_RECALL_WARM_IDLE Sekunden warm (Modell ebenso lange geladen), und fehlt sie, startet der Aufruf sie
# und endet sofort mit 75 (Leer-Grund `kalt`) statt die Frist abzuwarten. BRAIN_RECALL_WARM=0 = alter Weg.
WARM_IDLE="28800"
case "${BRAIN_RECALL_WARM_IDLE:-}" in ''|*[!0-9]*) ;; *) WARM_IDLE="$BRAIN_RECALL_WARM_IDLE" ;; esac
if [ "${BRAIN_RECALL_WARM:-1}" = "0" ]; then
  result="$(BRAIN_NUTZUNGSLOG_QUELLE=hook "$TIMEOUT_BIN" "$TIMEOUT_SECONDS" "$BRAIN_BIN" search "$query" -k "$K" --json --no-rerank $SPACE_ARGS 2>/dev/null)"
  rc=$?
else
  result="$(BRAIN_NUTZUNGSLOG_QUELLE=hook BRAIN_WARM_LANE=recall BRAIN_WARM_ONLY=1 BRAIN_WARM_IDLE="$WARM_IDLE" BRAIN_SEARCH_KEEP_ALIVE="${WARM_IDLE}s" "$TIMEOUT_BIN" "$TIMEOUT_SECONDS" "$BRAIN_BIN" search "$query" -k "$K" --json --no-rerank $SPACE_ARGS 2>/dev/null)"
  rc=$?
fi
if [ -z "$result" ]; then
  if [ "$rc" = 124 ]; then protokoll frist; elif [ "$rc" = 75 ]; then protokoll kalt; else protokoll fehler "rc $rc"; fi
  exit 0
fi

printf '%s' "$result" | WB_THRESHOLD="$SCORE_THRESHOLD" WB_RELATIVE_MARGIN="$RELATIVE_MARGIN" WB_MODEL_GATES="$MODEL_GATES" WB_THRESHOLD_OVERRIDE="$THRESHOLD_OVERRIDE" WB_MARGIN_OVERRIDE="$MARGIN_OVERRIDE" WB_MAX_HITS="$MAX_HITS" WB_SNIPPET_CHARS="$SNIPPET_CHARS" WB_CWD="$session_cwd" WB_PROMPT="$prompt" WB_VAULT="$VAULT_DIR" WB_PROJECT_PENALTY="$PROJECT_PENALTY" WB_PROSE_MIN="$PROSE_MIN" WB_RECALL_VALIDITY="$RECALL_VALIDITY" WB_AUFTRAG_FILE="$auftrag_file" WB_SESSION_ID="$session_id" WB_RECALL_DEDUP="${BRAIN_RECALL_DEDUP:-1}" WB_RECALL_HERKUNFT="${BRAIN_RECALL_HERKUNFT:-1}" WB_STATE_DIR="${AWB_RECALL_STATE_DIR:-$VAULT_DIR/_meta/tools/state/recall-dedup}" WB_NUTZUNG_DATEI="$nl_datei" WB_WORT="${BRAIN_RECALL_WORT:-0}" WB_WORT_MATCH="$WORT_MATCH" WB_WORT_RANG="$WORT_RANG" WB_WORT_SCORE="$WORT_SCORE" WB_WORT_TITEL="$WORT_TITEL" WB_RERANK="$RERANK" WB_RERANK_MIN="$RERANK_MIN" WB_RERANK_GAP="$RERANK_GAP" WB_RERANK_RETTUNG="$RERANK_RETTUNG" WB_RERANK_KOSINUS="$RERANK_KOSINUS" WB_RERANK_QUERY_CHARS="$RERANK_QUERY_CHARS" WB_RERANK_MAX_HITS="$RERANK_MAX_HITS" WB_RERANK_ORDNUNG="$RERANK_ORDNUNG" WB_RERANK_STOERUNG="$RERANK_STOERUNG" WB_RERANK_BUDGET_MS="$RERANK_BUDGET_MS" python3 "$(dirname "$0")/auto-recall-format.py" 2>/dev/null
protokoll

exit 0
