#!/usr/bin/env python3
"""Persistent file data model for the independent Agents feature.

The module deliberately contains no process, tmux, network, or harness code.
It stores one world per project (or a standalone global-world directory), and
offers the small transaction API used by wb-welt, wb-agent, wb-ticket and
wb-kanal.  ``--absender`` and ``--rolle`` are caller supplied metadata only;
they are never treated as proof of identity. Governance mutations by agents
require the context that ``AgentController`` sets only after its current-run,
world and stored-role checks; a separate CLI process cannot inherit it.
This is process provenance, not an unforgeable same-UID credential: code already
executing in this Python process can instantiate ``AgentController`` with its
own current-run predicate. Accordingly, ``verified: true`` means
controller-verified within the same-UID trust boundary, not independently
attested by the data module.

Host boundary: a process running under the same UID can read the mobile HMAC
key and can replace user-owned executables.  This module narrows that boundary
with fixed paths, modes, HMACs, one-time request IDs, a sanitized probe
environment and agent-marker rejection, but code at the same UID is not an
independent trust domain.
"""

from __future__ import annotations

import argparse
import contextvars
import datetime as _dt
import fcntl
import hashlib
import hmac
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any, Iterable

try:
    import atomar_schreiben
except ImportError:  # pragma: no cover - useful when called from another cwd
    atomar_schreiben = None


SCHEMA_VERSION = 1
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
STAGES = ("hauptagent", "teamleiter", "mitglied")
TICKET_STATES = ("triage", "offen", "läuft", "wartet", "braucht dich", "zur Abnahme",
                 "in Prüfung", "abgenommen", "zurückgegeben", "verworfen", "unterbrochen")
REVIEW_VERDICTS = ("bestanden", "maengel")
# A transition the assignee (or, from a review turn, the reviewer) may perform itself; the
# carrier counts them as a report at the end of a turn (plan sentence 16).
ASSIGNEE_TRANSITIONS = ("geparkt", "verworfen", "umadressiert")
DISCARD_REASONS = ("duplikat", "anderswo-erledigt", "nicht-mehr-noetig",
                   "nicht-reproduzierbar", "abgelehnt")
APPROVE_REASONS = ("erledigt", "teilweise")
# Art und Prioritaet je Ticket (tickets3, Plan AGENTS-TICKETS-PLAN Saetze 3 und 5, AGIL
# Abschnitt 2 und 3): kind wird bei der Anlage geprueft, priority ist 0 bis 3 mit
# Bedeutungstext. Bestehende Tickets ohne Feld gelten als task und normal.
TICKET_KINDS = ("vorhaben", "story", "task", "subtask", "auftrag", "fehler",
                "recherche", "pruefung", "skill-vorschlag")
DEFAULT_KIND = "auftrag"  # Bestand und Anlage ohne Angabe: kein Fertig-Listen-Zwang (Definition of Ready gilt fuer story, task, subtask)
PRIORITY_STUFEN = (0, 1, 2, 3)
DEFAULT_PRIORITY = 2
PRIORITY_TEXTS = {0: "sofort (Betrieb steht, Daten in Gefahr)", 1: "hoch",
                  2: "normal (Vorgabe)", 3: "spaeter"}
# Vorgabe-Grenze, wenn ein Ticket weder Frist noch Rundenzahl erhaelt (Entscheidung
# tickets3, der Nutzer entscheidet endgueltig in Abschnitt 8 des Planes).
DEFAULT_ROUNDS = 6
# Hierarchie (Saetze 4, 17, 29, 43): erlaubte Eltern-Kind-Ketten, hoechstens drei Ebenen.
PARENT_EDGES = {("vorhaben", "story"), ("story", "task"), ("task", "subtask")}
HIERARCHY_DEPTH = 3
# Zyklus und WIP je Welt (Saetze 46 und 48).
CYCLE_DEFAULT_DAYS = 7
ZYKLEN_DATEI = "zyklen.jsonl"
WORLD_STATES = ("läuft", "pausiert", "gestoppt")
AGENT_STATES = ("aktiv", "pausiert", "gestoppt", "archiviert")
HUMAN_ACTORS = {"mensch", "person-1", "companion", "orchestrator", "cli-operator"}
# The first three names are controlled by a human-facing surface.  They stay
# reserved for agents, but unlike before their spelling is not evidence.
MEASURED_HUMAN_ACTORS = {"mensch", "person-1", "companion"}
# These are unverified CLI surface names, never people and never a source of
# governance authority.  They may create and report through the local CLI;
# governance mutations use a run-bound controller identity or a measured human.
ORCHESTRATOR_ACTORS = {"orchestrator", "cli-operator"}
# Test suites use this non-human origin for disposable worlds, agents and
# tickets.  It is deliberately recognized only by the three creation paths;
# `_actor` never accepts it for an ordinary or governance mutation.
TEST_SETUP_ACTOR = "aufbau"
TEST_SETUP_PROOF_ENV = "WB_TEST_AUFBAU_BELEG"
TEST_SETUP_PROOF_MIN_BYTES = 32
RESERVED_ACTORS = HUMAN_ACTORS | {TEST_SETUP_ACTOR}
NON_AGENT_CHANNEL_ACTORS = HUMAN_ACTORS | {TEST_SETUP_ACTOR}
# The one human of a world who can be addressed: messages to this identity land
# in `menschen/<id>/postfach/` and never wake anybody.
WORLD_HUMAN = "mensch"
MESSAGE_MARKS = ("frage", "ergebnis")
PROFILE_FIELDS = ("model", "effort", "fallback_model", "fallback_effort", "machine", "specialty")
MEMORY_WRITE_LIMIT = 1024 * 1024
READ_KEY_RE = re.compile(r"^(kanal|einzel:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|direkt:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$")
# `--herkunft-beleg=wb-mensch` is deliberately only a selector for the live,
# fixed-path measurement.  It never carries a caller-provided positive result.
_HERKUNFTSBELEG = contextvars.ContextVar("herkunftsbeleg", default=None)
# A mobile proof is populated only while `approve_ticket` validates the
# already-consumed app hand-off.  `_actor` cannot turn an arbitrary `mobil:`
# selector into a human before this structural binding happened.
_MOBILE_APPROVAL_PROOF = contextvars.ContextVar("mobile_approval_proof", default=None)
# Set only by ``AgentController`` after its current-run, world and stored-role
# checks succeeded. A sender spelling from a host CLI never populates this
# context and therefore cannot authorize a governance mutation.
_CONTROLLER_ACTOR_BINDING = contextvars.ContextVar("controller_actor_binding", default=None)
MOBILE_APPROVAL_ACTION = "ticket-abnehmen"
MOBILE_BELEG_MAX_BYTES = 64 * 1024
MOBILE_BELEG_MAX_AGE_SECONDS = 120
MOBILE_BELEG_FUTURE_TOLERANCE_SECONDS = 5
MOBILE_BELEG_FIELDS = ("aktion", "welt", "ticket", "grund", "bemerkung", "dod_geprueft",
                       "request_id", "ausgestellt_um")
MOBILE_BELEG_ALL_FIELDS = frozenset((*MOBILE_BELEG_FIELDS, "quittung"))
MOBILE_BELEG_USED_FILE = "belege-verbraucht.jsonl"
HUMAN_PROBE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HUMAN_PROBE_TMPDIR = "/tmp"


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
    primary = model or "opus:medium"
    fb = fallback
    if "fable" in primary.lower() or (fb and "fable" in fb.lower()):
        raise AgentsError("Fable ist fuer Agents verboten, auch als Fallback")
    if not effort:
        effort = primary.rsplit(":", 1)[1] if ":" in primary else "medium"
    if fb and not fallback_effort:
        fallback_effort = fb.rsplit(":", 1)[1] if ":" in fb else "medium"
    for profil, stufe in ((primary, effort), (fb, fallback_effort)):
        if profil and profil.startswith("haiku:") and stufe == "low":
            raise AgentsError("Haiku-Familienprofile erlauben nur medium, high oder xhigh")
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


def _real_home() -> Path | None:
    """Return the account home without trusting the caller's ``HOME``."""
    try:
        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (KeyError, OSError):
        return None


def _mobile_beleg_dir() -> Path | None:
    real_home = _real_home()
    return real_home / ".claude" / "workbench" / "mobile" / "belege" if real_home else None


def _secure_mobile_file(directory_fd: int, name: str, label: str, *, minimum: int = 1,
                        maximum: int | None = None) -> bytes:
    """Read one same-UID 0600 regular file without following a final symlink."""
    try:
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except OSError as exc:
        if label == "Mobilbeleg-Schluessel":
            raise AgentsError("Mobilbeleg-Schluessel fehlt") from exc
        raise AgentsError("Mobilbeleg ist nicht lesbar") from exc
    if stat.S_ISLNK(before.st_mode):
        raise AgentsError("%s darf kein Symlink sein" % label)
    if not stat.S_ISREG(before.st_mode):
        raise AgentsError("%s muss eine regulaere Datei sein" % label)
    if before.st_uid != os.getuid():
        raise AgentsError("%s gehoert nicht dem aufrufenden Benutzer" % label)
    if stat.S_IMODE(before.st_mode) != 0o600:
        raise AgentsError("%s muss Modus 0600 haben" % label)
    if before.st_size < minimum or (maximum is not None and before.st_size > maximum):
        if label == "Mobilbeleg-Schluessel":
            raise AgentsError("Mobilbeleg-Schluessel braucht mindestens 32 Bytes")
        raise AgentsError("Mobilbeleg hat eine ungueltige Groesse")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=directory_fd)
    except OSError as exc:
        if label == "Mobilbeleg-Schluessel":
            raise AgentsError("Mobilbeleg-Schluessel ist nicht lesbar") from exc
        raise AgentsError("Mobilbeleg ist nicht lesbar") from exc
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise AgentsError("%s wurde waehrend der Pruefung ausgetauscht" % label)
        chunks, remaining = [], opened.st_size
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)
    if len(raw) != opened.st_size:
        raise AgentsError("%s ist nicht vollstaendig lesbar" % label)
    return raw


def _trusted_wb_mensch_paths() -> tuple[Path, ...]:
    """Both homes must agree when a caller redirected ``HOME`` for a test."""
    real_home = _real_home()
    if real_home is None:
        return ()
    real = real_home / ".local" / "bin" / "wb-mensch"
    caller_home = Path(os.environ.get("HOME") or str(real_home))
    caller = caller_home / ".local" / "bin" / "wb-mensch"
    return (real,) if caller == real else (caller, real)


def _human_probe_env() -> dict[str, str]:
    """Return the complete allowlisted environment for a human verifier.

    M2's two claims may cross this boundary because ``wb-mensch`` validates
    both against its actual ancestry.  No loader, shell-startup or search-path
    variable is inherited.
    """
    real_home = _real_home()
    caller_home = Path(os.environ.get("HOME") or str(real_home or ""))
    env = {"HOME": str(caller_home), "PATH": HUMAN_PROBE_PATH, "TMPDIR": HUMAN_PROBE_TMPDIR}
    app_pid = os.environ.get("WB_APP_PID", "")
    if os.environ.get("WB_MENSCH_QUELLE") == "oberflaeche" and app_pid.isdigit():
        env.update(WB_MENSCH_QUELLE="oberflaeche", WB_APP_PID=app_pid)
    return env


def _measured_human() -> tuple[bool, str]:
    """Ask the fixed human probe; any missing or disagreeing probe denies.

    The user database determines the decisive path.  A redirected HOME remains
    useful for isolated tests, but it has to agree with the installed probe and
    cannot replace it (the same trust shape as fix 265431f0).
    """
    marker = next((name for name in os.environ if name == "CLAUDECODE"
                   or name.startswith("CLAUDE_CODE_") or name == "PI_AGENT"
                   or name.startswith("WB_AGENT")), None)
    if marker is not None:
        return False, "Agenten-Marker %s ist im aufrufenden Prozess gesetzt" % marker
    selector = _HERKUNFTSBELEG.get()
    if isinstance(selector, str) and selector.startswith("mobil:"):
        proof = _MOBILE_APPROVAL_PROOF.get()
        if proof is None:
            return False, "mobil:PFAD gilt nur fuer eine gebundene Ticket-Abnahme"
        return True, "mobil-kern: quittierte Ticket-Abnahme (%s)" % proof["request_id"]
    if selector not in (None, "wb-mensch"):
        return False, "unbekanntes Herkunftsbeleg-Format '%s'" % selector
    paths = _trusted_wb_mensch_paths()
    if not paths:
        return False, "das echte Heimatverzeichnis ist nicht bestimmbar"
    for path in paths:
        if not path.is_file() or not os.access(path, os.X_OK):
            return False, "wb-mensch am festen Pfad %s fehlt" % path
        try:
            probe = subprocess.run([str(path), "beleg"], text=True, capture_output=True,
                                   timeout=3, check=False, env=_human_probe_env())
        except (OSError, subprocess.SubprocessError) as exc:
            return False, "wb-mensch am festen Pfad %s ist nicht messbar (%s)" % (path, type(exc).__name__)
        lines = probe.stdout.splitlines()
        if len(lines) != 1 or "\t" not in lines[0]:
            return False, "wb-mensch am festen Pfad %s liefert keinen gueltigen Beleg" % path
        art, grund = lines[0].split("\t", 1)
        if art != "mensch" or not grund.strip():
            return False, "wb-mensch am festen Pfad %s lehnt ab: %s" % (path, grund.strip() or art)
    return True, "wb-mensch (M1/M2) am festen Pfad"


