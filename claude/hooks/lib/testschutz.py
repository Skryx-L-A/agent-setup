#!/usr/bin/env python3
"""testschutz.py -- die Logik hinter dem PreToolUse-Hook testschutz-gate.sh
(docs/AGENTS-PLAN.md, Abschnitt 4 "Vergeben und pruefen": "Fuer Aufgaben mit
Gate-Befehlen sperrt ein Hook das Loeschen und Ueberspringen von Tests").

Der Hook laeuft auf ZWEI Mattchern (Bash, Write|Edit) und tut ALLES nur,
wenn WB_AUFGABE_ID gesetzt ist UND die Aufgabe gate_commands traegt --
ohne Gate-Befehle gibt es nichts, das als "die Tests" gilt, also nichts zu
schuetzen.

Geschuetzt ist ein Pfad, der in einem der gate_commands genannt wird
(irgendein Token mit '/' darin; auch jeder Ordner darueber und alles darin)
oder generisch nach Test aussieht (ein Pfadbestandteil test/tests/spec, oder
ein Dateiname wie test_x.py, x_test.go, x.spec.ts, x_spec.rb). Jeder Pfad
wird vor der Entscheidung mit realpath aufgeloest, ein Symlink auf einen
Test ist also selbst geschuetzt; laesst sich ein Pfad nicht eindeutig
aufloesen, wird verweigert.

Zwei Sperren:

  1. Bash: jede Loesch- und Schreibprimitive auf einen geschuetzten Pfad
     wird verweigert -- rm/unlink/rmdir/shred, mv (Quelle UND ein
     ueberschriebenes Ziel), cp/install/ln/rsync, git rm/mv/checkout/
     restore/clean/stash -u/reset --hard, find -delete/-exec, truncate, dd,
     tee, sed -i, perl/ruby -i, Umleitungen > und >>, und Code in python*/
     perl/ruby/node (-c, -e, Here-Doc, Here-String), der eine Schreib- oder
     Loeschfunktion aufruft. Verfolgt werden eval, `<shell> -c`,
     Here-Docs an eine Shell, $( ) und Backticks, Wrapper (env, nice,
     nohup, command, builtin, exec, time, sudo) und xargs. Grundsatz: was
     sich nicht sicher analysieren laesst, wird VERWEIGERT (fail-closed),
     und die Begruendung nennt die Form -- xargs mit einem schreibfaehigen
     Befehl, eine Pipe in eine Shell oder einen Interpreter, IFS-Tricks,
     ein Befehlswort oder Ziel aus einer nicht aufloesbaren Variablen.
     Ueberschreibende Formen (>, cp, tee ...) sperren nur, wenn das Ziel
     schon existiert: das Anlegen eines NEUEN Tests bleibt erlaubt.
  2. Write/Edit auf eine Testdatei (dasselbe Muster, auch ueber einen
     Symlink): abgelehnt wird nur, wenn der NEUE Inhalt eine Umgehung
     EINFUEHRT, die im ALTEN Inhalt der Datei (auf der Platte, nicht im
     Diff) noch nicht stand -- skip, xit, @pytest.mark.skip, #[ignore],
     `exit 0` als erste Inhaltszeile, oder eine Leerung (Ergebnisgroesse
     unter 20% der alten Dateigroesse). Erlaubt bleibt jede Aenderung, die
     keinen dieser Marker neu einfuehrt -- also das normale Hinzufuegen und
     Aendern von Testinhalt.

Die Bash-Zerlegung ist lib/cmdshell.py, dieselbe wie in bash-guard.py.
Zeitfrist: laeuft sie ab, kommt keine Ausgabe (fail-open) -- dieser Hook ist
eine Bremse gegen Abkuerzungen, keine Sandbox; siehe hooks/README.md.
"""
import glob
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import zipfile

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HOOKS_DIR, 'lib'))
import cmdshell as cs  # noqa: E402

FRIST_SEKUNDEN = 8
UNTERFRIST_SEKUNDEN = 6
MAX_DEPTH = 4
MAX_GLOB_TREFFER = 5000
MAX_ARCHIV_BYTES = 50 * 1024 * 1024
MAX_ARCHIV_MITGLIEDER = 20000

KENNUNG_MUSTER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')

TEST_VERZEICHNIS_MUSTER = re.compile(r'/(test|tests|spec)/', re.IGNORECASE)
TEST_DATEI_MUSTER = re.compile(r'(?:^|[_.-])(test|tests|spec)(?:[_.-]|$)', re.IGNORECASE)

SKIP_MARKER = [
    re.compile(r'\bxit\s*\('),
    re.compile(r'\.skip\s*\('),
    re.compile(r'@pytest\.mark\.skip\b'),
    re.compile(r'#\[ignore\]'),
]
LEERUNGS_SCHWELLE = 0.2

IFS_EXPANSION_RE = re.compile(r'\$\{?IFS')
ZUWEISUNGS_BEFEHLE = {'export', 'declare', 'typeset', 'local', 'readonly'}

# Was xargs oder find -exec ausfuehren darf: nur Befehle, die nichts
# schreiben. Die Ziele kommen dort erst zur Laufzeit (stdin, Suchtreffer),
# ein schreibender Befehl liesse sich also nicht gegen die Tests pruefen.
NUR_LESEND = {
    'grep', 'egrep', 'fgrep', 'rg', 'wc', 'cat', 'head', 'tail', 'ls', 'stat',
    'file', 'echo', 'printf', 'du', 'basename', 'dirname', 'realpath',
    'readlink', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'test',
    '[', 'true', 'diff', 'cmp',
}

