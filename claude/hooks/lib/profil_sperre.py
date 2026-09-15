#!/usr/bin/env python3
"""profil_sperre.py -- die Logik hinter dem PreToolUse-Hook profil-sperre.sh
(docs/AGENTS-PLAN.md, Abschnitt 3 "Die Sperre" und Abschnitt 8 Regel 5 "Kein
Eingriff ausserhalb der Welt"; docs/AGENTS-SPERREN.md).

Der Hook greift NUR in einem Agentenzug: WB_AGENT_ID und WB_WELT sind gesetzt
(der Traeger setzt sie, siehe agents_skills.profil_umgebung). Ohne beide keine
Ausgabe; halbe oder ungueltige Umgebung wird verweigert.

Massgeblich ist <WB_WELT>/agents/<id>/agent.json: Werkzeugliste `tools`,
Bash-Muster `bash`, Kontextgrenze `context_limit`, Stufe `stage`. Laesst sich
das Profil nicht lesen oder die Hausliste gesperrter Programme
(wb-profil-gesperrt.json neben wb-profil) nicht laden, wird jedes Werkzeug
verweigert (fail-closed).

Vier Pruefungen:

  1. Werkzeug: nur Werkzeuge aus `tools` (MultiEdit zaehlt als Edit).
  2. Bash: jede ausfuehrbare Stufe -- auch in $( ), Backticks, eval,
     <shell> -c, Here-Docs an eine Shell, hinter Wrappern und xargs -- muss
     auf ein Muster passen (dieselbe Mustersprache wie die Rollen-Sperre:
     reviewer_sperre.muster_passt), und keine Stufe darf auf der Hausliste
     stehen, egal was das Muster erlaubt. Frei sind nur Shell-Bausteine
     ohne eigene Wirkung (set, echo, test, ...), Kontrollwoerter und im
     selben Befehl definierte Funktionen; deren Rumpf wird wie jeder Befehl
     geprueft.
  3. Weltgrenze fuer Bash-Pfade (Argumente, Umleitungen, cd, ausgefuehrte
     Programme) und Read/Write/Edit/Glob/Grep:
       lesen:     Projektordner, Worktree, Weltablage, Agentenverzeichnis,
                  Skill- und Skriptpfade und beide Bibliotheken aus der
                  Umgebung, ~/Knowledge, ~/.local/bin; Programme zusaetzlich
                  aus den Systemordnern und den PATH-Ordnern ausserhalb von
                  $HOME;
       schreiben: Projektordner, Worktree, eigenes Agentenverzeichnis, das
                  eigene Temp-Verzeichnis (WB_AGENT_TMP); der Hauptagent
                  zusaetzlich ~/Knowledge. In der Weltablage nur das eigene
                  Agentenverzeichnis (eigene skills/ und skripte/ darin),
                  und dort nie agent.json, skills.json, history.json,
                  runtime.json oder das Postfach; freigaben.json und
                  traeger.json nirgends. Welt- und Bibliotheksskripte sind
                  damit wie Weltskills nie beschreibbar.
     Die Kontextgrenze sperrt Pfade, die sie in `...` oder als Pfadwort nennt,
     auch fuer das Lesen.
  4. Zugaenge der Welt (<WB_WELT>/zugaenge.json, docs/AGENTS-SPERREN.md): nur
     wenn der Traeger sie im Zug bereitgestellt hat (WB_ZUGAENGE nennt den
     Ordner, darin je Zugang ein Unterordner). Ihre Muster geben ssh, scp und
     rsync frei, aber nur ueber den nackten Programmnamen (die Huelle des
     Zuges), ohne Wrapper, Variablen, Umleitung von PATH oder fremde Optionen;
     der Zugangsordner selbst ist fuer jeden Zugriff gesperrt.

Die Bash-Zerlegung ist lib/cmdshell.py. Grenzen: siehe hooks/README.md.
"""
import fnmatch
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import signal
import stat
import sys
import unicodedata

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_DIR = os.path.join(HOOKS_DIR, 'lib')
sys.path.insert(0, LIB_DIR)
import cmdshell as cs  # noqa: E402
from reviewer_sperre import muster_aufteilen, muster_passt  # noqa: E402  (dieselbe Mustersprache)

FRIST_SEKUNDEN = 7
MAX_DEPTH = 4
ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
PROFIL_LIMIT = 1024 * 1024
WERKZEUG_ALIAS = {'MultiEdit': 'Edit'}
SCHREIBWERKZEUGE = {'Write', 'Edit', 'MultiEdit', 'NotebookEdit'}
LESEWERKZEUGE = {'Read', 'Glob', 'Grep'}
# Shell-Bausteine ohne eigene Wirkung: sie starten kein Programm und schreiben
# nur ueber Umleitungen, die die Weltgrenze ohnehin prueft.
BAUSTEINE = {'set', 'shift', 'exit', 'return', 'true', 'false', ':', 'test', '[', '[[', ']]', 'echo', 'printf',
             'local', 'export', 'declare', 'typeset', 'readonly', 'unset', 'read', 'pwd', 'break', 'continue',
             'cd', 'wait', 'umask', 'getopts'}