def _mobile_approval_beleg(root: Path, ticket_id: str, reason_code: str | None,
                           note: str | None, dod_checked: bool,
                           accept: bool) -> dict[str, str] | None:
    """Verify the mobile core's HMAC-authenticated hand-off without consuming it."""
    selector = _HERKUNFTSBELEG.get()
    if not isinstance(selector, str) or not selector.startswith("mobil:"):
        return None
    if not accept:
        raise AgentsError("Mobilbeleg gilt nur fuer `wb-ticket abnehmen`")
    raw_path = selector[len("mobil:"):]
    if not raw_path:
        raise AgentsError("Mobilbeleg braucht einen absoluten Pfad nach `mobil:`")
    path = Path(raw_path)
    if not path.is_absolute():
        raise AgentsError("Mobilbeleg braucht einen absoluten Pfad nach `mobil:`")
    beleg_dir = _mobile_beleg_dir()
    if beleg_dir is None:
        raise AgentsError("Mobilbeleg-Verzeichnis ist nicht bestimmbar")
    beleg_dir = Path(os.path.abspath(beleg_dir))
    path = Path(os.path.abspath(path))
    if path.parent != beleg_dir or Path(os.path.realpath(path.parent)) != Path(os.path.realpath(beleg_dir)):
        raise AgentsError("Mobilbeleg liegt nicht im festen Belegverzeichnis")
    if path.is_symlink():
        raise AgentsError("Mobilbeleg darf kein Symlink sein")
    if beleg_dir.is_symlink():
        raise AgentsError("Mobilbeleg-Verzeichnis darf kein Symlink sein")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_fd = os.open(str(beleg_dir), directory_flags)
    except OSError as exc:
        raise AgentsError("Mobilbeleg-Verzeichnis fehlt oder ist nicht lesbar") from exc
    try:
        directory_info = os.fstat(directory_fd)
        if not stat.S_ISDIR(directory_info.st_mode):
            raise AgentsError("Mobilbeleg-Verzeichnis ist kein Verzeichnis")
        if directory_info.st_uid != os.getuid():
            raise AgentsError("Mobilbeleg-Verzeichnis gehoert nicht dem aufrufenden Benutzer")
        if stat.S_IMODE(directory_info.st_mode) != 0o700:
            raise AgentsError("Mobilbeleg-Verzeichnis muss Modus 0700 haben")
        raw = _secure_mobile_file(directory_fd, path.name, "Mobilbeleg", maximum=MOBILE_BELEG_MAX_BYTES)
        key = _secure_mobile_file(directory_fd, ".schluessel", "Mobilbeleg-Schluessel", minimum=32)
    finally:
        os.close(directory_fd)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AgentsError("Mobilbeleg ist kein gueltiges JSON") from exc
    if not isinstance(data, dict):
        raise AgentsError("Mobilbeleg muss ein JSON-Objekt sein")
    missing = [field for field in MOBILE_BELEG_ALL_FIELDS if field not in data]
    if missing:
        raise AgentsError("Mobilbeleg hat Pflichtfeld(er) nicht: %s" % ", ".join(sorted(missing)))
    unknown = sorted(set(data) - MOBILE_BELEG_ALL_FIELDS)
    if unknown:
        raise AgentsError("Mobilbeleg hat unbekannte Felder: %s" % ", ".join(unknown))
    text_fields = ("aktion", "welt", "ticket", "grund", "bemerkung", "request_id", "ausgestellt_um", "quittung")
    if any(not isinstance(data[field], str) for field in text_fields) or not isinstance(data["dod_geprueft"], bool):
        raise AgentsError("Mobilbeleg hat ein Feld mit falschem Typ")
    if "|" in data["bemerkung"]:
        raise AgentsError("Mobilbeleg-Bemerkung darf kein Trennzeichen | enthalten")
    if not ID_RE.fullmatch(data["request_id"]):
        raise AgentsError("Mobilbeleg hat keine gueltige request_id")
    if not re.fullmatch(r"[0-9a-f]{64}", data["quittung"]):
        raise AgentsError("Mobilbeleg hat eine ungueltige Quittung")
    canonical_values = [data[field] if field != "dod_geprueft"
                        else ("true" if data[field] else "false") for field in MOBILE_BELEG_FIELDS]
    canonical = "|".join(canonical_values).encode("utf-8")
    expected_receipt = hmac.new(key, canonical, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(data["quittung"], expected_receipt):
        raise AgentsError("Mobilbeleg hat eine ungueltige Quittung")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", data["ausgestellt_um"]):
        raise AgentsError("Mobilbeleg hat keinen gueltigen UTC-Zeitstempel")
    try:
        issued = _dt.datetime.fromisoformat(data["ausgestellt_um"][:-1] + "+00:00")
    except ValueError as exc:
        raise AgentsError("Mobilbeleg hat keinen gueltigen UTC-Zeitstempel") from exc
    age = (_dt.datetime.now(_dt.timezone.utc) - issued).total_seconds()
    if age < -MOBILE_BELEG_FUTURE_TOLERANCE_SECONDS:
        raise AgentsError("Mobilbeleg liegt mehr als 5 Sekunden in der Zukunft")
    if age > MOBILE_BELEG_MAX_AGE_SECONDS:
        raise AgentsError("Mobilbeleg ist aelter als 120 Sekunden")
    if data["aktion"] != MOBILE_APPROVAL_ACTION:
        raise AgentsError("Mobilbeleg bindet keine Ticket-Abnahme")
    if not isinstance(data["welt"], str):
        raise AgentsError("Mobilbeleg hat keine gueltige Welt")
    try:
        bound_world = world_path(data["welt"])
    except AgentsError as exc:
        raise AgentsError("Mobilbeleg hat keine gueltige Welt") from exc
    if bound_world != world_path(str(root)):
        raise AgentsError("Mobilbeleg bindet eine andere Welt")
    if not isinstance(data["ticket"], str) or data["ticket"] != ticket_id:
        raise AgentsError("Mobilbeleg bindet ein anderes Ticket")
    if not isinstance(data["grund"], str) or data["grund"] != reason_code:
        raise AgentsError("Mobilbeleg bindet einen anderen Abnahmegrund")
    expected_note = note if note is not None else ""
    if not isinstance(data["bemerkung"], str) or data["bemerkung"] != expected_note:
        raise AgentsError("Mobilbeleg bindet eine andere Bemerkung")
    if not isinstance(data["dod_geprueft"], bool) or data["dod_geprueft"] is not dod_checked:
        raise AgentsError("Mobilbeleg bindet eine andere DoD-Bestaetigung")
    used = _read_jsonl(world_path(str(root)) / MOBILE_BELEG_USED_FILE, "Verbrauchte Mobilbelege")
    if any(entry.get("request_id") == data["request_id"] for entry in used):
        raise AgentsError("Mobilbeleg-request_id wurde bereits verbraucht")
    return {"art": "mobil-kern", "request_id": data["request_id"],
            "ausgestellt_um": data["ausgestellt_um"]}


def _consume_mobile_approval_beleg(root: Path, proof: dict[str, str]) -> None:
    """Consume a verified proof while the caller holds the world transaction."""
    used_path = world_path(str(root)) / MOBILE_BELEG_USED_FILE
    used = _read_jsonl(used_path, "Verbrauchte Mobilbelege")
    if any(entry.get("request_id") == proof["request_id"] for entry in used):
        raise AgentsError("Mobilbeleg-request_id wurde bereits verbraucht")
    _append_jsonl(used_path, {"request_id": proof["request_id"],
                              "ausgestellt_um": proof["ausgestellt_um"], "verbraucht_um": now()})


def _actor(root: Path, sender: str | None, claimed_role: str | None = None) -> dict[str, Any]:
    """Return a measured human, an unprivileged CLI surface, or a stored agent."""
    sender = sender or WORLD_HUMAN
    result: dict[str, Any] = {
        "id": sender,
        "claimed_role": claimed_role,
        "verified": False,
        "source": "cli-argument",
    }
    if sender in MEASURED_HUMAN_ACTORS:
        measured, reason = _measured_human()
        if not measured:
            raise AgentsError("Herkunftsbeleg fuer Menschenname '%s' abgelehnt: %s" % (sender, reason))
        result["kind"] = "external"
        result["verified"] = True
        result["source"] = "mobil-kern" if isinstance(_HERKUNFTSBELEG.get(), str) \
            and _HERKUNFTSBELEG.get().startswith("mobil:") else "wb-mensch"
        result["proof"] = reason
        mobile_proof = _MOBILE_APPROVAL_PROOF.get()
        if result["source"] == "mobil-kern" and mobile_proof is not None:
            result["herkunft"] = {"art": mobile_proof["art"], "request_id": mobile_proof["request_id"]}
        return result
    if sender in ORCHESTRATOR_ACTORS:
        if claimed_role and claimed_role != "hauptagent":
            raise AgentsError("CLI-Oberflaechen handeln nur als Hauptagent; --rolle beweist keine Identitaet")
        result.update({"kind": "agent", "role": "hauptagent", "verified": False,
                       "source": "cli-operator-limited"})
        return result
    if sender == TEST_SETUP_ACTOR:
        # The setup proof only covers creation (_creation_actor); say so instead of "unknown".
        raise AgentsError("Absender 'aufbau' gilt nur fuer die Anlage (Test-Herkunft), nicht fuer diese Aktion")
    try:
        agent = read_agent(root, sender)
    except AgentsError:
        raise AgentsError("Absender '%s' unbekannt; --rolle beweist keine Identitaet" % sender)
    result["kind"] = "agent"
    result["role"] = agent["stage"]
    created_by = agent.get("created_by") or {}
    if created_by.get("id") == TEST_SETUP_ACTOR or created_by.get("source") == "test-aufbau" \
            or created_by.get("origin") == TEST_SETUP_ACTOR:
        result["setup_origin"] = True
    if claimed_role and claimed_role != agent["stage"]:
        raise AgentsError("Angegebene Rolle passt nicht zum gespeicherten Profil; CLI-Rolle ist kein Beleg")
    return result


def _test_setup_proof() -> tuple[bool, str]:
    """Verify the runner-owned proof for CLI-only disposable setup.

    The proof is useful only with the literal sender ``aufbau`` and only in
    creation functions.  A suite creates it with unpredictable bytes inside
    its private HOME.  The returned actor remains limited to creation even
    after this filesystem check succeeds.
    """
    raw_path = os.environ.get(TEST_SETUP_PROOF_ENV)
    raw_home = os.environ.get("HOME")
    if not raw_path or not raw_home:
        return False, "%s oder HOME fehlt" % TEST_SETUP_PROOF_ENV
    path = Path(raw_path)
    home = Path(raw_home)
    if not path.is_absolute() or not home.is_absolute():
        return False, "Aufbau-Beleg und HOME muessen absolute Pfade sein"
    try:
        home_real = Path(os.path.realpath(home))
        path_real = Path(os.path.realpath(path))
        if path.is_symlink() or path_real == home_real or home_real not in path_real.parents:
            return False, "Aufbau-Beleg muss symlinkfrei unter dem Prozess-HOME liegen"
        home_info = home_real.stat()
        if not stat.S_ISDIR(home_info.st_mode) or home_info.st_uid != os.getuid() \
                or stat.S_IMODE(home_info.st_mode) != 0o700:
            return False, "Prozess-HOME fuer Aufbau muss dem Benutzer gehoeren und Modus 0700 haben"
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(str(path), flags)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                return False, "Aufbau-Beleg muss eine eigene regulaere Datei sein"
            if stat.S_IMODE(info.st_mode) != 0o600:
                return False, "Aufbau-Beleg muss Modus 0600 haben"
            if info.st_size < TEST_SETUP_PROOF_MIN_BYTES or info.st_size > 4096:
                return False, "Aufbau-Beleg hat keine gueltige Laenge"
            content = os.read(descriptor, 4097)
        finally:
            os.close(descriptor)
    except OSError as exc:
        return False, "Aufbau-Beleg ist nicht sicher lesbar (%s)" % type(exc).__name__
    if len(content) != info.st_size:
        return False, "Aufbau-Beleg ist nicht vollstaendig lesbar"
    return True, "privater Test-Aufbaubeleg"


def _creation_actor(root: Path, sender: str | None, claimed_role: str | None = None,
                    allowed: Iterable[str] | None = None) -> dict[str, Any]:
    """Resolve an actor for creation, including the test-only setup origin."""
    if sender == TEST_SETUP_ACTOR:
        if claimed_role is not None:
            raise AgentsError("Aufbau-Herkunft hat keine Agentenrolle")
        valid, reason = _test_setup_proof()
        if not valid:
            raise AgentsError("Aufbau-Herkunftsbeleg abgelehnt: %s" % reason)
        return {"id": TEST_SETUP_ACTOR, "kind": "external", "verified": False,
                "source": "test-aufbau", "proof": reason}
    actor = _actor(root, sender, claimed_role)
    if allowed is not None and actor.get("kind") != "external" \
            and actor.get("role") not in set(allowed):
        raise AgentsError("Agent '%s' darf diese Mutation nicht ausfuehren" % actor["id"])
    return actor


def _actor_provenance(actor: dict[str, Any]) -> dict[str, Any]:
    """Persist the stable, non-secret part of an actor's creation proof."""
    provenance = {key: actor.get(key) for key in ("id", "kind", "verified", "source")}
    if actor.get("id") == TEST_SETUP_ACTOR or actor.get("source") == "test-aufbau" \
            or actor.get("setup_origin"):
        provenance["origin"] = TEST_SETUP_ACTOR
    return provenance


def _setup_created_agent(root: Path, actor: dict[str, Any]) -> bool:
    if actor.get("kind") != "agent" or actor.get("id") in ORCHESTRATOR_ACTORS:
        return False
    created_by = read_agent(root, actor["id"]).get("created_by") or {}
    return created_by.get("id") == TEST_SETUP_ACTOR or created_by.get("source") == "test-aufbau" \
        or created_by.get("origin") == TEST_SETUP_ACTOR


@contextmanager
def _controller_actor_binding(root: Path, agent_id: str, role: str, run_id: str):
    """Bind governance calls in one authenticated controller dispatch."""
    binding = {
        "world": str(world_path(str(root))),
        "agent": valid_id(agent_id, "Agentenkennung"),
        "role": role,
        "run": run_id,
    }
    token = _CONTROLLER_ACTOR_BINDING.set(binding)
    try:
        yield
    finally:
        _CONTROLLER_ACTOR_BINDING.reset(token)


def _controller_binding_matches(root: Path, actor: dict[str, Any]) -> bool:
    binding = _CONTROLLER_ACTOR_BINDING.get()
    return isinstance(binding, dict) \
        and binding.get("world") == str(world_path(str(root))) \
        and binding.get("agent") == actor.get("id") \
        and binding.get("role") == actor.get("role") \
        and isinstance(binding.get("run"), str) and bool(binding["run"])


def _require_actor(root: Path, sender: str | None, claimed_role: str | None,
                   allowed: Iterable[str]) -> dict[str, Any]:
    actor = _actor(root, sender, claimed_role)
    if actor.get("kind") == "external":
        return actor
    if actor.get("role") not in set(allowed):
        raise AgentsError("Agent '%s' darf diese Mutation nicht ausfuehren" % actor["id"])
    return actor


def _require_governance_actor(root: Path, sender: str | None, claimed_role: str | None,
                              allowed: Iterable[str]) -> dict[str, Any]:
    actor = _require_actor(root, sender, claimed_role, allowed)
    if actor.get("kind") == "external":
        return actor
    if _setup_created_agent(root, actor):
        raise AgentsError("Aufbau-Herkunft von Agent '%s' ist nicht governance-befugt" % actor["id"])
    if not _controller_binding_matches(root, actor):
        raise AgentsError("Governance-Mutation fuer Agent '%s' hat keinen passenden "
                          "run-gebundenen Controller-Beleg; --absender/--rolle sind kein Beweis"
                          % actor["id"])
    binding = _CONTROLLER_ACTOR_BINDING.get()
    return dict(actor, verified=True, source="agent-controller", run_id=binding["run"])


def _require_external_operator(root: Path, sender: str | None,
                               claimed_role: str | None) -> dict[str, Any]:
    actor = _actor(root, sender, claimed_role)
    if actor.get("kind") != "external":
        raise AgentsError("Nur ein gemessener Mensch darf Fragen beantworten oder zuruecknehmen")
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
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
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
        if question.get("kind") == RIGHTS_REQUEST_KIND:
            raise AgentsError("%s ist ein Rechteantrag; entscheiden mit wb-agent rechte-antrag-entscheiden" % question_id)
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
        for other in list_tickets(root):
            flag = other.get("flag") or {}
            if not isinstance(flag, dict) or flag.get("question") != question_id \
                    or other.get("state") != "braucht dich":
                continue
            ts = now()
            delivery_id = derived_id("ticket-flag", other["id"], question_id)
            target = [other["assignee"]] if other.get("assignee") else list(other.get("recipients") or [])
            other.update({"state": "offen", "updated_at": ts, "return_to": target,
                          "return_to_delivery": delivery_id, "return_delivery_id": delivery_id,
                          "return_delivery_time": ts, "delivery_sender": actor["id"]})
            other.pop("flag", None)
            _write_json(_ticket_path(root, other["id"]) / "ticket.json", other)
            _ticket_event(root, other, "beantwortet", actor, frage=question_id)
            _deliver_ticket(root, other, actor)
        return question


def withdraw_question(root: Path, question_id: str, reason: str | None = None,
                      sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    valid_id(question_id, "Fragenkennung")
    if reason is not None and (not isinstance(reason, str) or not reason.strip()):
        raise AgentsError("Ruecknahmegrund muss ein Text sein")
    with transaction(root):
        actor = _require_external_operator(root, sender, claimed_role)
        question = read_question(root, question_id)
        if question.get("kind") == RIGHTS_REQUEST_KIND:
            raise AgentsError("%s ist ein Rechteantrag; zurueckziehen kann ihn nur der Antragsteller" % question_id)
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
                 global_world: bool = False, with_main_agent: bool = True,
                 sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Create a world; without `with_main_agent` it starts empty and the main agent follows later.

    The empty form is the path of the surfaces (welten.ts `welt:neu`): the human then creates
    the main agent in the creation menu, by hand or as a model proposal.
    """
    root = world_path(str(root))
    actor = _creation_actor(root, sender, claimed_role, ("hauptagent",))
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
        "hauptagent": main_name if with_main_agent else None,
        "created_at": timestamp, "updated_at": timestamp, "state": "läuft",
        "definition_of_done": [],
        "pause": {"state": "läuft", "changed_at": timestamp, "reason": None},
        "stop": {"state": "läuft", "changed_at": timestamp, "reason": None},
        "governance": {"identity_verified": False, "mutation_gate": "external-adapter-required"},
        "created_by": _actor_provenance(actor),
    }
    try:
        _world_dirs(stage)
        _write_json(world_file(stage), world)
        main = None
        if with_main_agent:
            main = create_agent(stage, main_name, "hauptagent", None, description, None, None,
                                model or "opus:medium", effort, fallback,
                                fallback_effort, machine, "cli-operator", None, bootstrap=True)
            main["created_by"] = _actor_provenance(actor)
            _write_json(_agent_dir(stage, main_name) / "agent.json", main)
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
    if agent_id in RESERVED_ACTORS:
        raise AgentsError("Agentenkennung '%s' ist fuer Menschen und Entwicklungsakteure reserviert" % agent_id)
    if stage not in STAGES:
        raise AgentsError("Stufe ungueltig (hauptagent, teamleiter, mitglied)")
    if not description.strip():
        raise AgentsError("Beschreibung fehlt")
    with transaction(root):
        world = read_world(root)
        if world["state"] != "läuft":
            raise AgentsError("Welt ist %s; kein neuer Agent wird angelegt" % world["state"])
        actor = None if bootstrap else _creation_actor(
            root, sender, claimed_role, ("hauptagent", "teamleiter"))
        if any(a["stage"] == "hauptagent" for a in list_agents(root)) and stage == "hauptagent":
            raise AgentsError("Welt darf genau einen Hauptagenten haben")
        if stage == "hauptagent" and team:
            raise AgentsError("Hauptagent gehoert keinem Team an")
        path = _agent_dir(root, agent_id)
        if path.exists() or path.is_symlink():
            raise AgentsError("Agent existiert bereits: %s" % agent_id)
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
        if actor is not None:
            profile["created_by"] = _actor_provenance(actor)
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
            try:
                import agents_gedaechtnis
                memory = agents_gedaechtnis.vorlage(agent_id)
            except ImportError:  # the RPC copy in a turn carries no memory module
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
            if stage == "hauptagent" and world.get("hauptagent") != agent_id:
                world["hauptagent"] = agent_id
                world["updated_at"] = now()
                _write_json(world_file(root), world)
            return profile
        except BaseException:
            shutil.rmtree(stage_path, ignore_errors=True)
            raise


def set_agent_state(root: Path, agent_id: str, state: str, reason: str | None,
                    sender: str | None, claimed_role: str | None) -> dict[str, Any]:
    if state not in ("aktiv", "pausiert", "gestoppt"):
        raise AgentsError("Agentenstand ungueltig")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent", "teamleiter"))
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
        _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
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


def _done_item_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise AgentsError("Fertig-Punkte muessen nichtleere Texte sein")
    return list(dict.fromkeys(item.strip() for item in value))


def _ticket_done_items(ticket: dict[str, Any]) -> list[dict[str, Any]]:
    items = ticket.get("done_items")
    return [item for item in items if isinstance(item, dict) and isinstance(item.get("text"), str)] \
        if isinstance(items, list) else []


def _open_done_items(ticket: dict[str, Any]) -> list[str]:
    return [item["text"] for item in _ticket_done_items(ticket) if not item.get("done")]


def _ticket_kind_feld(ticket: dict[str, Any]) -> str:
    """Art des Tickets: das Feld `kind`, sonst auftrag (Bestand ohne Feld, Plan Satz 3; die Definition of Ready verlangt die Fertig-Liste nur fuer story, task, subtask)."""
    kind = ticket.get("kind")
    return kind if kind in TICKET_KINDS else DEFAULT_KIND


def _ticket_kind_wert(value: Any) -> str:
    if value is None:
        return DEFAULT_KIND
    if not isinstance(value, str) or value not in TICKET_KINDS:
        raise AgentsError("Art muss %s sein" % ", ".join(TICKET_KINDS))
    return value


def _ticket_priority_wert(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value not in PRIORITY_STUFEN:
        raise AgentsError("Prioritaet muss 0 (sofort), 1 (hoch), 2 (normal) oder 3 (spaeter) sein")
    return value


def _ticket_limits_wert(limits: dict[str, Any] | None) -> dict[str, Any]:
    """Grenzen bei der Anlage: Frist als ISO-Zeit, Rundenzahl als ganze Zahl ab 1 (Plan Satz 6)."""
    limits = dict(limits or {})
    frist = limits.get("frist")
    if frist is not None:
        try:
            _epoch_of(frist)
        except (ValueError, TypeError, OSError) as exc:
            raise AgentsError("Grenze frist braucht eine ISO-Zeit (z. B. 2026-09-18T09:00:00Z)") from exc
    runden = limits.get("runden")
    if runden is not None and (isinstance(runden, bool) or not isinstance(runden, int) or runden < 1):
        raise AgentsError("Grenze runden braucht eine ganze Zahl ab 1")
    return limits


def _deadline_state(ticket: dict[str, Any], now_epoch: float | None = None) -> str | None:
    """Ampel der Frist: rot abgelaufen, gelb weniger als ein Tag, sonst grau (Plan Satz 31)."""
    frist = (ticket.get("limits") or {}).get("frist")
    if not frist:
        return None
    try:
        ende = _epoch_of(frist)
    except (ValueError, TypeError, OSError):
        return None
    if now_epoch is None:
        now_epoch = time.time()
    if now_epoch >= ende:
        return "rot"
    if ende - now_epoch < 86400:
        return "gelb"
    return "grau"


def _definition_of_ready_fehlt(kind: str, punkte: list[str] | None, limits: dict[str, Any] | None,
                               recipients, team, title: str = "t", goal: str = "z",
                               done: str = "f") -> list[dict[str, str]]:
    """Definition of Ready (Plan Satz 45): jeder fehlende Punkt in der Reihenfolge der Pruefung.

    Fuer `vorhaben` gelten nur Titel, Ziel und Fertig-Kriterium; fuer story, task und subtask
    gehoert eine abhakbare Fertig-Liste dazu, fuer alle uebrigen Arten Frist oder Rundenzahl.
    Jeder Punkt traegt eine feste Kennung, damit ein Formular ihn seinem Feld zuordnen kann.
    """
    fehlt: list[dict[str, str]] = []
    if not str(title or "").strip() or not str(goal or "").strip() or not str(done or "").strip():
        fehlt.append({"punkt": "auftrag", "text": "fehlender Auftrag (Titel, Ziel oder Fertig-Kriterium)"})
    if kind == "vorhaben":
        return fehlt
    if kind in ("story", "task", "subtask") and not (punkte or []):
        fehlt.append({"punkt": "fertig-liste", "text": "fehlende Fertig-Liste"})
    grenzen = limits or {}
    if not grenzen.get("frist") and not grenzen.get("runden"):
        fehlt.append({"punkt": "grenzen", "text": "fehlende Grenzen (keine Frist, keine Rundenzahl)"})
    if not recipients and not team:
        fehlt.append({"punkt": "adressaten", "text": "fehlende Adressaten"})
    return fehlt


def _definition_of_ready_grund(kind: str, punkte: list[str] | None, limits: dict[str, Any] | None,
                               recipients, team, title: str = "t", goal: str = "z",
                               done: str = "f") -> str | None:
    """Der erste fehlende Punkt der Definition of Ready als Grund, sonst None."""
    fehlt = _definition_of_ready_fehlt(kind, punkte, limits, recipients, team, title, goal, done)
    return fehlt[0]["text"] if fehlt else None


def _ticket_parent_pruefen(root: Path, ticket_id: str, parent_id: str, kind: str) -> dict[str, Any]:
    """Hierarchieregeln (Plan Saetze 4, 17, 29, 43): Eltern existiert, ist nicht verworfen oder
    abgenommen, die Kette ist erlaubt, hoechstens drei Ebenen und kein Zyklus."""
    valid_id(parent_id, "Elternkennung")
    if parent_id == ticket_id:
        raise AgentsError("Ein Ticket ist nicht sein eigenes Eltern")
    try:
        parent = read_ticket(root, parent_id)
    except AgentsError as exc:
        raise AgentsError("Eltern %s existiert nicht" % parent_id) from exc
    if parent.get("state") in ("verworfen", "abgenommen"):
        raise AgentsError("Eltern %s ist %s; es traegt keine Kinder mehr" % (parent_id, parent.get("state")))
    eltern_kind = _ticket_kind_feld(parent)
    if (eltern_kind, kind) not in PARENT_EDGES:
        raise AgentsError("Kette %s > %s ist nicht erlaubt (vorhaben > story > task > subtask)" % (
            eltern_kind, kind))
    tiefe, current, kette = 1, parent, {parent_id}
    while current.get("parent"):
        eltern_id = current.get("parent")
        if eltern_id == ticket_id or eltern_id in kette:
            raise AgentsError("Ticket-Hierarchie bildet einen Zyklus")
        kette.add(eltern_id)
        tiefe += 1
        if tiefe > HIERARCHY_DEPTH:
            raise AgentsError("Ticket-Hierarchie ist hoechstens drei Ebenen tief")
        try:
            current = read_ticket(root, eltern_id)
        except AgentsError as exc:
            raise AgentsError("Eltern %s existiert nicht" % eltern_id) from exc
    return parent


def _naechste_triage_ordnung(tickets: list[dict[str, Any]]) -> int:
    """Reihenfolge fuer ein neues Triage-Ticket: ans Ende (Plan Satz 44)."""
    orders = [t.get("order") for t in tickets if t.get("state") == "triage"
              and isinstance(t.get("order"), int) and not isinstance(t.get("order"), bool)]
    return (max(orders) + 1) if orders else 1


def create_ticket(root: Path, title: str, goal: str, done: str,
                  recipients: list[str], sender: str | None, claimed_role: str | None,
                  team: str | None = None, limits: dict[str, Any] | None = None,
                  dependencies: list[str] | None = None,
                  ticket_id: str | None = None,
                  done_items: list[str] | None = None,
                  kind: str | None = None, priority: int | None = None,
                  parent: str | None = None, origin: str | None = None,
                  in_transaction: bool = False) -> dict[str, Any]:
    if not title.strip() or not goal.strip() or not done.strip():
        raise AgentsError("Titel, Ziel und Fertig-Kriterium sind Pflicht")
    punkte = _done_item_list(done_items)
    art = _ticket_kind_wert(kind)
    _ticket_priority_wert(priority)
    limits = _ticket_limits_wert(limits)
    # Vorgabe-Grenze (tickets3): ohne Frist und ohne Rundenzahl sechs Zuege, Vorhaben ohne Grenze.
    if "frist" not in limits and "runden" not in limits and art != "vorhaben":
        limits["runden"] = DEFAULT_ROUNDS
    triage = not recipients and not team
    # `in_transaction` ist fuer den Aufrufer, der die Weltsperre schon haelt (das Rest-Ticket
    # der Abnahme): flock ist nicht wiedereintrittsfaehig, ein zweites `transaction` haengt.
    with (nullcontext() if in_transaction else transaction(root)):
        world = read_world(root)
        actor = _creation_actor(root, sender, claimed_role)
        if triage:
            haupt = world.get("hauptagent")
            if not haupt or not isinstance(haupt, str) or not ID_RE.fullmatch(haupt):
                raise AgentsError("Ticket braucht Adressat oder Team")
            try:
                haupt_agent = read_agent(root, haupt)
            except AgentsError as exc:
                raise AgentsError("Ticket braucht Adressat oder Team") from exc
            if haupt_agent.get("stage") != "hauptagent":
                raise AgentsError("Ticket braucht Adressat oder Team")
            recipients = [haupt]
            team = None
        else:
            for recipient in recipients:
                read_agent(root, recipient)
            if team and not valid_id(team, "Team"):
                raise AgentsError("Team ungueltig")
        deps = list(dependencies or [])
        for dep in deps:
            read_ticket(root, dep)
        eltern = herkunft = None
        if parent is not None:
            eltern = _ticket_parent_pruefen(root, ticket_id or "t-neu", parent, art)
        if origin is not None:
            valid_id(origin, "Herkunftskennung")
            if origin == ticket_id:
                raise AgentsError("Ein Ticket ist nicht seine eigene Herkunft")
            herkunft = read_ticket(root, origin)
        ticket_id = valid_id(ticket_id, "Ticketkennung") if ticket_id else new_id("t")
        if parent is not None:
            # Erst mit der endgueltigen Kennung pruefen (Zyklus und Selbstbezug).
            eltern = _ticket_parent_pruefen(root, ticket_id, parent, art)
        if origin is not None:
            herkunft = read_ticket(root, origin)
        priority_wert = priority if priority is not None else \
            ((eltern or {}).get("priority") if eltern is not None else DEFAULT_PRIORITY)
        existing_path = _ticket_path(root, ticket_id)
        if existing_path.exists():
            existing = read_ticket(root, ticket_id)
            same = (existing.get("title"), existing.get("goal"), existing.get("done_criterion"),
                    existing.get("recipients"), existing.get("team"), existing.get("dependencies"),
                    existing.get("limits"), [item["text"] for item in existing.get("done_items") or []],
                    existing.get("kind"), existing.get("priority"), existing.get("parent"),
                    existing.get("origin")) == \
                   (title, goal, done, recipients, team, deps, limits, punkte,
                    art, priority_wert, parent, origin)
            if same:
                return existing
            raise AgentsError("Ticketkennung existiert bereits mit anderem Inhalt")
        _ticket_dependencies_cycle(root, ticket_id, deps)
        ts = now()
        ticket = {
            "schema_version": SCHEMA_VERSION, "id": ticket_id, "world": world["id"],
            "title": title, "goal": goal, "done_criterion": done, "limits": limits,
            "dependencies": deps, "recipients": list(recipients), "team": team,
            "sender": sender or "cli-operator", "sender_verified": False,
            "state": "triage" if triage else "offen",
            "assignee": None, "claimed_at": None, "result": None, "approval": None,
            "done_items": [{"text": text, "done": False, "by": None, "at": None} for text in punkte],
            "created_at": ts, "updated_at": ts,
            "kind": art,
            "priority": priority_wert,
        }
        if parent is not None:
            ticket["parent"] = parent
        if origin is not None:
            ticket["origin"] = origin
        if eltern is not None and eltern.get("cycle"):
            # Kinder erben Prioritaet und Zyklus des Eltern (Plan Saetze 42 und 43).
            ticket["cycle"] = eltern["cycle"]
        if triage:
            ticket["order"] = _naechste_triage_ordnung(list_tickets(root))
        elif not ticket.get("cycle"):
            # Tickets im Zyklus stehen offen adressiert oder in triage mit Zyklusvermerk (AGIL
            # Abschnitt 4): ein direkt adressiertes Ticket bekommt den aktuellen Zyklus der Welt.
            zyklen = world.get("cycles") or {}
            if zyklen.get("enabled"):
                ticket["cycle"] = (zyklen.get("current") or {}).get("id")
        path = _ticket_path(root, ticket_id)
        stage_path = path.parent / (".%s.creating-%s" % (ticket_id, uuid.uuid4().hex))
        try:
            stage_path.mkdir(parents=True)
            _write_json(stage_path / "ticket.json", ticket)
            _write_json(stage_path / "ergebnis.json", {})
            _append_jsonl(stage_path / "verlauf.jsonl", {"id": new_id("ev"), "time": ts, "event": "erstellt", "actor": actor})
            os.replace(stage_path, path)
            if not triage:
                _deliver_ticket(root, ticket, actor)
            if herkunft is not None:
                _ticket_event(root, herkunft, "folgeticket", actor, folgeticket=ticket_id)
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
            if dependency.get("state") == "verworfen":
                raise AgentsError("Abhaengigkeit %s ist verworfen" % dependency_id)
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
        offen = _open_done_items(ticket)
        if offen:
            raise AgentsError("Fertig-Liste hat offene Punkte: %s" % "; ".join(offen))
        result = {"schema_version": SCHEMA_VERSION, "ticket": ticket_id, "agent": agent_id,
                  "text": text, "commit": commit, "written_at": now(), "sender_verified": False}
        revision = int(ticket.get("result_revision") or 0) + 1
        result_message_id = (derived_id("result", ticket_id) if revision == 1
                             else derived_id("result", ticket_id, revision))
        ticket.update({"state": "zur Abnahme", "result": result,
                       "result_message_id": result_message_id, "result_revision": revision,
                       "updated_at": now()})
        ticket.pop("review", None)  # eine neue Revision wird neu geprüft
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


def _require_approver(root: Path, actor: dict[str, Any], ticket: dict[str, Any]) -> None:
    """Die Abnahme- und Pruefungsregel: Hauptagent oder Teamleiter des Teams (Plan Satz 27)."""
    if _setup_created_agent(root, actor):
        raise AgentsError("Aufbau-Herkunft von Agent '%s' ist nicht abnahmebefugt" % actor["id"])
    if actor.get("id") in ORCHESTRATOR_ACTORS and (
            ticket.get("assignee") in ORCHESTRATOR_ACTORS
            or ticket.get("sender") in ORCHESTRATOR_ACTORS):
        raise AgentsError("Orchestrator '%s' darf eigene Arbeit nicht abnehmen" % actor["id"])
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
            raise AgentsError("Teamleiter darf nur Tickets seines Teams oder selbst bearbeitete Tickets von "
                              "Mitgliedern seines Teams abnehmen")
    if actor.get("kind") == "agent" and actor.get("role") == "mitglied":
        raise AgentsError("Mitglied darf Tickets nicht abnehmen")


def _rest_ticket_name(root: Path, ticket_id: str) -> str:
    """Kennung des Rest-Tickets: sprechend am abgenommenen Ticket, sonst die naechste freie."""
    belegt = {t["id"] for t in list_tickets(root)}
    for kandidat in ["%s-rest" % ticket_id] + ["%s-rest-%d" % (ticket_id, nr) for nr in range(2, 100)]:
        if ID_RE.fullmatch(kandidat) and kandidat not in belegt:
            return kandidat
    return new_id("t")


def _rest_ticket_anlegen(root: Path, ticket: dict[str, Any], rest_id: str, note: str | None,
                         sender: str | None, claimed_role: str | None,
                         in_transaction: bool = False) -> dict[str, Any]:
    """Der Rest einer Abnahme `teilweise` als neues Ticket (Plan Satz 40).

    Es uebernimmt Art, Eltern, Prioritaet und Adressat des abgenommenen Tickets, die offenen
    Punkte seiner Fertig-Liste und die Bemerkung des Abnehmenden; `origin` zeigt auf das
    abgenommene Ticket. Die feste Kennung aus der Abnahme macht den Weg idempotent: ein
    zweiter Aufruf findet das Rest-Ticket und legt kein zweites an.
    """
    try:
        return read_ticket(root, rest_id)
    except AgentsError:
        pass
    art = _ticket_kind_feld(ticket)
    bemerkung = " ".join(str(note or "").split())
    punkte = _open_done_items(ticket)
    if not punkte and art in ("story", "task", "subtask") and bemerkung:
        # Die Definition of Ready verlangt fuer diese Arten eine Fertig-Liste; steht kein Punkt
        # mehr offen, ist die Bemerkung des Abnehmenden der eine offene Punkt.
        punkte = [bemerkung]
    eltern = ticket.get("parent")
    if eltern is not None:
        try:
            _ticket_parent_pruefen(root, rest_id, eltern, art)
        except AgentsError:
            eltern = None  # Das Eltern traegt keine Kinder mehr; der Rest steht fuer sich.
    ziel = ticket.get("goal") or ""
    ziel = "%s\n\nRest aus der Abnahme von %s: %s" % (ziel, ticket["id"], bemerkung) if ziel \
        else "Rest aus der Abnahme von %s: %s" % (ticket["id"], bemerkung)
    rest = create_ticket(root, "Rest von %s: %s" % (ticket["id"], ticket.get("title") or ticket["id"]),
                         ziel, ticket.get("done_criterion") or "Rest aus der Abnahme von %s" % ticket["id"],
                         list(ticket.get("recipients") or []), sender, claimed_role,
                         team=ticket.get("team"), ticket_id=rest_id, done_items=punkte,
                         kind=ticket.get("kind"), priority=ticket.get("priority"), parent=eltern,
                         origin=ticket["id"], in_transaction=in_transaction)
    with (nullcontext() if in_transaction else transaction(root)):
        _ticket_event(root, rest, "rest-aus-abnahme", _actor(root, sender, claimed_role),
                      herkunft=ticket["id"], bemerkung=bemerkung)
    return rest


def _abnahme_wiederholung(root: Path, ticket_id: str, approver: str | None, claimed_role: str | None,
                          note: str | None, code: str) -> tuple[dict[str, Any], str | None] | None:
    """Dieselbe Abnahme ein zweites Mal (verlorene Antwort): Ticket und Kennung des Rests.

    Sonst None; dann laeuft die gewoehnliche Abnahme und meldet den Stand des Tickets.
    """
    with transaction(root):
        actor = _require_governance_actor(root, approver, claimed_role, ("hauptagent", "teamleiter"))
        ticket = read_ticket(root, ticket_id)
        if ticket.get("state") != "abgenommen":
            return None
        frueher = ticket.get("approval") or {}
        if (frueher.get("agent") != actor["id"] or frueher.get("note") != note
                or (frueher.get("reason_code") or "erledigt") != code):
            return None
        return ticket, frueher.get("rest")


def approve_ticket(root: Path, ticket_id: str, approver: str | None,
                   claimed_role: str | None, note: str | None, accept: bool = True,
                   reason_code: str | None = None, dod_checked: bool = False) -> dict[str, Any]:
    code = (reason_code if reason_code is not None else "erledigt") if accept else None
    mobile_proof = _mobile_approval_beleg(root, ticket_id, code, note, dod_checked, accept)
    proof_token = _MOBILE_APPROVAL_PROOF.set(mobile_proof)
    try:
        return _approve_ticket(root, ticket_id, approver, claimed_role, note, accept, reason_code, dod_checked, code)
    finally:
        _MOBILE_APPROVAL_PROOF.reset(proof_token)


def _approve_ticket(root: Path, ticket_id: str, approver: str | None,
                    claimed_role: str | None, note: str | None, accept: bool,
                    reason_code: str | None, dod_checked: bool, code: str | None) -> dict[str, Any]:
    if accept and code not in APPROVE_REASONS:
        raise AgentsError("Abnahmegrund muss %s sein" % " oder ".join(APPROVE_REASONS))
    if accept:
        # Wiederholung nach verlorener Antwort: kein zweites Rest-Ticket, aber ein Rest, der
        # zwischen Abnahme und Anlage verloren ging, wird nachgeholt.
        wiederholung = _abnahme_wiederholung(root, ticket_id, approver, claimed_role, note, code)
        if wiederholung is not None:
            ticket, rest_id = wiederholung
            if rest_id:
                _rest_ticket_anlegen(root, ticket, rest_id, note, approver, claimed_role)
            return ticket
    with transaction(root):
        actor = _require_governance_actor(root, approver, claimed_role, ("hauptagent", "teamleiter"))
        ticket = read_ticket(root, ticket_id)
        if ticket["state"] not in ("zur Abnahme", "zurückgegeben"):
            raise AgentsError("Ticket ist %s; keine Abnahme moeglich" % ticket["state"])
        if accept:
            if code == "teilweise" and (note is None or not str(note).strip()):
                raise AgentsError("Abnahme mit Grund teilweise braucht eine Bemerkung")
            if _world_dod(read_world(root)) and not dod_checked:
                raise AgentsError("Definition of Done nicht bestätigt")
        _require_approver(root, actor, ticket)
        if mobile_proof := _MOBILE_APPROVAL_PROOF.get():
            _consume_mobile_approval_beleg(root, mobile_proof)
        if not accept and ticket["state"] == "zurückgegeben":
            approval = ticket.get("approval") or {}
            if approval.get("agent") == actor.get("id") and approval.get("note") == note:
                return ticket  # idempotent retry after a lost response
        ticket["state"] = "abgenommen" if accept else "zurückgegeben"
        approval = {"agent": actor["id"], "verified": bool(actor.get("verified")), "time": now(), "note": note}
        if actor.get("herkunft"):
            approval["herkunft"] = dict(actor["herkunft"])
        if accept:
            approval["reason_code"] = code
        ticket["approval"] = approval
        ticket["updated_at"] = now()
        if not accept:
            ticket.pop("return_to", None)
            ticket.pop("return_to_delivery", None)
            revision = int(ticket.get("return_revision") or 0) + 1
            ticket["return_revision"] = revision
            ticket["return_delivery_id"] = derived_id("ticket-return", ticket_id, revision)
            ticket["return_delivery_time"] = ticket["updated_at"]
            ticket["delivery_sender"] = actor["id"]
        if accept and code == "teilweise":
            # Der Rest wird ein eigenes Ticket, bevor die Eltern nachgezaehlt werden; die
            # Kennung steht in der Abnahme, damit ein zweiter Aufruf denselben Rest findet.
            approval["rest"] = _rest_ticket_name(root, ticket_id)
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        # Die Revision ordnet das Urteil der Ergebnisfassung zu, die es betrifft (Jev-Zuordnung).
        _ticket_event(root, ticket, "abgenommen" if accept else "zurueckgegeben", actor, note=note,
                      grund=code if accept else None, result_revision=int(ticket.get("result_revision") or 0))
        if approval.get("rest"):
            _rest_ticket_anlegen(root, ticket, approval["rest"], note, approver, claimed_role,
                                 in_transaction=True)
        if not accept:
            _deliver_ticket(root, ticket, actor)
        else:
            _deliver_freed_locked(root, actor["id"])
            _eltern_kinder_fertig(root, ticket, actor)
            _melde_vorhaben(root, ticket)
    if accept:
        wake_parked_tickets(root)
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
        if ticket.get("assignee") != agent_id or ticket.get("state") not in ("läuft", "zur Abnahme", "in Prüfung"):
            continue
        ticket["state"] = "unterbrochen"
        ticket["updated_at"] = now()
        _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
        _ticket_event(root, ticket, "unterbrochen", {"id": "system", "verified": False}, reason=reason)


def _interrupt_all_tickets(root: Path, reason: str) -> None:
    for ticket in list_tickets(root):
        if ticket.get("state") in ("läuft", "zur Abnahme", "in Prüfung"):
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
    elif recipient in NON_AGENT_CHANNEL_ACTORS:
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
    existing = None
    if _channel_has_message(root, message_id):
        existing = next(item for item in read_messages(root) if item.get("id") == message_id)
        if any(existing.get(key) != message.get(key) for key in message if key != "time"):
            raise AgentsError("Nachrichtenkennung existiert bereits mit anderem Inhalt")
        message = existing
    else:
        # A crash can leave postbox projections before the channel append.
        # Keep their original timestamp when the same message is retried.
        projected_time = None
        paths = [_human_delivery_path(root, human, message_id) for human in humans]
        paths.extend(_delivery_path(root, target, message_id) for target in recipients)
        for path in paths:
            _reject_symlink(path, "Postfachdatei")
            if path.exists():
                stored_time = _read_json(path).get("time")
                if not isinstance(stored_time, str) or not stored_time:
                    raise AgentsError("Kanalzustellung hat keinen Zeitstempel")
                if projected_time is not None and stored_time != projected_time:
                    raise AgentsError("Kanalzustellungen haben verschiedene Zeitstempel")
                projected_time = stored_time
        if projected_time is not None:
            message["time"] = projected_time
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
    if existing is None:
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
            if result.get("agent") == "system":
                # Ein Eltern auf "zur Abnahme" (Kinder fertig) bekommt die Kinderzustellung
                # nachgetragen, keine Ergebnisnachricht an den Absender.
                _deliver_ticket(root, ticket, {"id": "system", "verified": False})
            else:
                sender = ticket.get("sender") or "hauptagent"
                _deliver_message(root, result.get("agent", ticket.get("assignee")), sender,
                                 "ticket-ergebnis", "Ergebnis zu %s" % ticket["id"], ticket["id"],
                                 result.get("text", ""), ticket.get("result_message_id") or derived_id("result", ticket["id"]))
        elif ticket.get("state") == "läuft":
            result_path = _ticket_path(root, ticket["id"]) / "ergebnis.json"
            if result_path.exists() and _read_json(result_path) != {}:
                _write_json(result_path, {})
    _deliver_freed_locked(root, "system")
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
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent", "teamleiter"))
        ticket = read_ticket(root, ticket_id)
        if ticket["state"] in ("offen", "zur Abnahme", "in Prüfung") and ticket.get("resume_revision"):
            return ticket  # idempotent retry after a lost response
        if ticket["state"] != "unterbrochen":
            raise AgentsError("Ticket ist %s; nur unterbrochene Tickets werden fortgesetzt" % ticket["state"])
        revision = int(ticket.get("resume_revision") or 0) + 1
        ts = now()
        review = ticket.get("review")
        if ticket.get("state") == "unterbrochen" and isinstance(review, dict) and review.get("reviewer"):
            # Eine unterbrochene Pruefung wird dem Pruefer neu zugestellt (Plan Satz 34).
            ticket.update({"state": "in Prüfung", "resume_revision": revision, "updated_at": ts})
            _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
            delivery_id = derived_id("ticket-review", ticket_id, review.get("revision"), revision)
            reviewer = valid_id(review["reviewer"], "Prueferkennung")
            path = _delivery_path(root, reviewer, delivery_id)
            payload = {"delivery_id": delivery_id, "kind": "ticket-review", "ticket_id": ticket_id,
                       "time": ts, "sender": review.get("requested_by") or actor["id"],
                       "acknowledged": False, "recipient": reviewer}
            if path.exists():
                stored = _read_json(path)
                if any(stored.get(key) != payload[key] for key in payload if key != "acknowledged"):
                    raise AgentsError("Pruefungszustellung existiert bereits mit anderem Inhalt")
            else:
                _write_json(path, payload)
            _ticket_event(root, ticket, "fortgesetzt", actor, revision=revision, restored="in Prüfung",
                          pruefer=reviewer, zustellung=delivery_id)
            return ticket
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
# Warten, Fragen, Verwerfen, Umadressieren und Triage (Plan AGENTS-TICKETS-PLAN
# Abschnitt 5, Saetze 19 bis 24 und 39 bis 41).  Jeder Uebergang laeuft unter
# dem Welt-Lock, ist bei Wiederholung mit gleichen Argumenten idempotent und
# traegt ein Ereignis in den Ticketverlauf.
# ---------------------------------------------------------------------------

def _epoch_of(value: Any) -> float:
    text = str(value).strip()
    stamp = _dt.datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=_dt.timezone.utc)
    return stamp.timestamp()


def _ticket_delivery_recipients(root: Path, ticket: dict[str, Any]) -> tuple[list[str], str]:
    delivery_id = ticket.get("return_delivery_id") or derived_id("ticket", ticket["id"])
    if ticket.get("return_to") and ticket.get("return_to_delivery") == delivery_id:
        return list(ticket["return_to"]), delivery_id
    recipients = list(ticket.get("recipients") or [])
    if ticket.get("team"):
        recipients.extend(a["id"] for a in list_agents(root) if a.get("team") == ticket["team"])
    return recipients, delivery_id


def _ticket_has_open_delivery(root: Path, ticket: dict[str, Any]) -> bool:
    recipients, delivery_id = _ticket_delivery_recipients(root, ticket)
    for recipient in sorted(set(recipients)):
        path = _delivery_path(root, recipient, delivery_id)
        if path.exists() and not _read_json(path).get("acknowledged"):
            return True
    return False


def _ticket_event_exists(root: Path, ticket_id: str, event: str, **match: Any) -> bool:
    for entry in _read_jsonl(_ticket_path(root, ticket_id) / "verlauf.jsonl", "Ticketverlauf"):
        if entry.get("event") == event and all(entry.get(key) == value for key, value in match.items()):
            return True
    return False


def _acknowledge_ticket_deliveries(root: Path, ticket: dict[str, Any], actor_id: str) -> None:
    recipients, delivery_id = _ticket_delivery_recipients(root, ticket)
    for recipient in sorted(set(recipients)):
        path = _delivery_path(root, recipient, delivery_id)
        if not path.exists():
            continue
        data = _read_json(path)
        if data.get("acknowledged"):
            continue
        data["acknowledged"] = True
        data["acknowledged_at"] = now()
        data["acknowledged_by"] = actor_id
        _write_json(path, data)


def _deliver_freed_locked(root: Path, sender: str = "system") -> None:
    approved = [item for item in list_tickets(root) if item.get("state") == "abgenommen"]
    if not approved:
        return
    for ticket in list_tickets(root):
        if ticket.get("state") not in ("offen", "zurückgegeben"):
            continue
        deps = list(ticket.get("dependencies") or [])
        if not deps or not any(item["id"] in deps for item in approved):
            continue
        states = {item["id"]: item for item in approved}
        for dep in deps:
            if dep in states:
                continue
            try:
                if read_ticket(root, dep).get("state") != "abgenommen":
                    break
            except AgentsError:
                break
        else:
            approval = next(item for item in approved if item["id"] in deps)
            approval_time = (approval.get("approval") or {}).get("time") or approval.get("updated_at")
            delivery_id = derived_id("ticket-free", ticket["id"], approval["id"], approval_time)
            if _ticket_event_exists(root, ticket["id"], "frei", zustellung=delivery_id):
                continue
            if _ticket_has_open_delivery(root, ticket):
                continue
            recipients, _ = _ticket_delivery_recipients(root, ticket)
            ts = now()
            ticket.update({"return_to": sorted(set(recipients)), "return_to_delivery": delivery_id,
                           "return_delivery_id": delivery_id, "return_delivery_time": ts,
                           "delivery_sender": sender, "updated_at": ts})
            _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
            _deliver_ticket(root, ticket, {"id": sender, "verified": False})
            _ticket_event(root, ticket, "frei", {"id": sender, "verified": False},
                          abnahme=approval["id"], zustellung=delivery_id)


def _wake_parked_locked(root: Path, now_epoch: float) -> list[str]:
    woke: list[str] = []
    for ticket in list_tickets(root):
        parked = ticket.get("parked")
        if not isinstance(parked, dict) or not parked:
            continue
        due = False
        until = parked.get("until")
        if until is not None:
            try:
                due = _epoch_of(until) <= now_epoch
            except (ValueError, TypeError, OSError):
                due = False
        waiting_for = parked.get("waiting_for")
        grund = None
        if waiting_for is not None and not due:
            try:
                target = read_ticket(root, waiting_for)
            except AgentsError:
                target = None
            state = (target or {}).get("state")
            if state == "abgenommen":
                due = True
            elif state == "verworfen":
                # Ein verworfen entblocktes Warteticket weckt ebenfalls; das Ereignis nennt den Grund.
                due, grund = True, "warteticket %s verworfen" % waiting_for
        if not due:
            continue
        ts = now()
        ticket.pop("parked", None)
        ticket["updated_at"] = ts
        if ticket.get("state") == "triage":
            _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
            _ticket_event(root, ticket, "geweckt", {"id": "system", "verified": False},
                          until=until, waiting_for=waiting_for, grund=grund)
            woke.append(ticket["id"])
            continue
        revision = int(ticket.get("wake_revision") or 0) + 1
        delivery_id = derived_id("ticket-wake", ticket["id"], revision)
        target = [ticket["assignee"]] if ticket.get("assignee") else list(ticket.get("recipients") or [])
        ticket.update({"state": "offen", "wake_revision": revision, "return_to": target,
                       "return_to_delivery": delivery_id, "return_delivery_id": delivery_id,
                       "return_delivery_time": ts, "delivery_sender": "system"})
        _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
        _deliver_ticket(root, ticket, {"id": "system", "verified": False})
        _ticket_event(root, ticket, "geweckt", {"id": "system", "verified": False},
                      until=until, waiting_for=waiting_for, grund=grund)
        woke.append(ticket["id"])
    return woke


def wake_parked_tickets(root: Path, now: float | None = None) -> list[str]:
    """Open every parked ticket whose wake time passed or whose ticket was approved.

    Called by the carrier in each pass and by `approve_ticket` after an
    approval; a triage ticket parked by the main agent returns to `triage`,
    every other parked ticket opens with a fresh delivery to its assignee.
    """
    with transaction(root):
        return _wake_parked_locked(root, time.time() if now is None else float(now))


def park_ticket(root: Path, ticket_id: str, agent_id: str, reason: str, until: str | None = None,
                waiting_for: str | None = None, sender: str | None = None,
                claimed_role: str | None = None) -> dict[str, Any]:
    """Park a running ticket with a reason and exactly one wake condition.

    Only the assignee parks, and only from `läuft`; the main agent may defer a
    triage ticket, which stays in `triage` with its `parked` fields.  A parked
    ticket keeps its assignee but frees the agent's one running slot.
    """
    valid_id(ticket_id, "Ticketkennung")
    if not isinstance(reason, str) or not reason.strip():
        raise AgentsError("Parken braucht einen Grund")
    if (until is None) == (waiting_for is None):
        raise AgentsError("Genau eines von --bis (Zeitpunkt) oder --auf (Ticketkennung) ist Pflicht")
    if waiting_for is not None:
        valid_id(waiting_for, "Ticketkennung")
    if until is not None:
        try:
            _epoch_of(until)
        except (ValueError, TypeError, OSError) as exc:
            raise AgentsError("--bis braucht eine ISO-Zeit (z. B. 2026-09-18T09:00:00Z)") from exc
    with transaction(root):
        actor = _actor(root, sender or agent_id, claimed_role)
        ticket = read_ticket(root, ticket_id)
        parked = ticket.get("parked") or {}
        if isinstance(parked, dict) and parked and parked.get("reason") == reason \
                and parked.get("until") == until and parked.get("waiting_for") == waiting_for:
            return ticket
        if waiting_for is not None:
            target = read_ticket(root, waiting_for)
            if waiting_for == ticket_id:
                raise AgentsError("Ticket-Abhaengigkeit bildet einen Zyklus")
            _ticket_dependencies_cycle(root, ticket_id, list(ticket.get("dependencies") or []) + [waiting_for])
            if isinstance(target.get("parked"), dict) and target["parked"].get("waiting_for") == ticket_id:
                raise AgentsError("Ticket-Abhaengigkeit bildet einen Zyklus")
        ts = now()
        parked = {"reason": reason, "until": until, "waiting_for": waiting_for,
                  "by": actor["id"], "at": ts}
        if ticket.get("state") == "triage":
            actor = _require_governance_actor(root, sender or agent_id, claimed_role, ("hauptagent",))
            if actor.get("kind") == "agent" and actor.get("role") != "hauptagent":
                raise AgentsError("Zurueckstellen aus der Triage darf nur der Hauptagent der Welt")
            ticket.update({"parked": parked, "updated_at": ts})
            _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
            _ticket_event(root, ticket, "geparkt", actor, reason=reason, until=until, waiting_for=waiting_for)
            return ticket
        if ticket.get("state") != "läuft":
            raise AgentsError("Ticket ist %s; nur ein laufendes Ticket wird geparkt" % ticket["state"])
        if actor.get("kind") == "external" or actor.get("id") != agent_id \
                or ticket.get("assignee") != agent_id:
            raise AgentsError("Nur der Bearbeiter darf das Ticket parken")
        ticket.update({"state": "wartet", "parked": parked, "updated_at": ts})
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "geparkt", actor, reason=reason, until=until, waiting_for=waiting_for)
        return ticket


def flag_ticket(root: Path, ticket_id: str, question_id: str, reason: str,
                sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Mark a ticket as waiting on an open question; only the main agent (or the human) flags.

    The question must exist and be open.  Answering it reopens the ticket with
    a delivery to its assignee (event `beantwortet`).
    """
    valid_id(ticket_id, "Ticketkennung")
    valid_id(question_id, "Fragenkennung")
    if not isinstance(reason, str) or not reason.strip():
        raise AgentsError("Braucht-dich braucht einen Grund")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
        question = read_question(root, question_id)
        if question.get("state") != "offen":
            raise AgentsError("Frage %s ist %s; nur eine offene Frage wird vermerkt" % (
                question_id, question.get("state")))
        ticket = read_ticket(root, ticket_id)
        flag = ticket.get("flag") or {}
        if isinstance(flag, dict) and flag and flag.get("question") == question_id \
                and flag.get("reason") == reason:
            return ticket
        if flag:
            raise AgentsError("Ticket haengt bereits an Frage %s" % flag.get("question"))
        if ticket.get("state") not in ("läuft", "wartet"):
            raise AgentsError("Ticket ist %s; braucht-dich nur aus läuft oder wartet" % ticket["state"])
        ts = now()
        ticket.pop("parked", None)
        ticket.update({"state": "braucht dich", "updated_at": ts,
                       "flag": {"question": question_id, "reason": reason, "by": actor["id"], "at": ts}})
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "braucht-dich", actor, frage=question_id, grund=reason)
        return ticket


def discard_ticket(root: Path, ticket_id: str, reason_code: str, note: str | None = None,
                   sender: str | None = None, claimed_role: str | None = None,
                   duplicate_of: str | None = None) -> dict[str, Any]:
    """Discard a ticket with a reason from the fixed catalog; never from `abgenommen`.

    The sender of the ticket, the main agent or the human discards.  A duplicate
    names the existing original, which gets a `duplikat-gemeldet` event.
    Dependent tickets stay open with an `abhaengigkeit-verworfen` event; a
    discarded dependency never fulfils `claim_ticket` or readiness.
    """
    valid_id(ticket_id, "Ticketkennung")
    if reason_code not in DISCARD_REASONS:
        raise AgentsError("Verwerfungsgrund muss %s sein" % ", ".join(DISCARD_REASONS))
    if note is not None and not isinstance(note, str):
        raise AgentsError("Bemerkung muss ein Text sein")
    if duplicate_of is not None:
        valid_id(duplicate_of, "Ticketkennung")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, STAGES)
        ticket = read_ticket(root, ticket_id)
        discard = ticket.get("discard") or {}
        same = (isinstance(discard, dict) and discard.get("code") == reason_code
                and discard.get("note") == note and discard.get("duplicate_of") == duplicate_of)
        if ticket.get("state") == "verworfen":
            if same:
                return ticket
            raise AgentsError("Ticket ist bereits verworfen")
        if ticket.get("state") == "abgenommen":
            raise AgentsError("Ticket ist abgenommen; es wird nicht verworfen")
        if actor.get("kind") == "agent" and actor.get("role") != "hauptagent" \
                and actor["id"] != ticket.get("sender"):
            raise AgentsError("Verwerfen darf der Absender des Tickets oder der Hauptagent")
        if reason_code == "duplikat":
            if not duplicate_of:
                raise AgentsError("Grund duplikat braucht ein --duplikat-von")
            if duplicate_of == ticket_id:
                raise AgentsError("Ein Ticket ist kein Duplikat von sich selbst")
            original = read_ticket(root, duplicate_of)
        ts = now()
        _acknowledge_ticket_deliveries(root, ticket, actor["id"])
        ticket.update({"state": "verworfen", "updated_at": ts,
                       "discard": {"code": reason_code, "note": note, "by": actor["id"], "at": ts,
                                   "duplicate_of": duplicate_of}})
        if reason_code == "duplikat":
            ticket["duplicate_of"] = duplicate_of
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "verworfen", actor, code=reason_code, note=note, duplicate_of=duplicate_of)
        if reason_code == "duplikat":
            _ticket_event(root, original, "duplikat-gemeldet", actor, duplikat=ticket_id)
        for other in list_tickets(root):
            if other["id"] == ticket_id or other.get("state") == "verworfen":
                continue
            if ticket_id in (other.get("dependencies") or []):
                _ticket_event(root, other, "abhaengigkeit-verworfen", actor, abhaengigkeit=ticket_id)
        return ticket


