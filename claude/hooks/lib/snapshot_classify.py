import fnmatch
import glob as globmod
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cmdshell as cs

MAX_DEPTH = 5
MAX_COMMAND_LEN = 200_000
GIT_TIMEOUT = 3
WALK_ENTRY_CAP = 4000

DEFAULTS = {
    'snapshot_dir': '~/.local/trash-snapshots',
    'snapshot_max_age_minutes': 120,
    'min_bytes': 1,
    'git_committed_is_exempt': True,
    'exempt_glob': [
        '/private/tmp/claude-*', '/tmp/claude-*',
        '/tmp', '/tmp/*', '/private/tmp', '/private/tmp/*',
        '/var/folders/*', '/private/var/folders/*', '/dev/null',
        '*/node_modules', '*/node_modules/*',
        '*/__pycache__', '*/__pycache__/*',
        '*/dist', '*/dist/*', '*/build', '*/build/*',
        '*/.git/objects/*', '*.pyc', '*.log', '*.tmp', '*/.DS_Store',
    ],
}

# Nur wenn eine dieser Formen im ROHTEXT vorkommt, wird ein nicht zerlegbares
# Kommando (unausgeglichene Anfuehrungszeichen) ueberhaupt fail-closed
# behandelt. Bewusst OHNE das nackte '>': ein kaputt gequotetes echo mit
# Umleitung ist der haeufigste harmlose Fall und darf keinen Deny ausloesen.
FAILCLOSED_RE = re.compile(
    r'(\brm\s+-[A-Za-z]*[rR]|\bmv\b|\btruncate\b|\bshred\b|\bdd\b|'
    r'git\s+(-\S+\s+|\S+\s+)*?(checkout|restore|clean|reset)\b)'
)

SNAPSHOT_TOOLS = {'cp', 'rsync', 'ditto', 'tar', 'cpio'}


# --------------------------------------------------------------------------
# Konfiguration
# --------------------------------------------------------------------------

def load_config(path):
    cfg = dict(DEFAULTS)
    cfg['exempt_glob'] = list(DEFAULTS['exempt_glob'])
    if not os.path.isfile(path):
        return cfg
    globs = []
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            for line in fh:
                line = line.split('#', 1)[0].strip()
                if not line or '=' not in line:
                    continue
                key, val = line.split('=', 1)
                key, val = key.strip(), val.strip()
                if key == 'exempt_glob':
                    if val:
                        globs.append(val)
                elif key in ('snapshot_max_age_minutes', 'min_bytes'):
                    try:
                        cfg[key] = int(val)
                    except ValueError:
                        pass
                elif key == 'git_committed_is_exempt':
                    cfg[key] = val.lower() in ('1', 'true', 'yes', 'ja')
                elif key == 'snapshot_dir':
                    cfg[key] = val
    except OSError:
        return cfg
    if globs:
        cfg['exempt_glob'] = globs
    return cfg


# --------------------------------------------------------------------------
# Pfad-Handwerk
# --------------------------------------------------------------------------

def _has_unresolved(word):
    return bool('$(' in word or '`' in word or
                re.search(r'\$\{?[A-Za-z_][A-Za-z0-9_]*\}?', word))


_MKTEMP_SUB_RE = re.compile(r'\$\(\s*mktemp\b[^()]*\)|`\s*mktemp\b[^`]*`')
FRESH_TEMP_SENTINEL = '/nonexistent-frisch-angelegt-mktemp'


