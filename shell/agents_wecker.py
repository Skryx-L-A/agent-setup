"""Controllerseitiger Vertrag fuer persistente Wecker und Wiederanlaeufe.

Dieses Modul plant oder startet nichts. Es registriert Zustellungen, reserviert
eine faellige Zustellung atomar genau einmal und erwartet danach eine explizite
Rueckmeldung des Controllers mit Laufidentitaet und Fortschrittsmarker.
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


class WeckerFehler(Exception):
    """Basisklasse fuer Vertragsfehler."""


class WeckerKonflikt(WeckerFehler):
    """Eine Zustellungskennung wurde mit anderem Inhalt erneut vorgelegt."""


class WeckerUngeklaert(WeckerFehler):
    """Eine vorher reservierte Zustellung hat noch keine Controllerquittung."""


class WeckerVerweigert(WeckerFehler):
    """Eine Zustellung oder Aufloesung ist im aktuellen Zustand nicht erlaubt."""


_NAME = re.compile(r"^[^\x00/\\]+$")
_CAUSES = frozenset({"fresh_message", "ticket", "self_timer", "recovery"})
_STATES = frozenset({"pending", "claimed", "completed", "blocked"})
_DESIRED = frozenset({"running", "paused", "stopped"})
_VERSION = 1
_SELF_TIMER_MIN_S = 900.0
_RECOVERY_GAP_S = 300.0
_RECOVERY_MAX_WITHOUT_PROGRESS = 2
_CHAIN_LIMIT = 20


def _name(value: str, field: str) -> str:
    if not isinstance(value, str) or not value or not _NAME.fullmatch(value):
        raise ValueError(f"{field} muss ein einzelner nichtleerer Bezeichner sein")
    return value


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} muss eine endliche Zahl sein")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} muss eine endliche Zahl sein")
    return number


def _optional_marker(value: Optional[str], field: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError(f"{field} muss leer oder eine nichtleere Zeichenkette sein")
    return value


def _binding_key(world: str, agent: str) -> str:
    return json.dumps([world, agent], ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class Delivery:
    """Unveraenderliche Beschreibung einer adressierten Zustellung."""

    delivery_id: str
    world: str
    agent: str
    cause: str
    due_at: float
    content: str
    caused_by: Optional[str] = None
    chain: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _name(self.delivery_id, "delivery_id")
        _name(self.world, "world")
        _name(self.agent, "agent")
        if self.cause not in _CAUSES:
            raise ValueError("unbekannte Weckerursache")
        _finite_number(self.due_at, "due_at")
        if not isinstance(self.content, str) or "\x00" in self.content:
            raise ValueError("content muss eine Zeichenkette ohne NUL sein")
        if self.caused_by is not None:
            _name(self.caused_by, "caused_by")
        if not isinstance(self.chain, tuple):
            raise ValueError("chain muss ein Tupel sein")
        for item in self.chain:
            _name(item, "chain item")

    def as_dict(self) -> dict[str, Any]:
        return {
            "delivery_id": self.delivery_id,
            "world": self.world,
            "agent": self.agent,
            "cause": self.cause,
            "due_at": self.due_at,
            "content": self.content,
            "caused_by": self.caused_by,
            "chain": list(self.chain),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Delivery":
        return cls(
            value["delivery_id"], value["world"], value["agent"], value["cause"],
            value["due_at"], value["content"], value.get("caused_by"),
            tuple(value.get("chain", ())),
        )


@dataclass(frozen=True)
class DeliveryClaim:
    """Ergebnis einer Claim-Pruefung; nur `claimed` erlaubt Aussenwirkung."""

    delivery_id: str
    status: str
    claim_id: Optional[str] = None
    reason: Optional[str] = None
    content: Optional[str] = None

    def __post_init__(self) -> None:
        _name(self.delivery_id, "delivery_id")
        if self.status not in {"pending", "claimed", "unknown", "completed", "blocked"}:
            raise ValueError("unbekannter Claimstatus")


@dataclass(frozen=True)
class DeliveryStatus:
    """Persistenter Status einer Zustellung."""

    delivery_id: str
    status: str
    reason: Optional[str] = None
    claim_id: Optional[str] = None
    outcome: Optional[str] = None


class WeckerController:
    """Persistenter, einzelner Claimvertrag ohne Scheduler oder Prozessstart."""

    def __init__(
        self,
        register_path: str | os.PathLike[str],
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.register_path = Path(register_path).absolute()
        self.lock_path = self.register_path.with_name(self.register_path.name + ".lock")
        self._clock = clock
        self.register_path.parent.mkdir(parents=True, exist_ok=True)

    def claim(
        self,
        delivery: Delivery,
        *,
        desired_world_state: str,
        desired_agent_state: str,
        active_run: Optional[str],
        progress_marker: Optional[str],
    ) -> DeliveryClaim:
        """Registriert und reserviert eine Zustellung unter einer einzigen Sperre."""
        if not isinstance(delivery, Delivery):
            raise ValueError("Delivery fehlt oder ist nicht unveraenderlich")
        self._validate_context(desired_world_state, desired_agent_state, active_run, progress_marker)
        key = _binding_key(delivery.world, delivery.agent)
        with self._locked_state() as state:
            now = self._now()
            records = state["deliveries"]
            existing = records.get(delivery.delivery_id)
            if existing is not None:
                stored = Delivery.from_dict(existing["delivery"])
                if stored.as_dict() != delivery.as_dict():
                    raise WeckerKonflikt("delivery_id mit anderem Inhalt oder anderer Bindung")
                if existing.get("state") != "pending":
                    result = self._existing_claim(existing)
                    self._write_state(state)
                    return result
                record = existing
            else:
                record = {
                    "delivery": delivery.as_dict(),
                    "state": "pending",
                    "last_block_reason": None,
                    "claim": None,
                    "receipt": None,
                    "outcome": None,
                }
                records[delivery.delivery_id] = record
                blocked = self._chain_block_reason(delivery)
                if blocked is not None:
                    record["state"] = "blocked"
                    record["last_block_reason"] = blocked
                    self._write_state(state)
                    return DeliveryClaim(delivery.delivery_id, "blocked", reason=blocked, content=delivery.content)

            # Gewuenschte Steuerung und ein aktiver Lauf haben Vorrang vor einem
            # laufenden Claim, damit Pause und Sofortstopp als Grund sichtbar bleiben.
            control = self._control_reason(desired_world_state, desired_agent_state, active_run)
            if control is not None:
                record["last_block_reason"] = control
                self._write_state(state)
                return DeliveryClaim(delivery.delivery_id, "pending", reason=control, content=delivery.content)

            if self._other_claim_in_flight(records, delivery):
                record["last_block_reason"] = "claim_in_flight"
                self._write_state(state)
                return DeliveryClaim(delivery.delivery_id, "pending", reason="claim_in_flight",
                                     content=delivery.content)

            progress = state["progress"].setdefault(key, {
                "marker": None,
                "recovery_attempts": 0,
                "last_self_timer_claim_at": None,
                "last_recovery_claim_at": None,
            })
            if delivery.cause == "recovery" and self._marker_changed(progress_marker, progress["marker"]):
                progress["marker"] = progress_marker
                progress["recovery_attempts"] = 0
            reason = self._blocking_reason(
                delivery, desired_world_state, desired_agent_state, active_run, progress, now
            )
            if reason is not None:
                record["last_block_reason"] = reason
                self._write_state(state)
                return DeliveryClaim(delivery.delivery_id, "pending", reason=reason, content=delivery.content)

            if delivery.cause == "recovery":
                progress["recovery_attempts"] += 1
                progress["last_recovery_claim_at"] = now
            elif delivery.cause == "self_timer":
                progress["last_self_timer_claim_at"] = now

            sequence = int(state["next_claim_sequence"])
            state["next_claim_sequence"] = sequence + 1
            claim_id = f"{delivery.delivery_id}#{sequence}"
            record["state"] = "claimed"
            record["claim"] = {
                "claim_id": claim_id,
                "claimed_at": now,
                "progress_marker_before": progress_marker,
            }
            self._write_state(state)
            return DeliveryClaim(delivery.delivery_id, "claimed", claim_id=claim_id, content=delivery.content)

    def resolve(
        self,
        delivery_id: str,
        claim_id: str,
        *,
        run_id: str,
        progress_marker: Optional[str],
        outcome: str,
    ) -> DeliveryStatus:
        """Quittiert genau einen Claim mit vertrauenswuerdiger Laufidentitaet."""
        _name(delivery_id, "delivery_id")
        _name(claim_id, "claim_id")
        _name(run_id, "run_id")
        _optional_marker(progress_marker, "progress_marker")
        if not isinstance(outcome, str) or not outcome or "\x00" in outcome:
            raise ValueError("outcome fehlt")
        with self._locked_state() as state:
            record = state["deliveries"].get(delivery_id)
            if record is None:
                raise WeckerVerweigert("unbekannte delivery_id")
            claim = record.get("claim")
            if record.get("state") == "completed":
                receipt = record.get("receipt") or {}
                if (receipt.get("claim_id"), receipt.get("run_id"), receipt.get("outcome"),
                        receipt.get("progress_marker")) == (
                    claim_id, run_id, outcome, progress_marker
                ):
                    return self._status(record)
                raise WeckerKonflikt("Zustellung bereits mit anderem Ergebnis quittiert")
            if record.get("state") != "claimed" or not isinstance(claim, dict):
                if record.get("state") == "blocked":
                    raise WeckerVerweigert("blockierte Zustellung hat keinen Claim")
                raise WeckerUngeklaert("Zustellung ist nicht in einem quittierbaren Claim")
            if claim.get("claim_id") != claim_id:
                raise WeckerKonflikt("Claim-ID gehoert nicht zu dieser Zustellung")
            delivery = Delivery.from_dict(record["delivery"])
            key = _binding_key(delivery.world, delivery.agent)
            progress = state["progress"].setdefault(key, {
                "marker": None,
                "recovery_attempts": 0,
                "last_self_timer_claim_at": None,
                "last_recovery_claim_at": None,
            })
            before = (claim.get("progress_marker_before") if delivery.cause == "recovery"
                      else progress.get("marker"))
            changed = self._marker_changed(progress_marker, before)
            if changed:
                progress["marker"] = progress_marker
                progress["recovery_attempts"] = 0
            record["state"] = "completed"
            record["receipt"] = {
                "claim_id": claim_id,
                "run_id": run_id,
                "outcome": outcome,
                "progress_marker": progress_marker,
                "resolved_at": self._now(),
            }
            record["outcome"] = outcome
            self._write_state(state)
            return self._status(record)

    def offene(self, world: Optional[str] = None, agent: Optional[str] = None) -> list[tuple[Delivery, DeliveryStatus]]:
        """Liest registrierte, noch nicht quittierte Zustellungen; beansprucht nichts."""
        if world is not None:
            _name(world, "world")
        if agent is not None:
            _name(agent, "agent")
        with self._locked_state() as state:
            result = []
            for record in state["deliveries"].values():
                delivery = Delivery.from_dict(record["delivery"])
                if record.get("state") not in {"pending", "claimed"}:
                    continue
                if (world is not None and delivery.world != world) or (agent is not None and delivery.agent != agent):
                    continue
                result.append((delivery, self._status(record)))
            return sorted(result, key=lambda item: (item[0].due_at, item[0].delivery_id))

    def status(self, delivery_id: str) -> DeliveryStatus:
        """Liest den persistenten Zustand; einen offenen Claim zeigt `unknown`."""
        _name(delivery_id, "delivery_id")
        with self._locked_state() as state:
            record = state["deliveries"].get(delivery_id)
            if record is None:
                raise WeckerVerweigert("unbekannte delivery_id")
            return self._status(record)

    def _existing_claim(self, record: Mapping[str, Any]) -> DeliveryClaim:
        delivery = Delivery.from_dict(record["delivery"])
        state = record.get("state")
        claim = record.get("claim") or {}
        claim_id = claim.get("claim_id")
        if state == "claimed":
            return DeliveryClaim(delivery.delivery_id, "unknown", claim_id=claim_id, reason="claim_in_flight",
                                 content=delivery.content)
        if state == "completed":
            receipt = record.get("receipt") or {}
            return DeliveryClaim(delivery.delivery_id, "completed", claim_id=receipt.get("claim_id"),
                                 reason="already_completed", content=delivery.content)
        if state == "blocked":
            return DeliveryClaim(delivery.delivery_id, "blocked", reason=record.get("last_block_reason"),
                                 content=delivery.content)
        return DeliveryClaim(delivery.delivery_id, "pending", reason=record.get("last_block_reason"),
                             content=delivery.content)

    @staticmethod
    def _marker_changed(current: Optional[str], previous: Optional[str]) -> bool:
        return current is not None and current != previous

    @staticmethod
    def _other_claim_in_flight(records: Mapping[str, Any], delivery: Delivery) -> bool:
        for delivery_id, record in records.items():
            if delivery_id == delivery.delivery_id or record.get("state") != "claimed":
                continue
            other = Delivery.from_dict(record["delivery"])
            if other.world == delivery.world and other.agent == delivery.agent:
                return True
        return False

    @staticmethod
    def _status(record: Mapping[str, Any]) -> DeliveryStatus:
        delivery_id = record["delivery"]["delivery_id"]
        state = record.get("state")
        if state == "claimed":
            claim = record.get("claim") or {}
            return DeliveryStatus(delivery_id, "unknown", "claim_in_flight", claim.get("claim_id"))
        if state not in _STATES:
            raise WeckerFehler("Register enthaelt unbekannten Zustellstatus")
        receipt = record.get("receipt") or {}
        return DeliveryStatus(delivery_id, state, record.get("last_block_reason"),
                              receipt.get("claim_id"), record.get("outcome"))

    @staticmethod
    def _chain_block_reason(delivery: Delivery) -> Optional[str]:
        chain = delivery.chain
        if len(chain) + 1 > _CHAIN_LIMIT:
            return "chain_limit"
        if len(set(chain)) != len(chain) or delivery.delivery_id in chain:
            return "cycle"
        if delivery.caused_by is not None and (not chain or chain[-1] != delivery.caused_by):
            return "chain_binding"
        return None

    @staticmethod
    def _control_reason(
        desired_world_state: str,
        desired_agent_state: str,
        active_run: Optional[str],
    ) -> Optional[str]:
        if desired_world_state == "stopped" or desired_agent_state == "stopped":
            return "stopped"
        if desired_world_state == "paused" or desired_agent_state == "paused":
            return "paused"
        if active_run is not None:
            return "active_run"
        return None

    @staticmethod
    def _blocking_reason(
        delivery: Delivery,
        desired_world_state: str,
        desired_agent_state: str,
        active_run: Optional[str],
        progress: Mapping[str, Any],
        now: float,
    ) -> Optional[str]:
        control = WeckerController._control_reason(desired_world_state, desired_agent_state, active_run)
        if control is not None:
            return control
        if delivery.cause == "self_timer":
            previous = progress.get("last_self_timer_claim_at")
            if previous is not None and now - float(previous) < _SELF_TIMER_MIN_S:
                return "self_timer_spacing"
        if delivery.cause == "recovery":
            previous = progress.get("last_recovery_claim_at")
            if previous is not None and now - float(previous) < _RECOVERY_GAP_S:
                return "recovery_spacing"
            if int(progress.get("recovery_attempts", 0)) >= _RECOVERY_MAX_WITHOUT_PROGRESS:
                return "recovery_limit"
        if delivery.cause not in {"fresh_message", "ticket"} and delivery.due_at > now:
            return "not_due"
        return None

    @staticmethod
    def _validate_context(
        desired_world_state: str,
        desired_agent_state: str,
        active_run: Optional[str],
        progress_marker: Optional[str],
    ) -> None:
        if desired_world_state not in _DESIRED or desired_agent_state not in _DESIRED:
            raise ValueError("unbekannter gewuenschter Welt- oder Agentenzustand")
        if active_run is not None:
            _name(active_run, "active_run")
        _optional_marker(progress_marker, "progress_marker")

    def _now(self) -> float:
        return _finite_number(self._clock(), "Controller-Uhr")

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
            return {
                "version": _VERSION,
                "next_claim_sequence": 1,
                "deliveries": {},
                "progress": {},
            }
        try:
            state = json.loads(self.register_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise WeckerFehler(f"Weckerregister unlesbar: {exc}") from exc
        if not isinstance(state, dict) or state.get("version") != _VERSION:
            raise WeckerFehler("Weckerregister hat unbekannte Version")
        if not isinstance(state.get("deliveries"), dict) or not isinstance(state.get("progress"), dict):
            raise WeckerFehler("Weckerregister ist ungueltig")
        if not isinstance(state.get("next_claim_sequence"), int) or state["next_claim_sequence"] <= 0:
            raise WeckerFehler("Weckerregister hat ungueltige Claim-Sequenz")
        return copy.deepcopy(state)

    def _write_state(self, state: Mapping[str, Any]) -> None:
        atomar_schreiben.schreiben(
            self.register_path,
            json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            modus=0o600,
            dauerhaft=True,
        )
