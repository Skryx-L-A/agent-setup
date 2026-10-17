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
import script_guard            # noqa: E402  (lokale Skripte, die ein Befehl startet)
try:
    import geheimnis_inhalt    # noqa: E402  (Inhaltspruefung der Secrets-Stufe)
except ImportError:            # lib/ nur teilweise ausgerollt: die Stufe verweigert dann (fail-closed)
    geheimnis_inhalt = None
try:
    import guard_log           # noqa: E402  (Ablehnungsverlauf mit Monatsrotation)
except ImportError:            # lib/ nur teilweise ausgerollt: der Hook darf daran nie sterben
    guard_log = None


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
            # DER VOLLE WORTLAUT, nie gekuerzt (05.09.2026, Befund: "ich habe
            # gerade eine anfrage oben fuer eine erlaubnis freigegeben, sie ist
            # aber noch da"). Bis dahin stand hier [:2000], der Schluessel in
            # `extra` aber ueber den vollen Befehl. Erteilt wurde damit, was im
            # Marker stand -- der gekuerzte Wortlaut --, und die Wiederholung des
            # Workers fand keine passende Freigabe, wurde erneut angehalten und
            # stand als derselbe Eintrag wieder in der Leiste. Ein Marker, der
            # einen Schluessel traegt, muss genau das tragen, worueber er
            # gebildet wurde. Gekuerzt wird beim ANZEIGEN (wb-freigabe kuerzen()).
            'command': command or '',
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
    if not reason or script_guard.PROBING[0] or _RUMPF[0]:
        return
    try:
        pfad = _guard_log_path()
        eintrag = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'guard': guard,
            'reason': reason,
            # Ungekuerzt, aus demselben Grund wie in note_block: wb-freigabe liest
            # aus diesem Verlauf die weiteren Wortlaute einer wartenden Pane
            # ('muster-anderer-wortlaut-wartend') und erteilt sie woertlich.
            'command': command or '',
            'cwd': cwd or '',
            'session_id': session_id or '',
            'pane': pane or '',
        }
        # Anhaengen UND Monatsrotation (hooks/lib/guard_log.py): die aktive Datei haelt
        # nur den aktuellen Monat, aeltere liegen als guard-blocks.YYYY-MM.log.gz daneben.
        if guard_log is not None:
            guard_log.anhaengen(pfad, json.dumps(eintrag))
        else:
            d = os.path.dirname(pfad)
            if d:
                os.makedirs(d, exist_ok=True)
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
#        Secret-Dateimuster ausserhalb ~/Knowledge/secrets/ einschliessen.
# Event: PreToolUse, matcher Bash.
# Warum: CLAUDE.md sagt "Never commit a .env (or any secret) to GitHub" und
#        "Secrets knowledge goes only into secrets/" — bisher reine Prosa-
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

    Ebenso die Trenner ';', '&' und '|' (2026-10-09): sie werden zu eigenen
    Woertern, damit `true&&git add -A` dasselbe Wort `git` zeigt wie
    `true && git add -A` und GIT_ADD_SEPARATORS die Argumentliste dort
    abschneidet. Vorher war `true&&git` ein Wort, und weder git-add noch
    secrets sah einen git-Aufruf. `&&` wird dabei zu zwei Woertern '&', beide
    sind Trenner; `2>&1` zu `2>`, '&', `1` -- nach einem `git add` endet die
    Argumentliste damit an der Umleitung statt sie mitzunehmen.
    """
    return re.sub(r'([;&|])', r' \1 ', text.replace('(', ' ').replace(')', ' ')).split()


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
    if re.search(r'(^|/)secrets/', p):
        return False
    if is_allowed_env_suffix(p):
        return False
    if re.search(r'(^|/)\.env($|\.[A-Za-z0-9_-]+$)', p):
        return True
    # `*.env` (prod.env, docker.env, ...): der Dateiname ENDET auf `.env`. Seit 2026-10-09;
    # vorher fiel `git commit -am` mit geaendertem `prod.env` durch. Ohne Gross/Klein-
    # Unterschied, weil das Dateisystem hier keinen macht (`PROD.ENV` ist `prod.env`).
    if re.search(r'\.env$', p, re.IGNORECASE):
        return True
    if re.search(
        r'(^|/)(id_rsa|id_ed25519|id_ecdsa)$|\.(pem|p12|pfx)$|(^|/)credentials\.json$'
        r'|(^|/)service-account.*\.json$|(^|/)secrets\.ya?ml$', p, re.IGNORECASE
    ):
        return True
    return False


# Obergrenze je unversioniertem Verzeichnis (Dateien darueber werden nicht gesehen).
_UNVERSIONIERT_MAX = 5000


def _status_eintraege_z(repo_dir):
    """[(XY, wurzel-relativer Pfad)] aus `git status --porcelain -z` (bei Umbenennung das
    Ziel). Anders als die Textform ohne Anfuehrungszeichen um Pfade mit Leerzeichen oder
    Sonderzeichen -- sonst blieben solche Dateien fuer Pfad- und Inhaltspruefung
    unsichtbar. Unversionierte Verzeichnisse stehen als 'ordner/'. None bei Fehler."""
    out = run_git(['-C', repo_dir, 'status', '--porcelain', '-z'])
    if out is None:
        return None
    teile = out.split('\0')
    eintraege = []
    i = 0
    while i < len(teile):
        eintrag = teile[i]
        i += 1
        if len(eintrag) < 4:
            continue
        xy, pfad = eintrag[:2], eintrag[3:]
        if xy[0] in 'RC' or xy[1] in 'RC':
            i += 1  # der Ursprungspfad folgt als eigener Eintrag
        eintraege.append((xy, pfad))
    return eintraege


def _unversioniert_aufloesen(repo_dir, eintraege):
    """Unversionierte Verzeichnisse ('?? ordner/') durch ihre Dateien ersetzen: status nennt
    nur das Verzeichnis, ein Schluessel oder eine .env darin bliebe ungesehen (auch in der
    alten Kette). .gitignore gilt weiter; Obergrenze je Verzeichnis, damit ein riesiger
    unversionierter Baum den Hook nicht lahmlegt."""
    out = []
    for xy, pfad in eintraege:
        if xy == '??' and pfad.endswith('/'):
            drin = run_git(['-C', repo_dir, 'ls-files', '--others', '--exclude-standard',
                            '-z', '--', pfad])
            if drin is None:
                out.append((xy, pfad))
            else:
                out.extend([(xy, d) for d in drin.split('\0') if d][:_UNVERSIONIERT_MAX])
        else:
            out.append((xy, pfad))
    return out


_COMMIT_MIT_WERT = frozenset(('-m', '-F', '-C', '-c', '-t', '--message', '--file', '--author',
                              '--date', '--template', '--reuse-message', '--reedit-message',
                              '--fixup', '--squash', '--cleanup', '--trailer'))


def _unquote(tok):
    tok = tok.strip()
    for q in ('"', "'"):
        if tok.endswith(q):
            tok = tok[:-1]
        if tok.startswith(q):
            tok = tok[1:]
    return tok


def _dynamisch(tok):
    """Ein Wort, dessen Ziel erst die Shell festlegt (Variable, Substitution, Muster)."""
    return bool(re.search(r'[$`*?\[{\\~]', tok)) or tok.startswith(':(')


def _commit_info(args):
    """(alle_tracked, pfade) aus der Argumentliste eines `git commit`: -a/--all, und die
    Pfadangaben, die einen Commit auf diese Dateien beschraenken."""
    alle = False
    pfade = []
    i = 0
    while i < len(args):
        t = args[i]
        i += 1
        if t == '--':
            pfade.extend(args[i:])
            break
        if t.startswith('--'):
            if t == '--all':
                alle = True
            elif t in _COMMIT_MIT_WERT:
                i += 1
            continue
        if t.startswith('-') and len(t) > 1:
            for k, ch in enumerate(t[1:], 1):
                if ch == 'a':
                    alle = True
                elif ch in 'mFCct':
                    if k == len(t) - 1:
                        i += 1  # Wert steht im naechsten Wort
                    break
            continue
        pfade.append(t)
    return alle, pfade


def _merge_uebernommen(repo_dir, index_pfade):
    """Pfade, die ein laufender Merge unveraendert aus veroeffentlichtem Stand uebernimmt --
    seit 2026-10-09 in lib/geheimnis_inhalt.merge_uebernommen (gemeinsam mit dem
    Git-Hook-Verteiler); Beschreibung dort. Fehlt die Lib, ist die Menge leer -- die
    Inhaltspruefung verweigert dann ohnehin (fail-closed, _inhalt_pruefen). Eine aeltere Lib
    ohne die Funktion (Teilausrollung): ebenfalls leer, also keine Ausnahme -- nie weniger scannen."""
    funktion = getattr(geheimnis_inhalt, 'merge_uebernommen', None)
    if funktion is None:
        return set()
    return funktion(repo_dir, index_pfade, run_git)


def _staging_kandidaten(command, repo_dir, top, eintraege):
    """Die Dateien, die dieser Befehl tatsaechlich staged bzw. committet -- Grundlage der
    Inhaltspruefung (und der Pfadpruefung fuer reine Commits). Wurzel-relative Pfade.
      - breites `git add` (-A, ., :/, *, -u ohne Pfad) oder ein Wort, das erst die Shell
        aufloest (Variable, Substitution, Muster): alle Eintraege des Arbeitsbaums
      - `git add a b`: genau diese Dateien; ein Verzeichnis: alles darunter; ein Pfad, den es
        nicht gibt und der auch nicht als geloescht im Status steht: nicht aufloesbar, dann
        ebenfalls alle (fail-closed)
      - `git commit -a`: alle versionierten Aenderungen
      - `git commit` (jede Form): der Index (`git diff --cached --name-only -z`)
      - `git commit <pfad>`: diese Dateien
    Ein einzelnes `git add ok.py` zieht damit eine unversionierte config.py daneben NICHT mehr
    in die Inhaltspruefung (Fehlalarm, gemessen 2026-10-09).
    Rueckgabe (kand, scan): kand = alle Pfade des Befehls (Pfadpruefung), scan = die Teilmenge
    fuer die Inhaltspruefung. Bei einem Merge faellt aus scan, was der Index unveraendert aus
    veroeffentlichtem Stand uebernimmt (_merge_uebernommen) UND nicht aus dem Arbeitsbaum
    committet wird (`commit -a`/`commit <pfad>` mit abweichendem Arbeitsbaum, `git add`)."""
    alle = _unversioniert_aufloesen(repo_dir, eintraege)
    kand = []
    scan = []
    merge_frei = set()
    arbeitsbaum_abw = []  # [Menge] -- erst beim ersten Bedarf gelesen; None = nicht lesbar

    def dazu(pfad, scannen=True):
        if not pfad:
            return
        if pfad not in kand:
            kand.append(pfad)
        if scannen and pfad not in scan:
            scan.append(pfad)

    def dazu_arbeitsbaum(pfad):
        """Wird aus dem ARBEITSBAUM committet (-a, <pfad>): ein Merge-Pfad bleibt nur frei,
        solange der Arbeitsbaum dem Index entspricht."""
        if pfad in merge_frei:
            if not arbeitsbaum_abw:
                d = run_git(['-C', repo_dir, 'diff', '--name-only', '-z'])
                arbeitsbaum_abw.append(None if d is None else set(d.split('\0')))
            if arbeitsbaum_abw[0] is not None and pfad not in arbeitsbaum_abw[0]:
                dazu(pfad, False)
                return
        dazu(pfad)

    def alles():
        for _xy, p in alle:
            dazu(p)

    def pfadangabe(a, streng):
        """streng: nicht aufloesbar => alles (add); sonst nur ueberspringen (commit-Pfade)."""
        ziel = dazu if streng else dazu_arbeitsbaum
        a = _unquote(a)
        if not a or a.startswith('-'):
            return
        if _dynamisch(a):
            if streng:
                alles()
            return
        ab = a if os.path.isabs(a) else os.path.join(repo_dir, a)
        try:
            rel = os.path.relpath(os.path.realpath(ab), os.path.realpath(top))
        except ValueError:
            rel = None
        if rel is None or rel.startswith('..'):
            if streng:
                alles()
            return
        if os.path.isdir(ab):
            if rel == '.':
                alles()
                return
            for _xy, p in alle:
                if p == rel or p.startswith(rel.rstrip('/') + '/'):
                    ziel(p)
        elif os.path.isfile(ab):
            ziel(rel)
        elif any(p == rel for _xy, p in alle):
            ziel(rel)  # geloescht oder umbenannt: der Status kennt den Pfad
        elif streng:
            alles()

    for args in _git_arg_lists(command, 'add'):
        if (any(x in ('-A', '--all', '--no-ignore-removal') for x in args)
                or (any(x in ('-u', '--update') for x in args)
                    and not any(x and not x.startswith('-') for x in args))
                or any(_unquote(x) in ('.', '*') or _unquote(x).startswith(':/') for x in args)):
            alles()
            continue
        for a in args:
            pfadangabe(a, True)

    commits = _git_arg_lists(command, 'commit')
    if commits:
        index = run_git(['-C', repo_dir, 'diff', '--cached', '--name-only', '-z'])
        if index is None:
            alles()  # Index nicht lesbar: nicht raten
        else:
            index_pfade = [p for p in index.split('\0') if p]
            merge_frei = _merge_uebernommen(repo_dir, index_pfade)
            for p in index_pfade:
                dazu(p, p not in merge_frei)
    for args in commits:
        mit_a, pfade = _commit_info(args)
        if mit_a:
            for xy, p in alle:
                if xy != '??':
                    dazu_arbeitsbaum(p)
        for a in pfade:
            pfadangabe(a, False)
    return kand, scan


def _inhalt_pruefen(kandidaten, repo_dir, git_nutzbar):
    """Inhaltspruefung (Abschnitt 3 des Originals) fuer (relativ, absolut)-Paare.
    -> Ablehnungstext oder None. Fail-closed: ein Fehler im Scanner selbst oder
    eine nicht lesbare Datei ist KEIN sauberer Befund."""
    if geheimnis_inhalt is None:
        return (
            "git add/commit (Repo: %s): die Inhaltspruefung auf Secrets ist nicht verfuegbar "
            "(lib/geheimnis_inhalt.py fehlt). Fail-closed: Commit wird verweigert, bis die Datei "
            "ausgerollt ist. Blockiert von bash-guard-secrets." % repo_dir
        )
    voll, generisch = geheimnis_inhalt.load_exceptions(HOOKS_DIR)
    paare = [(rel, ab) for rel, ab in kandidaten
             if os.path.isfile(ab) and not geheimnis_inhalt.is_exempt(rel, voll)]
    if not paare:
        return None
    zusatz = '' if git_nutzbar else ', git unbenutzbar'
    try:
        fund, fehler = geheimnis_inhalt.scan_paths(paare, generisch,
                                                       geheimnis_inhalt.load_public_values(HOOKS_DIR))
    except Exception as e:
        return (
            "git add/commit (Repo: %s%s): die Inhaltspruefung auf Secrets konnte nicht "
            "ausgefuehrt werden (%s). Fail-closed: Commit wird verweigert, bis das Werkzeug "
            "wieder verfuegbar ist. Blockiert von bash-guard-secrets." % (repo_dir, zusatz, e)
        )
    if fehler is not None:
        return (
            "git add/commit (Repo: %s%s): eine Datei im Staging konnte nicht auf Secrets "
            "geprueft werden (%s). Fail-closed: Commit wird verweigert. "
            "Blockiert von bash-guard-secrets." % (repo_dir, zusatz, fehler)
        )
    if fund is not None:
        if git_nutzbar:
            return (
                "git add/commit (Repo: %s) wuerde eine Datei mit einem wahrscheinlichen Secret "
                "im INHALT einschliessen: %s. Blockiert von bash-guard-secrets "
                "(Inhaltspruefung)." % (repo_dir, fund)
            )
        return (
            "git add/commit nennt eine Datei mit einem wahrscheinlichen Secret im INHALT: %s. "
            "(git war hier nicht benutzbar, best-effort Pruefung ausserhalb der Staging-Liste.) "
            "Blockiert von bash-guard-secrets." % fund
        )
    return None


# Befehle, die Index oder HEAD VERAENDERN und damit Inhalt in einen Commit bringen, den der
# Hook-Lauf (PreToolUse, vor der Ausfuehrung) noch nicht sieht: kein MERGE_HEAD, ein Index ohne
# den kommenden Inhalt -- `git merge --no-commit X && git commit` brachte so ungeprueft alles
# aus X durch (guard-merge, 09.10.). Steht so ein Befehl VOR einem `git commit` im selben Aufruf,
# prueft der Inhaltsscan nichts Verwertbares: fail-closed ablehnen, in zwei Aufrufe trennen.
_INDEX_VERAENDERER = frozenset((
    'merge', 'pull', 'cherry-pick', 'revert', 'am', 'rebase', 'read-tree', 'update-index',
    'update-ref',
))
# Ihr "Aufraeumen" ist harmlos: bringt keinen neuen Inhalt in Index oder HEAD.
_ABBRUCH_OPTIONEN = frozenset(('--abort', '--quit'))


def _index_veraendernd(sub, args):
    """Grund (Text) oder None: veraendert `git <sub> <args>` Index/HEAD so, dass ein folgender
    Commit Inhalt traegt, den der Hook nicht sah? Die Mengen oben gelten ohne Ansehen der
    Argumente; checkout/restore/reset/apply/stash nur in den Formen, die Inhalt von woanders
    holen (Revision, Quelle, Patch, Stash). Nicht aufloesbar (dynamisches Wort) heisst: ja."""
    if _dynamisch(sub):
        return "git %s (Unterbefehl erst zur Laufzeit bekannt)" % sub
    if sub in _INDEX_VERAENDERER:
        if sub in ('merge', 'pull', 'cherry-pick', 'revert', 'am', 'rebase') \
                and any(a in _ABBRUCH_OPTIONEN for a in args):
            return None
        return "git %s" % sub
    mit_optionen = [a for a in args if a != '--']
    vor_trenner = args[:args.index('--')] if '--' in args else args
    revisionen = [a for a in vor_trenner if a and not a.startswith('-')]
    if sub == 'reset':
        # Entstagen (`reset`, `reset HEAD f`, `reset -- f`) holt nichts; jede andere Revision
        # (`--soft HEAD~1`, `abc123 -- f`) verschiebt HEAD oder holt Inhalt in den Index.
        # Ohne `--` ist nur das ERSTE Wort eine Revision, der Rest sind Pfade; ein erstes
        # Wort, das ein Pfad sein koennte (`reset datei`), ist nicht zu unterscheiden -- ablehnen.
        if revisionen[:1] and revisionen[0] not in ('HEAD', '@'):
            return "git reset auf eine andere Revision"
    elif sub == 'checkout':
        # `checkout <rev> -- <pfad>` holt Inhalt aus <rev> in den Index. Branchwechsel und
        # `checkout -- <pfad>` (aus dem Index) nicht.
        if '--' in args and revisionen and not any(
                a in ('-b', '-B', '--orphan') for a in vor_trenner):
            return "git checkout <Revision> -- <Pfad>"
        if any(a in ('-p', '--patch') for a in args):
            return "git checkout --patch"
    elif sub == 'restore':
        if any(a in ('-s', '--source') or a.startswith('--source=') for a in args):
            return "git restore --source"
        if any(a in ('-p', '--patch') for a in args) and any(
                a in ('-S', '--staged') for a in args):
            return "git restore --staged --patch"
    elif sub == 'apply':
        if any(a in ('--index', '--cached', '-3', '--3way') for a in mit_optionen):
            return "git apply --index/--cached"
    elif sub == 'stash':
        if revisionen and revisionen[0] in ('pop', 'apply', 'branch'):
            return "git stash %s" % revisionen[0]
    return None


def _index_vor_commit(command):
    """Ablehnungstext, wenn vor einem `git commit` dieses Aufrufs ein Befehl steht, der Index
    oder HEAD veraendert (siehe _INDEX_VERAENDERER). Reihenfolge wie im Text (Zeile fuer Zeile,
    je Zeile von links); `git add a && git commit` bleibt unberuehrt -- den Add-Weg prueft
    _staging_kandidaten."""
    erstes = None
    for zeile in command.splitlines():
        toks = _split_on_parens(zeile)
        n = len(toks)
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
                elif t.startswith('-'):
                    j += 1
                else:
                    break
            if j >= n:
                break
            sub = toks[j]
            k = j + 1
            args = []
            while k < n and toks[k] not in GIT_ADD_SEPARATORS:
                args.append(_unquote(toks[k]))
                k += 1
            if sub == 'commit':
                if erstes:
                    return erstes
            elif erstes is None:
                erstes = _index_veraendernd(sub, args)
            i = k
    return None


def check_secrets(command, cwd):
    if not command:
        return None

    gate1_found, _ = find_git_invocation(command, ('add', 'commit'))
    if not gate1_found:
        return None

    add_found, _ = find_git_invocation(command, ('add',))
    commit_found, _ = find_git_invocation(command, ('commit',))
    if commit_found:
        # Vor dem Add-/Pfadweg: ein Commit nach merge/pull/rebase/... hat zur Pruefzeit weder
        # den Index noch das MERGE_HEAD, die der Scan braeuchte.
        vorher = _index_vor_commit(command)
        if vorher:
            return (
                "%s steht in diesem Aufruf VOR einem git commit. Der Hook laeuft vor der "
                "Ausfuehrung: Index und HEAD haben dann noch nicht den Inhalt, den der Commit "
                "tragen wird, der Inhaltsscan pruefte nichts. In zwei Aufrufe trennen; der Commit "
                "wird dann gegen den tatsaechlichen Index geprueft. Blockiert von "
                "bash-guard-secrets." % vorher
            )
    commit_dash_a = bool(re.search(r'commit\s+-a(m|\s|$)', command, re.MULTILINE))
    if not (add_found or commit_found or commit_dash_a):
        return None

    _found2, dirhint = find_git_invocation(command, ('add', 'commit'))
    repo_dir = dirhint or cwd or os.getcwd()

    if run_git(['-C', repo_dir, 'rev-parse', '--show-toplevel']) is not None:
        top = (run_git(['-C', repo_dir, 'rev-parse', '--show-toplevel']) or '').strip()
        eintraege = _status_eintraege_z(repo_dir)
        if eintraege is None:
            # -z faellt aus: Textform wie bisher
            status = run_git(['-C', repo_dir, 'status', '--porcelain']) or ''
            eintraege = []
            for line in status.splitlines():
                path = re.sub(r'^.{2} ', '', line, count=1)
                path = re.sub(r'.* -> ', '', path)
                eintraege.append((line[:2], path))
        kandidaten, zu_scannen = _staging_kandidaten(command, repo_dir, top, eintraege)
        # PFADPRUEFUNG. Wie im Original ueber den ganzen Status, sobald ein `git add` oder
        # `commit -a` im Spiel ist: die Namen im Kommando lassen sich beliebig umquoten
        # (Stresstest B10), der tatsaechliche Arbeitsbaum nicht. Das ist absichtlich weiter
        # als die Inhaltspruefung -- eine `.env` irgendwo im Baum haelt jedes `git add`
        # an, wie vor dieser Aenderung. Reine Commits (ohne -a) pruefen nur den Index.
        pfade = list(kandidaten)
        if add_found or commit_dash_a or any(
                _commit_info(a)[0] for a in _git_arg_lists(command, 'commit')):
            pfade = [p for _xy, p in eintraege] + pfade
        for path in pfade:
            if not path:
                continue
            if is_secret_path(path):
                return (
                    "git add/commit (breites Staging, Repo: %s) wuerde eine Secret-/.env-Datei "
                    "einschliessen (%s) ausserhalb secrets/. Blockiert von bash-guard-secrets."
                    % (repo_dir, path)
                )
        # Abschnitt 3 (Inhalt): NUR die Dateien, die der Befehl wirklich staged oder
        # committet. Seit 2026-10-09 auch hier -- bis dahin lag das nur in der
        # stillgelegten bash-guard-secrets.sh, ein Schluessel in config.py ging durch.
        grund = _inhalt_pruefen([(d, os.path.join(top, d)) for d in zu_scannen if d],
                                repo_dir, True)
        if grund:
            return grund
        return None
    else:
        # git nicht benutzbar (fehlt im PATH, kein Repo): frueher endete der Hook hier
        # still auf "erlauben" — gemessen im Stresstest mit gestripptem PATH. Ein
        # Deny-Hook, der seine Pruefung nicht durchfuehren kann, darf nicht so tun, als
        # waere alles in Ordnung. Die Namen im Kommando selbst kann er trotzdem pruefen;
        # bleibt danach Unsicherheit, wird sie WENIGSTENS sichtbar gemacht.
        # Klammern auch hier als Wortgrenze -- sonst hiesse der Pfad in
        # `(git add .env)` ".env)" und kein Secret-Muster traefe darauf.
        kandidaten = []
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
                    "secrets/ aus. (git war hier nicht benutzbar, geprueft wurde deshalb nur der "
                    "Kommandotext.) Blockiert von bash-guard-secrets." % stripped
                )
            kandidaten.append((stripped, os.path.join(repo_dir, stripped)))
        grund = _inhalt_pruefen(kandidaten, repo_dir, False)
        if grund:
            return grund
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


def _git_arg_lists(command, sub):
    """Fuer jedes `git <sub>`-Vorkommen (add oder commit) im (parens-getrennten) Kommando: die Liste
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
        out.extend(_git_arg_lists_einzeilig(zeile, sub))
    return out


