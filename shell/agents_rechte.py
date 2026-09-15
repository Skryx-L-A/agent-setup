"""Controllerseitiger Rechtevertrag fuer Agents.

Dieses Modul ist ein kleiner Zustandsvertrag, kein Sandbox- oder
Authentifizierungssystem. Der Controller haelt einen einzigen JSON-Zustand
unter einem Prozess-Lock. Agenten bekommen ueber :func:`consumer` nur
`check`, `reserve` und `report`; Grant-Erteilung und Widerruf bleiben beim
Controller und brauchen einen von aussen eingespeisten Authenticator.
"""

from __future__ import annotations

import copy
import fcntl
import json
import math
import os
import re
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Optional, Sequence

import atomar_schreiben


class RechteFehler(Exception):
    """Basisklasse fuer alle Vertragsverletzungen."""


class KeineControllerAutorisierung(RechteFehler):
    """Keine proven Controller-/Mensch-Autorisierung verfuegbar."""


class AktionVerweigert(RechteFehler):
    """Aktion besitzt keinen aktuell passenden Grant."""


class UnbekanntesErgebnis(RechteFehler):
    """Ergebnis unklar; der verbrauchte Grant darf nicht wiederholt werden."""


_PATH_ACTIONS = frozenset({"write", "result_write", "memory_write", "push", "publish", "deploy"})
_OUTCOMES = frozenset({"success", "failure", "unknown"})
_NAME = re.compile(r"^[^\x00/\\]+$")
_VERSION = 1


def _nonempty_name(value: str, field: str) -> str:
    if not isinstance(value, str) or not value or not _NAME.fullmatch(value):
        raise ValueError(f"{field} muss ein einzelner nichtleerer Bezeichner sein")
    return value


