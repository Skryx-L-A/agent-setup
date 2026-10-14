#!/usr/bin/env python3
"""Codex-Agent: Zugbeschreibung und hostseitige Abo-Anmeldung.

Ein Codex-Modell erkennt der Traeger an seinem Registry-Eintrag (``harness: codex``) in
``~/.claude/workbench/models.json``. Der Aufruf folgt der auf Peer-Rechner gemessenen Form aus
``shell/messungen/agents-remote/model-pipeline-probe.py`` (zuletzt Codex 0.160.1 auf peer):
``codex exec --json`` mit eigenem ``CODEX_HOME``, ohne Nutzerkonfiguration, mit einem Provider auf
die Modellbruecke und ``--sandbox danger-full-access``. Dieser Schalter steht ausschliesslich im
Runner (``agents_codex_runner.py``), der nur innerhalb des LinuxLaunchers laeuft; aussen bleiben
Dateiscopes, Netzisolation und private Sockets.

Die Anmeldung wird ausschliesslich im Controller/Modellproxy gelesen. Der Zug sieht nur
einen bedeutungslosen Platzhalter; seine Dateigrenze und Netzsperre setzt der LinuxLauncher.
"""
from __future__ import annotations

import json
import base64
import binascii
import fcntl
import os
import re
import stat
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from agents_claude import ClaudeAdapterFehler, StreamBefund, ZUG_UMGEBUNG
from agents_worktree import git_env_erlaubt

RUNNER = "agents_codex_runner.py"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
AUTH_LIMIT = 64 * 1024
_MODEL = re.compile(r"[A-Za-z0-9._:/-]{1,256}\Z")
_REFRESH_LOCK = threading.Lock()


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
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > AUTH_LIMIT
                or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600):
            return dict(result, reason="keine_regulaere_datei")
        try:
            fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(fd)
                if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid()
                        or stat.S_IMODE(opened.st_mode) != 0o600 or opened.st_size > AUTH_LIMIT):
                    return dict(result, reason="keine_regulaere_datei")
                data = json.loads(os.read(fd, AUTH_LIMIT + 1))
            finally:
                os.close(fd)
        except (OSError, ValueError):
            return dict(result, reason="unlesbar")
        tokens = data.get("tokens") if isinstance(data, dict) else None
        if not (isinstance(tokens, dict) and isinstance(tokens.get("access_token"), str)
                and tokens["access_token"]):
            return dict(result, reason="ohne_anmeldung")
        try:
            claim = tokens["access_token"].split(".")[1]
            jwt = json.loads(base64.urlsafe_b64decode(claim + "=" * (-len(claim) % 4)))
            claims = jwt.get("https://api.openai.com/auth")
            if not isinstance(claims.get("chatgpt_account_id"), str) or not claims["chatgpt_account_id"]:
                return dict(result, reason="ohne_konto")
            if int(jwt["exp"]) <= time.time() + 30:
                return dict(result, reason="abgelaufen")
        except (IndexError, ValueError, TypeError, KeyError, AttributeError, binascii.Error):
            return dict(result, reason="ungueltiges_token")
        return dict(result, available=True)

    def auth_headers(self, cli: str | None = None) -> tuple[tuple[str, str], ...]:
        """Liest Token nur im Hostprozess; Rueckgabe darf nie protokolliert werden."""
        def lesen():
            fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > AUTH_LIMIT):
                    raise ValueError("Codex-Anmeldung nicht verfuegbar")
                data = json.loads(os.read(fd, AUTH_LIMIT + 1))
            finally:
                os.close(fd)
            if not isinstance(data, dict):
                raise ValueError("Codex-Anmeldung nicht verfuegbar")
            tokens = data.get("tokens")
            token = tokens.get("access_token") if isinstance(tokens, dict) else None
            if not isinstance(token, str) or not token or "\r" in token or "\n" in token:
                raise ValueError("Codex-Zug braucht ein gueltiges Abo-Token")
            claim = token.split(".")[1]
            claim += "=" * (-len(claim) % 4)
            jwt = json.loads(base64.urlsafe_b64decode(claim))
            claims = jwt.get("https://api.openai.com/auth") if isinstance(jwt, dict) else None
            account = claims.get("chatgpt_account_id") if isinstance(claims, dict) else None
            return token, account, int(jwt["exp"])
        try:
            token, account, expiry = lesen()
            if expiry <= time.time() + 30 and cli is not None:
                # Expliziter CLI-Pfad ist nur fuer die isolierte Refresh-Probe vorgesehen.
                # Der produktive Proxy ruft auth_headers() ohne CLI auf, bis der CLI-Weg belegt ist.
                with _REFRESH_LOCK:
                    lock_path = self.path.with_name(self.path.name + ".refresh.lock")
                    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
                    try:
                        info = os.fstat(fd)
                        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() \
                                or stat.S_IMODE(info.st_mode) != 0o600:
                            raise ValueError("Codex-Refreshsperre ungueltig")
                        deadline = time.monotonic() + 75
                        while True:
                            try:
                                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                                break
                            except BlockingIOError:
                                if time.monotonic() >= deadline:
                                    raise ValueError("Codex-Refreshsperre Zeitlimit") from None
                                time.sleep(0.05)
                        token, account, expiry = lesen()
                        if expiry <= time.time() + 30:
                            subprocess.run([cli, "debug", "models"], stdin=subprocess.DEVNULL,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60,
                                           env={"CODEX_HOME": str(self.path.parent), "PATH": "/usr/bin:/bin",
                                                "BROWSER": "/usr/bin/true"}, check=False)
                            token, account, expiry = lesen()
                    finally:
                        os.close(fd)
            if not isinstance(account, str) or not account or expiry <= time.time() + 30:
                raise ValueError
        except (IndexError, ValueError, TypeError, KeyError, OSError, binascii.Error,
                subprocess.TimeoutExpired):
            raise ValueError("Codex-Abo-Token abgelaufen oder ohne Konto") from None
        return (("Authorization", "Bearer " + token), ("ChatGPT-Account-ID", account))


