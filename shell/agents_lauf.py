"""Controllerseitiger Lifecycle-Vertrag fuer dauerhafte Agents.

Dieses Modul verwaltet nur Laufzustand. Es startet nichts ohne einen explizit
eingespeisten und verifizierbaren Launcher. Der Launcher besitzt die
prozessnahen Rechte; der Controller bindet jeden Lauf an Welt, Agent, Run-ID
und unveraenderliche Startdaten und haelt den Registerzustand atomar.
"""

from __future__ import annotations

import copy
import fcntl
import json
import math
import os
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Optional

import atomar_schreiben


class LaufFehler(Exception):
    """Basisklasse fuer Lifecycle-Vertragsverletzungen."""


class KeineVerifizierteStartstrecke(LaufFehler):
    """Kein vertrauenswuerdiger Launcher wurde eingespeist."""


class LaufVerweigert(LaufFehler):
    """Start oder Zustandswechsel ist im aktuellen Zustand nicht erlaubt."""


class VeralteteRueckmeldung(LaufFehler):
    """Rueckmeldung gehoert nicht zum aktuell aktiven Lauf."""


class LaufUngeklaert(LaufFehler):
    """Prozessidentitaet oder Exit konnte nicht belastbar geprueft werden."""


_NAME = re.compile(r"^[^\x00/\\]+$")
_DESIRED = frozenset({"running", "paused", "stopped"})
_OBSERVED = frozenset({"unknown", "running", "pausing", "paused", "stopped", "unclear"})
_VERSION = 1


def _name(value: str, field: str) -> str:
    if not isinstance(value, str) or not value or not _NAME.fullmatch(value):
        raise ValueError(f"{field} muss ein einzelner nichtleerer Bezeichner sein")
    return value


def _absolute_dir(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError(f"{field} muss ein absoluter Pfad sein")
    return str(Path(value).resolve(strict=False))


@dataclass(frozen=True)
class StartSpec:
    """Unveraenderliche, vom Controller gespeicherte Startbeschreibung."""

    argv: tuple[str, ...]
    cwd: str
    env: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.argv, tuple) or not self.argv:
            raise ValueError("argv muss ein nichtleeres Tupel sein")
        if any(not isinstance(part, str) or not part or "\x00" in part for part in self.argv):
            raise ValueError("argv enthaelt einen ungueltigen Bestandteil")
        object.__setattr__(self, "cwd", _absolute_dir(self.cwd, "cwd"))
        if not isinstance(self.env, tuple):
            raise ValueError("env muss ein Tupel sein")
        for pair in self.env:
            if (not isinstance(pair, tuple) or len(pair) != 2 or
                    any(not isinstance(value, str) or "\x00" in value for value in pair)):
                raise ValueError("env enthaelt ein ungueltiges Paar")

    def as_dict(self) -> dict[str, Any]:
        return {"argv": list(self.argv), "cwd": self.cwd, "env": [list(pair) for pair in self.env]}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "StartSpec":
        return cls(tuple(value["argv"]), value["cwd"], tuple(tuple(pair) for pair in value.get("env", [])))


@dataclass(frozen=True)
class LaunchReceipt:
    """Vom verifizierten Launcher gelieferte Prozessidentitaet."""

    pid: int
    process_group_id: int
    identity: str

    def __post_init__(self) -> None:
        if not isinstance(self.pid, int) or self.pid <= 0:
            raise ValueError("pid muss positiv sein")
        if not isinstance(self.process_group_id, int) or self.process_group_id <= 0:
            raise ValueError("process_group_id muss positiv sein")
        if not isinstance(self.identity, str) or not self.identity or "\x00" in self.identity:
            raise ValueError("identity fehlt")

    def as_dict(self) -> dict[str, Any]:
        return {"pid": self.pid, "process_group_id": self.process_group_id, "identity": self.identity}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "LaunchReceipt":
        return cls(int(value["pid"]), int(value["process_group_id"]), value["identity"])


