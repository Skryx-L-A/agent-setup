#!/usr/bin/env python3
"""Persistent file data model for the independent Agents feature.

The module deliberately contains no process, tmux, network, or harness code.
It stores one world per project (or a standalone global-world directory), and
offers the small transaction API used by wb-welt, wb-agent, wb-ticket and
wb-kanal.  ``--absender`` and ``--rolle`` are caller supplied metadata only;
they are never treated as proof of identity.  A future governance adapter can
reject the same mutation before calling this module.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

try:
    import atomar_schreiben
except ImportError:  # pragma: no cover - useful when called from another cwd
    atomar_schreiben = None


SCHEMA_VERSION = 1
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
STAGES = ("hauptagent", "teamleiter", "mitglied")
TICKET_STATES = ("offen", "läuft", "wartet", "braucht dich", "zur Abnahme",
                 "abgenommen", "zurückgegeben", "verworfen", "unterbrochen")
WORLD_STATES = ("läuft", "pausiert", "gestoppt")
AGENT_STATES = ("aktiv", "pausiert", "gestoppt", "archiviert")
HUMAN_ACTORS = {"mensch", "person-1", "companion", "orchestrator", "cli-operator"}
# The one human of a world who can be addressed: messages to this identity land
# in `menschen/<id>/postfach/` and never wake anybody.
WORLD_HUMAN = "mensch"
MESSAGE_MARKS = ("frage", "ergebnis")
PROFILE_FIELDS = ("model", "effort", "fallback_model", "fallback_effort", "machine", "specialty")
MEMORY_WRITE_LIMIT = 1024 * 1024
READ_KEY_RE = re.compile(r"^(kanal|einzel:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|direkt:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$")


class AgentsError(Exception):
    """Expected user-facing validation or state error."""


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return "%s-%s" % (prefix, uuid.uuid4().hex[:20])


def derived_id(prefix: str, *parts: object) -> str:
    """Build a structurally unambiguous derived ID within the 64-char limit."""
    values = [str(part) for part in parts]
    candidate = prefix + "-" + "-".join("%d_%s" % (len(value), value) for value in values)
    if ID_RE.fullmatch(candidate):
        return candidate
    canonical = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return prefix + "-" + digest[:64 - len(prefix) - 1]


def valid_id(value: str, label: str = "Kennung") -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise AgentsError("%s ist ungueltig (nur Buchstaben, Zahlen, '.', '_' und '-' erlaubt)" % label)
    return value


def _reject_symlink(path: Path, label: str) -> None:
    """Reject symlink components below an already selected world root."""
    current = path
    while current != current.parent and not current.exists():
        current = current.parent
    if current.is_symlink() or current.parent.is_symlink():
        raise AgentsError("%s darf keine Symlink-Komponente enthalten" % label)


def world_path(raw: str) -> Path:
    if not raw:
        raise AgentsError("Weltpfad fehlt")
    path = Path(os.path.abspath(os.path.expanduser(raw)))
    _reject_symlink(path, "Weltpfad")
    return path


def child(root: Path, *parts: str) -> Path:
    """Resolve a validated relative child and reject traversal/symlinks."""
    for part in parts:
        valid_id(part, "Pfadbestandteil")
    target = root.joinpath(*parts)
    try:
        target.relative_to(root)
    except ValueError as exc:  # defensive, validation above should already catch it
        raise AgentsError("Pfad liegt ausserhalb der Welt") from exc
    _reject_symlink(target, "Pfad")
    if target.exists() and target.is_symlink():
        raise AgentsError("Pfad darf kein Symlink sein")
    return target


def _write_json(path: Path, data: Any) -> None:
    _reject_symlink(path, "Zieldatei")
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if atomar_schreiben is not None:
        atomar_schreiben.schreiben(str(path), text, modus=0o600, dauerhaft=True)
        return
    tmp = path.with_name(".%s.tmp-%s" % (path.name, uuid.uuid4().hex))
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(tmp), str(path))
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        with path.open(encoding="utf-8") as stream:
            return json.load(stream)
    except FileNotFoundError:
        if default is not None:
            return default
        raise AgentsError("Datei fehlt: %s" % path)
    except json.JSONDecodeError as exc:
        raise AgentsError("JSON unlesbar: %s" % path) from exc


def _append_jsonl(path: Path, data: dict[str, Any]) -> None:
    _reject_symlink(path, "Zieldatei")
    path.parent.mkdir(parents=True, exist_ok=True)
    # The world lock serializes this append.  fsync makes a successful
    # acknowledgement durable before it is returned to the caller.
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(data, ensure_ascii=False, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _repair_channel_tail(root: Path) -> None:
    """Drop only an unterminated final JSONL fragment left by a crash."""
    path = root / "kanal.jsonl"
    if path.is_symlink():
        raise AgentsError("Kanaldatei darf kein Symlink sein")
    if not path.exists():
        return
    raw = path.read_bytes()
    if not raw or raw.endswith((b"\n", b"\r")):
        return
    tail = raw[raw.rfind(b"\n") + 1:]
    try:
        json.loads(tail.decode("utf-8"))
        keep = raw + b"\n"
    except (UnicodeDecodeError, json.JSONDecodeError):
        keep = raw[:raw.rfind(b"\n") + 1]
    if keep != raw:
        tmp = path.with_name(".%s.repair-%s" % (path.name, uuid.uuid4().hex))
        try:
            with tmp.open("wb") as stream:
                stream.write(keep)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(str(tmp), str(path))
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass


@contextmanager
def transaction(root: Path):
    root = world_path(str(root))
    if not root.is_dir():
        raise AgentsError("Welt ist kein Verzeichnis: %s" % root)
    lock_path = root / ".agents.lock"
    if lock_path.is_symlink():
        raise AgentsError("Transaktionssperre darf kein Symlink sein")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            _repair_channel_tail(root)
            _recover_pending(root)
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def world_file(root: Path) -> Path:
    return root / "world.json"


def read_world(root: Path) -> dict[str, Any]:
    root = world_path(str(root))
    path = world_file(root)
    if path.is_symlink():
        raise AgentsError("Weltdatei darf kein Symlink sein")
    data = _read_json(path)
    if data.get("schema_version") != SCHEMA_VERSION:
        raise AgentsError("Unbekannte Welt-Schema-Version")
    return data


def _world_dirs(root: Path) -> None:
    for name in ("agents", "tickets", "questions", "postfach", "direktchats"):
        path = root / name
        if path.is_symlink():
            raise AgentsError("Weltordner darf keine Symlink-Unterordner enthalten")
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir():
            raise AgentsError("Weltordner ist kein Verzeichnis: %s" % path)
    kanal = root / "kanal.jsonl"
    if kanal.is_symlink():
        raise AgentsError("Kanaldatei darf kein Symlink sein")
    kanal.touch(exist_ok=True)


def _slug(text: str, prefix: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", (text or "").strip()).strip("-._")
    return (value[:48] or prefix).lower()


def _model(model: str | None, effort: str | None, fallback: str | None,
           fallback_effort: str | None) -> dict[str, Any]:
    primary = model or "opus5:xhigh"
    fb = fallback
    if "fable" in primary.lower() or (fb and "fable" in fb.lower()):
        raise AgentsError("Fable ist fuer Agents verboten, auch als Fallback")
    if not effort:
        effort = primary.rsplit(":", 1)[1] if ":" in primary else "medium"
    if fb and not fallback_effort:
        fallback_effort = fb.rsplit(":", 1)[1] if ":" in fb else "medium"
    if effort not in {"low", "medium", "high", "xhigh"}:
        raise AgentsError("Denkstufe muss low, medium, high oder xhigh sein")
    if fb and fallback_effort not in {"low", "medium", "high", "xhigh"}:
        raise AgentsError("Fallback-Denkstufe muss low, medium, high oder xhigh sein")
    if not fb:
        fallback_effort = None
    return {
        "model": primary,
        "effort": effort,
        "fallback_model": fb,
        "fallback_effort": fallback_effort,
        "fixed_until_changed": True,
    }


def _actor(root: Path, sender: str | None, claimed_role: str | None = None) -> dict[str, Any]:
    """Return an explicitly untrusted governance identity description."""
    sender = sender or "cli-operator"
    result: dict[str, Any] = {
        "id": sender,
        "claimed_role": claimed_role,
        "verified": False,
        "source": "cli-argument",
    }
    if sender in HUMAN_ACTORS:
        result["kind"] = "external"
        return result
    try:
        agent = read_agent(root, sender)
    except AgentsError:
        raise AgentsError("Absender '%s' unbekannt; --rolle beweist keine Identitaet" % sender)
    result["kind"] = "agent"
    result["role"] = agent["stage"]
    if claimed_role and claimed_role != agent["stage"]:
        raise AgentsError("Angegebene Rolle passt nicht zum gespeicherten Profil; CLI-Rolle ist kein Beleg")
    return result


def _require_actor(root: Path, sender: str | None, claimed_role: str | None,
                   allowed: Iterable[str]) -> dict[str, Any]:
    actor = _actor(root, sender, claimed_role)
    if actor.get("kind") == "external":
        return actor
    if actor.get("role") not in set(allowed):
        raise AgentsError("Agent '%s' darf diese Mutation nicht ausfuehren" % actor["id"])
    return actor


def _require_external_operator(root: Path, sender: str | None,
                               claimed_role: str | None) -> dict[str, Any]:
    actor = _actor(root, sender, claimed_role)
    if actor.get("kind") != "external":
        raise AgentsError("Nur ein externer Entwicklungsakteur darf Fragen beantworten oder zuruecknehmen")
    return actor


def _agent_dir(root: Path, agent_id: str) -> Path:
    return child(root / "agents", valid_id(agent_id, "Agentenkennung"))


def read_agent(root: Path, agent_id: str) -> dict[str, Any]:
    root = world_path(str(root))
    return _read_json(_agent_dir(root, agent_id) / "agent.json")


def list_agents(root: Path) -> list[dict[str, Any]]:
    root = world_path(str(root))
    folder = root / "agents"
    if not folder.exists():
        return []
    if folder.is_symlink() or not folder.is_dir():
        raise AgentsError("Agentordner ist ungueltig")
    result = []
    for item in sorted(folder.iterdir()):
        if item.is_symlink():
            raise AgentsError("Agentordner enthaelt einen Symlink")
        if item.is_dir() and (item / "agent.json").is_file():
            result.append(_read_json(item / "agent.json"))
    return result


def _question_dir(root: Path, question_id: str) -> Path:
    return child(root / "questions", valid_id(question_id, "Fragenkennung"))


def read_question(root: Path, question_id: str) -> dict[str, Any]:
    root = world_path(str(root))
    path = _question_dir(root, question_id) / "question.json"
    _reject_symlink(path, "Fragedatei")
    if path.is_symlink():
        raise AgentsError("Fragedatei darf kein Symlink sein")
    return _read_json(path)


def list_questions(root: Path) -> list[dict[str, Any]]:
    root = world_path(str(root))
    folder = root / "questions"
    _reject_symlink(folder, "Fragenordner")
    if not folder.exists():
        return []
    if folder.is_symlink() or not folder.is_dir():
        raise AgentsError("Fragenordner ist ungueltig")
    result = []
    for item in sorted(folder.iterdir()):
        if item.name.startswith("."):
            continue  # staging directory of a question being created right now
        if item.is_symlink():
            raise AgentsError("Fragenordner enthaelt einen Symlink")
        question_file = item / "question.json"
        if question_file.is_symlink():
            raise AgentsError("Fragedatei darf kein Symlink sein")
        if item.is_dir() and question_file.is_file():
            result.append(read_question(root, item.name))
    return result


def _question_content(text: str, options: list[str] | None,
                     recommendation: str | None, ticket_id: str | None) -> dict[str, Any]:
    if not isinstance(text, str) or not text.strip():
        raise AgentsError("Fragentext fehlt")
    if options is None:
        options = []
    if not isinstance(options, list) or any(not isinstance(option, str) or not option.strip() for option in options):
        raise AgentsError("Frageoptionen muessen nichtleere Texte sein")
    if recommendation is not None and (not isinstance(recommendation, str) or not recommendation.strip()):
        raise AgentsError("Empfehlung muss ein Text sein")
    if ticket_id is not None:
        valid_id(ticket_id, "Ticketkennung")
    return {"text": text, "options": list(options), "recommendation": recommendation,
            "ticket": ticket_id}


def ask_question(root: Path, text: str, options: list[str] | None = None,
                 recommendation: str | None = None, ticket_id: str | None = None,
                 question_id: str | None = None, sender: str | None = None,
                 claimed_role: str | None = None) -> dict[str, Any]:
    content = _question_content(text, options, recommendation, ticket_id)
    if question_id is not None:
        valid_id(question_id, "Fragenkennung")
    with transaction(root):
        actor = _actor(root, sender, claimed_role)
        if actor.get("kind") != "agent" or actor.get("role") != "hauptagent":
            raise AgentsError("Nur der Hauptagent darf Fragen stellen")
        world = read_world(root)
        question_id = question_id or new_id("frage")
        valid_id(question_id, "Fragenkennung")
        path = _question_dir(root, question_id)
        if path.exists() or path.is_symlink():
            existing = read_question(root, question_id)
            if any(existing.get(key) != value for key, value in content.items()):
                raise AgentsError("Fragenkennung existiert bereits mit anderem Inhalt")
            return existing
        if world["state"] != "läuft":
            raise AgentsError("Welt ist %s; keine neue Frage wird gestellt" % world["state"])
        if ticket_id is not None:
            read_ticket(root, ticket_id)
        timestamp = now()
        question = {
            "schema_version": SCHEMA_VERSION, "id": question_id, "world": world["id"],
            **content, "state": "offen", "answer": None, "withdrawal": None,
            "sender": actor["id"], "sender_verified": False,
            "created_at": timestamp, "updated_at": timestamp,
        }
        stage_path = path.parent / (".%s.creating-%s" % (question_id, uuid.uuid4().hex))
        try:
            stage_path.mkdir(parents=True)
            _write_json(stage_path / "question.json", question)
            os.replace(stage_path, path)
            return question
        except BaseException:
            shutil.rmtree(stage_path, ignore_errors=True)
            raise


def answer_question(root: Path, question_id: str, answer: str,
                    sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    valid_id(question_id, "Fragenkennung")
    if not isinstance(answer, str) or not answer.strip():
        raise AgentsError("Antworttext fehlt")
    with transaction(root):
        actor = _require_external_operator(root, sender, claimed_role)
        question = read_question(root, question_id)
        if question.get("state") == "beantwortet":
            if question.get("answer", {}).get("text") == answer:
                return question
            raise AgentsError("Frage ist bereits mit anderem Inhalt beantwortet")
        if question.get("state") in ("zurückgenommen", "zurueckgenommen"):
            raise AgentsError("Frage wurde zurueckgenommen")
        question["state"] = "beantwortet"
        question["answer"] = {"text": answer, "sender": actor["id"],
                               "role": actor.get("role"), "verified": False,
                               "source": "cli-argument", "answered_at": now()}
        question["updated_at"] = question["answer"]["answered_at"]
        _write_json(_question_dir(root, question_id) / "question.json", question)
        return question


def withdraw_question(root: Path, question_id: str, reason: str | None = None,
                      sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    valid_id(question_id, "Fragenkennung")
    if reason is not None and (not isinstance(reason, str) or not reason.strip()):
        raise AgentsError("Ruecknahmegrund muss ein Text sein")
    with transaction(root):
        actor = _require_external_operator(root, sender, claimed_role)
        question = read_question(root, question_id)
        if question.get("state") in ("zurückgenommen", "zurueckgenommen"):
            withdrawal = question.get("withdrawal") or {}
            if withdrawal.get("reason") == reason:
                return question
            raise AgentsError("Frage ist bereits mit anderem Ruecknahmegrund zurueckgenommen")
        if question.get("state") == "beantwortet":
            raise AgentsError("Beantwortete Frage kann nicht zurueckgenommen werden")
        question["state"] = "zurückgenommen"
        question["withdrawal"] = {"reason": reason, "sender": actor["id"],
                                   "role": actor.get("role"), "verified": False,
                                   "source": "cli-argument", "withdrawn_at": now()}
        question["updated_at"] = question["withdrawal"]["withdrawn_at"]
        _write_json(_question_dir(root, question_id) / "question.json", question)
        return question


def create_world(root: Path, name: str | None = None, main_name: str = "hauptagent",
                 description: str = "Hauptagent der Welt", model: str | None = None,
                 effort: str | None = None, fallback: str | None = None,
                 fallback_effort: str | None = None, machine: str = "lokal",
                 global_world: bool = False, with_main_agent: bool = True) -> dict[str, Any]:
    """Create a world; without `with_main_agent` it starts empty and the main agent follows later.

    The empty form is the path of the surfaces (welten.ts `welt:neu`): the human then creates
    the main agent in the creation menu, by hand or as a model proposal.
    """
    root = world_path(str(root))
    if root.exists():
        if (root / "world.json").exists():
            raise AgentsError("Welt existiert bereits: %s" % root)
        raise AgentsError("Weltpfad existiert; keine stillen Uebernahmen")
    root.parent.mkdir(parents=True, exist_ok=True)
    stage = root.parent / (".%s.creating-%s" % (root.name, uuid.uuid4().hex))
    stage.mkdir()
    timestamp = now()
    world_id = new_id("welt")
    world = {
        "schema_version": SCHEMA_VERSION, "id": world_id, "name": name or root.name,
        "path": str(root), "kind": "global" if global_world else "project",
        "created_at": timestamp, "updated_at": timestamp, "state": "läuft",
        "pause": {"state": "läuft", "changed_at": timestamp, "reason": None},
        "stop": {"state": "läuft", "changed_at": timestamp, "reason": None},
        "governance": {"identity_verified": False, "mutation_gate": "external-adapter-required"},
    }
    try:
        _world_dirs(stage)
        _write_json(world_file(stage), world)
        main = None
        if with_main_agent:
            main = create_agent(stage, main_name, "hauptagent", None, description, None, None,
                                model or "opus5:xhigh", effort, fallback,
                                fallback_effort, machine, "cli-operator", None, bootstrap=True)
        os.replace(stage, root)
        return {"world": world, "hauptagent": main}
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def create_agent(root: Path, agent_id: str, stage: str, team: str | None,
                 description: str, figure: str | None, tools: list[str] | None,
                 model: str | None, effort: str | None, fallback: str | None,
                 fallback_effort: str | None, machine: str, sender: str | None,
                 claimed_role: str | None, skills: list[str] | None = None,
                 bootstrap: bool = False) -> dict[str, Any]:
    root = world_path(str(root))
    valid_id(agent_id, "Agentenkennung")
    if agent_id in HUMAN_ACTORS:
        raise AgentsError("Agentenkennung '%s' ist fuer Menschen und Entwicklungsakteure reserviert" % agent_id)
    if stage not in STAGES:
        raise AgentsError("Stufe ungueltig (hauptagent, teamleiter, mitglied)")
    if not description.strip():
        raise AgentsError("Beschreibung fehlt")
    with transaction(root):
        world = read_world(root)
        if world["state"] != "läuft":
            raise AgentsError("Welt ist %s; kein neuer Agent wird angelegt" % world["state"])
        if not bootstrap:
            _require_actor(root, sender, claimed_role, ("hauptagent", "teamleiter"))
        if any(a["stage"] == "hauptagent" for a in list_agents(root)) and stage == "hauptagent":
            raise AgentsError("Welt darf genau einen Hauptagenten haben")
        if stage == "hauptagent" and team:
            raise AgentsError("Hauptagent gehoert keinem Team an")
        path = _agent_dir(root, agent_id)
        if path.exists() or path.is_symlink():
            raise AgentsError("Agent existiert bereits: %s" % agent_id)
        actor = None if bootstrap else _actor(root, sender, claimed_role)
        if actor and actor.get("kind") == "agent" and actor.get("role") == "teamleiter":
            raise AgentsError("Teamleiter beantragt Agenten beim Hauptagenten")
        if stage == "teamleiter" and not team:
            raise AgentsError("Teamleiter braucht ein Team")
        ts = now()
        profile = {
            "schema_version": SCHEMA_VERSION, "id": agent_id, "name": agent_id,
            "world": world["id"], "stage": stage, "team": team,
            "specialty": description, "figure": figure or {"family": "maschinenwesen", "variant": _slug(agent_id, "agent")},
            "tools": list(tools or []), "skills": list(skills or []), "machine": machine,
            "created_at": ts, "updated_at": ts, "state": "aktiv",
            "model_profile": _model(model, effort, fallback, fallback_effort),
            "governance": {"identity_verified": False, "source": "cli-argument"},
        }
        if not tools:
            # Without tools the profile gets the defaults of its stage, so a turn can work at all.
            profile.update(tools=list(DEFAULT_TOOLS[stage]), bash=list(DEFAULT_BASH))
        else:
            # With an own list the service path still comes along (see validate_agent_draft):
            # Bash with the default patterns, otherwise the agent cannot answer or hand over.
            if "Bash" not in profile["tools"]:
                profile["tools"] = profile["tools"] + ["Bash"]
            profile["bash"] = list(DEFAULT_BASH)
        stage_path = path.parent / (".%s.creating-%s" % (agent_id, uuid.uuid4().hex))
        try:
            stage_path.mkdir(parents=True)
            (stage_path / "postfach").mkdir()
            _write_json(stage_path / "agent.json", profile)
            _write_json(stage_path / "runtime.json", {"state": "aktiv", "updated_at": ts, "reason": None})
            memory = "# %s – Gedächtnis\n\nNoch keine Einträge.\n" % agent_id
            if atomar_schreiben is not None:
                atomar_schreiben.schreiben(str(stage_path / "MEMORY.md"), memory, modus=0o600)
            else:
                (stage_path / "MEMORY.md").write_text(memory, encoding="utf-8")
            _write_json(stage_path / "history.json", {"schema_version": SCHEMA_VERSION, "agent": agent_id, "entries": []})
            instructions = "# %s\n\nAgentenregeln und Weltgrenze werden vor dem ersten Lauf durch den Träger ergänzt.\n" % agent_id
            if atomar_schreiben is not None:
                atomar_schreiben.schreiben(str(stage_path / "AGENTS.md"), instructions, modus=0o600)
            else:
                (stage_path / "AGENTS.md").write_text(instructions, encoding="utf-8")
            os.replace(stage_path, path)
            return profile
        except BaseException:
            shutil.rmtree(stage_path, ignore_errors=True)
            raise


def set_agent_state(root: Path, agent_id: str, state: str, reason: str | None,
                    sender: str | None, claimed_role: str | None) -> dict[str, Any]:
    if state not in ("aktiv", "pausiert", "gestoppt"):
        raise AgentsError("Agentenstand ungueltig")
    with transaction(root):
        actor = _require_actor(root, sender, claimed_role, ("hauptagent", "teamleiter"))
        agent = read_agent(root, agent_id)
        if actor.get("kind") == "agent" and actor.get("role") == "teamleiter":
            owner = read_agent(root, actor["id"])
            if agent.get("team") != owner.get("team") or agent.get("stage") != "mitglied":
                raise AgentsError("Teamleiter darf nur Mitglieder seines Teams steuern")
        runtime = {"state": state, "updated_at": now(), "reason": reason}
        agent["state"] = state
        agent["updated_at"] = runtime["updated_at"]
        # agent.json is the authoritative profile.  Recovery can restore the
        # derived runtime projection if the process dies between these files.
        _write_json(_agent_dir(root, agent_id) / "agent.json", agent)
        _write_json(_agent_dir(root, agent_id) / "runtime.json", runtime)
        if state == "gestoppt":
            _interrupt_agent_tickets(root, agent_id, reason or "Agent gestoppt")
        return agent


def set_world_state(root: Path, state: str, reason: str | None,
                    sender: str | None, claimed_role: str | None) -> dict[str, Any]:
    if state not in WORLD_STATES:
        raise AgentsError("Weltstand ungueltig")
    with transaction(root):
        _require_actor(root, sender, claimed_role, ("hauptagent",))
        world = read_world(root)
        ts = now()
        world["state"] = state
        world["updated_at"] = ts
        world["pause"] = {"state": state, "changed_at": ts, "reason": reason} if state == "pausiert" else world.get("pause", {})
        world["stop"] = {"state": state, "changed_at": ts, "reason": reason} if state == "gestoppt" else world.get("stop", {})
        _write_json(world_file(root), world)
        if state == "gestoppt":
            _interrupt_all_tickets(root, reason or "Welt gestoppt")
        return world


def _ticket_path(root: Path, ticket_id: str) -> Path:
    return child(root / "tickets", valid_id(ticket_id, "Ticketkennung"))


def read_ticket(root: Path, ticket_id: str) -> dict[str, Any]:
    root = world_path(str(root))
    return _read_json(_ticket_path(root, ticket_id) / "ticket.json")


def _ticket_dependencies_cycle(root: Path, ticket_id: str, dependencies: list[str]) -> None:
    """Reject self-reference and cycles before a ticket becomes visible."""
    graph: dict[str, list[str]] = {ticket_id: list(dependencies)}
    for dependency in dependencies:
        if dependency == ticket_id:
            raise AgentsError("Ticket-Abhaengigkeit bildet einen Zyklus")
        graph.setdefault(dependency, list(read_ticket(root, dependency).get("dependencies") or []))
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            raise AgentsError("Ticket-Abhaengigkeit bildet einen Zyklus")
        if node in visited:
            return
        visiting.add(node)
        for parent in graph.get(node, []):
            if parent not in graph:
                graph[parent] = list(read_ticket(root, parent).get("dependencies") or [])
            visit(parent)
        visiting.remove(node)
        visited.add(node)

    visit(ticket_id)


def _ticket_event(root: Path, ticket: dict[str, Any], event: str, actor: dict[str, Any], **extra: Any) -> None:
    data = {"id": new_id("ev"), "time": now(), "event": event, "actor": actor}
    data.update(extra)
    _append_jsonl(_ticket_path(root, ticket["id"]) / "verlauf.jsonl", data)


def create_ticket(root: Path, title: str, goal: str, done: str,
                  recipients: list[str], sender: str | None, claimed_role: str | None,
                  team: str | None = None, limits: dict[str, Any] | None = None,
                  dependencies: list[str] | None = None,
                  ticket_id: str | None = None) -> dict[str, Any]:
    if not title.strip() or not goal.strip() or not done.strip():
        raise AgentsError("Titel, Ziel und Fertig-Kriterium sind Pflicht")
    if not recipients and not team:
        raise AgentsError("Ticket braucht Adressat oder Team")
    with transaction(root):
        world = read_world(root)
        actor = _actor(root, sender, claimed_role)
        for recipient in recipients:
            read_agent(root, recipient)
        if team and not valid_id(team, "Team"):
            raise AgentsError("Team ungueltig")
        deps = list(dependencies or [])
        for dep in deps:
            read_ticket(root, dep)
        ticket_id = valid_id(ticket_id, "Ticketkennung") if ticket_id else new_id("t")
        existing_path = _ticket_path(root, ticket_id)
        if existing_path.exists():
            existing = read_ticket(root, ticket_id)
            same = (existing.get("title"), existing.get("goal"), existing.get("done_criterion"),
                    existing.get("recipients"), existing.get("team"), existing.get("dependencies"),
                    existing.get("limits")) == \
                   (title, goal, done, recipients, team, deps, limits or {})
            if same:
                return existing
            raise AgentsError("Ticketkennung existiert bereits mit anderem Inhalt")
        _ticket_dependencies_cycle(root, ticket_id, deps)
        ts = now()
        ticket = {
            "schema_version": SCHEMA_VERSION, "id": ticket_id, "world": world["id"],
            "title": title, "goal": goal, "done_criterion": done, "limits": limits or {},
            "dependencies": deps, "recipients": list(recipients), "team": team,
            "sender": sender or "cli-operator", "sender_verified": False, "state": "offen",
            "assignee": None, "claimed_at": None, "result": None, "approval": None,
            "created_at": ts, "updated_at": ts,
        }
        path = _ticket_path(root, ticket_id)
        stage_path = path.parent / (".%s.creating-%s" % (ticket_id, uuid.uuid4().hex))
        try:
            stage_path.mkdir(parents=True)
            _write_json(stage_path / "ticket.json", ticket)
            _write_json(stage_path / "ergebnis.json", {})
            _append_jsonl(stage_path / "verlauf.jsonl", {"id": new_id("ev"), "time": ts, "event": "erstellt", "actor": actor})
            os.replace(stage_path, path)
            _deliver_ticket(root, ticket, actor)
            return ticket
        except BaseException:
            shutil.rmtree(stage_path, ignore_errors=True)
            raise


def _deliver_ticket(root: Path, ticket: dict[str, Any], actor: dict[str, Any]) -> str:
    delivery_id = ticket.get("return_delivery_id") or derived_id("ticket", ticket["id"])
    recipients = list(ticket.get("recipients") or [])
    if ticket.get("return_to") and ticket.get("return_to_delivery") == delivery_id:
        # A ticket the human handed back goes to the agent who worked on it.
        recipients = list(ticket["return_to"])
    elif ticket.get("team"):
        recipients.extend(a["id"] for a in list_agents(root) if a.get("team") == ticket["team"])
    payload = {"delivery_id": delivery_id, "kind": "ticket", "ticket_id": ticket["id"],
               "time": ticket.get("return_delivery_time") or ticket.get("created_at") or now(),
               "sender": ticket.get("delivery_sender") or actor["id"], "acknowledged": False}
    for recipient in sorted(set(recipients)):
        folder = _agent_dir(root, recipient) / "postfach"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / (delivery_id + ".json")
        expected = dict(payload, recipient=recipient)
        if target.exists():
            stored = _read_json(target)
            if any(stored.get(key) != expected.get(key)
                   for key in expected if key not in {"acknowledged"}):
                raise AgentsError("Ticketzustellung existiert bereits mit anderem Inhalt")
        else:
            _write_json(target, expected)
    return delivery_id


def claim_ticket(root: Path, ticket_id: str, agent_id: str,
                 sender: str | None, claimed_role: str | None) -> dict[str, Any]:
    with transaction(root):
        world = read_world(root)
        if world["state"] != "läuft":
            raise AgentsError("Welt ist %s; Ticketuebernahme gesperrt" % world["state"])
        actor = _require_actor(root, sender or agent_id, claimed_role, STAGES)
        if actor.get("id") != agent_id and actor.get("kind") != "external":
            raise AgentsError("Absender darf nicht fuer einen anderen Agenten uebernehmen")
        agent = read_agent(root, agent_id)
        if agent.get("state") != "aktiv":
            raise AgentsError("Agent ist %s; Ticketuebernahme gesperrt" % agent.get("state"))
        ticket = read_ticket(root, ticket_id)
        if ticket["state"] == "läuft" and ticket.get("assignee") == agent_id:
            return ticket  # idempotent retry after lost response
        if ticket["state"] not in ("offen", "zurückgegeben"):
            raise AgentsError("Ticket ist bereits %s" % ticket["state"])
        for dependency_id in ticket.get("dependencies") or []:
            dependency = read_ticket(root, dependency_id)
            if dependency.get("state") != "abgenommen":
                raise AgentsError("Abhaengigkeit %s ist noch nicht abgenommen" % dependency_id)
        for other in list_tickets(root):
            if other.get("id") != ticket_id and other.get("assignee") == agent_id and other.get("state") == "läuft":
                raise AgentsError("Agent bearbeitet bereits Ticket %s" % other["id"])
        allowed = set(ticket.get("recipients") or [])
        if ticket.get("team"):
            allowed.update(a["id"] for a in list_agents(root) if a.get("team") == ticket["team"])
        if agent_id not in allowed and actor.get("kind") != "external":
            raise AgentsError("Ticket ist nicht an diesen Agenten adressiert")
        ticket.update({"state": "läuft", "assignee": agent_id, "claimed_at": now(),
                       "updated_at": now(), "result": None, "result_message_id": None})
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        if ticket.get("result_revision"):
            _write_json(_ticket_path(root, ticket_id) / "ergebnis.json", {})
        _ticket_event(root, ticket, "uebernommen", actor, assignee=agent_id)
        return ticket


def write_result(root: Path, ticket_id: str, agent_id: str, text: str,
                 commit: str | None, sender: str | None, claimed_role: str | None) -> dict[str, Any]:
    if not text.strip():
        raise AgentsError("Ergebnis fehlt")
    with transaction(root):
        actor = _require_actor(root, sender or agent_id, claimed_role, STAGES)
        ticket = read_ticket(root, ticket_id)
        if ticket.get("assignee") != agent_id:
            raise AgentsError("Nur der Bearbeiter darf das Ergebnis schreiben")
        if ticket["state"] == "zur Abnahme" and ticket.get("result"):
            result = ticket["result"]
            if result.get("text") == text and result.get("commit") == commit:
                return ticket  # idempotent retry after a lost response
            raise AgentsError("Ticket wartet bereits auf Abnahme")
        if ticket["state"] != "läuft":
            raise AgentsError("Ticket ist %s; Ergebnis nicht mehr schreibbar" % ticket["state"])
        result = {"schema_version": SCHEMA_VERSION, "ticket": ticket_id, "agent": agent_id,
                  "text": text, "commit": commit, "written_at": now(), "sender_verified": False}
        revision = int(ticket.get("result_revision") or 0) + 1
        result_message_id = (derived_id("result", ticket_id) if revision == 1
                             else derived_id("result", ticket_id, revision))
        ticket.update({"state": "zur Abnahme", "result": result,
                       "result_message_id": result_message_id, "result_revision": revision,
                       "updated_at": now()})
        # The ticket is authoritative.  If the process dies before the separate
        # result file or notification is written, the next transaction repairs both.
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _write_json(_ticket_path(root, ticket_id) / "ergebnis.json", result)
        _ticket_event(root, ticket, "ergebnis", actor, commit=commit)
        recipient = ticket.get("sender") or "hauptagent"
        # A result for the world's human is one marked entry in the channel and in the human's postbox.
        humans, mark = ([WORLD_HUMAN], "ergebnis") if recipient == WORLD_HUMAN else (None, None)
        _deliver_message(root, agent_id, recipient, "ticket-ergebnis", "Ergebnis zu %s" % ticket_id, ticket_id,
                         result["text"], result_message_id, humans, mark)
        return ticket


def approve_ticket(root: Path, ticket_id: str, approver: str | None,
                   claimed_role: str | None, note: str | None, accept: bool = True) -> dict[str, Any]:
    with transaction(root):
        actor = _require_actor(root, approver, claimed_role, ("hauptagent", "teamleiter"))
        ticket = read_ticket(root, ticket_id)
        if ticket["state"] not in ("zur Abnahme", "zurückgegeben"):
            raise AgentsError("Ticket ist %s; keine Abnahme moeglich" % ticket["state"])
        if actor.get("kind") == "agent" and actor.get("role") == "teamleiter":
            agent = read_agent(root, actor["id"])
            # Also an own ticket from a member of the leader's team, e.g. a skill
            # proposal addressed to the leader (docs/AGENTS-SKILLS.md, Abnahmeweg).
            sender_id = ticket.get("sender")
            sender = None
            if sender_id and sender_id not in HUMAN_ACTORS and ID_RE.match(str(sender_id)):
                try:
                    sender = read_agent(root, sender_id)
                except AgentsError:
                    sender = None
            own_member_ticket = (ticket.get("assignee") == actor["id"] and sender is not None
                                 and sender.get("stage") == "mitglied" and sender.get("team") == agent.get("team"))
            if ticket.get("team") != agent.get("team") and not own_member_ticket:
                raise AgentsError("Teamleiter darf nur Tickets seines Teams oder selbst bearbeitete Tickets von Mitgliedern seines Teams abnehmen")
        if actor.get("kind") == "agent" and actor.get("role") == "mitglied":
            raise AgentsError("Mitglied darf Tickets nicht abnehmen")
        if not accept and ticket["state"] == "zurückgegeben":
            approval = ticket.get("approval") or {}
            if approval.get("agent") == actor.get("id") and approval.get("note") == note:
                return ticket  # idempotent retry after a lost response
        ticket["state"] = "abgenommen" if accept else "zurückgegeben"
        ticket["approval"] = {"agent": actor["id"], "verified": False, "time": now(), "note": note}
        ticket["updated_at"] = now()
        if not accept:
            ticket.pop("return_to", None)
            ticket.pop("return_to_delivery", None)
            revision = int(ticket.get("return_revision") or 0) + 1
            ticket["return_revision"] = revision
            ticket["return_delivery_id"] = derived_id("ticket-return", ticket_id, revision)
            ticket["return_delivery_time"] = ticket["updated_at"]
            ticket["delivery_sender"] = actor["id"]
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "abgenommen" if accept else "zurueckgegeben", actor, note=note)
        if not accept:
            _deliver_ticket(root, ticket, actor)
    # Outside the lock: an orchestrator that created the ticket gets the result in its session
    # inbox. A dead session never undoes the approval (deliver_to_session_inbox records it).
    if accept and ((ticket.get("limits") or {}).get("rueckweg") or {}).get("art") == SESSION_RETURN_KIND:
        try:
            deliver_to_session_inbox(root, ticket)
        except (AgentsError, OSError):
            pass
    return ticket


def list_tickets(root: Path) -> list[dict[str, Any]]:
    root = world_path(str(root))
    folder = root / "tickets"
    if not folder.exists():
        return []
    if folder.is_symlink() or not folder.is_dir():
        raise AgentsError("Ticketordner ist ungueltig")
    result = []
    for item in sorted(folder.iterdir()):
        if item.is_symlink():
            raise AgentsError("Ticketordner enthaelt einen Symlink")
        if item.is_dir() and (item / "ticket.json").is_file():
            result.append(_read_json(item / "ticket.json"))
    return result


def _interrupt_agent_tickets(root: Path, agent_id: str, reason: str) -> None:
    for ticket in list_tickets(root):
        if ticket.get("assignee") != agent_id or ticket.get("state") not in ("läuft", "zur Abnahme"):
            continue
        ticket["state"] = "unterbrochen"
        ticket["updated_at"] = now()
        _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
        _ticket_event(root, ticket, "unterbrochen", {"id": "system", "verified": False}, reason=reason)


def _interrupt_all_tickets(root: Path, reason: str) -> None:
    for ticket in list_tickets(root):
        if ticket.get("state") in ("läuft", "zur Abnahme"):
            ticket["state"] = "unterbrochen"
            ticket["updated_at"] = now()
            _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
            _ticket_event(root, ticket, "unterbrochen", {"id": "system", "verified": False}, reason=reason)


def _delivery_path(root: Path, recipient: str, delivery_id: str) -> Path:
    if recipient == WORLD_HUMAN:
        return _human_delivery_path(root, recipient, delivery_id)
    return _agent_dir(root, recipient) / "postfach" / (valid_id(delivery_id, "Zustellungskennung") + ".json")


def _human_delivery_path(root: Path, human: str, delivery_id: str) -> Path:
    if human != WORLD_HUMAN:
        raise AgentsError("Nur '%s' hat ein Postfach in der Welt" % WORLD_HUMAN)
    return child(root, "menschen", human, "postfach") / (valid_id(delivery_id, "Zustellungskennung") + ".json")


def _ensure_human_delivery(root: Path, human: str, message: dict[str, Any]) -> None:
    """Project one message into the postbox of the world's human, idempotently."""
    path = _human_delivery_path(root, human, message["id"])
    expected = dict(message, recipient=human, delivery_id=message["id"], acknowledged=False)
    if path.exists():
        stored = _read_json(path)
        if any(stored.get(key) != expected.get(key)
               for key in expected if key not in {"time", "acknowledged", "acknowledged_at", "acknowledged_by"}):
            raise AgentsError("Zustellung an den Menschen existiert bereits mit anderem Inhalt")
    else:
        _write_json(path, expected)


