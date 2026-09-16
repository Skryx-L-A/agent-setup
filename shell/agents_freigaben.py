#!/usr/bin/env python3
"""Freigaben einer Welt (``freigaben.json``) und der Mail-Sendeweg der Mailkonten eines Hosts (docs/AGENTS-RECHTE.md,
Abschnitt "Freigaben einer Welt"; docs/AGENTS-PLAN.md, Abschnitt 8 Punkt 2 und Abschnitt 15).

Der Hauptagent einer Welt erhaelt vom Menschen Freigaben fuer die Absenderadressen eines Mailkontos und gibt sie an
einzelne Agenten seiner Welt weiter. Welche Konten es gibt und welche Adressen ohne Rueckfrage senden duerfen, steht
nicht im Code, sondern in der Hostkonfiguration ``mailkonten.json`` (Ordner ``AWB_STATE_DIR``, sonst
``~/.config/agent-workbench``; Form in ``mailkonten.example.json``). Fehlt die Datei oder das Konto, ist jede Erteilung
und jede Sendung ein Fehler; lesen, auflisten und widerrufen gehen weiter.

Speicher: eine eigene Datei ``freigaben.json`` in der Weltablage, geschrieben nur unter der Weltsperre von der
Datenschicht (Mensch per ``wb-welt freigabe``, Hauptagent ueber den Controller). Die Profil-Sperre fuehrt den Namen
auf der Liste der Dateien, die ein Agent nirgends schreibt. Der Rechtevertrag ``agents_rechte.py`` ist bewusst nicht
der Speicher: er bindet Grants an einen Lauf und verbraucht sie je Operation, hat keinen Authenticator im Betrieb und
waere fuer die Profil-Sperre im Zug nicht lesbar.

Jeder Eintrag gehoert genau einem Inhaber. Eine Weitergabe ist ein eigener Eintrag mit ``quelle`` (die Freigabe, aus
der er stammt) und ``kette``; gueltig ist er nur, solange seine Quelle gueltig ist und er nicht weiter reicht als
sie (Teilmenge der Adressen, gleiches Konto, Ablauf nicht spaeter).

Gesendet wird im Zug nie mit einem Passwort im Zug: das Sendewerkzeug des Kontos (``werkzeug``, Aufruf
``<werkzeug> senden``) ruft den Controller (``mail.senden``), der ausserhalb der Sandbox die Freigabe prueft, das
Passwort aus dem Schluesselbund des Traegerhosts holt, ueber SMTP sendet und die Zeile in ``mail-versand.jsonl``
schreibt. Der Mensch am Terminal sendet mit demselben Code direkt.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import smtplib
import ssl
import subprocess
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402

DATEI = "freigaben.json"
VERSANDLOG = "mail-versand.jsonl"
VERSION = 1
ARTEN = ("email",)
UMFANG_OHNE_RUECKFRAGE = "ohne_rueckfrage"
MAX_TIEFE = 4
FREIGABEN_GRENZE = 256 * 1024

# Mailkonten des Hosts (docs/AGENTS-TRAEGER.md, "Mailkonten"): Hostsache, nie im Repo. Je Konto Domaene, SMTP-Ziel,
# Anmeldename, Name des Schluesselbundeintrags, Sendewerkzeug, die Quelle des Umfangs, die Adressen „ohne Rueckfrage“
# und optional Adressen, die nie senden (``nie``), die nur ein eigener Pruefweg sendet (``rundschreiben``), sowie
# ``hinweise``: Saetze, die der Traeger unter „Mail senden“ in die Anweisung eines Agenten mit Freigabe stellt.
KONFIG_DATEI = "mailkonten.json"
KONFIG_VERSION = 1
KONFIG_GRENZE = 64 * 1024
KONTO_PFLICHT = ("domain", "smtp_host", "smtp_port", "smtp_modus", "benutzer", "schluesselbund", "werkzeug",
                 "umfang_quelle", "ohne_rueckfrage")
KONTO_OPTIONAL = ("nie", "rundschreiben", "hinweise")
SMTP_MODI = ("ssl", "starttls")
KONTONAME_RE = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")
DOMAIN_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\Z")
SCHLUESSELBUND_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
# Dieselbe Form prueft die Profil-Sperre (hooks/lib/profil_sperre.py, MAIL_WERKZEUG_RE).
WERKZEUG_RE = re.compile(r"wb-[a-z0-9][a-z0-9-]{0,39}\Z")
HINWEIS_GRENZE = 2000

ADRESSE_RE = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+\Z")
MSGID_RE = re.compile(r"<[^<>\s]{1,250}>\Z")
EMPFAENGER_GRENZE = 20
BETREFF_GRENZE = 300
TEXT_GRENZE = 48 * 1024
SMTP_ZEITLIMIT = 30.0
LOOPBACK = ("127.0.0.1", "::1", "localhost")


class FreigabeFehler(ad.AgentsError):
    """Abgelehnte Freigabe oder Weitergabe."""


class MailFehler(ad.AgentsError):
    """Abgelehnter oder gescheiterter Versand."""

    def __init__(self, text: str, abgewiesen: bool = True):
        super().__init__(text)
        self.abgewiesen = abgewiesen


# Zeit ---------------------------------------------------------------------------------------------
def _jetzt() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0)


def _text(zeit: _dt.datetime) -> str:
    return zeit.astimezone(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _zeit(wert: str) -> _dt.datetime:
    try:
        zeit = _dt.datetime.fromisoformat(wert.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise FreigabeFehler("Zeitangabe '%s' ist kein ISO-Zeitpunkt" % wert) from exc
    if zeit.tzinfo is None:
        zeit = zeit.replace(tzinfo=_dt.timezone.utc)
    return zeit


def ablauf_lesen(wert: Optional[str], jetzt: Optional[_dt.datetime] = None) -> Optional[str]:
    """Ablauf als ISO-Zeitpunkt: ``2026-12-31`` (Tagesende UTC), ``2026-12-31T18:00:00Z`` oder ``30d``/``12h``."""
    if wert is None or wert == "":
        return None
    jetzt = jetzt or _jetzt()
    if not isinstance(wert, str):
        raise FreigabeFehler("Ablauf muss ein Text sein")
    treffer = re.fullmatch(r"(\d{1,4})([dh])", wert.strip())
    if treffer:
        menge = int(treffer.group(1))
        zeit = jetzt + (_dt.timedelta(days=menge) if treffer.group(2) == "d" else _dt.timedelta(hours=menge))
    elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", wert.strip()):
        zeit = _zeit(wert.strip() + "T23:59:59Z")
    else:
        zeit = _zeit(wert.strip())
    if zeit <= jetzt:
        raise FreigabeFehler("Ablauf %s liegt nicht in der Zukunft" % _text(zeit))
    return _text(zeit)


# Datei --------------------------------------------------------------------------------------------
def datei(root: Path) -> Path:
    return ad.world_path(str(root)) / DATEI


# Mailkonten ---------------------------------------------------------------------------------------
def konfig_pfad(umgebung: Optional[dict[str, str]] = None) -> Path:
    env = umgebung if umgebung is not None else os.environ
    return Path(env.get("AWB_STATE_DIR") or "~/.config/agent-workbench").expanduser() / KONFIG_DATEI


def _pfadtext(pfad: Path) -> str:
    try:
        return "~/" + str(pfad.relative_to(Path.home()))
    except ValueError:
        return str(pfad)


def _konfig_fehler(text: str) -> FreigabeFehler:
    return FreigabeFehler("%s: %s" % (_pfadtext(konfig_pfad()), text))


def _adresse_im_konto(wert: Any, domain: str, wo: str) -> str:
    if not isinstance(wert, str) or not ADRESSE_RE.fullmatch(wert.strip()) \
            or wert.strip().lower().rpartition("@")[2] != domain:
        raise _konfig_fehler("%s braucht Adressen der Domaene %s, nicht %r" % (wo, domain, str(wert)[:80]))
    return wert.strip().lower()


def _konto_lesen(name: str, roh: Any) -> dict[str, Any]:
    if not KONTONAME_RE.fullmatch(name):
        raise _konfig_fehler("Kontoname '%s' passt nicht zu [a-z][a-z0-9-]*" % name[:40])
    if not isinstance(roh, dict):
        raise _konfig_fehler("Konto %s ist kein Objekt" % name)
    fehlend = [feld for feld in KONTO_PFLICHT if feld not in roh]
    fremd = sorted(set(roh) - set(KONTO_PFLICHT) - set(KONTO_OPTIONAL))
    if fehlend or fremd:
        raise _konfig_fehler("Konto %s: %s" % (name, "; ".join(
            (["es fehlen %s" % ", ".join(fehlend)] if fehlend else []) +
            (["unbekannte Felder %s" % ", ".join(fremd)] if fremd else []))))
    domain = roh["domain"].strip().lower() if isinstance(roh["domain"], str) else ""
    if not DOMAIN_RE.fullmatch(domain):
        raise _konfig_fehler("Konto %s: domain ist kein Domaenenname" % name)
    host = roh["smtp_host"].strip().lower() if isinstance(roh["smtp_host"], str) else ""
    if not DOMAIN_RE.fullmatch(host):
        raise _konfig_fehler("Konto %s: smtp_host ist kein Hostname" % name)
    port = roh["smtp_port"]
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65536:
        raise _konfig_fehler("Konto %s: smtp_port muss eine Zahl von 1 bis 65535 sein" % name)
    if roh["smtp_modus"] not in SMTP_MODI:
        raise _konfig_fehler("Konto %s: smtp_modus muss %s sein" % (name, " oder ".join(SMTP_MODI)))
    benutzer = roh["benutzer"]
    if not isinstance(benutzer, str) or not benutzer.strip() or len(benutzer) > 254 or re.search(r"\s", benutzer):
        raise _konfig_fehler("Konto %s: benutzer muss ein Anmeldename ohne Leerraum sein" % name)
    if not isinstance(roh["schluesselbund"], str) or not SCHLUESSELBUND_RE.fullmatch(roh["schluesselbund"]):
        raise _konfig_fehler("Konto %s: schluesselbund muss der Name eines Schluesselbundeintrags sein" % name)
    if not isinstance(roh["werkzeug"], str) or not WERKZEUG_RE.fullmatch(roh["werkzeug"]):
        raise _konfig_fehler("Konto %s: werkzeug muss wb-<name> sein" % name)
    if not isinstance(roh["umfang_quelle"], str) or not roh["umfang_quelle"].strip() \
            or len(roh["umfang_quelle"]) > 500:
        raise _konfig_fehler("Konto %s: umfang_quelle muss ein Text bis 500 Zeichen sein" % name)
    if not isinstance(roh["ohne_rueckfrage"], list) or not roh["ohne_rueckfrage"]:
        raise _konfig_fehler("Konto %s: ohne_rueckfrage muss eine nichtleere Liste sein" % name)
    ohne = list(dict.fromkeys(_adresse_im_konto(a, domain, "ohne_rueckfrage") for a in roh["ohne_rueckfrage"]))
    sperren: dict[str, dict[str, str]] = {}
    for feld in ("nie", "rundschreiben"):
        wert = roh.get(feld, {})
        if not isinstance(wert, dict) or not all(isinstance(g, str) and g.strip() and len(g) <= HINWEIS_GRENZE
                                                 for g in wert.values()):
            raise _konfig_fehler("Konto %s: %s muss Adressen auf einen Grund abbilden" % (name, feld))
        sperren[feld] = {_adresse_im_konto(a, domain, feld): g.strip() for a, g in wert.items()}
        doppelt = set(sperren[feld]) & set(ohne)
        if doppelt:
            raise _konfig_fehler("Konto %s: %s steht zugleich in ohne_rueckfrage und %s" % (
                name, ", ".join(sorted(doppelt)), feld))
    hinweise = roh.get("hinweise", [])
    if not isinstance(hinweise, list) or not all(isinstance(h, str) and h.strip() and len(h) <= HINWEIS_GRENZE
                                                 for h in hinweise):
        raise _konfig_fehler("Konto %s: hinweise muss eine Liste von Saetzen sein" % name)
    return {"name": name, "domain": domain, "smtp_host": host, "smtp_port": port, "smtp_modus": roh["smtp_modus"],
            "benutzer": benutzer, "schluesselbund": roh["schluesselbund"], "werkzeug": roh["werkzeug"],
            "umfang_quelle": roh["umfang_quelle"].strip(), "ohne_rueckfrage": ohne, "nie": sperren["nie"],
            "rundschreiben": sperren["rundschreiben"], "hinweise": [h.strip() for h in hinweise]}


def konten() -> dict[str, dict[str, Any]]:
    """Alle Mailkonten dieses Hosts; ohne Datei ein leeres dict, eine kaputte Datei ist ein Fehler."""
    pfad = konfig_pfad()
    try:
        with open(pfad, "rb") as stream:
            roh = stream.read(KONFIG_GRENZE + 1)
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise _konfig_fehler("nicht lesbar (%s)" % type(exc).__name__) from None
    if len(roh) > KONFIG_GRENZE:
        raise _konfig_fehler("groesser als %d Bytes" % KONFIG_GRENZE)
    try:
        daten = json.loads(roh.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise _konfig_fehler("kein JSON (%s)" % type(exc).__name__) from None
    if not isinstance(daten, dict) or set(daten) != {"version", "konten"} or daten["version"] != KONFIG_VERSION \
            or not isinstance(daten["konten"], dict):
        raise _konfig_fehler('Form muss {"version": 1, "konten": {…}} sein')
    result = {name: _konto_lesen(name, roh_konto) for name, roh_konto in daten["konten"].items()}
    domains = [item["domain"] for item in result.values()]
    werkzeuge = [item["werkzeug"] for item in result.values()]
    if len(set(domains)) != len(domains) or len(set(werkzeuge)) != len(werkzeuge):
        raise _konfig_fehler("zwei Konten teilen eine Domaene oder ein Werkzeug")
    return result


def nicht_eingerichtet(name: Any) -> str:
    return "Mailkonto %s ist auf diesem Host nicht eingerichtet: %s" % (str(name)[:40], _pfadtext(konfig_pfad()))


def konto(name: Any) -> dict[str, Any]:
    """Ein eingerichtetes Konto; sonst FreigabeFehler mit Pfad der Hostkonfiguration."""
    alle = konten()
    if not isinstance(name, str) or name not in alle:
        raise FreigabeFehler(nicht_eingerichtet(name))
    return alle[name]


def konto_fuer_werkzeug(werkzeug: str) -> str:
    """Name des Kontos, dessen Sendewerkzeug ``werkzeug`` ist (fuer den Menschen am Terminal)."""
    try:
        alle = konten()
    except FreigabeFehler as exc:
        raise MailFehler(str(exc), abgewiesen=False) from None
    for name, daten in alle.items():
        if daten["werkzeug"] == werkzeug:
            return name
    raise MailFehler("Kein Mailkonto mit Werkzeug %s ist auf diesem Host eingerichtet: %s" % (
        werkzeug, _pfadtext(konfig_pfad())), abgewiesen=False)


def adressen_pruefen(konto_name: str, adressen: Iterable[Any], daten: Optional[dict[str, Any]] = None) -> list[str]:
    """Absenderadressen einer Freigabe: nur Adressen des Kontos mit Umfang „ohne Rueckfrage", jede einmal."""
    daten = daten if daten is not None else konto(konto_name)
    result: list[str] = []
    for roh in adressen:
        if not isinstance(roh, str) or not roh.strip():
            raise FreigabeFehler("Adresse muss ein nichtleerer Text sein")
        adresse = roh.strip().lower()
        if adresse in daten["nie"]:
            raise FreigabeFehler(daten["nie"][adresse])
        if adresse in daten["rundschreiben"]:
            raise FreigabeFehler(daten["rundschreiben"][adresse])
        if adresse not in daten["ohne_rueckfrage"]:
            raise FreigabeFehler("Adresse '%s' hat keinen Umfang „ohne Rückfrage“ fuer Konto %s (erlaubt: %s)"
                                 % (adresse, konto_name, ", ".join(daten["ohne_rueckfrage"])))
        if adresse not in result:
            result.append(adresse)
    if not result:
        raise FreigabeFehler("Eine Freigabe braucht mindestens eine Absenderadresse")
    return result