# Schreib- und Loeschaufrufe in python/perl/ruby/node-Code. Bewusst breit:
# ein Treffer fuehrt nur zur Verweigerung eines Einzeilers, der den Test auch
# ueber das Edit-Werkzeug aendern koennte.
_STD_SCHREIBEN_RE = re.compile(r'\b(?:sys|process)\s*\.\s*std(?:out|err)\s*\.\s*write\b')
_SCHREIB_API_RE = re.compile(r'''(?x)
    \b(?:os|posix)\s*\.\s*(?:remove|unlink|rmdir|removedirs|rename|renames|replace|truncate
        |ftruncate|system|popen|exec\w*|spawn\w*|write|open|link|symlink|chmod)\b
  | \b(?:shutil|subprocess|pty|child_process|FileUtils|importlib|__import__|getattr)\b
  | \.\s*(?:unlink\w*|rmdir\w*|rm(?:Sync)?|rename\w*|write\w*|append\w*|truncate\w*
        |copy[Ff]ile\w*|cp(?:Sync)?|symlink\w*|link(?:Sync)?|touch|chmod\w*|createWriteStream)\s*\(
  | \b(?:File|Dir|IO)\s*\.\s*(?:delete|unlink|rename|write|binwrite|truncate|open|sysopen
        |symlink|link|chmod|rmdir)\b
  | (?<![\w.$])(?:unlink|rename|truncate|rmdir|system|exec|syscall|sysopen|qx|rmtree
        |remove_tree|copy|move)\b
  | (?<![\w.])open\s*\(?[^;)]*?['"]\s*(?:\+?[<>]{1,2}|\|)
  | \bopen\s*\([^)]*['"][rbt]*[wax+][rbt+]*['"]
  | \bmode\s*=\s*['"][rbt]*[wax+]
  | \bexec\s*\( | \beval\b | `  | %x
''')


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
def gate_commands_laden(id_, base):
    wb = shutil.which('wb-aufgabe')
    if not wb:
        return []
    r = subprozess_frist(wb, ['zeigen', id_, '--json', '--base', base])
    if r is None or r.returncode != 0:
        return []
    try:
        daten = json.loads(r.stdout)
    except ValueError:
        return []
    if not isinstance(daten, dict):
        return []
    auftrag = daten.get('auftrag') if isinstance(daten.get('auftrag'), dict) else {}
    roh = auftrag.get('gate_commands')
    return [g for g in roh if isinstance(g, str) and g.strip()] if isinstance(roh, list) else []


def genannte_pfade_aus_gate(gate_commands):
    pfade = []
    for befehl in gate_commands:
        for tok in befehl.split():
            if tok.startswith('-') or '/' not in tok:
                continue
            pfade.append(tok.rstrip('/'))
    return pfade


# --------------------------------------------------------- Testpfade ----
def ist_test_pfad(pfad, genannte_pfade):
    norm = (pfad or '').replace(os.sep, '/').strip()
    if not norm:
        return False
    ohne_slash = norm.strip('/')
    if TEST_VERZEICHNIS_MUSTER.search('/' + ohne_slash + '/'):
        return True
    basisname = ohne_slash.split('/')[-1] if ohne_slash else ''
    kern = os.path.splitext(basisname)[0]
    if TEST_DATEI_MUSTER.search(kern):
        return True
    for g in genannte_pfade:
        g_norm = (g or '').replace(os.sep, '/').strip('/')
        if not g_norm:
            continue
        if ohne_slash == g_norm or ohne_slash.startswith(g_norm + '/') or g_norm.startswith(ohne_slash + '/'):
            return True
    return False


def pfad_kanonisch(pfad, cwd):
    """realpath des Pfads, soweit es ihn gibt: der laengste vorhandene
    Anfang wird aufgeloest (Symlinks eingeschlossen), der noch nicht
    vorhandene Rest angehaengt -- unter einem Ordner, den es nicht gibt, kann
    auch kein Symlink liegen. None, wenn das nicht eindeutig ist: relativer
    Pfad ohne Arbeitsverzeichnis, oder `.`/`..` im nicht vorhandenen Rest."""
    if not isinstance(pfad, str) or not pfad or '\x00' in pfad:
        return None
    roh = os.path.expanduser(pfad)
    if not os.path.isabs(roh):
        if not cwd or not os.path.isabs(cwd):
            return None
        roh = os.path.join(cwd, roh)
    kopf, rest = roh.rstrip(os.sep) or os.sep, []
    while not os.path.lexists(kopf):
        kopf, schwanz = os.path.split(kopf)
        if not schwanz:
            return None
        rest.insert(0, schwanz)
    if any(t in ('.', '..') for t in rest):
        return None
    return os.path.join(os.path.realpath(kopf), *rest) if rest else os.path.realpath(kopf)


_KLAMMER_RE = re.compile(r'\{([^{}]*)\}')


