#!/usr/bin/env python3
"""PreToolUse-Hook-Einstieg fuer das Fallenbuch (tripwire_core.py).

Liest das Hook-JSON von stdin (tool_name, tool_input, cwd, session_id), prueft die
eingebauten Shell-Tripwires (tripwire_shell.py, projektunabhaengig, nur Bash) und die
Ausloeser des Projekt-Fallenbuchs und gibt bei Treffer additionalContext im
PreToolUse-Format aus. BLOCKIERT NIE: jeder Fehlerpfad endet in `sys.exit(0)` ohne
Ausgabe, nie in einem `deny`. Vorbild fuer das Ausgabeformat: `print_warn()` in
~/.claude/hooks/bash-guard.py (WARNUNG, kein deny).

Aufruf: `python3 tripwire_cli.py` mit dem Hook-JSON auf stdin. `tripwire.sh` ist der
duenne Shell-Wrapper, den settings.json tatsaechlich registriert.
"""
from __future__ import annotations

import json
import os
import sys

_HOOK_DIR = os.path.dirname(os.path.abspath(__file__))
if _HOOK_DIR not in sys.path:
    sys.path.insert(0, _HOOK_DIR)

import tripwire_core as tw  # noqa: E402


def _vault_dir() -> str:
    return os.environ.get("AWB_VAULT_DIR") or os.path.expanduser("~/Knowledge")


def _state_dir(vault: str) -> str:
    return os.environ.get("AWB_TRIPWIRE_STATE_DIR") or os.path.join(
        vault, "_meta", "tools", "state", "tripwire"
    )


def main() -> None:
    try:
        raw = sys.stdin.read()
    except Exception:
        return
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return
    if not isinstance(payload, dict):
        return

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    cwd = payload.get("cwd") or os.getcwd()
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        session_id = None

    vault = _vault_dir()
    state_dir = _state_dir(vault)

    texte = []
    try:
        shell_text = _shell_warnung(tool_name, tool_input, session_id, state_dir)
    except Exception:
        shell_text = ""
    if shell_text:
        texte.append(shell_text)

    try:
        projekt = tw.project_for_cwd(cwd, vault)
    except Exception:
        projekt = None
    # Ohne erkanntes Projekt bleibt das globale Fallenbuch (10-global/FALLEN.yaml) wirksam.
    texte.append(_fallen_text(tool_name, tool_input, cwd, vault, session_id, state_dir, projekt))
    text = "\n".join(t for t in texte if t)
    if not text:
        return
    _ausgeben(text)


def _shell_warnung(tool_name, tool_input, session_id, state_dir) -> str:
    """Eingebaute Shell-Tripwires (tripwire_shell.py), unabhaengig vom Projekt. Gleicher
    Fehlerklasse hoechstens einmal je Sitzung (seit 09.10.; BRAIN_TRIPWIRE_SHELL_DEDUPE=detail = je Klasse + Detail).
    Abschalter: BRAIN_TRIPWIRE_SHELL=0."""
    if tool_name != "Bash" or os.environ.get("BRAIN_TRIPWIRE_SHELL", "1") == "0":
        return ""
    command = tool_input.get("command")
    if not isinstance(command, str) or not (
        "`" in command or "pgrep" in command or "pkill" in command
    ):
        return ""
    import tripwire_shell as ts

    befunde = ts.detect(command, run_in_background=tool_input.get("run_in_background") is True)
    if not befunde:
        return ""
    if session_id:
        from pathlib import Path

        gezeigt = tw._load_shown(Path(state_dir), session_id)
        # Jede Shell-Fehlerklasse nur einmal je Sitzung (Standard seit 09.10., so gemessen als V1c mit dem globalen
        # Fallenbuch, eval/replay/BEFUNDE-v3-2026-10-09.md); BRAIN_TRIPWIRE_SHELL_DEDUPE=detail = je Befund wie vorher.
        je_klasse = os.environ.get("BRAIN_TRIPWIRE_SHELL_DEDUPE", "klasse") != "detail"
        neu = [(b, "shell:%s" % b["klasse"] if je_klasse else "shell:%s:%s" % (b["klasse"], b["detail"]))
               for b in befunde]
        neu = [(b, k) for b, k in neu if k not in gezeigt]
        if neu:
            tw._save_shown(Path(state_dir), session_id, gezeigt | {k for _, k in neu})
        befunde = [b for b, _ in neu]
    return ts.format_findings(befunde)


def _fallen_text(tool_name, tool_input, cwd, vault, session_id, state_dir, projekt) -> str:
    fallen_path = os.path.join(vault, "20-projects", projekt, "FALLEN.yaml") if projekt else None

    try:
        hits = tw.tripwire_for(
            tool_name,
            tool_input,
            cwd,
            vault,
            session_id=session_id,
            state_dir=state_dir,
            fallen_path=fallen_path,
        )
    except Exception:
        hits = []
    return tw.format_hits(hits, projekt=projekt or "global")


def _ausgeben(text: str) -> None:
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            # Kein permissionDecision (2026-09-23, Orchestrator): ein Erinnerungs-Hook darf den
            # Berechtigungsablauf nicht veraendern; "allow" haette in normalen Modi jeden
            # passenden Befehl ohne Rueckfrage freigegeben. Nur Zusatzkontext fuers Modell.
            "additionalContext": text,
        },
        "systemMessage": text,
    }
    try:
        print(json.dumps(out, ensure_ascii=False))
    except Exception:
        return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