def reassign_ticket(root: Path, ticket_id: str, recipients: list[str], team: str | None = None,
                    reason: str | None = None, sender: str | None = None,
                    claimed_role: str | None = None) -> dict[str, Any]:
    """Address a ticket anew with a reason; the old delivery is acknowledged, the new one goes out.

    Allowed while no assignee runs, or by the assignee from `läuft` (then the
    ticket opens again without an assignee).
    """
    valid_id(ticket_id, "Ticketkennung")
    recipients = list(recipients or [])
    if not recipients and not team:
        raise AgentsError("Umadressieren braucht neue Adressaten oder ein Team")
    if not isinstance(reason, str) or not reason.strip():
        raise AgentsError("Umadressieren braucht einen Grund")
    if team is not None:
        valid_id(team, "Team")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, STAGES)
        ticket = read_ticket(root, ticket_id)
        previous = ticket.get("reassign") or {}
        if isinstance(previous, dict) and previous.get("recipients") == recipients \
                and previous.get("team") == team and previous.get("reason") == reason:
            return ticket
        state = ticket.get("state")
        bearbeiter_haengt = state in ("läuft", "wartet", "braucht dich")
        if actor.get("kind") == "agent":
            if state == "läuft" and actor["id"] != ticket.get("assignee"):
                raise AgentsError("Ticket ist %s; umadressieren darf der Bearbeiter selbst" % state)
            if state in ("wartet", "braucht dich") and actor["id"] not in \
                    (ticket.get("assignee"), ticket.get("sender")) and actor.get("role") != "hauptagent":
                raise AgentsError("Ticket ist %s; umadressieren darf der Bearbeiter, der Absender oder "
                                  "der Hauptagent" % state)
            if not bearbeiter_haengt and actor.get("role") != "hauptagent" and actor["id"] != ticket.get("sender"):
                raise AgentsError("Umadressieren darf der Absender des Tickets oder der Hauptagent")
        for recipient in recipients:
            read_agent(root, recipient)
        ts = now()
        revision = int(ticket.get("reassign_revision") or 0) + 1
        delivery_id = derived_id("ticket-reassign", ticket_id, revision)
        _acknowledge_ticket_deliveries(root, ticket, actor["id"])
        ticket.update({"recipients": recipients, "team": team, "updated_at": ts,
                       "reassign_revision": revision, "return_delivery_id": delivery_id,
                       "return_delivery_time": ts, "delivery_sender": actor["id"],
                       "reassign": {"recipients": recipients, "team": team, "reason": reason,
                                    "by": actor["id"], "at": ts}})
        ticket.pop("return_to", None)
        ticket.pop("return_to_delivery", None)
        if state == "läuft":
            # Der Bearbeiter gibt ab: das Ticket oeffnet neu ohne Bearbeiter.
            ticket.update({"state": "offen", "assignee": None, "claimed_at": None})
        elif state in ("wartet", "braucht dich"):
            # Der Stand bleibt (Weckbedingung oder Frage kennen die neuen Adressaten); sie
            # werden sofort informiert, und beim Wecken oder Antworten geht die Zustellung
            # an die neuen Adressaten (tickets2).
            ticket.update({"assignee": None, "claimed_at": None})
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "umadressiert", actor, grund=reason, an=recipients, team=team,
                      aus_lauf=state == "läuft")
        _deliver_ticket(root, ticket, actor)
        return ticket