def _channel_has_message(root: Path, message_id: str) -> bool:
    path = root / "kanal.jsonl"
    if not path.exists():
        return False
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line:
            try:
                if json.loads(line).get("id") == message_id:
                    return True
            except json.JSONDecodeError:
                if index == len(lines) - 1 and not line.endswith(("\n", "\r")):
                    continue
                raise AgentsError("Kanaldatei enthaelt unlesbare JSON-Zeile")
    return False


def _deliver_message(root: Path, sender: str, recipient: str, kind: str,
                     subject: str, ticket_id: str | None, text: str,
                     message_id: str | None = None, humans: list[str] | None = None,
                     mark: str | None = None) -> dict[str, Any]:
    message_id = message_id or new_id("m")
    humans = list(dict.fromkeys(humans or []))
    if isinstance(recipient, list):
        recipients = list(dict.fromkeys(recipient))
        recipient_field: str | None = None
    elif recipient == "alle":
        recipients = [a["id"] for a in list_agents(root)]
        recipient_field = "alle"
    elif recipient in HUMAN_ACTORS:
        # Humans and the companion have no agent postbox in this data layer;
        # the durable channel entry is still retained for their UI.
        recipients = []
        recipient_field = recipient
    else:
        recipients = [recipient]
        recipient_field = recipient
    message = {"id": message_id, "kind": kind, "sender": sender, "recipient": recipient_field,
               "recipients": recipients, "subject": subject, "ticket": ticket_id, "text": text, "time": now(),
               "sender_verified": False}
    # Only messages to the human carry these keys, so stored older messages
    # still compare equal on an idempotent retry.
    if humans:
        message["humans"] = humans
    if mark:
        message["mark"] = mark
    for human in humans:
        _ensure_human_delivery(root, human, message)
    for target in recipients:
        read_agent(root, target)
        path = _delivery_path(root, target, message_id)
        if path.exists():
            stored = _read_json(path)
            expected = dict(message, recipient=target, delivery_id=message_id, acknowledged=False)
            if any(stored.get(key) != expected.get(key)
                   for key in expected if key not in {"time", "acknowledged", "acknowledged_at", "acknowledged_by"}):
                raise AgentsError("Zustellungskennung existiert bereits mit anderem Inhalt")
        else:
            _write_json(path, dict(message, recipient=target, delivery_id=message_id, acknowledged=False))
    if _channel_has_message(root, message_id):
        existing = next(item for item in read_messages(root) if item.get("id") == message_id)
        if any(existing.get(key) != message.get(key) for key in message if key != "time"):
            raise AgentsError("Nachrichtenkennung existiert bereits mit anderem Inhalt")
    else:
        _append_jsonl(root / "kanal.jsonl", message)
    return message