KONTROLLE_MIT_BEFEHL = {'if', 'elif', 'while', 'until', '!'}
KONTROLLE_OHNE_BEFEHL = {'for', 'case', 'select', 'in', 'esac', ';;', 'function'}
ZUWEISUNGS_BEFEHLE = {'export', 'declare', 'typeset', 'local', 'readonly'}
HARMLOSE_ZIELE = {'/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'}
MUTIERENDE = {'rm', 'rmdir', 'unlink', 'shred', 'mv', 'cp', 'install', 'ln', 'rsync', 'touch', 'chmod',
              'chown', 'chgrp', 'truncate', 'tee', 'dd', 'mkdir', 'patch'}
QUELLE_ZIEL = {'cp', 'install', 'rsync', 'ln'}
RECHTEERHOEHUNG = {'sudo', 'doas', 'su', 'pkexec'}
SONDERVARIABLE_RE = re.compile(r'\$\{?[0-9@*#]')
MIT_I_OPTION = {'sed', 'perl', 'ruby'}
SYSTEM_PROGRAMME = ('/bin', '/usr/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/usr/libexec')
GESCHUETZT_EIGEN = {'agent.json', 'skills.json', 'history.json', 'runtime.json'}
GESCHUETZT_UEBERALL = {'freigaben.json', 'traeger.json', 'zugaenge.json'}
ZUGANG_PROGRAMME = {'ssh', 'scp', 'rsync'}
ZUGANG_NAME_RE = re.compile(r'^[a-z][a-z0-9-]{0,39}$')
ZUGANG_LIMIT = 256 * 1024
# Optionen ohne eigenes Argument, die lokal nichts ausfuehren; alles andere (-e, -o, -F, -S, --rsh, ...) ist gesperrt.
SCP_BUCHSTABEN = set('rpqCv346')
RSYNC_BUCHSTABEN = set('avzrlptgoDhPcnuqiHmx')
RSYNC_LANG = {'--archive', '--verbose', '--compress', '--recursive', '--links', '--perms', '--times', '--delete',
              '--progress', '--partial', '--dry-run', '--checksum', '--update', '--human-readable', '--stats',
              '--itemize-changes', '--mkpath', '--one-file-system'}
RSYNC_LANG_WERT = ('--exclude=', '--include=')
PATH_RE = re.compile(r'(?<![A-Za-z0-9_])PATH(?![A-Za-z0-9_])')
IFS_RE = re.compile(r'\$\{?IFS')
# Funktionsdefinition am Anfang einer Anweisung: `f() {`, `f () (` oder `function f`. Gesucht wird im
# Text ohne Anfuehrungen, damit `echo "curl()"` keine Funktion curl erfindet.
FUNKTION_RE = re.compile(r'(?:^|[;&|\n]|&&|\|\|)\s*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)'
                         r'|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*[{(])')
ANFUEHRUNG_RE = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
VARIABLE_RE = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)')

_ausgegeben = False


class Verweigert(Exception):
    """Grund einer Verweigerung."""


def _deny_json(reason):
    return json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
        'permissionDecisionReason': reason}}, ensure_ascii=False)


def print_deny(reason):
    global _ausgegeben
    _ausgegeben = True
    print(_deny_json('Profil-Sperre: ' + reason), flush=True)


def _frist_abgelaufen(*_):
    if not _ausgegeben:
        try:
            os.write(1, (_deny_json('Profil-Sperre: Pruefung hat ihre Frist ueberschritten -- '
                                    'ohne Ergebnis bleibt der Zugriff gesperrt.') + '\n').encode())
        except OSError:
            pass
    os._exit(0)


def alarm_setzen():
    try:
        signal.signal(signal.SIGALRM, _frist_abgelaufen)
        signal.alarm(FRIST_SEKUNDEN)
    except (ValueError, OSError, AttributeError):
        pass


def _unter(pfad, wurzel):
    return bool(wurzel) and (pfad == wurzel or pfad.startswith(wurzel.rstrip(os.sep) + os.sep))