def triage_accept(root: Path, ticket_id: str, recipients: list[str] | None = None,
                  team: str | None = None, priority: Any = None, kind: Any = None,
                  sender: str | None = None, claimed_role: str | None = None,
                  done_items: list[str] | None = None, parent: str | None = None) -> dict[str, Any]:
    """Address a triage ticket anew; only the main agent (or the human) decides.

    `priority`, `kind` and `parent` are the tickets3 fields: kind is checked
    against the catalog, priority against 0 to 3, the parent against the
    hierarchy rules.  The Definition of Ready (plan sentence 45) refuses the
    acceptance with the same reason `ready_tickets` reports.  `done_items` is
    part of the creation flow and may only be set while the ticket is still in
    triage without a list of its own.
    """
    valid_id(ticket_id, "Ticketkennung")
    recipients = list(recipients or [])
    if not recipients and not team:
        raise AgentsError("Annehmen braucht Adressaten oder ein Team")
    if priority is not None and (isinstance(priority, bool) or not isinstance(priority, (str, int, float))):
        raise AgentsError("Prioritaet muss ein Text oder eine Zahl sein")
    if priority is not None:
        _ticket_priority_wert(priority)
    art = _ticket_kind_wert(kind)
    punkte = _done_item_list(done_items)
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
        ticket = read_ticket(root, ticket_id)
        previous = ticket.get("triage") or {}
        if isinstance(previous, dict) and previous.get("recipients") == recipients \
                and previous.get("team") == team and previous.get("priority") == priority \
                and previous.get("kind") == kind and previous.get("parent") == parent \
                and ticket.get("state") == "offen" \
                and (not punkte or [item["text"] for item in ticket.get("done_items") or []] == punkte):
            return ticket
        if ticket.get("state") != "triage":
            raise AgentsError("Ticket ist %s; nur ein Triage-Ticket wird angenommen" % ticket.get("state"))
        if ticket.get("parked"):
            raise AgentsError("Ticket ist zurueckgestellt; es wird erst geweckt")
        if punkte and _ticket_done_items(ticket):
            raise AgentsError("Fertig-Liste ist bereits gesetzt und bleibt unveraenderlich")
        wirksame_art = art if kind is not None else _ticket_kind_feld(ticket)
        liste = punkte or [item["text"] for item in _ticket_done_items(ticket)]
        grund = _definition_of_ready_grund(wirksame_art, liste, ticket.get("limits"), recipients, team,
                                           ticket.get("title"), ticket.get("goal"), ticket.get("done_criterion"))
        if grund:
            raise AgentsError("Nicht bereit: %s" % grund)
        eltern = None
        if parent is not None:
            eltern = _ticket_parent_pruefen(root, ticket_id, parent, wirksame_art)
        for recipient in recipients:
            read_agent(root, recipient)
        ts = now()
        delivery_id = derived_id("ticket-triage", ticket_id)
        zyklen = (read_world(root).get("cycles") or {})
        aktueller = (zyklen.get("current") or {}).get("id") if zyklen.get("enabled") else None
        ticket.update({"state": "offen", "recipients": recipients, "team": team, "updated_at": ts,
                       "return_delivery_id": delivery_id, "return_delivery_time": ts,
                       "delivery_sender": actor["id"],
                       "triage": {"recipients": recipients, "team": team, "priority": priority,
                                  "kind": kind, "parent": parent, "by": actor["id"], "at": ts}})
        ticket.pop("return_to", None)
        ticket.pop("return_to_delivery", None)
        ticket.pop("order", None)  # angenommen: die Triage-Reihenfolge hat ausgedient
        if priority is not None:
            ticket["priority"] = priority
        ticket["kind"] = wirksame_art
        if parent is not None:
            ticket["parent"] = parent
        if eltern is not None and eltern.get("cycle"):
            ticket["cycle"] = eltern["cycle"]
        elif aktueller and not ticket.get("cycle"):
            # Der Zyklus des Tickets ist der aktuelle der Welt (Plan Satz 46); das geerbte bleibt.
            ticket["cycle"] = aktueller
        if punkte:
            ticket["done_items"] = [{"text": text, "done": False, "by": None, "at": None} for text in punkte]
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "angenommen", actor, an=recipients, team=team,
                      prioritaet=priority, art=kind, eltern=parent)
        _deliver_ticket(root, ticket, actor)
        return ticket


# ---------------------------------------------------------------------------
# Zwischenstand, Fertig-Liste und Pruefer (tickets2, Plan AGENTS-TICKETS-PLAN
# Abschnitt 5 Saetze 2, 15, 16, 25, 26 und AGENTS-TICKETS-AGIL Abschnitt 6).
# ---------------------------------------------------------------------------

NOTE_LIMIT = 2000


def note_ticket(root: Path, ticket_id: str, agent_id: str, text: str,
                sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Append a progress note of the assignee to the ticket history (plan sentences 15, 16).

    Only the assignee notes, and only from `läuft` or `wartet`; the state never
    changes and the note may be written any number of times.  The text is
    capped at 2000 characters.
    """
    valid_id(ticket_id, "Ticketkennung")
    if not isinstance(text, str) or not text.strip():
        raise AgentsError("Zwischenstand fehlt")
    if len(text) > NOTE_LIMIT:
        raise AgentsError("Zwischenstand ist laenger als %d Zeichen" % NOTE_LIMIT)
    with transaction(root):
        actor = _actor(root, sender or agent_id, claimed_role)
        if actor.get("kind") != "agent" or actor["id"] != agent_id:
            raise AgentsError("Zwischenstand schreibt nur der Bearbeiter selbst")
        ticket = read_ticket(root, ticket_id)
        if ticket.get("assignee") != agent_id:
            raise AgentsError("Nur der Bearbeiter darf einen Zwischenstand schreiben")
        if ticket["state"] not in ("läuft", "wartet"):
            raise AgentsError("Ticket ist %s; Zwischenstand nur aus läuft oder wartet" % ticket["state"])
        _ticket_event(root, ticket, "zwischenstand", actor, text=text)
        return read_ticket(root, ticket_id)


def check_done_item(root: Path, ticket_id: str, agent_id: str, index: int, done: bool = True,
                    sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Tick (or untick) one item of the done list; idempotent, only the assignee from `läuft`.

    The list itself is immutable after creation; only the `done` mark moves.
    """
    valid_id(ticket_id, "Ticketkennung")
    if not isinstance(index, int) or isinstance(index, bool):
        raise AgentsError("Nummer muss eine Zahl sein")
    if not isinstance(done, bool):
        raise AgentsError("Haken muss true oder false sein")
    with transaction(root):
        actor = _actor(root, sender or agent_id, claimed_role)
        if actor.get("kind") != "agent" or actor["id"] != agent_id:
            raise AgentsError("Haken setzt nur der Bearbeiter selbst")
        ticket = read_ticket(root, ticket_id)
        if ticket.get("assignee") != agent_id:
            raise AgentsError("Nur der Bearbeiter setzt den Haken")
        if ticket["state"] != "läuft":
            raise AgentsError("Ticket ist %s; Haken nur aus läuft" % ticket["state"])
        items = _ticket_done_items(ticket)
        if not items or index < 1 or index > len(items):
            raise AgentsError("Fertig-Punkt %d existiert nicht (1 bis %d)" % (index, len(items)))
        item = items[index - 1]
        if bool(item.get("done")) == done:
            return ticket
        ts = now()
        item.update({"done": done, "by": agent_id, "at": ts})
        ticket["done_items"] = items
        ticket["updated_at"] = ts
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "fertig-zurueck" if not done else "fertig-gehaekt", actor,
                      punkt=item["text"], nr=index)
        return ticket


def review_ticket(root: Path, ticket_id: str, reviewer_id: str,
                  sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Move a ticket from `zur Abnahme` into `in Prüfung` with a named reviewer (plan sentence 25).

    Only the approver (main agent or team leader of the team) requests the
    review, exactly once per result revision.  The reviewer must be an active
    agent other than the assignee.  The reviewer is delivered a `pruefung`
    post with the review note still missing.
    """
    valid_id(ticket_id, "Ticketkennung")
    valid_id(reviewer_id, "Prueferkennung")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent", "teamleiter"))
        ticket = read_ticket(root, ticket_id)
        revision = int(ticket.get("result_revision") or 0)
        review = ticket.get("review")
        if isinstance(review, dict) and review.get("revision") == revision \
                and ticket["state"] == "in Prüfung" and review.get("reviewer") == reviewer_id \
                and review.get("requested_by") == actor["id"] and review.get("note") is None:
            return ticket  # idempotent retry after a lost response
        if ticket["state"] != "zur Abnahme":
            raise AgentsError("Ticket ist %s; Pruefung nur aus zur Abnahme" % ticket["state"])
        if isinstance(review, dict) and review.get("revision") == revision:
            raise AgentsError("Revision %d wurde bereits geprueft" % revision)
        reviewer = read_agent(root, reviewer_id)
        if reviewer.get("state") != "aktiv":
            raise AgentsError("Pruefer ist %s; nur ein aktiver Agent prueft" % reviewer.get("state"))
        if reviewer_id == ticket.get("assignee"):
            raise AgentsError("Der Bearbeiter prueft sich nicht selbst")
        _require_approver(root, actor, ticket)
        ts = now()
        ticket.update({"state": "in Prüfung", "updated_at": ts,
                       "review": {"reviewer": reviewer_id, "revision": revision,
                                  "requested_by": actor["id"], "at": ts, "note": None}})
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "pruefung-angefordert", actor, pruefer=reviewer_id, revision=revision)
        delivery_id = derived_id("ticket-review", ticket_id, revision)
        for recipient in sorted({reviewer_id}):
            path = _delivery_path(root, recipient, delivery_id)
            payload = {"delivery_id": delivery_id, "kind": "ticket-review", "ticket_id": ticket_id,
                       "time": ts, "sender": actor["id"], "acknowledged": False, "recipient": reviewer_id}
            if path.exists():
                stored = _read_json(path)
                if any(stored.get(key) != payload[key] for key in payload if key != "acknowledged"):
                    raise AgentsError("Pruefungszustellung existiert bereits mit anderem Inhalt")
            else:
                _write_json(path, payload)
        return ticket


def review_result(root: Path, ticket_id: str, reviewer_id: str, text: str, verdict: str,
                  sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Submit the review note exactly once (plan sentence 26).

    Only the registered reviewer, only from `in Prüfung`; the verdict is
    `bestanden` or `maengel`.  The ticket returns to `zur Abnahme` and the
    approver who requested the review gets the note (`ticket-reviewed-…`).
    """
    valid_id(ticket_id, "Ticketkennung")
    if not isinstance(text, str) or not text.strip():
        raise AgentsError("Pruefnotiz fehlt")
    if len(text) > NOTE_LIMIT:
        raise AgentsError("Pruefnotiz ist laenger als %d Zeichen" % NOTE_LIMIT)
    if verdict not in REVIEW_VERDICTS:
        raise AgentsError("Prüfurteil muss %s sein" % " oder ".join(REVIEW_VERDICTS))
    with transaction(root):
        actor = _actor(root, sender or reviewer_id, claimed_role)
        if actor.get("kind") != "agent" or actor["id"] != reviewer_id:
            raise AgentsError("Pruefnotiz schreibt nur der eingetragene Pruefer")
        ticket = read_ticket(root, ticket_id)
        review = ticket.get("review") or {}
        revision = int(ticket.get("result_revision") or 0)
        if ticket["state"] == "zur Abnahme" and isinstance(review, dict) \
                and review.get("revision") == revision and review.get("reviewer") == reviewer_id \
                and review.get("note") == text and review.get("verdict") == verdict:
            return ticket  # idempotent retry after a lost response
        if ticket["state"] != "in Prüfung":
            raise AgentsError("Ticket ist %s; Pruefnotiz nur aus in Prüfung" % ticket["state"])
        if review.get("reviewer") != reviewer_id or review.get("revision") != revision:
            raise AgentsError("Pruefer ist nicht fuer diese Revision eingetragen")
        ts = now()
        review.update({"note": text, "verdict": verdict, "at": ts})
        ticket.update({"state": "zur Abnahme", "updated_at": ts, "review": review})
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "pruefnotiz", actor, text=text, verdict=verdict, revision=revision)
        requested_by = review.get("requested_by")
        if requested_by:
            # Antwort-Betreff: der Träger verlangt keine Gegenantwort auf die Prüfnotiz.
            _deliver_message(root, reviewer_id, requested_by, "kanal", "Antwort", ticket_id,
                             "Prüfnotiz zu %s (%s): %s" % (ticket_id, verdict, text),
                             derived_id("ticket-reviewed", ticket_id, revision))
        return ticket


def ready_tickets(root: Path) -> list[dict[str, Any]]:
    """Every ticket with `ready` and, if not ready, the reason why it is not.

    Ready means: state `offen` or `zurückgegeben`, the Definition of Ready is
    met (plan sentence 45), every dependency approved, at least one active
    addressee without a running ticket, the world running and the world's WIP
    limit not reached (sentence 48).  Triage tickets sort by their backlog
    `order` (sentence 44), the rest by `priority` ascending (missing counts as
    normal), then `created_at`, then id.
    """
    root = world_path(str(root))
    world = read_world(root)
    agents = {a["id"]: a for a in list_agents(root)}
    tickets = list_tickets(root)
    by_id = {t["id"]: t for t in tickets}
    running = {t.get("assignee") for t in tickets if t.get("state") == "läuft"}
    result = []
    for ticket in tickets:
        blocker = _ticket_blocker(root, ticket, world, agents, by_id, running)
        entry = dict(ticket)
        entry["ready"] = blocker is None
        entry["reason"] = blocker
        result.append(entry)

    def sort_key(entry: dict[str, Any]) -> tuple[Any, ...]:
        if entry.get("state") == "triage":
            order = entry.get("order")
            num = order if isinstance(order, int) and not isinstance(order, bool) else 10 ** 9
            return (0, 0, num, str(entry.get("created_at") or ""), entry["id"])
        priority = entry.get("priority")
        if isinstance(priority, bool):
            bucket, value = 2, 0
        elif isinstance(priority, (int, float)):
            bucket, value = 0, priority
        elif isinstance(priority, str) and priority.strip():
            bucket, value = 1, 0
        else:
            bucket, value = 0, DEFAULT_PRIORITY  # Bestand ohne Feld gilt als normal
        return (1, bucket, value, str(entry.get("created_at") or ""), entry["id"])
    return sorted(result, key=sort_key)


# Die Felder eines Entwurfs: die Namen des Anlageformulars (`wb-ticket neu`) und daneben die
# Feldnamen eines gespeicherten Tickets, damit die Oberflaeche beide Formen schicken kann.
DRAFT_FELDER = {
    "title": ("titel", "title"),
    "goal": ("ziel", "goal"),
    "done_criterion": ("fertig", "done", "done_criterion"),
    "recipients": ("an", "recipients"),
    "team": ("team",),
    "kind": ("art", "kind"),
    "priority": ("prioritaet", "priority"),
    "limits": ("grenzen", "limits"),
    "done_items": ("fertig-punkt", "fertig-punkte", "fertig_punkte", "done_items"),
    "dependencies": ("abhaengig-von", "abhaengig_von", "dependencies"),
}


def _entwurf_normalisieren(draft: dict[str, Any]) -> dict[str, Any]:
    """Aus den Formularfeldern die Felder eines Tickets machen; prueft die Werte wie die Anlage."""
    if not isinstance(draft, dict):
        raise AgentsError("Entwurf braucht ein JSON-Objekt")
    werte: dict[str, Any] = {}
    for feld, namen in DRAFT_FELDER.items():
        for name in namen:
            if draft.get(name) is not None:
                werte[feld] = draft[name]
                break
    grenzen = werte.get("limits") or {}
    if not isinstance(grenzen, dict):
        raise AgentsError("Grenzen brauchen ein JSON-Objekt")
    grenzen = dict(grenzen)
    for name in ("frist", "runden"):
        if draft.get(name) is not None:
            grenzen[name] = draft[name]
    grenzen = _ticket_limits_wert(grenzen)
    art = _ticket_kind_wert(werte.get("kind"))
    prioritaet = werte.get("priority")
    if prioritaet is not None:
        _ticket_priority_wert(prioritaet)
    empfaenger = werte.get("recipients") or []
    if isinstance(empfaenger, str):
        empfaenger = [empfaenger]
    if not isinstance(empfaenger, list) or any(not isinstance(a, str) or not a.strip() for a in empfaenger):
        raise AgentsError("Adressaten brauchen eine Liste aus Kennungen")
    empfaenger = [valid_id(a.strip(), "Adressat") for a in empfaenger]
    team = werte.get("team")
    if team is not None and not isinstance(team, str):
        raise AgentsError("Team ungueltig")
    team = valid_id(team.strip(), "Team") if team and team.strip() else None
    punkte = werte.get("done_items")
    if isinstance(punkte, list):
        punkte = [item.get("text") if isinstance(item, dict) else item for item in punkte]
    punkte = _done_item_list(punkte)
    abhaengig = werte.get("dependencies") or []
    if isinstance(abhaengig, str):
        abhaengig = [abhaengig]
    if not isinstance(abhaengig, list) or any(not isinstance(d, str) or not d.strip() for d in abhaengig):
        raise AgentsError("Abhaengigkeiten brauchen eine Liste aus Ticketkennungen")
    abhaengig = [valid_id(d.strip(), "Ticketkennung") for d in abhaengig]
    # Die Vorgabe-Grenze der Anlage zaehlt mit (create_ticket): ohne Frist und Rundenzahl sechs
    # Zuege, ein Vorhaben ohne Grenze. Sonst meldet die Vorschau eine Luecke, die es nicht gibt.
    if "frist" not in grenzen and "runden" not in grenzen and art != "vorhaben":
        grenzen["runden"] = DEFAULT_ROUNDS
    return {"title": str(werte.get("title") or ""), "goal": str(werte.get("goal") or ""),
            "done_criterion": str(werte.get("done_criterion") or ""),
            "recipients": empfaenger, "team": team, "kind": art, "priority": prioritaet,
            "limits": grenzen, "done_items": punkte, "dependencies": abhaengig}


def ready_draft(root: Path, draft: dict[str, Any]) -> dict[str, Any]:
    """Bereitschaft eines Entwurfs, bevor das Ticket angelegt ist; schreibt nichts (Plan Satz 45).

    Dieselbe Definition of Ready, die `ready_tickets` an einem gespeicherten Ticket fuehrt, nur
    auf den Feldern des Anlageformulars. Dazu die Punkte, die `ready_tickets` erst nach der
    Anlage sehen wuerde: Adressat und Team gibt es in dieser Welt und sind aktiv, die
    Abhaengigkeiten sind abgenommen. Stand der Welt und WIP-Grenze bleiben aussen vor, denn sie
    gehoeren der Welt und nicht dem Entwurf.
    """
    root = world_path(str(root))
    entwurf = _entwurf_normalisieren(draft)
    fehlt = _definition_of_ready_fehlt(entwurf["kind"], entwurf["done_items"], entwurf["limits"],
                                       entwurf["recipients"], entwurf["team"], entwurf["title"],
                                       entwurf["goal"], entwurf["done_criterion"])
    agents = {a["id"]: a for a in list_agents(root)}
    for empfaenger in entwurf["recipients"]:
        agent = agents.get(empfaenger)
        if agent is None:
            fehlt.append({"punkt": "adressaten", "text": "Adressat %s gibt es in dieser Welt nicht" % empfaenger})
        elif agent.get("state") != "aktiv":
            fehlt.append({"punkt": "adressaten", "text": "Adressat %s ist %s" % (empfaenger, agent.get("state"))})
    if entwurf["team"] and not any(a.get("team") == entwurf["team"] for a in agents.values()):
        fehlt.append({"punkt": "adressaten", "text": "Team %s hat keine Agenten" % entwurf["team"]})
    tickets = {t["id"]: t for t in list_tickets(root)}
    for dep in entwurf["dependencies"]:
        abhaengigkeit = tickets.get(dep)
        if abhaengigkeit is None:
            fehlt.append({"punkt": "abhaengigkeiten", "text": "abhaengigkeit %s ist unbekannt" % dep})
        elif abhaengigkeit.get("state") != "abgenommen":
            fehlt.append({"punkt": "abhaengigkeiten",
                          "text": "abhaengigkeit %s ist %s" % (dep, abhaengigkeit.get("state"))})
    return {"bereit": not fehlt, "grund": fehlt[0]["text"] if fehlt else None,
            "fehlt": fehlt, "entwurf": entwurf}


def _ticket_blocker(root: Path, ticket: dict[str, Any], world: dict[str, Any],
                    agents: dict[str, dict[str, Any]], by_id: dict[str, dict[str, Any]],
                    running: set[str | None]) -> str | None:
    state = ticket.get("state")
    parked = ticket.get("parked") or {}
    if isinstance(parked, dict) and parked:
        if parked.get("until"):
            return "geparkt bis %s" % parked["until"]
        return "wartet auf Ticket %s" % parked.get("waiting_for")
    if state == "triage":
        return "triage"
    if state == "läuft":
        return "besetzt: Agent bearbeitet %s" % ticket["id"]
    if state not in ("offen", "zurückgegeben"):
        return {"wartet": "geparkt", "braucht dich": "wartet auf Antwort",
                "zur Abnahme": "wartet auf Abnahme", "in Prüfung": "in Prüfung",
                "abgenommen": "abgenommen", "unterbrochen": "unterbrochen",
                "verworfen": "verworfen"}.get(state, str(state))
    for dep in ticket.get("dependencies") or []:
        dependency = by_id.get(dep)
        if dependency is None:
            return "abhaengigkeit %s ist unbekannt" % dep
        if dependency.get("state") == "verworfen":
            return "abhaengigkeit %s verworfen" % dep
        if dependency.get("state") != "abgenommen":
            return "abhaengigkeit %s ist %s" % (dep, dependency.get("state"))
    if world.get("state") != "läuft":
        return "welt pausiert"
    recipients = list(ticket.get("recipients") or [])
    if ticket.get("team"):
        recipients.extend(a["id"] for a in agents.values() if a.get("team") == ticket["team"])
    active = [agents[r] for r in sorted(set(recipients)) if r in agents and agents[r].get("state") == "aktiv"]
    if not active:
        return "agent pausiert"
    free = [a for a in active if a["id"] not in running]
    if not free:
        busy = sorted(t["id"] for t in by_id.values()
                      if t.get("state") == "läuft" and t.get("assignee") in {a["id"] for a in active})
        return "agent bearbeitet %s" % (busy[0] if busy else "ein anderes Ticket")
    # Definition of Ready (Plan Satz 45): sie blockt, wenn alles andere freisteht, denn ein
    # Ticket ohne Fertig-Liste oder Grenzen wird nicht zugestellt.
    grund = _definition_of_ready_grund(_ticket_kind_feld(ticket),
                                       [item["text"] for item in _ticket_done_items(ticket)],
                                       ticket.get("limits"), ticket.get("recipients"), ticket.get("team"),
                                       ticket.get("title"), ticket.get("goal"), ticket.get("done_criterion"))
    if grund:
        return grund
    # Weiche WIP-Grenze der Welt (Plan Satz 48): laufende und geparkte Tickets der Welt zaehlen.
    limit = _wip_limit(world, agents)
    wip = sum(1 for other in by_id.values() if other.get("state") in ("läuft", "wartet"))
    if wip >= limit:
        return "wip-grenze (%d von %d laufen)" % (wip, limit)
    return None


