"""werkzeuge_dateien -- Dateiwege von `wb-werkzeuge` (Installer pi-Extensions, Prompt-Ordner).

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

PROMPTS (W2c, 14.10.): jeder Quelleintrag `prompts.<name>` (Feld `datei`: Markdown mit Frontmatter
`description`, ~ und absolute Pfade gelten, sonst relativ zum Quellordner) geht in den Befehlsordner
jedes Harness, dessen Registry-Zelle `toolAdapter.prompts` den Weg `markdown-dir` (Datei
<ziel>/<name>.md, Inhalt wie die Quelle) oder `recipe-dir` (goose: <ziel>/<name>.yaml mit
version/title/description/prompt) traegt. Zustaende und Besitz wie bei den Extensions. Claude
(`plugin-werkbank`) bedient werkzeuge_claude; ein Harness ohne diese Wege bleibt beim Kern (OFFEN/LEER).
ANWEISUNGEN: eine Zelle `toolAdapter.anweisungen.erinnerung` mit Weg `pi-erweiterung` (pi: die
Erweiterung, die die Erinnerung je Nachricht einspielt) wird wie eine pi-Extension installiert.

Zustaende: die des Kerns (GLEICH, FEHLT, VERALTET, ABGEWICHEN, OFFEN). FREMD wird in `status`
als ABGEWICHEN gemeldet, Begruendung im Feld `grund` beginnt mit "FREMD:". Das Schema
werkzeuge-status/1 kennt FREMD nicht, wie der Claude-Adapter es auch abbildet.

`adopt pi <eintrag>` uebernimmt eine Zieldatei ohne Bytebeaenderung (Kern-Befehl; dieser Modul
liefert dafuer `aktuell_sha`).

MCP-BLOECKE (W2a, 14.10.). Zwei MCP-Formate sind keine JSON-Dateien: gptme (`toml-marker`,
config.toml) und goose (`yaml-marker`, config.yaml). Sie tragen den Hub-Eintrag `werkbank` als
Markerblock `# >>> werkbank mcp werkbank` ... `# <<<` in der Bruecken-Form `wb-hub stdio --harness
<form>` (Registry toolAdapter.mcp: format, form, hub "stdio"). Wie bei Codex gilt: alles ausserhalb der
Marker bleibt bytegleich, der Block gehoert der Werkbank nur, solange die Statusdatei seine
Pruefsumme kennt; ein Handeintrag `werkbank` ausserhalb der Marker ist ABGEWICHEN (adopt/--force),
vor jedem Schreiben liegt ein Snapshot, das Ergebnis wird VOR dem Schreiben geparst (TOML/YAML;
ohne tomllib bzw. PyYAML eine leichte Pruefung). Codex hat seinen eigenen Adapter (werkzeuge_codex)
und kein Feld `form`; diesen Weg nimmt nur, wessen Zelle `form` gptme oder goose traegt.
"""
import datetime
import hashlib
import json
import os
import re

import atomar_schreiben
import werkzeuge_familie as familie
import werkzeuge_kern as kern

# Quelle je Ziel-Dateiname, relativ zum Quellordner (werkzeuge.default.json liegt dort).
QUELLEN = {
    "wb-hub.ts": "pi-wb-hub.ts",
    "wb-inbox.ts": "inbox/pi-wb-inbox.ts",
    "wb-anweisung.ts": "pi-wb-anweisung.ts",
}
# hooks-Zellen mit diesen Wegen sind eine ganze Datei (Quelle im Feld `quelle` der Zelle), Eintrag hooks.wb-hooks.
HOOK_WEGE = ("pi-erweiterung", "plugin-bruecke")
HOOK_NAME = "wb-hooks"
PROMPT_WEGE = {"markdown-dir": ".md", "recipe-dir": ".yaml"}
PROMPT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
GRUND_OHNE_QUELLE = "keine Quelle im Repo (Plan 2.3: Quelle durch Entscheidung festlegen)"
GRUND_FREMD = "FREMD: nicht von der Werkbank geschrieben, bleibt stehen (adopt uebernimmt)"
GRUND_HAND = "von Hand geaendert"


