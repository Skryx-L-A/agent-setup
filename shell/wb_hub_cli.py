"""wb_hub_cli -- Bruecke und Kurzaufrufe von `wb-hub` (Spur H3, Entwurf 2026-10-13, 2.1, 2.7, 4).

Alles hier spricht mit dem laufenden Hub (wb_hub_kern) ueber HTTP auf 127.0.0.1 und Token-Datei;
der Hub selbst bleibt unveraendert. Befehle:
  token-header   JSON {"Authorization": "Bearer ..."} fuer den headersHelper von Claude
                 (ohne Tokendatei Exit 1 ohne Ausgabe); legt nichts an
  token-sicherstellen
                 legt die Tokendatei bei Bedarf an (Regeln wie wb_hub_kern.token_laden), ohne einen
                 Hub zu starten. Mit --harness <h>: Exit 3, wenn der Harness keine Variable
                 WB_HUB_TOKEN braucht. Mit --wert: Token auf stdout, nur in eine Pipe/Variable
                 (Startweg wb-harness-run), nie auf ein Terminal
  stdio          stdio-MCP-Bruecke: Zeilen-JSON von stdin, HTTP zum Hub, Antworten nach stdout
  tools          Werkzeugnamen des Hubs fuer einen Harness
  call           ein Werkzeug aufrufen, Ergebnistext auf stdout (Exit 1 bei isError)
  status         Hub erreichbar? Ohne Token, ohne Werte

Umgebung: WB_HUB_PORT, WB_HUB_TOKEN_DATEI, WB_HUB_STATE (wie wb_hub_kern), WB_HUB_HARNESS (Vorgabe
fuer --harness). Ohne --harness sieht der Aufruf alle Backends, wie der Hub ohne Parameter.
"""
import http.client
import json
import os
import socket
import stat
import sys
import time
import urllib.parse

import werkzeuge_kern
import wb_hub_kern

PROTOKOLL = wb_hub_kern.PROTOKOLLE[0]
ZEITGRENZE = wb_hub_kern.VORGABE_TIMEOUT + 30


class HubFehler(Exception):
    pass


# ---------------------------------------------------------------- Pfade, Port, Token

def token_pfad():
    """Wie wb_hub_kern.token_laden, aber ohne Anlegen: token-header darf nichts erzeugen."""
    if os.environ.get("WB_HUB_TOKEN_DATEI"):
        return os.environ["WB_HUB_TOKEN_DATEI"]
    st = os.environ.get("WB_HUB_STATE") or os.path.join(werkzeuge_kern.home(), ".local", "state", "wb-hub")
    return os.path.join(st, "token")