def _wip_limit(world: dict[str, Any], agents: dict[str, dict[str, Any]]) -> int:
    """Weiche WIP-Grenze der Welt (Plan Satz 48): gesetzt oder aktive Agenten plus ein Viertel."""
    limit = world.get("wip_limit")
    if isinstance(limit, int) and not isinstance(limit, bool) and limit >= 1:
        return limit
    aktiv = sum(1 for a in agents.values() if a.get("state") == "aktiv")
    return aktiv + (aktiv + 3) // 4  # plus ein Viertel, aufgerundet


def children(root: Path, ticket_id: str) -> list[dict[str, Any]]:
    """The children of one ticket in the hierarchy (plan sentences 4 and 36)."""
    root = world_path(str(root))
    read_ticket(root, ticket_id)
    return sorted((t for t in list_tickets(root) if t.get("parent") == ticket_id),
                  key=lambda t: (str(t.get("created_at") or ""), t["id"]))


def reorder_triage(root: Path, ticket_ids: list[str], sender: str | None = None,
                   claimed_role: str | None = None) -> list[dict[str, Any]]:
    """Set the backlog order of the triage tickets (plan sentence 44); only the main
    agent or the human decides.  Named tickets come first in the given sequence, the
    unnamed triage tickets keep their relative order behind them."""
    ids: list[str] = []
    for item in ticket_ids or []:
        ids.append(valid_id(item, "Ticketkennung"))
    if len(set(ids)) != len(ids):
        raise AgentsError("Reihenfolge nennt eine Kennung doppelt")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
        triage = {t["id"]: t for t in list_tickets(root) if t.get("state") == "triage"}
        unknown = [i for i in ids if i not in triage]
        if unknown:
            raise AgentsError("Kein Triage-Ticket: %s" % ", ".join(unknown))

        def alt(item: dict[str, Any]) -> tuple[Any, str, str]:
            order = item.get("order")
            num = order if isinstance(order, int) and not isinstance(order, bool) else 10 ** 9
            return (num, str(item.get("created_at") or ""), item["id"])
        rest = sorted((t for i, t in triage.items() if i not in set(ids)), key=alt)
        for position, tid in enumerate(ids + [t["id"] for t in rest], start=1):
            ticket = triage[tid]
            if ticket.get("order") == position:
                continue
            ticket["order"] = position
            ticket["updated_at"] = now()
            _write_json(_ticket_path(root, tid) / "ticket.json", ticket)
            _ticket_event(root, ticket, "geordnet", actor, position=position)
        return [triage[tid] for tid in ids] + list(rest)


# ---------------------------------------------------------------------------
# Grenzen, Zyklus, WIP und Hierarchie-Folgen (tickets3, Plan AGENTS-TICKETS-PLAN
# Saetze 6, 29, 31, 43, 46, 48 und 51, AGENTS-TICKETS-AGIL Abschnitt 4 und 8).
# ---------------------------------------------------------------------------

def set_ticket_limits(root: Path, ticket_id: str, frist: str | None = None,
                      runden: int | None = None, sender: str | None = None,
                      claimed_role: str | None = None) -> dict[str, Any]:
    """Frist und Rundenzahl aendern (Plan Satz 31); nur der Hauptagent oder der Mensch.

    Ein Ticket, das der Träger wegen seiner Grenzen auf `braucht dich` gehoben hat,
    kehrt auf den vorherigen Stand zurück und wird dem Bearbeiter wieder zugestellt
    (Ereignis `grenzen-geaendert`).
    """
    valid_id(ticket_id, "Ticketkennung")
    if frist is None and runden is None:
        raise AgentsError("grenzen braucht --frist oder --runden")
    if frist is not None:
        try:
            _epoch_of(frist)
        except (ValueError, TypeError, OSError) as exc:
            raise AgentsError("--frist braucht eine ISO-Zeit (z. B. 2026-09-18T09:00:00Z)") from exc
    if runden is not None and (isinstance(runden, bool) or not isinstance(runden, int) or runden < 1):
        raise AgentsError("--runden braucht eine ganze Zahl ab 1")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
        ticket = read_ticket(root, ticket_id)
        limits = dict(ticket.get("limits") or {})
        if frist is not None:
            limits["frist"] = frist
        if runden is not None:
            limits["runden"] = runden
        flag = ticket.get("flag") or {}
        gehoben = isinstance(flag, dict) and flag.get("question") is None and flag.get("vorher")
        if ticket.get("limits") == limits and not gehoben:
            return ticket
        ts = now()
        ticket["limits"] = limits
        if gehoben:
            vorher = flag.get("vorher")
            ticket.pop("flag", None)
            # Ein geparktes Ticket kehrt offen zurück, seine Weckbedingung ist weg; sonst der alte Stand.
            ticket["state"] = vorher if vorher in ("offen", "zurückgegeben", "läuft") else "offen"
            ziel = [ticket["assignee"]] if ticket.get("assignee") else list(ticket.get("recipients") or [])
            delivery_id = derived_id("ticket-grenzen", ticket_id)
            ticket.update({"return_to": ziel, "return_to_delivery": delivery_id,
                           "return_delivery_id": delivery_id, "return_delivery_time": ts,
                           "delivery_sender": actor["id"]})
        ticket["updated_at"] = ts
        _write_json(_ticket_path(root, ticket_id) / "ticket.json", ticket)
        _ticket_event(root, ticket, "grenzen-geaendert", actor, frist=frist, runden=runden,
                      zurueck_auf=ticket["state"])
        if gehoben:
            _deliver_ticket(root, ticket, actor)
        return ticket


def enforce_ticket_limits(root: Path, now_epoch: float | None = None,
                          busy_ticket_ids: frozenset[str] | set[str] = frozenset()) -> list[str]:
    """Fristpruefung und Rundenzaehler (Plan Saetze 6 und 31); kehrt mit den Kennungen zurück.

    Ein Ticket, dessen Rundenzahl erreicht oder dessen Frist abgelaufen ist, wird
    `braucht dich` mit Grund, Feld `flag` ohne Frage und Merker des vorherigen
    Standes.  Gilt auch für geparkte und offene Tickets; nicht für tickets, die
    gerade laufen (deren Zug darf enden) und nicht für Triage, Abnahme oder Prüfung.
    Kein automatischer Zug danach; der Hauptagent löst es mit `set_ticket_limits`.
    """
    if now_epoch is None:
        now_epoch = time.time()
    escalated: list[str] = []
    with transaction(root):
        for ticket in list_tickets(root):
            state = ticket.get("state")
            if state not in ("offen", "zurückgegeben", "läuft", "wartet"):
                continue
            if ticket["id"] in busy_ticket_ids:
                continue
            limits = ticket.get("limits") or {}
            grund = None
            runden = limits.get("runden")
            if isinstance(runden, int) and not isinstance(runden, bool) and runden >= 1:
                zuege = sum(1 for entry in _read_jsonl(_ticket_path(root, ticket["id"]) / "verlauf.jsonl",
                                                       "Ticketverlauf") if entry.get("event") == "zug")
                if zuege >= runden:
                    grund = "Rundenzahl %d erreicht" % runden
            if grund is None:
                frist = limits.get("frist")
                if frist:
                    try:
                        abgelaufen = _epoch_of(frist) <= now_epoch
                    except (ValueError, TypeError, OSError):
                        abgelaufen = False
                    if abgelaufen:
                        grund = "Frist %s abgelaufen" % frist
            if grund is None:
                continue
            ts = now()
            ticket.pop("parked", None)
            ticket.update({"state": "braucht dich", "updated_at": ts,
                           "flag": {"question": None, "reason": grund, "by": "system", "at": ts,
                                    "vorher": state}})
            _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
            _ticket_event(root, ticket, "braucht-dich", {"id": "traeger", "verified": False},
                          grund=grund, vorher=state, frage=None)
            escalated.append(ticket["id"])
    return escalated


def _zyklen_lesen(root: Path) -> list[dict[str, Any]]:
    path = root / ZYKLEN_DATEI
    if path.is_symlink() or not path.exists():
        return []
    return _read_jsonl(path, "Zyklendatei")


def set_cycle(root: Path, enabled: bool, tage: int | None = None, ziel: str | None = None,
              sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """Zyklus der Welt einschalten oder ausschalten (Plan Satz 46); nur der Hauptagent
    oder der Mensch.  Vorgabe ist eine Woche; das Ziel steht je Zyklus."""
    if not isinstance(enabled, bool):
        raise AgentsError("einschalten oder ausschalten")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
        world = read_world(root)
        cycles = dict(world.get("cycles") or {})
        if not enabled:
            if not cycles.get("enabled"):
                return world
            # Der letzte Zyklus bleibt sichtbar (Nummerierung geht weiter), eingeschaltet ist aus.
            cycles["enabled"] = False
            world["cycles"] = cycles
            _write_json(world_file(root), world)
            _world_event(root, "zyklus-ausgeschaltet", actor, zyklus=(cycles.get("current") or {}).get("id"))
            return world
        if tage is not None and (isinstance(tage, bool) or not isinstance(tage, int) or tage < 1):
            raise AgentsError("--tage braucht eine ganze Zahl ab 1")
        laenge = tage or int(cycles.get("length_days") or CYCLE_DEFAULT_DAYS)
        belegt = {str(entry.get("id")) for entry in _zyklen_lesen(root)}
        if isinstance(cycles.get("current"), dict) and cycles["current"].get("id"):
            belegt.add(str(cycles["current"]["id"]))
        nummer = 1
        while "zyklus-%d" % nummer in belegt:
            nummer += 1
        start = now()
        ende = _dt.datetime.fromtimestamp(_epoch_of(start) + laenge * 86400, _dt.timezone.utc) \
            .isoformat().replace("+00:00", "Z")
        cycles.update({"enabled": True, "length_days": laenge,
                       "current": {"id": "zyklus-%d" % nummer, "start": start, "end": ende, "goal": ziel}})
        world["cycles"] = cycles
        _write_json(world_file(root), world)
        _world_event(root, "zyklus-eingeschaltet", actor, zyklus=cycles["current"]["id"],
                     tage=laenge, ziel=ziel)
        return world


def read_cycle(root: Path) -> dict[str, Any]:
    """Zyklusstand der Welt zum Zeigen (Plan Satz 46)."""
    world = read_world(world_path(str(root)))
    zyklen = _zyklen_alle(root)
    return {"enabled": bool((world.get("cycles") or {}).get("enabled")),
            "current": (world.get("cycles") or {}).get("current"),
            "length_days": (world.get("cycles") or {}).get("length_days") or CYCLE_DEFAULT_DAYS,
            "abgeschlossen": zyklen}


def set_wip_limit(root: Path, limit: int | None = None, sender: str | None = None,
                  claimed_role: str | None = None) -> dict[str, Any]:
    """Weiche WIP-Grenze der Welt setzen oder leeren (Plan Satz 48); nur der Hauptagent
    oder der Mensch.  Ohne Grenze gilt: aktive Agenten plus ein Viertel, aufgerundet."""
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
        world = read_world(root)
        if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 1):
            raise AgentsError("--limit braucht eine ganze Zahl ab 1")
        vorher = world.get("wip_limit")
        if limit is None:
            world.pop("wip_limit", None)
        else:
            world["wip_limit"] = limit
        if vorher == world.get("wip_limit"):
            return world
        _write_json(world_file(root), world)
        _world_event(root, "wip-grenze-gesetzt", actor, limit=world.get("wip_limit"))
        return world


def _zyklen_alle(root: Path) -> list[dict[str, Any]]:
    try:
        return _zyklen_lesen(root)
    except (AgentsError, OSError, ValueError):
        return []


def cycle_schluss(root: Path, now_epoch: float | None = None) -> dict[str, Any] | None:
    """Zyklusschluss (Plan Satz 46): liegt `now` hinter dem Zyklusende, werden alle nicht
    abgenommenen Tickets des Zyklus in den neuen übertragen (Ereignis `uebertragen`,
    Zähler `carried_over`), der alte Zyklus in `zyklen.jsonl` mit Zahlen abgeschlossen,
    und der Hauptagent bekommt eine Zustellung `zyklus-schluss` mit den Zahlen und der
    Anweisung, einen Retro-Eintrag ins Gedächtnis zu schreiben.  Welten ohne Zyklus
    bleiben unverändert; kein Ticket wird still geschlossen."""
    if now_epoch is None:
        now_epoch = time.time()
    with transaction(root):
        world = read_world(root)
        cycles = world.get("cycles") or {}
        if not cycles.get("enabled"):
            return None
        current = cycles.get("current") or {}
        try:
            ende = _epoch_of(current.get("end"))
        except (ValueError, TypeError, OSError):
            return None
        if now_epoch <= ende:
            return None
        alter = current.get("id")
        tickets = list_tickets(root)
        im_zyklus = [t for t in tickets if t.get("cycle") == alter]
        fertig = [t for t in im_zyklus if t.get("state") == "abgenommen"]
        verworfen = [t for t in im_zyklus if t.get("state") == "verworfen"]
        uebertrag = [t for t in im_zyklus if t.get("state") not in ("abgenommen", "verworfen")]
        laenge = int(cycles.get("length_days") or CYCLE_DEFAULT_DAYS)
        belegt = {str(entry.get("id")) for entry in _zyklen_lesen(root)}
        if alter:
            belegt.add(str(alter))
        nummer = 1
        while "zyklus-%d" % nummer in belegt:
            nummer += 1
        ts = now()
        start = _dt.datetime.fromtimestamp(now_epoch, _dt.timezone.utc).isoformat().replace("+00:00", "Z")
        ende_neu = _dt.datetime.fromtimestamp(now_epoch + laenge * 86400, _dt.timezone.utc) \
            .isoformat().replace("+00:00", "Z")
        neu = {"id": "zyklus-%d" % nummer, "start": start, "end": ende_neu, "goal": None}
        system = {"id": "system", "verified": False}
        kennungen: list[str] = []
        for ticket in sorted(uebertrag, key=lambda t: t["id"]):
            ticket["cycle"] = neu["id"]
            ticket["updated_at"] = ts
            _write_json(_ticket_path(root, ticket["id"]) / "ticket.json", ticket)
            _ticket_event(root, ticket, "uebertragen", system, von=alter, zu=neu["id"])
            kennungen.append(ticket["id"])
        eintrag = {"id": alter, "start": current.get("start"), "ende": current.get("end"),
                   "ziel": current.get("goal"), "abgeschlossen_at": ts,
                   "angelegt": len(im_zyklus), "abgenommen": len(fertig),
                   "uebertragen": len(uebertrag), "verworfen": len(verworfen),
                   "carried_over": len(uebertrag)}
        abgeschlossen = _zyklen_lesen(root)
        if not abgeschlossen or abgeschlossen[-1].get("id") != alter:
            _append_jsonl(root / ZYKLEN_DATEI, eintrag)
        cycles["current"] = neu
        world["cycles"] = cycles
        _write_json(world_file(root), world)
        _world_event(root, "zyklus-abgeschlossen", system, zyklus=alter, uebertragen=len(uebertrag),
                     abgenommen=len(fertig), verworfen=len(verworfen))
        haupt = world.get("hauptagent")
        text = ("Zyklus %s ist abgeschlossen: %d Tickets angelegt, %d abgenommen, %d übertragen, "
                "%d verworfen. Übertragen: %s. Schreibe einen Retro-Eintrag ins Gedächtnis "
                "(Lernschritt: was hängen blieb, was sich ändert)." % (
                    alter, len(im_zyklus), len(fertig), len(uebertrag), len(verworfen),
                    ", ".join(kennungen) or "keine"))
        if haupt and isinstance(haupt, str) and ID_RE.fullmatch(haupt):
            delivery_id = derived_id("zyklus-schluss", alter)
            try:
                ordner = _agent_dir(root, haupt) / "postfach"
                ordner.mkdir(parents=True, exist_ok=True)
                ziel = ordner / (delivery_id + ".json")
                if not ziel.exists():
                    _write_json(ziel, {"delivery_id": delivery_id, "kind": "zyklus-schluss",
                                       "ticket_id": None, "time": ts, "sender": "system",
                                       "text": text, "recipient": haupt, "acknowledged": False})
            except OSError:
                pass
        return {"zyklus": alter, "neu": neu["id"], "uebertragen": kennungen,
                "zahlen": {key: eintrag[key] for key in ("angelegt", "abgenommen", "uebertragen",
                                                         "verworfen", "carried_over")},
                "zustellung": delivery_id if haupt else None}


def _eltern_kinder_fertig(root: Path, kind_ticket: dict[str, Any], actor: dict[str, Any]) -> None:
    """Eltern auf `zur Abnahme`, sobald das letzte Kind abgenommen ist (Plan Saetze 29 und 51).

    Verworfene Kinder zählen nicht als offen; ein Eltern mit nur verworfenen Kindern geht
    nicht automatisch weiter.  Idempotent: ein Eltern auf `zur Abnahme` oder `abgenommen`
    bleibt, wie es ist."""
    eltern_id = kind_ticket.get("parent")
    if not eltern_id:
        return
    try:
        eltern = read_ticket(root, eltern_id)
    except AgentsError:
        return
    if eltern.get("state") not in ("offen", "zurückgegeben", "triage"):
        return
    kinder = [t for t in list_tickets(root) if t.get("parent") == eltern_id]
    offen = [t for t in kinder if t.get("state") != "verworfen"]
    if not offen or any(t.get("state") != "abgenommen" for t in offen):
        return
    ts = now()
    kennungen = ", ".join(sorted(t["id"] for t in offen))
    delivery_id = derived_id("ticket-kinder", eltern_id)
    eltern.update({"state": "zur Abnahme", "updated_at": ts,
                   "result": {"schema_version": SCHEMA_VERSION, "ticket": eltern_id, "agent": "system",
                              "text": "Alle Kinder abgenommen: %s" % kennungen, "commit": None,
                              "written_at": ts, "sender_verified": False},
                   "return_delivery_id": delivery_id, "return_delivery_time": ts,
                   "delivery_sender": "system"})
    _write_json(_ticket_path(root, eltern_id) / "ticket.json", eltern)
    _write_json(_ticket_path(root, eltern_id) / "ergebnis.json", eltern["result"])
    _ticket_event(root, eltern, "kinder-fertig", {"id": "system", "verified": False},
                  kinder=sorted(t["id"] for t in offen), durch=kind_ticket["id"])
    _deliver_ticket(root, eltern, {"id": "system", "verified": False})


def _melde_vorhaben(root: Path, ticket: dict[str, Any]) -> None:
    """Ein abgenommenes Vorhaben meldet dem Menschen der Welt ein markiertes Ergebnis
    (Plan Satz 51, wie Ergebnisse von Menschen-Tickets)."""
    if _ticket_kind_feld(ticket) != "vorhaben":
        return
    approval = ticket.get("approval") or {}
    result = ticket.get("result") or {}
    bemerkung = ", Bemerkung %s" % approval["note"] if approval.get("note") else ""
    text = "Vorhaben %s „%s“ abgenommen%s: %s" % (ticket["id"], ticket.get("title") or "",
                                                  bemerkung, result.get("text") or "(kein Ergebnistext)")
    message_id = derived_id("vorhaben-ergebnis", ticket["id"], int(ticket.get("result_revision") or 0))
    if _channel_has_message(root, message_id):
        return
    _deliver_message(root, approval.get("agent") or "system", WORLD_HUMAN, "ticket-ergebnis",
                     "Ergebnis zu %s" % ticket["id"], ticket["id"], text, message_id,
                     [WORLD_HUMAN], "ergebnis")


# ---------------------------------------------------------------------------
# Definition of Done der Welt (tickets2, AGENTS-TICKETS-AGIL Abschnitt 6, Satz 49).
# Setzen und Aendern nur durch den Menschen oder den Hauptagenten; jedes Mal ein
# Ereignis im Weltverlauf. Die DoD ist Text und Pruefauftrag fuer den Abnehmenden:
# sie kann keine Hausregel absenken (docs/AGENTS-DATEN.md).
# ---------------------------------------------------------------------------

WORLD_VERLAUF = "verlauf.jsonl"


def _world_event(root: Path, event: str, actor: dict[str, Any], **extra: Any) -> None:
    data = {"id": new_id("ev"), "time": now(), "event": event, "actor": actor}
    data.update(extra)
    _append_jsonl(root / WORLD_VERLAUF, data)


def read_world_history(root: Path) -> list[dict[str, Any]]:
    """The world's own event log (DoD changes); empty without one."""
    return _read_jsonl(world_path(str(root)) / WORLD_VERLAUF, "Weltverlauf")


def _world_dod(world: dict[str, Any]) -> list[str]:
    value = world.get("definition_of_done")
    return [item for item in value if isinstance(item, str) and item.strip()] if isinstance(value, list) else []


def set_definition_of_done(root: Path, punkte: Any, sender: str | None = None,
                           claimed_role: str | None = None) -> dict[str, Any]:
    """Replace the world's Definition of Done (list of texts); empty removes it.

    Only the human (external actor) or the world's main agent writes it.  An
    unchanged list returns the world without an event.
    """
    if punkte is None:
        punkte = []
    if isinstance(punkte, str):
        punkte = [punkte]
    if not isinstance(punkte, list) or any(not isinstance(item, str) or not item.strip() for item in punkte):
        raise AgentsError("Definition of Done muss eine Liste nichtleerer Texte sein")
    punkte = list(dict.fromkeys(item.strip() for item in punkte))
    with transaction(root):
        actor = _require_governance_actor(root, sender or WORLD_HUMAN, claimed_role, ("hauptagent",))
        world = read_world(root)
        if _world_dod(world) == punkte:
            return world
        world["definition_of_done"] = punkte
        world["updated_at"] = now()
        _write_json(world_file(root), world)
        _world_event(root, "dod-gesetzt", actor, punkte=punkte)
        return world


# ---------------------------------------------------------------------------
# Zugende des Traegers (tickets2, Plan Satz 16): ein Ticket-Zug endet mit einem
# Bericht.  Die Pruefung liest nur den Verlauf; der Traeger ergaenzt fehlende
# Berichte als Träger-Zwischenstand.
# ---------------------------------------------------------------------------

TURN_REPORT_EVENTS = ("zwischenstand", "ergebnis", "pruefnotiz")


def ticket_turn_reported(root: Path, ticket_id: str, previous_entries: int,
                         agent_id: str | None = None) -> bool:
    """True, wenn nach `previous_entries` (Verlaufseintraege beim Zugbeginn) ein Bericht oder ein
    Uebergang des Bearbeiters im Verlauf steht.  Der Index statt der Zeit: Verlaufszeiten sind auf
    Sekunden abgeschnitten, ein Zug kann innerhalb derselben Sekunde enden."""
    try:
        assignee = read_ticket(root, ticket_id).get("assignee")
        entries = _read_jsonl(_ticket_path(root, ticket_id) / "verlauf.jsonl", "Ticketverlauf")
    except AgentsError:
        return True  # ein weggeräumtes Ticket braucht keinen Bericht
    for entry in entries[max(0, previous_entries):]:
        if entry.get("event") in TURN_REPORT_EVENTS:
            return True
        if entry.get("event") in ASSIGNEE_TRANSITIONS and (entry.get("actor") or {}).get("id") == \
                (agent_id or assignee):
            return True
    return False


def carrier_turn_note(root: Path, ticket_id: str, run_id: str, outcome: str) -> dict[str, Any]:
    """The carrier's own progress note for a ticket turn that reported nothing (plan sentence 16)."""
    with transaction(root):
        ticket = read_ticket(root, ticket_id)
        if not _ticket_event_exists(root, ticket_id, "zwischenstand", zug=run_id):
            _ticket_event(root, ticket, "zwischenstand", {"id": "traeger", "verified": False, "source": "controller"},
                          text="Zug ohne Bericht (Träger)", zug=run_id, ausgang=outcome)
        return read_ticket(root, ticket_id)


