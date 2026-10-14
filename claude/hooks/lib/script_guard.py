"""Skript-Schritt von bash-guard.py; der Kommentarblock unten sagt, was er tut.

bash-guard.py ruft hard_hit() und ask_hit() und haelt die Einhaengepunkte in main(); der Rest
steht hier, damit Python ihn einmal uebersetzt (.pyc) und nicht bei jedem Bash-Aufruf.
"""
import hashlib
import io
import json
import os
import re
import sys

import ask_muster
import cmdshell

# ===========================================================================
# Lokale Skripte, die der Befehl startet.
# ===========================================================================
# Warum: Die Guards sahen nur den getippten Befehlstext. `bash skript.sh`, `sh skript.sh`,
#        `zsh skript.sh`, `./skript.sh`, `source skript.sh` und `. skript.sh` liessen deshalb einen
#        bewachten Befehl (`gh release create`, `git push --force`, `rm -rf` eines Live-Ordners, ein
#        Kill-Muster, ein Agenten-Trailer im Commit ...) ohne Ablehnung und ohne Rueckfrage laufen,
#        sobald er im Skript stand. Am 2026-09-26 lief so ein GitHub-Release ohne die Frage an den
#        Menschen.
# Was:   Die harten Guards 1-8 und die Rueckfrage-Stufe 9 laufen jetzt auch ueber den Text eines
#        solchen Skripts: eine regulaere Textdatei bis 256 KiB, gegen das cwd des Hooks aufgeloest,
#        nur woertliche Pfade, eine Ebene tief -- was das Skript selbst startet, wird nicht verfolgt.
#        Eine Ablehnung nennt Skript und Zeile. Eine unlesbare, zu grosse oder binaere Datei und ein
#        direkt gestartetes Nicht-Shell-Skript (Shebang python usw.) aendern nichts.
# Wie:   bash-guard.py main(probe_input) laesst die harten Guards ueber ein Stueck Skripttext laufen,
#        als waere es getippt, ohne jede Nebenwirkung (kein Marker, kein Verlaufseintrag, keine
#        Freigabe verbraucht, keine Ausgabe), und meldet, was sie abgelehnt haetten. Bei einer
#        Ablehnung wird die Zeile per Bisektion ueber die ersten k Zeilen gesucht; Marker,
#        Verlaufseintrag und Antwort entstehen danach genau einmal, fuer den getippten Befehl. Die
#        Rueckfrage-Stufe prueft die Muster ueber das Skript; eine Freigabe bindet an den getippten
#        Befehl PLUS einen Hash des Skripttexts und gilt deshalb nicht fuer ein geaendertes Skript.
#        Laufzeit-Befehlsnamen ($CMD args) sind im Skript nicht beurteilbar und werden dort
#        uebersprungen.
# Ausnahmen: Globs in ${XDG_CONFIG_HOME:-~/.config}/agent-workbench/skript-ausnahmen.conf.

SCRIPT_MAX_BYTES = 256 * 1024
SCRIPT_MAX_FILES = 8
SCRIPT_CHUNK_CHARS = 150000  # unter der 200000-Grenze der Klassifizierer
_SHELL_OPT_ARG = ('-o', '+o', '-O', '+O', '--rcfile', '--init-file')
# Die harten Guards, die auch im Skripttext laufen (Entscheidung 2026-09-26): was ein Skript
# nicht tun darf, egal wo es laeuft. rolle, git-add, freigabe-pfad, secrets, snapshot und der Rest
# bleiben beim getippten Befehl: in Skripten treffen sie vor allem isolierte Testumgebungen
# (gemessen: 52 von 379 Suiten dieses Repos waeren sonst nicht mehr startbar).
SKRIPT_GUARDS = frozenset({'commit-trailer', 'kill-pattern', 'push-gate'})
PROBING = [False]
PROBE_HITS = []


AUSNAHMEN_NAME = 'skript-ausnahmen.conf'


def ausnahmen_datei():
    """Pfad der Ausnahmeliste. Sie gehoert zu den geschuetzten Ablagen (freigabe-pfad in
    bash-guard.py, Write/Edit in bash-guard-live-config.sh): pflegt ein Mensch, kein Agent."""
    base = os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config')
    return os.path.join(base, 'agent-workbench', AUSNAHMEN_NAME)