def send_message(root: Path, sender: str | None, recipients: list[str], text: str,
                 ticket_id: str | None, message_id: str | None, claimed_role: str | None,
                 direct: bool = False) -> dict[str, Any]:
    return _send_message(root, sender, recipients, text, ticket_id, message_id, claimed_role, direct, None)


def send_marked_message(root: Path, sender: str | None, recipients: list[str], text: str, mark: str,
                        ticket_id: str | None = None, message_id: str | None = None,
                        claimed_role: str | None = None, direct: bool = False) -> dict[str, Any]:
    """A message to the world's human marked as question or result.

    Only marked messages ask for the human's attention; a question may only
    come from the main agent (plan section 8, rule 1).
    """
    if mark not in MESSAGE_MARKS:
        raise AgentsError("Markierung muss frage oder ergebnis sein")
    return _send_message(root, sender, recipients, text, ticket_id, message_id, claimed_role, direct, mark)


def _send_message(root: Path, sender: str | None, recipients: list[str], text: str,
                  ticket_id: str | None, message_id: str | None, claimed_role: str | None,
                  direct: bool, mark: str | None) -> dict[str, Any]:
    if not recipients or any(not r.strip() for r in recipients):
        raise AgentsError("Nachricht braucht mindestens einen Adressaten")
    if "alle" in recipients and len(recipients) != 1:
        raise AgentsError("'alle' darf nicht mit einzelnen Adressaten gemischt werden")
    if direct and "alle" in recipients:
        raise AgentsError("Direktchat braucht konkrete Adressaten")
    if not text.strip():
        raise AgentsError("Nachrichtentext fehlt")
    if message_id is not None:
        message_id = valid_id(message_id, "Nachrichtenkennung")
    humans = [r for r in dict.fromkeys(recipients) if r == WORLD_HUMAN]
    agents = [r for r in recipients if r != WORLD_HUMAN]
    if mark and not humans:
        raise AgentsError("Eine Markierung gilt nur fuer Nachrichten an '%s'" % WORLD_HUMAN)
    with transaction(root):
        actor = _actor(root, sender, claimed_role)
        if humans and actor.get("kind") != "agent":
            raise AgentsError("An '%s' schreiben nur Agenten der Welt" % WORLD_HUMAN)
        if mark == "frage" and actor.get("role") != "hauptagent":
            raise AgentsError("Fragen an den Menschen stellt nur der Hauptagent")
        if "alle" in recipients and actor.get("kind") == "agent" and actor.get("role") != "hauptagent":
            raise AgentsError("Nachricht an alle ist dem Hauptagenten vorbehalten")
        for recipient in agents:
            if recipient != "alle":
                read_agent(root, recipient)
        if ticket_id:
            read_ticket(root, ticket_id)
        message_id = message_id or new_id("m")
        if direct:
            ids = sorted([sender or "cli-operator"] + agents + humans)
            ids = [valid_id(x, "Chatpartner") for x in ids]
            chat = derived_id("chat", *ids)
            path = child(root / "direktchats", chat)
            path.mkdir(parents=True, exist_ok=True)
            message = {"id": message_id, "kind": "direktchat", "sender": sender or "cli-operator",
                       "recipients": agents, "ticket": ticket_id, "text": text, "time": now(),
                       "sender_verified": False}
            if humans:
                message["humans"] = humans
            if mark:
                message["mark"] = mark
            existing = path / (message_id + ".json")
            if existing.exists():
                stored = _read_json(existing)
                if any(stored.get(key) != message.get(key) for key in message if key != "time"):
                    raise AgentsError("Nachrichtenkennung existiert bereits mit anderem Inhalt")
                return stored
            else:
                _write_json(existing, message)
            for recipient in agents:
                target = _delivery_path(root, recipient, message_id)
                if not target.exists():
                    _write_json(target, dict(message, recipient=recipient, delivery_id=message_id, acknowledged=False))
            for human in humans:
                _ensure_human_delivery(root, human, message)
            return message
        if not agents:
            return _deliver_message(root, sender or "cli-operator", WORLD_HUMAN, "kanal", "Nachricht",
                                    ticket_id, text, message_id, humans, mark)
        if not humans:
            return _deliver_message(root, sender or "cli-operator", agents[0] if len(agents) == 1 else agents,
                                    "kanal", "Nachricht", ticket_id, text, message_id)
        return _deliver_message(root, sender or "cli-operator", agents, "kanal", "Nachricht",
                                ticket_id, text, message_id, humans, mark)