def _klammern(wort, tiefe=0):
    """Klammer-Expansion `{a,b}` wie bash; None bei `{1..9}` oder zu vielen
    Worten -- dann ist das Ziel nicht sicher zu bestimmen."""
    if tiefe > 8:
        return None
    for m in _KLAMMER_RE.finditer(wort):
        inhalt = m.group(1)
        if ',' in inhalt:
            out = []
            for teil in inhalt.split(','):
                r = _klammern(wort[:m.start()] + teil + wort[m.end():], tiefe + 1)
                if r is None:
                    return None
                out.extend(r)
                if len(out) > 256:
                    return None
            return out
        if '..' in inhalt:
            return None
    return [wort]


def ziele_expandieren(wort, basis):
    worte = _klammern(wort)
    if worte is None:
        return None
    out = []
    for w in worte:
        if not any(c in w for c in '*?['):
            out.append(w)
            continue
        muster = os.path.expanduser(w)
        if not os.path.isabs(muster):
            if not basis:
                return None
            muster = os.path.join(basis, muster)
        treffer = glob.glob(muster)
        if len(treffer) > MAX_GLOB_TREFFER:
            return None
        out.extend(treffer or [w])
    return out


class Schutz:
    """Die geschuetzten Pfade einer Aufgabe, kanonisch."""

    def __init__(self, genannte_pfade, cwd):
        self.genannte = genannte_pfade
        self.cwd = cwd
        self.cwd_real = os.path.realpath(cwd) if cwd and os.path.isabs(cwd) else ''
        self.geschuetzt = [p for p in (pfad_kanonisch(g, cwd) for g in genannte_pfade) if p]

    def im_arbeitsbaum(self, kanonisch):
        return bool(self.cwd_real) and (kanonisch == self.cwd_real
                                        or kanonisch.startswith(self.cwd_real + os.sep))

    def vorfahr_von_geschuetzt(self, kanonisch):
        k = kanonisch.rstrip(os.sep)
        return any(g == kanonisch or g.startswith(k + os.sep) for g in self.geschuetzt)

    def trifft(self, kanonisch, roh):
        if ist_test_pfad(roh, self.genannte):
            return True
        if self.im_arbeitsbaum(kanonisch) and kanonisch != self.cwd_real:
            if ist_test_pfad(os.path.relpath(kanonisch, self.cwd_real), self.genannte):
                return True
        for g in self.geschuetzt:
            if kanonisch == g or kanonisch.startswith(g + os.sep):
                return True
        return self.vorfahr_von_geschuetzt(kanonisch)


# ------------------------------------------------------------- Bash -----
def schreibt(code):
    return bool(_SCHREIB_API_RE.search(_STD_SCHREIBEN_RE.sub('', code or '')))


def _positional(worte):
    out, nur_positional = [], False
    for t in worte:
        if not nur_positional and t == '--':
            nur_positional = True
            continue
        if not nur_positional and t.startswith('-') and t != '-':
            continue
        if t:
            out.append(t)
    return out


def _kopierziele(name, worte, pos, basis):
    """mv/cp/install/ln/rsync: (art, art_des_zugriffs, wort, basis, quellen)."""
    ziel_ordner = None
    for k, t in enumerate(worte):
        if t in ('-t', '--target-directory') and k + 1 < len(worte):
            ziel_ordner = worte[k + 1]
        elif t.startswith('--target-directory='):
            ziel_ordner = t.split('=', 1)[1]
    if ziel_ordner is not None:
        quellen, ziel = [p for p in pos if p != ziel_ordner], ziel_ordner
    elif len(pos) >= 2:
        quellen, ziel = pos[:-1], pos[-1]
    else:
        return []
    out = []
    if name == 'mv' or (name == 'rsync' and '--remove-source-files' in worte):
        out += [('umbenannt (Quelle von %s)' % name, 'weg', q, basis, None) for q in quellen]
    zugriff = 'weg' if name in ('rsync', 'ditto') else 'ueber'
    out.append(('ueberschrieben (Ziel von %s)' % name, zugriff, ziel, basis, quellen))
    return out


def _git_ziele(worte, cwd):
    basis, i = cwd, 0
    while i < len(worte):
        t = worte[i]
        if t == '-C' and i + 1 < len(worte):
            basis = os.path.join(basis, os.path.expanduser(worte[i + 1])) if basis else worte[i + 1]
            i += 2
            continue
        if t == '-c':
            i += 2
            continue
        if t in ('--git-dir', '--work-tree'):
            i += 2
            continue
        if t.startswith('-'):
            i += 1
            continue
        break
    if i >= len(worte):
        return []
    sub, rest = worte[i], worte[i + 1:]
    pos = _positional(rest)
    if sub == 'rm':
        return [('geloescht (git rm)', 'weg', z, basis, None) for z in pos]
    if sub == 'mv' and len(pos) >= 2:
        return ([('umbenannt (git mv)', 'weg', z, basis, None) for z in pos[:-1]]
                + [('ueberschrieben (Ziel von git mv)', 'ueber', pos[-1], basis, pos[:-1])])
    if sub in ('checkout', 'restore'):
        ziele = rest[rest.index('--') + 1:] if '--' in rest else pos
        return [('ueberschrieben (git %s)' % sub, 'weg', z, basis, None) for z in ziele]
    if sub == 'clean':
        return [('geloescht (git clean)', 'weg', z, basis, None) for z in (pos or ['.'])]
    if sub == 'stash' and any(o in rest for o in ('-u', '--include-untracked', '-a', '--all')):
        return [('geloescht (git stash -u)', 'weg', '.', basis, None)]
    if sub == 'reset' and '--hard' in rest:
        return [('zurueckgesetzt (git reset --hard)', 'weg', '.', basis, None)]
    if sub == 'worktree' and rest[:1] in (['remove'], ['rm']):
        return [('entfernt (git worktree remove)', 'weg', z, basis, None) for z in _positional(rest[1:])]
    return []