def _sha_datei(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _prompt_wege(q, reg):
    """Die Prompt-Dateien je Harness mit Weg markdown-dir/recipe-dir: [(harness, "prompts", name, ziel, extra)].
    extra = {"datei": <Quellpfad laut Quelle>, "weg": <weg>, "fehler": <Grund oder None>}."""
    wege = []
    m = kern.maschine()
    for name, e in (q.get("prompts") or {}).items():
        if m not in e.get("maschinen", [m]) or e.get("status"):
            continue
        for h in kern.harnesses_aufloesen(e.get("harnesses", []), "prompts", reg):
            ad = kern.zelle(reg, h, "prompts")
            if not isinstance(ad, dict):
                continue
            weg = ad.get("weg") if ad.get("weg") in PROMPT_WEGE else ad.get("format")
            if weg not in PROMPT_WEGE or not ad.get("ziel"):
                continue
            fehler = None
            if not PROMPT_NAME.match(name):
                fehler = "Promptname %r: nur Buchstaben, Ziffern, _ und - (kein Pfadausbruch)" % name
            wege.append((h, "prompts", name, os.path.join(ad["ziel"], name + PROMPT_WEGE[weg]),
                         {"datei": e.get("datei", ""), "weg": weg, "fehler": fehler}))
    return wege


def _wege(q, reg):
    """Die Dateiwege je Harness aus Registry und Quelle: [(harness, art, name, ziel, extra)]. Ein Ziel,
    das schon der Hub-Eintrag belegt (wb-hub.ts), steht in `plugins.dateien` nicht noch einmal:
    zwei Eintraege fuer dieselbe Datei wuerden sich gegenseitig ABGEWICHEN melden. extra ist nur bei
    Prompts gesetzt (siehe _prompt_wege)."""
    wege = []
    hub = (q.get("mcp") or {}).get(kern.HUB_NAME)
    hub_hier = kern.ist_hub_eintrag(hub) and kern.maschine() in hub.get("maschinen", [kern.maschine()])
    anw_hier = any(kern.maschine() in e.get("maschinen", [kern.maschine()]) and not e.get("status")
                   and "nachricht" in (e.get("anlaesse") or list(kern.ANLAESSE)) and e.get("erinnerung")
                   for e in (q.get("anweisungen") or {}).values())
    for h in reg["harnesses"]:
        ad = h.get("toolAdapter") or {}
        mcp = ad.get("mcp") or {}
        if hub_hier and mcp.get("weg") == "pi-erweiterung":
            wege.append((h["id"], "mcp", kern.HUB_NAME, mcp["ziel"], None))
        hk = ad.get("hooks") or {}
        if hk.get("weg") in HOOK_WEGE and hk.get("ziel") and hk.get("quelle"):
            # Hook-Bruecke als Datei (W2b): pi-Extension bzw. opencode-Plugin ruft wb-hook-bruecke.
            wege.append((h["id"], "hooks", HOOK_NAME, hk["ziel"], None))
        plg = ad.get("plugins") or {}
        if plg.get("weg") == "dateien":
            for datei in plg.get("dateien", []):
                wege.append((h["id"], "plugins", datei, os.path.join(plg["ziel"], datei), None))
        erinnerung = (ad.get("anweisungen") or {}).get("erinnerung") or {}
        if anw_hier and erinnerung.get("weg") == "pi-erweiterung" and erinnerung.get("ziel"):
            wege.append((h["id"], "anweisungen", "erinnerung", erinnerung["ziel"], None))
    wege += _prompt_wege(q, reg)
    belegt = {(w[0], kern.pfad_aufloesen(w[3])) for w in wege if w[1] == "mcp"}
    return [w for w in wege if w[1] == "mcp" or (w[0], kern.pfad_aufloesen(w[3])) not in belegt]


def _frontmatter(text):
    """-> (description oder None, Rumpf ohne Frontmatter)."""
    if not text.startswith("---\n"):
        return None, text
    ende = text.find("\n---\n", 4)
    if ende < 0:
        return None, text
    m = re.search(r"^description:[ \t]*(.+?)[ \t]*$", text[4:ende], re.M)
    beschr = m.group(1).strip("\"'") if m else None
    return beschr, text[ende + 5:].lstrip("\n")


def _prompt_inhalt(name, weg, text):
    """Dateiinhalt (bytes) des Prompts fuer den Weg: markdown-dir wie die Quelle, recipe-dir als goose-Rezept
    (version/title/description/prompt; Beleg goose recipe list und validate im Test-HOME, 14.10.)."""
    if weg == "markdown-dir":
        return text.encode("utf-8")
    beschr, rumpf = _frontmatter(text)
    zeilen = ["version: 1.0.0", "title: " + json.dumps(name), "description: " + json.dumps(beschr or name),
              "prompt: |2"]
    zeilen += [("  " + z) if z else "" for z in rumpf.strip("\n").split("\n")]
    return ("\n".join(zeilen) + "\n").encode("utf-8")


def _vergleichen(r, harness, art, name, state):
    """Setzt den Zustand von r (datei, soll_sha gesetzt) gegen die Zieldatei und die Statusdatei."""
    if not os.path.lexists(r["datei"]):
        r["zustand"] = "FEHLT"
        return r
    try:
        ist = _sha_datei(r["datei"])
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


def _prompt_eintrag(r, name, extra, ordner):
    """Ein Prompt-Dateiweg: Quelle lesen, Inhalt erzeugen (r["inhalt"]), soll_sha setzen."""
    if extra["fehler"]:
        r["grund"] = extra["fehler"]
        return None
    if not extra["datei"]:
        r["grund"] = "prompts.%s hat kein Feld datei" % name
        return None
    quelle = kern._datei_da(extra["datei"], ordner)
    try:
        with open(quelle, encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        r["grund"] = "Quelldatei %s nicht lesbar" % extra["datei"]
        return None
    r["quelle"], r["wert"] = quelle, extra["datei"]
    r["inhalt"] = _prompt_inhalt(name, extra["weg"], text)
    r["soll_sha"] = hashlib.sha256(r["inhalt"]).hexdigest()
    return r


def _eintrag(harness, art, name, ziel, ordner, state, extra=None, rel=None):
    """Ein Dateiweg mit Zustand. Interne Felder (datei, quelle, soll_sha, aktuell_sha, fremd, inhalt)
    braucht apply/adopt; status gibt sie nicht aus (kern._oeffentlich). rel: Quelle aus der
    Registry-Zelle (hooks), sonst nach Dateiname aus QUELLEN."""
    datei = kern.pfad_aufloesen(ziel)
    r = {"harness": harness, "art": art, "name": name, "ziel": ziel, "zustand": "OFFEN", "grund": None,
         "wert": None, "datei": datei, "quelle": None, "fremd": False}
    if extra is not None:
        if _prompt_eintrag(r, name, extra, ordner) is None:
            return r
        return _vergleichen(r, harness, art, name, state)
    rel = rel or QUELLEN.get(os.path.basename(datei))
    r["wert"] = rel
    if rel is None:
        r["grund"] = GRUND_OHNE_QUELLE
        return r
    quelle = os.path.join(ordner, rel)
    if not os.path.isfile(quelle):
        r["grund"] = "Quelle %s fehlt neben werkzeuge.default.json" % rel
        return r
    r["quelle"] = quelle
    r["soll_sha"] = _sha_datei(quelle)
    return _vergleichen(r, harness, art, name, state)


def _eintraege(q, reg, state, nur_harness=None, nur_art=None):
    ordner = kern.quellordner()
    out = []
    for harness, art, name, ziel, extra in _wege(q, reg):
        if nur_harness and harness not in nur_harness:
            continue
        if nur_art and art != nur_art:
            continue
        zelle = (kern.zelle(reg, harness, "hooks") or {}) if art == "hooks" else {}
        r = _eintrag(harness, art, name, ziel, ordner, state, extra, zelle.get("quelle"))
        if zelle.get("alte_tabelle"):
            _alte_tabelle(r, zelle["alte_tabelle"])
        out.append(r)
    return out


def _alte_tabelle(r, ziel):
    """opencode (Review W2 F4): Liegt die alte Hook-Tabelle (~/.config/opencode/wb-hooks.json) noch da oder ist
    WB_HOOKS_TABELLE gesetzt, nimmt das Plugin den alten Weg, der fail-open ist, und die Bruecke laeuft nie.
    Status meldet das; apply sichert die Tabelle als Snapshot und entfernt sie."""
    hinweise = []
    if os.environ.get("WB_HOOKS_TABELLE"):
        hinweise.append("WB_HOOKS_TABELLE ist gesetzt: das Plugin nimmt die alte Tabelle (fail-open), "
                        "die Variable aus der Startumgebung entfernen")
    datei = kern.pfad_aufloesen(ziel)
    if os.path.lexists(datei):
        r["alte_tabelle"] = datei
        hinweise.append("alte Tabelle %s schaltet die Bruecke ab (fail-open); apply sichert und entfernt sie" % ziel)
        if r["zustand"] == "GLEICH":
            r["zustand"] = "VERALTET"
    if hinweise:
        r["grund"] = "; ".join(([r["grund"]] if r["grund"] else []) + hinweise)
    return r


# ---------------------------------------------------------------- Haken

def bewerten(eintraege, q, reg, state, nur_harness, nur_art):
    """Ersetzt die Kern-Eintraege dieser Dateiwege (OFFEN, weil die Form fehlt) durch den Dateizustand."""
    ours = _eintraege(q, reg, state, nur_harness, nur_art)
    schluessel = {(e["harness"], e["art"], e["name"]) for e in ours}
    rest = [x for x in eintraege if (x["harness"], x["art"], x["name"]) not in schluessel]
    mcp = {(x["harness"], x["art"], x["name"]): x for x in _marker_eintraege(eintraege, reg, state)}
    rest = [mcp.get((x["harness"], x["art"], x["name"]), x) for x in rest]
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
        if x.get("alte_tabelle") and z != "OFFEN" and (z != "ABGEWICHEN" or ist_force):
            snap_t = snaps.sichern(x["harness"], x["alte_tabelle"])
            if snap_t:
                os.unlink(x["alte_tabelle"])
                zeilen.append("ENTFERNT  %s: alte Tabelle %s (fail-open; Snapshot %s)" % (ref, x["alte_tabelle"], snap_t))
            else:
                zeilen.append("ZIEL-UNLESBAR  %s: alte Tabelle %s nicht gesichert, bleibt stehen" % (ref, x["alte_tabelle"]))
        if z in ("GLEICH", "OFFEN"):
            continue
        if z == "ABGEWICHEN" and not ist_force:
            hinweis = "adopt uebernimmt" if x["fremd"] else "--force sichert und ueberschreibt"
            zeilen.append("ABGEWICHEN  %s: bleibt stehen (%s); %s" % (ref, x["grund"], hinweis))
            continue
        datei = x["datei"]
        snap = snaps.sichern(x["harness"], datei) if z != "FEHLT" else None
        os.makedirs(os.path.dirname(datei), exist_ok=True)
        if "inhalt" in x:
            atomar_schreiben.schreiben(datei, x["inhalt"], modus=0o644)
        else:
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
    return geschrieben + _marker_anwenden(q, reg, nur_harness, nur_art, force, zeilen, snaps)


# ---------------------------------------------------------------- MCP-Bloecke (toml-marker, yaml-marker)

MCP_NAME = kern.HUB_NAME
FORM_FORMAT = {"gptme": "toml-marker", "goose": "yaml-marker"}
YAML_KOPF = re.compile(r"^extensions:[ \t]*(#.*)?$")
YAML_FLUSS = re.compile(r"^extensions:[ \t]*[\[{|>]")


def _toml_block(form):
    befehl, args = familie.stdio_befehl(form)
    return "\n".join(["[mcp]", "enabled = true", "", "[[mcp.servers]]", 'name = %s' % json.dumps(MCP_NAME),
                      "command = %s" % json.dumps(befehl), "args = %s" % json.dumps(args)])


def _yaml_block(form, mit_kopf=True):
    befehl, args = familie.stdio_befehl(form)
    zeilen = ["extensions:"] if mit_kopf else []
    zeilen += ["  %s:" % MCP_NAME, "    enabled: true", "    type: stdio", "    name: %s" % MCP_NAME,
               "    description: Werkbank-Hub (wb-hub stdio)", "    cmd: %s" % befehl, "    args:"]
    zeilen += ["    - %s" % a for a in args]
    zeilen += ["    envs: {}", "    timeout: 300"]
    return "\n".join(zeilen)


def _toml_pruefen(text):
    """tomllib (ab Python 3.11); sonst eine leichte Pruefung: Tabellenkoepfe vollstaendig und
    keine Tabelle doppelt (mehrzeilige Werte der Nutzerdatei lehnt sie nicht ab). Wirft ValueError."""
    try:
        import tomllib
    except ImportError:
        tomllib = None
    if tomllib is not None:
        tomllib.loads(text)
        return
    tabellen, aktuell = set(), ()
    for n, z in enumerate(text.split("\n"), 1):
        s = z.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("["):
            m = re.match(r"^(\[\[?)\s*([A-Za-z0-9_.\" '-]+?)\s*\]\]?\s*(#.*)?$", s)
            if not m:
                raise ValueError("Zeile %d: Tabellenkopf unvollstaendig" % n)
            aktuell = (m.group(1), m.group(2))
            if m.group(1) == "[":
                if aktuell in tabellen:
                    raise ValueError("Zeile %d: Tabelle doppelt" % n)
                tabellen.add(aktuell)


def _yaml_pruefen(text):
    """PyYAML, wenn da; sonst: keine Tabulatoren im Einzug, `extensions:` hoechstens einmal als Kopf."""
    try:
        import yaml
    except ImportError:
        yaml = None
    zeilen = text.split("\n")
    # PyYAML nimmt doppelte Schluessel still hin (der letzte gewinnt); goose tut das nicht.
    if sum(1 for z in zeilen if re.match(r"^extensions:", z)) > 1:
        raise ValueError("extensions doppelt")
    if yaml is not None:
        d = yaml.safe_load(text)
        if d is not None and not isinstance(d, dict):
            raise ValueError("Wurzel ist kein Mapping")
        return
    if any(re.match(r"^\s*\t", z) for z in zeilen):
        raise ValueError("Tabulator im Einzug")


def _ohne_block(text):
    anfang, ende = kern._marker("mcp", MCP_NAME, "#")
    zeilen = text.split("\n")
    if anfang in zeilen:
        a = zeilen.index(anfang)
        if ende in zeilen[a + 1:]:
            return "\n".join(zeilen[:a] + zeilen[zeilen.index(ende, a + 1) + 1:])
    return text


def _hand_toml(rest):
    """Ein [[mcp.servers]] mit name = "werkbank" ausserhalb der Marker."""
    in_servers = False
    for z in rest.split("\n"):
        s = z.strip()
        if s.startswith("["):
            in_servers = re.match(r"^\[\[\s*mcp\.servers\s*\]\]", s) is not None
        elif in_servers and re.match(r"^name\s*=\s*[\"']%s[\"']" % re.escape(MCP_NAME), s):
            return True
    return False


def _hand_yaml(rest):
    """extensions.werkbank ausserhalb der Marker."""
    try:
        import yaml
        d = yaml.safe_load(rest) or {}
        e = d.get("extensions") if isinstance(d, dict) else None
        return isinstance(e, dict) and MCP_NAME in e
    except Exception:       # ImportError oder ein Text ohne Block, der fuer sich nicht parst: Zeilensuche
        pass
    in_ext = False
    for z in rest.split("\n"):
        if re.match(r"^\S", z):
            in_ext = YAML_KOPF.match(z) is not None
        elif in_ext and re.match(r"^\s{1,4}%s:\s*(#.*)?$" % re.escape(MCP_NAME), z):
            return True
    return False


def _hat_kopf(text):
    return any(YAML_KOPF.match(z) for z in _ohne_block(text).split("\n"))


def _block_soll(form, text):
    """Der gewuenschte Blockinhalt. gptme: fest. goose: mit eigenem `extensions:`-Kopf, wenn die Datei
    keinen hat; sonst nur der Eintrag, der unter das vorhandene `extensions:` eingefuegt wird (ein
    schon geschriebener Block behaelt seine Lage)."""
    if form == "gptme":
        return _toml_block(form)
    aktuell = kern.marker_lesen(text, "mcp", MCP_NAME) if text else None
    if aktuell is not None:
        return _yaml_block(form, aktuell.startswith("extensions:"))
    return _yaml_block(form, not _hat_kopf(text or ""))


def _block_einfuegen(text, form, inhalt):
    """Neuer Dateitext mit dem Block. Vorhandene Marker: Block ersetzen. Sonst gptme: anhaengen;
    goose ohne eigenen Kopf: direkt unter die Zeile `extensions:`, mit Kopf: anhaengen."""
    anfang, ende = kern._marker("mcp", MCP_NAME, "#")
    if form == "goose" and anfang not in text.split("\n") and not inhalt.startswith("extensions:"):
        zeilen = text.split("\n")
        i = next(n for n, z in enumerate(zeilen) if YAML_KOPF.match(z))
        return "\n".join(zeilen[:i + 1] + [anfang] + inhalt.split("\n") + [ende] + zeilen[i + 1:])
    return kern.marker_ersetzen(text, "mcp", MCP_NAME, inhalt)


def _marker_pruefer(form):
    return _toml_pruefen if form == "gptme" else _yaml_pruefen


def _marker_eintrag(x, ad, state):
    """Der Zustand des Hub-Blocks einer Marker-Datei. `x` ist der OFFEN-Eintrag des Kerns."""
    form = ad.get("form")
    r = dict(x, ziel=ad["ziel"], zustand="OFFEN", grund=None)
    r["_marker"], r["form"] = True, form
    datei = kern.pfad_aufloesen(ad["ziel"])
    r["datei"] = datei
    text = None
    if os.path.exists(datei):
        try:
            with open(datei, encoding="utf-8", newline="") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError):
            r["zustand"], r["grund"] = "ZIEL-UNLESBAR", "Datei nicht lesbar"
            return r
        if "\r" in text:
            r["zustand"], r["grund"] = "ZIEL-UNLESBAR", "CRLF-Zeilenenden werden nicht unterstuetzt"
            return r
        try:
            _marker_pruefer(form)(text)
        except Exception as e:
            r["zustand"], r["grund"] = "ZIEL-UNLESBAR", "kein gueltiges %s (%s)" % (
                "TOML" if form == "gptme" else "YAML", type(e).__name__)
            return r
        if form == "goose" and any(YAML_FLUSS.match(z) for z in _ohne_block(text).split("\n")):
            r["zustand"], r["grund"] = "ZIEL-UNLESBAR", "extensions steht als Fluss-Mapping, kein Platz fuer den Block"
            return r
    try:
        aktuell = kern.marker_lesen(text, "mcp", MCP_NAME) if text is not None else None
        if aktuell is None and text is not None and kern._marker("mcp", MCP_NAME, "#")[0] in text.split("\n"):
            raise kern.MarkerFehler("Anfangsmarker ohne Endmarker")
    except kern.MarkerFehler as e:
        r["zustand"], r["grund"] = "ZIEL-UNLESBAR", str(e)
        return r
    soll = _block_soll(form, text)
    r["wert"], r["block"] = soll, soll
    rest = _ohne_block(text) if text is not None else ""
    hand = (_hand_toml if form == "gptme" else _hand_yaml)(rest)
    if hand:
        r["zustand"] = "ABGEWICHEN"
        r["grund"] = "Handeintrag %s ohne Marker%s" % (MCP_NAME, "" if aktuell is None else " zusaetzlich zum Block")
        r["fremd"] = True
        return r
    if aktuell is None:
        r["zustand"] = "FEHLT"
    else:
        r["aktuell_sha"] = kern._wert_sha(aktuell)
        if aktuell.strip("\n") == soll:
            r["zustand"] = "GLEICH"
            return r
        rec = state["eintraege"].get(kern.state_schluessel(x["harness"], "mcp", MCP_NAME))
        if rec and rec.get("sha") == r["aktuell_sha"]:
            r["zustand"] = "VERALTET"
        else:
            r["zustand"] = "ABGEWICHEN"
            r["grund"] = "von Hand geaendert" if rec else "Block mit Marker, aber nicht von der Werkbank geschrieben"
            return r
    # Zu schreiben (FEHLT, VERALTET): passt der Block in die Datei? Sonst steht der Zustand schon im Status.
    try:
        _marker_pruefer(form)(_block_einfuegen(text or "", form, soll))
    except Exception as e:
        r["zustand"] = "ZIEL-UNLESBAR"
        r["grund"] = "Block passt nicht in die Datei (%s), etwa ein vorhandenes %s; nichts geschrieben" % (
            type(e).__name__, "[mcp]" if form == "gptme" else "extensions")
    return r


def _marker_zelle(reg, harness):
    ad = kern.zelle(reg, harness, "mcp")
    if (isinstance(ad, dict) and ad.get("form") in FORM_FORMAT and ad.get("hub") == "stdio"
            and ad.get("format") == FORM_FORMAT[ad["form"]] and ad.get("ziel")):
        return ad
    return None


def _marker_eintraege(eintraege, reg, state):
    """Die Kern-Eintraege mcp.werkbank (OFFEN) der Harnesses mit Marker-Zelle, mit dem Dateizustand."""
    aus = []
    for x in eintraege:
        if x["art"] != "mcp" or x["name"] != MCP_NAME or x["zustand"] != "OFFEN":
            continue
        ad = _marker_zelle(reg, x["harness"])
        if ad is not None:
            aus.append(_marker_eintrag(x, ad, state))
    return aus


def _marker_anwenden(q, reg, nur_harness, nur_art, force, zeilen, snaps):
    """FEHLT und VERALTET schreiben; ABGEWICHEN nur mit --force und nur ein Block mit Marker (nie ein
    Handeintrag). Snapshot vorher, Parser-Pruefung VOR dem Schreiben, Nachpruefung danach."""
    state = kern.state_laden()
    roh = kern._bewerten_kern(q, reg, state, nur_harness, nur_art)
    geschrieben = 0
    for x in _marker_eintraege(roh, reg, state):
        z = x["zustand"]
        ref = "%s mcp.%s" % (x["harness"], MCP_NAME)
        ist_force = (force is not None and not x.get("fremd") and force[0] == x["harness"]
                     and force[1] in (MCP_NAME, "mcp.%s" % MCP_NAME))
        if z in ("GLEICH", "OFFEN", "ZIEL-UNLESBAR", "LEER"):
            if z == "ZIEL-UNLESBAR":
                zeilen.append("ZIEL-UNLESBAR  %s %s: %s" % (x["harness"], x["datei"], x["grund"]))
            continue
        if z == "ABGEWICHEN" and not ist_force:
            zeilen.append("ABGEWICHEN  %s: bleibt stehen (%s); %s" % (
                ref, x["grund"], "adopt uebernimmt" if x.get("fremd") else "--force sichert und ueberschreibt"))
            continue
        datei = x["datei"]
        alt = None
        if os.path.exists(datei):
            with open(datei, encoding="utf-8", newline="") as f:
                alt = f.read()
        neu = _block_einfuegen(alt or "", x["form"], x["block"])
        try:
            _marker_pruefer(x["form"])(neu)
        except Exception as e:
            zeilen.append("ZIEL-UNLESBAR  %s %s: Ergebnis nicht parsebar (%s), nicht geschrieben" % (
                ref, datei, type(e).__name__))
            continue
        snap = snaps.sichern(x["harness"], datei) if alt is not None else None
        os.makedirs(os.path.dirname(datei), exist_ok=True)
        modus = os.stat(datei).st_mode & 0o7777 if alt is not None else 0o644
        atomar_schreiben.schreiben(datei, neu, modus=modus, newline="")
        with open(datei, encoding="utf-8", newline="") as f:
            gelesen = f.read()
        if (kern.marker_lesen(gelesen, "mcp", MCP_NAME) or "").strip("\n") != x["block"]:
            if snap:
                atomar_schreiben.kopieren(snap, datei)
            else:
                os.unlink(datei)
            zeilen.append("ZIEL-UNLESBAR  %s %s: Nachpruefung nach dem Schreiben, zurueckgerollt" % (ref, datei))
            continue
        state["eintraege"][kern.state_schluessel(x["harness"], "mcp", MCP_NAME)] = {
            "ziel": x["ziel"], "sha": kern._wert_sha(x["block"]),
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
