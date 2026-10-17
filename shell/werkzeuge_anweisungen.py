"""werkzeuge_anweisungen -- Status der Art `anweisungen` fuer alle Harnesses ausser Claude (den
bewertet werkzeuge_claude ueber das Werkbank-Plugin). Schreibt nichts: der Volltext kommt ueber
`wb-instructions sync` in die Anweisungsdatei jedes Harness, ueber den Rollenblock von
wb-harness-run in Datei-Harnesses ohne feste Anweisungsdatei und ueber den Spawner in jeden
Worker-Auftrag; die Erinnerung je Nachricht ueber Hooks, wo der Harness sie kann.

Zustaende je Harness:
  GLEICH  die Anweisungsdatei (toolAdapter.anweisungen.ziel, Weg datei) enthaelt den aktuellen Volltext
  FEHLT   die Datei fehlt oder enthaelt ihn nicht (Abhilfe: wb-instructions sync)
  OFFEN   kein belegtes Ziel (Weg leer, Leseort unbelegt) -- grund sagt, wie er dort ankommt
Der grund nennt zusaetzlich, ob und wie die Erinnerung je Nachricht ankommt.
"""
import importlib.machinery
import importlib.util
import os
import sys

import werkzeuge_kern as kern

# Erinnerung je Nachricht: Harness -> Weg. Ohne Eintrag: nur der Volltext am Start. Ein Harness mit
# Registry-Feld toolAdapter.anweisungen.erinnerung {weg, ziel} (pi: Extension) braucht hier keinen Eintrag:
# die Registry geht vor (W2c, "nie Sonderfaelle je Harness im Code, wo ein Registry-Feld reicht").
NACHRICHT_WEG = {
    "opencode": ("~/.config/opencode/plugin/wb-hooks.ts", "wb-anweisung",
                 "opencode-Bruecke (experimental.chat.system.transform)"),
}
# Harnesses, deren Registry-Ziel als Leseort nicht belegt ist: OFFEN statt GLEICH/FEHLT.
NICHT_BELEGT = {
    "agy": "Leseort ~/.antigravity/AGENTS.md nicht belegt; agy liest Regeln laut Doku unter ~/.gemini/config/ "
           "(AGENTS.md, rules/, GEMINI.md; Herleitung, Quota erschoepft bis 15.10. 21:34, keine Probe), "
           "nicht umgestellt ohne Beleg",
}
# Ziele, die kein Weg schreibt (Review wz-integ2, J; gleiche Liste in wb-instructions GESPERRTE_ZIELE).
GESPERRT = {"~/AGENTS.md": "~/AGENTS.md bleibt bewusst weg (25.09.: jeder Harness in ~ liest sie); jcode kennt "
                           "global nur diesen Ort (Binary 0.72.0) und bekommt den Text ueber AGENTS.md im Arbeitsverzeichnis"}
NACHRICHT_OHNE = {
    "codex": "Codex-Hooks bleiben bis zur trusted_hash-Messung aus (Hauptagent 13.10.)",
}