def _git_add_arg_lists(command):
    return _git_arg_lists(command, 'add')


def _git_arg_lists_einzeilig(command, sub):
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
        if j < n and toks[j] == sub:
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
    # -u ohne Pfad nimmt jede Aenderung an verfolgten Dateien im ganzen Repo
    # mit (seit git 2.0), also auch fremde -- mit Pfad bleibt es eng.
    if (any(a in ('-u', '--update') for a in args)
            and not any(a and not a.startswith('-') for a in args)):
        return "-u/--update ohne Pfad nimmt jede Aenderung an verfolgten Dateien im ganzen Repo mit"
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
# 3c2. worker-name (2026-10-09) -- der Workername eines Panes
# ===========================================================================
# Zweck: Kein Agent setzt, aendert oder loescht die Pane-Option `@wb_worker`.
# BEFUND (gruppen-kern, 2026-10-09): wb-gruppe nennt den Absender nach
#        `@wb_worker` des eigenen Panes (pi-worker setzt die Option beim Spawn).
#        Ungeschuetzt koennte ein Worker sich einen fremden Workernamen geben und
#        unter ihm in Gruppen schreiben oder Antraege stellen.
# Policy, Grenzen und Lesen wie 3c (rolle), mit denselben Bausteinen: set /
#        set-option / setw / set-window-option mit `@wb_worker` (auch -u, auch in
#        tmux-Befehlsketten und ueber Variablen) gegen den hiesigen Server: DENY.
#        Lesen (`display`, `show-options`, `list-panes -F`) bleibt erlaubt; ein
#        eigener Server (-L/-S auf einen anderen Socket) darf setzen. Kein Schalter,
#        aus demselben Grund wie 3c. Legitim setzen die Werkzeuge (pi-worker,
#        wb-agent, wb-remote-view) -- in ihrem Code, nicht in der Zeile des Agenten.
#        Ein Optionsname, der erst zur Laufzeit feststeht, lehnt schon 3c ab.

