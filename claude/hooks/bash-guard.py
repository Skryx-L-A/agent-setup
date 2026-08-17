#!/usr/bin/env python3
# Zweck: EIN Einstiegspunkt fuer alle acht PreToolUse/Bash-Guards, statt acht
#        separaten Prozessen (acht Skripte, mehrfach zusaetzlich python3).
#        Liest die Hook-Eingabe EINMAL und fuehrt alle acht Pruefungen im
#        selben Prozess aus, in derselben Reihenfolge wie vorher in
#        settings.json (secrets, kill-pattern, live-config, push-gate-worker,
#        media-cloud-guard, screencapture, snapshot, commit-trailer).
# Gemessen (~/.claude/hooks/tests/test-guard-parity.sh, fuenf Laeufe, Median,
#        `ls -la /tmp`): alte Kette 340 ms je Bash-Aufruf -> neuer Einstiegspunkt
#        siehe Ergebnis-Datei fuer die aktuelle Zahl.
#
# KEINE Entscheidung soll sich aendern. Vier Guards haben ihre Klassifikations-
#        LOGIK bereits als eigenstaendiges Python-Modul unter lib/ (jeweils
#        eine main(), die stdin liest und stdout/exit-Code produziert, UND
#        eine davon getrennte reine Pruef-Funktion) -- diese Module werden
#        HIER IMPORTIERT und ihre main() unveraendert ausgefuehrt (stdin/stdout
#        pro Aufruf kurz umgeleitet auf den bereits eingelesenen Eingabetext),
#        nicht nachgebaut: kill_pattern_classify, push_gate_classify,
#        screencapture_classify, snapshot_classify. Deren volle Warum-/
#        Vorfall-Kommentare stehen unveraendert in den zugehoerigen .sh-
#        Wrappern (bash-guard-kill-pattern.sh, push-gate-worker.sh,
#        bash-guard-screencapture.sh, bash-guard-snapshot.sh), die absichtlich
#        NICHT geloescht wurden.
#
#        Die uebrigen vier trugen ihre Logik nur im Shell-Skript (secrets,
#        live-config, media-cloud-guard, commit-trailer) -- sie sind unten
#        nach Python ueberfuehrt, JEDE Bedingung so, wie sie im Original stand
#        (inkl. der Bash-eigenen, NICHT shell-aware Tokenisierung dort, wo das
#        Original genau die benutzt hat -- ein staerkerer Parser haette hier
#        Entscheidungen VERAENDERN koennen, nicht nur "verbessert"). Ihre
#        vollstaendigen Original-Kommentarbloecke (Zweck/Warum/Fix-Historie)
#        stehen wortwoertlich weiter unten bei der jeweiligen Funktion.
#
# Reihenfolge-Regel: sobald IRGENDEIN Guard denyt, wird sofort dessen Ausgabe
#        geschrieben und der Prozess beendet -- ein spaeterer Guard haette am
#        Gesamtergebnis (blockiert) ohnehin nichts mehr geaendert, und zwei
#        JSON-Objekte auf stdout waeren fuer den Hook-Konsumenten ungueltig.
#        Warnungen (live-config, media-cloud-guard) blockieren NIE -- die
#        alte Kette lief bei denen unabhaengig weiter (acht separate
#        Prozesse), deshalb sammelt dieser Prozess Warnungen weiter und gibt
#        sie erst am Ende aus, statt beim ersten Treffer stehenzubleiben.
#
# Betroffen: nur der Bash-Matcher in settings.json. bash-guard-live-config.sh
#        (Write|Edit) und media-cloud-guard.sh (WebFetch, MCP-Medien-Tools)
#        bleiben als eigene Hook-Eintraege bestehen -- ihre Bash-Zweige sind
#        unten dupliziert (nicht verschoben), die Originaldateien bleiben die
#        Quelle fuer die anderen Matcher.
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
LIB_DIR = os.path.join(HOOKS_DIR, 'lib')
sys.path.insert(0, LIB_DIR)

import ask_muster             # noqa: E402
import cmdshell                # noqa: E402
import rollen                  # noqa: E402
import kill_pattern_classify   # noqa: E402
import push_gate_classify      # noqa: E402
import screencapture_classify  # noqa: E402
import snapshot_classify       # noqa: E402


# ===========================================================================
# Angehaltene Worker sichtbar machen (V20, Freigabe-Ansicht)
# ===========================================================================
# Zweck: Ein deny hier stoppt den Bash-Aufruf, aber bis eben stand nirgends
#        eine Datei, an der von AUSSEN zu erkennen war, dass genau DIESER
#        Worker gerade auf eine Entscheidung wartet -- der Anlass war ein
#        Worker, der am 2026-08-04 45 Minuten stillstand, weil niemand
#        zufaellig in seinen Pane sah.
# Wie: Jeder Ablehnungspunkt in main() schreibt zusaetzlich eine kleine
#        JSON-Markerdatei, benannt nach der tmux-Pane-Kennung (TMUX_PANE) --
#        das ist die Kennung, unter der Agent-Workbench ihre Worker fuehrt.
#        Der naechste Bash-Aufruf AUS DERSELBEN PANE loescht den Marker zuerst
#        und schreibt ihn nur neu, wenn auch ER abgelehnt wird. Der Marker
#        gilt damit genau, solange der LETZTE Versuch dieser Pane abgelehnt
#        wurde und keiner danach durchkam -- kein Rueckschluss aus Bildschirm-
#        text, sondern eine Tatsache aus dem Hook-Lauf selbst.
# Kein TMUX_PANE: keine Markerdatei. Eine Zuordnung, die sich nicht belegen
#        laesst, wird nicht geraten.
# Dieser Hook prompted NICHT in den Chat -- er legt hoechstens eine Datei ab,
#        wie die stehende Anforderung es verlangt.

def _guard_blocks_dir():
    return os.environ.get('AWB_GUARD_BLOCKS_DIR') or os.path.expanduser('~/.pi-workers/guard-blocks')


def _pane_marker_path(pane):
    sicher = re.sub(r'[^A-Za-z0-9_.-]', '_', pane)
    return os.path.join(_guard_blocks_dir(), sicher + '.json')


def read_block(pane):
    """Der Merker dieser Pane, sonst None."""
    if not pane:
        return None
    try:
        with open(_pane_marker_path(pane), 'r') as fh:
            eintrag = json.load(fh)
    except (OSError, ValueError):
        return None
    return eintrag if isinstance(eintrag, dict) else None


def drop_block(pane):
    """Merker weg, ohne Ruecksicht -- fuer den Fall, dass die Frage beantwortet ist."""
    if not pane:
        return
    try:
        os.remove(_pane_marker_path(pane))
    except OSError:
        pass


def clear_block(pane):
    """Raeumt den Merker der Pane ab -- AUSSER er ist eine noch gueltige
    Rueckfrage. Rueckgabe: der beibehaltene Rueckfrage-Merker, sonst None.

    Warum die Ausnahme (gemeldet 2026-08-05 aus dem Betrieb): eine harte
    Ablehnung ist erledigt, sobald der Worker weitermacht -- deshalb raeumt der
    naechste Aufruf sie weg. Eine RUECKFRAGE ist erst erledigt, wenn ein Mensch
    entschieden hat oder sie abgelaufen ist. Bis eben loeschte der naechste
    beliebige Befehl derselben Pane (nachsehen, lesen, eine Datei oeffnen) die
    eigene Frage aus der Ansicht, bevor sie jemand gesehen hatte. Das entwertet
    genau die Eigenschaft, fuer die diese Stufe gebaut wurde.
    """
    eintrag = read_block(pane)
    if eintrag is None:
        return None
    if eintrag.get('wartet') is True and not ask_muster.merker_abgelaufen(eintrag):
        return eintrag
    drop_block(pane)
    return None


def note_block(pane, guard, reason, command, cwd, session_id, extra=None):
    if not pane or not reason:
        return
    try:
        d = _guard_blocks_dir()
        os.makedirs(d, exist_ok=True)
        eintrag = {
            'pane': pane,
            'guard': guard,
            'reason': reason,
            'command': (command or '')[:2000],
            'cwd': cwd or '',
            'session_id': session_id or '',
            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        # Zusatzfelder der Rueckfrage-Stufe (wartet/muster/schluessel). Die
        # Freigabe-Ansicht unterscheidet daran einen wartenden Eintrag von
        # einer endgueltigen Ablehnung -- dieselbe Rubrik, andere Knoepfe.
        if extra:
            eintrag.update(extra)
        fd, tmp = tempfile.mkstemp(dir=d)
        with os.fdopen(fd, 'w') as fh:
            json.dump(eintrag, fh)
        os.replace(tmp, _pane_marker_path(pane))
    except OSError:
        pass


# ===========================================================================
# Verlauf aller Ablehnungen (V17, Workbench-Plan): eine Zeile je Ablehnung
# ===========================================================================
# Zweck: note_block() oben haelt nur den MOMENTANWERT fest -- ein Marker fuer
#        den laufenden Block, den der naechste Versuch derselben Pane wieder
#        wegraeumt. Das genuegt der Freigabe-Ansicht, aber nicht der Frage
#        "welche Muster schlagen WIEDERHOLT an" -- dafuer braucht es eine
#        Geschichte, keinen Momentanwert (zwei Ablehnungen am 2026-08-04 waren
#        dieselbe Ursache, und das fiel niemandem auf).
# Wie: eine ANHAENGENDE Zeile je Ablehnung, in einer eigenen Datei NEBEN dem
#        Merker-Ordner (nicht darin -- der Ordner ist der Lebenszyklus des
#        LAUFENDEN Blocks, diese Datei waechst nur). Gruppiert wird spaeter
#        (in der Oberflaeche) nach (guard, reason) -- das steht deshalb an
#        erster Stelle in jeder Zeile.
# NICHT an `pane` gebunden: anders als der Marker gilt der Verlauf auch fuer
#        einen Aufruf ohne TMUX_PANE -- eine Ablehnung ist ein Datum, mit
#        oder ohne zuordenbare Pane.
# Dieser Hook prompted NICHT in den Chat -- er haengt hoechstens eine Zeile an
#        eine Datei an, wie die stehende Anforderung es verlangt.

def _guard_log_path():
    return os.environ.get('AWB_GUARD_LOG') or os.path.expanduser('~/.pi-workers/guard-blocks.log')


def append_block_log(pane, guard, reason, command, cwd, session_id):
    if not reason:
        return
    try:
        pfad = _guard_log_path()
        d = os.path.dirname(pfad)
        if d:
            os.makedirs(d, exist_ok=True)
        eintrag = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'guard': guard,
            'reason': reason,
            'command': (command or '')[:2000],
            'cwd': cwd or '',
            'session_id': session_id or '',
            'pane': pane or '',
        }
        with open(pfad, 'a') as fh:
            fh.write(json.dumps(eintrag) + '\n')
    except OSError:
        pass


