"""werkzeuge_codex -- Codex-Adapter fuer `wb-werkzeuge` (Spur S3).

Plan: ~/AI/_recherche/werkzeug-plan-2026-10-13.md (2.2, Zeile S3) und Hub-Entwurf 5.1.

MCP: Codex bekommt GENAU EINEN Markerblock `[mcp_servers.werkbank]` (url + bearer_token_env_var)
in ~/.codex/config.toml, nicht je Server einen Block. Alles ausserhalb der Marker bleibt
bytegleich (TOML wird ohne Bibliothek als Text bearbeitet), vor dem Schreiben liegt ein
Snapshot, nach dem Schreiben wird das Ganze geparst und bei Fehler zurueckgerollt. Ein von
Hand geaenderter Block oder ein Handeintrag `[mcp_servers.werkbank]` ohne Marker ist
ABGEWICHEN und wird nicht ueberschrieben (Block: nur mit `apply --force codex werkbank`).

HOOKS: aus dem Abschnitt "hooks" der Quelle wird ~/.codex/hooks.json ergaenzt. Eine Gruppe
gehoert der Werkbank, wenn Ereignis, Matcher und Befehl uebereinstimmen. Es werden nur
Gruppen ANGEHAENGT (die Gruppenindizes der vorhandenen Hooks, auf die sich die trusted_hash-
Eintraege in config.toml beziehen, bleiben gleich). Der Aufruf von `wb-chat-hook-install`
bleibt, was er ist: er haengt seinen Chat-Hook mit anderem Befehl an und prueft den Befehl,
nicht die Datei -- beide Seiten doppeln sich nie. Den trusted_hash bildet Codex selbst; seine
Regel ist von aussen nicht gemessen, deshalb meldet `status` fehlende Vertrauenseintraege im
Feld grund, statt sie zu raten.

PROMPTS: Weg "leer" (kein Prompt-Ordner im Codex-Binary belegt, S0 13.10.).

Eingebunden wird der Adapter von `wb-werkzeuge` (registrieren): ueber die Haken `bewerten` (ersetzt
die Eintraege, die der Kern fuer Codex als OFFEN meldet), `anwenden` und `zustaendig`/`main`
(`entfernen codex`) von werkzeuge_kern.adapter_registrieren. Kern-Funktionen
(Markerblock, Snapshots, Statusdatei) kommen aus werkzeuge_kern.
"""
import datetime
import json
import os
import re
import sys

import atomar_schreiben
import werkzeuge_kern as kern

HARNESS = "codex"
HUB_NAME = "werkbank"
HUB_PORT = 8790
HUB_TOKEN_VAR = "WB_HUB_TOKEN"
PROMPTS_GRUND = "kein Prompt-Ordner im Codex-Binary belegt (S0, 13.10.)"


def hub_url(q):
    """Endpunkt fuer Codex: Port aus hub.port der Quelle, sonst 8790 (wie werkzeuge_claude.hub_url)."""
    port = ((q.get("hub") or {}).get("port")) or HUB_PORT
    return "http://127.0.0.1:%d/mcp?harness=codex" % int(port)


def mcp_block(url, stdio=None):
    """Der Block fuer den Hub-Eintrag. Mit `stdio` = (befehl, args) (Registry toolAdapter.mcp.hub = "stdio")
    die tokenfreie Bruecke `wb-hub stdio`, sonst HTTP mit Bearer aus WB_HUB_TOKEN."""
    if stdio:
        return '[mcp_servers.%s]\ncommand = %s\nargs = %s' % (HUB_NAME, json.dumps(stdio[0]), json.dumps(stdio[1]))
    return '[mcp_servers.%s]\nurl = "%s"\nbearer_token_env_var = "%s"' % (HUB_NAME, url, HUB_TOKEN_VAR)


def stdio_von(ad):
    """(befehl, args) der Bruecke, wenn die Registry-Zelle hub "stdio" verlangt, sonst None."""
    import werkzeuge_familie
    return werkzeuge_familie.stdio_befehl(HARNESS) if werkzeuge_familie.ist_stdio_zelle(ad) else None


# ---------------------------------------------------------------- TOML ohne Bibliothek

def _kopf_name(zeile):
    """Tabellenname einer Kopfzeile `[a.b]` / `[[a.b]]` ohne Anfuehrungszeichen, sonst None."""
    m = re.match(r"^\s*(\[\[?)\s*(.*?)\s*\]\]?\s*(#.*)?$", zeile)
    if not m:
        return None
    teile = re.findall(r'"[^"]*"|\'[^\']*\'|[^.\s]+', m.group(2))
    return (m.group(1), tuple(t.strip("\"'") for t in teile))