WORKER_OPTION = '@wb_worker'

WORKER_HINWEIS = (
    "Der Workername eines Panes ist keine Behauptung, die der Bewachte selbst "
    "umschreiben darf: unter ihm schreibt die Sitzung in Gruppen (wb-gruppe) und "
    "steht auf der Tafel. Gesetzt wird er beim Spawn (pi-worker); ein Test arbeitet "
    "auf einem eigenen Socket (tmux -L wbtest ...). Blockiert von worker-name."
)


def check_worker_option(command):
    if not command:
        return None
    command = cmdshell.strip_heredocs(command)
    stmts = cmdshell.all_statements(command)
    if stmts == [None]:
        if WORKER_OPTION in command:
            return ("Befehl nicht zerlegbar, enthaelt aber '%s'. Im Zweifel gilt er als "
                    "Versuch, den Workernamen zu setzen. %s" % (WORKER_OPTION, WORKER_HINWEIS))
        return None
    prefixes = cmdshell.assignment_prefixes(stmts)
    for idx, stmt in enumerate(stmts):
        if not stmt:
            continue
        varmap = prefixes[idx] if idx < len(prefixes) else {}
        for stage in cmdshell.split_pipeline(cmdshell.strip_redirections(stmt)):
            name, _i, rest = cmdshell.resolve_command(stage, varmap)
            if name in ROLLEN_SET_VERBEN:
                # tmux-Befehlskette: der Server ist nicht mehr zu sehen (wie 3c).
                if any(WORKER_OPTION in cmdshell.resolve_vars(t, varmap) for t in rest):
                    return ("`%s ... %s ...` steht ohne sichtbares `tmux` in der Zeile "
                            "(tmux-Befehlskette). Welcher Server gemeint ist, laesst sich "
                            "so nicht bestimmen. %s" % (name, WORKER_OPTION, WORKER_HINWEIS))
                continue
            if name != 'tmux':
                continue
            aufgeloest = [cmdshell.resolve_vars(t, varmap) for t in rest]
            if not any(t in ROLLEN_SET_VERBEN for t in aufgeloest):
                continue
            if not any(WORKER_OPTION in t for t in aufgeloest):
                continue
            ziel = _rollen_zielsocket(aufgeloest)
            hier = os.path.realpath((os.environ.get('TMUX', '') or '').split(',')[0]) \
                if os.environ.get('TMUX') else ''
            if ziel and hier and ziel != hier:
                continue   # eigener Server, erreicht die hiesigen Panes nicht
            woher = ('' if ziel and hier else
                     ' Der gemeinte tmux-Server liess sich nicht bestimmen (%s gegen %s).'
                     % (ziel or 'unbekannt', hier or 'unbekannt'))
            return ("`tmux %s ...` nennt %s und veraendert den Workernamen eines Panes "
                    "dieses Servers.%s %s"
                    % (next(t for t in aufgeloest if t in ROLLEN_SET_VERBEN),
                       WORKER_OPTION, woher, WORKER_HINWEIS))
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
# Policy: DENY fuer JEDEN Zugriff -- auch lesend. Ein Agent hat in diesen
#        Ablagen nichts zu suchen: die Freigaben schreibt ein Mensch (ueber
#        `wb-freigabe` oder das Programmfenster), das Register fuehrt
#        `wb-rolle`, und der Schluessel ist genau das, was eine Faelschung
#        verhindern soll. Seit 2026-09-26 gehoert die Ausnahmeliste des
#        Skript-Schritts dazu (lib/script_guard.py): ein Eintrag dort nimmt ein
#        Skript aus der Pruefung, also pflegt sie ein Mensch, kein Agent.
# Kein Schalter, aus demselben Grund wie bei 3c.

