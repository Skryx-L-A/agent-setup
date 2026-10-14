"""werkzeuge_dateien -- Dateiwege von `wb-werkzeuge` (Installer pi-Extensions).

Plan: ~/AI/_recherche/werkzeug-plan-2026-10-13.md (2.3, 2.4, 3.1, 3.2) und Nachtrag 13:30 (Hub).
Der Kern kennt nur json-pfad und Markerbloecke. Fuer pi sind beide Wege Dateien, die ganz
gehoeren: `toolAdapter.mcp.weg = pi-erweiterung` (der Hub-Eintrag `werkbank` als Extension
wb-hub.ts) und `toolAdapter.plugins.weg = dateien` (Extensions aus der Registry). Dieses Modul
kopiert diese Dateien aus der Quelle an das Ziel, nur solange die Werkbank sie besitzt.

BESITZ wie im Kern: die Statusdatei (~/.local/state/wb-werkzeuge.json, Schluessel
harness|art|name, Pruefsumme des zuletzt Geschriebenen). Eine Zieldatei, die dort nicht steht
und anders ist als die Quelle, ist FREMD und bleibt stehen. Eine Datei, die die Werkbank
geschrieben hat und die danach von Hand geaendert wurde, ist ABGEWICHEN. Vor jedem
Ueberschreiben legt der Kern einen Snapshot an (werkzeuge_kern.Snapshots).

QUELLE: neben werkzeuge.default.json, also shell/ im Repo und nach dem Ausrollen ~/.local/bin
(inbox/ ist ein Unterordner). Dateien ohne Quelle im Repo (brain-kontext.ts, Plan 2.3) bleiben
OFFEN. Die Zuordnung Ziel-Dateiname -> Quelle steht hier, nicht in der Registry.

Zustaende: die des Kerns (GLEICH, FEHLT, VERALTET, ABGEWICHEN, OFFEN). FREMD wird in `status`
als ABGEWICHEN gemeldet, Begruendung im Feld `grund` beginnt mit "FREMD:". Das Schema
werkzeuge-status/1 kennt FREMD nicht, wie der Claude-Adapter es auch abbildet.

`adopt pi <eintrag>` uebernimmt eine Zieldatei ohne Bytebeaenderung (Kern-Befehl; dieser Modul
liefert dafuer `aktuell_sha`).
"""
import datetime
import hashlib
import os

import atomar_schreiben
import werkzeuge_kern as kern

# Quelle je Ziel-Dateiname, relativ zum Quellordner (werkzeuge.default.json liegt dort).
QUELLEN = {
    "wb-hub.ts": "pi-wb-hub.ts",
    "wb-inbox.ts": "inbox/pi-wb-inbox.ts",
}
GRUND_OHNE_QUELLE = "keine Quelle im Repo (Plan 2.3: Quelle durch Entscheidung festlegen)"
GRUND_FREMD = "FREMD: nicht von der Werkbank geschrieben, bleibt stehen (adopt uebernimmt)"
GRUND_HAND = "von Hand geaendert"


