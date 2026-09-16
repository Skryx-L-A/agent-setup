#!/usr/bin/env python3
"""Autostart der Traeger (Plan Schritt 7): beim Anmelden einmal jeden konfigurierten Traeger wecken, sonst nichts.

Ein Traeger laeuft nur, solange Arbeit ihn braucht. Der Autostart ist deshalb kein Dauerdienst:
eine systemd-User-Unit ``wb-agents-autostart.service`` vom Typ ``oneshot`` ruft beim Start der
User-Session einmal ``wecken`` auf. Jeder Traeger prueft danach selbst, ob Arbeit ansteht, und
beendet sich sonst. Welche Welten dazugehoeren, steht im Register
``~/.local/state/werkbank-agents/welten.json``; ``agents_traeger.py einrichten`` traegt ein.

``installieren`` legt eine Laufzeit (``shell/``, ``hooks/``, ``agents/bibliothek/skills`` und ``skripte``) unter
``~/.local/share/werkbank-agents/laufzeit`` an, schreibt die Unit und aktiviert sie; nur Linux.
Auf dem Mac erzeugt ``plist`` das LaunchAgent-Gegenstueck als Datei, legt es aber nie nach
``~/Library/LaunchAgents`` und laedt nichts.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import platform
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Callable, Optional
from xml.sax.saxutils import escape

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import atomar_schreiben  # noqa: E402

UNIT = "wb-agents-autostart.service"
PLIST_LABEL = "de.werkbank.agents.autostart"
ZUSTAND = Path("~/.local/state/werkbank-agents")
LAUFZEIT = Path("~/.local/share/werkbank-agents/laufzeit")
# Was die Laufzeit braucht: Traeger, Daten, Lauf, Proxy, Runner, Skills, Sperren und die Befehle.
SHELL_DATEIEN = ("agents_autostart.py", "agents_claude.py", "agents_claude_lauf.py", "agents_claude_runner.py",
                 "agents_codex.py", "agents_codex_runner.py", "agents_controller.py", "agents_controller_endpoint.py",
                 "agents_data.py", "agents_denkstufe.py",
                 "agents_fernweg.py", "agents_kontingent.py", "agents_lauf.py", "agents_linux.py",
                 "agents_model_bridge.py", "agents_model_proxy.py", "agents_modellwahl.py", "agents_pi.py", "agents_pi_runner.py",
                 "agents_rpc_client.py", "agents_skills.py", "agents_skills_ansicht.py", "agents_traeger.py",
                 "agents_traeger_wecken.py", "agents_wecker.py", "agents_weltauftrag.py", "agents_weltumzug.py",
                 "agents_worktree.py", "agents_zugaenge.py",
                 "atomar_schreiben.py", "wb-agent", "<ein eigenes Mailwerkzeug>", "wb-kanal", "wb-profil",
                 "wb-profil-gesperrt.json", "<ein eigenes Mailwerkzeug>", "wb-skill", "wb-ticket", "wb-welt")
HOOK_DATEIEN = ("skills-sperre.sh", "profil-sperre.sh", "lib/cmdshell.py", "lib/skills_sperre.py",
                "lib/profil_sperre.py", "lib/reviewer_sperre.py", "lib/rollen.py")


class AutostartFehler(Exception):
    """Abgelehnte Autostart-Operation."""


def zustand_dir() -> Path:
    return Path(os.path.expanduser(os.environ.get("WB_AGENTS_ZUSTAND") or str(ZUSTAND)))


def register_pfad() -> Path:
    return zustand_dir() / "welten.json"


def _jetzt() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def register_lesen() -> dict[str, Any]:
    path = register_pfad()
    if not path.exists():
        return {"version": 1, "welten": []}
    if path.is_symlink():
        raise AutostartFehler("Weltenregister darf kein Symlink sein")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("welten"), list):
        raise AutostartFehler("Weltenregister hat unbekanntes Format")
    return data


def _register_schreiben(data: dict[str, Any]) -> None:
    folder = zustand_dir()
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomar_schreiben.schreiben(register_pfad(), json.dumps(data, ensure_ascii=False, indent=2) + "\n", modus=0o600,
                               dauerhaft=True)


def registrieren(konfig: str | os.PathLike[str]) -> dict[str, Any]:
    path = str(Path(konfig).resolve())
    if not Path(path).is_file():
        raise AutostartFehler("Traegerkonfiguration fehlt: %s" % path)
    data = register_lesen()
    if not any(item.get("konfig") == path for item in data["welten"]):
        data["welten"].append({"konfig": path, "seit": _jetzt()})
        _register_schreiben(data)
    return data


def abmelden(konfig: str | os.PathLike[str]) -> dict[str, Any]:
    path = str(Path(konfig).resolve())
    data = register_lesen()
    rest = [item for item in data["welten"] if item.get("konfig") != path]
    if len(rest) != len(data["welten"]):
        data["welten"] = rest
        _register_schreiben(data)
    return data


def wecken_alle(wecker: Optional[Callable[[Path], str]] = None) -> dict[str, Any]:
    """Weckt jeden registrierten Traeger dieser Maschine einmal; ein Fehler haelt die anderen nicht auf."""
    if wecker is None:
        import agents_traeger
        wecker = agents_traeger.wecken
    import socket
    host = socket.gethostname().split(".")[0].lower()
    ergebnisse = []
    for item in register_lesen()["welten"]:
        path = Path(str(item.get("konfig")))
        eintrag: dict[str, Any] = {"konfig": str(path)}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            maschine = str(data.get("maschine") or "lokal")
            if maschine != "lokal" and maschine.lower() != host:
                eintrag["ergebnis"] = "andere_maschine"
            else:
                eintrag["ergebnis"] = wecker(path)
        except Exception as exc:  # noqa: BLE001 - jede Welt fuer sich
            eintrag.update(ergebnis="fehler", fehler="%s: %s" % (type(exc).__name__, str(exc)[:200]))
        ergebnisse.append(eintrag)
    record = {"zeit": _jetzt(), "pid": os.getpid(), "ergebnisse": ergebnisse}
    zustand_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
    atomar_schreiben.schreiben(zustand_dir() / "autostart.json", json.dumps(record, ensure_ascii=False, indent=2) + "\n",
                               modus=0o600, dauerhaft=True)
    return record


def letzter_lauf() -> Optional[dict[str, Any]]:
    path = zustand_dir() / "autostart.json"
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() and not path.is_symlink() else None
    except (OSError, ValueError):
        return None


def unit_text(laufzeit: Path, python: str = "/usr/bin/python3") -> str:
    modul = Path(laufzeit) / "shell" / "agents_autostart.py"
    return "\n".join([
        "[Unit]",
        "Description=Werkbank Agents: konfigurierte Traeger einmal wecken",
        "",
        "[Service]",
        "Type=oneshot",
        "Environment=PATH=/usr/bin:/bin",
        "ExecStart=%s -I %s wecken" % (python, modul),
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ])


def plist_text(laufzeit: Path, python: str = "/usr/bin/python3") -> str:
    modul = Path(laufzeit) / "shell" / "agents_autostart.py"
    args = "".join("\n    <string>%s</string>" % escape(str(value)) for value in (python, "-I", modul, "wecken"))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>%s</string>\n'
            '  <key>ProgramArguments</key>\n  <array>%s\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n'
            '  <key>KeepAlive</key>\n  <false/>\n</dict>\n</plist>\n') % (PLIST_LABEL, args)


def plist_schreiben(laufzeit: Path, ausgabe: Path) -> Path:
    """Schreibt das LaunchAgent-Gegenstueck als Datei; nie in einen Ordner, aus dem launchd laedt."""
    ausgabe = Path(ausgabe).expanduser().resolve()
    verboten = [Path("~/Library/LaunchAgents").expanduser(), Path("/Library/LaunchAgents"), Path("/Library/LaunchDaemons")]
    if any(ausgabe == folder or folder in ausgabe.parents for folder in verboten):
        raise AutostartFehler("Das plist wird nicht nach LaunchAgents gelegt und nicht geladen")
    atomar_schreiben.schreiben(ausgabe, plist_text(laufzeit), modus=0o644)
    return ausgabe


def laufzeit_anlegen(ziel: Path, repo: Path) -> Path:
    """Kopiert die Laufzeit neu nach ``ziel`` (erst vollstaendig daneben, dann per rename getauscht)."""
    ziel = Path(ziel).expanduser()
    ziel.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    stage = ziel.parent / (".%s.neu-%s" % (ziel.name, uuid.uuid4().hex[:8]))
    try:
        for name in SHELL_DATEIEN:
            _kopieren(repo / "shell" / name, stage / "shell" / name)
        for name in HOOK_DATEIEN:
            _kopieren(repo / "hooks" / name, stage / "hooks" / name)
        # Skills und gespeicherte Skripte: pruefen-vor-abgabe verweist auf agents/bibliothek/skripte.
        for folder in ("skills", "skripte"):
            library = repo / "agents" / "bibliothek" / folder
            if library.is_dir():
                for path in sorted(library.rglob("*")):
                    if path.is_file() and "__pycache__" not in path.parts and not path.name.endswith(".pyc") \
                            and path.name != ".DS_Store":
                        _kopieren(path, stage / "agents" / "bibliothek" / folder / path.relative_to(library))
        old = ziel.parent / (".%s.alt-%s" % (ziel.name, uuid.uuid4().hex[:8]))
        if ziel.exists():
            os.replace(ziel, old)
        os.replace(stage, ziel)
        shutil.rmtree(old, ignore_errors=True)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return ziel


def _kopieren(source: Path, target: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise AutostartFehler("Laufzeitdatei fehlt: %s" % source)
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    os.chmod(target, 0o755 if os.access(source, os.X_OK) else 0o644)


def _systemctl(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    runtime = Path("/run/user/%d" % os.getuid())
    if not env.get("XDG_RUNTIME_DIR") and runtime.is_dir():
        env["XDG_RUNTIME_DIR"] = str(runtime)
    return subprocess.run(["systemctl", "--user", *args], text=True, capture_output=True, timeout=20, env=env)


def unit_pfad() -> Path:
    return Path(os.path.expanduser(os.environ.get("WB_AGENTS_UNIT_DIR") or "~/.config/systemd/user")) / UNIT


def installieren(laufzeit: Path, repo: Path, aktivieren: bool = True) -> dict[str, Any]:
    if platform.system() != "Linux":
        raise AutostartFehler("installieren gilt nur fuer Linux; auf dem Mac erzeugt plist nur eine Datei")
    ziel = laufzeit_anlegen(laufzeit, repo)
    path = unit_pfad()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomar_schreiben.schreiben(path, unit_text(ziel), modus=0o644)
    result: dict[str, Any] = {"laufzeit": str(ziel), "unit": str(path)}
    if aktivieren:
        for action in (("daemon-reload",), ("enable", UNIT)):
            done = _systemctl(*action)
            if done.returncode != 0:
                raise AutostartFehler("systemctl %s: %s" % (" ".join(action), done.stderr.strip()[:200]))
        result["aktiviert"] = _systemctl("is-enabled", UNIT).stdout.strip()
    return result


def deinstallieren() -> dict[str, Any]:
    result = {"deaktiviert": _systemctl("disable", UNIT).returncode == 0}
    path = unit_pfad()
    if path.is_file():
        path.unlink()
    _systemctl("daemon-reload")
    result["unit_entfernt"] = not path.exists()
    return result


def status() -> dict[str, Any]:
    info: dict[str, Any] = {"register": str(register_pfad()), "welten": register_lesen()["welten"],
                            "letzter_lauf": letzter_lauf(), "unit": str(unit_pfad())}
    if platform.system() == "Linux":
        info["aktiviert"] = _systemctl("is-enabled", UNIT).stdout.strip()
        info["aktiv"] = _systemctl("is-active", UNIT).stdout.strip()
    return info


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("registrieren", "abmelden"):
        sub.add_parser(name).add_argument("--konfig", required=True)
    sub.add_parser("wecken")
    sub.add_parser("status")
    p = sub.add_parser("installieren")
    p.add_argument("--laufzeit", default=str(LAUFZEIT))
    p.add_argument("--nicht-aktivieren", action="store_true")
    sub.add_parser("deinstallieren")
    p = sub.add_parser("unit")
    p.add_argument("--laufzeit", default=str(LAUFZEIT))
    p = sub.add_parser("plist")
    p.add_argument("--laufzeit", default=str(LAUFZEIT))
    p.add_argument("--ausgabe", required=True)
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    try:
        if args.command == "registrieren":
            result: Any = registrieren(args.konfig)
        elif args.command == "abmelden":
            result = abmelden(args.konfig)
        elif args.command == "wecken":
            result = wecken_alle()
        elif args.command == "status":
            result = status()
        elif args.command == "installieren":
            result = installieren(Path(os.path.expanduser(args.laufzeit)), repo, not args.nicht_aktivieren)
        elif args.command == "deinstallieren":
            result = deinstallieren()
        elif args.command == "unit":
            print(unit_text(Path(os.path.expanduser(args.laufzeit))), end="")
            return 0
        else:
            result = {"plist": str(plist_schreiben(Path(os.path.expanduser(args.laufzeit)), Path(args.ausgabe))),
                      "geladen": False}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (AutostartFehler, OSError, ValueError) as exc:
        print(json.dumps({"fehler": type(exc).__name__, "detail": str(exc)[:300]}, ensure_ascii=False), file=sys.stderr)
        return 2


__all__ = ["abmelden", "installieren", "plist_schreiben", "plist_text", "registrieren", "status", "unit_text",
           "wecken_alle"]

if __name__ == "__main__":
    raise SystemExit(main())