_ZIP_ARG = {'-b', '-n', '-t', '-tt', '-P', '--password', '-Z', '--compression-method',
            '-s', '--split-size', '--temp-path'}


def _zip_ziele(worte, cwd):
    """zip schreibt in das Archiv -- das erste Nicht-Options-Argument, oder
    das Ziel von -O --, und loescht mit -m die eingepackten Quellen."""
    archiv, ausgabe, quellen, verschieben, i = None, None, [], False, 0
    while i < len(worte):
        t = worte[i]
        if t in ('-O', '--output-file'):
            ausgabe = worte[i + 1] if i + 1 < len(worte) else None
            i += 2
            continue
        if t in _ZIP_ARG:
            i += 2
            continue
        if t in ('-x', '-i'):
            break  # dahinter stehen nur noch Muster
        if t.startswith('-'):
            if not t.startswith('--') and 'm' in t[1:]:
                verschieben = True
            i += 1
            continue
        if archiv is None:
            archiv = t
        else:
            quellen.append(t)
        i += 1
    out = [('ueberschrieben (zip)', 'ueber', z, cwd, None) for z in (archiv, ausgabe) if z]
    if verschieben:
        out += [('geloescht (zip -m)', 'weg', q, cwd, None) for q in quellen]
    return out


_TAR_ARG = set('fCbTXKgLNVHFI')
_TAR_LANG = {'--create': 'c', '--extract': 'x', '--get': 'x', '--append': 'r', '--update': 'u',
             '--concatenate': 'A', '--catenate': 'A', '--delete': 'D'}


def _tar_ziele(worte, cwd):
    """tar schreibt das Archiv (-c/-r/-u/-A/--delete), entpackt nach -C oder
    ins Arbeitsverzeichnis (-x) und loescht mit --remove-files die Quellen."""
    toks = list(worte)
    alt_stil = bool(toks) and not toks[0].startswith('-') and bool(re.fullmatch(r'[A-Za-z]+', toks[0]))
    if alt_stil:
        toks[0] = '-' + toks[0]  # `tar xzf a.tgz`: Argumente in Reihenfolge der Buchstaben
    werte = {'f': None, 'C': None}
    modus, rest, entfernen, gestrippt, i = set(), [], False, False, 0
    while i < len(toks):
        t = toks[i]
        if t == '--':
            rest += toks[i + 1:]
            break
        if t.startswith('--'):
            name, gleich, wert = t.partition('=')
            if name in _TAR_LANG:
                modus.add(_TAR_LANG[name])
            elif name in ('--file', '--directory'):
                if not gleich:
                    wert = toks[i + 1] if i + 1 < len(toks) else None
                    i += 1
                werte['f' if name == '--file' else 'C'] = wert
            elif name == '--remove-files':
                entfernen = True
            elif name == '--strip-components':
                gestrippt = True
            i += 1
            continue
        if t.startswith('-') and len(t) > 1:
            erstes, buchstaben = i, t[1:]
            for j, c in enumerate(buchstaben):
                if c in 'cxtrudA':
                    modus.add(c)
                if c not in _TAR_ARG:
                    continue
                if buchstaben[j + 1:] and not (alt_stil and erstes == 0):
                    werte[c] = buchstaben[j + 1:]
                    break
                werte[c] = toks[i + 1] if i + 1 < len(toks) else None
                i += 1
            i += 1
            continue
        rest.append(t)
        i += 1
    archiv, ordner = werte['f'], werte['C']
    out = []
    if modus & {'c', 'r', 'u', 'A', 'D'} and archiv and archiv != '-':
        out.append(('ueberschrieben (tar-Archiv)', 'ueber', archiv, cwd, None))
    if entfernen:
        basis = os.path.join(cwd, ordner) if ordner and cwd else cwd
        out += [('geloescht (tar --remove-files)', 'weg', z, basis, None) for z in rest]
    if 'x' in modus:
        out.append(('entpackt (tar -x)', 'entpacken', ordner or '.', cwd,
                    ('tar', archiv, False, gestrippt)))
    return out


def _unzip_ziele(worte, cwd):
    archiv, ordner, schalter, i = None, None, set(), 0
    while i < len(worte):
        t = worte[i]
        if t == '-d':
            ordner = worte[i + 1] if i + 1 < len(worte) else None
            i += 2
            continue
        if t == '-P':
            i += 2
            continue
        if t == '-x':
            break
        if t.startswith('-'):
            schalter.update(t[1:])
        elif archiv is None:
            archiv = t
        i += 1
    if schalter & set('lptvzZn'):
        return []  # nur anzeigen, testen, nach stdout, oder -n: ueberschreibt nie
    return [('entpackt (unzip)', 'entpacken', ordner or '.', cwd, ('zip', archiv, 'j' in schalter, False))]


