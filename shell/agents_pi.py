#!/usr/bin/env python3
"""Pi als Agenten-Harness auf Linux: Zugbeschreibung und Stream-Urteil fuer ``pi --print --mode json``.

Ein Pi-Zug laeuft wie ein Claude-Zug im LinuxLauncher mit gebundener Modellbruecke. Das Modell
rechnet lokal auf demselben Host (``local_only``); der Proxy spricht Chat-Completions
(``openai-completions``) mit dem lokalen Inferenzserver. Pi bekommt nur den Platzhalterschluessel.

Gemessen an Pi 0.83.0 (``shell/messungen/agents-remote/pi-json-probe.py``): Die Ausgabe beginnt mit
der Sitzungskopfzeile ``{"type": "session", "id": …}``, jede Assistenznachricht endet mit
``message_end`` samt ``usage`` und ``stopReason``, der Zug mit ``agent_end`` und ``agent_settled``.
``--session-id`` mit festem ``--session-dir`` setzt dieselbe Sitzung im naechsten Zug fort. Im
JSON-Modus endet Pi auch nach einem Modellfehler mit Exit 0; massgeblich ist der Stopgrund.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from agents_claude import ClaudeAdapterFehler, StreamBefund, ZUG_UMGEBUNG

RUNNER = "agents_pi_runner.py"
PI_TOOLS = frozenset({"bash", "read", "write", "edit", "grep", "find", "ls"})
# Werkzeugnamen des Profils (Claude-Schreibweise) auf Pi-Werkzeuge.
PROFIL_WERKZEUGE = {"Bash": "bash", "Read": "read", "Write": "write", "Edit": "edit", "Grep": "grep", "Glob": "find"}
THINKING = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
_MODEL = re.compile(r"[A-Za-z0-9._:/-]{1,512}\Z")
PROTOKOLLE = ("openai-completions", "openai-responses")


@dataclass(frozen=True)
class PiZug:
    """Unveraenderliche Beschreibung genau eines Pi-Zuges."""

    node: str
    cli: str
    model: str
    prompt: str
    session_id: str
    session_dir: str
    agent_dir: str
    api: str = "openai-completions"
    context_window: int = 16384
    tools: tuple[str, ...] = ("bash",)
    thinking: Optional[str] = None
    append_system_prompt_file: Optional[str] = None
    extra_env: tuple[tuple[str, str], ...] = field(default=())
    runner = RUNNER

    def __post_init__(self) -> None:
        for name in ("node", "cli", "session_dir", "agent_dir"):
            if not Path(getattr(self, name)).is_absolute():
                raise ClaudeAdapterFehler("%s braucht einen absoluten Pfad" % name)
        if not _MODEL.fullmatch(self.model):
            raise ClaudeAdapterFehler("Modellkennung ist ungueltig")
        if not isinstance(self.prompt, str) or not self.prompt.strip() or "\x00" in self.prompt:
            raise ClaudeAdapterFehler("Prompt fehlt")
        try:
            if str(uuid.UUID(self.session_id)) != self.session_id:
                raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise ClaudeAdapterFehler("Sitzungskennung muss eine kanonische UUID sein") from None
        if self.api not in PROTOKOLLE:
            raise ClaudeAdapterFehler("Pi-Protokoll ist nicht freigegeben")
        if not isinstance(self.context_window, int) or not 1024 <= self.context_window <= 1_048_576:
            raise ClaudeAdapterFehler("Kontextfenster ist ungueltig")
        if not isinstance(self.tools, tuple) or not self.tools or set(self.tools) - PI_TOOLS:
            raise ClaudeAdapterFehler("Werkzeugliste enthaelt nicht freigegebene Pi-Werkzeuge")
        if self.thinking is not None and self.thinking not in THINKING:
            raise ClaudeAdapterFehler("Pi-Denkstufe ist ungueltig")
        if self.append_system_prompt_file is not None and not Path(self.append_system_prompt_file).is_absolute():
            raise ClaudeAdapterFehler("Anweisungsdatei des Zuges braucht einen absoluten Pfad")
        for name, value in self.extra_env:
            if name not in ZUG_UMGEBUNG or not isinstance(value, str) or "\x00" in value or len(value) > 4096:
                raise ClaudeAdapterFehler("extra_env enthaelt eine nicht freigegebene Variable")

    def lese_pfade(self) -> tuple[Path, ...]:
        """Pi-Paket (``dist/cli.js`` liegt zwei Ebenen darunter) und der Ordner des Node-Binaries."""
        return (Path(self.cli).parents[1], Path(self.node).parent)

    def as_dict(self) -> dict[str, Any]:
        return {
            "harness": "pi", "node": self.node, "cli": self.cli, "model": self.model, "prompt": self.prompt,
            "session_id": self.session_id, "session_dir": self.session_dir, "agent_dir": self.agent_dir,
            "api": self.api, "context_window": self.context_window, "tools": list(self.tools),
            "thinking": self.thinking, "append_system_prompt_file": self.append_system_prompt_file,
            "extra_env": [list(pair) for pair in self.extra_env],
        }


def pi_werkzeuge(profil_tools: Any) -> tuple[str, ...]:
    """Pi-Werkzeuge aus der Werkzeugliste des Profils; ohne Liste nur bash."""
    names = [PROFIL_WERKZEUGE[t] for t in profil_tools or [] if t in PROFIL_WERKZEUGE]
    return tuple(dict.fromkeys(names)) or ("bash",)


def pi_befund(data: bytes, expected_session_id: Optional[str] = None) -> StreamBefund:
    """Wertet die JSON-Ereignisse eines Pi-Zuges in derselben Form aus wie ``stream_befund``."""
    if not data:
        return StreamBefund("empty", "keine Ausgabe")
    parts = data.split(b"\n")
    tail = parts.pop()
    events: list[dict[str, Any]] = []
    for index, line in enumerate(parts):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, ValueError):
            return StreamBefund("unclear", "unlesbare Zeile %d" % (index + 1), events=len(events))
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            return StreamBefund("unclear", "Zeile %d ist kein Ereignis" % (index + 1), events=len(events))
        events.append(value)
    session_id = events[0].get("id") if events and events[0].get("type") == "session" else None
    tools = tuple(str(event.get("toolName")) for event in events if event.get("type") == "tool_execution_start")
    base = dict(session_id=session_id, tool_uses=tools, events=len(events))
    if tail.strip():
        return StreamBefund("truncated", "letzte Zeile ohne Abschluss", **base)
    if not events:
        return StreamBefund("empty", "keine Ereignisse", **base)
    if session_id is None:
        return StreamBefund("unclear", "Ausgabe beginnt nicht mit der Sitzungskopfzeile", **base)
    if expected_session_id is not None and session_id != expected_session_id:
        return StreamBefund("unclear", "Sitzungskennung passt nicht zum Zug", **base)
    ends = [index for index, event in enumerate(events) if event.get("type") == "agent_end"]
    if not ends:
        return StreamBefund("truncated", "Stream endet ohne agent_end", **base)
    if len(ends) > 1:
        return StreamBefund("unclear", "mehrere agent_end-Ereignisse", **base)
    if any(event.get("type") not in {"agent_settled"} for event in events[ends[0] + 1:]):
        return StreamBefund("unclear", "Ereignisse nach agent_end", **base)
    messages = [m for m in events[ends[0]].get("messages") or [] if isinstance(m, dict)]
    last = next((m for m in reversed(messages) if m.get("role") == "assistant"), None)
    turns = sum(1 for event in events if event.get("type") == "turn_end")
    text = None
    if last is not None:
        text = "\n".join(c.get("text", "") for c in last.get("content") or [] if isinstance(c, dict)
                         and c.get("type") == "text").strip() or None
    stop = (last or {}).get("stopReason")
    details = dict(result_text=text, subtype=stop, terminal_reason=stop, num_turns=turns)
    status = _http_status((last or {}).get("errorMessage"))
    if stop == "stop":
        return StreamBefund("completed", "Zug abgeschlossen", **base, **details)
    if stop in {"error", "aborted", "length"}:
        return StreamBefund("harness_error", "Pi meldet %s" % stop, **dict(base, api_error_status=status), **details)
    return StreamBefund("unclear", "agent_end ohne eindeutigen Stopgrund", **base, **details)


def _http_status(message: Any) -> Optional[int]:
    match = re.search(r"\b(401|403|429|500|502|503|529)\b", str(message or ""))
    return int(match.group(1)) if match else None


__all__ = ["PI_TOOLS", "PiZug", "RUNNER", "pi_befund", "pi_werkzeuge"]
