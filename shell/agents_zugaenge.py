#!/usr/bin/env python3
"""Zugaenge einer Welt: die einzige Tuer eines Agentenzuges nach draussen (docs/AGENTS-TRAEGER.md,
Abschnitt "Zugaenge einer Welt").

Eine Welt kann in ``zugaenge.json`` (Weltablage, Modus 0600) benannte Zugaenge fuehren. Ein Zugang
der Art ``ssh`` nennt Ziel (``user@host`` oder einen ssh-Alias des Traegerhosts), den privaten
Schluessel und ``known_hosts`` auf dem Traegerhost, optional Port und Bash-Muster. Nur der Mensch
richtet ihn ein (``wb-welt zugang <welt> hinzufuegen ... --bestaetigt``).

Hat die Welt Zugaenge, stellt der Traeger vor jedem Claude-Zug mit Sperren im nur lesend
eingebundenen Zugordner ``<zugordner>/zugaenge/`` bereit: je Zugang eine Kopie von Schluessel und
``known_hosts`` (0600), eine ``ssh_config`` mit genau diesen Eintraegen und die Huellen ``ssh``,
``scp`` und ``rsync``, die nur ueber diese Konfiguration laufen. Der Zug bekommt Netz, die
Profil-Sperre gibt die Muster des Zugangs frei und sperrt den Ordner fuer jeden Zugriff des
Agenten. Am Zugende und bei jedem Traegerdurchgang werden die Kopien geloescht.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import agents_data as ad
import atomar_schreiben

DATEI = "zugaenge.json"
ORDNER = "zugaenge"
VERSION = 1
ARTEN = ("ssh",)
PROGRAMME = ("ssh", "scp", "rsync")
FELDER = ("name", "art", "ziel", "schluessel", "known_hosts", "port", "muster")
NAME_RE = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")
_USER = r"[A-Za-z_][A-Za-z0-9._-]{0,31}"
_HOST = r"[A-Za-z0-9][A-Za-z0-9.:-]{0,252}"
ZIEL_RE = re.compile(r"(?:(?P<user>%s)@)?(?P<host>%s)\Z" % (_USER, _HOST))
# Pfade stehen in ssh_config in Anfuehrungszeichen und in den Huellen in einfachen Anfuehrungen.
PFAD_RE = re.compile(r"/[^\x00-\x1f\"'\\]{1,1023}\Z")
SCHLUESSEL_GRENZE = 64 * 1024
KNOWN_HOSTS_GRENZE = 1024 * 1024
MUSTER_GRENZE = 16
# Die Werkzeuge liegen innerhalb der Sandbox nur unter /usr.
WERKZEUGE = {name: "/usr/bin/" + name for name in PROGRAMME}


class ZugangFehler(ad.AgentsError):
    """Abgelehnter oder nicht bereitstellbarer Zugang."""


def datei(root: Path) -> Path:
    return ad.world_path(str(root)) / DATEI


def vorgabe_muster(name: str) -> list[str]:
    # `scp *name:*` statt `scp * name:*`: auch `scp name:/datei .` (Ziel vorn) passt; ein fremdes `xname:` weist die
    # Profil-Sperre an ihrer Zielpruefung ab (gemessen am echten Zug auf peer, 15.09.2026).
    return ["ssh %s *" % name, "scp *%s:*" % name, "rsync *%s:*" % name]


def _pfad(value: Any, label: str) -> str:
    if not isinstance(value, str) or not PFAD_RE.fullmatch(value) or ".." in Path(value).parts:
        raise ZugangFehler("%s braucht einen absoluten kanonischen Pfad ohne Anfuehrungszeichen" % label)
    return value


def muster_pruefen(name: str, muster: list[str]) -> list[str]:
    """Muster eines Zugangs: Programm ssh, scp oder rsync, nennt den Zugang, besteht die Hausliste."""
    if not isinstance(muster, list) or not muster or len(muster) > MUSTER_GRENZE:
        raise ZugangFehler("Muster muessen eine Liste mit 1 bis %d Eintraegen sein" % MUSTER_GRENZE)
    module, blocked = ad._house_rules()
    result = []
    for item in muster:
        if not isinstance(item, str) or not item.strip() or "\n" in item:
            raise ZugangFehler("Muster muss ein einzeiliger Text sein")
        item = " ".join(item.split())
        words = item.split(" ")
        if words[0] not in PROGRAMME:
            raise ZugangFehler("Muster '%s' beginnt nicht mit ssh, scp oder rsync" % item)
        if words[0] == "ssh" and (len(words) < 2 or words[1] != name):
            raise ZugangFehler("ssh-Muster '%s' muss mit 'ssh %s' beginnen" % (item, name))
        if words[0] != "ssh" and "%s:" % name not in item:
            raise ZugangFehler("Muster '%s' muss das Ziel '%s:' nennen" % (item, name))
        if module.nicht_lateinischer_name(item):
            raise ZugangFehler("Muster '%s' beginnt mit einem nicht lateinischen Zeichen" % item)
        reason = module.gesperrt_verstoss(item, blocked)
        if reason:
            raise ZugangFehler("Muster '%s' ist gesperrt: %s" % (item, reason))
        if item not in result:
            result.append(item)
    return result


def normalisieren(eintrag: Any) -> dict[str, Any]:
    if not isinstance(eintrag, dict):
        raise ZugangFehler("Zugang muss ein Objekt sein")
    unknown = sorted(set(eintrag) - set(FELDER))
    if unknown:
        raise ZugangFehler("Zugang enthaelt unbekannte Felder: %s" % ", ".join(unknown))
    name = eintrag.get("name")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise ZugangFehler("Zugangsname muss aus Kleinbuchstaben, Ziffern und Bindestrich bestehen (hoechstens 40)")
    art = eintrag.get("art") or "ssh"
    if art not in ARTEN:
        raise ZugangFehler("Zugangsart muss %s sein" % ", ".join(ARTEN))
    ziel = eintrag.get("ziel")
    if not isinstance(ziel, str) or not ZIEL_RE.fullmatch(ziel):
        raise ZugangFehler("Ziel muss user@host oder ein ssh-Alias sein")
    port = eintrag.get("port")
    if port is not None and (isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536):
        raise ZugangFehler("Port muss zwischen 1 und 65535 liegen")
    schluessel = _pfad(eintrag.get("schluessel"), "Schluessel")
    known_hosts = _pfad(eintrag.get("known_hosts"), "known_hosts")
    muster = muster_pruefen(name, eintrag["muster"] if eintrag.get("muster") is not None else vorgabe_muster(name))
    result = {"name": name, "art": art, "ziel": ziel, "schluessel": schluessel, "known_hosts": known_hosts,
              "muster": muster}
    if port is not None:
        result["port"] = port
    return result


def lesen(root: Path) -> list[dict[str, Any]]:
    """Alle Zugaenge der Welt; ohne Datei eine leere Liste, eine ungueltige Datei ist ein Fehler."""
    path = datei(root)
    if path.is_symlink():
        raise ZugangFehler("zugaenge.json darf kein Symlink sein")
    if not path.exists():
        return []
    data = ad._read_json(path)
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get("zugaenge"), list):
        raise ZugangFehler("zugaenge.json hat eine unbekannte Form")
    result, names = [], set()
    for item in data["zugaenge"]:
        entry = normalisieren(item)
        if entry["name"] in names:
            raise ZugangFehler("Zugang '%s' steht doppelt in zugaenge.json" % entry["name"])
        names.add(entry["name"])
        result.append(entry)
    return result


def oeffentlich(eintraege: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Was Oberflaeche und Anweisungen sehen duerfen: Name und Art, nie Ziel oder Schluesselpfad."""
    return [{"name": item["name"], "art": item["art"]} for item in eintraege]