def token_lesen():
    """-> Token oder None (Datei fehlt, leer, nicht lesbar, Symlink, fremder Eigentuemer oder
    Gruppen-/Weltrechte; dieselbe Pruefung wie wb_hub_kern.token_laden)."""
    try:
        fd = os.open(token_pfad(), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    with os.fdopen(fd, encoding="utf-8") as f:
        st = os.fstat(f.fileno())
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            return None
        try:
            t = f.read().strip()
        except (OSError, ValueError):
            return None
    return t or None


def token_ordner_fehler(pfad=None):
    """-> Grund oder None. Die Tokendatei entsteht nur in einem eigenen Ordner: kein Symlink, eigener
    Nutzer, keine Gruppen-/Weltschreibrechte (sonst koennte ein anderer sie tauschen oder mitlesen).
    Fehlt der Ordner, wird er hier mit 0700 angelegt und danach ebenso geprueft."""
    ordner = os.path.dirname(os.path.abspath(pfad or token_pfad()))
    try:
        if not os.path.lexists(ordner):
            os.makedirs(ordner, mode=0o700, exist_ok=True)
        st = os.lstat(ordner)
    except OSError as e:
        return "Ordner %s nicht anlegbar (%s)" % (ordner, type(e).__name__)
    if not stat.S_ISDIR(st.st_mode):
        return "%s ist kein Ordner (Symlink?)" % ordner
    if st.st_uid != os.getuid():
        return "Ordner %s gehoert einem anderen Nutzer" % ordner
    if st.st_mode & 0o022:
        return "Ordner %s ist fuer Gruppe/Welt beschreibbar" % ordner
    return None


def port():
    roh = os.environ.get("WB_HUB_PORT")
    if roh:
        return int(roh)
    try:
        q, _ = werkzeuge_kern.laden()
        return int((q.get("hub") or {}).get("port") or wb_hub_kern.VORGABE_PORT)
    except (werkzeuge_kern.FehlerInQuelle, ValueError):
        return wb_hub_kern.VORGABE_PORT


# ---------------------------------------------------------------- HTTP zum Hub

def senden(port_, token, harness, sid, nachricht=None, methode="POST"):
    """-> (HTTP-Code, Mcp-Session-Id oder None, Antwortobjekt oder None). Fehler: HubFehler."""
    pfad = "/mcp"
    if harness:
        pfad += "?" + urllib.parse.urlencode({"harness": harness})
    kopf = {"Authorization": "Bearer " + (token or ""), "Accept": "application/json, text/event-stream"}
    data = None
    if nachricht is not None:
        data = json.dumps(nachricht).encode()
        kopf["Content-Type"] = "application/json"
    if sid:
        kopf["Mcp-Session-Id"] = sid
    try:
        c = http.client.HTTPConnection("127.0.0.1", port_, timeout=ZEITGRENZE)
        c.request(methode, pfad, body=data, headers=kopf)
        r = c.getresponse()
        roh = r.read()
        neu = r.getheader("Mcp-Session-Id")
        c.close()
    except OSError as e:
        raise HubFehler("Hub nicht erreichbar auf 127.0.0.1:%d (%s)" % (port_, type(e).__name__))
    objekt = None
    if roh:
        try:
            objekt = json.loads(roh)
        except ValueError:
            raise HubFehler("Hub-Antwort ist kein JSON (HTTP %d)" % r.status)
    return r.status, neu or sid, objekt


class Sitzung:
    """Eine MCP-Sitzung am Hub. Nach HTTP 404 (Hub neu gestartet) baut sie sich mit dem gemerkten
    initialize neu auf, wie es die Spezifikation fuer Clients verlangt."""

    def __init__(self, harness):
        self.harness = harness
        self.port = port()
        self.token = token_lesen()
        if not self.token:
            # Harnesses mit der Registry-Zelle hub "stdio" haben keinen wb-harness-run-Schritt, der die
            # Datei vorher anlegt (token-sicherstellen antwortet dort Exit 3): die Bruecke legt sie wie der
            # Hub selbst an (wb_hub_kern.token_laden, O_EXCL, 0600), damit ein erster Aufruf vor dem ersten
            # Hub-Start (launchd startet ihn erst bei der Verbindung) nicht an der fehlenden Datei scheitert.
            fehler = token_ordner_fehler()
            if fehler:
                raise HubFehler("Tokendatei nicht angelegt: " + fehler)
            try:
                self.token = wb_hub_kern.token_laden()
            except (SystemExit, OSError):
                self.token = None
        if not self.token:
            raise HubFehler("keine Tokendatei; Hub nie gestartet oder WB_HUB_TOKEN_DATEI falsch")
        self.sid = None
        self.init = None

    def starten(self, nachricht=None):
        self.init = nachricht or {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
            "protocolVersion": PROTOKOLL, "capabilities": {},
            "clientInfo": {"name": "wb-hub-cli", "version": "1"}}}
        code, sid, obj = senden(self.port, self.token, self.harness, None, self.init)
        if code != 200 or not sid or obj is None:
            raise HubFehler("initialize abgelehnt (HTTP %d)" % code)
        self.sid = sid
        return obj

    def anfrage(self, nachricht):
        """-> Antwortobjekt oder None (bei Benachrichtigungen)."""
        code, sid, obj = senden(self.port, self.token, self.harness, self.sid, nachricht)
        if code == 404 and self.init is not None:
            self.starten(self.init)
            code, sid, obj = senden(self.port, self.token, self.harness, self.sid, nachricht)
        if code == 202:
            return None
        if code != 200 or obj is None:
            raise HubFehler("Hub antwortet HTTP %d" % code)
        return obj

    def beenden(self):
        if self.sid:
            try:
                senden(self.port, self.token, self.harness, self.sid, None, methode="DELETE")
            except HubFehler:
                pass
            self.sid = None


# ---------------------------------------------------------------- Befehle

def harness_aus(argv):
    """-> (harness oder None, Restargumente). --harness <h> wird entfernt."""
    harness = os.environ.get("WB_HUB_HARNESS") or None
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--harness":
            if i + 1 >= len(argv):
                raise SystemExit("wb-hub: --harness braucht einen Namen")
            harness = argv[i + 1]
            i += 2
            continue
        rest.append(argv[i])
        i += 1
    return harness, rest


