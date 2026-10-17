"""werkzeuge_kern -- Kern von `wb-werkzeuge`: eine Quelle (werkzeuge.default.json),
je Harness ein Adapter, der nur Eintraege schreibt, die die Werkbank besitzt.

Plan: ~/AI/_recherche/werkzeug-plan-2026-10-13.md (Abschnitte 1, 3.1, 3.2). Diese Datei
liefert den GENERISCHEN Adapter "json-pfad" (ein Schluessel unterhalb eines Pfads in einer
JSON-Datei) und die Markerblock-Funktionen fuer TOML/YAML; der Codex-Adapter gehoert
einer anderen Spur. Nach dem Muster von `wb-harness-config`: Pruefsumme des zuletzt
Geschriebenen in einer Statusdatei, Zustaende GLEICH/FEHLT/VERALTET/ABGEWICHEN, Snapshot
vor jedem Ueberschreiben, atomares Schreiben ueber `atomar_schreiben`.

BESITZ entsteht nur aus der Statusdatei (~/.local/state/wb-werkzeuge.json unter $HOME):
was `apply` geschrieben oder `adopt` uebernommen hat, gehoert der Werkbank. Alles andere
in der Zieldatei ist fremd und bleibt unveraendert (Werte und Schluesselreihenfolge).

GEHEIMNISSE stehen nie in der Quelle: unter "geheimnisse" ist nur "schluesselbund:<d>/<k>"
oder "filter:<name>" erlaubt (Fehler GEHEIMNIS-IN-QUELLE, Exit 2, der Wert wird nie
ausgegeben). Die Mustersuche und `wb-mcp-start` sind eine getrennte Spur.

Umgebungsvariablen (Tests): WB_WERKZEUGE_SRC (Quellordner), WB_WERKZEUGE_REGISTRY (Datei),
WB_MASCHINE (mac|peer). HOME bestimmt Statusdatei, Snapshots und `~` in Zielpfaden.

Ausgabe `status --json`: {"schema":"werkzeuge-status/1","maschine":..,"eintraege":[..],
"fehler":[..]} -- Format fest, S6 (`check15_werkzeuge`) liest es.
"""
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import sys
import urllib.parse

import atomar_schreiben

SCHEMA_QUELLE = "werkzeuge/1"
SCHEMA_STATUS = "werkzeuge-status/1"
SCHEMA_STATE = "werkzeuge-state/1"
ARTEN = ("mcp", "hooks", "prompts", "plugins", "rechte", "skills", "anweisungen")
SCHLUESSELWORTE = {"alle-mit-mcp": "mcp", "alle-mit-prompts": "prompts", "alle-mit-hooks": "hooks",
                   "alle-mit-skills": "skills", "alle-mit-anweisungen": "anweisungen",
                   "alle-mit-rechte": "rechte"}
# Anlaesse, zu denen eine Anweisung (volltext/erinnerung) einem Harness zugestellt wird.
ANLAESSE = ("sitzungsstart", "nachricht", "worker-auftrag")
# Eintraege, die kein Adapter schreibt (leere Harness-Menge): Wissen bleibt in der Quelle, `grund` sagt warum.
# nur-traeger: der Agenten-Traeger registriert den Hook selbst je Claude-Zug (eigene turn-settings.json).
OHNE_HARNESS = ("nur-traeger",)
# alle: jeder Harness der Registry, auch kuenftige (Stilregel, der Nutzer 13.10.); ohne toolAdapter-Bedingung.
ALLE = "alle"
VERWEIS_PRAEFIXE = ("schluesselbund:", "filter:")
HUB_NAME = "werkbank"            # Name des einen Hub-Eintrags in mcp (Hub-Entwurf 5.1)
HUB_FELDER = ("port", "idleMinutes", "maschinen")
BEFUND_ZUSTAENDE = ("FEHLT", "VERALTET", "ABGEWICHEN")
# Messdatum je Registry-Zelle: gemessen "<JJJJ-MM-TT>/<Methode>", dazu `beleg` (kurz). Ohne Feld ist eine
# Zelle mit weg "leer" ein ungemessener Stand, kein geprueftes Merkmal (Luecken-Messung 13.10.).
GEMESSEN_MUSTER = re.compile(r"^\d{4}-\d{2}-\d{2}/(help|doku|binary|probe|quelle|herleitung)$")
UNGEMESSEN_GRUND = "ungemessen: weg leer ohne gemessen-Feld, Faehigkeit des Harness nicht belegt"
# Fehlt eine Datei oder ein Ordner, den skills/anweisungen nennen (etwa werkbank-stil/ neben einer
# installierten Quelle), gilt das nur dem Eintrag: Befund je Eintrag, die Quelle bleibt gueltig
# (Ausfallschutz 13.10.; sonst fielen wb-werkzeuge und wb-hub ganz aus). Strukturfehler bleiben QUELLE-UNGUELTIG.
QUELLDATEI_FEHLT = "QUELLDATEI-FEHLT"


class FehlerInQuelle(Exception):
    """Quelle, Registry oder Statusdatei unbrauchbar; `fehler` ist die Liste fuer die Ausgabe."""

    def __init__(self, fehler):
        Exception.__init__(self, "; ".join(f["text"] for f in fehler))
        self.fehler = fehler


# ---------------------------------------------------------------- Pfade

def home():
    return os.environ.get("HOME") or os.path.expanduser("~")


def pfad_aufloesen(p):
    if p == "~" or p.startswith("~/"):
        return os.path.join(home(), p[2:])
    return p


def statusdatei():
    return os.path.join(home(), ".local", "state", "wb-werkzeuge.json")


def maschine():
    m = os.environ.get("WB_MASCHINE")
    if m:
        return m
    if platform.system() == "Darwin":
        return "mac"
    return "peer" if "peer" in platform.node().lower() else "linux"


def quellordner():
    """Erster Ordner mit werkzeuge.default.json; ist WB_WERKZEUGE_SRC gesetzt, gilt nur er."""
    env = os.environ.get("WB_WERKZEUGE_SRC")
    kandidaten = [env] if env else [
        os.path.dirname(os.path.abspath(__file__)),
        os.path.join(home(), ".local", "bin"),
        os.path.join(home(), "AI", "claude-workbench", "shell"),
    ]
    for k in kandidaten:
        if os.path.isfile(os.path.join(k, "werkzeuge.default.json")):
            return k
    raise FehlerInQuelle([{"code": "QUELLE-UNGUELTIG", "eintrag": "quelle",
                           "text": "werkzeuge.default.json nicht gefunden"}])


def registry_pfad(ordner):
    env = os.environ.get("WB_WERKZEUGE_REGISTRY")
    if env:
        return env
    for k in (ordner, os.path.dirname(os.path.abspath(__file__))):
        p = os.path.join(k, "models.default.json")
        if os.path.isfile(p):
            return p
    raise FehlerInQuelle([{"code": "QUELLE-UNGUELTIG", "eintrag": "registry",
                           "text": "models.default.json nicht gefunden"}])


# ---------------------------------------------------------------- Laden und Pruefen

