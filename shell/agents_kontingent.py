#!/usr/bin/env python3
"""Naechste erlaubte Startzeit eines Abo-Agenten aus getrennten Kontingentquellen.

Plan Abschnitt 13: Tagesbudget, Fuenf-Stunden-Fenster und Wochenfenster werden getrennt
beruecksichtigt. Auf einem Traegerhost gilt der Limitstand ``~/.claude/workbench/limits-latest.json``
nur, wenn er juenger als eine Stunde ist (Entscheidung des Nutzers vom 14.09.2026); sonst zaehlt
allein die Abweisung des Backends. Weitere optionale Quellen sind ``wb-budget --json``,
``wb-kontingent zeigen --json`` (gemessene Erschoepfung und Beobachtungen) und die Abweisung
des Backends selbst (``rate_limit_event`` im Stream, Ratenlimit-Header am Proxy). Alle
bindenden Sperren muessen vorbei sein; die naechste Startzeit ist deshalb ihr spaetestes Ende.
Eine unlesbare Quelle sperrt nie allein. Ein Modellwechsel auf eine schwaechere Stufe ist
kein Teil dieses Vertrags.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

RECHECK_S = 900.0
_ISO = "%Y-%m-%dT%H:%M:%SZ"


@dataclass(frozen=True)
class Sperre:
    grund: str      # fuenf_stunden | wochenfenster | tagesbudget | kontingent | backend | anmeldung
    bis: Optional[float]
    quelle: str

    def as_dict(self) -> dict[str, Any]:
        return {"grund": self.grund, "bis": self.bis, "quelle": self.quelle}


@dataclass(frozen=True)
class Startfreigabe:
    erlaubt: bool
    naechster_start: Optional[float]
    sperren: tuple[Sperre, ...] = ()
    unbekannt: tuple[str, ...] = field(default=())
    quelle: Optional[dict[str, Any]] = None

    def as_dict(self) -> dict[str, Any]:
        return {"erlaubt": self.erlaubt, "naechster_start": self.naechster_start,
                "sperren": [item.as_dict() for item in self.sperren], "unbekannt": list(self.unbekannt),
                "quelle": self.quelle}


def _zahl(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _iso(value: Any) -> Optional[float]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    for parser in (lambda: _dt.datetime.strptime(text, _ISO).replace(tzinfo=_dt.timezone.utc),
                   lambda: _dt.datetime.fromisoformat(text.replace("Z", "+00:00"))):
        try:
            parsed = parser()
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=_dt.timezone.utc)
            return parsed.timestamp()
        except ValueError:
            continue
    return None


def aus_budget(data: Mapping[str, Any], jetzt: float, tz: Optional[_dt.tzinfo] = None,
               herkunft: str = "wb-budget") -> list[Sperre]:
    """Sperren aus einem Limitstand (``wb-budget --json`` oder ``limits-latest.json``), jede Grenze fuer sich."""
    tz = tz or _dt.datetime.now().astimezone().tzinfo
    sperren: list[Sperre] = []
    five = _zahl(data.get("five_hour_pct"))
    five_reset = _zahl(data.get("five_hour_resets_at_epoch"))
    if five is not None and five >= 100 and five_reset and five_reset > jetzt:
        sperren.append(Sperre("fuenf_stunden", five_reset, "%s five_hour_pct" % herkunft))
    week = _zahl(data.get("seven_day_pct"))
    week_reset = _zahl(data.get("seven_day_resets_at_epoch"))
    if week is None or not week_reset:
        return sperren
    if week >= 100 and week_reset > jetzt:
        sperren.append(Sperre("wochenfenster", week_reset, "%s seven_day_pct" % herkunft))
        return sperren
    # Tageslinie wie wb-budget: Kalendertag des Fensterbeginns zaehlt als Tag 1, bis
    # heute 24:00 sind Tag x 100/7 erlaubt. Gesperrt ist, wer UEBER der Linie liegt.
    start = week_reset - 7 * 86400
    start_day = _dt.datetime.fromtimestamp(start, tz).date()
    today = _dt.datetime.fromtimestamp(jetzt, tz).date()
    index = max(1, min(7, (today - start_day).days + 1))
    if week <= index * 100.0 / 7.0:
        return sperren
    for day in range(index + 1, 8):
        if week <= day * 100.0 / 7.0:
            midnight = _dt.datetime.combine(start_day + _dt.timedelta(days=day - 1), _dt.time(0, 0), tz)
            sperren.append(Sperre("tagesbudget", min(midnight.timestamp(), week_reset), "%s Tageslinie" % herkunft))
            return sperren
    sperren.append(Sperre("tagesbudget", week_reset, "%s Tageslinie bis Fensterende" % herkunft))
    return sperren


def limitsdatei_lesen(path: Path, jetzt: float, max_alter_s: float) -> tuple[Optional[dict[str, Any]], dict[str, Any]]:
    """Liest ``limits-latest.json``; liefert den Stand nur, wenn sein ``ts`` juenger als ``max_alter_s`` ist."""
    info: dict[str, Any] = {"art": "backend", "limits": str(path)}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, dict(info, grund="limits_fehlen")
    except (OSError, ValueError):
        return None, dict(info, grund="limits_unlesbar")
    ts = _iso(data.get("ts")) if isinstance(data, dict) else None
    if ts is None:
        return None, dict(info, grund="limits_ohne_zeit")
    alter = jetzt - ts
    if alter > max_alter_s or alter < -300:
        return None, dict(info, grund="limits_zu_alt", alter_s=round(alter))
    stand = {
        "five_hour_pct": _zahl(data.get("five_hour_pct")),
        "five_hour_resets_at_epoch": _zahl(data.get("five_hour_resets_at")) or _iso(data.get("five_hour_resets_at")),
        "seven_day_pct": _zahl(data.get("seven_day_pct")),
        "seven_day_resets_at_epoch": _zahl(data.get("seven_day_resets_at")) or _iso(data.get("seven_day_resets_at")),
    }
    return stand, {"art": "limits-latest", "limits": str(path), "alter_s": round(alter)}


def aus_kontingent(data: Mapping[str, Any], jetzt: float, harness: str = "claude") -> list[Sperre]:
    """Sperren aus ``wb-kontingent zeigen --json``: gemessene Erschoepfung und Beobachtung."""
    sperren: list[Sperre] = []
    entry = (data.get("harnesses") or {}).get(harness) or {}
    if entry.get("erschoepft") is True:
        kontingent = entry.get("kontingent") or {}
        bis = _iso(kontingent.get("faellt_zurueck_am")) or _iso((entry.get("fenster_kurz") or {}).get("faellt_zurueck_am"))
        if bis is None or bis > jetzt:
            sperren.append(Sperre("kontingent", bis, "wb-kontingent erschoepft"))
    observation = (data.get("beobachtungen") or {}).get(harness) or {}
    if observation.get("zustand") == "erschoepft":
        bis = _iso(observation.get("faellt_zurueck_am"))
        if bis is None or bis > jetzt:
            sperren.append(Sperre("kontingent", bis, "wb-kontingent Beobachtung"))
    return sperren


def aus_backend(rate_limit: Optional[Mapping[str, Any]], proxy_limit: Optional[Mapping[str, Any]],
                jetzt: float) -> list[Sperre]:
    """Sperre aus der tatsaechlichen Abweisung: Stream-Ereignis oder Proxy-Header."""
    candidates: list[float] = []
    if rate_limit and rate_limit.get("status") == "rejected":
        value = _zahl(rate_limit.get("resetsAt"))
        if value:
            candidates.append(value)
    headers = (proxy_limit or {}).get("headers") or {}
    for name in ("anthropic-ratelimit-unified-reset", "anthropic-ratelimit-unified-5h-reset",
                 "anthropic-ratelimit-unified-7d-reset"):
        value = _zahl(headers.get(name))
        if value and value > jetzt:
            candidates.append(value)
    retry = _zahl(headers.get("retry-after"))
    at = _zahl((proxy_limit or {}).get("at")) or jetzt
    if retry is not None and retry > 0:
        candidates.append(at + retry)
    kind = (rate_limit or {}).get("rateLimitType") or headers.get("anthropic-ratelimit-unified-representative-claim") or "backend"
    future = [value for value in candidates if value > jetzt]
    return [Sperre("backend", max(future) if future else None, "429 %s" % kind)]


def naechster_start(sperren: Iterable[Sperre], jetzt: float, recheck_s: float = RECHECK_S) -> Optional[float]:
    """Spaetestes Ende aller Sperren; eine Sperre ohne bekanntes Ende wird nach ``recheck_s`` neu geprueft."""
    items = list(sperren)
    if not items:
        return None
    known = [item.bis for item in items if item.bis is not None and item.bis > jetzt]
    unknown = any(item.bis is None for item in items)
    candidates = known + ([jetzt + recheck_s] if unknown else [])
    return max(candidates) if candidates else None


def _run_json(command: Sequence[str], env: Mapping[str, str], timeout: float,
              runner: Callable[..., Any]) -> Optional[dict[str, Any]]:
    try:
        result = runner(list(command), text=True, capture_output=True, timeout=timeout, env=dict(env))
    except (OSError, subprocess.TimeoutExpired):
        return None
    try:
        data = json.loads(result.stdout)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) and "fehler" not in data else None


class KontingentQuelle:
    """Liest die konfigurierten Werkzeuge und bildet eine Startfreigabe."""

    def __init__(self, budget_cmd: Optional[Sequence[str]] = ("wb-budget", "--json"),
                 kontingent_cmd: Optional[Sequence[str]] = ("wb-kontingent", "zeigen", "--json"),
                 *, harness: str = "claude", timeout: float = 20.0, clock: Callable[[], float] = time.time,
                 runner: Callable[..., Any] = subprocess.run, tz: Optional[_dt.tzinfo] = None,
                 limits_path: Optional[str | os.PathLike[str]] = None, max_alter_s: float = 3600.0):
        self.limits_path = Path(limits_path) if limits_path else None
        self.max_alter_s = float(max_alter_s)
        self.budget_cmd = list(budget_cmd) if budget_cmd else None
        self.kontingent_cmd = list(kontingent_cmd) if kontingent_cmd else None
        self.harness = harness
        self.timeout = timeout
        self._clock = clock
        self._runner = runner
        self._tz = tz
        home = Path.home()
        self._env = {"PATH": "%s:/usr/local/bin:/usr/bin:/bin" % (home / ".local" / "bin"), "HOME": str(home),
                     "LANG": "C.UTF-8"}

    def freigabe(self, *, rate_limit: Optional[Mapping[str, Any]] = None,
                 proxy_limit: Optional[Mapping[str, Any]] = None, anmeldung_fehlt: bool = False,
                 backend_abgewiesen: bool = False) -> Startfreigabe:
        jetzt = float(self._clock())
        sperren: list[Sperre] = []
        unbekannt: list[str] = []
        quelle = self.quelle(jetzt)
        if self.limits_path is not None:
            stand, _ = limitsdatei_lesen(self.limits_path, jetzt, self.max_alter_s)
            if stand is None:
                unbekannt.append("limits-latest")
            else:
                sperren += aus_budget(stand, jetzt, self._tz, "limits-latest")
        if self.budget_cmd:
            data = _run_json(self.budget_cmd, self._env, self.timeout, self._runner)
            if data is None:
                unbekannt.append("wb-budget")
            else:
                sperren += aus_budget(data, jetzt, self._tz)
        if self.kontingent_cmd:
            data = _run_json(self.kontingent_cmd, self._env, self.timeout, self._runner)
            if data is None:
                unbekannt.append("wb-kontingent")
            else:
                sperren += aus_kontingent(data, jetzt, self.harness)
        if backend_abgewiesen:
            sperren += aus_backend(rate_limit, proxy_limit, jetzt)
        if anmeldung_fehlt:
            sperren.append(Sperre("anmeldung", None, "Controlleranmeldung"))
        start = naechster_start(sperren, jetzt)
        return Startfreigabe(not sperren, start, tuple(sperren), tuple(unbekannt), quelle)

    def quelle(self, jetzt: Optional[float] = None) -> dict[str, Any]:
        """Welche Kontingentquelle gerade gilt; fuer den Status des Traegers."""
        jetzt = float(self._clock()) if jetzt is None else jetzt
        tools = [name for name, command in (("wb-budget", self.budget_cmd), ("wb-kontingent", self.kontingent_cmd))
                 if command]
        if self.limits_path is None:
            return {"art": "werkzeuge" if tools else "backend", "werkzeuge": tools}
        _, info = limitsdatei_lesen(self.limits_path, jetzt, self.max_alter_s)
        return dict(info, werkzeuge=tools)


__all__ = ["KontingentQuelle", "RECHECK_S", "Sperre", "Startfreigabe", "aus_backend", "aus_budget",
           "aus_kontingent", "limitsdatei_lesen", "naechster_start"]
