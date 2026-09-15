#!/usr/bin/env python3
"""Nachgelagerter Weckaufruf fuer wb-ticket, wb-kanal, wb-welt und Agentenantraege aus wb-agent.

Nach einem erfolgreichen Schreibvorgang weckt dieser Aufruf den Traeger der Welt, wenn in
der Weltablage eine Traegerkonfiguration ``traeger.json`` liegt. Ohne Konfiguration tut er
nichts und schreibt nichts. Er aendert nie den Ausgang des Schreibbefehls: Fehler erscheinen
als eine Zeile auf stderr, der Exitcode bleibt 0.

``maschine`` ist ``lokal`` oder ein Hostname (etwa ``peer``). Auf einer anderen Maschine
wird ueber ``ssh <maschine>`` das dort liegende ``traeger_modul`` mit ``wecken`` aufgerufen.
"""
from __future__ import annotations

import json
import os
import shlex
import socket
import subprocess
import sys
from pathlib import Path
from typing import Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402

WECKBEFEHLE = {("ticket", "neu"), ("kanal", "senden"), ("welt", "antwort"), ("agent", "antrag"),
               ("agent", "antrag-entscheiden")}
KONFIGNAME = "traeger.json"


def welt_aus_argv(kind: str, argv: list[str]) -> Optional[Path]:
    if kind not in {"ticket", "kanal", "welt", "agent"}:
        return None
    try:
        args = ad.parser_for(kind).parse_args(argv)
    except SystemExit:
        return None
    if (kind, args.command) not in WECKBEFEHLE:
        return None
    return Path(os.path.abspath(os.path.expanduser(args.world)))


def wecken_welt(world: Path, *, hostname: Optional[str] = None) -> str:
    """Weckt den konfigurierten Traeger der Welt; gibt den Zustand als Wort zurueck."""
    path = world / KONFIGNAME
    if not path.is_file() or path.is_symlink():
        return "nicht_konfiguriert"
    data = json.loads(path.read_text(encoding="utf-8"))
    maschine = str(data.get("maschine") or "lokal")
    if Path(str(data.get("world_root"))).resolve() != world.resolve():
        raise ValueError("Traegerkonfiguration gehoert zu einer anderen Weltablage")
    host = (hostname or socket.gethostname()).split(".")[0].lower()
    if maschine == "lokal" or maschine.lower() == host:
        import agents_traeger
        return agents_traeger.wecken(path)
    modul = data.get("traeger_modul")
    if not modul or not str(modul).startswith("/"):
        raise ValueError("Traegerkonfiguration fuer %s nennt kein absolutes traeger_modul" % maschine)
    python = str(data.get("python") or "/usr/bin/python3")
    ssh = os.environ.get("WB_TRAEGER_SSH") or "ssh"  # Testhaken; im Betrieb nie gesetzt
    result = subprocess.run([ssh, "-oBatchMode=yes", "-oConnectTimeout=8", maschine,
                             shlex.join([python, "-I", str(modul), "wecken", "--konfig", str(path)])],
                            text=True, capture_output=True, timeout=45)
    if result.returncode != 0:
        raise RuntimeError("Fernwecken auf %s fehlgeschlagen: %s" % (maschine, result.stderr.strip()[:200]))
    try:
        return str(json.loads(result.stdout)["wecken"])
    except (ValueError, KeyError, TypeError):
        return "unbekannt"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return 0
    world = welt_aus_argv(argv[0], argv[1:])
    if world is None:
        return 0
    try:
        state = wecken_welt(world)
    except Exception as exc:  # noqa: BLE001 - der Schreibbefehl ist bereits erfolgreich
        print("wb-agents: Traeger nicht geweckt (%s: %s)" % (type(exc).__name__, str(exc)[:200]), file=sys.stderr)
        return 0
    if state != "nicht_konfiguriert":
        print("wb-agents: Traeger %s" % state, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