def _geschuetzte_pfade():
    grants = ask_muster.grants_dir()
    return [grants, ask_muster.schluessel_datei(), rollen.verzeichnis(),
            script_guard.ausnahmen_datei()]


FREIGABE_HINWEIS = (
    "Freigaben erteilt ein Mensch -- im Programmfenster oder mit `wb-freigabe "
    "erteilen <pane> <grund>` im Terminal; beides misst die Herkunft, statt "
    "sie zu glauben. Das Rollenregister fuehrt `wb-rolle`. Ein angehaltener "
    "Befehl wird wiederholt, nicht umgangen. Blockiert von freigabe-pfad."
)


# Zweite Linie (2026-10-13, Befund zur Herkunft der Freigaben): der Steuerkanal
# der Mac-App trug bei `muster-entscheiden` in der sichtbaren App den Klick
# eines Menschen. Die App gibt dort nicht mehr frei (Fenster.entscheiden mit
# `echt: false`); hier wird der Weg zum LIVE-Socket (`mac-lauf/awbmac.sock`)
# schon vorher versperrt. Testinstanzen haben ihren eigenen Socket und bleiben
# frei; ein Socket, der sich aus der Zeile nicht ablesen laesst, gilt als live.
LIVE_MAC_LAUF = 'mac-lauf'


def _awbmac_freigabe_aufruf(args):
    """True, wenn die Argumente von awbmac-ctl etwas annehmen wollen."""
    if 'muster-entscheiden' in args and 'approve' in args:
        return True
    # Worker-Antraege (`entscheiden <antrag> approve`) und die Werkzeug-Rueckfrage
    # der Chat-Buehne (`chat-klick freigabe-ja`), 13.10.2026, Folge zum
    # Steuerkanal-Fix. Geprueft wird die Stelle der Aktion, damit ein Grund, der
    # das Wort enthaelt, ein Ablehnen nicht sperrt.
    for j, a in enumerate(args):
        if a == 'entscheiden' and args[j + 2:j + 3] == ['approve']:
            return True
        if a == 'chat-klick' and args[j + 1:j + 2] == ['freigabe-ja']:
            return True
    # Die Menuepunkte Freigaben > Freigeben und Gespraech > Freigabe erlauben
    # (`hauptmenue`), dieselben Wege mit Kuerzel.
    return 'hauptmenue' in args and ('Freigeben' in args or 'Freigabe erlauben' in args)


def _awbmac_socket(stage, idx, rest, varmap):
    """Der Socket, den dieser Aufruf erreicht, aufgeloest so weit die Zeile es
    hergibt; None heisst: keiner genannt (Vorgabe ohne mac-lauf)."""
    for j, t in enumerate(rest):
        if t == '--socket' and j + 1 < len(rest):
            return cmdshell.resolve_vars(rest[j + 1], varmap)
        if t.startswith('--socket='):
            return cmdshell.resolve_vars(t[len('--socket='):], varmap)
    for t in stage[:idx]:
        if t.startswith('AWBMAC_CONTROL_SOCKET='):
            return cmdshell.resolve_vars(t.split('=', 1)[1], varmap)
    if 'AWBMAC_CONTROL_SOCKET' in varmap:
        return cmdshell.resolve_vars(varmap['AWBMAC_CONTROL_SOCKET'], varmap)
    return os.environ.get('AWBMAC_CONTROL_SOCKET') or None


def _ist_live_socket(sock):
    if sock is None:
        return False
    sock = sock.strip('\'"')
    if '$' in sock or '`' in sock:
        return True   # nicht ablesbar: im Zweifel live
    return LIVE_MAC_LAUF + '/' in os.path.expanduser(sock)


