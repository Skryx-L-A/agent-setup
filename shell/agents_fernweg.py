#!/usr/bin/env python3
"""Fernweg fuer wb-ticket, wb-kanal und wb-welt: eine Welt, deren verbindliche Ablage auf einer anderen Maschine liegt.

Plan Abschnitt 13: jede Welt hat genau eine verbindliche Zustandsablage auf einer festgelegten
Maschine; es gibt keine stillen Schreibzugriffe auf eine zweite Kopie. Eine Weltangabe der Form
``<host>:/absoluter/pfad`` fuehrt deshalb den ganzen Befehl ueber ``ssh <host>`` mit der dort
installierten Laufzeit aus (Vorgabe ``~/.local/share/werkbank-agents/laufzeit/shell``, sonst
``WB_AGENTS_FERN_SHELL``). Dort schreibt der Befehl in die Ablage und weckt den Traeger lokal.
Ausgabe und Exitcode kommen unveraendert zurueck.
"""
from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402

ARTEN = ("ticket", "kanal", "welt")
FERN = re.compile(r"(?P<host>[a-z][a-z0-9-]{0,62}):(?P<pfad>/[^\x00]*)\Z")
LAUFZEIT = ".local/share/werkbank-agents/laufzeit/shell"
# Diese Angaben nennen Dateien auf der eigenen Maschine; ueber ssh wuerden sie etwas anderes bedeuten.
LOKALE_DATEIEN = ("--datei", "--entwurf-datei")


class FernwegFehler(ValueError):
    """Ungueltiger Fernaufruf."""


def fernziel(kind: str, argv: list[str]) -> Optional[tuple[str, str, int]]:
    """(host, pfad, index der Weltangabe) fuer einen Fernaufruf, sonst None."""
    if kind not in ARTEN:
        return None
    try:
        args = ad.parser_for(kind).parse_args(argv)
    except SystemExit:
        return None
    world = getattr(args, "world", None)
    match = FERN.fullmatch(world) if isinstance(world, str) else None
    if match is None:
        return None
    index = next(i for i, value in enumerate(argv) if value == world)
    if any(value.split("=", 1)[0] in LOKALE_DATEIEN for value in argv):
        raise FernwegFehler("Dateiangaben gelten nur fuer eine Welt auf dieser Maschine")
    if ".." in Path(match.group("pfad")).parts:
        raise FernwegFehler("Fernpfad muss kanonisch sein")
    return match.group("host"), match.group("pfad"), index


def fernbefehl(kind: str, argv: list[str], ziel: tuple[str, str, int]) -> list[str]:
    host, pfad, index = ziel
    remote = list(argv)
    remote[index] = pfad
    shell_dir = os.environ.get("WB_AGENTS_FERN_SHELL") or LAUFZEIT
    ssh = os.environ.get("WB_FERN_SSH") or "ssh"  # Testhaken; im Betrieb nie gesetzt
    return [ssh, "-oBatchMode=yes", "-oConnectTimeout=8", host,
            shlex.join(["%s/wb-%s" % (shell_dir.rstrip("/"), kind), *remote])]


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in {"pruefen", "ausfuehren"}:
        print("Aufruf: agents_fernweg.py pruefen|ausfuehren <ticket|kanal|welt> <argumente>", file=sys.stderr)
        return 2
    mode, kind, rest = argv[0], argv[1], argv[2:]
    try:
        ziel = fernziel(kind, rest)
    except FernwegFehler as exc:
        print("wb-%s: FEHLER - %s" % (kind, exc), file=sys.stderr)
        return 2 if mode == "ausfuehren" else 0
    if mode == "pruefen":
        return 0 if ziel is not None else 1
    if ziel is None:
        print("wb-%s: FEHLER - keine Weltangabe der Form <host>:/pfad" % kind, file=sys.stderr)
        return 2
    return subprocess.run(fernbefehl(kind, rest, ziel), stdin=sys.stdin).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