def _script_exceptions():
    globs = []
    try:
        with open(ausnahmen_datei()) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith('#'):
                    globs.append(line)
    except OSError:
        pass
    return globs


def _script_literal_path(word, cwd):
    """Absoluter Pfad eines Worts, das eine Datei woertlich nennt (`~` und $HOME erlaubt), sonst None."""
    if not word or any(c in word for c in '*?[`\x02\x01'):
        return None
    home = os.path.expanduser('~')
    w = word
    if w == '~' or w.startswith('~/'):
        w = home + w[1:]
    w = w.replace('${HOME}', home).replace('$HOME', home)
    if '$' in w:
        return None
    return w if os.path.isabs(w) else os.path.join(cwd or os.getcwd(), w)


def _shell_script_arg(args):
    """Die Skriptdatei, die eine Shell ausfuehren soll, sonst None (-c-Befehlstext, -s, keine Datei)."""
    i = 0
    while i < len(args):
        t = args[i]
        if t == '--':
            return args[i + 1] if i + 1 < len(args) else None
        if t.startswith('--'):
            i += 2 if t in _SHELL_OPT_ARG else 1
            continue
        if len(t) > 1 and t[0] in '-+':
            if 'c' in t[1:] or 's' in t[1:]:
                return None
            i += 2 if t in _SHELL_OPT_ARG else 1
            continue
        return t
    return None


def _shell_noexec(args):
    """True, wenn die Shell das Skript nur liest und nichts ausfuehrt: `-n` (auch in einer Gruppe wie
    `-nx`) oder `-o noexec`, solange kein `-i` (dann gilt -n nicht) und kein `-c`/`-s` dabei ist. Gelesen
    werden nur die Optionen vor dem Skriptnamen; `bash -n x.sh` prueft die Syntax, ein Push darin laeuft nie."""
    noexec = interactive = False
    i = 0
    while i < len(args):
        t = args[i]
        if t == '--':
            break
        if t.startswith('--'):
            i += 2 if t in _SHELL_OPT_ARG else 1
            continue
        if len(t) > 1 and t[0] in '-+':
            if t[0] == '-' and t == '-o' and i + 1 < len(args) and args[i + 1] == 'noexec':
                noexec = True
            elif t[0] == '-' and t[1:].isalpha():
                noexec = noexec or 'n' in t[1:]
                interactive = interactive or 'i' in t[1:]
            i += 2 if t in _SHELL_OPT_ARG else 1
            continue
        break
    return noexec and not interactive


def _stdin_file(stage):
    """Die Datei einer Eingabeumlenkung (`< x.sh`, `<x.sh`, `0< x.sh`) in einer Stufe, sonst None."""
    for i, t in enumerate(stage):
        m = re.match(r'^0?<(?![<&(])(.*)$', t)
        if m:
            return m.group(1) or (stage[i + 1] if i + 1 < len(stage) else None)
    return None


def _shell_shebang(head):
    """True, wenn eine direkt gestartete Datei ein Shell-Skript ist: kein Shebang oder ein Shell-Interpreter."""
    if not head.startswith(b'#!'):
        return True
    words = head[2:].split(b'\n', 1)[0].decode('utf-8', 'replace').split()
    if not words:
        return True
    prog = os.path.basename(words[0])
    if prog == 'env':
        words = [w for w in words[1:] if not w.startswith('-') and '=' not in w]
        prog = os.path.basename(words[0]) if words else ''
    return prog in cmdshell.SHELL_INTERPRETERS


