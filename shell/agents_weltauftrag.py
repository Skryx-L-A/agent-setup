#!/usr/bin/env python3
"""Auftraege der Oberflaeche an eine Welt auf ihrer Maschine: lesen, finden, schreiben und wecken, anlegen, einrichten.

Plan Abschnitt 13: jede Welt hat genau eine verbindliche Ablage auf einer festgelegten Maschine; die
Oberflaeche liest und schreibt ueber diese Maschine. Der Kern (app/src/main/welten.ts und fernwelten.ts)
ruft fuer eine Welt auf einer anderen Maschine

    ssh <host> python3 <laufzeit>/agents_weltauftrag.py json

auf und schreibt den Auftrag als ein JSON-Objekt auf stdin; die Antwort ist ein JSON-Objekt auf stdout.
Die Befehlszeile der entfernten Shell traegt damit keine Nutzdaten: nichts wird fuer die entfernte Shell
gequotet, und kein Text stoesst an die Laengengrenze eines Arguments. Dateiangaben (``--datei``,
``--entwurf-datei``), die der CLI-Fernweg ablehnt, entstehen hier als temporaere Dateien auf der Maschine
der Welt.

Auftraege (Feld ``befehl``):

- ``hallo``: Maschine, Home und Python -- die Erreichbarkeitsprobe.
- ``lesen``: ``welt``, ``grenze``; die Ansicht (``agents_data.world_snapshot``), die Skills
  (``agents_skills_ansicht.skills_view``), der Traeger der Welt (``traeger.json``, laeuft seine Unit) und, wenn
  er eingerichtet ist, unter ``zug`` das Lebenszeichen je Agent aus ``agents_traeger.py status --nur-zug``
  (``agenten``, oder ``zug_fehler`` mit dem Grund).
- ``finden``: ``wurzeln``, ``projekte``, ``global`` wie ``wb-welt finden``, Pfade mit ``~``.
- ``ausfuehren``: ``skript`` (``agents_data.py`` oder ``agents_skills.py``), ``argv`` (Texte oder
  ``{"datei": inhalt}``), ``welt`` und ``wecken``. Nach Exit 0 weckt er den Traeger der Welt
  (``agents_traeger_wecken.wecken_welt``), wie ``wb-kanal``, ``wb-ticket`` und ``wb-welt`` es tun.
- ``wecken``: ``welt``; nur wecken.
- ``anlegen``: ``art`` (``projekt`` oder ``global``), ``projekt`` bzw. ``global`` (mit ``~``), ``name``,
  ``einrichten``; legt die Welt ohne Hauptagenten an und richtet den Traeger mit den Vorgaben dieser
  Maschine ein.
- ``einrichten``: ``welt``; nur den Traeger einrichten.
- ``umzug-ziel``, ``umzug-pruefen``, ``umzug-verwerfen``: die entfernten Schritte von ``wb-welt umziehen``
  (agents_weltumzug.py).

Die Vorgaben des Einrichtens stehen nur hier: Controllerzustand ``z`` und Agentenbereiche ``a`` unter
``~/.wba/<hash>/`` (mit ``WB_AGENTS_ZUSTAND`` darunter), ``<hash>`` die ersten 8 Zeichen des
Unit-Hashes (sha256 der Weltablage), Maschine ``lokal``. Der Pfad ist absichtlich kurz: der
Modell-Socket eines Zuges liegt im Zugordner, und ein Unix-Socket traegt hoechstens 107 Byte
(``kennung_hoechstens``).

Lokal fuer eine Welt dieser Maschine: ``agents_weltauftrag.py wecken <welt>`` und
``agents_weltauftrag.py einrichten --welt <ablage>``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402

HIER = Path(__file__).resolve().parent
SKRIPTE = ("agents_data.py", "agents_skills.py")
KONFIGNAME = "traeger.json"


class AuftragFehler(ValueError):
    """Ein Auftrag, der so nicht ausgefuehrt wird; der Text geht an die Oberflaeche."""


def maschine() -> str:
    return socket.gethostname().split(".")[0].lower()


def _text(job: dict[str, Any], key: str, required: bool = True) -> str:
    value = job.get(key)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise AuftragFehler("Angabe %s fehlt" % key)
    return value


def _pfad(raw: str) -> Path:
    return Path(os.path.abspath(os.path.expanduser(raw)))


def _unit_hash(world_root: Path) -> str:
    # Derselbe Hash wie agents_traeger.traeger_unit: Ablage und Unit gehoeren zusammen.
    return hashlib.sha256(str(world_root).encode("utf-8")).hexdigest()[:16]


# --- Traeger ---------------------------------------------------------------------------------

def einrichten_vorgaben(world_root: Path) -> tuple[Path, Path]:
    """(Controllerzustand, Agentenbereiche) fuer eine Welt dieser Maschine.

    Kurz, weil der Modell-Socket eines Zuges im Zugordner liegt
    (``<agenten>/<id>/state/zug-<20 hex>/model.sock``, agents_claude_lauf.py) und ein Unix-Socket
    hoechstens 107 Byte Pfad traegt. Die erste Vorgabe ``~/.local/state/werkbank-agents/traeger/<16 hex>/``
    scheiterte am 15.09.2026 auf peer beim ersten echten Zug mit ``AF_UNIX path too long``.
    """
    roh = os.environ.get("WB_AGENTS_ZUSTAND")
    base = (Path(os.path.expanduser(roh)) if roh else Path.home() / ".wba") / _unit_hash(world_root)[:8]
    return base / "z", base / "a"


# Fester Anteil hinter dem Agentenbereich: "/<id>/state/zug-<20 hex>/model.sock" ohne die Kennung.
_SOCKET_REST = len("/") + len("/state/zug-") + 20 + len("/model.sock")
_SOCKET_MAX = 107


def kennung_hoechstens(agenten: Path) -> int:
    """Wie lang eine Agentenkennung hoechstens sein darf, damit der Modell-Socket noch passt."""
    return _SOCKET_MAX - len(str(agenten)) - _SOCKET_REST


def einrichten(world_root: Path, *, ersetzen: bool = False) -> dict[str, Any]:
    """Richtet den Traeger mit den Vorgaben dieser Maschine ein; das Ergebnis nennt Konfiguration und Anmeldung."""
    import agents_traeger
    zustand, agenten = einrichten_vorgaben(world_root)
    path = agents_traeger.einrichten(world_root, zustand, agenten, maschine="lokal", ersetzen=ersetzen)
    konfig = agents_traeger.TraegerKonfig.laden(path)
    try:
        anmeldung = konfig.anmeldequelle().status()
    except Exception as exc:  # noqa: BLE001 - die Konfiguration steht; die Anmeldung zeigt sich im Zug
        anmeldung = {"fehler": str(exc)[:200]}
    raus: dict[str, Any] = {"eingerichtet": True, "konfig": str(path), "zustand": str(zustand), "agenten": str(agenten),
                            "kennung_hoechstens": kennung_hoechstens(agenten), "anmeldung": anmeldung}
    if raus["kennung_hoechstens"] < 12:
        # Nur eine Warnung: der Zug scheitert dann mit „startfehler" (AF_UNIX path too long), nicht das Einrichten.
        raus["warnung"] = "Agentenbereich %s zu lang fuer Unix-Sockets; Kennungen bis %d Zeichen (WB_AGENTS_ZUSTAND kuerzer waehlen)" % (
            agenten, raus["kennung_hoechstens"])
    return raus


def einrichten_versuchen(world_root: Path) -> dict[str, Any]:
    try:
        return einrichten(world_root)
    except Exception as exc:  # noqa: BLE001 - die Welt steht; der Grund geht in die Meldung
        return {"eingerichtet": (world_root / KONFIGNAME).is_file(), "fehler": "%s: %s" % (type(exc).__name__, str(exc)[:300])}


def traeger_stand(world_root: Path) -> dict[str, Any]:
    """Ob die Welt einen Traeger hat und ob seine Unit gerade laeuft (``None``: ohne systemd nicht feststellbar)."""
    path = world_root / KONFIGNAME
    if path.is_symlink() or not path.is_file():
        return {"eingerichtet": False, "laeuft": None}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {"eingerichtet": True, "laeuft": None, "fehler": str(exc)[:200]}
    stand: dict[str, Any] = {"eingerichtet": True, "laeuft": None, "maschine": str(data.get("maschine") or "lokal")}
    systemctl = shutil.which("systemctl")
    if systemctl and stand["maschine"] in ("lokal", maschine()):
        unit = "wb-agents-traeger-%s.service" % _unit_hash(Path(str(data.get("world_root") or world_root)))
        try:
            aktiv = subprocess.run([systemctl, "--user", "is-active", unit], text=True, capture_output=True,
                                   timeout=3).stdout.strip()
            stand["laeuft"] = aktiv in ("active", "activating", "reloading")
        except (OSError, subprocess.TimeoutExpired):
            pass
    return stand


def wecken(world_root: Path) -> dict[str, Any]:
    import agents_traeger_wecken
    try:
        return {"wecken": agents_traeger_wecken.wecken_welt(world_root)}
    except Exception as exc:  # noqa: BLE001 - das Schreiben ist schon geschehen
        return {"wecken": None, "wecken_fehler": "%s: %s" % (type(exc).__name__, str(exc)[:200])}


# --- Auftraege ---------------------------------------------------------------------------------

def hallo(_job: dict[str, Any]) -> dict[str, Any]:
    return {"maschine": maschine(), "home": str(Path.home()), "python": sys.version.split()[0], "laufzeit": str(HIER)}


def lesen(job: dict[str, Any]) -> dict[str, Any]:
    root = _pfad(_text(job, "welt"))
    grenze = job.get("grenze")
    limit = grenze if isinstance(grenze, int) and grenze > 0 else ad.SNAPSHOT_LIMIT
    ansicht = ad.world_snapshot(root, limit)
    skills: Optional[dict[str, Any]] = None
    skills_fehler = ""
    try:
        import agents_skills_ansicht
        skills = agents_skills_ansicht.skills_view(root)
    except Exception as exc:  # noqa: BLE001 - die Welt bleibt lesbar; der Grund steht bei den Skills
        skills_fehler = str(exc)[:300]
    traeger = traeger_stand(root)
    raus = {"ansicht": ansicht, "skills": skills, "skills_fehler": skills_fehler, "traeger": traeger}
    if traeger.get("eingerichtet"):
        raus["zug"] = zug_stand(root)
    return raus


def zug_stand(world_root: Path) -> dict[str, Any]:
    """Das Lebenszeichen je Agent aus ``agents_traeger.py status --nur-zug``: ein Aufruf je Lesung, nicht je Agent.

    ``agenten`` je Kennung laeuft/seit/art/zustellung_offen/wartet_seit/grund/naechster_wecker/letzter; scheitert
    der Aufruf, steht der Grund in ``zug_fehler`` und die Oberflaeche nennt den Traeger nicht erreichbar.
    Ein eigener Prozess mit Frist: der Status nimmt die Weckersperre, und ein haengender Traeger haelt das Lesen nicht auf.
    """
    try:
        done = subprocess.run([sys.executable, str(HIER / "agents_traeger.py"), "status", "--konfig", str(world_root / KONFIGNAME),
                               "--nur-zug"], text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"zug_fehler": "%s: %s" % (type(exc).__name__, str(exc)[:200])}
    try:
        data = json.loads(done.stdout) if done.returncode == 0 else None
    except ValueError:
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("agenten"), dict):
        zeile = (done.stderr.strip().splitlines() or done.stdout.strip().splitlines() or ["Exit %d" % done.returncode])[-1]
        return {"zug_fehler": zeile[:300]}
    return {"agenten": data["agenten"]}


def finden(job: dict[str, Any]) -> dict[str, Any]:
    wurzeln = [w for w in job.get("wurzeln") or [] if isinstance(w, str) and w]
    projekte = [p for p in job.get("projekte") or [] if isinstance(p, str) and p]
    global_dir = job.get("global") if isinstance(job.get("global"), str) and job.get("global") else None
    return {"maschine": maschine(), "home": str(Path.home()), "welten": ad.find_worlds(wurzeln, projekte, global_dir)}


def _argumente(roh: Any, ordner: list[str]) -> list[str]:
    if not isinstance(roh, list) or not roh:
        raise AuftragFehler("argv fehlt")
    argv: list[str] = []
    for item in roh:
        if isinstance(item, str):
            argv.append(item)
        elif isinstance(item, dict) and isinstance(item.get("datei"), str):
            if not ordner:
                ordner.append(tempfile.mkdtemp(prefix="wb-weltauftrag-"))
            fd, name = tempfile.mkstemp(dir=ordner[0], suffix=".txt")
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(item["datei"])
            prefix = item.get("vor") if isinstance(item.get("vor"), str) else ""
            argv.append(prefix + name)
        else:
            raise AuftragFehler("argv enthaelt einen ungueltigen Eintrag")
    return argv


def ausfuehren(job: dict[str, Any]) -> dict[str, Any]:
    skript = _text(job, "skript")
    if skript not in SKRIPTE:
        raise AuftragFehler("Skript %s ist nicht erlaubt" % skript)
    ordner: list[str] = []
    try:
        argv = _argumente(job.get("argv"), ordner)
        done = subprocess.run([sys.executable, str(HIER / skript), *argv], text=True, capture_output=True,
                              stdin=subprocess.DEVNULL, timeout=120)
    finally:
        if ordner:
            shutil.rmtree(ordner[0], ignore_errors=True)
    result: dict[str, Any] = {"code": done.returncode, "out": done.stdout, "err": done.stderr}
    if done.returncode == 0 and job.get("wecken") is True:
        result.update(wecken(_pfad(_text(job, "welt"))))
    return result


def anlegen(job: dict[str, Any]) -> dict[str, Any]:
    art = _text(job, "art")
    if art not in ("projekt", "global"):
        raise AuftragFehler("art ist projekt oder global")
    home = Path.home().resolve()
    name = _text(job, "name", required=False).strip()
    projekt: Optional[Path] = None
    if art == "projekt":
        roh = _text(job, "projekt")
        projekt = _pfad(roh)
        if projekt.is_symlink():
            projekt = projekt.resolve()
        if not projekt.is_dir():
            raise AuftragFehler("Den Ordner %s gibt es auf %s nicht." % (projekt, maschine()))
        if projekt in (Path("/"), home):
            raise AuftragFehler("Waehle den Ordner eines Projekts, nicht den Benutzerordner oder die Wurzel.")
        ablage = projekt / ".werkbank" / "agents"
        name = name or projekt.name
    else:
        ablage = _pfad(_text(job, "global"))
        name = "Global"
    vorhanden = (ablage / "world.json").exists()
    if not vorhanden:
        ad.create_world(ablage, name, global_world=art == "global", with_main_agent=False)
    result: dict[str, Any] = {"pfad": str(ablage), "projekt": str(projekt) if projekt else None, "name": name,
                              "vorhanden": vorhanden, "maschine": maschine()}
    if job.get("einrichten") is True:
        result["traeger"] = traeger_stand(ablage) if (ablage / KONFIGNAME).is_file() else einrichten_versuchen(ablage)
    return result


def einrichten_auftrag(job: dict[str, Any]) -> dict[str, Any]:
    root = _pfad(_text(job, "welt"))
    ad.read_world(root)
    if (root / KONFIGNAME).is_file():
        return dict(traeger_stand(root), vorhanden=True)
    return einrichten_versuchen(root)


def umzug_ziel(job: dict[str, Any]) -> dict[str, Any]:
    """Was ``wb-welt umziehen`` vor dem Kopieren auf der Zielmaschine wissen muss; mit ``eltern`` legt er den Elternordner an."""
    ziel = _pfad(_text(job, "ziel"))
    projekt = _pfad(job["projekt"]) if isinstance(job.get("projekt"), str) and job["projekt"] else None
    vorhanden = ziel.exists() or ziel.is_symlink()
    projekt_da = projekt.is_dir() if projekt else None
    if job.get("eltern") is True and not vorhanden and projekt_da is not False:
        ziel.parent.mkdir(parents=True, exist_ok=True)
    unit = "wb-agents-traeger-%s.service" % _unit_hash(ziel)
    laeuft: Optional[bool] = None
    systemctl = shutil.which("systemctl")
    if systemctl:
        try:
            laeuft = subprocess.run([systemctl, "--user", "is-active", unit], text=True, capture_output=True,
                                    timeout=3).stdout.strip() in ("active", "activating", "reloading")
        except (OSError, subprocess.TimeoutExpired):
            laeuft = None
    return {"maschine": maschine(), "home": str(Path.home()), "ziel": str(ziel), "vorhanden": vorhanden,
            "projekt": str(projekt) if projekt else None, "projekt_da": projekt_da, "traeger_laeuft": laeuft,
            "rsync": shutil.which("rsync") is not None}


def weltzahlen(root: Path) -> dict[str, Any]:
    """Was nach einer Kopie gleich sein muss: Agenten, Tickets, Fragen, Direktchats, Kanal, Postfach des Menschen."""
    snap = ad.world_snapshot(root, ad.SNAPSHOT_LIMIT)
    menschen = snap.get("humans") or {}
    return {
        "welt": (snap.get("world") or {}).get("id"),
        "agenten": sorted(a["id"] for a in snap.get("agents") or []),
        "tickets": sorted(t["id"] for t in snap.get("tickets") or []),
        "fragen": sorted(q["id"] for q in snap.get("questions") or []),
        "direktchats": sorted(c["id"] for c in snap.get("direct_chats") or []),
        "kanal": snap.get("channel_total"),
        "postfach_mensch": {k: (v.get("postbox") or {}).get("total") for k, v in sorted(menschen.items())},
    }


def umzug_pruefen(job: dict[str, Any]) -> dict[str, Any]:
    root = _pfad(_text(job, "welt"))
    erwartet = job.get("erwartet")
    if not isinstance(erwartet, dict):
        raise AuftragFehler("erwartet fehlt")
    ist = weltzahlen(root)
    abweichung = sorted(k for k in set(erwartet) | set(ist) if erwartet.get(k) != ist.get(k))
    alt = _text(job, "alter_pfad", required=False)
    mit_altem_pfad: list[str] = []
    if alt:
        needle = alt.encode("utf-8")
        for path in sorted(root.rglob("*")):
            if path.is_file() and not path.is_symlink() and path.stat().st_size < 4 * 1024 * 1024:
                try:
                    if needle in path.read_bytes():
                        mit_altem_pfad.append(str(path.relative_to(root)))
                except OSError:
                    continue
    return {"ok": not abweichung, "abweichung": abweichung, "ist": ist, "mit_altem_pfad": mit_altem_pfad[:50]}


def umzug_verwerfen(job: dict[str, Any]) -> dict[str, Any]:
    """Eine abgebrochene Kopie beiseitelegen, nie loeschen: der naechste Versuch findet das Ziel frei."""
    ziel = _pfad(_text(job, "ziel"))
    if not ziel.exists():
        return {"verworfen": None}
    import datetime as _dt
    neu = ziel.with_name("%s.abgebrochen-%s" % (ziel.name, _dt.datetime.now().strftime("%Y%m%d-%H%M%S")))
    ziel.rename(neu)
    return {"verworfen": str(neu)}


AUFTRAEGE = {
    "hallo": hallo, "lesen": lesen, "finden": finden, "ausfuehren": ausfuehren, "anlegen": anlegen,
    "einrichten": einrichten_auftrag, "wecken": lambda job: wecken(_pfad(_text(job, "welt"))),
    "umzug-ziel": umzug_ziel, "umzug-pruefen": umzug_pruefen, "umzug-verwerfen": umzug_verwerfen,
}


def auftrag(job: Any) -> tuple[int, dict[str, Any]]:
    """(Exitcode, Antwort): 0 erledigt, 1 abgelehnt mit Grund, 2 ungueltiger Auftrag."""
    if not isinstance(job, dict) or job.get("befehl") not in AUFTRAEGE:
        return 2, {"fehler": "unbekannter Auftrag; erlaubt: %s" % ", ".join(sorted(AUFTRAEGE))}
    try:
        return 0, AUFTRAEGE[job["befehl"]](job)
    except (AuftragFehler, ad.AgentsError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return 1, {"fehler": str(exc)[:400]}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("json", help="Auftrag als JSON-Objekt auf stdin")
    sub.add_parser("wecken").add_argument("welt")
    p = sub.add_parser("einrichten")
    p.add_argument("--welt", required=True)
    p.add_argument("--ersetzen", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "json":
        try:
            job = json.loads(sys.stdin.read())
        except ValueError as exc:
            code, data = 2, {"fehler": "Auftrag ist kein JSON: %s" % exc}
        else:
            code, data = auftrag(job)
    elif args.command == "wecken":
        code, data = auftrag({"befehl": "wecken", "welt": args.welt})
    else:
        try:
            root = _pfad(args.welt)
            ad.read_world(root)
            code, data = 0, einrichten(root, ersetzen=args.ersetzen)
        except Exception as exc:  # noqa: BLE001
            code, data = 1, {"fehler": "%s: %s" % (type(exc).__name__, str(exc)[:300])}
    print(json.dumps(data, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