def check_awbmac_freigabe(command):
    stmts = cmdshell.all_statements(command)
    if stmts == [None]:
        if 'awbmac-ctl' in command and any(w in command for w in (
                'approve', 'Freigeben', 'freigabe-ja', 'Freigabe erlauben')):
            return ("Befehl nicht zerlegbar, nennt aber awbmac-ctl mit einer Annahme. %s"
                    % FREIGABE_HINWEIS)
        return None
    prefixes = cmdshell.assignment_prefixes(stmts)
    for idx, stmt in enumerate(stmts):
        if not stmt:
            continue
        varmap = prefixes[idx] if idx < len(prefixes) else {}
        for stage in cmdshell.split_pipeline(cmdshell.strip_redirections(stmt)):
            name, i, rest = cmdshell.resolve_command(stage, varmap)
            if name != 'awbmac-ctl':
                continue
            args = [cmdshell.resolve_vars(t, varmap) for t in rest]
            if not _awbmac_freigabe_aufruf(args):
                continue
            if _ist_live_socket(_awbmac_socket(stage, i, rest, varmap)):
                return ("`awbmac-ctl` will ueber den Steuerkanal der laufenden Mac-App "
                        "eine Rueckfrage oder einen Antrag annehmen (Socket %s/awbmac.sock "
                        "oder nicht ablesbar). "
                        "Der Steuerkanal ist kein Mensch. %s" % (LIVE_MAC_LAUF, FREIGABE_HINWEIS))
    return None


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
    formen.extend(['guard-grants', ask_muster.SCHLUESSEL_NAME, 'pi-workers/rollen',
                   script_guard.AUSNAHMEN_NAME])
    # DER MANTEL DER MAC-APP (13.10.2026, Auftrag wz-mantel): mit Token und
    # Socket wird ein Prozess zum Fenster des Menschen. Der Kern prueft die
    # Gegenseite inzwischen selbst (app/src/main/mantel.ts, Peer-PID); hier
    # faellt nur der getippte Griff danach auf. `mantel.token` gibt es nur im
    # Laufverzeichnis der App; der Socket nur mit `mac-lauf/` davor, weil
    # Testsuiten eigene `mantel.sock` unter mktemp anlegen.
    formen.extend(['mantel.token', 'mac-lauf/mantel.sock'])
    laufdir = os.environ.get('AWBMAC_LAUFDIR', '')
    if laufdir:
        formen.append(os.path.join(laufdir, 'mantel.sock'))
    for form in formen:
        if form and form in command:
            return ("Der Befehl fasst eine geschuetzte Ablage an (%s). %s"
                    % (form, FREIGABE_HINWEIS))
    return check_awbmac_freigabe(command)


# ===========================================================================
# 3e. mobil-pfad (2026-10-14, Auftrag wz-mobilguard) -- das Geraeteregister
#     der Mobil-App
# ===========================================================================
# Zweck: Kein Agent traegt ein eigenes Geraet in ~/.claude/workbench/mobile/
#        ein. BEFUND (Review handyguard F2, Nachweis
#        app/test/mobile/review/geraet-eingeschleust.test.ts): der Kern liest
#        auth-state.json bei jeder Pruefung von Platte (auth.ts readState) und
#        nimmt ein dort eingetragenes P-256-Geraet als Mobilgeraet = Mensch an:
#        Worker-Antraege annehmen, mobil-senden in den Orchestrator-Pane, agents
#        mit Absender mensch. Gekoppelt wird nur ueber den Kern mit Code und
#        gemessenem Menschen; ein Agent hat in dem Ordner nichts zu suchen.
# Policy: DENY fuer jeden getippten Zugriff, auch lesend (Zaehler, Nonces,
#        Journal), wie freigabe-pfad. Erkannt werden: jede Schreibweise des
#        Ordners (absolut, ~, $HOME, ${HOME}, Variablen der Zeile, Gross/Klein,
#        Anfuehrungszeichen, doppelte Schraegstriche, Symlink-Ziel), der
#        Elternweg (~/.claude bzw. ~/.claude/workbench zusammen mit `mobile`
#        oder `auth-state`, oder mit mv/ln/rm/cp/rsync/find/chmod/chown/tar/
#        ditto/install, die den Elternordner umhaengen oder kopieren) und ein
#        Arbeitsverzeichnis im oder ueber dem Ordner. Die App (Kern) schreibt
#        weiter dort: sie laeuft nicht durch die Hooks.
# GRENZE: Was ein Skript oder Interpreter erst zur Laufzeit zusammensetzt
#        (`bash x.sh`, ein Pfad aus Teilstuecken in python -c), sieht der Hook
#        nicht -- wie bei freigabe-pfad. Die Abhilfe dafuer gehoert in den Kern
#        (MAC ueber die Geraeteeintraege, Auftrag wz-handyguard2).
# Kein Schalter, aus demselben Grund wie bei 3c.

MOBIL_HINWEIS = (
    "Das Geraeteregister der Mobil-App (~/.claude/workbench/mobile/) fuehrt allein der "
    "Kern der Werkbank; ein Telefon koppelt ein Mensch am Mac (Kopplung mit Code). Ein "
    "selbst eingetragenes Geraet spraeche fuer den Menschen, deshalb liest und schreibt "
    "ein Agent dort nichts, auch nicht ueber den Elternordner. Blockiert von mobil-pfad."
)

_MOBIL_WORT = re.compile(r'(?<![a-z0-9_.-])(?:mobile|auth-state)(?![a-z0-9_-])')
# Befehle, die den Elternordner als Ganzes umhaengen, verlinken, loeschen,
# kopieren oder durchgehen; mit ihm als Operand erreichen sie das Register.
_MOBIL_UMHAENGEN = {'mv', 'ln', 'rm', 'rmdir', 'cp', 'rsync', 'find', 'chmod', 'chown',
                    'tar', 'ditto', 'install'}
_PFAD_ENDE = r'/?(?=$|[\s;&|()<>])'


def _mobil_orte():
    """(Ordner, Elternordner) in Kleinschrift, je mit dem Symlink-Ziel, falls es abweicht."""
    heim = os.path.expanduser('~')
    claude = os.path.join(heim, '.claude')
    wb = os.path.join(claude, 'workbench')
    mobil = os.path.join(wb, 'mobile')
    ordner, eltern = {mobil.lower()}, {wb.lower(), claude.lower()}
    for p, ziel in ((mobil, ordner), (wb, eltern), (claude, eltern)):
        try:
            ziel.add(os.path.realpath(p).lower())
        except Exception:
            pass
    return heim, ordner, eltern


def _mobil_normal(text, heim):
    t = re.sub(r'[\'"\\]', '', text)
    for form in ('${HOME}', '$HOME'):
        t = t.replace(form, heim)
    t = re.sub(r'(^|[\s=:;&|(<>])~(?=/|$|[\s;&|()<>])', lambda m: m.group(1) + heim, t)
    t = re.sub(r'/+', '/', t.lower())
    while '/./' in t:
        t = t.replace('/./', '/')
    return t


def _ist_elternordner(wort, eltern):
    w = wort.rstrip('/')
    return w in eltern or w in ('.claude', '.claude/workbench', 'workbench') \
        or w.endswith('/.claude') or w.endswith('/.claude/workbench')


# Zweite Tuer (Nachtrag 14.10., wz-handyguard OPEN 3): Seit die Geraeteliste
# signiert ist, prueft der Kern jeden Eintrag gegen den Freigabe-Schluessel.
# `geraete-replizieren.mjs registry` signiert aber jeden Eintrag seiner
# Quelldatei neu -- ein Agent, der es mit einer eigenen Quelle ruft, bekaeme
# ein gueltig signiertes Fremdgeraet, ohne den Schluessel je zu sehen. Der
# Replikationsdienst (Kern, replik-gegenseite.sh) laeuft nicht durch die Hooks.
# Gesperrt ist jeder getippte Aufruf eines Programms namens geraete-replizieren*
# (direkt oder ueber node/bun/deno) mit dem Unterbefehl registry; `audience`
# und `abos` bleiben frei, sie signieren nichts.
_REPLIK_NAME = 'geraete-replizieren'
_REPLIK_INTERPRETER = {'node', 'nodejs', 'bun', 'deno'}


def _replik_registry(stage, varmap):
    name, i, rest = cmdshell.resolve_command(stage, varmap)
    if not name:
        return False
    args = [cmdshell.resolve_vars(t, varmap).strip('\'"') for t in rest]
    if name in cmdshell.SHELL_INTERPRETERS:
        hat_c, skript = cmdshell.shell_c_script(args)
        return bool(hat_c and skript and check_mobil_replik(skript))
    if name in _REPLIK_INTERPRETER:
        # Optionen des Interpreters ueberspringen; das erste Wort ist das Skript.
        while args and args[0].startswith('-'):
            args = args[1:]
        if not args:
            return False
        name, args = args[0].split('/')[-1], args[1:]
    return name.startswith(_REPLIK_NAME) and 'registry' in args


def check_mobil_replik(command):
    if not command or _REPLIK_NAME not in command:
        return None
    command = cmdshell.strip_heredocs(command)
    if _REPLIK_NAME not in command:
        return None
    stmts = cmdshell.all_statements(command)
    if stmts == [None]:
        if re.search(r'(?<![a-z0-9_-])registry(?![a-z0-9_-])', command):
            return ("Befehl nicht zerlegbar, nennt aber geraete-replizieren mit registry. %s"
                    % MOBIL_HINWEIS)
        return None
    prefixes = cmdshell.assignment_prefixes(stmts)
    for idx, stmt in enumerate(stmts):
        if not stmt:
            continue
        varmap = prefixes[idx] if idx < len(prefixes) else {}
        for stage in cmdshell.split_pipeline(cmdshell.strip_redirections(stmt)):
            if _replik_registry(stage, varmap):
                return ("`geraete-replizieren registry` signiert jeden Eintrag seiner Quelle mit dem "
                        "Freigabe-Schluessel neu; das ruft nur der Replikationsdienst des Kerns. %s"
                        % MOBIL_HINWEIS)
    return None