def _cpio_ziele(worte, cwd):
    """cpio liest sein Archiv von stdin -- vorab nicht lesbar, also zaehlt
    der ganze Zielordner."""
    kurz, ordner, pos, i = set(), None, [], 0
    while i < len(worte):
        t = worte[i]
        if t in ('-D', '--directory'):
            ordner = worte[i + 1] if i + 1 < len(worte) else None
            i += 2
            continue
        if t.startswith('--directory='):
            ordner = t.split('=', 1)[1]
        elif t == '--extract':
            kurz.add('i')
        elif t == '--pass-through':
            kurz.add('p')
        elif t.startswith('-') and not t.startswith('--'):
            kurz.update(t[1:])
        elif not t.startswith('-'):
            pos.append(t)
        i += 1
    if 'i' in kurz:
        return [('entpackt (cpio -i)', 'weg', ordner or '.', cwd, None)]
    if 'p' in kurz:
        return [('kopiert (cpio -p)', 'weg', pos[-1] if pos else '.', cwd, None)]
    return []


def _find_ziele(worte, cwd):
    wurzeln = []
    for t in worte:
        if t.startswith('-') or t in ('(', '!', ')'):
            break
        wurzeln.append(t)
    wurzeln = wurzeln or ['.']
    out = []
    for k, t in enumerate(worte):
        if t in ('-fprint', '-fprint0', '-fprintf', '-fls') and k + 1 < len(worte):
            out.append(('ueberschrieben (find %s)' % t, 'ueber', worte[k + 1], cwd, None))
    if '-delete' in worte:
        return out + [('geloescht (find -delete)', 'weg', z, cwd, None) for z in wurzeln]
    for aktion in ('-exec', '-execdir', '-ok', '-okdir'):
        if aktion in worte:
            befehl = worte[worte.index(aktion) + 1:]
            innen = befehl[0].split('/')[-1] if befehl else ''
            if innen not in NUR_LESEND:
                return out + [('ausgefuehrt (find %s %s)' % (aktion, innen), 'weg', z, cwd, None)
                              for z in wurzeln]
    return out


def _ziele(name, remaining, vm, cwd):
    """(art, zugriff, wort, basis, quellen) je Pfad, den eine Stufe loescht
    ('weg') oder ueberschreibt ('ueber')."""
    worte = [cs.resolve_vars(t, vm) for t in remaining]
    pos = _positional(worte)
    if name in ('rm', 'unlink', 'rmdir', 'shred', 'srm'):
        return [('geloescht (%s)' % name, 'weg', z, cwd, None) for z in pos]
    if name in ('mv', 'cp', 'install', 'ln', 'rsync', 'ditto'):
        return _kopierziele(name, worte, pos, cwd)
    if name == 'git':
        return _git_ziele(worte, cwd)
    if name == 'find':
        return _find_ziele(worte, cwd)
    if name == 'zip':
        return _zip_ziele(worte, cwd)
    if name in ('tar', 'gtar', 'bsdtar'):
        return _tar_ziele(worte, cwd)
    if name == 'unzip':
        return _unzip_ziele(worte, cwd)
    if name == 'cpio':
        return _cpio_ziele(worte, cwd)
    if name == 'truncate':
        return [('ausgehoehlt (truncate)', 'ueber', z, cwd, None) for z in pos]
    if name == 'dd':
        return [('ueberschrieben (dd)', 'ueber', t[3:], cwd, None) for t in worte if t.startswith('of=')]
    if name == 'tee':
        return [('ueberschrieben (tee)', 'ueber', z, cwd, None) for z in pos]
    familie = cs.interpreter_family(name)
    in_place = any(t == '-i' or t.startswith('-i') or (familie in ('perl', 'ruby') and re.match(r'^-[A-Za-z]*i', t))
                   for t in worte if not t.startswith('--'))
    if in_place and (name in ('sed', 'gsed') or familie in ('perl', 'ruby')):
        return [('ueberschrieben (%s -i)' % name, 'ueber', z, cwd, None) for z in pos]
    return []


def _ziel_pruefen(art, zugriff, roh, basis, quellen, schutz, vm):
    if roh is None:
        return "%s ohne erkennbares Ziel" % art
    z = cs.resolve_vars(roh, vm)
    if z in ('/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'):
        return None
    if '$' in z or '`' in z:
        # Nur ein Ziel, dessen literaler Ordner nachweislich ausserhalb des
        # Arbeitsbaums und ueber keinem Test liegt, darf offen bleiben
        # (`/tmp/x-$$`); alles andere ist erst zur Laufzeit entscheidbar.
        literal = cs.unresolved_to_wildcard(z).split('*', 1)[0]
        ordner = literal.rstrip('/') if literal.endswith('/') else os.path.dirname(literal)
        k = pfad_kanonisch(ordner, basis) if ordner else None
        if k is None or schutz.im_arbeitsbaum(k) or schutz.vorfahr_von_geschuetzt(k):
            return "%s mit nicht aufloesbarem Ziel '%s'" % (art, roh)
        return None
    worte = ziele_expandieren(z, basis)
    if worte is None:
        return "%s mit nicht sicher expandierbarem Ziel '%s'" % (art, roh)
    for w in worte:
        k = pfad_kanonisch(w, basis)
        if k is None:
            return "%s mit nicht eindeutig aufloesbarem Ziel '%s'" % (art, w)
        if zugriff == 'entpacken':
            r = _entpacken_pruefen(art, w, k, quellen, basis, schutz, vm)
            if r:
                return r
            continue
        kandidaten = [k]
        if quellen and os.path.isdir(k):
            kandidaten = [os.path.join(k, os.path.basename(q.rstrip('/'))) for q in quellen]
        for kk in kandidaten:
            if zugriff == 'ueber' and not os.path.lexists(kk):
                continue  # ein NEUER Pfad -- Hinzufuegen bleibt erlaubt
            real = os.path.realpath(kk) if os.path.lexists(kk) else kk
            if schutz.trifft(real, w if kk == k else kk) or (real != kk and schutz.trifft(kk, w)):
                return "%s: '%s'" % (art, w)
    return None