def toml_pruefen(text):
    """Echter Parser, wenn tomllib da ist (Python >= 3.11), sonst eine leichte Pruefung:
    unvollstaendige oder doppelte Tabellenkoepfe und Zeilen im Block, die kein
    `schluessel = wert` sind. Wirft ValueError."""
    try:
        import tomllib
    except ImportError:
        tomllib = None
    if tomllib is not None:
        tomllib.loads(text)
        return
    gesehen = set()
    for n, z in enumerate(text.split("\n"), 1):
        s = z.strip()
        if s.startswith("["):
            k = _kopf_name(z)
            if k is None:
                raise ValueError("Zeile %d: Tabellenkopf unvollstaendig" % n)
            if k[0] == "[":
                if k[1] in gesehen:
                    raise ValueError("Zeile %d: Tabelle doppelt" % n)
                gesehen.add(k[1])
    anfang, ende = kern._marker("mcp", HUB_NAME, "#")
    inhalt = kern.marker_lesen(text, "mcp", HUB_NAME)
    for z in (inhalt or "").split("\n"):
        if z.strip() and not z.lstrip().startswith("#") and not z.lstrip().startswith("["):
            if not re.match(r'^[A-Za-z0-9_-]+\s*=\s*("[^"\n]*"|\'[^\'\n]*\'|true|false|-?\d+(\.\d+)?|\[.*\])\s*(#.*)?$',
                            z.strip()):
                raise ValueError("Block: Zeile ist kein schluessel = wert")


def _ohne_block(text, art, name):
    anfang, ende = kern._marker(art, name, "#")
    zeilen = text.split("\n")
    if anfang in zeilen:
        a = zeilen.index(anfang)
        if ende in zeilen[a + 1:]:
            e = zeilen.index(ende, a + 1)
            return "\n".join(zeilen[:a] + zeilen[e + 1:])
    return text


def handeintrag_vorhanden(text, name):
    """True, wenn ausserhalb der Marker ein Eintrag fuer mcp_servers.<name> steht
    (Tabellenkopf, gepunkteter Schluessel oder Eintrag unter [mcp_servers])."""
    tabelle = ()
    for z in _ohne_block(text, "mcp", name).split("\n"):
        s = z.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("["):
            k = _kopf_name(z)
            tabelle = k[1] if k else ()
            if k and k[1][:2] == ("mcp_servers", name):
                return True
            continue
        m = re.match(r"^([^=]+?)\s*=", s)
        if not m:
            continue
        teile = tuple(t.strip("\"'") for t in re.findall(r'"[^"]*"|\'[^\']*\'|[^.\s]+', m.group(1)))
        if tabelle == () and teile[:2] == ("mcp_servers", name):
            return True
        if tabelle == ("mcp_servers",) and teile[:1] == (name,):
            return True
    return False


def block_entfernen_text(text, art, name):
    """Der Text ohne den Markerblock und ohne die eine Leerzeile davor, die marker_ersetzen
    beim Anhaengen setzt. -> (neuer_text, entfernt)."""
    anfang, ende = kern._marker(art, name, "#")
    zeilen = text.split("\n")
    if anfang not in zeilen:
        return text, False
    a = zeilen.index(anfang)
    if ende not in zeilen[a + 1:]:
        raise kern.MarkerFehler("Anfangsmarker ohne Endmarker")
    e = zeilen.index(ende, a + 1)
    von = a - 1 if a > 0 and zeilen[a - 1] == "" and a - 1 > 0 else a
    return "\n".join(zeilen[:von] + zeilen[e + 1:]), True


def _datei_lesen(pfad):
    """-> text oder None (fehlt). ZielUnlesbar bei Lesefehler, Nicht-UTF-8 oder CRLF."""
    if not os.path.exists(pfad):
        return None
    try:
        with open(pfad, encoding="utf-8", newline="") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        raise kern.ZielUnlesbar("Datei nicht lesbar")
    if "\r" in text:
        raise kern.ZielUnlesbar("CRLF-Zeilenenden werden nicht unterstuetzt")
    return text


# ---------------------------------------------------------------- Status MCP

def _basis(harness, art, name, ziel, zustand, grund=None):
    return {"harness": harness, "art": art, "name": name, "ziel": ziel, "zustand": zustand, "grund": grund}