# ---------------------------------------------------------------------------
# Write paths of the human (Auftrag agentsui Nr. 2): hand back an approved
# ticket, maintain profile and memory, keep the shared read state.  Each of
# them accepts only an external actor; the stored sender stays unverified.
# ---------------------------------------------------------------------------

def _require_human(root: Path, sender: str | None, claimed_role: str | None, what: str) -> dict[str, Any]:
    actor = _actor(root, sender or WORLD_HUMAN, claimed_role)
    if actor.get("id") in ORCHESTRATOR_ACTORS:
        raise AgentsError("Governance-Mutation fuer '%s' ist ueber die CLI gesperrt; "
                          "nur run-gebundener Controller oder gemessener Mensch" % actor["id"])
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
        _ticket_event(root, ticket, "zurueckgegeben", actor, note=note, by="mensch", to=target,
                      result_revision=int(ticket.get("result_revision") or 0))
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
# The tools the carrier's runner accepts (agents_claude_runner.ALLOWED_TOOLS).  WebFetch and
# WebSearch are opt-in per agent (research agents need them, 2026-09-15); the turn gets the
# host network only through the world's accesses (agents_zugaenge), never by the tool alone.
AGENT_TOOLS = ("Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch")
WEB_TOOLS = ("WebFetch", "WebSearch")
FIGURE_FAMILIES = ("roboter", "tier", "linse")
FIGURE_COLORS = ("entwicklung", "recherche", "pruefung", "gestaltung")
SPECIALTY_LIMIT = 300
CONTEXT_LIMIT_LIMIT = 600
INSTRUCTIONS_LIMIT = 64 * 1024
LIBRARY_DIR = Path(__file__).resolve().parent.parent / "agents" / "bibliothek"
AGENT_REQUEST_KIND = "agent-antrag"
# Defaults for a profile created without tools (`create_world`, `create_agent`): the
# profile lock refuses every tool that is not listed, so an empty list stops a turn
# before its first step.  Every stage writes (2026-09-15: members draft documents, not only
# reports); web tools stay opt-in.
DEFAULT_TOOLS = {"hauptagent": ("Bash", "Read", "Grep", "Glob", "Write", "Edit"),
                 "teamleiter": ("Bash", "Read", "Grep", "Glob", "Write", "Edit"),
                 "mitglied": ("Bash", "Read", "Grep", "Glob", "Write", "Edit")}
# The Bash patterns a turn needs in any case: the controller RPC client in the turn
# directory, stored scripts (`agents/bibliothek/skripte`), skill scripts and reading git.
# An interpreter pattern without a narrower argument (`python3 *`) grants nothing.
# Since 2026-09-16 every agent works in its own worktree on branch `agent/<id>` (plan
# section 8 item 9): add, commit, rebase and restoring files there.  `git merge agent/*`
# is in the list for every stage because the list is not per stage; the profile lock
# lets only team leads (branches of their own team's members) and the main agent merge.
# No `git push`: it is on the house list, which every draft is checked against.
DEFAULT_BASH = ("python3 */rpc/agents_rpc_client.py *",
                "python3 */skripte/*/*.py *", "sh */skripte/*/*.sh *", "*/skripte/*/*.py *",
                "python3 */skills/*/scripts/*.py *", "*/skills/*/scripts/*.py *",
                "git status", "git diff *", "git log *", "git show *",
                "git add *", "git commit *", "git rebase *", "git checkout -- *",
                "git merge agent/*", "git merge --abort",
                # 16.09.2026, erster Zug im Worktree: Myproject konnte kein Verzeichnis auflisten, nur Glob/Grep.
                "ls", "ls *", "pwd")
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


def _name_list(value: Any, label: str) -> list[str]:
    """Tools or skills as a list; a model's draft may also write one text ("Read, Grep")."""
    if isinstance(value, str):
        value = [item for item in re.split(r"[,\s]+", value) if item]
        if not value:
            raise AgentsError("%s muss eine Liste nichtleerer Texte sein" % label)
    return _text_list(value, label)


def _tool_names(value: Any) -> list[str]:
    """Tool names in the spelling of AGENT_TOOLS (`read` -> `Read`); unknown names stay for the error."""
    spelling = {tool.lower(): tool for tool in AGENT_TOOLS}
    return list(dict.fromkeys(spelling.get(item.lower(), item) for item in _name_list(value, "Werkzeuge")))


def validate_agent_draft(draft: dict[str, Any], for_agent: bool = False,
                         machine_default: str = "lokal") -> dict[str, Any]:
    """Check a creation draft without touching a world; return it normalized.

    `for_agent` applies the stricter rules for drafts an agent writes: no stage
    above team leader.  `machine_default` is the machine of a draft without one
    (the carrier host of the world, see `world_machine_default`).
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
    if agent_id in RESERVED_ACTORS:
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
    machine = draft.get("machine") or machine_default
    if not isinstance(machine, str):
        raise AgentsError("Maschine muss ein Text sein")
    valid_id(machine, "Maschine")
    # A draft without tools gets those of its stage, exactly like `create_agent` (the example draft in the
    # main agent's instructions names none); an explicitly empty list stays an error.
    tools = _tool_names(draft["tools"]) if draft.get("tools") is not None else list(DEFAULT_TOOLS[stage])
    if not tools:
        raise AgentsError("Ein Agent braucht mindestens ein Werkzeug")
    foreign = [tool for tool in tools if tool not in AGENT_TOOLS]
    if foreign:
        raise AgentsError("Werkzeug nicht erlaubt: %s (erlaubt: %s)" % (", ".join(foreign), ", ".join(AGENT_TOOLS)))
    bash = _text_list(draft.get("bash"), "Bash-Muster")
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
    skills = _name_list(draft.get("skills"), "Skills")
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


def _limits_lines(draft: dict[str, Any], zugaenge: Iterable[str] = ()) -> list[str]:
    tools = ", ".join(t for t in draft["tools"] if t != "Bash")
    lines = ["- Werkzeuge: %s." % (tools or "keine außer Bash")]
    if draft["bash"]:
        lines.append("- Bash nur mit diesen Mustern: %s." % ", ".join("`%s`" % b for b in draft["bash"]))
    lines.append("- Skills: %s." % (", ".join(draft["skills"]) if draft["skills"] else "keine vorgeladenen"))
    if draft.get("context_limit"):
        lines.append("- Was du nicht erfährst und nicht erfragst: %s" % draft["context_limit"])
    # Zugaenge der Welt (zugaenge.json) sind die einzige Tuer nach draussen; die Anweisung nennt nur Name und Aufruf.
    zugaenge = list(zugaenge)
    if zugaenge:
        lines.append("- Zugänge: %s." % ", ".join("%s (ssh) – `ssh %s <befehl>`" % (name, name) for name in zugaenge))
    lines += ["- Kein Eingriff außerhalb der Welt%s. Freigaben, Regeln und Profile erweiterst du nicht." % (
                  " außer über die Zugänge" if zugaenge else ""),
              "- Deploy, Veröffentlichung, E-Mail und Ausgaben nur mit bestehender Freigabe in `freigaben.json` "
              "der Welt (Mail: Abschnitt „Mail senden“; der Hauptagent sieht sie mit `freigabe.liste`).",
              "- Die Regeln für Agenten stehen in `regeln/agenten.md`."]
    return lines


def _with_profile_limits(text: str, draft: dict[str, Any], zugaenge: Iterable[str] = ()) -> str:
    """An own instruction file (menu, model proposal) ends with the limits of the profile, rewritten each time."""
    head = text.split(INSTRUCTIONS_LIMITS_MARK)[0].rstrip()
    return "%s\n\n%s\n## Verbindliche Grenzen aus dem Profil\n\n%s\n" % (
        head, INSTRUCTIONS_LIMITS_MARK, "\n".join(_limits_lines(draft, zugaenge)))


def world_access_names(root: Path) -> list[str]:
    """Names of the world's accesses (zugaenge.json) for instructions; an unreadable file names none."""
    return [item["name"] for item in _snapshot_zugaenge(root)]


def _snapshot_zugaenge(root: Path) -> list[dict[str, str]]:
    """Name and kind of each access in zugaenge.json -- never target or key path."""
    path = root / "zugaenge.json"
    if path.is_symlink():
        raise AgentsError("zugaenge.json darf kein Symlink sein")
    if not path.exists():
        return []
    data = _read_json(path)
    if not isinstance(data, dict) or not isinstance(data.get("zugaenge"), list):
        raise AgentsError("zugaenge.json hat eine unbekannte Form")
    return [{"name": str(item.get("name")), "art": str(item.get("art") or "ssh")}
            for item in data["zugaenge"] if isinstance(item, dict) and isinstance(item.get("name"), str)]


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
             "- Dein Gedächtnis ist `MEMORY.md` in deinem Agentenordner. Du pflegst es selbst.",
             "- Ins Gedächtnis nur das Wichtigste (höchstens 2.000 Zeichen, 15 Zeilen); Ausführliches und Hergang als "
             "Notiz ins Brain, vor der Arbeit `brain search`.", "",
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
                  "- Den Menschen fragst du nur in den Fällen aus `regeln/agenten.md`; alles andere entscheidest du und schreibst es ins Ticket.",
                  "- Mail-Freigaben, die du hältst, gibst du mit `freigabe.weitergeben` an einzelne Agenten weiter, nie weiter als deine eigene; zurück nimmst du sie mit `freigabe.entziehen`."]
    # The limits close the file behind the mark, exactly as for an own instruction file.
    try:
        zugaenge = world_access_names(root)
    except AgentsError:
        zugaenge = []
    return _with_profile_limits("\n".join(line.rstrip() for line in lines), draft, zugaenge)


CARRIER_CONFIG = "traeger.json"


def world_carrier_config(root: Path) -> dict[str, Any] | None:
    """The world's carrier configuration (`traeger.json`) as plain JSON, or None without one.

    Read without importing the carrier: the view and the RPC copy of this module need only
    `execution_host`, `modelle`, `pi`, `codex` and `registry`."""
    path = Path(root) / CARRIER_CONFIG
    if path.is_symlink() or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def world_machine_default(root: Path) -> str:
    """Machine of a new agent without one: the carrier host of the world (`execution_host`), else `lokal`.

    der Nutzer, 16.09.2026: agents of the world myproject run on peer; the world's carrier decides that."""
    host = (world_carrier_config(root) or {}).get("execution_host")
    return host if isinstance(host, str) and ID_RE.match(host) else "lokal"


def preview_agent_draft(root: Path, draft: dict[str, Any]) -> dict[str, Any]:
    """Normalized draft plus the instruction file it would get; writes nothing."""
    normalized = validate_agent_draft(draft, machine_default=world_machine_default(world_path(str(root))))
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
    actor = _creation_actor(root, sender, claimed_role)
    # The two CLI-surface identities have no governance authority, but creation
    # is their deliberately retained capability (the empty-world menu needs to
    # create its first main agent).  Only stored agents get the stricter draft
    # ceiling that prevents them from creating a new main-agent principal.
    normalized = validate_agent_draft(
        draft,
        for_agent=actor.get("kind") == "agent" and actor.get("id") not in ORCHESTRATOR_ACTORS,
        machine_default=world_machine_default(root))
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
            "created_by": _actor_provenance(actor),
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
        actor = _require_governance_actor(root, sender, claimed_role, ("teamleiter",))
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
        actor = _require_governance_actor(root, sender, claimed_role, ("hauptagent",))
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


RIGHTS_FIELDS = ("tools", "bash", "skills", "web")
# Programs that reach another machine only through an ssh access of the world (agents_zugaenge), and
# programs that reach the network only through an access of kind `web`.
SSH_PROGRAMS = ("ssh", "scp", "rsync")
WEB_PROGRAMS = ("curl", "wget")


def _check_rights_against_accesses(root: Path, tools: list[str], extra_bash: list[str]) -> None:
    """No right beyond the world's accesses: web tools need an access of kind web, ssh patterns an ssh access."""
    accesses = _snapshot_zugaenge(root)
    kinds = {item["art"] for item in accesses}
    web = [tool for tool in tools if tool in WEB_TOOLS]
    if web and "web" not in kinds:
        raise AgentsError("%s braucht einen Zugang der Art web in der Welt; die Welt hat keinen "
                          "(wb-welt zugang … --art web richtet der Mensch ein)" % " und ".join(web))
    ssh_names = [item["name"] for item in accesses if item["art"] == "ssh"]
    for pattern in extra_bash:
        program = pattern.split(" ", 1)[0]
        if program in WEB_PROGRAMS and "web" not in kinds:
            raise AgentsError("Muster '%s' braucht einen Zugang der Art web in der Welt" % pattern)
        if program not in SSH_PROGRAMS:
            continue
        if not ssh_names:
            raise AgentsError("Muster '%s' braucht einen ssh-Zugang der Welt; die Welt hat keinen" % pattern)
        import agents_zugaenge
        for name in ssh_names:
            try:
                agents_zugaenge.muster_pruefen(name, [pattern])
                break
            except agents_zugaenge.ZugangFehler:
                continue
        else:
            raise AgentsError("Muster '%s' nennt keinen eingerichteten ssh-Zugang der Welt (%s)" % (
                pattern, ", ".join(ssh_names)))


def _check_rights_fields(changes: Any) -> None:
    """The shape of a rights change before any world is read: known fields, `web` a boolean."""
    if not isinstance(changes, dict) or not changes:
        raise AgentsError("Keine Rechteaenderung angegeben")
    unknown = sorted(set(changes) - set(RIGHTS_FIELDS))
    if unknown:
        raise AgentsError("Rechtefeld unbekannt: %s (erlaubt: %s)" % (", ".join(unknown), ", ".join(RIGHTS_FIELDS)))
    if "web" in changes and not isinstance(changes["web"], bool):
        raise AgentsError("web muss true oder false sein")


def _plan_rights(root: Path, agent: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    """The rights an agent would have after `changes`, checked but not written.

    Tool names, the house list of blocked programs, skill names and the world's accesses are
    checked here; `set_agent_rights` writes the result and `request_rights` only uses it as a dry run.
    `diff` is empty when the change has no effect.
    """
    old_tools = list(agent.get("tools") or [])
    old_bash = list(agent.get("bash") or [])
    old_skills = list(agent.get("skills") or [])
    tools = _tool_names(changes["tools"]) if "tools" in changes else list(old_tools)
    if changes.get("web") is True:
        tools += [tool for tool in WEB_TOOLS if tool not in tools]
    elif changes.get("web") is False:
        tools = [tool for tool in tools if tool not in WEB_TOOLS]
    foreign = [tool for tool in tools if tool not in AGENT_TOOLS]
    if foreign:
        raise AgentsError("Werkzeug nicht erlaubt: %s (erlaubt: %s)" % (", ".join(foreign), ", ".join(AGENT_TOOLS)))
    if "Bash" not in tools:
        tools.append("Bash")  # the service path (see validate_agent_draft)
    defaults = list(DEFAULT_BASH)
    if "bash" in changes:
        extra = [pattern for pattern in (" ".join(item.split()) for item in _text_list(changes["bash"], "Bash-Muster"))
                 if pattern not in defaults]
    else:
        extra = [pattern for pattern in old_bash if pattern not in defaults]
    bash = list(dict.fromkeys(extra + defaults))
    module, blocked = _house_rules()
    for entry in tools + bash:
        if module.nicht_lateinischer_name(entry):
            raise AgentsError("Eintrag '%s' beginnt mit einem nicht lateinischen Zeichen" % entry)
        reason = module.gesperrt_verstoss(entry, blocked)
        if reason:
            raise AgentsError("Eintrag '%s' ist gesperrt: %s" % (entry, reason))
    skills = _name_list(changes["skills"], "Skills") if "skills" in changes else list(old_skills)
    for skill in skills:
        if not re.match(r"^[a-z0-9][a-z0-9:._-]{0,79}$", skill):
            raise AgentsError("Skillname ungueltig: %s" % skill)
    # Only what the change adds must fit the accesses: an older profile is not rejected for rights it has.
    added_tools = [tool for tool in tools if tool not in old_tools]
    added_bash = [pattern for pattern in extra if pattern not in old_bash]
    _check_rights_against_accesses(root, added_tools, added_bash)
    diff: dict[str, list[Any]] = {}
    for key, old, new in (("tools", old_tools, tools), ("bash", old_bash, bash), ("skills", old_skills, skills)):
        if old != new:
            diff[key] = [old, new]
    return {"tools": tools, "bash": bash, "skills": skills, "diff": diff}


def set_agent_rights(root: Path, agent_id: str, changes: dict[str, Any], sender: str | None = None,
                     claimed_role: str | None = None, antrag: str | None = None) -> dict[str, Any]:
    """Set tools, Bash patterns, skills or web access of an agent (der Nutzer, 16.09.2026).

    Allowed for the human and for the world's main agent on every other agent of the world; team
    leaders and members ask the main agent.  `tools` replaces the tool list (Bash always stays),
    `bash` replaces the own patterns on top of `DEFAULT_BASH`, `skills` replaces the skill list,
    `web` true or false adds or removes WebFetch and WebSearch.  Nothing goes beyond the world's
    accesses.  A running turn keeps its rights; the next turn reads agent.json anew.
    `antrag` names the message in which the agent asked for the change; it must exist in the world and
    come from that agent, and the history entry then names it.  A rights request (`kind: rechte-antrag`)
    is not accepted here: it is granted only through `decide_rights_request`, which applies its stored changes.
    """
    root = world_path(str(root))
    _check_rights_fields(changes)
    with transaction(root):
        actor = _require_governance_actor(root, sender or WORLD_HUMAN, claimed_role, ("hauptagent",))
        return _apply_rights_locked(root, actor, agent_id, changes, antrag)


def _apply_rights_locked(root: Path, actor: dict[str, Any], agent_id: str, changes: dict[str, Any],
                         antrag: str | None, rights_request: str | None = None) -> dict[str, Any]:
    """The body of `set_agent_rights` for a checked actor; the caller holds `transaction(root)`.

    `transaction` is a flock on a newly opened file and not reentrant, so nothing in here opens one.
    `antrag` is checked as a message of the agent; `rights_request` is a rights request the caller
    (`decide_rights_request`) has already checked under the same lock.
    """
    if actor.get("kind") == "agent":
        if actor.get("role") != "hauptagent":
            raise AgentsError("Rechte vergibt der Hauptagent; %s beantragt sie bei ihm" % _STAGE_WORDS.get(
                actor.get("role"), actor.get("role")))
        if actor["id"] == agent_id:
            raise AgentsError("Der Hauptagent aendert seine eigenen Rechte nicht; das tut der Mensch")
    agent = read_agent(root, agent_id)
    if antrag is not None:
        antrag = _rights_request(root, antrag, agent_id)
    antrag = rights_request or antrag
    plan = _plan_rights(root, agent, changes)
    tools, bash, skills, diff = plan["tools"], plan["bash"], plan["skills"], plan["diff"]
    if not diff:
        # Ohne Wirkung wird der Versuch vermerkt, aber kein Antrag: ein mitgegebener antrag ist geprueft, nicht gebucht.
        _append_history(root, agent_id, {
            "id": new_id("h"), "time": now(), "event": "rechte", "actor": actor, "changes": {}, "ohne_wirkung": True,
            "note": "Rechte unverändert; nichts geändert",
        })
        return agent
    ts = now()
    agent.update({"tools": tools, "bash": bash, "skills": skills, "rights_updated_at": ts,
                  "rights_revision": int(agent.get("rights_revision") or 0) + 1})
    path = _agent_dir(root, agent_id)
    _write_json(path / "agent.json", agent)
    # The instruction file ends with the limits of the profile; rewrite that block so both agree.
    instructions = path / "AGENTS.md"
    if instructions.is_file() and not instructions.is_symlink():
        limits = {"tools": tools, "bash": bash, "skills": skills, "context_limit": agent.get("context_limit") or ""}
        try:
            accesses = world_access_names(root)
        except AgentsError:
            accesses = []
        _write_text(instructions, _with_profile_limits(instructions.read_text(encoding="utf-8"), limits, accesses))
    entry = {
        "id": new_id("h"), "time": ts, "event": "rechte", "actor": actor, "changes": diff,
        "note": "Rechte gelten ab dem nächsten Zug; ein laufender Zug behält seine",
    }
    if antrag is not None:
        entry["antrag"] = antrag
    _append_history(root, agent_id, entry)
    return agent


def _rights_request(root: Path, message_id: str, agent_id: str) -> str:
    """Check that a rights request is a message of the world by the agent whose rights change.

    A rights request (`kind: rechte-antrag`) is refused: only `decide_rights_request` books one, with
    exactly its stored changes and only while it is open (review F2, 14.10.2026).
    """
    message_id = valid_id(message_id, "Antragskennung")
    question_path = _question_dir(root, message_id) / "question.json"
    if question_path.is_file() and not question_path.is_symlink():
        question = read_question(root, message_id)
        if question.get("kind") == RIGHTS_REQUEST_KIND:
            raise AgentsError("%s ist ein Rechteantrag; er wird nur mit rechte-antrag-entscheiden freigegeben"
                              % message_id)
    messages = read_messages(root) + [
        message
        for chat in sorted((root / "direktchats").glob("*")) if chat.is_dir() and not chat.is_symlink()
        for message in read_messages(root, direct_chat=chat.name)
    ]
    message = next((item for item in messages if item.get("id") == message_id), None)
    if message is None:
        raise AgentsError("Antrag %s ist in dieser Welt nicht vorhanden" % message_id)
    if message.get("sender") != agent_id:
        raise AgentsError("Antrag %s stammt nicht von %s, sondern von %s" % (message_id, agent_id, message.get("sender")))
    return message_id


RIGHTS_REQUEST_KIND = "rechte-antrag"
# An open rights request nobody decided runs out after this many days (contract 13.10.2026): it stays
# `offen` in its file, is no longer decidable and the carrier no longer delivers it.
RIGHTS_REQUEST_DAYS = 7
RIGHTS_REQUEST_REASON_LIMIT = 2000


def _parse_time(value: Any) -> _dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)


def rights_request_expired(question: dict[str, Any], at: str | None = None) -> bool:
    """True for an open rights request whose `laeuft_ab` lies in the past (or is unreadable)."""
    if question.get("kind") != RIGHTS_REQUEST_KIND or question.get("state") != "offen":
        return False
    deadline = _parse_time(question.get("laeuft_ab"))
    moment = _parse_time(at or now())
    return deadline is None or moment is None or deadline <= moment


def _normalize_rights_changes(changes: dict[str, Any]) -> dict[str, Any]:
    """The stored form of a rights change: the same lists `set_agent_rights` would read."""
    normalized: dict[str, Any] = {}
    if "tools" in changes:
        normalized["tools"] = _tool_names(changes["tools"])
    if "bash" in changes:
        normalized["bash"] = list(dict.fromkeys(" ".join(item.split())
                                                for item in _text_list(changes["bash"], "Bash-Muster")))
    if "skills" in changes:
        normalized["skills"] = _name_list(changes["skills"], "Skills")
    if "web" in changes:
        normalized["web"] = changes["web"]
    return normalized


def _rights_change_text(diff: dict[str, list[Any]]) -> str:
    """A short description of a rights change for the request text: what is added and what is removed."""
    words = {"tools": "Werkzeuge", "bash": "Bash-Muster", "skills": "Skills"}
    parts = []
    for key in ("tools", "bash", "skills"):
        if key not in diff:
            continue
        old, new = diff[key]
        added = [item for item in new if item not in old]
        removed = [item for item in old if item not in new]
        bits = (["+ %s" % ", ".join(added)] if added else []) + (["- %s" % ", ".join(removed)] if removed else [])
        parts.append("%s %s" % (words[key], "; ".join(bits) or "neu geordnet"))
    return "; ".join(parts)


def _rights_request_event(root: Path, agent_id: str, request_id: str, stand: str, actor: dict[str, Any],
                          note: str | None) -> None:
    _append_history(root, agent_id, {
        "id": new_id("h"), "time": now(), "event": "rechte-antrag", "antrag": request_id, "stand": stand,
        "actor": actor, "note": note,
    })


def _read_rights_request(root: Path, request_id: str) -> dict[str, Any]:
    question = read_question(root, request_id)
    if question.get("kind") != RIGHTS_REQUEST_KIND:
        raise AgentsError("%s ist kein Rechteantrag" % request_id)
    return question