def check_mobil_pfad(command, cwd=''):
    replik = check_mobil_replik(command)
    if replik:
        return replik
    heim, ordner, eltern = _mobil_orte()
    wb_eltern = [e for e in eltern if not e.endswith('/.claude')]
    ort = ''
    if cwd:
        try:
            ort = os.path.realpath(cwd).lower()
        except Exception:
            ort = cwd.lower()
        if any(ort == o or ort.startswith(o + '/') for o in ordner):
            return "Das Arbeitsverzeichnis liegt im Geraeteregister (%s). %s" % (cwd, MOBIL_HINWEIS)
    if not command:
        return None
    command = cmdshell.strip_heredocs(command)
    texte = [command]
    # Variablen der Zeile eingesetzt (`D=~/.claude/workbench; echo > $D/mobile/x`).
    stmts = cmdshell.all_statements(command)
    if stmts != [None]:
        prefixes = cmdshell.assignment_prefixes(stmts)
        for idx, stmt in enumerate(stmts):
            if not stmt:
                continue
            varmap = prefixes[idx] if idx < len(prefixes) else {}
            texte.append(' '.join(cmdshell.resolve_vars(t, varmap) for t in stmt))
            # Der Elternordner selbst als Operand: `mv ~/.claude/workbench ~/w`,
            # `ln -s ~/.claude c`. Ein `cd ~/.claude && cp a b` bleibt frei.
            for stage in cmdshell.split_pipeline(cmdshell.strip_redirections(stmt)):
                name, _i, rest = cmdshell.resolve_command(stage, varmap)
                if name not in _MOBIL_UMHAENGEN:
                    continue
                for tok in rest:
                    w = _mobil_normal(cmdshell.resolve_vars(tok, varmap), heim)
                    if _ist_elternordner(w, eltern) or (w.rstrip('/') in ('.', '..') and ort in eltern):
                        return ("`%s` fasst den Elternordner des Geraeteregisters als Ganzes an (%s). %s"
                                % (name, tok, MOBIL_HINWEIS))
    for roh in texte:
        t = _mobil_normal(roh, heim)
        if re.search(r'(?<![a-z0-9_.-])workbench/mobile(?![a-z0-9_.-])', t) or \
                any(o in t for o in ordner if not o.endswith('/workbench/mobile')):
            return "Der Befehl nennt das Geraeteregister. %s" % MOBIL_HINWEIS
        # ~/.claude/workbench in jeder Schreibweise plus `mobile`/`auth-state`:
        # `cd ~/.claude/workbench && cat > mobile/auth-state.json`.
        if (any(re.search(re.escape(e) + _PFAD_ENDE, t) for e in wb_eltern)
                or re.search(r'(?<![a-z0-9_.-])(?:\.claude/)?workbench' + _PFAD_ENDE, t)) \
                and _MOBIL_WORT.search(t):
            return ("Der Befehl erreicht das Geraeteregister ueber den Elternordner "
                    "~/.claude/workbench. %s" % MOBIL_HINWEIS)
    if ort in wb_eltern and _MOBIL_WORT.search(command.lower()):
        return ("Das Arbeitsverzeichnis (%s) ist der Elternordner des Geraeteregisters. %s"
                % (cwd, MOBIL_HINWEIS))
    return None


# ===========================================================================
# 3f. xcode-umlenkung (14.10.2026, Review handyguard2 N1) -- DEVELOPER_DIR,
#     SDKROOT und TOOLCHAINS vor einem Werkbank-Werkzeug
# ===========================================================================
# Zweck: /usr/bin/python3 ist auf macOS der xcrun-Shim und startet
#        $DEVELOPER_DIR/usr/bin/xcrun. BEFUND (gemessen): `DEVELOPER_DIR=<eigener
#        Ordner> wb-decide <antrag> approve` aus einem Worker-Pane -- das eigene
#        xcrun gab fuer die Herkunftsmessung "orchestrator" aus, Exit 0,
#        angenommen; ebenso der Geraetebeleg von wb-decide/wb-freigabe. Die erste
#        Linie steht in den Werkzeugen (unset + `env -i ... python3 -I -S`). Diese
#        hier ist die zweite, vor allem fuer Werkzeuge mit `#!/usr/bin/env python3`
#        (wb-inbox, wb-tafel, ...): steht /usr/bin/python3 vorn im PATH, ist dort
#        schon der Interpreter ersetzt, bevor eine Zeile des Werkzeugs laeuft.
# Policy: DENY, wenn der Befehl
#        (a) eine der drei Variablen setzt oder weiterreicht (Praefix, env,
#            export, declare/typeset -x, launchctl setenv, ${VAR:=..}) UND ein
#            Werkbank-Werkzeug nennt (wb-*, pi-worker, claude-worker, agents_*,
#            context-guard, awbmac-ctl), oder
#        (b) DEVELOPER_DIR auf etwas anderes setzt als die festen Entwicklerordner
#            (Xcode.app, Xcode-beta.app, CommandLineTools) -- auch ohne Werkzeug,
#            weil ein Skript oder eine spaetere Stufe es weitertragen kann.
#        Eine Sperre fuer JEDEN Befehl mit diesen Variablen waere zu breit: Builds
#        mit `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` (ttsapp)
#        sind gewollt; ein fester Entwicklerordner ist keine Umlenkung auf Code des
#        Agenten. SDKROOT und TOOLCHAINS zaehlen nur zusammen mit einem Werkzeug
#        (SDKROOT lenkte python3 nicht um, gemessen; TOOLCHAINS braucht eine
#        Toolchain unter ~/Library/Developer).
# GRENZE: Was ein Skript oder Interpreter erst zur Laufzeit setzt (`bash x.sh`,
#        os.environ in python -c), sieht der Hook nicht -- dafuer die erste Linie.
#        `unset` dieser Variablen ist frei.
# Kein Schalter, aus demselben Grund wie bei 3c.

XCODE_HINWEIS = (
    "/usr/bin/python3 ist auf macOS der xcrun-Shim und folgt DEVELOPER_DIR (auch SDKROOT "
    "und TOOLCHAINS lenken xcrun): ein eigener Ordner davor ersetzt den Interpreter, der in "
    "den Werkbank-Werkzeugen Herkunft, Freigaben und Rollen misst (Befund 14.10.2026). "
    "Werkbank-Werkzeuge laufen ohne diese Variablen; ein Build mit einem echten "
    "Entwicklerordner (/Applications/Xcode.app/Contents/Developer, "
    "/Applications/Xcode-beta.app/Contents/Developer, /Library/Developer/CommandLineTools) "
    "bleibt frei, solange er kein Werkbank-Werkzeug ruft. Blockiert von xcode-umlenkung."
)
XCODE_ENTWICKLERORDNER = {'/Applications/Xcode.app/Contents/Developer',
                          '/Applications/Xcode-beta.app/Contents/Developer',
                          '/Library/Developer/CommandLineTools'}
_XCODE_VAR = r'(?:DEVELOPER_DIR|SDKROOT|TOOLCHAINS)'
# Die Formen, die eine der Variablen setzen oder in die Umgebung heben: VAR=.. (Praefix, env,
# export/declare/local mit Wert), ${VAR:=..}, export/declare/typeset/readonly/local VAR ohne
# Wert, launchctl setenv VAR, printf -v VAR, read .. VAR. Eine blosse Erwaehnung (grep, echo,
# $VAR) setzt nichts.
_XCODE_SETZT = re.compile(
    r'(?<![\w$])(?<!\$\{)' + _XCODE_VAR + r'\+?='
    r'|\$\{' + _XCODE_VAR + r':?[=]'
    r'|(?<![\w-])(?:export|declare|typeset|readonly|local)(?![\w-])[^;&|\n]*?(?<![\w$])(?<!\$\{)'
    + _XCODE_VAR + r'(?!\w)'
    r'|(?<![\w-])setenv\s+' + _XCODE_VAR + r'(?!\w)'
    r'|(?<![\w-])printf\s+-v\s*' + _XCODE_VAR + r'(?!\w)'
    r'|(?<![\w-])read(?![\w-])[^;&|\n]*?(?<![\w$])' + _XCODE_VAR + r'(?!\w)')
_XCODE_UNSET = re.compile(r'(?<![\w-])unset(?:\s+-v)?(?:\s+' + _XCODE_VAR + r'(?!\w))+')
_XCODE_DEVDIR_WERT = re.compile(
    r'(?:(?<![\w$])(?<!\$\{)DEVELOPER_DIR\+?=|(?<![\w-])setenv\s+DEVELOPER_DIR\s+)'
    r'("[^"]*"|\'[^\']*\'|[^\s;&|()<>]*)')