def substitute_fresh_temp(word):
    # `mktemp` und `mktemp -d` legen per Definition einen NEUEN, bis dahin
    # nicht existierenden Namen an. Unter so einem Ziel kann nichts
    # Vorhandenes ueberschrieben oder geloescht werden -- es gibt dort nichts
    # zu sichern. Bis 2026-08-04 galt `echo ... > "$P/datei"` mit
    # `P=$(mktemp -d)` trotzdem als unentscheidbar und wurde blockiert.
    # Die Substitution wird deshalb durch einen Platzhalterpfad ersetzt, der
    # garantiert nicht existiert; alle weiteren Pruefungen laufen unveraendert
    # darueber und finden dort nichts Schuetzenswertes.
    # Ausnahme '..': damit laesst sich aus dem frischen Verzeichnis wieder
    # herausklettern, das Ziel waere dann nicht mehr das frische. Solche Worte
    # bleiben unangetastet und damit unentscheidbar.
    if '..' in word:
        return word
    return _MKTEMP_SUB_RE.sub(FRESH_TEMP_SENTINEL, word)


def resolve_word(raw, varmap):
    return substitute_fresh_temp(cs.resolve_vars(raw, varmap))


def resolve_path(raw, varmap, cwd):
    # Rueckgabe: (liste_von_pfaden, unresolved_bool).
    word = resolve_word(raw, varmap)
    if _has_unresolved(word):
        return [], True
    word = os.path.expanduser(word)
    if not os.path.isabs(word):
        word = os.path.join(cwd or os.getcwd(), word)
    if any(c in word for c in '*?['):
        hits = globmod.glob(word)
        return [os.path.normpath(h) for h in hits], False
    return [os.path.normpath(word)], False


def variants(path):
    out = [path]
    try:
        real = os.path.realpath(path)
        if real != path:
            out.append(real)
    except OSError:
        pass
    return out


def is_exempt(path, cfg):
    for p in variants(path):
        for pattern in cfg['exempt_glob']:
            pat = os.path.expanduser(pattern)
            if fnmatch.fnmatch(p, pat):
                return True
    return False


def payload_bytes(path, limit):
    # Bricht ab, sobald das Limit erreicht ist -- der genaue Wert interessiert
    # nicht, nur ob ueberhaupt nennenswerter Inhalt dranhaengt.
    try:
        if os.path.islink(path):
            return 0
        if os.path.isfile(path):
            return os.path.getsize(path)
        if not os.path.isdir(path):
            return 0
    except OSError:
        return 0
    total, seen = 0, 0
    for root, dirs, files in os.walk(path):
        for f in files:
            seen += 1
            if seen > WALK_ENTRY_CAP:
                return limit
            try:
                fp = os.path.join(root, f)
                if not os.path.islink(fp):
                    total += os.path.getsize(fp)
            except OSError:
                continue
            if total >= limit:
                return total
    return total


def is_trivial(path, cfg):
    if not os.path.lexists(path):
        return True
    if os.path.islink(path):
        return True
    return payload_bytes(path, cfg['min_bytes']) < cfg['min_bytes']


# --------------------------------------------------------------------------
# git: was schon committed ist, ist schon gesichert
# --------------------------------------------------------------------------

