#!/bin/bash
# Zweck: WARNT (blockt nie) bei Aufrufen an bekannte Cloud-Bild-/Video-/Audio-
#        APIs, verweist auf die lokalen Tools bild/video/tts/stt.
# Event: PreToolUse, matcher Bash + WebFetch.
# Warum: LOCAL-FIRST-Media-Regel ("website/landing-page images ... never a
#        paid cloud model/connector") gilt fuer Orchestrator UND jeden Worker,
#        ist aber nirgends technisch erzwungen — nur Prosa in CLAUDE.md.
# Blockliste: ~/.claude/hooks/media-cloud-domains.txt (separat, leicht
#        pflegbar ohne diesen Hook neu zu schreiben).
# Policy: reines Warnen, kein Deny — die Liste veraltet schnell und manche
#        Cloud-Aufrufe sind bewusst genehmigte Ausnahmen (z.B. creative-media-
#        Skill nutzt Higgsfield gezielt); ein Hard-Block waere hier falsch.
set -uo pipefail

domains_file="$HOME/.claude/hooks/media-cloud-domains.txt"
[ -f "$domains_file" ] || exit 0

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ -z "$tool_name" ] && exit 0

# MCP-Medien-Konnektoren: der wahrscheinlichere Weg als ein roher curl-Aufruf.
# Bis 2026-08-03 war er ungedeckt — der Guard kannte nur Bash und WebFetch, waehrend
# in dieser Umgebung ueber ein Dutzend Cloud-Bild-/Video-Werkzeuge als MCP-Tools
# bereitstehen (Adobe Firefly/Express, Canva, Gamma). Ein Worker, der eines davon
# aufruft, umging die LOCAL-FIRST-Regel vollstaendig, ohne dass irgendetwas feuerte.
# Hier zaehlt der TOOL-NAME, nicht eine Domain im Text: diese Aufrufe tragen keine URL.
case "$tool_name" in
  mcp__claude_ai_Adobe_for_creativity__image_*|\
  mcp__claude_ai_Adobe_for_creativity__video_*|\
  mcp__claude_ai_Adobe_for_creativity__animate_design|\
  mcp__claude_ai_Adobe_for_creativity__create_firefly_board|\
  mcp__claude_ai_Canva__generate-design*|\
  mcp__claude_ai_Canva__create-design*|\
  mcp__claude_ai_Gamma__generate*)
    cat <<EOF >&2
HINWEIS (media-cloud-guard): '$tool_name' erzeugt Medien in der CLOUD.
  Stehende Regel LOCAL-FIRST (regeln/medien.md): Bilder, Video, Sprache und
  Transkription entstehen zuerst mit dem lokalen Stack — bild / video / tts / stt
  in ~/.local/bin, offline, kostenlos, in Benchmarks auf Augenhoehe.
  Cloud ist erlaubt, wenn die lokale Qualitaet fuer genau diese Aufgabe
  nachweislich nicht reicht oder der Nutzer es verlangt — dann sag im Bericht
  ausdruecklich, dass und warum Cloud benutzt wurde.
EOF
    exit 0
    ;;
esac

haystack=""
case "$tool_name" in
  Bash)
    haystack=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
    ;;
  WebFetch)
    haystack=$(printf '%s' "$input" | jq -r '.tool_input.url // empty' 2>/dev/null)
    ;;
  *)
    exit 0
    ;;
esac
[ -z "$haystack" ] && exit 0

hit=""
while IFS= read -r domain; do
  case "$domain" in
    ''|'#'*) continue ;;
  esac
  if printf '%s' "$haystack" | grep -Fq "$domain"; then
    hit="$domain"
    break
  fi
done < "$domains_file"

[ -z "$hit" ] && exit 0

reason="media-cloud-guard: Aufruf an bekannte Cloud-Media-API ($hit) erkannt. LOCAL-FIRST-Regel: bild/video/tts/stt (~/.local/bin, offline-faehig) zuerst pruefen, Cloud nur wenn lokale Qualitaet nachweislich nicht reicht oder der Nutzer es verlangt. Reine Warnung, kein Block."
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