def _eintrag_pruefen(eintrag: Any) -> dict[str, Any]:
    # Nur die Form: ob eine Adresse (noch) ohne Rueckfrage sendet, entscheidet die Hostkonfiguration bei Erteilung und
    # Versand. So bleiben Freigaben lesbar und widerrufbar, auch wenn ein Konto auf diesem Host fehlt.
    felder = {"id", "art", "konto", "werkzeug", "inhaber", "adressen", "umfang_quelle", "erteilt_von", "ablauf",
              "quelle", "kette", "zeit", "widerrufen"}
    if not isinstance(eintrag, dict) or set(eintrag) - felder:
        raise FreigabeFehler("freigaben.json enthaelt einen Eintrag unbekannter Form")
    ad.valid_id(str(eintrag.get("id")), "Freigabekennung")
    if eintrag.get("art") not in ARTEN:
        raise FreigabeFehler("Freigabeart muss %s sein" % ", ".join(ARTEN))
    if not isinstance(eintrag.get("konto"), str) or not KONTONAME_RE.fullmatch(eintrag["konto"]):
        raise FreigabeFehler("Konto einer Freigabe hat eine unbekannte Form")
    if eintrag.get("werkzeug") is not None and (not isinstance(eintrag["werkzeug"], str)
                                                or not WERKZEUG_RE.fullmatch(eintrag["werkzeug"])):
        raise FreigabeFehler("Werkzeug einer Freigabe hat eine unbekannte Form")
    ad.valid_id(str(eintrag.get("inhaber")), "Inhaber")
    adressen = eintrag.get("adressen")
    if not isinstance(adressen, list) or not adressen or not all(
            isinstance(a, dict) and set(a) == {"adresse", "umfang"} and a["umfang"] == UMFANG_OHNE_RUECKFRAGE
            and isinstance(a["adresse"], str) and ADRESSE_RE.fullmatch(a["adresse"]) for a in adressen):
        raise FreigabeFehler("adressen einer Freigabe haben eine unbekannte Form")
    von = eintrag.get("erteilt_von")
    if not isinstance(von, dict) or von.get("art") not in ("mensch", "agent") or not isinstance(von.get("id"), str):
        raise FreigabeFehler("erteilt_von einer Freigabe hat eine unbekannte Form")
    if (von["art"] == "mensch") != (eintrag.get("quelle") is None):
        raise FreigabeFehler("Nur eine Weitergabe durch einen Agenten hat eine Quelle")
    for feld in ("ablauf", "zeit"):
        if eintrag.get(feld) is not None:
            _zeit(eintrag[feld])
    return eintrag