def request_rights(root: Path, changes: dict[str, Any], grund: str, sender: str | None = None,
                   claimed_role: str | None = None, request_id: str | None = None) -> dict[str, Any]:
    """An agent asks for a change of its OWN rights (der Nutzer, 13.10.2026: „Eigener Typ jetzt“).

    There is no parameter for another agent: the request always concerns the sender.  The change is
    checked like `set_agent_rights` (tool names, house list, skills, the world's accesses) without
    writing anything; a change without effect is refused.  The request goes to the main agent, a request
    of the main agent to the human.  It is an open question of `kind: rechte-antrag` and a direct
    message; nothing changes until `decide_rights_request`.
    """
    root = world_path(str(root))
    _check_rights_fields(changes)
    if not isinstance(grund, str) or not grund.strip():
        raise AgentsError("Grund fehlt: ein Rechteantrag braucht eine Begruendung")
    grund = grund.strip()
    if len(grund) > RIGHTS_REQUEST_REASON_LIMIT:
        raise AgentsError("Grund ist zu lang (hoechstens %d Zeichen)" % RIGHTS_REQUEST_REASON_LIMIT)
    if request_id is not None:
        valid_id(request_id, "Antragskennung")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, STAGES)
        if actor.get("kind") != "agent" or actor["id"] in ORCHESTRATOR_ACTORS:
            raise AgentsError("Rechteantraege stellen Agenten der Welt fuer ihre eigenen Rechte")
        agent = read_agent(root, actor["id"])
        normalized = _normalize_rights_changes(changes)
        question = None
        if request_id is not None:
            path = _question_dir(root, request_id)
            if path.exists() or path.is_symlink():
                question = read_question(root, request_id)
                if question.get("kind") != RIGHTS_REQUEST_KIND or question.get("agent") != actor["id"] \
                        or question.get("changes") != normalized or question.get("grund") != grund:
                    raise AgentsError("Antragskennung existiert bereits mit anderem Inhalt")
        if question is None:
            plan = _plan_rights(root, agent, normalized)
            if not plan["diff"]:
                raise AgentsError("Antrag ohne Wirkung: die Rechte von %s sind bereits so" % actor["id"])
            if actor.get("role") == "hauptagent":
                target = WORLD_HUMAN
            else:
                target = next((a["id"] for a in list_agents(root) if a.get("stage") == "hauptagent"), None)
                if target is None:
                    raise AgentsError("Welt hat keinen Hauptagenten, der den Antrag entscheidet")
            world = read_world(root)
            if world["state"] != "läuft":
                raise AgentsError("Welt ist %s; kein Antrag wird gestellt" % world["state"])
            request_id = request_id or new_id("rantrag")
            path = _question_dir(root, request_id)
            text = "Rechteantrag von %s: %s. Grund: %s" % (actor["id"], _rights_change_text(plan["diff"]), grund)
            timestamp = now()
            created = _parse_time(timestamp) or _dt.datetime.now(_dt.timezone.utc)
            expires = (created + _dt.timedelta(days=RIGHTS_REQUEST_DAYS)).isoformat().replace("+00:00", "Z")
            question = {
                "schema_version": SCHEMA_VERSION, "id": request_id, "world": world["id"],
                "kind": RIGHTS_REQUEST_KIND, "text": text, "options": ["freigeben", "ablehnen"],
                "recommendation": None, "ticket": None, "state": "offen", "answer": None, "withdrawal": None,
                "sender": actor["id"], "sender_verified": False, "to": target, "agent": actor["id"],
                "changes": normalized,
                "vorher": {key: list(agent.get(key) or []) for key in ("tools", "bash", "skills")},
                "grund": grund, "created_at": timestamp, "updated_at": timestamp, "laeuft_ab": expires,
            }
            stage_path = path.parent / (".%s.creating-%s" % (request_id, uuid.uuid4().hex))
            try:
                stage_path.mkdir(parents=True)
                _write_json(stage_path / "question.json", question)
                os.replace(stage_path, path)
            except BaseException:
                shutil.rmtree(stage_path, ignore_errors=True)
                raise
            _rights_request_event(root, actor["id"], request_id, "gestellt", actor, None)
    # Also on a repeated call: a run that stopped before this line delivers now (review F3, 14.10.2026).
    # A repeated call after a decision, withdrawal or expiry delivers nothing (review R2, 14.10.2026).
    if question["state"] != "offen" or rights_request_expired(question):
        return question
    target, request_id = question["to"], question["id"]
    hint = "entscheiden mit wb-agent rechte-antrag-entscheiden" if target == WORLD_HUMAN else \
        "entscheiden mit agent.rechte_entscheiden"
    # The human is reached through the world's postbox (unmarked: a rights request is no question).
    send_message(root, actor["id"], [target], "%s (Rechteantrag %s; %s)" % (question["text"], request_id, hint),
                 None, derived_id("rechte-antrag", request_id), actor.get("role"), direct=True)
    return question


def decide_rights_request(root: Path, request_id: str, accept: bool, note: str | None = None,
                          sender: str | None = None, claimed_role: str | None = None) -> dict[str, Any]:
    """The main agent or the human grants or declines a rights request; nobody decides an own request.

    A request of the main agent is decided only by the human, team leaders never decide.  Granting
    applies exactly the changes stored when the request was made, with `antrag=<id>` in the history;
    if that fails, the request stays open and the error goes to the caller.  Checking the request,
    setting the rights and marking the request run under ONE lock, so a concurrent decision,
    withdrawal or expiry cannot leave a declined request with rights in effect (review F1, 14.10.2026).
    A repeated identical decision only delivers the reply again (idempotent through its derived ID).
    """
    root = world_path(str(root))
    valid_id(request_id, "Antragskennung")
    if not isinstance(accept, bool):
        raise AgentsError("Entscheidung muss freigeben oder ablehnen sein")
    if note is not None and (not isinstance(note, str) or not note.strip()):
        raise AgentsError("Bemerkung muss ein Text sein")
    decision = "freigegeben" if accept else "abgelehnt"
    with transaction(root):
        actor = _require_governance_actor(root, sender or WORLD_HUMAN, claimed_role, ("hauptagent",))
        question = _read_rights_request(root, request_id)
        if actor.get("kind") == "agent":
            if actor.get("role") != "hauptagent":
                raise AgentsError("Rechteantraege entscheidet der Hauptagent oder der Mensch")
            if actor["id"] in (question.get("agent"), question.get("sender")):
                raise AgentsError("Niemand entscheidet seinen eigenen Rechteantrag; das tut der Mensch")
            if question.get("to") != actor["id"]:
                raise AgentsError("Rechteantrag %s richtet sich an %s" % (request_id, question.get("to")))
        if question.get("state") == "beantwortet":
            if (question.get("answer") or {}).get("text") != decision:
                raise AgentsError("Rechteantrag ist bereits anders entschieden")
        elif question.get("state") != "offen":
            raise AgentsError("Rechteantrag ist %s" % question.get("state"))
        elif rights_request_expired(question):
            raise AgentsError("Rechteantrag %s ist abgelaufen (%s)" % (request_id, question.get("laeuft_ab")))
        else:
            agent_id = question["agent"]
            if accept:
                _apply_rights_locked(root, actor, agent_id, question["changes"], None, rights_request=request_id)
            question["state"] = "beantwortet"
            question["answer"] = {"text": decision, "note": note, "sender": actor["id"], "role": actor.get("role"),
                                  "verified": bool(actor.get("verified")), "source": actor.get("source"),
                                  "answered_at": now()}
            question["updated_at"] = question["answer"]["answered_at"]
            _write_json(_question_dir(root, request_id) / "question.json", question)
            _rights_request_event(root, agent_id, request_id, decision, actor, note)
    # The reply is built from the stored answer, so a repeated call delivers the same message once.
    answer = question["answer"]
    reply = "Rechteantrag %s: %s%s" % (request_id, answer["text"], " – %s" % answer["note"] if answer.get("note") else "")
    send_message(root, answer["sender"], [question["sender"]], reply, None,
                 derived_id("rechte-antrag-entschieden", request_id), answer.get("role"), direct=True)
    return question


def withdraw_rights_request(root: Path, request_id: str, note: str | None = None, sender: str | None = None,
                            claimed_role: str | None = None) -> dict[str, Any]:
    """Only the agent that made a rights request withdraws it; afterwards nobody can decide it."""
    root = world_path(str(root))
    valid_id(request_id, "Antragskennung")
    if note is not None and (not isinstance(note, str) or not note.strip()):
        raise AgentsError("Bemerkung muss ein Text sein")
    with transaction(root):
        actor = _require_governance_actor(root, sender, claimed_role, STAGES)
        question = _read_rights_request(root, request_id)
        if actor.get("kind") != "agent" or actor["id"] != question.get("sender"):
            raise AgentsError("Einen Rechteantrag zieht nur der Antragsteller %s zurueck" % question.get("sender"))
        if question.get("state") == "zurueckgezogen":
            return question
        if question.get("state") != "offen":
            raise AgentsError("Rechteantrag ist %s" % question.get("state"))
        ts = now()
        question.update({"state": "zurueckgezogen", "updated_at": ts,
                         "withdrawal": {"sender": actor["id"], "at": ts, "note": note}})
        _write_json(_question_dir(root, request_id) / "question.json", question)
        _rights_request_event(root, question["agent"], request_id, "zurueckgezogen", actor, note)
        return question


def rights_summary(agent: dict[str, Any]) -> str:
    """One sentence on an agent's rights for the human: tools, own Bash patterns beyond the service path, skills."""
    tools = ", ".join(agent.get("tools") or []) or "keine"
    extra = [pattern for pattern in agent.get("bash") or [] if pattern not in DEFAULT_BASH]
    skills = ", ".join(agent.get("skills") or []) or "keine"
    return "Rechte: Werkzeuge %s; Bash über den Dienstweg hinaus %s; Skills %s." % (
        tools, ", ".join("`%s`" % item for item in extra) if extra else "keine", skills)


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


def _snapshot_memory(root: Path, agent_id: str, memory: dict[str, Any], vault: Any) -> dict[str, Any] | None:
    """Groesse des Gedaechtnisses und Brain-Bereich (der Nutzer, 16.09.2026); die volle Datei, nicht nur der Auszug."""
    try:
        import agents_gedaechtnis
    except ImportError:  # the RPC copy in a turn carries no memory module
        return None
    try:
        text = None if memory.get("truncated") else memory.get("text") or ""
        return agents_gedaechtnis.stand(root, agent_id, vault, text=text)
    except (AgentsError, OSError, ValueError):
        return None


def _snapshot_agents(root: Path, limit: int, text_limit: int) -> list[dict[str, Any]]:
    result = []
    try:
        import agents_gedaechtnis
        vault = agents_gedaechtnis.welt_vault(root)
    except ImportError:
        vault = None
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
        agent["gedaechtnis"] = _snapshot_memory(root, profile.get("id") or item.name, agent["memory"], vault)
        agent["instructions"] = _read_text_capped(item / "AGENTS.md", text_limit)
        agent["history"] = {"entries": entries[-limit:], "total": len(entries)}
        result.append(agent)
    return result


def _snapshot_tickets(root: Path, limit: int) -> list[dict[str, Any]]:
    result = []
    tickets = []
    for item in _visible_dirs(root / "tickets", "Ticketordner"):
        ticket = _read_optional_json(item / "ticket.json", "Ticketdatei")
        if ticket is None:
            continue
        events = _read_jsonl(item / "verlauf.jsonl", "Ticketverlauf")
        ticket = dict(ticket)
        ticket["history"] = {"events": events[-limit:], "total": len(events)}
        tickets.append((ticket, events))
    stich = time.time()
    kinder_gesamt: dict[str, int] = {}
    kinder_fertig: dict[str, int] = {}
    for ticket, _events in tickets:
        parent = ticket.get("parent")
        if parent:
            kinder_gesamt[parent] = kinder_gesamt.get(parent, 0) + \
                (0 if ticket.get("state") == "verworfen" else 1)
            if ticket.get("state") == "abgenommen":
                kinder_fertig[parent] = kinder_fertig.get(parent, 0) + 1
    for ticket, events in tickets:
        # Messung je Ticket (Plan Satz 50): Durchlaufzeit, Zuege und Alter; dazu die Ampel
        # der Frist und der Kinderzaehler fuer "n von m abgenommen" (Saetze 31 und 36).
        angelegt = _epoch_of(ticket.get("created_at")) if ticket.get("created_at") else None
        abnahme = ((ticket.get("approval") or {}).get("time")) if ticket.get("state") == "abgenommen" else None
        bis = _epoch_of(abnahme) if abnahme else stich
        if angelegt is not None:
            ticket["lead_time_s"] = max(0, int(bis - angelegt))
            ticket["age_s"] = max(0, int(stich - angelegt))
        ticket["turns"] = sum(1 for entry in events if entry.get("event") == "zug")
        ticket["deadline_state"] = _deadline_state(ticket, stich)
        # Satz 5: die Ansicht zeigt die Stufe mit Bedeutungstext.
        stufe = ticket.get("priority")
        ticket["priority_text"] = PRIORITY_TEXTS.get(stufe if stufe in PRIORITY_TEXTS else DEFAULT_PRIORITY)
        ticket["children_total"] = kinder_gesamt.get(ticket["id"], 0)
        ticket["children_approved"] = kinder_fertig.get(ticket["id"], 0)
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
        zugaenge = section("zugaenge", lambda: _snapshot_zugaenge(root), [])
        zyklen = section("zyklen", lambda: _zyklen_alle(root), [])
        # Die Ansicht bekommt Triage-Tickets in der Backlog-Reihenfolge (Plan Satz 44); die
        # uebrigen Tickets bleiben in ihrer Ordnung (stabile Sortierung).
        tickets.sort(key=lambda t: (0 if t.get("state") == "triage" else 1,
                                    t.get("order") if t.get("state") == "triage"
                                    and isinstance(t.get("order"), int)
                                    and not isinstance(t.get("order"), bool) else 0))
    counters = {"braucht_dich": 0, "triage": 0, "laufen": 0, "offen": 0}
    for ticket in tickets:
        state = ticket.get("state")
        if state == "braucht dich":
            counters["braucht_dich"] += 1
        elif state == "triage":
            counters["triage"] += 1
        elif state == "läuft":
            counters["laufen"] += 1
        if state in ("offen", "zurückgegeben", "wartet"):
            counters["offen"] += 1
    wip = sum(1 for ticket in tickets if ticket.get("state") in ("läuft", "wartet"))
    result = {"schema_version": SCHEMA_VERSION, "path": str(root), "consistent": consistent,
              "read_at": now(), "world": world, "agents": agents, "tickets": tickets,
              "tickets_braucht_dich": counters["braucht_dich"], "tickets_triage": counters["triage"],
              "tickets_laufen": counters["laufen"], "tickets_offen": counters["offen"],
              "wip": {"laufend": wip, "grenze": _wip_limit(world, {a["id"]: a for a in agents})},
              "channel": channel[-limit:], "channel_total": len(channel),
              "direct_chats": chats, "questions": questions, "humans": humans, "zugaenge": zugaenge,
              "zyklen": zyklen,
              "maschine_vorgabe": world_machine_default(root), "errors": errors}
    # The models this world's carrier can run (agents_modellwahl); without traeger.json the field is absent
    # and the interface keeps its fixed list.
    try:
        import agents_modellwahl
    except ImportError:  # the RPC copy in a turn carries no model list
        agents_modellwahl = None
    if agents_modellwahl is not None:
        models = section("modelle", lambda: agents_modellwahl.welt_modelle(root), None)
        if models is not None:
            result["modelle"] = models
    return result


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


def pause_hinweis(root: Path, agent_id: str | None = None) -> str:
    """Auftrag pausetext (10.10.2026): die Pause friert einen laufenden Zug nicht ein (agents_claude_lauf.py,
    ``ClaudeZugLauncher``: das Zugende ist der Checkpoint). Er arbeitet zu Ende, danach startet keiner mehr;
    sofort haelt nur ``wb-welt stop``/``wb-agent stop``. Der Satz dazu, wenn laut ``agents_traeger.py status --nur-zug`` ein Zug laeuft --
    fuer die Welt jeder Agent, fuer einen Agenten nur er. Leer ohne Traeger, ohne Zug oder wenn der Status scheitert.
    """
    konfig = root / "traeger.json"
    if not konfig.is_file():
        return ""
    try:
        done = subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "agents_traeger.py"), "status",
                               "--konfig", str(konfig), "--nur-zug"],
                              text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=10)
        stand = json.loads(done.stdout).get("agenten") if done.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError, AttributeError):
        return ""
    if not isinstance(stand, dict):
        return ""
    namen = [agent.get("name") or agent["id"] for agent in list_agents(root)
             if (agent_id is None or agent["id"] == agent_id)
             and isinstance(stand.get(agent["id"]), dict) and stand[agent["id"]].get("laeuft") is True]
    if not namen:
        return ""
    if agent_id is not None:
        wer = "Der laufende Zug arbeitet noch zu Ende und kann"
    elif len(namen) == 1:
        wer = "Der laufende Zug von %s arbeitet noch zu Ende und kann" % namen[0]
    else:
        wer = "Die laufenden Züge von %s und %s arbeiten noch zu Ende und können" % (", ".join(namen[:-1]), namen[-1])
    stopp = "wb-agent stop" if agent_id is not None else "wb-welt stop"
    return "%s dabei Ergebnisse schreiben. Danach startet kein neuer Zug. Sofort anhalten lässt sich nur mit %s." % (wer, stopp)


def _pause_ausgeben(args: argparse.Namespace, data: Any, root: Path, agent_id: str | None) -> None:
    """Wie `_json_or_text`; im Text nach einer Pause der Satz ueber den laufenden Zug (JSON bleibt unveraendert)."""
    _json_or_text(args, data)
    if args.command == "pause" and not getattr(args, "json", False):
        hinweis = pause_hinweis(root, agent_id)
        if hinweis:
            print(hinweis)


def _entwurf_aus_argumenten(args: argparse.Namespace) -> dict[str, Any]:
    """Der Entwurf fuer `wb-ticket bereit --entwurf`: erst das JSON, dann die Optionen darueber."""
    entwurf: dict[str, Any] = {}
    quelle = None
    if args.entwurf_datei:
        quelle = sys.stdin.read() if args.entwurf_datei == "-" \
            else Path(args.entwurf_datei).read_text(encoding="utf-8")
    elif args.entwurf_json:
        quelle = args.entwurf_json
    if quelle is not None:
        try:
            entwurf = json.loads(quelle)
        except json.JSONDecodeError as exc:
            raise AgentsError("Entwurf braucht JSON") from exc
        if not isinstance(entwurf, dict):
            raise AgentsError("Entwurf braucht ein JSON-Objekt")
        entwurf = dict(entwurf)
    if args.grenzen:
        try:
            grenzen = json.loads(args.grenzen)
        except json.JSONDecodeError as exc:
            raise AgentsError("--grenzen braucht JSON") from exc
        if not isinstance(grenzen, dict):
            raise AgentsError("--grenzen braucht ein JSON-Objekt")
        entwurf["grenzen"] = grenzen
    for name, wert in (("titel", args.titel), ("ziel", args.ziel), ("fertig", args.fertig),
                       ("team", args.team), ("art", args.art), ("prioritaet", args.prioritaet),
                       ("frist", args.frist), ("runden", args.runden)):
        if wert is not None:
            entwurf[name] = wert
    for name, wert in (("an", args.an), ("fertig-punkt", args.fertig_punkt),
                       ("abhaengig-von", args.abhaengig_von)):
        if wert:
            entwurf[name] = list(wert)
    return entwurf


def ticket_text(root: Path, ticket_id: str) -> str:
    """Readable ticket view: assignment, done list, result, review, approval and the
    progress notes in chronological order (`wb-ticket zeigen` ohne --json)."""
    root = world_path(str(root))
    ticket = read_ticket(root, ticket_id)
    stich = time.time()
    lines = ["Ticket %s: %s" % (ticket_id, ticket.get("title") or ""),
             "Auftrag/Ziel: %s" % (ticket.get("goal") or ""),
             "Fertig wenn: %s" % (ticket.get("done_criterion") or ""),
             "Stand: %s%s" % (ticket.get("state"),
                              ", Bearbeiter %s" % ticket["assignee"] if ticket.get("assignee") else ""),
             # Klammern: ohne sie entschied das Team ueber die ganze Zeile, und ein Ticket
             # ohne Team zeigte "-", obwohl es Adressaten hatte.
             "Adressat: %s" % (", ".join(ticket.get("recipients") or [])
                               or ("Team %s" % ticket["team"] if ticket.get("team") else "-"))]
    lines.append("Art: %s, Prioritaet: %s (%s)" % (
        _ticket_kind_feld(ticket), ticket.get("priority") if ticket.get("priority") is not None else DEFAULT_PRIORITY,
        PRIORITY_TEXTS.get(ticket.get("priority"), PRIORITY_TEXTS[DEFAULT_PRIORITY])))
    if ticket.get("parent"):
        lines.append("Eltern: %s" % ticket["parent"])
    if ticket.get("origin"):
        lines.append("Entdeckt bei: %s" % ticket["origin"])
    if ticket.get("cycle"):
        lines.append("Zyklus: %s" % ticket["cycle"])
    kinder = children(root, ticket_id)
    if kinder:
        offen = [k for k in kinder if k.get("state") != "verworfen"]
        fertig = [k for k in offen if k.get("state") == "abgenommen"]
        lines.append("Kinder (%d von %d abgenommen): %s" % (len(fertig), len(offen),
                                                            ", ".join(k["id"] for k in kinder)))
    ampel = _deadline_state(ticket, stich)
    grenzen = ticket.get("limits") or {}
    if grenzen:
        teile = []
        if grenzen.get("frist"):
            teile.append("Frist %s (%s)" % (grenzen["frist"], ampel or "keine Ampel"))
        if grenzen.get("runden"):
            teile.append("hoechstens %s Zuege" % grenzen["runden"])
        if grenzen.get("daten"):
            teile.append("Daten bleiben auf der Maschine")
        lines.append("Grenzen: %s" % "; ".join(teile))
    items = _ticket_done_items(ticket)
    if items:
        lines.append("Fertig-Liste:")
        lines += ["  [%s] %s" % ("x" if item.get("done") else " ", item["text"]) for item in items]
    review = ticket.get("review") or {}
    if review.get("note"):
        lines.append("Prüfnotiz von %s (%s): %s" % (review.get("reviewer"), review.get("verdict") or "?",
                                                    review.get("note")))
    elif review.get("reviewer"):
        lines.append("In Prüfung bei %s (Revision %s)" % (review["reviewer"], review.get("revision")))
    result = ticket.get("result") or {}
    if result.get("text"):
        lines.append("Ergebnis (Revision %s%s): %s" % (ticket.get("result_revision"),
                                                       ", Commit %s" % result["commit"] if result.get("commit") else "",
                                                       result["text"]))
    approval = ticket.get("approval") or {}
    if approval.get("time"):
        lines.append("Abnahme durch %s%s: %s" % (approval.get("agent"),
                                                 ", Bemerkung %s" % approval["note"] if approval.get("note") else "",
                                                 approval.get("reason_code") or approval.get("kind") or ""))
    zwischen = [entry for entry in _read_jsonl(_ticket_path(root, ticket_id) / "verlauf.jsonl", "Ticketverlauf")
                if entry.get("event") == "zwischenstand"]
    lines.append("Zwischenstände (%d):" % len(zwischen))
    for entry in zwischen:
        actor = (entry.get("actor") or {}).get("id") or "?"
        lines.append("  %s [%s]: %s" % (entry.get("time"), actor,
                                        str(entry.get("text") or "").replace("\n", " ")))
    return "\n".join(lines)


def _world_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("world", help="Weltordner")