def _json_laden(pfad, was):
    try:
        with open(pfad, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise FehlerInQuelle([{"code": "QUELLE-UNGUELTIG", "eintrag": was,
                               "text": "%s nicht lesbar: %s" % (was, type(e).__name__)}])


def ist_hub_eintrag(e):
    """Der Hub-Eintrag der Quelle: Streamable HTTP mit `"token": "hub"` (Name werkbank)."""
    return isinstance(e, dict) and e.get("transport") == "http" and e.get("token") == "hub"


def ohne_hub(e):
    """Ein mcp-Eintrag mit `"ueber_hub": false`: entfernter Server, den der Hub nicht bedienen kann
    (etwa OAuth im Client, kein lokales Ziel). Er ist kein Hub-Backend; nur Adapter, die den Weg
    kennen, tragen ihn direkt ein (Claude: Plugin-.mcp.json), alle anderen melden OFFEN."""
    return isinstance(e, dict) and e.get("ueber_hub") is False


def hub_backend(q, art, e):
    """Ein mcp-Eintrag, den der Hub bedient und der in KEINER Harness-Datei steht: sobald die Quelle
    einen Abschnitt `hub` hat, ist jeder mcp-Eintrag ausser dem Hub-Eintrag ein Backend (und ausser
    den Eintraegen mit ueber_hub false). `harnesses` bleibt dann die Sichtbarkeit im Hub
    (?harness=<name>), nicht ein Schreibziel der Adapter."""
    return (art == "mcp" and isinstance(q.get("hub"), dict)
            and not ist_hub_eintrag(e) and not ohne_hub(e))


def _hub_pruefen(q, fehler):
    """Abschnitt `hub` und der Hub-Eintrag in mcp: Felder, Typen, Zusammenhang. Meldet nur."""
    def ung(eintrag, text):
        fehler.append({"code": "QUELLE-UNGUELTIG", "eintrag": eintrag, "text": text})

    hub = q.get("hub")
    mcp = q.get("mcp") if isinstance(q.get("mcp"), dict) else {}
    hub_eintraege = [n for n, e in mcp.items() if isinstance(e, dict) and e.get("token") is not None]
    if hub is not None:
        if not isinstance(hub, dict):
            ung("hub", "Abschnitt ist kein Objekt")
            hub = None
        else:
            for k in hub:
                if k not in HUB_FELDER:
                    ung("hub.%s" % k, "unbekanntes Feld (erlaubt: %s)" % ", ".join(HUB_FELDER))
            # Felder sind optional (die Leser haben Vorgaben: Port 8790, idleMinutes 10); gesetzt muessen sie stimmen
            port = hub.get("port", 1)
            if not (isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535):
                ung("hub.port", "port muss eine ganze Zahl von 1 bis 65535 sein")
            idle = hub.get("idleMinutes", 1)
            if not (isinstance(idle, (int, float)) and not isinstance(idle, bool) and idle > 0):
                ung("hub.idleMinutes", "idleMinutes muss eine Zahl groesser 0 sein")
            m = hub.get("maschinen", ["mac"])
            if not (isinstance(m, list) and m and all(x in ("mac", "peer") for x in m)):
                ung("hub.maschinen", "maschinen muss eine nichtleere Liste aus mac/peer sein")
    for name in hub_eintraege:
        e = mcp[name]
        ref = "mcp.%s" % name
        if e.get("token") != "hub":
            ung(ref, "token kennt nur den Wert \"hub\"")
            continue
        if e.get("transport") != "http":
            ung(ref, "token hub gehoert zu transport http")
            continue
        if name != HUB_NAME:
            ung(ref, "der Hub-Eintrag heisst %r" % HUB_NAME)
        url = e.get("url")
        if isinstance(url, str) and "{harness}" not in url:
            ung(ref, "token hub braucht {harness} in der url (Endpunkt ?harness=<name>)")
        elif isinstance(url, str) and isinstance(hub, dict) and isinstance(hub.get("port"), int):
            try:
                url_port = urllib.parse.urlsplit(url.replace("{harness}", "x")).port
            except ValueError:
                url_port = None
            if url_port != hub["port"]:
                ung(ref, "Port der url (%s) weicht von hub.port (%s) ab" % (url_port, hub["port"]))
    if len(hub_eintraege) > 1:
        ung("hub", "hoechstens ein mcp-Eintrag mit token hub (gefunden: %d)" % len(hub_eintraege))


def _datei_da(pfad, ordner):
    """Pfad einer Quelldatei: ~ und absolut gelten, sonst relativ zum Ordner der Quelle."""
    p = pfad_aufloesen(pfad)
    if not os.path.isabs(p) and ordner:
        p = os.path.join(ordner, p)
    return p


def _skills_pruefen(ref, e, ung, fehlt, ordner, aktiv):
    """skills.<name>: genau eine von `quelle` (Ordner mit SKILL.md) oder `alle-unter` (Ordner voller Skill-Ordner)."""
    q, alle = e.get("quelle"), e.get("alle-unter")
    if (q is None) == (alle is None):
        ung(ref, "skills braucht genau eines von quelle oder alle-unter")
        return
    feld = "quelle" if q is not None else "alle-unter"
    wert = e[feld]
    if not (isinstance(wert, str) and wert.strip()):
        ung(ref, "%s muss ein Pfad sein" % feld)
        return
    if ordner is None or not aktiv:
        return
    p = _datei_da(wert, ordner)
    if not os.path.isdir(p):
        fehlt(ref, "%s: Ordner nicht vorhanden" % feld)
    elif feld == "quelle" and not os.path.isfile(os.path.join(p, "SKILL.md")):
        fehlt(ref, "quelle: SKILL.md fehlt im Skill-Ordner")


def _anweisungen_pruefen(ref, e, ung, fehlt, ordner, aktiv):
    """anweisungen.<name>: volltext (Datei), optional erinnerung (Datei) und anlaesse."""
    for feld in ("volltext", "erinnerung"):
        w = e.get(feld)
        if w is None:
            if feld == "volltext":
                ung(ref, "anweisungen brauchen volltext")
            continue
        if not (isinstance(w, str) and w.strip()):
            ung(ref, "%s muss ein Dateipfad sein" % feld)
        elif ordner is not None and aktiv and not os.path.isfile(_datei_da(w, ordner)):
            fehlt(ref, "%s: Datei nicht vorhanden" % feld)
    an = e.get("anlaesse")
    if an is not None:
        if not (isinstance(an, list) and an and all(isinstance(x, str) for x in an)):
            ung(ref, "anlaesse muss eine nichtleere Liste sein")
        else:
            for x in an:
                if x not in ANLAESSE:
                    ung(ref, "unbekannter Anlass %r (erlaubt: %s)" % (x, ", ".join(ANLAESSE)))
    # takt (P2, WO 13.10.): nachricht.alle = N (jede N-te Nachricht, >= 1), nach_kompaktierung bool
    t = e.get("takt")
    if t is not None:
        n = (t.get("nachricht") or {}).get("alle", 1) if isinstance(t, dict) and isinstance(
            t.get("nachricht", {}), dict) else None
        if not isinstance(t, dict) or not isinstance(n, int) or isinstance(n, bool) or n < 1 \
                or not isinstance(t.get("nach_kompaktierung", True), bool):
            ung(ref, "takt: {nachricht: {alle: N>=1}, nach_kompaktierung: true|false} erwartet")


def _rechte_pruefen(ref, e, ung):
    """rechte.<name>: erlauben/verbieten sind Listen von Mustern (neutral); mindestens eine nichtleer."""
    gesetzt, kaputt = False, False
    for feld in ("erlauben", "verbieten"):
        w = e.get(feld)
        if w is None:
            continue
        if not (isinstance(w, list) and all(isinstance(x, str) and x.strip() for x in w)):
            ung(ref, "%s muss eine Liste von Mustern sein" % feld)
            kaputt = True
        elif w:
            gesetzt = True
    if not gesetzt and not kaputt:
        ung(ref, "rechte braucht erlauben oder verbieten (nichtleer)")


def quelle_pruefen(q, ordner=None):
    """Gibt die Fehlerliste zurueck (leer = gueltig). Werte unter geheimnisse nie im Text.
    ordner: Ordner der Quelle; nur mit ihm prueft sie, ob Skill-Ordner und Anweisungsdateien da sind
    (und nur fuer Eintraege, die auf dieser Maschine gelten). Eine fehlende Datei meldet sie als
    QUELLDATEI-FEHLT; laden() macht daraus einen Befund je Eintrag statt eines Quellfehlers."""
    fehler = []

    def ung(eintrag, text):
        fehler.append({"code": "QUELLE-UNGUELTIG", "eintrag": eintrag, "text": text})

    def fehlt(eintrag, text):
        fehler.append({"code": QUELLDATEI_FEHLT, "eintrag": eintrag, "text": text})

    if not isinstance(q, dict):
        return [{"code": "QUELLE-UNGUELTIG", "eintrag": "quelle", "text": "Wurzel ist kein Objekt"}]
    if q.get("schema") != SCHEMA_QUELLE:
        ung("schema", "schema muss %r sein" % SCHEMA_QUELLE)
    for art in ARTEN:
        sect = q.get(art)
        if sect is None:
            continue
        if not isinstance(sect, dict):
            ung(art, "Abschnitt ist kein Objekt")
            continue
        for name, e in sect.items():
            ref = "%s.%s" % (art, name)
            if not isinstance(e, dict):
                ung(ref, "Eintrag ist kein Objekt")
                continue
            geh = e.get("geheimnisse")
            if geh is not None:
                if not isinstance(geh, dict):
                    ung(ref, "geheimnisse ist kein Objekt")
                else:
                    for var, wert in geh.items():
                        ok = (isinstance(wert, str)
                              and any(wert.startswith(p) and len(wert) > len(p) for p in VERWEIS_PRAEFIXE))
                        if not ok:
                            fehler.append({"code": "GEHEIMNIS-IN-QUELLE", "eintrag": ref,
                                           "text": "geheimnisse.%s ist kein Verweis "
                                                   "(schluesselbund:<dienst>/<konto> oder filter:<name>)" % var})
            zw = e.get("zweck")
            if zw is not None and not isinstance(zw, str):
                ung(ref, "zweck muss ein Text sein")
            h = e.get("harnesses")
            if h is not None and not ((isinstance(h, str) and (h in SCHLUESSELWORTE or h in OHNE_HARNESS or h == ALLE)) or
                                      (isinstance(h, list) and all(isinstance(x, str) for x in h))):
                ung(ref, "harnesses: Liste, %s, %s oder %s erwartet" % (
                    ALLE, "/".join(sorted(SCHLUESSELWORTE)), "/".join(OHNE_HARNESS)))
            m = e.get("maschinen")
            if m is not None and not (isinstance(m, list) and all(isinstance(x, str) for x in m)):
                ung(ref, "maschinen muss eine Liste sein")
            st = e.get("status")
            if st is not None and not (isinstance(st, str) and st.startswith("offen-")):
                ung(ref, "status muss offen-<E> sein")
            aktiv = not isinstance(m, list) or maschine() in m
            if art == "skills":
                _skills_pruefen(ref, e, ung, fehlt, ordner, aktiv)
            elif art == "anweisungen":
                _anweisungen_pruefen(ref, e, ung, fehlt, ordner, aktiv)
            elif art == "rechte":
                _rechte_pruefen(ref, e, ung)
            if art == "hooks":
                ev = e.get("ereignisse")
                if not (isinstance(ev, list) and ev and all(isinstance(x, str) for x in ev)):
                    ung(ref, "ereignisse muss eine nichtleere Liste sein")
                if not isinstance(e.get("befehl"), str):
                    ung(ref, "hooks brauchen befehl")
            if art == "mcp":
                t = e.get("transport")
                if t == "stdio":
                    if not isinstance(e.get("command"), str):
                        ung(ref, "stdio braucht command")
                    a = e.get("args", [])
                    if not (isinstance(a, list) and all(isinstance(x, str) for x in a)):
                        ung(ref, "args muss eine Liste von Texten sein")
                    st = e.get("start")
                    if st is not None or e.get("command") == "wb-mcp-start":
                        if not (isinstance(st, list) and st and all(isinstance(x, str) for x in st)):
                            ung(ref, "start (echter Startbefehl) muss eine nichtleere Liste sein, "
                                     "Pflicht bei command wb-mcp-start")
                elif t == "http":
                    if not isinstance(e.get("url"), str):
                        ung(ref, "http braucht url")
                    elif re.search(r"\{(?!harness\})[^}]*\}", e["url"]):
                        ung(ref, "url: nur der Platzhalter {harness} ist erlaubt")
                    elif e["url"].lower().startswith("https://") and not ohne_hub(e):
                        ung(ref, "https-url nur mit \"ueber_hub\": false (der Hub spricht nur lokales http)")
                else:
                    ung(ref, "transport muss stdio oder http sein")
                if "ueber_hub" in e:
                    if e["ueber_hub"] is not False:
                        ung(ref, "ueber_hub kennt nur den Wert false")
                    else:
                        if t != "http":
                            ung(ref, "ueber_hub false gehoert zu transport http")
                        if e.get("token") is not None or e.get("geheimnisse"):
                            ung(ref, "ueber_hub false: kein token und keine geheimnisse (Anmeldung macht der Client)")
                        if not (isinstance(e.get("grund"), str) and e["grund"].strip()):
                            ung(ref, "ueber_hub false braucht grund")
    _hub_pruefen(q, fehler)
    return fehler


def _registry_zellen_pruefen(reg):
    """gemessen-Muster, skillRoots und `wie`-Verweise der Registry; die Zellen selbst bleiben frei."""
    fehler = []
    ids = [x.get("id") for x in reg["harnesses"]]

    def ung(eintrag, text):
        fehler.append({"code": "QUELLE-UNGUELTIG", "eintrag": eintrag, "text": text})

    for x in reg["harnesses"]:
        sr = x.get("skillRoots")
        if sr is not None and not (isinstance(sr, list) and all(isinstance(w, str) and w.startswith("~/") for w in sr)):
            ung("registry.%s.skillRoots" % x.get("id"), "skillRoots muss eine Liste von ~/-Pfaden sein")
        for art, z in (x.get("toolAdapter") or {}).items():
            ref = "registry.%s.toolAdapter.%s" % (x.get("id"), art)
            if not isinstance(z, dict):
                continue
            if "gemessen" in z and not (isinstance(z["gemessen"], str) and GEMESSEN_MUSTER.match(z["gemessen"])):
                ung(ref, "gemessen muss <JJJJ-MM-TT>/<help|doku|binary|probe|quelle|herleitung> sein")
            if "wie" in z and (z["wie"] not in ids or z["wie"] == x.get("id")):
                ung(ref, "wie verweist auf einen unbekannten oder den eigenen Harness")
    return fehler


def laden():
    """-> (quelle, registry). Wirft FehlerInQuelle mit allen Strukturfehlern. Fehlende Quelldateien
    stehen danach in quelldatei_befunde(q); die Eintraege selbst bleiben in der Quelle."""
    ordner = quellordner()
    q = _json_laden(os.path.join(ordner, "werkzeuge.default.json"), "quelle")
    fehler = quelle_pruefen(q, ordner)
    dateien = [f for f in fehler if f["code"] == QUELLDATEI_FEHLT]
    fehler = [f for f in fehler if f["code"] != QUELLDATEI_FEHLT]
    reg = _json_laden(registry_pfad(ordner), "registry")
    if not isinstance(reg, dict) or not isinstance(reg.get("harnesses"), list):
        fehler.append({"code": "QUELLE-UNGUELTIG", "eintrag": "registry", "text": "harnesses fehlt"})
        reg = {"harnesses": []}
    if not fehler:
        fehler.extend(_registry_zellen_pruefen(reg))
    if not fehler:
        ids = [h.get("id") for h in reg["harnesses"]]
        for art in ARTEN:
            for name, e in (q.get(art) or {}).items():
                h = e.get("harnesses")
                for x in (h if isinstance(h, list) else []):
                    if x not in ids:
                        fehler.append({"code": "QUELLE-UNGUELTIG", "eintrag": "%s.%s" % (art, name),
                                       "text": "unbekannter Harness %r" % x})
    if fehler:
        raise FehlerInQuelle(fehler)
    _QUELLDATEI_BEFUNDE[id(q)] = (q, dateien)
    return q, reg


# Befunde je Quelle aus laden(), ueber die Kennung des geladenen Objekts (die Quelle selbst bleibt
# unveraendert, Adapter und Hub sehen kein Zusatzfeld). Der Verweis auf q haelt die Kennung fest.
_QUELLDATEI_BEFUNDE = {}


def quelldatei_befunde(q):
    """[{code, eintrag, text}] der fehlenden Quelldateien einer mit laden() geladenen Quelle."""
    paar = _QUELLDATEI_BEFUNDE.get(id(q))
    return list(paar[1]) if paar and paar[0] is q else []


def _quelldatei_zeilen(q, nur_art):
    """Eine Statuszeile je Eintrag mit fehlender Quelldatei: ZIEL-UNLESBAR, der Grund nennt den Code
    und das Feld (keine Werte). Harness "-": der Eintrag gilt allen seinen Harnesses."""
    je_eintrag = {}
    for f in quelldatei_befunde(q):
        je_eintrag.setdefault(f["eintrag"], []).append(f["text"])
    aus = []
    for eintrag, texte in je_eintrag.items():
        art, _, name = eintrag.partition(".")
        if nur_art and art != nur_art:
            continue
        aus.append({"harness": "-", "art": art, "name": name, "ziel": None, "zustand": "ZIEL-UNLESBAR",
                    "grund": "%s: %s (nur dieser Eintrag, die uebrige Quelle gilt)" % (QUELLDATEI_FEHLT, "; ".join(texte))})
    return aus


# ---------------------------------------------------------------- Statusdatei

def _wert_sha(wert):
    s = json.dumps(wert, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def state_laden():
    p = statusdatei()
    if not os.path.exists(p):
        return {"schema": SCHEMA_STATE, "eintraege": {}}
    try:
        with open(p, encoding="utf-8") as f:
            s = json.load(f)
        if not isinstance(s, dict) or not isinstance(s.get("eintraege"), dict):
            raise ValueError("form")
        return s
    except (OSError, ValueError):
        raise FehlerInQuelle([{"code": "QUELLE-UNGUELTIG", "eintrag": "statusdatei",
                               "text": "Statusdatei unlesbar, wird nicht ueberschrieben"}])


def state_schluessel(harness, art, name):
    return "%s|%s|%s" % (harness, art, name)


def state_speichern(state):
    p = statusdatei()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    text = json.dumps(state, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    atomar_schreiben.schreiben(p, text, modus=0o600)


# ---------------------------------------------------------------- Ziel lesen/schreiben (json-pfad)

class ZielUnlesbar(Exception):
    pass


def _pfad_teile(pfad):
    return [t for t in pfad.split(".") if t]


def ziel_lesen(ziel):
    """-> (text|None, daten). Fehlt die Datei: (None, {}); leere Datei zaehlt als {}.
    Ungueltig: ZielUnlesbar."""
    p = pfad_aufloesen(ziel)
    if not os.path.exists(p):
        return None, {}
    try:
        with open(p, encoding="utf-8", newline="") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        raise ZielUnlesbar("Datei nicht lesbar")
    if not text.strip():
        return text, {}
    try:
        daten = json.loads(text)
    except ValueError:
        raise ZielUnlesbar("kein gueltiges JSON")
    if not isinstance(daten, dict):
        raise ZielUnlesbar("Wurzel ist kein Objekt")
    return text, daten


def knoten_holen(daten, pfad):
    """Das Objekt unterhalb von pfad oder None. ZielUnlesbar, wenn dort etwas anderes steht."""
    k = daten
    for t in _pfad_teile(pfad):
        if t not in k:
            return None
        k = k[t]
        if not isinstance(k, dict):
            raise ZielUnlesbar("Pfad %s ist kein Objekt" % pfad)
    return k


def wert_setzen(daten, pfad, name, wert):
    """Setzt nur daten[pfad][name]; alle anderen Schluessel bleiben, mit Reihenfolge."""
    knoten = daten
    for t in _pfad_teile(pfad):
        if t not in knoten:
            knoten[t] = {}
        knoten = knoten[t]
        if not isinstance(knoten, dict):
            raise ZielUnlesbar("Pfad %s ist kein Objekt" % pfad)
    knoten[name] = wert  # SETZE-EIGENEN-SCHLUESSEL


def _einrueckung(text):
    m = re.search(r"\n([ \t]+)\S", text or "")
    if not m:
        return 2
    return "\t" if m.group(1).startswith("\t") else len(m.group(1))


def json_serialisieren(daten, vorlage_text):
    s = json.dumps(daten, indent=_einrueckung(vorlage_text), ensure_ascii=False)
    if vorlage_text is None or vorlage_text.endswith("\n") or not vorlage_text.strip():
        s += "\n"
    return s


# ---------------------------------------------------------------- Snapshot

class Snapshots:
    """Hoechstens ein Snapshot je Datei und Lauf, unter
    ~/.local/trash-snapshots/<datum>-werkzeuge/<harness>-<dateiname>.<uhrzeit>."""

    def __init__(self):
        self.gesichert = {}

    def sichern(self, harness, datei):
        if datei in self.gesichert:
            return self.gesichert[datei]
        if not os.path.exists(datei):
            return None
        jetzt = datetime.datetime.now()
        verz = os.path.join(home(), ".local", "trash-snapshots", jetzt.strftime("%Y-%m-%d") + "-werkzeuge")
        os.makedirs(verz, exist_ok=True)
        basis = "%s-%s.%s" % (harness, os.path.basename(datei), jetzt.strftime("%H%M%S"))
        ziel, n = os.path.join(verz, basis), 1
        while os.path.exists(ziel):
            ziel = os.path.join(verz, "%s.%d" % (basis, n))
            n += 1
        shutil.copy2(datei, ziel)
        self.gesichert[datei] = ziel
        return ziel


# ---------------------------------------------------------------- Markerbloecke (TOML/YAML)

class MarkerFehler(Exception):
    pass


def _marker(art, name, kommentar):
    return ("%s >>> werkbank %s %s (wb-werkzeuge, nicht von Hand aendern)" % (kommentar, art, name),
            "%s <<< werkbank %s %s" % (kommentar, art, name))


def marker_lesen(text, art, name, kommentar="#"):
    """Der Inhalt zwischen den Markern oder None."""
    anfang, ende = _marker(art, name, kommentar)
    zeilen = text.split("\n")
    try:
        a = zeilen.index(anfang)
        e = zeilen.index(ende, a + 1)
    except ValueError:
        return None
    return "\n".join(zeilen[a + 1:e])


def marker_ersetzen(text, art, name, inhalt, kommentar="#"):
    """Ersetzt den Block zwischen den Markern, haengt ihn sonst an. Nur Text zwischen den
    Markern aendert sich; alles andere bleibt bytegleich."""
    anfang, ende = _marker(art, name, kommentar)
    block = "%s\n%s\n%s" % (anfang, inhalt.rstrip("\n"), ende)
    zeilen = text.split("\n")
    if anfang in zeilen:
        a = zeilen.index(anfang)
        if ende not in zeilen[a + 1:]:
            raise MarkerFehler("Anfangsmarker ohne Endmarker")
        e = zeilen.index(ende, a + 1)
        return "\n".join(zeilen[:a] + block.split("\n") + zeilen[e + 1:])
    if text and not text.endswith("\n"):
        text += "\n"
    if text.strip():
        text += "\n"
    return text + block + "\n"


def toml_pruefer(text):
    try:
        import tomllib
    except ImportError:
        raise MarkerFehler("kein TOML-Parser (tomllib) in dieser Python-Fassung")
    tomllib.loads(text)


def markerblock_schreiben(ziel, harness, art, name, inhalt, pruefer=None, kommentar="#", snapshots=None):
    """Schreibt einen Markerblock. Das Ganze wird VOR dem Schreiben mit `pruefer(text)` geparst;
    scheitert das, bleibt das Ziel unberuehrt und MarkerFehler wird geworfen.
    Gibt den Snapshot-Pfad oder None zurueck."""
    p = pfad_aufloesen(ziel)
    alt = None
    if os.path.exists(p):
        with open(p, encoding="utf-8", newline="") as f:
            alt = f.read()
    neu = marker_ersetzen(alt or "", art, name, inhalt, kommentar)
    snap = (snapshots or Snapshots()).sichern(harness, p)
    if pruefer is not None:
        # Vor dem Schreiben pruefen: ein Harness, der die Datei gerade liest, sieht nie
        # einen kaputten Zwischenstand. Das Ziel bleibt dann unberuehrt.
        try:
            pruefer(neu)
        except Exception as e:
            raise MarkerFehler("Ergebnis nicht parsebar (%s), nicht geschrieben" % type(e).__name__)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    modus = os.stat(p).st_mode & 0o7777 if alt is not None else 0o644
    atomar_schreiben.schreiben(p, neu, modus=modus, newline="")
    return snap


# ---------------------------------------------------------------- Adapter-Haken

WEITER = object()   # Rueckgabe eines mcp_wert-Hakens: "nicht mein Fall", der naechste (zuletzt der Kern) antwortet
ADAPTER = []        # [{name, haken...}] in Registrierungsreihenfolge; Adapter tragen sich selbst ein
HAKEN = {
    # zustaendig(argv) -> bool, main(argv) -> Exit: eigene Befehle/Flags eines Adapters (vor dem Kern gefragt)
    "zustaendig": "zustaendig(argv) -> bool",
    "main": "main(argv) -> Exitcode",
    # mcp_wert(e, form, ad) -> Wert | None (Form bekannt, aber nicht schreibbar) | WEITER; ad = Registry-Zelle
    "mcp_wert": "mcp_wert(e, form, ad) -> Wert | None | WEITER",
    # eintrag(r, art, name, e, harness, ad, state) -> r: Nachbearbeitung eines Kern-Eintrags (z. B. Grund)
    "eintrag": "eintrag(r, art, name, e, harness, ad, state) -> r",
    # bewerten(eintraege, q, reg, state, nur_harness, nur_art) -> eintraege: ergaenzt/ersetzt Eintraege
    # (Status, Plan, adopt); apply sieht diese Eintraege nicht, sondern ruft den Haken anwenden
    "bewerten": "bewerten(eintraege, q, reg, state, nur_harness, nur_art) -> eintraege",
    # anwenden(q, reg, nur_harness, nur_art, force, zeilen) -> Zahl geschriebener Eintraege; haengt
    # Berichtszeilen an zeilen an. Laeuft nach dem Kern-Schreiben, mit frisch geladener Statusdatei.
    "anwenden": "anwenden(q, reg, nur_harness, nur_art, force, zeilen) -> int",
}


def adapter_registrieren(name, **haken):
    """Traegt einen Adapter ein (oder ersetzt den gleichnamigen). Unbekannte Haken sind ein Fehler,
    damit sich ein Tippfehler nicht still als fehlender Haken auswirkt."""
    unbekannt = sorted(set(haken) - set(HAKEN))
    if unbekannt:
        raise ValueError("adapter_registrieren(%s): unbekannte Haken %s (erlaubt: %s)"
                         % (name, unbekannt, ", ".join(sorted(HAKEN))))
    ADAPTER[:] = [a for a in ADAPTER if a["name"] != name]
    ADAPTER.append(dict(haken, name=name))


def _haken(art):
    return [a[art] for a in ADAPTER if a.get(art)]


# ---------------------------------------------------------------- Bewerten

def mcp_wert(e, form, ad=None):
    """Die native Form eines MCP-Eintrags je Harness-Formfamilie: erst die Adapter-Haken,
    dann die Formen des Kerns. `ad` ist die Registry-Zelle toolAdapter.mcp (Feld `hub`: http|stdio)."""
    for haken in _haken("mcp_wert"):
        w = haken(e, form, ad)
        if w is not WEITER:
            return w
    return _mcp_wert_kern(e, form)


def _mcp_wert_kern(e, form):
    stdio = e["transport"] == "stdio"
    args = list(e.get("args", []))
    if form == "opencode":
        if stdio:
            return {"type": "local", "command": [e["command"]] + args, "enabled": True}
        return {"type": "remote", "url": e["url"], "enabled": True}
    if form == "qwen":
        return {"command": e["command"], "args": args} if stdio else {"httpUrl": e["url"]}
    if form == "copilot":
        if stdio:
            return {"type": "local", "command": e["command"], "args": args, "tools": ["*"]}
        return {"type": "http", "url": e["url"], "tools": ["*"]}
    if form in (None, "claude"):
        if stdio:
            return {"type": "stdio", "command": e["command"], "args": args}
        return {"type": "http", "url": e["url"]}
    return None


def zelle(reg, harness, art):
    """toolAdapter.<art> des Harness. `wie: <harness>` verweist auf die Zelle eines anderen Harness
    (copilot-cloud ist dasselbe Programm mit denselben Dateien wie copilot); das Messfeld der
    eigenen Zelle bleibt erhalten."""
    by_id = {x.get("id"): x for x in reg["harnesses"]}
    z = ((by_id.get(harness) or {}).get("toolAdapter") or {}).get(art)
    if isinstance(z, dict) and z.get("wie") in by_id and z["wie"] != harness:
        fremd = ((by_id[z["wie"]].get("toolAdapter") or {}).get(art))
        if isinstance(fremd, dict) and "wie" not in fremd:
            z = dict(fremd, **{k: z[k] for k in ("gemessen", "beleg") if k in z})
    return z


def skill_wurzeln(reg, harness):
    """Die Skill-Wurzeln, die der Harness selbst liest (Registry skillRoots, gemessen)."""
    for x in reg["harnesses"]:
        if x.get("id") == harness:
            r = x.get("skillRoots")
            return [w for w in r if isinstance(w, str)] if isinstance(r, list) else []
    return []


def harnesses_aufloesen(h, art, reg):
    harnesses = reg["harnesses"]
    if isinstance(h, list):
        return list(h)
    if h in OHNE_HARNESS:
        return []
    if h == ALLE:
        return [x["id"] for x in harnesses]
    if h in SCHLUESSELWORTE:
        a = SCHLUESSELWORTE[h]
        return [x["id"] for x in harnesses
                if isinstance(zelle(reg, x.get("id"), a), dict)
                and zelle(reg, x.get("id"), a).get("weg") != "leer"]
    return []


def bewerten(q, reg, state, nur_harness=None, nur_art=None):
    """Alle Eintraege mit Zustand, auch die der Adapter. Aendert nichts."""
    eintraege = _bewerten_kern(q, reg, state, nur_harness, nur_art)
    # Eintraege ohne Hub haben ihren Grund vom Kern; ein Haken darf sie nur in einen echten Zustand
    # heben (Claude: Plugin-.mcp.json), sie aber nicht als "im Hub aufgegangen" umdeuten (Codex).
    roh = {(x["harness"], x["art"], x["name"]): x for x in eintraege
           if x["art"] == "mcp" and ohne_hub((q.get("mcp") or {}).get(x["name"]))}
    for haken in _haken("bewerten"):
        eintraege = haken(eintraege, q, reg, state, nur_harness, nur_art)
    if roh:
        eintraege = [roh[k] if (k := (x["harness"], x["art"], x["name"])) in roh and x["zustand"] == "OFFEN"
                     else x for x in eintraege]
    return eintraege + _ungemessen(eintraege, reg, nur_harness, nur_art) + _quelldatei_zeilen(q, nur_art)


def _ungemessen(eintraege, reg, nur_harness, nur_art):
    """Eine Zeile je Zelle mit weg "leer" und ohne gemessen-Feld, fuer die kein Quelleintrag eine Zeile
    liefert: sonst bliebe ein kuenftiger Harness still leer (wb-consistency: HARNESS-UNGEMESSEN)."""
    vorhanden = {(x["harness"], x["art"]) for x in eintraege}
    aus = []
    for x in reg["harnesses"]:
        if nur_harness and x.get("id") not in nur_harness:
            continue
        for art in ARTEN:
            if nur_art and art != nur_art:
                continue
            z = zelle(reg, x.get("id"), art)
            if (isinstance(z, dict) and z.get("weg") == "leer" and not z.get("gemessen")
                    and (x.get("id"), art) not in vorhanden):
                aus.append({"harness": x["id"], "art": art, "name": "-", "ziel": None,
                            "zustand": "OFFEN", "grund": UNGEMESSEN_GRUND})
    return aus


def _bewerten_kern(q, reg, state, nur_harness=None, nur_art=None):
    """Die json-pfad-Eintraege des Kerns (mit mcp_wert- und eintrag-Haken). Jeder Eintrag: harness,
    art, name, ziel, zustand, grund plus interne Felder (wert, pfad, datei) fuer apply/adopt."""
    m = maschine()
    ergebnis = []
    for art in ARTEN:
        if nur_art and art != nur_art:
            continue
        for name, e in (q.get(art) or {}).items():
            if m not in e.get("maschinen", [m]) or hub_backend(q, art, e):
                continue
            for harness in harnesses_aufloesen(e.get("harnesses", []), art, reg):
                if nur_harness and harness not in nur_harness:
                    continue
                ad = zelle(reg, harness, art)
                if art == "skills" and isinstance(ad, dict) and skill_wurzeln(reg, harness):
                    ad = dict(ad, _wurzeln=skill_wurzeln(reg, harness))
                ergebnis.append(_eintrag(art, name, e, harness, ad, state))
    return ergebnis


def _eintrag(art, name, e, harness, ad, state):
    r = _eintrag_kern(art, name, e, harness, ad, state)
    for haken in _haken("eintrag"):
        r = haken(r, art, name, e, harness, ad, state)
    return r


def _eintrag_kern(art, name, e, harness, ad, state):
    r = {"harness": harness, "art": art, "name": name, "ziel": None, "zustand": "OFFEN", "grund": None}
    if ad is not None and isinstance(ad, dict):
        r["ziel"] = ad.get("ziel")
    if e.get("status"):
        r["grund"] = e["status"]
        return r
    if art == "mcp" and ohne_hub(e):
        r["grund"] = "entfernter Server mit OAuth, Weg fuer %s nicht gemessen" % harness
        return r
    if not isinstance(ad, dict):
        r["grund"] = "kein toolAdapter.%s in der Registry" % art
        return r
    if ad.get("weg") == "leer":
        if not ad.get("gemessen"):
            r["zustand"], r["ziel"], r["grund"] = "OFFEN", None, UNGEMESSEN_GRUND
            return r
        r["zustand"], r["ziel"], r["grund"] = "LEER", None, ad.get("grund")
        return r
    if art == "skills" and ad.get("weg") == "ordner-verweis":
        return _skills_status(r, e, ad)
    if ad.get("format") != "json-pfad" or art != "mcp":
        r["grund"] = "Adapter %s fuer %s folgt (%s)" % (ad.get("format") or ad.get("weg"), art,
                                                        "W2" if ad.get("gemessen") else "andere Spur")
        return r
    wert = mcp_wert(e, ad.get("form"), ad)
    if wert is None:
        r["grund"] = "form %r unbekannt" % ad.get("form")
        return r
    pfad = ad.get("pfad", "")
    r["wert"], r["pfad"], r["datei"] = wert, pfad, pfad_aufloesen(ad["ziel"])
    try:
        text, daten = ziel_lesen(ad["ziel"])
        knoten = knoten_holen(daten, pfad)
    except ZielUnlesbar as ex:
        r["zustand"], r["grund"] = "ZIEL-UNLESBAR", str(ex)
        return r
    if knoten is None or name not in knoten:
        r["zustand"] = "FEHLT"
        return r
    aktuell = _wert_sha(knoten[name])
    r["aktuell_sha"] = aktuell
    if aktuell == _wert_sha(wert):
        r["zustand"] = "GLEICH"
        return r
    rec = state["eintraege"].get(state_schluessel(harness, art, name))
    if rec and rec.get("sha") == aktuell:
        r["zustand"] = "VERALTET"
    else:
        r["zustand"] = "ABGEWICHEN"
        r["grund"] = "von Hand geaendert" if rec else "Handeintrag, nicht von der Werkbank geschrieben"
    return r


def _skills_status(r, e, ad):
    """skills mit Weg ordner-verweis: in JEDER Skill-Wurzel des Harness (Registry skillRoots, sonst das
    Ziel der Zelle) muss je Skill ein Eintrag stehen, der (ueber realpath) auf den Skill-Ordner der Quelle
    zeigt. Symlink oder derselbe Ordner zaehlt als GLEICH. Nur lesend; geschrieben werden die Links von
    `wb-instructions sync` (sync_skill_links)."""
    try:
        ordner = quellordner()
    except FehlerInQuelle:
        ordner = None
    wurzeln = ad.get("_wurzeln") or [ad["ziel"]]
    r["ziel"] = ", ".join(wurzeln)
    rang = {"GLEICH": 0, "FEHLT": 1, "ABGEWICHEN": 2, "ZIEL-UNLESBAR": 3}
    erg = [(w,) + _skills_wurzel(e, ordner, w) for w in wurzeln]
    zustand = max((x[1] for x in erg), key=lambda z: rang.get(z, 1))
    r["zustand"] = zustand
    gruende = [x[2] if len(wurzeln) == 1 else "%s: %s" % (x[0], x[2]) for x in erg if x[1] != "GLEICH" and x[2]]
    if gruende:
        r["grund"] = "; ".join(gruende)
    return r


def _skills_wurzel(e, ordner, wurzel):
    """-> (zustand, grund) fuer eine Skill-Wurzel."""
    ziel = pfad_aufloesen(wurzel)
    if os.path.lexists(ziel) and not os.path.isdir(ziel):
        return "ZIEL-UNLESBAR", "Zielordner ist kein Ordner"
    if e.get("alle-unter") is not None:
        quelle = _datei_da(e["alle-unter"], ordner)
        try:
            skills = sorted(n for n in os.listdir(quelle) if os.path.isfile(os.path.join(quelle, n, "SKILL.md")))
        except OSError:
            return "OFFEN", "Quellordner nicht lesbar"
        if os.path.realpath(quelle) == os.path.realpath(ziel):
            return "GLEICH", None
        paare = [(os.path.join(quelle, n), os.path.join(ziel, n)) for n in skills]
    else:
        quelle = _datei_da(e["quelle"], ordner).rstrip("/")
        paare = [(quelle, os.path.join(ziel, os.path.basename(quelle)))]
    fehlt = [z for _, z in paare if not os.path.lexists(z)]
    anders = [z for q, z in paare if os.path.lexists(z) and os.path.realpath(z) != os.path.realpath(q)]
    if anders:
        return "ABGEWICHEN", "%d von %d zeigen woandershin" % (len(anders), len(paare))
    if fehlt:
        return "FEHLT", ("%d von %d fehlen" % (len(fehlt), len(paare))) if len(paare) > 1 else None
    return "GLEICH", None


def _oeffentlich(eintraege):
    return [{k: x[k] for k in ("harness", "art", "name", "ziel", "zustand", "grund")} for x in eintraege]


def status_dokument(eintraege, fehler):
    return {"schema": SCHEMA_STATUS, "maschine": maschine(),
            "eintraege": _oeffentlich(eintraege), "fehler": fehler}


# ---------------------------------------------------------------- apply / adopt

def _ziel_schreiben(datei, harness, aenderungen, snapshots):
    """Schreibt alle aenderungen=[(pfad,name,wert)] einer Datei in einem Zug und prueft das
    Ergebnis. Rollback bei Fehler. Gibt den Snapshot-Pfad zurueck."""
    text, daten = ziel_lesen(datei)
    for pfad, name, wert in aenderungen:
        wert_setzen(daten, pfad, name, wert)
    neu = json_serialisieren(daten, text)
    snap = snapshots.sichern(harness, datei) if text is not None else None
    os.makedirs(os.path.dirname(datei), exist_ok=True)
    modus = (os.stat(datei).st_mode & 0o7777) if text is not None else 0o644
    atomar_schreiben.schreiben(datei, neu, modus=modus, newline="")
    try:
        if json.loads(open(datei, encoding="utf-8").read()) != daten:
            raise ValueError("abweichend")
    except ValueError:
        if snap:
            atomar_schreiben.kopieren(snap, datei)
        elif text is None:
            os.unlink(datei)
        raise ZielUnlesbar("Ergebnis nicht pruefbar, zurueckgerollt")
    return snap


def anwenden(q, reg, nur_harness=None, nur_art=None, force=None):
    """apply. force=(harness, art-name) ueberschreibt ABGEWICHEN fuer genau diesen Eintrag.
    Gibt (berichtszeilen, geschrieben) zurueck."""
    state = state_laden()
    eintraege = _bewerten_kern(q, reg, state, nur_harness, nur_art)
    snapshots, zeilen, nach_datei = Snapshots(), [], {}
    for x in eintraege:
        z = x["zustand"]
        if "wert" not in x:   # Eintrag ohne schreibbaren Wert (skills-Ordnerverweis): apply folgt in P4/P5
            if z in ("FEHLT", "VERALTET", "ABGEWICHEN"):
                zeilen.append("OFFEN  %s %s.%s: apply fuer diese Art folgt, nichts geschrieben%s" % (
                    x["harness"], x["art"], x["name"],
                    " (Skill-Links: wb-werkzeuge skills-anlegen, dann wb-instructions sync)" if x["art"] == "skills" else ""))
            continue
        ist_force = force is not None and force[0] == x["harness"] and force[1] in (x["name"],
                                                                                     "%s.%s" % (x["art"], x["name"]))
        if z in ("FEHLT", "VERALTET") or (z == "ABGEWICHEN" and ist_force):
            nach_datei.setdefault((x["harness"], x["datei"]), []).append(x)
        elif z == "ABGEWICHEN":
            zeilen.append("ABGEWICHEN  %s %s.%s: bleibt stehen (%s); --force sichert und ueberschreibt"
                          % (x["harness"], x["art"], x["name"], x["grund"]))
    geschrieben = 0
    for (harness, datei), xs in nach_datei.items():
        try:
            snap = _ziel_schreiben(datei, harness, [(x["pfad"], x["name"], x["wert"]) for x in xs], snapshots)
        except ZielUnlesbar as ex:
            zeilen.append("ZIEL-UNLESBAR  %s %s: %s" % (harness, datei, ex))
            continue
        for x in xs:
            state["eintraege"][state_schluessel(harness, x["art"], x["name"])] = {
                "ziel": x["ziel"], "sha": _wert_sha(x["wert"]),
                "zeit": datetime.datetime.now().isoformat(timespec="seconds")}
            zeilen.append("GESCHRIEBEN  %s %s.%s -> %s%s" % (harness, x["art"], x["name"], x["ziel"],
                                                             " (Snapshot %s)" % snap if snap else " (neu angelegt)"))
            geschrieben += 1
    if geschrieben:
        state_speichern(state)
    for haken in _haken("anwenden"):
        geschrieben += haken(q, reg, nur_harness, nur_art, force, zeilen) or 0
    return zeilen, geschrieben


def uebernehmen(q, reg, harness, eintrag):
    """adopt: nimmt einen vorhandenen Handeintrag in die Statusdatei auf. Die Zieldatei bleibt
    byteweise unveraendert."""
    state = state_laden()
    treffer = [x for x in bewerten(q, reg, state, [harness])
               if eintrag in (x["name"], "%s.%s" % (x["art"], x["name"]))]
    if not treffer:
        return ["adopt: kein Eintrag %s fuer %s in der Quelle" % (eintrag, harness)], 1
    x = treffer[0]
    if "aktuell_sha" not in x:
        return ["adopt: %s %s.%s hat im Ziel keinen Eintrag (Zustand %s)" % (harness, x["art"], x["name"],
                                                                         x["zustand"])], 1
    state["eintraege"][state_schluessel(harness, x["art"], x["name"])] = {
        "ziel": x["ziel"], "sha": x["aktuell_sha"], "adoptiert": True,
        "zeit": datetime.datetime.now().isoformat(timespec="seconds")}
    state_speichern(state)
    return ["ADOPTIERT  %s %s.%s (Ziel unveraendert)" % (harness, x["art"], x["name"])], 0


# ---------------------------------------------------------------- Ausgabe und CLI

def _tabelle(eintraege):
    out = []
    for x in eintraege:
        out.append("%-9s %-8s %-18s %-14s %s" % (x["harness"], x["art"], x["name"], x["zustand"],
                                                  x["grund"] or ""))
    return out


def _plan_zeilen(eintraege):
    out = []
    for x in eintraege:
        if x["zustand"] in ("FEHLT", "VERALTET") and "wert" not in x:
            out.append("? %s.%s [%s]: apply fuer diese Art folgt" % (x["art"], x["name"], x["harness"]))
        elif x["zustand"] in ("FEHLT", "VERALTET"):
            out.append("%s %s.%s in %s [%s]: %s" % ("+" if x["zustand"] == "FEHLT" else "~", x["art"], x["name"],
                                                     x["ziel"], x["harness"],
                                                     json.dumps(x["wert"], sort_keys=True, ensure_ascii=False)))
    return out or ["nichts zu schreiben"]


# ---------------------------------------------------------------- Skill-Schreiber (Quell-Wurzel)

# Die Wurzel, aus der `wb-instructions sync` (sync_skill_links) die Skills in alle uebrigen
# skillRoots verlinkt (dort SRC_SKILLS_DIR). Ein Werkbank-Skill aus der Quelle (skills.<name>.quelle)
# liegt hier als Link auf seinen Ordner neben der installierten werkzeuge.default.json; danach
# verteilt sync_skill_links ihn wie jeden anderen Skill (Review wz-integ2, M1).
QUELL_SKILLWURZEL = "~/.claude/skills"


def skills_anlegen(q, ordner, trocken=False, pruef_ordner=None):
    """Legt je skills.<name> mit `quelle` (diese Maschine) <QUELL_SKILLWURZEL>/<basename> als Link auf
    <ordner>/<quelle> an. Kriterium: nie ohne Snapshot ueberschrieben, Ersatz wird gemeldet. Steht dort
    etwas anderes (fremde Fassung, anderer Link), kommt es vorher nach
    ~/.local/trash-snapshots/<Datum>-skill-<name>/ (verschoben, nicht geloescht); die Zeile nennt den
    Snapshot-Pfad. Der Name gehoert der Werkbank (Entscheidung WorkbenchOrchestrator 13.10.).
    Fehlt <quelle>/SKILL.md, ist das auch im Trockenlauf ein FEHLER (Review wz-integ3, Fund 4); geprueft
    wird unter pruef_ordner, wenn gesetzt (wb-ausrollen: Repo-Quelle, die installierte fehlt im
    Trockenlauf noch), sonst unter ordner. Ein Dateifehler (Snapshot, Link) wird als FEHLER gemeldet,
    nicht als Traceback (Fund 5). -> (zeilen, fehler)"""
    m = maschine()
    wurzel = pfad_aufloesen(QUELL_SKILLWURZEL)
    zeilen, fehler = [], 0
    for name, e in sorted((q.get("skills") or {}).items()):
        if not isinstance(e, dict) or e.get("quelle") is None or m not in e.get("maschinen", [m]):
            continue
        quelle = _datei_da(e["quelle"], ordner).rstrip("/")
        ziel = os.path.join(wurzel, os.path.basename(quelle))
        pruef = _datei_da(e["quelle"], pruef_ordner).rstrip("/") if pruef_ordner else quelle
        if not os.path.isfile(os.path.join(pruef, "SKILL.md")):
            # auch vor GLEICH: ein Link auf eine verschwundene Quelle ist kein gueltiger Skill
            zeilen.append("FEHLER  skills.%s: %s/SKILL.md fehlt, kein Link %s" % (
                name, pruef, "wuerde angelegt" if trocken else "angelegt"))
            fehler += 1
            continue
        if os.path.lexists(ziel) and os.path.realpath(ziel) == os.path.realpath(quelle):
            zeilen.append("GLEICH  skills.%s: %s" % (name, ziel))
            continue
        snap = None
        if os.path.lexists(ziel):
            basis = os.path.join(home(), ".local", "trash-snapshots",
                                 "%s-skill-%s" % (datetime.date.today().isoformat(), name), os.path.basename(ziel))
            snap, n = basis, 1
            while os.path.lexists(snap):
                snap, n = "%s.%d" % (basis, n), n + 1
        vorsatz = "WUERDE " if trocken else ""
        zeile = "%sANGELEGT  skills.%s: %s -> %s%s" % (
            vorsatz, name, ziel, quelle, " (ERSETZT, alte Fassung im Snapshot %s)" % snap if snap else "")
        if trocken:
            zeilen.append(zeile)
            continue
        tmp = "%s.wbtmp-%d" % (ziel, os.getpid())
        try:
            os.makedirs(wurzel, exist_ok=True)
            if snap:
                os.makedirs(os.path.dirname(snap), exist_ok=True)
                shutil.move(ziel, snap)
            os.symlink(quelle, tmp, target_is_directory=True)
            os.replace(tmp, ziel)
        except (OSError, shutil.Error) as ex:
            if os.path.lexists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            stand = ("alte Fassung liegt im Snapshot %s, %s fehlt jetzt" % (snap, ziel)
                     if snap and os.path.lexists(snap) and not os.path.lexists(ziel)
                     else "%s unveraendert" % ziel)
            zeilen.append("FEHLER  skills.%s: %s (%s: %s)" % (name, stand, type(ex).__name__, ex))
            fehler += 1
            continue
        zeilen.append(zeile)
    return zeilen, fehler

USAGE = """wb-werkzeuge status [<harness>...] [--json] [--nur <art>]
wb-werkzeuge check [<harness>...]              Exit 0 sauber, 1 Befund, 2 Fehler in der Quelle
wb-werkzeuge plan [<harness>...]               zeigt, was apply schreiben wuerde
wb-werkzeuge apply [<harness>...]              schreibt FEHLT und VERALTET (mit Snapshot); Exit 1, wenn etwas stehen blieb
wb-werkzeuge apply --force <harness> <eintrag> ueberschreibt ABGEWICHEN (mit Snapshot)
wb-werkzeuge adopt <harness> <eintrag>         uebernimmt einen Handeintrag in die Statusdatei
wb-werkzeuge skills-anlegen [--dry-run] [--ordner DIR] [--pruef-ordner DIR]
                                               legt die Werkbank-Skills der Quelle in ~/.claude/skills an
                                               (Link; ersetzt nie ohne Snapshot und meldet den Ersatz);
                                               fehlende SKILL.md ist auch im Trockenlauf FEHLER; Exit 1 bei Fehler"""


def _optionen(args):
    json_aus, nur, force, rest = False, None, False, []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--json":
            json_aus = True
        elif a == "--force":
            force = True
        elif a == "--nur" and i + 1 < len(args):
            nur = args[i + 1]
            i += 1
        else:
            rest.append(a)
        i += 1
    return json_aus, nur, force, rest


def _skills_anlegen_main(args):
    trocken, werte = "--dry-run" in args, {}
    for opt in ("--ordner", "--pruef-ordner"):
        if opt in args:
            i = args.index(opt)
            werte[opt] = args[i + 1] if i + 1 < len(args) else None
            if not werte[opt]:
                print("wb-werkzeuge: skills-anlegen %s DIR" % opt, file=sys.stderr)
                return 2
    ordner = werte.get("--ordner")
    try:
        q, _ = laden()
        ordner = ordner or quellordner()
    except FehlerInQuelle as ex:
        for f in ex.fehler:
            print("FEHLER %s %s: %s" % (f["code"], f["eintrag"], f["text"]), file=sys.stderr)
        return 2
    zeilen, fehler = skills_anlegen(q, ordner, trocken, werte.get("--pruef-ordner"))
    print("\n".join(zeilen) or "keine Werkbank-Skills fuer diese Maschine")
    return 1 if fehler else 0


def main(argv):
    for a in ADAPTER:
        if a.get("zustaendig") and a.get("main") and a["zustaendig"](argv):
            return a["main"](argv)
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if len(argv) >= 2 else 2
    befehl = argv[1]
    if befehl == "skills-anlegen":
        return _skills_anlegen_main(argv[2:])
    json_aus, nur_art, force, rest = _optionen(argv[2:])
    if befehl not in ("status", "check", "plan", "apply", "adopt"):
        print("wb-werkzeuge: unbekannter Befehl %r\n%s" % (befehl, USAGE), file=sys.stderr)
        return 2
    try:
        q, reg = laden()
        state = state_laden()
    except FehlerInQuelle as ex:
        if json_aus or befehl in ("status", "check"):
            if json_aus:
                print(json.dumps(status_dokument([], ex.fehler), ensure_ascii=False))
            else:
                for f in ex.fehler:
                    print("FEHLER %s %s: %s" % (f["code"], f["eintrag"], f["text"]))
        else:
            for f in ex.fehler:
                print("FEHLER %s %s: %s" % (f["code"], f["eintrag"], f["text"]), file=sys.stderr)
        return 2
    if befehl == "adopt":
        if len(rest) != 2:
            print(USAGE, file=sys.stderr)
            return 2
        zeilen, rc = uebernehmen(q, reg, rest[0], rest[1])
        print("\n".join(zeilen))
        return rc
    if befehl == "apply" and force:
        if len(rest) != 2:
            print("wb-werkzeuge: apply --force <harness> <eintrag>", file=sys.stderr)
            return 2
        zeilen, _ = anwenden(q, reg, [rest[0]], nur_art, force=(rest[0], rest[1]))
        print("\n".join(zeilen) or "nichts zu schreiben")
        return 1 if any(z.startswith(("ABGEWICHEN", "ZIEL-UNLESBAR")) for z in zeilen) else 0
    eintraege = bewerten(q, reg, state, rest or None, nur_art)
    if befehl == "plan":
        print("\n".join(_plan_zeilen(eintraege)))
        return 0
    if befehl == "apply":
        zeilen, _ = anwenden(q, reg, rest or None, nur_art)
        print("\n".join(zeilen) or "nichts zu schreiben")
        # Exit 1, wenn etwas stehen blieb (ABGEWICHEN) oder nicht schreibbar war, wie
        # wb-harness-config: ein Wartungslauf soll das bemerken.
        return 1 if any(z.startswith(("ABGEWICHEN", "ZIEL-UNLESBAR")) for z in zeilen) else 0
    if json_aus:
        print(json.dumps(status_dokument(eintraege, []), ensure_ascii=False))
    else:
        print("\n".join(_tabelle(eintraege)) or "keine Eintraege fuer diese Maschine")
    if befehl == "check" and (any(x["zustand"] in BEFUND_ZUSTAENDE for x in eintraege)
                              or quelldatei_befunde(q)):
        return 1
    return 0