def _mcp_eintrag(ad, state, url):
    r = _basis(HARNESS, "mcp", HUB_NAME, ad["ziel"], "OFFEN")
    r["_codex"] = "mcp"
    stdio = stdio_von(ad)
    wert = {"command": stdio[0], "args": stdio[1]} if stdio else {"url": url, "bearer_token_env_var": HUB_TOKEN_VAR}
    r["wert"], r["datei"] = wert, kern.pfad_aufloesen(ad["ziel"])
    r["block"] = mcp_block(url, stdio)
    try:
        text = _datei_lesen(r["datei"])
        if text is not None:
            try:
                toml_pruefen(text)
            except Exception as e:
                raise kern.ZielUnlesbar("kein gueltiges TOML (%s)" % type(e).__name__)
            try:
                aktuell = kern.marker_lesen(text, "mcp", HUB_NAME)
                if aktuell is None and kern._marker("mcp", HUB_NAME, "#")[0] in text.split("\n"):
                    raise kern.MarkerFehler("Anfangsmarker ohne Endmarker")
            except kern.MarkerFehler as e:
                raise kern.ZielUnlesbar(str(e))
        else:
            aktuell = None
    except kern.ZielUnlesbar as ex:
        r["zustand"], r["grund"] = "ZIEL-UNLESBAR", str(ex)
        return r
    if aktuell is None:
        if text is not None and handeintrag_vorhanden(text, HUB_NAME):
            r["zustand"], r["grund"] = "ABGEWICHEN", "Handeintrag [mcp_servers.%s] ohne Marker" % HUB_NAME
            r["hand"] = True
        else:
            r["zustand"] = "FEHLT"
        return r
    if text is not None and handeintrag_vorhanden(text, HUB_NAME):
        r["zustand"], r["grund"] = "ABGEWICHEN", "zusaetzlich ein Handeintrag [mcp_servers.%s] ausserhalb der Marker" % HUB_NAME
        r["hand"] = True
        return r
    r["aktuell_sha"] = kern._wert_sha(aktuell)
    if aktuell.strip("\n") == r["block"]:
        r["zustand"] = "GLEICH"
        return r
    rec = state["eintraege"].get(kern.state_schluessel(HARNESS, "mcp", HUB_NAME))
    if rec and rec.get("sha") == r["aktuell_sha"]:
        r["zustand"] = "VERALTET"
    else:
        r["zustand"] = "ABGEWICHEN"
        r["grund"] = "von Hand geaendert" if rec else "Block mit Marker, aber nicht von der Werkbank geschrieben"
    return r


# ---------------------------------------------------------------- Status Hooks

def _ereignis_snake(ev):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", ev).lower()


def hook_specs(e):
    """[(ereignis, matcher|None, befehl, timeout)] aus einem Hook-Eintrag der Quelle."""
    out = []
    for roh in e["ereignisse"]:
        ev, _, m = roh.partition(":")
        out.append((ev, m or None, e["befehl"], e.get("timeout", 10)))
    return out


def _gruppe_passt(g, matcher, befehl):
    if not isinstance(g, dict) or (g.get("matcher") or None) != matcher:
        return None
    for hi, h in enumerate(g.get("hooks") or []):
        if isinstance(h, dict) and h.get("command") == befehl:
            return hi
    return None


