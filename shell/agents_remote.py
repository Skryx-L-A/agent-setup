"""Gebundene Einmal-RPCs über SSH; keine dauerhaft pollende Fernverbindung.

Nur der vertrauenswürdige Controller verwendet diesen Kanal. Agenten erhalten
weder SSH-Zugang noch diese Schnittstelle. Die serverseitigen Handler erzeugen
Startdaten aus eigenen Profilen; eine Anfrage enthält keine Shellkommandos.
"""
from __future__ import annotations

from dataclasses import dataclass
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import time
from typing import Any, Callable

import atomar_schreiben

MAX_MESSAGE = 256 * 1024
OPERATIONS = frozenset({"status", "start", "pause", "resume", "stop"})
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


class RemoteError(Exception):
    pass


class OutcomeUnknown(RemoteError):
    """Kein bestätigtes Ergebnis; niemals als erneuten Start behandeln."""


def encode(value: Any) -> bytes:
    data = json.dumps(value, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":"), sort_keys=True).encode()
    if len(data) > MAX_MESSAGE:
        raise RemoteError("Nachricht zu groß")
    return data


def identifier(value: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise RemoteError("Ungültige Kennung")
    return value


@dataclass(frozen=True)
class HostBinding:
    host_id: str
    world_id: str
    ssh_target: str
    endpoint: str
    config: str
    run_as: str | None = None

    def __post_init__(self) -> None:
        identifier(self.host_id)
        identifier(self.world_id)
        if self.run_as is not None:
            identifier(self.run_as)
            if self.run_as == "root":
                raise RemoteError("Remote-Controller darf nicht als root laufen")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*", self.ssh_target):
            raise RemoteError("Ungültiges SSH-Ziel")
        for path in (self.endpoint, self.config):
            if not path.startswith("/") or any(c in path for c in "\x00\n\r"):
                raise RemoteError("Endpoint und Konfiguration brauchen absolute Pfade")


class SSHTransport:
    def __init__(self, binding: HostBinding, *, timeout: float = 30):
        if not math.isfinite(timeout) or timeout <= 0 or timeout > 300:
            raise ValueError("Zeitlimit muss zwischen 0 und 300 Sekunden liegen")
        self.binding = binding
        self.timeout = timeout

    def call(self, request_id: str, operation: str, agent_id: str,
             run_id: str | None = None) -> Any:
        request = make_request(self.binding.host_id, self.binding.world_id,
                               request_id, operation, agent_id, run_id)
        remote_argv = ["/usr/bin/python3", "-I", self.binding.endpoint,
                       "--config", self.binding.config]
        if self.binding.run_as is not None:
            remote_argv = ["/usr/sbin/runuser", "-u", self.binding.run_as, "--", *remote_argv]
        command = shlex.join(remote_argv)
        argv = ["ssh", "-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes",
                "-oConnectTimeout=8", "-oServerAliveInterval=5", "-oServerAliveCountMax=2",
                "-oForwardAgent=no", "-oClearAllForwardings=yes", "-oControlMaster=no",
                "-oControlPath=none", self.binding.ssh_target, command]
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            try:
                result = subprocess.run(argv, input=encode(request), stdout=output,
                                        stderr=errors, timeout=self.timeout, check=False,
                                        close_fds=True)
            except (subprocess.TimeoutExpired, OSError) as exc:
                raise OutcomeUnknown("SSH unterbrochen; Ausgang bleibt unbekannt") from exc
            output.seek(0, os.SEEK_END)
            if result.returncode or output.tell() > MAX_MESSAGE:
                raise OutcomeUnknown("Keine gültige SSH-Antwort; Ausgang bleibt unbekannt")
            output.seek(0)
            try:
                response = json.loads(output.read())
            except (ValueError, UnicodeError) as exc:
                raise OutcomeUnknown("Unlesbare SSH-Antwort") from exc
        if (not isinstance(response, dict) or response.get("request") != request or
                set(response) != {"request", "state", "result"}):
            raise OutcomeUnknown("Antwort passt nicht zur gebundenen Anfrage")
        if response["state"] != "done":
            raise OutcomeUnknown("Remote-Ausgang nicht bestätigt")
        return response["result"]


def make_request(host: str, world: str, request_id: str, operation: str,
                 agent: str, run_id: str | None = None) -> dict:
    if operation not in OPERATIONS:
        raise RemoteError("Operation nicht erlaubt")
    if operation != "status" and run_id is None:
        raise RemoteError("Steuerung braucht eine unveränderliche Laufkennung")
    if operation == "status" and run_id is not None:
        raise RemoteError("Status nimmt keine Laufkennung entgegen")
    return {"host": identifier(host), "world": identifier(world),
            "id": identifier(request_id), "op": operation,
            "agent": identifier(agent), "run": identifier(run_id) if run_id else None}


class RemoteDispatcher:
    """Serverseitige Bindung und persistente Quittierung über SSH-Neustarts hinweg.

    Register und Handler liegen außerhalb aller Agenten-Schreibbereiche. Ein
    stehengebliebener Claim wird nie automatisch erneut ausgeführt. Status ist
    mit neuer Anfragekennung lesbar und hilft bei einer gezielten Klärung.
    """
    def __init__(self, host_id: str, world_id: str, ledger: Path,
                 handlers: dict[str, Callable[[str, str | None], Any]]):
        self.host = identifier(host_id)
        self.world = identifier(world_id)
        self.ledger = Path(ledger)
        self.handlers = dict(handlers)
        if set(self.handlers) != OPERATIONS:
            raise RemoteError("Vollständige feste Handlerliste erforderlich")
        self.ledger.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def dispatch(self, request: Any) -> dict:
        if not isinstance(request, dict) or set(request) != {"host", "world", "id", "op", "agent", "run"}:
            raise RemoteError("Ungültige Anfragefelder")
        canonical = make_request(request["host"], request["world"], request["id"],
                                 request["op"], request["agent"], request["run"])
        encode(canonical)
        if canonical["host"] != self.host or canonical["world"] != self.world:
            raise RemoteError("Anfrage gehört zu einer anderen Maschine oder Welt")
        digest = hashlib.sha256(encode(canonical)).hexdigest()
        with self.ledger.with_suffix(self.ledger.suffix + ".lock").open("a+") as lock:
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise OutcomeUnknown("Controller ist beschäftigt")
                    time.sleep(0.025)
            state = json.loads(self.ledger.read_text()) if self.ledger.exists() else {}
            previous = state.get(canonical["id"])
            if previous is not None:
                if previous["digest"] != digest:
                    raise RemoteError("Anfragekennung wurde mit anderem Inhalt wiederverwendet")
                return previous["response"]
            response = {"request": canonical, "state": "unknown", "result": None}
            state[canonical["id"]] = {"digest": digest, "response": response}
            self._save(state)
            # Der Claim wird vor dem Handler dauerhaft geschrieben. Auch ein
            # Prozessabbruch während der Ausführung erlaubt keine Wiederholung.
            result = self.handlers[canonical["op"]](canonical["agent"], canonical["run"])
            response = {"request": canonical, "state": "done", "result": result}
            encode(response)
            state[canonical["id"]]["response"] = response
            self._save(state)
            return response

    def _save(self, state: dict) -> None:
        atomar_schreiben.schreiben(self.ledger, json.dumps(state, ensure_ascii=False, allow_nan=False),
                                  modus=0o600, dauerhaft=True)
