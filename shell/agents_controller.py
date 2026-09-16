#!/usr/bin/env python3
"""Run-bound socketpair controller for the Agents data channel.

This module deliberately has no listener, CLI, subprocess, or human endpoint.
The controller owns the world and binding; a client owns only one connected
socket and can invoke the typed operations below.
"""

from __future__ import annotations

import json
import socket
import struct
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import agents_data as ad


MAX_FRAME = 64 * 1024
DEFAULT_IO_TIMEOUT = 1.0
DEFAULT_SESSION_TIMEOUT = 300.0


class ControllerError(Exception):
    """Expected protocol, binding, or data operation error."""


class _BindingExpired(ControllerError):
    """Fatal error: this socket must not serve another request."""


@dataclass(frozen=True)
class AgentBinding:
    """Immutable identity selected by the controller, never by the client."""

    world_root: Path
    world_id: str
    agent_id: str
    role: str
    run_id: str


_FIELD_TYPES: dict[str, dict[str, tuple[str, bool]]] = {
    "inbox.read": {},
    "inbox.ack": {"delivery_id": ("str", True)},
    "message.send": {
        "recipients": ("str_list", True), "text": ("str", True),
        "ticket_id": ("str", False), "message_id": ("str", True),
        "direct": ("bool", False), "mark": ("str", False),
    },
    "ticket.show": {"ticket_id": ("str", True)},
    "ticket.claim": {"ticket_id": ("str", True)},
    "ticket.result": {
        "ticket_id": ("str", True), "text": ("str", True),
        "commit": ("str", False),
    },
    "message.reply": {
        "delivery_id": ("str", True), "text": ("str", True), "message_id": ("str", True),
        "mark": ("str", False),
    },
    "agent.create": {"draft": ("object", True)},
    "agent.request": {"draft": ("object", True), "request_id": ("str", True)},
    "agent.decide": {"request_id": ("str", True), "accept": ("bool", True), "note": ("str", False)},
    "agent.rechte": {
        "agent_id": ("str", True), "tools": ("str_list", False), "bash": ("str_list", False),
        "skills": ("str_list", False), "web": ("bool", False),
    },
    "question.ask": {
        "text": ("str", True), "question_id": ("str", True),
        "options": ("str_list", False), "recommendation": ("str", False),
        "ticket_id": ("str", False),
    },
}
OPERATIONS = frozenset(_FIELD_TYPES)


def _report_created_agent(root: Path, binding: AgentBinding, agent: dict[str, Any]) -> str | None:
    """A main agent that creates an agent tells the world's human with a marked result."""
    if binding.role != "hauptagent":
        return None
    profile = agent.get("model_profile") or {}
    stage = {"mitglied": "Mitglied", "teamleiter": "Teamleiter", "hauptagent": "Hauptagent"}.get(agent.get("stage"),
                                                                                             agent.get("stage"))
    text = "Agent %s angelegt, Rolle %s%s, Modell %s (Denkstufe %s), Maschine %s. %s" % (
        agent["id"], stage, " im Team %s" % agent["team"] if agent.get("team") else "", profile.get("model"),
        profile.get("effort"), agent.get("machine"), ad.rights_summary(agent))
    message_id = ad.derived_id("agent-angelegt", agent["id"])
    ad.send_marked_message(root, binding.agent_id, [ad.WORLD_HUMAN], text, "ergebnis", None, message_id, binding.role)
    return message_id


def _report_rights(root: Path, binding: AgentBinding, before: dict[str, Any], agent: dict[str, Any]) -> str | None:
    """A main agent that changes an agent's rights tells the world's human, like a creation."""
    if binding.role != "hauptagent" or all(before.get(key) == agent.get(key) for key in ("tools", "bash", "skills")):
        return None
    text = "Rechte von %s geändert durch %s. %s" % (agent["id"], binding.agent_id, ad.rights_summary(agent))
    message_id = ad.derived_id("agent-rechte", agent["id"], agent.get("rights_revision") or 0)
    ad.send_marked_message(root, binding.agent_id, [ad.WORLD_HUMAN], text, "ergebnis", None, message_id, binding.role)
    return message_id


def _type_matches(value: Any, kind: str) -> bool:
    if kind == "str":
        return isinstance(value, str)
    if kind == "bool":
        return isinstance(value, bool)
    if kind == "str_list":
        return isinstance(value, list) and all(isinstance(item, str) for item in value)
    if kind == "object":
        return isinstance(value, dict)
    raise ControllerError("Unbekannter Payloadtyp")


