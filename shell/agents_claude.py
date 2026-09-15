#!/usr/bin/env python3
"""Controllerseitiger Adapter fuer Claude-Code-Zuege im Linux-Launcher.

Der Harness laeuft vollstaendig in der bwrap/systemd-Grenze und erhaelt als
Anmeldung nur einen Platzhalter. Der laufgebundene Modellproxy setzt die echten
Zugangsheader aus einer Controllerquelle. Dieses Modul liest diese Quelle,
beschreibt einen Zug, bewertet dessen stream-json-Ausgabe und sichert den
Sitzungsverlauf fuer eine Wiederaufnahme. Es startet selbst keinen Prozess.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

import atomar_schreiben
from agents_lauf import StartSpec


PLACEHOLDER_TOKEN = "wb-agents-placeholder"
ANTHROPIC_ORIGIN = "https://api.anthropic.com"
RUNNER = "agents_claude_runner.py"
RUNTIME_MODULES = (
    RUNNER, "agents_pi_runner.py", "agents_codex_runner.py", "agents_model_bridge.py", "agents_rpc_client.py", "agents_controller.py",
    "agents_data.py", "atomar_schreiben.py",
)
ALLOWED_TOOLS = frozenset({"Bash", "Read", "Write", "Edit", "Glob", "Grep"})
MAX_CREDENTIAL_BYTES = 64 * 1024
MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024
_TOKEN = re.compile(r"[A-Za-z0-9._~+/=-]{16,1024}\Z")
_SETUP_TOKEN = re.compile(r"sk-ant-oat01-[A-Za-z0-9._~+/=-]{16,1024}\Z")
# Umgebung eines Zuges: Werkzeugschalter und die Skill-Umgebung aus dem Traeger.
# Namen der Sperren aus docs/AGENTS-SPERREN.md (skills_umgebung, profil_umgebung) plus Zugordner, RPC-Client
# und die Hausliste fuer die Profil-Sperre.
ZUG_UMGEBUNG = frozenset({"ENABLE_TOOL_SEARCH", "MAX_THINKING_TOKENS", "WB_WELT", "WB_AGENT_ID", "WB_AGENT_PROFIL",
                          "WB_WELT_PROJEKT", "WB_AGENT_WORKTREE", "WB_AGENT_TMP", "WB_SKILLS_JSON", "WB_SKILL_PFADE",
                          "WB_SKILL_BIBLIOTHEK", "WB_SKRIPT_PFADE", "WB_SKRIPT_BIBLIOTHEK", "WB_AGENT_ZUG",
                          "WB_RPC_CLIENT", "WB_PROFIL_BIN"})
EFFORT_STUFEN = ("low", "medium", "high", "xhigh", "max")
_MODEL = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


class ClaudeAdapterFehler(Exception):
    """Abgelehnte Konfiguration oder ungueltiger Adapterzustand."""


class AnmeldungNichtVerfuegbar(ClaudeAdapterFehler):
    """Keine gueltige Controlleranmeldung; die Meldung nennt nie einen Wert."""


def _read_private_file(path: Path, max_bytes: int) -> bytes:
    """Liest eine eigene, nicht gruppen-/weltlesbare Datei ohne Symlinkfolge."""
    try:
        descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        raise AnmeldungNichtVerfuegbar("Anmeldedatei fehlt oder ist nicht lesbar") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise AnmeldungNichtVerfuegbar("Anmeldedatei muss eigene regulaere Datei sein")
        if info.st_mode & 0o077:
            raise AnmeldungNichtVerfuegbar("Anmeldedatei darf keine Gruppen- oder Fremdrechte haben")
        if info.st_size > max_bytes:
            raise AnmeldungNichtVerfuegbar("Anmeldedatei ist zu gross")
        chunks = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            raise AnmeldungNichtVerfuegbar("Anmeldedatei ist zu gross")
        return data
    finally:
        os.close(descriptor)


def _bearer(token: str) -> tuple[tuple[str, str], ...]:
    return (("Authorization", "Bearer " + token),)


class SetupTokenDatei:
    """Langlebiges Abo-Token aus ``claude setup-token`` in einer Controllerdatei.

    Die Datei enthaelt genau das Token. Sie wird bei jeder Modellanfrage neu
    gelesen, sodass ein Austausch ohne Neustart wirkt. Das Modul erneuert nichts.
    """

    kind = "setup-token"

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)
        if not self.path.is_absolute():
            raise ClaudeAdapterFehler("Tokendatei braucht einen absoluten Pfad")

    def auth_headers(self) -> tuple[tuple[str, str], ...]:
        raw = _read_private_file(self.path, MAX_CREDENTIAL_BYTES)
        try:
            token = raw.decode("ascii").strip()
        except UnicodeDecodeError:
            raise AnmeldungNichtVerfuegbar("Tokendatei hat kein gueltiges Format") from None
        if not _SETUP_TOKEN.fullmatch(token):
            raise AnmeldungNichtVerfuegbar("Tokendatei hat kein gueltiges Format")
        return _bearer(token)

    def status(self) -> dict[str, Any]:
        try:
            self.auth_headers()
            return {"kind": self.kind, "available": True, "expires_at": None, "reason": None}
        except AnmeldungNichtVerfuegbar as exc:
            return {"kind": self.kind, "available": False, "expires_at": None, "reason": str(exc)}


class ClaudeAnmeldungNurLesen:
    """Vorhandene Claude-Code-Anmeldung desselben Kontos, ausschliesslich lesend.

    Der Controller verwendet nur das Zugriffstoken, solange es noch mindestens
    ``min_valid_seconds`` gilt. Das Refresh-Token wird nie benutzt: eine Erneuerung
    wuerde es rotieren und damit die Anmeldung des Hosts veraendern. Erneuert wird
    ausschliesslich durch die Claude-Code-Anmeldung auf diesem Host selbst.
    """

    kind = "claude-login-readonly"

    def __init__(self, credentials_path: str | os.PathLike[str], *, min_valid_seconds: float = 600.0,
                 clock: Callable[[], float] = time.time):
        self.path = Path(credentials_path)
        if not self.path.is_absolute():
            raise ClaudeAdapterFehler("Anmeldedatei braucht einen absoluten Pfad")
        if not isinstance(min_valid_seconds, (int, float)) or min_valid_seconds < 0:
            raise ClaudeAdapterFehler("Mindestrestlaufzeit ist ungueltig")
        self.min_valid_seconds = float(min_valid_seconds)
        self._clock = clock

    def _token_and_expiry(self) -> tuple[str, float]:
        raw = _read_private_file(self.path, MAX_CREDENTIAL_BYTES)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise AnmeldungNichtVerfuegbar("Anmeldedatei ist kein gueltiges JSON") from None
        oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
        if not isinstance(oauth, dict):
            raise AnmeldungNichtVerfuegbar("Anmeldedatei enthaelt keine Claude-Abo-Anmeldung")
        token = oauth.get("accessToken")
        expires = oauth.get("expiresAt")
        scopes = oauth.get("scopes")
        if not isinstance(token, str) or not _TOKEN.fullmatch(token):
            raise AnmeldungNichtVerfuegbar("Zugriffstoken fehlt oder hat kein gueltiges Format")
        if isinstance(expires, bool) or not isinstance(expires, (int, float)):
            raise AnmeldungNichtVerfuegbar("Ablaufzeit der Anmeldung fehlt")
        if not isinstance(scopes, list) or "user:inference" not in scopes:
            raise AnmeldungNichtVerfuegbar("Anmeldung erlaubt keine Modellanfragen")
        return token, float(expires) / 1000.0

    def auth_headers(self) -> tuple[tuple[str, str], ...]:
        token, expires_at = self._token_and_expiry()
        if expires_at - float(self._clock()) < self.min_valid_seconds:
            raise AnmeldungNichtVerfuegbar(
                "Zugriffstoken laeuft ab; der Controller erneuert die Host-Anmeldung nicht")
        return _bearer(token)

    def status(self) -> dict[str, Any]:
        try:
            _, expires_at = self._token_and_expiry()
        except AnmeldungNichtVerfuegbar as exc:
            return {"kind": self.kind, "available": False, "expires_at": None, "reason": str(exc)}
        remaining = expires_at - float(self._clock())
        available = remaining >= self.min_valid_seconds
        return {"kind": self.kind, "available": available, "expires_at": expires_at,
                "reason": None if available else "Zugriffstoken laeuft ab"}


class AnmeldungMitRueckfall:
    """Setup-Token zuerst; die Nur-Lese-Anmeldung gilt nur, solange die Tokendatei fehlt.

    Bei jeder Anfrage wird neu entschieden. Eine vorhandene, aber ungueltige Tokendatei
    faellt nicht zurueck: sie ist ein Fehler, der sichtbar bleiben soll.
    """

    kind = "setup-token-mit-rueckfall"

    def __init__(self, primary: SetupTokenDatei, fallback: ClaudeAnmeldungNurLesen):
        self.primary = primary
        self.fallback = fallback

    def aktiv(self):
        return self.primary if os.path.lexists(self.primary.path) else self.fallback

    def auth_headers(self) -> tuple[tuple[str, str], ...]:
        return self.aktiv().auth_headers()

    def status(self) -> dict[str, Any]:
        source = self.aktiv()
        return dict(source.status(), aktiv=source.kind, rueckfall=source is self.fallback)


@dataclass(frozen=True)
class ClaudeZug:
    """Unveraenderliche Beschreibung genau eines Claude-Code-Zuges."""

    claude_binary: str
    model: str
    prompt: str
    session_id: str
    config_dir: str
    resume: bool = False
    tools: tuple[str, ...] = ("Bash",)
    append_system_prompt: Optional[str] = None
    extra_env: tuple[tuple[str, str], ...] = field(default=())
    effort: Optional[str] = None
    append_system_prompt_file: Optional[str] = None
    settings_file: Optional[str] = None
    runner = RUNNER

    def __post_init__(self) -> None:
        if not Path(self.claude_binary).is_absolute():
            raise ClaudeAdapterFehler("Claude-Binary braucht einen absoluten Pfad")
        if not _MODEL.fullmatch(self.model):
            raise ClaudeAdapterFehler("Modellkennung ist ungueltig")
        if not isinstance(self.prompt, str) or not self.prompt.strip() or "\x00" in self.prompt:
            raise ClaudeAdapterFehler("Prompt fehlt")
        try:
            if str(uuid.UUID(self.session_id)) != self.session_id:
                raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise ClaudeAdapterFehler("Sitzungskennung muss eine kanonische UUID sein") from None
        if not Path(self.config_dir).is_absolute():
            raise ClaudeAdapterFehler("Claude-Konfigurationsordner braucht einen absoluten Pfad")
        if not isinstance(self.resume, bool):
            raise ClaudeAdapterFehler("resume muss boolesch sein")
        if not isinstance(self.tools, tuple) or not self.tools or set(self.tools) - ALLOWED_TOOLS:
            raise ClaudeAdapterFehler("Werkzeugliste enthaelt nicht freigegebene Werkzeuge")
        if self.append_system_prompt is not None and (
                not isinstance(self.append_system_prompt, str) or "\x00" in self.append_system_prompt):
            raise ClaudeAdapterFehler("Systemprompt-Ergaenzung ist ungueltig")
        if not isinstance(self.extra_env, tuple):
            raise ClaudeAdapterFehler("extra_env muss ein Tupel sein")
        for name, value in self.extra_env:
            if name not in ZUG_UMGEBUNG or not isinstance(value, str) or "\x00" in value or len(value) > 4096:
                raise ClaudeAdapterFehler("extra_env enthaelt eine nicht freigegebene Variable")
        if self.effort is not None and self.effort not in EFFORT_STUFEN:
            raise ClaudeAdapterFehler("Denkstufe muss low, medium, high, xhigh oder max sein")
        if self.settings_file is not None and (not isinstance(self.settings_file, str)
                                               or not Path(self.settings_file).is_absolute()):
            raise ClaudeAdapterFehler("Einstellungsdatei des Zuges braucht einen absoluten Pfad")
        if self.append_system_prompt_file is not None and (
                not isinstance(self.append_system_prompt_file, str) or not Path(self.append_system_prompt_file).is_absolute()):
            raise ClaudeAdapterFehler("Anweisungsdatei des Zuges braucht einen absoluten Pfad")

    def as_dict(self) -> dict[str, Any]:
        return {
            "claude_binary": self.claude_binary, "model": self.model, "prompt": self.prompt,
            "session_id": self.session_id, "config_dir": self.config_dir, "resume": self.resume,
            "tools": list(self.tools), "append_system_prompt": self.append_system_prompt,
            "extra_env": [list(pair) for pair in self.extra_env], "effort": self.effort,
            "append_system_prompt_file": self.append_system_prompt_file, "settings_file": self.settings_file,
        }

    def lese_pfade(self) -> tuple[Path, ...]:
        return (Path(self.claude_binary).parent,)


def zug_schreiben(zug: ClaudeZug, turn_dir: Path) -> Path:
    """Schreibt die Zugbeschreibung in einen Ordner, den der Launcher nur lesend einbindet."""
    turn_dir = Path(turn_dir)
    info = turn_dir.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ClaudeAdapterFehler("Zugordner muss eigener privater Ordner sein")
    target = turn_dir / "turn.json"
    atomar_schreiben.schreiben(target, json.dumps(zug.as_dict(), ensure_ascii=False, indent=2) + "\n",
                               modus=0o600, dauerhaft=True)
    return target


def start_spec(runtime_dir: Path, turn_file: Path, workspace: Path, runner: str = None) -> StartSpec:
    """Startet den Runner isoliert von PYTHON*-Umgebung und Benutzer-site."""
    return StartSpec(("/usr/bin/python3", "-I", str(Path(runtime_dir) / (runner or RUNNER)), str(turn_file)),
                     str(workspace), ())


@dataclass(frozen=True)
class StreamBefund:
    """Auswertung einer ``--output-format stream-json``-Ausgabe."""

    status: str  # completed | harness_error | truncated | unclear | empty
    detail: str
    session_id: Optional[str] = None
    result_text: Optional[str] = None
    subtype: Optional[str] = None
    terminal_reason: Optional[str] = None
    num_turns: Optional[int] = None
    tool_uses: tuple[str, ...] = ()
    events: int = 0
    api_error_status: Optional[int] = None
    rate_limit: Optional[dict[str, Any]] = None


def stream_befund(data: bytes, expected_session_id: Optional[str] = None) -> StreamBefund:
    """Erkennt Zugabschluss, abgeschnittene und unklare Ausgabe strikt."""
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
    session_ids = {event["session_id"] for event in events if "session_id" in event}
    session_id = next(iter(session_ids)) if len(session_ids) == 1 else None
    tool_uses: list[str] = []
    for event in events:
        if event.get("type") == "assistant":
            content = (event.get("message") or {}).get("content") or []
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_uses.append(str(block.get("name")))
    # Claude Code meldet eine Abo-Abweisung als rate_limit_event (status, resetsAt,
    # rateLimitType); der letzte abgewiesene Stand zaehlt.
    rate_limit = None
    for event in events:
        info = event.get("rate_limit_info") if event.get("type") == "rate_limit_event" else None
        if isinstance(info, dict) and info.get("status") == "rejected":
            rate_limit = {key: info.get(key) for key in ("status", "resetsAt", "rateLimitType")}
    api_status = next((event.get("api_error_status") for event in reversed(events)
                       if event.get("type") == "result" and isinstance(event.get("api_error_status"), int)), None)
    base = dict(session_id=session_id, tool_uses=tuple(tool_uses), events=len(events),
                api_error_status=api_status, rate_limit=rate_limit)
    if tail.strip():
        return StreamBefund("truncated", "letzte Zeile ohne Abschluss", **base)
    if not events:
        return StreamBefund("empty", "keine Ereignisse", **base)
    first = events[0]
    if first.get("type") != "system" or first.get("subtype") != "init":
        return StreamBefund("unclear", "Ausgabe beginnt nicht mit system/init", **base)
    if len(session_ids) != 1:
        return StreamBefund("unclear", "Sitzungskennung fehlt oder wechselt", **base)
    if expected_session_id is not None and session_id != expected_session_id:
        return StreamBefund("unclear", "Sitzungskennung passt nicht zum Zug", **base)
    results = [index for index, event in enumerate(events) if event.get("type") == "result"]
    if not results:
        return StreamBefund("truncated", "Stream endet ohne result-Ereignis", **base)
    if len(results) > 1:
        return StreamBefund("unclear", "mehrere result-Ereignisse", **base)
    if results[0] != len(events) - 1:
        return StreamBefund("unclear", "Ereignisse nach dem result-Ereignis", **base)
    result = events[-1]
    details = dict(result_text=result.get("result") if isinstance(result.get("result"), str) else None,
                   subtype=result.get("subtype"), terminal_reason=result.get("terminal_reason"),
                   num_turns=result.get("num_turns") if isinstance(result.get("num_turns"), int) else None)
    if result.get("is_error") is False and result.get("subtype") == "success" and \
            result.get("terminal_reason") == "completed":
        return StreamBefund("completed", "Zug abgeschlossen", **base, **details)
    if result.get("is_error") is True or result.get("subtype") not in {None, "success"}:
        return StreamBefund("harness_error", "Harness meldet Fehler", **base, **details)
    return StreamBefund("unclear", "result-Ereignis ohne eindeutigen Ausgang", **base, **details)


@dataclass(frozen=True)
class ZugUrteil:
    """Controllerurteil ueber einen Zug; nur ``erfolg`` darf ein Ergebnis annehmen."""

    # erfolg | gestoppt | kontingent | anmeldung | abgeschnitten | ergebnis_fehlt | harness_fehler | unklar
    status: str
    detail: str
    session_id: Optional[str] = None


def zug_urteil(befund: StreamBefund, exit_code: Optional[int], *, stop_requested: bool,
               ticket: Optional[Mapping[str, Any]], agent_id: str,
               result_revision_before: int, proxy_counts: Optional[Mapping[str, int]] = None,
               ergebnis_belegt: Optional[bool] = None) -> ZugUrteil:
    """Verbindet Stream, bestaetigten Exit, Steuerwunsch, Backendabweisung und Ergebnisnachweis.

    ``ergebnis_belegt`` ersetzt fuer Zuege ohne Ticket (Nachricht, Antwort) die Ticketpruefung.
    """
    session = befund.session_id
    counts = proxy_counts or {}
    if stop_requested:
        return ZugUrteil("gestoppt", "Sofortstopp; unterbrochene Arbeit ist nie ein Erfolg", session)
    if befund.status != "completed" or exit_code != 0:
        if befund.api_error_status == 429 or befund.rate_limit is not None or counts.get("429"):
            return ZugUrteil("kontingent", "Backend weist das Abo-Kontingent ab", session)
        if befund.api_error_status in {401, 403} or counts.get("401") or counts.get("403") \
                or counts.get("controller_auth_unavailable"):
            return ZugUrteil("anmeldung", "Anmeldung abgelaufen oder nicht verfuegbar", session)
    if befund.status in {"truncated", "empty"}:
        return ZugUrteil("abgeschnitten", befund.detail, session)
    if befund.status == "unclear":
        return ZugUrteil("unklar", befund.detail, session)
    if exit_code is None:
        return ZugUrteil("unklar", "Prozessende ohne bestaetigten Exitcode", session)
    if befund.status == "harness_error":
        return ZugUrteil("harness_fehler", "%s (%s)" % (befund.detail, befund.terminal_reason), session)
    if exit_code != 0:
        return ZugUrteil("unklar", "Stream meldet Abschluss, Prozess endete mit %d" % exit_code, session)
    if ergebnis_belegt is not None:
        if not ergebnis_belegt:
            return ZugUrteil("ergebnis_fehlt", "Zug abgeschlossen, aber keine belegte Antwort", session)
        return ZugUrteil("erfolg", "Zug abgeschlossen und Antwort belegt", session)
    revision = int((ticket or {}).get("result_revision") or 0)
    result = (ticket or {}).get("result") or {}
    if (ticket is None or ticket.get("state") != "zur Abnahme" or ticket.get("assignee") != agent_id
            or revision <= result_revision_before or result.get("agent") != agent_id):
        return ZugUrteil("ergebnis_fehlt", "Zug abgeschlossen, aber kein neues Ticketergebnis gespeichert", session)
    return ZugUrteil("erfolg", "Zug abgeschlossen und Ticketergebnis gespeichert", session)


def ausgabe_lesen(path: Path, max_bytes: int = 16 * 1024 * 1024) -> bytes:
    """Liest eine controllereigene Ausgabedatei begrenzt; zu grosse Ausgabe gilt als abgeschnitten."""
    try:
        descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return b""
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ClaudeAdapterFehler("Ausgabedatei ist keine regulaere Datei")
        data = stream.read(max_bytes + 1)
    return data[:max_bytes] + (b"\x00" if len(data) > max_bytes else b"")


def projekt_ordnername(cwd: str) -> str:
    """Ordnername, unter dem Claude Code Sitzungen eines Arbeitsordners ablegt."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