def _lesbare_datei(path: str, label: str, limit: int) -> None:
    try:
        info = os.stat(path)
    except OSError as exc:
        raise ZugangFehler("%s fehlt auf dem Traegerhost: %s" % (label, path)) from exc
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise ZugangFehler("%s ist keine gewoehnliche Datei passender Groesse: %s" % (label, path))
    if not os.access(path, os.R_OK):
        raise ZugangFehler("%s ist nicht lesbar: %s" % (label, path))


def _schreiben(root: Path, eintraege: list[dict[str, Any]]) -> None:
    ad._write_json(datei(root), {"version": VERSION, "zugaenge": eintraege})


def hinzufuegen(root: Path, eintrag: dict[str, Any], *, bestaetigt: bool, absender: Optional[str] = None,
                ersetzen: bool = False) -> dict[str, Any]:
    """Traegt einen Zugang ein. Rechte erweitern ist Betreibersache: ohne Bestaetigung geschieht nichts."""
    root = ad.world_path(str(root))
    if not bestaetigt:
        raise ZugangFehler("Ein Zugang erweitert die Rechte aller Agenten der Welt; --bestaetigt fehlt")
    entry = normalisieren(eintrag)
    _lesbare_datei(entry["schluessel"], "Schluessel", SCHLUESSEL_GRENZE)
    _lesbare_datei(entry["known_hosts"], "known_hosts", KNOWN_HOSTS_GRENZE)
    with ad.transaction(root):
        actor = ad._require_human(root, absender or "cli-operator", None, "Zugaenge einrichten")
        ad.read_world(root)
        current = lesen(root)
        if any(item["name"] == entry["name"] for item in current) and not ersetzen:
            raise ZugangFehler("Zugang '%s' existiert bereits; --ersetzen ueberschreibt" % entry["name"])
        updated = [item for item in current if item["name"] != entry["name"]] + [entry]
        _schreiben(root, updated)
        _meldung(root, actor["id"], "Zugang %s (%s) %s." % (entry["name"], entry["art"],
                                                            "ersetzt" if len(updated) == len(current) else "hinzugefügt"))
    return entry


