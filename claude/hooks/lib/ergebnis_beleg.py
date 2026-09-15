#!/usr/bin/env python3
"""ergebnis_beleg.py -- die Logik hinter dem PreToolUse-Hook
ergebnis-beleg-gate.sh (docs/AGENTS-PLAN.md, Abschnitt 4 "Vergeben und
pruefen": "Ein Ergebnis zaehlt erst, wenn der Hauptagent seinen Inhalt
geprueft hat ... Ein Hook verweigert die Ergebnisdatei einer Claude-Sitzung,
solange sie keine Belegdatei gelesen hat ... nachgewiesen an ihren
Werkzeugaufrufen, nicht an einem Eintrag, den sie selbst schreibt").

Der Hook laeuft auf dem Matcher Write|Edit und tut ALLES nur, wenn
WB_AUFGABE_ID gesetzt ist -- jede andere Sitzung, auch jede interaktive,
laesst er unberuehrt (Exit 0, kein Ausgabe-JSON, also 'allow').

Ist WB_AUFGABE_ID gesetzt, unterscheidet er zwei Ziele:

  1. Ein Pfad unter ~/.pi-workers/results/ (die Ergebnisdatei EINES
     WORKERS -- ~ ist das echte $HOME des Hook-Prozesses, nicht
     WB_AUFGABE_BASE; geprueft wird die Schreibweise UND der kanonische
     Pfad, ein Symlink hinein zaehlt also mit). Beleg: ein ausgefuehrter
     Testlauf -- ein Bash-Aufruf, von dessen Teilbefehlen einer mit test,
     npm test, npm run test, cargo test, pytest, python3 -m pytest, go test,
     make test oder bash shell/tests/ beginnt oder ein Testskript mit einer
     Shell startet (bash hooks/tests/test-x.sh).
  2. Der Ergebnispfad DES HAUPTAGENTEN dieser Aufgabe (verlauf.ergebnis.pfad
     aus `wb-aufgabe zeigen <id> --json --base <base>`). Beleg: jeder
     Gate-Befehl aus auftrag.gate_commands ist als Bash-Aufruf ausgefuehrt
     worden. Ohne gate_commands gibt es nichts zu belegen -- dann wird nicht
     verweigert.

'Ausgefuehrt' heisst: zum tool_use-Block steht im Transkript ein
tool_result-Block (per tool_use_id) mit NICHT LEERER Ausgabe, der entweder
kein Fehler ist oder mit "Exit code N" beginnt -- ein Testlauf mit rotem
Ergebnis ist gelaufen und darf ehrlich berichtet werden; eine Verweigerung
oder ein Abbruch des Aufrufs traegt dieses Praefix nicht und zaehlt nicht.
Ein Read zaehlt nie, auch nicht auf eine Datei, die wie ein Testprotokoll
heisst: ihr Inhalt belegt keinen Lauf.

Das Transkript wird nicht mehr am Ende abgeschnitten (bis 2026-09-11 nur die
letzten 8 MB -- in langen Sitzungen fiel ein frueher Testlauf heraus, und
das Gate verweigerte faelschlich). Stattdessen schreibt der Hook je Aufgabe
und Transkript eine kleine Zustandsdatei fort (<base>/.local/state/
wb-ergebnis-beleg/<id>.<hash>.json): wie weit gelesen ist, welche
Bash-Aufrufe noch auf ihr Ergebnis warten und welche Befehle ausgefuehrt
wurden (begrenzt). Jeder Aufruf liest nur, was seitdem dazukam.

Trifft das Schreibziel WEDER auf 1 noch auf 2 zu, ist es keine
Ergebnisdatei im Sinne dieses Hooks -- durchgelassen, ohne Ausgabe.

Grenzen: nie laenger als eine kurze Frist (signal.alarm, wie
lib/stop_aufgabe.py) -- laeuft die Frist ab, kommt keine Ausgabe, also
'allow' (fail-open: dieser Hook ist ein Wecker, nie die letzte Instanz --
der Reviewer-Pass vor jeder Abnahme bleibt die eigentliche Pruefung,
Abschnitt 4 "Vergeben und pruefen"). Ob das Transkript selbst echt ist,
prueft dieser Hook nicht; eine Sitzung, die Transkript oder Zustandsdatei
faelscht, muss ein anderer Schutz aufhalten.
"""
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HOOKS_DIR, 'lib'))
import cmdshell as cs  # noqa: E402

FRIST_SEKUNDEN = 8
UNTERFRIST_SEKUNDEN = 6

