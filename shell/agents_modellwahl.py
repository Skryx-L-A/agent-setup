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
import re
from pathlib import Path
from typing import Any, Optional

REGISTRY_VORGABE = Path.home() / ".claude" / "workbench" / "models.json"
FAMILIEN_FALLBACK = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5",
                     "haiku": "claude-haiku-5-5"}


def familienmodell(familie: str, registry: Optional[dict[str, Any]], fallback: Optional[str] = None) -> Optional[str]:
    """Resolve a Claude family alias to its newest enabled numeric version."""
    if registry is not None:
        specs = []
        for harness in registry.get("harnesses", []) if isinstance(registry.get("harnesses"), list) else []:
            if isinstance(harness, dict) and harness.get("id") == "claude":
                specs.extend(harness.get("modelFamilyAliases") or [])
        for spec in specs:
            if not isinstance(spec, dict) or familie not in (spec.get("aliases") or []):
                continue
            try:
                pattern = re.compile(spec.get("idPattern") or "")
            except re.error:
                continue
            candidates = []
            for item in registry.get("models", []):
                if not isinstance(item, dict) or item.get("harness") != "claude" or item.get("enabled") is False:
                    continue
                match = pattern.fullmatch(str(item.get("id") or ""))
                raw = match.groupdict().get("version") if match else None
                if not raw or not re.fullmatch(r"[0-9]+(?:-[0-9]+)*", raw):
                    continue
                candidates.append((tuple(int(part) for part in raw.split("-")), item))
            if candidates:
                item = max(candidates, key=lambda candidate: candidate[0])[1]
                return str(item.get("modelRef") or item.get("id"))
            break
    return fallback or FAMILIEN_FALLBACK.get(familie)


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
        if harness == "codex":
            item["profilgrenze"] = "nur_launcher"
        if grund is not None:
            item["grund"] = grund
        raus.append(item)

    for name, ziel in sorted((konfig.get("modelle") or {}).items()):
        familie, trennzeichen, stufe = str(name).partition(":")
        if trennzeichen and ((familie in {"opus", "sonnet"} and stufe in {"low", "medium", "high", "xhigh"})
                             or (familie == "haiku" and stufe in {"medium", "high", "xhigh"})):
            continue
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
    family_efforts = {"opus": ("low", "medium", "high", "xhigh"),
                      "sonnet": ("low", "medium", "high", "xhigh"),
                      "haiku": ("medium", "high", "xhigh")}
    configured = konfig.get("modelle") or {}
    for familie, efforts in family_efforts.items():
        for effort in efforts:
            alias = "%s:%s" % (familie, effort)
            fallback = configured.get(alias) or FAMILIEN_FALLBACK[familie]
            ziel = familienmodell(familie, registry, fallback)
            if not ziel:
                continue
            grund = None
            if registry is not None:
                zeile = _registry_claude(registry, ziel)
                if zeile is None:
                    grund = "nicht_in_registry"
                elif zeile.get("enabled") is False:
                    grund = "in_registry_abgeschaltet"
                elif not _maschine_passt(zeile, host, registry):
                    grund = "nicht_fuer_diese_maschine"
            item = {"id": alias, "modell": ziel, "harness": "claude", "verfuegbar": grund is None}
            if grund is not None:
                item["grund"] = grund
            raus.append(item)
    pi = konfig.get("pi")
    if isinstance(pi, dict):
        for name in sorted((pi.get("modelle") or {})):
            eintrag(str(name), "pi", None)
    if isinstance(konfig.get("codex"), dict) and registry is not None:
        from agents_codex import CodexAnmeldung
        auth = CodexAnmeldung(konfig["codex"]["auth"]).status()
        for item in registry["models"]:
            if isinstance(item, dict) and item.get("harness") == "codex" and isinstance(item.get("id"), str) \
                    and isinstance(item.get("modelRef"), str):
                grund = ("in_registry_abgeschaltet" if item.get("enabled") is False else
                         "nicht_fuer_diese_maschine" if not _maschine_passt(item, host, registry) else
                         "Anmeldung fehlt" if not auth["available"] else None)
                eintrag(item["id"], "codex", grund)
    return raus


def welt_modelle(root: str | os.PathLike[str]) -> Optional[list[dict[str, Any]]]:
    """Modellliste der Welt; ``None`` ohne ``traeger.json`` (die Ansicht laesst das Feld dann weg)."""
    import agents_data as ad
    konfig = ad.world_carrier_config(Path(root))
    if konfig is None:
        return None
    return modelle(konfig, registry_lesen(konfig))


__all__ = ["abo", "familienmodell", "ist_fable", "modelle", "registry_lesen", "welt_modelle"]