def script_files(command, cwd, _depth=0):
    """[(Name wie getippt, absoluter Pfad, direkt gestartet)] der lokalen Skriptdateien, die ein Befehl startet."""
    found = []
    try:
        statements = cmdshell.all_statements(cmdshell.strip_heredocs(command))
    except Exception:
        return found
    for stmt in statements:
        if stmt is None:
            continue
        for full in cmdshell.split_pipeline(stmt, strip=False):
            stage = cmdshell.strip_redirections(full)
            name, idx, rest = cmdshell.resolve_command(stage, {})
            if name is None:
                continue
            word, direct = None, False
            if name in cmdshell.SHELL_INTERPRETERS:
                has_c, script = cmdshell.shell_c_script(rest)
                if has_c:
                    if script and _depth < 2:
                        found.extend(script_files(script, cwd, _depth + 1))
                    continue
                if _shell_noexec(rest):
                    continue  # `bash -n x.sh`: Syntaxpruefung, nichts wird ausgefuehrt
                word = _shell_script_arg(rest) or _stdin_file(full)  # `bash x.sh` oder `bash < x.sh`
            elif name in ('source', '.'):
                word = rest[0] if rest and not rest[0].startswith('-') else None
            elif '/' in stage[idx] and not stage[idx].endswith('/'):
                word, direct = stage[idx], True
            path = _script_literal_path(word, cwd) if word else None
            if path:
                found.append((word, path, direct))
    return found


def read_script(path, direct):
    """Text einer regulaeren Textdatei bis SCRIPT_MAX_BYTES, sonst None (der Aufrufer verhaelt sich dann wie bisher)."""
    try:
        if not os.path.isfile(path) or os.path.getsize(path) > SCRIPT_MAX_BYTES:
            return None
        with open(path, 'rb') as fh:
            data = fh.read(SCRIPT_MAX_BYTES + 1)
    except OSError:
        return None
    if len(data) > SCRIPT_MAX_BYTES or not data.strip() or b'\x00' in data or (direct and not _shell_shebang(data)):
        return None
    return data.decode('utf-8', errors='replace')


_SCRIPTS_SEEN = {}


def local_scripts(command, cwd):
    """[(Name wie getippt, Text, sha256)] der lesbaren Skripte, die der Befehl startet (einmal je Befehl)."""
    key = (command, cwd)
    if key in _SCRIPTS_SEEN:
        return _SCRIPTS_SEEN[key]
    out, done = [], set()
    files = script_files(command, cwd or os.getcwd())[:SCRIPT_MAX_FILES]
    if files:
        import fnmatch
        exempt = _script_exceptions()
        for word, path, direct in files:
            real = os.path.realpath(path)
            if real in done or any(fnmatch.fnmatch(x, g) for g in exempt for x in (real, word)):
                continue
            done.add(real)
            text = read_script(real, direct)
            if text is not None:
                out.append((word, text, hashlib.sha256(text.encode('utf-8', 'replace')).hexdigest()))
    _SCRIPTS_SEEN[key] = out
    return out


def _script_chunks(lines):
    """(erste Zeilennummer, Text)-Stuecke eines Skripts, jedes unter der Laengengrenze der Klassifizierer."""
    start, size, cur = 0, 0, []
    for i, ln in enumerate(lines):
        if cur and size + len(ln) + 1 > SCRIPT_CHUNK_CHARS:
            yield start + 1, '\n'.join(cur)
            start, size, cur = i, 0, []
        cur.append(ln[:SCRIPT_CHUNK_CHARS])
        size += len(ln) + 1
    if cur:
        yield start + 1, '\n'.join(cur)


_HEREDOC_RE = re.compile(r'<<(-?)[ \t]*(\\?)([\'"]?)([A-Za-z_][A-Za-z0-9_]*)\3')


def _open_state(buf):
    """Liest den bisherigen Text eines Befehls: 'quote'/'cont', wenn er nicht fertig ist (eine Anfuehrung
    bleibt offen, ein Backslash setzt die Zeile fort), ('heredoc', (wort, dash)), wenn seine letzte Zeile
    ein Here-Dokument beginnt, sonst (None, None)."""
    in_s = in_d = False
    i, n = 0, len(buf)
    last_nl = buf.rfind('\n')
    heredoc = None
    while i < n:
        c = buf[i]
        if in_s:
            if c == "'":
                in_s = False
        elif c == '\\':
            if i + 1 >= n:
                return 'cont', None
            i += 1
        elif in_d:
            if c == '"':
                in_d = False
        elif c == "'":
            in_s = True
        elif c == '"':
            in_d = True
        elif c == '#' and (i == 0 or buf[i - 1] in ' \t\n;&|('):
            j = buf.find('\n', i)
            i = n if j < 0 else j
            continue
        elif i > last_nl and buf.startswith('<<', i) and not buf.startswith('<<<', i):
            m = _HEREDOC_RE.match(buf, i)
            if m:
                heredoc = (m.group(4), m.group(1) == '-')
                i = m.end() - 1
        i += 1
    if in_s or in_d:
        return 'quote', None
    return ('heredoc', heredoc) if heredoc else (None, None)