def _hooks_eintrag(name, e, ad, trust_datei, state):
    r = _basis(HARNESS, "hooks", name, ad["ziel"], "OFFEN")
    r["_codex"], r["datei"] = "hooks", kern.pfad_aufloesen(ad["ziel"])
    specs = hook_specs(e)
    r["specs"] = specs
    r["wert"] = [list(s) for s in specs]
    try:
        text, daten = kern.ziel_lesen(ad["ziel"])
        haken = daten.get("hooks", {})
        if not isinstance(haken, dict):
            raise kern.ZielUnlesbar("hooks ist kein Objekt")
        for ev in {s[0] for s in specs}:
            if not isinstance(haken.get(ev, []), list):
                raise kern.ZielUnlesbar("hooks.%s ist keine Liste" % ev)
    except kern.ZielUnlesbar as ex:
        r["zustand"], r["grund"] = "ZIEL-UNLESBAR", str(ex)
        return r
    fehlt, abweich, orphan, stellen, gefunden = [], [], [], [], []
    for (ev, matcher, befehl, frist) in specs:
        gruppen = haken.get(ev, [])
        stelle = None
        for gi, g in enumerate(gruppen):
            hi = _gruppe_passt(g, matcher, befehl)
            if hi is not None:
                stelle = (gi, hi)
                break
        if stelle is None:
            fehlt.append((ev, matcher))
            for gi, g in enumerate(gruppen):
                if isinstance(g, dict) and any(isinstance(h, dict) and h.get("command") == befehl
                                               for h in g.get("hooks") or []):
                    orphan.append((ev, g.get("matcher")))
            continue
        h = gruppen[stelle[0]]["hooks"][stelle[1]]
        stellen.append((ev, stelle[0], stelle[1]))
        gefunden.append([ev, matcher, befehl, h.get("timeout")])
        if h.get("type") != "command" or h.get("timeout") != frist:
            abweich.append((ev, matcher))
    r["stellen"], r["fehlende"] = stellen, fehlt
    r["gefunden"] = gefunden
    r["aktuell_sha"] = kern._wert_sha(sorted(gefunden, key=str))
    n = len(specs)
    if orphan:
        r["zustand"] = "ABGEWICHEN"
        r["grund"] = "Hook-Befehl steht unter anderem Matcher (von Hand geaendert); wird nicht angefasst"
    elif abweich:
        rec = state["eintraege"].get(kern.state_schluessel(HARNESS, "hooks", name))
        if rec and rec.get("sha") == r["aktuell_sha"] and not fehlt:
            r["zustand"] = "VERALTET"
        else:
            r["zustand"] = "ABGEWICHEN"
            r["grund"] = "Timeout oder Typ von Hand geaendert"
    elif fehlt:
        r["zustand"] = "FEHLT"
        r["grund"] = None if len(fehlt) == n else "%d von %d Ereignissen fehlen" % (len(fehlt), n)
    else:
        r["zustand"] = "GLEICH"
    if r["zustand"] in ("GLEICH", "VERALTET") and trust_datei and stellen:
        vertrauen = _vertrauen_fehlt(r["datei"], stellen, trust_datei)
        if vertrauen:
            r["grund"] = ("trusted_hash fehlt in config.toml fuer %d Hook-Gruppe(n): Codex fuehrt sie nicht aus "
                          "(Hash-Regel von aussen ungemessen)" % vertrauen)
    return r


def _vertrauen_fehlt(hooks_datei, stellen, trust_datei):
    try:
        with open(trust_datei, encoding="utf-8") as f:
            conf = f.read()
    except (OSError, UnicodeDecodeError):
        return 0
    return sum(1 for (ev, gi, hi) in stellen
               if "%s:%s:%d:%d" % (hooks_datei, _ereignis_snake(ev), gi, hi) not in conf)


# ---------------------------------------------------------------- bewerten (Kern erweitern)

def _bewerten(roh, q, reg, state, nur_harness=None, nur_art=None):
    """Haken `bewerten`: ersetzt die OFFEN-Eintraege des Kerns fuer codex durch die eigenen."""
    ad = {x["id"]: x.get("toolAdapter") or {} for x in reg["harnesses"]}.get(HARNESS) or {}
    mcp_ad, hook_ad, prompt_ad = ad.get("mcp"), ad.get("hooks"), ad.get("prompts")
    mcp_aktiv = isinstance(mcp_ad, dict) and mcp_ad.get("format") == "toml-marker" and mcp_ad.get("ziel")
    hook_aktiv = (isinstance(hook_ad, dict) and hook_ad.get("weg") == "wb-chat-hook-install"
                  and hook_ad.get("ziel"))
    trust_datei = None
    if mcp_aktiv:
        trust_datei = kern.pfad_aufloesen(mcp_ad["ziel"])
    elif hook_aktiv:
        trust_datei = os.path.join(os.path.dirname(kern.pfad_aufloesen(hook_ad["ziel"])), "config.toml")
    aus, mcp_da = [], False
    for x in roh:
        if x["harness"] == HARNESS and x["art"] == "mcp" and mcp_aktiv and x["zustand"] == "OFFEN" \
                and not (q["mcp"][x["name"]].get("status")):
            mcp_da = True
            if x["name"] == HUB_NAME:
                continue  # der eigene Eintrag kommt unten aus _mcp_eintrag, nicht als zweite Zeile
            x = dict(x, grund="aufgegangen im Hub-Eintrag mcp.%s (ein Block statt je Server)" % HUB_NAME)
            aus.append(x)
            continue
        if x["harness"] == HARNESS and x["art"] == "hooks" and hook_aktiv and x["zustand"] == "OFFEN" \
                and not (q["hooks"][x["name"]].get("status")):
            aus.append(_hooks_eintrag(x["name"], q["hooks"][x["name"]], hook_ad, trust_datei, state))
            continue
        aus.append(x)
    if mcp_da:
        aus.append(_mcp_eintrag(mcp_ad, state, hub_url(q)))
    if (nur_art in (None, "prompts") and (not nur_harness or HARNESS in nur_harness)
            and isinstance(prompt_ad, dict) and prompt_ad.get("weg") == "leer"):
        # LEER nur mit Messfeld; ohne gemessen ist "leer" ein ungemessener Stand (wie im Kern)
        if prompt_ad.get("gemessen"):
            aus.append(_basis(HARNESS, "prompts", HUB_NAME, None, "LEER", PROMPTS_GRUND))
        else:
            aus.append(_basis(HARNESS, "prompts", HUB_NAME, None, "OFFEN", kern.UNGEMESSEN_GRUND))
    aus.sort(key=lambda x: kern.ARTEN.index(x["art"]))
    return aus