def _git(args, cwd):
    try:
        r = subprocess.run(['git', '--no-optional-locks'] + args, cwd=cwd,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout.decode('utf-8', 'replace')


def git_fully_committed(path, cfg):
    if not cfg['git_committed_is_exempt']:
        return False
    base = path if os.path.isdir(path) else os.path.dirname(path) or '.'
    if not os.path.isdir(base):
        return False
    if _git(['rev-parse', '--show-toplevel'], base) is None:
        return False
    status = _git(['status', '--porcelain', '--', path], base)
    if status is None or status.strip():
        return False
    tracked = _git(['ls-files', '--', path], base)
    return bool(tracked and tracked.strip())


# --------------------------------------------------------------------------
# Snapshot-Erkennung
# --------------------------------------------------------------------------

def snapshot_in_same_command(path, statements, upto_index, varmap, cfg):
    base = os.path.basename(path.rstrip('/')) or path
    marker = os.path.basename(os.path.expanduser(cfg['snapshot_dir']).rstrip('/'))
    for stmt in statements[:upto_index + 1]:
        if not stmt:
            continue
        for stage in cs.split_pipeline(stmt):
            name, _i, _rest = cs.resolve_command(stage, varmap)
            if name not in SNAPSHOT_TOOLS:
                continue
            text = cs.resolved_stage_text(stage, varmap)
            if marker in text and (base in text or path in text):
                return True
    return False


def recent_snapshot_exists(path, cfg):
    snapdir = os.path.expanduser(cfg['snapshot_dir'])
    if not os.path.isdir(snapdir):
        return False
    base = os.path.basename(path.rstrip('/')) or path
    cutoff = time.time() - cfg['snapshot_max_age_minutes'] * 60
    try:
        entries = os.listdir(snapdir)
    except OSError:
        return False
    # Erst nach Alter filtern, NICHT nach Name kappen: das Verzeichnis waechst
    # ueber Monate (heute schon >1000 Eintraege), und ein Namens-Fenster haette
    # ausgerechnet die frischen Snapshots uebersehen -- also einen Block trotz
    # vorhandenem Snapshot ausgeloest, der teuerste Fehler dieses Guards. Ein
    # stat pro Eintrag ist billig genug (gemessen ~3 ms auf 1193 Eintraegen).
    for entry in entries[:20000]:
        full = os.path.join(snapdir, entry)
        try:
            if os.path.getmtime(full) < cutoff:
                continue
        except OSError:
            continue
        if base and base in entry:
            return True
        try:
            if os.path.isdir(full) and base in os.listdir(full):
                return True
        except OSError:
            continue
    return False


def already_secured(path, statements, idx, varmap, cfg):
    return (snapshot_in_same_command(path, statements, idx, varmap, cfg)
            or recent_snapshot_exists(path, cfg))


# --------------------------------------------------------------------------
# Meldung
# --------------------------------------------------------------------------

def _slug(path):
    base = os.path.basename(path.rstrip('/')) or 'ziel'
    return re.sub(r'[^A-Za-z0-9._-]+', '-', base).strip('-') or 'ziel'


def deny(what, path, cfg):
    day = time.strftime('%Y-%m-%d')
    dest = '%s/%s-%s' % (cfg['snapshot_dir'].rstrip('/'), day, _slug(path))
    one_liner = 'mkdir -p %s && cp -a "%s" %s/' % (dest, path, dest)
    return (
        "%s Kein Snapshot dieser Daten gefunden -- weder im selben Befehl noch in den letzten "
        "%d Minuten unter %s. Stehende Regel: nicht-triviale Daten werden vor dem Loeschen oder "
        "Ueberschreiben nach %s/<datum>-<name>/ kopiert. Vorher ausfuehren:  %s  "
        "Blockiert von bash-guard-snapshot."
        % (what, cfg['snapshot_max_age_minutes'], cfg['snapshot_dir'],
           cfg['snapshot_dir'].rstrip('/'), one_liner)
    )


def check_target(path, what, statements, idx, varmap, cfg):
    if is_exempt(path, cfg):
        return None
    if is_trivial(path, cfg):
        return None
    if git_fully_committed(path, cfg):
        return None
    if already_secured(path, statements, idx, varmap, cfg):
        return None
    return deny(what % path, path, cfg)


def unresolved_deny(kind, stage):
    return (
        "%s mit einem Ziel aus einer nicht aufloesbaren Variablen/Kommandosubstitution -- welche "
        "Daten hier verschwinden, steht erst zur Laufzeit fest, ein Snapshot laesst sich dafuer "
        "nicht pruefen. Umweg: den Pfad ausschreiben, oder ihn vorher in eine Variable legen, die "
        "im selben Befehl zugewiesen wird. Blockiert von bash-guard-snapshot (Default-Deny fuer "
        "unentscheidbare Formen). Teilbefehl: %s" % (kind, cs.stage_text(stage))
    )


# --------------------------------------------------------------------------
# Heredocs raus, bevor irgendetwas zerlegt wird
# --------------------------------------------------------------------------

# Wohnt seit 2026-08-05 in cmdshell.py, damit kill-pattern denselben Text
# zerlegt wie dieser Guard. Der Name bleibt hier stehen, weil er im Modul
# mehrfach verwendet wird.
strip_heredocs = cs.strip_heredocs


# --------------------------------------------------------------------------
# Einzelne Kommandoformen
# --------------------------------------------------------------------------

def _non_flag_args(remaining):
    out, after_ddash = [], False
    for t in remaining:
        if not after_ddash and t == '--':
            after_ddash = True
            continue
        if not after_ddash and t.startswith('-') and t != '-':
            continue
        out.append(t)
    return out


def _rm_is_recursive(remaining):
    flags = [t for t in remaining if t.startswith('-') and t != '--']
    return any(
        (f.startswith('--') and f in ('--recursive',)) or
        (not f.startswith('--') and re.search(r'[rR]', f[1:]))
        for f in flags
    )


def check_rm(remaining, stage, statements, idx, varmap, cfg):
    if not _rm_is_recursive(remaining):
        return None
    for raw in _non_flag_args(remaining):
        paths, unresolved = resolve_path(raw, varmap, cfg['_cwd'])
        if unresolved:
            return unresolved_deny('rm -r', stage)
        for p in paths:
            r = check_target(p, "rm -r loescht '%s' samt Inhalt.",
                             statements, idx, varmap, cfg)
            if r:
                return r
    return None


def _word_has_glob(word):
    return any(c in word for c in '*?[')


def rm_verified_empty_glob_reason(command, varmap, cfg):
    # Zusatzpfad NUR fuer den gemeldeten Fall (N6, MASTERLISTE 2026-08-04):
    # Claude Codes EIGENE, von diesem Hook unabhaengige Rueckfrage "Dangerous
    # rm operation on statically-unresolvable target" feuert fuer jeden
    # rm-Aufruf mit einem Glob-Zeichen im Ziel -- unabhaengig davon, was
    # dieser Guard entscheidet. Ein stilles "kein Einwand" (return None aus
    # analyze()) unterdrueckt diese CLI-eigene Nachfrage NICHT, nur ein
    # EXPLIZITES 'allow' vom Hook tut das (bestaetigt: Changelog nennt genau
    # diese Kombination -- ein PreToolUse-Hook mit permissionDecision=allow
    # kann sogar eine interaktive Nachfrage direkt beantworten). Der
    # Kommentarkopf von bash-guard-snapshot.sh dokumentiert die Absicht schon
    # seit jeher: "Auch ein Glob, der auf nichts passt" gilt als trivial und
    # geht durch -- hier wird dieses "geht durch" von stillem Nichtstun zu
    # einem expliziten, protokollierten Allow, OHNE die DENY-Seite anzufassen.
    #
    # Eng geschnitten, absichtlich:
    #   * genau EIN Statement, keine Verkettung (';', '&&', '||') und keine
    #     Pipe -- ein zusammengesetzter Befehl kann nach dem rm noch etwas
    #     ganz anderes tun, und dieses Allow darf sich nie auf mehr als den
    #     einen, vollstaendig verifizierten rm-Aufruf beziehen.
    #   * WIRKLICH JEDES Nicht-Flag-Argument muss ein Glob sein (Zeichen
    #     *, ?, [) UND nach ECHTER Dateisystem-Aufloesung (glob.glob, kein
    #     Raten) NICHTS treffen. Sobald auch nur ein Argument literal ist,
    #     etwas trifft, oder unaufloesbar ist (Variable/Kommandosubstitution),
    #     liefert diese Funktion None -- die normale, bereits gelaufene
    #     Pruef-/Deny-Logik (analyze()) bleibt fuer diesen Fall unveraendert
    #     massgeblich.
    #   * Diese Pruefung laeuft ERST NACHDEM analyze() schon None geliefert
    #     hat (siehe main()) -- sie kann also nie einen Deny uebersteuern.
    #
    # Kein Sicherheitsabbau gegenueber dem "Glob trifft heute nichts, morgen
    # etwas" -Bedenken: jeder neue Aufruf desselben Befehls (heute, morgen,
    # in einer Minute) durchlaeuft diese Pruefung ERNEUT, mit einer FRISCHEN
    # glob.glob()-Aufloesung. Existiert beim naechsten Aufruf etwas, greift
    # wieder die volle Snapshot-Pflicht ueber check_target() -- unveraendert.
    statements = cs.all_statements(strip_heredocs(command))
    if len(statements) != 1 or statements[0] is None:
        return None
    stages = cs.split_pipeline(statements[0])
    if len(stages) != 1:
        return None
    name, _i, remaining = cs.resolve_command(stages[0], varmap)
    if name != 'rm' or not _rm_is_recursive(remaining):
        return None
    args = _non_flag_args(remaining)
    if not args:
        return None
    checked = []
    for raw in args:
        word = cs.resolve_vars(raw, varmap)
        if _has_unresolved(word) or not _word_has_glob(word):
            return None
        paths, unresolved = resolve_path(raw, varmap, cfg['_cwd'])
        if unresolved or paths:
            return None
        checked.append(word)
    return (
        "bash-guard-snapshot: rm -r/-rf mit Glob-Ziel(en) %s trifft nach "
        "Dateisystem-Aufloesung NICHTS (Pfad existiert nicht) -- nichts zu "
        "sichern, nichts zu verlieren. Automatisch erlaubt statt CLI-"
        "Rueckfrage 'Dangerous rm operation on statically-unresolvable "
        "target'." % ', '.join(checked)
    )


def check_mv(remaining, stage, statements, idx, varmap, cfg):
    if any(f in ('-n', '--no-clobber') for f in remaining):
        return None
    if '-t' in remaining or any(f.startswith('--target-directory') for f in remaining):
        return None
    args = _non_flag_args(remaining)
    if len(args) < 2:
        return None
    paths, unresolved = resolve_path(args[-1], varmap, cfg['_cwd'])
    if unresolved:
        return unresolved_deny('mv', stage)
    for target in paths:
        if os.path.isdir(target):
            continue
        if not os.path.lexists(target):
            continue
        r = check_target(target, "mv ueberschreibt die vorhandene Datei '%s'.",
                         statements, idx, varmap, cfg)
        if r:
            return r
    return None


def check_truncate(remaining, stage, statements, idx, varmap, cfg):
    for raw in _non_flag_args(remaining):
        paths, unresolved = resolve_path(raw, varmap, cfg['_cwd'])
        if unresolved:
            return unresolved_deny('truncate', stage)
        for p in paths:
            r = check_target(p, "truncate kuerzt '%s'.", statements, idx, varmap, cfg)
            if r:
                return r
    return None


def check_shred(remaining, stage, statements, idx, varmap, cfg):
    for raw in _non_flag_args(remaining):
        paths, unresolved = resolve_path(raw, varmap, cfg['_cwd'])
        if unresolved:
            return unresolved_deny('shred', stage)
        for p in paths:
            r = check_target(p, "shred ueberschreibt '%s' unwiederbringlich.",
                             statements, idx, varmap, cfg)
            if r:
                return r
    return None


def check_dd(remaining, stage, statements, idx, varmap, cfg):
    for t in remaining:
        resolved = resolve_word(t, varmap)
        if not resolved.startswith('of='):
            continue
        raw = resolved[3:]
        if not raw:
            continue
        if _has_unresolved(raw):
            return unresolved_deny('dd of=', stage)
        paths, _unres = resolve_path(raw, varmap, cfg['_cwd'])
        for p in paths:
            if p.startswith('/dev/') and not is_exempt(p, cfg):
                return deny("dd schreibt direkt auf das Geraet '%s'." % p, p, cfg)
            r = check_target(p, "dd ueberschreibt '%s'.", statements, idx, varmap, cfg)
            if r:
                return r
    return None


def check_redirects(stmt_tokens, statements, idx, varmap, cfg):
    # Umleitungen liest cs.split_pipeline heraus -- sie muessen deshalb VOR der
    # Pipeline-Zerlegung aus den rohen Statement-Tokens geholt werden.
    i, n = 0, len(stmt_tokens)
    while i < n:
        tok = stmt_tokens[i]
        m = re.match(r'^(?:&|[0-9]+)?>(?!>)\|?(.*)$', tok)
        i += 1
        if not m:
            continue
        rest = m.group(1)
        if rest:
            if ' ' in rest:
                # Aus einem gequoteten Argument wie echo "> x" -- keine echte
                # Umleitung, sondern Text.
                continue
            target_raw = rest
        else:
            if i >= n:
                continue
            target_raw = stmt_tokens[i]
            i += 1
        if target_raw.startswith('&'):
            continue
        paths, unresolved = resolve_path(target_raw, varmap, cfg['_cwd'])
        if unresolved:
            return (
                "Ausgabeumleitung '>' auf ein Ziel aus einer nicht aufloesbaren Variablen/"
                "Kommandosubstitution -- ob dabei eine vorhandene Datei ueberschrieben wird, steht "
                "erst zur Laufzeit fest. Umweg: Pfad ausschreiben, oder '>>' anhaengen statt "
                "ueberschreiben. Blockiert von bash-guard-snapshot (Default-Deny fuer "
                "unentscheidbare Formen)."
            )
        for p in paths:
            if not os.path.isfile(p):
                continue
            r = check_target(p, "Ausgabeumleitung '>' ueberschreibt die vorhandene Datei '%s'.",
                             statements, idx, varmap, cfg)
            if r:
                return r
    return None


# --------------------------------------------------------------------------
# git-Formen
# --------------------------------------------------------------------------

def git_parts(remaining, varmap):
    # Liefert (subcommand, repo_dir_hint, args_nach_subcommand).
    i, n, dirhint = 0, len(remaining), None
    while i < n:
        t = cs.resolve_vars(remaining[i], varmap)
        if t == '-C' and i + 1 < n:
            dirhint = cs.resolve_vars(remaining[i + 1], varmap)
            i += 2
            continue
        if t == '-c':
            i += 2
            continue
        if t.startswith('--git-dir=') or t.startswith('--work-tree='):
            dirhint = t.split('=', 1)[1]
            i += 1
            continue
        if t.startswith('-'):
            i += 1
            continue
        return t, dirhint, remaining[i + 1:]
    return None, dirhint, []


def _repo_dir(dirhint, cfg):
    d = dirhint or cfg['_cwd'] or os.getcwd()
    return os.path.expanduser(d)


def _git_unusable(what, repo):
    return (
        "%s -- der Guard konnte den Zustand des Repositories unter '%s' nicht lesen (git nicht "
        "benutzbar oder kein Repository). Ob dabei uncommittete Aenderungen verloren gehen, ist "
        "damit nicht pruefbar. Blockiert von bash-guard-snapshot (Default-Deny fuer "
        "unentscheidbare Formen)." % (what, repo)
    )


def check_git(remaining, stage, statements, idx, varmap, cfg):
    sub, dirhint, rest = git_parts(remaining, varmap)
    if sub not in ('checkout', 'restore', 'clean', 'reset'):
        return None
    repo = _repo_dir(dirhint, cfg)
    if is_exempt(repo, cfg):
        return None

    if sub == 'reset':
        if not any(cs.resolve_vars(t, varmap) == '--hard' for t in rest):
            return None
        status = _git(['status', '--porcelain'], repo)
        if status is None:
            return _git_unusable('git reset --hard', repo)
        if not status.strip():
            return None
        if already_secured(repo, statements, idx, varmap, cfg):
            return None
        return deny(
            "git reset --hard verwirft %d uncommittete Aenderung(en) im Working Tree unter '%s'."
            % (len(status.strip().splitlines()), repo), repo, cfg)

    if sub == 'clean':
        resolved = [cs.resolve_vars(t, varmap) for t in rest]
        forced = any(f == '--force' or (f.startswith('-') and not f.startswith('--')
                                        and 'f' in f[1:]) for f in resolved)
        if not forced:
            return None
        dry = ['clean', '-n']
        if any(f.startswith('-') and not f.startswith('--') and 'd' in f[1:] for f in resolved) \
                or '--directory' in resolved:
            dry.append('-d')
        if any(f.startswith('-') and not f.startswith('--') and 'x' in f[1:] for f in resolved):
            dry.append('-x')
        preview = _git(dry, repo)
        if preview is None:
            return _git_unusable('git clean -f', repo)
        if not preview.strip():
            return None
        if already_secured(repo, statements, idx, varmap, cfg):
            return None
        return deny(
            "git clean loescht %d ungetrackte Datei(en)/Verzeichnis(se) unter '%s' -- ungetrackt "
            "heisst: git hat davon keine Kopie."
            % (len(preview.strip().splitlines()), repo), repo, cfg)

    # checkout / restore: nur die Pfad-Form, nicht der Branch-Wechsel.
    resolved = [cs.resolve_vars(t, varmap) for t in rest]
    if sub == 'restore':
        if '--staged' in resolved and '--worktree' not in resolved:
            return None  # nur unstagen, der Inhalt im Working Tree bleibt
        paths = [t for t in _non_flag_args(rest)]
    else:
        if '--' not in resolved:
            return None  # git checkout <branch> -- kein Datenverlust im Sinn der Regel
        cut = resolved.index('--')
        paths = [t for t in rest[cut + 1:] if not t.startswith('-')]
    if not paths:
        return None

    for raw in paths:
        if _has_unresolved(cs.resolve_vars(raw, varmap)):
            return unresolved_deny('git %s' % sub, stage)
        spec = cs.resolve_vars(raw, varmap)
        status = _git(['status', '--porcelain', '--', spec], repo)
        if status is None:
            return _git_unusable('git %s -- %s' % (sub, spec), repo)
        if not status.strip():
            continue
        abspath = spec if os.path.isabs(spec) else os.path.join(repo, spec)
        abspath = os.path.normpath(abspath)
        if is_exempt(abspath, cfg):
            continue
        if already_secured(abspath, statements, idx, varmap, cfg):
            continue
        return deny(
            "git %s verwirft die uncommitteten Aenderungen an '%s'." % (sub, spec),
            abspath, cfg)
    return None


DISPATCH = {
    'rm': check_rm,
    'mv': check_mv,
    'truncate': check_truncate,
    'shred': check_shred,
    'dd': check_dd,
    'git': check_git,
}


# --------------------------------------------------------------------------
# Hauptlauf
# --------------------------------------------------------------------------

def analyze(command, varmap, cfg, depth=0):
    if depth > MAX_DEPTH:
        return (
            "Verschachtelte eval/-c-Aufloesung zu tief (>%d Ebenen) -- nicht mehr pruefbar. "
            "Blockiert von bash-guard-snapshot." % MAX_DEPTH
        )
    statements = cs.all_statements(strip_heredocs(command))
    # Je Teilbefehl nur die Zuweisungen, die VOR ihm stehen -- siehe
    # cs.assignment_prefixes(). Der uebergebene varmap bleibt die Basis, damit
    # eine Zuweisung aus der umgebenden Ebene (eval, bash -c) erhalten bleibt.
    varmaps = cs.assignment_prefixes(statements, varmap)
    for idx, stmt in enumerate(statements):
        varmap = varmaps[idx]
        if stmt is None:
            if FAILCLOSED_RE.search(command):
                return (
                    "Kommando enthaelt eine loeschende/ueberschreibende Form, laesst sich aber "
                    "wegen unausgeglichener Anfuehrungszeichen nicht in Teilbefehle zerlegen -- "
                    "welche Pfade betroffen waeren, ist nicht feststellbar. Blockiert von "
                    "bash-guard-snapshot (Default-Deny fuer unentscheidbare Formen)."
                )
            return None

        r = check_redirects(stmt, statements, idx, varmap, cfg)
        if r:
            return r

        for stage in cs.split_pipeline(stmt):
            name, _i, remaining = cs.resolve_command(stage, varmap)
            if name is None:
                continue
            if name == 'eval' and remaining:
                inner = ' '.join(remaining)
                if any(_has_unresolved(t) for t in remaining):
                    if FAILCLOSED_RE.search(inner):
                        return unresolved_deny('eval', stage)
                    continue
                r = analyze(inner, varmap, cfg, depth + 1)
                if r:
                    return r
                continue
            if name in cs.SHELL_INTERPRETERS and len(remaining) >= 2 and remaining[0] == '-c':
                inner = remaining[1]
                if _has_unresolved(inner):
                    if FAILCLOSED_RE.search(inner):
                        return unresolved_deny('%s -c' % name, stage)
                    continue
                r = analyze(inner, varmap, cfg, depth + 1)
                if r:
                    return r
                continue
            fn = DISPATCH.get(name)
            if fn is None:
                continue
            r = fn(remaining, stage, statements, idx, varmap, cfg)
            if r:
                return r
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    command = (data.get('tool_input') or {}).get('command')
    if not isinstance(command, str) or not command.strip():
        return 0

    cwd = data.get('cwd')
    conf_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'snapshot-guard-exempt.conf')
    cfg = load_config(os.environ.get('SNAPSHOT_GUARD_CONF', conf_path))
    cfg['_cwd'] = cwd if isinstance(cwd, str) and cwd else os.getcwd()

    if len(command) > MAX_COMMAND_LEN:
        if not FAILCLOSED_RE.search(command):
            return 0
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'deny',
                'permissionDecisionReason': (
                    "Kommando ist %d Zeichen lang (Limit %d) und enthaelt eine loeschende/"
                    "ueberschreibende Form -- zu gross, um im Hook-Zeitbudget sicher zerlegt zu "
                    "werden. Blockiert von bash-guard-snapshot."
                    % (len(command), MAX_COMMAND_LEN)
                ),
            }
        }))
        return 0

    # Kein vorab gesammelter Gesamt-varmap mehr: analyze() baut die Karte
    # positionsgebunden auf, damit eine Zuweisung NACH der Verwendung nicht
    # rueckwirkend gilt (cs.assignment_prefixes).
    varmap = {}
    try:
        reason = analyze(command, varmap, cfg)
    except Exception as exc:  # nie den Bash-Aufruf wegen eines Guard-Fehlers toeten
        sys.stderr.write('bash-guard-snapshot: interner Fehler (%s) -- nicht geprueft\n'
                         % type(exc).__name__)
        return 0
    if reason:
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'deny',
                'permissionDecisionReason': reason,
            }
        }))
        return 0

    # Nur erreicht, wenn analyze() nichts zu beanstanden hatte -- kann also
    # niemals einen Deny uebersteuern. Eigener try/except (Reviewer-Prinzip
    # wie oben): ein Fehler hier darf hoechstens das Allow ausfallen lassen,
    # nie den Bash-Aufruf blockieren.
    try:
        allow_reason = rm_verified_empty_glob_reason(command, varmap, cfg)
    except Exception:
        allow_reason = None
    if allow_reason:
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'allow',
                'permissionDecisionReason': allow_reason,
            },
            'systemMessage': allow_reason,
        }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
