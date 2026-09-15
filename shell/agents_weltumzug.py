#!/usr/bin/env python3
"""wb-welt umziehen: eine Welt dieser Maschine auf eine Agent-Maschine bringen, ohne Doppelbetrieb.

    wb-welt umziehen <weltablage> <host> [--trocken] [--json]

Plan Abschnitt 13 („Beim Maschinenwechsel werden der alte Lauf und dessen Schreibberechtigung zuerst
beendet ... Ein Ausfall mitten im Wechsel darf keinen Doppelbetrieb erzeugen"). Die Ablage liegt danach
unter demselben Pfad relativ zum Home auf ``<host>`` (Mac ``~/AI/myproject/.werkbank/agents`` -> peer
``~/AI/myproject/.werkbank/agents``). Die Schritte:

1. Pruefen, hier: eine lesbare Welt unter dem Home, kein laufender Traeger, kein Ticket auf „läuft",
   niemand schreibt gerade. Dort (``agents_weltauftrag.py umzug-ziel``): Ziel frei, Projektordner da,
   kein Traeger unter dem Zielpfad, rsync vorhanden. ``--trocken`` endet hier und schreibt nichts.
2. Die Welt hier exklusiv sperren (``.agents.lock``, dieselbe Sperre wie jede Transaktion der
   Datenbibliothek), ihre Zahlen merken und die Ablage per rsync kopieren (ohne ``traeger.json``, die
   nennt Pfade dieser Maschine).
3. Dort pruefen (``umzug-pruefen``): dieselben Agenten, Tickets, Fragen, Direktchats, Kanal- und
   Postfachzahlen. Weicht etwas ab, wird die Kopie dort beiseitegelegt und hier bleibt alles, wie es war.
4. Die Ablage hier nach ``<ablage>.umgezogen-<datum>`` umbenennen (nie loeschen) und die Sperre
   loesen: ab jetzt findet ``wb-welt finden`` sie hier nicht mehr, und nichts schreibt mehr hinein.
5. Die Welt als Fernwelt der Oberflaeche eintragen (``welten-fern.json`` im Zustandsordner des Kerns).
6. Dort den Traeger einrichten (``einrichten``, Vorgaben der Zielmaschine, Autostart-Register). Geht das
   nicht, ist die Welt trotzdem umgezogen; die Ausgabe nennt den Grund und den Befehl zum Nachholen.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import fcntl
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402
import agents_weltauftrag as wa  # noqa: E402
import atomar_schreiben  # noqa: E402

HOST = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")
# Der Pfad geht als rsync-Ziel durch die entfernte Shell: nur Zeichen, die dort nichts bedeuten.
SICHER = re.compile(r"[A-Za-z0-9._+/-]+\Z")
LAUFZEIT = ".local/share/werkbank-agents/laufzeit/shell"
SPERRFRIST_S = 5.0


class UmzugFehler(RuntimeError):
    """Ein Umzug, der nicht stattfindet; der Text sagt warum."""


def register_pfad(explizit: Optional[str] = None) -> Path:
    if explizit:
        return Path(os.path.expanduser(explizit))
    if os.environ.get("AWB_WELTEN_FERN"):
        return Path(os.path.expanduser(os.environ["AWB_WELTEN_FERN"]))
    state = os.environ.get("AWB_STATE_DIR") or "~/.config/agent-workbench"
    return Path(os.path.expanduser(state)) / "welten-fern.json"


def register_lesen(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    welten = data.get("welten") if isinstance(data, dict) else None
    return [w for w in welten or [] if isinstance(w, dict) and isinstance(w.get("maschine"), str)
            and isinstance(w.get("pfad"), str)]


def registrieren(path: Path, eintrag: dict[str, Any]) -> None:
    """Traegt eine Fernwelt ein; derselbe Eintrag (Maschine und Pfad) steht danach genau einmal da."""
    welten = [w for w in register_lesen(path) if (w["maschine"], w["pfad"]) != (eintrag["maschine"], eintrag["pfad"])]
    welten.append(eintrag)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomar_schreiben.schreiben(path, json.dumps({"version": 1, "welten": welten}, ensure_ascii=False, indent=2) + "\n",
                               modus=0o600)


class Fern:
    """Ein Auftrag an ``agents_weltauftrag.py`` auf der Zielmaschine, ueber ssh mit dem Auftrag auf stdin."""

    def __init__(self, host: str, ssh: str, laufzeit: str, python: str = "python3"):
        if not SICHER.fullmatch(laufzeit) or not SICHER.fullmatch(python):
            raise UmzugFehler("Laufzeit und Python brauchen einen einfachen Pfad")
        self.host, self.ssh, self.laufzeit, self.python = host, ssh, laufzeit.rstrip("/"), python

    def optionen(self) -> list[str]:
        return ["-oBatchMode=yes", "-oConnectTimeout=8"]

    def __call__(self, job: dict[str, Any], frist_s: float = 60.0) -> dict[str, Any]:
        befehl = "%s %s/agents_weltauftrag.py json" % (self.python, self.laufzeit)
        try:
            done = subprocess.run([self.ssh, *self.optionen(), self.host, befehl], input=json.dumps(job), text=True,
                                  capture_output=True, timeout=frist_s)
        except subprocess.TimeoutExpired as exc:
            raise UmzugFehler("%s antwortete nicht in %d s (%s)" % (self.host, frist_s, job.get("befehl"))) from exc
        if done.returncode == 255:
            raise UmzugFehler("%s nicht erreichbar: %s" % (self.host, (done.stderr.strip().splitlines() or ["ssh"])[-1][:200]))
        try:
            data = json.loads(done.stdout)
        except ValueError as exc:
            zeile = (done.stderr.strip().splitlines() or done.stdout.strip().splitlines() or ["keine Ausgabe"])[-1]
            raise UmzugFehler("%s: %s (Laufzeit dort aktuell? %s)" % (self.host, zeile[:200], self.laufzeit)) from exc
        if done.returncode != 0:
            raise UmzugFehler("%s: %s" % (self.host, data.get("fehler") or "Exit %d" % done.returncode))
        return data


def _welt_finden(raw: str) -> Path:
    root = Path(os.path.abspath(os.path.expanduser(raw)))
    if not (root / "world.json").exists() and (root / ".werkbank" / "agents" / "world.json").exists():
        root = root / ".werkbank" / "agents"
    if root.is_symlink():
        raise UmzugFehler("Die Ablage %s ist ein Symlink" % root)
    return root


def _sperren(root: Path, frist_s: float) -> int:
    lock = root / ".agents.lock"
    if lock.is_symlink():
        raise UmzugFehler("Transaktionssperre darf kein Symlink sein")
    fd = os.open(str(lock), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    ende = time.monotonic() + frist_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if time.monotonic() >= ende:
                os.close(fd)
                raise UmzugFehler("In die Welt schreibt gerade jemand; nichts umgezogen. Spaeter noch einmal.") from None
            time.sleep(0.05)


def _traeger_laeuft_hier(root: Path) -> bool:
    stand = wa.traeger_stand(root)
    return stand.get("laeuft") is True


def plan(root: Path, host: str, fern: Fern, *, trocken: bool) -> dict[str, Any]:
    if not HOST.fullmatch(host):
        raise UmzugFehler("Maschine %s ist kein gueltiger ssh-Name" % host)
    welt = ad.read_world(root)
    home = Path.home().resolve()
    try:
        rel = root.resolve().relative_to(home)
    except ValueError:
        raise UmzugFehler("Die Ablage %s liegt nicht unter %s; auf %s gibt es dazu keinen gleichen Pfad" % (root, home, host)) from None
    if not SICHER.fullmatch(str(rel)) or str(rel).startswith("-"):
        raise UmzugFehler("Der Pfad %s enthaelt Zeichen, die rsync und ssh anders lesen koennten" % rel)
    projekt_rel: Optional[str] = None
    if welt.get("kind") != "global" and root.name == "agents" and root.parent.name == ".werkbank":
        projekt_rel = str(rel.parent.parent)
    laufend = [t for t in ad.world_snapshot(root, ad.SNAPSHOT_LIMIT).get("tickets") or [] if t.get("state") == "läuft"]
    if laufend:
        raise UmzugFehler("Ticket „%s“ steht auf läuft; erst abwarten oder die Welt stoppen, dann umziehen"
                          % (laufend[0].get("title") or laufend[0]["id"]))
    if _traeger_laeuft_hier(root):
        raise UmzugFehler("Der Traeger dieser Welt laeuft hier noch; erst anhalten, dann umziehen")
    ziel = fern({"befehl": "umzug-ziel", "ziel": "~/" + str(rel), "projekt": "~/" + projekt_rel if projekt_rel else None,
                 "eltern": not trocken}, frist_s=30)
    if ziel.get("vorhanden"):
        raise UmzugFehler("Auf %s gibt es %s schon; nichts umgezogen" % (host, ziel.get("ziel")))
    if ziel.get("projekt_da") is False:
        raise UmzugFehler("Den Projektordner %s gibt es auf %s nicht; erst das Projekt dorthin bringen" % (ziel.get("projekt"), host))
    if ziel.get("traeger_laeuft"):
        raise UmzugFehler("Auf %s laeuft schon ein Traeger fuer %s" % (host, ziel.get("ziel")))
    if not ziel.get("rsync"):
        raise UmzugFehler("Auf %s fehlt rsync" % host)
    return {"welt": welt.get("name"), "id": welt.get("id"), "von": str(root), "maschine": host, "rel": str(rel),
            "nach": ziel["ziel"], "projekt": ziel.get("projekt"), "fern_home": ziel.get("home"),
            "traeger_hier": (root / wa.KONFIGNAME).is_file()}


def umziehen(raw: str, host: str, *, trocken: bool = False, register: Optional[str] = None,
             ssh: Optional[str] = None, laufzeit: Optional[str] = None, ssh_host: Optional[str] = None) -> dict[str, Any]:
    """``host`` ist der Name der Maschine (Register); ``ssh_host`` ihr ssh-Name, wenn er anders heisst."""
    root = _welt_finden(raw)
    if ssh_host is not None and not HOST.fullmatch(ssh_host):
        raise UmzugFehler("ssh-Name %s ist ungueltig" % ssh_host)
    fern = Fern(ssh_host or host, ssh or os.environ.get("WB_FERN_SSH") or "ssh",
                laufzeit or os.environ.get("WB_AGENTS_FERN_SHELL") or LAUFZEIT)
    schritte = plan(root, host, fern, trocken=trocken)
    reg = register_pfad(register)
    datum = _dt.datetime.now().strftime("%Y%m%d")
    beiseite = root.with_name("%s.umgezogen-%s" % (root.name, datum))
    if beiseite.exists():
        beiseite = root.with_name("%s.umgezogen-%s" % (root.name, _dt.datetime.now().strftime("%Y%m%d-%H%M%S")))
    schritte.update(umbenannt=str(beiseite), register=str(reg))
    if trocken:
        return dict(schritte, trocken=True)
    if not shutil.which("rsync"):
        raise UmzugFehler("rsync fehlt auf dieser Maschine")
    fd = _sperren(root, SPERRFRIST_S)
    try:
        erwartet = wa.weltzahlen(root)
        rsh = " ".join(shlex.quote(x) for x in [fern.ssh, *fern.optionen()])
        kopie = subprocess.run(["rsync", "-a", "--exclude=/traeger.json", "-e", rsh, "%s/" % root,
                                "%s:%s/" % (fern.host, schritte["rel"])], text=True, capture_output=True, timeout=600)
        if kopie.returncode != 0:
            verworfen = _verwerfen(fern, schritte["nach"])
            raise UmzugFehler("rsync nach %s scheiterte (Exit %d): %s%s" % (
                host, kopie.returncode, (kopie.stderr.strip().splitlines() or [""])[-1][:200], verworfen))
        pruefung = fern({"befehl": "umzug-pruefen", "welt": schritte["nach"], "erwartet": erwartet,
                         "alter_pfad": str(root)}, frist_s=60)
        if not pruefung.get("ok"):
            verworfen = _verwerfen(fern, schritte["nach"])
            raise UmzugFehler("Die Kopie auf %s weicht ab (%s); hier bleibt alles, wie es war%s" % (
                host, ", ".join(pruefung.get("abweichung") or []), verworfen))
        root.rename(beiseite)
    finally:
        os.close(fd)
    schritte["alte_pfade"] = pruefung.get("mit_altem_pfad") or []
    registrieren(reg, {"maschine": host, "pfad": schritte["nach"], "projekt": schritte["projekt"]})
    try:
        schritte["traeger"] = fern({"befehl": "einrichten", "welt": schritte["nach"]}, frist_s=60)
    except UmzugFehler as exc:
        schritte["traeger"] = {"eingerichtet": False, "fehler": str(exc)}
    return schritte


def _verwerfen(fern: Fern, ziel: str) -> str:
    try:
        weg = fern({"befehl": "umzug-verwerfen", "ziel": ziel}, frist_s=30).get("verworfen")
    except UmzugFehler as exc:
        return "; die Kopie dort liess sich nicht beiseitelegen: %s" % exc
    return "; die Kopie dort liegt jetzt unter %s" % weg if weg else ""


def text(ergebnis: dict[str, Any]) -> str:
    if ergebnis.get("trocken"):
        return ("Trocken: %(welt)s zoege von %(von)s nach %(maschine)s:%(nach)s; die Ablage hier hiesse danach "
                "%(umbenannt)s. Nichts kopiert, nichts umbenannt." % ergebnis)
    zeilen = ["%(welt)s ist nach %(maschine)s:%(nach)s umgezogen; hier liegt sie unter %(umbenannt)s." % ergebnis]
    traeger = ergebnis.get("traeger") or {}
    if traeger.get("eingerichtet") and not traeger.get("fehler"):
        zeilen.append("Traeger dort eingerichtet.")
    else:
        zeilen.append("Traeger dort NICHT eingerichtet: %s. Nachholen: ssh %s python3 %s/agents_weltauftrag.py einrichten --welt %s"
                      % (traeger.get("fehler") or "unbekannt", ergebnis["maschine"], LAUFZEIT, ergebnis["nach"]))
    if ergebnis.get("alte_pfade"):
        zeilen.append("Dateien, die den alten Pfad nennen: %s" % ", ".join(ergebnis["alte_pfade"][:10]))
    return "\n".join(zeilen)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="wb-welt umziehen", description=__doc__.splitlines()[0])
    parser.add_argument("welt")
    parser.add_argument("maschine")
    parser.add_argument("--trocken", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--register", help="welten-fern.json des Kerns (Vorgabe: AWB_STATE_DIR)")
    parser.add_argument("--ssh")
    parser.add_argument("--laufzeit", help="Laufzeit auf der Zielmaschine, relativ zum Home")
    parser.add_argument("--ssh-host", help="ssh-Name der Maschine, wenn er nicht wie die Maschine heisst")
    args = parser.parse_args(argv)
    try:
        ergebnis = umziehen(args.welt, args.maschine, trocken=args.trocken, register=args.register, ssh=args.ssh,
                            laufzeit=args.laufzeit, ssh_host=args.ssh_host)
    except (UmzugFehler, ad.AgentsError, OSError, subprocess.TimeoutExpired) as exc:
        if args.json:
            print(json.dumps({"fehler": str(exc)}, ensure_ascii=False))
        else:
            print("wb-welt: FEHLER - %s" % exc, file=sys.stderr)
        return 2
    print(json.dumps(ergebnis, ensure_ascii=False) if args.json else text(ergebnis))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
