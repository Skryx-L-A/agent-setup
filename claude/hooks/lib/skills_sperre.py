#!/usr/bin/env python3
"""skills_sperre.py -- die Logik hinter dem PreToolUse-Hook skills-sperre.sh
(docs/AGENTS-PLAN.md, Abschnitt 3 "Die Sperre": "ein Hook sperrt fremde
Skills", und Abschnitt 14 "Sicherungen"; docs/AGENTS-SKILLS.md).

Der Hook greift NUR in einem Agentenzug: WB_AGENT_ID und WB_WELT sind
gesetzt (der Traeger setzt sie, siehe agents_skills.skills_umgebung). Ohne
beide gibt es keine Ausgabe. Sind sie gesetzt, aber ungueltig, wird
verweigert.

Massgeblich ist <WB_WELT>/agents/<WB_AGENT_ID>/skills.json. Laesst sie sich
nicht lesen, passt sie nicht zum Agenten oder nennt sie einen Pfad ausserhalb
der drei Ebenen, wird JEDES gepruefte Werkzeug verweigert (fail-closed), wie
bei der Rollen-Sperre: eine Sandbox-Zusage, keine Erinnerung.

Ein Skillordner ist ein Ordner unter einer bekannten Skillwurzel
(~/.claude/skills, ~/.agents/skills, ~/.agent-skills, <welt>/skills,
<welt>/agents/*/skills, die Bibliothek) oder, in versteckten Ordnern direkt
unter $HOME (dort laden Harnesses und Plugins ihre Skills), jeder Ordner mit
einer SKILL.md. Gespeicherte Skripte gelten genauso: <welt>/skripte,
<welt>/agents/*/skripte und die Skriptbibliothek aus skills.json
(skript_bibliothek) sind Wurzeln, ihre Ordner Einheiten mit derselben Regel.
Projektbaeume ausserhalb davon gelten nicht als Skills, auch wenn sie
SKILL.md-Dateien enthalten: das ist Arbeitsmaterial. Fuer jeden Pfad, den ein
Werkzeug beruehrt, gilt:

  - eigener Skill- oder Skriptordner (<welt>/agents/<id>/skills/<name>,
    <welt>/agents/<id>/skripte/<name>): alles erlaubt;
  - Welt- oder Bibliothekseinheit aus skills.json: lesen und ausfuehren nur,
    wenn die Version (SHA-256 wie in agents_skills.files_version) noch
    stimmt; schreiben nie, das geht nur ueber wb-skill [skript] vorschlag;
  - jeder andere Skill- oder Skriptordner: verweigert.

Geprueft werden Bash (ausgefuehrte Pfade, Skriptdateien von Shells und
Interpretern, source, Pfadargumente, Umleitungen; auch in $( ), Backticks,
eval, <shell> -c, Here-Docs an eine Shell, Wrappern und xargs), Skill (nur
Namen aus skills.json), Read/Grep/Glob (lesen) und Write/Edit/MultiEdit/
NotebookEdit (schreiben).

Inhaltspruefung: Ruft ein Befehl ein SHELL-Skript eines erlaubten Skills oder
ein gespeichertes Shell-Skript auf
(bash/sh/zsh/dash/ksh <datei>, source, oder direkt mit Shell-Shebang), liest
der Hook die Datei (hoechstens 512 KB, kein Symlink), setzt woertliche
Positionsargumente fuer $1..$9, $@ und $* ein und prueft den Inhalt wie einen
direkten Befehl: mit dieser Sperre selbst und mit den Bash-Hooks neben ihr
(PRUEFKETTE). Grenzen: Python-, Perl-, Node- und andere Nicht-Shell-Skripte
lassen sich nicht so pruefen; ein Skript, das seinen Inhalt erst zur Laufzeit
bildet, ebenso nicht. Siehe hooks/README.md.
"""
import glob
import hashlib
import json
import os
import re
import shlex
import signal
import stat
import subprocess
import sys

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_DIR = os.path.join(HOOKS_DIR, 'lib')
sys.path.insert(0, LIB_DIR)
import cmdshell as cs  # noqa: E402

