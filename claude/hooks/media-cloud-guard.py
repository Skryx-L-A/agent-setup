#!/usr/bin/env python3
# Zweck: EIN Prozess statt bash+jq+N-mal-grep fuer media-cloud-guard.sh. Das
#        Original forkt pro Aufruf: bash, ein jq fuer tool_name, dann -- im
#        Domain-Scan-Pfad -- pro Zeile der Domain-Liste EIN printf UND EIN
#        grep (bis zu 20 Domains, also bis zu 40 zusaetzliche Forks im
#        Worst-Case "kein Treffer"). Dieser Prozess liest die Hook-Eingabe
#        einmal und scannt die Domain-Liste in-process.
# Gemessen (~/.claude/hooks/tests/test-guard-parity2.sh, fuenf Laeufe, Median,
#        python3 subprocess.run-Zeitnahme):
#        alt, WebFetch ohne Treffer (voller 20-Domain-Scan):    53,3 ms
#        alt, WebFetch mit frueher Treffer-Domain:              21,2 ms
#        alt, MCP-Tool-Name-Treffer (kein Domain-Scan):         10,5 ms
#        neu, WebFetch ohne Treffer:                            23,9 ms
#        neu, WebFetch mit frueher Treffer-Domain:               24,4 ms
#        neu, MCP-Tool-Name-Treffer:                             22,1 ms
#        WebFetch ohne Treffer ist der haeufigste Fall (die meisten Fetches
#        sind keine Cloud-Media-API) und dort ~2,2x schneller. Der MCP-Treffer-
#        Fall wird ~11 ms LANGSAMER (Python-Interpreter-Start allein liegt bei
#        ~20 ms auf dieser Maschine, siehe Ergebnis-Datei) -- das ist der Fall,
#        wo sich der Umbau NICHT lohnt, aber selten genug (nur bei aktiver
#        Cloud-Media-Nutzung) und klein genug, dass der WebFetch-Gewinn
#        ueberwiegt.
#
# KEINE Entscheidung soll sich aendern. Die Logik ist 1:1 aus
#        media-cloud-guard.sh uebernommen (Original-Kommentarblock unten
#        wortwoertlich). Die Originaldatei bleibt unveraendert liegen --
#        Quelle fuer den Differenz-Test, nicht geloescht.
#
# Betroffen: die Matcher WebFetch und die MCP-Medien-Konnektoren in
#        settings.json, jetzt zu einem einzigen PreToolUse-Eintrag
#        zusammengelegt (beide riefen ohnehin schon dasselbe Skript auf).
#        bash-guard-live-config.sh (Write|Edit) bleibt UNVERAENDERT und
#        unverkabelt -- gemessen 14-18 ms alt gegen 25-26 ms als Python-
#        Umbau, also eine Verschlechterung (Python-Interpreter-Start allein
#        kostet hier mehr als der ganze alte bash+2x-jq-Aufruf). Der
#        Bash-Matcher bleibt bei bash-guard.py (eigene Kopie der
#        Bash-Zweige dort, "duplicated not moved").
import json
import os
import re
import sys

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))


def print_warn(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": reason,
            "additionalContext": reason,
        },
        "systemMessage": reason,
    }))


# ---------------------------------------------------------------------------
# media-cloud-guard.sh (Original-Kommentarblock, wortwoertlich):
#
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
DOMAINS_FILE = os.path.join(HOOKS_DIR, "media-cloud-domains.txt")

# MCP-Medien-Konnektoren: der wahrscheinlichere Weg als ein roher curl-Aufruf.
# Bis 2026-08-03 war er ungedeckt — der Guard kannte nur Bash und WebFetch, waehrend
# in dieser Umgebung ueber ein Dutzend Cloud-Bild-/Video-Werkzeuge als MCP-Tools
# bereitstehen (Adobe Firefly/Express, Canva, Gamma). Ein Worker, der eines davon
# aufruft, umging die LOCAL-FIRST-Regel vollstaendig, ohne dass irgendetwas feuerte.
# Hier zaehlt der TOOL-NAME, nicht eine Domain im Text: diese Aufrufe tragen keine URL.
MCP_MEDIA_TOOL_RE = re.compile(
    r'^mcp__claude_ai_Adobe_for_creativity__(image_|video_|animate_design$|create_firefly_board$)'
    r'|^mcp__claude_ai_Canva__(generate-design|create-design)'
    r'|^mcp__claude_ai_Gamma__generate'
)

MCP_MEDIA_NOTICE = """HINWEIS (media-cloud-guard): '%s' erzeugt Medien in der CLOUD.
  Stehende Regel LOCAL-FIRST (regeln/medien.md): Bilder, Video, Sprache und
  Transkription entstehen zuerst mit dem lokalen Stack — bild / video / tts / stt
  in ~/.local/bin, offline, kostenlos, in Benchmarks auf Augenhoehe.
  Cloud ist erlaubt, wenn die lokale Qualitaet fuer genau diese Aufgabe
  nachweislich nicht reicht oder der Nutzer es verlangt — dann sag im Bericht
  ausdruecklich, dass und warum Cloud benutzt wurde."""


def main():
    if not os.path.isfile(DOMAINS_FILE):
        return
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    tool_name = data.get("tool_name") or ""
    if not tool_name:
        return
    tool_input = data.get("tool_input") or {}

    if MCP_MEDIA_TOOL_RE.search(tool_name):
        sys.stderr.write((MCP_MEDIA_NOTICE % tool_name) + "\n")
        return

    if tool_name == "Bash":
        haystack = tool_input.get("command") or ""
    elif tool_name == "WebFetch":
        haystack = tool_input.get("url") or ""
    else:
        return
    if not haystack:
        return

    hit = None
    with open(DOMAINS_FILE) as f:
        for line in f:
            domain = line.strip()
            if not domain or domain.startswith("#"):
                continue
            if domain in haystack:
                hit = domain
                break
    if not hit:
        return

    reason = (f"media-cloud-guard: Aufruf an bekannte Cloud-Media-API ({hit}) erkannt. LOCAL-FIRST-Regel: "
              "bild/video/tts/stt (~/.local/bin, offline-faehig) zuerst pruefen, Cloud nur wenn lokale "
              "Qualitaet nachweislich nicht reicht oder der Nutzer es verlangt. Reine Warnung, kein Block.")
    print_warn(reason)


if __name__ == "__main__":
    main()