def codex_befund(data: bytes, session_id: str) -> StreamBefund:
    """Codex-JSONL nur bei genau einem abgeschlossenen Turn als Erfolg werten."""
    if not data:
        return StreamBefund("empty", "keine Ausgabe", session_id=session_id)
    if not data.endswith(b"\n"):
        return StreamBefund("truncated", "letzte Zeile ohne Abschluss", session_id=session_id)
    try:
        events = [json.loads(line) for line in data.splitlines() if line.strip()]
    except (UnicodeDecodeError, ValueError):
        return StreamBefund("unclear", "unlesbares Codex-Ereignis", session_id=session_id)
    if not events or any(not isinstance(e, dict) or not isinstance(e.get("type"), str) for e in events):
        return StreamBefund("unclear", "ungueltiger Codex-Stream", session_id=session_id)
    starts = [e for e in events if e["type"] == "thread.started"]
    turns = [e for e in events if e["type"] in {"turn.completed", "turn.failed"}]
    tools = tuple(str((e.get("item") or {}).get("type")) for e in events
                  if e["type"] == "item.completed" and isinstance(e.get("item"), dict)
                  and (e["item"].get("type") or "").endswith("execution"))
    base = dict(session_id=session_id, events=len(events), tool_uses=tools)
    if len(starts) != 1 or not isinstance(starts[0].get("thread_id"), str):
        return StreamBefund("unclear", "Codex-Thread fehlt oder wechselt", **base)
    if len(turns) != 1 or events[-1] is not turns[0]:
        return StreamBefund("truncated", "Codex-Turn ohne eindeutiges Ende", **base)
    if turns[0]["type"] == "turn.failed":
        return StreamBefund("harness_error", "Codex meldet Turn-Fehler", **base)
    return StreamBefund("completed", "Codex-Turn abgeschlossen", **base)


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
    web_enabled: bool = False
    # Codex-Sperre aktiv (agents_codex_sperre): der Runner schaltet Code-Modus, Hooks, Plugins und Apps ab.
    sperre: bool = False
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
        if type(self.web_enabled) is not bool:
            raise ClaudeAdapterFehler("Codex-Webrecht muss boolesch sein")
        if type(self.sperre) is not bool:
            raise ClaudeAdapterFehler("Codex-Sperre muss boolesch sein")
        if self.append_system_prompt_file is not None and not Path(self.append_system_prompt_file).is_absolute():
            raise ClaudeAdapterFehler("Anweisungsdatei des Zuges braucht einen absoluten Pfad")
        for name, value in self.extra_env:
            # Wie beim Pi-Zug: die Git-Namen des Traegers geben dem Zug die Identitaet des Menschen im Worktree.
            if (name not in ZUG_UMGEBUNG and not git_env_erlaubt(name)) or not isinstance(value, str) \
                    or "\x00" in value or len(value) > 4096:
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
            "web_enabled": self.web_enabled, "sperre": self.sperre,
        }


__all__ = ["CodexAnmeldung", "CodexZug", "EFFORTS", "RUNNER", "codex_eintrag", "codex_befund"]
