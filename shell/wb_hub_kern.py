"""wb_hub_kern -- Kern von `wb-hub`: EIN MCP-Endpunkt je Maschine fuer alle Harnesses.

Entwurf: ~/AI/_recherche/werkzeug-hub-entwurf-2026-10-13.md (1.3, 2.1 bis 2.8). Diese Datei ist
Spur H1: Streamable HTTP (Spezifikation 2025-06-18, eine JSON-Antwort je POST) auf 127.0.0.1,
Sitzungen ueber `Mcp-Session-Id`, Aggregation der stdio-Backends aus werkzeuge.default.json
(Schema werkzeuge/1, geladen ueber werkzeuge_kern) mit Werkzeugnamen `<server>-<tool>`.
HTTP-Backends (playwright ueber mcp-shared) liegen in wb_hub_http.py, Prompts und
Skill-Ressourcen (H5) in wb_hub_prompts, Socket-Uebernahme durch launchd/systemd und
Selbstende in wb_hub_dienst (H2); hier nur die Weichen. Nicht hier: stdio-Bruecke und CLI (H3).

SCHUTZ (2.7): Bindung nur an 127.0.0.1. Jede Anfrage prueft zuerst Host und Origin (403), dann
`Authorization: Bearer <token>` (401). Das Token liegt in ~/.local/state/wb-hub/token (0600, beim
ersten Start erzeugt). Es ist ein Zugriffsschluessel der Werkbank, kein Dienstgeheimnis.

GEHEIMNISSE (2.6): Der Hub sieht keine Werte. Er startet jedes Backend als `command args` aus der
Quelle (also `wb-mcp-start <name>`); der Wrapper loest die Verweise auf. stderr der Backends geht
nur durch `wb-geheimnis-filter filter` in stderr-<server>.log; ohne Filter wird es verworfen.

LOGS (2.8): hub.log, eine Zeile je Aufruf (Zeit, Harness, Server, Werkzeug, Dauer, Ergebnis).
Nie Argumente, nie Ergebnisinhalte, nie Header.

LEERLAUF (2.4): tools/list liest den Cache <state>/<server>.tools.json (Schluessel: Hash des
Quelleintrags). Ein Backend startet nur bei tools/call oder fehlendem Cache und endet nach
idleMinutes ohne Aufruf. Ausfall (2.5): isError-Ergebnis statt Absturz, Neustart mit Backoff
1 s, 5 s, 30 s, danach GESPERRT.

Umgebung (Tests): WB_WERKZEUGE_SRC, WB_WERKZEUGE_REGISTRY, WB_MASCHINE (wie werkzeuge_kern),
WB_HUB_STATE (Zustandsordner), WB_HUB_TOKEN_DATEI, WB_HUB_PORT, WB_HUB_IDLE_SEKUNDEN,
WB_HUB_BACKOFF ("1,5,30"), WB_HUB_FILTER_CMD (Filterbefehl, leer = keiner),
WB_HUB_HANDLER_TIMEOUT (Socket-Zeitgrenze in Sekunden, Vorgabe 30), WB_HUB_SELBSTENDE_SEKUNDEN (siehe wb_hub_dienst).
"""
import datetime
import fcntl
import glob
import hashlib
import http.server
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid

import werkzeuge_kern
import wb_hub_prompts
from wb_hub_http import BackendFehler, HttpBackend, ZielFehler

VORGABE_PORT = 8790
VORGABE_IDLE_MINUTEN = 10
VORGABE_TIMEOUT = 120
VORGABE_BACKOFF = (1.0, 5.0, 30.0)
PROTOKOLLE = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVERNAME = re.compile(r"^[a-z0-9]+$")
WERKZEUGNAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LOG_GRENZE = 5 * 1024 * 1024
KOERPER_GRENZE = 4 * 1024 * 1024
HANDLER_ZEITGRENZE = 30
FAEDEN_GRENZE = 64


# ---------------------------------------------------------------- Pfade und Einstellungen

def state_ordner():
    p = os.environ.get("WB_HUB_STATE") or os.path.join(werkzeuge_kern.home(), ".local", "state", "wb-hub")
    os.makedirs(p, mode=0o700, exist_ok=True)
    os.chmod(p, 0o700)     # makedirs aendert einen vorhandenen Ordner nicht
    return p