def _validate_request(value: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != {"op", "payload"}:
        raise ControllerError("Anfrage braucht genau op und payload")
    operation = value["op"]
    payload = value["payload"]
    if not isinstance(operation, str):
        raise ControllerError("Operation muss eine Zeichenkette sein")
    if operation not in OPERATIONS:
        raise ControllerError("Operation nicht erlaubt")
    if not isinstance(payload, dict):
        raise ControllerError("Payload muss ein Objekt sein")
    fields = _FIELD_TYPES[operation]
    unknown = set(payload) - set(fields)
    if unknown:
        raise ControllerError("Unbekannte Payloadfelder: %s" % ", ".join(sorted(unknown)))
    for name, (kind, required) in fields.items():
        if required and name not in payload:
            raise ControllerError("Payloadfeld fehlt: %s" % name)
        if name in payload and not _type_matches(payload[name], kind):
            raise ControllerError("Payloadfeld hat falschen Typ: %s" % name)
    return operation, dict(payload)


def _send_frame(sock: socket.socket, value: Any) -> None:
    try:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ControllerError("Antwort ist nicht JSON-faehig") from exc
    if not body or len(body) > MAX_FRAME:
        raise ControllerError("Frame ist zu gross")
    try:
        sock.sendall(struct.pack("!I", len(body)) + body)
    except (socket.timeout, BrokenPipeError, ConnectionError, OSError) as exc:
        raise ControllerError("Verbindung konnte nicht beschrieben werden") from exc


def _recv_exact(sock: socket.socket, length: int, deadline: float | None = None) -> bytes:
    result = bytearray()
    while len(result) < length:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ControllerError("Zeitlimit beim Lesen der Verbindung")
            try:
                sock.settimeout(remaining)
            except OSError as exc:
                raise ControllerError("Verbindung konnte nicht gelesen werden") from exc
        try:
            part = sock.recv(length - len(result))
        except socket.timeout as exc:
            raise ControllerError("Zeitlimit beim Lesen der Verbindung") from exc
        except (ConnectionError, OSError) as exc:
            raise ControllerError("Verbindung konnte nicht gelesen werden") from exc
        if not part:
            raise ControllerError("Verbindung getrennt")
        result.extend(part)
    return bytes(result)


def _recv_frame(sock: socket.socket, idle_deadline: float | None = None,
                frame_timeout: float = DEFAULT_IO_TIMEOUT) -> Any:
    previous_timeout = sock.gettimeout()

    def restore_timeout() -> None:
        try:
            sock.settimeout(previous_timeout)
        except OSError:
            pass

    try:
        first = _recv_exact(sock, 1, idle_deadline)
        frame_deadline = time.monotonic() + frame_timeout
        header = first + _recv_exact(sock, 3, frame_deadline)
    finally:
        restore_timeout()
    length = struct.unpack("!I", header)[0]
    if length == 0 or length > MAX_FRAME:
        raise ControllerError("Framegroesse ungueltig")
    try:
        body = _recv_exact(sock, length, frame_deadline)
    finally:
        restore_timeout()
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ControllerError("Frame enthaelt kein gueltiges JSON") from exc


def _read_inbox(binding: AgentBinding) -> list[dict[str, Any]]:
    folder = ad._agent_dir(binding.world_root, binding.agent_id) / "postfach"
    ad._reject_symlink(folder, "Postfach")
    if not folder.exists():
        return []
    if folder.is_symlink() or not folder.is_dir():
        raise ControllerError("Eigenes Postfach ist ungueltig")
    result: list[dict[str, Any]] = []
    for path in sorted(folder.iterdir()):
        ad._reject_symlink(path, "Postfachdatei")
        if path.is_symlink():
            raise ControllerError("Eigenes Postfach enthaelt einen Symlink")
        if path.is_file() and path.suffix == ".json":
            item = ad._read_json(path)
            if item.get("recipient") != binding.agent_id:
                raise ControllerError("Postfach enthaelt fremde Zustellung")
            result.append(item)
    return result


class AgentClient:
    """Client side of one socketpair; it carries no identity fields."""

    def __init__(self, sock: socket.socket, timeout: float):
        self._sock = sock
        self._sock.settimeout(timeout)
        self._lock = threading.Lock()
        self._closed = False

    def request(self, operation: str, payload: dict[str, Any] | None = None) -> Any:
        if not isinstance(operation, str) or operation not in OPERATIONS:
            raise ControllerError("Operation nicht erlaubt")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ControllerError("Payload muss ein Objekt sein")
        request = {"op": operation, "payload": payload}
        with self._lock:
            if self._closed:
                raise ControllerError("Client ist geschlossen")
            try:
                _send_frame(self._sock, request)
                response = _recv_frame(self._sock)
            except ControllerError:
                self.close()
                raise
        if not isinstance(response, dict) or set(response) not in ({"ok", "data"}, {"ok", "error"}):
            self.close()
            raise ControllerError("Ungueltige Controllerantwort")
        if response.get("ok") is True:
            return response["data"]
        raise ControllerError(str(response.get("error", "Controllerfehler")))

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._sock.close()


@dataclass
class _Session:
    server_socket: socket.socket
    client: AgentClient
    thread: threading.Thread


class AgentController:
    """Controller-owned run-bound service over private socketpairs."""

    def __init__(self, world_root: Path, run_id: str,
                 current_run_checker: Callable[[AgentBinding], bool] | None,
                 io_timeout: float = DEFAULT_IO_TIMEOUT,
                 session_timeout: float = DEFAULT_SESSION_TIMEOUT):
        if current_run_checker is not None and not callable(current_run_checker):
            raise ControllerError("current-run-Pruefer muss aufrufbar sein")
        if io_timeout <= 0:
            raise ControllerError("I/O-Zeitlimit muss positiv sein")
        if session_timeout <= 0:
            raise ControllerError("Session-Zeitlimit muss positiv sein")
        self._world_root = ad.world_path(str(world_root))
        world = ad.read_world(self._world_root)
        self._world_id = ad.valid_id(world["id"], "Weltkennung")
        self._run_id = ad.valid_id(run_id, "Laufkennung")
        self._checker = current_run_checker
        self._timeout = io_timeout
        self._session_timeout = session_timeout
        self._sessions: list[_Session] = []
        self._closed = False
        self._lock = threading.Lock()

    def bind_agent(self, agent_id: str, role: str) -> AgentClient:
        if self._closed:
            raise ControllerError("Controller ist geschlossen")
        agent_id = ad.valid_id(agent_id, "Agentenkennung")
        if role not in ad.STAGES:
            raise ControllerError("Rolle ungueltig")
        agent = ad.read_agent(self._world_root, agent_id)
        if agent.get("stage") != role:
            raise ControllerError("Rolle passt nicht zum gespeicherten Agentenprofil")
        binding = AgentBinding(self._world_root, self._world_id, agent_id, role, self._run_id)
        server_socket, client_socket = socket.socketpair()
        server_socket.set_inheritable(False)
        client_socket.set_inheritable(False)
        client = AgentClient(client_socket, self._timeout)
        deadline = time.monotonic() + self._session_timeout
        thread = threading.Thread(target=self._serve, args=(server_socket, binding, deadline),
                                  name="agents-controller", daemon=False)
        session = _Session(server_socket, client, thread)
        with self._lock:
            if self._closed:
                client.close()
                server_socket.close()
                raise ControllerError("Controller ist geschlossen")
            # A long-lived controller must not retain every completed connection.
            # Callers still own their AgentClient; only finished service records go.
            self._sessions = [existing for existing in self._sessions if existing.thread.is_alive()]
            self._sessions.append(session)
            try:
                thread.start()
            except RuntimeError as exc:
                self._sessions.remove(session)
                client.close()
                server_socket.close()
                raise ControllerError("Controllerdienst konnte nicht starten") from exc
        return client

    def _authorize(self, binding: AgentBinding) -> None:
        if self._checker is None:
            raise _BindingExpired("Kein current-run-Pruefer eingespeist")
        try:
            current = bool(self._checker(binding))
        except Exception as exc:
            raise _BindingExpired("current-run-Pruefung fehlgeschlagen") from exc
        if not current:
            raise _BindingExpired("Laufbindung ist nicht mehr gueltig")
        world = ad.read_world(binding.world_root)
        if world.get("id") != binding.world_id:
            raise _BindingExpired("Weltbindung ist nicht mehr gueltig")
        agent = ad.read_agent(binding.world_root, binding.agent_id)
        if agent.get("stage") != binding.role:
            raise _BindingExpired("Agentenbindung ist nicht mehr gueltig")

    def _dispatch(self, binding: AgentBinding, operation: str,
                  payload: dict[str, Any]) -> Any:
        self._authorize(binding)
        operation, payload = _validate_request({"op": operation, "payload": payload})
        root = binding.world_root
        if operation == "inbox.read":
            return _read_inbox(binding)
        if operation == "inbox.ack":
            return ad.acknowledge(root, binding.agent_id, payload["delivery_id"],
                                  binding.agent_id, binding.role)
        if operation == "message.send":
            if "mark" in payload:
                # Die Datenschicht prueft: nur an den Menschen, frage nur vom Hauptagenten.
                return ad.send_marked_message(root, binding.agent_id, payload["recipients"], payload["text"],
                                              payload["mark"], payload.get("ticket_id"), payload.get("message_id"),
                                              binding.role, payload.get("direct", False))
            return ad.send_message(root, binding.agent_id, payload["recipients"], payload["text"],
                                   payload.get("ticket_id"), payload.get("message_id"),
                                   binding.role, payload.get("direct", False))
        if operation == "ticket.show":
            return ad.read_ticket(root, payload["ticket_id"])
        if operation == "ticket.claim":
            return ad.claim_ticket(root, payload["ticket_id"], binding.agent_id,
                                   binding.agent_id, binding.role)
        if operation == "ticket.result":
            return ad.write_result(root, payload["ticket_id"], binding.agent_id,
                                   payload["text"], payload.get("commit"),
                                   binding.agent_id, binding.role)
        if operation == "message.reply":
            return ad.reply_to_delivery(root, binding.agent_id, payload["delivery_id"], payload["text"],
                                        payload["message_id"], payload.get("mark"))
        if operation == "agent.create":
            agent = ad.create_agent_from_draft(root, payload["draft"], binding.agent_id, binding.role)
            return dict(agent, meldung=_report_created_agent(root, binding, agent))
        if operation == "agent.request":
            return ad.request_agent(root, payload["draft"], binding.agent_id, binding.role, payload["request_id"])
        if operation == "agent.decide":
            question = ad.decide_agent_request(root, payload["request_id"], payload["accept"], payload.get("note"),
                                               binding.agent_id, binding.role)
            created = (question.get("answer") or {}).get("agent")
            if created:
                question = dict(question, meldung=_report_created_agent(root, binding, ad.read_agent(root, created)))
            return question
        if operation == "agent.rechte":
            before = ad.read_agent(root, payload["agent_id"])
            changes = {key: payload[key] for key in ad.RIGHTS_FIELDS if key in payload}
            agent = ad.set_agent_rights(root, payload["agent_id"], changes, binding.agent_id, binding.role)
            return dict(agent, meldung=_report_rights(root, binding, before, agent))
        if operation == "question.ask":
            return ad.ask_question(root, payload["text"], payload.get("options", []),
                                   payload.get("recommendation"), payload.get("ticket_id"),
                                   payload.get("question_id"), binding.agent_id, binding.role)
        raise ControllerError("Operation nicht erlaubt")

    def _serve(self, sock: socket.socket, binding: AgentBinding, session_deadline: float) -> None:
        sock.settimeout(self._timeout)
        try:
            while True:
                try:
                    request = _recv_frame(sock, session_deadline, self._timeout)
                    operation, payload = _validate_request(request)
                    data = self._dispatch(binding, operation, payload)
                    _send_frame(sock, {"ok": True, "data": data})
                except ControllerError as exc:
                    try:
                        _send_frame(sock, {"ok": False, "error": str(exc)})
                    except ControllerError:
                        return
                    if isinstance(exc, _BindingExpired):
                        return
                    if str(exc) in {"Verbindung getrennt", "Zeitlimit beim Lesen der Verbindung",
                                    "Framegroesse ungueltig"}:
                        return
                except (ad.AgentsError, OSError, ValueError) as exc:
                    try:
                        _send_frame(sock, {"ok": False, "error": str(exc)})
                    except ControllerError:
                        return
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def close(self) -> None:
        with self._lock:
            self._closed = True
            sessions = list(self._sessions)
        for session in sessions:
            session.client.close()
            try:
                session.server_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            session.server_socket.close()

    def join(self, timeout: float = 5.0) -> None:
        if timeout < 0:
            raise ControllerError("Join-Zeitlimit ungueltig")
        with self._lock:
            sessions = list(self._sessions)
        for session in sessions:
            session.thread.join(timeout)
            if session.thread.is_alive():
                raise ControllerError("Controllerdienst beendet sich nicht innerhalb des Zeitlimits")