def _datei_lesen(pfad, grenze):
    fd = os.open(pfad, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > grenze:
            raise OSError('keine gewoehnliche Datei oder zu gross')
        return os.read(fd, grenze + 1)
    finally:
        os.close(fd)


# ------------------------------------------------------------ Hausliste --
def _norm(text):
    return unicodedata.normalize('NFKC', text or '').lower()


class Hausliste:
    """Die Hausliste aus wb-profil, auf Befehle angewandt: eine Programmregel trifft den
    Programmnamen (Basisname, NFKC, ohne Gross/Klein), ihre `erfordert`-Teile die Argumente --
    ein Kurzoptionsbuendel wie `-rf` auch zerlegt (`-r -f`, `-fR`); eine Musterregel trifft den
    ganzen Befehlstext. Anders als die Profilpruefung in wb-profil zaehlt ein Programmname in einem
    Argument (`git commit -m "kill"`) nicht."""

    def __init__(self, daten):
        self.programme = [r for r in daten.get('programme', []) if isinstance(r, dict) and r.get('programm')]
        self.muster = [r for r in daten.get('muster', []) if isinstance(r, dict) and r.get('enthaelt')]

    @staticmethod
    def _erfordert(teil, worte):
        teil = _norm(teil)
        if teil in worte:
            return True
        if re.fullmatch(r'-[a-z]{2,}', teil):
            buchstaben = set()
            for w in worte:
                if re.fullmatch(r'-[a-z]+', w):
                    buchstaben.update(w[1:])
            return set(teil[1:]) <= buchstaben
        return any(teil in w for w in worte)

    def stufe(self, programm, worte):
        name = _norm(os.path.basename(programm))
        klein = [_norm(w) for w in worte]
        for regel in self.programme:
            if name == _norm(regel['programm']) and all(self._erfordert(t, klein) for t in regel.get('erfordert', [])):
                return regel.get('grund') or regel['programm']
        return None

    def text(self, befehl):
        norm = _norm(befehl)
        for regel in self.muster:
            if _norm(regel['enthaelt']) in norm:
                return regel.get('grund') or regel['enthaelt']
        return None


def hausliste_laden():
    """Hausliste aus wb-profil; Verweigert, wenn nicht ladbar oder leer."""
    ziel = os.environ.get('WB_PROFIL_BIN') or shutil.which('wb-profil')
    if not ziel or not os.path.isfile(ziel):
        raise Verweigert('wb-profil fehlt -- ohne Hausliste gesperrter Programme ist nichts erlaubt')
    try:
        loader = importlib.machinery.SourceFileLoader('wb_profil_hausliste', ziel)
        spec = importlib.util.spec_from_loader(loader.name, loader)
        modul = importlib.util.module_from_spec(spec)
        loader.exec_module(modul)
        gesperrt = modul.gesperrt_laden()
    except Exception:  # noqa: BLE001 - jeder Ladefehler sperrt
        raise Verweigert('Hausliste gesperrter Programme (wb-profil) laesst sich nicht laden')
    if not isinstance(gesperrt, dict) or not gesperrt.get('programme'):
        raise Verweigert('Hausliste gesperrter Programme ist leer oder unlesbar -- ohne sie ist nichts erlaubt')
    return Hausliste(gesperrt)


# --------------------------------------------------------------- Profil --
def _kontext_muster(text, home):
    """Pfade und Muster, die eine Kontextgrenze nennt: Text in Backticks oder Woerter, die
    mit /, ~/ oder ./ beginnen. Ein Satz ohne solche Angaben sperrt keinen Pfad."""
    kandidaten = re.findall(r'`([^`]+)`', text or '')
    for wort in re.split(r'\s+', re.sub(r'`[^`]*`', ' ', text or '')):
        wort = wort.strip('.,;:!?()"\'')
        if wort.startswith(('/', '~/', './')):
            kandidaten.append(wort)
    muster = []
    for k in kandidaten:
        k = k.strip()
        if not k or not (k.startswith(('/', '~', '.')) or '*' in k or '/' in k):
            continue
        k = home + k[1:] if k.startswith('~') else k
        muster.append(k.rstrip('/') or '/')
    return muster


def _kontext_aufloesen(muster, projekt):
    """Absolute Muster bleiben; relative gelten unter dem Projektordner, ohne Projekt gar nicht."""
    result = []
    for m in muster:
        if not os.path.isabs(m):
            if not projekt:
                continue
            m = os.path.join(projekt, m[2:] if m.startswith('./') else m)
        result.append(m if '*' in m else os.path.realpath(m))
    return result


class Profil:
    def __init__(self, welt, agent, daten, hausliste, umgebung):
        self.welt_roh = welt
        self.welt = os.path.realpath(welt)
        self.agent = agent
        self.home = os.path.realpath(os.path.expanduser('~'))
        self.stufe = daten.get('stage')
        tools = daten.get('tools')
        bash = daten.get('bash') if daten.get('bash') is not None else []
        grenze = daten.get('context_limit') or ''
        if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools) \
                or not isinstance(bash, list) or not all(isinstance(b, str) for b in bash) \
                or not isinstance(grenze, str) or daten.get('id') != agent:
            raise Verweigert('agent.json ist unvollstaendig oder gehoert nicht zu %s' % agent)
        self.tools = set(tools)
        self.muster, self.generisch = muster_aufteilen(bash)
        self.hausliste = hausliste
        self.eigenes = os.path.realpath(os.path.join(welt, 'agents', agent))
        self.agenten = os.path.realpath(os.path.join(welt, 'agents'))

        def verzeichnis(name, pflicht=False):
            wert = (umgebung.get(name) or '').strip()
            if not wert:
                return None
            if not os.path.isabs(wert) or not os.path.isdir(wert):
                raise Verweigert('%s ist kein absoluter Ordner' % name)
            real = os.path.realpath(wert)
            if real in ('/', self.home):
                raise Verweigert('%s umfasst zu viel (%s)' % (name, real))
            return real

        self.projekt = verzeichnis('WB_WELT_PROJEKT')
        self.worktree = verzeichnis('WB_AGENT_WORKTREE')
        self.tmp = verzeichnis('WB_AGENT_TMP')
        self.bibliothek = verzeichnis('WB_SKILL_BIBLIOTHEK')
        self.skriptbibliothek = verzeichnis('WB_SKRIPT_BIBLIOTHEK')
        self.zugang_ordner = verzeichnis('WB_ZUGAENGE')
        self.zugaenge = zugaenge_laden(welt, self.zugang_ordner)
        # Skill- und Skriptpfade aus skills.json (skills_umgebung): lesbar und ausfuehrbar, nie beschreibbar.
        self.skillpfade = [os.path.realpath(p) for name in ('WB_SKILL_PFADE', 'WB_SKRIPT_PFADE')
                           for p in (umgebung.get(name) or '').split(os.pathsep) if p and os.path.isabs(p)]
        self.kontext = _kontext_aufloesen(_kontext_muster(grenze, self.home), self.projekt)
        self.knowledge = os.path.realpath(os.path.join(self.home, 'Knowledge'))
        self.localbin = os.path.realpath(os.path.join(self.home, '.local', 'bin'))

    def lesewurzeln(self):
        return [w for w in [self.projekt, self.worktree, self.welt, self.tmp, self.bibliothek, self.skriptbibliothek,
                            self.knowledge, self.localbin] + self.skillpfade if w]

    def schreibwurzeln(self):
        result = [w for w in (self.projekt, self.worktree, self.eigenes, self.tmp) if w]
        if self.stufe == 'hauptagent':
            result.append(self.knowledge)
        return result

    def kontext_trifft(self, real):
        for m in self.kontext:
            if '*' in m:
                if fnmatch.fnmatch(real, m) or fnmatch.fnmatch(real, m.rstrip('/') + '/*'):
                    return m
            elif _unter(real, m):
                return m
        return None

    def pfad(self, roh, real, art):
        """Verweigert, wenn der kanonische Pfad fuer die Art lesen|schreiben|ausfuehren
        ausserhalb der Weltgrenze liegt oder geschuetzt ist."""
        if real in HARMLOSE_ZIELE:
            return
        if self.zugang_ordner and _unter(real, self.zugang_ordner):
            raise Verweigert("'%s' liegt im Zugangsordner des Zuges; Schluessel und Konfiguration liest nur ssh selbst"
                             % roh)
        treffer = self.kontext_trifft(real)
        if treffer:
            raise Verweigert("'%s' liegt in der Kontextgrenze des Profils (%s)" % (roh, treffer))
        if art == 'schreiben':
            if os.path.basename(real) in GESCHUETZT_UEBERALL:
                raise Verweigert("'%s' ist eine Freigabe- oder Traegerdatei; Agenten schreiben sie nie" % roh)
            if _unter(real, self.welt):
                if not _unter(real, self.eigenes) or real == self.eigenes:
                    raise Verweigert("'%s' liegt in der Weltablage ausserhalb des eigenen Agentenverzeichnisses" % roh)
                teile = os.path.relpath(real, self.eigenes).split(os.sep)
                if teile[0] in GESCHUETZT_EIGEN or teile[0] == 'postfach':
                    raise Verweigert("'%s' schreibt nur die Werkbank, nicht der Agent selbst" % roh)
                return
            if not any(_unter(real, w) for w in self.schreibwurzeln()):
                raise Verweigert("'%s' liegt ausserhalb von Projekt, Worktree und Agentenverzeichnis" % roh)
            return
        wurzeln = self.lesewurzeln()
        if art == 'ausfuehren':
            wurzeln = wurzeln + programmordner(self.home)
        if not any(_unter(real, w) for w in wurzeln):
            raise Verweigert("'%s' liegt ausserhalb der Welt (lesen nur Projekt, Worktree, Weltablage, Skills und "
                             "Skripte aus skills.json, ~/Knowledge und ~/.local/bin)" % roh)