def lesen(root: Path) -> list[dict[str, Any]]:
    """Alle Eintraege, auch widerrufene und abgelaufene; ohne Datei eine leere Liste."""
    path = datei(root)
    if path.is_symlink():
        raise FreigabeFehler("freigaben.json darf kein Symlink sein")
    if not path.exists():
        return []
    data = ad._read_json(path)
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get("freigaben"), list):
        raise FreigabeFehler("freigaben.json hat eine unbekannte Form")
    eintraege = [_eintrag_pruefen(item) for item in data["freigaben"]]
    if len({item["id"] for item in eintraege}) != len(eintraege):
        raise FreigabeFehler("freigaben.json enthaelt eine Kennung doppelt")
    return eintraege


def _schreiben(root: Path, eintraege: list[dict[str, Any]]) -> None:
    ad._write_json(datei(root), {"version": VERSION, "freigaben": eintraege})


# Gueltigkeit --------------------------------------------------------------------------------------
def _adressliste(eintrag: dict[str, Any]) -> list[str]:
    return [item["adresse"] for item in eintrag["adressen"]]


def gueltig(eintraege: list[dict[str, Any]], eintrag: dict[str, Any], jetzt: Optional[_dt.datetime] = None,
            root: Optional[Path] = None, _tiefe: int = 0) -> bool:
    """Nicht widerrufen, nicht abgelaufen, und eine Weitergabe nur, solange ihre Quelle gilt und sie nicht weiter
    reicht als die Quelle. Mit ``root`` muss der Weitergebende noch Hauptagent der Welt sein."""
    jetzt = jetzt or _jetzt()
    if _tiefe > MAX_TIEFE or eintrag.get("widerrufen"):
        return False
    if eintrag.get("ablauf") and _zeit(eintrag["ablauf"]) <= jetzt:
        return False
    quelle_id = eintrag.get("quelle")
    if quelle_id is None:
        return eintrag["erteilt_von"]["art"] == "mensch"
    quelle = next((item for item in eintraege if item["id"] == quelle_id), None)
    if quelle is None or quelle["inhaber"] != eintrag["erteilt_von"]["id"]:
        return False
    if (quelle["art"], quelle["konto"], quelle.get("werkzeug")) != (eintrag["art"], eintrag["konto"],
                                                                     eintrag.get("werkzeug")):
        return False
    if not set(_adressliste(eintrag)) <= set(_adressliste(quelle)):
        return False
    if quelle.get("ablauf") and (not eintrag.get("ablauf") or _zeit(eintrag["ablauf"]) > _zeit(quelle["ablauf"])):
        return False
    if root is not None:
        try:
            if ad.read_agent(root, eintrag["erteilt_von"]["id"]).get("stage") != "hauptagent":
                return False
        except ad.AgentsError:
            return False
    return gueltig(eintraege, quelle, jetzt, root, _tiefe + 1)


def gueltige(root: Path, agent_id: str, art: str = "email", konto: Optional[str] = None,
             jetzt: Optional[_dt.datetime] = None, eintraege: Optional[list[dict[str, Any]]] = None
             ) -> list[dict[str, Any]]:
    """Gueltige Freigaben eines Agenten fuer Art (und Konto)."""
    root = ad.world_path(str(root))
    eintraege = lesen(root) if eintraege is None else eintraege
    return [item for item in eintraege if item["inhaber"] == agent_id and item["art"] == art
            and (konto is None or item["konto"] == konto) and gueltig(eintraege, item, jetzt, root)]


def adressen_von(freigaben: Iterable[dict[str, Any]]) -> list[str]:
    result: list[str] = []
    for item in freigaben:
        for adresse in _adressliste(item):
            if adresse not in result:
                result.append(adresse)
    return result


def _ansicht(eintraege: list[dict[str, Any]], root: Path, jetzt: Optional[_dt.datetime] = None
             ) -> list[dict[str, Any]]:
    return [dict(item, gueltig=gueltig(eintraege, item, jetzt, root)) for item in eintraege]