FRIST_SEKUNDEN = 7          # vor der Huelle (8 s) und dem Settings-Eintrag (10 s)
KETTE_FRIST_SEKUNDEN = 2.5  # je Hook der Pruefkette
MAX_DEPTH = 4
ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
SKILL_NAME_RE = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$')
LEVELS = ('agent', 'welt', 'bibliothek')
ARTEN = {'skill': 'skills', 'skript': 'skripte'}   # Art -> Ordnername der Ebene
SKILLS_JSON_LIMIT = 1024 * 1024
SKRIPT_LIMIT = 512 * 1024
GLOB_LIMIT = 64
# Wie agents_skills: dieselben Grenzen, sonst gaebe es Versionen, die nur hier gelten.
FILE_NAME_RE = re.compile(r'^[A-Za-z0-9_.+-]{1,128}$')
IGNORED_NAMES = {'__pycache__', '.DS_Store'}
SKILL_FILE_LIMIT = 512 * 1024
SKILL_TOTAL_LIMIT = 4 * 1024 * 1024
SKILL_FILES_LIMIT = 200
SKILL_DEPTH_LIMIT = 8
HAUS_WURZELN = ('.claude/skills', '.agents/skills', '.agent-skills')
# Bash-Hooks, die den Inhalt eines Skill-Skripts wie einen direkten Befehl
# sehen. Nur, was neben diesem Hook tatsaechlich liegt, wird aufgerufen.
PRUEFKETTE = (('bash-guard.py', 'python3'), ('testschutz-gate.sh', 'bash'), ('reviewer-sperre.sh', 'bash'),
              ('profil-sperre.sh', 'bash'))
KETTEN_MARKER = 'WB_SKILLS_SPERRE_KETTE'
MUTIERENDE = {'rm', 'rmdir', 'unlink', 'shred', 'mv', 'cp', 'install', 'ln', 'rsync', 'touch', 'chmod',
              'chown', 'chgrp', 'truncate', 'tee', 'dd', 'mkdir', 'patch'}
MIT_I_OPTION = {'sed', 'perl', 'ruby'}
QUELLE_ZIEL = {'cp', 'install', 'rsync', 'ln'}
SHEBANG_RE = re.compile(rb'^#!\s*(\S+)(?:\s+(\S+))?')
GLOB_ZEICHEN = re.compile(r'[*?\[]')
POS_RE = re.compile(r'"\$(?:\{([1-9])\}|([1-9]))"|\$\{([1-9])\}|\$([1-9])')
ALLE_RE = re.compile(r'"\$(?:\{[@*]\}|[@*])"|\$\{[@*]\}|\$[@*]')

_ausgegeben = False


# ------------------------------------------------------------- Fristen --
def _deny_json(reason):
    return json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
        'permissionDecisionReason': reason}}, ensure_ascii=False)


def print_deny(reason):
    global _ausgegeben
    _ausgegeben = True
    print(_deny_json('Skills-Sperre: ' + reason), flush=True)