def zugaenge_laden(welt, ordner):
    """Zugaenge der Welt, die der Traeger in diesem Zug bereitgestellt hat: {name: [muster]}.

    Ohne WB_ZUGAENGE, ohne zugaenge.json oder bei unlesbarer Datei keine Freigabe; ein Zugang
    zaehlt nur, wenn sein Unterordner im Zugangsordner liegt."""
    if not ordner:
        return {}
    pfad = os.path.join(welt, 'zugaenge.json')
    try:
        daten = json.loads(_datei_lesen(pfad, ZUGANG_LIMIT).decode('utf-8'))
    except (OSError, UnicodeDecodeError, ValueError):
        return {}
    eintraege = daten.get('zugaenge') if isinstance(daten, dict) else None
    result = {}
    for eintrag in eintraege if isinstance(eintraege, list) else []:
        if not isinstance(eintrag, dict):
            continue
        name = eintrag.get('name')
        muster = eintrag.get('muster')
        if not isinstance(name, str) or not ZUGANG_NAME_RE.match(name) or (eintrag.get('art') or 'ssh') != 'ssh':
            continue
        if muster is None:
            muster = ['ssh %s *' % name, 'scp *%s:*' % name, 'rsync *%s:*' % name]
        if not isinstance(muster, list) or not all(isinstance(m, str) for m in muster):
            continue
        unter = os.path.join(ordner, name)
        if os.path.islink(unter) or not os.path.isdir(unter):
            continue
        gueltig, _generisch = muster_aufteilen([m for m in muster if m.split()[:1] and m.split()[0] in ZUGANG_PROGRAMME])
        if gueltig:
            result[name] = gueltig
    return result