@dataclass(frozen=True)
class Observation:
    """Vom Launcher verifizierter beobachteter Laufzustand."""

    state: str
    identity_valid: bool
    exit_code: Optional[int] = None
    checkpoint_id: Optional[str] = None

    def __post_init__(self) -> None:
        if self.state not in _OBSERVED:
            raise ValueError("unbekannter beobachteter Zustand")
        if not isinstance(self.identity_valid, bool):
            raise ValueError("identity_valid muss boolesch sein")


@dataclass(frozen=True)
class RunHandle:
    run_id: str
    world: str
    agent: str
    spec: StartSpec
    desired_state: str
    observed_state: str
    receipt: Optional[LaunchReceipt]


def _binding_key(world: str, agent: str) -> str:
    return json.dumps([world, agent], ensure_ascii=False, separators=(",", ":"))


class RunController:
    """Atomarer Controller fuer genau einen aktiven Lauf je Welt und Agent."""

    def __init__(
        self,
        register_path: str | os.PathLike[str],
        *,
        launcher: Any = None,
        clock: Callable[[], float] = time.time,
    ):
        self.register_path = Path(register_path).absolute()
        self.lock_path = self.register_path.with_name(self.register_path.name + ".lock")
        self._launcher = launcher
        self._clock = clock
        self.register_path.parent.mkdir(parents=True, exist_ok=True)

    def start(self, world: str, agent: str, run_id: str, spec: StartSpec) -> RunHandle:
        world, agent, run_id = self._identity(world, agent, run_id)
        if not isinstance(spec, StartSpec):
            raise ValueError("StartSpec fehlt oder ist nicht unveraenderlich")
        launcher = self._verified_launcher()
        key = _binding_key(world, agent)
        with self._locked_state() as state:
            controls = state["controls"].setdefault(key, {"desired_state": "running"})
            if controls["desired_state"] != "running":
                raise LaufVerweigert("neue Starts fuer Welt und Agent gesperrt")
            active_id = state["active"].get(key)
            if active_id is not None:
                active = state["runs"].get(active_id)
                if active is None:
                    raise LaufUngeklaert("aktiver Laufverweis ist ungueltig")
                observation = self._reconcile_record(active, launcher)
                self._record_observation(active, observation)
                if observation.state != "stopped" or not observation.identity_valid:
                    self._write_state(state)
                    raise LaufVerweigert("aktiver oder ungeklaerter Lauf vorhanden")
                active["desired_state"] = "stopped"
                active["ended_at"] = self._now()
                state["active"].pop(key, None)
            if run_id in state["runs"]:
                raise LaufVerweigert("run_id bereits verwendet")
            record = {
                "world": world,
                "agent": agent,
                "run_id": run_id,
                "spec": spec.as_dict(),
                "desired_state": "running",
                "observed_state": "unknown",
                "receipt": None,
                "starting": True,
                "started_at": self._now(),
                "checkpoint_id": None,
                "exit_code": None,
            }
            state["runs"][run_id] = record
            state["active"][key] = run_id
            self._write_state(state)
            try:
                receipt = launcher.launch(spec)
            except Exception as exc:
                record["starting"] = False
                record["observed_state"] = "unclear"
                record["launch_error"] = type(exc).__name__
                self._write_state(state)
                raise LaufUngeklaert("Launcher-Start fehlgeschlagen; Tombstone bleibt aktiv") from exc
            if not isinstance(receipt, LaunchReceipt):
                record["starting"] = False
                record["observed_state"] = "unclear"
                record["launch_error"] = "ungueltiges Receipt"
                self._write_state(state)
                raise LaufUngeklaert("Launcher lieferte keine belastbare Prozessidentitaet")
            record["receipt"] = receipt.as_dict()
            record["starting"] = False
            verified = self._call_bool(launcher, "verify", receipt, spec)
            observation = self._observe_receipt(launcher, receipt, spec)
            if not verified or not observation.identity_valid:
                observed_state = "unclear"
            else:
                observed_state = observation.state
            record["observed_state"] = observed_state
            record["checkpoint_id"] = observation.checkpoint_id
            record["exit_code"] = observation.exit_code
            self._write_state(state)
            return self._handle(record)

    def status(self, world: str, agent: str) -> Optional[RunHandle]:
        world, agent, _ = self._identity(world, agent, "status")
        key = _binding_key(world, agent)
        with self._locked_state() as state:
            run_id = state["active"].get(key)
            if run_id is None:
                return None
            record = state["runs"].get(run_id)
            if record is None:
                raise LaufUngeklaert("aktiver Laufverweis ist ungueltig")
            observation = self._reconcile_record(record)
            self._record_observation(record, observation)
            if observation.state == "stopped" and observation.identity_valid:
                state["active"].pop(key, None)
            self._write_state(state)
            return self._handle(record)

    def pause(self, world: str, agent: str, *, expected_run_id: str | None = None) -> Optional[RunHandle]:
        world, agent, _ = self._identity(world, agent, "pause")
        key = _binding_key(world, agent)
        with self._locked_state() as state:
            record = self._active_record(state, key)
            self._check_expected_run(record, expected_run_id)
            if record is not None:
                record["desired_state"] = "paused"
            state["controls"][key] = {"desired_state": "paused"}
            self._write_state(state)
            if record is not None:
                try:
                    launcher = self._verified_launcher()
                except KeineVerifizierteStartstrecke:
                    raise
                observation = self._reconcile_record(record, launcher)
                if observation.identity_valid and observation.state == "stopped":
                    # Ein zugbasierter Lauf kann vor der Pause bereits geendet haben.
                    # Dann gibt es keinen Checkpoint mehr anzufordern; die Sperre bleibt.
                    self._record_observation(record, observation)
                    record["ended_at"] = self._now()
                    state["active"].pop(key, None)
                    self._write_state(state)
                    return self._handle(record)
                if not observation.identity_valid or observation.state not in {"running", "paused"}:
                    self._record_observation(record, Observation("unclear", False))
                    self._write_state(state)
                    raise LaufUngeklaert("Laufidentitaet vor Pause nicht bestaetigt")
                try:
                    launcher.request_pause(LaunchReceipt.from_dict(record["receipt"]))
                except Exception as exc:
                    self._record_observation(record, Observation("unclear", False))
                    state["controls"][key] = {"desired_state": "paused"}
                    self._write_state(state)
                    raise LaufUngeklaert("Pause konnte nicht bestaetigt werden") from exc
                self._record_observation(record, observation)
            self._write_state(state)
            return self._handle(record) if record is not None else None

    def resume(self, world: str, agent: str, *, expected_run_id: str | None = None) -> Optional[RunHandle]:
        world, agent, _ = self._identity(world, agent, "resume")
        key = _binding_key(world, agent)
        with self._locked_state() as state:
            record = self._active_record(state, key)
            self._check_expected_run(record, expected_run_id)
            if record is not None:
                launcher = self._verified_launcher()
                observation = self._reconcile_record(record, launcher)
                if not observation.identity_valid or observation.state not in {"running", "paused"}:
                    self._record_observation(record, Observation("unclear", False))
                    self._write_state(state)
                    raise LaufUngeklaert("Laufidentitaet vor Fortsetzung nicht bestaetigt")
                launcher.resume(LaunchReceipt.from_dict(record["receipt"]))
                record["desired_state"] = "running"
                self._record_observation(record, observation)
            state["controls"][key] = {"desired_state": "running"}
            self._write_state(state)
            return self._handle(record) if record is not None else None

    def checkpoint(self, run_id: str, checkpoint_id: str) -> RunHandle:
        _name(run_id, "run_id")
        _name(checkpoint_id, "checkpoint_id")
        with self._locked_state() as state:
            record = self._record_for_callback(state, run_id)
            if record["desired_state"] != "paused":
                raise LaufVerweigert("Checkpoint ist ausserhalb einer Pause ungueltig")
            observation = self._reconcile_record(record)
            if not observation.identity_valid or observation.state not in {"running", "paused"}:
                self._record_observation(record, Observation("unclear", False))
                self._write_state(state)
                raise LaufUngeklaert("Checkpoint traegt keine bestaetigte Laufidentitaet")
            try:
                confirmed = self._verified_launcher().confirm_checkpoint(
                    LaunchReceipt.from_dict(record["receipt"]),
                    StartSpec.from_dict(record["spec"]),
                    checkpoint_id,
                )
            except Exception as exc:
                self._record_observation(record, Observation("unclear", False))
                self._write_state(state)
                raise LaufUngeklaert("Checkpoint konnte nicht bestaetigt werden") from exc
            if not isinstance(confirmed, Observation) or not confirmed.identity_valid:
                self._record_observation(record, Observation("unclear", False))
                self._write_state(state)
                raise LaufUngeklaert("Checkpoint traegt keine bestaetigte Laufidentitaet")
            if confirmed.state != "paused":
                self._record_observation(record, confirmed)
                self._write_state(state)
                raise LaufVerweigert("Launcher bestaetigt keinen pausierten Checkpoint")
            if confirmed.checkpoint_id != checkpoint_id:
                self._record_observation(record, confirmed)
                self._write_state(state)
                raise LaufVerweigert("Launcher bestaetigt nicht den angeforderten Checkpoint")
            self._record_observation(record, confirmed)
            self._write_state(state)
            return self._handle(record)

    def stop(self, world: str, agent: str, *, expected_run_id: str | None = None) -> Optional[RunHandle]:
        world, agent, _ = self._identity(world, agent, "stop")
        key = _binding_key(world, agent)
        with self._locked_state() as state:
            record = self._active_record(state, key)
            self._check_expected_run(record, expected_run_id)
            if record is not None:
                record["desired_state"] = "stopped"
            state["controls"][key] = {"desired_state": "stopped"}
            self._write_state(state)
            if record is None:
                return None
            try:
                launcher = self._verified_launcher()
            except KeineVerifizierteStartstrecke:
                raise
            observation = self._reconcile_record(record, launcher)
            if not observation.identity_valid:
                self._record_observation(record, Observation("unclear", False, observation.exit_code))
                self._write_state(state)
                raise LaufUngeklaert("Laufidentitaet vor Stop nicht bestaetigt")
            if observation.state != "stopped":
                receipt = LaunchReceipt.from_dict(record["receipt"])
                try:
                    launcher.terminate(receipt)
                except Exception as exc:
                    self._record_observation(record, Observation("unclear", False))
                    self._write_state(state)
                    raise LaufUngeklaert("eigene Prozessgruppe konnte nicht gestoppt werden") from exc
                observation = self._observe_receipt(launcher, receipt, StartSpec.from_dict(record["spec"]))
            if observation.state != "stopped" or not observation.identity_valid:
                self._record_observation(record, Observation("unclear", False, observation.exit_code))
                self._write_state(state)
                raise LaufUngeklaert("eigene Prozessgruppe nicht als beendet bestaetigt")
            self._record_observation(record, observation)
            record["ended_at"] = self._now()
            state["active"].pop(key, None)
            self._write_state(state)
            return self._handle(record)

    def klaeren(self, world: str, agent: str) -> Optional[RunHandle]:
        """Klaert einen ungeklaerten aktiven Lauf, ohne je etwas zu starten oder zu beenden.

        Ein lebender eigener Prozess wird uebernommen. Ein beobachtetes Ende oder ein vom
        Launcher belegtes Ende (``beendet_belegt``) loest den Tombstone. Ohne Beleg bleibt
        der Lauf ungeklaert und sperrt weiter.
        """
        world, agent, _ = self._identity(world, agent, "klaeren")
        key = _binding_key(world, agent)
        launcher = self._verified_launcher()
        with self._locked_state() as state:
            record = self._active_record(state, key)
            if record is None:
                return None
            observation = self._reconcile_record(record, launcher)
            if observation.identity_valid and observation.state != "unclear":
                self._record_observation(record, observation)
                if observation.state == "stopped":
                    record["ended_at"] = self._now()
                    state["active"].pop(key, None)
                self._write_state(state)
                return self._handle(record)
            proof = getattr(launcher, "beendet_belegt", None)
            receipt = LaunchReceipt.from_dict(record["receipt"]) if record.get("receipt") else None
            try:
                ended = callable(proof) and proof(record["world"], record["agent"], record["run_id"],
                                                  StartSpec.from_dict(record["spec"]), receipt) is True
            except Exception:
                ended = False
            if not ended:
                self._record_observation(record, Observation("unclear", False))
                self._write_state(state)
                raise LaufUngeklaert("Ende des ungeklaerten Laufs ist nicht belegt")
            record["starting"] = False
            record["observed_state"] = "stopped"
            record["klaerung"] = "belegtes_ende"
            record["ended_at"] = self._now()
            state["active"].pop(key, None)
            self._write_state(state)
            return self._handle(record)

    def ungeklaert(self) -> list[dict[str, Any]]:
        """Aktive Laeufe mit ungeklaerter Identitaet oder offenem Start-Tombstone, ohne Launcheraufruf."""
        state = self._read_state()
        result = []
        for key, run_id in state["active"].items():
            record = state["runs"].get(run_id) or {}
            if record.get("observed_state") in {"unclear", "unknown"} or record.get("starting"):
                result.append({"world": record.get("world"), "agent": record.get("agent"), "run_id": run_id,
                               "observed_state": record.get("observed_state"),
                               "launch_error": record.get("launch_error"), "started_at": record.get("started_at")})
        return result

    def is_current(self, world: str, agent: str, run_id: str) -> bool:
        """Sperrfreie Pruefung fuer Proxy und Controllerkanal eines laufenden Zuges.

        Das Register wird atomar ersetzt; ein Stop schreibt seinen Wunsch vor dem
        Beenden. Deshalb sieht diese Pruefung einen Stop, ohne auf dessen Sperre zu warten.
        Eine Pause sperrt nur neue Starts: der laufende Zug darf seinen Checkpoint erreichen.
        """
        try:
            world, agent, run_id = self._identity(world, agent, run_id)
            state = self._read_state()
        except (LaufFehler, ValueError):
            return False
        key = _binding_key(world, agent)
        record = state["runs"].get(run_id)
        controls = state["controls"].get(key) or {}
        return (
            state["active"].get(key) == run_id
            and isinstance(record, dict)
            and record.get("desired_state") in {"running", "paused"}
            and controls.get("desired_state") in {"running", "paused"}
        )

    @staticmethod
    def _check_expected_run(record: Optional[dict], expected_run_id: str | None) -> None:
        if expected_run_id is not None:
            _name(expected_run_id, "expected_run_id")
            if record is None or record["run_id"] != expected_run_id:
                raise VeralteteRueckmeldung("Steuerauftrag gehoert nicht zum aktiven Lauf")

    def report(self, run_id: str, observation: Observation) -> RunHandle:
        """Nimmt nur eine Rueckmeldung fuer den aktuell aktiven Lauf an."""
        _name(run_id, "run_id")
        if not isinstance(observation, Observation):
            raise ValueError("Observation fehlt")
        with self._locked_state() as state:
            record = self._record_for_callback(state, run_id)
            verified = self._reconcile_record(record)
            if not verified.identity_valid:
                self._record_observation(record, Observation("unclear", False, verified.exit_code))
                self._write_state(state)
                raise LaufUngeklaert("Rueckmeldung traegt keine bestaetigte Identitaet")
            if observation.state == "stopped" and verified.state != "stopped":
                raise LaufVerweigert("Rueckmeldung behauptet einen ungeprueften Exit")
            self._record_observation(record, verified)
            if verified.state == "stopped":
                key = _binding_key(record["world"], record["agent"])
                state["active"].pop(key, None)
                record["ended_at"] = self._now()
            self._write_state(state)
            return self._handle(record)

    def _record_for_callback(self, state: Mapping[str, Any], run_id: str) -> dict[str, Any]:
        record = state["runs"].get(run_id)
        if record is None:
            raise VeralteteRueckmeldung("unbekannte run_id")
        key = _binding_key(record["world"], record["agent"])
        if state["active"].get(key) != run_id:
            raise VeralteteRueckmeldung("Rueckmeldung gehoert nicht zum aktiven Lauf")
        return record

    @staticmethod
    def _identity(world: str, agent: str, run_id: str) -> tuple[str, str, str]:
        return _name(world, "world"), _name(agent, "agent"), _name(run_id, "run_id")

    def _verified_launcher(self) -> Any:
        launcher = self._launcher
        methods = ("launch", "verify", "observe", "request_pause", "resume", "confirm_checkpoint", "terminate")
        if launcher is None or any(not callable(getattr(launcher, method, None)) for method in methods):
            raise KeineVerifizierteStartstrecke("kein vollstaendiger verifizierter Launcher")
        return launcher

    @staticmethod
    def _call_bool(launcher: Any, method: str, *args: Any) -> bool:
        try:
            return bool(getattr(launcher, method)(*args))
        except Exception:
            return False

    @staticmethod
    def _observe_receipt(launcher: Any, receipt: LaunchReceipt, spec: StartSpec) -> Observation:
        try:
            observation = launcher.observe(receipt, spec)
        except Exception:
            return Observation("unclear", False)
        if not isinstance(observation, Observation):
            return Observation("unclear", False)
        return observation

    def _observe_record(self, record: Mapping[str, Any], launcher: Any) -> Observation:
        return self._observe_receipt(launcher, LaunchReceipt.from_dict(record["receipt"]),
                                     StartSpec.from_dict(record["spec"]))

    def _reconcile_record(self, record: dict[str, Any], launcher: Any = None) -> Observation:
        try:
            launcher = self._verified_launcher() if launcher is None else launcher
        except (KeineVerifizierteStartstrecke, ValueError, KeyError):
            return Observation("unclear", False)
        if record.get("receipt") is None:
            resolver = getattr(launcher, "resolve", None)
            if not callable(resolver):
                return Observation("unclear", False)
            try:
                spec = StartSpec.from_dict(record["spec"])
                resolved = resolver(record["world"], record["agent"], record["run_id"], spec)
            except Exception:
                return Observation("unclear", False)
            if not isinstance(resolved, LaunchReceipt) or not self._call_bool(launcher, "verify", resolved, spec):
                return Observation("unclear", False)
            record["receipt"] = resolved.as_dict()
            record["starting"] = False
        return self._observe_record(record, launcher)

    @staticmethod
    def _record_observation(record: dict[str, Any], observation: Observation) -> None:
        record["observed_state"] = observation.state
        record["exit_code"] = observation.exit_code
        if observation.checkpoint_id is not None:
            record["checkpoint_id"] = observation.checkpoint_id

    @staticmethod
    def _active_record(state: Mapping[str, Any], key: str) -> Optional[dict[str, Any]]:
        run_id = state["active"].get(key)
        return None if run_id is None else state["runs"].get(run_id)

    @staticmethod
    def _handle(record: Mapping[str, Any]) -> RunHandle:
        receipt = None if record.get("receipt") is None else LaunchReceipt.from_dict(record["receipt"])
        return RunHandle(
            record["run_id"], record["world"], record["agent"], StartSpec.from_dict(record["spec"]),
            record["desired_state"], record["observed_state"], receipt,
        )

    def _now(self) -> float:
        value = self._clock()
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError("Controller-Uhr liefert keine Zahl")
        return float(value)

    @contextmanager
    def _locked_state(self) -> Iterator[dict[str, Any]]:
        self.lock_path.touch(mode=0o600, exist_ok=True)
        with self.lock_path.open("r+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield self._read_state()
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _read_state(self) -> dict[str, Any]:
        if not self.register_path.exists():
            return {"version": _VERSION, "controls": {}, "active": {}, "runs": {}}
        try:
            state = json.loads(self.register_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise LaufFehler(f"Laufregister unlesbar: {exc}") from exc
        if not isinstance(state, dict) or state.get("version") != _VERSION:
            raise LaufFehler("Laufregister hat unbekannte Version")
        for field in ("controls", "active", "runs"):
            if not isinstance(state.get(field), dict):
                raise LaufFehler("Laufregister ist ungueltig")
        return copy.deepcopy(state)

    def _write_state(self, state: Mapping[str, Any]) -> None:
        atomar_schreiben.schreiben(
            self.register_path,
            json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            modus=0o600,
            dauerhaft=True,
        )