def _frist_abgelaufen(*_):
    if not _ausgegeben:
        try:
            os.write(1, (_deny_json('Skills-Sperre: Pruefung hat ihre Frist ueberschritten -- '
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


class Verweigert(Exception):
    """Grund einer Verweigerung; bricht die Pruefung ab."""


# ------------------------------------------------------ Skill-Version --
def _datei_lesen(pfad, grenze):
    fd = os.open(pfad, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > grenze:
            raise OSError('keine gewoehnliche Datei oder zu gross: %s' % pfad)
        daten = b''
        while len(daten) <= grenze:
            teil = os.read(fd, 65536)
            if not teil:
                break
            daten += teil
        if len(daten) > grenze:
            raise OSError('zu gross: %s' % pfad)
        return daten
    finally:
        os.close(fd)


def skill_version(ordner):
    """Dieselbe Version wie agents_skills.skill_version; None, wenn der Ordner
    Symlinks, Sonderdateien, ungueltige Namen enthaelt oder zu gross ist."""
    eintraege = {}
    gesamt = 0

    def gehen(verzeichnis, praefix, tiefe):
        nonlocal gesamt
        if tiefe > SKILL_DEPTH_LIMIT:
            raise OSError('zu tief')
        with os.scandir(verzeichnis) as it:
            liste = sorted(it, key=lambda e: e.name)
        for e in liste:
            if e.name in IGNORED_NAMES or e.name.endswith('.pyc'):
                continue
            rel = praefix + e.name
            if not FILE_NAME_RE.fullmatch(e.name) or set(e.name) == {'.'} or e.is_symlink():
                raise OSError('ungueltiger Eintrag %s' % rel)
            if e.is_dir(follow_symlinks=False):
                gehen(e.path, rel + '/', tiefe + 1)
            elif e.is_file(follow_symlinks=False):
                daten = _datei_lesen(e.path, SKILL_FILE_LIMIT)
                gesamt += len(daten)
                if gesamt > SKILL_TOTAL_LIMIT or len(eintraege) >= SKILL_FILES_LIMIT:
                    raise OSError('Skill zu gross')
                eintraege[rel] = (daten, bool(e.stat(follow_symlinks=False).st_mode & 0o111))
            else:
                raise OSError('Sonderdatei %s' % rel)

    try:
        if os.path.islink(ordner) or not os.path.isdir(ordner):
            return None
        gehen(ordner, '', 1)
    except OSError:
        return None
    digest = hashlib.sha256()
    for rel in sorted(eintraege):
        daten, ausfuehrbar = eintraege[rel]
        digest.update(('f\0%s\0%s\0%s\n' % (rel, 'x' if ausfuehrbar else '-',
                                            hashlib.sha256(daten).hexdigest())).encode('utf-8'))
    return digest.hexdigest()


# ---------------------------------------------------------- Kontext ----
def _unter(pfad, wurzel):
    return pfad == wurzel or pfad.startswith(wurzel.rstrip(os.sep) + os.sep)


class Kontext:
    """Was ein Agentenzug an Skills darf, gelesen aus seiner skills.json."""

    def __init__(self, welt, agent, daten):
        self.welt = welt
        self.agent = agent
        self.home = os.path.expanduser('~')
        self.agenten_wurzel = os.path.realpath(os.path.join(welt, 'agents'))
        # Je Art die Wurzeln der drei Ebenen; eigene Wurzeln sind frei, fremde Agentenwurzeln gesperrt.
        self.ebenen = {}
        for art, ordner in ARTEN.items():
            bibliothek = daten.get('bibliothek' if art == 'skill' else 'skript_bibliothek')
            self.ebenen[art] = {
                'agent': os.path.realpath(os.path.join(welt, 'agents', agent, ordner)),
                'welt': os.path.realpath(os.path.join(welt, ordner)),
                'bibliothek': os.path.realpath(bibliothek) if isinstance(bibliothek, str) and bibliothek else None,
            }
        self.eigene_wurzel = self.ebenen['skill']['agent']
        self.eigene_wurzeln = [self.ebenen[art]['agent'] for art in ARTEN]
        self.welt_wurzel = self.ebenen['skill']['welt']
        self.bibliothek = self.ebenen['skill']['bibliothek']
        self.haus = [os.path.realpath(os.path.join(self.home, r)) for r in HAUS_WURZELN]
        self.erlaubt = {}   # realpath -> Eintrag
        self.namen = set()  # Namen fuer das Skill-Werkzeug: nur Skills, keine Skripte
        self._versionen = {}
        for eintrag in daten.get('skills') or []:
            if not isinstance(eintrag, dict):
                raise Verweigert('skills.json enthaelt einen ungueltigen Eintrag')
            name, ebene, pfad, version = (eintrag.get(k) for k in ('name', 'ebene', 'pfad', 'version'))
            art = eintrag.get('art', 'skill')
            if not (isinstance(name, str) and SKILL_NAME_RE.fullmatch(name) and ebene in LEVELS and art in ARTEN
                    and isinstance(pfad, str) and os.path.isabs(pfad) and isinstance(version, str)
                    and re.fullmatch(r'[0-9a-f]{64}', version)):
                raise Verweigert('skills.json enthaelt einen ungueltigen Eintrag (%r)' % name)
            real = os.path.realpath(pfad)
            wurzel = self.ebenen[art][ebene]
            if not wurzel or os.path.dirname(real) != wurzel or os.path.basename(real) != name:
                raise Verweigert("skills.json nennt fuer '%s' (%s) einen Pfad ausserhalb der Ebene %s"
                                 % (name, art, ebene))
            if real in self.erlaubt:
                raise Verweigert("skills.json nennt den Ordner '%s' doppelt" % real)
            self.erlaubt[real] = dict(eintrag, real=real, art=art)
            if art == 'skill':
                self.namen.add(name)

    def wurzeln(self):
        result = self.haus[:]
        for ebenen in self.ebenen.values():
            result += [w for w in ebenen.values() if w]
        return result

    def skillordner(self, real):
        """Der Skillordner, zu dem der kanonische Pfad gehoert, sonst None.
        Eine Skillwurzel selbst ist kein Skillordner; die fremden Wurzeln sperrt pruefen()."""
        for wurzel in self.wurzeln():
            if _unter(real, wurzel) and real != wurzel:
                return os.path.join(wurzel, os.path.relpath(real, wurzel).split(os.sep)[0])
        if _unter(real, self.agenten_wurzel):
            teile = os.path.relpath(real, self.agenten_wurzel).split(os.sep)
            if len(teile) >= 3 and teile[1] in ARTEN.values():
                return os.path.join(self.agenten_wurzel, teile[0], teile[1], teile[2])
        if _unter(real, os.path.realpath(self.welt)):
            return None  # Weltablage: nur die ausdruecklichen Ebenen oben
        home = os.path.realpath(self.home)
        if not _unter(real, home) or real == home:
            return None
        erstes = os.path.relpath(real, home).split(os.sep)[0]
        if not erstes.startswith('.'):
            return None
        grenze = os.path.join(home, erstes)
        aktuell = real if os.path.isdir(real) else os.path.dirname(real)
        while _unter(aktuell, grenze):
            if os.path.isfile(os.path.join(aktuell, 'SKILL.md')):
                return aktuell
            if aktuell == grenze:
                return None
            aktuell = os.path.dirname(aktuell)
        return None

    def version_passt(self, ordner, soll):
        if ordner not in self._versionen:
            self._versionen[ordner] = skill_version(ordner)
        return self._versionen[ordner] == soll

    def pruefen(self, roh, real, art):
        """Verweigert, wenn ein Zugriff der Art lesen|ausfuehren|schreiben auf
        den kanonischen Pfad einen fremden oder veraenderten Skill trifft."""
        if art == 'schreiben' and os.path.basename(real) == 'skills.json' \
                and os.path.dirname(os.path.dirname(real)) == self.agenten_wurzel:
            raise Verweigert("'%s' ist ein Skill-Verzeichnis; es schreibt nur wb-skill" % roh)
        fremde_wurzel = real in self.haus or (
            os.path.basename(real) in ARTEN.values() and os.path.dirname(os.path.dirname(real)) == self.agenten_wurzel
            and real not in self.eigene_wurzeln)
        if fremde_wurzel:
            raise Verweigert("'%s' ist die Skillwurzel fremder Skills oder Skripte" % roh)
        ordner = self.skillordner(real)
        if ordner is None:
            return None
        if any(_unter(ordner, w) for w in self.eigene_wurzeln):
            return None
        eintrag = self.erlaubt.get(ordner)
        if eintrag is None:
            raise Verweigert("'%s' gehoert zum Skill oder Skript '%s', das nicht in skills.json des Agenten '%s' "
                             "steht" % (roh, ordner, self.agent))
        titel = 'Skript' if eintrag['art'] == 'skript' else 'Skill'
        if art == 'schreiben':
            raise Verweigert("'%s' liegt im %s-%s '%s'; Welt- und Bibliothekseinheiten aendern sich nur ueber "
                             "wb-skill %svorschlag" % (roh, eintrag['ebene'], titel, eintrag['name'],
                                                      'skript ' if eintrag['art'] == 'skript' else ''))
        if not self.version_passt(ordner, eintrag['version']):
            raise Verweigert("%s '%s' (%s) weicht von der Version in skills.json ab; erst wb-skill verzeichnis"
                             % (titel, eintrag['name'], eintrag['ebene']))
        return eintrag


def kontext_laden():
    """None ohne Agentenzug; sonst Kontext oder Verweigert."""
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
    pfad = os.path.join(welt, 'agents', agent, 'skills.json')
    for teil in (os.path.join(welt, 'agents'), os.path.join(welt, 'agents', agent), pfad):
        if os.path.islink(teil):
            raise Verweigert('Pfad zu skills.json enthaelt einen Symlink')
    gemeldet = (os.environ.get('WB_SKILLS_JSON') or '').strip()
    if gemeldet and os.path.realpath(gemeldet) != os.path.realpath(pfad):
        raise Verweigert('WB_SKILLS_JSON zeigt nicht auf skills.json des Agenten')
    try:
        daten = json.loads(_datei_lesen(pfad, SKILLS_JSON_LIMIT).decode('utf-8'))
    except (OSError, UnicodeDecodeError, ValueError):
        raise Verweigert('skills.json des Agenten laesst sich nicht lesen -- ohne Verzeichnis ist nichts erlaubt')
    if not isinstance(daten, dict) or daten.get('agent') != agent or not isinstance(daten.get('skills'), list):
        raise Verweigert('skills.json gehoert nicht zu Agent %s oder ist unvollstaendig' % agent)
    return Kontext(welt, agent, daten)


# ------------------------------------------------------------ Pfade -----
VARIABLE_RE = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)')


def _variablen(wort, varmap):
    """Woertliche Aufloesung: Zuweisungen des Befehls, dann die Umgebung des
    Hooks (dieselbe, mit der der Harness den Befehl startet), sonst leer wie
    in der Shell."""
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
    """Variablen und fuehrende Tilde; None, wenn eine Kommandosubstitution bleibt."""
    wert = _variablen(wort, varmap)
    if '$(' in wert or '`' in wert:
        return None
    if wert == '~' or wert.startswith('~/'):
        wert = home + wert[1:]
    return wert


def _absolut(wert, cwd):
    return wert if os.path.isabs(wert) else os.path.join(cwd or os.getcwd(), wert)


def _pfad(wort, varmap, cwd, home):
    """(kanonischer Pfad, unaufloesbar) eines Wortes."""
    wert = _expandieren(wort, varmap, home)
    if wert is None:
        return None, True
    return os.path.realpath(_absolut(wert, cwd)), False


def _pfadwort(wort):
    return bool(wort) and not wort.startswith('-') and wort not in ('', '|', '&&', '||', ';')


class Pruefung:
    def __init__(self, kontext, eingabe):
        self.k = kontext
        self.eingabe = eingabe
        self.skripte = []   # (realpath, text) der zu pruefenden Shell-Skripte

    # -- einzelne Zugriffe
    def zugriff(self, wort, varmap, cwd, art, pflicht=False):
        if not _pfadwort(wort):
            return None
        if '=' in wort and wort.startswith('--'):
            wort = wort.split('=', 1)[1]
        wert = _expandieren(wort, varmap, self.k.home)
        if wert is None:
            if pflicht:
                raise Verweigert("Pfad '%s' enthaelt eine Kommandosubstitution und ist nicht pruefbar" % wort)
            return None
        wert = _absolut(wert, cwd)
        if GLOB_ZEICHEN.search(wert):
            praefix = GLOB_ZEICHEN.split(wert, 1)[0]
            basis = os.path.realpath(praefix if praefix.endswith('/') else os.path.dirname(praefix))
            self.k.pruefen(wort, basis, art)
            # Aufgeloest wird nur, wo das Muster Skills treffen kann: in einer
            # Skillwurzel oder einem Skillordner. Sonst bliebe `**/*.py` teuer.
            if any(_unter(basis, w) for w in self.k.wurzeln()) or self.k.skillordner(basis) \
                    or _unter(basis, self.k.agenten_wurzel):
                treffer = sorted(glob.glob(wert))
                if len(treffer) > GLOB_LIMIT:
                    raise Verweigert("Muster '%s' trifft mehr als %d Pfade in Skillordnern" % (wort, GLOB_LIMIT))
                for t in treffer:
                    self.k.pruefen(wort, os.path.realpath(t), art)
            return None
        return self.k.pruefen(wort, os.path.realpath(wert), art)

    def skript(self, wort, varmap, cwd, argumente, shell):
        """Aufruf einer Skriptdatei: Zugriff pruefen, Shell-Skripte eines Skills zur Inhaltspruefung vormerken."""
        eintrag = self.zugriff(wort, varmap, cwd, 'ausfuehren', pflicht=True)
        real, _ = _pfad(wort, varmap, cwd, self.k.home)
        if real is None or not os.path.isfile(real):
            return
        eigen = any(_unter(real, w) for w in self.k.eigene_wurzeln)
        if eintrag is None and not eigen:
            return  # weder Skill-Skript noch gespeichertes Skript: Sache der uebrigen Hooks
        try:
            daten = _datei_lesen(real, SKRIPT_LIMIT)
        except OSError:
            raise Verweigert("Skill-Skript '%s' laesst sich nicht lesen (Symlink, Sonderdatei oder groesser "
                             "als %d Bytes)" % (wort, SKRIPT_LIMIT))
        if shell is None:
            m = SHEBANG_RE.match(daten)
            programm = os.path.basename(m.group(1).decode('utf-8', 'replace')) if m else ''
            if programm == 'env' and m.group(2):
                programm = os.path.basename(m.group(2).decode('utf-8', 'replace'))
            if programm not in cs.SHELL_INTERPRETERS:
                return  # Python, Perl, ...: Inhalt nicht mit Shell-Regeln pruefbar (Grenze)
        try:
            text = daten.decode('utf-8')
        except UnicodeDecodeError:
            raise Verweigert("Skill-Skript '%s' ist kein UTF-8-Text" % wort)
        self.skripte.append((real, positionen_einsetzen(text, [_variablen(a, varmap) for a in argumente]), cwd))

    # -- Bash
    def bash(self, command, cwd, depth=0):
        if depth > MAX_DEPTH:
            raise Verweigert('Kommando zu tief verschachtelt')
        riskant = 'skills' in command or 'SKILL.md' in command or 'skripte' in command
        teile = cs.heredoc_split(command)
        if not teile.complete:
            if riskant:
                raise Verweigert('Here-Doc ohne Abschlusszeile in einem Befehl, der Skills nennt')
            return
        subs, vollstaendig = cs.command_substitutions(teile.text_subs)
        if not vollstaendig and riskant:
            raise Verweigert('unvollstaendige Kommandosubstitution in einem Befehl, der Skills nennt')
        for b in teile.bodies:
            if b['top'] and not b['quoted']:
                weitere, _ = cs.command_substitutions(b['body'], quotes=False)
                subs.extend(weitere)
        for inner in subs:
            self.bash(inner, cwd, depth + 1)
        for b in teile.bodies:
            if not b['top']:
                continue
            kopf = cs.all_statements(b['prefix'])
            if kopf and kopf[-1] is not None and cs.split_pipeline(kopf[-1]):
                name, _i, rest = cs.resolve_command(cs.split_pipeline(kopf[-1])[-1], {})
                if name in cs.SHELL_INTERPRETERS and not cs.shell_c_script(rest)[0]:
                    self.bash(b['body'], cwd, depth + 1)
        anweisungen = cs.all_statements(teile.text)
        if anweisungen == [None]:
            if riskant:
                raise Verweigert('Befehl nennt Skills, ist aber nicht zerlegbar')
            return
        varmaps = cs.assignment_prefixes(anweisungen)
        for stmt, varmap in zip(anweisungen, varmaps):
            for raw_stage in cs.split_pipeline(stmt, strip=False):
                cwd = self.stufe(raw_stage, varmap, cwd, depth)

    def stufe(self, raw_stage, varmap, cwd, depth):
        for _op, ziel in cs.output_redirections(raw_stage):
            if ziel:
                self.zugriff(ziel, varmap, cwd, 'schreiben')
        eingaben = eingabe_umleitungen(raw_stage)
        stage = cs.strip_redirections(raw_stage)
        name, idx, rest = cs.resolve_command(stage, varmap)
        for quelle in eingaben:
            if name in cs.SHELL_INTERPRETERS and not cs.shell_c_script([_variablen(t, varmap) for t in rest])[0]:
                self.skript(quelle, varmap, cwd, [], name)  # `bash < datei` liest sein Skript aus der Datei
            else:
                self.zugriff(quelle, varmap, cwd, 'lesen')
        if name is None or name in (cs.SUBSHELL_TOKEN, cs.PROCSUB_TOKEN):
            return cwd
        befehlswort = _variablen(stage[idx], varmap)
        if '/' in befehlswort:
            self.skript(stage[idx], varmap, cwd, rest, None)
            self.argumente(name, rest, varmap, cwd)
            return cwd
        worte = [_variablen(t, varmap) for t in rest]
        if name == 'cd':
            ziele = [w for w in worte if not w.startswith('-')]
            if ziele and '$(' not in ziele[0] and '`' not in ziele[0]:
                real, _ = _pfad(ziele[0], varmap, cwd, self.k.home)
                self.k.pruefen(ziele[0], real, 'lesen')
                return real
            return cwd
        if name == 'eval':
            if rest:
                self.bash(' '.join(rest), cwd, depth + 1)
            return cwd
        if name in cs.SHELL_INTERPRETERS:
            hat_c, skript = cs.shell_c_script(worte)
            if hat_c:
                if skript:
                    self.bash(skript, cwd, depth + 1)
                return cwd
            i = 0
            while i < len(rest) and rest[i].startswith(('-', '+')) and rest[i] != '--':
                i += 2 if rest[i] in ('-o', '+o', '-O', '+O') else 1
            if i < len(rest) and rest[i] == '--':
                i += 1
            if i < len(rest):
                self.skript(rest[i], varmap, cwd, rest[i + 1:], name)
                self.argumente(name, rest[i + 1:], varmap, cwd)
            return cwd
        if name in ('source', '.'):
            if rest:
                self.skript(rest[0], varmap, cwd, rest[1:], 'source')
                self.argumente(name, rest[1:], varmap, cwd)
            return cwd
        if name == 'xargs':
            innen = cs.xargs_inner(rest)
            if innen:
                if depth >= MAX_DEPTH:
                    raise Verweigert('Kommando zu tief verschachtelt')
                self.stufe(innen, varmap, cwd, depth + 1)
            return cwd
        familie = cs.interpreter_family(name)
        if familie:
            art, _codes = cs.interpreter_program(name, rest)
            if art == 'datei':
                kandidaten = [w for w in rest if not w.startswith('-')]
                if kandidaten and '-m' not in rest:
                    self.zugriff(kandidaten[0], varmap, cwd, 'ausfuehren', pflicht=True)
                    rest = rest[rest.index(kandidaten[0]) + 1:]
        self.argumente(name, rest, varmap, cwd)
        return cwd

    def argumente(self, name, rest, varmap, cwd):
        """Jedes Pfadargument; bei schreibenden Befehlen als Schreibzugriff (Quelle von cp und
        Verwandten als Lesezugriff)."""
        worte = [_variablen(t, varmap) for t in rest]
        schreibend = name in MUTIERENDE or (name in MIT_I_OPTION and any(w.startswith('-i') for w in worte))
        positionen = [w for w in rest if _pfadwort(w)]
        for n, wort in enumerate(positionen):
            art = 'schreiben' if schreibend else 'lesen'
            if name in QUELLE_ZIEL and n < len(positionen) - 1:
                art = 'lesen'
            self.zugriff(wort, varmap, cwd, art)

    # -- Inhalt der Skill-Skripte
    def inhalte(self, depth=0):
        geprueft = set()
        while self.skripte:
            real, text, cwd = self.skripte.pop(0)
            schluessel = (real, text)
            if schluessel in geprueft:
                continue
            geprueft.add(schluessel)
            if len(geprueft) > 16:
                raise Verweigert('zu viele verschachtelte Skill-Skripte')
            try:
                self.bash(text, cwd, depth + 1)
            except Verweigert as exc:
                raise Verweigert("Skript '%s': %s" % (real, exc))
            grund = kette_pruefen(text, cwd, self.eingabe)
            if grund:
                raise Verweigert("Skript '%s' wird wie ein direkter Befehl geprueft und verweigert: %s"
                                 % (real, grund))


EINGABE_RE = re.compile(r'^(?:[0-9]+)?<(?![<&>(])(.*)$')


def eingabe_umleitungen(tokens):
    """Ziele von `< datei` und `0<datei`; Here-Docs, Here-Strings und `<&` zaehlen nicht."""
    ziele, i = [], 0
    while i < len(tokens):
        m = EINGABE_RE.match(tokens[i])
        if m:
            if m.group(1):
                ziele.append(m.group(1))
            elif i + 1 < len(tokens):
                ziele.append(tokens[i + 1])
                i += 1
        i += 1
    return ziele


def positionen_einsetzen(text, argumente):
    """$1..$9, ${N}, "$@" und "$*" durch die woertlichen Aufrufargumente ersetzen,
    damit die Pruefkette sieht, worauf das Skript tatsaechlich wirkt."""
    def einzeln(m):
        nummer = int(next(g for g in m.groups() if g))
        return shlex.quote(argumente[nummer - 1]) if nummer <= len(argumente) else "''"

    text = POS_RE.sub(einzeln, text)
    return ALLE_RE.sub(lambda _m: ' '.join(shlex.quote(a) for a in argumente), text)


def kette_pruefen(text, cwd, eingabe):
    """Grund der ersten Verweigerung eines Bash-Hooks der Pruefkette, sonst None."""
    if os.environ.get(KETTEN_MARKER):
        return None
    nutzlast = json.dumps({
        'hook_event_name': 'PreToolUse', 'tool_name': 'Bash',
        'tool_input': {'command': text, 'description': 'Inhalt eines Skill-Skripts'},
        'cwd': cwd, 'session_id': eingabe.get('session_id') or ''})
    umgebung = dict(os.environ, **{KETTEN_MARKER: '1'})
    for datei, interpreter in PRUEFKETTE:
        pfad = os.path.join(HOOKS_DIR, datei)
        if not os.path.isfile(pfad):
            continue
        try:
            r = subprocess.run([interpreter, pfad], input=nutzlast.encode('utf-8'), stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=umgebung, timeout=KETTE_FRIST_SEKUNDEN)
        except subprocess.TimeoutExpired:
            return '%s hat seine Frist ueberschritten' % datei
        except OSError as exc:
            return '%s nicht ausfuehrbar (%s)' % (datei, exc)
        if r.returncode == 2:
            return '%s: %s' % (datei, r.stderr.decode('utf-8', 'replace').strip()[:400] or 'Exit 2')
        ausgabe = r.stdout.decode('utf-8', 'replace').strip()
        for zeile in ausgabe.splitlines():
            try:
                daten = json.loads(zeile)
            except ValueError:
                continue
            spezifisch = daten.get('hookSpecificOutput') if isinstance(daten, dict) else None
            if isinstance(spezifisch, dict) and spezifisch.get('permissionDecision') in ('deny', 'ask'):
                return '%s: %s' % (datei, spezifisch.get('permissionDecisionReason') or 'ohne Grund')
    return None


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
    """None = erlaubt, sonst Grund. Unerwartete Fehler verweigert main()."""
    werkzeug = eingabe.get('tool_name')
    if werkzeug not in ('Bash', 'Skill', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'):
        return None
    try:
        kontext = kontext_laden()
    except Verweigert as exc:
        return str(exc)
    if kontext is None:
        return None
    eingabe_werkzeug = eingabe.get('tool_input') if isinstance(eingabe.get('tool_input'), dict) else {}
    cwd = str(eingabe.get('cwd') or '') or os.getcwd()
    pruefung = Pruefung(kontext, eingabe)
    try:
        if werkzeug == 'Skill':
            name = eingabe_werkzeug.get('skill')
            if not isinstance(name, str) or name.strip() not in kontext.namen:
                return ("Skill '%s' steht nicht in skills.json des Agenten '%s'" % (name, kontext.agent))
            return None
        if werkzeug == 'Bash':
            befehl = eingabe_werkzeug.get('command')
            if not isinstance(befehl, str) or not befehl.strip():
                return None
            pruefung.bash(befehl, cwd)
            pruefung.inhalte()
            return None
        feld = {'Read': 'file_path', 'Write': 'file_path', 'Edit': 'file_path', 'MultiEdit': 'file_path',
                'NotebookEdit': 'notebook_path', 'Grep': 'path', 'Glob': 'path'}[werkzeug]
        ziel = eingabe_werkzeug.get(feld)
        if werkzeug == 'Glob' and isinstance(eingabe_werkzeug.get('pattern'), str):
            muster = eingabe_werkzeug['pattern']
            basis = ziel if isinstance(ziel, str) and ziel else cwd
            pruefung.zugriff(muster if os.path.isabs(muster) else os.path.join(basis, muster), {}, cwd, 'lesen')
        if not isinstance(ziel, str) or not ziel.strip():
            return None
        art = 'schreiben' if werkzeug in ('Write', 'Edit', 'MultiEdit', 'NotebookEdit') else 'lesen'
        real, _ = _pfad(ziel, {}, cwd, kontext.home)
        kontext.pruefen(ziel, real, art)
        return None
    except Verweigert as exc:
        return str(exc)


def main():
    alarm_setzen()
    try:
        grund = entscheiden(eingabe_lesen())
    except Exception as exc:  # noqa: BLE001 - eine Sandbox-Zusage verweigert bei eigenem Fehler
        grund = 'interner Fehler der Pruefung (%s) -- ohne Pruefung ist nichts erlaubt' % type(exc).__name__
    if grund:
        print_deny(grund)
    return 0


if __name__ == '__main__':
    sys.exit(main())
