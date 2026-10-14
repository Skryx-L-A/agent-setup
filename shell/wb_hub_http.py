"""wb_hub_http -- HTTP-Backend von `wb-hub` (Spur H1, Entwurf 2.1 und 2.5): ein schon laufender
Streamable-HTTP-MCP-Server auf 127.0.0.1, heute playwright ueber mcp-shared auf 8767.

Der Hub startet hier keinen Kindprozess; der Dienst laeuft extern. Je Backend eine MCP-Sitzung
(Kopf Mcp-Session-Id, Protokollversion aus der Initialisierung). Antworten als JSON oder als
SSE-Strom (je Ereignis eine Zeile data:). 404 zu einer bekannten Sitzung baut die Sitzung einmal
neu auf (Spezifikation 2025-06-18). Verbindungsfehler und 5xx zaehlen als Fehlschlag mit Backoff
wie beim stdio-Backend; Zeitgrenze und Fehlerantworten zaehlen nicht.

ZIEL: nur http://127.0.0.1 oder http://localhost, ohne Benutzerangabe. Weiterleitungen werden nicht
verfolgt (http.client statt urllib), damit der Hub nie an einen fremden Host weitergibt.
"""
import hashlib
import http.client
import itertools
import json
import os
import threading
import time
import urllib.parse

VERSIONEN = ("2025-06-18", "2025-03-26", "2024-11-05")
LOKAL = ("127.0.0.1", "localhost")
ANTWORT_GRENZE = 4 * 1024 * 1024
VORGABE_TIMEOUT = 120
ABBRUCH_ZEIT = 2.0


class BackendFehler(Exception):
    pass


class VerbindungWeg(BackendFehler):
    """Verbindung abgelehnt oder abgebrochen, 5xx, Protokoll bei der Initialisierung: zaehlt als Fehlschlag."""


class SitzungWeg(VerbindungWeg):
    """404 zu einer bekannten Sitzung: der Dienst hat sie verloren (z. B. nach einem Neustart)."""


class Zeitgrenze(BackendFehler):
    pass


class ZielFehler(ValueError):
    """Ziel ist kein lokaler http-Endpunkt."""


def ziel_zerlegen(url):
    """-> (Host, Port, Pfad samt Abfrage). Nur http auf 127.0.0.1 oder localhost, ohne Benutzerangabe."""
    if not isinstance(url, str):
        raise ZielFehler("url fehlt")
    teile = urllib.parse.urlsplit(url)
    if teile.scheme != "http" or teile.hostname not in LOKAL or teile.username or teile.password:
        raise ZielFehler("kein lokales http-Ziel")
    try:
        port = teile.port or 80
    except ValueError:
        raise ZielFehler("Port ungueltig")
    pfad = teile.path or "/"
    if teile.query:
        pfad += "?" + teile.query
    return teile.hostname, port, pfad


def antwort_lesen(typ, text, rid):
    """Antwort zur Anfrage rid aus einer JSON-Antwort oder aus einem SSE-Strom."""
    inhalt = text.decode("utf-8", "replace")
    if typ.lower().startswith("application/json"):
        zeilen = [inhalt]
    elif typ.lower().startswith("text/event-stream"):
        zeilen = [z[len("data:"):].strip() for z in inhalt.splitlines() if z.startswith("data:")]
    else:
        raise BackendFehler("Antworttyp nicht unterstuetzt")
    for z in zeilen:
        try:
            m = json.loads(z)
        except ValueError:
            continue
        if isinstance(m, dict) and m.get("id") == rid and ("result" in m or "error" in m):
            return m
    raise BackendFehler("keine Antwort zur Anfrage")