def token_header(argv):
    t = token_lesen()
    if not t:
        return 1
    print(json.dumps({"Authorization": "Bearer " + t}))
    return 0


def token_variable_noetig(harness):
    """True, wenn der MCP-Eintrag, den der Adapter fuer `harness` schreibt, das Token ueber die
    Umgebungsvariable WB_HUB_TOKEN bezieht (codex: bearer_token_env_var; opencode, crush, qwen,
    nanocoder: Header mit Verweis). claude (headersHelper) und pi (liest die Datei) brauchen sie nicht."""
    import werkzeuge_codex
    import werkzeuge_familie
    werkzeuge_familie.registrieren()     # Haken mcp_wert: Hub-Header mit Verweis auf die Variable
    q, reg = werkzeuge_kern.laden()
    ad = next(((x.get("toolAdapter") or {}).get("mcp") for x in reg["harnesses"] if x.get("id") == harness), None)
    if not isinstance(ad, dict) or ad.get("weg"):
        return False
    m = werkzeuge_kern.maschine()
    for e in (q.get("mcp") or {}).values():
        if not werkzeuge_kern.ist_hub_eintrag(e) or m not in e.get("maschinen", [m]):
            continue
        if harness not in werkzeuge_kern.harnesses_aufloesen(e.get("harnesses", []), "mcp", reg):
            continue
        if harness == werkzeuge_codex.HARNESS:
            return not werkzeuge_familie.ist_stdio_zelle(ad)
        if werkzeuge_familie.HUB_VAR in json.dumps(werkzeuge_kern.mcp_wert(e, ad.get("form"), ad)):
            return True
    return False


def token_sicherstellen(argv):
    """Exit 0 Datei da (mit --wert: Token auf stdout), 1 nicht anlegbar/unbrauchbar (eine Zeile auf
    stderr, ohne Wert), 2 Bedienfehler, 3 Harness braucht keine Variable (nichts angelegt)."""
    harness, rest = harness_aus(argv)
    wert = "--wert" in rest
    if [a for a in rest if a != "--wert"]:
        print(USAGE, file=sys.stderr)
        return 2
    if wert and sys.stdout.isatty():
        print("wb-hub: --wert nur in eine Pipe oder Variable, nicht auf ein Terminal", file=sys.stderr)
        return 2
    if harness:
        try:
            if not token_variable_noetig(harness):
                return 3
        except (werkzeuge_kern.FehlerInQuelle, ImportError) as e:
            print("wb-hub: Quelle oder Adapter unlesbar, Bedarf fuer %s unbekannt: %s" % (harness, e), file=sys.stderr)
            return 1
    fehler = token_ordner_fehler()
    if fehler:
        print("wb-hub: Tokendatei nicht angelegt: " + fehler, file=sys.stderr)
        return 1
    t = None
    for _ in range(3):     # ein gleichzeitig anlegender Prozess hat die Datei evtl. noch leer
        try:
            t = wb_hub_kern.token_laden()
            break
        except SystemExit as e:
            grund = str(e.code)
        except OSError as e:
            grund = "wb-hub: Tokendatei nicht anlegbar (%s)" % type(e).__name__
        time.sleep(0.1)
    if not t:
        print(grund, file=sys.stderr)
        return 1
    if wert:
        sys.stdout.write(t)
    return 0


def stdio(argv):
    """Zeilen-JSON von stdin an den Hub, Antworten nach stdout. Eine Sitzung je Prozess."""
    harness, _ = harness_aus(argv)
    sitz = None

    def schreiben(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    for zeile in sys.stdin:
        zeile = zeile.strip()
        if not zeile:
            continue
        try:
            m = json.loads(zeile)
        except ValueError:
            schreiben({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        if not isinstance(m, dict):
            continue
        rid = m.get("id")
        try:
            if m.get("method") == "initialize":
                if sitz is not None:
                    sitz.beenden()
                sitz = Sitzung(harness)
                obj = sitz.starten(m)
            elif sitz is None:
                obj = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32600, "message": "erst initialize"}}
            else:
                obj = sitz.anfrage(m)
        except HubFehler as e:
            if rid is None:
                continue
            obj = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(e)}}
        if obj is not None and rid is not None:
            schreiben(obj)
    if sitz is not None:
        sitz.beenden()
    return 0