def entfernen(root: Path, name: str, *, absender: Optional[str] = None) -> dict[str, Any]:
    root = ad.world_path(str(root))
    with ad.transaction(root):
        actor = ad._require_human(root, absender or "cli-operator", None, "Zugaenge entfernen")
        current = lesen(root)
        entry = next((item for item in current if item["name"] == name), None)
        if entry is None:
            raise ZugangFehler("Zugang '%s' gibt es in dieser Welt nicht" % name)
        _schreiben(root, [item for item in current if item["name"] != name])
        _meldung(root, actor["id"], "Zugang %s (%s) entfernt." % (entry["name"], entry["art"]))
    return {"name": entry["name"], "art": entry["art"], "entfernt": True}


def _meldung(root: Path, absender: str, text: str) -> None:
    """Systemmeldung im Kanal der Welt; sie weckt niemanden."""
    ad._deliver_message(root, absender, ad.WORLD_HUMAN, "kanal", "Zugang", None, text)


# Bereitstellung im Zug ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Bereitstellung:
    """Die Zugaenge eines Zuges: Ordner (Huellen, ssh_config, Kopien), Namen und die Weltdatei."""

    ordner: Path
    namen: tuple[str, ...]
    weltdatei: Path


def _ssh_g(alias: str, runner: Callable[..., Any] = subprocess.run) -> dict[str, str]:
    """Loest einen ssh-Alias auf dem Traegerhost auf: hostname, user, port."""
    result = runner([WERKZEUGE["ssh"], "-G", "--", alias], text=True, capture_output=True, timeout=10)
    if result.returncode != 0:
        raise ZugangFehler("ssh-Alias '%s' laesst sich nicht aufloesen" % alias)
    values: dict[str, str] = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition(" ")
        if key in {"hostname", "user", "port"} and key not in values:
            values[key] = value.strip()
    return values


def _ziel(entry: dict[str, Any], runner: Callable[..., Any]) -> tuple[str, str, int]:
    match = ZIEL_RE.fullmatch(entry["ziel"])
    assert match is not None
    if match.group("user"):
        host, user, port = match.group("host"), match.group("user"), entry.get("port") or 22
    else:
        resolved = _ssh_g(entry["ziel"], runner)
        host, user = resolved.get("hostname", ""), resolved.get("user", "")
        port = entry.get("port") or int(resolved.get("port") or 22)
    if not re.fullmatch(_HOST, host) or not re.fullmatch(_USER, user):
        raise ZugangFehler("Ziel von Zugang '%s' ergibt keinen gueltigen Host oder Nutzer" % entry["name"])
    return host, user, int(port)


