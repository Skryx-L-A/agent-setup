#!/usr/bin/env python3
"""Denkstufe aus dem Agentenprofil als Aufrufargumente des Harness.

Die Stufe steht im Profil (``model_profile.effort``, etwa aus ``opus5:xhigh``). Die Schreibweise
je Harness kommt aus der Modellregistry ``~/.claude/workbench/models.json`` (Harness-Eintrag
``effort``: ``style``, ``args`` mit ``{effort}``, ``map``); ohne Registry gelten die dort
eingetragenen Vorgaben fuer Claude Code, Codex und Pi. Nennt die Registry fuer das Modell eine
Obergrenze (``maxEffort``) oder eine Liste (``efforts``), wird die Stufe darauf gesenkt, nie
angehoben.

Gemessen an Claude Code 2.1.241 (``shell/messungen/agents-remote/claude-effort-probe.py``):
``--effort`` erscheint bei Sonnet 5 und Opus 5 als ``output_config.effort`` im Anfragekoerper;
Haiku 4.5 bekommt keine Stufe.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

STUFEN = ("low", "medium", "high", "xhigh", "max")
REGISTRY = Path("~/.claude/workbench/models.json")
VORGABEN: dict[str, dict[str, Any]] = {
    "claude": {"style": "arg", "args": ["--effort", "{effort}"], "map": {s: s for s in STUFEN}},
    "codex": {"style": "arg", "args": ["--config", "model_reasoning_effort={effort}"], "map": {s: s for s in STUFEN}},
    "pi": {"style": "arg", "args": ["--thinking", "{effort}"], "map": {s: s for s in STUFEN}},
}


class DenkstufeFehler(ValueError):
    """Unbekannter Harness oder unbrauchbare Stufe."""


def registry_laden(path: Optional[str | os.PathLike[str]] = None) -> Optional[dict[str, Any]]:
    """Liest die Modellregistry; eine fehlende oder unlesbare Datei heisst: Vorgaben verwenden."""
    target = Path(os.path.expanduser(str(path or REGISTRY)))
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _eintrag(items: Any, key: str) -> Optional[dict[str, Any]]:
    if isinstance(items, dict):
        value = items.get(key)
        return value if isinstance(value, dict) else None
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and item.get("id") == key:
            return item
    return None


def denkstufe_argumente(harness: str, stufe: Optional[str], *, modell: Optional[str] = None,
                        registry: Optional[dict[str, Any]] = None) -> tuple[list[str], dict[str, Any]]:
    """Argumente fuer die Stufe und ein Befund (angefragt, wirksam, Quelle, gesenkt)."""
    befund: dict[str, Any] = {"harness": harness, "angefragt": stufe, "wirksam": None, "quelle": "vorgabe",
                              "gesenkt": False}
    if stufe is None:
        return [], befund
    if stufe not in STUFEN:
        raise DenkstufeFehler("Denkstufe muss low, medium, high, xhigh oder max sein")
    spec = _eintrag((registry or {}).get("harnesses"), harness)
    if spec is not None and isinstance(spec.get("effort"), dict):
        spec, befund["quelle"] = spec["effort"], "registry"
    elif harness in VORGABEN:
        spec = VORGABEN[harness]
    else:
        raise DenkstufeFehler("Harness ohne bekannte Denkstufe: %s" % harness)
    if spec.get("style") != "arg" or not spec.get("args"):
        befund["wirksam"] = None
        befund["grund"] = "harness_ohne_stufe"
        return [], befund
    allowed = [s for s in STUFEN if s in (spec.get("map") or {})]
    model = _eintrag((registry or {}).get("models"), modell) if modell else None
    if model is not None:
        if model.get("supportsEffort") is False:
            befund["grund"] = "modell_ohne_stufe"
            return [], befund
        if isinstance(model.get("efforts"), list):
            allowed = [s for s in allowed if s in model["efforts"]]
        if model.get("maxEffort") in STUFEN:
            allowed = [s for s in allowed if STUFEN.index(s) <= STUFEN.index(model["maxEffort"])]
    if not allowed:
        befund["grund"] = "keine_erlaubte_stufe"
        return [], befund
    wirksam = stufe
    if wirksam not in allowed:
        lower = [s for s in allowed if STUFEN.index(s) < STUFEN.index(stufe)]
        wirksam = lower[-1] if lower else allowed[0]
        if STUFEN.index(wirksam) > STUFEN.index(stufe):
            befund["grund"] = "keine_niedrigere_stufe"
            return [], befund
        befund["gesenkt"] = True
    value = str(spec["map"][wirksam])
    befund["wirksam"] = wirksam
    return [str(arg).replace("{effort}", value) for arg in spec["args"]], befund


__all__ = ["DenkstufeFehler", "REGISTRY", "STUFEN", "VORGABEN", "denkstufe_argumente", "registry_laden"]