def _mit_sitzung(harness, fn):
    sitz = Sitzung(harness)
    try:
        sitz.starten()
        return fn(sitz)
    finally:
        sitz.beenden()


def tools(argv):
    harness, rest = harness_aus(argv)
    if rest:
        print("wb-hub tools [--harness <h>]", file=sys.stderr)
        return 2
    try:
        def holen(sitz):
            return sitz.anfrage({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        obj = _mit_sitzung(harness, holen)
    except HubFehler as e:
        print("wb-hub: %s" % e, file=sys.stderr)
        return 1
    if obj is None or "error" in obj:
        print("wb-hub: tools/list: %s" % ((obj or {}).get("error") or {}).get("message", "leer"), file=sys.stderr)
        return 1
    for t in obj["result"].get("tools", []):
        zeilen = (t.get("description") or "").splitlines()
        print("%s\t%s" % (t.get("name"), zeilen[0] if zeilen else ""))
    return 0


def call(argv):
    harness, rest = harness_aus(argv)
    if not rest or len(rest) > 2 or "-" not in rest[0]:
        print("wb-hub call <server-tool> [json-argumente] [--harness <h>]", file=sys.stderr)
        return 2
    try:
        args = json.loads(rest[1]) if len(rest) == 2 else {}
    except ValueError:
        print("wb-hub: Argumente sind kein JSON", file=sys.stderr)
        return 2
    if not isinstance(args, dict):
        print("wb-hub: Argumente muessen ein JSON-Objekt sein", file=sys.stderr)
        return 2
    try:
        def aufrufen(sitz):
            return sitz.anfrage({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                 "params": {"name": rest[0], "arguments": args}})
        obj = _mit_sitzung(harness, aufrufen)
    except HubFehler as e:
        print("wb-hub: %s" % e, file=sys.stderr)
        return 1
    if obj is None or "error" in obj:
        print("wb-hub: %s" % ((obj or {}).get("error") or {}).get("message", "leer"), file=sys.stderr)
        return 1
    r = obj["result"]
    for c in r.get("content", []):
        if isinstance(c, dict) and c.get("type") == "text":
            print(c.get("text", ""))
    return 1 if r.get("isError") else 0


def status(argv):
    if argv:
        print("wb-hub status", file=sys.stderr)
        return 2
    p = port()
    try:
        socket.create_connection(("127.0.0.1", p), 0.5).close()
    except OSError:
        print("Hub: nicht erreichbar auf 127.0.0.1:%d" % p)
        return 1
    # Ohne Token: der Hub verlangt ihn fuer jede Anfrage, 401 belegt also, dass er antwortet.
    try:
        code, _, _ = senden(p, "", None, None, None, methode="GET")
    except HubFehler:
        code = None
    print("Hub: laeuft auf 127.0.0.1:%d (HTTP %s ohne Token)" % (p, code))
    try:
        q, _ = werkzeuge_kern.laden()
    except werkzeuge_kern.FehlerInQuelle as e:
        print("Quelle: %s" % e)
        return 1
    state = os.environ.get("WB_HUB_STATE") or os.path.join(werkzeuge_kern.home(), ".local", "state", "wb-hub")
    for name in sorted((q.get("mcp") or {})):
        cache = os.path.isfile(os.path.join(state, "%s.tools.json" % name))
        print("  %-12s Werkzeugliste im Cache: %s" % (name, "ja" if cache else "nein"))
    return 0


USAGE = """wb-hub serve [--port <n>]               Hub im Vordergrund (Start durch launchd/systemd)
wb-hub token-header                     Authorization-JSON fuer headersHelper (Exit 1 ohne Token)
wb-hub token-sicherstellen [--harness <h>] [--wert]
                                        Tokendatei anlegen, ohne Hub (Exit 3: <h> braucht kein Token)
wb-hub stdio [--harness <h>]            stdio-MCP-Bruecke zum Hub
wb-hub tools [--harness <h>]            Werkzeugnamen des Hubs
wb-hub call <server-tool> [json] [--harness <h>]
wb-hub status                           Hub erreichbar, Backends aus der Quelle"""

BEFEHLE = {"token-header": token_header, "token-sicherstellen": token_sicherstellen, "stdio": stdio, "tools": tools, "call": call, "status": status}


def main(argv):
    args = argv[1:]
    if not args or args[0] not in BEFEHLE:
        print(USAGE, file=sys.stderr)
        return 2
    return BEFEHLE[args[0]](args[1:])