@dataclass(frozen=True)
class Uebergabe:
    world: str
    agent: str
    run_id: str
    session_id: str
    cwd: str
    relative_path: str
    sha256: str
    bytes: int
    created_at: float

    def as_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def _private_dir(path: Path, label: str) -> Path:
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ClaudeAdapterFehler("%s muss eigener privater Ordner sein" % label)
    return path


def _read_regular_nofollow(path: Path, max_bytes: int) -> bytes:
    for parent in (path.parent, path.parent.parent):
        if parent.is_symlink():
            raise ClaudeAdapterFehler("Sitzungspfad enthaelt einen Symlink")
    try:
        descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise ClaudeAdapterFehler("Sitzungsdatei fehlt oder ist ein Symlink") from exc
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise ClaudeAdapterFehler("Sitzungsdatei ist ungueltig oder zu gross")
        data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ClaudeAdapterFehler("Sitzungsdatei ist zu gross")
    return data


def uebergabe_sichern(config_dir: Path, session_id: str, cwd: str, store_dir: Path, *,
                      world: str, agent: str, run_id: str,
                      clock: Callable[[], float] = time.time) -> Uebergabe:
    """Kopiert den Sitzungsverlauf eines beendeten Zuges in die Controllerablage."""
    for value, label in ((world, "Welt"), (agent, "Agent"), (run_id, "Lauf")):
        if not _ID.fullmatch(value):
            raise ClaudeAdapterFehler("%s-Kennung ist ungueltig" % label)
    str(uuid.UUID(session_id))
    relative = Path("projects") / projekt_ordnername(cwd) / (session_id + ".jsonl")
    source = Path(config_dir) / relative
    data = _read_regular_nofollow(source, MAX_TRANSCRIPT_BYTES)
    if not data.endswith(b"\n"):
        # Ein beim Stop halb geschriebener letzter Eintrag ist nicht Teil der Uebergabe.
        data = data[:data.rfind(b"\n") + 1]
    if not data:
        raise ClaudeAdapterFehler("Sitzungsverlauf ist leer")
    target = _private_dir(Path(store_dir) / run_id, "Uebergabeordner")
    digest = hashlib.sha256(data).hexdigest()
    handoff = Uebergabe(world, agent, run_id, session_id, cwd, str(relative), digest, len(data), float(clock()))
    atomar_schreiben.schreiben(target / "transcript.jsonl", data, modus=0o600, dauerhaft=True)
    atomar_schreiben.schreiben(target / "uebergabe.json", json.dumps(handoff.as_dict(), indent=2) + "\n",
                               modus=0o600, dauerhaft=True)
    return handoff