def read_messages(root: Path, recipient: str | None = None, direct_chat: str | None = None) -> list[dict[str, Any]]:
    root = world_path(str(root))
    if direct_chat:
        path = child(root / "direktchats", direct_chat)
        messages = []
        for item in sorted(path.glob("*.json")):
            if item.is_symlink():
                raise AgentsError("Direktchat enthaelt einen Symlink")
            if item.is_file():
                messages.append(_read_json(item))
        return messages
    path = root / "kanal.jsonl"
    if path.is_symlink():
        raise AgentsError("Kanaldatei darf kein Symlink sein")
    if not path.exists():
        return []
    result = []
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    for index, line in enumerate(lines):
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            if index == len(lines) - 1 and not line.endswith(("\n", "\r")):
                continue
            raise AgentsError("Kanaldatei enthaelt unlesbare JSON-Zeile")
        addressed = list(msg.get("recipients") or []) + list(msg.get("humans") or [])
        if recipient and recipient not in addressed and msg.get("recipient") not in (recipient, "alle") and msg.get("sender") != recipient:
            continue
        result.append(msg)
    return result


def acknowledge(root: Path, recipient: str, delivery_id: str,
                sender: str | None, claimed_role: str | None) -> dict[str, Any]:
    with transaction(root):
        actor = _actor(root, sender or recipient, claimed_role)
        if actor.get("kind") == "agent" and actor.get("id") != recipient:
            raise AgentsError("Agent darf nur eigene Zustellungen quittieren")
        path = _delivery_path(root, recipient, delivery_id)
        data = _read_json(path)
        if data.get("acknowledged"):
            return data
        data["acknowledged"] = True
        data["acknowledged_at"] = now()
        data["acknowledged_by"] = recipient
        _write_json(path, data)
        return data


def _recover_pending(root: Path) -> None:
    """Repair durable-but-not-yet-delivered side effects after a crash.

    Ticket and result JSON files are the authoritative records.  Postboxes and
    the channel are idempotent projections, so a process death between their
    writes and the state write cannot lose work or duplicate it on retry.
    """
    world = read_world(root)
    if world.get("state") == "gestoppt":
        _interrupt_all_tickets(root, "Welt gestoppt")
    for agent in list_agents(root):
        if agent.get("state") == "gestoppt":
            _interrupt_agent_tickets(root, agent["id"], "Agent gestoppt")
        runtime_path = _agent_dir(root, agent["id"]) / "runtime.json"
        runtime = _read_json(runtime_path) if runtime_path.exists() else {}
        expected_runtime = {
            "state": agent.get("state"), "updated_at": agent.get("updated_at"),
            "reason": runtime.get("reason"),
        }
        if runtime != expected_runtime:
            _write_json(runtime_path, expected_runtime)
    for ticket in list_tickets(root):
        if ticket.get("state") in ("offen", "zurueckgegeben", "zurückgegeben"):
            _deliver_ticket(root, ticket, {"id": ticket.get("sender", "system"), "verified": False})
        result = ticket.get("result")
        if result and ticket.get("state") == "zur Abnahme":
            result_path = _ticket_path(root, ticket["id"]) / "ergebnis.json"
            if not result_path.exists() or _read_json(result_path) != result:
                _write_json(result_path, result)
            sender = ticket.get("sender") or "hauptagent"
            _deliver_message(root, result.get("agent", ticket.get("assignee")), sender,
                             "ticket-ergebnis", "Ergebnis zu %s" % ticket["id"], ticket["id"],
                             result.get("text", ""), ticket.get("result_message_id") or derived_id("result", ticket["id"]))
        elif ticket.get("state") == "läuft":
            result_path = _ticket_path(root, ticket["id"]) / "ergebnis.json"
            if result_path.exists() and _read_json(result_path) != {}:
                _write_json(result_path, {})
    # Channel messages are durable records whose per-agent postboxes are
    # projections.  Rebuild any projection left behind by a crash.
    for message in read_messages(root):
        for human in message.get("humans") or []:
            _ensure_human_delivery(root, human, message)
        recipients = list(message.get("recipients") or [])
        for recipient in recipients:
            target = _delivery_path(root, recipient, message["id"])
            expected = dict(message, recipient=recipient, delivery_id=message["id"], acknowledged=False)
            if target.exists():
                stored = _read_json(target)
                if any(stored.get(key) != expected.get(key)
                       for key in expected if key not in {"time", "acknowledged", "acknowledged_at", "acknowledged_by"}):
                    raise AgentsError("Kanalzustellung existiert bereits mit anderem Inhalt")
            else:
                _write_json(target, expected)
    direct_root = root / "direktchats"
    if direct_root.exists():
        if direct_root.is_symlink() or not direct_root.is_dir():
            raise AgentsError("Direktchatordner ist ungueltig")
        for chat in direct_root.iterdir():
            if chat.is_symlink():
                raise AgentsError("Direktchatordner enthaelt einen Symlink")
            if not chat.is_dir():
                continue
            for path in chat.iterdir():
                if path.is_symlink():
                    raise AgentsError("Direktchat enthaelt einen Symlink")
                if not path.is_file() or path.suffix != ".json":
                    continue
                message = _read_json(path)
                for human in message.get("humans") or []:
                    _ensure_human_delivery(root, human, message)
                for recipient in message.get("recipients", []):
                    target = _delivery_path(root, recipient, message["id"])
                    if not target.exists():
                        _write_json(target, dict(message, recipient=recipient,
                                                 delivery_id=message["id"], acknowledged=False))


def reopen_interrupted_ticket(root: Path, ticket_id: str, sender: str | None,
                              claimed_role: str | None) -> dict[str, Any]:
    """Give an interrupted ticket back to its addressees with a fresh delivery.

    A stop never wakes the agent again by itself.  Only this explicit resume
    step opens the ticket and creates a new, stable delivery identity.  A ticket
    that already carried a stored result returns to review instead of being redone.
    """
    with transaction(root):
        world = read_world(root)
        if world["state"] != "läuft":
            raise AgentsError("Welt ist %s; Ticket bleibt unterbrochen" % world["state"])
        actor = _require_actor(root, sender, claimed_role, ("hauptagent", "teamleiter"))
        ticket = read_ticket(root, ticket_id)
        if ticket["state"] in ("offen", "zur Abnahme") and ticket.get("resume_revision"):
            return ticket  # idempotent retry after a lost response
        if ticket["state"] != "unterbrochen":
            raise AgentsError("Ticket ist %s; nur unterbrochene Tickets werden fortgesetzt" % ticket["state"])
        revision = int(ticket.get("resume_revision") or 0) + 1
        ts = now()
        if ticket.get("result"):
            ticket.update({"state": "zur Abnahme", "resume_revision": revision, "updated_at": ts})
            _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
            _ticket_event(root, ticket, "fortgesetzt", actor, revision=revision, restored="zur Abnahme")
            return ticket
        ticket.update({"state": "offen", "resume_revision": revision, "updated_at": ts,
                       "return_delivery_id": derived_id("ticket-resume", ticket_id, revision),
                       "return_delivery_time": ts, "delivery_sender": actor["id"]})
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "fortgesetzt", actor, revision=revision)
        _deliver_ticket(root, ticket, actor)
        return ticket


def record_run_outcome(root: Path, ticket_id: str, run_id: str, outcome: str,
                       detail: str) -> dict[str, Any]:
    """Append the carrier's verdict about one run to the ticket history."""
    valid_id(run_id, "Laufkennung")
    if not outcome or not isinstance(detail, str):
        raise AgentsError("Laufausgang fehlt")
    with transaction(root):
        ticket = read_ticket(root, ticket_id)
        _ticket_event(root, ticket, "zug", {"id": "traeger", "verified": False, "source": "controller"},
                      run_id=run_id, outcome=outcome, detail=detail[:500])
        return ticket


# ---------------------------------------------------------------------------
# Write paths of the human (Auftrag agentsui Nr. 2): hand back an approved
# ticket, maintain profile and memory, keep the shared read state.  Each of
# them accepts only an external actor; the stored sender stays unverified.
# ---------------------------------------------------------------------------

def _require_human(root: Path, sender: str | None, claimed_role: str | None, what: str) -> dict[str, Any]:
    actor = _actor(root, sender or WORLD_HUMAN, claimed_role)
    if actor.get("kind") != "external":
        raise AgentsError("%s darf nur der Mensch; ein Agent aendert das nicht selbst" % what)
    return actor


def return_ticket(root: Path, ticket_id: str, note: str, sender: str | None = None,
                  claimed_role: str | None = None) -> dict[str, Any]:
    """The human hands an approved ticket back to the agent who worked on it."""
    if not isinstance(note, str) or not note.strip():
        raise AgentsError("Die Rueckgabe braucht eine Bemerkung")
    with transaction(root):
        actor = _require_human(root, sender, claimed_role, "Ein abgenommenes Ticket zurueckgeben")
        ticket = read_ticket(root, ticket_id)
        approval = ticket.get("approval") or {}
        if (ticket["state"] == "zurückgegeben" and approval.get("kind") == "rueckgabe-mensch"
                and approval.get("agent") == actor["id"] and approval.get("note") == note):
            return ticket  # idempotent retry after a lost response
        if ticket["state"] != "abgenommen":
            raise AgentsError("Ticket ist %s; der Mensch gibt nur abgenommene Tickets zurueck" % ticket["state"])
        ts = now()
        revision = int(ticket.get("return_revision") or 0) + 1
        delivery_id = derived_id("ticket-return", ticket_id, revision)
        target = [ticket["assignee"]] if ticket.get("assignee") else list(ticket.get("recipients") or [])
        ticket.update({
            "state": "zurückgegeben", "previous_approval": approval,
            "approval": {"agent": actor["id"], "verified": False, "time": ts, "note": note, "kind": "rueckgabe-mensch"},
            "updated_at": ts, "return_revision": revision, "return_delivery_id": delivery_id,
            "return_delivery_time": ts, "delivery_sender": actor["id"],
            "return_to": target, "return_to_delivery": delivery_id,
        })
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "zurueckgegeben", actor, note=note, by="mensch", to=target)
        _deliver_ticket(root, ticket, actor)
        return ticket


def _append_history(root: Path, agent_id: str, entry: dict[str, Any]) -> None:
    path = _agent_dir(root, agent_id) / "history.json"
    history = _read_optional_json(path, "Verlauf") or {"schema_version": SCHEMA_VERSION, "agent": agent_id, "entries": []}
    history.setdefault("entries", []).append(entry)
    _write_json(path, history)


def update_agent_profile(root: Path, agent_id: str, changes: dict[str, Any], sender: str | None = None,
                         claimed_role: str | None = None) -> dict[str, Any]:
    """Change model, thinking level, fallback, machine or specialty of an agent.

    A model change applies from the agent's next start: a running turn keeps
    the model it started with.  The history names every changed field.
    """
    if not isinstance(changes, dict) or not changes:
        raise AgentsError("Keine Profilaenderung angegeben")
    unknown = sorted(set(changes) - set(PROFILE_FIELDS))
    if unknown:
        raise AgentsError("Profilfeld nicht aenderbar: %s" % ", ".join(unknown))
    with transaction(root):
        actor = _require_human(root, sender, claimed_role, "Profilfelder aendern")
        agent = read_agent(root, agent_id)
        old = dict(agent.get("model_profile") or {})
        model = changes.get("model", old.get("model"))
        if not isinstance(model, str) or not model.strip():
            raise AgentsError("Modell fehlt")
        model = model.strip()
        if "effort" in changes:
            effort = changes["effort"] or None
        elif model != old.get("model"):
            effort = None  # derived from the new model's suffix
        else:
            effort = old.get("effort")
        fallback = (changes["fallback_model"] or None) if "fallback_model" in changes else old.get("fallback_model")
        if isinstance(fallback, str):
            fallback = fallback.strip() or None
        if "fallback_effort" in changes:
            fallback_effort = changes["fallback_effort"] or None
        elif fallback != old.get("fallback_model"):
            fallback_effort = None
        else:
            fallback_effort = old.get("fallback_effort")
        profile = dict(old)
        profile.update(_model(model, effort, fallback, fallback_effort))
        diff: dict[str, list[Any]] = {}
        for key in ("model", "effort", "fallback_model", "fallback_effort"):
            if old.get(key) != profile.get(key):
                diff[key] = [old.get(key), profile.get(key)]
        machine = agent.get("machine")
        if "machine" in changes:
            machine = valid_id(str(changes["machine"] or ""), "Maschine")
            if machine != agent.get("machine"):
                diff["machine"] = [agent.get("machine"), machine]
        specialty = agent.get("specialty")
        if "specialty" in changes:
            specialty = str(changes["specialty"] or "").strip()
            if not specialty:
                raise AgentsError("Spezialgebiet fehlt")
            if specialty != agent.get("specialty"):
                diff["specialty"] = [agent.get("specialty"), specialty]
        if not diff:
            return agent
        ts = now()
        agent.update({"model_profile": profile, "machine": machine, "specialty": specialty, "profile_updated_at": ts})
        _write_json(_agent_dir(root, agent_id) / "agent.json", agent)
        model_changed = any(key in diff for key in ("model", "effort", "fallback_model", "fallback_effort"))
        _append_history(root, agent_id, {
            "id": new_id("h"), "time": ts, "event": "profil", "actor": actor, "changes": diff,
            "note": "Modellwechsel gilt ab dem nächsten Start" if model_changed else None,
        })
        return agent