def _huelle(programm: str, ordner: Path, namen: tuple[str, ...]) -> str:
    config = str(ordner / "ssh_config")
    head = ["#!/bin/sh",
            "# Werkbank-Zugang: %s nur ueber die Zugaenge dieses Zuges (agents_zugaenge.py)." % programm,
            "set -eu"]
    if programm == "ssh":
        # `--` vor dem Namen: ssh liest danach auch hinter dem Ziel keine Optionen mehr, alles Weitere ist der
        # entfernte Befehl (gemessen an OpenSSH 10.5: ohne `--` wirkt `ssh name -G`, mit `--` nicht; ein zweites
        # `--` hinter dem Namen landete im entfernten Befehl). So wird `ssh name -o ProxyCommand=...` nie lokal.
        return "\n".join(head + [
            'case "${1:-}" in',
            "  %s) ;;" % "|".join(namen),
            '  *) echo "ssh: unbekannter Zugang \'${1:-}\' (Zugaenge: %s)" >&2; exit 2 ;;' % ", ".join(namen),
            "esac",
            'name=$1; shift',
            '[ "$#" -gt 0 ] || { echo "ssh: Zugang braucht einen Befehl" >&2; exit 2; }',
            "exec %s -F '%s' -- \"$name\" \"$@\"" % (WERKZEUGE["ssh"], config), ""])
    if programm == "scp":
        return "\n".join(head + ["exec %s -F '%s' \"$@\"" % (WERKZEUGE["scp"], config), ""])
    return "\n".join(head + ["exec %s -e '%s -F %s' \"$@\"" % (WERKZEUGE["rsync"], WERKZEUGE["ssh"], config), ""])


def bereitstellen(root: Path, zugordner: Path, *, eintraege: Optional[list[dict[str, Any]]] = None,
                  runner: Callable[..., Any] = subprocess.run) -> Optional[Bereitstellung]:
    """Legt die Zugaenge der Welt im Zugordner an; ohne Zugaenge None und nichts auf der Platte."""
    root = ad.world_path(str(root))
    entries = lesen(root) if eintraege is None else eintraege
    aufraeumen(zugordner)
    if not entries:
        return None
    base = Path(zugordner)
    info = base.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ZugangFehler("Zugordner muss eigener privater Ordner sein")
    ordner = base / ORDNER
    try:
        ordner.mkdir(mode=0o700)
        if " " in str(ordner) or not PFAD_RE.fullmatch(str(ordner)):
            raise ZugangFehler("Zugordner-Pfad eignet sich nicht fuer ssh_config und Huellen")
        if not Path(WERKZEUGE["ssh"]).is_file():
            raise ZugangFehler("ssh fehlt auf dem Traegerhost (%s)" % WERKZEUGE["ssh"])
        config = ["# Zugaenge dieses Zuges; nur ueber die Huellen im selben Ordner benutzt.", ""]
        for entry in entries:
            host, user, port = _ziel(entry, runner)
            folder = ordner / entry["name"]
            folder.mkdir(mode=0o700)
            for source, target, label, limit in ((entry["schluessel"], "id", "Schluessel", SCHLUESSEL_GRENZE),
                                                 (entry["known_hosts"], "known_hosts", "known_hosts",
                                                  KNOWN_HOSTS_GRENZE)):
                _lesbare_datei(source, label, limit)
                atomar_schreiben.schreiben(folder / target, Path(source).read_bytes(), modus=0o600)
            config += [
                "Host %s" % entry["name"],
                "  HostName %s" % host, "  User %s" % user, "  Port %d" % port,
                '  IdentityFile "%s"' % (folder / "id"), "  IdentitiesOnly yes", "  IdentityAgent none",
                '  UserKnownHostsFile "%s"' % (folder / "known_hosts"), "  GlobalKnownHostsFile /dev/null",
                "  StrictHostKeyChecking yes", "  UpdateHostKeys no", "  BatchMode yes", "  ConnectTimeout 15",
                "  ProxyCommand none", "  ProxyJump none", "  PermitLocalCommand no", "  ControlMaster no",
                "  ForwardAgent no", "  ForwardX11 no", "  ClearAllForwardings yes", "  LogLevel ERROR", ""]
        atomar_schreiben.schreiben(ordner / "ssh_config", "\n".join(config), modus=0o600)
        namen = tuple(entry["name"] for entry in entries)
        for programm in PROGRAMME:
            if Path(WERKZEUGE[programm]).is_file():
                atomar_schreiben.schreiben(ordner / programm, _huelle(programm, ordner, namen), modus=0o700)
    except BaseException:
        aufraeumen(zugordner)
        raise
    return Bereitstellung(ordner, namen, datei(root))