_WB_WERKZEUG = re.compile(
    r'(?<![\w.-])(?:wb-[a-z0-9][\w-]*|pi-worker|claude-worker|agents_\w+|context-guard|awbmac-ctl)(?![\w-])')


def check_xcode_umlenkung(command):
    if not command:
        return None
    # Der Rumpf eines Here-Dokuments ist Text; laeuft er als Skript, prueft ihn 8b eigens.
    text = _XCODE_UNSET.sub(' ', cmdshell.strip_heredocs(command))
    if not _XCODE_SETZT.search(text):
        return None
    if _WB_WERKZEUG.search(text):
        return ("Der Befehl setzt DEVELOPER_DIR, SDKROOT oder TOOLCHAINS und ruft ein "
                "Werkbank-Werkzeug. %s" % XCODE_HINWEIS)
    for m in _XCODE_DEVDIR_WERT.finditer(text):
        wert = m.group(1)
        if wert[:1] in ('"', "'"):
            wert = wert[1:-1]
        if not wert:
            continue   # `export DEVELOPER_DIR` allein: der Wert steht (wenn) an anderer Stelle
        if '$' in wert or '`' in wert or wert.rstrip('/') not in XCODE_ENTWICKLERORDNER:
            return ("Der Befehl setzt DEVELOPER_DIR auf %s, keinen der festen "
                    "Entwicklerordner. %s" % (wert[:200], XCODE_HINWEIS))
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
# Blockliste: media-cloud-domains.txt NEBEN diesem Skript (Rueckfall
#        $HOME/.claude/hooks); fehlt sie, warnt der Guard laut.
# Policy: reines Warnen, kein Deny — die Liste veraltet schnell und manche
#        Cloud-Aufrufe sind bewusst genehmigte Ausnahmen (z.B. creative-media-
#        Skill nutzt Higgsfield gezielt); ein Hard-Block waere hier falsch.

MEDIA_CLOUD_DOMAINS_NAME = 'media-cloud-domains.txt'


def _media_cloud_domains_file():
    """Liste neben dem eigenen Skript; Rueckfall auf $HOME/.claude/hooks nur,
    wenn dort keine liegt (z. B. Skript ausserhalb des Hooks-Ordners kopiert)."""
    neben = os.path.join(HOOKS_DIR, MEDIA_CLOUD_DOMAINS_NAME)
    if os.path.isfile(neben):
        return neben
    return os.path.join(
        os.environ.get('HOME', os.path.expanduser('~')), '.claude', 'hooks', MEDIA_CLOUD_DOMAINS_NAME)