def _archiv_dateien(typ, archiv, basis, vm):
    """Die Dateien (keine Ordner) eines Archivs, oder None, wenn es sich
    vorab nicht lesen laesst: stdin, unbekannter Pfad, zu gross, kaputt."""
    if not archiv or archiv == '-':
        return None
    a = cs.resolve_vars(archiv, vm)
    pfad = pfad_kanonisch(a, basis) if '$' not in a and '`' not in a else None
    if not pfad or not os.path.isfile(pfad) or os.path.getsize(pfad) > MAX_ARCHIV_BYTES:
        return None
    try:
        if typ == 'zip':
            with zipfile.ZipFile(pfad) as z:
                namen = [n for n in z.namelist() if not n.endswith('/')]
        else:
            with tarfile.open(pfad) as t:
                namen = [m.name for m in t.getmembers() if not m.isdir()]
    except Exception:  # tarfile.ReadError, zipfile.BadZipFile, EOFError, OSError ...
        return None
    return namen if len(namen) <= MAX_ARCHIV_MITGLIEDER else None


def _entpacken_pruefen(art, wort, ordner, info, basis, schutz, vm):
    """Ein Archiv ueberschreibt, was es enthaelt: jede Datei, die im
    Zielordner schon existiert und geschuetzt ist, sperrt. Laesst sich das
    Archiv nicht vorab lesen, zaehlt der ganze Zielordner."""
    typ, archiv, flach, gestrippt = info
    namen = None if gestrippt else _archiv_dateien(typ, archiv, basis, vm)
    if namen is None:
        if schutz.trifft(ordner, wort):
            return "%s nach '%s', Archivinhalt vorab nicht lesbar" % (art, wort)
        return None
    for name in namen:
        teil = os.path.basename(name.rstrip('/')) if flach else name
        if not teil:
            continue
        if os.path.isabs(teil) or '..' in teil.replace('\\', '/').split('/'):
            return "%s mit einem Pfad ausserhalb des Zielordners ('%s')" % (art, name)
        ziel = os.path.join(ordner, teil)
        if os.path.lexists(ziel) and schutz.trifft(os.path.realpath(ziel), os.path.join(wort, teil)):
            return "%s ueberschreibt '%s'" % (art, os.path.join(wort, teil))
    return None


def _here_string(raw_stage):
    for k, t in enumerate(raw_stage):
        m = re.match(r'^[0-9]*<<<(.*)$', t)
        if m:
            if m.group(1):
                return m.group(1)
            return raw_stage[k + 1] if k + 1 < len(raw_stage) else ''
    return None


def _shell_liest_stdin(args):
    if '-s' in args:
        return True
    return not [t for t in args if t and t[0] not in '-+']


def _befehl(stage, vm):
    """(name, remaining) -- mit einem Befehlswort aus einer Variablen
    (`X="rm t"; $X`) so, wie bash es nach der Wortteilung ausfuehrt.
    name False: das Befehlswort ist erst zur Laufzeit bekannt."""
    name, idx, remaining = cs.resolve_command(stage, vm)
    if name is None or idx >= len(stage) or ('$' not in stage[idx] and '`' not in stage[idx]):
        return name, remaining
    wort = cs.resolve_vars(stage[idx], vm)
    if '$' in wort or '`' in wort:
        return False, remaining
    try:
        teile = shlex.split(wort)
    except ValueError:
        return False, remaining
    if len(teile) == 1:
        return name, remaining
    name, _idx, rest = cs.resolve_command(teile + list(remaining), vm)
    return name, rest


def _heredoc_pruefen(b, schutz, vm, depth):
    anweisungen = cs.all_statements(b['prefix'])
    if not anweisungen or anweisungen[-1] is None:
        return "Here-Doc mit nicht zerlegbarem Kopf"
    stufen = cs.split_pipeline(anweisungen[-1])
    name, rest = _befehl(stufen[-1], vm) if stufen else (None, [])
    if not name:
        return "Here-Doc ohne erkennbaren Empfaenger"
    rest = [cs.resolve_vars(t, vm) for t in rest]
    if name in cs.SHELL_INTERPRETERS and not cs.shell_c_script(rest)[0] and _shell_liest_stdin(rest):
        r = finde_verstoss(b['body'], schutz, vm, depth + 1)
        return ("Here-Doc an %s: %s" % (name, r)) if r else None
    if name in ('source', '.') and rest[:1] in (['/dev/stdin'], ['-']):
        r = finde_verstoss(b['body'], schutz, vm, depth + 1)
        return ("Here-Doc an %s: %s" % (name, r)) if r else None
    programm = cs.interpreter_program(name, rest)
    if programm and programm[0] == 'stdin' and schreibt(b['body']):
        return "Here-Doc an %s ruft eine Schreib- oder Loeschfunktion auf" % name
    return None