def _deny_reason_if_any(json_text):
    """Reason aus einer bereits fertigen deny-JSON-Zeile eines lib-Moduls, sonst
    None -- nie raten, ob es ein deny war, sondern nachlesen."""
    try:
        obj = json.loads(json_text)
        out = obj.get('hookSpecificOutput') or {}
        if out.get('permissionDecision') == 'deny':
            return out.get('permissionDecisionReason') or ''
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Hilfsmittel: ein lib-Modul-main() mit dem schon eingelesenen Eingabetext
# fuettern und dessen stdout einsammeln, ohne einen eigenen Prozess zu starten.
# ---------------------------------------------------------------------------

def with_stdin(input_text, fn):
    old_stdin, old_stdout = sys.stdin, sys.stdout
    sys.stdin = io.StringIO(input_text)
    buf = io.StringIO()
    try:
        sys.stdout = buf
        fn()
    finally:
        sys.stdin, sys.stdout = old_stdin, old_stdout
    return buf.getvalue()


def print_deny(reason):
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': reason,
        }
    }))


def print_warn(reason):
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'permissionDecisionReason': reason,
            'additionalContext': reason,
        },
        'systemMessage': reason,
    }))


# ===========================================================================
# Einzelne Guards abschalten (2026-08-06)
# ===========================================================================
# Zweck: Bis hierher liefen die acht Guards und die Rueckfrage-Stufe fest; wer
#        einen davon stilllegen wollte, musste diesen Hook bearbeiten.
# Wo steht der Schalter: ~/.claude/workbench/settings.json, Schluessel `guards`,
#        je Guard {"aus": true, "grund": "...", "seit": "<ISO>",
#        "rolle": "alle|worker|orchestrator"}. Geschrieben wird er NUR ueber
#        `wb-state guard set …`, und das verlangt einen echten MENSCHEN
#        (`wb-mensch` misst die Herkunft des Aufrufs) und einen Grund. Ein
#        Agent, der die Einstellungsdatei beschreiben kann, legt damit keinen
#        Guard stumm -- der Schreibweg prueft, wer ruft.
# Voreinstellung: alle an. Fehlt die Datei, ist sie kaputt oder fehlt der
#        Schluessel, ist NICHTS abgeschaltet -- ein Fehler faellt immer in
#        Richtung "Sicherung greift".
#
# EIN ABGESCHALTETER GUARD BLEIBT SICHTBAR, auf drei Wegen:
#   1. Er wird trotzdem GEPRUEFT. Statt abzulehnen, sagt er, was er abgelehnt
#      HAETTE, samt Grund und Datum der Abschaltung. Eine stille Sicherung, die
#      nicht mehr da ist, ist schlimmer als keine.
#   2. Jeder Lauf schreibt die Liste der abgeschalteten Guards nach
#      <guard-blocks>/.abgeschaltet.json -- die Freigabe-Ansicht liest sie dort.
#      Ist nichts abgeschaltet, wird die Datei ENTFERNT: die Datei existiert
#      genau dann, wenn etwas aus ist.
#   3. `wb-state guard list` zeigt denselben Zustand im Terminal.
#
# ROLLEN: Die Hooks sehen den Pane (TMUX_PANE) und darueber @wb_role, also
#        laesst sich ein Guard auch NUR fuer Worker oder NUR fuer den
#        Orchestrator abschalten. Ohne Pane-Rolle greift nur `rolle: alle` --
#        eine Rolle, die sich nicht belegen laesst, wird nicht geraten.

# AWB_SETTINGS_FILE zeigt auf DIESELBE Datei -- `lib/ask_muster.py` liest sie seit dem
# 06.08. schon so, und eine Suite, die die echten Einstellungen der Maschine aus ihrem
# Lauf heraushalten will, musste bisher trotzdem damit rechnen, dass die Guard-Schalter
# davon unberuehrt weiterlaufen. Die Variable steht in der Umgebung des HOOK-Prozesses,
# die der Harness beim Start setzt; ein Agent kann sie mit einem Praefix vor seinem
# eigenen Befehl (`VAR=1 tmux ...`) nicht erreichen und damit keinen Guard stilllegen.
SETTINGS_FILE = os.environ.get('AWB_SETTINGS_FILE') or os.path.expanduser(
    '~/.claude/workbench/settings.json')

GUARD_NAMES = ['secrets', 'git-add', 'kill-pattern', 'live-config', 'push-gate', 'media-cloud',
               'screencapture', 'snapshot', 'commit-trailer', 'muster', 'pane-write']


def guard_settings():
    try:
        cfg = json.load(open(SETTINGS_FILE))
        g = cfg.get('guards')
        return g if isinstance(g, dict) else {}
    except Exception:
        return {}


def guard_aus(guards, name, role):
    """Der Eintrag, wenn dieser Guard fuer DIESE Rolle abgeschaltet ist, sonst None."""
    e = guards.get(name)
    if not isinstance(e, dict) or e.get('aus') is not True:
        return None
    r = e.get('rolle') or 'alle'
    if r != 'alle' and r != (role or ''):
        return None
    return e


def abschaltung_vermerken(guards, role):
    """Weg 2: der Zustand als Datei, bei jedem Lauf. Darf nie etwas kaputt
    machen -- ein nicht schreibbares Verzeichnis ist kein Grund, einen
    Bash-Aufruf scheitern zu lassen."""
    aus = []
    for g in GUARD_NAMES:
        e = guards.get(g)
        if isinstance(e, dict) and e.get('aus') is True:
            aus.append({'guard': g, 'grund': e.get('grund') or '',
                        'seit': e.get('seit') or '', 'rolle': e.get('rolle') or 'alle'})
    pfad = os.path.join(_guard_blocks_dir(), '.abgeschaltet.json')
    try:
        if not aus:
            if os.path.exists(pfad):
                os.remove(pfad)
            return
        os.makedirs(_guard_blocks_dir(), exist_ok=True)
        neu = json.dumps({'stand': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                          'rolleDiesesPanes': role or '', 'aus': aus},
                         ensure_ascii=False)
        fd, tmp = tempfile.mkstemp(dir=_guard_blocks_dir())
        with os.fdopen(fd, 'w') as f:
            f.write(neu)
        os.replace(tmp, pfad)
    except Exception:
        pass


def abschaltungs_warnung(name, eintrag, reason):
    """Weg 1: was der Guard abgelehnt HAETTE. Der Text nennt Guard, Datum und
    Grund -- ohne die drei ist die Meldung nur Laerm und niemand kann
    entscheiden, ob die Abschaltung noch stimmt."""
    seit = eintrag.get('seit') or 'unbekannt'
    grund = eintrag.get('grund') or 'kein Grund vermerkt'
    rolle = eintrag.get('rolle') or 'alle'
    return ('WARNUNG: Der Guard "%s" ist ABGESCHALTET (seit %s, fuer Rolle "%s").\n'
            'Grund der Abschaltung: %s\n'
            'Er haette diesen Befehl abgelehnt:\n%s\n'
            'Wieder einschalten: wb-state guard set %s an'
            % (name, seit, rolle, grund, reason, name))