def _widerrufen(eintraege: list[dict[str, Any]], ziel: dict[str, Any], von: dict[str, Any], grund: str,
                zeit: str) -> list[str]:
    """Markiert den Eintrag und alle aus ihm weitergegebenen als widerrufen; liefert die Kennungen."""
    betroffen = []
    offen = [(ziel, grund)]
    while offen:
        eintrag, text = offen.pop(0)
        if eintrag.get("widerrufen"):
            continue
        eintrag["widerrufen"] = {"von": von, "zeit": zeit, "grund": text}
        betroffen.append(eintrag["id"])
        offen += [(item, "Quelle %s widerrufen" % eintrag["id"]) for item in eintraege
                  if item.get("quelle") == eintrag["id"]]
    return betroffen


def _verlauf(root: Path, agent_id: str, ereignis: str, actor: dict[str, Any], **extra: Any) -> None:
    ad._append_history(root, agent_id, dict({"id": ad.new_id("h"), "time": ad.now(), "event": ereignis,
                                             "actor": actor}, **extra))


def _kanal(root: Path, absender: str, text: str) -> None:
    """Systemmeldung im Kanal der Welt; sie weckt niemanden."""
    ad._deliver_message(root, absender, ad.WORLD_HUMAN, "kanal", "Freigabe", None, text)


