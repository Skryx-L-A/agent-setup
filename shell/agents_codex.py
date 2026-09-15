#!/usr/bin/env python3
"""Codex als Agenten-Harness, Stand Trockenlauf: Erkennung, Zugbeschreibung und Anmeldeweg.

Ein Codex-Modell erkennt der Traeger an seinem Registry-Eintrag (``harness: codex``) in
``~/.claude/workbench/models.json``. Der Aufruf folgt der auf Peer-Rechner gemessenen Form aus
``shell/messungen/agents-remote/model-pipeline-probe.py`` (Codex 0.149.1, docs/AGENTS-CONTROLLER-ENDPOINT.md):
``codex exec --json`` mit eigenem ``CODEX_HOME``, ohne Nutzerkonfiguration, mit einem Provider auf
die Modellbruecke und ``--sandbox danger-full-access``. Dieser Schalter steht ausschliesslich im
Runner (``agents_codex_runner.py``), der nur innerhalb des LinuxLaunchers laeuft; aussen bleiben
Dateiscopes, Netzisolation und private Sockets.

Nicht gebaut: der Modelltransport mit der Codex-Anmeldung und das Urteil ueber einen echten Codex-Zug.
Der Traeger startet deshalb keinen Codex-Zug; ohne Anmeldung endet der Zug mit ``anmeldung``.
"""
from __future__ import annotations

import json
import os
import re
import stat
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from agents_claude import ClaudeAdapterFehler, ZUG_UMGEBUNG

RUNNER = "agents_codex_runner.py"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
AUTH_LIMIT = 64 * 1024
_MODEL = re.compile(r"[A-Za-z0-9._:/-]{1,256}\Z")


def codex_eintrag(registry: Optional[dict[str, Any]], name: str) -> Optional[dict[str, Any]]:
    """Registry-Eintrag eines Codex-Modells zum Profilnamen (``codex-gpt-5-5:high`` → ``codex-gpt-5-5``)."""
    base = str(name or "").split(":", 1)[0]
    models = (registry or {}).get("models")
    for item in models if isinstance(models, list) else []:
        if isinstance(item, dict) and item.get("id") == base and item.get("harness") == "codex" \
                and item.get("enabled") is not False and isinstance(item.get("modelRef"), str):
            return item
    return None


class CodexAnmeldung:
    """Anmeldestatus aus ``auth.json`` der Codex-CLI; der Inhalt verlaesst den Controllerprozess nie."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(os.path.abspath(os.path.expanduser(str(path))))

    def status(self) -> dict[str, Any]:
        result = {"kind": "codex-login", "available": False, "reason": None}
        try:
            info = os.lstat(self.path)
        except FileNotFoundError:
            return dict(result, reason="fehlt")
        except OSError:
            return dict(result, reason="unlesbar")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > AUTH_LIMIT:
            return dict(result, reason="keine_regulaere_datei")
        try:
            data = json.loads(self.path.read_bytes()[:AUTH_LIMIT + 1])
        except (OSError, ValueError):
            return dict(result, reason="unlesbar")
        tokens = data.get("tokens") if isinstance(data, dict) else None
        if not (isinstance(tokens, dict) and tokens.get("access_token")) and not (
                isinstance(data, dict) and data.get("OPENAI_API_KEY")):
            return dict(result, reason="ohne_anmeldung")
        return dict(result, available=True)


@dataclass(frozen=True)
class CodexZug:
    """Unveraenderliche Beschreibung genau eines Codex-Zuges."""

    cli: str
    model: str
    prompt: str
    session_id: str
    codex_home: str
    effort: Optional[str] = None
    append_system_prompt_file: Optional[str] = None
    extra_env: tuple[tuple[str, str], ...] = field(default=())
    runner = RUNNER

    def __post_init__(self) -> None:
        for name in ("cli", "codex_home"):
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
        if self.effort is not None and self.effort not in EFFORTS:
            raise ClaudeAdapterFehler("Codex-Denkstufe ist ungueltig")
        if self.append_system_prompt_file is not None and not Path(self.append_system_prompt_file).is_absolute():
            raise ClaudeAdapterFehler("Anweisungsdatei des Zuges braucht einen absoluten Pfad")
        for name, value in self.extra_env:
            if name not in ZUG_UMGEBUNG or not isinstance(value, str) or "\x00" in value or len(value) > 4096:
                raise ClaudeAdapterFehler("extra_env enthaelt eine nicht freigegebene Variable")

    def lese_pfade(self) -> tuple[Path, ...]:
        """Ordner des Codex-Binaries."""
        return (Path(self.cli).parent,)

    def as_dict(self) -> dict[str, Any]:
        return {
            "harness": "codex", "cli": self.cli, "model": self.model, "prompt": self.prompt,
            "session_id": self.session_id, "codex_home": self.codex_home, "effort": self.effort,
            "append_system_prompt_file": self.append_system_prompt_file,
            "extra_env": [list(pair) for pair in self.extra_env],
        }


__all__ = ["CodexAnmeldung", "CodexZug", "EFFORTS", "RUNNER", "codex_eintrag"]