def aufraeumen(zugordner: Path) -> bool:
    """Loescht die Zugangskopien eines Zuges; True, wenn etwas zu loeschen war."""
    ordner = Path(zugordner) / ORDNER
    if ordner.is_symlink():
        ordner.unlink()
        return True
    if not ordner.exists():
        return False
    shutil.rmtree(ordner)
    return True


def anweisung(namen: tuple[str, ...] | list[str]) -> list[str]:
    """Zeilen fuer Anweisungen: Zugangsnamen mit Aufruf, ohne Ziel oder Pfad."""
    lines = []
    for name in namen:
        lines.append("- Zugang `%s` (ssh): `ssh %s <befehl>`, Dateien mit `scp <datei> %s:<pfad>` oder "
                     "`rsync -a <ordner> %s:<pfad>`." % (name, name, name, name))
    return lines


# CLI ---------------------------------------------------------------------------------------------
def cli(args: Any) -> Any:
    root = Path(args.world)
    if args.aktion == "liste":
        return lesen(root)
    if args.aktion == "entfernen":
        if not args.name:
            raise ZugangFehler("--name fehlt")
        return entfernen(root, args.name, absender=args.absender)
    missing = [flag for flag, value in (("--name", args.name), ("--ziel", args.ziel), ("--schluessel", args.schluessel))
               if not value]
    if missing:
        raise ZugangFehler("Es fehlen: %s" % ", ".join(missing))
    known_hosts = args.known_hosts or str(Path(args.schluessel).parent / "known_hosts")
    entry: dict[str, Any] = {"name": args.name, "art": args.art, "ziel": args.ziel, "schluessel": args.schluessel,
                             "known_hosts": known_hosts}
    if args.port is not None:
        entry["port"] = args.port
    if args.muster:
        entry["muster"] = args.muster
    return hinzufuegen(root, entry, bestaetigt=args.bestaetigt, absender=args.absender, ersetzen=args.ersetzen)


def parser_ergaenzen(sub: Any) -> None:
    p = sub.add_parser("zugang", help="Zugaenge einer Welt nach draussen (nur der Mensch)")
    p.add_argument("world")
    p.add_argument("aktion", choices=("hinzufuegen", "entfernen", "liste"))
    p.add_argument("--name")
    p.add_argument("--art", default="ssh", choices=ARTEN)
    p.add_argument("--ziel")
    p.add_argument("--schluessel")
    p.add_argument("--known-hosts")
    p.add_argument("--port", type=int)
    p.add_argument("--muster", action="append", default=[])
    p.add_argument("--ersetzen", action="store_true")
    p.add_argument("--bestaetigt", action="store_true")
    p.add_argument("--absender", default="cli-operator")
    p.add_argument("--json", action="store_true")


__all__ = ["ARTEN", "Bereitstellung", "DATEI", "ORDNER", "PROGRAMME", "ZugangFehler", "anweisung", "aufraeumen",
           "bereitstellen", "entfernen", "hinzufuegen", "lesen", "muster_pruefen", "normalisieren", "oeffentlich",
           "vorgabe_muster"]