class HttpBackend:
    """Ein Streamable-HTTP-MCP-Server als externer Dienst: Sitzung bei Bedarf, kein Kindprozess."""

    def __init__(self, name, eintrag, hub):
        self.name = name
        self.eintrag = eintrag
        self.hub = hub
        self.host, self.port, self.pfad = ziel_zerlegen(eintrag.get("url"))
        self.schluessel = hashlib.sha256(json.dumps(eintrag, sort_keys=True).encode()).hexdigest()
        self.sperre = threading.RLock()
        self.ids = itertools.count(1)
        self.sitzung = False     # Sitzung ist aufgebaut
        self.sid = None          # Mcp-Session-Id des Dienstes, falls er eine vergibt
        self.version = None
        self.laufende = 0
        self.letzter_aufruf = 0.0
        self.fehlschlaege = 0
        self.gesperrt_bis = 0.0
        self.gesperrt = False
        self.letzter_fehler = None
        idle = eintrag.get("idleMinutes")
        env_idle = os.environ.get("WB_HUB_IDLE_SEKUNDEN")
        if env_idle:
            self.idle_sekunden = float(env_idle)
        else:
            self.idle_sekunden = 60.0 * float(idle if idle is not None else hub.idle_minuten)
        self.timeout = float(eintrag.get("timeout", VORGABE_TIMEOUT))

    # -- Zustand

    def laeuft(self):
        return self.sitzung

    def zustand(self):
        if self.gesperrt:
            return "GESPERRT"
        return "LAEUFT" if self.sitzung else "SCHLAEFT"

    # -- Sitzung

    def _verwerfen(self):
        self.sitzung, self.sid, self.version = False, None, None

    def _pruefe_start(self):
        if self.hub.ende.is_set():
            raise BackendFehler("Hub endet")
        if self.gesperrt:
            raise BackendFehler("gesperrt nach %d Fehlschlaegen" % self.fehlschlaege)
        rest = self.gesperrt_bis - time.monotonic()
        if rest > 0:
            raise BackendFehler("Neustart erst in %.1f s (Backoff)" % rest)

    def _aufbauen(self, zeit):
        """initialize, Mcp-Session-Id uebernehmen, notifications/initialized. Haelt die sperre."""
        self._verwerfen()
        rid = next(self.ids)
        _, sid, m = self._post({"jsonrpc": "2.0", "id": rid, "method": "initialize",
                                "params": {"protocolVersion": VERSIONEN[0], "capabilities": {},
                                           "clientInfo": {"name": "wb-hub", "version": "1"}}}, zeit, rid=rid)
        if "error" in m:
            raise VerbindungWeg("initialize: Fehler %s" % m["error"].get("code"))
        version = (m.get("result") or {}).get("protocolVersion")
        if version not in VERSIONEN:
            raise VerbindungWeg("Protokollversion nicht unterstuetzt")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, zeit, sid, version)
        self.sitzung, self.sid, self.version = True, sid, version
        self.hub.log.zeile(ereignis="start", server=self.name)

    def _beenden(self):
        if not self.sitzung:
            return
        sid, version = self.sid, self.version
        self._verwerfen()
        if sid:
            self._loeschen(sid, version)
        self.hub.log.zeile(ereignis="ende", server=self.name)

    def _loeschen(self, sid, version):
        """DELETE der Sitzung am Dienst (Spezifikation); Fehler dabei sind ohne Folge."""
        kopf = {"Mcp-Session-Id": sid}
        if version:
            kopf["MCP-Protocol-Version"] = version
        c = http.client.HTTPConnection(self.host, self.port, timeout=ABBRUCH_ZEIT)
        try:
            c.request("DELETE", self.pfad, headers=kopf)
            c.getresponse().read()
        except (OSError, http.client.HTTPException):
            pass
        finally:
            c.close()

    def _fehlschlag(self, grund):
        self.fehlschlaege += 1
        self.letzter_fehler = grund
        stufen = self.hub.backoff
        if self.fehlschlaege > len(stufen):
            self.gesperrt = True
        else:
            self.gesperrt_bis = time.monotonic() + stufen[self.fehlschlaege - 1]
        self.hub.log.zeile(ereignis="fehlschlag", server=self.name, grund=self.zustand())

    def stoppen(self):
        with self.sperre:
            self._beenden()

    def leerlauf_pruefen(self):
        """Hausmeister: beendet eine ruhende Sitzung; wartet nie auf einen laufenden Aufbau."""
        if not self.sperre.acquire(blocking=False):
            return
        try:
            if self.sitzung and self.laufende == 0 and time.monotonic() - self.letzter_aufruf > self.idle_sekunden:
                self._beenden()
        finally:
            self.sperre.release()

    # -- Anfragen

    def _post(self, nachricht, zeit, sid=None, version=None, rid=None):
        """-> (HTTP-Status, Mcp-Session-Id der Antwort, Antwort zu rid oder None).
        Verbindungsfehler und 5xx: VerbindungWeg; 404 zu einer Sitzung: SitzungWeg; Zeitablauf: Zeitgrenze."""
        kopf = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if sid:
            kopf["Mcp-Session-Id"] = sid
        if version:
            kopf["MCP-Protocol-Version"] = version
        c = http.client.HTTPConnection(self.host, self.port, timeout=zeit)
        try:
            c.request("POST", self.pfad, body=json.dumps(nachricht).encode(), headers=kopf)
            r = c.getresponse()
            status, typ, neue = r.status, r.getheader("Content-Type") or "", r.getheader("Mcp-Session-Id")
            text = r.read(ANTWORT_GRENZE + 1)
        except TimeoutError:
            raise Zeitgrenze("Zeitgrenze %.0f s" % zeit)
        except (OSError, http.client.HTTPException) as e:
            raise VerbindungWeg("Verbindung: %s" % type(e).__name__)
        finally:
            c.close()
        if len(text) > ANTWORT_GRENZE:
            raise BackendFehler("Antwort zu gross")
        if status >= 500:
            raise VerbindungWeg("HTTP %d" % status)
        if status == 404 and sid:
            raise SitzungWeg("Sitzung unbekannt")
        if not 200 <= status < 300:
            raise BackendFehler("HTTP %d" % status)
        if rid is None:
            return status, neue, None
        return status, neue, antwort_lesen(typ, text, rid)

    def _abbrechen(self, rid, sid, version):
        """Benachrichtigung notifications/cancelled, best effort (Zeitgrenze einer Anfrage)."""
        try:
            self._post({"jsonrpc": "2.0", "method": "notifications/cancelled",
                        "params": {"requestId": rid, "reason": "Zeitgrenze"}}, ABBRUCH_ZEIT, sid, version)
        except BackendFehler:
            pass

    def _rpc(self, methode, params, zeit, sid, version):
        rid = next(self.ids)
        try:
            _, _, m = self._post({"jsonrpc": "2.0", "id": rid, "method": methode, "params": params},
                                 zeit, sid, version, rid)
        except Zeitgrenze:
            self._abbrechen(rid, sid, version)
            raise
        if "error" in m:
            raise BackendFehler("Fehler %s" % m["error"].get("code"))
        return m.get("result") or {}

    def anfrage(self, methode, params, timeout=None):
        """Baut die Sitzung bei Bedarf auf; ein 404 baut sie einmal neu auf. Verbindungsfehler zaehlen als Fehlschlag."""
        zeit = timeout or self.timeout
        try:
            with self.sperre:
                if not self.sitzung:
                    self._pruefe_start()
                    self._aufbauen(zeit)
                self.laufende += 1
                sid, version = self.sid, self.version
            try:
                try:
                    r = self._rpc(methode, params, zeit, sid, version)
                except SitzungWeg:
                    with self.sperre:
                        self._aufbauen(zeit)
                        sid, version = self.sid, self.version
                    r = self._rpc(methode, params, zeit, sid, version)
            finally:
                with self.sperre:
                    self.laufende -= 1
                    self.letzter_aufruf = time.monotonic()
        except VerbindungWeg as e:
            with self.sperre:
                self._verwerfen()
                self._fehlschlag(str(e))
            raise
        with self.sperre:
            self.fehlschlaege = 0
        return r