def token_laden():
    """Liest das Token; legt es beim ersten Start an (0600, 32 Zufallsbytes).
    Abbruch bei Symlink, fremdem Eigentuemer oder Gruppen-/Weltrechten."""
    pfad = os.environ.get("WB_HUB_TOKEN_DATEI") or os.path.join(state_ordner(), "token")
    if not os.path.isfile(pfad):
        os.makedirs(os.path.dirname(pfad), mode=0o700, exist_ok=True)
        try:
            fd = os.open(pfad, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            fd = None      # gleichzeitig angelegt (Hub und `wb-hub token-sicherstellen`): lesen
        if fd is not None:
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_hex(32) + "\n")
    try:
        fd = os.open(pfad, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise SystemExit("wb-hub: Tokendatei nicht oeffenbar (Symlink?): %s" % pfad)
    with os.fdopen(fd, encoding="utf-8") as f:
        st = os.fstat(f.fileno())
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise SystemExit("wb-hub: Tokendatei mit fremdem Eigentuemer oder Rechten: %s" % pfad)
        t = f.read().strip()
    if not t:
        raise SystemExit("wb-hub: Tokendatei leer: %s" % pfad)
    return t


def backoff_stufen():
    roh = os.environ.get("WB_HUB_BACKOFF")
    if not roh:
        return VORGABE_BACKOFF
    return tuple(float(x) for x in roh.split(",") if x.strip())


def filter_befehl():
    roh = os.environ.get("WB_HUB_FILTER_CMD")
    if roh is not None:
        return shlex.split(roh) if roh.strip() else None
    f = shutil.which("wb-geheimnis-filter")
    return [f, "filter"] if f else None


def zustand_sperren(ordner):
    """Exklusiver Lock je Zustandsordner. Ein zweiter Hub darin wuerde beim Start die Backends des
    ersten fuer Waisen halten und beenden. Der Lock lebt, solange die Datei offen ist (Hub.sperre_datei)."""
    f = open(os.path.join(ordner, "hub.lock"), "a")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        raise SystemExit("wb-hub: ein Hub laeuft schon mit diesem Zustandsordner: %s" % ordner)
    return f


def startzeit(pid):
    """Startzeit eines Prozesses als Text (ps lstart); leer, wenn er nicht mehr laeuft."""
    r = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True)
    return r.stdout.strip()


def gruppe_beenden(pid, pgid, zeit):
    """SIGTERM an die Gruppe, nach 2 s SIGKILL; die Gruppe ist eigene Session (start_new_session)."""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        pass
    for _ in range(20):
        if startzeit(pid) != zeit:
            break
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass


def waisen_aufraeumen(ordner, log):
    """Beendet Backends eines abgestuerzten Hubs. Eine pid-Datei zaehlt nur, wenn die Startzeit
    noch zum Prozess passt (sonst hat die PID ein fremder Prozess bekommen)."""
    for pfad in sorted(glob.glob(os.path.join(ordner, "*.pid"))):
        name = os.path.basename(pfad)[:-len(".pid")]
        try:
            with open(pfad, encoding="utf-8") as f:
                pid, pgid, zeit = f.read().rstrip("\n").split(" ", 2)
            pid, pgid = int(pid), int(pgid)
            if pid > 1 and pgid > 1 and zeit and startzeit(pid) == zeit:
                gruppe_beenden(pid, pgid, zeit)
                log.zeile(ereignis="waise-beendet", server=name)
        except (OSError, ValueError):
            pass
        try:
            os.unlink(pfad)
        except OSError:
            pass


# ---------------------------------------------------------------- Log ohne Inhalte

class Log:
    def __init__(self, ordner):
        self.pfad = os.path.join(ordner, "hub.log")
        self.sperre = threading.Lock()

    def zeile(self, **felder):
        """Nur feste, inhaltsfreie Felder; Werte werden auf ein Wort ohne Leerraum gekuerzt."""
        teile = [datetime.datetime.now().isoformat(timespec="seconds")]
        for k in ("ereignis", "harness", "server", "werkzeug", "dauer_ms", "ergebnis", "grund"):
            if k in felder and felder[k] is not None:
                teile.append("%s=%s" % (k, re.sub(r"[^A-Za-z0-9_.:-]", "_", str(felder[k]))[:80]))
        with self.sperre:
            try:
                if os.path.getsize(self.pfad) > LOG_GRENZE:
                    os.replace(self.pfad, self.pfad + ".1")
            except OSError:
                pass
            with open(self.pfad, "a", encoding="utf-8") as f:
                f.write(" ".join(teile) + "\n")