def uebergabe_wiederherstellen(store_dir: Path, run_id: str, config_dir: Path, *, world: str,
                               agent: str, cwd: str) -> Uebergabe:
    """Legt einen gesicherten Verlauf in einen frischen Konfigurationsordner fuer ``--resume``."""
    source = Path(store_dir) / run_id
    try:
        meta = json.loads(_read_regular_nofollow(source / "uebergabe.json", MAX_CREDENTIAL_BYTES))
        handoff = Uebergabe(**meta)
    except (OSError, ValueError, TypeError) as exc:
        raise ClaudeAdapterFehler("Uebergabe ist unlesbar") from exc
    if (handoff.world, handoff.agent, handoff.cwd) != (world, agent, cwd):
        raise ClaudeAdapterFehler("Uebergabe gehoert zu anderer Welt, anderem Agenten oder Arbeitsordner")
    expected = Path("projects") / projekt_ordnername(cwd) / (handoff.session_id + ".jsonl")
    if handoff.relative_path != str(expected):
        raise ClaudeAdapterFehler("Uebergabepfad ist ungueltig")
    data = _read_regular_nofollow(source / "transcript.jsonl", MAX_TRANSCRIPT_BYTES)
    if hashlib.sha256(data).hexdigest() != handoff.sha256 or len(data) != handoff.bytes:
        raise ClaudeAdapterFehler("Uebergabe wurde veraendert")
    config_dir = _private_dir(Path(config_dir), "Claude-Konfigurationsordner")
    target = config_dir / expected
    _private_dir(config_dir / "projects", "Projektordner")
    _private_dir(target.parent, "Sitzungsordner")
    if target.exists() or target.is_symlink():
        raise ClaudeAdapterFehler("Zielsitzung existiert bereits; keine stille Uebernahme")
    atomar_schreiben.schreiben(target, data, modus=0o600, dauerhaft=True)
    return handoff


__all__ = [
    "ALLOWED_TOOLS", "ANTHROPIC_ORIGIN", "AnmeldungMitRueckfall", "AnmeldungNichtVerfuegbar", "ClaudeAdapterFehler",
    "ClaudeAnmeldungNurLesen", "ClaudeZug", "PLACEHOLDER_TOKEN", "RUNNER", "RUNTIME_MODULES",
    "SetupTokenDatei", "StreamBefund", "Uebergabe", "ZugUrteil", "ausgabe_lesen",
    "projekt_ordnername", "start_spec", "stream_befund", "uebergabe_sichern",
    "uebergabe_wiederherstellen", "zug_schreiben", "zug_urteil",
]