# ---------------------------------------------------------------- schreiben

def _mcp_schreiben(x, snapshots, state):
    block = x["block"]
    snap = kern.markerblock_schreiben(x["datei"], HARNESS, "mcp", HUB_NAME, block,
                                      pruefer=toml_pruefen, snapshots=snapshots)
    state["eintraege"][kern.state_schluessel(HARNESS, "mcp", HUB_NAME)] = {
        "ziel": x["ziel"], "sha": kern._wert_sha(block),
        "zeit": datetime.datetime.now().isoformat(timespec="seconds")}
    return snap


def _hooks_schreiben(x, snapshots, state):
    text, daten = kern.ziel_lesen(x["ziel"])
    haken = daten.setdefault("hooks", {})
    for (ev, matcher, befehl, frist) in x["specs"]:
        gruppen = haken.setdefault(ev, [])
        stelle = None
        for g in gruppen:
            hi = _gruppe_passt(g, matcher, befehl)
            if hi is not None:
                stelle = g["hooks"][hi]
                break
        if stelle is not None:
            stelle["type"], stelle["timeout"] = "command", frist
            continue
        g = {"hooks": [{"type": "command", "command": befehl, "timeout": frist}]}
        if matcher is not None:
            g = dict([("matcher", matcher)] + list(g.items()))
        gruppen.append(g)
    neu = kern.json_serialisieren(daten, text)
    snap = snapshots.sichern(HARNESS, x["datei"]) if text is not None else None
    os.makedirs(os.path.dirname(x["datei"]), exist_ok=True)
    modus = (os.stat(x["datei"]).st_mode & 0o7777) if text is not None else 0o644
    atomar_schreiben.schreiben(x["datei"], neu, modus=modus, newline="")
    try:
        with open(x["datei"], encoding="utf-8") as f:
            ok = json.loads(f.read()) == daten
    except ValueError:
        ok = False
    if not ok:
        if snap:
            atomar_schreiben.kopieren(snap, x["datei"])
        elif text is None:
            os.unlink(x["datei"])
        raise kern.ZielUnlesbar("Ergebnis nicht pruefbar, zurueckgerollt")
    state["eintraege"][kern.state_schluessel(HARNESS, "hooks", x["name"])] = {
        "ziel": x["ziel"], "sha": kern._wert_sha(sorted([list(s) for s in x["specs"]], key=str)),
        "zeit": datetime.datetime.now().isoformat(timespec="seconds")}
    return snap