def parser_for(kind: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wb-" + kind)
    sub = parser.add_subparsers(dest="command", required=True)
    if kind == "welt":
        p = sub.add_parser("neu"); p.add_argument("world"); p.add_argument("--name"); p.add_argument("--hauptagent", default="hauptagent"); p.add_argument("--beschreibung", default="Hauptagent der Welt"); p.add_argument("--modell"); p.add_argument("--denkweise", choices=("low", "medium", "high", "xhigh")); p.add_argument("--fallback"); p.add_argument("--fallback-denkweise"); p.add_argument("--maschine", default="lokal"); p.add_argument("--global", dest="global_world", action="store_true"); p.add_argument("--ohne-hauptagent", dest="without_main", action="store_true"); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("frage"); p.add_argument("world"); p.add_argument("--id"); p.add_argument("--text", required=True); p.add_argument("--option", action="append", default=[]); p.add_argument("--empfehlung"); p.add_argument("--ticket"); p.add_argument("--absender", required=True); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("fragen"); p.add_argument("world"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("antwort"); p.add_argument("world"); p.add_argument("question"); p.add_argument("--text", required=True); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("ruecknahme"); p.add_argument("world"); p.add_argument("question"); p.add_argument("--grund"); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        # Read-only views for the user interface; they never write.
        p = sub.add_parser("finden"); p.add_argument("--wurzel", action="append", default=[]); p.add_argument("--projekt", action="append", default=[]); p.add_argument("--global", dest="global_dir"); p.add_argument("--ohne-global", action="store_true"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("ansicht"); p.add_argument("world"); p.add_argument("--grenze", type=int, default=SNAPSHOT_LIMIT); p.add_argument("--json", action="store_true")
        p = sub.add_parser("gelesen"); p.add_argument("world"); p.add_argument("--gespraech", required=True); p.add_argument("--zeit", required=True); p.add_argument("--nachricht", required=True); p.add_argument("--mensch", default=WORLD_HUMAN); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("dod"); p.add_argument("world"); p.add_argument("aktion", choices=("setzen", "zeigen")); p.add_argument("--punkt", action="append", default=[]); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("zyklus"); p.add_argument("world"); p.add_argument("aktion", choices=("einschalten", "ausschalten", "zeigen")); p.add_argument("--tage", type=int, help="Zykluslaenge in Tagen (Vorgabe 7)"); p.add_argument("--ziel", help="Ziel des ersten Zyklus"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("wip"); p.add_argument("world"); p.add_argument("--limit", type=int, help="weiche WIP-Grenze setzen; ohne Angabe zeigen"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        for name, state in (("liste", None), ("zeigen", None), ("pause", "pausiert"), ("start", "läuft"), ("stop", "gestoppt")):
            p = sub.add_parser(name); p.add_argument("world"); p.add_argument("--grund"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        try:
            import agents_zugaenge
        except ImportError:  # the RPC copy in a turn carries no access module
            agents_zugaenge = None
        if agents_zugaenge is not None:
            agents_zugaenge.parser_ergaenzen(sub)
        try:
            import agents_freigaben
        except ImportError:  # the RPC copy in a turn carries no release module either
            agents_freigaben = None
        if agents_freigaben is not None:
            agents_freigaben.parser_ergaenzen(sub)
        try:
            import agents_gedaechtnis
        except ImportError:  # the RPC copy in a turn carries no memory module
            agents_gedaechtnis = None
        if agents_gedaechtnis is not None:
            agents_gedaechtnis.parser_ergaenzen(sub)
        return parser
    if kind == "agent":
        p = sub.add_parser("neu"); p.add_argument("world"); p.add_argument("--name", required=True); p.add_argument("--stufe", required=True, choices=STAGES); p.add_argument("--team"); p.add_argument("--beschreibung", required=True); p.add_argument("--figur"); p.add_argument("--werkzeug", action="append", default=[]); p.add_argument("--skill", action="append", default=[]); p.add_argument("--modell"); p.add_argument("--denkweise"); p.add_argument("--fallback"); p.add_argument("--fallback-denkweise"); p.add_argument("--maschine"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        for name, state in (("liste", None), ("zeigen", None), ("pause", "pausiert"), ("start", "aktiv"), ("stop", "gestoppt")):
            p = sub.add_parser(name); p.add_argument("world");
            if name != "liste": p.add_argument("agent")
            p.add_argument("--grund"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("profil"); p.add_argument("world"); p.add_argument("agent"); p.add_argument("--modell"); p.add_argument("--denkweise"); p.add_argument("--fallback"); p.add_argument("--fallback-denkweise"); p.add_argument("--maschine"); p.add_argument("--beschreibung"); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("rechte"); p.add_argument("world"); p.add_argument("agent"); p.add_argument("--werkzeuge", help="Liste mit Komma, z. B. Read,Grep,Write"); g = p.add_mutually_exclusive_group(); g.add_argument("--bash", action="append", help="eigenes Muster zusaetzlich zum Dienstweg, wiederholbar"); g.add_argument("--ohne-bash", action="store_true", help="nur die Dienstwegmuster"); p.add_argument("--skills", help="Liste mit Komma; leer entfernt alle"); g = p.add_mutually_exclusive_group(); g.add_argument("--web", dest="web", action="store_const", const=True); g.add_argument("--ohne-web", dest="web", action="store_const", const=False); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--antrag", help="Nachrichten-ID, mit der der Agent die Rechte erbat; Rechteantraege entscheidet rechte-antrag-entscheiden"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("gedaechtnis"); p.add_argument("world"); p.add_argument("agent"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--text"); g.add_argument("--datei"); p.add_argument("--erwartet"); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("vorlagen"); p.add_argument("--ordner"); p.add_argument("--json", action="store_true")
        for name in ("entwurf", "anlegen", "antrag"):
            p = sub.add_parser(name); p.add_argument("world"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--entwurf"); g.add_argument("--entwurf-datei")
            p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--id"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("antrag-entscheiden"); p.add_argument("world"); p.add_argument("antrag"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--annehmen", action="store_true"); g.add_argument("--ablehnen", action="store_true")
        p.add_argument("--bemerkung"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("rechte-antrag", help="eigene Rechte beim Hauptagenten (als Hauptagent beim Menschen) beantragen"); p.add_argument("world"); p.add_argument("--werkzeuge", help="Liste mit Komma, z. B. Read,Grep,Write"); g = p.add_mutually_exclusive_group(); g.add_argument("--bash", action="append", help="eigenes Muster zusaetzlich zum Dienstweg, wiederholbar"); g.add_argument("--ohne-bash", action="store_true", help="nur die Dienstwegmuster"); p.add_argument("--skills", help="Liste mit Komma; leer entfernt alle"); g = p.add_mutually_exclusive_group(); g.add_argument("--web", dest="web", action="store_const", const=True); g.add_argument("--ohne-web", dest="web", action="store_const", const=False); p.add_argument("--grund", required=True, help="Begruendung, hoechstens %d Zeichen" % RIGHTS_REQUEST_REASON_LIMIT); p.add_argument("--id", help="Antragskennung fuer eine wiederholbare Anfrage"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("rechte-antrag-entscheiden", help="Rechteantrag freigeben oder ablehnen (Hauptagent oder Mensch)"); p.add_argument("world"); p.add_argument("antrag"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--freigeben", action="store_true"); g.add_argument("--ablehnen", action="store_true")
        p.add_argument("--bemerkung"); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("rechte-antrag-zurueckziehen", help="eigenen offenen Rechteantrag zurueckziehen"); p.add_argument("world"); p.add_argument("antrag"); p.add_argument("--bemerkung"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        return parser
    if kind == "ticket":
        p = sub.add_parser("neu"); p.add_argument("world"); p.add_argument("--id"); p.add_argument("--titel", required=True); p.add_argument("--ziel", required=True); p.add_argument("--fertig", required=True); p.add_argument("--an", action="append", default=[]); p.add_argument("--team"); p.add_argument("--grenzen", default="{}"); p.add_argument("--frist", help="ISO-Zeit der Frist (limits.frist)"); p.add_argument("--runden", type=int, help="hoechste Zugzahl (limits.runden)"); p.add_argument("--abhaengig-von", action="append", default=[]); p.add_argument("--fertig-punkt", action="append", default=[]); p.add_argument("--art", choices=TICKET_KINDS); p.add_argument("--prioritaet", type=int, choices=PRIORITY_STUFEN); p.add_argument("--eltern", help="Kennung des Eltern-Tickets"); p.add_argument("--entdeckt-bei", help="Kennung der Herkunft (origin)"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("liste"); p.add_argument("world"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("zeigen"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("uebernehmen"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("ergebnis"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("--text", required=True); p.add_argument("--commit"); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("zwischenstand"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("--text", required=True); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("haken"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("nr", type=int); p.add_argument("--zurueck", action="store_true"); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        for name, accept in (("abnehmen", True), ("zurueckgeben", False)):
            p = sub.add_parser(name); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--absender", required=True); p.add_argument("--rolle"); p.add_argument("--herkunft-beleg", metavar="wb-mensch|mobil:PFAD", help="'wb-mensch' misst live; 'mobil:PFAD' bindet den bereits geprueften App-Umschlag strukturell"); p.add_argument("--bemerkung"); p.add_argument("--grund", choices=APPROVE_REASONS)
            if accept: p.add_argument("--dod-geprueft", action="store_true")
            p.add_argument("--json", action="store_true")
        p = sub.add_parser("pruefen"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--absender", required=True); p.add_argument("--pruefer", required=True); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("pruefnotiz"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("--text", required=True); p.add_argument("--verdict", required=True, choices=REVIEW_VERDICTS); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("parken"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--agent", required=True); p.add_argument("--grund", required=True); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--bis"); g.add_argument("--auf"); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("braucht-dich"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--frage", required=True); p.add_argument("--grund", required=True); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("verwerfen"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--absender", default=WORLD_HUMAN); p.add_argument("--grund", required=True, choices=DISCARD_REASONS); p.add_argument("--bemerkung"); p.add_argument("--duplikat-von"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("umadressieren"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--an", action="append", default=[]); p.add_argument("--team"); p.add_argument("--grund", required=True); p.add_argument("--absender", required=True); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("annehmen"); p.add_argument("world"); p.add_argument("ticket"); g = p.add_mutually_exclusive_group(required=True); g.add_argument("--an", action="append"); g.add_argument("--team"); p.add_argument("--prioritaet"); p.add_argument("--art", choices=TICKET_KINDS); p.add_argument("--eltern"); p.add_argument("--fertig-punkt", action="append", default=[]); p.add_argument("--absender", required=True); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("backlog"); p.add_argument("world"); p.add_argument("--ordnen", action="append", default=[], help="Triage-Tickets neu ordnen (oben zuerst)"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        p = sub.add_parser("grenzen"); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--frist"); p.add_argument("--runden", type=int); p.add_argument("--absender", default="cli-operator"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
        # Bereitschaft: ohne Option fuer die Tickets der Welt, mit --entwurf fuer einen Entwurf, bevor
        # das Ticket angelegt ist. Der Entwurf kommt aus den Optionen, aus --entwurf-json oder aus
        # --entwurf-datei; die Optionen gelten ueber dem JSON. Exit 0 bereit, 1 nicht bereit, 2 Aufruffehler.
        p = sub.add_parser("bereit"); p.add_argument("world"); p.add_argument("--entwurf", action="store_true"); p.add_argument("--entwurf-json"); p.add_argument("--entwurf-datei", help="JSON-Datei, '-' liest von der Standardeingabe"); p.add_argument("--titel"); p.add_argument("--ziel"); p.add_argument("--fertig"); p.add_argument("--an", action="append", default=[]); p.add_argument("--team"); p.add_argument("--art", choices=TICKET_KINDS); p.add_argument("--prioritaet", type=int, choices=PRIORITY_STUFEN); p.add_argument("--frist"); p.add_argument("--runden", type=int); p.add_argument("--grenzen"); p.add_argument("--fertig-punkt", action="append", default=[]); p.add_argument("--abhaengig-von", action="append", default=[]); p.add_argument("--json", action="store_true")
        return parser
    p = sub.add_parser("senden"); p.add_argument("world"); p.add_argument("--absender", default="cli-operator"); p.add_argument("--an", action="append", required=True); p.add_argument("--text", required=True); p.add_argument("--ticket"); p.add_argument("--id"); p.add_argument("--rolle"); p.add_argument("--direkt", action="store_true"); p.add_argument("--markierung", choices=MESSAGE_MARKS); p.add_argument("--json", action="store_true")
    p = sub.add_parser("lesen"); p.add_argument("world"); p.add_argument("--agent"); p.add_argument("--chat"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("quittieren"); p.add_argument("world"); p.add_argument("--agent", required=True); p.add_argument("--zustellung", required=True); p.add_argument("--absender"); p.add_argument("--rolle"); p.add_argument("--json", action="store_true")
    return parser


def run(kind: str, argv: list[str]) -> int:
    args = parser_for(kind).parse_args(argv)
    # These two subcommands have historically defaulted to ``cli-operator``.
    # They are human-only authority changes; keep the shorthand useful for a
    # terminal/UI user, but turn it into a measured human request rather than
    # treating the spelling as authority.
    if kind == "welt" and args.command in {"freigabe", "zugang"} \
            and getattr(args, "absender", None) == "cli-operator":
        args.absender = WORLD_HUMAN
    proof = getattr(args, "herkunft_beleg", None)
    proof_token = _HERKUNFTSBELEG.set(proof)
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
                else: print("%s: %d Agenten, %d Tickets (offen %d, läuft %d, braucht dich %d, triage %d), %d Kanalnachrichten, %d Fragen" % (
                    data["world"].get("name"), len(data["agents"]), len(data["tickets"]), data["tickets_offen"],
                    data["tickets_laufen"], data["tickets_braucht_dich"], data["tickets_triage"],
                    data["channel_total"], len(data["questions"])))
            elif args.command == "gelesen":
                data = mark_read(Path(args.world), args.gespraech, args.zeit, args.nachricht, args.mensch, args.absender, args.rolle)
                _json_or_text(args, data, args.gespraech)
            elif args.command == "dod":
                if args.aktion == "setzen":
                    data = set_definition_of_done(Path(args.world), args.punkt, args.absender, args.rolle)
                    _json_or_text(args, data.get("definition_of_done") or [],
                                  "; ".join(data.get("definition_of_done") or []) or "leer")
                else:
                    data = read_world(Path(args.world)).get("definition_of_done") or []
                    if args.json: _json_or_text(args, data)
                    else:
                        for punkt in data: print("- %s" % punkt)
                        if not data: print("(keine Definition of Done)")
            elif args.command == "zyklus":
                if args.aktion == "zeigen":
                    data = read_cycle(Path(args.world))
                    if args.json: _json_or_text(args, data)
                    else:
                        aktueller = data["current"]
                        print("Zyklen %s, Laenge %d Tage" % ("an" if data["enabled"] else "aus", data["length_days"]))
                        if aktueller:
                            print("Aktueller Zyklus %s: %s bis %s%s" % (
                                aktueller.get("id"), aktueller.get("start"), aktueller.get("end"),
                                ", Ziel: %s" % aktueller["goal"] if aktueller.get("goal") else ""))
                        for eintrag in data["abgeschlossen"]:
                            print("Abgeschlossen %s: angelegt %d, abgenommen %d, übertragen %d, verworfen %d" % (
                                eintrag.get("id"), eintrag.get("angelegt", 0), eintrag.get("abgenommen", 0),
                                eintrag.get("uebertragen", 0), eintrag.get("verworfen", 0)))
                elif args.aktion == "einschalten":
                    world = set_cycle(Path(args.world), True, args.tage, args.ziel, args.absender, args.rolle)
                    aktueller = (world.get("cycles") or {}).get("current") or {}
                    _json_or_text(args, world, "Zyklus %s eingeschaltet (%d Tage)" % (
                        aktueller.get("id"), (world.get("cycles") or {}).get("length_days")))
                else:
                    world = set_cycle(Path(args.world), False, None, None, args.absender, args.rolle)
                    _json_or_text(args, world, "Zyklen ausgeschaltet")
            elif args.command == "wip":
                if args.limit is not None:
                    world = set_wip_limit(Path(args.world), args.limit, args.absender, args.rolle)
                else:
                    world = read_world(Path(args.world))
                grenze = world.get("wip_limit")
                if args.json:
                    _json_or_text(args, {"wip_limit": grenze})
                else:
                    print("WIP-Grenze: %s" % (grenze if grenze is not None else
                                              "aktive Agenten plus ein Viertel (Vorgabe)"))
            elif args.command == "neu": data = create_world(Path(args.world), args.name, args.hauptagent, args.beschreibung, args.modell, args.denkweise, args.fallback, args.fallback_denkweise, args.maschine, args.global_world, not args.without_main, args.absender, args.rolle); _json_or_text(args, data, data["world"]["id"])
            elif args.command == "liste": _json_or_text(args, [read_world(Path(args.world))] if (Path(args.world) / "world.json").exists() else [])
            elif args.command == "zeigen": _json_or_text(args, read_world(Path(args.world)))
            elif args.command == "freigabe":
                import agents_freigaben
                agents_freigaben.ausgeben(args, agents_freigaben.cli(args))
            elif args.command == "mailkonto":
                import agents_freigaben
                agents_freigaben.mailkonto_cli(args)
            elif args.command == "gedaechtnis":
                import agents_gedaechtnis
                agents_gedaechtnis.cli(args)
            elif args.command == "zugang":
                import agents_zugaenge
                data = agents_zugaenge.cli(args)
                if args.json or args.aktion != "liste": _json_or_text(args, data, data.get("name", "") if isinstance(data, dict) else "")
                else:
                    for entry in data: print("%s (%s) -> %s" % (entry["name"], entry["art"], entry["ziel"]))
            else: _pause_ausgeben(args, set_world_state(Path(args.world), {"pause": "pausiert", "start": "läuft", "stop": "gestoppt"}[args.command], args.grund, args.absender, args.rolle), Path(args.world), None)
        elif kind == "agent":
            if args.command == "neu": data = create_agent(Path(args.world), args.name, args.stufe, args.team, args.beschreibung, args.figur, args.werkzeug, args.modell, args.denkweise, args.fallback, args.fallback_denkweise, args.maschine or world_machine_default(world_path(args.world)), args.absender, args.rolle, args.skill); _json_or_text(args, data, data["id"])
            elif args.command == "liste": _json_or_text(args, list_agents(Path(args.world)))
            elif args.command == "zeigen": _json_or_text(args, read_agent(Path(args.world), args.agent))
            elif args.command == "profil":
                changes = {key: value for key, value in (("model", args.modell), ("effort", args.denkweise),
                           ("fallback_model", args.fallback), ("fallback_effort", args.fallback_denkweise),
                           ("machine", args.maschine), ("specialty", args.beschreibung)) if value is not None}
                data = update_agent_profile(Path(args.world), args.agent, changes, args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            elif args.command == "rechte":
                changes: dict[str, Any] = {}
                if args.werkzeuge is not None: changes["tools"] = args.werkzeuge
                if args.bash is not None: changes["bash"] = args.bash
                if args.ohne_bash: changes["bash"] = []
                if args.skills is not None: changes["skills"] = args.skills if args.skills.strip() else []
                if args.web is not None: changes["web"] = args.web
                data = set_agent_rights(Path(args.world), args.agent, changes, args.absender, args.rolle, antrag=args.antrag)
                if args.json: _json_or_text(args, data)
                else: print("%s: %s" % (data["id"], rights_summary(data)))
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
            elif args.command == "rechte-antrag":
                changes = {}
                if args.werkzeuge is not None: changes["tools"] = args.werkzeuge
                if args.bash is not None: changes["bash"] = args.bash
                if args.ohne_bash: changes["bash"] = []
                if args.skills is not None: changes["skills"] = args.skills if args.skills.strip() else []
                if args.web is not None: changes["web"] = args.web
                data = request_rights(Path(args.world), changes, args.grund, args.absender, args.rolle, args.id)
                _json_or_text(args, data, data["id"])
            elif args.command == "rechte-antrag-entscheiden":
                data = decide_rights_request(Path(args.world), args.antrag, args.freigeben, args.bemerkung, args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            elif args.command == "rechte-antrag-zurueckziehen":
                data = withdraw_rights_request(Path(args.world), args.antrag, args.bemerkung, args.absender, args.rolle)
                _json_or_text(args, data, data["id"])
            else: _pause_ausgeben(args, set_agent_state(Path(args.world), args.agent, {"pause": "pausiert", "start": "aktiv", "stop": "gestoppt"}[args.command], args.grund, args.absender, args.rolle), Path(args.world), args.agent)
        elif kind == "ticket":
            if args.command == "neu":
                try: limits = json.loads(args.grenzen)
                except json.JSONDecodeError as exc: raise AgentsError("--grenzen braucht JSON") from exc
                if not isinstance(limits, dict): raise AgentsError("--grenzen braucht ein JSON-Objekt")
                limits = dict(limits)
                if args.frist is not None: limits["frist"] = args.frist
                if args.runden is not None: limits["runden"] = args.runden
                data = create_ticket(Path(args.world), args.titel, args.ziel, args.fertig, args.an, args.absender,
                                     args.rolle, args.team, limits, args.abhaengig_von, args.id,
                                     args.fertig_punkt, args.art, args.prioritaet, args.eltern,
                                     args.entdeckt_bei)
                _json_or_text(args, data, data["id"])
            elif args.command == "liste": _json_or_text(args, list_tickets(Path(args.world)))
            elif args.command == "zeigen":
                if args.json: _json_or_text(args, read_ticket(Path(args.world), args.ticket))
                else: print(ticket_text(Path(args.world), args.ticket))
            elif args.command == "uebernehmen": _json_or_text(args, claim_ticket(Path(args.world), args.ticket, args.agent, args.absender, args.rolle))
            elif args.command == "ergebnis": _json_or_text(args, write_result(Path(args.world), args.ticket, args.agent, args.text, args.commit, args.absender, args.rolle))
            elif args.command == "zwischenstand":
                _json_or_text(args, note_ticket(Path(args.world), args.ticket, args.agent, args.text,
                                                args.absender or args.agent, args.rolle))
            elif args.command == "haken":
                _json_or_text(args, check_done_item(Path(args.world), args.ticket, args.agent, args.nr,
                                                    not args.zurueck, args.absender or args.agent, args.rolle))
            elif args.command == "pruefen":
                _json_or_text(args, review_ticket(Path(args.world), args.ticket, args.pruefer,
                                                  args.absender, args.rolle))
            elif args.command == "pruefnotiz":
                _json_or_text(args, review_result(Path(args.world), args.ticket, args.agent, args.text,
                                                  args.verdict, args.absender or args.agent, args.rolle))
            elif args.command == "zurueckgeben" and args.absender in MEASURED_HUMAN_ACTORS and (
                    read_ticket(Path(args.world), args.ticket).get("state") == "abgenommen"
                    or (read_ticket(Path(args.world), args.ticket).get("approval") or {}).get("kind") == "rueckgabe-mensch"):
                _json_or_text(args, return_ticket(Path(args.world), args.ticket, args.bemerkung or "", args.absender, args.rolle))
            elif args.command == "parken":
                _json_or_text(args, park_ticket(Path(args.world), args.ticket, args.agent, args.grund,
                                                args.bis, args.auf, args.absender or args.agent, args.rolle))
            elif args.command == "braucht-dich":
                _json_or_text(args, flag_ticket(Path(args.world), args.ticket, args.frage, args.grund,
                                                args.absender, args.rolle))
            elif args.command == "verwerfen":
                _json_or_text(args, discard_ticket(Path(args.world), args.ticket, args.grund, args.bemerkung,
                                                   args.absender, args.rolle, args.duplikat_von))
            elif args.command == "umadressieren":
                _json_or_text(args, reassign_ticket(Path(args.world), args.ticket, args.an, args.team,
                                                    args.grund, args.absender, args.rolle))
            elif args.command == "annehmen":
                prioritaet = args.prioritaet
                if prioritaet is not None and re.fullmatch(r"-?\d+", str(prioritaet)):
                    prioritaet = int(prioritaet)
                _json_or_text(args, triage_accept(Path(args.world), args.ticket, args.an, args.team,
                                                  prioritaet, args.art, args.absender, args.rolle,
                                                  args.fertig_punkt, args.eltern))
            elif args.command == "backlog":
                if args.ordnen:
                    data = reorder_triage(Path(args.world), args.ordnen, args.absender, args.rolle)
                else:
                    data = [item for item in ready_tickets(Path(args.world)) if item.get("state") == "triage"]
                if args.json:
                    _json_or_text(args, data)
                else:
                    for item in data:
                        grund = _definition_of_ready_grund(
                            _ticket_kind_feld(item), [i["text"] for i in _ticket_done_items(item)],
                            item.get("limits"), item.get("recipients"), item.get("team"),
                            item.get("title"), item.get("goal"), item.get("done_criterion"))
                        print("%s (Platz %s)%s %s" % (
                            item["id"], item.get("order") or "?",
                            " nicht bereit: %s" % grund if grund else "", item.get("title") or ""))
            elif args.command == "grenzen":
                _json_or_text(args, set_ticket_limits(Path(args.world), args.ticket, args.frist,
                                                      args.runden, args.absender, args.rolle))
            elif args.command == "bereit":
                felder = [args.titel, args.ziel, args.fertig, args.team, args.art, args.prioritaet,
                          args.frist, args.runden, args.grenzen]
                gesetzt = any(wert is not None for wert in felder) or bool(
                    args.an or args.fertig_punkt or args.abhaengig_von)
                if args.entwurf or args.entwurf_json or args.entwurf_datei:
                    data = ready_draft(Path(args.world), _entwurf_aus_argumenten(args))
                    if args.json:
                        _json_or_text(args, data)
                    else:
                        print("bereit" if data["bereit"] else "nicht bereit: %s"
                              % "; ".join(punkt["text"] for punkt in data["fehlt"]))
                    return 0 if data["bereit"] else 1
                if gesetzt:
                    raise AgentsError("Die Felder eines Entwurfs gelten nur mit --entwurf")
                data = ready_tickets(Path(args.world))
                if args.json:
                    _json_or_text(args, data)
                else:
                    for item in data:
                        print("%s %s" % (item["id"], "bereit" if item["ready"] else "nicht bereit: %s" % item["reason"]))
            else: _json_or_text(args, approve_ticket(Path(args.world), args.ticket, args.absender, args.rolle,
                                                     args.bemerkung, args.command == "abnehmen", args.grund,
                                                     getattr(args, "dod_geprueft", False)))
        else:
            if args.command == "senden" and args.markierung:
                _json_or_text(args, send_marked_message(Path(args.world), args.absender, args.an, args.text, args.markierung, args.ticket, args.id, args.rolle, args.direkt))
            elif args.command == "senden": _json_or_text(args, send_message(Path(args.world), args.absender, args.an, args.text, args.ticket, args.id, args.rolle, args.direkt))
            elif args.command == "lesen": _json_or_text(args, read_messages(Path(args.world), args.agent, args.chat))
            else: _json_or_text(args, acknowledge(Path(args.world), args.agent, args.zustellung, args.absender, args.rolle))
        return 0
    except (AgentsError, OSError, ValueError) as exc:
        return cli_error(exc)
    finally:
        _HERKUNFTSBELEG.reset(proof_token)


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
    # Modules imported from here (agents_zugaenge) see this module, not a second copy with its own AgentsError.
    sys.modules.setdefault("agents_data", sys.modules[__name__])
    if len(sys.argv) < 2 or sys.argv[1] not in {"welt", "agent", "ticket", "kanal"}:
        print("agents_data: interner Einstiegspunkt", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(run(sys.argv[1], sys.argv[2:]))