def _stufe_pruefen(raw_stage, pos, schutz, vm, depth):
    for op, ziel in cs.output_redirections(raw_stage):
        r = _ziel_pruefen("ueberschrieben (Umleitung %s)" % op, 'ueber', ziel, schutz.cwd, None, schutz, vm)
        if r:
            return r
    herestring = _here_string(raw_stage)
    stage = cs.strip_redirections(raw_stage)
    name, remaining = _befehl(stage, vm)
    if name is False:
        return "Befehlswort aus einer nicht aufloesbaren Variablen oder Substitution"
    if name is None:
        if any(t.startswith('IFS=') for t in stage):
            return "IFS-Aenderung fuer die folgenden Befehle (Wortgrenzen erst zur Laufzeit bekannt)"
        return None
    worte = [cs.resolve_vars(t, vm) for t in remaining]
    if name in ZUWEISUNGS_BEFEHLE and any(t.startswith('IFS=') for t in worte):
        return "IFS-Aenderung fuer die folgenden Befehle (Wortgrenzen erst zur Laufzeit bekannt)"
    if name == 'xargs':
        innen = cs.xargs_inner(worte)
        innen_name = cs.resolve_command(innen, vm)[0] if innen else 'echo'
        if innen_name not in NUR_LESEND:
            return "xargs %s: die Ziele kommen erst zur Laufzeit von stdin" % innen_name
        return None
    if name == 'eval':
        if not remaining:
            return None
        r = finde_verstoss(' '.join(remaining), schutz, vm, depth + 1)
        return ("eval: %s" % r) if r else None
    if name in cs.SHELL_INTERPRETERS:
        hat_c, skript = cs.shell_c_script(worte)
        if hat_c:
            if skript is None:
                return "%s -c ohne Skript" % name
            r = finde_verstoss(skript, schutz, vm, depth + 1)
            return ("%s -c: %s" % (name, r)) if r else None
        if _shell_liest_stdin(worte):
            if herestring is not None:
                r = finde_verstoss(herestring, schutz, vm, depth + 1)
                return ("%s <<<: %s" % (name, r)) if r else None
            if pos > 0:
                return "%s liest sein Programm aus einer Pipe" % name
        return None
    programm = cs.interpreter_program(name, worte)
    if programm:
        art, codes = programm
        if art == 'unklar':
            return "%s mit Code-Option ohne Code" % name
        if art == 'code' and any(schreibt(c) for c in codes):
            return "Interpreter-Code mit Schreib- oder Loeschaufruf (%s)" % name
        if art == 'stdin':
            if herestring is not None:
                if schreibt(herestring):
                    return "Interpreter-Code mit Schreib- oder Loeschaufruf (%s <<<)" % name
            elif pos > 0:
                return "%s liest sein Programm aus einer Pipe" % name
    for art, zugriff, roh, basis, quellen in _ziele(name, remaining, vm, schutz.cwd):
        r = _ziel_pruefen(art, zugriff, roh, basis, quellen, schutz, vm)
        if r:
            return r
    return None


def finde_verstoss(command_text, schutz, varmap=None, depth=0):
    if varmap is None:
        varmap = {}
    if depth > MAX_DEPTH:
        return "Kommando zu tief verschachtelt (Substitution/eval/-c), um sicher zu pruefen"
    if IFS_EXPANSION_RE.search(command_text):
        return "IFS-Expansion (Wortgrenzen erst zur Laufzeit bekannt)"

    teile = cs.heredoc_split(command_text)
    if not teile.complete:
        return "Here-Doc ohne Abschlusszeile"
    substitutionen, vollstaendig = cs.command_substitutions(teile.text_subs)
    if not vollstaendig:
        return "unvollstaendige Kommandosubstitution"
    for b in teile.bodies:
        if b['top'] and not b['quoted']:
            weitere, vollstaendig = cs.command_substitutions(b['body'], quotes=False)
            if not vollstaendig:
                return "unvollstaendige Kommandosubstitution im Here-Doc"
            substitutionen.extend(weitere)
    for inner in substitutionen:
        r = finde_verstoss(inner, schutz, varmap, depth + 1)
        if r:
            return "Kommandosubstitution: %s" % r
    for b in teile.bodies:
        if b['top']:
            r = _heredoc_pruefen(b, schutz, varmap, depth)
            if r:
                return r

    leser = cs.process_substitution_script(teile.text)
    if leser:
        return ("%s liest sein Skript aus einer Prozess-Substitution <( ) (Inhalt erst "
                "zur Laufzeit bekannt)" % leser)
    statements = cs.all_statements(teile.text)
    varmaps = cs.assignment_prefixes(statements, varmap)
    for i, stmt in enumerate(statements):
        if stmt is None:
            return "Kommando nicht sicher zerlegbar (unausgeglichene Anfuehrung)"
        for pos, raw_stage in enumerate(cs.split_pipeline(stmt, strip=False)):
            r = _stufe_pruefen(raw_stage, pos, schutz, varmaps[i], depth)
            if r:
                return r
    return None


# --------------------------------------------------- Write/Edit-Inhalt --
def _erste_inhaltszeile(text):
    for zeile in text.splitlines():
        z = zeile.strip()
        if not z or z.startswith('#!'):
            continue
        return z
    return ''


