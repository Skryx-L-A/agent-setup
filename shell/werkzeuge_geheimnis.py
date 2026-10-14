#!/usr/bin/env python3
"""Geheimnisverweise der Werkzeugquelle (Plan Abschnitt 3.3, Spur S5).

Die Quelle `werkzeuge.default.json` enthaelt unter `geheimnisse` nur Verweise:
  schluesselbund:<dienst>/<konto>   Passwort aus dem Schluesselbund des Traegerhosts
  filter:<name>                     Geheimnisfilter-Dienst (Abfrageweg offen, siehe OPEN in der Ergebnisdatei)

Aufgaben:
  verweis_gueltig(wert)     True nur fuer die beiden Verweisformen.
  muster_pruefen(quelle)    Befunde {"code","eintrag","text"} mit Code GEHEIMNIS-IN-QUELLE. Ausgabe ohne Wert.
  start(server, ...)        Fuer `wb-mcp-start`: Werte zur Laufzeit holen, nur in die Umgebung des
                            Kindprozesses setzen, dann exec. Stdout, stderr und Dateien bekommen keinen Wert.

Exitcodes der Befehle `start` und `pruefen`:
  0 ok (pruefen ohne Befund), 2 Befund in der Quelle oder ungueltige Form, 3 Geheimnis nicht verfuegbar,
  4 Eintrag oder Startbefehl fehlt, 64 Gebrauch.

Die Musterliste ist eine Kopie der Schluessel-Muster aus den guard-secrets-Hooks (bash-guard.py,
lib/geheimnis_inhalt.py). Die Hooks werden nur gelesen, nicht importiert, damit die Quelle nicht
von der Live-Konfiguration abhaengt. Der Schluesselbund-Zugriff ist agents_zugaenge._geheimnis.

WB_SCHLUESSELBUND_CMD ersetzt das Schluesselbund-Programm nur, wenn zusaetzlich WB_TESTUMGEBUNG=1 gesetzt ist.
Sonst wird der Ersatz mit einer Meldung auf stderr ignoriert.

Fallback-Quelle: fehlt WB_WERKZEUGE_SRC und liegt keine Quelle neben dem Skript oder unter ~/.local/bin,
liest quelle_suchen() den Werkbank-Klon unter ~/AI/claude-workbench/shell. Das kann einen unausgerollten
Arbeitsstand starten (OPEN in der Ergebnisdatei).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agents_zugaenge as zg  # noqa: E402  (eine Quelle fuer die Schluesselbund-Abfrage)

VERWEIS = re.compile(
    r"schluesselbund:([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._@-]*)|filter:([A-Za-z0-9][A-Za-z0-9._-]*)")
ENV_NAME = re.compile(r"[A-Z_][A-Z0-9_]*")
GESPERRT = ("PATH", "BASH_ENV", "ENV", "PYTHONPATH", "PYTHONHOME")
GESPERRT_PRAEFIX = ("DYLD_", "LD_")
MUSTER = [
    ("aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("github_token", re.compile(r"(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255}")),
    ("anthropic_key", re.compile(r"(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}")),
    ("openai_key", re.compile(r"(?<![A-Za-z0-9])sk-(?!ant-)[A-Za-z0-9_-]{20,}")),
    ("slack_token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,48}")),
    ("google_api_key", re.compile(r"AIza[0-9A-Za-z_-]{35,}")),
    ("google_oauth_client_secret", re.compile(r"(?<![A-Za-z0-9])GOCSPX-[A-Za-z0-9_-]{28,}")),
    ("private_key_block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("stripe_key", re.compile(r"(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}")),
    ("bearer_token", re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}")),
]
# Schluesselname = Wert mit mindestens 16 Zeichen. Ohne Entropieschwelle wie im Guard: die Quelle ist
# kuratiert, ein Fehlalarm ist dort seltener als ein uebersehener Wert.
GENERISCH = re.compile(
    r"(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b"
    r"\s*[:=]\s*[\"']?([A-Za-z0-9+/_=\-~.]{16,})"
)
# Elternschluessel, unter denen ein langer Wert ohne Verweisform als Geheimnis gilt.
SCHLUESSELNAME = re.compile(r"(?i)password|passwd|secret|token|api_?key|access_?key|auth")
# Wert unter einem solchen Schluessel: ohne Schraegstrich, damit Pfade (Verweis- und Dateinamen) nicht anschlagen.
SCHLUESSELWERT = re.compile(r"[A-Za-z0-9][A-Za-z0-9+_=\-~.]{15,}")


class GeheimnisFehler(Exception):
    """Ein Verweis laesst sich nicht aufloesen. Die Meldung nennt den Verweis, nie einen Wert."""


def verweis_gueltig(wert: Any) -> bool:
    return isinstance(wert, str) and VERWEIS.fullmatch(wert) is not None


def _befund(code: str, eintrag: str, text: str) -> dict[str, str]:
    return {"code": code, "eintrag": eintrag, "text": text}


def muster_pruefen(quelle: Any) -> list[dict[str, str]]:
    """Befunde zu Literalwerten in der Quelle. Der Wert selbst taucht in keinem Befund auf."""
    befunde: list[dict[str, str]] = []

    def gehe(knoten: Any, pfad: list[str], schluessel: str, in_geheimnissen: bool) -> None:
        if isinstance(knoten, dict):
            for name, kind in knoten.items():
                gehe(kind, pfad + [str(name)], str(name), in_geheimnissen or name == "geheimnisse")
            return
        eintrag = ".".join(pfad[:2]) or "(wurzel)"
        if isinstance(knoten, list):
            if in_geheimnissen:
                befunde.append(_befund("GEHEIMNIS-IN-QUELLE", eintrag, "Liste unter geheimnisse (erwartet Objekt)"))
                return
            for kind in knoten:
                gehe(kind, pfad, schluessel, False)
            return
        if in_geheimnissen:
            if not verweis_gueltig(knoten):
                befunde.append(_befund(
                    "GEHEIMNIS-IN-QUELLE", eintrag,
                    "Wert ohne Verweisform (erwartet schluesselbund:<dienst>/<konto> oder filter:<name>)"))
            return
        if not isinstance(knoten, str):
            return
        for name, rx in MUSTER:
            if rx.search(knoten):
                befunde.append(_befund(
                    "GEHEIMNIS-IN-QUELLE", eintrag,
                    "Muster %s im Wert; Zugangsdaten gehoeren in den Schluesselbund" % name))
                return
        if GENERISCH.search(knoten):
            befunde.append(_befund(
                "GEHEIMNIS-IN-QUELLE", eintrag, "Schluesselname mit langem Wert; Zugangsdaten gehoeren in den Schluesselbund"))
            return
        if SCHLUESSELNAME.search(schluessel) and SCHLUESSELWERT.fullmatch(knoten):
            befunde.append(_befund(
                "GEHEIMNIS-IN-QUELLE", eintrag,
                "Wert unter Schluesselname %s; Zugangsdaten gehoeren in den Schluesselbund" % schluessel))

    gehe(quelle, [], "", False)
    return befunde


def _ersatzprogramm() -> Optional[str]:
    """WB_SCHLUESSELBUND_CMD gilt nur mit dem Testanker WB_TESTUMGEBUNG=1; sonst Meldung und Ignorieren."""
    ersatz = os.environ.get("WB_SCHLUESSELBUND_CMD")
    if not ersatz:
        return None
    if os.environ.get("WB_TESTUMGEBUNG") != "1":
        _melden("WB_SCHLUESSELBUND_CMD ohne WB_TESTUMGEBUNG=1 ignoriert")
        return None
    return ersatz


def _schluesselbund_befehl(cmd: list[str], **kwargs: Any) -> Any:
    """Startet den Schluesselbund-Befehl; im Testanker ersetzt WB_SCHLUESSELBUND_CMD das Programm."""
    ersatz = _ersatzprogramm()
    if ersatz:
        cmd = [ersatz] + cmd[1:]
    return subprocess.run(cmd, **kwargs)


def aufloesen(verweis: str) -> str:
    treffer = VERWEIS.fullmatch(verweis)
    if treffer is None:
        raise GeheimnisFehler("kein gueltiger Verweis")
    if treffer.group(3):
        raise GeheimnisFehler(
            "filter:%s ist nicht angebunden: der Geheimnisfilter liefert keine Werte, Abfrageweg offen"
            % treffer.group(3))
    try:
        return zg._geheimnis(treffer.group(1), treffer.group(2), runner=_schluesselbund_befehl)
    except zg.ZugangFehler as exc:
        raise GeheimnisFehler(str(exc)) from None


def quelle_suchen(pfad: Optional[str]) -> Path:
    """Suchreihenfolge wie wb-harness-config: WB_WERKZEUGE_SRC, Skriptverzeichnis, ~/.local/bin, Werkbank-Klon."""
    kandidaten = [pfad or os.environ.get("WB_WERKZEUGE_SRC") or "",
                  str(Path(__file__).resolve().parent / "werkzeuge.default.json"),
                  os.path.expanduser("~/.local/bin/werkzeuge.default.json"),
                  os.path.expanduser("~/AI/claude-workbench/shell/werkzeuge.default.json")]
    for kandidat in kandidaten:
        if kandidat and Path(kandidat).is_file():
            return Path(kandidat)
    raise FileNotFoundError("keine Werkzeugquelle gefunden (WB_WERKZEUGE_SRC setzen)")


def _melden(text: str) -> None:
    print("wb-mcp-start: " + text, file=sys.stderr)


def _lade_quelle(quelle_pfad: Optional[str]) -> Any:
    return json.loads(quelle_suchen(quelle_pfad).read_text(encoding="utf-8"))


def start(server: str, quelle_pfad: Optional[str], zusatz: list[str]) -> int:
    """Startet den MCP-Server aus mcp.<server> mit seinen Geheimnissen. Kehrt nur bei Fehlern zurueck."""
    try:
        quelle = _lade_quelle(quelle_pfad)
    except (OSError, ValueError) as exc:
        _melden("Quelle nicht lesbar: %s" % type(exc).__name__)
        return 2
    if not isinstance(quelle, dict):
        _melden("Quelle hat keine Objektwurzel")
        return 2
    mcp = quelle.get("mcp")
    eintrag = mcp.get(server) if isinstance(mcp, dict) else None
    if not isinstance(eintrag, dict):
        _melden("kein Eintrag mcp.%s in der Quelle" % server)
        return 4
    befunde = muster_pruefen({"mcp": {server: eintrag}})
    if befunde:
        for befund in befunde:
            _melden("%s %s: %s" % (befund["code"], befund["eintrag"], befund["text"]))
        return 2
    startbefehl = eintrag.get("start")
    if not isinstance(startbefehl, list) or not startbefehl or not all(isinstance(a, str) for a in startbefehl):
        _melden("Eintrag mcp.%s hat kein Feld start (Liste aus Programm und Argumenten)" % server)
        return 4
    geheimnisse = eintrag.get("geheimnisse") or {}
    if not isinstance(geheimnisse, dict) or not all(isinstance(v, str) for v in geheimnisse.values()):
        _melden("geheimnisse von mcp.%s ist kein Objekt mit Verweisen" % server)
        return 2
    for variable in geheimnisse:
        if not ENV_NAME.fullmatch(variable):
            _melden("Variablenname in mcp.%s ist ungueltig" % server)
            return 2
        if variable in GESPERRT or variable.startswith(GESPERRT_PRAEFIX):
            _melden("Variable %s in mcp.%s ist gesperrt" % (variable, server))
            return 2
    umgebung = dict(os.environ)
    for variable, verweis in geheimnisse.items():
        try:
            umgebung[variable] = aufloesen(verweis)
        except GeheimnisFehler as exc:
            _melden("%s (%s): %s" % (variable, verweis, exc))
            return 3
    argv = startbefehl + zusatz
    try:
        os.execvpe(argv[0], argv, umgebung)
    except OSError as exc:
        _melden("Start von %s fehlgeschlagen: %s" % (argv[0], type(exc).__name__))
        return 4
    return 4  # nicht erreichbar: execvpe ersetzt den Prozess


def _pruefen(quelle_pfad: Optional[str]) -> int:
    try:
        quelle = _lade_quelle(quelle_pfad)
    except (OSError, ValueError) as exc:
        _melden("Quelle nicht lesbar: %s" % type(exc).__name__)
        return 2
    if not isinstance(quelle, dict):
        _melden("Quelle hat keine Objektwurzel")
        return 2
    befunde = muster_pruefen(quelle)
    print(json.dumps(befunde, ensure_ascii=False, indent=2))
    return 2 if befunde else 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="werkzeuge_geheimnis.py")
    parser.add_argument("--quelle", help="Pfad der Werkzeugquelle (sonst Suchreihenfolge)")
    sub = parser.add_subparsers(dest="befehl", required=True)
    sp_start = sub.add_parser("start", help="MCP-Server mit Geheimnissen starten (exec)")
    sp_start.add_argument("server")
    sp_start.add_argument("zusatz", nargs=argparse.REMAINDER)
    sub.add_parser("pruefen", help="Befunde zu Literalwerten in der Quelle ausgeben")
    args = parser.parse_args(argv)
    if args.befehl == "start":
        return start(args.server, args.quelle, args.zusatz)
    return _pruefen(args.quelle)


if __name__ == "__main__":
    sys.exit(main())