def _instructions_laden():
    """-> (Modul, None) oder (None, Grund). Ein Ladefehler ist laut (stderr und Grund im Befund),
    nicht still: sonst stuenden alle Datei-Harnesses ohne Hinweis auf OFFEN (Review wz-integ2, I)."""
    pfad = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wb-instructions")
    if not os.path.isfile(pfad):
        return None, "wb-instructions fehlt neben %s" % os.path.basename(__file__)
    try:
        loader = importlib.machinery.SourceFileLoader("wb_instructions_status", pfad)
        spec = importlib.util.spec_from_loader(loader.name, loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        return mod, None
    except Exception as ex:   # auch SyntaxError/ImportError aus dem Generator selbst
        grund = "wb-instructions nicht ladbar: %s: %s" % (type(ex).__name__, str(ex).splitlines()[0][:160] if str(ex) else "-")
        print("wb-werkzeuge: %s" % grund, file=sys.stderr)
        return None, grund


def _volltext(e):
    try:
        ordner = kern.quellordner()
        with open(kern._datei_da(e.get("volltext", ""), ordner), encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError, kern.FehlerInQuelle):
        return None
    if text.startswith("---\n"):
        ende = text.find("\n---\n", 4)
        if ende >= 0:
            text = text[ende + 5:]
    return text.strip("\n")


def _takt_text(e):
    t = e.get("takt") if isinstance(e.get("takt"), dict) else {}
    n = (t.get("nachricht") or {}).get("alle", 1) if isinstance(t.get("nachricht"), dict) else 1
    return "je Nachricht" if n == 1 else "jede %s. Nachricht je Sitzung" % n


def _nachricht_grund(harness, e, ad=None):
    if "nachricht" not in (e.get("anlaesse") or list(kern.ANLAESSE)) or not e.get("erinnerung"):
        return "Erinnerung je Nachricht: nicht verlangt"
    reg_weg = (ad or {}).get("erinnerung")
    if isinstance(reg_weg, dict) and reg_weg.get("ziel"):
        # Registry-Weg (pi): die Datei gehoert der Werkbank (werkzeuge_dateien), ihr Zustand steht dort.
        ziel, merkmal, was = reg_weg["ziel"], "wb-anweisung", "Erweiterung (%s)" % reg_weg.get("weg", "datei")
    elif harness in NACHRICHT_WEG:
        ziel, merkmal, was = NACHRICHT_WEG[harness]
    else:
        ziel = None
    if ziel:
        try:
            with open(kern.pfad_aufloesen(ziel), encoding="utf-8") as f:
                da = merkmal in f.read()
        except (OSError, UnicodeDecodeError):
            da = False
        return "Erinnerung %s: %s %s" % (_takt_text(e), was, "installiert" if da else "fehlt (%s)" % ziel)
    return "Erinnerung je Nachricht: keine (%s)" % NACHRICHT_OHNE.get(
        harness, "kein Hook je Nachricht belegt; nur Volltext am Start und im Worker-Auftrag")


def _bewerten(roh, q, reg, state, nur_harness=None, nur_art=None):
    """Haken `bewerten`: ersetzt die Kern-Eintraege (OFFEN/LEER) der Art anweisungen fuer alle Harnesses
    ausser claude. Weg `datei` (toolAdapter.anweisungen.ziel): GLEICH, wenn die Datei den Volltext traegt."""
    # kern.zelle loest `wie` auf (copilot-cloud ist dasselbe Programm mit denselben Dateien wie copilot).
    adapter = {h.get("id"): (kern.zelle(reg, h.get("id"), "anweisungen") or {}) for h in reg.get("harnesses", [])}
    router, ladefehler = None, None
    aus = []
    for x in roh:
        e = (q.get("anweisungen") or {}).get(x["name"])
        if x["art"] != "anweisungen" or x["harness"] == "claude" or x["zustand"] not in ("OFFEN", "LEER") \
                or not isinstance(e, dict) or e.get("status"):
            aus.append(x)
            continue
        h = x["harness"]
        ad = adapter.get(h) or {}
        nachricht = _nachricht_grund(h, e, ad)
        start = "Volltext ueber den Rollenblock von wb-harness-run (Datei-Harnesses) und den Spawner-Auftrag"
        if "sitzungsstart" not in (e.get("anlaesse") or list(kern.ANLAESSE)):
            aus.append(dict(x, zustand="OFFEN", grund="kein Anlass sitzungsstart; " + nachricht))
            continue
        if h in NICHT_BELEGT:
            aus.append(dict(x, zustand="OFFEN", grund="%s; %s; %s" % (NICHT_BELEGT[h], start, nachricht)))
            continue
        if ad.get("weg") != "datei" or not ad.get("ziel"):
            warum = ad.get("grund") or "kein Weg datei in toolAdapter.anweisungen"
            # Belegt leer (gemessen anders als herleitung, etwa jcode: nur ~/AGENTS.md, gesperrt) ist LEER:
            # nichts zu schreiben. Eine Herleitung oder fehlende Messung bleibt OFFEN.
            belegt = ad.get("weg") == "leer" and (ad.get("gemessen") or "").split("/")[-1] not in ("", "herleitung")
            aus.append(dict(x, zustand="LEER" if belegt else "OFFEN", ziel=None,
                            grund="%s; %s; %s" % (warum, start, nachricht)))
            continue
        ziel = ad["ziel"]
        if ziel in GESPERRT:
            aus.append(dict(x, zustand="OFFEN", ziel=None, grund="%s; %s; %s" % (GESPERRT[ziel], start, nachricht)))
            continue
        if router is None:
            wi, ladefehler = _instructions_laden()
            try:
                router = {r["id"]: r.get("target") for r in wi.router_harnesses()} if wi else {}
            except Exception as ex:
                router, ladefehler = {}, "wb-instructions router_harnesses scheiterte: %s" % type(ex).__name__
                print("wb-werkzeuge: %s" % ladefehler, file=sys.stderr)
        if ladefehler:
            aus.append(dict(x, zustand="OFFEN", ziel=ziel, grund="%s; %s; %s" % (ladefehler, start, nachricht)))
            continue
        if not router.get(h):
            # Registry-Ziel ohne Schreiber (etwa qwen ~/.qwen/QWEN.md, W1 13.10.): "wb-instructions sync"
            # waere ein falscher Rat, der Weg ist offen, bis ein Generator die Datei schreibt.
            aus.append(dict(x, zustand="OFFEN", ziel=ziel, grund="%s steht in der Registry, aber kein Generator "
                            "schreibt es (wb-instructions kennt fuer %s kein Ziel); %s; %s" % (ziel, h, start, nachricht)))
            continue
        voll = _volltext(e)
        try:
            with open(kern.pfad_aufloesen(ziel), encoding="utf-8") as f:
                inhalt = f.read()
        except (OSError, UnicodeDecodeError):
            inhalt = None
        hinweise = []
        if kern.pfad_aufloesen(router[h]) != kern.pfad_aufloesen(ziel):
            hinweise.append("wb-instructions schreibt nach %s, nicht ins Registry-Ziel" % router[h])
        if voll is None:
            z, g = "OFFEN", "Volltext der Quelle nicht lesbar"
        elif inhalt is None:
            z, g = "FEHLT", "Anweisungsdatei fehlt: wb-instructions sync"
        elif voll in inhalt:
            z, g = "GLEICH", None
        else:
            z, g = "FEHLT", "Volltext nicht (aktuell) in der Anweisungsdatei: wb-instructions sync"
        aus.append(dict(x, zustand=z, ziel=ziel, grund="; ".join(s for s in [g] + hinweise + [nachricht] if s)))
    return aus


def registrieren():
    kern.adapter_registrieren("anweisungen", bewerten=_bewerten)