BASH_TEST_PRAEFIXE = ('test', 'npm test', 'npm run test', 'cargo test', 'pytest',
                      'python3 -m pytest', 'python -m pytest', 'go test', 'make test',
                      'bash shell/tests/')
TESTSKRIPT_MUSTER = re.compile(r'^(?:bash|sh|zsh) (?:\S*/)?(?:tests?/\S|test[-_]\S)')
AUSGEFUEHRT_TROTZ_FEHLER = re.compile(r'^\s*Exit code [0-9]+')

MAX_BEFEHLE = 2000
MAX_OFFENE = 500
KOPF_BYTES = 4096

KENNUNG_MUSTER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


# ------------------------------------------------------------- Fristen --
def alarm_setzen():
    try:
        signal.signal(signal.SIGALRM, lambda *_: os._exit(0))
        signal.alarm(FRIST_SEKUNDEN)
    except (ValueError, OSError, AttributeError):
        pass


def kennung_ok(id_):
    return bool(id_) and bool(KENNUNG_MUSTER.fullmatch(id_)) and '..' not in id_


def subprozess_frist(ziel, args):
    try:
        r = subprocess.run([ziel, *args], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE,
                           timeout=UNTERFRIST_SEKUNDEN)
    except (OSError, subprocess.SubprocessError):
        return None
    return r


# ------------------------------------------------------------ stdin -----
def eingabe_lesen():
    try:
        roh = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    if not roh.strip():
        return {}
    try:
        daten = json.loads(roh)
    except ValueError:
        return {}
    return daten if isinstance(daten, dict) else {}


def print_deny(reason):
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': reason,
        }
    }))


# --------------------------------------------------------- wb-aufgabe ---
def wb_aufgabe_rufen(args):
    wb = shutil.which('wb-aufgabe')
    if not wb:
        return None
    return subprozess_frist(wb, args)


def aufgabe_laden(id_, base):
    """(gate_commands, ergebnis_pfad) oder (None, None) bei jedem
    Fehlschlag (kein wb-aufgabe, keine Vorratsdatei, kaputtes JSON) --
    ohne diese Daten kann nur noch die worker-Regel greifen."""
    r = wb_aufgabe_rufen(['zeigen', id_, '--json', '--base', base])
    if r is None or r.returncode != 0:
        return None, None
    try:
        daten = json.loads(r.stdout)
    except ValueError:
        return None, None
    if not isinstance(daten, dict):
        return None, None
    auftrag = daten.get('auftrag') if isinstance(daten.get('auftrag'), dict) else {}
    verlauf = daten.get('verlauf') if isinstance(daten.get('verlauf'), dict) else {}
    gate_commands = auftrag.get('gate_commands')
    gate_commands = [g for g in gate_commands if isinstance(g, str) and g.strip()] \
        if isinstance(gate_commands, list) else []
    ergebnis = verlauf.get('ergebnis') if isinstance(verlauf.get('ergebnis'), dict) else {}
    ergebnis_pfad = ergebnis.get('pfad')
    ergebnis_pfad = ergebnis_pfad.strip() if isinstance(ergebnis_pfad, str) and ergebnis_pfad.strip() else None
    return gate_commands, ergebnis_pfad


# ------------------------------------------------------------ Pfade -----
def pfad_normalisieren(pfad, cwd):
    if not pfad:
        return ''
    pfad = os.path.expanduser(pfad)
    if not os.path.isabs(pfad) and cwd:
        pfad = os.path.join(cwd, pfad)
    return os.path.normpath(pfad)


def unter_pfad(kind, eltern):
    if not kind or not eltern:
        return False
    kind = kind.rstrip(os.sep)
    eltern = eltern.rstrip(os.sep)
    return kind == eltern or kind.startswith(eltern + os.sep)


def ergebnisse_wurzel():
    return os.path.join(os.path.expanduser('~'), '.pi-workers', 'results')


# -------------------------------------------------------- Transkript ----
def _ergebnis_text(inhalt):
    if isinstance(inhalt, str):
        return inhalt
    teile = []
    if isinstance(inhalt, list):
        for teil in inhalt:
            if isinstance(teil, str):
                teile.append(teil)
            elif isinstance(teil, dict):
                for schluessel in ('text', 'content'):
                    if isinstance(teil.get(schluessel), str):
                        teile.append(teil[schluessel])
    return '\n'.join(teile)


def ausgefuehrt(tool_result):
    text = _ergebnis_text(tool_result.get('content'))
    if not text.strip():
        return False
    if tool_result.get('is_error'):
        return bool(AUSGEFUEHRT_TROTZ_FEHLER.match(text))
    return True