def programmordner(home):
    """Systemordner und die PATH-Ordner des Hooks ausserhalb von $HOME; den PATH setzt der Traeger."""
    ordner = [os.path.realpath(p) for p in SYSTEM_PROGRAMME]
    for eintrag in (os.environ.get('PATH') or '').split(os.pathsep):
        if os.path.isabs(eintrag) and os.path.isdir(eintrag):
            real = os.path.realpath(eintrag)
            if not _unter(real, home) and real != '/':
                ordner.append(real)
    return ordner


def profil_laden():
    """None ohne Agentenzug, sonst Profil oder Verweigert."""
    agent = (os.environ.get('WB_AGENT_ID') or '').strip()
    welt = (os.environ.get('WB_WELT') or '').strip()
    if not agent and not welt:
        return None
    if not agent or not welt:
        raise Verweigert('WB_AGENT_ID und WB_WELT muessen beide gesetzt sein')
    if not ID_RE.fullmatch(agent):
        raise Verweigert('WB_AGENT_ID ist ungueltig')
    if not os.path.isabs(welt) or not os.path.isdir(welt):
        raise Verweigert('WB_WELT ist kein absoluter Weltordner')
    welt = os.path.abspath(welt)
    pfad = os.path.join(welt, 'agents', agent, 'agent.json')
    for teil in (os.path.join(welt, 'agents'), os.path.join(welt, 'agents', agent), pfad):
        if os.path.islink(teil):
            raise Verweigert('Pfad zu agent.json enthaelt einen Symlink')
    gemeldet = (os.environ.get('WB_AGENT_PROFIL') or '').strip()
    if gemeldet and os.path.realpath(gemeldet) != os.path.realpath(pfad):
        raise Verweigert('WB_AGENT_PROFIL zeigt nicht auf agent.json des Agenten')
    try:
        daten = json.loads(_datei_lesen(pfad, PROFIL_LIMIT).decode('utf-8'))
    except (OSError, UnicodeDecodeError, ValueError):
        raise Verweigert('agent.json des Agenten laesst sich nicht lesen -- ohne Profil ist nichts erlaubt')
    if not isinstance(daten, dict):
        raise Verweigert('agent.json ist kein Objekt')
    return Profil(welt, agent, daten, hausliste_laden(), os.environ)


# ------------------------------------------------------------- Pfade ----
def _variablen(wort, varmap):
    def ersetzen(m):
        name = m.group(1) or m.group(2)
        return varmap[name] if name in varmap else os.environ.get(name, '')

    for _ in range(6):
        neu = VARIABLE_RE.sub(ersetzen, wort)
        if neu == wort:
            break
        wort = neu
    return wort


def _expandieren(wort, varmap, home):
    wert = _variablen(wort, varmap)
    if '$(' in wert or '`' in wert:
        return None
    if wert == '~' or wert.startswith('~/'):
        wert = home + wert[1:]
    return wert


def _ist_pfadwort(wert, cwd, schreibend):
    """Ob ein Argument als Pfad gilt. Absolute Woerter nur, wenn ihr erster Bestandteil
    existiert (`/api/` ist eher ein Muster als ein Pfad); relative mit ./, ../, .. oder wenn
    sie im Arbeitsverzeichnis existieren; bei schreibenden Befehlen jedes Wort."""
    if not wert or wert.startswith('-') or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://', wert):
        return False
    if wert.startswith('/'):
        erstes = wert.lstrip('/').split('/', 1)[0]
        return schreibend or not erstes or os.path.lexists('/' + erstes)
    if wert in ('.', '..') or wert.startswith(('./', '../')) or '/../' in wert or wert.endswith('/..'):
        return True
    return schreibend or os.path.lexists(os.path.join(cwd, wert))