def hat_exit0_am_anfang(text):
    z = _erste_inhaltszeile(text)
    return z == 'exit 0' or z.startswith('exit 0 ') or z.startswith('exit 0;') or z.startswith('exit 0#')


def marker_eingefuehrt(alt_text, neu_text):
    treffer = []
    for muster in SKIP_MARKER:
        if muster.search(neu_text) and not muster.search(alt_text):
            treffer.append(muster.pattern)
    if hat_exit0_am_anfang(neu_text) and not hat_exit0_am_anfang(alt_text):
        treffer.append("'exit 0' als erste Inhaltszeile")
    return treffer


def edit_neuer_inhalt(alt_text, old_string, new_string, replace_all):
    if replace_all:
        if old_string not in alt_text:
            return None
        return alt_text.replace(old_string, new_string)
    idx = alt_text.find(old_string)
    if idx == -1:
        return None
    return alt_text[:idx] + new_string + alt_text[idx + len(old_string):]


def ziel_lesen(pfad):
    """(vorhanden, text) -- ein Lesefehler zaehlt wie 'nicht vorhanden',
    dieser Hook rät nie, was auf der Platte steht."""
    if not os.path.isfile(pfad):
        return False, ''
    try:
        with open(pfad, 'r', encoding='utf-8', errors='replace') as f:
            return True, f.read()
    except OSError:
        return False, ''


# ------------------------------------------------------------- Logik ----
def main():
    alarm_setzen()
    eingabe = eingabe_lesen()

    tool_name = eingabe.get('tool_name')
    if tool_name not in ('Bash', 'Write', 'Edit'):
        return 0

    id_ = (os.environ.get('WB_AUFGABE_ID') or '').strip()
    if not id_ or not kennung_ok(id_):
        return 0

    base = os.environ.get('WB_AUFGABE_BASE') or os.path.expanduser('~')
    gate_commands = gate_commands_laden(id_, base)
    if not gate_commands:
        return 0  # ohne Gate-Befehle nichts, das als "die Tests" gilt

    genannte_pfade = genannte_pfade_aus_gate(gate_commands)
    tool_input = eingabe.get('tool_input') if isinstance(eingabe.get('tool_input'), dict) else {}
    cwd = str(eingabe.get('cwd') or '')
    schutz = Schutz(genannte_pfade, cwd)

    if tool_name == 'Bash':
        command = tool_input.get('command')
        if not isinstance(command, str) or not command.strip():
            return 0
        # HOME und TMPDIR sind im Bash-Werkzeug dieselben wie hier -- ohne
        # sie waere jedes `rm "$TMPDIR/x"` unentscheidbar.
        umgebung = {k: os.environ[k] for k in ('HOME', 'TMPDIR') if os.environ.get(k)}
        verstoss = finde_verstoss(command, schutz, umgebung)
        if verstoss:
            print_deny(
                "Testschutz: %s -- das Loeschen, Umbenennen oder Aushoehlen eines "
                "Tests dieser Aufgabe ist gesperrt (Aufgabe traegt gate_commands), "
                "und eine Form, die sich nicht sicher pruefen laesst, ebenso. "
                "Erlaubt bleibt das Hinzufuegen und Aendern von Testinhalt, am "
                "einfachsten ueber das Edit-Werkzeug." % verstoss)
        return 0

    # Write/Edit
    ziel_roh = tool_input.get('file_path')
    if not isinstance(ziel_roh, str) or not ziel_roh.strip():
        return 0
    kanonisch = pfad_kanonisch(ziel_roh, cwd)
    if not ist_test_pfad(ziel_roh, genannte_pfade) and not (kanonisch and schutz.trifft(kanonisch, ziel_roh)):
        return 0

    ziel_abs = kanonisch or (ziel_roh if os.path.isabs(ziel_roh) else os.path.join(cwd, ziel_roh) if cwd else ziel_roh)
    alt_vorhanden, alt_text = ziel_lesen(ziel_abs)

    if tool_name == 'Write':
        neu_text = tool_input.get('content')
        if not isinstance(neu_text, str):
            return 0
    else:  # Edit
        old_string = tool_input.get('old_string')
        new_string = tool_input.get('new_string')
        if not isinstance(old_string, str) or not isinstance(new_string, str) or not alt_vorhanden:
            return 0
        neu_text = edit_neuer_inhalt(alt_text, old_string, new_string, bool(tool_input.get('replace_all')))
        if neu_text is None:
            return 0  # old_string passt nicht -- das meldet Claudes eigenes Werkzeug, nicht dieser Hook

    gruende = marker_eingefuehrt(alt_text, neu_text)
    if alt_vorhanden:
        alt_groesse = len(alt_text.encode('utf-8'))
        neu_groesse = len(neu_text.encode('utf-8'))
        if alt_groesse > 0 and neu_groesse < LEERUNGS_SCHWELLE * alt_groesse:
            gruende.append("Leerung (%d -> %d Bytes, unter %d%% der alten Groesse)"
                           % (alt_groesse, neu_groesse, int(LEERUNGS_SCHWELLE * 100)))

    if gruende:
        print_deny(
            "Testschutz: '%s' fuehrt eine Testumgehung ein (%s). Erlaubt bleibt das "
            "Hinzufuegen und Aendern von Testinhalt." % (ziel_roh, '; '.join(gruende)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
