"""werkzeuge_hookbruecke -- Hook-Bruecke der Werkbank (Spur W2b): Uebersetzung und Adapter.

Plan: ~/AI/_recherche/werkzeug-plan-2026-10-13.md (Nachtrag 13:30, E8 "Alles bei allen") und
Lueckenmessung gruppe-b Abschnitt 5.3: ein einziges Programm `wb-hook-bruecke <harness> <ereignis>
[<hook>]`, das die Adapter als Hook-Befehl in jeden Harness mit Hook-Mechanismus eintragen.

UEBERSETZUNG. Die Hook-Skripte unter ~/.claude/hooks sprechen das Claude-Protokoll: JSON auf stdin
(session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input, prompt ...), Exit 2 mit
stderr oder `hookSpecificOutput.permissionDecision = "deny"` blockiert, `additionalContext` spielt
Kontext ein. Die Bruecke liest die Nutzlast des Harness, baut daraus die Claude-Form, ruft die
passenden Hook-Befehle der Quelle (shell/werkzeuge.default.json, Abschnitt hooks) und schreibt
die Antwort in der Form des Harness zurueck. ALLES Harness-Eigene steht in der Registry unter
toolAdapter.hooks.bruecke, nicht hier:

  ereignisse  {Claude-Ereignis: natives Ereignis}  welche Ereignisse der Harness traegt
  eingabe     "gleich" (Nutzlast ist schon Claude-foermig) oder {Claude-Feld: "pfad.im.nativen.json" | [Pfade]}
              (Liste: der erste vorhandene; Ziffern waehlen ein Listenelement);
              Endung "|json" dekodiert einen JSON-Text (copilot toolArgs)
  werkzeuge   {nativer Werkzeugname: Claude-Name | {"name": .., "argumente": {nativ: claude},
               "nach_feld": "<Argument>", "namen": {<Wert>: Claude-Name},
               "verketten": {<natives Listenfeld>: <Claude-Feld>}}}  (verketten: Liste -> Text mit
              Zeilenumbruechen, clite run_commands.commands -> Bash.command; nach_feld: ein natives
              Werkzeug mit Unterbefehl, z. B. openhands file_editor command=create -> Write;
              "patch": [<Argument>, ..]: ein Patch-Werkzeug im apply_patch-Format, siehe PATCHES)
  antwort     {"blockieren"|"kontext"|"erlauben": {"json": Vorlage, "stderr": Text, "exit": n},
               "<Claude-Ereignis>": {dieselben Schluessel, gelten vor den allgemeinen}}
              Platzhalter in Texten: {grund} {kontext} {ereignis} {ereignis_nativ}
  eintrag     Vorlage des Eintrags, den der Adapter je Ereignis in die Harness-Datei schreibt
              (Platzhalter {befehl}, {name}; ein Wert genau "{timeout}" wird zur Zahl, "{timeout_ms}" ebenso)
  blockierend Claude-Ereignisse, deren Hooks fail-closed laufen (Vorgabe ["PreToolUse"])

Ein neuer Harness braucht damit nur einen Registry-Eintrag.

SCHUTZ (fail-closed / fail-open, je Hook ueber sein Ereignis begruendet):
  * Blockierende Ereignisse (PreToolUse: ergebnis-beleg-gate, reviewer-sperre, testschutz-gate) sind
    Gates. Kann die Bruecke dort nicht sicher uebersetzen (Nutzlast kein JSON, keine bruecke-Zelle,
    Quelle/Registry unlesbar, Ereignis unbekannt) oder bekommt sie vom Hook keine Antwort (Start
    gescheitert, Frist ueberschritten, Exit ausser 0 und 2 -- etwa 127, wenn das Hook-Skript fehlt,
    126 oder 1 nach einem Absturz), BLOCKIERT sie mit Grund "wb-hook-bruecke: ...". Sie erlaubt dort
    nie still; hier strenger als Claude, das einen solchen Exit als nicht blockierenden Fehler liest.
    Was der Hook selbst entscheidet (Exit 0 ohne deny = erlaubt, wie bei Claude), bleibt seine
    Entscheidung; die Skripte sind bewusst so gebaut (testschutz: fail-open im Skript, reviewer-sperre:
    verweigert selbst, wenn ihr Pruefkern fehlt).
  * Ein schreibendes Werkzeug (Write/Edit/MultiEdit/NotebookEdit) ohne Zielpfad blockiert dort ebenso:
    die Gates sehen ohne file_path nichts und erlauben.
  * PATCHES (Review W2 F1): Patch-Werkzeuge (opencode apply_patch/patch, cline apply_patch, openhands
    apply_patch; Registry-Feld "patch") tragen viele Dateien in einem Text. Die Bruecke liest daraus
    jeden Pfad (*** Add File / Update File / Delete File / Move to; relative Pfade gegen cwd, ../ und
    absolute normalisiert) und ruft die Gates je Pfad wie fuer Write (Add) bzw. Edit (sonst) mit
    file_path. Ein blockiertes Gate blockiert den ganzen Patch; ein unlesbarer Patch blockiert.
  * Alle anderen Ereignisse (PostToolUse/UserPromptSubmit: inbox-einspielen spielt nur Kontext ein;
    Stop: stop-aufgabe-zugende blockiert nie) laufen fail-open: ein Fehler wird geloggt, der Harness
    laeuft weiter. Ein Blockieren dort wuerde nur die Sitzung stoeren, ohne etwas zu schuetzen.
  * Ein Hook-Name, den die gueltige Quelle nicht mehr kennt, ist entfernt worden: nichts ausfuehren,
    loggen (kein Gate mehr, das zu schuetzen waere).
Log: ~/.local/state/wb-hook-bruecke.log, nur Harness, Ereignis, Hook, Ergebnis und Fehlerart, nie
Nutzlastwerte (Prompts, Befehle, Dateiinhalte).

ADAPTER (Haken bewerten/anwenden von werkzeuge_kern): schreibt fuer jeden Quell-Hook und jedes seiner
Ereignisse einen Eintrag `wb-hook-bruecke <harness> <Claude-Ereignis> <hook>` nach der Vorlage
bruecke.eintrag unter <pfad>.<natives Ereignis> der Zieldatei (Format json-pfad). Der Matcher der
Quelle (z. B. "Write|Edit") wirkt in der Bruecke auf den uebersetzten Werkzeugnamen; im Harness steht
keiner, weil die nativen Werkzeugnamen anders heissen. Besitz wie im Kern (Statusdatei), fremde
Eintraege bleiben, Snapshot vor jedem Ueberschreiben.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import time

import atomar_schreiben
import werkzeuge_kern as kern

BEFEHL = "wb-hook-bruecke"
BLOCKIEREND_VORGABE = ("PreToolUse",)
MAX_EINGABE = 16 * 1024 * 1024
LOG_GRENZE = 1024 * 1024
SCHREIBEND = ("Write", "Edit", "MultiEdit", "NotebookEdit")
FRIST_PUFFER = 5      # Sekunden, die der Harness der Bruecke ueber die Hook-Frist hinaus laesst (Review W2 F3)
FRIST_OHNE_NAME = 50  # Gesamtfrist ohne Hook-Namen (pi/opencode-Erweiterung warten 60 s auf die Bruecke)
PATCH_KOPF = re.compile(r"^\*\*\* (Add File|Update File|Delete File|Move to): ?(.*)$")
OHNE_WERKZEUG = ("UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "SubagentStop", "PreCompact",
                 "Notification")


class Uebersetzungsfehler(Exception):
    pass


# ---------------------------------------------------------------- Log

def _log(harness, ereignis, hook, ergebnis, art=""):
    p = os.path.join(kern.home(), ".local", "state", "wb-hook-bruecke.log")
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if os.path.exists(p) and os.path.getsize(p) > LOG_GRENZE:
            os.replace(p, p + ".1")
        with open(p, "a", encoding="utf-8") as f:
            f.write("%s %s %s %s %s %s\n" % (datetime.datetime.now().isoformat(timespec="seconds"),
                                             harness, ereignis, hook or "-", ergebnis, art))
    except OSError:
        pass


# ---------------------------------------------------------------- Registry-Zelle

def bruecke_zelle(reg, harness):
    """toolAdapter.hooks.bruecke des Harness (ueber `wie` aufgeloest) oder None."""
    z = kern.zelle(reg, harness, "hooks")
    b = z.get("bruecke") if isinstance(z, dict) else None
    return b if isinstance(b, dict) else None


def blockierend(b, ereignis):
    return ereignis in (b.get("blockierend") or BLOCKIEREND_VORGABE)


def claude_ereignis(b, ereignis):
    """Nimmt den Claude-Namen oder den nativen Namen eines Ereignisses an."""
    ev = b.get("ereignisse") or {}
    if ereignis in ev:
        return ereignis
    for c, n in ev.items():
        if n == ereignis:
            return c
    raise Uebersetzungsfehler("Ereignis %r traegt die Registry fuer diesen Harness nicht" % ereignis)


# ---------------------------------------------------------------- Eingabe

def _holen(daten, pfad):
    roh = pfad.endswith("|json")
    if roh:
        pfad = pfad[:-5]
    x = daten
    for teil in pfad.split("."):
        if isinstance(x, list) and teil.isdigit():
            if int(teil) >= len(x):
                return None
            x = x[int(teil)]
            continue
        if not isinstance(x, dict) or teil not in x:
            return None
        x = x[teil]
    if roh and isinstance(x, str):
        try:
            x = json.loads(x)
        except ValueError:
            raise Uebersetzungsfehler("Feld %s ist kein JSON" % pfad)
    return x


def werkzeug_uebersetzen(b, name, eingabe):
    """(nativer Name, native Argumente) -> (Claude-Name, Claude-Argumente)."""
    w = (b.get("werkzeuge") or {}).get(name)
    if w is None:
        return name, eingabe
    if isinstance(w, str):
        return w, eingabe
    argumente = w.get("argumente") or {}
    neu = {}
    for k, v in (eingabe or {}).items():
        neu[argumente.get(k, k)] = v
    # Liste -> ein Text (clite run_commands {commands: [..]} -> Bash {command: "a\nb"}), damit die Gates den
    # ganzen Befehl sehen.
    for nativ_feld, claude_feld in (w.get("verketten") or {}).items():
        wert = (eingabe or {}).get(nativ_feld)
        if isinstance(wert, list):
            neu.pop(argumente.get(nativ_feld, nativ_feld), None)
            neu[claude_feld] = "\n".join(str(x) for x in wert)
    claude = w.get("name", name)
    if w.get("patch") is not None:
        neu["_wb_patch"] = patch_text(w.get("patch"), eingabe or {})
    # Ein natives Werkzeug fuer mehrere Claude-Werkzeuge (openhands file_editor: command create/view/...).
    feld = w.get("nach_feld")
    if feld:
        claude = (w.get("namen") or {}).get((eingabe or {}).get(feld), claude)
    return claude, neu


def patch_text(felder, eingabe):
    """Der Patchtext eines Patch-Werkzeugs: das erste genannte Argument mit Text, sonst jeder Textwert mit
    einem Patch-Kopf (Argumentnamen je Harness gemessen, aber nicht ueberall eindeutig). None = keiner."""
    for f in (felder if isinstance(felder, list) else [felder]):
        if isinstance(eingabe.get(f), str):
            return eingabe[f]
    for v in eingabe.values():
        if isinstance(v, str) and any(PATCH_KOPF.match(z) for z in v.splitlines()):
            return v
    return None


def patch_pfade(text, cwd=None):
    """-> [(Claude-Name, absoluter normalisierter Pfad)] aus einem Patch im apply_patch-Format
    (*** Begin Patch / *** Add|Update|Delete File: / *** Move to: / *** End Patch). Wirft
    Uebersetzungsfehler, wenn der Patch nicht sicher lesbar ist: kein Text, kein Begin/End, keine Datei,
    leerer Pfad, Move to ohne Update File davor."""
    if not isinstance(text, str):
        raise Uebersetzungsfehler("Patch-Werkzeug ohne Patchtext")
    zeilen = [z.rstrip("\r") for z in text.strip().splitlines()]
    if not zeilen or zeilen[0].strip() != "*** Begin Patch" or zeilen[-1].strip() != "*** End Patch":
        raise Uebersetzungsfehler("Patch ohne *** Begin Patch/*** End Patch")
    basis = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else os.getcwd()
    aus, letzte = [], None
    for z in zeilen[1:-1]:
        m = PATCH_KOPF.match(z)
        if not m:
            if z.startswith("*** ") and z.strip() not in ("*** End of File",):
                raise Uebersetzungsfehler("unbekannte Patch-Kopfzeile")
            continue
        art, pfad = m.group(1), m.group(2).strip()
        if not pfad or "\0" in pfad:
            raise Uebersetzungsfehler("Patch-Kopfzeile ohne Pfad")
        if art == "Move to" and letzte != "Update File":
            raise Uebersetzungsfehler("Move to ohne Update File davor")
        # Wie das OS schreibt: join ohne normpath, dann realpath (folgt vorhandenen Symlinks, loest .. erst
        # danach auf). normpath allein machte aus frei/link/../x.sh frei/x.sh, das OS schreibt aber ins
        # Linkziel (Nach-Review W2 N2).
        voll = os.path.realpath(os.path.join(basis, os.path.expanduser(pfad)))
        if ("Write" if art == "Add File" else "Edit", voll) not in aus:
            aus.append(("Write" if art == "Add File" else "Edit", voll))
        letzte = art
    if not aus:
        raise Uebersetzungsfehler("Patch ohne Dateiangabe")
    return aus


def claude_nutzlast(b, ereignis, nativ):
    if not isinstance(nativ, dict):
        raise Uebersetzungsfehler("Nutzlast ist kein JSON-Objekt")
    abb = b.get("eingabe", "gleich")
    if abb == "gleich":
        d = dict(nativ)
    elif isinstance(abb, dict):
        d = {}
        for feld, pfade in abb.items():
            # ein Pfad oder eine Liste (erster vorhandener gilt; cline: preToolUse.toolName/postToolUse.toolName)
            for pfad in (pfade if isinstance(pfade, list) else [pfade]):
                if not isinstance(pfad, str):
                    raise Uebersetzungsfehler("eingabe.%s ist kein Pfad" % feld)
                w = _holen(nativ, pfad)
                if w is not None:
                    d[feld] = w
                    break
    else:
        raise Uebersetzungsfehler("eingabe muss \"gleich\" oder ein Objekt sein")
    d["hook_event_name"] = ereignis
    if "tool_name" in d:
        if not isinstance(d["tool_name"], str):
            raise Uebersetzungsfehler("tool_name ist kein Text")
        ti = d.get("tool_input")
        if ti is not None and not isinstance(ti, dict):
            raise Uebersetzungsfehler("tool_input ist kein Objekt")
        d["tool_name"], d["tool_input"] = werkzeug_uebersetzen(b, d["tool_name"], ti or {})
    elif ereignis not in OHNE_WERKZEUG:
        raise Uebersetzungsfehler("Nutzlast ohne Werkzeugnamen fuer %s" % ereignis)
    return d


# ---------------------------------------------------------------- Hooks der Quelle

def matcher_passt(matcher, werkzeug):
    if matcher in (None, "", "*") or werkzeug is None:
        return True
    try:
        return re.fullmatch(matcher, werkzeug) is not None
    except re.error:
        return werkzeug in matcher.split("|")


def hooks_waehlen(q, reg, harness, ereignis, werkzeug, name=None):
    """[(name, eintrag)] der Quell-Hooks, die fuer harness/ereignis/werkzeug laufen."""
    m = kern.maschine()
    aus = []
    for n, e in (q.get("hooks") or {}).items():
        if name is not None and n != name:
            continue
        if e.get("status") or m not in e.get("maschinen", [m]):
            continue
        if harness not in kern.harnesses_aufloesen(e.get("harnesses", []), "hooks", reg):
            continue
        for roh in e["ereignisse"]:
            ev, _, matcher = roh.partition(":")
            if ev == ereignis and matcher_passt(matcher or None, werkzeug):
                aus.append((n, e))
                break
    return aus


def hook_ausfuehren(e, nutzlast, rest=None):
    """-> ("block", grund) | ("kontext", text) | ("ok", None) | ("fehler", art). Exit 2 oder deny/block
    blockiert. Jeder andere Exit ausser 0 ist ("fehler", "exit N"): bei Gates fail-closed (bruecke), sonst
    ein nicht blockierender Fehler wie bei Claude."""
    frist = max(0.1, min(int(e.get("timeout", 10)), rest if rest is not None else 1e9))
    try:
        # Eigene Prozessgruppe: bei Fristablauf endet der Hook samt Kindern; sonst hielte ein Enkel (sleep,
        # python) die Pipe offen und die Bruecke wartete trotz Frist weiter.
        p = subprocess.Popen(["bash", "-c", e["befehl"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    except OSError:
        return "fehler", "start"
    try:
        out, err = p.communicate(json.dumps(nutzlast).encode("utf-8"), timeout=frist)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, 9)
        except OSError:
            pass
        p.communicate()
        return "fehler", "frist"
    r = subprocess.CompletedProcess(p.args, p.returncode, out, err)
    aus = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode == 2:
        return "block", (r.stderr.decode("utf-8", "replace").strip() or "von einem Werkbank-Hook blockiert")
    if r.returncode != 0:
        return "fehler", "exit %d" % r.returncode
    if not aus:
        return "ok", None
    try:
        o = json.loads(aus)
    except ValueError:
        return ("kontext", aus) if nutzlast["hook_event_name"] in ("UserPromptSubmit", "SessionStart") else ("ok", None)
    if not isinstance(o, dict):
        return "ok", None
    hso = o.get("hookSpecificOutput") if isinstance(o.get("hookSpecificOutput"), dict) else {}
    if hso.get("permissionDecision") == "deny" or o.get("decision") == "block":
        return "block", str(hso.get("permissionDecisionReason") or o.get("reason") or "von einem Werkbank-Hook blockiert")
    if isinstance(hso.get("additionalContext"), str) and hso["additionalContext"]:
        return "kontext", hso["additionalContext"]
    return "ok", None


# ---------------------------------------------------------------- Antwort

def _fuellen(v, werte):
    if isinstance(v, str):
        if v in ("{timeout}", "{timeout_ms}") and v[1:-1] in werte:
            return werte[v[1:-1]]
        for k, w in werte.items():
            v = v.replace("{%s}" % k, str(w))
        return v
    if isinstance(v, dict):
        return {k: _fuellen(x, werte) for k, x in v.items()}
    if isinstance(v, list):
        return [_fuellen(x, werte) for x in v]
    return v


def antwort(b, ergebnis, ereignis, grund="", kontext=""):
    """-> (stdout, stderr, exit) in der Form des Harness."""
    a = b.get("antwort") or {}
    vorlage = dict(a.get(ergebnis) or {})
    vorlage.update(((a.get(ereignis) or {}).get(ergebnis)) or {})
    if ergebnis == "kontext" and not vorlage:
        # Der Harness kann fuer dieses Ereignis keinen Kontext aufnehmen: erlauben.
        return antwort(b, "erlauben", ereignis)
    if ergebnis == "blockieren" and not vorlage:
        vorlage = {"stderr": "{grund}", "exit": 2}
    werte = {"grund": grund, "kontext": kontext, "ereignis": ereignis,
             "ereignis_nativ": (b.get("ereignisse") or {}).get(ereignis, ereignis)}
    out = json.dumps(_fuellen(vorlage["json"], werte), ensure_ascii=False) if "json" in vorlage else ""
    err = _fuellen(vorlage.get("stderr", ""), werte)
    return out, err, int(vorlage.get("exit", 0))


# Native Namen der Vor-Werkzeug-Ereignisse (pi, copilot, openhands, opencode, gemini-Familie): nur fuer den
# Fall, dass weder Quelle noch Registry lesbar sind, damit ein Gate auch dann nicht still erlaubt.
VOR_WERKZEUG_NATIV = ("PreToolUse", "tool_call", "preToolUse", "pre_tool_use", "tool.execute.before", "BeforeTool")


def _registry_notfall(harness):
    """bruecke-Zelle direkt aus der Registry, wenn kern.laden() an der Quelle scheitert."""
    kandidaten = [os.environ.get("WB_WERKZEUGE_REGISTRY"),
                  os.path.join(os.path.dirname(os.path.abspath(__file__)), "models.default.json")]
    for p in kandidaten:
        if not p:
            continue
        try:
            with open(p, encoding="utf-8") as f:
                reg = json.load(f)
            return bruecke_zelle(reg, harness)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return None


def bruecke(harness, ereignis_arg, roh, name=None):
    """Kern von wb-hook-bruecke. -> (stdout, stderr, exit). Wirft nichts."""
    b = None
    ereignis = ereignis_arg
    gate = ereignis_arg in VOR_WERKZEUG_NATIV

    def fehler(art):
        _log(harness, ereignis, name, "fail-closed" if gate else "fail-open", art)
        if gate:
            grund = "wb-hook-bruecke: %s (fail-closed, blockierender Hook)" % art
            if b is not None:
                return antwort(b, "blockieren", ereignis, grund=grund)
            return "", grund, 2
        return "", "", 0

    try:
        q, reg = kern.laden()
    except (kern.FehlerInQuelle, OSError) as ex:
        # Ohne Quelle kein Hook; ob das Ereignis ein Gate ist und wie der Harness eine Ablehnung liest,
        # sagt die Registry allein (falls lesbar), sonst die Liste nativer Vor-Werkzeug-Namen.
        b = _registry_notfall(harness)
        if b is not None:
            try:
                ereignis = claude_ereignis(b, ereignis_arg)
                gate = blockierend(b, ereignis)
            except Uebersetzungsfehler:
                pass
        gate = gate or ereignis_arg in VOR_WERKZEUG_NATIV
        return fehler("Quelle oder Registry unlesbar (%s)" % type(ex).__name__)
    b = bruecke_zelle(reg, harness)
    if b is None:
        return fehler("keine toolAdapter.hooks.bruecke fuer %s" % harness)
    try:
        ereignis = claude_ereignis(b, ereignis_arg)
    except Uebersetzungsfehler as ex:
        return fehler(str(ex))
    gate = blockierend(b, ereignis)
    if name is not None and name not in (q.get("hooks") or {}):
        _log(harness, ereignis, name, "uebersprungen", "Hook nicht mehr in der Quelle")
        return antwort(b, "erlauben", ereignis)
    try:
        if len(roh) > MAX_EINGABE:
            raise Uebersetzungsfehler("Nutzlast zu gross")
        nativ = json.loads(roh.decode("utf-8")) if roh.strip() else {}
        nutzlast = claude_nutzlast(b, ereignis, nativ)
    except (ValueError, UnicodeDecodeError):
        return fehler("Nutzlast ist kein JSON")
    except Uebersetzungsfehler as ex:
        return fehler(str(ex))
    ti = nutzlast.get("tool_input") if isinstance(nutzlast.get("tool_input"), dict) else {}
    laeufe = [nutzlast]
    if "_wb_patch" in ti:
        # Patch-Werkzeug: je Datei ein Lauf wie Write/Edit mit file_path (Review W2 F1).
        text = ti.pop("_wb_patch")
        if gate:
            try:
                pfade = patch_pfade(text, nutzlast.get("cwd"))
            except Uebersetzungsfehler as ex:
                return fehler("Patch nicht lesbar: %s" % ex)
            laeufe = [dict(nutzlast, tool_name=w, tool_input=dict(ti, file_path=p)) for w, p in pfade]
    elif gate and nutzlast.get("tool_name") in SCHREIBEND \
            and not (ti.get("file_path") or ti.get("notebook_path")):
        return fehler("%s ohne file_path" % nutzlast["tool_name"])
    # Gesamtfrist ueber alle Laeufe (Nach-Review W2 N1): der Harness wartet nur Hook-Frist + FRIST_PUFFER auf
    # die Bruecke, egal wie viele Dateien ein Patch traegt. Jeder Aufruf bekommt nur die Restzeit; ist sie
    # verbraucht, antwortet die Bruecke selbst (bei Gates: blockieren), bevor der Harness sie beendet.
    # Gleiche Aufrufe (Hook, Werkzeug, Eingabe) laufen nur einmal.
    if name is not None:
        gesamt = int((q.get("hooks") or {}).get(name, {}).get("timeout", 10))
    else:
        gesamt = FRIST_OHNE_NAME
    ende = time.monotonic() + gesamt
    gesehen = set()
    kontexte = []
    for lauf in laeufe:
        for n, e in hooks_waehlen(q, reg, harness, ereignis, lauf.get("tool_name"), name):
            schluessel = (n, lauf.get("tool_name"), json.dumps(lauf.get("tool_input"), sort_keys=True))
            if schluessel in gesehen:
                continue
            gesehen.add(schluessel)
            rest = ende - time.monotonic()
            if rest <= 0:
                if gate:
                    _log(harness, ereignis, n, "fail-closed", "gesamtfrist")
                    return antwort(b, "blockieren", ereignis,
                                   grund="wb-hook-bruecke: Gesamtfrist %d s ueberschritten (%d Pfade); fail-closed"
                                   % (gesamt, len(laeufe)))
                _log(harness, ereignis, n, "fail-open", "gesamtfrist")
                break
            erg, wert = hook_ausfuehren(e, lauf, rest)
            if erg == "fehler" and wert == "frist" and rest < int(e.get("timeout", 10)):
                wert = "Gesamtfrist %d s ueberschritten, %d Pfade" % (gesamt, len(laeufe))
            if erg == "block":
                _log(harness, ereignis, n, "blockiert")
                return antwort(b, "blockieren", ereignis, grund=wert)
            if erg == "fehler":
                if gate:
                    _log(harness, ereignis, n, "fail-closed", wert)
                    return antwort(b, "blockieren", ereignis,
                                   grund="wb-hook-bruecke: Hook %s ohne Antwort (%s); fail-closed" % (n, wert))
                _log(harness, ereignis, n, "fail-open", wert)
                continue
            if erg == "kontext" and wert not in kontexte:
                kontexte.append(wert)
    if kontexte:
        return antwort(b, "kontext", ereignis, kontext="\n\n".join(kontexte))
    return antwort(b, "erlauben", ereignis)


def main(argv):
    if len(argv) not in (3, 4) or argv[1].startswith("-"):
        print("Aufruf: wb-hook-bruecke <harness> <ereignis> [<hook>]  (Nutzlast des Harness auf stdin)",
              file=sys.stderr)
        return 64
    try:
        roh = sys.stdin.buffer.read(MAX_EINGABE + 1)
    except OSError:
        roh = b""
    out, err, rc = bruecke(argv[1], argv[2], roh, argv[3] if len(argv) == 4 else None)
    if out:
        sys.stdout.write(out + "\n")
    if err:
        sys.stderr.write(err + "\n")
    return rc


# ---------------------------------------------------------------- Adapter (wb-werkzeuge)

BEFEHL_PFAD = '"$HOME/.local/bin/%s"' % BEFEHL


def befehl(harness, ereignis, name):
    return "%s %s %s %s" % (BEFEHL_PFAD, harness, ereignis, name)


def _roh_zelle(reg, harness):
    for x in reg["harnesses"]:
        if x.get("id") == harness:
            z = (x.get("toolAdapter") or {}).get("hooks")
            return z if isinstance(z, dict) else None
    return None


def adapter_zelle(reg, harness):
    """Die hooks-Zelle, wenn der Bruecken-Adapter fuer den Harness schreibt (json-pfad mit bruecke)."""
    z = kern.zelle(reg, harness, "hooks")
    if not (isinstance(z, dict) and isinstance(z.get("bruecke"), dict) and z.get("ziel")):
        return None
    if (z.get("format") or z.get("weg")) != "json-pfad" or not isinstance(z["bruecke"].get("eintrag"), dict):
        return None
    return z


def specs(harness, name, e, z):
    """-> ([(claude_ev, natives_ev, eintrag)], [nicht getragene Claude-Ereignisse])."""
    ev_map = z["bruecke"].get("ereignisse") or {}
    aus, fehlen, gesehen = [], [], set()
    for roh in e["ereignisse"]:
        ev = roh.partition(":")[0]
        if ev in gesehen:
            continue
        gesehen.add(ev)
        if ev not in ev_map:
            fehlen.append(ev)
            continue
        # Der Harness wartet laenger als der Hook darf: sonst beendet er die Bruecke, bevor sie bei einem
        # Fristablauf fail-closed antworten kann (Review W2 F3).
        t = int(e.get("timeout", 10)) + FRIST_PUFFER
        aus.append((ev, ev_map[ev], _fuellen(z["bruecke"].get("eintrag") or {},
                                             {"befehl": befehl(harness, ev, name), "timeout": t, "name": name,
                                              "timeout_ms": t * 1000})))
    return aus, fehlen


def _enthaelt(x, text):
    if isinstance(x, str):
        return x == text
    if isinstance(x, dict):
        return any(_enthaelt(v, text) for v in x.values())
    if isinstance(x, list):
        return any(_enthaelt(v, text) for v in x)
    return False


def _liste(daten, z, natives_ev, anlegen=False):
    k = daten
    for t in kern._pfad_teile(z.get("pfad", "")) + [natives_ev]:
        if t not in k:
            if not anlegen:
                return None
            k[t] = [] if t == natives_ev else {}
        k = k[t]
        if t != natives_ev and not isinstance(k, dict):
            raise kern.ZielUnlesbar("Pfad %s ist kein Objekt" % z.get("pfad"))
    if not isinstance(k, list):
        raise kern.ZielUnlesbar("hooks.%s ist keine Liste" % natives_ev)
    return k


def _status(harness, name, e, z, state):
    r = {"harness": harness, "art": "hooks", "name": name, "ziel": z["ziel"], "zustand": "OFFEN", "grund": None,
         "_bruecke": True, "datei": kern.pfad_aufloesen(z["ziel"])}
    sp, fehlen = specs(harness, name, e, z)
    r["specs"] = sp
    hinweis = ("Ereignis %s traegt %s nicht" % (", ".join(fehlen), harness)) if fehlen else None
    if not sp:
        r["grund"] = hinweis
        return r
    try:
        _, daten = kern.ziel_lesen(z["ziel"])
        listen = {nev: _liste(daten, z, nev) for (_, nev, _) in sp}
        knoten = kern.knoten_holen(daten, z.get("pfad", ""))
    except kern.ZielUnlesbar as ex:
        r["zustand"], r["grund"] = "ZIEL-UNLESBAR", str(ex)
        return r
    fehlt, anders, gefunden = [], [], []
    for (ev, nev, soll) in sp:
        cmd = befehl(harness, ev, name)
        treffer = [x for x in (listen[nev] or []) if _enthaelt(x, cmd)]
        if not treffer:
            fehlt.append(ev)
        elif treffer[0] != soll:
            anders.append(ev)
        gefunden.extend(treffer[:1])
    # Befehl unter einem anderen nativen Ereignis: von Hand verschoben, nicht anfassen.
    eigene = {nev for (_, nev, _) in sp}
    fremd_ort = False
    for nev, liste in (knoten or {}).items():
        if nev not in eigene and isinstance(liste, list) and any(
                _enthaelt(x, "%s %s " % (BEFEHL_PFAD, harness)) and _enthaelt_name(x, name) for x in liste):
            fremd_ort = True
    r["aktuell_sha"] = kern._wert_sha(gefunden)
    if fremd_ort:
        r["zustand"], r["grund"] = "ABGEWICHEN", "Bruecken-Befehl steht unter anderem Ereignis (von Hand)"
    elif anders:
        rec = state["eintraege"].get(kern.state_schluessel(harness, "hooks", name))
        if rec and rec.get("sha") == r["aktuell_sha"]:
            r["zustand"] = "VERALTET"
        else:
            r["zustand"], r["grund"] = "ABGEWICHEN", "Eintrag von Hand geaendert"
    elif fehlt:
        r["zustand"] = "FEHLT"
        r["grund"] = None if len(fehlt) == len(sp) else "%d von %d Ereignissen fehlen" % (len(fehlt), len(sp))
    else:
        r["zustand"] = "GLEICH"
    if hinweis and r["zustand"] == "GLEICH":
        r["grund"] = hinweis
    return r


def _enthaelt_name(x, name):
    if isinstance(x, str):
        return x.endswith(" " + name)
    if isinstance(x, dict):
        return any(_enthaelt_name(v, name) for v in x.values())
    if isinstance(x, list):
        return any(_enthaelt_name(v, name) for v in x)
    return False


def _eigene(q, reg, state, nur_harness, nur_art, roh):
    aus = {}
    for x in roh:
        if x["art"] != "hooks" or x["zustand"] != "OFFEN" or (q["hooks"].get(x["name"]) or {}).get("status"):
            continue
        z = adapter_zelle(reg, x["harness"])
        if z is None and dir_zelle(reg, x["harness"]) is not None:
            aus[(x["harness"], x["name"])] = _dir_status(x["harness"], x["name"], q["hooks"][x["name"]],
                                                         dir_zelle(reg, x["harness"]), state)
            continue
        if z is None:
            d = _datei_zeile(q, reg, state, x)
            if d is not None:
                aus[(x["harness"], x["name"])] = d
            continue
        rz = _roh_zelle(reg, x["harness"]) or {}
        if rz.get("wie"):
            # dasselbe Programm mit derselben Datei (copilot-cloud): der Eintrag gehoert dem Bezugs-Harness.
            aus[(x["harness"], x["name"])] = dict(x, zustand="LEER", ziel=z["ziel"],
                                                  grund="dieselbe Datei wie %s; Eintrag steht dort" % rz["wie"])
            continue
        aus[(x["harness"], x["name"])] = _status(x["harness"], x["name"], q["hooks"][x["name"]], z, state)
    return aus


# ---------------------------------------------------------------- Weg hooks-dir (cline)
# Je natives Ereignis eine ausfuehrbare Datei im Hook-Ordner des Harness (Name nach bruecke.dateiname,
# Vorgabe "{ereignis_nativ}", Inhalt nach bruecke.datei mit {befehl} = Bruecke OHNE Hook-Namen: die Datei
# gilt fuer alle Quell-Hooks des Ereignisses). Besitz je Datei in der Statusdatei (Schluessel
# <harness>|hooks|datei:<name>); eine Datei mit anderem Inhalt ohne Besitzvermerk ist FREMD.

def dir_zelle(reg, harness):
    z = kern.zelle(reg, harness, "hooks")
    if (isinstance(z, dict) and z.get("weg") == "hooks-dir" and z.get("ziel")
            and isinstance(z.get("bruecke"), dict) and isinstance(z["bruecke"].get("datei"), str)):
        return z
    return None


def _dir_specs(harness, name, e, z):
    """-> ([(claude_ev, dateipfad, inhalt, statusschluessel)], fehlende Ereignisse)."""
    b = z["bruecke"]
    ev_map = b.get("ereignisse") or {}
    aus, fehlen, gesehen = [], [], set()
    for roh in e["ereignisse"]:
        ev = roh.partition(":")[0]
        if ev in gesehen:
            continue
        gesehen.add(ev)
        if ev not in ev_map:
            fehlen.append(ev)
            continue
        datei = _fuellen(b.get("dateiname", "{ereignis_nativ}"), {"ereignis_nativ": ev_map[ev], "ereignis": ev})
        inhalt = _fuellen(b["datei"], {"befehl": "%s %s %s" % (BEFEHL_PFAD, harness, ev)})
        aus.append((ev, os.path.join(kern.pfad_aufloesen(z["ziel"]), datei), inhalt,
                    kern.state_schluessel(harness, "hooks", "datei:" + datei)))
    return aus, fehlen


def _lesen(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _dir_status(harness, name, e, z, state):
    r = {"harness": harness, "art": "hooks", "name": name, "ziel": z["ziel"], "zustand": "OFFEN", "grund": None,
         "_dir": True}
    sp, fehlen = _dir_specs(harness, name, e, z)
    r["specs"] = sp
    hinweis = ("Ereignis %s traegt %s nicht" % (", ".join(fehlen), harness)) if fehlen else None
    if not sp:
        r["grund"] = hinweis
        return r
    fehlt, veraltet, fremd, hand = [], [], [], []
    for (ev, p, inhalt, schl) in sp:
        if not os.path.lexists(p):
            fehlt.append(p)
            continue
        ist = _lesen(p)
        if ist == inhalt and os.access(p, os.X_OK):
            continue
        rec = state["eintraege"].get(schl)
        if rec is None:
            fremd.append(p)
        elif ist is not None and rec.get("sha") == kern._wert_sha(ist):
            veraltet.append(p)
        else:
            hand.append(p)
    r["fremd"] = bool(fremd)
    if fremd:
        r["zustand"], r["grund"] = "ABGEWICHEN", "FREMD: %s nicht von der Werkbank geschrieben, bleibt stehen" % (
            ", ".join(os.path.basename(p) for p in fremd))
    elif hand:
        r["zustand"], r["grund"] = "ABGEWICHEN", "von Hand geaendert: %s" % ", ".join(os.path.basename(p) for p in hand)
    elif veraltet:
        r["zustand"] = "VERALTET"
    elif fehlt:
        r["zustand"] = "FEHLT"
        r["grund"] = None if len(fehlt) == len(sp) else "%d von %d Dateien fehlen" % (len(fehlt), len(sp))
    else:
        r["zustand"], r["grund"] = "GLEICH", hinweis
    return r


def _dir_schreiben(x, snapshots, state):
    snap = None
    for (ev, p, inhalt, schl) in x["specs"]:
        if _lesen(p) == inhalt and os.access(p, os.X_OK):
            continue
        if os.path.lexists(p):
            snap = snapshots.sichern(x["harness"], p) or snap
        os.makedirs(os.path.dirname(p), exist_ok=True)
        atomar_schreiben.schreiben(p, inhalt, modus=0o755, newline="")
        if _lesen(p) != inhalt:
            raise kern.ZielUnlesbar("Nachpruefung %s fehlgeschlagen" % p)
        state["eintraege"][schl] = {"ziel": p, "sha": kern._wert_sha(inhalt),
                                    "zeit": datetime.datetime.now().isoformat(timespec="seconds")}
    return snap


def _datei_zeile(q, reg, state, x):
    """Harness, dessen Bruecke eine ganze Datei ist (pi-Extension, opencode-Plugin; werkzeuge_dateien
    schreibt sie als hooks.wb-hooks): der Quell-Hook steht dort nicht einzeln, die Datei ruft
    wb-hook-bruecke, und das Programm liest die Quelle selbst. Zustand je Hook = Zustand der Datei."""
    import werkzeuge_dateien
    z = kern.zelle(reg, x["harness"], "hooks")
    if not (isinstance(z, dict) and z.get("weg") in werkzeuge_dateien.HOOK_WEGE and z.get("quelle")
            and isinstance(z.get("bruecke"), dict)):
        return None
    d = werkzeuge_dateien._eintrag(x["harness"], "hooks", werkzeuge_dateien.HOOK_NAME, z["ziel"],
                                   kern.quellordner(), state, rel=z["quelle"])
    _, fehlen = specs(x["harness"], x["name"], q["hooks"][x["name"]], z)
    grund = "ueber %s (ruft %s; Datei-Eintrag hooks.%s)" % (z["ziel"], BEFEHL, werkzeuge_dateien.HOOK_NAME)
    if fehlen:
        grund += "; Ereignis %s traegt %s nicht" % (", ".join(fehlen), x["harness"])
    return dict(x, zustand=d["zustand"], ziel=z["ziel"], grund=grund)


def bewerten(eintraege, q, reg, state, nur_harness, nur_art):
    """Haken bewerten: ersetzt die OFFEN-Zeilen des Kerns fuer hooks bei Harnesses mit bruecke-Zelle."""
    if nur_art not in (None, "hooks"):
        return eintraege
    eigene = _eigene(q, reg, state, nur_harness, nur_art, eintraege)
    return [eigene.get((x["harness"], x["name"]), x) if x["art"] == "hooks" else x for x in eintraege]


def _schreiben(x, snapshots, state):
    text, daten = kern.ziel_lesen(x["ziel"])
    for (ev, nev, soll) in x["specs"]:
        liste = _liste(daten, x_zelle(x), nev, anlegen=True)
        cmd = befehl(x["harness"], ev, x["name"])
        for i, alt in enumerate(liste):
            if _enthaelt(alt, cmd):
                liste[i] = soll
                break
        else:
            liste.append(soll)
    neu = kern.json_serialisieren(daten, text)
    snap = snapshots.sichern(x["harness"], x["datei"]) if text is not None else None
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
    state["eintraege"][kern.state_schluessel(x["harness"], "hooks", x["name"])] = {
        "ziel": x["ziel"], "sha": kern._wert_sha([s[2] for s in x["specs"]]),
        "zeit": datetime.datetime.now().isoformat(timespec="seconds")}
    return snap


def x_zelle(x):
    return x["_zelle"]


def anwenden(q, reg, nur_harness, nur_art, force, zeilen):
    """Haken anwenden: schreibt FEHLT/VERALTET, ABGEWICHEN nur mit --force <harness> <hook>."""
    if nur_art not in (None, "hooks"):
        return 0
    state = kern.state_laden()
    snapshots, n = kern.Snapshots(), 0
    roh = kern._bewerten_kern(q, reg, state, nur_harness, "hooks")
    for (harness, name), x in sorted(_eigene(q, reg, state, nur_harness, "hooks", roh).items()):
        if not (x.get("_bruecke") or x.get("_dir")):
            continue
        z = x["zustand"]
        ist_force = force is not None and force[0] == harness and force[1] in (name, "hooks." + name)
        if z == "ABGEWICHEN" and (not ist_force or x["grund"].startswith("Bruecken-Befehl") or x.get("fremd")):
            zeilen.append("ABGEWICHEN  %s hooks.%s: bleibt stehen (%s)%s" % (
                harness, name, x["grund"], "" if (x["grund"].startswith("Bruecken-Befehl") or x.get("fremd"))
                else "; --force sichert und ueberschreibt"))
            continue
        if z not in ("FEHLT", "VERALTET", "ABGEWICHEN"):
            continue
        x["_zelle"] = adapter_zelle(reg, harness)
        try:
            snap = (_dir_schreiben if x.get("_dir") else _schreiben)(x, snapshots, state)
        except kern.ZielUnlesbar as ex:
            zeilen.append("ZIEL-UNLESBAR  %s %s: %s" % (harness, x["ziel"], ex))
            continue
        zeilen.append("GESCHRIEBEN  %s hooks.%s -> %s%s" % (harness, name, x["ziel"],
                                                           " (Snapshot %s)" % snap if snap else " (neu angelegt)"))
        n += 1
        kern.state_speichern(state)
    return n


def registrieren():
    """Traegt den Bruecken-Adapter in den Kern ein (idempotent)."""
    kern.adapter_registrieren("hookbruecke", bewerten=bewerten, anwenden=anwenden)