# ---------------------------------------------------------------- Backend (stdio)

class ProzessWeg(BackendFehler):
    """Der Backendprozess ist beendet oder seine Leitung zu; zaehlt als Fehlschlag."""


class Backend:
    """Ein stdio-MCP-Server als Kindprozess: Start bei Bedarf, Zeilen-JSON, eigener Lesefaden."""

    def __init__(self, name, eintrag, hub):
        self.name = name
        self.eintrag = eintrag
        self.hub = hub
        self.schluessel = hashlib.sha256(json.dumps(eintrag, sort_keys=True).encode()).hexdigest()
        self.sperre = threading.RLock()
        self.schreib_sperre = threading.Lock()
        self.proc = None
        self.filter = None
        self.offen = {}          # id -> [Event, Antwort]
        self.naechste_id = 0
        self.letzter_aufruf = 0.0
        self.laufende = 0
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
        return self.proc is not None and self.proc.poll() is None

    def zustand(self):
        if self.gesperrt:
            return "GESPERRT"
        return "LAEUFT" if self.laeuft() else "SCHLAEFT"

    # -- Start und Ende

    def _starten(self):
        if self.hub.ende.is_set():     # nach alles_beenden kein neues Kind mehr (sonst Waise)
            raise BackendFehler("Hub endet")
        if self.gesperrt:
            raise BackendFehler("gesperrt nach %d Fehlschlaegen" % self.fehlschlaege)
        jetzt = time.monotonic()
        if jetzt < self.gesperrt_bis:
            raise BackendFehler("Neustart erst in %.1f s (Backoff)" % (self.gesperrt_bis - jetzt))
        befehl = [self.eintrag["command"]] + list(self.eintrag.get("args", []))
        if shutil.which(befehl[0]) is None:
            self._fehlschlag("Befehl nicht gefunden")
            raise BackendFehler("Befehl nicht gefunden")
        fcmd = filter_befehl()
        log = None
        stderr = subprocess.DEVNULL
        if fcmd:
            log = open(os.path.join(self.hub.state, "stderr-%s.log" % self.name), "ab")
            self.filter = subprocess.Popen(fcmd, stdin=subprocess.PIPE, stdout=log,
                                           stderr=subprocess.DEVNULL, start_new_session=True)
            stderr = self.filter.stdin
        try:
            self.proc = subprocess.Popen(befehl, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=stderr, start_new_session=True)
        except OSError as e:
            self._fehlschlag(type(e).__name__)
            raise BackendFehler("Start gescheitert: %s" % type(e).__name__)
        finally:
            if self.filter:
                self.filter.stdin.close()
            if log:
                log.close()
        try:
            self._pid_schreiben()
        except OSError:           # ohne pid-Datei bliebe ein Kind bei Hub-Absturz unbekannt
            self._beenden()
            self._fehlschlag("pid-Datei")
            raise BackendFehler("pid-Datei nicht schreibbar")
        self.offen = {}
        threading.Thread(target=self._lesen, args=(self.proc,), daemon=True).start()
        self.hub.log.zeile(ereignis="start", server=self.name)
        try:
            self._anfrage_roh("initialize", {"protocolVersion": PROTOKOLLE[0], "capabilities": {},
                                             "clientInfo": {"name": "wb-hub", "version": "1"}}, 30.0)
            self._senden({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except BackendFehler as e:
            self._beenden()
            self._fehlschlag(str(e))
            raise

    def _pid_pfad(self):
        return os.path.join(self.hub.state, "%s.pid" % self.name)

    def _pid_schreiben(self):
        """`pid pgid startzeit` (0600). Die Gruppe ist eigene Session, also pgid = pid."""
        pid = self.proc.pid
        fd = os.open(self._pid_pfad(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("%d %d %s\n" % (pid, pid, startzeit(pid)))

    def _fehlschlag(self, grund):
        self.fehlschlaege += 1
        self.letzter_fehler = grund
        stufen = backoff_stufen()
        if self.fehlschlaege > len(stufen):
            self.gesperrt = True
        else:
            self.gesperrt_bis = time.monotonic() + stufen[self.fehlschlaege - 1]
        self.hub.log.zeile(ereignis="fehlschlag", server=self.name, grund=self.zustand())

    def _beenden(self):
        p, self.proc = self.proc, None
        if p is None:
            return
        try:
            p.stdin.close()
        except OSError:
            pass
        for sig, warte in ((None, 2.0), (signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0)):
            if sig is not None:
                try:
                    os.killpg(p.pid, sig)
                except OSError:
                    pass
            try:
                p.wait(warte)
                break
            except subprocess.TimeoutExpired:
                continue
        try:
            os.killpg(p.pid, signal.SIGKILL)   # Enkel des Wrappers
        except OSError:
            pass
        f, self.filter = self.filter, None
        if f is not None:
            try:
                f.wait(2.0)
            except subprocess.TimeoutExpired:
                f.kill()
                f.wait()
        for ev in list(self.offen.values()):
            ev[0].set()
        try:
            os.unlink(self._pid_pfad())
        except OSError:
            pass
        self.hub.log.zeile(ereignis="ende", server=self.name)

    def stoppen(self):
        with self.sperre:
            self._beenden()

    def leerlauf_pruefen(self):
        """Hausmeister: wartet nie auf ein Backend, das gerade startet oder endet; es wird im naechsten Takt geprueft."""
        if not self.sperre.acquire(blocking=False):
            return
        try:
            if self.laeuft() and self.laufende == 0 and \
                    time.monotonic() - self.letzter_aufruf > self.idle_sekunden:
                self._beenden()
            elif self.proc is not None and not self.laeuft():
                self._beenden()
        finally:
            self.sperre.release()

    # -- Zeilen-JSON

    def _senden(self, nachricht):
        try:
            with self.schreib_sperre:
                self.proc.stdin.write((json.dumps(nachricht) + "\n").encode())
                self.proc.stdin.flush()
        except (OSError, AttributeError, ValueError):
            raise ProzessWeg("Verbindung zum Prozess verloren")

    def _lesen(self, proc):
        for zeile in proc.stdout:
            try:
                m = json.loads(zeile)
            except ValueError:
                continue
            if not isinstance(m, dict):
                continue
            if "method" in m:
                if "id" in m:   # Anfrage des Backends: nur ping, sonst -32601 (kein Sampling/Elicitation)
                    antw = {"jsonrpc": "2.0", "id": m["id"]}
                    if m["method"] == "ping":
                        antw["result"] = {}
                    else:
                        antw["error"] = {"code": -32601, "message": "vom Hub nicht unterstuetzt"}
                    try:
                        proc.stdin.write((json.dumps(antw) + "\n").encode())
                        proc.stdin.flush()
                    except (OSError, ValueError):
                        pass
                elif m["method"] == "notifications/tools/list_changed":
                    self.hub.cache_loeschen(self)
                continue
            ev = self.offen.get(m.get("id"))
            if ev is not None:
                ev[1] = m
                ev[0].set()
        for ev in list(self.offen.values()):
            ev[0].set()

    def _anfrage_roh(self, methode, params, timeout):
        with self.schreib_sperre:
            self.naechste_id += 1
            rid = self.naechste_id
        ev = [threading.Event(), None]
        self.offen[rid] = ev
        try:
            self._senden({"jsonrpc": "2.0", "id": rid, "method": methode, "params": params})
            if not ev[0].wait(timeout):
                try:
                    self._senden({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                  "params": {"requestId": rid, "reason": "Zeitgrenze"}})
                except BackendFehler:
                    pass
                raise BackendFehler("Zeitgrenze %.0f s" % timeout)
            if ev[1] is None:
                raise ProzessWeg("Prozess beendet")
            if "error" in ev[1]:
                raise BackendFehler("Fehler %s" % ev[1]["error"].get("code"))
            return ev[1].get("result") or {}
        finally:
            self.offen.pop(rid, None)

    def anfrage(self, methode, params, timeout=None):
        """Startet bei Bedarf; jeder Fehler wird BackendFehler, ein Absturz zaehlt als Fehlschlag."""
        with self.sperre:
            if self.proc is not None and not self.laeuft():
                self._beenden()
                self._fehlschlag("Prozess beendet")
            if not self.laeuft():
                self._starten()
            self.laufende += 1
            self.letzter_aufruf = time.monotonic()
        try:
            r = self._anfrage_roh(methode, params, timeout or self.timeout)
            with self.sperre:
                self.fehlschlaege = 0
            return r
        except ProzessWeg:
            with self.sperre:
                if self.proc is not None:
                    try:
                        self.proc.wait(1.0)
                    except subprocess.TimeoutExpired:
                        pass
                if not self.laeuft():
                    self._beenden()
                    self._fehlschlag("Prozess beendet")
            raise
        finally:
            with self.sperre:
                self.laufende -= 1
                self.letzter_aufruf = time.monotonic()


# ---------------------------------------------------------------- Hub

class Hub:
    def __init__(self):
        self.state = state_ordner()
        self.sperre_datei = zustand_sperren(self.state)
        self.log = Log(self.state)
        waisen_aufraeumen(self.state, self.log)
        self.token = token_laden()
        q, reg = werkzeuge_kern.laden()
        self.quelle, self.registry = q, reg
        hub = q.get("hub") or {}
        self.port = int(os.environ.get("WB_HUB_PORT") or hub.get("port") or VORGABE_PORT)
        self.idle_minuten = float(hub.get("idleMinutes", VORGABE_IDLE_MINUTEN))
        self.backoff = backoff_stufen()
        self.maschine = werkzeuge_kern.maschine()
        self.backends = {}
        self.sichtbar = {}       # server -> Menge der Harnesses oder None (= kein Filter)
        self.befunde = []
        for name, e in sorted((q.get("mcp") or {}).items()):
            if not SERVERNAME.match(name):
                self.befunde.append(("NAME-UNGUELTIG", name))
                continue
            m = e.get("maschinen")
            if isinstance(m, list) and self.maschine not in m:
                continue
            if werkzeuge_kern.ist_hub_eintrag(e):     # der Eintrag werkbank ist der Hub selbst
                continue
            if werkzeuge_kern.ohne_hub(e):            # ueber_hub false: kein Backend, kein Befund
                continue
            art = e.get("transport")
            if art not in ("stdio", "http"):
                self.befunde.append(("TRANSPORT-NICHT-IM-HUB", name))
                continue
            try:
                self.backends[name] = HttpBackend(name, e, self) if art == "http" else Backend(name, e, self)
            except ZielFehler:
                self.log.zeile(ereignis="ziel-abgelehnt", server=name)
                self.befunde.append(("ZIEL-NICHT-LOKAL", name))
                continue
            self.sichtbar[name] = set(werkzeuge_kern.harnesses_aufloesen(
                e.get("harnesses", "alle-mit-mcp"), "mcp", reg))
        self.sitzungen = {}
        self.sperre = threading.Lock()
        self.cache_sperre = threading.Lock()
        self.ende = threading.Event()
        # Selbstende (H2, nur unter launchd/systemd): Zeit der letzten Anfrage und Zahl der gerade
        # bearbeiteten. selbstende_sekunden bleibt None, solange der Hub nicht dienstgestartet laeuft.
        self.anfrage_sperre = threading.Lock()
        self.letzte_anfrage = time.monotonic()
        self.aktive_anfragen = 0
        self.selbstende_sekunden = None
        self.stopp = None

    # -- Sichtbarkeit

    def backends_fuer(self, harness):
        return [b for n, b in sorted(self.backends.items())
                if harness is None or harness in self.sichtbar[n]]

    # -- Werkzeug-Cache (nur Namen und Schemata)

    def _cache_pfad(self, b):
        return os.path.join(self.state, "%s.tools.json" % b.name)

    def cache_loeschen(self, b):
        with self.cache_sperre:
            try:
                os.unlink(self._cache_pfad(b))
            except OSError:
                pass

    def werkzeuge(self, b):
        """-> Liste der Backend-Werkzeuge; warmer Cache startet nichts, Ausfall faellt auf alten Cache."""
        alt = None
        try:
            with open(self._cache_pfad(b), encoding="utf-8") as f:
                alt = json.load(f)
            if alt.get("schluessel") == b.schluessel:
                return alt["tools"]
        except (OSError, ValueError, AttributeError):
            alt = None
        try:
            tools, cursor = [], None
            while True:
                r = b.anfrage("tools/list", {"cursor": cursor} if cursor else {})
                tools.extend(t for t in r.get("tools", []) if isinstance(t, dict) and "name" in t)
                cursor = r.get("nextCursor")
                if not cursor:
                    break
        except BackendFehler:
            return alt["tools"] if alt else []
        with self.cache_sperre:
            tmp = self._cache_pfad(b) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"schluessel": b.schluessel, "tools": tools}, f)
            os.replace(tmp, self._cache_pfad(b))
        return tools

    def tools_list(self, harness):
        aus = []
        for b in self.backends_fuer(harness):
            for t in self.werkzeuge(b):
                name = "%s-%s" % (b.name, t["name"])
                if not WERKZEUGNAME.match(name):
                    self.log.zeile(ereignis="NAME-ZU-LANG" if len(name) > 64 else "NAME-UNGUELTIG",
                                   server=b.name)
                    continue
                aus.append(dict(t, name=name))
        return {"tools": aus}

    def tools_call(self, harness, params):
        name = params.get("name") if isinstance(params, dict) else None
        if not isinstance(name, str) or "-" not in name:
            return None
        server, tool = name.split("-", 1)
        b = self.backends.get(server)
        if b is None or b not in self.backends_fuer(harness):
            return None
        t0 = time.monotonic()
        try:
            r = b.anfrage("tools/call", {"name": tool, "arguments": params.get("arguments") or {}})
            ergebnis = "fehler" if r.get("isError") else "ok"
        except BackendFehler as e:
            ergebnis = "zeit" if str(e).startswith("Zeitgrenze") else "fehler"
            r = {"content": [{"type": "text", "text": "Server %s nicht erreichbar: %s" % (server, e)}],
                 "isError": True}
        self.log.zeile(ereignis="aufruf", harness=harness or "-", server=server, werkzeug=tool,
                       dauer_ms=int((time.monotonic() - t0) * 1000), ergebnis=ergebnis)
        return r

    # -- JSON-RPC

    def bearbeiten(self, m, sitzung):
        """-> Antwortobjekt oder None (Benachrichtigung)."""
        rid = m.get("id")
        methode = m.get("method")
        params = m.get("params") or {}

        def ok(r):
            return {"jsonrpc": "2.0", "id": rid, "result": r}

        def err(code, text):
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": text}}

        if rid is None:
            return None
        harness = sitzung["harness"]
        if methode == "ping":
            return ok({})
        if methode == "tools/list":
            return ok(self.tools_list(harness))
        if methode == "tools/call":
            r = self.tools_call(harness, params)
            return ok(r) if r is not None else err(-32602, "unbekanntes Werkzeug")
        if methode in wb_hub_prompts.PROMPT_METHODEN:
            try:
                return ok(wb_hub_prompts.bearbeiten(methode, params, self.quelle, self.registry, harness))
            except wb_hub_prompts.PromptFehler as e:
                return err(e.code, e.text)
        return err(-32601, "Methode nicht unterstuetzt")

    def initialisieren(self, m, harness):
        params = m.get("params") or {}
        gewuenscht = params.get("protocolVersion")
        version = gewuenscht if gewuenscht in PROTOKOLLE else PROTOKOLLE[0]
        sid = uuid.uuid4().hex
        with self.sperre:
            self.sitzungen[sid] = {"harness": harness, "version": version}
        return sid, {"jsonrpc": "2.0", "id": m.get("id"), "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False},
                             "prompts": {"listChanged": False},
                             "resources": {"subscribe": False, "listChanged": False}},
            "serverInfo": {"name": "werkbank", "version": "1"}}}

    # -- Leerlauf und Ende

    def anfrage_beginn(self):
        with self.anfrage_sperre:
            self.aktive_anfragen += 1
            self.letzte_anfrage = time.monotonic()

    def anfrage_ende(self):
        with self.anfrage_sperre:
            self.aktive_anfragen -= 1
            self.letzte_anfrage = time.monotonic()

    def anfrage_beruehrt(self):
        with self.anfrage_sperre:
            self.letzte_anfrage = time.monotonic()

    def selbstende_faellig(self):
        """Ohne Anfrage seit selbstende_sekunden, keine in Bearbeitung und kein Backend am Laufen
        (ein laufendes Backend endet erst nach seiner eigenen Leerlaufzeit; dann wird dies wahr)."""
        if self.selbstende_sekunden is None:
            return False
        with self.anfrage_sperre:
            if self.aktive_anfragen > 0 or \
                    time.monotonic() - self.letzte_anfrage <= self.selbstende_sekunden:
                return False
        return not any(b.laeuft() or b.laufende > 0 for b in self.backends.values())

    def hausmeister(self):
        while not self.ende.wait(0.5):
            for b in list(self.backends.values()):
                b.leerlauf_pruefen()
            if self.stopp is not None and self.selbstende_faellig():
                self.log.zeile(ereignis="hub-selbstende", grund="leerlauf")
                self.stopp()
                return

    def alles_beenden(self):
        self.ende.set()
        for b in self.backends.values():
            b.stoppen()