def check_media_cloud_bash(command):
    if not command:
        return None
    domains_file = _media_cloud_domains_file()
    try:
        with open(domains_file, 'r', encoding='utf-8', errors='replace') as fh:
            lines = fh.read().splitlines()
    except OSError:
        lines = []
    if not any(l.strip() and not l.startswith('#') for l in lines):
        # Fehlende/leere/unlesbare Liste: laut warnen statt still erlauben.
        return (
            "media-cloud-guard: KEINE Domainliste (%s fehlt, ist leer oder unlesbar) -- Cloud-Media-"
            "Aufrufe werden NICHT erkannt. Liste neben bash-guard.py ablegen. Reine Warnung, kein Block."
            % MEDIA_CLOUD_DOMAINS_NAME
        )

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
# Warum: Stehende Regel (~/.claude/AGENTS.md, Schutz und Verifikation): Commits laufen auf dem
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
  Stehende Regel (~/.claude/AGENTS.md, Schutz und Verifikation): Commits laufen auf dem Git-Handle
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
        # Ein Muster in einem Skript, das der Befehl startet. Die Freigabe bindet dann an den
        # Befehl plus einen Hash des Skripttexts (siehe lib/script_guard.py).
        treffer, command = script_guard.ask_hit(command, cwd, muster_liste)
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
        # Auch fuer die neue Fassung kann der Agent im selben Zug warten (29.09.):
        # ein Mensch kann sie per `--index` waehlen. Der Wortlaut liegt dafuer in
        # einer eigenen Datei; `warten` erteilt nichts.
        datei = ask_muster.wortlaut_ablegen(pane, cwd, command)
        warten_zeile = ("  Auf eine Entscheidung ueber GENAU diese Fassung wartest du im selben Zug mit:\n"
                        "    %s\n" % ask_muster.warten_aufruf(pane, cwd, datei)) if datei else ""
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
            "  Ist die wartende Frage UEBERFLUESSIG geworden (du brauchst den Befehl nicht\n"
            "  mehr), nimm sie zurueck: `wb-freigabe zurueckziehen` -- das erteilt nichts,\n"
            "  es gibt nur den Pane fuer die naechste Frage frei.\n"
            "%s"
            "  Angehalten von bash-guard-muster."
            % (wartender.get('command', ''), warten_zeile)
        )

    # Der Wortlaut in einer Datei, damit der Agent IM SELBEN ZUG warten kann
    # (`wb-freigabe warten`, 29.09.2026) statt seinen Zug zu beenden. Ohne Pane
    # oder bei nicht schreibbarer Ablage bleibt es beim alten Text.
    befehl_datei = ask_muster.wortlaut_ablegen(pane, cwd, command) if pane else None
    reason = ask_muster.deny_text(treffer, max(1, ttl // 60),
                                  warten=(pane, cwd, befehl_datei) if befehl_datei else None)
    if freigabe_bericht:
        # Der Fall, den es vor dem 07.08. nicht gab: eine Freigabe lag vor und
        # wurde verworfen. Wer das liest, muss beides erfahren -- dass sie da
        # war, und warum sie nicht zaehlte. Seit 29.09. direkt unter der ersten
        # Zeile statt am Ende: der Text mit dem warten-Aufruf ist laenger, und
        # eine Anzeige, die nach ~1500 Zeichen kuerzt, verschluckte den Grund.
        kopf, _, rest = reason.partition('\n')
        reason = kopf + ("\n  HINWEIS zur vorliegenden Freigabe: %s\n"
                         "  Gueltig wird sie nur mit gemessener Herkunft: im Terminal\n"
                         "  `wb-freigabe erteilen %s <grund>` (ein Mensch am Terminal oder das\n"
                         "  Programmfenster -- beides wird gemessen, nicht geglaubt).\n"
                         % ('; '.join(freigabe_bericht), pane or '<pane>')) + rest
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

# Here-Doc in einem mehrteiligen Befehl (Betreiberentscheidung 2026-10-09):
# fast jeder Guard hier schneidet Here-Doc-Ruempfe weg (strip_heredocs in
# rolle, freigabe-pfad, kill-pattern, push-gate, snapshot …), weil ein Rumpf
# beim Einzelbefehl `cat > f <<'EOF'` nur Text ist. In einem mehrteiligen
# Befehl kann eine andere Anweisung den Empfaenger umdefinieren oder eine
# weitere Stufe den Rumpf lesen (cmdshell.heredoc_mehrteilig). Dann laeuft
# jeder Rumpf zusaetzlich als eigener Befehl durch dieselbe Guard-Kette --
# ohne Marker, Verlauf, Rueckfrage-Stufe und ohne Wirkung auf eine wartende
# Freigabe; eine Ablehnung dort lehnt den ganzen Befehl ab. Fehlalarme bei
# `cd x && cat > f <<'EOF'` mit gesperrten Woertern sind in Kauf genommen
# (Ausweg: das Write-Werkzeug).
_RUMPF = [False]
_RUMPF_TREFFER = []


def _rumpf_pruefen(data, rumpf):
    """(Entscheidung, Guard, Grund), die die Guard-Kette fuer `rumpf` als
    eigenen Befehl gaebe ('deny' oder 'ask'), sonst None."""
    tool_input = dict(data.get('tool_input') or {})
    tool_input['command'] = rumpf
    payload = json.dumps(dict(data, tool_input=tool_input))
    out, err = io.StringIO(), io.StringIO()
    old = sys.stdout, sys.stderr, _RUMPF[0], list(_RUMPF_TREFFER)
    del _RUMPF_TREFFER[:]
    _RUMPF[0] = True
    sys.stdout, sys.stderr = out, err
    try:
        rc = main(rumpf_input=payload)
    except Exception:
        return None  # ein Absturz ist auch das, was der Hook beim getippten Befehl taete
    finally:
        guard = _RUMPF_TREFFER[0] if _RUMPF_TREFFER else 'heredoc'
        sys.stdout, sys.stderr, _RUMPF[0] = old[0], old[1], old[2]
        _RUMPF_TREFFER[:] = old[3]
    if rc == 2:
        return 'deny', guard, err.getvalue().strip()
    for zeile in out.getvalue().splitlines():
        try:
            hso = json.loads(zeile).get('hookSpecificOutput') or {}
        except ValueError:
            continue
        if hso.get('permissionDecision') in ('deny', 'ask'):
            return hso['permissionDecision'], guard, hso.get('permissionDecisionReason') or ''
    return None


def main(probe_input=None, rumpf_input=None):
    # probe_input: das Hook-JSON eines Skriptstuecks (lib/script_guard.py laesst main() ohne
    # Nebenwirkung ueber Skripttext laufen).
    # rumpf_input: das Hook-JSON eines Here-Doc-Rumpfs aus einem mehrteiligen Befehl
    # (_rumpf_pruefen); ebenfalls ohne Nebenwirkung, aber mit allen Guards.
    probe = probe_input is not None
    rumpf = rumpf_input is not None
    try:
        input_text = probe_input if probe else rumpf_input if rumpf else sys.stdin.read()
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
    if not probe and not rumpf:
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
    wartender = None if probe or rumpf else clear_block(pane)

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
    if not probe and not rumpf:
        abschaltung_vermerken(guards, _rolle[0] or '')

    warn_msgs = []

    def laeuft(name):
        """Im Probelauf (Skripttext) nur die Guards aus script_guard.SKRIPT_GUARDS,
        sonst alle. Die uebrigen sehen in Skripten vor allem isolierte Testumgebungen
        (eigener tmux-Socket, Temp-Repo, Temp-Ordner) und bleiben beim getippten Befehl."""
        return not probe or name in script_guard.SKRIPT_GUARDS

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
        if probe:
            script_guard.PROBE_HITS.append(guard)
            return
        if rumpf:
            _RUMPF_TREFFER.append(guard)
            return
        if wartender is not None:
            return
        note_block(pane, guard, reason, command, cwd, session_id)

    # 1. secrets
    reason = check_secrets(command, cwd) if laeuft('secrets') else None
    if reason and not abgeschaltet('secrets', reason):
        merken('secrets', reason)
        append_block_log(pane, 'secrets', reason, command, cwd, session_id)
        print_deny(reason)
        return 0

    # 1b. git-add -- direkt hinter secrets: beide sehen sich `git add` an, und
    #     ein Fall, den secrets schon ablehnt (z.B. `git add -A` mit einem
    #     .env im Working Tree), ist damit laengst weg, bevor dieser Guard
    #     ueberhaupt drankommt.
    reason = check_git_add(command, cwd) if laeuft('git-add') else None
    if reason and not abgeschaltet('git-add', reason):
        merken('git-add', reason)
        append_block_log(pane, 'git-add', reason, command, cwd, session_id)
        print_deny(reason)
        return 0

    # 2. kill-pattern (lib, importiert)
    #    Ein abgeschalteter Guard verschluckt nur seine ABLEHNUNG. Was das
    #    lib-Modul sonst ausgibt (Warnung, Rueckfrage), geht unveraendert durch --
    #    abschalten heisst "lehnt nicht mehr ab", nicht "sagt nichts mehr".
    kp_out = with_stdin(input_text, kill_pattern_classify.main) if laeuft('kill-pattern') else ''
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
    lc_warn = check_live_config_bash(command, cwd) if laeuft('live-config') else None
    if lc_warn and not abgeschaltet('live-config', lc_warn):
        warn_msgs.append(lc_warn)

    # 3b. pane-write -- lehnt ab. Steht direkt hinter live-config, weil beide
    #     dieselbe Familie von Befehlen ansehen: die Warnung dort erklaert den
    #     Testfall, die Ablehnung hier zieht die Grenze.
    pw_reason = check_pane_write_bash(command) if laeuft('pane-write') else None
    if pw_reason and not abgeschaltet('pane-write', pw_reason):
        merken('pane-write', pw_reason)
        append_block_log(pane, 'pane-write', pw_reason, command, cwd, session_id)
        print_deny(pw_reason)
        return 0

    # 3c/3c2/3d/3e. rolle, worker-name, freigabe-pfad und mobil-pfad -- ohne Schalter (Begruendung oben).
    #        Sie stehen VOR dem Push-Gate, weil sie dessen Grundlage schuetzen:
    #        wer die Rollenquelle umschreiben darf, hat das Push-Verbot schon
    #        beantwortet, bevor es gefragt wird.
    for name, pruefung in (('rolle', check_rollen_option),
                           ('worker-name', check_worker_option),
                           ('freigabe-pfad', check_freigabe_pfad),
                           ('mobil-pfad', lambda c: check_mobil_pfad(c, cwd)),
                           ('xcode-umlenkung', check_xcode_umlenkung)):
        reason = pruefung(command) if laeuft(name) else None
        if reason:
            merken(name, reason)
            append_block_log(pane, name, reason, command, cwd, session_id)
            print_deny(reason)
            return 0

    # 4. push-gate-worker (lib, importiert, + Rollen-Check)
    pg_out = with_stdin(input_text, push_gate_classify.main).strip() if laeuft('push-gate') else ''
    if pg_out == '1':
        ist_worker, warum = ist_worker_pane()
        if ist_worker and not abgeschaltet('push-gate', PUSH_GATE_REASON):
            reason = '%s (%s)' % (PUSH_GATE_REASON, warum)
            merken('push-gate', reason)
            append_block_log(pane, 'push-gate', reason, command, cwd, session_id)
            print_deny(reason)
            return 0

    # 5. media-cloud-guard (Bash-Zweig) -- warnt nur.
    mc_warn = check_media_cloud_bash(command) if laeuft('media-cloud') else None
    if mc_warn and not abgeschaltet('media-cloud', mc_warn):
        warn_msgs.append(mc_warn)

    # 6. screencapture (lib, importiert)
    sc_out = with_stdin(input_text, screencapture_classify.main) if laeuft('screencapture') else ''
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
    sn_out = with_stdin(input_text, snapshot_classify.main) if laeuft('snapshot') else ''
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
    trailer = (script_guard.commit_trailer_im_skript(command, check_commit_trailer) if probe
               else check_commit_trailer(command))
    if trailer and not abgeschaltet('commit-trailer',
                                                          COMMIT_TRAILER_MESSAGE):
        merken('commit-trailer', COMMIT_TRAILER_MESSAGE)
        append_block_log(pane, 'commit-trailer', COMMIT_TRAILER_MESSAGE, command, cwd, session_id)
        sys.stderr.write(COMMIT_TRAILER_MESSAGE)
        return 2

    # 8a. Die harten Guards aus script_guard.SKRIPT_GUARDS ueber die Skripte, die dieser Befehl
    #     startet (Kommentarblock in lib/script_guard.py). Ein Probelauf (main() fuer ein
    #     Skriptstueck) endet hier: gefragt sind nur diese harten Guards.
    if probe:
        return 0
    sh = script_guard.hard_hit(command, cwd, data, main)
    if sh is not None:
        decision, guard, reason = sh
        merken(guard, reason)
        append_block_log(pane, guard, reason, command, cwd, session_id)
        if decision == 'deny':
            print_deny(reason)
        else:
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse',
                                                     'permissionDecision': 'ask',
                                                     'permissionDecisionReason': reason}}))
        return 0

    # 8b. Here-Doc in einem mehrteiligen Befehl: jeder Rumpf (auch einer in
    #     `$( )`) zusaetzlich als eigener Befehl durch diese Kette (Kommentar
    #     bei _rumpf_pruefen). Ein Probelauf ueber Skripttext ist oben schon
    #     zu Ende: dort ist fast jeder Befehl mehrteilig.
    teile = cmdshell.heredoc_split(command)
    if cmdshell.heredoc_mehrteilig(teile):
        for b in teile.bodies:
            treffer = _rumpf_pruefen(data, b['body'])
            if treffer is None:
                continue
            decision, guard, reason = treffer
            reason = ("Here-Doc in einem mehrteiligen Befehl, Rumpf als Befehl geprueft: %s\n\n%s"
                      % (reason, cmdshell.HEREDOC_MEHRTEILIG_AUSWEG))
            merken(guard, reason)
            append_block_log(pane, guard, reason, command, cwd, session_id)
            if decision == 'deny':
                print_deny(reason)
            else:
                print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse',
                                                         'permissionDecision': 'ask',
                                                         'permissionDecisionReason': reason}}))
            return 0

    # 9. Rueckfrage-Stufe (Muster-Erkennung riskanter Befehle).
    #    Steht mit Absicht GANZ UNTEN: alles, was die acht Guards oben hart
    #    ablehnen, ist hier laengst weg. Diese Stufe kann deshalb keine
    #    bestehende Ablehnung aufweichen, nur etwas anhalten, das heute
    #    durchlaeuft. Und eine Freigabe wird ERST HIER gelesen -- sie ist nie
    #    ein Weg an einem der acht Guards vorbei.
    if rumpf:
        return 0
    reason = check_ask_muster(pane, command, cwd, session_id, wartender)
    if reason and not abgeschaltet('muster', reason):
        print_deny(reason)
        return 0

    if warn_msgs:
        print_warn('\n\n'.join(warn_msgs))
    return 0


if __name__ == '__main__':
    sys.exit(main())