def zustand_datei(base, id_, transkript):
    schluessel = hashlib.sha1(os.path.abspath(transkript).encode('utf-8', 'replace')).hexdigest()[:16]
    return os.path.join(base, '.local', 'state', 'wb-ergebnis-beleg', '%s.%s.json' % (id_, schluessel))


def _kopf(daten):
    return hashlib.sha1(daten).hexdigest()


def _zustand_laden(pfad):
    try:
        with open(pfad, 'r', encoding='utf-8') as f:
            daten = json.load(f)
    except (OSError, ValueError):
        return None
    return daten if isinstance(daten, dict) else None


def _zustand_speichern(pfad, zustand):
    try:
        os.makedirs(os.path.dirname(pfad), exist_ok=True)
        tmp = '%s.%d.tmp' % (pfad, os.getpid())
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(zustand, f)
        os.replace(tmp, pfad)
    except OSError:
        pass  # dann liest der naechste Aufruf eben wieder von vorn


def _eintrag_verarbeiten(e, offene, befehle, gesehen):
    if not isinstance(e, dict) or not isinstance(e.get('message'), dict):
        return
    inhalt = e['message'].get('content')
    if not isinstance(inhalt, list):
        return
    for teil in inhalt:
        if not isinstance(teil, dict):
            continue
        if e.get('type') == 'assistant' and teil.get('type') == 'tool_use' and teil.get('name') == 'Bash':
            eingabe = teil.get('input') if isinstance(teil.get('input'), dict) else {}
            if teil.get('id') and isinstance(eingabe.get('command'), str):
                offene[teil['id']] = eingabe['command']
        elif e.get('type') == 'user' and teil.get('type') == 'tool_result':
            befehl = offene.pop(teil.get('tool_use_id'), None)
            if befehl is not None and ausgefuehrt(teil) and befehl not in gesehen:
                befehle.append(befehl)
                gesehen.add(befehl)


def ausgefuehrte_befehle(transkript, zustand_pfad):
    """Alle ausgefuehrten Bash-Befehle dieses Transkripts, fortgeschrieben
    ueber die Zustandsdatei: gelesen wird nur, was seit dem letzten Aufruf
    dazukam; ein ausgetauschtes oder gekuerztes Transkript beginnt von vorn."""
    try:
        st = os.stat(transkript)
    except OSError:
        return []
    zustand = _zustand_laden(zustand_pfad) if zustand_pfad else None
    try:
        with open(transkript, 'rb') as f:
            if (not zustand or zustand.get('pfad') != transkript or zustand.get('dev') != st.st_dev
                    or zustand.get('ino') != st.st_ino or not isinstance(zustand.get('offset'), int)
                    or zustand['offset'] > st.st_size or not isinstance(zustand.get('offene'), dict)
                    or not isinstance(zustand.get('befehle'), list)
                    or _kopf(f.read(zustand.get('kopf_laenge') or 0)) != zustand.get('kopf')):
                # Neu, ausgetauscht, gekuerzt oder an Ort und Stelle
                # umgeschrieben (anderer Anfang): von vorn lesen.
                zustand = {'pfad': transkript, 'dev': st.st_dev, 'ino': st.st_ino,
                           'offset': 0, 'offene': {}, 'befehle': []}
            f.seek(zustand['offset'])
            daten = f.read()
            f.seek(0)
            anfang = f.read(KOPF_BYTES)
    except OSError:
        return list(zustand['befehle']) if zustand else []
    ende = daten.rfind(b'\n') + 1
    offene = dict(zustand['offene'])
    befehle = [b for b in zustand['befehle'] if isinstance(b, str)]
    gesehen = set(befehle)
    for zeile in daten[:ende].split(b'\n'):
        if b'"tool_use"' not in zeile and b'"tool_result"' not in zeile:
            continue
        try:
            _eintrag_verarbeiten(json.loads(zeile), offene, befehle, gesehen)
        except ValueError:
            continue
    zustand['offset'] += ende
    zustand['kopf_laenge'] = len(anfang)
    zustand['kopf'] = _kopf(anfang)
    zustand['offene'] = dict(list(offene.items())[-MAX_OFFENE:])
    zustand['befehle'] = befehle[-MAX_BEFEHLE:]
    if zustand_pfad:
        _zustand_speichern(zustand_pfad, zustand)
    # Eine letzte Zeile ohne Zeilenende kann schon vollstaendig sein -- sie
    # zaehlt fuer diesen Aufruf, fortgeschrieben wird sie erst mit '\n'.
    rest = daten[ende:].strip()
    if rest:
        try:
            _eintrag_verarbeiten(json.loads(rest), offene, befehle, gesehen)
        except ValueError:
            pass
    return befehle