def script_units(text):
    """[(erste Zeilennummer, Befehlstext)]: physische Zeilen, verbunden, wo ein Backslash die Zeile
    fortsetzt, eine Anfuehrung offen bleibt oder ein Here-Dokument folgt; Leer- und reine Kommentarzeilen
    fallen weg."""
    lines = text.split('\n')
    units, i = [], 0
    while i < len(lines):
        start, buf = i, lines[i]
        i += 1
        while i < len(lines):
            state, arg = _open_state(buf)
            if state is None:
                break
            if state == 'heredoc':
                word, dash = arg
                while i < len(lines):
                    buf += '\n' + lines[i]
                    i += 1
                    if (lines[i - 1].lstrip('\t') if dash else lines[i - 1]) == word:
                        break
                break
            buf += '\n' + lines[i]
            i += 1
        if buf.strip() and not buf.lstrip().startswith('#'):
            units.append((start + 1, buf))
    return units


def _startet_git_commit(unit):
    """True, wenn in diesem Skriptbefehl wirklich `git ... commit` laeuft (nicht nur als Text in
    einem Argument); ein nicht zerlegbarer Befehl zaehlt vorsichtshalber als ja."""
    try:
        statements = cmdshell.all_statements(cmdshell.strip_heredocs(unit))
    except Exception:
        return True
    if statements == [None]:
        return True
    for stmt in statements:
        if stmt is None:
            continue
        for stage in cmdshell.split_pipeline(stmt):
            name, _idx, rest = cmdshell.resolve_command(stage, {})
            if name == 'git' and 'commit' in rest:
                return True
    return False


def commit_trailer_im_skript(text, trailer_fn):
    """Die Trailer-Pruefung von bash-guard.py fuer Skripttext: Befehl fuer Befehl, und nur dort,
    wo wirklich committet wird. Die getippte Pruefung ist eine Textsuche ueber die ganze Zeile;
    ueber ein Skript gelegt, traefe sie Testdaten wie `mkjson 'git commit -m "...Co-Authored-By..."'`.
    Ein Here-Dokument gehoert zu seinem Befehl (`git commit -F - <<EOF`)."""
    for _no, unit in script_units(text):
        if trailer_fn(unit) and _startet_git_commit(unit):
            return True
    return False


def _probe_hard(text, data, main_fn):
    """(Entscheidung, Guard, Grund), die die harten Guards fuer `text` als getippten Befehl gaeben, sonst
    None. Laeuft main() im Probelauf: kein Marker, kein Verlauf, keine Freigabe verbraucht, keine Ausgabe."""
    tool_input = dict(data.get('tool_input') or {})
    tool_input['command'] = text
    payload = json.dumps(dict(data, tool_input=tool_input))
    out, err = io.StringIO(), io.StringIO()
    old = sys.stdout, sys.stderr
    del PROBE_HITS[:]
    PROBING[0] = True
    sys.stdout, sys.stderr = out, err
    try:
        rc = main_fn(payload)
    except Exception:
        return None  # ein Absturz ist auch das, was der Hook beim getippten Befehl taete
    finally:
        sys.stdout, sys.stderr = old
        PROBING[0] = False
    guard = PROBE_HITS[0] if PROBE_HITS else 'script'
    if rc == 2:
        return 'deny', guard, err.getvalue().strip()
    try:
        hso = json.loads(out.getvalue()).get('hookSpecificOutput') or {}
    except ValueError:
        return None
    if hso.get('permissionDecision') in ('deny', 'ask'):
        return hso['permissionDecision'], guard, hso.get('permissionDecisionReason') or ''
    return None


_UNDECIDABLE = re.compile(r'unentscheidbare|nicht als sicher einstufbar|Teilbefehl: [^\n]*[$`]')