def _anwenden(q, reg, nur_harness, nur_art, force, zeilen):
    """Haken `anwenden`: schreibt nach dem Kern die Codex-Eintraege (der Kern schreibt nur seine
    json-pfad-Eintraege, nie die hier ersetzten). Haengt Berichtszeilen an zeilen an, gibt die Zahl zurueck."""
    state = kern.state_laden()
    snapshots, codex_n = kern.Snapshots(), 0
    for x in _bewerten(kern._bewerten_kern(q, reg, state, nur_harness, nur_art), q, reg, state,
                       nur_harness, nur_art):
        if x.get("_codex") is None or x["harness"] != HARNESS:
            continue
        z = x["zustand"]
        ist_force = force is not None and force[0] == HARNESS and force[1] in (
            x["name"], "%s.%s" % (x["art"], x["name"]))
        if z == "ABGEWICHEN" and ist_force and x.get("hand"):
            zeilen.append("ABGEWICHEN  codex %s.%s: Handeintrag ausserhalb der Marker; bitte von Hand "
                          "entfernen (--force aendert nur den Markerblock)" % (x["art"], x["name"]))
            continue
        if z == "ABGEWICHEN" and not ist_force:
            zeilen.append("ABGEWICHEN  codex %s.%s: bleibt stehen (%s); --force sichert und ueberschreibt"
                          % (x["art"], x["name"], x["grund"]))
            continue
        if z == "ABGEWICHEN" and x["art"] == "hooks" and x["grund"].startswith("Hook-Befehl"):
            zeilen.append("ABGEWICHEN  codex hooks.%s: %s; --force aendert das nicht" % (x["name"], x["grund"]))
            continue
        if z not in ("FEHLT", "VERALTET", "ABGEWICHEN"):
            continue
        try:
            snap = (_mcp_schreiben if x["_codex"] == "mcp" else _hooks_schreiben)(x, snapshots, state)
        except (kern.ZielUnlesbar, kern.MarkerFehler) as ex:
            zeilen.append("ZIEL-UNLESBAR  codex %s: %s" % (x["ziel"], ex))
            continue
        except OSError:
            # Ein schon geschriebener Eintrag behaelt seinen Besitzvermerk, sonst meldet der naechste Lauf ABGEWICHEN.
            if codex_n:
                kern.state_speichern(state)
            raise
        zeilen.append("GESCHRIEBEN  codex %s.%s -> %s%s" % (x["art"], x["name"], x["ziel"],
                                                           " (Snapshot %s)" % snap if snap else " (neu angelegt)"))
        codex_n += 1
    if codex_n:
        kern.state_speichern(state)
    return codex_n




def entfernen():
    """`wb-werkzeuge entfernen codex`: nimmt den Markerblock aus config.toml (mit Snapshot und
    Parse-Pruefung) und loescht den Besitzvermerk. Der Rest der Datei bleibt bytegleich."""
    q, reg = kern.laden()
    mcp_ad = ({x["id"]: x.get("toolAdapter") or {} for x in reg["harnesses"]}.get(HARNESS) or {}).get("mcp")
    if not (isinstance(mcp_ad, dict) and mcp_ad.get("format") == "toml-marker"):
        return ["entfernen: codex hat keinen toml-marker-Weg"], 1
    datei = kern.pfad_aufloesen(mcp_ad["ziel"])
    try:
        text = _datei_lesen(datei)
        if text is None:
            return ["entfernen: %s fehlt, nichts zu tun" % mcp_ad["ziel"]], 0
        neu, entfernt = block_entfernen_text(text, "mcp", HUB_NAME)
    except (kern.ZielUnlesbar, kern.MarkerFehler) as ex:
        return ["ZIEL-UNLESBAR  codex %s: %s" % (mcp_ad["ziel"], ex)], 1
    if not entfernt:
        return ["entfernen: kein Markerblock in %s" % mcp_ad["ziel"]], 0
    try:
        toml_pruefen(neu)
    except Exception as e:
        return ["entfernen: Ergebnis nicht parsebar (%s), nichts geschrieben" % type(e).__name__], 1
    snap = kern.Snapshots().sichern(HARNESS, datei)
    atomar_schreiben.schreiben(datei, neu, modus=os.stat(datei).st_mode & 0o7777, newline="")
    state = kern.state_laden()
    state["eintraege"].pop(kern.state_schluessel(HARNESS, "mcp", HUB_NAME), None)
    kern.state_speichern(state)
    return ["ENTFERNT  codex mcp.%s aus %s (Snapshot %s)" % (HUB_NAME, mcp_ad["ziel"], snap)], 0


def _zustaendig(argv):
    return len(argv) == 3 and argv[1] == "entfernen" and argv[2] == HARNESS


def _main(argv):
    try:
        zeilen, rc = entfernen()
    except kern.FehlerInQuelle as ex:
        for f in ex.fehler:
            print("FEHLER %s %s: %s" % (f["code"], f["eintrag"], f["text"]), file=sys.stderr)
        return 2
    print("\n".join(zeilen))
    return rc


def registrieren():
    """Traegt den Codex-Adapter in den Kern ein (idempotent)."""
    kern.adapter_registrieren("codex", bewerten=_bewerten, anwenden=_anwenden,
                              zustaendig=_zustaendig, main=_main)