def _teilbefehle(befehl):
    texte = [befehl.strip()]
    for stmt in cs.all_statements(cs.strip_heredocs(befehl)):
        if not stmt:
            continue
        if stmt[0] == 'timeout':
            rest = stmt[1:]
            while rest and rest[0].startswith('-'):
                rest = rest[1:]
            stmt = rest[1:]
        texte.append(' '.join(stmt))
    return texte


def bash_gilt_als_testlauf(befehl):
    for b in _teilbefehle(befehl or ''):
        if not b:
            continue
        if TESTSKRIPT_MUSTER.match(b):
            return True
        for p in BASH_TEST_PRAEFIXE:
            if p.endswith('/'):
                if b.startswith(p):
                    return True
            elif b == p or b.startswith(p + ' '):
                return True
    return False


def fehlende_gate_befehle(befehle, gate_commands):
    gelaufen = set()
    for b in befehle:
        gelaufen.update(_teilbefehle(b))
    fehlend = []
    for g in gate_commands:
        normal = [' '.join(s) for s in cs.all_statements(g) if s]
        if g.strip() not in gelaufen and not (len(normal) == 1 and normal[0] in gelaufen):
            fehlend.append(g)
    return fehlend


# ------------------------------------------------------------- Logik ----
def main():
    alarm_setzen()
    eingabe = eingabe_lesen()

    tool_name = eingabe.get('tool_name')
    if tool_name not in ('Write', 'Edit'):
        return 0

    id_ = (os.environ.get('WB_AUFGABE_ID') or '').strip()
    if not id_ or not kennung_ok(id_):
        return 0  # interaktive Sitzungen und fremde Kennungen: nichts tun

    tool_input = eingabe.get('tool_input') if isinstance(eingabe.get('tool_input'), dict) else {}
    ziel_roh = tool_input.get('file_path')
    if not isinstance(ziel_roh, str) or not ziel_roh.strip():
        return 0
    cwd = str(eingabe.get('cwd') or '')
    ziel = pfad_normalisieren(ziel_roh, cwd)
    ziel_kanonisch = os.path.realpath(ziel)

    base = os.environ.get('WB_AUFGABE_BASE') or os.path.expanduser('~')

    modus = None
    wurzel = ergebnisse_wurzel()
    if unter_pfad(ziel, wurzel) or unter_pfad(ziel_kanonisch, os.path.realpath(wurzel)):
        modus = 'worker'
    else:
        _, ergebnis_pfad = aufgabe_laden(id_, base)
        if ergebnis_pfad:
            erwartet = pfad_normalisieren(ergebnis_pfad, cwd)
            if ziel == erwartet or ziel_kanonisch == os.path.realpath(erwartet):
                modus = 'hauptagent'

    if modus is None:
        return 0  # kein Ergebnispfad im Sinne dieses Hooks

    transcript = str(eingabe.get('transcript_path') or '')
    befehle = ausgefuehrte_befehle(transcript, zustand_datei(base, id_, transcript)) if transcript else []

    if modus == 'worker':
        if any(bash_gilt_als_testlauf(b) for b in befehle):
            return 0
        print_deny(
            "Ergebnisdatei ohne Beleg ('%s'): in diesem Transkript steht kein "
            "ausgefuehrter Testlauf mit nicht leerer Ausgabe. Ein Read auf eine "
            "Datei reicht nicht; fuehre den Testlauf aus (test, npm test, cargo "
            "test, pytest, bash shell/tests/... oder ein Testskript) und sieh Dir "
            "sein Ergebnis an, bevor Du diese Datei schreibst." % ziel_roh)
        return 0

    # modus == 'hauptagent'
    gate_commands, _ = aufgabe_laden(id_, base)
    gate_commands = gate_commands or []
    if not gate_commands:
        return 0  # nichts verabredet, also nichts zu belegen
    fehlend = fehlende_gate_befehle(befehle, gate_commands)
    if not fehlend:
        return 0
    print_deny(
        "Ergebnisdatei der Aufgabe '%s' ohne Beleg: das Gate-Protokoll steht "
        "nicht vollstaendig im Transkript. Fehlende Gate-Befehle: %s. Fuehre "
        "sie aus und sieh Dir ihre Ausgabe an, bevor Du das Ergebnis schreibst."
        % (id_, '; '.join(fehlend)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