def run_git(args):
    try:
        r = subprocess.run(['git'] + args, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return r.stdout


# ===========================================================================
# 1. bash-guard-secrets.sh
# ===========================================================================
# Zweck: verhindert `git add`/`git commit`, die .env-Dateien oder gaengige
#        Secret-Dateimuster ausserhalb ~/Knowledge/90-secrets/ einschliessen.
# Event: PreToolUse, matcher Bash.
# Warum: CLAUDE.md sagt "Never commit a .env (or any secret) to GitHub" und
#        "Secrets knowledge goes only into 90-secrets/" — bisher reine Prosa-
#        Regel ohne technische Durchsetzung (siehe research-skills Luecke #1).
# Fix nach Review 2026-07-28 (M10): alle drei Trigger-Checks verlangten "git"
#        UNMITTELBAR gefolgt vom Unterbefehl (add/commit) — `git -C <dir> add`
#        oder `git --git-dir=<pfad> commit` (genau die Form, die vault-sync
#        selbst benutzt!) fielen komplett durch den Hook. Jetzt liest
#        find_git_invocation() den ERSTEN Nicht-Options-Token nach "git" als
#        echtes Unterkommando (kennt -C/-c/--git-dir=/--work-tree= als
#        Optionen-mit-Wert) und traegt zusaetzlich den per -C/--git-dir
#        angegebenen Zielpfad ein — der breite Staging-Scan (Abschnitt 2)
#        prueft jetzt GENAU dieses Repo, nicht mehr blind das cwd des
#        Bash-Aufrufs (das bei `-C` etwas ganz anderes sein kann).
# Umweg, falls falsch-positiv: Datei umbenennen/aus dem Commit nehmen, oder
#        (nur wenn wirklich unbedenklich) einmalig ohne diesen Hook committen
#        via `git commit --no-verify` betrifft NICHT diesen Hook (Hooks laufen
#        unabhaengig von Git-Hooks) — in dem Fall den Nutzer fragen, ob das
#        Pattern hier angepasst werden soll.
# Fix nach Stresstest 2026-07-28 (B10/B02): Abschnitt 1 pruefte die Pfad-
#        Argumente von `git add` als rohe Kommandozeilen-Tokens — jede Form
#        von Quoting (`git add ".env"`, `git add "$(printf .env)"`, sogar
#        `git add .en''v`) liess sich damit beliebig variieren, der
#        tatsaechliche Working-Tree-Status nicht. Abschnitt 1 ist komplett
#        entfernt; Abschnitt 2 (git status --porcelain) laeuft jetzt bei JEDER
#        Form von `git add` (nicht nur den vorher als "breit" erkannten
#        -A/--all/./commit -a), erkennt damit alle Quoting-Varianten gleich
#        mit und kostet weiterhin nur einen git-Aufruf. Und: kein `jq` mehr —
#        Python3 (json-Modul) uebernimmt Parsen und Ausgabe, damit ein
#        fehlendes jq-Binary diesen Deny-Hook nicht mehr lautlos stilllegt.
#
# Diese Portierung benutzt bewusst dieselbe NAIVE Tokenisierung wie das
# Original (`read -r -a toks <<< "$seg"` == Split auf Whitespace, keine
# Quote-/Shell-Aufloesung) -- ein shell-bewussterer Tokenizer (wie cmdshell.py
# ihn fuer die anderen Guards benutzt) wuerde hier ANDERE Entscheidungen
# treffen als das Original, nicht nur "besser" tokenisieren.

GIT_OPTS_WITH_VALUE_C = ('-C',)


def _split_on_parens(text):
    """Wie `str.split()`, aber '(' und ')' zaehlen zusaetzlich als Wortgrenze.

    Entspricht `${seg//[()]/ }` in bash-guard-secrets.sh. Bewusst nur eine
    Wortgrenze und keine Shell-Aufloesung: dieser Guard tokenisiert absichtlich
    naiv (siehe Kommentarblock oben), und daran soll sich nichts aendern ausser
    dem einen Punkt, an dem eine Klammer den Befehlsnamen verklebt hat.
    """
    return text.replace('(', ' ').replace(')', ' ').split()


def find_git_invocation(command, targets):
    # Klammern trennen Woerter -- wortgleich zur selben Zeile in
    # bash-guard-secrets.sh, damit beide Ketten dasselbe entscheiden. Ohne sie
    # heisst der erste Token von `(git add .env)` "(git", und der Guard sah gar
    # keinen git-Aufruf. Gemessen 2026-08-05: beide protokollierten
    # secrets-Ablehnungen liefen in dieser geklebten Form durch.
    toks = _split_on_parens(command)
    n = len(toks)
    i = 0
    found = False
    dirhint_result = ''
    while i < n:
        if toks[i] == 'git':
            dirhint = ''
            j = i + 1
            while j < n:
                t = toks[j]
                if t == '-C':
                    dirhint = toks[j + 1] if j + 1 < n else ''
                    j += 2
                    continue
                elif t == '-c':
                    j += 2
                    continue
                elif t.startswith('--git-dir='):
                    dirhint = t[len('--git-dir='):]
                    j += 1
                    continue
                elif t.startswith('--work-tree='):
                    dirhint = t[len('--work-tree='):]
                    j += 1
                    continue
                elif t.startswith('-'):
                    j += 1
                    continue
                else:
                    break
            if j < n:
                sub = toks[j]
                if sub in targets:
                    dirhint_result = dirhint
                    found = True
        i += 1
    return found, dirhint_result


def is_allowed_env_suffix(p):
    return re.search(r'\.env\.(example|template|sample)$', p, re.IGNORECASE) is not None


def is_secret_path(p):
    if re.search(r'(^|/)90-secrets/', p):
        return False
    if is_allowed_env_suffix(p):
        return False
    if re.search(r'(^|/)\.env($|\.[A-Za-z0-9_-]+$)', p):
        return True
    if re.search(
        r'(^|/)(id_rsa|id_ed25519|id_ecdsa)$|\.(pem|p12|pfx)$|(^|/)credentials\.json$'
        r'|(^|/)service-account.*\.json$|(^|/)secrets\.ya?ml$', p, re.IGNORECASE
    ):
        return True
    return False


def check_secrets(command, cwd):
    if not command:
        return None

    gate1_found, _ = find_git_invocation(command, ('add', 'commit'))
    if not gate1_found:
        return None

    add_found, _ = find_git_invocation(command, ('add',))
    commit_dash_a = bool(re.search(r'commit\s+-a(m|\s|$)', command, re.MULTILINE))
    if not (add_found or commit_dash_a):
        return None

    _found2, dirhint = find_git_invocation(command, ('add', 'commit'))
    repo_dir = dirhint or cwd or os.getcwd()

    if run_git(['-C', repo_dir, 'rev-parse', '--show-toplevel']) is not None:
        status = run_git(['-C', repo_dir, 'status', '--porcelain']) or ''
        for line in status.splitlines():
            path = re.sub(r'^.{2} ', '', line, count=1)
            path = re.sub(r'.* -> ', '', path)
            if not path:
                continue
            if is_secret_path(path):
                return (
                    "git add/commit (breites Staging, Repo: %s) wuerde eine Secret-/.env-Datei "
                    "einschliessen (%s) ausserhalb 90-secrets/. Blockiert von bash-guard-secrets."
                    % (repo_dir, path)
                )
        return None
    else:
        # git nicht benutzbar (fehlt im PATH, kein Repo): frueher endete der Hook hier
        # still auf "erlauben" — gemessen im Stresstest mit gestripptem PATH. Ein
        # Deny-Hook, der seine Pruefung nicht durchfuehren kann, darf nicht so tun, als
        # waere alles in Ordnung. Die Namen im Kommando selbst kann er trotzdem pruefen;
        # bleibt danach Unsicherheit, wird sie WENIGSTENS sichtbar gemacht.
        # Klammern auch hier als Wortgrenze -- sonst hiesse der Pfad in
        # `(git add .env)` ".env)" und kein Secret-Muster traefe darauf.
        for tok in _split_on_parens(command):
            if tok.startswith('-'):
                continue
            stripped = tok
            if stripped.endswith('"'):
                stripped = stripped[:-1]
            if stripped.startswith('"'):
                stripped = stripped[1:]
            if stripped.endswith("'"):
                stripped = stripped[:-1]
            if stripped.startswith("'"):
                stripped = stripped[1:]
            if is_secret_path(stripped):
                return (
                    "git add/commit nennt '%s' — sieht nach einer Secret-/.env-Datei ausserhalb "
                    "90-secrets/ aus. (git war hier nicht benutzbar, geprueft wurde deshalb nur der "
                    "Kommandotext.) Blockiert von bash-guard-secrets." % stripped
                )
        sys.stderr.write(
            "bash-guard-secrets: WARNUNG — git ist hier nicht benutzbar (Repo '%s'); es wurde NUR "
            "der Kommandotext geprueft, nicht der Staging-Bereich.\n" % repo_dir
        )
        return None


# ===========================================================================
# 1b. git-add (2026-08-16) -- neuer Guard, kein Vorbild in der alten Kette
# ===========================================================================
# Zweck: BLOCKT ein `git add`, das ein ganzes VERZEICHNIS oder den Arbeitsbaum
#        einsammelt (-A/--all/--no-ignore-removal, '.', ':/', '*', oder ein
#        Argument, das auf der Platte tatsaechlich ein Verzeichnis ist), und
#        verlangt stattdessen die Dateipfade, die der Aufrufer selbst
#        angefasst hat.
# Event: PreToolUse, matcher Bash.
# Warum: Stehende Regel (regeln/arbeitsweise.md, Code hygiene, seit 2026-08-11):
#        "Wer committet, nennt seine Pfade — git add -A nie", belegt durch ein
#        `git add -A` im Gaertner, das 31 Tage lang Fremdes einsammelte. Bis
#        heute stand die Regel nur als Prosa da. Am 2026-08-16 hat genau diese
#        Luecke real zugeschlagen: eine Orchestrator-Sitzung hat mit
#        `git add shell` und `git add -A app shell` die laufende, halbfertige
#        Arbeit einer ZWEITEN Sitzung an shell/grug-server in zwei eigene
#        Commits gezogen und gepusht (samt deren neuer Testsuite
#        shell/tests/test-grug-server-stop.sh) — die fremde Suite war danach
#        rot. Ein Verzeichnis-Add sieht harmlos aus und ist genau deshalb der
#        Weg, auf dem es passiert: anders als -A/./:/`*` traegt es kein
#        offensichtliches "ich nehme alles"-Signal im Kommando selbst.
# Grenze: Wie secrets/commit-trailer erkennt dieser Guard nur, was im Kommando
#        selbst steht -- ein `git add` aus einem Skript heraus sieht er nicht.
#        Die Tokenisierung ist bewusst naiv (Whitespace-Split, Klammern als
#        zusaetzliche Wortgrenze wie bei den beiden genannten Nachbarn) --
#        kein shell-bewusster Parser wie cmdshell.py, aus demselben Grund wie
#        bei secrets/commit-trailer: eine praezisere Zerlegung wuerde hier
#        ANDERE Entscheidungen treffen, nicht nur "genauer" tokenisieren, und
#        dieser Guard soll exakt das erkennen, was ein Mensch beim Lesen der
#        Zeile sieht. Der Verzeichnis-Test prueft relativ zum `cwd` des
#        Tool-Aufrufs (bzw. absolut, wenn das Argument ein absoluter Pfad
#        ist) -- ein Pfad, der zur Pruefzeit noch nicht existiert, kann kein
#        Verzeichnis sein und faellt durch dieses Sieb (bewusst: dieselbe
#        Haltung wie beim snapshot-Guard, "was nicht da ist, kann nicht
#        geprueft werden").

GIT_ADD_SEPARATORS = (';', '&', '|', '&&', '||')


def _git_add_arg_lists(command):
    """Fuer jedes `git add`-Vorkommen im (parens-getrennten) Kommando: die Liste
    seiner rohen Argument-Tokens, abgeschnitten am naechsten Trenner (;/&/|).
    Klammern zaehlen als Wortgrenze -- wortgleiche Behandlung zu
    find_git_invocation()/_split_on_parens() oben: `(git add -A)` ist
    dasselbe Add wie ohne Klammer.

    Zeilenweise (Korrektur 16.08.): `_split_on_parens` wirft Zeilenumbrueche
    weg, GIT_ADD_SEPARATORS kennt sie nicht, und die Argumentliste lief damit
    ueber das Zeilenende hinaus in alles, was danach im selben Aufruf stand.
    Gemessen an einem echten Fall: `git add vier/dateien` gefolgt von
    `git commit -F - <<'EOF'` mit mehrzeiligem Text wurde abgelehnt, weil der
    Text einen mit ')' endenden Satz enthielt -- die Klammer wird als Wort
    abgetrennt, der Satzpunkt bleibt als eigenes Token '.' zurueck, und genau
    darauf prueft _git_add_grund. Ein Fehlalarm auf korrekter Arbeit ist nicht
    harmlos: er ist der Grund, aus dem Guards abgeschaltet werden. Die Zerlegung
    je Zeile ist die konservative Korrektur -- ein `git add` endet spaetestens
    am Zeilenende, und ein `git add -A` in einer spaeteren Zeile (auch im Text
    eines Here-Documents) wird weiterhin gesehen und geprueft, statt
    ausgeschnitten zu werden."""
    out = []
    for zeile in command.splitlines():
        out.extend(_git_add_arg_lists_einzeilig(zeile))
    return out


def _git_add_arg_lists_einzeilig(command):
    toks = _split_on_parens(command)
    n = len(toks)
    out = []
    i = 0
    while i < n:
        if toks[i] != 'git':
            i += 1
            continue
        j = i + 1
        while j < n:
            t = toks[j]
            if t in ('-C', '-c'):
                j += 2
                continue
            if t.startswith('--git-dir=') or t.startswith('--work-tree='):
                j += 1
                continue
            if t.startswith('-'):
                j += 1
                continue
            break
        if j < n and toks[j] == 'add':
            k = j + 1
            args = []
            while k < n and toks[k] not in GIT_ADD_SEPARATORS:
                args.append(toks[k])
                k += 1
            out.append(args)
            i = k
        else:
            i = j
    return out


def _git_add_grund(args, cwd):
    """Der erste Grund, warum diese Argumentliste ein VERZEICHNIS oder den
    Arbeitsbaum einsammelt, sonst None. Reihenfolge wie in der Vorlage:
    -A/--all zuerst, dann '.', dann ':/', dann '*', erst danach der
    Verzeichnis-Test je Wort."""
    if any(a in ('-A', '--all', '--no-ignore-removal') for a in args):
        return "-A/--all sammelt den ganzen Arbeitsbaum ein"
    if any(a == '.' for a in args):
        return "'.' sammelt alles unterhalb des Arbeitsverzeichnisses ein"
    if any(a == ':/' or a.startswith(':/') for a in args):
        return "':/' sammelt vom Wurzelverzeichnis des Repos aus ein"
    if any(a == '*' for a in args):
        return "'*' expandiert zu allem, was die Shell gerade sieht"
    for a in args:
        if not a or a.startswith('-'):
            continue
        pfad = a if os.path.isabs(a) else os.path.join(cwd or '.', a)
        if os.path.isdir(pfad):
            return "'%s' ist ein VERZEICHNIS — damit reist jede fremde Aenderung darin mit" % a
    return None


def check_git_add(command, cwd):
    if not command:
        return None
    for args in _git_add_arg_lists(command):
        grund = _git_add_grund(args, cwd)
        if grund:
            return (
                "git add abgelehnt: %s.\n"
                "  Stehende Regel (regeln/arbeitsweise.md, Code hygiene, 2026-08-11): wer "
                "committet, nennt SEINE Pfade — git add -A nie. In diesem Haus arbeiten "
                "regelmaessig mehrere Sitzungen im selben Baum; ein Verzeichnis- oder "
                "Breites-Add zieht ihre halbfertige Arbeit in Deinen Commit, und nach dem "
                "Push ist das nicht mehr still zu reparieren — belegt am 2026-08-16: "
                "'git add shell' und 'git add -A app shell' haben die laufende Arbeit einer "
                "zweiten Sitzung an shell/grug-server in zwei Commits gezogen und gepusht, "
                "samt deren Testsuite, die danach rot war.\n"
                "  Statt dessen: die Dateien einzeln nennen, die Du selbst angefasst hast.\n"
                "    git status --short          # zeigt, was da ist — auch das, was NICHT Dir gehoert\n"
                "    git add pfad/zur/datei.ts pfad/zur/anderen.sh\n"
                "  Braucht ein Werkzeug wirklich den ganzen Baum (frischer Klon, "
                "Erstbefuellung), dann macht das ein Mensch am Terminal, nicht ein Agent im "
                "Vorbeigehen.\n"
                "  Blockiert von git-add." % grund
            )
    return None


# ===========================================================================
# 2. bash-guard-live-config.sh (nur der Bash-Zweig -- Write|Edit bleibt im
#    eigenstaendigen Skript, das weiterhin unter dem Write|Edit-Matcher haengt)
# ===========================================================================
# Zweck: WARNT (blockt NICHT) vor Test-artigen Schreibzugriffen auf die echte
#        Workbench-Settings-Datei (~/.claude/workbench/settings.json) oder vor
#        Eingaben/Kommandos gegen eine LIVE-tmux-Session, wenn der Aufruf nach
#        einem Test aussieht, aber keine Test-Isolation (HOME=$(mktemp -d),
#        -L wbtest) erkennbar ist.
# Event: PreToolUse, matcher Bash + Write + Edit.
# Warum: ECHTER Vorfall — ein Worker hat `workerLayout` zum Testen auf
#        "window" und zurueckgeschaltet, dabei wanderten vier laufende Worker
#        des Nutzers in ein tmux-Fenster ohne Client — fuer ihn sahen sie aus,
#        als liefen keine Worker. CLAUDE.md: "Tests fassen nie die Live-
#        Umgebung an und nie das Fenster des Nutzers."
# Policy: bewusst NUR warnen (nie deny) — die Heuristik "sieht nach Test aus"
#        ist unscharf (Pfad-/Kommando-Substring-Suche), ein falscher Block
#        waere schlimmer als eine verpasste Warnung (siehe Auftrag). Wer die
#        Warnung sieht und weiss, dass es kein Test ist, ignoriert sie einfach
#        — es gibt keinen Override-Mechanismus noetig, weil nichts blockiert.

def check_live_config_bash(command, cwd):
    if not command:
        return None

    real_live_settings = os.path.join(
        os.environ.get('HOME', os.path.expanduser('~')), '.claude', 'workbench', 'settings.json')

    def looks_like_test_context():
        return bool(re.search(r'(^|/)tests?(/|$)|test', cwd or '', re.IGNORECASE))

    # tmux send-keys/attach gegen eine Session mit dem Live-Praefix "wb-",
    # ohne eigenen Test-Socket (-L wbtest / TMUX_TMPDIR).
    if re.search(r'tmux\s+.*(send-keys|attach)', command) \
            and re.search(r'=?wb-', command, re.IGNORECASE) \
            and not re.search(r'wbtest|-L\s+wbtest|TMUX_TMPDIR', command, re.IGNORECASE):
        if looks_like_test_context() or re.search(r'test', command, re.IGNORECASE):
            return (
                "WARNUNG bash-guard-live-config: tmux-Kommando gegen eine Session mit Live-Praefix "
                "'wb-' aus einem nach-Test-aussehenden Kontext, aber kein eigener Test-Socket "
                "(-L wbtest) und kein HOME-Redirect erkennbar. Falls das ein Test ist: eigenen "
                "Socket verwenden (tmux -L wbtest ...). Falls kein Test: ignorieren."
            )

    # Direkter Schreibversuch auf die echte Settings-Datei via Bash (z.B. cat >, echo >, cp).
    if real_live_settings in command \
            and re.search(r'(>|>>|cp\s+.*\s|mv\s+.*\s)', command) \
            and not re.search(r'HOME=|mktemp', command, re.IGNORECASE):
        if looks_like_test_context() or re.search(r'test', command, re.IGNORECASE):
            return (
                "WARNUNG bash-guard-live-config: Bash-Kommando schreibt moeglicherweise direkt auf "
                "die ECHTE Workbench-Settings (%s) aus einem nach-Test-aussehenden Kontext, ohne "
                "erkennbares HOME=$(mktemp -d). Falls das ein Test ist: HOME umleiten. Falls kein "
                "Test: ignorieren." % real_live_settings
            )

    return None


# ===========================================================================
# 3b. pane-write (2026-08-06) -- neuer Guard, kein Vorbild in der alten Kette
# ===========================================================================
# Zweck: Ein Agent darf nicht mehr mit `tmux send-keys` in einen Orchestrator-Pane
#        tippen. Die Regel selbst steht in `shell/wb-pane-write`; sie greift fuer
#        alles, was durch dieses Werkzeug geht. Dieser Guard ist die ZWEITE, davon
#        unabhaengige Schicht: er faengt den direkten Weg an dem Werkzeug vorbei.
# Event: PreToolUse, matcher Bash.
# Warum: Vorgabe des Nutzers, 2026-08-06 -- "ich will das niemand ausser mir und dem kontext
#        guard in den orchestrator chat promptet". Am 04.08. hat eine Testsuite in
#        die Live-Sitzung getippt und dem Orchestrator eine Anweisung untergeschoben.
# Policy: DENY, fail-closed. Ein Ziel, dessen Rolle sich nicht bestimmen laesst,
#        gilt als Orchestrator; ein `send-keys` ganz ohne `-t` trifft den gerade
#        aktiven Pane und ist damit erst recht unbestimmt.
# GRENZEN, offen benannt: Dieser Guard sieht nur, was ein Agent DIREKT als
#        Bash-Befehl ausfuehrt. Ruft er ein Skript auf, das seinerseits tippt
#        (`bash shell/tests/test-x.sh`), steht im Befehl kein `tmux` -- dagegen
#        hilft nur die Engstelle selbst. Und ein tmux-Aufruf gegen einen ANDEREN
#        Server (-L/-S/TMUX_TMPDIR) wird durchgelassen: er kann den hiesigen
#        Orchestrator nicht erreichen, und ohne diese Ausnahme koennte kein Test
#        mehr auf seinem eigenen Socket arbeiten.

PANE_WRITE_VERBS = ('send-keys', 'paste-buffer', 'send-prefix')

PANE_WRITE_HINWEIS = (
    "In einen Orchestrator-Pane schreiben nur ein gemessener Mensch und der "
    "context-guard. Alles andere kommt ohne Tippen aus: Ergebnisse nach "
    "~/.pi-workers/results/, Freigaben nach ~/.pi-workers/requests/ -- die Workbench "
    "liest beides von selbst. Ein Worker-Pane darf weiter angesprochen werden, dann "
    "aber ueber `wb-pane-write` statt ueber `tmux` direkt. Ein Test arbeitet auf einem "
    "eigenen Socket (tmux -L wbtest...). Blockiert von pane-write."
)


def ziel_ist_orchestrator(target):
    """(gilt als Orchestrator?, Begruendung) -- aus BEIDEN Rollenquellen.

    Bis zum 07.08. stand hier nur die tmux-Pane-Option, und die durfte der
    Bewachte selbst schreiben: `tmux set -p -t <ziel> @wb_role worker` liess
    denselben send-keys danach durch (gemessen). Jetzt entscheidet die
    strengste Lesart aus Option UND Register (lib/rollen.py), und der Versuch,
    die Option zu setzen, wird selbst abgelehnt (check_rollen_option unten)."""
    if shutil.which('tmux') is None:
        return True, 'tmux nicht auffindbar, Rolle nicht bestimmbar'
    try:
        return rollen.ziel_ist_orchestrator(target)
    except Exception:
        return True, 'Rolle nicht bestimmbar (Fehler beim Lesen), gilt als Orchestrator'


def _tmux_ziel(rest):
    """Der Wert hinter -t, oder None. `-t%3` (zusammengeschrieben) zaehlt mit."""
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok == '-t' and i + 1 < len(rest):
            return rest[i + 1]
        if tok.startswith('-t') and len(tok) > 2:
            return tok[2:]
        i += 1
    return None


def check_pane_write_bash(command):
    if not command:
        return None
    # Ein anderer tmux-Server ist ausserhalb der Reichweite dieses Orchestrators.
    if re.search(r'TMUX_TMPDIR=', command):
        return None
    roh_trifft = re.search(r'\b(%s)\b' % '|'.join(PANE_WRITE_VERBS), command)
    stmts = cmdshell.all_statements(command)
    if stmts == [None]:
        # Unzerlegbar. Fail-closed, aber nur wenn ueberhaupt ein Schreibverb im
        # Rohtext steht -- dieselbe Bauart wie FAILCLOSED_RE in den lib-Modulen:
        # raten wird nur dort, wo etwas zu raten ist.
        if roh_trifft:
            return ("Befehl nicht zerlegbar, enthaelt aber einen tmux-Schreibbefehl. "
                    "Im Zweifel gilt der Orchestrator als Ziel. " + PANE_WRITE_HINWEIS)
        return None
    prefixes = cmdshell.assignment_prefixes(stmts)
    for idx, stmt in enumerate(stmts):
        if not stmt:
            continue
        varmap = prefixes[idx] if idx < len(prefixes) else {}
        for stage in cmdshell.split_pipeline(cmdshell.strip_redirections(stmt)):
            name, _i, rest = cmdshell.resolve_command(stage, varmap)
            if name != 'tmux':
                continue
            # Eigener Server: -L <name> / -S <pfad>, auch zusammengeschrieben.
            if any(t == '-L' or t == '-S' or t.startswith('-L') or t.startswith('-S')
                   for t in rest):
                continue
            unterbefehl = next((t for t in rest if not t.startswith('-')), '')
            if unterbefehl not in PANE_WRITE_VERBS:
                continue
            ziel = _tmux_ziel(rest)
            if not ziel:
                return ("`tmux %s` ohne -t trifft den gerade aktiven Pane -- welcher das "
                        "ist, steht nicht fest. %s" % (unterbefehl, PANE_WRITE_HINWEIS))
            ziel = cmdshell.resolve_vars(ziel, varmap)
            ist_orch, wie = ziel_ist_orchestrator(ziel)
            if not ist_orch:
                continue
            return ("`tmux %s` gegen Pane '%s' (%s). %s"
                    % (unterbefehl, ziel, wie, PANE_WRITE_HINWEIS))
    return None


# ===========================================================================
# 3c. rolle (2026-08-07) -- die Rollenquelle selbst
# ===========================================================================
# Zweck: Kein Agent aendert oder loescht mehr die Pane-Option `@wb_role`.
# Event: PreToolUse, matcher Bash.
# BEFUND (Durchsicht 2026-08-07, gemessen): `tmux set -p -t <pane> @wb_role
#        worker` war erlaubt. Danach fielen drei Sicherungen auf einmal --
#        Push-Verbot, Schutz des Orchestrator-Panes und das Kompaktier-Gate,
#        denn alle drei lasen genau diese eine Option. Die Gegenrichtung
#        (`set -u @wb_role` auf dem EIGENEN Pane) machte aus dem Worker einen
#        Pane ohne Rolle und damit einen, der pushen darf.
# Policy: DENY, fail-closed. Erkannt wird der Versuch, nicht die Schreibweise:
#        set / set-option / setw / set-window-option, -p/-w/-g/-s, -u zum
#        Loeschen, mehrere Befehle in einer Zeile, tmux-eigene Befehlsketten
#        (`tmux new-window \; set -p @wb_role worker`) und Variablen. Laesst
#        sich die Zeile nicht zerlegen und steht `@wb_role` im Rohtext drin,
#        wird abgelehnt; steht der Optionsname erst zur Laufzeit fest, ebenso.
# LESEN bleibt erlaubt: `tmux display -p '#{@wb_role}'`, `show-options`,
#        `list-panes -F '#{@wb_role}'` -- daran haengt die halbe Werkbank.
# ANDERER SERVER: ein Aufruf gegen einen eigenen tmux-Server (-L/-S) darf
#        setzen, denn er erreicht die hiesigen Panes nicht. Verglichen wird
#        der SOCKET-PFAD, nicht der Name: fuer -L bildet tmux
#        ${TMUX_TMPDIR:-/tmp}/tmux-<uid>/<name>, fuer -S steht er da. Laesst
#        sich einer der beiden Pfade nicht bestimmen, wird abgelehnt.
# WARUM DIESER GUARD KEINEN SCHALTER HAT: Die uebrigen Guards lassen sich in
#        der Einstellungsdatei abschalten. Genau diese Datei ist aber (Befund
#        2 derselben Durchsicht) fuer jeden Agenten beschreibbar. Ein Guard,
#        der die Rollenquelle schuetzt, darf nicht ueber eine Datei
#        abschaltbar sein, die schwaecher gesichert ist als das, was er
#        schuetzt. Er steht deshalb nicht in GUARD_NAMES und kennt kein `aus`.
# WER DIE ROLLE LEGITIM SETZT, und wie sich das unterscheidet: `pi-worker`
#        setzt sie beim Spawn (jetzt ueber `wb-rolle`, das zusaetzlich das
#        Register fuehrt). Dieser Guard sieht davon nichts -- in der
#        Befehlszeile des Agenten steht `pi-worker <name> ...`, nicht `tmux
#        set`. Der Unterschied ist also nicht "wer darf", sondern WO der
#        Befehl steht: im Werkzeug, das ihn kapselt, oder in der Zeile, die
#        der Bewachte selbst schreibt. Und `wb-rolle` prueft seinerseits, dass
#        niemand seinen EIGENEN Pane hochstuft (siehe dort).

ROLLEN_OPTION = '@wb_role'
ROLLEN_SET_VERBEN = ('set', 'set-option', 'setw', 'set-window-option')
# Flaggen mit eigenem Wert -- der Wert ist kein Optionsname.
_TMUX_FLAG_MIT_WERT = ('-t', '-L', '-S', '-f', '-F', '-c')

ROLLEN_HINWEIS = (
    "Die Rolle eines Panes ist keine Behauptung, die der Bewachte selbst "
    "umschreiben darf: an ihr haengen das Push-Verbot, der Schutz des "
    "Orchestrator-Panes und das Kompaktier-Gate. Gesetzt wird sie beim Spawn "
    "(pi-worker) ueber `wb-rolle`, das sie zusaetzlich im Register festhaelt; "
    "ein Test arbeitet auf einem eigenen Socket (tmux -L wbtest ...). "
    "Blockiert von rolle."
)


def _rollen_zielsocket(rest):
    """Socket-Pfad des Servers, den dieser tmux-Aufruf meint. '' = unbekannt."""
    i = 0
    while i < len(rest):
        tok = rest[i]
        wert = None
        if tok in ('-L', '-S') and i + 1 < len(rest):
            wert = rest[i + 1]
            art = tok
        elif tok.startswith('-L') and len(tok) > 2:
            wert, art = tok[2:], '-L'
        elif tok.startswith('-S') and len(tok) > 2:
            wert, art = tok[2:], '-S'
        if wert is not None:
            if art == '-S':
                return os.path.realpath(os.path.expanduser(wert))
            tmpdir = os.environ.get('TMUX_TMPDIR') or '/tmp'
            return os.path.realpath(os.path.join(tmpdir, 'tmux-%d' % os.getuid(), wert))
        i += 1
    # Kein eigener Server genannt -> der umgebende, also der aus $TMUX.
    t = os.environ.get('TMUX', '')
    if t:
        return os.path.realpath(t.split(',')[0])
    return ''


def _rollen_optionsname_unklar(rest, varmap):
    """Steht an der Stelle des Optionsnamens etwas, das erst zur Laufzeit
    feststeht? Dann laesst sich nicht sagen, ob es `@wb_role` ist."""
    i = 0
    verb_gesehen = False
    while i < len(rest):
        tok = rest[i]
        if tok in _TMUX_FLAG_MIT_WERT:
            i += 2
            continue
        if tok.startswith('-'):
            i += 1
            continue
        if not verb_gesehen:
            verb_gesehen = True
            i += 1
            continue
        aufgeloest = cmdshell.resolve_vars(tok, varmap)
        return bool(re.search(r'\$\{?[A-Za-z_@*#?!0-9]|`', aufgeloest))
    return False


def check_rollen_option(command):
    if not command:
        return None
    # Der Rumpf eines Here-Dokuments ist Text, kein Code. Er wird
    # weggeschnitten, aus demselben Grund wie in ask_muster: eine Sicherung,
    # die schon beim SCHREIBEN ueber einen Befehl anschlaegt, erzieht zum
    # Wegklicken und traegt sich selbst ab (Befund 2026-08-05).
    command = cmdshell.strip_heredocs(command)
    stmts = cmdshell.all_statements(command)
    if stmts == [None]:
        if ROLLEN_OPTION in command:
            return ("Befehl nicht zerlegbar, enthaelt aber '%s'. Im Zweifel gilt er als "
                    "Versuch, die Rollenquelle zu setzen. %s" % (ROLLEN_OPTION, ROLLEN_HINWEIS))
        return None
    prefixes = cmdshell.assignment_prefixes(stmts)
    for idx, stmt in enumerate(stmts):
        if not stmt:
            continue
        varmap = prefixes[idx] if idx < len(prefixes) else {}
        for stage in cmdshell.split_pipeline(cmdshell.strip_redirections(stmt)):
            name, _i, rest = cmdshell.resolve_command(stage, varmap)
            if name in ROLLEN_SET_VERBEN:
                # Eine tmux-eigene Befehlskette (`tmux new-window \; set -p
                # @wb_role worker`) kommt hier als ZWEITE Anweisung an, deren
                # Befehlsname `set` ist -- das `tmux` steht in der ersten.
                # Welchen Server sie meint, ist damit nicht mehr zu sehen:
                # fail-closed. Eine Shell-Anweisung `set ... @wb_role ...` gibt
                # es nicht, also kostet das keinen richtigen Befehl.
                if any(ROLLEN_OPTION in cmdshell.resolve_vars(t, varmap) for t in rest):
                    return ("`%s ... %s ...` steht ohne sichtbares `tmux` in der Zeile "
                            "(tmux-Befehlskette). Welcher Server gemeint ist, laesst sich "
                            "so nicht bestimmen. %s" % (name, ROLLEN_OPTION, ROLLEN_HINWEIS))
                continue
            if name != 'tmux':
                continue
            aufgeloest = [cmdshell.resolve_vars(t, varmap) for t in rest]
            setzt = any(t in ROLLEN_SET_VERBEN for t in aufgeloest)
            if not setzt:
                continue
            nennt_rolle = any(ROLLEN_OPTION in t for t in aufgeloest)
            if not nennt_rolle and not _rollen_optionsname_unklar(rest, varmap):
                continue
            ziel = _rollen_zielsocket(aufgeloest)
            hier = os.path.realpath((os.environ.get('TMUX', '') or '').split(',')[0]) \
                if os.environ.get('TMUX') else ''
            if ziel and hier and ziel != hier:
                continue   # eigener Server, erreicht die hiesigen Panes nicht
            wie = ('nennt %s' % ROLLEN_OPTION if nennt_rolle
                   else 'der Optionsname steht erst zur Laufzeit fest')
            woher = ('' if ziel and hier else
                     ' Der gemeinte tmux-Server liess sich nicht bestimmen (%s gegen %s).'
                     % (ziel or 'unbekannt', hier or 'unbekannt'))
            return ("`tmux %s ...` (%s) veraendert die Rollenquelle dieses Servers.%s %s"
                    % (next(t for t in aufgeloest if t in ROLLEN_SET_VERBEN),
                       wie, woher, ROLLEN_HINWEIS))
    return None


# ===========================================================================
# 3d. freigabe-pfad (2026-08-07) -- die Ablage der Freigaben und des Registers
# ===========================================================================
# Zweck: Kein Agent legt selbst eine Freigabe an, kein Agent liest den
#        Signaturschluessel, kein Agent raeumt das Rollenregister ab.
# BEFUND (Durchsicht 2026-08-07, gemessen): Die Rueckfrage-Stufe haelt `sudo
#        launchctl list` an -- nach einer selbst geschriebenen JSON-Datei in
#        ~/.pi-workers/guard-grants/ lief derselbe Befehl durch. Die
#        Herkunftspruefung in lib/ask_muster.py (Signatur + gemessener
#        Herkunftsbeleg) ist die eine Haelfte der Antwort; diese hier ist die
#        andere: der Weg zur Datei wird schon vorher versperrt, damit ein
#        Agent nicht einmal in die Naehe des Schluessels kommt.
# Policy: DENY fuer JEDEN Zugriff -- auch lesend. Ein Agent hat in diesen drei
#        Ablagen nichts zu suchen: die Freigaben schreibt ein Mensch (ueber
#        `wb-freigabe` oder das Programmfenster), das Register fuehrt
#        `wb-rolle`, und der Schluessel ist genau das, was eine Faelschung
#        verhindern soll.
# Kein Schalter, aus demselben Grund wie bei 3c.

def _geschuetzte_pfade():
    grants = ask_muster.grants_dir()
    return [grants, ask_muster.schluessel_datei(), rollen.verzeichnis()]


FREIGABE_HINWEIS = (
    "Freigaben erteilt ein Mensch -- im Programmfenster oder mit `wb-freigabe "
    "erteilen <pane> <grund>` im Terminal; beides misst die Herkunft, statt "
    "sie zu glauben. Das Rollenregister fuehrt `wb-rolle`. Ein angehaltener "
    "Befehl wird wiederholt, nicht umgangen. Blockiert von freigabe-pfad."
)


def check_freigabe_pfad(command):
    if not command:
        return None
    # Wie oben: der Rumpf eines Here-Dokuments zaehlt nicht. Ein Bericht, der
    # diese Pfade ERWAEHNT, ist kein Zugriff auf sie -- der Angriff steht im
    # Umleitungsziel oder in einem Argument, und beides bleibt nach dem
    # Schnitt stehen.
    command = cmdshell.strip_heredocs(command)
    heim = os.path.expanduser('~')
    formen = []
    for pfad in _geschuetzte_pfade():
        if not pfad:
            continue
        formen.append(pfad)
        if pfad.startswith(heim):
            rest = pfad[len(heim):]
            formen.append('~' + rest)
            formen.append('$HOME' + rest)
            formen.append('${HOME}' + rest)
    # Sprechende Bestandteile zusaetzlich: eine anders zusammengesetzte
    # Pfadangabe (Variable, Teilstueck) faellt damit trotzdem auf.
    formen.extend(['guard-grants', ask_muster.SCHLUESSEL_NAME, 'pi-workers/rollen'])
    for form in formen:
        if form and form in command:
            return ("Der Befehl fasst eine geschuetzte Ablage an (%s). %s"
                    % (form, FREIGABE_HINWEIS))
    return None


# ===========================================================================
# 3. push-gate-worker.sh (Klassifikation importiert, Rollen-Check + Deny-Text
#    hier -- die waren im Original auch nicht Teil des lib-Moduls)
# ===========================================================================

PUSH_GATE_REASON = (
    "Push-Authority-Regel: nur der Orchestrator pusht/erstellt PRs. Dieser "
    "Pane ist als @wb_role=worker markiert. Verifizierte Arbeit ans "
    "Orchestrator-Pane zurueckgeben. Blockiert von push-gate-worker."
)


def get_pane_role():
    """Die Rolle DIESES Panes fuer den Rollenfilter der Guard-Schalter.
    Register vor Pane-Option (lib/rollen.py), damit auch hier keine Rolle
    zaehlt, die sich der Bewachte selbst gegeben hat."""
    tmux_pane = os.environ.get('TMUX_PANE', '')
    if not tmux_pane or shutil.which('tmux') is None:
        return ''
    try:
        return rollen.rolle_effektiv(tmux_pane)
    except Exception:
        return ''


def ist_worker_pane():
    """(Worker?, Begruendung) fuer das Push-Verbot -- aus BEIDEN Quellen.
    Ein Worker, der seine Pane-Option loescht, bleibt damit ein Worker
    (gemessen war genau das der Weg an dieser Sperre vorbei)."""
    tmux_pane = os.environ.get('TMUX_PANE', '')
    if not tmux_pane or shutil.which('tmux') is None:
        return False, 'kein Pane bestimmbar'
    try:
        return rollen.selbst_ist_worker(tmux_pane)
    except Exception:
        return False, 'Rolle nicht bestimmbar'


# ===========================================================================
# 4. media-cloud-guard.sh (nur der Bash-Zweig -- WebFetch/MCP bleiben im
#    eigenstaendigen Skript)
# ===========================================================================
# Zweck: WARNT (blockt nie) bei Aufrufen an bekannte Cloud-Bild-/Video-/Audio-
#        APIs, verweist auf die lokalen Tools bild/video/tts/stt.
# Event: PreToolUse, matcher Bash + WebFetch.
# Warum: LOCAL-FIRST-Media-Regel ("website/landing-page images ... never a
#        paid cloud model/connector") gilt fuer Orchestrator UND jeden Worker,
#        ist aber nirgends technisch erzwungen — nur Prosa in CLAUDE.md.
# Blockliste: ~/.claude/hooks/media-cloud-domains.txt (separat, leicht
#        pflegbar ohne diesen Hook neu zu schreiben).
# Policy: reines Warnen, kein Deny — die Liste veraltet schnell und manche
#        Cloud-Aufrufe sind bewusst genehmigte Ausnahmen (z.B. creative-media-
#        Skill nutzt Higgsfield gezielt); ein Hard-Block waere hier falsch.

def check_media_cloud_bash(command):
    domains_file = os.path.join(
        os.environ.get('HOME', os.path.expanduser('~')), '.claude', 'hooks', 'media-cloud-domains.txt')
    if not os.path.isfile(domains_file):
        return None
    if not command:
        return None
    try:
        with open(domains_file, 'r', encoding='utf-8', errors='replace') as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None

    hit = None
    for domain in lines:
        if domain == '' or domain.startswith('#'):
            continue
        if domain in command:
            hit = domain
            break
    if hit is None:
        return None

    return (
        "media-cloud-guard: Aufruf an bekannte Cloud-Media-API (%s) erkannt. LOCAL-FIRST-Regel: "
        "bild/video/tts/stt (~/.local/bin, offline-faehig) zuerst pruefen, Cloud nur wenn lokale "
        "Qualitaet nachweislich nicht reicht oder der Nutzer es verlangt. Reine Warnung, kein Block."
        % hit
    )


# ===========================================================================
# 5. bash-guard-commit-trailer.sh
# ===========================================================================
# Zweck: BLOCKT einen `git commit`, dessen Nachricht einen Claude-Co-Author-Trailer
#        oder eine Generated-with-Zeile traegt.
# Event: PreToolUse, matcher Bash.
# Warum: Stehende Regel (CLAUDE.md, Standing rules): Commits laufen auf dem
#        Git-Handle des Repo-Besitzers, englische Nachricht, nie ein Claude-
#        Co-Author-Trailer — sie ueberschreibt ausdruecklich die Voreinstellung
#        des Harness, der solche Trailer von sich aus anhaengt. Bis 2026-08-03
#        stand die Regel nur als
#        Prosa da: weder bash-guard-secrets noch push-gate-worker sehen sich die
#        Commit-NACHRICHT an, beide pruefen nur, OB committet wird.
#        Ein einmal gesetzter Trailer laesst sich nach dem Push nicht mehr still
#        entfernen — deshalb Deny statt Warnung.
# Grenze: Erkennt nur Nachrichten, die im Kommando stehen (-m/-F-Text). Ein
#        Commit ueber den Editor oder eine Datei sieht dieser Guard nicht; das
#        ist bewusst so, weil er sonst Dateien lesen muesste, die es zur
#        Pruefzeit noch gar nicht gibt.

COMMIT_TRAILER_MESSAGE = """git commit mit Claude-Trailer abgelehnt.
  Stehende Regel (CLAUDE.md, Standing rules): Commits laufen auf dem Git-Handle
  des Repo-Besitzers, die Nachricht ist englisch, und ein Claude-Co-Author-
  Trailer kommt NIE hinein — diese Regel ueberschreibt die Voreinstellung des
  Harness.
  Gefunden wurde eines von: "Co-Authored-By: Claude", "Generated with Claude Code",
  "noreply@anthropic.com", "Claude-Session: https...".
  Richtig: dieselbe Nachricht ohne Trailer-Zeilen committen.
  Nach dem Push laesst sich so ein Trailer nicht mehr still entfernen - deshalb
  wird hier abgelehnt statt gewarnt.
"""


def check_commit_trailer(command):
    if not command:
        return False
    # '(' und ')' stehen mit in der Zeichenklasse davor -- wortgleich zur
    # selben Zeile in bash-guard-commit-trailer.sh. Eine Unterschale ist ein
    # gueltiger Platz fuer einen Commit; bis 2026-08-05 liefen beide
    # protokollierten Trailer-Ablehnungen in der Form `(git commit …)` durch.
    if not re.search(r'(^|[;&|()\s])git(\s+-[^\s]+)*\s+commit(\s|$)', command, re.MULTILINE):
        return False
    if re.search(
        r'Co-Authored-By:\s*Claude|Generated with \[?Claude Code|noreply@anthropic\.com'
        r'|Claude-Session:\s*https', command, re.IGNORECASE
    ):
        return True
    return False


# ===========================================================================
# 9. Rueckfrage-Stufe -- die mittlere Stufe zwischen Block und Durchlauf
# ===========================================================================
# Die Logik (Musterliste, Bindung, Einloesen, Ablauf) steht in lib/ask_muster.py;
# hier bleibt nur, was zum Hook gehoert: Marker schreiben, Verlauf anhaengen,
# Text zurueckgeben. Reihenfolge und Begruendung siehe main(), Punkt 9.

def check_ask_muster(pane, command, cwd, session_id, wartender):
    """None = durchlassen. Sonst der Text der Rueckfrage (als deny gemeldet,
    weil dieser Hook nie in den Chat fragt -- die Frage stellt die
    Freigabe-Ansicht, hier landet nur eine Datei).

    `wartender` ist der Rueckfrage-Merker dieser Pane, der den vorigen Aufruf
    ueberlebt hat, sonst None.
    """
    muster_liste = ask_muster.lade_muster()
    ttl = ask_muster.lade_ttl()

    try:
        treffer = ask_muster.passendes_muster(command, muster_liste)
    except ask_muster.Unentscheidbar as u:
        # Dieselbe Haltung wie beim snapshot-Guard: wo keine Aussage moeglich
        # ist, wird gefragt statt geraten. Aber nur, wenn ueberhaupt eine
        # Musterliste in Kraft ist -- eine leere Liste heisst "Stufe aus", und
        # eine abgeschaltete Stufe darf auch hier nichts anhalten.
        if not muster_liste:
            return None
        treffer = {
            'befehl': '(unentscheidbar)',
            'grund': 'Die Befehlszeile war nicht zerlegbar: %s. Ob ein Muster darin steckt, '
                     'laesst sich nicht sagen -- deshalb wird gefragt statt geraten.' % u.was,
        }

    if not treffer:
        return None

    freigabe_bericht = []
    eingeloest = ask_muster.freigabe_einloesen(pane, cwd, command, bericht=freigabe_bericht)
    if eingeloest:
        # Frage beantwortet UND Befehl gelaufen -- damit ist der Merker
        # erledigt, auch wenn er den letzten Aufruf ueberlebt hat.
        drop_block(pane)
        append_block_log(
            pane, 'muster-durchlauf',
            "Freigegeben und verbraucht (%s, %s): %s" % (
                ask_muster.eintrag_label(treffer),
                '; '.join(freigabe_bericht) or 'ohne Vermerk',
                eingeloest.get('reason', '') or 'ohne Begruendung'),
            command, cwd, session_id)
        return None
    if freigabe_bericht:
        # Es LAG eine Freigabe da, sie zaehlte nur nicht. Das gehoert in den
        # Verlauf, sonst sucht ein Mensch den Fehler bei sich: er hat geklickt,
        # und es passierte nichts.
        append_block_log(pane, 'muster-freigabe-verworfen', '; '.join(freigabe_bericht),
                         command, cwd, session_id)

    # Liegt fuer DIESEN Pane schon eine gueltige, unverbrauchte Freigabe --
    # nur fuer einen ANDEREN Wortlaut? Genau das war der Vorfall vom
    # 2026-08-10: ein Mensch gab frei, das Werkzeug meldete Erfolg -- und die
    # Wiederholung wurde trotzdem wieder angehalten, weil der Agent den
    # Wortlaut zwischen zwei Versuchen selbst veraendert hatte. Bis dahin sah
    # dieser Fall genauso aus wie eine ganz frische Rueckfrage; ohne diese
    # Pruefung hatte der Agent keine Chance zu sehen, dass er selbst die
    # Ursache war (siehe ask_muster.wortlaut_hinweis).
    andere_wortlaut = ask_muster.freigabe_fuer_pane(pane, cwd, command) if pane else []
    if andere_wortlaut:
        reason = ask_muster.wortlaut_hinweis(andere_wortlaut[0], command)
        if len(andere_wortlaut) > 1:
            reason += ("\n  (Und %d weitere Freigabe(n) fuer diesen Pane, ebenfalls fuer "
                       "andere Wortlaute.)" % (len(andere_wortlaut) - 1))
        reason += "\n  Angehalten von bash-guard-muster."
        if wartender is None:
            note_block(pane, 'muster', reason, command, cwd, session_id, extra={
                'wartet': True,
                'muster': ask_muster.eintrag_label(treffer),
                'musterGrund': treffer.get('grund', ''),
                'schluessel': ask_muster.schluessel(pane, cwd, command),
                'expires_ts': ask_muster.ablauf_stempel(ttl),
            })
        append_block_log(pane, 'muster-anderer-wortlaut-freigabe',
                         "Freigabe liegt vor, aber fuer anderen Wortlaut (%s)" %
                         ask_muster.eintrag_label(treffer),
                         command, cwd, session_id)
        return reason

    # Eine zweite Rueckfrage, waehrend die erste noch wartet.
    #
    # GEMESSEN am echten Guard-Verlauf (407 Zeilen, 2026-08-05): 122-mal hat
    # dieselbe Pane binnen 300 s eine zweite Ablehnung mit einem ANDEREN Befehl
    # ausgeloest, im Median 1 s spaeter. Der Fall ist also nicht theoretisch,
    # sondern der Normalfall -- ein angehaltener Worker versucht als naechstes
    # etwas anderes.
    #
    # Es gilt: die AELTERE Frage gewinnt, die neue wird abgewiesen, ohne den
    # Merker anzufassen. Grund: eine Freigabe ist an den Befehl im Wortlaut
    # gebunden, und ein Mensch liest den Eintrag, bevor er klickt. Duerfte die
    # zweite Frage die erste ueberschreiben, taeusche der Eintrag zwischen
    # Lesen und Klicken den Befehl aus -- die Freigabe ginge dann an einen
    # Befehl, den niemand gelesen hat. Das ist der eine Fehler, den ein
    # Freigabeweg nicht haben darf.
    #
    # Die abgewiesene Fassung wird trotzdem protokolliert (guard
    # 'muster-anderer-wortlaut-wartend') -- NICHT als eigener Merker (die
    # aeltere Frage bleibt die einzige STEHENDE), aber als Eintrag im Verlauf,
    # aus dem `wb-freigabe erteilen` die offenen Wortlaute dieser Pane
    # zusammensucht und dem Menschen zur Wahl vorlegt, statt still einen zu
    # nehmen (Auftrag vom 2026-08-10, Punkt 1).
    if wartender is not None and wartender.get('command') != command:
        append_block_log(pane, 'muster-anderer-wortlaut-wartend',
                         "Neue Fassung waehrend eine andere Frage schon wartet (%s)" %
                         ask_muster.eintrag_label(treffer),
                         command, cwd, session_id)
        return (
            "RUECKFRAGE, keine Ablehnung -- und in diesem Pane wartet bereits eine ANDERE.\n"
            "  Wartende Frage: %s\n"
            "  Deine neue Fassung wurde vermerkt: ein Mensch kann in der Freigabe-Ansicht\n"
            "  (`wb-freigabe erteilen`) zwischen den offenen Wortlauten dieser Pane waehlen.\n"
            "  Solange die erste Frage offen ist, kommt keine zweite als STEHENDE Frage dazu:\n"
            "  die Freigabe haengt am Befehl im Wortlaut, und ein Eintrag, der sich zwischen\n"
            "  Lesen und Klicken aendert, waere eine Zustimmung zu etwas Ungelesenem.\n"
            "  Richtig: die offene Frage beantworten lassen (Freigabe-Ansicht, Abschnitt\n"
            "  \"Angehaltene Worker\"), dann weiterarbeiten -- nicht selbst weiter variieren.\n"
            "  Angehalten von bash-guard-muster."
            % (wartender.get('command', ''))
        )

    reason = ask_muster.deny_text(treffer, max(1, ttl // 60))
    if freigabe_bericht:
        # Der Fall, den es vor dem 07.08. nicht gab: eine Freigabe lag vor und
        # wurde verworfen. Wer das liest, muss beides erfahren -- dass sie da
        # war, und warum sie nicht zaehlte.
        reason += ("\n  HINWEIS zur vorliegenden Freigabe: %s\n"
                   "  Gueltig wird sie nur mit gemessener Herkunft: im Terminal\n"
                   "  `wb-freigabe erteilen %s <grund>` (ein Mensch am Terminal oder das\n"
                   "  Programmfenster -- beides wird gemessen, nicht geglaubt)."
                   % ('; '.join(freigabe_bericht), pane or '<pane>'))
    if not pane:
        # Ohne TMUX_PANE laesst sich kein Marker schreiben, den die Ansicht
        # zeigen koennte -- die Rueckfrage bliebe unbeantwortbar. Sie
        # trotzdem stillschweigend durchzulassen hiesse, die Stufe durch das
        # Loeschen einer Umgebungsvariablen abschaltbar zu machen. Also:
        # anhalten und ehrlich sagen, warum hier niemand zustimmen kann.
        reason += ("\n  ACHTUNG: keine Pane-Kennung (TMUX_PANE) -- dieser Aufruf kann in der "
                   "Ansicht nicht angezeigt und deshalb hier nicht freigegeben werden. Aus "
                   "einem Workbench-Pane heraus wiederholen.")
    if wartender is None:
        # Nur wenn keine Frage haengt. Steht dieselbe Frage schon da, bleibt
        # der bestehende Merker unveraendert -- sonst schoebe ein Worker, der
        # es immer wieder versucht, den Ablauf seiner eigenen Frage endlos vor
        # sich her.
        note_block(pane, 'muster', reason, command, cwd, session_id, extra={
            'wartet': True,
            'muster': ask_muster.eintrag_label(treffer),
            'musterGrund': treffer.get('grund', ''),
            'schluessel': ask_muster.schluessel(pane, cwd, command),
            'expires_ts': ask_muster.ablauf_stempel(ttl),
        })
        append_block_log(pane, 'muster',
                         "Rueckfrage (%s): %s" % (ask_muster.eintrag_label(treffer),
                                                  treffer.get('grund', '')),
                         command, cwd, session_id)
    return reason


# ===========================================================================
# Orchestrierung -- Reihenfolge identisch zur bisherigen settings.json-Liste.
# ===========================================================================

def main():
    try:
        input_text = sys.stdin.read()
    except Exception:
        return 0
    try:
        data = json.loads(input_text)
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0

    tool_input = data.get('tool_input') or {}
    if not isinstance(tool_input, dict):
        tool_input = {}
    command = tool_input.get('command')
    if not isinstance(command, str):
        command = ''
    cwd = data.get('cwd')
    if not isinstance(cwd, str):
        cwd = ''
    pane = os.environ.get('TMUX_PANE', '')
    # Erstsicht: die Rolle dieses Panes einmal je Pane-Leben festhalten (siehe
    # lib/rollen.py). Sie steht hier ganz vorn, VOR jeder Guard-Entscheidung --
    # der erste Bash-Aufruf eines Panes ist der frueheste Zeitpunkt, zu dem ein
    # Agent ueberhaupt etwas tun koennte, und dieser Lauf kommt ihm zuvor.
    # Kostet im Normalfall einen Verzeichnisblick; tmux wird nur gefragt,
    # solange noch kein gueltiger Eintrag da ist.
    try:
        rollen.erstsicht(pane)
    except Exception:
        pass
    session_id = data.get('session_id')
    if not isinstance(session_id, str):
        session_id = ''
    # Ein neuer Versuch aus derselben Pane -- der Marker einer frueheren
    # Ablehnung gilt erst wieder, wenn DIESER Versuch ebenfalls abgelehnt wird.
    # Eine noch gueltige RUECKFRAGE ueberlebt das dagegen: sie ist erst
    # erledigt, wenn ein Mensch entschieden hat oder sie abgelaufen ist.
    wartender = clear_block(pane)

    # Der Zustand der Schalter wird EINMAL gelesen und die Pane-Rolle hoechstens
    # einmal ermittelt: `get_pane_role()` ruft tmux, und das darf nicht vor jedem
    # einzelnen Guard passieren. Ohne einen abgeschalteten Guard mit Rollenbezug
    # wird tmux gar nicht erst gefragt -- der Normalfall (alles an) kostet damit
    # genau einen Dateizugriff mehr als vorher.
    guards = guard_settings()
    _rolle = [None]

    def rolle():
        if _rolle[0] is None:
            _rolle[0] = get_pane_role()
        return _rolle[0]

    if any(isinstance(guards.get(g), dict) and guards[g].get('aus') is True
           for g in GUARD_NAMES):
        rolle()
    abschaltung_vermerken(guards, _rolle[0] or '')

    warn_msgs = []

    def abgeschaltet(name, reason):
        """True, wenn dieser Guard gerade nicht greift. Sammelt dann die
        Warnung, die an seine Stelle tritt. Aufgerufen wird das ERST, wenn ein
        Guard tatsaechlich ablehnen wuerde -- die Pruefung selbst laeuft
        unveraendert weiter, sonst waere nicht mehr zu sagen, was fehlt."""
        e = guard_aus(guards, name, rolle())
        if e is None:
            return False
        warn_msgs.append(abschaltungs_warnung(name, e, reason))
        return True

    def merken(guard, reason):
        """Marker einer harten Ablehnung -- aber nie ueber eine wartende
        Rueckfrage hinweg. Die Rueckfrage ist das einzige, was in der Ansicht
        eine Entscheidung verlangt; eine harte Ablehnung traegt dort keine
        Knoepfe und steht ohnehin im Verlauf. Wuerde sie die Frage
        ueberschreiben, waere genau der Befund vom 05.08. wieder da, nur mit
        einem anderen Ausloeser."""
        if wartender is not None:
            return
        note_block(pane, guard, reason, command, cwd, session_id)

    # 1. secrets
    reason = check_secrets(command, cwd)
    if reason and not abgeschaltet('secrets', reason):
        merken('secrets', reason)
        append_block_log(pane, 'secrets', reason, command, cwd, session_id)
        print_deny(reason)
        return 0

    # 1b. git-add -- direkt hinter secrets: beide sehen sich `git add` an, und
    #     ein Fall, den secrets schon ablehnt (z.B. `git add -A` mit einem
    #     .env im Working Tree), ist damit laengst weg, bevor dieser Guard
    #     ueberhaupt drankommt.
    reason = check_git_add(command, cwd)
    if reason and not abgeschaltet('git-add', reason):
        merken('git-add', reason)
        append_block_log(pane, 'git-add', reason, command, cwd, session_id)
        print_deny(reason)
        return 0

    # 2. kill-pattern (lib, importiert)
    #    Ein abgeschalteter Guard verschluckt nur seine ABLEHNUNG. Was das
    #    lib-Modul sonst ausgibt (Warnung, Rueckfrage), geht unveraendert durch --
    #    abschalten heisst "lehnt nicht mehr ab", nicht "sagt nichts mehr".
    kp_out = with_stdin(input_text, kill_pattern_classify.main)
    if kp_out.strip():
        kp_reason = _deny_reason_if_any(kp_out)
        if kp_reason is not None and abgeschaltet('kill-pattern', kp_reason):
            kp_out = ''
        elif kp_reason is not None:
            merken('kill-pattern', kp_reason)
            append_block_log(pane, 'kill-pattern', kp_reason, command, cwd, session_id)
        if kp_out.strip():
            sys.stdout.write(kp_out)
            return 0

    # 3. live-config (Bash-Zweig) -- warnt nur, stoppt die Kette nicht.
    lc_warn = check_live_config_bash(command, cwd)
    if lc_warn and not abgeschaltet('live-config', lc_warn):
        warn_msgs.append(lc_warn)

    # 3b. pane-write -- lehnt ab. Steht direkt hinter live-config, weil beide
    #     dieselbe Familie von Befehlen ansehen: die Warnung dort erklaert den
    #     Testfall, die Ablehnung hier zieht die Grenze.
    pw_reason = check_pane_write_bash(command)
    if pw_reason and not abgeschaltet('pane-write', pw_reason):
        merken('pane-write', pw_reason)
        append_block_log(pane, 'pane-write', pw_reason, command, cwd, session_id)
        print_deny(pw_reason)
        return 0

    # 3c/3d. rolle und freigabe-pfad -- beide ohne Schalter (Begruendung oben).
    #        Sie stehen VOR dem Push-Gate, weil sie dessen Grundlage schuetzen:
    #        wer die Rollenquelle umschreiben darf, hat das Push-Verbot schon
    #        beantwortet, bevor es gefragt wird.
    for name, reason in (('rolle', check_rollen_option(command)),
                         ('freigabe-pfad', check_freigabe_pfad(command))):
        if reason:
            merken(name, reason)
            append_block_log(pane, name, reason, command, cwd, session_id)
            print_deny(reason)
            return 0

    # 4. push-gate-worker (lib, importiert, + Rollen-Check)
    pg_out = with_stdin(input_text, push_gate_classify.main).strip()
    if pg_out == '1':
        ist_worker, warum = ist_worker_pane()
        if ist_worker and not abgeschaltet('push-gate', PUSH_GATE_REASON):
            reason = '%s (%s)' % (PUSH_GATE_REASON, warum)
            merken('push-gate', reason)
            append_block_log(pane, 'push-gate', reason, command, cwd, session_id)
            print_deny(reason)
            return 0

    # 5. media-cloud-guard (Bash-Zweig) -- warnt nur.
    mc_warn = check_media_cloud_bash(command)
    if mc_warn and not abgeschaltet('media-cloud', mc_warn):
        warn_msgs.append(mc_warn)

    # 6. screencapture (lib, importiert)
    sc_out = with_stdin(input_text, screencapture_classify.main)
    if sc_out.strip():
        sc_reason = _deny_reason_if_any(sc_out)
        if sc_reason is not None and abgeschaltet('screencapture', sc_reason):
            sc_out = ''
        elif sc_reason is not None:
            merken('screencapture', sc_reason)
            append_block_log(pane, 'screencapture', sc_reason, command, cwd, session_id)
        if sc_out.strip():
            sys.stdout.write(sc_out)
            return 0

    # 7. snapshot (lib, importiert)
    sn_out = with_stdin(input_text, snapshot_classify.main)
    if sn_out.strip():
        sn_reason = _deny_reason_if_any(sn_out)
        if sn_reason is not None and abgeschaltet('snapshot', sn_reason):
            sn_out = ''
        elif sn_reason is not None:
            merken('snapshot', sn_reason)
            append_block_log(pane, 'snapshot', sn_reason, command, cwd, session_id)
        if sn_out.strip():
            sys.stdout.write(sn_out)
            return 0

    # 8. commit-trailer -- einziger Guard mit exit(2)+stderr statt JSON-deny,
    #    exakt wie im Original.
    if check_commit_trailer(command) and not abgeschaltet('commit-trailer',
                                                          COMMIT_TRAILER_MESSAGE):
        merken('commit-trailer', COMMIT_TRAILER_MESSAGE)
        append_block_log(pane, 'commit-trailer', COMMIT_TRAILER_MESSAGE, command, cwd, session_id)
        sys.stderr.write(COMMIT_TRAILER_MESSAGE)
        return 2

    # 9. Rueckfrage-Stufe (Muster-Erkennung riskanter Befehle).
    #    Steht mit Absicht GANZ UNTEN: alles, was die acht Guards oben hart
    #    ablehnen, ist hier laengst weg. Diese Stufe kann deshalb keine
    #    bestehende Ablehnung aufweichen, nur etwas anhalten, das heute
    #    durchlaeuft. Und eine Freigabe wird ERST HIER gelesen -- sie ist nie
    #    ein Weg an einem der acht Guards vorbei.
    reason = check_ask_muster(pane, command, cwd, session_id, wartender)
    if reason and not abgeschaltet('muster', reason):
        print_deny(reason)
        return 0

    if warn_msgs:
        print_warn('\n\n'.join(warn_msgs))
    return 0


if __name__ == '__main__':
    sys.exit(main())
