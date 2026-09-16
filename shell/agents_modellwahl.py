#!/usr/bin/env python3
"""Modelle, die der Traeger einer Welt fahren kann, und die Abo-Zuordnung fuer die Fallbackwahl.

der Nutzer, 16.09.2026: „Fallback-Modell machen.“ und die Modellliste je Welt aus der
Traegerkonfiguration statt einer festen Liste in der Oberflaeche. Das Modul liest nur JSON
(``traeger.json`` der Welt und die Modellregistry) und importiert den Traeger nicht; so kann es
die Weltansicht auf jeder Maschine liefern, auch ueber den ssh-Weg einer Fernwelt.

Eintrag der Liste: ``{"id", "harness", "verfuegbar", "grund"?}``. ``id`` ist der Profilname, den ein
Agent als ``model`` traegt (``sonnet5:high``, ``haiku``, ein Pi- oder Codex-Name). Fable steht nie
in der Liste (Regel: Fable nie, auch nicht als Fallback).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

REGISTRY_VORGABE = Path.home() / ".claude" / "workbench" / "models.json"


def ist_fable(name: Any) -> bool:
    return "fable" in str(name or "").lower()


def abo(harness: str) -> Optional[str]:
    """Das Abo hinter einem Harness; ``None`` fuer lokale Modelle, die kein Abo-Kontingent haben."""
    return {"claude": "claude", "codex": "codex"}.get(harness)


def registry_lesen(konfig: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Die Registry der Traegerkonfiguration, sonst die Vorgabe des Hosts; unlesbar heisst: keine."""
    raw = konfig.get("registry") or (str(REGISTRY_VORGABE) if REGISTRY_VORGABE.is_file() else None)
    if not raw:
        return None
    try:
        data = json.loads(Path(os.path.expanduser(str(raw))).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("models"), list) else None


def _registry_claude(registry: dict[str, Any], kennung: str) -> Optional[dict[str, Any]]:
    """Registry-Eintrag eines Claude-Modells zur Kennung des Traegers (``claude-haiku-4-5-20251001``)."""
    for item in registry["models"]:
        if not isinstance(item, dict) or item.get("harness") != "claude":
            continue
        for ref in (item.get("modelRef"), item.get("id")):
            if isinstance(ref, str) and ref and (kennung == ref or kennung.startswith(ref + "-")):
                return item
    return None


def _maschine_passt(item: dict[str, Any], host: str, registry: dict[str, Any]) -> bool:
    """Eine Registry-Zeile mit ``machines`` gilt nur dort; ein Host, den keine Zeile nennt, wird nicht beurteilt."""
    bekannt = {name for entry in registry["models"] if isinstance(entry, dict)
               for name in (entry.get("machines") or []) if isinstance(name, str)}
    machines = item.get("machines")
    return host not in bekannt or not isinstance(machines, list) or host in machines


def modelle(konfig: dict[str, Any], registry: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
    """Die Modelle eines Traegers: Harnesses mit eingerichtetem Backend, geschnitten mit der Registry."""
    host = str(konfig.get("execution_host") or "")
    raus: list[dict[str, Any]] = []

    def eintrag(kennung: str, harness: str, grund: Optional[str]) -> None:
        if ist_fable(kennung):
            return
        item: dict[str, Any] = {"id": kennung, "harness": harness, "verfuegbar": grund is None}
        if grund is not None:
            item["grund"] = grund
        raus.append(item)

    for name, ziel in sorted((konfig.get("modelle") or {}).items()):
        if ist_fable(ziel):
            continue
        grund = None
        if registry is not None:
            zeile = _registry_claude(registry, str(ziel))
            if zeile is None:
                grund = "nicht_in_registry"
            elif zeile.get("enabled") is False:
                grund = "in_registry_abgeschaltet"
            elif not _maschine_passt(zeile, host, registry):
                grund = "nicht_fuer_diese_maschine"
        eintrag(str(name), "claude", grund)
    pi = konfig.get("pi")
    if isinstance(pi, dict):
        for name in sorted((pi.get("modelle") or {})):
            eintrag(str(name), "pi", None)
    if isinstance(konfig.get("codex"), dict) and registry is not None:
        for item in registry["models"]:
            if isinstance(item, dict) and item.get("harness") == "codex" and isinstance(item.get("id"), str) \
                    and isinstance(item.get("modelRef"), str):
                grund = "in_registry_abgeschaltet" if item.get("enabled") is False else "codex_nur_trockenlauf"
                eintrag(item["id"], "codex", grund)
    return raus


def welt_modelle(root: str | os.PathLike[str]) -> Optional[list[dict[str, Any]]]:
    """Modellliste der Welt; ``None`` ohne ``traeger.json`` (die Ansicht laesst das Feld dann weg)."""
    import agents_data as ad
    konfig = ad.world_carrier_config(Path(root))
    if konfig is None:
        return None
    return modelle(konfig, registry_lesen(konfig))


__all__ = ["abo", "ist_fable", "modelle", "registry_lesen", "welt_modelle"]