class Pruefung:
    def __init__(self, profil):
        self.p = profil

    def zugriff(self, wort, varmap, cwd, art, immer=False):
        if wort.startswith('--') and '=' in wort:
            wort = wort.split('=', 1)[1]
        if art in ('schreiben', 'ausfuehren') and _unbestimmt(wort, varmap):
            raise Verweigert("'%s' nimmt sein Ziel aus einer Variablen, die erst zur Laufzeit feststeht" % wort)
        wert = _expandieren(wort, varmap, self.p.home)
        if wert is None:
            if art in ('schreiben', 'ausfuehren'):
                raise Verweigert("'%s' enthaelt eine Kommandosubstitution; Ziel nicht pruefbar" % wort)
            return
        if not immer and not _ist_pfadwort(wert, cwd, art == 'schreiben'):
            return
        if '*' in wert or '?' in wert or '[' in wert:
            wert = re.split(r'[*?\[]', wert, 1)[0] or '.'
        absolut = wert if os.path.isabs(wert) else os.path.join(cwd, wert)
        self.p.pfad(wort, os.path.realpath(absolut), art)

    def muster(self, text, voll):
        if not any(muster_passt(text, m) or muster_passt(voll, m) for m in self.p.muster):
            hinweis = ''
            if self.p.generisch:
                hinweis = ' (die Profilmuster %s geben als Wrapper oder Interpreter nichts frei)' % \
                    ', '.join("'%s'" % g for g in self.p.generisch)
            raise Verweigert("'%s' steht nicht in den Bash-Mustern des Agenten%s" % (text, hinweis))

    def hausliste_text(self, befehl):
        grund = self.p.hausliste.text(befehl)
        if grund:
            raise Verweigert("Befehl beruehrt ein gesperrtes Muster der Hausliste: %s" % grund)

    def hausliste_stufe(self, programm, worte):
        grund = self.p.hausliste.stufe(programm, worte)
        if grund:
            raise Verweigert("'%s' steht auf der Hausliste gesperrter Programme: %s"
                             % (' '.join([programm] + worte), grund))

    def bash(self, command, cwd, depth=0, funktionen=None):
        if depth > MAX_DEPTH:
            raise Verweigert('Kommando zu tief verschachtelt')
        if IFS_RE.search(command):
            raise Verweigert('IFS-Expansion ist nicht sicher aufloesbar')
        ohne_anfuehrung = ANFUEHRUNG_RE.sub('""', command)
        funktionen = set(funktionen or ()) | {a or b for a, b in FUNKTION_RE.findall(ohne_anfuehrung)}
        teile = cs.heredoc_split(command)
        if not teile.complete:
            raise Verweigert('Here-Doc ohne Abschlusszeile')
        subs, vollstaendig = cs.command_substitutions(teile.text_subs)
        if not vollstaendig:
            raise Verweigert('unvollstaendige Kommandosubstitution')
        for b in teile.bodies:
            if b['top'] and not b['quoted']:
                weitere, vollstaendig = cs.command_substitutions(b['body'], quotes=False)
                if not vollstaendig:
                    raise Verweigert('unvollstaendige Kommandosubstitution im Here-Doc')
                subs.extend(weitere)
        for inner in subs:
            self.bash(inner, cwd, depth + 1, funktionen)
        for b in teile.bodies:
            if not b['top']:
                continue
            kopf = cs.all_statements(b['prefix'])
            if not kopf or kopf[-1] is None or not cs.split_pipeline(kopf[-1]):
                raise Verweigert('Here-Doc ohne erkennbaren Empfaenger')
            name, _i, rest = cs.resolve_command(cs.split_pipeline(kopf[-1])[-1], {})
            if name in cs.SHELL_INTERPRETERS and not cs.shell_c_script(rest)[0]:
                self.bash(b['body'], cwd, depth + 1, funktionen)
        leser = cs.process_substitution_script(teile.text)
        if leser:
            raise Verweigert('%s liest sein Skript aus einer Prozess-Substitution' % leser)
        anweisungen = cs.all_statements(teile.text)
        if anweisungen == [None]:
            raise Verweigert('Kommando nicht zerlegbar')
        for stmt, varmap in zip(anweisungen, cs.assignment_prefixes(anweisungen)):
            for raw_stage in cs.split_pipeline(stmt, strip=False):
                cwd = self.stufe(raw_stage, varmap, cwd, depth, funktionen)

    def stufe(self, raw_stage, varmap, cwd, depth, funktionen):
        for _op, ziel in cs.output_redirections(raw_stage):
            if ziel and ziel not in HARMLOSE_ZIELE and not re.fullmatch(r'&?[0-9-]', ziel):
                self.zugriff(ziel, varmap, cwd, 'schreiben', immer=True)
        for quelle in _eingaben(raw_stage):
            self.zugriff(quelle, varmap, cwd, 'lesen', immer=True)
        stage = cs.strip_redirections(raw_stage)
        name, idx, rest = cs.resolve_command(stage, varmap)
        if name is None:
            if any(t.startswith('IFS=') for t in stage):
                raise Verweigert('IFS-Aenderung ist nicht sicher aufloesbar')
            return cwd
        if name in (cs.SUBSHELL_TOKEN, cs.PROCSUB_TOKEN):
            return cwd
        roh = _variablen(stage[idx], varmap)
        worte = [_variablen(t, varmap) for t in rest]
        text = ' '.join([name] + worte)
        voll = ' '.join([roh] + worte)
        self.hausliste_stufe(roh, worte)
        if any(os.path.basename(_variablen(t, varmap)) in RECHTEERHOEHUNG for t in stage[:idx + 1]):
            raise Verweigert('Rechteerhoehung (%s) ist fuer Agenten gesperrt' % ' '.join(stage[:idx + 1]))
        if name in KONTROLLE_MIT_BEFEHL:
            return self.stufe(rest, varmap, cwd, depth, funktionen) if rest else cwd
        if name in KONTROLLE_OHNE_BEFEHL or name in cs.BLOCK_KEYWORDS:
            return cwd
        if name in ZUWEISUNGS_BEFEHLE and any(w.startswith('IFS=') for w in worte):
            raise Verweigert('IFS-Aenderung ist nicht sicher aufloesbar')
        if '/' in roh:
            self.zugriff(stage[idx], varmap, cwd, 'ausfuehren', immer=True)
        if name == 'cd':
            ziele = [w for w in rest if not w.startswith('-')]
            if not ziele:
                self.p.pfad('cd', self.p.home, 'lesen')
                return self.p.home
            wert = _expandieren(ziele[0], varmap, self.p.home)
            if wert is None:
                raise Verweigert("cd mit Kommandosubstitution ist nicht pruefbar")
            real = os.path.realpath(wert if os.path.isabs(wert) else os.path.join(cwd, wert))
            self.p.pfad(ziele[0], real, 'lesen')
            return real
        if name == 'eval':
            if rest:
                self.bash(' '.join(rest), cwd, depth + 1, funktionen)
            return cwd
        if name in cs.SHELL_INTERPRETERS:
            hat_c, skript = cs.shell_c_script(worte)
            if hat_c:
                if skript is None:
                    raise Verweigert('%s -c ohne Skript' % name)
                self.bash(skript, cwd, depth + 1, funktionen)
                return cwd
        if name == 'xargs':
            innen = cs.xargs_inner(rest) or ['echo']
            if self.p.zugaenge and os.path.basename(_variablen(innen[0], varmap)) in ZUGANG_PROGRAMME | {'hash'}:
                raise Verweigert('Zugangsbefehle laufen nicht ueber xargs; ihre Argumente muessen im Befehl stehen')
            if depth >= MAX_DEPTH:
                raise Verweigert('Kommando zu tief verschachtelt')
            return self.stufe(innen, varmap, cwd, depth + 1, funktionen) or cwd
        if name in BAUSTEINE:
            return cwd  # keine Programme, keine Dateien ausser Umleitungen (oben geprueft)
        if self.p.zugaenge and name == 'hash':
            raise Verweigert('hash ist gesperrt, solange Zugaenge bereitstehen')
        if self.p.zugaenge and name in ZUGANG_PROGRAMME and name not in funktionen:
            zugang = self.zugang_treffer(text, voll)
            if zugang is not None:
                self.zugang(zugang, name, stage, idx, rest, varmap, cwd)
                return cwd
        if name not in funktionen:
            self.muster(text, voll)
        schreibend = name in MUTIERENDE or (name in MIT_I_OPTION and any(w.startswith('-i') for w in worte))
        positionen = [w for w in rest if not (w.startswith('-') and not (w.startswith('--') and '=' in w))]
        for n, wort in enumerate(positionen):
            art = 'schreiben' if schreibend else 'lesen'
            if name in QUELLE_ZIEL and n < len(positionen) - 1:
                art = 'lesen'
            self.zugriff(wort, varmap, cwd, art)
        return cwd


    def zugang_treffer(self, text, voll):
        for zugang, muster in sorted(self.p.zugaenge.items()):
            if any(muster_passt(text, m) or muster_passt(voll, m) for m in muster):
                return zugang
        return None

    def zugang(self, zugang, name, stage, idx, rest, varmap, cwd):
        """Ein Befehl ueber einen Zugang: nackter Programmname ohne Vorspann, feste Argumente, kein fremdes Ziel,
        nur harmlose Optionen; lokale Pfade von scp und rsync pruefen Welt- und Schreibgrenze."""
        if stage[idx] != name or any(t not in cs.BLOCK_KEYWORDS for t in stage[:idx]):
            raise Verweigert("'%s' ueber einen Zugang laeuft nur als nacktes '%s ...' ohne Pfad, Wrapper oder "
                             "Zuweisung davor" % (' '.join(stage), name))
        for wort in rest:
            if '$' in wort or '`' in wort:
                raise Verweigert("'%s' ueber einen Zugang braucht feste Argumente ohne Variablen oder Substitution"
                                 % ' '.join(stage))
        worte = list(rest)  # die Zerlegung hat Anfuehrungen schon entfernt
        if name == 'ssh':
            if not worte or worte[0] != zugang:
                raise Verweigert("ssh ueber einen Zugang beginnt mit dem Zugangsnamen: 'ssh %s <befehl>'" % zugang)
            if len(worte) < 2:
                raise Verweigert("ssh %s braucht einen Befehl; eine offene Sitzung gibt es nicht" % zugang)
            if worte[1].startswith('-'):
                raise Verweigert("ssh %s: nach dem Zugangsnamen folgt der entfernte Befehl, keine ssh-Option" % zugang)
            # Der entfernte Befehl ist nicht an die Bash-Muster gebunden (der Server ist der freigegebene Bereich),
            # die Hausliste gilt aber auch dort: jede erkennbare Stufe und jedes gesperrte Textmuster.
            entfernt = ' '.join(worte[1:])
            self.hausliste_text(entfernt)
            for stmt in cs.all_statements(entfernt):
                for teil in cs.split_pipeline(stmt or []):
                    programm, i, weiter = cs.resolve_command(teil, {})
                    if programm is not None and programm not in (cs.SUBSHELL_TOKEN, cs.PROCSUB_TOKEN):
                        self.hausliste_stufe(teil[i], list(weiter))
            return
        positionen = []
        for wort in worte:
            if name == 'scp' and wort.startswith('-'):
                if wort == '-' or not set(wort[1:]) <= SCP_BUCHSTABEN:
                    raise Verweigert("scp-Option '%s' ist ueber einen Zugang gesperrt (erlaubt: -r -p -q -C -v -3 -4 -6)"
                                     % wort)
                continue
            if name == 'rsync' and wort.startswith('--'):
                if wort not in RSYNC_LANG and not wort.startswith(RSYNC_LANG_WERT):
                    raise Verweigert("rsync-Option '%s' ist ueber einen Zugang gesperrt" % wort)
                continue
            if name == 'rsync' and wort.startswith('-'):
                if wort == '-' or not set(wort[1:]) <= RSYNC_BUCHSTABEN:
                    raise Verweigert("rsync-Option '%s' ist ueber einen Zugang gesperrt (kein -e, keine Shell)" % wort)
                continue
            positionen.append(wort)
        if len(positionen) < 2:
            raise Verweigert('%s ueber einen Zugang braucht Quelle und Ziel' % name)
        entfernt = 0
        for n, wort in enumerate(positionen):
            kopf, trenner, _ = wort.partition(':')
            if trenner and '/' not in kopf:
                if kopf != zugang:
                    raise Verweigert("'%s' nennt ein anderes Ziel als den Zugang '%s'" % (wort, zugang))
                entfernt += 1
                continue
            art = 'schreiben' if n == len(positionen) - 1 else 'lesen'
            self.zugriff(wort, varmap, cwd, art, immer=True)
        if not entfernt:
            raise Verweigert("%s ueber den Zugang '%s' braucht ein Ziel '%s:<pfad>'" % (name, zugang, zugang))