def _sha_datei(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _wege(q, reg):
    """Die Dateiwege je Harness aus Registry und Quelle: [(harness, art, name, ziel)]. Ein Ziel,
    das schon der Hub-Eintrag belegt (wb-hub.ts), steht in `plugins.dateien` nicht noch einmal:
    zwei Eintraege fuer dieselbe Datei wuerden sich gegenseitig ABGEWICHEN melden."""
    wege = []
    hub = (q.get("mcp") or {}).get(kern.HUB_NAME)
    hub_hier = kern.ist_hub_eintrag(hub) and kern.maschine() in hub.get("maschinen", [kern.maschine()])
    for h in reg["harnesses"]:
        ad = h.get("toolAdapter") or {}
        mcp = ad.get("mcp") or {}
        if hub_hier and mcp.get("weg") == "pi-erweiterung":
            wege.append((h["id"], "mcp", kern.HUB_NAME, mcp["ziel"]))
        plg = ad.get("plugins") or {}
        if plg.get("weg") == "dateien":
            for datei in plg.get("dateien", []):
                wege.append((h["id"], "plugins", datei, os.path.join(plg["ziel"], datei)))
    belegt = {(w[0], kern.pfad_aufloesen(w[3])) for w in wege if w[1] == "mcp"}
    return [w for w in wege if w[1] == "mcp" or (w[0], kern.pfad_aufloesen(w[3])) not in belegt]


def _eintrag(harness, art, name, ziel, ordner, state):
    """Ein Dateiweg mit Zustand. Interne Felder (datei, quelle, soll_sha, aktuell_sha, fremd)
    braucht apply/adopt; status gibt sie nicht aus (kern._oeffentlich)."""
    datei = kern.pfad_aufloesen(ziel)
    rel = QUELLEN.get(os.path.basename(datei))
    r = {"harness": harness, "art": art, "name": name, "ziel": ziel, "zustand": "OFFEN", "grund": None,
         "wert": rel, "datei": datei, "quelle": None, "fremd": False}
    if rel is None:
        r["grund"] = GRUND_OHNE_QUELLE
        return r
    quelle = os.path.join(ordner, rel)
    if not os.path.isfile(quelle):
        r["grund"] = "Quelle %s fehlt neben werkzeuge.default.json" % rel
        return r
    r["quelle"] = quelle
    r["soll_sha"] = _sha_datei(quelle)
    if not os.path.lexists(datei):
        r["zustand"] = "FEHLT"
        return r
    try:
        ist = _sha_datei(datei)
    except OSError:
        r["grund"] = "Zieldatei nicht lesbar"
        return r
    r["aktuell_sha"] = ist
    if ist == r["soll_sha"]:
        r["zustand"] = "GLEICH"
        return r
    rec = state["eintraege"].get(kern.state_schluessel(harness, art, name))
    if rec is None:
        r["zustand"], r["grund"], r["fremd"] = "ABGEWICHEN", GRUND_FREMD, True
    elif rec.get("sha") == ist:
        r["zustand"] = "VERALTET"
    else:
        r["zustand"], r["grund"] = "ABGEWICHEN", GRUND_HAND
    return r


def _eintraege(q, reg, state, nur_harness=None, nur_art=None):
    ordner = kern.quellordner()
    out = []
    for harness, art, name, ziel in _wege(q, reg):
        if nur_harness and harness not in nur_harness:
            continue
        if nur_art and art != nur_art:
            continue
        out.append(_eintrag(harness, art, name, ziel, ordner, state))
    return out


# ---------------------------------------------------------------- Haken

def bewerten(eintraege, q, reg, state, nur_harness, nur_art):
    """Ersetzt die Kern-Eintraege dieser Dateiwege (OFFEN, weil die Form fehlt) durch den Dateizustand."""
    ours = _eintraege(q, reg, state, nur_harness, nur_art)
    schluessel = {(e["harness"], e["art"], e["name"]) for e in ours}
    rest = [x for x in eintraege if (x["harness"], x["art"], x["name"]) not in schluessel]
    return rest + ours


def anwenden(q, reg, nur_harness, nur_art, force, zeilen):
    """Schreibt FEHLT und VERALTET, ABGEWICHEN nur mit --force (nie FREMD). Snapshot vor
    jedem Ueberschreiben, atomar ueber atomar_schreiben. Gibt die Zahl geschriebener Dateien zurueck."""
    state = kern.state_laden()
    snaps = kern.Snapshots()
    geschrieben = 0
    for x in _eintraege(q, reg, state, nur_harness, nur_art):
        z = x["zustand"]
        ist_force = (force is not None and not x["fremd"] and force[0] == x["harness"]
                     and force[1] in (x["name"], "%s.%s" % (x["art"], x["name"])))
        ref = "%s %s.%s" % (x["harness"], x["art"], x["name"])
        if z in ("GLEICH", "OFFEN"):
            continue
        if z == "ABGEWICHEN" and not ist_force:
            hinweis = "adopt uebernimmt" if x["fremd"] else "--force sichert und ueberschreibt"
            zeilen.append("ABGEWICHEN  %s: bleibt stehen (%s); %s" % (ref, x["grund"], hinweis))
            continue
        datei = x["datei"]
        snap = snaps.sichern(x["harness"], datei) if z != "FEHLT" else None
        os.makedirs(os.path.dirname(datei), exist_ok=True)
        atomar_schreiben.kopieren(x["quelle"], datei)
        if _sha_datei(datei) != x["soll_sha"]:
            # Nachpruefung fehlgeschlagen: Snapshot zurueck, sonst die neue Datei entfernen.
            if snap:
                atomar_schreiben.kopieren(snap, datei)
            else:
                os.unlink(datei)
            zeilen.append("ZIEL-UNLESBAR  %s %s: Nachpruefung nach dem Schreiben, zurueckgerollt" % (ref, datei))
            continue
        state["eintraege"][kern.state_schluessel(x["harness"], x["art"], x["name"])] = {
            "ziel": x["ziel"], "sha": x["soll_sha"],
            "zeit": datetime.datetime.now().isoformat(timespec="seconds")}
        zeilen.append("GESCHRIEBEN  %s -> %s%s" % (ref, x["ziel"],
                                                  " (Snapshot %s)" % snap if snap else " (neu angelegt)"))
        geschrieben += 1
    if geschrieben:
        kern.state_speichern(state)
    return geschrieben


def registrieren():
    """Traegt die Dateiwege in den Kern ein (idempotent)."""
    kern.adapter_registrieren("dateien", bewerten=bewerten, anwenden=anwenden)