def _write_text(path: Path, text: str) -> None:
    _reject_symlink(path, "Zieldatei")
    if path.is_symlink():
        raise AgentsError("Zieldatei darf kein Symlink sein")
    if atomar_schreiben is not None:
        atomar_schreiben.schreiben(str(path), text, modus=0o600, dauerhaft=True)
        return
    tmp = path.with_name(".%s.tmp-%s" % (path.name, uuid.uuid4().hex))
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(tmp), str(path))
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def write_memory(root: Path, agent_id: str, text: str, expected_sha256: str | None = None,
                 sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Replace an agent's MEMORY.md on behalf of the human, atomically.

    With `expected_sha256` the write only happens if the file still has the
    content the editor loaded; the agent maintains the file itself as well.
    """
    if not isinstance(text, str):
        raise AgentsError("Gedaechtnistext fehlt")
    data = text.encode("utf-8")
    if len(data) > MEMORY_WRITE_LIMIT:
        raise AgentsError("Gedaechtnis ist groesser als %d Bytes" % MEMORY_WRITE_LIMIT)
    with transaction(root):
        actor = _require_human(root, sender, claimed_role, "Das Gedaechtnis eines Agenten bearbeiten")
        read_agent(root, agent_id)
        path = _agent_dir(root, agent_id) / "MEMORY.md"
        if path.is_symlink():
            raise AgentsError("Gedaechtnisdatei darf kein Symlink sein")
        before = path.read_bytes() if path.exists() else b""
        before_sha = hashlib.sha256(before).hexdigest()
        if expected_sha256 is not None and expected_sha256 != before_sha:
            raise AgentsError("Gedaechtnis wurde inzwischen geaendert; neu laden und erneut bearbeiten")
        after_sha = hashlib.sha256(data).hexdigest()
        if before == data:
            return {"agent": agent_id, "sha256": after_sha, "changed": False}
        _write_text(path, text)
        _append_history(root, agent_id, {
            "id": new_id("h"), "time": now(), "event": "gedaechtnis", "actor": actor,
            "note": "vom Menschen bearbeitet", "sha256_before": before_sha, "sha256_after": after_sha,
            "bytes": len(data),
        })
        return {"agent": agent_id, "sha256": after_sha, "changed": True}


def mark_read(root: Path, conversation: str, message_time: str, message_id: str,
              human: str = WORLD_HUMAN, sender: str | None = None,
              claimed_role: str | None = None) -> dict[str, Any]:
    """Advance the shared read state of the human for one conversation.

    Keys are `kanal`, `einzel:<agent>` and `direkt:<chat>`.  The mark only
    moves forward (time, then message id), so two surfaces cannot undo each
    other's reading.
    """
    if not isinstance(conversation, str) or not READ_KEY_RE.fullmatch(conversation):
        raise AgentsError("Gespraech ungueltig (kanal, einzel:<agent>, direkt:<chat>)")
    if not isinstance(message_time, str) or not message_time or len(message_time) > 40:
        raise AgentsError("Nachrichtenzeit ungueltig")
    valid_id(message_id, "Nachrichtenkennung")
    if human != WORLD_HUMAN:
        raise AgentsError("Nur '%s' hat einen Lesestand in der Welt" % WORLD_HUMAN)
    with transaction(root):
        actor = _require_human(root, sender, claimed_role, "Den Lesestand des Menschen setzen")
        path = child(root, "menschen", human) / "gelesen.json"
        state = _read_optional_json(path, "Lesestand") or {"schema_version": SCHEMA_VERSION, "human": human, "conversations": {}}
        current = (state.get("conversations") or {}).get(conversation)
        if current and (str(current.get("time") or ""), str(current.get("id") or "")) >= (message_time, message_id):
            return state
        state.setdefault("conversations", {})[conversation] = {
            "time": message_time, "id": message_id, "at": now(), "by": actor["id"], "verified": False}
        state["updated_at"] = now()
        _write_json(path, state)
        return state


# ---------------------------------------------------------------------------
# Creating agents from a full draft (plan section 9, build step 5).
#
# A draft is what the creation menu, a library template or a model proposal
# fills in.  It is checked against a positive list of fields, the tool set the
# carrier can start, and the house list of blocked programs and patterns
# (shell/wb-profil-gesperrt.json, the same rules as wb-profil).  The agent
# itself is created by `create_agent`; the fields it does not know (Bash
# patterns, context limit, the instruction file) follow in a second
# transaction, after every check has passed.
# ---------------------------------------------------------------------------

AGENT_DRAFT_FIELDS = ("id", "stage", "team", "specialty", "model", "effort", "fallback_model",
                      "fallback_effort", "machine", "tools", "bash", "skills", "context_limit",
                      "figure", "instructions", "template")
# The tools the carrier's runner accepts (agents_claude_runner.ALLOWED_TOOLS).
AGENT_TOOLS = ("Bash", "Read", "Write", "Edit", "Glob", "Grep")
FIGURE_FAMILIES = ("roboter", "tier", "linse")
FIGURE_COLORS = ("entwicklung", "recherche", "pruefung", "gestaltung")
SPECIALTY_LIMIT = 300
CONTEXT_LIMIT_LIMIT = 600
INSTRUCTIONS_LIMIT = 64 * 1024
LIBRARY_DIR = Path(__file__).resolve().parent.parent / "agents" / "bibliothek"
AGENT_REQUEST_KIND = "agent-antrag"
# Defaults for a profile created without tools (`create_world`, `create_agent`): the
# profile lock refuses every tool that is not listed, so an empty list stops a turn
# before its first step.  Main agent and team leader work in their worktree; a member
# reads and reports.
DEFAULT_TOOLS = {"hauptagent": ("Bash", "Read", "Grep", "Glob", "Write", "Edit"),
                 "teamleiter": ("Bash", "Read", "Grep", "Glob", "Write", "Edit"),
                 "mitglied": ("Bash", "Read", "Grep", "Glob")}
# The Bash patterns a turn needs in any case: the controller RPC client in the turn
# directory, stored scripts (`agents/bibliothek/skripte`), skill scripts and reading git.
# An interpreter pattern without a narrower argument (`python3 *`) grants nothing.
DEFAULT_BASH = ("python3 */rpc/agents_rpc_client.py *",
                "python3 */skripte/*/*.py *", "sh */skripte/*/*.sh *", "*/skripte/*/*.py *",
                "python3 */skills/*/scripts/*.py *", "*/skills/*/scripts/*.py *",
                "git status", "git diff *", "git log *", "git show *")
_HOUSE_RULES: Any = None


def _house_rules() -> Any:
    """The checks of wb-profil (blocked programs and patterns), loaded once; fail closed."""
    global _HOUSE_RULES
    if _HOUSE_RULES is None:
        import importlib.machinery
        import importlib.util
        path = Path(__file__).resolve().parent / "wb-profil"
        try:
            loader = importlib.machinery.SourceFileLoader("wb_profil_hausliste", str(path))
            spec = importlib.util.spec_from_loader(loader.name, loader)
            module = importlib.util.module_from_spec(spec)
            loader.exec_module(module)
            blocked = module.gesperrt_laden()
        except (OSError, ImportError, AttributeError, SyntaxError) as exc:
            raise AgentsError("Hausliste gesperrter Werkzeuge ist nicht lesbar (wb-profil)") from exc
        if not blocked.get("programme"):
            raise AgentsError("Hausliste gesperrter Werkzeuge ist leer; kein Agent wird angelegt")
        _HOUSE_RULES = (module, blocked)
    return _HOUSE_RULES


def _text_list(value: Any, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise AgentsError("%s muss eine Liste nichtleerer Texte sein" % label)
    return list(dict.fromkeys(item.strip() for item in value))


def validate_agent_draft(draft: dict[str, Any], for_agent: bool = False) -> dict[str, Any]:
    """Check a creation draft without touching a world; return it normalized.

    `for_agent` applies the stricter rules for drafts an agent writes: no stage
    above team leader.
    """
    if not isinstance(draft, dict):
        raise AgentsError("Entwurf muss ein Objekt sein")
    unknown = sorted(set(draft) - set(AGENT_DRAFT_FIELDS))
    if unknown:
        raise AgentsError("Entwurf enthaelt Felder ausserhalb der Positivliste: %s" % ", ".join(unknown))
    agent_id = draft.get("id")
    if not isinstance(agent_id, str):
        raise AgentsError("Entwurf braucht eine Agentenkennung")
    valid_id(agent_id, "Agentenkennung")
    if agent_id in HUMAN_ACTORS:
        raise AgentsError("Agentenkennung '%s' ist fuer Menschen und Entwicklungsakteure reserviert" % agent_id)
    stage = draft.get("stage") or "mitglied"
    if stage not in STAGES:
        raise AgentsError("Stufe ungueltig (hauptagent, teamleiter, mitglied)")
    if for_agent and stage == "hauptagent":
        raise AgentsError("Ein Agent legt keine Stufe ueber Teamleiter an")
    team = draft.get("team") or None
    if team is not None:
        if not isinstance(team, str):
            raise AgentsError("Team muss ein Text sein")
        valid_id(team, "Teamname")
    if stage == "hauptagent" and team:
        raise AgentsError("Hauptagent gehoert keinem Team an")
    if stage == "teamleiter" and not team:
        raise AgentsError("Teamleiter braucht ein Team")
    specialty = draft.get("specialty")
    if not isinstance(specialty, str) or not specialty.strip():
        raise AgentsError("Spezialgebiet fehlt")
    specialty = " ".join(specialty.split())
    if len(specialty) > SPECIALTY_LIMIT:
        raise AgentsError("Spezialgebiet ist laenger als %d Zeichen; ein Satz genuegt" % SPECIALTY_LIMIT)
    model_profile = _model(draft.get("model") or None, draft.get("effort") or None,
                           draft.get("fallback_model") or None, draft.get("fallback_effort") or None)
    machine = draft.get("machine") or "lokal"
    if not isinstance(machine, str):
        raise AgentsError("Maschine muss ein Text sein")
    valid_id(machine, "Maschine")
    tools = _text_list(draft.get("tools"), "Werkzeuge")
    if not tools:
        raise AgentsError("Ein Agent braucht mindestens ein Werkzeug")
    foreign = [tool for tool in tools if tool not in AGENT_TOOLS]
    if foreign:
        raise AgentsError("Werkzeug nicht erlaubt: %s (erlaubt: %s)" % (", ".join(foreign), ", ".join(AGENT_TOOLS)))
    bash = _text_list(draft.get("bash"), "Bash-Muster")
    if bash and "Bash" not in tools:
        raise AgentsError("Bash-Muster brauchen das Werkzeug Bash")
    # The service path is not optional: a Claude turn answers, hands over and writes its
    # result only through the RPC client, and the profile lock reads tools and patterns
    # from agent.json.  A draft without Bash therefore gets Bash plus the default
    # patterns (RPC client, stored scripts, skill scripts, reading git); a draft with
    # own patterns keeps them and gains the missing defaults.  Measured 2026-09-15 on
    # peer: the first main agent created in the menu (Read/Grep/Glob/Edit/Write) ran,
    # could not answer "Hallo" and ended with `ergebnis_fehlt`.
    if "Bash" not in tools:
        tools = tools + ["Bash"]
    bash = bash + [pattern for pattern in DEFAULT_BASH if pattern not in bash]
    module, blocked = _house_rules()
    for entry in tools + bash:
        if module.nicht_lateinischer_name(entry):
            raise AgentsError("Eintrag '%s' beginnt mit einem nicht lateinischen Zeichen" % entry)
        reason = module.gesperrt_verstoss(entry, blocked)
        if reason:
            raise AgentsError("Eintrag '%s' ist gesperrt: %s" % (entry, reason))
    skills = _text_list(draft.get("skills"), "Skills")
    for skill in skills:
        if not re.match(r"^[a-z0-9][a-z0-9:._-]{0,79}$", skill):
            raise AgentsError("Skillname ungueltig: %s" % skill)
    context_limit = draft.get("context_limit") or ""
    if not isinstance(context_limit, str):
        raise AgentsError("Kontextgrenze muss ein Text sein")
    context_limit = " ".join(context_limit.split())
    if len(context_limit) > CONTEXT_LIMIT_LIMIT:
        raise AgentsError("Kontextgrenze ist laenger als %d Zeichen" % CONTEXT_LIMIT_LIMIT)
    figure = draft.get("figure")
    if stage == "hauptagent":
        figure = {"family": "kern", "color": None}
    elif figure is None:
        figure = {"family": "roboter", "color": team if team in FIGURE_COLORS else "entwicklung"}
    else:
        if not isinstance(figure, dict) or set(figure) - {"family", "color"}:
            raise AgentsError("Figur braucht genau family und color")
        if figure.get("family") not in FIGURE_FAMILIES:
            raise AgentsError("Figurart muss %s sein" % ", ".join(FIGURE_FAMILIES))
        if figure.get("color") not in FIGURE_COLORS:
            raise AgentsError("Figurfarbe muss %s sein" % ", ".join(FIGURE_COLORS))
        figure = {"family": figure["family"], "color": figure["color"]}
    instructions = draft.get("instructions") or ""
    if not isinstance(instructions, str):
        raise AgentsError("Anweisungsdatei muss ein Text sein")
    if len(instructions.encode("utf-8")) > INSTRUCTIONS_LIMIT:
        raise AgentsError("Anweisungsdatei ist groesser als %d Bytes" % INSTRUCTIONS_LIMIT)
    template = draft.get("template") or None
    if template is not None:
        valid_id(template, "Vorlage")
    return {
        "id": agent_id, "stage": stage, "team": team, "specialty": specialty,
        "model": model_profile["model"], "effort": model_profile["effort"],
        "fallback_model": model_profile["fallback_model"], "fallback_effort": model_profile["fallback_effort"],
        "machine": machine, "tools": tools, "bash": bash, "skills": skills, "context_limit": context_limit,
        "figure": figure, "instructions": instructions, "template": template,
    }


_STAGE_WORDS = {"hauptagent": "Hauptagent", "teamleiter": "Teamleiter", "mitglied": "Mitglied"}
# Marks the block an own instruction file always ends with: the limits as the
# profile records them.  Everything after the mark is rewritten on creation.
INSTRUCTIONS_LIMITS_MARK = "<!-- wb-agent: verbindliche Grenzen aus dem Profil -->"


def _limits_lines(draft: dict[str, Any]) -> list[str]:
    tools = ", ".join(t for t in draft["tools"] if t != "Bash")
    lines = ["- Werkzeuge: %s." % (tools or "keine außer Bash")]
    if draft["bash"]:
        lines.append("- Bash nur mit diesen Mustern: %s." % ", ".join("`%s`" % b for b in draft["bash"]))
    lines.append("- Skills: %s." % (", ".join(draft["skills"]) if draft["skills"] else "keine vorgeladenen"))
    if draft.get("context_limit"):
        lines.append("- Was du nicht erfährst und nicht erfragst: %s" % draft["context_limit"])
    lines += ["- Kein Eingriff außerhalb der Welt. Freigaben, Regeln und Profile erweiterst du nicht.",
              "- Deploy, Veröffentlichung, E-Mail und Ausgaben nur mit bestehender Freigabe (`wb-freigabe pruefen`).",
              "- Die Regeln für Agenten stehen in `regeln/agenten.md`."]
    return lines


def _with_profile_limits(text: str, draft: dict[str, Any]) -> str:
    """An own instruction file (menu, model proposal) ends with the limits of the profile, rewritten each time."""
    head = text.split(INSTRUCTIONS_LIMITS_MARK)[0].rstrip()
    return "%s\n\n%s\n## Verbindliche Grenzen aus dem Profil\n\n%s\n" % (head, INSTRUCTIONS_LIMITS_MARK, "\n".join(_limits_lines(draft)))


def render_agent_instructions(root: Path, draft: dict[str, Any]) -> str:
    """The personal instruction file (AGENTS.md) from the house template:
    role, specialty, limits and reporting lines."""
    root = world_path(str(root))
    world = read_world(root)
    agents = list_agents(root)
    main = next((a["id"] for a in agents if a.get("stage") == "hauptagent"), None)
    leader = next((a["id"] for a in agents if a.get("stage") == "teamleiter" and a.get("team") == draft.get("team")
                   and a["id"] != draft["id"]), None)
    stage = draft["stage"]
    where = "Team „%s“ der Welt „%s“" % (draft["team"], world.get("name")) if draft.get("team") else "der Welt „%s“" % world.get("name")
    lines = ["# %s – Anweisungen" % draft["id"], "",
             "Du bist %s, %s in %s." % (draft["id"], _STAGE_WORDS[stage], where), "",
             "## Rolle", "", draft["specialty"], "",
             "## Arbeitsweise", "",
             "- Du arbeitest an Tickets und Nachrichten, die an dich adressiert sind.",
             "- Ein Zug endet mit einer Entscheidung: fertig, Weckzeit, Übergabe oder „braucht dich“ über den Dienstweg.",
             "- Ergebnisse gehören ins Ticket, nicht in den Kanal. Nachrichten tragen Adressat und Handlung, kein Statusverkehr.",
             "- Dein Gedächtnis ist `MEMORY.md` in deinem Agentenordner. Du pflegst es selbst.", "",
             "## Meldewege", ""]
    if stage == "mitglied":
        target = leader or main or "den Hauptagenten"
        lines += ["- Ergebnisse, Rückfragen und Hindernisse gehen an %s." % target,
                  "- Fragen an den Menschen stellst du nicht; du antwortest und berichtest."]
    elif stage == "teamleiter":
        lines += ["- Du verteilst die Tickets deines Teams und nimmst sie ab.",
                  "- Rückfragen und Anträge gehen an den Hauptagenten %s." % (main or ""),
                  "- Einen neuen Agenten beantragst du mit `wb-agent antrag`; die Entscheidung trifft der Hauptagent."]
    else:
        lines += ["- Du verteilst Tickets, nimmst ab, führst zusammen und legst Agenten an.",
                  "- Den Menschen fragst du nur in den Fällen aus `regeln/agenten.md`; alles andere entscheidest du und schreibst es ins Ticket."]
    # The limits close the file behind the mark, exactly as for an own instruction file.
    return _with_profile_limits("\n".join(line.rstrip() for line in lines), draft)


def preview_agent_draft(root: Path, draft: dict[str, Any]) -> dict[str, Any]:
    """Normalized draft plus the instruction file it would get; writes nothing."""
    normalized = validate_agent_draft(draft)
    own = normalized["instructions"]
    instructions = _with_profile_limits(own, normalized) if own else render_agent_instructions(root, normalized)
    return {"draft": normalized, "instructions": instructions,
            "instructions_source": "entwurf" if normalized["instructions"] else "vorlage"}


def create_agent_from_draft(root: Path, draft: dict[str, Any], sender: str | None = None,
                            claimed_role: str | None = None, request_id: str | None = None) -> dict[str, Any]:
    """Create an agent with every field of the creation menu.

    Role rules are those of `create_agent`: main agents and external actors
    create, team leaders file a request instead (`request_agent`).
    """
    root = world_path(str(root))
    actor = _actor(root, sender, claimed_role)
    normalized = validate_agent_draft(draft, for_agent=actor.get("kind") == "agent")
    if request_id is not None:
        valid_id(request_id, "Antragskennung")
        try:
            existing = read_agent(root, normalized["id"])
        except AgentsError:
            existing = None
        if existing is not None and existing.get("request") == request_id:
            return existing  # retry after a crash between creation and decision
    own = normalized["instructions"]
    instructions = _with_profile_limits(own, normalized) if own else render_agent_instructions(root, normalized)
    create_agent(root, normalized["id"], normalized["stage"], normalized["team"], normalized["specialty"],
                 normalized["figure"], normalized["tools"], normalized["model"], normalized["effort"],
                 normalized["fallback_model"], normalized["fallback_effort"], normalized["machine"],
                 sender, claimed_role, normalized["skills"])
    with transaction(root):
        agent = read_agent(root, normalized["id"])
        agent.update({
            "bash": normalized["bash"], "context_limit": normalized["context_limit"],
            "template": normalized["template"], "request": request_id,
            "instructions_source": "entwurf" if normalized["instructions"] else "vorlage",
            "created_by": {"id": actor["id"], "kind": actor.get("kind"), "verified": False},
        })
        path = _agent_dir(root, normalized["id"])
        _write_json(path / "agent.json", agent)
        _write_text(path / "AGENTS.md", instructions)
        _append_history(root, normalized["id"], {
            "id": new_id("h"), "time": now(), "event": "angelegt", "actor": actor["id"], "verified": False,
            "note": "aus Antrag %s" % request_id if request_id else ("aus Vorlage %s" % normalized["template"] if normalized["template"] else None),
        })
        return agent


def request_agent(root: Path, draft: dict[str, Any], sender: str | None = None,
                  claimed_role: str | None = None, request_id: str | None = None) -> dict[str, Any]:
    """A team leader asks the main agent for a new member of the own team.

    The request is an open question addressed to the main agent
    (`kind: agent-antrag`) and a direct message that wakes him; nothing is
    created until `decide_agent_request`.
    """
    root = world_path(str(root))
    if request_id is not None:
        valid_id(request_id, "Antragskennung")
    with transaction(root):
        actor = _actor(root, sender, claimed_role)
        if actor.get("kind") != "agent" or actor.get("role") != "teamleiter":
            raise AgentsError("Antraege auf neue Agenten stellen Teamleiter")
        own_team = read_agent(root, actor["id"]).get("team")
        draft = dict(draft or {})
        if not draft.get("team"):
            draft["team"] = own_team
        normalized = validate_agent_draft(draft, for_agent=True)
        if normalized["stage"] != "mitglied":
            raise AgentsError("Ein Teamleiter beantragt nur Mitglieder")
        if normalized["team"] != own_team:
            raise AgentsError("Ein Teamleiter beantragt nur Mitglieder fuer das eigene Team '%s'" % own_team)
        main = next((a["id"] for a in list_agents(root) if a.get("stage") == "hauptagent"), None)
        if main is None:
            raise AgentsError("Welt hat keinen Hauptagenten, der den Antrag entscheidet")
        world = read_world(root)
        if world["state"] != "läuft":
            raise AgentsError("Welt ist %s; kein Antrag wird gestellt" % world["state"])
        request_id = request_id or new_id("antrag")
        path = _question_dir(root, request_id)
        text = "Antrag von %s: %s als Mitglied im Team %s anlegen? %s" % (
            actor["id"], normalized["id"], normalized["team"], normalized["specialty"])
        if path.exists() or path.is_symlink():
            question = read_question(root, request_id)
            if question.get("kind") != AGENT_REQUEST_KIND or question.get("draft") != normalized:
                raise AgentsError("Antragskennung existiert bereits mit anderem Inhalt")
        else:
            if _agent_dir(root, normalized["id"]).exists():
                raise AgentsError("Agent existiert bereits: %s" % normalized["id"])
            timestamp = now()
            question = {
                "schema_version": SCHEMA_VERSION, "id": request_id, "world": world["id"],
                "text": text, "options": ["anlegen", "ablehnen"], "recommendation": None, "ticket": None,
                "state": "offen", "answer": None, "withdrawal": None,
                "sender": actor["id"], "sender_verified": False,
                "created_at": timestamp, "updated_at": timestamp,
                "kind": AGENT_REQUEST_KIND, "to": main, "draft": normalized,
            }
            stage_path = path.parent / (".%s.creating-%s" % (request_id, uuid.uuid4().hex))
            try:
                stage_path.mkdir(parents=True)
                _write_json(stage_path / "question.json", question)
                os.replace(stage_path, path)
            except BaseException:
                shutil.rmtree(stage_path, ignore_errors=True)
                raise
    send_message(root, actor["id"], [main], "%s (Antrag %s; entscheiden mit wb-agent antrag-entscheiden)" % (text, request_id),
                 None, derived_id("antrag", request_id), "teamleiter", direct=True)
    return question


def decide_agent_request(root: Path, request_id: str, accept: bool, note: str | None = None,
                         sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """The main agent accepts (creates the agent) or declines a team leader's request."""
    root = world_path(str(root))
    valid_id(request_id, "Antragskennung")
    if note is not None and (not isinstance(note, str) or not note.strip()):
        raise AgentsError("Bemerkung muss ein Text sein")
    decision = "anlegen" if accept else "ablehnen"
    with transaction(root):
        actor = _require_actor(root, sender, claimed_role, ("hauptagent",))
        question = read_question(root, request_id)
        if question.get("kind") != AGENT_REQUEST_KIND:
            raise AgentsError("%s ist kein Antrag auf einen Agenten" % request_id)
        if question.get("state") == "beantwortet":
            if (question.get("answer") or {}).get("text") == decision:
                return question
            raise AgentsError("Antrag ist bereits anders entschieden")
        if question.get("state") != "offen":
            raise AgentsError("Antrag ist %s" % question.get("state"))
        draft = question["draft"]
    agent = create_agent_from_draft(root, draft, sender, claimed_role, request_id) if accept else None
    with transaction(root):
        question = read_question(root, request_id)
        if question.get("state") != "beantwortet":
            question["state"] = "beantwortet"
            question["answer"] = {"text": decision, "note": note, "sender": actor["id"], "role": actor.get("role"),
                                  "verified": False, "source": "cli-argument", "answered_at": now(),
                                  "agent": agent["id"] if agent else None}
            question["updated_at"] = question["answer"]["answered_at"]
            _write_json(_question_dir(root, request_id) / "question.json", question)
    if actor.get("kind") == "agent":
        reply = "Antrag %s: %s%s" % (request_id, "angelegt" if accept else "abgelehnt", " – %s" % note if note else "")
        send_message(root, actor["id"], [question["sender"]], reply,
                     None, derived_id("antrag-entschieden", request_id), "hauptagent", direct=True)
    return question


def list_agent_templates(folder: Path | None = None) -> list[dict[str, Any]]:
    """The library of ready-made profiles (agents/bibliothek/*.json), each checked like a draft."""
    folder = Path(folder) if folder is not None else LIBRARY_DIR
    if not folder.is_dir():
        return []
    result = []
    for path in sorted(folder.glob("*.json")):
        if path.is_symlink():
            raise AgentsError("Vorlage darf kein Symlink sein: %s" % path.name)
        data = _read_json(path)
        if not isinstance(data, dict) or set(data) - {"name", "title", "summary", "draft"}:
            raise AgentsError("Vorlage %s braucht genau name, title, summary und draft" % path.name)
        if data.get("name") != path.stem:
            raise AgentsError("Vorlage %s: name passt nicht zum Dateinamen" % path.name)
        draft = dict(data.get("draft") or {}, template=path.stem)
        try:
            normalized = validate_agent_draft(draft)
        except AgentsError as exc:
            raise AgentsError("Vorlage %s: %s" % (path.name, exc)) from exc
        result.append({"name": path.stem, "title": str(data.get("title") or path.stem),
                       "summary": str(data.get("summary") or ""), "draft": normalized})
    return result


# ---------------------------------------------------------------------------
# Read-only views for the user interface (wb-welt finden, wb-welt ansicht).
#
# Nothing below writes, repairs or creates a file: no transaction, no
# recovery, not even the lock file.  A snapshot holds the world lock shared so
# it never observes half of a transaction; staging directories of a running
# transaction (leading dot) are skipped.
# ---------------------------------------------------------------------------

READ_LOCK_SECONDS = 2.0
SNAPSHOT_LIMIT = 500
SNAPSHOT_TEXT_LIMIT = 65536


@contextmanager
def _shared_read(root: Path, timeout: float = READ_LOCK_SECONDS):
    """Hold the world lock shared; yield whether the snapshot is consistent.

    The lock file is opened read-only, so a world without one stays untouched.
    A writer holding the exclusive lock longer than ``timeout`` yields an
    unlocked read marked inconsistent instead of blocking the caller.
    """
    lock_path = root / ".agents.lock"
    if lock_path.is_symlink():
        raise AgentsError("Transaktionssperre darf kein Symlink sein")
    try:
        fd = os.open(str(lock_path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        fd = -1
    locked = False
    try:
        if fd >= 0:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    locked = True
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.02)
        yield locked or fd < 0
    finally:
        if locked:
            fcntl.flock(fd, fcntl.LOCK_UN)
        if fd >= 0:
            os.close(fd)


def _visible_dirs(folder: Path, label: str) -> list[Path]:
    if not folder.exists() and not folder.is_symlink():
        return []
    if folder.is_symlink() or not folder.is_dir():
        raise AgentsError("%s ist ungueltig" % label)
    result = []
    for item in sorted(folder.iterdir()):
        if item.name.startswith("."):
            continue  # staging directory of a running transaction
        if item.is_symlink():
            raise AgentsError("%s enthaelt einen Symlink" % label)
        if item.is_dir():
            result.append(item)
    return result


def _json_files(folder: Path, label: str) -> list[Path]:
    if not folder.exists() and not folder.is_symlink():
        return []
    if folder.is_symlink() or not folder.is_dir():
        raise AgentsError("%s ist ungueltig" % label)
    result = []
    for item in sorted(folder.iterdir()):
        if item.name.startswith(".") or item.suffix != ".json":
            continue  # temporary file of an atomic write
        if item.is_symlink():
            raise AgentsError("%s enthaelt einen Symlink" % label)
        if item.is_file():
            result.append(item)
    return result


def _read_optional_json(path: Path, label: str) -> Any:
    if path.is_symlink():
        raise AgentsError("%s darf kein Symlink sein" % label)
    if not path.is_file():
        return None
    return _read_json(path)


def _read_text_capped(path: Path, limit: int) -> dict[str, Any]:
    if path.is_symlink():
        raise AgentsError("Textdatei darf kein Symlink sein: %s" % path.name)
    if not path.is_file():
        return {"text": None, "truncated": False, "modified_at": None}
    data = path.read_bytes()
    modified = _dt.datetime.fromtimestamp(path.stat().st_mtime, _dt.timezone.utc)
    return {"text": data[:limit].decode("utf-8", errors="replace"), "truncated": len(data) > limit,
            "modified_at": modified.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "sha256": hashlib.sha256(data).hexdigest()}


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    if path.is_symlink():
        raise AgentsError("%s darf kein Symlink sein" % label)
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    items = []
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            if index == len(lines) - 1 and not line.endswith(("\n", "\r")):
                continue  # unterminated tail of a crashed append
            raise AgentsError("%s enthaelt unlesbare JSON-Zeile" % label)
    return items


def _snapshot_agents(root: Path, limit: int, text_limit: int) -> list[dict[str, Any]]:
    result = []
    for item in _visible_dirs(root / "agents", "Agentordner"):
        profile = _read_optional_json(item / "agent.json", "Profil")
        if profile is None:
            continue
        deliveries = [_read_json(path) for path in _json_files(item / "postfach", "Postfach")]
        unacknowledged = [d for d in deliveries if not d.get("acknowledged")]
        history = _read_optional_json(item / "history.json", "Verlauf") or {}
        entries = list(history.get("entries") or [])
        agent = dict(profile)
        agent["runtime"] = _read_optional_json(item / "runtime.json", "Laufzustand") or {}
        agent["postbox"] = {"open": len(unacknowledged), "total": len(deliveries),
                            "open_ids": [d.get("delivery_id") or d.get("id") for d in unacknowledged][-limit:]}
        agent["memory"] = _read_text_capped(item / "MEMORY.md", text_limit)
        agent["instructions"] = _read_text_capped(item / "AGENTS.md", text_limit)
        agent["history"] = {"entries": entries[-limit:], "total": len(entries)}
        result.append(agent)
    return result


def _snapshot_tickets(root: Path, limit: int) -> list[dict[str, Any]]:
    result = []
    for item in _visible_dirs(root / "tickets", "Ticketordner"):
        ticket = _read_optional_json(item / "ticket.json", "Ticketdatei")
        if ticket is None:
            continue
        events = _read_jsonl(item / "verlauf.jsonl", "Ticketverlauf")
        ticket = dict(ticket)
        ticket["history"] = {"events": events[-limit:], "total": len(events)}
        result.append(ticket)
    return result


def _snapshot_direct_chats(root: Path, limit: int) -> list[dict[str, Any]]:
    result = []
    for chat in _visible_dirs(root / "direktchats", "Direktchatordner"):
        stamped = []
        for path in _json_files(chat, "Direktchat"):
            # Stored times have one-second resolution; the write time of the
            # file keeps messages from the same second in their order.
            stamped.append((_read_json(path), path.stat().st_mtime_ns))
        stamped.sort(key=lambda pair: (str(pair[0].get("time") or ""), pair[1], str(pair[0].get("id") or "")))
        messages = [message for message, _ in stamped]
        participants = {m.get("sender") for m in messages if m.get("sender")}
        for message in messages:
            participants.update(r for r in message.get("recipients") or [] if r)
            participants.update(h for h in message.get("humans") or [] if h)
        result.append({"id": chat.name, "participants": sorted(participants),
                       "messages": messages[-limit:], "total": len(messages)})
    return result


def _snapshot_humans(root: Path, limit: int) -> dict[str, Any]:
    """Postbox and read state of each human of the world (always `mensch`)."""
    names = {WORLD_HUMAN} | {item.name for item in _visible_dirs(root / "menschen", "Menschenordner")}
    result = {}
    for name in sorted(names):
        base = root / "menschen" / name
        deliveries = [_read_json(path) for path in _json_files(base / "postfach", "Postfach des Menschen")]
        deliveries.sort(key=lambda d: (str(d.get("time") or ""), str(d.get("id") or "")))
        unacknowledged = [d for d in deliveries if not d.get("acknowledged")]
        read_state = _read_optional_json(base / "gelesen.json", "Lesestand") or {}
        result[name] = {"postbox": {"open": len(unacknowledged), "total": len(deliveries),
                                    "deliveries": deliveries[-limit:]},
                        "read_state": read_state.get("conversations") or {}}
    return result


def _snapshot_questions(root: Path) -> list[dict[str, Any]]:
    result = []
    for item in _visible_dirs(root / "questions", "Fragenordner"):
        question = _read_optional_json(item / "question.json", "Fragedatei")
        if question is not None:
            result.append(question)
    return result


def world_snapshot(root: Path, limit: int = SNAPSHOT_LIMIT, text_limit: int = SNAPSHOT_TEXT_LIMIT,
                   lock_timeout: float = READ_LOCK_SECONDS) -> dict[str, Any]:
    """Everything the Agents view draws for one world, read-only."""
    if limit < 1 or text_limit < 1:
        raise AgentsError("Grenzen muessen positiv sein")
    root = world_path(str(root))
    if not root.is_dir():
        raise AgentsError("Welt ist kein Verzeichnis: %s" % root)
    errors: list[dict[str, str]] = []

    def section(label: str, read, default):
        try:
            return read()
        except (AgentsError, OSError, ValueError) as exc:
            errors.append({"section": label, "text": str(exc)})
            return default

    with _shared_read(root, lock_timeout) as consistent:
        world = read_world(root)
        agents = section("agents", lambda: _snapshot_agents(root, limit, text_limit), [])
        tickets = section("tickets", lambda: _snapshot_tickets(root, limit), [])
        channel = section("channel", lambda: read_messages(root), [])
        chats = section("direct_chats", lambda: _snapshot_direct_chats(root, limit), [])
        questions = section("questions", lambda: _snapshot_questions(root), [])
        humans = section("humans", lambda: _snapshot_humans(root, limit), {})
    return {"schema_version": SCHEMA_VERSION, "path": str(root), "consistent": consistent,
            "read_at": now(), "world": world, "agents": agents, "tickets": tickets,
            "channel": channel[-limit:], "channel_total": len(channel),
            "direct_chats": chats, "questions": questions, "humans": humans, "errors": errors}


def find_worlds(roots: Iterable[str] = (), projects: Iterable[str] = (),
                global_dir: str | None = None) -> list[dict[str, Any]]:
    """Find the global world and project worlds (``<project>/.werkbank/agents``).

    A root is scanned one level deep; a project is checked directly.  The
    result names every world once, the global world first.
    """
    seen: set[str] = set()
    result: list[dict[str, Any]] = []

    def add(world_root: Path, kind: str, project: str | None) -> None:
        marker = world_root / "world.json"
        if not marker.is_file() and not marker.is_symlink():
            return
        key = os.path.realpath(str(world_root))
        if key in seen:
            return
        seen.add(key)
        entry: dict[str, Any] = {"path": str(world_root), "kind": kind, "project": project}
        try:
            world = read_world(world_root)
            entry.update({"id": world.get("id"), "name": world.get("name"),
                          "state": world.get("state"), "error": None})
        except (AgentsError, OSError) as exc:
            entry.update({"id": None, "name": Path(project).name if project else world_root.name,
                          "state": None, "error": str(exc)})
        result.append(entry)

    if global_dir:
        add(Path(os.path.abspath(os.path.expanduser(global_dir))), "global", None)
    candidates = [Path(os.path.abspath(os.path.expanduser(p))) for p in projects if p]
    for raw in roots:
        if not raw:
            continue
        base = Path(os.path.abspath(os.path.expanduser(raw)))
        if not base.is_dir():
            continue
        candidates.append(base)
        try:
            children = sorted(base.iterdir())
        except OSError:
            continue
        candidates.extend(c for c in children if not c.name.startswith(".") and c.is_dir())
    for project in candidates:
        add(project / ".werkbank" / "agents", "project", str(project))
    return result


def reply_to_delivery(root: Path, agent_id: str, delivery_id: str, text: str,
                      message_id: str, mark: str | None = None) -> dict[str, Any]:
    """Answer the sender of a message in this agent's own postbox.

    The reply goes to the same place as the original: the direct chat for a direct
    message, otherwise the channel addressed to the original sender (agent or human).
    The caller chooses neither recipient nor chat, only text and a stable message id.
    A reply that reaches the world's human lands in the human's postbox and may carry
    a mark; a question mark is reserved for the main agent.
    """
    valid_id(agent_id, "Agentenkennung")
    valid_id(message_id, "Nachrichtenkennung")
    if not isinstance(text, str) or not text.strip():
        raise AgentsError("Antworttext fehlt")
    if mark is not None and mark not in MESSAGE_MARKS:
        raise AgentsError("Markierung muss frage oder ergebnis sein")
    with transaction(root):
        agent = read_agent(root, agent_id)
        path = _delivery_path(root, agent_id, delivery_id)
        _reject_symlink(path, "Postfachdatei")
        original = _read_json(path)
        sender = original.get("sender")
        if original.get("recipient") != agent_id:
            raise AgentsError("Zustellung gehoert nicht zu diesem Agenten")
        if original.get("kind") not in ("kanal", "direktchat", "ticket-ergebnis") or not sender or sender == agent_id:
            raise AgentsError("Auf diese Zustellung gibt es keine Antwort")
        if original.get("kind") != "direktchat":
            humans = [WORLD_HUMAN] if sender == WORLD_HUMAN else []
        else:
            # Same composition as the chat id in _send_message: sender, agents, then humans.
            participants = sorted([sender] + list(original.get("recipients") or [])
                                  + list(original.get("humans") or []))
            humans = [WORLD_HUMAN] if WORLD_HUMAN in participants else []
        if mark and not humans:
            raise AgentsError("Eine Markierung gilt nur fuer Nachrichten an '%s'" % WORLD_HUMAN)
        if mark == "frage" and agent.get("stage") != "hauptagent":
            raise AgentsError("Fragen an den Menschen stellt nur der Hauptagent")
        if original.get("kind") != "direktchat":
            return _deliver_message(root, agent_id, sender, "kanal", "Antwort", original.get("ticket"), text,
                                    message_id, humans, mark)
        chat = child(root / "direktchats", derived_id("chat", *participants))
        if not chat.is_dir():
            raise AgentsError("Direktchat der Zustellung fehlt")
        recipients = list(dict.fromkeys(participant for participant in participants
                                        if participant != agent_id and participant != WORLD_HUMAN))
        message = {"id": message_id, "kind": "direktchat", "sender": agent_id, "recipients": recipients,
                   "subject": "Antwort", "ticket": original.get("ticket"), "text": text, "time": now(),
                   "sender_verified": False}
        if humans:
            message["humans"] = humans
        if mark:
            message["mark"] = mark
        target = chat / (message_id + ".json")
        if target.exists():
            stored = _read_json(target)
            if any(stored.get(key) != message.get(key) for key in message if key != "time"):
                raise AgentsError("Nachrichtenkennung existiert bereits mit anderem Inhalt")
            return stored
        _write_json(target, message)
        for recipient in recipients:
            if recipient in HUMAN_ACTORS:
                continue
            read_agent(root, recipient)
            delivery = _delivery_path(root, recipient, message_id)
            if not delivery.exists():
                _write_json(delivery, dict(message, recipient=recipient, delivery_id=message_id, acknowledged=False))
        for human in humans:
            _ensure_human_delivery(root, human, message)
        return message


def cli_error(exc: Exception) -> int:
    print("agents: FEHLER - %s" % exc, file=sys.stderr)
    return 2


def _json_or_text(args: argparse.Namespace, data: Any, label: str = "") -> None:
    if getattr(args, "json", False):
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif isinstance(data, list):
        for item in data:
            print(item.get("id") or item.get("name"))
    elif isinstance(data, dict):
        print(label or data.get("id") or data.get("name") or json.dumps(data, ensure_ascii=False))
    else:
        print(data)


def _world_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("world", help="Weltordner")


def parser_for(kind: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wb-" + kind)
    sub = parser.add_subparsers(dest="command", required=True)
    if kind == "welt":
        p = sub.add_parser("neu"); p.add_argument("world"); p.add_argument("--name"); p.add_argument("--hauptagent", default="hauptagent"); p.add_argument("--beschreibung", default="Hauptagent der Welt"); p.add_argument("--modell"); p.add_argument("--denkweise", choices=("low", "medium", "high", "xhigh")); p.add_argument("--fallback"); p.add_argument("--fallback-denkweise"); p.add_argument("--maschine", default="lokal"); p.add_argument("--global", dest="global_world", action="store_true"); p.add_argument("--ohne-hauptagent", dest="without_main", action="store_true"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("frage"); p.add_argument("world"); p.add_argument("--id"); p.add_argument("--text", required=True); p.add_argument("--option", action="append", default=[]); p.add_argument("--empfehlung"); p.add_argument("--ticket"); p.add_argument("--absender", required=True); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("fragen"); p.add_argument("world"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("antwort"); p.add_argument("world"); p.add_argument("question"); p.add_argument("--text", required=True); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("ruecknahme"); p.add_argument("world"); p.add_argument("question"); p.add_argument("--grund"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        # Read-only views for the user interface; they never write.
        p = sub.add_parser("finden"); p.add_argument("--wurzel", action="append", default=[]); p.add_argument("--projekt", action="append", default=[]); p.add_argument("--global", dest="global_dir"); p.add_argument("--ohne-global", action="store_true"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("ansicht"); p.add_argument("world"); p.add_argument("--grenze", type=int, default=SNAPSHOT_LIMIT); p.add_argument("--json", action="store_true")
        p = sub.add_parser("gelesen"); p.add_argument("world"); p.add_argument("--gespraech", required=True); p.add_argument("--zeit", required=True); p.add_argument("--nachricht", required=True); p.add_argument("--mensch", default=WORLD_HUMAN); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        for name, state in (("liste", None), ("zeigen", None), ("pause", "pausiert"), ("start", "läuft"), ("stop", "gestoppt")):
            p = sub.add_parser(name); p.add_argument("world"); p.add_argument("--grund"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        return parser
    if kind == "agent":
        p = sub.add_parser("neu"); p.add_argument("world"); p.add_argument("--name", required=True); p.add_argument("--stufe", required=True, choices=STAGES); p.add_argument("--team"); p.add_argument("--beschreibung", required=True); p.add_argument("--figur"); p.add_argument("--werkzeug", action="append", default=[]); p.add_argument("--skill", action="append", default=[]); p.add_argument("--modell"); p.add_argument("--denkweise"); p.add_argument("--fallback"); p.add_argument("--fallback-denkweise"); p.add_argument("--maschine", default="lokal"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        for name, state in (("liste", None), ("zeigen", None), ("pause", "pausiert"), ("start", "aktiv"), ("stop", "gestoppt")):
            p = sub.add_parser(name); p.add_argument("world");
            if name != "liste": p.add_argument("agent")
            p.add_argument("--grund"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("profil"); p.add_argument("world"); p.add_argument("agent"); p.add_argument("--modell"); p.add_argument("--denkweise"); p.add_argument("--fallback"); p.add_argument("--fallback-denkweise"); p.add_argument("--maschine"); p.add_argument("--beschreibung"); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("gedaechtnis"); p.add_argument("world"); p.add_argument("agent"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--text"); g.add_argument("--datei"); p.add_argument("--erwartet"); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("vorlagen"); p.add_argument("--ordner"); p.add_argument("--json", action="store_true")
        for name in ("entwurf", "anlegen", "antrag"):
            p = sub.add_parser(name); p.add_argument("world"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--entwurf"); g.add_argument("--entwurf-datei")
            p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--id"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("antrag-entscheiden"); p.add_argument("world"); p.add_argument("antrag"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--annehmen", action="store_true"); g.add_argument("--ablehnen", action="store_true")
        p.add_argument("--bemerkung"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        return parser
    if kind == "ticket":
        p = sub.add_parser("neu"); p.add_argument("world"); p.add_argument("--id"); p.add_argument("--titel", required=True); p.add_argument("--ziel", required=True); p.add_argument("--fertig", required=True); p.add_argument("--an", action="append", default=[]); p.add_argument("--team"); p.add_argument("--grenzen", default="{}"); p.add_argument("--abhaengig-von", action="append", default=[]); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("liste"); p.add_argument("world"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("zeigen"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("uebernehmen"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("ergebnis"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("--text", required=True); p.add_argument("--commit"); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        for name, accept in (("abnehmen", True), ("zurueckgeben", False)):
            p = sub.add_parser(name); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--absender", required=True); p.add_argument("--rolle"); p.add_argument("--bemerkung"); p.add_argument("--json", action="store_true")
        return parser
    p = sub.add_parser("senden"); p.add_argument("world"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--an", action="append", required=True); p.add_argument("--text", required=True); p.add_argument("--ticket"); p.add_argument("--id"); p.add_argument("--rolle"); p.add_argument("--direkt", action="store_true"); p.add_argument("--markierung", choices=MESSAGE_MARKS); p.add_argument("--json", action="store_true")
    p = sub.add_parser("lesen"); p.add_argument("world"); p.add_argument("--agent"); p.add_argument("--chat"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("quittieren"); p.add_argument("world"); p.add_argument("--agent", required=True); p.add_argument("--zustellung", required=True); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
    return parser


def run(kind: str, argv: list[str]) -> int:
    args = parser_for(kind).parse_args(argv)
    try:
        if kind == "welt":
            if args.command == "frage":
                data = ask_question(Path(args.world), args.text, args.option, args.empfehlung,
                                    args.ticket, args.id, args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            elif args.command == "fragen":
                _json_or_text(args, list_questions(Path(args.world)))
            elif args.command == "antwort":
                data = answer_question(Path(args.world), args.question, args.text,
                                       args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            elif args.command == "ruecknahme":
                data = withdraw_question(Path(args.world), args.question, args.grund,
                                         args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            elif args.command == "finden":
                roots = args.wurzel if (args.wurzel or args.projekt) else [str(Path.home() / "AI")]
                global_dir = None if args.ohne_global else (args.global_dir or str(Path.home() / ".claude" / "workbench" / "agents"))
                data = find_worlds(roots, args.projekt, global_dir)
                if args.json: _json_or_text(args, data)
                else:
                    for entry in data: print(entry["path"])
            elif args.command == "ansicht":
                data = world_snapshot(Path(args.world), args.grenze)
                if args.json: _json_or_text(args, data)
                else: print("%s: %d Agenten, %d Tickets, %d Kanalnachrichten, %d Fragen" % (data["world"].get("name"), len(data["agents"]), len(data["tickets"]), data["channel_total"], len(data["questions"])))
            elif args.command == "gelesen":
                data = mark_read(Path(args.world), args.gespraech, args.zeit, args.nachricht, args.mensch, args.absender, args.rolle)
                _json_or_text(args, data, args.gespraech)
            elif args.command == "neu": data = create_world(Path(args.world), args.name, args.hauptagent, args.beschreibung, args.modell, args.denkweise, args.fallback, args.fallback_denkweise, args.maschine, args.global_world, not args.without_main); _json_or_text(args, data, data["world"]["id"])
            elif args.command == "liste": _json_or_text(args, [read_world(Path(args.world))] if (Path(args.world) / "world.json").exists() else [])
            elif args.command == "zeigen": _json_or_text(args, read_world(Path(args.world)))
            else: _json_or_text(args, set_world_state(Path(args.world), {"pause": "pausiert", "start": "läuft", "stop": "gestoppt"}[args.command], args.grund, args.absender, args.rolle))
        elif kind == "agent":
            if args.command == "neu": data = create_agent(Path(args.world), args.name, args.stufe, args.team, args.beschreibung, args.figur, args.werkzeug, args.modell, args.denkweise, args.fallback, args.fallback_denkweise, args.maschine, args.absender, args.rolle, args.skill); _json_or_text(args, data, data["id"])
            elif args.command == "liste": _json_or_text(args, list_agents(Path(args.world)))
            elif args.command == "zeigen": _json_or_text(args, read_agent(Path(args.world), args.agent))
            elif args.command == "profil":
                changes = {key: value for key, value in (("model", args.modell), ("effort", args.denkweise),
                           ("fallback_model", args.fallback), ("fallback_effort", args.fallback_denkweise),
                           ("machine", args.maschine), ("specialty", args.beschreibung)) if value is not None}
                data = update_agent_profile(Path(args.world), args.agent, changes, args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            elif args.command == "gedaechtnis":
                text = args.text if args.text is not None else Path(args.datei).read_text(encoding="utf-8")
                _json_or_text(args, write_memory(Path(args.world), args.agent, text, args.erwartet, args.absender, args.rolle), args.agent)
            elif args.command == "vorlagen":
                _json_or_text(args, list_agent_templates(Path(args.ordner) if args.ordner else None))
            elif args.command in ("entwurf", "anlegen", "antrag"):
                try:
                    draft = json.loads(args.entwurf if args.entwurf is not None else Path(args.entwurf_datei).read_text(encoding="utf-8"))
                except json.JSONDecodeError as exc:
                    raise AgentsError("--entwurf braucht JSON") from exc
                if args.command == "entwurf": data = preview_agent_draft(Path(args.world), draft)
                elif args.command == "anlegen": data = create_agent_from_draft(Path(args.world), draft, args.absender, args.rolle)
                else: data = request_agent(Path(args.world), draft, args.absender, args.rolle, args.id)
                _json_or_text(args, data, data.get("id", ""))
            elif args.command == "antrag-entscheiden":
                data = decide_agent_request(Path(args.world), args.antrag, args.annehmen, args.bemerkung, args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            else: _json_or_text(args, set_agent_state(Path(args.world), args.agent, {"pause": "pausiert", "start": "aktiv", "stop": "gestoppt"}[args.command], args.grund, args.absender, args.rolle))
        elif kind == "ticket":
            if args.command == "neu":
                try: limits = json.loads(args.grenzen)
                except json.JSONDecodeError as exc: raise AgentsError("--grenzen braucht JSON") from exc
                data = create_ticket(Path(args.world), args.titel, args.ziel, args.fertig, args.an, args.absender, args.rolle, args.team, limits, args.abhaengig_von, args.id); _json_or_text(args, data, data["id"])
            elif args.command == "liste": _json_or_text(args, list_tickets(Path(args.world)))
            elif args.command == "zeigen": _json_or_text(args, read_ticket(Path(args.world), args.ticket))
            elif args.command == "uebernehmen": _json_or_text(args, claim_ticket(Path(args.world), args.ticket, args.agent, args.absender, args.rolle))
            elif args.command == "ergebnis": _json_or_text(args, write_result(Path(args.world), args.ticket, args.agent, args.text, args.commit, args.absender, args.rolle))
            elif args.command == "zurueckgeben" and args.absender in HUMAN_ACTORS and (
                    read_ticket(Path(args.world), args.ticket).get("state") == "abgenommen"
                    or (read_ticket(Path(args.world), args.ticket).get("approval") or {}).get("kind") == "rueckgabe-mensch"):
                _json_or_text(args, return_ticket(Path(args.world), args.ticket, args.bemerkung or "", args.absender, args.rolle))
            else: _json_or_text(args, approve_ticket(Path(args.world), args.ticket, args.absender, args.rolle, args.bemerkung, args.command == "abnehmen"))
        else:
            if args.command == "senden" and args.markierung:
                _json_or_text(args, send_marked_message(Path(args.world), args.absender, args.an, args.text, args.markierung, args.ticket, args.id, args.rolle, args.direkt))
            elif args.command == "senden": _json_or_text(args, send_message(Path(args.world), args.absender, args.an, args.text, args.ticket, args.id, args.rolle, args.direkt))
            elif args.command == "lesen": _json_or_text(args, read_messages(Path(args.world), args.agent, args.chat))
            else: _json_or_text(args, acknowledge(Path(args.world), args.agent, args.zustellung, args.absender, args.rolle))
        return 0
    except (AgentsError, OSError, ValueError) as exc:
        return cli_error(exc)


# ---------------------------------------------------------------------------
# Return path into a session inbox (docs/AGENTS-PLAN.md section 7, agentsui order no. 5)
# ---------------------------------------------------------------------------
#
# An orchestrator in the code tab creates a ticket with `wb-ticket neu --welt <ordner> ...
# --absender orchestrator`. `wb-ticket` then records the messaging socket of the calling
# Claude Code session in `limits.rueckweg` (never its token). When the ticket is approved,
# `approve_ticket` calls `deliver_to_session_inbox`, which writes the result into that inbox the
# same way `wb-inbox sende` does: one auth line with the peer token from the session registry,
# one user line with the text. The carrier may call it again later; a delivered result is not
# sent twice. The functions stand before the entry point so the script sees them too.

SESSION_RETURN_KIND = "sitzungs-inbox"
SESSION_RETURN_FILE = "rueckweg.json"
AGENT_TRAFFIC_PAUSE = ".agentverkehr-pause"


def _session_registry(home: str | os.PathLike[str] | None = None) -> Path:
    return Path(home or Path.home()) / ".claude" / "sessions"


def _process_parent(pid: int) -> int | None:
    import subprocess
    try:
        out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    value = out.stdout.strip()
    return int(value) if out.returncode == 0 and value.isdigit() else None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _registered_session(registry: Path, pid: int) -> dict[str, Any] | None:
    path = registry / ("%d.json" % pid)
    if path.is_symlink() or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    socket_path = data.get("messagingSocketPath") if isinstance(data, dict) else None
    if data.get("pid") != pid or not _pid_alive(pid) or not socket_path or not os.path.exists(socket_path):
        return None
    return data


def find_session_inbox(pid: int | None = None, start_pid: int | None = None,
                       home: str | os.PathLike[str] | None = None) -> dict[str, Any] | None:
    """The Claude Code session to report back to, as a ``limits.rueckweg`` entry, or None.

    With ``pid`` only that registered session counts. Without it the first process in the
    parent chain of ``start_pid`` (default: this process) that is registered in
    ``~/.claude/sessions`` with a live messaging socket. The entry holds no token and no time,
    so a retried `wb-ticket neu --id ...` stays the same ticket.
    """
    registry = _session_registry(home)
    if pid is not None:
        chain = [int(pid)]
    else:
        chain, current = [], int(start_pid or os.getpid())
        while current and current > 1 and len(chain) < 64:
            chain.append(current)
            current = _process_parent(current) or 0
    for candidate in chain:
        data = _registered_session(registry, candidate)
        if data:
            return {"art": SESSION_RETURN_KIND, "pid": candidate, "session_id": data.get("sessionId"),
                    "proc_start": data.get("procStart"), "socket": data["messagingSocketPath"],
                    "name": data.get("name"), "tmux": data.get("tmux"), "cwd": data.get("cwd")}
    return None


def prepare_ticket_new(argv: list[str], start_pid: int | None = None,
                       home: str | os.PathLike[str] | None = None) -> tuple[list[str], dict[str, Any] | None, str | None]:
    """Resolve the options `wb-ticket neu` adds before `agents_data.py ticket neu` sees them.

    ``--welt <ordner>`` stands for the world as first argument. ``--absender orchestrator`` adds
    the calling session's inbox as return path to ``--grenzen``; ``--inbox keine`` leaves it out,
    ``--inbox-pid <pid>`` pins the session. Returns (argv, return path, warning).
    """
    rest: list[str] = []
    world = None
    inbox = "auto"
    inbox_pid = None
    limits_index = None
    sender = None
    i = 0
    items = list(argv)
    if items and items[0] == "neu":
        items = items[1:]
    while i < len(items):
        item = items[i]
        name, eq, inline = item.partition("=")
        if name in ("--welt", "--inbox", "--inbox-pid") and not eq:
            if i + 1 >= len(items):
                raise AgentsError("%s braucht einen Wert" % name)
            inline, i = items[i + 1], i + 1
        if name == "--welt" and item.startswith("--welt"):
            world = inline
        elif name == "--inbox" and item.startswith("--inbox") and not item.startswith("--inbox-pid"):
            if inline not in ("auto", "keine"):
                raise AgentsError("--inbox kennt auto oder keine")
            inbox = inline
        elif name == "--inbox-pid":
            if not inline.isdigit():
                raise AgentsError("--inbox-pid braucht eine Prozessnummer")
            inbox_pid = int(inline)
        else:
            if name == "--absender":
                sender = inline if eq else (items[i + 1] if i + 1 < len(items) else None)
            if name == "--grenzen":
                limits_index = len(rest)
            rest.append(item)
        i += 1
    if world is not None:
        rest.insert(0, world)
        if limits_index is not None:
            limits_index += 1
    if sender != "orchestrator":
        if inbox_pid is not None or inbox != "auto":
            raise AgentsError("--inbox und --inbox-pid gelten nur mit --absender orchestrator")
        return ["neu"] + rest, None, None
    if inbox == "keine":
        return ["neu"] + rest, None, None
    route = find_session_inbox(inbox_pid, start_pid, home)
    if route is None:
        if inbox_pid is not None:
            raise AgentsError("Keine lebende Claude-Code-Sitzung mit PID %d im Sitzungsregister" % inbox_pid)
        return ["neu"] + rest, None, ("kein Rueckweg eingetragen: keine Claude-Code-Sitzung mit Inbox "
                                      "in der Aufrufkette")
    if limits_index is None:
        limits: dict[str, Any] = {}
        rest += ["--grenzen", ""]
        limits_index = len(rest) - 2
    item = rest[limits_index]
    raw = item.partition("=")[2] if "=" in item else rest[limits_index + 1]
    try:
        limits = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise AgentsError("--grenzen braucht JSON") from exc
    if not isinstance(limits, dict):
        raise AgentsError("--grenzen braucht ein JSON-Objekt")
    limits["rueckweg"] = route
    encoded = json.dumps(limits, ensure_ascii=False, sort_keys=True)
    if "=" in item:
        rest[limits_index] = "--grenzen=" + encoded
    else:
        rest[limits_index + 1] = encoded
    return ["neu"] + rest, route, None


def _peer_pid(sock: Any) -> int | None:
    import socket as _socket
    import struct
    try:
        if sys.platform == "darwin":
            return int.from_bytes(sock.getsockopt(0, 0x002, 4), sys.byteorder)  # SOL_LOCAL, LOCAL_PEERPID
        if hasattr(_socket, "SO_PEERCRED"):
            return struct.unpack("3i", sock.getsockopt(_socket.SOL_SOCKET, _socket.SO_PEERCRED, 12))[0]
    except OSError:
        return None
    return None


def _session_return_text(root: Path, ticket: dict[str, Any]) -> str:
    world = read_world(root)
    approval = ticket.get("approval") or {}
    result = ticket.get("result") or {}
    lines = ["Ergebnis aus der Agents-Welt „%s“, zugestellt über die Sitzungs-Inbox." % world.get("name", ""),
             "Dieses Ticket wurde mit Absender orchestrator angelegt und ist jetzt abgenommen.", "",
             "Ticket: %s „%s“" % (ticket["id"], ticket.get("title", "")),
             "Welt: %s" % root,
             "Abgenommen von: %s%s" % (approval.get("agent", "?"),
                                       ", Bemerkung: %s" % approval["note"] if approval.get("note") else ""),
             "Bearbeitet von: %s%s" % (ticket.get("assignee") or "?",
                                       ", Commit %s" % result["commit"] if result.get("commit") else ""),
             "", "Ergebnis:", result.get("text") or "(kein Ergebnistext)", "",
             "Das ist ein Ergebnis zum Lesen, kein neuer Auftrag."]
    return "\n".join(lines)


def deliver_to_session_inbox(root: Path, ticket: dict[str, Any] | str,
                             home: str | os.PathLike[str] | None = None,
                             ignore_pause: bool = False, timeout: float = 5.0) -> dict[str, Any]:
    """Write an approved ticket's result into the session inbox from ``limits.rueckweg``.

    Never raises for a missing or dead session: the approval stands, the outcome is stored in
    ``rueckweg.json`` next to the ticket and as a ``rueckweg`` event. ``zugestellt`` is final;
    a later call for the same approval sends nothing. While agent traffic is paused
    (``<vorrat>/.agentverkehr-pause``, as in `wb-inbox`) the result is held back unless the
    caller is the carrier and passes ``ignore_pause``. Written means sent, not read.
    """
    import socket as _socket
    root = world_path(str(root))
    ticket = read_ticket(root, ticket if isinstance(ticket, str) else ticket["id"])
    route = (ticket.get("limits") or {}).get("rueckweg")
    if not isinstance(route, dict) or route.get("art") != SESSION_RETURN_KIND:
        return {"status": "ohne-rueckweg", "ticket": ticket["id"]}
    if ticket.get("state") != "abgenommen":
        return {"status": "nicht-abgenommen", "ticket": ticket["id"]}
    approval_time = (ticket.get("approval") or {}).get("time")
    marker_path = _ticket_path(root, ticket["id"]) / SESSION_RETURN_FILE
    stored = _read_json(marker_path, {}) if marker_path.exists() else {}
    if stored.get("status") == "zugestellt" and stored.get("abnahme") == approval_time:
        return stored
    base = Path(home or Path.home())
    vorrat = Path(os.environ.get("WB_VORRAT") or base / ".claude" / "workbench" / "vorrat")
    outcome: dict[str, Any] = {"ticket": ticket["id"], "abnahme": approval_time, "pid": route.get("pid"),
                               "session_id": route.get("session_id"), "time": now()}
    registry = _session_registry(base)
    session = None
    if not ignore_pause and (vorrat / AGENT_TRAFFIC_PAUSE).exists():
        outcome.update(status="zurueckgehalten", grund="Agent-Verkehr ist pausiert")
    else:
        session = _registered_session(registry, int(route.get("pid") or 0)) if route.get("pid") else None
        if session and (session.get("sessionId") != route.get("session_id")
                        or session.get("procStart") != route.get("proc_start")):
            session = None
        if session is None and route.get("session_id"):
            for path in sorted(registry.glob("*.json")) if registry.is_dir() else []:
                if path.stem.isdigit():
                    candidate = _registered_session(registry, int(path.stem))
                    if candidate and candidate.get("sessionId") == route.get("session_id"):
                        session = candidate
                        break
        if session is None:
            outcome.update(status="sitzung-fehlt", grund="Sitzung nicht mehr im Register")
    if session is not None:
        pid = int(session["pid"])
        token = None
        for key_path in sorted(registry.glob("%d.*.key" % pid)):
            try:
                value = json.loads(key_path.read_text(encoding="utf-8")).get("peerToken")
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(value, str) and value:
                token = value
                break
        outcome.update(pid=pid)
        if not token:
            outcome.update(status="fehlgeschlagen", grund="Sitzung ohne lesbaren Schluessel")
        else:
            lines = [json.dumps({"type": "auth", "token": token}),
                     json.dumps({"type": "user", "message": {"role": "user",
                                                             "content": _session_return_text(root, ticket)}},
                                ensure_ascii=False)]
            sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
            sock.settimeout(timeout)
            try:
                sock.connect(session["messagingSocketPath"])
                peer = _peer_pid(sock)
                if peer is not None and peer != pid:
                    outcome.update(status="fehlgeschlagen", grund="am Socket haengt Prozess %d statt %d" % (peer, pid))
                else:
                    sock.sendall(("\n".join(lines) + "\n").encode("utf-8"))
                    outcome.update(status="zugestellt", socket=session["messagingSocketPath"])
            except OSError as exc:
                outcome.update(status="fehlgeschlagen", grund="Socket: %s" % exc.__class__.__name__)
            finally:
                sock.close()
    with transaction(root):
        _write_json(marker_path, outcome)
        _ticket_event(root, ticket, "rueckweg", {"kind": "system", "id": "datenbibliothek"},
                      status=outcome["status"], grund=outcome.get("grund"), pid=outcome.get("pid"))
    return outcome


if __name__ == "__main__":
    # Internal entry point: agents_data.py <welt|agent|ticket|kanal> ...
    if len(sys.argv) < 2 or sys.argv[1] not in {"welt", "agent", "ticket", "kanal"}:
        print("agents_data: interner Einstiegspunkt", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(run(sys.argv[1], sys.argv[2:]))