def _unbestimmt(wort, varmap):
    """Ob das Wort eine Variable nennt, die weder der Befehl zuweist noch die Umgebung kennt
    (Schleifen- und Leseziele, Positionsparameter)."""
    if SONDERVARIABLE_RE.search(wort):
        return True
    return any((m.group(1) or m.group(2)) not in varmap and (m.group(1) or m.group(2)) not in os.environ
               for m in VARIABLE_RE.finditer(wort))


def _eingaben(tokens):
    ziele, i = [], 0
    while i < len(tokens):
        m = re.match(r'^(?:[0-9]+)?<(?![<&>(])(.*)$', tokens[i])
        if m:
            if m.group(1):
                ziele.append(m.group(1))
            elif i + 1 < len(tokens):
                ziele.append(tokens[i + 1])
                i += 1
        i += 1
    return ziele


# ------------------------------------------------------------- Logik ----
def eingabe_lesen():
    try:
        roh = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    try:
        daten = json.loads(roh) if roh.strip() else {}
    except ValueError:
        return {}
    return daten if isinstance(daten, dict) else {}


def entscheiden(eingabe):
    """None = erlaubt, sonst Grund."""
    werkzeug = eingabe.get('tool_name')
    try:
        profil = profil_laden()
    except Verweigert as exc:
        return str(exc)
    if profil is None:
        return None
    if not isinstance(werkzeug, str) or WERKZEUG_ALIAS.get(werkzeug, werkzeug) not in profil.tools:
        return "Werkzeug '%s' steht nicht in der Werkzeugliste des Agenten '%s'" % (werkzeug, profil.agent)
    felder = eingabe.get('tool_input') if isinstance(eingabe.get('tool_input'), dict) else {}
    cwd = str(eingabe.get('cwd') or '') or os.getcwd()
    pruefung = Pruefung(profil)
    try:
        if werkzeug == 'Bash':
            befehl = felder.get('command')
            if not isinstance(befehl, str) or not befehl.strip():
                return None
            profil.pfad(cwd, os.path.realpath(cwd), 'lesen')
            if profil.zugaenge and PATH_RE.search(befehl):
                return ('Solange Zugaenge bereitstehen, aendert oder nennt kein Befehl PATH -- ssh, scp und rsync '
                        'laufen nur ueber die Huellen des Zuges')
            pruefung.hausliste_text(befehl)
            pruefung.bash(befehl, cwd)
            return None
        art = 'schreiben' if werkzeug in SCHREIBWERKZEUGE else 'lesen'
        if werkzeug == 'Glob':
            basis = felder.get('path') if isinstance(felder.get('path'), str) and felder.get('path') else cwd
            muster = felder.get('pattern') if isinstance(felder.get('pattern'), str) else ''
            ziel = muster if os.path.isabs(muster) else os.path.join(basis, muster)
            ziel = re.split(r'[*?\[{]', ziel, 1)[0] or basis
        elif werkzeug == 'Grep':
            ziel = felder.get('path') if isinstance(felder.get('path'), str) and felder.get('path') else cwd
        else:
            ziel = felder.get('file_path') or felder.get('notebook_path')
            if not isinstance(ziel, str) or not ziel.strip():
                return None
        # Werkzeugpfade sind woertlich: keine Shell-Variablen, keine Tilde.
        profil.pfad(ziel, os.path.realpath(ziel if os.path.isabs(ziel) else os.path.join(cwd, ziel)), art)
        return None
    except Verweigert as exc:
        return str(exc)


def main():
    alarm_setzen()
    try:
        grund = entscheiden(eingabe_lesen())
    except Exception as exc:  # noqa: BLE001 - Sandbox-Zusage: eigener Fehler verweigert
        grund = 'interner Fehler der Pruefung (%s) -- ohne Pruefung ist nichts erlaubt' % type(exc).__name__
    if grund:
        print_deny(grund)
    return 0


if __name__ == '__main__':
    sys.exit(main())