# ---------------------------------------------------------------- HTTP

def _zaehlt(fn):
    """Die Anfrage zaehlt fuer das Selbstende des Hubs, solange sie bearbeitet wird."""
    def umhuellt(self):
        self.hub.anfrage_beginn()
        try:
            return fn(self)
        finally:
            self.hub.anfrage_ende()
    umhuellt.__name__ = fn.__name__
    return umhuellt


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "wb-hub"
    sys_version = ""
    timeout = HANDLER_ZEITGRENZE    # Sekunden je Socket; haengende Kopf- und Koerperlesen enden
    hub = None

    def log_message(self, *a):   # keine Zugriffszeilen auf stderr (Header, Pfade)
        pass

    def _antwort(self, code, objekt=None, kopf=None):
        body = b"" if objekt is None else json.dumps(objekt).encode()
        self.send_response(code)
        if objekt is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (kopf or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _fehler(self, code, text):
        self._antwort(code, {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": text}})

    def _pruefen(self):
        """Host/Origin (403), Pfad (404), Token (401). -> harness oder False."""
        port = self.hub.port
        erlaubt = ("127.0.0.1:%d" % port, "localhost:%d" % port)
        if self.headers.get("Host") not in erlaubt:
            self._fehler(403, "Host nicht erlaubt")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ["http://" + h for h in erlaubt]:
            self._fehler(403, "Origin nicht erlaubt")
            return False
        teile = urllib.parse.urlsplit(self.path)
        if teile.path != "/mcp":
            self._fehler(404, "nur /mcp")
            return False
        auth = self.headers.get("Authorization") or ""
        if not secrets.compare_digest(auth.encode(), ("Bearer " + self.hub.token).encode()):
            self._fehler(401, "Token fehlt oder falsch")
            return False
        h = urllib.parse.parse_qs(teile.query).get("harness")
        return h[0] if h else None

    @_zaehlt
    def do_GET(self):
        if self._pruefen() is not False:
            self._antwort(405, None, {"Allow": "POST, DELETE"})

    @_zaehlt
    def do_DELETE(self):
        if self._pruefen() is False:
            return
        sid = self.headers.get("Mcp-Session-Id")
        with self.hub.sperre:
            weg = self.hub.sitzungen.pop(sid, None) if sid else None
        self._antwort(204 if weg else 404)

    def _koerper(self):
        """Liest den Koerper nach gepruefter Laenge (411 ohne Laenge, 413 zu gross). -> Bytes oder None."""
        if self.headers.get("Transfer-Encoding") is not None or self.headers.get("Content-Length") is None:
            self.close_connection = True
            self._fehler(411, "Content-Length erforderlich")
            return None
        try:
            laenge = int(self.headers["Content-Length"])
        except ValueError:
            self.close_connection = True
            self._fehler(400, "Content-Length ungueltig")
            return None
        if laenge < 0 or laenge > KOERPER_GRENZE:
            self.close_connection = True
            self._fehler(413, "Koerper zu gross")
            return None
        return self.rfile.read(laenge)

    @_zaehlt
    def do_POST(self):
        harness = self._pruefen()
        if harness is False:
            return
        koerper = self._koerper()
        if koerper is None:
            return
        try:
            m = json.loads(koerper)
        except ValueError:
            self._antwort(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            return
        if not isinstance(m, dict) or m.get("jsonrpc") != "2.0":
            self._fehler(400, "eine JSON-RPC-Nachricht je POST")
            return
        if m.get("method") == "initialize":
            sid, antw = self.hub.initialisieren(m, harness)
            self._antwort(200, antw, {"Mcp-Session-Id": sid})
            return
        sid = self.headers.get("Mcp-Session-Id")
        if not sid:
            self._fehler(400, "Mcp-Session-Id fehlt")
            return
        with self.hub.sperre:
            sitzung = self.hub.sitzungen.get(sid)
        if sitzung is None:
            self._fehler(404, "Sitzung unbekannt")
            return
        pv = self.headers.get("MCP-Protocol-Version")
        if pv is not None and pv not in PROTOKOLLE:
            self._fehler(400, "MCP-Protocol-Version nicht unterstuetzt")
            return
        if "method" not in m:          # Antwort eines Clients: nichts zu tun
            self._antwort(202)
            return
        antw = self.hub.bearbeiten(m, sitzung)
        if antw is None:
            self._antwort(202)
        else:
            self._antwort(200, antw)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    faeden = threading.BoundedSemaphore(FAEDEN_GRENZE)
    hub = None

    @classmethod
    def aus_socket(cls, sock, handler):
        """Server auf einem schon lauschenden Socket (von launchd/systemd, H2); bindet nichts selbst."""
        srv = cls(sock.getsockname(), handler, bind_and_activate=False)
        srv.socket.close()
        srv.socket = sock
        srv.server_address = sock.getsockname()
        return srv

    def process_request(self, request, client_address):
        """Ueber der Fadengrenze wird die Verbindung sofort geschlossen, vor jeder Authentisierung."""
        if self.hub is not None:
            self.hub.anfrage_beruehrt()
        if not self.faeden.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.faeden.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.faeden.release()


# ---------------------------------------------------------------- Befehle

USAGE = """wb-hub serve [--port <n> | --socket-aktiviert]
  MCP-Endpunkt http://127.0.0.1:<port>/mcp?harness=<name>
  --socket-aktiviert  Lausch-Socket von launchd/systemd uebernehmen; Selbstende nach hub.idleMinutes"""


def serve(argv):
    os.umask(0o077)     # Log, stderr-Dateien und Backend-Kinder nur fuer den Eigentuemer
    port = None
    aktiviert = False
    if len(argv) == 2 and argv[0] == "--port":
        port = int(argv[1])
    elif argv == ["--socket-aktiviert"]:
        aktiviert = True
    elif argv:
        print(USAGE, file=sys.stderr)
        return 2
    sock = None
    if aktiviert:
        import wb_hub_dienst
        try:
            sock = wb_hub_dienst.socket_uebernehmen()
        except wb_hub_dienst.KeinSocket as e:
            print("wb-hub: %s" % e, file=sys.stderr)
            return 2
    try:
        hub = Hub()
    except werkzeuge_kern.FehlerInQuelle as e:
        for f in e.fehler:
            print("wb-hub: %s %s: %s" % (f["code"], f["eintrag"], f["text"]), file=sys.stderr)
        return 2
    if port is not None:
        hub.port = port
    Handler.hub = hub
    if os.environ.get("WB_HUB_HANDLER_TIMEOUT"):
        Handler.timeout = float(os.environ["WB_HUB_HANDLER_TIMEOUT"])
    if sock is not None:
        hub.port = sock.getsockname()[1]     # Host-Pruefung (2.7) gilt dem Port des Dienstsockets
        srv = Server.aus_socket(sock, Handler)
        hub.selbstende_sekunden = wb_hub_dienst.selbstende_sekunden(hub.idle_minuten)
    else:
        srv = Server(("127.0.0.1", hub.port), Handler)
    srv.hub = hub

    def stopp(*_):
        threading.Thread(target=srv.shutdown, daemon=True).start()

    hub.stopp = stopp if sock is not None else None

    signal.signal(signal.SIGTERM, stopp)
    signal.signal(signal.SIGINT, stopp)
    threading.Thread(target=hub.hausmeister, daemon=True).start()
    hub.log.zeile(ereignis="hub-start", grund="port:%d%s" % (hub.port, " dienst" if sock is not None else ""))
    print("wb-hub: lauscht auf 127.0.0.1:%d, %d Backends" % (hub.port, len(hub.backends)), file=sys.stderr)
    try:
        srv.serve_forever(poll_interval=0.2)
    finally:
        hub.alles_beenden()
        srv.server_close()
        hub.log.zeile(ereignis="hub-ende")
    return 0


def main(argv):
    args = argv[1:]
    if args and args[0] == "serve":
        return serve(args[1:])
    print(USAGE, file=sys.stderr)
    return 2
