#!/usr/bin/env python3
"""Traeger genau einer Welt: Zustellung beanspruchen, einen Zug starten, Ergebnis annehmen, quittieren.

Der Traeger setzt Datenvertrag (``agents_data``), Weckervertrag (``agents_wecker``) und
Laufvertrag (``agents_lauf``) zusammen. Er laeuft nur, solange ein Zug laeuft oder eine
Zustellung beansprucht werden kann, und beendet sich danach. ``wecken`` startet ihn als
transiente systemd-User-Unit ohne App und ohne dauerhaft aktivierten Dienst.

Zustellwege: Tickets, adressierte Kanal- und Direktnachrichten, beantwortete Fragen sowie
Selbstwecker und Recovery aus dem Weckervertrag. Nur Adressierte werden geweckt.

Pause sperrt neue Starts; ein laufender Zug endet an seinem Zugende. Sofortstopp beendet
den Lauf samt Kindern, erzeugt unterbrochene Arbeit und weckt den Agenten nie selbst
wieder. Erst ``agent-fortsetzen`` oder ``welt-fortsetzen`` oeffnet unterbrochene Arbeit
mit neuer Zustellung; der naechste Zug setzt dieselbe Sitzung aus der Uebergabe fort.

Ein erschoepftes Kontingent oder eine fehlende Anmeldung legt den Agenten bis zur naechsten
erlaubten Startzeit schlafen. Ein Selbstwecker setzt die Arbeit danach mit demselben Modell
fort; der Traeger waehlt nie eine schwaechere Stufe.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402
import agents_skills as ask  # noqa: E402
import agents_worktree as aw  # noqa: E402
import agents_zugaenge as az  # noqa: E402
import atomar_schreiben  # noqa: E402
from agents_claude import (  # noqa: E402
    RUNTIME_MODULES, AnmeldungMitRueckfall, AnmeldungNichtVerfuegbar, ClaudeAdapterFehler, ClaudeAnmeldungNurLesen,
    ALLOWED_TOOLS, ClaudeZug,
    SetupTokenDatei, stream_befund, uebergabe_sichern, uebergabe_wiederherstellen, zug_urteil,
)
from agents_denkstufe import DenkstufeFehler, denkstufe_argumente, registry_laden  # noqa: E402
from agents_pi import PiZug, pi_befund, pi_werkzeuge  # noqa: E402
from agents_codex import CodexAnmeldung, CodexZug, codex_eintrag  # noqa: E402
from agents_kontingent import RECHECK_S, KontingentQuelle, Startfreigabe  # noqa: E402
from agents_lauf import LaufFehler, LaunchReceipt, RunController  # noqa: E402
from agents_wecker import Delivery, WeckerController, WeckerFehler  # noqa: E402
from agents_modellwahl import abo as modell_abo, ist_fable  # noqa: E402

WELT_ZUSTAND = {"läuft": "running", "pausiert": "paused", "gestoppt": "stopped"}
AGENT_ZUSTAND = {"aktiv": "running", "pausiert": "paused", "gestoppt": "stopped", "archiviert": "stopped"}
NACHRICHT_ARTEN = ("kanal", "direktchat", "ticket-ergebnis")
RECOVERY_URTEILE = frozenset({"abgeschnitten", "harness_fehler", "ergebnis_fehlt", "unklar", "zeitlimit", "startfehler"})
SCHLAF_URTEILE = frozenset({"kontingent", "anmeldung"})
RECOVERY_ABSTAND_S = 300.0
# Ein lokales Modell, das nicht frei ist („belegt“), wird nach dieser Zeit neu geprueft.
BELEGT_ABSTAND_S = 300.0
# Skills- und Profil-Sperre (docs/AGENTS-SPERREN.md) samt Pruefkern und Hausliste gesperrter Programme.
SPERR_DATEIEN = ("skills-sperre.sh", "profil-sperre.sh", "lib/cmdshell.py", "lib/skills_sperre.py",
                 "lib/profil_sperre.py", "lib/reviewer_sperre.py", "lib/rollen.py", "wb-profil",
                 "wb-profil-gesperrt.json")
RPC_MODULE = ("agents_rpc_client.py", "agents_controller.py", "agents_data.py", "atomar_schreiben.py")
# Gespeichertes Skript der Bibliothek, das den Lernschritt schreibt; Prompt und Anweisung nennen es, wenn der Agent es hat.
LERNSKRIPT = "lernschritt-schreiben"
NACHRICHTEN_SITZUNG = "__nachrichten__"
_MODELL = re.compile(r"claude-[a-z0-9.-]{3,100}\Z")
_VERSION = 1


class TraegerFehler(Exception):
    """Abgelehnte Traegerkonfiguration oder -operation."""


def _private_dir(path: Path, label: str) -> Path:
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise TraegerFehler("%s muss eigener privater Ordner sein" % label)
    return path


def _inside(path: Path, root: Path) -> bool:
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def _epoch(value: str | None, fallback: float) -> float:
    try:
        return _dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return fallback


@contextlib.contextmanager
def _flock(path: Path, *, blocking: bool = True) -> Iterator[bool]:
    path.touch(mode=0o600, exist_ok=True)
    with path.open("r+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@dataclass(frozen=True)
class TraegerOrte:
    state: Path
    agents: Path

    def __getattr__(self, name: str) -> Path:
        files = {
            "runs": "runs.json", "wecker": "wecker.json", "zuege": "zuege.json", "launcher": "launcher",
            "output": "output", "sockets": "sockets", "turns": "turns", "handoffs": "handoffs",
            "runtime": "runtime", "traeger_lock": "traeger.lock", "wecken_lock": "wecken.lock",
            "exiting": "traeger.exiting", "log": "traeger.log",
        }
        if name in files:
            return self.state / files[name]
        raise AttributeError(name)


@dataclass(frozen=True)
class TraegerKonfig:
    world_root: Path
    state_dir: Path
    agents_dir: Path
    claude_binary: str
    execution_host: str
    anmeldung: dict[str, Any]
    backend: dict[str, Any] = field(default_factory=lambda: {"kind": "anthropic"})
    unit_prefix: str = "wb-agents-linux-claude-"
    modelle: dict[str, str] = field(default_factory=dict)
    zug_frist_s: float = 900.0
    tools: tuple[str, ...] = ("Bash",)
    launcher: dict[str, str] = field(default_factory=dict)
    python: str = "/usr/bin/python3"
    kontingent: Optional[dict[str, Any]] = None
    systemd: Optional[dict[str, str]] = None
    skill_bibliothek: Optional[str] = None
    registry: Optional[str] = None
    pi: Optional[dict[str, Any]] = None
    sperren: bool = True
    codex: Optional[dict[str, Any]] = None

    def __post_init__(self) -> None:
        for name in ("world_root", "state_dir", "agents_dir"):
            value = Path(getattr(self, name))
            if not value.is_absolute():
                raise TraegerFehler("%s braucht einen absoluten Pfad" % name)
            object.__setattr__(self, name, value)
        if _inside(self.state_dir, self.agents_dir) or _inside(self.agents_dir, self.state_dir):
            raise TraegerFehler("Controllerzustand und Agentenbereiche duerfen sich nicht ueberlappen")
        if _inside(self.world_root, self.agents_dir):
            raise TraegerFehler("Weltablage darf nicht in Agentenbereichen liegen")
        if self.anmeldung.get("kind") not in {"claude-login-readonly", "setup-token"}:
            raise TraegerFehler("Unbekannte Anmeldequelle")
        rueckfall = self.anmeldung.get("rueckfall")
        if rueckfall is not None and (self.anmeldung["kind"] != "setup-token" or not isinstance(rueckfall, dict)
                                      or rueckfall.get("kind") != "claude-login-readonly"):
            raise TraegerFehler("Rueckfall gibt es nur vom Setup-Token auf die Nur-Lese-Anmeldung")
        if self.backend.get("kind") not in {"anthropic", "local-fixture"}:
            raise TraegerFehler("Unbekanntes Modellbackend")
        if self.kontingent is not None and (not isinstance(self.kontingent, dict) or set(self.kontingent) - {
                "budget", "kontingent", "harness", "timeout_s", "limits", "max_alter_s"}):
            raise TraegerFehler("Kontingentkonfiguration ist ungueltig")
        for name in ("skill_bibliothek", "registry"):
            if getattr(self, name) is not None and not Path(getattr(self, name)).is_absolute():
                raise TraegerFehler("%s braucht einen absoluten Pfad" % name)
        if self.pi is not None:
            if not isinstance(self.pi, dict) or set(self.pi) - {"node", "cli", "base_url", "api", "modelle"} \
                    or not all(Path(str(self.pi.get(k) or "")).is_absolute() for k in ("node", "cli")) \
                    or not isinstance(self.pi.get("modelle"), dict) or not str(self.pi.get("base_url", "")).startswith(
                        ("http://127.0.0.1:", "http://[::1]:")):
                raise TraegerFehler("Pi-Konfiguration braucht node, cli, base_url auf Loopback und modelle")
        if not isinstance(self.sperren, bool):
            raise TraegerFehler("sperren muss boolesch sein")
        if self.codex is not None and (not isinstance(self.codex, dict) or set(self.codex) - {"cli", "auth"}
                                       or not all(Path(str(self.codex.get(k) or "")).is_absolute() for k in ("cli", "auth"))):
            raise TraegerFehler("Codex-Konfiguration braucht cli und auth als absolute Pfade")
        object.__setattr__(self, "tools", tuple(self.tools))

    @classmethod
    def laden(cls, path: str | os.PathLike[str]) -> "TraegerKonfig":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.pop("version", None) != _VERSION:
            raise TraegerFehler("Traegerkonfiguration hat unbekannte Version")
        # Eine in der Weltablage liegende Konfiguration nennt zusaetzlich Maschine und Modulpfad.
        data.pop("maschine", None)
        data.pop("traeger_modul", None)
        return cls(**data)

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": _VERSION, "world_root": str(self.world_root), "state_dir": str(self.state_dir),
            "agents_dir": str(self.agents_dir), "claude_binary": self.claude_binary,
            "execution_host": self.execution_host, "anmeldung": dict(self.anmeldung), "backend": dict(self.backend),
            "unit_prefix": self.unit_prefix, "modelle": dict(self.modelle), "zug_frist_s": self.zug_frist_s,
            "tools": list(self.tools), "launcher": dict(self.launcher), "python": self.python,
            "kontingent": dict(self.kontingent) if self.kontingent is not None else None,
            "systemd": dict(self.systemd) if self.systemd is not None else None,
            "skill_bibliothek": self.skill_bibliothek, "registry": self.registry,
            "pi": dict(self.pi) if self.pi is not None else None, "sperren": self.sperren,
            "codex": dict(self.codex) if self.codex is not None else None,
        }

    def orte(self) -> TraegerOrte:
        return TraegerOrte(self.state_dir, self.agents_dir)

    def anmeldequelle(self):
        return self._anmeldequelle(self.anmeldung)

    @staticmethod
    def _anmeldequelle(spec: dict[str, Any]):
        path = spec.get("path")
        if spec["kind"] == "setup-token":
            primary = SetupTokenDatei(path)
            if spec.get("rueckfall") is None:
                return primary
            return AnmeldungMitRueckfall(primary, TraegerKonfig._anmeldequelle(spec["rueckfall"]))
        return ClaudeAnmeldungNurLesen(path, min_valid_seconds=float(spec.get("min_valid_seconds", 900)))

    def kontingentquelle(self) -> Optional[KontingentQuelle]:
        if self.kontingent is None:
            return None
        # Nicht genannte Werkzeuge bleiben aus: auf einem Traegerhost gilt nur, was die Konfiguration nennt.
        return KontingentQuelle(self.kontingent.get("budget"), self.kontingent.get("kontingent"),
                                harness=self.kontingent.get("harness", "claude"),
                                timeout=float(self.kontingent.get("timeout_s", 20)),
                                limits_path=self.kontingent.get("limits"),
                                max_alter_s=float(self.kontingent.get("max_alter_s", 3600)))

    def backend_fuer(self, model: str, harness: str = "claude"):
        from agents_model_proxy import BackendConfig
        if harness == "pi":
            # Lokale Inferenz auf demselben Host; der lokale Server bekommt nie eine Abo-Anmeldung.
            return BackendConfig("lokal", model, str(self.pi.get("api") or "openai-completions"), "local",
                                 str(self.pi["base_url"]), self.execution_host, self.execution_host,
                                 (("Authorization", "Bearer wb-agents-lokal"),), True)
        if self.backend["kind"] == "local-fixture":
            return BackendConfig("anthropic", model, "anthropic-messages", "local", self.backend["base_url"],
                                 self.execution_host, self.execution_host, (), True)
        from agents_claude_lauf import anthropic_backend
        return anthropic_backend(model, self.execution_host)


def traeger_unit(konfig: TraegerKonfig) -> str:
    digest = hashlib.sha256(str(konfig.world_root).encode("utf-8")).hexdigest()[:16]
    return "wb-agents-traeger-%s.service" % digest


def zeitgeber_unit(konfig: TraegerKonfig) -> str:
    return traeger_unit(konfig).replace(".service", "-wecker")


def _claude_lauf_fabrik(traeger: "WeltTraeger", *, agent_id: str, run_id: str, zug: ClaudeZug,
                        workspace: Path, agent_state: Path, extra_read_paths: tuple[Path, ...] = (),
                        netz: bool = False, extra_write_paths: tuple[Path, ...] = (),
                        git_einbindung: Optional[dict[str, Any]] = None):
    from agents_claude_lauf import ClaudeLauf, LaufOrte
    k, orte = traeger.konfig, traeger.orte
    lauf_orte = LaufOrte(orte.runs, orte.launcher, orte.output, orte.sockets, orte.turns, orte.runtime)
    if isinstance(zug, CodexZug):
        # Trockenlauf: Aufruf und Anmeldeweg sind gebaut, der Modelltransport mit der Codex-Anmeldung nicht.
        raise TraegerFehler("Codex-Zug ist nur als Trockenlauf gebaut; Modelltransport mit Codex-Anmeldung fehlt")
    pi = isinstance(zug, PiZug)
    return ClaudeLauf(lauf_orte, world_root=k.world_root, agent_id=agent_id, run_id=run_id, workspace=workspace,
                      agent_state=agent_state, zug=zug, backend=k.backend_fuer(zug.model, "pi" if pi else "claude"),
                      auth_headers=None if pi else traeger.anmeldequelle.auth_headers, extra_read_paths=extra_read_paths,
                      launcher_options=dict(k.launcher, **({"git_einbindung": git_einbindung} if git_einbindung
                                                           else {})), unit_prefix=k.unit_prefix, netz=netz,
                      extra_write_paths=extra_write_paths)


PROJEKT_ARBEITSORDNER = "work"


def projekt_pfade(world_root: Path) -> tuple[Optional[Path], Optional[Path]]:
    """Projektwurzel der Welt und ihr gemeinsamer Ordner ``work/`` (der Nutzer, 15.09.2026: jeder Agent sieht
    das Projekt, geschrieben wird im eigenen Ordner und in ``work/``).

    Die Wurzel wird nur lesbar eingebunden, ``work/`` beschreibbar; der Ordner entsteht beim ersten Zug.
    Ohne Projekt (Welt ausserhalb von ``<projekt>/.werkbank/agents``) gibt es beides nicht."""
    projekt = ask.world_project(world_root)
    if projekt is None or not projekt.is_dir():
        return None, None
    projekt = projekt.resolve(strict=True)
    if projekt in (Path("/"), Path.home()):
        return None, None
    arbeit = projekt / PROJEKT_ARBEITSORDNER
    if arbeit.is_symlink():
        raise TraegerFehler("%s ist ein Symlink; der gemeinsame Ordner muss ein echter Ordner sein" % arbeit)
    arbeit.mkdir(mode=0o700, exist_ok=True)
    return projekt, arbeit


def _lokal_erreichbar(base_url: str, timeout: float = 1.0) -> bool:
    """Vorgabe fuer „belegt“: der lokale Modellserver nimmt auf seinem Loopback-Port eine Verbindung an."""
    from urllib.parse import urlsplit
    teile = urlsplit(base_url)
    try:
        with socket.create_connection((teile.hostname or "127.0.0.1", teile.port or 80), timeout=timeout):
            return True
    except OSError:
        return False


def _claude_observer(traeger: "WeltTraeger"):
    from agents_claude_lauf import ClaudeZugLauncher
    k, orte = traeger.konfig, traeger.orte
    _private_dir(orte.launcher, "Launcherordner")
    _private_dir(orte.output, "Ausgabeordner")
    return ClaudeZugLauncher(orte.launcher, output_dir=orte.output, unit_prefix=k.unit_prefix, **dict(k.launcher))


def _claude_ausgabe(traeger: "WeltTraeger", receipt) -> bytes:
    from agents_claude import ausgabe_lesen
    stdout, _ = traeger.observer().output_paths(receipt)
    return ausgabe_lesen(stdout)


@dataclass(frozen=True)
class Posten:
    """Eine beanspruchbare Zustellung eines Agenten mit ihrer Zugart."""

    delivery: Delivery
    art: str                      # ticket | nachricht | antwort | fortsetzen | aufwachen
    ticket_id: Optional[str] = None
    nachricht_id: Optional[str] = None
    frage_id: Optional[str] = None
    grund: Optional[str] = None
    postfach_id: Optional[str] = None


def _inhalt(art: str, **werte: Any) -> str:
    return json.dumps(dict(werte, art=art), sort_keys=True, ensure_ascii=False)


class WeltTraeger:
    """Traeger fuer eine Welt; Start, Beobachtung, Ausgabe, Kontingent und Zeitgeber sind austauschbar."""

    def __init__(self, konfig: TraegerKonfig, *, zug_fabrik: Callable[..., Any] = _claude_lauf_fabrik,
                 observer_fabrik: Callable[["WeltTraeger"], Any] = _claude_observer,
                 ausgabe: Callable[["WeltTraeger", Any], bytes] = _claude_ausgabe,
                 anmeldequelle: Any = None, kontingentquelle: Any = "konfig",
                 zeitgeber: Optional[Callable[[Optional[float]], Any]] = None,
                 clock: Callable[[], float] = time.time, runtime_quelle: Optional[Path] = None,
                 lokal_frei: Optional[Callable[[str], bool]] = None):
        self.konfig = konfig
        self._lokal_frei_pruefer = lokal_frei or _lokal_erreichbar
        self.orte = konfig.orte()
        self.root = konfig.world_root
        self._zug_fabrik = zug_fabrik
        self._observer_fabrik = observer_fabrik
        self._ausgabe = ausgabe
        self.anmeldequelle = anmeldequelle if anmeldequelle is not None else konfig.anmeldequelle()
        self.kontingentquelle = konfig.kontingentquelle() if kontingentquelle == "konfig" else kontingentquelle
        self._zeitgeber = zeitgeber
        self._clock = clock
        self.laeufe: dict[str, Any] = {}
        _private_dir(self.orte.state, "Traegerzustand")
        _private_dir(self.orte.agents, "Agentenbereich")
        for name in ("handoffs", "turns", "sockets"):
            _private_dir(getattr(self.orte, name), name)
        self.wecker = WeckerController(self.orte.wecker, clock=clock)
        self._runtime_bereitstellen(runtime_quelle or Path(__file__).resolve().parent)

    # Grundlagen ------------------------------------------------------------------
    def observer(self):
        return self._observer_fabrik(self)

    def runs(self) -> RunController:
        return RunController(self.orte.runs, launcher=self.observer(), clock=self._clock)

    def world_id(self) -> str:
        return ad.read_world(self.root)["id"]

    def _now(self) -> float:
        return float(self._clock())

    def _runtime_bereitstellen(self, quelle: Path) -> None:
        runtime = _private_dir(self.orte.runtime, "Laufzeitordner")
        if self.konfig.sperren:
            # Die Sperr-Hooks laufen im Zug; ihre Dateien und die Hausliste liegen nur lesend in der Laufzeit.
            hooks = Path(quelle).parent / "hooks"
            for rel in SPERR_DATEIEN:
                source = hooks / rel if not rel.startswith("wb-profil") else Path(quelle) / rel
                if not source.is_file():
                    raise TraegerFehler("Sperrdatei fehlt: %s" % source)
                target = runtime / ("hooks" if not rel.startswith("wb-profil") else "") / rel
                _private_dir(target.parent, "Hookordner")
                data = source.read_bytes()
                if not target.exists() or target.read_bytes() != data:
                    atomar_schreiben.schreiben(target, data, modus=0o700 if rel.endswith(".sh") else 0o600,
                                               dauerhaft=True)
        for name in RUNTIME_MODULES:
            data = (quelle / name).read_bytes()
            target = runtime / name
            if not target.exists() or target.read_bytes() != data:
                atomar_schreiben.schreiben(target, data, modus=0o600, dauerhaft=True)
        # Lesende Postfachwerkzeuge fuer Mail-Zugaenge (agents_zugaenge.MAIL_WERKZEUGE): ihre Huelle im Zug ruft sie
        # ueber den Interpreter, deshalb reicht 0600. Fehlt eines an der Quelle, gibt es dafuer keine Huelle.
        for name in az.MAIL_WERKZEUGE:
            source = quelle / name
            if not source.is_file():
                continue
            data = source.read_bytes()
            target = runtime / name
            if not target.exists() or target.read_bytes() != data:
                atomar_schreiben.schreiben(target, data, modus=0o600, dauerhaft=True)

    @contextlib.contextmanager
    def _zuege(self) -> Iterator[dict[str, Any]]:
        with _flock(self.orte.state / "zuege.lock"):
            state = self._zuege_lesen()
            yield state
            atomar_schreiben.schreiben(self.orte.zuege, json.dumps(state, ensure_ascii=False, indent=2,
                                                                   sort_keys=True) + "\n", modus=0o600,
                                       dauerhaft=True)

    def _zuege_lesen(self) -> dict[str, Any]:
        if not self.orte.zuege.exists():
            return {"version": _VERSION, "runs": {}, "sessions": {}, "schlaf": {}, "zaehler": {}, "fallback": {}}
        state = json.loads(self.orte.zuege.read_text(encoding="utf-8"))
        if state.get("version") != _VERSION:
            raise TraegerFehler("Zugregister hat unbekannte Version")
        for name in ("sessions", "schlaf", "zaehler", "fallback"):
            state.setdefault(name, {})
        return state

    def _run_record(self, run_id: str) -> Optional[dict[str, Any]]:
        if not self.orte.runs.exists():
            return None
        return json.loads(self.orte.runs.read_text(encoding="utf-8"))["runs"].get(run_id)

    def _registry(self) -> Optional[dict[str, Any]]:
        """Modellregistry, je Aenderungszeit einmal gelesen."""
        if not self.konfig.registry:
            return None
        try:
            mtime = os.stat(self.konfig.registry).st_mtime_ns
        except OSError:
            return None
        cached = getattr(self, "_registry_cache", None)
        if cached is None or cached[0] != mtime:
            cached = (mtime, registry_laden(self.konfig.registry))
            self._registry_cache = cached
        return cached[1]

    def harness(self, agent: dict[str, Any]) -> str:
        """``pi`` fuer ein lokales Modell aus der Pi-Konfiguration, ``codex`` fuer ein Codex-Modell der Registry,
        sonst ``claude``."""
        name = str((agent.get("model_profile") or {}).get("model") or "")
        if self.konfig.pi is not None and name in self.konfig.pi["modelle"]:
            return "pi"
        return "codex" if codex_eintrag(self._registry(), name) is not None else "claude"

    def modell(self, agent: dict[str, Any]) -> Optional[str]:
        name = str((agent.get("model_profile") or {}).get("model") or "")
        harness = self.harness(agent)
        if harness == "pi":
            return str((self.konfig.pi["modelle"][name] or {}).get("id") or name)
        if harness == "codex":
            return str(codex_eintrag(self._registry(), name)["modelRef"])
        name = self.konfig.modelle.get(name, name)
        return name if _MODELL.fullmatch(name) else None

    def denkstufe(self, agent: dict[str, Any], model: str, harness: str = "claude") -> tuple[Optional[str], dict[str, Any]]:
        """Stufe aus dem Profil als Stufe des Harness; die Registry kann sie nur senken.

        Fuer Codex ist ``model`` die Registry-Kennung, die Stufe geht als ``--config model_reasoning_effort``."""
        stufe = (agent.get("model_profile") or {}).get("effort")
        try:
            args, befund = denkstufe_argumente(harness, stufe, modell=model, registry=self._registry())
        except DenkstufeFehler as exc:
            return None, {"harness": harness, "angefragt": stufe, "wirksam": None, "grund": str(exc)}
        if not args:
            return None, befund
        return (args[1].split("=", 1)[1] if harness == "codex" else args[1]), befund

    def _rpc_bereitstellen(self, run_dir: Path) -> Path:
        """RPC-Client im Zugordner: die Profil-Sperre erlaubt dem Agenten nur Pfade seiner Welt und seines Zuges.

        Die Kopie ist nur ein Client; die Grenze bleibt der gebundene Controllersocket."""
        folder = _private_dir(run_dir / "rpc", "RPC-Ordner")
        for name in RPC_MODULE:
            atomar_schreiben.schreiben(folder / name, (self.orte.runtime / name).read_bytes(), modus=0o600)
        return folder / "agents_rpc_client.py"

    def _zugumgebung(self, agent_id: str, workspace: Path, run_dir: Path, rpc: Path,
                     skills: bool) -> list[tuple[str, str]]:
        """Umgebung nach docs/AGENTS-SPERREN.md plus Zugordner, RPC-Client und Hausliste."""
        env = ask.profil_umgebung(self.root, agent_id, worktree=workspace, tmp=run_dir)
        if skills:
            env.update(ask.skills_umgebung(self.root, agent_id))
        env.update({"WB_AGENT_ZUG": str(run_dir), "WB_RPC_CLIENT": str(rpc),
                    "WB_PROFIL_BIN": str(self.orte.runtime / "wb-profil")})
        return sorted((key, value) for key, value in env.items() if value)

    def _sperr_einstellungen(self, zugang: Optional[az.Bereitstellung] = None,
                             git: Optional[dict[str, str]] = None) -> dict[str, Any]:
        """Zug-eigene Claude-Code-Einstellungen mit Skills- und Profil-Sperre aus den Snippets.

        Mit Zugaengen stehen deren Huellen vorn im PATH von Bash und Hooks, und ``WB_ZUGAENGE`` nennt der
        Profil-Sperre den Zugangsordner; ``extra_env`` des Zuges kennt beides nicht. Mit Worktree kommen die
        Git-Einstellungen des Zuges dazu (``agents_worktree.Arbeitsbaum.git_umgebung``: Hooks aus, Identitaet)."""
        hooks = self.orte.runtime / "hooks"

        def eintrag(matcher: str, name: str) -> dict[str, Any]:
            return {"matcher": matcher, "hooks": [{"type": "command", "timeout": 10,
                                                   "command": 'bash "%s"' % (hooks / name)}]}
        skills = [eintrag(m, "skills-sperre.sh") for m in ("Bash", "Skill", "Read|Grep|Glob",
                                                          "Write|Edit|MultiEdit|NotebookEdit")]
        settings: dict[str, Any] = {"hooks": {"PreToolUse": skills + [eintrag("*", "profil-sperre.sh")]}}
        if zugang is not None:
            settings["env"] = {"PATH": "%s:/usr/local/bin:/usr/bin:/bin" % zugang.ordner,
                               "WB_ZUGAENGE": str(zugang.ordner)}
        if git:
            settings.setdefault("env", {}).update(git)
        return settings

    def _zugaenge_aufraeumen(self) -> list[str]:
        """Loescht Zugangskopien jedes Zugordners, dessen Zug beendet ist oder nicht mehr im Register steht.

        Faengt einen Absturz zwischen Zugende und ``close`` ab; ein laufender Zug behaelt seine Kopien."""
        if not self.orte.turns.is_dir():
            return []
        runs = self._zuege_lesen()["runs"]
        removed = []
        for folder in sorted(self.orte.turns.iterdir()):
            entry = runs.get(folder.name)
            if entry is not None and entry.get("outcome") is None:
                continue
            with contextlib.suppress(OSError):
                if az.aufraeumen(folder):
                    removed.append(folder.name)
        return removed

    def _skills(self, agent_id: str) -> tuple[Optional[dict[str, Any]], Optional[str]]:
        """Schreibt ``skills.json`` vor dem Zug; ein Fehler startet den Zug ohne Skills und bleibt sichtbar."""
        try:
            return ask.write_skill_directory(self.root, agent_id, self.konfig.skill_bibliothek)[0], None
        except (ad.AgentsError, OSError, ValueError) as exc:
            return None, "%s: %s" % (type(exc).__name__, str(exc)[:200])

    def arbeitsorte(self, agent_id: str) -> tuple[Path, Path]:
        base = _private_dir(self.orte.agents / ad.valid_id(agent_id, "Agentenkennung"), "Agentenordner")
        return _private_dir(base / "work", "Arbeitsordner"), _private_dir(base / "state", "Agentenzustand")

    def arbeitsbaum(self, agent_id: str, arbeitsordner: Path) -> tuple[Optional[aw.Arbeitsbaum], Optional[str]]:
        """Worktree des Agenten im git-Projekt der Welt (agents_worktree, der Nutzer 16.09.2026).

        Ohne git-Projekt ``(None, None)``. Laesst er sich nicht anlegen oder pruefen, laeuft der Zug wie ohne
        git-Projekt, und der Grund steht als ``worktree_fehler`` im Zug und in der Anweisung."""
        try:
            projekt = ask.world_project(self.root)
            if projekt is None or not projekt.is_dir():
                return None, None
            projekt = projekt.resolve(strict=True)
            if projekt in (Path("/"), Path.home()):
                return None, None
            return aw.bereitstellen(projekt, arbeitsordner, agent_id), None
        except Exception as exc:  # noqa: BLE001 - der Zug laeuft ohne Worktree weiter, der Grund bleibt sichtbar
            return None, "%s: %s" % (type(exc).__name__, str(exc)[:200])

    def _uebergabe_cwd(self, handoff_run: str) -> Optional[str]:
        try:
            return json.loads((self.orte.handoffs / handoff_run / "uebergabe.json").read_text(encoding="utf-8"))["cwd"]
        except (OSError, ValueError, KeyError, TypeError):
            return None

    # Zustellwege -----------------------------------------------------------------
    def _kette(self, sender: Optional[str], zeit: Optional[str]) -> tuple[Optional[str], tuple[str, ...]]:
        """Bindet eine Nachricht an den Zug, in dem ihr Absender sie geschrieben hat."""
        if not sender:
            return None, ()
        moment = _epoch(zeit, -1.0)
        best = None
        for entry in self._zuege_lesen()["runs"].values():
            if entry.get("agent") != sender:
                continue
            # Nachrichtenzeiten sind auf Sekunden abgeschnitten: eine im Zug geschriebene Nachricht
            # liegt hoechstens eine Sekunde vor dem Zugbeginn, nie nach dem Zugende.
            start = float(entry.get("started_at") or 0) - 1.0
            end = float(entry.get("ended_at") or self._now())
            if start <= moment <= end and (best is None or entry["started_at"] > best["started_at"]):
                best = entry
        if best is None:
            return None, ()
        return best["delivery_id"], tuple(best.get("chain") or ()) + (best["delivery_id"],)

    def _posten(self, world_id: str, agent_id: str) -> list[Posten]:
        items: dict[str, Posten] = {}
        questions = ad.list_questions(self.root)
        antraege = {ad.derived_id("antrag", q["id"]): q for q in questions if q.get("kind") == ad.AGENT_REQUEST_KIND}
        entscheide = {ad.derived_id("antrag-entschieden", q["id"]) for q in questions
                      if q.get("kind") == ad.AGENT_REQUEST_KIND}
        folder = ad._agent_dir(self.root, agent_id) / "postfach"
        for path in sorted(folder.glob("*.json")) if folder.is_dir() else []:
            if path.is_symlink():
                continue
            data = ad._read_json(path)
            if data.get("acknowledged") or data.get("recipient") != agent_id:
                continue
            postfach_id = data["delivery_id"]
            # Postfachkennungen gelten je Empfaenger (ein Rundruf traegt ueberall dieselbe); der
            # Wecker braucht eine weltweit eindeutige Kennung je Agent und Zustellung.
            delivery_id = self._wecker_id(agent_id, postfach_id)
            due = _epoch(data.get("time"), 0.0)
            if data.get("kind") == "ticket":
                delivery = Delivery(delivery_id, world_id, agent_id, "ticket", due,
                                    _inhalt("ticket", ticket_id=data["ticket_id"], postfach_id=postfach_id))
                items[delivery_id] = Posten(delivery, "ticket", ticket_id=data["ticket_id"], postfach_id=postfach_id)
            elif data.get("kind") in NACHRICHT_ARTEN and data.get("sender") != agent_id:
                # Antworten und Ticketergebnisse werden gelesen, verlangen aber keine Gegenantwort;
                # sonst weckten sich zwei Agenten bis zur Kettengrenze gegenseitig.
                art = "rueckmeldung" if (data.get("kind") == "ticket-ergebnis" or data.get("subject") == "Antwort"
                                         or postfach_id in entscheide) else "nachricht"
                # Ein Antrag auf einen neuen Agenten verlangt eine Entscheidung statt einer Antwort.
                antrag = antraege.get(postfach_id)
                frage_id = None
                if antrag is not None and antrag.get("to") == agent_id and antrag.get("sender") == data.get("sender"):
                    art, frage_id = "antrag", antrag["id"]
                caused_by, chain = self._kette(data.get("sender"), data.get("time"))
                content = _inhalt(art, nachricht_id=postfach_id, frage_id=frage_id) if frage_id else \
                    _inhalt(art, nachricht_id=postfach_id)
                delivery = Delivery(delivery_id, world_id, agent_id, "fresh_message", due, content, caused_by, chain)
                items[delivery_id] = Posten(delivery, art, nachricht_id=postfach_id, frage_id=frage_id,
                                            postfach_id=postfach_id)
        for question in questions:
            # Die Entscheidung ueber einen Agentenantrag erreicht den Teamleiter als Direktnachricht.
            if question.get("sender") != agent_id or question.get("state") != "beantwortet" \
                    or question.get("kind") == ad.AGENT_REQUEST_KIND:
                continue
            delivery_id = self._wecker_id(agent_id, "antwort-" + question["id"])
            due = _epoch((question.get("answer") or {}).get("answered_at"), 0.0)
            delivery = Delivery(delivery_id, world_id, agent_id, "fresh_message", due,
                                _inhalt("antwort", frage_id=question["id"]))
            items[delivery_id] = Posten(delivery, "antwort", frage_id=question["id"])
        for delivery, _status in self.wecker.offene(world_id, agent_id):
            if delivery.delivery_id in items:
                continue
            try:
                content = json.loads(delivery.content)
            except ValueError:
                continue
            art = content.get("art")
            if art in {"fortsetzen", "aufwachen", "nachricht", "rueckmeldung", "antwort", "antrag"}:
                items[delivery.delivery_id] = Posten(delivery, art, ticket_id=content.get("ticket_id"),
                                                     nachricht_id=content.get("nachricht_id"),
                                                     frage_id=content.get("frage_id"), grund=content.get("grund"))
        return sorted(items.values(), key=lambda item: (item.delivery.due_at, item.delivery.delivery_id))

    @staticmethod
    def _wecker_id(agent_id: str, postfach_id: str) -> str:
        return ad.derived_id("zustellung", agent_id, postfach_id)

    def _marker(self, art: str, ticket_id: Optional[str] = None, nachricht_id: Optional[str] = None,
                frage_id: Optional[str] = None, agent_id: Optional[str] = None) -> str:
        if ticket_id:
            ticket = ad.read_ticket(self.root, ticket_id)
            return "%s:%d" % (ticket_id, int(ticket.get("result_revision") or 0))
        if art == "antrag" and frage_id:
            return "antrag:%s:%s" % (frage_id, ad.read_question(self.root, frage_id).get("state"))
        if nachricht_id and agent_id:
            return "nachricht:%s:%d" % (nachricht_id, int(self._antwort_belegt(agent_id, nachricht_id)))
        return "%s:%s" % (art, frage_id or nachricht_id or "-")

    # Ein Durchgang ---------------------------------------------------------------
    def einmal(self) -> dict[str, Any]:
        summary: dict[str, Any] = {"gestartet": [], "beendet": [], "aktiv": [], "wartend": [], "ungeklaert": []}
        world = ad.read_world(self.root)
        world_id = world["id"]
        self._laeufe_pruefen(world_id, summary)
        self._zugaenge_aufraeumen()
        busy = {entry["agent"] for entry in self._zuege_lesen()["runs"].values() if entry.get("outcome") is None}
        runs = self.runs()
        freigabe_cache: dict[str, Startfreigabe] = {}
        for agent in ad.list_agents(self.root):
            if agent["id"] in busy:
                continue
            for posten in self._posten(world_id, agent["id"]):
                if self._zustellung(world, agent, posten, runs, summary, freigabe_cache):
                    break
        return summary

    def _zustellung(self, world: dict[str, Any], agent: dict[str, Any], posten: Posten, runs: RunController,
                    summary: dict[str, Any], freigabe_cache: dict[str, Startfreigabe]) -> bool:
        """Behandelt eine Zustellung; True heisst: fuer diesen Agenten ist der Durchgang erledigt."""
        agent_id, world_id = agent["id"], world["id"]
        delivery = posten.delivery
        delivery_id = delivery.delivery_id
        info = {"delivery": delivery_id, "agent": agent_id, "art": posten.art}
        try:
            existing = self.wecker.status(delivery_id)
        except WeckerFehler:
            existing = None
        if existing is not None and existing.status == "completed":
            if self._quittierbar(posten, existing.outcome):
                self._quittieren(agent_id, posten.postfach_id)
            return False
        if existing is not None and existing.status == "blocked":
            summary["wartend"].append(dict(info, reason=existing.reason, status="blocked"))
            return False
        if existing is not None and existing.status == "unknown":
            entries = [entry for entry in self._zuege_lesen()["runs"].values()
                       if entry.get("delivery_id") == delivery_id]
            finished = [entry for entry in entries if entry.get("outcome")]
            if finished:
                # Absturz zwischen Urteil und Quittung: das gespeicherte Urteil nachtragen.
                entry = finished[-1]
                self.wecker.resolve(delivery_id, entry["claim_id"], run_id=entry["run_id"],
                                    progress_marker=entry.get("marker_after") or self._marker(
                                        posten.art, posten.ticket_id, posten.nachricht_id, posten.frage_id, agent_id),
                                    outcome=entry["outcome"])
                if self._quittierbar(posten, entry["outcome"]):
                    self._quittieren(agent_id, posten.postfach_id)
                return False
            # Ein Claim ohne gespeicherten Zug wird nie blind wiederholt.
            summary["ungeklaert"].append(dict(info, reason="claim_ohne_zug" if not entries else "zug_offen"))
            return True
        schlaf = self._zuege_lesen()["schlaf"].get(agent_id)
        if schlaf and float(schlaf["bis"]) > self._now():
            summary["wartend"].append(dict(info, reason="schlaeft", grund=schlaf.get("grund"), bis=schlaf["bis"]))
            return True
        if schlaf:
            with self._zuege() as state:
                state["schlaf"].pop(agent_id, None)
        active = runs.status(world_id, agent_id)
        if active is not None and active.observed_state in {"unclear", "unknown"}:
            summary["wartend"].append(dict(info, reason="ungeklaerter_lauf", run=active.run_id))
            return True
        model = None
        wahl = None
        if posten.art != "aufwachen":
            zug_agent, model, wahl, erledigt = self._modellwahl(agent, info, summary, freigabe_cache)
            if zug_agent is None:
                return erledigt
            agent = zug_agent
        marker = self._marker(posten.art, posten.ticket_id, posten.nachricht_id, posten.frage_id, agent_id)
        claim = self.wecker.claim(
            delivery, desired_world_state=WELT_ZUSTAND[world["state"]],
            desired_agent_state=AGENT_ZUSTAND.get(agent.get("state"), "stopped"),
            active_run=active.run_id if active is not None else None, progress_marker=marker)
        if claim.status == "claimed":
            if posten.art == "aufwachen":
                self.wecker.resolve(delivery_id, claim.claim_id, run_id="kein-lauf", progress_marker=marker,
                                    outcome="aufgewacht")
                summary["beendet"].append(dict(info, outcome="aufgewacht"))
                return False
            run_id = self._starten(world, agent, posten, claim.claim_id, model, marker, wahl)
            if run_id is not None:
                summary["gestartet"].append(dict(info, run=run_id, ticket=posten.ticket_id))
            return True
        if claim.status == "completed":
            self._quittieren(agent_id, posten.postfach_id)
            return False
        summary["wartend" if claim.status in {"pending", "blocked"} else "ungeklaert"].append(
            dict(info, reason=claim.reason, status=claim.status))
        return claim.status == "unknown" or claim.reason in {"paused", "stopped", "active_run", "claim_in_flight"}

    def _startsperre(self, agent_id: str, cache: dict[str, Startfreigabe],
                     fallback: Optional[dict[str, Any]] = None) -> Optional[dict[str, Any]]:
        """Prueft Anmeldung und Kontingent vor einem Claim; bei Sperre schlaeft der Agent bis zur Freigabe."""
        sperre = self._abo_sperre(cache)
        if sperre is None:
            return None
        quelle = dict(sperre["quelle"], fallback=fallback) if fallback is not None else sperre["quelle"]
        self._schlafen(agent_id, sperre["grund"], sperre["bis"], quelle)
        return {"grund": sperre["grund"], "bis": sperre["bis"]}

    def _abo_sperre(self, cache: dict[str, Startfreigabe]) -> Optional[dict[str, Any]]:
        """Anmeldung und Kontingent des Claude-Abos ohne Nebenwirkung: ``None`` oder Grund, Ende und Quelle."""
        credential = self.anmeldequelle.status()
        if not credential.get("available"):
            return {"grund": "anmeldung", "bis": self._now() + RECHECK_S,
                    "quelle": {"anmeldung": credential.get("reason")}}
        if self.kontingentquelle is None:
            return None
        if "frei" not in cache:
            cache["frei"] = self.kontingentquelle.freigabe()
        freigabe = cache["frei"]
        if freigabe.erlaubt:
            return None
        return {"grund": "kontingent", "bis": freigabe.naechster_start or (self._now() + RECHECK_S),
                "quelle": freigabe.as_dict()}

    # Modellwahl je Zug ---------------------------------------------------------------
    def fallback_agent(self, agent: dict[str, Any]) -> tuple[Optional[dict[str, Any]], Optional[str]]:
        """Das Profil mit ``fallback_model``/``fallback_effort`` als Modell, oder ``None`` und der Grund dafuer.

        Fable ist nie ein Fallback (Regel), auch wenn es im Profil steht."""
        profile = agent.get("model_profile") or {}
        name = profile.get("fallback_model")
        if not name:
            return None, "kein_fallback"
        if ist_fable(name):
            return None, "fallback_fable_verboten"
        variant = dict(agent, model_profile=dict(profile, model=name, effort=profile.get("fallback_effort")))
        if self.modell(variant) is None:
            return None, "fallback_nicht_aufloesbar"
        return variant, None

    def _lokal_frei(self, agent: dict[str, Any]) -> bool:
        """Ein lokales Pi-Modell ist frei, wenn sein Server antwortet; Claude und Codex sind nie „belegt“."""
        if self.harness(agent) != "pi":
            return True
        try:
            return bool(self._lokal_frei_pruefer(str(self.konfig.pi["base_url"])))
        except Exception:  # noqa: BLE001 - ein kaputter Pruefer heisst: nicht frei
            return False

    def _modellwahl(self, agent: dict[str, Any], info: dict[str, Any], summary: dict[str, Any],
                    cache: dict[str, Startfreigabe]) -> tuple[Optional[dict[str, Any]], Optional[str],
                                                              Optional[dict[str, Any]], bool]:
        """Modell des naechsten Zuges: das Profilmodell oder sein Fallback (der Nutzer, 16.09.2026).

        Der Fallback greift bei erschoepftem Kontingent (Vorabsperre oder vorgemerkte 429 des Abos), wenn ein
        lokales Modell belegt ist, und nach einem Startfehler. Ein Fallback im selben Abo hilft am Limit nicht:
        dann schlaeft der Agent wie ohne Fallback, und die Schlafquelle nennt den Grund. Liefert
        ``(agent_fuer_den_zug, modell, wahl, erledigt)``; ohne Zug ist das Agentenprofil ``None``, und
        ``erledigt`` sagt, ob der Durchgang fuer diesen Agenten vorbei ist."""
        agent_id = agent["id"]
        profil = str((agent.get("model_profile") or {}).get("model") or "")
        if ist_fable(profil):
            summary["wartend"].append(dict(info, reason="fable_verboten"))
            return None, None, None, False
        model = self.modell(agent)
        if model is None:
            summary["wartend"].append(dict(info, reason="modell_nicht_aufloesbar"))
            return None, None, None, False
        harness = self.harness(agent)
        wahl = {"profil": profil, "modell": profil, "harness": harness, "fallback": False, "grund": None}
        fallback, fallback_fehlt = self.fallback_agent(agent)

        def bereit(kandidat: dict[str, Any]) -> Optional[str]:
            """Grund, warum der Kandidat jetzt nicht startet, ohne zu schlafen."""
            if not self._lokal_frei(kandidat):
                return "belegt"
            if self.harness(kandidat) == "claude":
                sperre = self._abo_sperre(cache)
                return sperre["grund"] if sperre is not None else None
            return None

        def mit_fallback(grund: str) -> tuple[dict[str, Any], str, dict[str, Any], bool]:
            assert fallback is not None
            name = str(fallback["model_profile"]["model"])
            return fallback, str(self.modell(fallback)), dict(wahl, modell=name, harness=self.harness(fallback),
                                                               fallback=True, grund=grund), False

        def warten(grund: str, bis: float, quelle: dict[str, Any], fallback_info: dict[str, Any]):
            self._schlafen(agent_id, grund, bis, dict(quelle, fallback=fallback_info))
            summary["wartend"].append(dict(info, reason=grund, bis=bis, fallback=fallback_info))
            return None, None, None, True

        vormerkung = self._zuege_lesen()["fallback"].get(agent_id)
        if vormerkung is not None:
            gueltig = vormerkung.get("profil") == profil and (
                vormerkung.get("bis") is None or float(vormerkung["bis"]) > self._now())
            if not gueltig or vormerkung.get("grund") == "startfehler":
                with self._zuege() as state:  # ein Startfehler gilt fuer genau einen Zug
                    state["fallback"].pop(agent_id, None)
            if gueltig and fallback is not None and bereit(fallback) is None:
                return mit_fallback(str(vormerkung.get("grund")))
            if gueltig and vormerkung.get("grund") == "kontingent":
                bis = float(vormerkung.get("bis") or (self._now() + RECHECK_S))
                return warten("kontingent", bis, {"vorgemerkt": vormerkung},
                              {"modell": (fallback or {}).get("model_profile", {}).get("model"),
                               "grund": fallback_fehlt or "fallback_nicht_bereit"})
        if not self._lokal_frei(agent):
            if fallback is not None and bereit(fallback) is None:
                return mit_fallback("belegt")
            return warten("belegt", self._now() + BELEGT_ABSTAND_S, {"base_url": str((self.konfig.pi or {}).get("base_url"))},
                          {"modell": (fallback or {}).get("model_profile", {}).get("model"),
                           "grund": fallback_fehlt or "fallback_nicht_bereit"})
        if harness == "claude":
            sperre = self._abo_sperre(cache)
            if sperre is not None:
                if sperre["grund"] == "kontingent" and fallback is not None:
                    if modell_abo(self.harness(fallback)) == modell_abo(harness):
                        info_fb = {"modell": fallback["model_profile"]["model"], "grund": "gleiches_abo"}
                    elif bereit(fallback) is None:
                        return mit_fallback("kontingent")
                    else:
                        info_fb = {"modell": fallback["model_profile"]["model"], "grund": "fallback_nicht_bereit"}
                else:
                    info_fb = {"modell": (fallback or {}).get("model_profile", {}).get("model"), "grund": fallback_fehlt}
                return warten(sperre["grund"], sperre["bis"], sperre["quelle"], info_fb)
        return agent, model, wahl, False

    def _schlafen(self, agent_id: str, grund: str, bis: float, quelle: dict[str, Any],
                  timer_content: Optional[str] = None, caused_by: Optional[Delivery] = None) -> str:
        """Legt den Agenten bis ``bis`` schlafen und registriert genau einen Selbstwecker dafuer."""
        world_id = self.world_id()
        with self._zuege() as state:
            state["schlaf"][agent_id] = {"grund": grund, "bis": bis, "seit": self._now(), "quelle": quelle}
            count = int(state["zaehler"].get("wecker", 0)) + 1
            state["zaehler"]["wecker"] = count
        pending_timers = [item for item, _ in self.wecker.offene(world_id, agent_id) if item.cause == "self_timer"]
        if timer_content is None and pending_timers:
            return pending_timers[0].delivery_id
        delivery_id = ad.derived_id("wecker", agent_id, count)
        chain = tuple(caused_by.chain) + (caused_by.delivery_id,) if caused_by is not None else ()
        delivery = Delivery(delivery_id, world_id, agent_id, "self_timer", bis,
                            timer_content or _inhalt("aufwachen", grund=grund),
                            caused_by.delivery_id if caused_by is not None else None, chain)
        self._registrieren(delivery)
        return delivery_id

    def _registrieren(self, delivery: Delivery) -> None:
        """Legt eine Zustellung im Weckerregister ab, ohne sie jetzt beanspruchen zu wollen."""
        world = ad.read_world(self.root)
        agent = ad.read_agent(self.root, delivery.agent)
        # Ein kuenftiger Selbstwecker oder Recovery bleibt `not_due`; ein Steuerungsgrund haelt
        # ihn ebenfalls nur ausstehend. Sollte er sofort beanspruchbar sein, wird nichts gestartet:
        # der naechste Durchgang findet ihn als offenen Claim ohne Zug nicht, weil hier sofort
        # aufgeloest und neu registriert wird.
        claim = self.wecker.claim(delivery, desired_world_state=WELT_ZUSTAND[world["state"]],
                                  desired_agent_state=AGENT_ZUSTAND.get(agent.get("state"), "stopped"),
                                  active_run="registrierung", progress_marker=None)
        if claim.status == "claimed":  # pragma: no cover - active_run verhindert das
            raise TraegerFehler("Registrierung darf nicht beanspruchen")

    def _quittierbar(self, posten: Posten, outcome: Optional[str]) -> bool:
        """Postfachnachrichten bleiben offen, solange ihre Bearbeitung noch aussteht."""
        if posten.art in {"nachricht", "rueckmeldung", "antrag"}:
            return outcome in {"erfolg", "bereits_erledigt"}
        return posten.art == "ticket"

    def _quittieren(self, agent_id: str, delivery_id: Optional[str]) -> None:
        if not delivery_id:
            return
        try:
            ad.acknowledge(self.root, agent_id, delivery_id, agent_id, None)
        except ad.AgentsError:
            pass

    def _ohne_lauf_quittieren(self, agent_id: str, posten: Posten, claim_id: str, marker: str, outcome: str) -> None:
        self.wecker.resolve(posten.delivery.delivery_id, claim_id, run_id="kein-lauf", progress_marker=marker,
                            outcome=outcome)
        if self._quittierbar(posten, outcome) or posten.art == "ticket":
            self._quittieren(agent_id, posten.postfach_id)
        if posten.art in {"nachricht", "rueckmeldung", "antrag"} and outcome == "bereits_erledigt" and posten.nachricht_id:
            self._quittieren(agent_id, posten.nachricht_id)

    # Zugbeschreibung ---------------------------------------------------------------
    def _antwort_id(self, agent_id: str, nachricht_id: str) -> str:
        return ad.derived_id("antwort", agent_id, nachricht_id)

    def _antwort_belegt(self, agent_id: str, nachricht_id: str) -> bool:
        reply_id = self._antwort_id(agent_id, nachricht_id)
        if any(message.get("id") == reply_id and message.get("sender") == agent_id
               for message in ad.read_messages(self.root)):
            return True
        chats = self.root / "direktchats"
        return any(path.is_file() and ad._read_json(path).get("sender") == agent_id
                   for path in chats.glob("*/%s.json" % reply_id)) if chats.is_dir() else False

    def _antrag_belegt(self, frage_id: Optional[str]) -> bool:
        if not frage_id:
            return False
        try:
            return ad.read_question(self.root, frage_id).get("state") != "offen"
        except ad.AgentsError:
            return False

    def _prompt(self, world: dict[str, Any], agent: dict[str, Any], posten: Posten, resume: bool,
                ticket: Optional[dict[str, Any]], nachricht: Optional[dict[str, Any]],
                frage: Optional[dict[str, Any]], run_dir: Optional[Path] = None,
                skills: Optional[list[dict[str, Any]]] = None) -> str:
        workspace, _ = self.arbeitsorte(agent["id"])
        rpc = (run_dir / "rpc" / "agents_rpc_client.py") if run_dir is not None else self.orte.runtime / "agents_rpc_client.py"
        skill = {item["name"]: item for item in skills or []}
        lines = [
            'You are the agent "%s" (%s) in the Werkbank world "%s".' % (agent["id"], agent["stage"], world["name"]),
            "Work only inside your workspace %s." % workspace,
        ]
        if resume:
            lines.append("You worked in this session before and something was delivered to you again. "
                         "Continue from the previous conversation.")
        if posten.art == "fortsetzen":
            lines.append("Your previous turn on this ticket ended early (%s). Continue the work." % (posten.grund or "?"))
        if ticket is not None:
            payload = json.dumps({"ticket_id": ticket["id"], "text": "RESULT"})
            lines += [
                "Ticket %s: %s" % (ticket["id"], ticket["title"]),
                "Goal: %s" % ticket["goal"],
                "Done when: %s" % ticket["done_criterion"],
            ]
            if "ergebnis-schreiben" in skill:
                # Ein Skill ersetzt die Erklaerung im Prompt (Plan Abschnitt 14).
                lines += [
                    "When the goal is met, store your result exactly once with your skill ergebnis-schreiben "
                    "(instructions in %s/SKILL.md):" % skill["ergebnis-schreiben"]["pfad"],
                    "<<<", "%s/scripts/ergebnis-schreiben.py --ticket %s --text \"RESULT\"" % (
                        skill["ergebnis-schreiben"]["pfad"], ticket["id"]), ">>>",
                    "Then reply with a one-line summary.",
                ]
            else:
                lines += [
                    "When the goal is met, store your result exactly once by running the command between the markers "
                    "with the Bash tool, replacing RESULT with a short plain-text result without quotes or backslashes:",
                    "<<<", "printf '%%s' '%s' | /usr/bin/python3 %s ticket.result" % (payload, rpc), ">>>",
                    "Then reply with a one-line summary.",
                ]
        elif nachricht is not None and posten.art == "antrag" and posten.frage_id:
            antrag = ad.read_question(self.root, posten.frage_id)
            payload = json.dumps({"request_id": antrag["id"], "accept": True, "note": "NOTE"})
            lines += [
                "The team leader %s requests a new agent (request %s):" % (antrag.get("sender"), antrag["id"]),
                "---", str(antrag.get("text")), "Draft: %s" % json.dumps(antrag.get("draft"), ensure_ascii=False), "---",
                "Decide exactly once by running the command between the markers with the Bash tool. Keep "
                "\"accept\": true to create the agent or set it to false to decline; replace NOTE with a short reason "
                "without quotes or backslashes:",
                "<<<", "printf '%%s' '%s' | /usr/bin/python3 %s agent.decide" % (payload, rpc), ">>>",
                "The team leader is informed automatically. Then reply with a one-line summary.",
            ]
        elif nachricht is not None and posten.art == "rueckmeldung":
            lines += [
                "You received a reply or result notice from %s:" % nachricht.get("sender"),
                "---", str(nachricht.get("text")), "---",
                "Take it into account for your work. No answer is required. Reply with a one-line summary.",
            ]
        elif nachricht is not None:
            where = "direct chat" if nachricht.get("kind") == "direktchat" else "channel"
            payload = json.dumps({"delivery_id": posten.nachricht_id, "text": "REPLY",
                                  "message_id": self._antwort_id(agent["id"], posten.nachricht_id)})
            lines += [
                "You received a message in the %s from %s:" % (where, nachricht.get("sender")),
                "---", str(nachricht.get("text")), "---",
                "Read it and answer the sender exactly once by running the command between the markers with the Bash "
                "tool, replacing REPLY with your short plain-text answer without quotes or backslashes:",
                "<<<", "printf '%%s' '%s' | /usr/bin/python3 %s message.reply" % (payload, rpc), ">>>",
                "Then reply with a one-line summary.",
            ]
        elif frage is not None:
            lines += [
                "Your question %s was answered." % frage["id"],
                "Question: %s" % frage.get("text"),
                "Answer: %s" % (frage.get("answer") or {}).get("text"),
                "Take the answer into account for your work and reply with a one-line summary.",
            ]
        lernen = skill.get(LERNSKRIPT) or {}
        if run_dir is not None and lernen.get("datei"):
            # Das gespeicherte Skript baut und prueft das JSON; kleine Modelle scheitern sonst am Quoting.
            lines += [
                "End the turn with your learning step: run your stored script %s exactly once, replacing LESSON "
                "and REASON (instructions in your instructions file):" % LERNSKRIPT,
                "<<<", "python3 %s --art lehre --text \"LESSON\" --grund \"REASON\"" % lernen["datei"], ">>>",
                "If you learned nothing, run it with --art nichts instead. It writes %s/%s." % (run_dir, ask.LEARN_FILE),
            ]
        elif run_dir is not None:
            lines.append("End the turn with your learning step as described in your instructions: write "
                         "%s/%s (art nichts if you learned nothing)." % (run_dir, ask.LEARN_FILE))
        return "\n".join(lines)

    def _anweisung(self, world: dict[str, Any], agent: dict[str, Any], run_dir: Path,
                   verzeichnis: Optional[dict[str, Any]], skills_fehler: Optional[str],
                   zugang: Optional[az.Bereitstellung] = None, zugang_fehler: Optional[str] = None,
                   projekt: Optional[Path] = None, projekt_arbeit: Optional[Path] = None,
                   baum: Optional[aw.Arbeitsbaum] = None, baum_fehler: Optional[str] = None,
                   arbeitsordner: Optional[Path] = None) -> str:
        """Anweisungsdatei des Zuges: eigene Anweisungen, Gedaechtnis, Skills mit Pfad, Projekt, Zugende mit
        Lernschritt."""
        folder = ad._agent_dir(self.root, agent["id"])

        def lesen(name: str, limit: int) -> str:
            path = folder / name
            if path.is_symlink() or not path.is_file():
                return ""
            return path.read_bytes()[:limit].decode("utf-8", "replace").strip()

        rpc = run_dir / "rpc" / "agents_rpc_client.py"
        lines = ["# Anweisung für Zug %s" % run_dir.name, "",
                 "Agent `%s` (%s) in der Welt „%s“." % (agent["id"], agent["stage"], world["name"]), "",
                 "## Deine Anweisungsdatei", "", lesen("AGENTS.md", ask.INSTRUCTIONS_LIMIT) or "(keine)", "",
                 "## Dein Gedächtnis", "", lesen("MEMORY.md", ask.MEMORY_LIMIT) or "(leer)", "",
                 "## Skills", "",
                 "Lade einen Skill nur, wenn er passt: lies seine `SKILL.md` und rufe dann seine Skripte auf, "
                 "statt die Schritte selbst neu zu beschreiben. Der RPC-Client steht in `WB_RPC_CLIENT` (%s)." % rpc, ""]
        skills = (verzeichnis or {}).get("skills") or []
        for item in skills:
            if (item.get("art") or "skill") == "skript":
                # Ein gespeichertes Skript ist eine eigene Einheit: Datei und Aufruf aus seinem Anweisungskopf.
                lines.append("- Skript `%s` (%s, Version %s): %s  \n  Datei `%s`, Aufruf `%s`" % (
                    item["name"], item["ebene"], str(item.get("version") or "")[:12], item.get("description") or "",
                    item.get("datei"), item.get("aufruf")))
                continue
            lines.append("- `%s` (%s, Version %s): %s  \n  `%s/SKILL.md`, Skripte unter `%s/scripts/`" % (
                item["name"], item["ebene"], str(item.get("version") or "")[:12], item.get("description") or "",
                item["pfad"], item["pfad"]))
        if not skills:
            lines.append("Keine Skills verzeichnet." if not skills_fehler else
                         "Skillverzeichnis nicht lesbar: %s" % skills_fehler)
        if projekt is not None and baum is not None:
            # Worktree je Agent (der Nutzer, 16.09.2026): am Projekt arbeitet jeder Agent auf seinem eigenen Zweig.
            haupt = aw.hauptzweig(baum.projekt) or "main"
            lines += ["", "## Projekt", "",
                      "Das Projekt der Welt liegt unter `%s` und ist im Zug nur lesbar; seinen Arbeitsbaum und den "
                      "Hauptzweig `%s` berührst du nie." % (projekt, haupt),
                      "Du arbeitest in deinem eigenen Worktree `%s` (dein Arbeitsverzeichnis) auf dem Zweig `%s`. "
                      "Änderungen am Projekt machst und committest du dort: `git add <pfade>`, "
                      "`git commit -m \"…\"` (immer mit `-m`, einen Editor gibt es nicht). Den neuesten Stand holst "
                      "du mit `git rebase %s`; eine Datei stellst du mit `git checkout -- <pfad>` zurück." % (
                          baum.pfad, baum.zweig, haupt),
                      "Das Ergebnis eines Tickets mit Codeänderung nennt deinen Commit im Feld `commit` von "
                      "`ticket.result` (im JSON neben `text`: `\"commit\": \"<sha>\"`; mit dem Skill "
                      "ergebnis-schreiben `--commit <sha>`).",
                      "Zusammengeführt wird nur durch Teamleiter und Hauptagent; gepusht wird nur vom Hauptagenten "
                      "nach Abnahme. Kein `git push`, kein Wechsel auf andere Zweige, kein `git worktree`."]
            if agent["stage"] == "teamleiter":
                lines.append("Als Teamleiter führst du Zweige der Mitglieder deines Teams in deinen Zweig zusammen: "
                             "`git merge agent/<mitglied>`; nach Konflikten `git add` und `git commit --no-edit`, "
                             "abbrechen mit `git merge --abort`.")
            elif agent["stage"] == "hauptagent":
                lines.append("Als Hauptagent führst du jeden Agentenzweig in deinen Zweig zusammen: "
                             "`git merge agent/<id>`; nach Konflikten `git add` und `git commit --no-edit`, "
                             "abbrechen mit `git merge --abort`.")
            lines.append("Dokumente für andere (Berichte, Entwürfe, Übergaben) legst du im gemeinsamen Ordner `%s` "
                         "ab (Unterordner je Team oder Thema); eigene Notizen und Entwürfe gehören in deinen privaten "
                         "Ordner `%s`." % (projekt_arbeit, arbeitsordner))
        elif projekt is not None:
            lines += ["", "## Projekt", "",
                      "Das Projekt der Welt liegt unter `%s` und ist im Zug lesbar (Regeln, Dokumente, Quelltext). "
                      "Geschrieben wird nur im eigenen Arbeitsordner und im gemeinsamen Ordner `%s`; dort legen "
                      "Team und Agenten ihre Ergebnisdateien ab (Unterordner je Team oder Thema)." % (
                          projekt, projekt_arbeit)]
            if baum_fehler:
                lines.append("Dein eigener Worktree ist in diesem Zug nicht bereit: %s" % baum_fehler)
        if zugang is not None or zugang_fehler:
            lines += ["", "## Zugänge", ""]
            if zugang is not None:
                lines += ["Die Welt hat Zugänge nach draußen; nur über sie erreichst du andere Rechner, das Netz und "
                          "Postfächer. Rufe sie genau so auf, ohne Pfad, Variablen oder zusätzliche Optionen:"
                          ] + az.anweisung(zugang.eintraege or zugang.namen)
            else:
                lines.append("Die Zugänge der Welt sind in diesem Zug nicht bereit: %s" % zugang_fehler)
        if agent["stage"] == "hauptagent":
            draft = {"id": "NAME", "stage": "mitglied", "team": "TEAM", "specialty": "Ein Satz zur Aufgabe",
                     "model": "sonnet5:high", "tools": ["Read", "Grep", "Glob", "Write", "Edit"], "bash": [],
                     "skills": []}
            rechte = {"agent_id": "NAME", "tools": ["Read", "Grep", "Glob", "Write", "Edit"], "bash": ["pytest *"],
                      "skills": ["texte-schreiben"], "web": True}
            lines += ["", "## Agenten anlegen", "",
                      "Einen Agenten legst du über den RPC an: schreibe den Entwurf als JSON in eine Datei deines "
                      "Arbeitsordners und rufe `/usr/bin/python3 %s agent.create < entwurf.json` auf. Form: "
                      "`{\"draft\": %s}`. `tools`, `bash` und `skills` sind die Rechte des neuen Agenten; ohne "
                      "`tools` gelten die seiner Stufe, ohne `machine` die Maschine dieser Welt. Der Mensch erfährt "
                      "es als markiertes Ergebnis mit den Rechten." % (rpc, json.dumps(draft, ensure_ascii=False)),
                      "Anträge von Teamleitern entscheidest du mit `agent.decide` (`request_id`, `accept`, `note`).",
                      "Rechte eines Agenten der Welt (nicht deine eigenen) setzt du mit `agent.rechte`: "
                      "`/usr/bin/python3 %s agent.rechte < rechte.json`, Form `%s`. Jedes Feld außer `agent_id` ist "
                      "optional: `tools` ersetzt die Werkzeugliste (erlaubt: %s; Bash bleibt immer), `bash` ersetzt die "
                      "eigenen Muster, die Dienstwegmuster bleiben immer, `skills` ersetzt die Skills, `web` true oder "
                      "false gibt oder nimmt WebFetch und WebSearch. Web gibt es nur mit einem Zugang der Art web, "
                      "`ssh`/`scp`/`rsync`-Muster nur für eingerichtete ssh-Zugänge der Welt; sonst nennt die Antwort "
                      "den Grund. Die Änderung gilt ab dem nächsten Zug des Agenten, steht in seinem Verlauf, und der "
                      "Mensch erfährt sie als markiertes Ergebnis. Teamleiter beantragen Rechte bei dir." % (
                          rpc, json.dumps(rechte, ensure_ascii=False), ", ".join(ad.AGENT_TOOLS))]
        lines += ["", "## Zugende", "",
                  "1. Ein Zug endet mit einer Entscheidung: fertig, Weckzeit, Übergabe oder „braucht dich“ über "
                  "den Dienstweg.",
                  "2. Danach der Lernschritt: Was hat gefehlt, was war umständlich, was war beim zweiten Mal anders? "
                  "Schreibe genau eine JSON-Datei `%s/%s`, eine dieser Formen:" % (run_dir, ask.LEARN_FILE),
                  '   - `{"art": "lehre", "text": "kurze Lehre", "grund": "warum"}` (landet datiert in MEMORY.md)',
                  '   - `{"art": "anweisung", "ziel": "AGENTS.md", "diff": "<unified diff, nur ergänzend>", "grund": "warum"}`',
                  '   - `{"art": "skill", "ziel": "<skillname>", "diff": "<unified diff relativ zum Skill>", "grund": "warum"}`',
                  '   - `{"art": "nichts", "text": "optional"}`, wenn du ausdrücklich nichts gelernt hast.',
                  "   Der Träger prüft und wendet den Lernschritt nach dem Zug an; du änderst diese Dateien nicht selbst."]
        lernen = next((item for item in skills if item.get("name") == LERNSKRIPT and item.get("datei")), None)
        if lernen is not None:
            lines.append("3. Schreibe den Lernschritt mit deinem Skript `%s` statt JSON von Hand: "
                         "`python3 %s --art lehre --text \"…\" --grund \"…\"`, für die übrigen Arten `--ziel` und "
                         "`--diff-datei`, ohne Lernen `--art nichts`. Es prüft das Format und schreibt die Datei; "
                         "Exit 1 nennt den Fehler in `error`." % (LERNSKRIPT, lernen["datei"]))
        return "\n".join(lines) + "\n"

    def _starten(self, world: dict[str, Any], agent: dict[str, Any], posten: Posten, claim_id: str,
                 model: str, marker: str, wahl: Optional[dict[str, Any]] = None) -> Optional[str]:
        agent_id = agent["id"]
        ticket = nachricht = frage = None
        if posten.art in {"ticket", "fortsetzen"} and posten.ticket_id:
            ticket = ad.read_ticket(self.root, posten.ticket_id)
            open_states = {"offen", "zurückgegeben"} if posten.art == "ticket" else set()
            owned = ticket["state"] == "läuft" and ticket.get("assignee") == agent_id
            if ticket["state"] not in open_states and not owned:
                self._ohne_lauf_quittieren(agent_id, posten, claim_id, marker, "ticket_nicht_offen")
                return None
            if posten.art == "ticket":
                try:
                    ticket = ad.claim_ticket(self.root, posten.ticket_id, agent_id, agent_id, agent["stage"])
                except ad.AgentsError:
                    self._ohne_lauf_quittieren(agent_id, posten, claim_id, marker, "uebernahme_abgewiesen")
                    return None
        elif posten.nachricht_id:
            path = ad._agent_dir(self.root, agent_id) / "postfach" / (posten.nachricht_id + ".json")
            nachricht = ad._read_json(path) if path.is_file() else None
            if nachricht is None or nachricht.get("acknowledged") or (
                    posten.art == "nachricht" and self._antwort_belegt(agent_id, posten.nachricht_id)) or (
                    posten.art == "antrag" and self._antrag_belegt(posten.frage_id)):
                self._ohne_lauf_quittieren(agent_id, posten, claim_id, marker, "bereits_erledigt")
                return None
        elif posten.frage_id:
            frage = ad.read_question(self.root, posten.frage_id)
            if frage.get("state") != "beantwortet":
                self._ohne_lauf_quittieren(agent_id, posten, claim_id, marker, "frage_offen")
                return None
        else:
            self._ohne_lauf_quittieren(agent_id, posten, claim_id, marker, "unbekannte_zustellung")
            return None
        run_id = "zug-" + uuid.uuid4().hex[:20]
        workspace, agent_state = self.arbeitsorte(agent_id)
        # Mit git-Projekt ist der eigene Worktree (im privaten Arbeitsordner) das Arbeitsverzeichnis des Zuges.
        baum, baum_fehler = self.arbeitsbaum(agent_id, workspace)
        cwd = baum.pfad if baum is not None else workspace
        # Der Zugordner traegt die Laufkennung: der Lernschritt ist je Zug eindeutig.
        run_dir = agent_state / run_id
        config_dir = run_dir / "claude-config"
        session_key = posten.ticket_id or NACHRICHTEN_SITZUNG
        session = (self._zuege_lesen()["sessions"].get(agent_id) or {}).get(session_key) or {}
        harness = self.harness(agent)
        # Claude setzt aus einer gesicherten Uebergabe fort, Pi ueber dieselbe Sitzungskennung im Sitzungsordner.
        resume = bool(session.get("session_id")) if harness == "pi" else bool(session.get("handoff_run"))
        if session.get("harness") and session["harness"] != harness:
            resume = False  # ein Fallback in einem anderen Harness kann die Sitzung des anderen nicht fortsetzen
        if resume and harness == "claude" and self._uebergabe_cwd(session["handoff_run"]) != str(cwd):
            # Eine Sitzung aus der Zeit vor dem Worktree haengt an ihrem alten Arbeitsordner; sie beginnt einmal neu.
            resume = False
        session_id = session["session_id"] if resume else str(uuid.uuid4())
        entry = {"run_id": run_id, "agent": agent_id, "art": posten.art, "delivery_id": posten.delivery.delivery_id,
                 "cause": posten.delivery.cause, "chain": list(posten.delivery.chain), "claim_id": claim_id,
                 "ticket_id": posten.ticket_id, "nachricht_id": posten.nachricht_id, "frage_id": posten.frage_id,
                 "postfach_id": posten.postfach_id, "harness": harness,
                 "session_key": session_key, "session_id": session_id, "resume": resume, "model": model,
                 "modellwahl": wahl or {"profil": (agent.get("model_profile") or {}).get("model"),
                                        "modell": (agent.get("model_profile") or {}).get("model"), "harness": harness,
                                        "fallback": False, "grund": None},
                 "config_dir": str(config_dir), "run_dir": str(run_dir), "workspace": str(cwd),
                 "worktree": str(baum.pfad) if baum is not None else None, "worktree_fehler": baum_fehler,
                 "marker_before": marker,
                 "revision_before": int((ticket or {}).get("result_revision") or 0), "started_at": self._now(),
                 "outcome": None}
        with self._zuege() as state:
            state["runs"][run_id] = entry
        try:
            if harness == "codex":
                # Anmeldeweg vor jedem Aufbau: ohne Codex-Anmeldung endet der Zug mit `anmeldung`, ohne Start.
                auth = (self.konfig.codex or {}).get("auth") or str(Path.home() / CODEX_AUTH_VORGABE)
                anmeldung = CodexAnmeldung(auth).status()
                if not anmeldung["available"]:
                    with self._zuege() as state:
                        state["runs"][run_id]["anmeldung"] = anmeldung
                    self._nachbereiten(world["id"], entry, "anmeldung",
                                       "Codex-Anmeldung %s; kein Zug gestartet" % anmeldung["reason"], marker)
                    return None
            _private_dir(run_dir, "Zugzustand")
            if resume and harness == "claude":
                uebergabe_wiederherstellen(self.orte.handoffs, session["handoff_run"], config_dir,
                                           world=world["id"], agent=agent_id, cwd=str(cwd))
            verzeichnis, skills_fehler = self._skills(agent_id)
            skills = (verzeichnis or {}).get("skills") or []
            turn_dir = _private_dir(self.orte.turns / run_id, "Zugordner des Laufs")
            rpc = self._rpc_bereitstellen(run_dir)
            zugang, zugang_fehler = None, None
            if harness == "claude" and self.konfig.sperren:
                # Zugaenge nur mit Profil-Sperre: ohne sie gaebe es keine Grenze zwischen Agent und Schluessel.
                try:
                    zugang = az.bereitstellen(self.root, turn_dir, werkzeuge=self.orte.runtime)
                except (ad.AgentsError, OSError, ValueError, subprocess.SubprocessError) as exc:
                    zugang_fehler = "%s: %s" % (type(exc).__name__, str(exc)[:200])
            # Das Projekt der Welt: Wurzel lesbar, `work/` beschreibbar (projekt_pfade). Die Profil-Sperre kennt
            # beides schon ueber WB_WELT_PROJEKT; ohne Einbindung saehe der Zug den Ordner trotzdem nicht.
            projekt, projekt_arbeit = projekt_pfade(self.root)
            anweisung = turn_dir / "ANWEISUNG.md"
            atomar_schreiben.schreiben(anweisung, self._anweisung(world, agent, run_dir, verzeichnis, skills_fehler,
                                                                  zugang, zugang_fehler, projekt=projekt,
                                                                  projekt_arbeit=projekt_arbeit, baum=baum,
                                                                  baum_fehler=baum_fehler, arbeitsordner=workspace),
                                       modus=0o600, dauerhaft=True)
            agent_dir = ad._agent_dir(self.root, agent_id)
            libraries = [Path(str((verzeichnis or {}).get(key) or "")) for key in ("bibliothek", "skript_bibliothek")]
            # Die Sperren pruefen WB_SKILL_BIBLIOTHEK und WB_SKRIPT_BIBLIOTHEK als Ordner; beide Bibliotheken
            # sind oeffentlich und nur lesbar eingebunden.
            read_paths = tuple(Path(item["pfad"]) for item in skills) + (agent_dir / "agent.json",) + (
                (agent_dir / "skills.json",) if verzeichnis else ()) + tuple(
                path for path in libraries if path.is_absolute() and path.is_dir()) + (
                (zugang.weltdatei,) if zugang is not None else ()) + ((projekt,) if projekt is not None else ())
            # Mit Worktree ist er Arbeitsverzeichnis und Schreibpfad des Laufs; der private Arbeitsordner darum
            # bleibt beschreibbar. Das Projekt-Repo bindet der Launcher ueber git_einbindung.
            write_paths = ((projekt_arbeit,) if projekt_arbeit is not None else ()) + (
                (workspace,) if baum is not None else ())
            env = self._zugumgebung(agent_id, workspace, run_dir, rpc, verzeichnis is not None)
            prompt = self._prompt(world, agent, posten, resume, ticket, nachricht, frage, run_dir, skills)
            if harness == "pi":
                effort, stufe = None, {"harness": "pi", "angefragt": (agent.get("model_profile") or {}).get("effort")}
                spec = self.konfig.pi["modelle"][str((agent.get("model_profile") or {}).get("model"))] or {}
                zug = PiZug(str(self.konfig.pi["node"]), str(self.konfig.pi["cli"]), model, prompt, session_id,
                            str(agent_state / "pi-sitzungen"), str(run_dir / "pi-agent"),
                            api=str(self.konfig.pi.get("api") or "openai-completions"),
                            context_window=int(spec.get("context_window") or 16384),
                            tools=pi_werkzeuge(agent.get("tools")), thinking=spec.get("thinking"),
                            append_system_prompt_file=str(anweisung), extra_env=tuple(env))
            elif harness == "codex":
                if not self.konfig.codex:
                    raise TraegerFehler("Codex-CLI ist in der Traegerkonfiguration nicht eingetragen")
                name = str((agent.get("model_profile") or {}).get("model") or "").split(":", 1)[0]
                effort, stufe = self.denkstufe(agent, name, "codex")
                zug = CodexZug(str(self.konfig.codex["cli"]), model, prompt, session_id, str(agent_state / "codex"),
                               effort=effort, append_system_prompt_file=str(anweisung), extra_env=tuple(env))
            else:
                effort, stufe = self.denkstufe(agent, model)
                settings = None
                if self.konfig.sperren:
                    settings = turn_dir / "settings.json"
                    git = baum.git_umgebung(agent_id) if baum is not None else None
                    atomar_schreiben.schreiben(settings, json.dumps(self._sperr_einstellungen(zugang, git), indent=2)
                                               + "\n", modus=0o600, dauerhaft=True)
                tools = tuple(t for t in agent.get("tools") or [] if t in ALLOWED_TOOLS) or self.konfig.tools
                zug = ClaudeZug(self.konfig.claude_binary, model, prompt, session_id, str(config_dir), resume, tools,
                                extra_env=tuple(env), effort=effort, append_system_prompt_file=str(anweisung),
                                settings_file=str(settings) if settings else None)
            with self._zuege() as state:
                state["runs"][run_id].update({"denkstufe": stufe, "skills": [item["name"] for item in skills],
                                              "skills_fehler": skills_fehler, "sperren": bool(self.konfig.sperren
                                                                                             and harness == "claude"),
                                              "zugaenge": list(zugang.namen) if zugang is not None else [],
                                              "zugaenge_fehler": zugang_fehler})
            lauf = self._zug_fabrik(self, agent_id=agent_id, run_id=run_id, zug=zug, workspace=cwd,
                                    agent_state=agent_state, extra_read_paths=read_paths, netz=zugang is not None,
                                    extra_write_paths=write_paths,
                                    **({"git_einbindung": baum.einbindung()} if baum is not None else {}))
            self.laeufe[run_id] = lauf
            lauf.start()
        except Exception as exc:  # noqa: BLE001 - jeder Startfehler wird sichtbar abgeschlossen
            lauf = self.laeufe.pop(run_id, None)
            if lauf is not None:
                with contextlib.suppress(Exception):
                    lauf.close()
            with contextlib.suppress(OSError):
                az.aufraeumen(self.orte.turns / run_id)
            detail = "%s: %s" % (type(exc).__name__, str(exc)[:200])
            sofort = self._fallback_vormerken(agent, entry, "startfehler", None)
            self._nachbereiten(world["id"], entry, "startfehler", detail, marker, sofort=sofort)
            return None
        return run_id

    def _fallback_vormerken(self, agent: dict[str, Any], entry: dict[str, Any], grund: str,
                            bis: Optional[float]) -> bool:
        """Merkt nach Startfehler oder 429 den Fallback fuer den naechsten Zug vor; True, wenn er greifen kann.

        Nur ein Zug mit dem Profilmodell merkt vor. Nach einer 429 hilft nur ein Fallback ausserhalb des Abos."""
        if (entry.get("modellwahl") or {}).get("fallback"):
            return False
        try:
            profil_agent = ad.read_agent(self.root, agent["id"])
        except ad.AgentsError:
            return False
        fallback, _ = self.fallback_agent(profil_agent)
        if fallback is None:
            return False
        harness = entry.get("harness") or self.harness(profil_agent)
        if grund == "kontingent" and modell_abo(self.harness(fallback)) == modell_abo(harness):
            return False
        with self._zuege() as state:
            state["fallback"][agent["id"]] = {"grund": grund, "bis": bis, "seit": self._now(), "run": entry["run_id"],
                                              "profil": (profil_agent.get("model_profile") or {}).get("model")}
        return True

    # Zugende -----------------------------------------------------------------------
    def _laeufe_pruefen(self, world_id: str, summary: dict[str, Any]) -> None:
        state = self._zuege_lesen()
        for run_id, entry in sorted(state["runs"].items()):
            if entry.get("outcome") is not None:
                continue
            runs = self.runs()
            with contextlib.suppress(LaufFehler):
                runs.status(world_id, entry["agent"])
            record = self._run_record(run_id)
            if record is None:
                summary["ungeklaert"].append({"run": run_id, "reason": "kein_laufeintrag"})
                continue
            observed = record.get("observed_state")
            if observed == "stopped":
                summary["beendet"].append(self._abschliessen(world_id, entry, record))
            elif observed == "unclear":
                summary["ungeklaert"].append({"run": run_id, "agent": entry["agent"], "reason": "laufidentitaet"})
            else:
                if self._now() - float(entry["started_at"]) > self.konfig.zug_frist_s:
                    with self._zuege() as current:
                        current["runs"][run_id]["zeitlimit"] = True
                    with contextlib.suppress(LaufFehler):
                        runs.stop(world_id, entry["agent"], expected_run_id=run_id)
                summary["aktiv"].append({"run": run_id, "agent": entry["agent"], "art": entry.get("art"),
                                         "ticket": entry.get("ticket_id")})

    def _abschliessen(self, world_id: str, entry: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
        run_id, agent_id = entry["run_id"], entry["agent"]
        lauf = self.laeufe.pop(run_id, None)
        proxy = getattr(lauf, "proxy", None) if lauf is not None else None
        counts = proxy.upstream_counts() if proxy is not None else {}
        limit = proxy.upstream_limit() if proxy is not None else None
        shapes = proxy.request_shapes() if proxy is not None and hasattr(proxy, "request_shapes") else {}
        if lauf is not None:
            with contextlib.suppress(Exception):  # das Urteil haengt nicht am Kanalabbau
                lauf.close()
        # Auch ohne Laufobjekt (Traeger neu gestartet): die Zugangskopien des beendeten Zuges gehen jetzt.
        with contextlib.suppress(OSError):
            az.aufraeumen(self.orte.turns / run_id)
        receipt = LaunchReceipt.from_dict(record["receipt"]) if record.get("receipt") else None
        data = self._ausgabe(self, receipt) if receipt is not None else b""
        pi = entry.get("harness") == "pi"
        befund = pi_befund(data, entry["session_id"]) if pi else stream_befund(data, entry["session_id"])
        art = entry.get("art", "ticket")
        ticket = ad.read_ticket(self.root, entry["ticket_id"]) if entry.get("ticket_id") else None
        belegt = None
        if art == "nachricht":
            belegt = self._antwort_belegt(agent_id, entry["nachricht_id"])
        elif art == "antrag":
            belegt = self._antrag_belegt(entry.get("frage_id"))
        elif art in {"antwort", "rueckmeldung"}:
            belegt = True
        verdict = zug_urteil(befund, record.get("exit_code"), stop_requested=record.get("desired_state") == "stopped",
                             ticket=ticket, agent_id=agent_id, result_revision_before=int(entry["revision_before"]),
                             proxy_counts=counts, ergebnis_belegt=belegt)
        outcome, detail = verdict.status, verdict.detail
        zeitlimit = bool(self._zuege_lesen()["runs"][run_id].get("zeitlimit"))
        if outcome == "gestoppt" and zeitlimit:
            outcome, detail = "zeitlimit", "Zugfrist ueberschritten; der Traeger hat den Zug beendet"
        # Lernschritt und Messung gehoeren zu jedem Zug; beides ist je Zug idempotent.
        lernschritt = self._lernschritt(agent_id, entry)
        messung = self._messen(agent_id, entry, data, ticket, art)
        skill_aufrufe = _skill_aufrufe(data, self._zuege_lesen()["runs"][run_id].get("skills") or [],
                                       (self._skills_pfade(agent_id)))
        # Jede neue Zustellung derselben Sitzung (Fortsetzung, Rueckgabe, Nachricht) setzt sie fort.
        try:
            # Pi fuehrt seine Sitzung selbst im Sitzungsordner des Agenten; nur Claude braucht eine Uebergabe.
            handoff = None if pi else uebergabe_sichern(
                Path(entry["config_dir"]), entry["session_id"], entry["workspace"], self.orte.handoffs,
                world=world_id, agent=agent_id, run_id=run_id, clock=self._clock)
        except (ClaudeAdapterFehler, OSError, ValueError):
            handoff = None
        with self._zuege() as state:
            sessions = state["sessions"].setdefault(agent_id, {})
            previous = sessions.get(entry["session_key"]) or {}
            sessions[entry["session_key"]] = {
                "session_id": entry["session_id"], "harness": entry.get("harness"),
                "handoff_run": run_id if handoff is not None else (
                    previous.get("handoff_run") if previous.get("harness", entry.get("harness")) == entry.get("harness")
                    else None)}
            state["runs"][run_id].update({"stream": befund.status, "exit_code": record.get("exit_code"),
                                          "handoff": handoff is not None, "upstream": counts,
                                          "anfragen_form": shapes, "lernschritt": lernschritt, "messung": messung,
                                          "skill_aufrufe": skill_aufrufe,
                                          "api_error_status": befund.api_error_status,
                                          "rate_limit": befund.rate_limit})
        if zeitlimit:
            self._bindung_freigeben(world_id, agent_id)
        schlaf = self._nachbereiten(world_id, entry, outcome, detail,
                                    self._marker(art, entry.get("ticket_id"), entry.get("nachricht_id"),
                                                 entry.get("frage_id"), agent_id),
                                    befund=befund, limit=limit)
        result = {"run": run_id, "agent": agent_id, "art": art, "ticket": entry.get("ticket_id"),
                  "outcome": outcome, "stream": befund.status, "handoff": handoff is not None,
                  "lernschritt": lernschritt.get("status")}
        if lernschritt.get("urteil"):
            result["vermerk"] = lernschritt["urteil"]
        if schlaf:
            result["folge"] = schlaf
        return result

    def _bindung_freigeben(self, world_id: str, agent_id: str) -> None:
        """Nach einem Stopp durch den Traeger selbst (Zugfrist) darf der Agent wieder starten.

        Nur wenn Welt und Agent weiterhin laufen sollen; ein Sofortstopp des Menschen bleibt bestehen
        (gemessen am 14.09.2026: ohne Freigabe endete jede Recovery mit ``startfehler``)."""
        world = ad.read_world(self.root)
        agent = ad.read_agent(self.root, agent_id)
        if WELT_ZUSTAND.get(world["state"]) == "running" and AGENT_ZUSTAND.get(agent.get("state")) == "running":
            with contextlib.suppress(LaufFehler):
                RunController(self.orte.runs).resume(world_id, agent_id)

    def _lernschritt(self, agent_id: str, entry: dict[str, Any]) -> dict[str, Any]:
        """Wendet den Lernschritt des Zuges an; fehlt er, lautet das Urteil „kein Lernschritt“, ohne Wiederholung."""
        run_dir = entry.get("run_dir") or str(Path(entry["config_dir"]).parent)
        try:
            result = ask.lernschritt_anwenden(self.root, agent_id, run_dir, library=self.konfig.skill_bibliothek)
        except (ad.AgentsError, OSError, ValueError) as exc:
            return {"status": "fehler", "fehler": "%s: %s" % (type(exc).__name__, str(exc)[:200])}
        keep = {key: result.get(key) for key in ("status", "art", "ziel", "fehler", "vorschlag_fehler") if result.get(key)}
        if isinstance(result.get("vorschlag"), dict):
            keep["vorschlag"] = result["vorschlag"].get("ticket") or result["vorschlag"].get("id")
        if result.get("status") == "fehlt":
            keep["urteil"] = "kein Lernschritt"
        return keep

    def _messen(self, agent_id: str, entry: dict[str, Any], data: bytes, ticket: Optional[dict[str, Any]],
                art: str) -> Optional[dict[str, Any]]:
        """Tokenzahl des Zuges je Ticketart in ``messungen.jsonl``."""
        messung = ask.measure_turn(data, entry.get("harness") or "claude") if data else None
        if not messung:
            return None
        kind = ask.ticket_kind(ticket, art)
        try:
            ask.record_measurement(self.root, agent_id, kind, messung, entry["run_id"], entry.get("ticket_id"))
        except (ad.AgentsError, OSError) as exc:
            return {"fehler": "%s: %s" % (type(exc).__name__, str(exc)[:200])}
        return {"ticketart": kind, "gesamt": messung["tokens"]["gesamt"], "vollstaendig": messung.get("vollstaendig")}

    def _skills_pfade(self, agent_id: str) -> dict[str, str]:
        path = ad._agent_dir(self.root, agent_id) / "skills.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() and not path.is_symlink() else {}
        except (OSError, ValueError):
            return {}
        return {item["name"]: (item.get("datei") or item["pfad"]) if item.get("art") == "skript" else item["pfad"]
                for item in data.get("skills") or [] if isinstance(item, dict)}

    def _nachbereiten(self, world_id: str, entry: dict[str, Any], outcome: str, detail: str, marker: str, *,
                      befund: Any = None, limit: Optional[dict[str, Any]] = None,
                      sofort: bool = False) -> Optional[dict[str, Any]]:
        """Speichert das Urteil, quittiert und plant Schlaf oder Recovery; startet selbst nichts."""
        run_id, agent_id, art = entry["run_id"], entry["agent"], entry.get("art", "ticket")
        delivery = Delivery(entry["delivery_id"], world_id, agent_id, entry.get("cause") or "ticket", 0.0, "",
                            None, tuple(entry.get("chain") or ()))
        follow: Optional[dict[str, Any]] = None
        content = None
        if art in {"ticket", "fortsetzen"} and entry.get("ticket_id"):
            content = lambda grund: _inhalt("fortsetzen", ticket_id=entry["ticket_id"], grund=grund)  # noqa: E731
        elif art in {"nachricht", "rueckmeldung"}:
            content = lambda grund: _inhalt(art, nachricht_id=entry["nachricht_id"], grund=grund)  # noqa: E731
        elif art == "antrag":
            content = lambda grund: _inhalt(art, nachricht_id=entry["nachricht_id"], frage_id=entry["frage_id"],  # noqa: E731
                                            grund=grund)
        elif art == "antwort":
            content = lambda grund: _inhalt("antwort", frage_id=entry["frage_id"], grund=grund)  # noqa: E731
        if outcome in SCHLAF_URTEILE and content is not None:
            freigabe = self._freigabe_nach_abweisung(outcome, befund, limit)
            bis = freigabe.naechster_start or (self._now() + RECHECK_S)
            # 429 des Abos mit einem Fallback ausserhalb dieses Abos: sofort mit dem Fallback fortsetzen, das Abo
            # bleibt fuer diesen Agenten bis zum Ende der Sperre vorgemerkt.
            if outcome == "kontingent" and self._fallback_vormerken({"id": agent_id}, entry, "kontingent", bis):
                sofort = True
            else:
                fallback, fehlt = self.fallback_agent(ad.read_agent(self.root, agent_id))
                quelle = dict(freigabe.as_dict(), fallback={
                    "modell": (fallback or {}).get("model_profile", {}).get("model"),
                    "grund": "bereits_fallback" if (entry.get("modellwahl") or {}).get("fallback")
                    else fehlt or ("gleiches_abo" if outcome == "kontingent" else None)})
                timer = self._schlafen(agent_id, outcome, bis, quelle, content(outcome), delivery)
                follow = {"schlaf": outcome, "bis": bis, "wecker": timer,
                          "sperren": [item.as_dict() for item in freigabe.sperren], "fallback": quelle["fallback"]}
        if follow is None and (outcome in RECOVERY_URTEILE or sofort) and content is not None:
            with self._zuege() as state:
                count = int(state["zaehler"].get("recovery", 0)) + 1
                state["zaehler"]["recovery"] = count
            # Mit vorgemerktem Fallback sofort, sonst mit Abstand: ein neuer Versuch mit demselben Modell braucht Zeit.
            recovery = Delivery(ad.derived_id("recovery", agent_id, count), world_id, agent_id, "recovery",
                                self._now() + (0.0 if sofort else RECOVERY_ABSTAND_S), content(outcome),
                                delivery.delivery_id, tuple(delivery.chain) + (delivery.delivery_id,))
            self._registrieren(recovery)
            follow = {"recovery": recovery.delivery_id, "faellig": recovery.due_at}
            if sofort:
                follow["fallback"] = True
        with self._zuege() as state:
            state["runs"][run_id].update({"outcome": outcome, "detail": detail, "ended_at": self._now(),
                                          "marker_after": marker, "folge": follow})
        self.wecker.resolve(entry["delivery_id"], entry["claim_id"], run_id=run_id, progress_marker=marker,
                            outcome=outcome)
        posten = Posten(delivery, art, entry.get("ticket_id"), entry.get("nachricht_id"), entry.get("frage_id"),
                        postfach_id=entry.get("postfach_id"))
        if self._quittierbar(posten, outcome):
            self._quittieren(agent_id, entry.get("postfach_id"))
        if art in {"nachricht", "rueckmeldung", "antrag"} and outcome == "erfolg":
            self._quittieren(agent_id, entry["nachricht_id"])
        if entry.get("ticket_id"):
            ad.record_run_outcome(self.root, entry["ticket_id"], run_id, outcome, detail)
        return follow

    def _freigabe_nach_abweisung(self, outcome: str, befund: Any, limit: Optional[dict[str, Any]]) -> Startfreigabe:
        rate_limit = getattr(befund, "rate_limit", None)
        if self.kontingentquelle is not None:
            return self.kontingentquelle.freigabe(rate_limit=rate_limit, proxy_limit=limit,
                                                  backend_abgewiesen=outcome == "kontingent",
                                                  anmeldung_fehlt=outcome == "anmeldung")
        return KontingentQuelle(None, None, clock=self._clock).freigabe(
            rate_limit=rate_limit, proxy_limit=limit, backend_abgewiesen=outcome == "kontingent",
            anmeldung_fehlt=outcome == "anmeldung")

    # Zeitgeber ---------------------------------------------------------------------
    def naechster_weckzeitpunkt(self) -> Optional[float]:
        """Fruehester Zeitpunkt, zu dem ein schlafender Agent oder ein Wecker wieder Arbeit bekommt."""
        world = ad.read_world(self.root)
        if WELT_ZUSTAND[world["state"]] != "running":
            return None
        agents = {agent["id"]: agent for agent in ad.list_agents(self.root)}
        now = self._now()
        candidates: list[float] = []
        state = self._zuege_lesen()
        for agent_id, schlaf in state["schlaf"].items():
            if AGENT_ZUSTAND.get((agents.get(agent_id) or {}).get("state")) == "running":
                candidates.append(float(schlaf["bis"]))
        for delivery, status in self.wecker.offene(world["id"]):
            if delivery.cause not in {"self_timer", "recovery"} or status.status != "pending":
                continue
            if AGENT_ZUSTAND.get((agents.get(delivery.agent) or {}).get("state")) != "running":
                continue
            if status.reason in {"recovery_limit", "paused", "stopped"}:
                continue
            spacing = status.reason in {"self_timer_spacing", "recovery_spacing"}
            candidates.append(max(delivery.due_at, now + 60.0) if spacing else delivery.due_at)
        return min(candidates) if candidates else None

    def zeitgeber_stellen(self) -> Optional[float]:
        when = self.naechster_weckzeitpunkt()
        if self._zeitgeber is not None:
            try:
                self._zeitgeber(when)
            except (TraegerFehler, OSError, subprocess.SubprocessError) as exc:
                # Ein fehlender Zeitgeber haelt das Leerlaufende nicht auf; er bleibt im Log sichtbar.
                self.zeitgeber_fehler = "%s: %s" % (type(exc).__name__, str(exc)[:200])
        return when

    # Steuerung -------------------------------------------------------------------
    def agent_pausieren(self, agent_id: str, grund: Optional[str] = None, absender: str = "cli-operator") -> dict:
        ad.set_agent_state(self.root, agent_id, "pausiert", grund, absender, None)
        handle = self.runs().pause(self.world_id(), agent_id)
        return {"agent": agent_id, "desired": "paused", "active_run": handle.run_id if handle else None}

    def agent_stoppen(self, agent_id: str, grund: Optional[str] = None, absender: str = "cli-operator") -> dict:
        ad.set_agent_state(self.root, agent_id, "gestoppt", grund, absender, None)
        handle = self.runs().stop(self.world_id(), agent_id)
        return {"agent": agent_id, "desired": "stopped", "run": handle.run_id if handle else None,
                "observed": handle.observed_state if handle else None}

    def agent_fortsetzen(self, agent_id: str, absender: str = "cli-operator") -> dict:
        ad.set_agent_state(self.root, agent_id, "aktiv", None, absender, None)
        self.runs().resume(self.world_id(), agent_id)
        reopened = self._unterbrochene_oeffnen({agent_id}, absender)
        return {"agent": agent_id, "desired": "running", "reopened": reopened}

    def welt_pausieren(self, grund: Optional[str] = None, absender: str = "cli-operator") -> dict:
        ad.set_world_state(self.root, "pausiert", grund, absender, None)
        world_id, runs, active = self.world_id(), self.runs(), []
        for agent in ad.list_agents(self.root):
            handle = runs.pause(world_id, agent["id"])
            if handle is not None:
                active.append(handle.run_id)
        return {"world": world_id, "desired": "paused", "active_runs": active}

    def welt_stoppen(self, grund: Optional[str] = None, absender: str = "cli-operator") -> dict:
        ad.set_world_state(self.root, "gestoppt", grund, absender, None)
        world_id, runs, stopped = self.world_id(), self.runs(), []
        for agent in ad.list_agents(self.root):
            handle = runs.stop(world_id, agent["id"])
            if handle is not None:
                stopped.append({"run": handle.run_id, "observed": handle.observed_state})
        return {"world": world_id, "desired": "stopped", "stopped": stopped}

    def welt_fortsetzen(self, absender: str = "cli-operator") -> dict:
        ad.set_world_state(self.root, "läuft", None, absender, None)
        world_id, runs, active = self.world_id(), self.runs(), set()
        for agent in ad.list_agents(self.root):
            if agent.get("state") == "aktiv":
                runs.resume(world_id, agent["id"])
                active.add(agent["id"])
        return {"world": world_id, "desired": "running", "reopened": self._unterbrochene_oeffnen(active, absender)}

    def _unterbrochene_oeffnen(self, agents: set[str], absender: str) -> list[dict[str, str]]:
        reopened = []
        for ticket in ad.list_tickets(self.root):
            if ticket.get("state") == "unterbrochen" and ticket.get("assignee") in agents:
                result = ad.reopen_interrupted_ticket(self.root, ticket["id"], absender, None)
                reopened.append({"ticket": ticket["id"], "state": result["state"]})
        # Eine durch Sofortstopp unterbrochene Nachricht bekommt eine neue Zustellung derselben Nachricht.
        world_id = self.world_id()
        state = self._zuege_lesen()
        for entry in state["runs"].values():
            if entry.get("art") not in {"nachricht", "rueckmeldung", "antrag"} or entry.get("agent") not in agents \
                    or entry.get("outcome") != "gestoppt":
                continue
            if entry.get("fortgesetzt") or (entry["art"] == "nachricht"
                                            and self._antwort_belegt(entry["agent"], entry["nachricht_id"])) or (
                    entry["art"] == "antrag" and self._antrag_belegt(entry.get("frage_id"))):
                continue
            extra = {"frage_id": entry["frage_id"]} if entry["art"] == "antrag" else {}
            delivery = Delivery(ad.derived_id("nachricht-fortsetzen", entry["run_id"]), world_id, entry["agent"],
                                "fresh_message", self._now(),
                                _inhalt(entry["art"], nachricht_id=entry["nachricht_id"], grund="fortsetzen", **extra))
            self.wecker.claim(delivery, desired_world_state="running", desired_agent_state="running",
                              active_run="registrierung", progress_marker=None)
            with self._zuege() as current:
                current["runs"][entry["run_id"]]["fortgesetzt"] = delivery.delivery_id
            reopened.append({"nachricht": entry["nachricht_id"], "state": "offen"})
        return reopened

    def klaeren(self, agent_id: str) -> dict[str, Any]:
        """Klaert einen ungeklaerten Lauf des Agenten ueber den Launcher; loest ihn nur bei belegtem Ende."""
        handle = self.runs().klaeren(self.world_id(), agent_id)
        return {"agent": agent_id, "run": handle.run_id if handle else None,
                "observed": handle.observed_state if handle else None}

    def status(self) -> dict[str, Any]:
        state = self._zuege_lesen()
        world_id = self.world_id()
        ungeklaert = [item for item in RunController(self.orte.runs).ungeklaert() if item.get("world") == world_id] \
            if self.orte.runs.exists() else []
        kontingent = self.kontingentquelle.quelle() if self.kontingentquelle is not None else {
            "art": "backend", "werkzeuge": []}
        messungen = {}
        for agent in ad.list_agents(self.root):
            try:
                messungen[agent["id"]] = ask.evaluate_measurements(self.root, agent["id"])
            except ad.AgentsError as exc:
                messungen[agent["id"]] = {"fehler": str(exc)[:200]}
        import agents_autostart
        try:
            eigene = str((self.root / "traeger.json").resolve())
            autostart = {"registriert": any(item.get("konfig") == eigene
                                            for item in agents_autostart.register_lesen()["welten"]),
                         "letzter_lauf": agents_autostart.letzter_lauf()}
        except (agents_autostart.AutostartFehler, OSError, ValueError) as exc:
            autostart = {"fehler": str(exc)[:200]}
        return {"world": world_id, "anmeldung": self.anmeldequelle.status(), "kontingentquelle": kontingent,
                "messungen": messungen, "autostart": autostart,
                "ungeklaerte_laeufe": ungeklaert, "schlaf": state["schlaf"],
                "offene_wecker": [dict(item.as_dict(), status=status.status, reason=status.reason)
                                  for item, status in self.wecker.offene(world_id)],
                "naechster_weckzeitpunkt": self.naechster_weckzeitpunkt(),
                "offene_zuege": [entry for entry in state["runs"].values() if entry.get("outcome") is None],
                "fallback_vorgemerkt": state["fallback"],
                "letzte_zuege": sorted((entry for entry in state["runs"].values() if entry.get("outcome")),
                                       key=lambda entry: entry.get("ended_at") or 0)[-10:],
                "agenten": self.zug_stand()}

    def zug_stand(self) -> dict[str, dict[str, Any]]:
        """Das Lebenszeichen je Agent fuer die Oberflaeche (Auftrag agentaktiv, docs/AGENTS-OBERFLAECHE.md).

        ``laeuft``/``seit``/``art``: der offene Zug. ``zustellung_offen``: eine Zustellung wartet auf einen Zug
        (Postfach, beantwortete Frage, faelliger Wecker), ``wartet_seit`` die aelteste davon. ``grund``: warum
        sie keinen Zug hat, soweit der Traeger es festhaelt (``kontingent``, ``anmeldung``, ``recovery_limit``,
        ``pausiert``, ``gestoppt``, ``ungeklaert``, ein Wecker-Grund oder das Urteil des letzten Zuges dafuer).
        ``naechster_wecker``: wann ein Selbstwecker oder das Ende des Schlafs den Agenten wieder weckt.
        ``letzter``: Ende, Urteil und Art des letzten beendeten Zuges. Liest nur; beansprucht nichts.
        """
        state = self._zuege_lesen()
        world = ad.read_world(self.root)
        world_id = world["id"]
        now = self._now()
        ungeklaert = {item.get("agent") for item in RunController(self.orte.runs).ungeklaert()
                      if item.get("world") == world_id} if self.orte.runs.exists() else set()
        offene = self.wecker.offene(world_id)
        raus: dict[str, dict[str, Any]] = {}
        for agent in ad.list_agents(self.root):
            agent_id = agent["id"]
            eigene = [entry for entry in state["runs"].values() if entry.get("agent") == agent_id]
            laufend = sorted((e for e in eigene if e.get("outcome") is None), key=lambda e: float(e.get("started_at") or 0))
            beendet = sorted((e for e in eigene if e.get("outcome")), key=lambda e: float(e.get("ended_at") or 0))
            zug = laufend[-1] if laufend else None
            wecker_zeiten: list[float] = []
            schlaf = state["schlaf"].get(agent_id)
            if schlaf and float(schlaf.get("bis") or 0) > now:
                wecker_zeiten.append(float(schlaf["bis"]))
            wartend: list[tuple[Posten, Optional[str]]] = []
            if zug is None:
                for posten in self._posten(world_id, agent_id):
                    if posten.art == "aufwachen":
                        continue
                    try:
                        status = self.wecker.status(posten.delivery.delivery_id)
                    except WeckerFehler:
                        status = None
                    if status is not None and status.status == "completed":
                        continue
                    if posten.delivery.cause in {"self_timer", "recovery"} and posten.delivery.due_at > now + 1.0:
                        continue
                    wartend.append((posten, status.reason if status is not None else None))
            for delivery, status in offene:
                if delivery.agent == agent_id and delivery.cause in {"self_timer", "recovery"} and delivery.due_at > now \
                        and status.reason not in {"recovery_limit", "paused", "stopped"}:
                    wecker_zeiten.append(float(delivery.due_at))
            grund: Optional[str] = None
            if zug is None and wartend:
                ids = {posten.delivery.delivery_id for posten, _ in wartend}
                fehlgeschlagen = [e for e in beendet if e.get("delivery_id") in ids and e.get("outcome") not in {"erfolg", "bereits_erledigt"}]
                gruende = [reason for _, reason in wartend if reason and reason not in {"not_due", "claim_in_flight", "active_run"}]
                if world.get("state") in {"pausiert", "gestoppt"}:
                    grund = world["state"]
                elif agent.get("state") in {"pausiert", "gestoppt", "archiviert"}:
                    grund = "gestoppt" if agent["state"] == "archiviert" else agent["state"]
                elif schlaf and float(schlaf.get("bis") or 0) > now:
                    grund = str(schlaf.get("grund") or "schlaeft")
                elif agent_id in ungeklaert:
                    grund = "ungeklaert"
                elif gruende:
                    grund = {"paused": "pausiert", "stopped": "gestoppt"}.get(gruende[0], gruende[0])
                elif fehlgeschlagen:
                    grund = str(fehlgeschlagen[-1]["outcome"])
            letzter = beendet[-1] if beendet else None
            raus[agent_id] = {
                "laeuft": zug is not None,
                "seit": _iso(zug.get("started_at")) if zug else None,
                "art": _zug_art(zug) if zug else None,
                "zustellung_offen": bool(wartend),
                "wartet_seit": _iso(min(posten.delivery.due_at for posten, _ in wartend)) if wartend else None,
                "grund": grund,
                "naechster_wecker": _iso(min(wecker_zeiten)) if wecker_zeiten else None,
                "letzter": {"ende": _iso(letzter.get("ended_at")), "ergebnis": str(letzter["outcome"]),
                            "art": _zug_art(letzter), "modellwahl": letzter.get("modellwahl")} if letzter else None,
                "modellwahl": zug.get("modellwahl") if zug else None,
                "fallback": (schlaf.get("quelle") or {}).get("fallback") if schlaf and float(schlaf.get("bis") or 0) > now
                else None,
            }
        return raus

    # Lebenszyklus ----------------------------------------------------------------
    def laufen(self, *, frist_s: float = 3600.0, poll_s: float = 0.5,
               log: Callable[[dict[str, Any]], None] = lambda _entry: None) -> dict[str, Any]:
        """Arbeitet, bis kein Zug laeuft und keine Zustellung beansprucht werden kann."""
        with _flock(self.orte.traeger_lock, blocking=False) as owned:
            if not owned:
                return {"status": "laeuft_bereits"}
            with _flock(self.orte.wecken_lock):
                with contextlib.suppress(FileNotFoundError):
                    self.orte.exiting.unlink()
            deadline = time.monotonic() + frist_s
            passes = 0
            while True:
                summary = self.einmal()
                passes += 1
                if summary["gestartet"] or summary["beendet"]:
                    log(summary)
                if not (summary["aktiv"] or summary["gestartet"]):
                    with _flock(self.orte.wecken_lock):
                        final = self.einmal()
                        passes += 1
                        if not (final["aktiv"] or final["gestartet"]):
                            when = self.zeitgeber_stellen()
                            _exiting_markieren(self.orte.exiting)
                            log({"idle": final, "passes": passes, "zeitgeber": when,
                                 "zeitgeber_fehler": getattr(self, "zeitgeber_fehler", None)})
                            return {"status": "leerlauf", "passes": passes, "letzter": final, "zeitgeber": when}
                        log(final)
                if time.monotonic() > deadline:
                    for entry in self._zuege_lesen()["runs"].values():
                        if entry.get("outcome") is None:
                            with self._zuege() as current:
                                current["runs"][entry["run_id"]]["zeitlimit"] = True
                            with contextlib.suppress(LaufFehler):
                                self.runs().stop(self.world_id(), entry["agent"], expected_run_id=entry["run_id"])
                    deadline = time.monotonic() + 60
                time.sleep(poll_s)


def _iso(zeit: Any) -> Optional[str]:
    """Epoch-Sekunden als ISO-Zeit in UTC, wie die Weltdateien sie schreiben (``agents_data.now``)."""
    if not isinstance(zeit, (int, float)) or isinstance(zeit, bool) or zeit <= 0:
        return None
    return _dt.datetime.fromtimestamp(float(zeit), _dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _zug_art(entry: dict[str, Any]) -> str:
    """Die Art eines Zuges fuer die Oberflaeche: ``recovery``, ``ticket``, ``frage`` oder ``nachricht``."""
    if entry.get("cause") == "recovery":
        return "recovery"
    art = entry.get("art")
    if art in {"ticket", "fortsetzen"} or (entry.get("ticket_id") and art not in {"nachricht", "rueckmeldung", "antrag", "antwort"}):
        return "ticket"
    if art == "antwort":
        return "frage"
    return "nachricht"


def _skill_aufrufe(data: bytes, namen: list[str], pfade: dict[str, str]) -> list[dict[str, str]]:
    """Bash-Aufrufe des Zuges, die ein Skript eines verzeichneten Skills starten."""
    found: list[dict[str, str]] = []
    for line in data.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(event, dict):
            continue
        content = (event.get("message") or {}).get("content") if isinstance(event.get("message"), dict) else None
        blocks = [b for b in content or [] if isinstance(b, dict) and b.get("type") == "tool_use"] \
            if isinstance(content, list) else []
        if event.get("type") == "tool_execution_start":  # Pi
            blocks = [{"input": event.get("args") if isinstance(event.get("args"), dict) else {}}]
        for block in blocks:
            command = str((block.get("input") or {}).get("command") or "")
            for name in namen:
                base = pfade.get(name)
                if not base:
                    continue
                if base.endswith((".py", ".sh")) or "/skripte/" in base:
                    # Gespeichertes Skript: der Pfad der Skriptdatei steht im Aufruf.
                    if base in command or base.rsplit("/", 1)[0] + "/" in command:
                        found.append({"skill": name, "skript": base.rsplit("/", 1)[-1][:120]})
                elif (base.rstrip("/") + "/scripts/") in command:
                    script = command.split(base.rstrip("/") + "/scripts/", 1)[1].split()[0] if command else ""
                    found.append({"skill": name, "skript": script[:120]})
    return found


def _process_start(pid: int) -> Optional[str]:
    try:
        text = Path("/proc/%d/stat" % pid).read_text(encoding="utf-8")
        return text[text.rfind(")") + 2:].split()[19]
    except (OSError, IndexError):
        return None


def _exiting_markieren(path: Path) -> None:
    atomar_schreiben.schreiben(path, json.dumps({"pid": os.getpid(), "start": _process_start(os.getpid())}),
                               modus=0o600)


def _traeger_beendet_sich(path: Path) -> bool:
    try:
        marker = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return marker.get("start") is not None and _process_start(int(marker.get("pid", 0))) == marker.get("start")


def _systemd_env() -> dict[str, str]:
    """Umgebung fuer ``systemctl --user``: ein CLI-Aufruf ohne Sitzungsvariablen findet den User-Manager."""
    env = dict(os.environ)
    runtime = Path("/run/user/%d" % os.getuid())
    if not env.get("XDG_RUNTIME_DIR") and runtime.is_dir():
        env["XDG_RUNTIME_DIR"] = str(runtime)
    return env


def _systemd_werkzeuge(konfig: TraegerKonfig) -> tuple[str, str]:
    """Werkzeuge fuer Traeger-Unit und Zeitgeber; ``systemd`` ueberschreibt die Launcherwerte."""
    tools = dict(konfig.launcher)
    tools.update(konfig.systemd or {})
    systemd_run = tools.get("systemd_run") or shutil.which("systemd-run")
    systemctl = tools.get("systemctl") or shutil.which("systemctl")
    if not systemd_run or not systemctl:
        raise TraegerFehler("systemd-run oder systemctl fehlt")
    return systemd_run, systemctl


def systemd_zeitgeber(konfig: TraegerKonfig, konfig_pfad: Path) -> Callable[[Optional[float]], dict[str, Any]]:
    """Ein transienter Einmal-Zeitgeber je Welt, der zur Weckzeit nur ``wecken`` aufruft."""
    systemd_run, systemctl = _systemd_werkzeuge(konfig)
    unit = zeitgeber_unit(konfig)

    def stellen(when: Optional[float]) -> dict[str, Any]:
        for action in (["stop", unit + ".timer"], ["reset-failed", unit + ".service"]):
            subprocess.run([systemctl, "--user", *action], text=True, capture_output=True, timeout=10,
                           env=_systemd_env())
        if when is None:
            return {"zeitgeber": None}
        delay = max(1, int(math.ceil(when - time.time())))
        result = subprocess.run([
            systemd_run, "--user", "--quiet", "--collect", "--unit=" + unit, "--on-active=%ds" % delay,
            "--timer-property=AccuracySec=1s",
            "--setenv=PATH=/usr/bin:/bin", "--description=wb-agents-traeger-wecker",
            konfig.python, "-I", str(Path(__file__).resolve()), "wecken", "--konfig", str(konfig_pfad),
        ], text=True, capture_output=True, timeout=15, env=_systemd_env())
        if result.returncode != 0:
            raise TraegerFehler("Zeitgeber konnte nicht gestellt werden: %s" % result.stderr.strip()[:200])
        return {"zeitgeber": unit + ".timer", "in_s": delay}

    return stellen


def wecken(konfig_pfad: Path, *, frist_s: float = 20.0) -> str:
    """Startet den Traeger als transiente User-Unit; ein laufender Traeger wird nicht verdoppelt."""
    konfig_pfad = Path(konfig_pfad).resolve()
    konfig = TraegerKonfig.laden(konfig_pfad)
    orte = konfig.orte()
    _private_dir(orte.state, "Traegerzustand")
    systemd_run, systemctl = _systemd_werkzeuge(konfig)
    unit = traeger_unit(konfig)
    world_id = ad.read_world(konfig.world_root)["id"]
    command = [
        systemd_run, "--user", "--quiet", "--collect", "--unit=" + unit, "--service-type=exec",
        "--property=Restart=no", "--property=UMask=0077",
        "--property=StandardOutput=append:%s" % orte.log, "--property=StandardError=append:%s" % orte.log,
        "--setenv=PATH=/usr/bin:/bin", "--description=wb-agents-traeger %s" % world_id,
        konfig.python, "-I", str(Path(__file__).resolve()), "laufen", "--konfig", str(konfig_pfad),
    ]
    deadline = time.monotonic() + frist_s
    zurueckgesetzt = False
    with _flock(orte.wecken_lock):
        while True:
            exiting = _traeger_beendet_sich(orte.exiting)
            result = subprocess.run(command, text=True, capture_output=True, timeout=15, env=_systemd_env())
            if result.returncode == 0:
                return "gestartet"
            active = subprocess.run([systemctl, "--user", "is-active", unit], text=True, capture_output=True,
                                    timeout=5, env=_systemd_env()).stdout.strip()
            if not exiting and active in {"active", "activating", "reloading"}:
                return "laeuft"
            if active == "failed" and not zurueckgesetzt:
                # Eine fehlgeschlagene Unit dieses Namens (etwa nach SIGKILL) blockiert systemd-run bis zur
                # Frist: genau diese Unit zuruecksetzen und sofort neu starten, einmal je Aufruf.
                subprocess.run([systemctl, "--user", "reset-failed", unit], text=True, capture_output=True,
                               timeout=10, env=_systemd_env())
                zurueckgesetzt = True
                continue
            if time.monotonic() > deadline:
                raise TraegerFehler("Traeger konnte nicht geweckt werden: %s" % (result.stderr or active).strip()[:200])
            time.sleep(0.2)


KONFIGNAME = "traeger.json"
SETUP_TOKEN_VORGABE = ".config/werkbank-agents/claude-setup-token"
ANMELDUNG_VORGABE = ".claude/.credentials.json"
LIMITS_VORGABE = ".claude/workbench/limits-latest.json"
CLAUDE_VORGABE = ".local/share/mise/installs/claude/latest/claude"
CODEX_AUTH_VORGABE = ".codex/auth.json"
REGISTRY_VORGABE = ".claude/workbench/models.json"
MODELLE_VORGABE = dict(
    [("%s:%s" % (short, effort), name) for short, name in (("opus5", "claude-opus-5"), ("sonnet5", "claude-sonnet-5"))
     for effort in ("low", "medium", "high", "xhigh")] + [("haiku", "claude-haiku-4-5-20251001")])


def einrichten(welt: str | os.PathLike[str], zustand: str | os.PathLike[str], agenten: str | os.PathLike[str], *,
               maschine: str = "lokal", claude: Optional[str] = None, ersetzen: bool = False,
               home: Optional[Path] = None, which: Callable[[str], Optional[str]] = shutil.which,
               autostart: bool = True) -> Path:
    """Schreibt ``<welt>/traeger.json`` mit den Vorgaben dieses Hosts; er ist der Traegerhost.

    Anmeldung: Setup-Token, Rueckfall auf die Nur-Lese-Anmeldung nur, solange die Tokendatei fehlt.
    Kontingent: ``limits-latest.json`` nur juenger als eine Stunde, sonst allein die Backend-Abweisung.
    """
    home = Path(home) if home is not None else Path.home()
    world_root = Path(os.path.abspath(os.path.expanduser(str(welt))))
    ad.read_world(world_root)
    target = world_root / KONFIGNAME
    if (target.exists() or target.is_symlink()) and not ersetzen:
        raise TraegerFehler("%s existiert bereits; --ersetzen ueberschreibt" % target)
    binary = claude or os.path.realpath(home / CLAUDE_VORGABE)
    if not os.path.isabs(binary) or not os.access(binary, os.X_OK):
        raise TraegerFehler("Claude-Code-Binary nicht ausfuehrbar: %s" % binary)
    systemd = {"systemd_run": which("systemd-run"), "systemctl": which("systemctl")}
    codex = which("codex")
    library = ask.library_path()
    konfig = TraegerKonfig(
        world_root=world_root, state_dir=Path(os.path.abspath(os.path.expanduser(str(zustand)))),
        agents_dir=Path(os.path.abspath(os.path.expanduser(str(agenten)))), claude_binary=binary,
        execution_host=socket.gethostname().split(".")[0].lower() if maschine == "lokal" else maschine,
        anmeldung={"kind": "setup-token", "path": str(home / SETUP_TOKEN_VORGABE),
                   "rueckfall": {"kind": "claude-login-readonly", "path": str(home / ANMELDUNG_VORGABE),
                                 "min_valid_seconds": 900}},
        modelle=dict(MODELLE_VORGABE),
        kontingent={"limits": str(home / LIMITS_VORGABE), "max_alter_s": 3600},
        systemd={key: value for key, value in systemd.items() if value} or None,
        skill_bibliothek=str(library) if library.is_dir() else None,
        registry=str(home / REGISTRY_VORGABE) if (home / REGISTRY_VORGABE).is_file() else None,
        codex={"cli": os.path.realpath(codex), "auth": str(home / CODEX_AUTH_VORGABE)} if codex else None)
    data = dict(konfig.as_dict(), maschine=maschine, traeger_modul=os.path.realpath(__file__))
    atomar_schreiben.schreiben(target, json.dumps(data, ensure_ascii=False, indent=2) + "\n", modus=0o600,
                               dauerhaft=True)
    if autostart:
        # Der Autostart weckt beim Anmelden jede eingerichtete Welt dieser Maschine einmal.
        import agents_autostart
        agents_autostart.registrieren(target)
    return target


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("einrichten")
    p.add_argument("--welt", required=True)
    p.add_argument("--zustand", required=True)
    p.add_argument("--agenten", required=True)
    p.add_argument("--maschine", default="lokal")
    p.add_argument("--claude")
    p.add_argument("--ersetzen", action="store_true")
    p.add_argument("--ohne-autostart", action="store_true")
    for name in ("laufen", "wecken", "status", "klaeren", "agent-pausieren", "agent-stoppen", "agent-fortsetzen",
                 "welt-pausieren", "welt-stoppen", "welt-fortsetzen"):
        p = sub.add_parser(name)
        p.add_argument("--konfig", required=True)
        if name.startswith("agent-") or name == "klaeren":
            p.add_argument("--agent", required=True)
        if name.endswith(("pausieren", "stoppen")):
            p.add_argument("--grund")
        if name not in {"laufen", "wecken", "status"}:
            p.add_argument("--absender", default="cli-operator")
            p.add_argument("--nicht-wecken", action="store_true")
        if name == "laufen":
            p.add_argument("--frist", type=float, default=3600.0)
        if name == "status":
            # Nur das Lebenszeichen je Agent: ohne Messungen, Autostart und Kontingentquelle, fuer den Takt der Oberflaeche.
            p.add_argument("--nur-zug", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "einrichten":
            path = einrichten(args.welt, args.zustand, args.agenten, maschine=args.maschine, claude=args.claude,
                              ersetzen=args.ersetzen, autostart=not args.ohne_autostart)
            konfig = TraegerKonfig.laden(path)
            print(json.dumps({"konfig": str(path), "anmeldung": konfig.anmeldequelle().status(),
                              "kontingentquelle": konfig.kontingentquelle().quelle()}, ensure_ascii=False))
            return 0
        if args.command == "wecken":
            print(json.dumps({"wecken": wecken(Path(args.konfig))}))
            return 0
        konfig_pfad = Path(args.konfig).resolve()
        konfig = TraegerKonfig.laden(konfig_pfad)
        if args.command == "laufen":
            traeger = WeltTraeger(konfig, zeitgeber=systemd_zeitgeber(konfig, konfig_pfad))

            def log(entry: dict[str, Any]) -> None:
                print(json.dumps(dict(entry, time=time.time()), ensure_ascii=False), flush=True)
            print(json.dumps(traeger.laufen(frist_s=args.frist, log=log), ensure_ascii=False), flush=True)
            return 0
        traeger = WeltTraeger(konfig)
        if args.command == "status" and args.nur_zug:
            print(json.dumps({"world": traeger.world_id(), "agenten": traeger.zug_stand()}, ensure_ascii=False))
            return 0
        if args.command == "status":
            print(json.dumps(traeger.status(), ensure_ascii=False, indent=2))
            return 0
        action = {
            "klaeren": lambda: traeger.klaeren(args.agent),
            "agent-pausieren": lambda: traeger.agent_pausieren(args.agent, args.grund, args.absender),
            "agent-stoppen": lambda: traeger.agent_stoppen(args.agent, args.grund, args.absender),
            "agent-fortsetzen": lambda: traeger.agent_fortsetzen(args.agent, args.absender),
            "welt-pausieren": lambda: traeger.welt_pausieren(args.grund, args.absender),
            "welt-stoppen": lambda: traeger.welt_stoppen(args.grund, args.absender),
            "welt-fortsetzen": lambda: traeger.welt_fortsetzen(args.absender),
        }[args.command]
        result = action()
        if args.command.endswith("fortsetzen") or args.command == "klaeren":
            if not args.nicht_wecken:
                result["wecken"] = wecken(konfig_pfad)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (TraegerFehler, ad.AgentsError, LaufFehler, WeckerFehler, AnmeldungNichtVerfuegbar, OSError, ValueError) as exc:
        print(json.dumps({"fehler": type(exc).__name__, "detail": str(exc)[:300]}, ensure_ascii=False), file=sys.stderr)
        return 2


__all__ = ["Posten", "TraegerFehler", "TraegerKonfig", "TraegerOrte", "WeltTraeger", "einrichten",
           "systemd_zeitgeber", "traeger_unit", "wecken", "zeitgeber_unit"]

if __name__ == "__main__":
    raise SystemExit(main())