# Mensch -------------------------------------------------------------------------------------------
def mensch_messen(runner: Callable[..., Any] = subprocess.run) -> tuple[str, str]:
    """Herkunft des Aufrufers ueber wb-mensch (wie wb-freigabe): ("mensch"|"agent", Begruendung)."""
    kandidat = Path.home() / ".local" / "bin" / "wb-mensch"
    programm = str(kandidat) if os.access(kandidat, os.X_OK) else shutil.which("wb-mensch")
    if not programm:
        return "agent", "wb-mensch nicht gefunden — ohne Messung gilt: kein Mensch."
    try:
        ergebnis = runner([programm, "beleg"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        return "agent", "wb-mensch nicht ausfuehrbar (%s)" % type(exc).__name__
    zeile = (ergebnis.stdout or "").strip().splitlines()[-1:] or [""]
    art, _, grund = zeile[0].partition("\t")
    return ("mensch" if art == "mensch" else "agent"), grund.strip()[:300]


def _beleg(bestaetigt: bool, wortlaut: Optional[str], messung: Optional[tuple[str, str]]) -> dict[str, Any]:
    if not bestaetigt:
        raise FreigabeFehler("Eine Freigabe erweitert die Rechte eines Agenten; --bestaetigt fehlt")
    art, grund = messung if messung is not None else mensch_messen()
    if art == "mensch":
        beleg: dict[str, Any] = {"art": "wb-mensch", "grund": grund}
        if wortlaut:
            beleg["wortlaut"] = wortlaut.strip()[:2000]
        return beleg
    if not isinstance(wortlaut, str) or not wortlaut.strip():
        raise FreigabeFehler("wb-mensch belegt keinen Menschen (%s); ohne diese Messung braucht die Freigabe "
                             "--bestaetigt und --beleg mit dem Wortlaut der Entscheidung" % grund)
    return {"art": "bestaetigt", "wortlaut": wortlaut.strip()[:2000], "wb_mensch": grund}


def erteilen(root: Path, agenten: list[str], art: str, konto_name: str, adressen: list[str], *,
             ablauf: Optional[str] = None, bestaetigt: bool = False, wortlaut: Optional[str] = None,
             absender: Optional[str] = None, messung: Optional[tuple[str, str]] = None) -> list[dict[str, Any]]:
    """Der Mensch erteilt je Agent eine Freigabe; eine bestehende Freigabe des Menschen fuer dasselbe Konto wird
    ersetzt (samt ihren Weitergaben), eine gleiche bleibt unveraendert."""
    root = ad.world_path(str(root))
    if art not in ARTEN:
        raise FreigabeFehler("Freigabeart muss %s sein" % ", ".join(ARTEN))
    daten = konto(konto_name)
    adressen = adressen_pruefen(konto_name, adressen, daten)
    if not agenten:
        raise FreigabeFehler("--an nennt keinen Agenten")
    beleg = _beleg(bestaetigt, wortlaut, messung)
    ergebnis = []
    with ad.transaction(root):
        actor = ad._require_human(root, absender or "cli-operator", None, "Freigaben erteilen")
        ad.read_world(root)
        eintraege = lesen(root)
        zeit = ad.now()
        ablauf_text = ablauf_lesen(ablauf)
        for agent_id in dict.fromkeys(agenten):
            ad.read_agent(root, agent_id)
            bestehend = [item for item in eintraege if item["inhaber"] == agent_id and item["art"] == art
                         and item["konto"] == konto_name and item["quelle"] is None and not item.get("widerrufen")]
            gleich = next((item for item in bestehend if _adressliste(item) == adressen
                           and item.get("ablauf") == ablauf_text and item.get("werkzeug") == daten["werkzeug"]
                           and item.get("umfang_quelle") == daten["umfang_quelle"]
                           and gueltig(eintraege, item, root=root)), None)
            if gleich is not None and len(bestehend) == 1:
                ergebnis.append(gleich)
                continue
            neu = {"id": ad.new_id("fg"), "art": art, "konto": konto_name, "werkzeug": daten["werkzeug"],
                   "inhaber": agent_id,
                   "adressen": [{"adresse": a, "umfang": UMFANG_OHNE_RUECKFRAGE} for a in adressen],
                   "umfang_quelle": daten["umfang_quelle"],
                   "erteilt_von": {"art": "mensch", "id": actor["id"], "beleg": beleg, "zeit": zeit},
                   "ablauf": ablauf_text, "quelle": None, "kette": ["mensch:%s" % actor["id"], agent_id],
                   "zeit": zeit, "widerrufen": None}
            ersetzt = []
            for alt in bestehend:
                ersetzt += _widerrufen(eintraege, alt, {"art": "mensch", "id": actor["id"]},
                                       "ersetzt durch %s" % neu["id"], zeit)
            eintraege.append(neu)
            _schreiben(root, eintraege)
            _verlauf(root, agent_id, "freigabe-erteilt", actor, freigabe=neu["id"], art=art, konto=konto_name,
                     adressen=adressen, ablauf=ablauf_text, ersetzt=ersetzt)
            _kanal(root, actor["id"], "Freigabe %s (%s) für %s erteilt: %s%s." % (
                art, konto_name, agent_id, ", ".join(adressen), ", bis %s" % ablauf_text if ablauf_text else ""))
            ergebnis.append(neu)
    return ergebnis


def widerrufen(root: Path, *, freigabe_id: Optional[str] = None, agent_id: Optional[str] = None,
               art: Optional[str] = None, grund: Optional[str] = None, absender: Optional[str] = None
               ) -> list[str]:
    """Der Mensch widerruft eine Freigabe (Kennung) oder alle eines Agenten (optional je Art), Weitergaben mit."""
    root = ad.world_path(str(root))
    if not freigabe_id and not agent_id:
        raise FreigabeFehler("Widerruf braucht --id oder --an")
    with ad.transaction(root):
        actor = ad._require_human(root, absender or "cli-operator", None, "Freigaben widerrufen")
        eintraege = lesen(root)
        ziele = [item for item in eintraege if not item.get("widerrufen")
                 and (freigabe_id is None or item["id"] == freigabe_id)
                 and (agent_id is None or item["inhaber"] == agent_id)
                 and (art is None or item["art"] == art)]
        if not ziele:
            raise FreigabeFehler("Keine offene Freigabe passt")
        zeit, betroffen = ad.now(), []
        for ziel in ziele:
            betroffen += _widerrufen(eintraege, ziel, {"art": "mensch", "id": actor["id"]},
                                     (grund or "widerrufen durch den Menschen").strip()[:300], zeit)
        _schreiben(root, eintraege)
        for item in eintraege:
            if item["id"] in betroffen:
                _verlauf(root, item["inhaber"], "freigabe-widerrufen", actor, freigabe=item["id"], art=item["art"],
                         konto=item["konto"], grund=item["widerrufen"]["grund"])
        _kanal(root, actor["id"], "Freigabe widerrufen: %s." % ", ".join(betroffen))
    return betroffen


# Hauptagent ---------------------------------------------------------------------------------------
def _hauptagent(root: Path, sender: str, rolle: Optional[str], was: str) -> dict[str, Any]:
    actor = ad._actor(root, sender, rolle)
    if actor.get("kind") != "agent":
        raise FreigabeFehler("%s ist der Dienstweg des Hauptagenten; der Mensch nutzt `wb-welt freigabe`" % was)
    if actor.get("role") != "hauptagent":
        raise FreigabeFehler("%s darf nur der Hauptagent der Welt; ein %s fragt ihn" % (
            was, ad._STAGE_WORDS.get(actor.get("role"), actor.get("role"))))
    return actor


def weitergeben(root: Path, sender: str, rolle: Optional[str], agent_id: str, art: str,
                adressen: Optional[list[str]] = None, ablauf: Optional[str] = None) -> dict[str, Any]:
    """Der Hauptagent gibt einem Agenten seiner Welt eine Freigabe, die er selbst haelt, nie weiter als die eigene.

    Rueckgabe: der Eintrag, dazu ``ersetzt`` (Kennungen) und ``neu`` (False, wenn eine gleiche schon bestand)."""
    root = ad.world_path(str(root))
    if art not in ARTEN:
        raise FreigabeFehler("Freigabeart muss %s sein" % ", ".join(ARTEN))
    with ad.transaction(root):
        actor = _hauptagent(root, sender, rolle, "Freigaben weitergeben")
        ad.valid_id(agent_id, "Agentenkennung")
        if agent_id == actor["id"]:
            raise FreigabeFehler("Der Hauptagent gibt sich keine Freigabe selbst; das tut der Mensch")
        ad.read_agent(root, agent_id)
        eintraege = lesen(root)
        jetzt = _jetzt()
        eigene = [item for item in gueltige(root, actor["id"], art, None, jetzt, eintraege)]
        if not eigene:
            raise FreigabeFehler("Du haeltst keine gueltige Freigabe %s; weitergeben kannst du nur eine eigene" % art)
        ablauf_text = ablauf_lesen(ablauf, jetzt)
        passend, fehler = [], []
        for quelle in eigene:
            # Weitergeben ist eine Erteilung: das Konto muss auf diesem Host eingerichtet sein, und die Adressen
            # muessen dort (noch) ohne Rueckfrage senden.
            try:
                daten = konto(quelle["konto"])
                gewuenscht = adressen_pruefen(quelle["konto"], adressen, daten) if adressen is not None \
                    else [a for a in _adressliste(quelle) if a in daten["ohne_rueckfrage"]]
            except FreigabeFehler as exc:
                fehler.append(exc)
                continue
            if not gewuenscht or not set(gewuenscht) <= set(_adressliste(quelle)):
                continue
            ziel_ablauf = ablauf_text if ablauf_text is not None else quelle.get("ablauf")
            if quelle.get("ablauf") and (ziel_ablauf is None or _zeit(ziel_ablauf) > _zeit(quelle["ablauf"])):
                continue
            passend.append((quelle, gewuenscht, ziel_ablauf))
        if not passend and fehler and len(fehler) == len(eigene):
            raise fehler[0]
        if not passend:
            raise FreigabeFehler("Nie weiter als die eigene Freigabe: deine Adressen sind %s%s" % (
                ", ".join(adressen_von(eigene)), "".join(
                    ", Ablauf %s" % item["ablauf"] for item in eigene if item.get("ablauf"))))
        # Die Quelle mit dem spaetesten Ablauf traegt am laengsten.
        quelle, gewuenscht, ziel_ablauf = max(passend, key=lambda p: _zeit(p[0]["ablauf"]) if p[0].get("ablauf")
                                              else _dt.datetime.max.replace(tzinfo=_dt.timezone.utc))
        bestehend = [item for item in eintraege if item["inhaber"] == agent_id and item["art"] == art
                     and item["konto"] == quelle["konto"] and item["erteilt_von"]["art"] == "agent"
                     and item["erteilt_von"]["id"] == actor["id"] and not item.get("widerrufen")]
        gleich = next((item for item in bestehend if item["quelle"] == quelle["id"]
                       and _adressliste(item) == gewuenscht and item.get("ablauf") == ziel_ablauf), None)
        if gleich is not None and len(bestehend) == 1:
            return dict(gleich, ersetzt=[], neu=False)
        zeit = ad.now()
        neu = {"id": ad.new_id("fg"), "art": art, "konto": quelle["konto"], "werkzeug": quelle.get("werkzeug"),
               "inhaber": agent_id,
               "adressen": [{"adresse": a, "umfang": UMFANG_OHNE_RUECKFRAGE} for a in gewuenscht],
               "umfang_quelle": quelle.get("umfang_quelle"), "erteilt_von": {"art": "agent", "id": actor["id"], "zeit": zeit},
               "ablauf": ziel_ablauf, "quelle": quelle["id"], "kette": list(quelle.get("kette") or []) + [agent_id],
               "zeit": zeit, "widerrufen": None}
        ersetzt = []
        for alt in bestehend:
            ersetzt += _widerrufen(eintraege, alt, {"art": "agent", "id": actor["id"]}, "ersetzt durch %s" % neu["id"],
                                   zeit)
        eintraege.append(neu)
        _schreiben(root, eintraege)
        _verlauf(root, agent_id, "freigabe-weitergegeben", actor, freigabe=neu["id"], quelle=quelle["id"], art=art,
                 konto=neu["konto"], adressen=gewuenscht, ablauf=ziel_ablauf, ersetzt=ersetzt)
        return dict(neu, ersetzt=ersetzt, neu=True)


def entziehen(root: Path, sender: str, rolle: Optional[str], agent_id: str, art: str) -> list[str]:
    """Der Hauptagent nimmt einem Agenten die Freigaben, die er ihm weitergegeben hat."""
    root = ad.world_path(str(root))
    if art not in ARTEN:
        raise FreigabeFehler("Freigabeart muss %s sein" % ", ".join(ARTEN))
    with ad.transaction(root):
        actor = _hauptagent(root, sender, rolle, "Freigaben entziehen")
        eintraege = lesen(root)
        ziele = [item for item in eintraege if item["inhaber"] == agent_id and item["art"] == art
                 and item["erteilt_von"]["art"] == "agent" and item["erteilt_von"]["id"] == actor["id"]
                 and not item.get("widerrufen")]
        if not ziele:
            raise FreigabeFehler("%s haelt keine von dir weitergegebene Freigabe %s; Freigaben des Menschen "
                                 "widerruft nur er" % (agent_id, art))
        zeit, betroffen = ad.now(), []
        for ziel in ziele:
            betroffen += _widerrufen(eintraege, ziel, {"art": "agent", "id": actor["id"]},
                                     "entzogen durch %s" % actor["id"], zeit)
        _schreiben(root, eintraege)
        for item in eintraege:
            if item["id"] in betroffen:
                _verlauf(root, item["inhaber"], "freigabe-entzogen", actor, freigabe=item["id"], art=item["art"],
                         konto=item["konto"], grund=item["widerrufen"]["grund"])
    return betroffen


def liste(root: Path, sender: Optional[str] = None, rolle: Optional[str] = None,
          jetzt: Optional[_dt.datetime] = None) -> list[dict[str, Any]]:
    """Alle Freigaben der Welt mit ``gueltig``; ueber den Dienstweg nur fuer den Hauptagenten."""
    root = ad.world_path(str(root))
    if sender is not None:
        _hauptagent(root, sender, rolle, "Freigaben auflisten")
    return _ansicht(lesen(root), root, jetzt)


def zusammenfassung(eintrag: dict[str, Any]) -> str:
    return "Freigabe %s (%s): %s%s" % (eintrag["art"], eintrag["konto"], ", ".join(_adressliste(eintrag)),
                                      ", bis %s" % eintrag["ablauf"] if eintrag.get("ablauf") else ", ohne Ablauf")


# Senden -------------------------------------------------------------------------------------------
def _mailkonten() -> dict[str, dict[str, Any]]:
    try:
        return konten()
    except FreigabeFehler as exc:
        raise MailFehler(str(exc), abgewiesen=False) from None


def _mailkonto(name: str) -> dict[str, Any]:
    alle = _mailkonten()
    if name not in alle:
        raise MailFehler(nicht_eingerichtet(name), abgewiesen=False)
    return alle[name]


def konto_fuer(von: str, alle: Optional[dict[str, dict[str, Any]]] = None) -> str:
    alle = _mailkonten() if alle is None else alle
    domain = von.rpartition("@")[2]
    for name, daten in alle.items():
        if daten["domain"] == domain:
            return name
    if not alle:
        raise MailFehler("Kein Mailkonto ist auf diesem Host eingerichtet: %s" % _pfadtext(konfig_pfad()),
                         abgewiesen=False)
    raise MailFehler("Absender '%s' gehoert zu keinem Konto mit Sendeweg (%s)" % (
        von, ", ".join("@" + d["domain"] for d in alle.values())))


def absender_pruefen(von: Any, erlaubt: Optional[Iterable[str]], konto_name: Optional[str] = None,
                     freigaben: Optional[list[dict[str, Any]]] = None) -> tuple[str, str, dict[str, Any]]:
    """(Adresse, Konto, Kontodaten). ``erlaubt`` None heisst: der Mensch, ohne Freigabezwang, aber mit den festen
    Sperren. Das Konto ist ``konto_name``, sonst das der Freigabe mit der Domaene des Absenders, sonst das der Domaene."""
    if not isinstance(von, str) or not ADRESSE_RE.fullmatch(von.strip()):
        raise MailFehler("--von braucht eine Mailadresse")
    von = von.strip().lower()
    domain = von.rpartition("@")[2]
    alle = _mailkonten()
    if konto_name is None and freigaben:
        konto_name = next((item["konto"] for item in freigaben
                           if any(a.rpartition("@")[2] == domain for a in _adressliste(item))), None)
    if konto_name is None:
        konto_name = konto_fuer(von, alle)
    elif konto_name not in alle:
        raise MailFehler(nicht_eingerichtet(konto_name), abgewiesen=False)
    daten = alle[konto_name]
    if daten["domain"] != domain:
        raise MailFehler("Absender '%s' gehoert nicht zum Konto %s (@%s)" % (von, konto_name, daten["domain"]))
    if von in daten["nie"]:
        raise MailFehler(daten["nie"][von])
    if von in daten["rundschreiben"]:
        raise MailFehler(daten["rundschreiben"][von])
    if erlaubt is not None:
        erlaubt = list(erlaubt)
        if von not in erlaubt:
            raise MailFehler("Absender %s steht nicht in deiner Freigabe email (erlaubt: %s)" % (
                von, ", ".join(erlaubt) or "keine"))
        if von not in daten["ohne_rueckfrage"]:
            raise MailFehler("Absender %s hat im Mailkonto %s dieses Hosts keinen Umfang „ohne Rückfrage“ mehr (%s)"
                             % (von, konto_name, _pfadtext(konfig_pfad())))
    return von, konto_name, daten


def _adressen(werte: Any, label: str) -> list[str]:
    if werte is None:
        return []
    if isinstance(werte, str):
        werte = [werte]
    if not isinstance(werte, list):
        raise MailFehler("%s muss eine Liste von Adressen sein" % label)
    result: list[str] = []
    for roh in werte:
        for teil in (roh.split(",") if isinstance(roh, str) else [roh]):
            if not isinstance(teil, str) or not ADRESSE_RE.fullmatch(teil.strip()):
                raise MailFehler("%s enthaelt keine gueltige Mailadresse: %r" % (label, str(teil)[:80]))
            if teil.strip().lower() not in result:
                result.append(teil.strip().lower())
    return result


def nachricht_bauen(von: str, an: list[str], cc: list[str], betreff: Any, text: Any,
                    in_reply_to: Optional[str] = None, references: Optional[str] = None) -> EmailMessage:
    if not an:
        raise MailFehler("--an nennt keinen Empfaenger")
    if len(an) + len(cc) > EMPFAENGER_GRENZE:
        raise MailFehler("Hoechstens %d Empfaenger je Sendung" % EMPFAENGER_GRENZE)
    if not isinstance(betreff, str) or not betreff.strip() or len(betreff) > BETREFF_GRENZE \
            or re.search(r"[\x00-\x1f\x7f]", betreff):
        raise MailFehler("Betreff muss eine Zeile mit 1 bis %d Zeichen sein" % BETREFF_GRENZE)
    if not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > TEXT_GRENZE:
        raise MailFehler("Text muss 1 bis %d Bytes haben" % TEXT_GRENZE)
    msg = EmailMessage()
    msg["From"] = von
    msg["To"] = ", ".join(an)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = betreff.strip()
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=von.rpartition("@")[2])
    if in_reply_to:
        if not MSGID_RE.fullmatch(in_reply_to):
            raise MailFehler("In-Reply-To muss eine Message-ID in spitzen Klammern sein")
        refs = (references or "").split()
        if len(refs) > 20 or not all(MSGID_RE.fullmatch(item) for item in refs):
            raise MailFehler("References muss eine Liste von Message-IDs sein (hoechstens 20)")
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = " ".join(refs if in_reply_to in refs else refs + [in_reply_to])
    msg.set_content(text)
    return msg


def smtp_ziel(konto_name: str, umgebung: Optional[dict[str, str]] = None) -> tuple[str, int, str]:
    """(Host, Port, Modus ssl|starttls|klartext) aus dem Mailkonto. ``WB_MAIL_SMTP=host:port:modus`` (Testschalter)
    gilt nur in der Umgebung des Traegers oder des Menschen, nie aus einem Zug; Klartext nur an eine Loopback-Adresse."""
    daten = _mailkonto(konto_name)
    wert = (umgebung if umgebung is not None else os.environ).get("WB_MAIL_SMTP") or ""
    if not wert:
        return daten["smtp_host"], int(daten["smtp_port"]), daten["smtp_modus"]
    teile = wert.rsplit(":", 2)
    if len(teile) != 3 or not teile[1].isdigit() or teile[2] not in ("ssl", "starttls", "klartext"):
        raise MailFehler("WB_MAIL_SMTP braucht host:port:ssl|starttls|klartext", abgewiesen=False)
    if teile[2] == "klartext" and teile[0] not in LOOPBACK:
        raise MailFehler("Klartext-SMTP nur an eine Loopback-Adresse", abgewiesen=False)
    return teile[0], int(teile[1]), teile[2]


def passwort(konto_name: str, runner: Callable[..., Any] = subprocess.run,
             umgebung: Optional[dict[str, str]] = None) -> str:
    """SMTP-Passwort aus dem Schluesselbund des Hosts (macOS security, Linux secret-tool); nie ausgegeben."""
    daten = _mailkonto(konto_name)
    env = umgebung if umgebung is not None else os.environ
    datei_pfad = env.get("WB_MAIL_SMTP_PASSWORT_DATEI")
    if datei_pfad:
        try:
            wert = Path(datei_pfad).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise MailFehler("Passwortdatei aus WB_MAIL_SMTP_PASSWORT_DATEI nicht lesbar", abgewiesen=False) from exc
    else:
        if sys.platform == "darwin":
            cmd = ["security", "find-generic-password", "-s", daten["schluesselbund"], "-a", daten["benutzer"], "-w"]
        else:
            cmd = ["secret-tool", "lookup", "service", daten["schluesselbund"], "account", daten["benutzer"]]
        try:
            ergebnis = runner(cmd, capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            raise MailFehler("Schluesselbund fuer '%s' nicht abfragbar (%s)" % (
                daten["schluesselbund"], type(exc).__name__), abgewiesen=False) from exc
        wert = (ergebnis.stdout or "").strip() if ergebnis.returncode == 0 else ""
    if not wert or "\n" in wert or len(wert) > 4096:
        raise MailFehler("Kein brauchbares SMTP-Passwort im Schluesselbund (Dienst '%s')" % daten["schluesselbund"],
                         abgewiesen=False)
    return wert


def smtp_senden(konto_name: str, msg: EmailMessage, von: str, empfaenger: list[str], pw: str,
                ziel: Optional[tuple[str, int, str]] = None, zeitlimit: float = SMTP_ZEITLIMIT) -> dict[str, Any]:
    """Sendet und liefert das SMTP-Ergebnis; jeder Fehler ist eine MailFehler-Ausnahme ohne Passwort im Text."""
    host, port, modus = ziel or smtp_ziel(konto_name)
    daten = _mailkonto(konto_name)
    server = None
    try:
        if modus == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=zeitlimit, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(host, port, timeout=zeitlimit)
            if modus == "starttls":
                server.starttls(context=ssl.create_default_context())
        server.login(daten["benutzer"], pw)
        abgewiesen = server.send_message(msg, from_addr=von, to_addrs=empfaenger)
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        text = ("%s: %s" % (type(exc).__name__, exc)).replace(pw, "***")[:300]
        raise MailFehler("SMTP-Versand gescheitert: %s" % text, abgewiesen=False) from None
    finally:
        if server is not None:
            try:
                server.quit()
            except (smtplib.SMTPException, OSError):
                server.close()
    if abgewiesen:
        raise MailFehler("SMTP hat Empfaenger abgewiesen: %s" % ", ".join(sorted(abgewiesen))[:300],
                         abgewiesen=False)
    return {"gesendet": True, "host": host, "angenommen": len(empfaenger)}


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _protokoll(pfad: Path, zeile: dict[str, Any]) -> None:
    pfad = Path(pfad)
    if pfad.is_symlink():
        raise MailFehler("Versandlog darf kein Symlink sein", abgewiesen=False)
    pfad.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(pfad), os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(zeile, ensure_ascii=False, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _frueher_gesendet(pfad: Path, agent: str, sendung_id: Optional[str]) -> Optional[dict[str, Any]]:
    if not sendung_id or not Path(pfad).is_file() or Path(pfad).is_symlink():
        return None
    with open(pfad, encoding="utf-8") as stream:
        for roh in stream:
            try:
                zeile = json.loads(roh)
            except ValueError:
                continue
            if zeile.get("agent") == agent and zeile.get("sendung_id") == sendung_id \
                    and (zeile.get("ergebnis") or {}).get("gesendet"):
                return zeile
    return None


def versenden(*, agent: Optional[str], freigaben: Optional[list[dict[str, Any]]], logpfad: Path,
              von: Any, an: Any, cc: Any = None, betreff: Any, text: Any, ticket: Optional[str] = None,
              in_reply_to: Optional[str] = None, references: Optional[str] = None,
              sendung_id: Optional[str] = None, sperre: Optional[Callable[[], Any]] = None,
              sender: Callable[..., dict[str, Any]] = smtp_senden,
              passwort_quelle: Callable[[str], str] = passwort, konto: Optional[str] = None) -> dict[str, Any]:
    """Prueft, sendet, protokolliert. ``freigaben`` None ist der Mensch (kein Freigabezwang); ``konto`` bindet den
    Absender an ein Mailkonto (das Sendewerkzeug des Menschen). Jeder Versuch, der die Eingabepruefung erreicht, steht
    mit Ergebnis im Versandlog; nie der Wortlaut, nie ein Passwort."""
    zeile: dict[str, Any] = {"zeit": ad.now(), "agent": agent, "ticket": ticket, "sendung_id": sendung_id,
                             "von": von if isinstance(von, str) else None, "an": [], "cc": [],
                             "betreff": betreff if isinstance(betreff, str) else None,
                             "text_sha256": _sha256(text) if isinstance(text, str) else None,
                             "freigabe": None, "message_id": None}

    def schreiben(ergebnis: dict[str, Any]) -> None:
        zeile["ergebnis"] = ergebnis
        if sperre is None:
            _protokoll(logpfad, zeile)
            return
        with sperre():
            _protokoll(logpfad, zeile)

    try:
        erlaubt = adressen_von(freigaben) if freigaben is not None else None
        von, konto, _daten = absender_pruefen(von, erlaubt, konto, freigaben)
        zeile["von"] = von
        if freigaben is not None:
            zeile["freigabe"] = next(item["id"] for item in freigaben if von in _adressliste(item))
        zeile["an"], zeile["cc"] = _adressen(an, "--an"), _adressen(cc, "--cc")
        msg = nachricht_bauen(von, zeile["an"], zeile["cc"], betreff, text, in_reply_to, references)
        zeile["message_id"] = msg["Message-ID"]
        if agent is not None:
            frueher = _frueher_gesendet(logpfad, agent, sendung_id)
            if frueher is not None:
                return {"gesendet": True, "wiederholt": True, "message_id": frueher.get("message_id"),
                        "von": frueher.get("von"), "an": frueher.get("an")}
        pw = passwort_quelle(konto)
    except MailFehler as exc:
        schreiben({"gesendet": False, "abgewiesen" if exc.abgewiesen else "fehler": str(exc)[:300]})
        raise
    try:
        ergebnis = sender(konto, msg, von, zeile["an"] + zeile["cc"], pw)
    except MailFehler as exc:
        schreiben({"gesendet": False, "fehler": str(exc).replace(pw, "***")[:300]})
        raise MailFehler(str(exc).replace(pw, "***"), abgewiesen=False) from None
    if not isinstance(ergebnis, dict) or ergebnis.get("gesendet") is not True:
        schreiben({"gesendet": False, "fehler": "SMTP meldete keinen Versand"})
        raise MailFehler("SMTP meldete keinen Versand", abgewiesen=False)
    schreiben(dict(ergebnis))
    return {"gesendet": True, "message_id": zeile["message_id"], "von": von, "an": zeile["an"], "cc": zeile["cc"],
            "freigabe": zeile["freigabe"], "text_sha256": zeile["text_sha256"]}


def senden_agent(root: Path, agent_id: str, rolle: Optional[str], payload: dict[str, Any], *,
                 sender: Callable[..., dict[str, Any]] = smtp_senden,
                 passwort_quelle: Callable[[str], str] = passwort) -> dict[str, Any]:
    """Versand fuer einen gebundenen Agenten (Controller ``mail.senden``): Freigabe aus freigaben.json der Welt."""
    root = ad.world_path(str(root))
    actor = ad._actor(root, agent_id, rolle)
    if actor.get("kind") != "agent":
        raise MailFehler("mail.senden gilt nur fuer einen Agenten der Welt")
    freigaben = gueltige(root, agent_id, "email")
    if not freigaben:
        zeile = {"zeit": ad.now(), "agent": agent_id, "ticket": payload.get("ticket_id"),
                 "sendung_id": payload.get("sendung_id"), "von": payload.get("von"), "an": [], "cc": [],
                 "betreff": payload.get("betreff") if isinstance(payload.get("betreff"), str) else None,
                 "text_sha256": _sha256(payload["text"]) if isinstance(payload.get("text"), str) else None,
                 "freigabe": None, "message_id": None,
                 "ergebnis": {"gesendet": False, "abgewiesen": "keine Freigabe email"}}
        with ad.transaction(root):
            _protokoll(root / VERSANDLOG, zeile)
        raise MailFehler("%s haelt keine gueltige Freigabe email. Der Mensch erteilt sie mit `wb-welt freigabe "
                         "<welt> erteilen --art email …`, der Hauptagent gibt seine mit `freigabe.weitergeben` "
                         "weiter." % agent_id)
    return versenden(agent=agent_id, freigaben=freigaben, logpfad=root / VERSANDLOG, von=payload.get("von"),
                     an=payload.get("an"), cc=payload.get("cc"), betreff=payload.get("betreff"),
                     text=payload.get("text"), ticket=payload.get("ticket_id"),
                     in_reply_to=payload.get("in_reply_to"), references=payload.get("references"),
                     sendung_id=payload.get("sendung_id"), sperre=lambda: ad.transaction(root),
                     sender=sender, passwort_quelle=passwort_quelle)


def mensch_logpfad(konto_name: str, umgebung: Optional[dict[str, str]] = None) -> Path:
    """Versandlog des Menschen am Terminal: ``<XDG_STATE_HOME>/<ein eigenes Mailwerkzeug>-agenten/<konto>/mail-versand.jsonl``."""
    if not isinstance(konto_name, str) or not KONTONAME_RE.fullmatch(konto_name):
        raise MailFehler("Kontoname '%s' passt nicht zu [a-z][a-z0-9-]*" % str(konto_name)[:40], abgewiesen=False)
    env = umgebung if umgebung is not None else os.environ
    basis = env.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(basis) / "<ein eigenes Mailwerkzeug>-agenten" / konto_name / VERSANDLOG


# CLI ----------------------------------------------------------------------------------------------
def _liste_text(eintraege: list[dict[str, Any]]) -> list[str]:
    zeilen = []
    for item in eintraege:
        zeilen.append("%s %s -> %s: %s%s%s" % (
            item["id"], item["art"], item["inhaber"], ", ".join(_adressliste(item)),
            " (bis %s)" % item["ablauf"] if item.get("ablauf") else "",
            " [von %s]" % item["erteilt_von"]["id"] if item["erteilt_von"]["art"] == "agent" else ""))
    return zeilen


def cli(args: Any) -> Any:
    root = Path(args.world)
    if args.aktion == "liste":
        eintraege = liste(root)
        return eintraege if args.alle else [item for item in eintraege if item["gueltig"]]
    if args.aktion == "widerrufen":
        return {"widerrufen": widerrufen(root, freigabe_id=args.id, agent_id=(args.an or None),
                                         art=args.art, grund=args.grund, absender=args.absender)}
    fehlend = [flag for flag, wert in (("--art", args.art), ("--konto", args.konto), ("--an", args.an),
                                       ("--adressen", args.adressen)) if not wert]
    if fehlend:
        raise FreigabeFehler("Es fehlen: %s" % ", ".join(fehlend))
    agenten = [teil.strip() for teil in args.an.split(",") if teil.strip()]
    adressen = [teil.strip() for teil in args.adressen.split(",") if teil.strip()]
    return erteilen(root, agenten, args.art, args.konto, adressen, ablauf=args.ablauf, bestaetigt=args.bestaetigt,
                    wortlaut=args.beleg, absender=args.absender)


def ausgeben(args: Any, data: Any) -> None:
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.aktion == "liste":
        for zeile in _liste_text(data):
            print(zeile)
    elif args.aktion == "widerrufen":
        print("widerrufen: %s" % ", ".join(data["widerrufen"]))
    else:
        for zeile in _liste_text(data):
            print(zeile)


def parser_ergaenzen(sub: Any) -> None:
    p = sub.add_parser("freigabe", help="Freigaben einer Welt (nur der Mensch; Hauptagent per freigabe.weitergeben)")
    p.add_argument("world")
    p.add_argument("aktion", choices=("erteilen", "widerrufen", "liste"))
    p.add_argument("--art", choices=ARTEN)
    p.add_argument("--konto", help="Mailkonto aus mailkonten.json dieses Hosts (wb-welt mailkonto zeigen)")
    p.add_argument("--an", help="Agentenkennung(en), mit Komma")
    p.add_argument("--adressen", help="Absenderadressen mit Komma, z. B. info@example.org,kontakt@example.org")
    p.add_argument("--ablauf", help="2026-12-31, 2026-12-31T18:00:00Z oder 30d")
    p.add_argument("--beleg", help="Wortlaut der Entscheidung; Pflicht, wenn wb-mensch keinen Menschen belegt")
    p.add_argument("--id", help="widerrufen: Kennung der Freigabe")
    p.add_argument("--grund")
    p.add_argument("--alle", action="store_true", help="liste: auch widerrufene und abgelaufene")
    p.add_argument("--bestaetigt", action="store_true")
    p.add_argument("--absender", default="cli-operator")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("mailkonto", help="Mailkonten dieses Hosts anzeigen (mailkonten.json; nie ein Passwort)")
    p.add_argument("aktion", choices=("zeigen",))
    p.add_argument("name", nargs="?")
    p.add_argument("--json", action="store_true")


def mailkonto_zeigen(name: Optional[str] = None) -> dict[str, Any]:
    """Anzeige der Hostkonfiguration: Pfad und ein Konto oder alle. Fehlt die Datei oder das Konto, FreigabeFehler."""
    pfad = konfig_pfad()
    alle = konten()
    if name is not None:
        return {"datei": _pfadtext(pfad), "konten": {name: konto(name)}}
    if not alle:
        raise FreigabeFehler("Kein Mailkonto ist auf diesem Host eingerichtet: %s" % _pfadtext(pfad))
    return {"datei": _pfadtext(pfad), "konten": alle}


def mailkonto_cli(args: Any) -> None:
    daten = mailkonto_zeigen(args.name)
    if args.json:
        print(json.dumps(daten, ensure_ascii=False, indent=2))
        return
    print("Datei: %s" % daten["datei"])
    for name, item in daten["konten"].items():
        print("")
        print("%s (@%s)" % (name, item["domain"]))
        print("  SMTP: %s:%d %s, Anmeldung %s" % (item["smtp_host"], item["smtp_port"], item["smtp_modus"],
                                                 item["benutzer"]))
        print("  Schluesselbund-Eintrag: %s (Passwort wird nicht gelesen)" % item["schluesselbund"])
        print("  Werkzeug: %s senden" % item["werkzeug"])
        print("  Umfang: %s" % item["umfang_quelle"])
        print("  Ohne Rueckfrage: %s" % ", ".join(item["ohne_rueckfrage"]))
        for feld, titel in (("nie", "Sendet nie"), ("rundschreiben", "Nur eigener Pruefweg")):
            for adresse, grund in item[feld].items():
                print("  %s: %s (%s)" % (titel, adresse, grund))
        if item["hinweise"]:
            print("  Hinweise fuer Agenten: %d" % len(item["hinweise"]))


__all__ = ["ARTEN", "DATEI", "FreigabeFehler", "KONFIG_DATEI", "MailFehler", "VERSANDLOG", "absender_pruefen",
           "ablauf_lesen", "adressen_pruefen", "adressen_von", "entziehen", "erteilen", "gueltig", "gueltige",
           "konfig_pfad", "konten", "konto", "konto_fuer_werkzeug", "liste", "mailkonto_cli", "mailkonto_zeigen",
           "mensch_logpfad", "mensch_messen", "nachricht_bauen", "nicht_eingerichtet", "passwort", "senden_agent",
           "smtp_senden", "smtp_ziel", "versenden", "weitergeben", "widerrufen", "zusammenfassung"]