def hard_hit(command, cwd, data, main_fn):
    """(Entscheidung, Guard, Grund) der strengsten Ablehnung der harten Guards in den Skripten, die der
    Befehl startet, mit Skript und Zeile im Grund; None, wenn nichts ablehnt.

    Eine Ablehnung, die nur "nicht entscheidbar" sagt (eine Variable als Ziel von rm, mv, > oder kill: in
    Skripten ueblich, ohne Ausfuehrung nicht zu entscheiden), zaehlt nicht: das Skript wird dann Befehl fuer
    Befehl beurteilt, und nur was entscheidbar ist und abgelehnt wird, zaehlt."""
    ask = None
    for name, text, _sha in local_scripts(command, cwd):
        lines = text.split('\n')
        for first, chunk in _script_chunks(lines):
            hit = _probe_hard(chunk, data, main_fn)
            if hit is None:
                continue
            found = []  # (Entscheidung, Guard, Grund, Zeile)
            if not _UNDECIDABLE.search(hit[2]):
                rows = lines[first - 1:first + chunk.count('\n')]

                def refused(k, hit=hit, rows=rows):
                    h = _probe_hard('\n'.join(rows[:k]), data, main_fn)
                    return h is not None and h[1] == hit[1] and not _UNDECIDABLE.search(h[2])
                lo, hi = 0, len(rows)
                at = None
                if refused(hi):
                    while hi - lo > 1:
                        mid = (lo + hi) // 2
                        if refused(mid):
                            hi = mid
                        else:
                            lo = mid
                    at = first + hi - 1
                    # Die Bisektion findet die LETZTE Zeile eines mehrzeiligen Befehls
                    # (Anfuehrung, Fortsetzung, Here-Dokument); genannt wird seine erste.
                    for no, unit in script_units(chunk):
                        if no <= hi <= no + unit.count('\n'):
                            at = first + no - 1
                            break
                found.append((hit[0], hit[1], hit[2], at))
            else:
                for no, unit in script_units(chunk):
                    h = _probe_hard(unit, data, main_fn)
                    if h is not None and not _UNDECIDABLE.search(h[2]):
                        found.append((h[0], h[1], h[2], first + no - 1))
            for decision, guard, reason, at in found:
                where = 'Zeile %d' % at if at else 'Zeilen %d-%d' % (first, first + chunk.count('\n'))
                res = (decision, guard, 'Skript %s, %s: %s' % (name, where, reason))
                if decision == 'deny':
                    return res
                ask = ask or res
    return ask


def ask_hit(command, cwd, muster_liste):
    """(Mustereintrag, Kennung des Befehls fuer die Freigabe) des ersten Rueckfrage-Musters in einem
    Skript, das der Befehl startet; (None, command), wenn keines passt. Der Eintrag nennt Skript und Zeile."""
    # Im Skript nur die Veroeffentlichungsmuster; chmod -R, sudo usw. bleiben beim getippten Befehl.
    muster_liste = [e for e in muster_liste or [] if ask_muster.ist_veroeffentlichung(e)]
    if not muster_liste:
        return None, command
    for name, text, sha in local_scripts(command, cwd):
        found = None
        try:
            found = ask_muster.passendes_muster(text, muster_liste)
        except ask_muster.Unentscheidbar:
            found = None
            for _no, unit in script_units(text):  # Gesamttext nicht beurteilbar: Befehl fuer Befehl, Laufzeitnamen uebersprungen
                try:
                    found = ask_muster.passendes_muster(unit, muster_liste)
                except ask_muster.Unentscheidbar:
                    continue
                if found:
                    break
        if not found:
            continue
        at = None
        for no, unit in script_units(text):
            try:
                if ask_muster.passendes_muster(unit, muster_liste) is found:
                    at = no
                    break
            except ask_muster.Unentscheidbar:
                continue
        where = 'Zeile %d' % at if at else 'irgendwo in der Datei'
        entry = dict(found)
        entry['grund'] = 'Skript %s, %s: %s' % (name, where, found.get('grund', ''))
        return entry, '%s\n# [Skript %s sha256 %s]' % (command, name, sha)
    return None, command


