#!/usr/bin/env python3
"""reviewer_sperre.py -- die Logik hinter dem PreToolUse-Hook
reviewer-sperre.sh (docs/AGENTS-PLAN.md, Abschnitt 4 "Rollen im Team",
Absatz "Wie die Sperre haelt": "ein Hook prueft jeden Bash-Befehl gegen das
Muster der Rolle ... ein Hook sperrt das Skill-Werkzeug fuer Skills
ausserhalb der Rolle ... Rollen, deren Grenze eine Schreibsperre ist
(Laeufer, Quellenpruefer, Reviewer), arbeiten zusaetzlich in einem
schreibgeschuetzten Checkout").

Der Hook laeuft auf DREI Mattchern (Write|Edit|NotebookEdit, Bash, Skill)
und tut ALLES nur innerhalb einer Werkbank-Aufgabe (gueltige WB_AUFGABE_ID)
UND mit gesetzter WB_ROLLE -- eine Sitzung ohne beides bleibt unberuehrt,
ohne jede Ausgabe.

Dann laedt der Hook das Profil ueber `wb-profil zeigen <rolle> --json`
(Positivliste in shell/wb-profil). Schlaegt das fehl (wb-profil fehlt, Rolle
nicht gefunden, kaputtes JSON), wird FAIL-CLOSED verweigert -- anders als die
anderen beiden neuen Hooks ist dies eine Sandbox-Zusage ("nicht als Prosa",
Abschnitt 4), keine Beleg-Erinnerung; ein Profil, das sich nicht lesen
laesst, darf nichts erlauben. Aus demselben Grund verweigert auch der
Fristablauf: der Python-Kern schreibt bei seinem Alarm selbst ein deny, und
die Shell-Huelle beendet einen haengenden Kern samt Prozessgruppe und
verweigert ebenfalls.

Drei Pruefungen, je nach Werkzeug:

  1. Write/Edit/NotebookEdit: NUR wenn die Rolle eine Schreibsperre traegt
     (WB_ROLLE == 'reviewer', ODER das Profilfeld schreibsperre: true) --
     erlaubt ist ausschliesslich der eine Ergebnispfad dieses Workers,
     bestimmt aus dessen Auftragsbuch auftraege.tsv (letzte Zeile, Spalte
     'result'; der Worker-Name kommt aus der tmux-Sitzung ueber
     lib/rollen.py) oder, falls das nichts liefert, aus WB_ERGEBNISPFAD. Der
     Pfad muss kanonisch (realpath) unter ~/.pi-workers/results/<worker>/
     liegen und darf selbst kein Symlink sein.
  2. Bash: IMMER, gegen das Feld 'bash' des Profils als ERLAUBNISLISTE. Jede
     Pipeline-Stufe jedes Teilbefehls muss auf ein Muster passen -- auch
     jede Stufe in $( ), Backticks, `<shell> -c`, eval, einem Here-Doc an
     eine Shell und hinter einem Wrapper (env, nice, nohup, command,
     builtin, exec, time, sudo, xargs). Ein Muster ohne `*` passt auf den
     Befehl selbst und auf ihn mit weiteren Argumenten, ein `*` steht fuer
     beliebigen Text ('git diff *'). Ein Muster, das einen Wrapper, eval,
     source oder einen nackten Interpreter freigeben wuerde, gibt NICHTS
     frei. Umleitungen > und >> sind Schreibwege und nur auf den
     Ergebnispfad erlaubt (und nach /dev/null). Ein leeres oder fehlendes
     'bash'-Feld erlaubt nichts.
  3. Skill: IMMER, gegen das Feld 'skills' des Profils -- nur die dort
     genannten Skills duerfen aufgerufen werden.

Die Bash-Zerlegung ist lib/cmdshell.py, dieselbe wie in bash-guard.py.
Grenze, offen benannt: ein Muster wie 'git diff *' gibt jedes Argument frei,
also auch eines, mit dem das Programm selbst schreibt (`git diff
--output=datei`) -- die Argumente eines erlaubten Programms prueft dieser
Hook nicht, das bleibt Sache des Musters.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_DIR = os.path.join(HOOKS_DIR, 'lib')
sys.path.insert(0, LIB_DIR)
import cmdshell as cs  # noqa: E402
import rollen  # noqa: E402

FRIST_SEKUNDEN = 7        # nach der wb-profil-Unterfrist, vor der Huelle (8 s)
UNTERFRIST_SEKUNDEN = 6

ROLLEN_MUSTER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
AUFGABE_MUSTER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
MAX_DEPTH = 4
IFS_EXPANSION_RE = re.compile(r'\$\{?IFS')
ZUWEISUNGS_BEFEHLE = {'export', 'declare', 'typeset', 'local', 'readonly'}
GENERISCHE_BEFEHLE = cs.WRAPPER_CMDS | {'xargs', 'eval', 'source', '.'}
HARMLOSE_ZIELE = {'/dev/null', '/dev/stdout', '/dev/stderr'}

_ausgegeben = False


# ------------------------------------------------------------- Fristen --
def _frist_abgelaufen(*_):
    if not _ausgegeben:
        try:
            os.write(1, (_deny_json(
                "Rollen-Sperre: Pruefung hat ihre Frist ueberschritten -- ohne "
                "Ergebnis bleibt der Zugriff gesperrt.") + '\n').encode())
        except OSError:
            pass
    os._exit(0)


def alarm_setzen():
    try:
        signal.signal(signal.SIGALRM, _frist_abgelaufen)
        signal.alarm(FRIST_SEKUNDEN)
    except (ValueError, OSError, AttributeError):
        pass


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


def _deny_json(reason):
    return json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': reason,
        }
    })


def print_deny(reason):
    global _ausgegeben
    _ausgegeben = True
    print(_deny_json(reason), flush=True)


# ---------------------------------------------------------- wb-profil ---
def profil_laden(rolle, base, projekt):
    wb = shutil.which('wb-profil')
    if not wb:
        return None
    args = ['zeigen', rolle, '--json', '--base', base]
    if projekt:
        args += ['--projekt', projekt]
    r = subprozess_frist(wb, args)
    if r is None or r.returncode != 0:
        return None
    try:
        daten = json.loads(r.stdout)
    except ValueError:
        return None
    frontmatter = daten.get('frontmatter') if isinstance(daten, dict) else None
    return frontmatter if isinstance(frontmatter, dict) else None


def hat_schreibsperre(rolle, profil):
    if rolle == 'reviewer':
        return True
    return bool(profil.get('schreibsperre'))


# ---------------------------------------------------- Ergebnispfad -----
def worker_name_aus_pane():
    pane = os.environ.get('TMUX_PANE', '')
    if not pane:
        return None
    try:
        fakten = rollen.pane_fakten(pane)
    except Exception:
        return None
    return (fakten or {}).get('sitzung') or None


def ergebnispfad_aus_auftragsbuch(name):
    """Letzte Zeile von ~/.pi-workers/results/<name>/auftraege.tsv, Spalte
    'result' (Format: ts, result, pane, harness, model, spawned -- siehe
    shell/pi-worker). ~ ist das echte $HOME des Hook-Prozesses."""
    if not name:
        return None
    buch = os.path.join(os.path.expanduser('~'), '.pi-workers', 'results', name, 'auftraege.tsv')
    letzte = None
    try:
        with open(buch, 'r', encoding='utf-8', errors='replace') as f:
            for zeile in f:
                zeile = zeile.rstrip('\n')
                if not zeile or zeile.startswith('#'):
                    continue
                letzte = zeile
    except OSError:
        return None
    if not letzte:
        return None
    felder = letzte.split('\t')
    if len(felder) < 2 or not felder[1].strip():
        return None
    return felder[1].strip()


def ergebnispfad_bestimmen():
    pfad = ergebnispfad_aus_auftragsbuch(worker_name_aus_pane())
    if pfad:
        return pfad
    umgebung = (os.environ.get('WB_ERGEBNISPFAD') or '').strip()
    return umgebung or None


def kanonischer_ergebnispfad(pfad, cwd):
    """Der kanonische Pfad (realpath), wenn er als Ergebnisdatei taugt,
    sonst None. Taugt heisst: sein Ordner existiert, er selbst ist kein
    Symlink, und er liegt unter ~/.pi-workers/results/<worker>/. `normpath`
    allein genuegt fuer eine Grenze nicht -- ein Symlink verlaesst den Baum,
    ohne dass sich die Schreibweise aendert."""
    if not isinstance(pfad, str) or not pfad.strip() or '\x00' in pfad:
        return None
    raw = os.path.expanduser(pfad)
    if not os.path.isabs(raw):
        if not cwd:
            return None
        raw = os.path.join(cwd, raw)
    if not os.path.isdir(os.path.dirname(raw)) or os.path.islink(raw):
        return None
    root = os.path.realpath(os.path.join(os.path.expanduser('~'), '.pi-workers', 'results'))
    result = os.path.realpath(raw)
    relative = os.path.relpath(result, root)
    parts = relative.split(os.sep)
    if len(parts) < 2 or parts[0] in ('.', '..'):
        return None
    if not ROLLEN_MUSTER.fullmatch(parts[0]):
        return None
    return result


# ------------------------------------------------------------- Bash -----
def muster_aufteilen(muster_liste):
    """(gueltige, generische) Muster. Generisch ist ein Muster, das einen
    Wrapper, xargs, eval oder source freigibt, oder einen Interpreter ohne
    engeres Argument ('bash', 'python3 *') -- es gaebe jeden Befehl frei."""
    gueltig, generisch = [], []
    for m in muster_liste:
        m = m.strip() if isinstance(m, str) else ''
        if not m:
            continue
        erstes = m.split()[0]
        name = erstes.split('/')[-1]
        rest = m[len(erstes):].strip()
        interpreter = name in cs.SHELL_INTERPRETERS or cs.interpreter_family(name)
        if name in GENERISCHE_BEFEHLE or (interpreter and rest in ('', '*')):
            generisch.append(m)
        else:
            gueltig.append(m)
    return gueltig, generisch


def muster_passt(text, muster):
    if '*' in muster:
        if muster.endswith(' *') and text == muster[:-2]:
            return True
        regex = '.*'.join(re.escape(teil) for teil in muster.split('*'))
        return re.fullmatch(regex, text, re.S) is not None
    return text == muster or text.startswith(muster + ' ')


class Rahmen:
    def __init__(self, muster, ergebnis, cwd):
        self.muster = muster
        self.ergebnis = ergebnis
        self.cwd = cwd


def _stufe_verstoss(raw_stage, rahmen, depth):
    for op, ziel in cs.output_redirections(raw_stage):
        if ziel in HARMLOSE_ZIELE:
            continue
        kanonisch = kanonischer_ergebnispfad(ziel or '', rahmen.cwd)
        if not kanonisch or kanonisch != rahmen.ergebnis:
            return ("Umleitung %s auf '%s' -- geschrieben werden darf nur der "
                    "Ergebnispfad" % (op, ziel or '?'))
    stage = cs.strip_redirections(raw_stage)
    name, _idx, remaining = cs.resolve_command(stage, {})
    if name in (cs.SUBSHELL_TOKEN, cs.PROCSUB_TOKEN):
        return None  # Stellvertreter der Zerlegung; ihr Inhalt ist eigene Anweisung
    if name is None:
        if any(t.startswith('IFS=') for t in stage):
            return "IFS-Aenderung ist nicht sicher aufloesbar"
        return None
    worte = [cs.resolve_vars(t, {}) for t in remaining]
    if name in ZUWEISUNGS_BEFEHLE and any(t.startswith('IFS=') for t in worte):
        return "IFS-Aenderung ist nicht sicher aufloesbar"
    if name == 'eval':
        if not remaining:
            return None
        v = bash_verstoss(' '.join(remaining), rahmen, depth + 1)
        return ("eval: %s" % v) if v else None
    if name in cs.SHELL_INTERPRETERS:
        hat_c, skript = cs.shell_c_script(worte)
        if hat_c:
            if skript is None:
                return "%s -c ohne Skript" % name
            v = bash_verstoss(skript, rahmen, depth + 1)
            return ("%s -c: %s" % (name, v)) if v else None
    if name == 'xargs':
        innen = cs.xargs_inner(worte) or ['echo']
        if depth >= MAX_DEPTH:
            return "Kommando zu tief verschachtelt"
        v = _stufe_verstoss(innen, rahmen, depth + 1)
        return ("xargs: %s" % v) if v else None
    text = ' '.join([name] + worte)
    if not any(muster_passt(text, m) for m in rahmen.muster):
        return "'%s' steht nicht im Bash-Muster" % text
    return None


def bash_verstoss(command, rahmen, depth=0):
    """None, wenn jede ausfuehrbare Stufe -- auch jede verschachtelte --
    von einem Muster gedeckt ist, sonst der Grund."""
    if depth > MAX_DEPTH:
        return "Kommando zu tief verschachtelt"
    if IFS_EXPANSION_RE.search(command):
        return "IFS-Expansion ist nicht sicher aufloesbar"
    teile = cs.heredoc_split(command)
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
        v = bash_verstoss(inner, rahmen, depth + 1)
        if v:
            return "Kommandosubstitution: %s" % v
    for b in teile.bodies:
        if not b['top']:
            continue
        kopf = cs.all_statements(b['prefix'])
        if not kopf or kopf[-1] is None or not cs.split_pipeline(kopf[-1]):
            return "Here-Doc ohne erkennbaren Empfaenger"
        name, _idx, rest = cs.resolve_command(cs.split_pipeline(kopf[-1])[-1], {})
        if name is None:
            return "Here-Doc ohne erkennbaren Empfaenger"
        if name in cs.SHELL_INTERPRETERS and not cs.shell_c_script(rest)[0] \
                and ('-s' in rest or not [t for t in rest if t and t[0] not in '-+']):
            v = bash_verstoss(b['body'], rahmen, depth + 1)
            if v:
                return "Here-Doc an %s: %s" % (name, v)

    leser = cs.process_substitution_script(teile.text)
    if leser:
        return ("%s liest sein Skript aus einer Prozess-Substitution <( ) -- was "
                "ausgefuehrt wird, steht erst zur Laufzeit fest" % leser)
    for stmt in cs.all_statements(teile.text):
        if stmt is None:
            return "Kommando nicht zerlegbar"
        for raw_stage in cs.split_pipeline(stmt, strip=False):
            v = _stufe_verstoss(raw_stage, rahmen, depth)
            if v:
                return v
    return None


# ------------------------------------------------------------- Logik ----
def main():
    alarm_setzen()
    eingabe = eingabe_lesen()

    tool_name = eingabe.get('tool_name')
    if tool_name not in ('Write', 'Edit', 'NotebookEdit', 'Bash', 'Skill'):
        return 0

    aufgabe = (os.environ.get('WB_AUFGABE_ID') or '').strip()
    if not aufgabe or not AUFGABE_MUSTER.fullmatch(aufgabe) or '..' in aufgabe:
        return 0  # keine Werkbank-Aufgabe -- dieser Hook greift nicht

    rolle = (os.environ.get('WB_ROLLE') or '').strip()
    if not rolle or not ROLLEN_MUSTER.fullmatch(rolle):
        return 0  # keine Rolle zugewiesen -- dieser Hook greift nicht

    base = os.environ.get('WB_AUFGABE_BASE') or os.path.expanduser('~')
    projekt = os.environ.get('WB_AUFGABE_PROJEKT') or None
    profil = profil_laden(rolle, base, projekt)
    if profil is None:
        print_deny(
            "Rollen-Sperre: Profil der Rolle '%s' laesst sich nicht lesen "
            "(wb-profil zeigen fehlgeschlagen) -- ohne lesbares Profil ist "
            "nichts erlaubt." % rolle)
        return 0

    tool_input = eingabe.get('tool_input') if isinstance(eingabe.get('tool_input'), dict) else {}
    cwd = str(eingabe.get('cwd') or '')

    if tool_name in ('Write', 'Edit', 'NotebookEdit'):
        if not hat_schreibsperre(rolle, profil):
            return 0
        ziel_roh = tool_input.get('file_path') or tool_input.get('notebook_path')
        if not isinstance(ziel_roh, str) or not ziel_roh.strip():
            return 0
        erlaubt = ergebnispfad_bestimmen()
        if not erlaubt:
            print_deny(
                "Rollen-Sperre: Rolle '%s' traegt eine Schreibsperre, aber kein "
                "Ergebnispfad ist bekannt (weder auftraege.tsv noch "
                "WB_ERGEBNISPFAD) -- kein Ziel ist erlaubt." % rolle)
            return 0
        erlaubt_norm = kanonischer_ergebnispfad(erlaubt, cwd)
        if not erlaubt_norm:
            print_deny(
                "Rollen-Sperre: Ergebnispfad '%s' liegt nicht kanonisch unter "
                "~/.pi-workers/results/<worker>/ oder ist ein Symlink -- kein "
                "Ziel ist erlaubt." % erlaubt)
            return 0
        if kanonischer_ergebnispfad(ziel_roh, cwd) == erlaubt_norm:
            return 0
        print_deny(
            "Rollen-Sperre: Rolle '%s' darf nur den Ergebnispfad schreiben ('%s'), "
            "nicht '%s'." % (rolle, erlaubt, ziel_roh))
        return 0

    if tool_name == 'Bash':
        command = tool_input.get('command')
        if not isinstance(command, str) or not command.strip():
            return 0
        roh = profil.get('bash') if isinstance(profil.get('bash'), list) else []
        muster, generisch = muster_aufteilen(roh)
        erlaubt = ergebnispfad_bestimmen()
        erlaubt_norm = kanonischer_ergebnispfad(erlaubt, cwd) if erlaubt else None
        verstoss = bash_verstoss(command, Rahmen(muster, erlaubt_norm, cwd))
        if verstoss is not None:
            hinweis = ''
            if generisch:
                hinweis = (" Die Profilmuster %s geben als generische Wrapper oder "
                           "Interpreter nichts frei." % ', '.join("'%s'" % g for g in generisch))
            print_deny(
                "Rollen-Sperre (Rolle '%s'): %s -- ohne Treffer wird verweigert.%s"
                % (rolle, verstoss, hinweis))
        return 0

    # tool_name == 'Skill'
    skill_name = tool_input.get('skill')
    if not isinstance(skill_name, str) or not skill_name.strip():
        print_deny(
            "Rollen-Sperre: Skill-Aufruf ohne erkennbaren Skill-Namen -- "
            "Rolle '%s' hat eine feste Skill-Liste, ohne Namen kein Treffer." % rolle)
        return 0
    erlaubte_skills = profil.get('skills') if isinstance(profil.get('skills'), list) else []
    if skill_name.strip() not in erlaubte_skills:
        print_deny(
            "Rollen-Sperre: Skill '%s' steht nicht in der Skill-Liste der Rolle "
            "'%s'." % (skill_name, rolle))
    return 0


if __name__ == '__main__':
    sys.exit(main())