def _canonical_path(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError(f"{field} muss ein absoluter Pfad sein")
    parts = Path(value).parts
    if ".." in parts:
        raise ValueError(f"{field} darf keine Pfadkomponente '..' enthalten")
    return str(Path(value).resolve(strict=False))


def _canonical_scopes(values: Sequence[str], field: str) -> tuple[str, ...]:
    result: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value:
            raise ValueError(f"{field} enthaelt einen leeren Scope")
        if value.startswith("/"):
            value = _canonical_path(value, field)
        if value not in result:
            result.append(value)
    return tuple(result)


@dataclass(frozen=True)
class RunContext:
    """Unveraenderlicher, fuer jede Aktion mitgefuehrter Run-Kontext."""

    world: str
    agent: str
    role: str
    run_id: str
    write_scopes: tuple[str, ...] = ()
    result_scopes: tuple[str, ...] = ()
    memory_scopes: tuple[str, ...] = ()
    protected_scopes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field in ("world", "agent", "role", "run_id"):
            _nonempty_name(getattr(self, field), field)
        for field in ("write_scopes", "result_scopes", "memory_scopes", "protected_scopes"):
            object.__setattr__(self, field, _canonical_scopes(getattr(self, field), field))

    def as_dict(self) -> dict[str, Any]:
        return {
            "world": self.world,
            "agent": self.agent,
            "role": self.role,
            "run_id": self.run_id,
            "write_scopes": list(self.write_scopes),
            "result_scopes": list(self.result_scopes),
            "memory_scopes": list(self.memory_scopes),
            "protected_scopes": list(self.protected_scopes),
        }


@dataclass(frozen=True)
class ControllerReceipt:
    """Typisierter Beleg des vertrauenswuerdigen Controller-Authenticators."""

    actor_id: str
    evidence_id: str

    def __post_init__(self) -> None:
        _nonempty_name(self.actor_id, "actor_id")
        _nonempty_name(self.evidence_id, "evidence_id")


@dataclass(frozen=True)
class Grant:
    """Ein vom Controller erteiltes, exakt gebundenes Recht."""

    grant_id: str
    action_type: str
    target: str
    scope: str
    world: str
    agent: str
    role: str
    run_id: Optional[str]
    valid_from: float
    valid_until: Optional[float]
    reusable: bool = False
    human_actor: str = ""
    human_evidence: str = ""


@dataclass(frozen=True)
class CheckResult:
    allowed: bool
    reason: str
    required_actions: tuple[str, ...] = ()


@dataclass(frozen=True)
class Reservation:
    reservation_id: str
    grant_ids: tuple[str, ...]
    action_type: str
    target: str
    scope: str
    operation_id: str
    context: RunContext


def _context_equal(left: Mapping[str, Any], right: RunContext) -> bool:
    return all(left.get(field) == getattr(right, field)
               for field in ("world", "agent", "role", "run_id"))


def _path_in_scope(target: str, scope: str) -> bool:
    try:
        target_path = Path(_canonical_path(target, "target"))
        scope_path = Path(_canonical_path(scope, "scope"))
        target_path.relative_to(scope_path)
        return True
    except (ValueError, TypeError):
        return False


def _target_matches(action_type: str, target: str, scope: str) -> bool:
    if action_type in _PATH_ACTIONS:
        if not isinstance(target, str) or not target.startswith("/"):
            return False
        return _path_in_scope(target, scope)
    return isinstance(target, str) and bool(target) and isinstance(scope, str) and bool(scope)


def _scope_allowed(context: RunContext, action_type: str, scope: str) -> bool:
    if action_type == "write":
        return scope in context.write_scopes
    if action_type == "result_write":
        return scope in context.result_scopes
    if action_type == "memory_write":
        return scope in context.memory_scopes
    if action_type in {"publish", "deploy", "push"}:
        return scope in context.write_scopes
    return scope in context.write_scopes or scope in context.result_scopes or scope in context.memory_scopes


class RightsConsumer:
    """Agent-facing view; intentionally exposes no Grant-Erteilung."""

    def __init__(self, controller: "RightsController", context: RunContext):
        self._controller = controller
        self.context = context

    def check(self, action_type: str, target: str, scope: str) -> CheckResult:
        return self._controller.check(self.context, action_type, target, scope)

    def reserve(self, action_type: str, target: str, scope: str, *, operation_id: str) -> Reservation:
        return self._controller.reserve(self.context, action_type, target, scope, operation_id=operation_id)

    def report(self, reservation: Reservation, outcome: str, *, detail: str = "") -> None:
        self._controller.report(self.context, reservation, outcome, detail=detail)


class RightsController:
    """Autoritat fuer Grants und atomare Verbrauchsentscheidungen.

    `human_authenticator` ist absichtlich kein boolescher Parameter. Fehlt er,
    bleiben Erteilung und Widerruf unmoeglich. Die aufrufende UI-/OS-Schicht
    muss ein Objekt mit `authorize(operation, grant)` einspeisen, das einen
    `ControllerReceipt` zur konkreten Grant-Nutzlast liefert.
    """

    def __init__(
        self,
        register_path: str | os.PathLike[str],
        *,
        protected_scopes: Sequence[str] = (),
        human_authenticator: Any = None,
        clock: Callable[[], float] = time.time,
        effect_resolver: Optional[Callable[[str, str, str], Sequence[str]]] = None,
    ):
        self.register_path = Path(register_path).absolute()
        self.lock_path = self.register_path.with_name(self.register_path.name + ".lock")
        # Register und Lock selbst bleiben Steuerpfade. Nur der exakte Pfad
        # wird geschuetzt; der gesamte Elternordner ist ein gueltiger
        # Projekt-/Ergebnis-Scope.
        self._protected_scopes = _canonical_scopes(
            tuple(protected_scopes) + (str(self.register_path), str(self.lock_path)),
            "protected_scopes",
        )
        self._human_authenticator = human_authenticator
        self._clock = clock
        # Vertrauenswuerdiger Adapter beschreibt nur tatsaechliche Wirkung
        # eines Pushes. Der Consumer kann diese Entscheidung nicht eingeben.
        self._effect_resolver = effect_resolver
        self.register_path.parent.mkdir(parents=True, exist_ok=True)

    def consumer(self, context: RunContext) -> RightsConsumer:
        return RightsConsumer(self, context)

    def issue(
        self,
        context: RunContext,
        action_type: str,
        target: str,
        scope: str,
        *,
        valid_from: float,
        valid_until: Optional[float],
        reusable: bool = False,
        bind_run: bool = True,
    ) -> Grant:
        target, scope = self._normalize_request(action_type, target, scope)
        grant = self._validate_grant(
            context, action_type, target, scope, valid_from, valid_until, reusable, bind_run
        )
        receipt = self._authorize("grant", grant)
        grant = replace(grant, human_actor=receipt.actor_id, human_evidence=receipt.evidence_id)
        with self._locked_state() as state:
            state["grants"][grant.grant_id] = self._grant_dict(grant)
            self._write_state(state)
        return grant

    def revoke(self, grant_id: str, *, context: Optional[RunContext] = None) -> None:
        if context is None:
            raise KeineControllerAutorisierung("Widerruf braucht RunContext")
        if not isinstance(grant_id, str) or not grant_id:
            raise ValueError("grant_id fehlt")
        with self._locked_state() as state:
            grant = state["grants"].get(grant_id)
            if grant is None:
                raise AktionVerweigert("Grant unbekannt")
            if not _context_equal(grant["context"], context):
                raise AktionVerweigert("Grant-Kontext passt nicht")
            if grant["status"] != "active":
                raise AktionVerweigert("Grant bereits verbraucht oder widerrufen")
            receipt = self._authorize("revoke", self._grant_from_dict(grant_id, grant))
            grant["status"] = "revoked"
            grant["revoked_at"] = self._clock()
            grant["revoked_actor"] = receipt.actor_id
            grant["revoked_evidence"] = receipt.evidence_id
            self._write_state(state)

    def check(
        self,
        context: RunContext,
        action_type: str,
        target: str,
        scope: str,
    ) -> CheckResult:
        try:
            target, scope = self._normalize_request(action_type, target, scope)
            self._validate_request(context, action_type, target, scope)
        except (RechteFehler, ValueError) as exc:
            try:
                required = self._required_actions(action_type, target, scope)
            except (RechteFehler, ValueError):
                required = ()
            return CheckResult(False, str(exc), required)
        with self._locked_state() as state:
            try:
                required = self._required_actions(action_type, target, scope)
            except RechteFehler as exc:
                return CheckResult(False, str(exc), ())
            now = self._now()
            missing = self._missing_grants(state, context, required, target, scope, now)
            if missing:
                return CheckResult(False, "kein gueltiger Grant: " + ", ".join(missing), required)
            return CheckResult(True, "ok", required)

    def reserve(
        self,
        context: RunContext,
        action_type: str,
        target: str,
        scope: str,
        *,
        operation_id: str,
    ) -> Reservation:
        target, scope = self._normalize_request(action_type, target, scope)
        self._validate_request(context, action_type, target, scope)
        _nonempty_name(operation_id, "operation_id")
        with self._locked_state() as state:
            if operation_id in state["operations"]:
                raise AktionVerweigert("operation_id bereits verwendet")
            required = self._required_actions(action_type, target, scope)
            now = self._now()
            grant_ids: list[str] = []
            for required_action in required:
                match = self._find_grant(state, context, required_action, target, scope, now)
                if match is None:
                    raise AktionVerweigert(f"kein gueltiger Grant fuer {required_action}")
                grant_ids.append(match)
            reservation_id = uuid.uuid4().hex
            for grant_id in grant_ids:
                grant = state["grants"][grant_id]
                if not grant.get("reusable", False):
                    grant["status"] = "consumed"
                    grant["consumed_by"] = reservation_id
                    grant["consumed_at"] = now
            state["reservations"][reservation_id] = {
                "context": context.as_dict(),
                "action_type": action_type,
                "target": target,
                "scope": scope,
                "grant_ids": grant_ids,
                "status": "reserved",
                "created_at": now,
                "operation_id": operation_id,
            }
            state["operations"][operation_id] = {"reservation_id": reservation_id, "status": "reserved"}
            self._write_state(state)
        return Reservation(reservation_id, tuple(grant_ids), action_type, target, scope, operation_id, context)

    def report(self, context: RunContext, reservation: Reservation, outcome: str, *, detail: str = "") -> None:
        if outcome not in _OUTCOMES:
            raise ValueError("outcome muss success, failure oder unknown sein")
        if not isinstance(reservation, Reservation):
            raise ValueError("ungueltige Reservation")
        if reservation.context != context:
            raise AktionVerweigert("Reservation-Kontext passt nicht")
        with self._locked_state() as state:
            entry = state["reservations"].get(reservation.reservation_id)
            if entry is None or entry["context"] != context.as_dict():
                raise AktionVerweigert("Reservation unbekannt")
            if entry["grant_ids"] != list(reservation.grant_ids):
                raise AktionVerweigert("Reservation-Bindung passt nicht")
            for field in ("action_type", "target", "scope", "operation_id"):
                if entry[field] != getattr(reservation, field):
                    raise AktionVerweigert("Reservation-Bindung passt nicht")
            if entry["status"] != "reserved":
                raise AktionVerweigert("Ergebnis bereits gemeldet")
            entry["status"] = outcome
            entry["detail"] = detail
            entry["reported_at"] = self._clock()
            state["operations"][entry["operation_id"]]["status"] = outcome
            self._write_state(state)
        if outcome == "unknown":
            raise UnbekanntesErgebnis("Aussenwirkung unbekannt; Reservation verbraucht, kein Retry")

    def _authorize(self, operation: str, grant: Grant) -> ControllerReceipt:
        authenticator = self._human_authenticator
        authorize = getattr(authenticator, "authorize", None) if authenticator is not None else None
        if not callable(authorize):
            raise KeineControllerAutorisierung("kein expliziter Controller-Authenticator")
        try:
            receipt = authorize(operation, grant)
        except Exception as exc:  # Auth-Fehler bleibt geschlossen
            raise KeineControllerAutorisierung("Controller-Authenticator fehlgeschlagen") from exc
        if not isinstance(receipt, ControllerReceipt):
            raise KeineControllerAutorisierung("Controller-Authenticator hat nicht autorisiert")
        return receipt

    def _validate_grant(
        self,
        context: RunContext,
        action_type: str,
        target: str,
        scope: str,
        valid_from: float,
        valid_until: Optional[float],
        reusable: bool,
        bind_run: bool,
    ) -> Grant:
        self._validate_request(context, action_type, target, scope)
        if not isinstance(valid_from, (int, float)):
            raise ValueError("Gueltigkeitsintervall muss Zahlen enthalten")
        if valid_until is not None and not isinstance(valid_until, (int, float)):
            raise ValueError("Gueltigkeitsintervall muss Zahlen enthalten")
        if not math.isfinite(float(valid_from)):
            raise ValueError("Gueltigkeitsintervall muss endlich sein")
        if valid_until is not None and not math.isfinite(float(valid_until)):
            raise ValueError("Gueltigkeitsintervall muss endlich sein")
        if valid_until is not None and valid_until <= valid_from:
            raise ValueError("Gueltigkeitsintervall ist leer")
        if not isinstance(reusable, bool):
            raise ValueError("reusable muss boolesch sein")
        if not isinstance(bind_run, bool):
            raise ValueError("bind_run muss boolesch sein")
        return Grant(
            uuid.uuid4().hex,
            action_type,
            target,
            scope,
            context.world,
            context.agent,
            context.role,
            context.run_id if bind_run else None,
            float(valid_from),
            None if valid_until is None else float(valid_until),
            reusable,
        )

    def _validate_request(self, context: RunContext, action_type: str, target: str, scope: str) -> None:
        if not isinstance(context, RunContext):
            raise AktionVerweigert("RunContext fehlt oder ist nicht unveraenderlich")
        if not isinstance(action_type, str) or not action_type:
            raise AktionVerweigert("Aktionstyp fehlt")
        if not isinstance(target, str) or not target:
            raise AktionVerweigert("Ziel fehlt")
        if not isinstance(scope, str) or not scope:
            raise AktionVerweigert("Umfang fehlt")
        if not _scope_allowed(context, action_type, scope):
            raise AktionVerweigert("Umfang nicht im RunContext")
        if action_type in _PATH_ACTIONS and not _target_matches(action_type, target, scope):
            raise AktionVerweigert("Ziel liegt nicht sicher im Umfang")
        if self._protected_target(context, target, scope):
            raise AktionVerweigert("geschuetzter Steuerpfad")

    @staticmethod
    def _normalize_request(action_type: str, target: str, scope: str) -> tuple[str, str]:
        """Gleiche Pfadform fuer Issue, Check und Reserve herstellen."""
        if isinstance(scope, str) and scope.startswith("/"):
            scope = _canonical_path(scope, "scope")
        if action_type in _PATH_ACTIONS and isinstance(target, str) and target.startswith("/"):
            target = _canonical_path(target, "target")
        return target, scope

    def _protected_target(self, context: RunContext, target: str, scope: str) -> bool:
        protected = self._protected_scopes + context.protected_scopes
        if target.startswith("/"):
            target_path = Path(_canonical_path(target, "target"))
            scope_path = Path(_canonical_path(scope, "scope")) if scope.startswith("/") else None
            for protected_scope in protected:
                if not protected_scope.startswith("/"):
                    continue
                protected_path = Path(protected_scope)
                try:
                    target_path.relative_to(protected_path)
                    return True
                except ValueError:
                    pass
                if scope_path is not None:
                    try:
                        scope_path.relative_to(protected_path)
                        return True
                    except ValueError:
                        pass
        return False

    def _required_actions(self, action_type: str, target: str, scope: str) -> tuple[str, ...]:
        required = [action_type]
        if action_type == "push" and self._effect_resolver is not None:
            effects = tuple(self._effect_resolver(action_type, target, scope))
            unknown = [effect for effect in effects if effect not in {"publish", "deploy"}]
            if unknown:
                raise RechteFehler("Wirkungsermittler meldet unbekannte Push-Wirkung")
            for effect in ("publish", "deploy"):
                if effect in effects:
                    required.append(effect)
        return tuple(dict.fromkeys(required))

    def _missing_grants(
        self,
        state: Mapping[str, Any],
        context: RunContext,
        required: Sequence[str],
        target: str,
        scope: str,
        now: float,
    ) -> list[str]:
        missing = []
        for action in required:
            if self._find_grant(state, context, action, target, scope, now) is None:
                missing.append(action)
        return missing

    def _find_grant(
        self,
        state: Mapping[str, Any],
        context: RunContext,
        action_type: str,
        target: str,
        scope: str,
        now: float,
    ) -> Optional[str]:
        for grant_id, grant in state["grants"].items():
            if grant["status"] != "active":
                continue
            if grant["action_type"] != action_type or grant["target"] != target or grant["scope"] != scope:
                continue
            if grant["context"]["world"] != context.world or grant["context"]["agent"] != context.agent:
                continue
            if grant["context"]["role"] != context.role:
                continue
            if grant["context"]["run_id"] not in (None, context.run_id):
                continue
            if grant["valid_until"] is not None and not (now < grant["valid_until"]):
                continue
            if now < grant["valid_from"]:
                continue
            return grant_id
        return None

    def _now(self) -> float:
        return self._clock()

    @staticmethod
    def _grant_from_dict(grant_id: str, grant: Mapping[str, Any]) -> Grant:
        context = grant["context"]
        return Grant(
            grant_id,
            grant["action_type"],
            grant["target"],
            grant["scope"],
            context["world"],
            context["agent"],
            context["role"],
            context["run_id"],
            float(grant["valid_from"]),
            None if grant["valid_until"] is None else float(grant["valid_until"]),
            bool(grant.get("reusable", False)),
            grant.get("human_actor", ""),
            grant.get("human_evidence", ""),
        )

    @staticmethod
    def _grant_dict(grant: Grant) -> dict[str, Any]:
        return {
            "action_type": grant.action_type,
            "target": grant.target,
            "scope": grant.scope,
            "context": {
                "world": grant.world,
                "agent": grant.agent,
                "role": grant.role,
                "run_id": grant.run_id,
            },
            "valid_from": grant.valid_from,
            "valid_until": grant.valid_until,
            "reusable": grant.reusable,
            "human_actor": grant.human_actor,
            "human_evidence": grant.human_evidence,
            "status": "active",
        }

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
            return {"version": _VERSION, "grants": {}, "reservations": {}, "operations": {}}
        try:
            state = json.loads(self.register_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RechteFehler(f"Rechteregister unlesbar: {exc}") from exc
        if not isinstance(state, dict) or state.get("version") != _VERSION:
            raise RechteFehler("Rechteregister hat unbekannte Version")
        if not isinstance(state.get("grants"), dict) or not isinstance(state.get("reservations"), dict):
            raise RechteFehler("Rechteregister ist ungueltig")
        if not isinstance(state.get("operations", {}), dict):
            raise RechteFehler("Rechteregister hat ungueltige Operationen")
        state.setdefault("operations", {})
        return copy.deepcopy(state)

    def _write_state(self, state: Mapping[str, Any]) -> None:
        atomar_schreiben.schreiben(
            self.register_path,
            json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            modus=0o600,
            dauerhaft=True,
        )
