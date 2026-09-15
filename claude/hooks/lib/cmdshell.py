import re
import shlex

STATEMENT_SEPS = {';', '&', '&&', '||', ';;', ';&', ';;&'}

# Stellvertreter-Woerter, die die Zerlegung selbst einsetzt (Steuerzeichen,
# kann also kein Befehl je enthalten):
#   PROCSUB_TOKEN  steht dort, wo `<( … )` oder `>( … )` stand -- der Befehl
#                  darin wird zu eigenen Anweisungen, das Argument bleibt
#                  sichtbar.
#   SUBSHELL_TOKEN steht vor einer Pipe, deren linke Seite eine Unterschale
#                  war: `(a) | bash` ist eine Pipeline in bash, nicht ein
#                  nacktes bash.
PROCSUB_TOKEN = '\x02PROCSUB\x02'
SUBSHELL_TOKEN = '\x02SUBSHELL\x02'
WRAPPER_CMDS = {'command', 'exec', 'builtin', 'nohup', 'sudo', 'env', 'nice', 'time'}
# `xargs` steht bewusst NICHT in WRAPPER_CMDS: kill_pattern_classify erkennt
# `pgrep ... | xargs kill` gerade am Namen `xargs` (Fall G15 in
# test-hooks.sh). Wer den inneren Befehl braucht, holt ihn mit xargs_inner().

# Optionen eines Wrappers, die ein EIGENES Argument mitnehmen. Ohne diese
# Liste wurde aus `nice -n 5 pkill -f x` der Befehl `5` und aus
# `env -u FOO pkill -f x` der Befehl `FOO` -- gemessen 2026-09-11: beide
# gingen an bash-guard vorbei, obwohl der nackte Befehl blockiert.
WRAPPER_ARG_OPTS = {
    'env': {'-u', '--unset', '-C', '--chdir', '-P'},
    'nice': {'-n', '--adjustment'},
    'sudo': {'-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
             '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T',
             '--command-timeout', '-U', '--other-user', '-r', '--role', '-t', '--type'},
    'exec': {'-a'},
    'time': {'-f', '--format', '-o', '--output'},
}


def wrapper_option_width(wrapper, token):
    """Wie viele Tokens eine Wrapper-Option belegt: 2, wenn sie ein
    eigenes Argument mitnimmt (`nice -n 5`), sonst 1."""
    return 2 if token in WRAPPER_ARG_OPTS.get(wrapper, ()) else 1


SHELL_INTERPRETERS = {'bash', 'sh', 'zsh', 'dash', 'ksh'}

# Woerter, die einen Block EINLEITEN oder BEENDEN und vor dem eigentlichen
# Kommando stehen. Sie wurden bis 2026-08-05 als das Kommando selbst gelesen:
# aus `for x in a; do pkill -f wb-; done` wurde ein Aufruf von `do`, und weil
# kein Guard ein Kommando namens `do` kennt, war der Rumpf jeder Schleife und
# jeder Bedingung fuer ALLE Guards unsichtbar. Gemessen am 2026-08-05: sowohl
# `for x in a; do pkill -f wb-; done` als auch `if true; then pkill -f wb-; fi`
# gingen glatt durch, obwohl der nackte Befehl blockiert.
# `for`/`while`/`until`/`if`/`case` stehen bewusst NICHT hier: sie tragen die
# Bedingung bzw. die Werteliste, und _check_for_loop erkennt eine for-Schleife
# an genau diesem ersten Token.
BLOCK_KEYWORDS = {'do', 'then', 'else', 'elif', 'done', 'fi', 'esac', '{', '}', '!'}


def strip_heredocs(command):
    # Ohne das wird der INHALT eines `cat > datei <<EOF ... EOF` als Folge von
    # Befehlen gelesen: eine Dokumentationszeile, die 'rm -rf ...' als Beispiel
    # zeigt, loeste sonst einen Deny aus, obwohl dort nur Text geschrieben wird.
    # Und ein Apostroph im Text ("don't") sah wie eine unausgeglichene
    # Anfuehrung aus, worauf das ganze Kommando als unzerlegbar galt.
    # Stand hier bis 2026-08-05 nur in snapshot_classify.py — jetzt gemeinsam,
    # damit jeder Guard denselben Text zerlegt.
    return heredoc_split(command).text


_HEREDOC_OP_RE = re.compile(r'<<(-?)[ \t]*(\\?)([\'"]?)([A-Za-z_][A-Za-z0-9_]*)\3')


class HeredocSplit:
    """Ergebnis von heredoc_split().

    text       -- der Befehl ohne JEDEN Here-Doc-Rumpf (wie strip_heredocs
                  es seit jeher liefert),
    text_subs  -- der Befehl ohne die Ruempfe, die NICHT in einer
                  `$( … )`-Substitution stehen: wer eine Substitution
                  rekursiv prueft, braucht ihren Here-Doc samt Rumpf,
    bodies     -- je Here-Doc ein dict(body, quoted, prefix, top); prefix ist
                  der Text des einfachen Befehls bis zum `<<`, also der
                  Befehl, der den Rumpf auf stdin bekommt,
    complete   -- False, wenn ein Here-Doc keinen Abschluss hat.
    """
    def __init__(self, text, text_subs, bodies, complete):
        self.text = text
        self.text_subs = text_subs
        self.bodies = bodies
        self.complete = complete


def heredoc_split(command):
    # Bis 2026-09-11 suchte die Erkennung `<<WORT` per Regex in JEDER Zeile,
    # ohne auf Anfuehrung, Kommentar oder Here-String zu achten, und
    # verschluckte danach alle Zeilen bis zu einer Zeile WORT -- ohne
    # Abschluss also den ganzen Rest. Gemessen am 2026-09-11 gegen
    # bash-guard.py: `echo "<<X"`, `true # <<X` und der Here-String
    # `cat <<< x`, jeweils mit `pkill -f wb-` in der naechsten Zeile, gingen
    # alle drei durch -- die zweite Zeile war fuer jeden Guard unsichtbar,
    # obwohl bash sie ausfuehrt.
    # Jetzt zaehlt `<<` nur ungequotet, ausserhalb eines Kommentars und nicht
    # als `<<<`. Fehler dieses Scanners fallen in die sichere Richtung: ein
    # nicht erkannter Here-Doc laesst seine Rumpfzeilen als Befehle stehen
    # (mehr Pruefung), nur ein falsch erkannter wuerde Befehle verstecken.
    out_all, out_subs, bodies, pending = [], [], [], []
    state = {'len': 0}

    def emit(s):
        out_all.append(s)
        out_subs.append(s)
        state['len'] += len(s)

    in_single = in_double = False
    stack = []          # 'dq' = `$(` in doppelten Anfuehrungszeichen, 'sub', 'paren'
    seg_start = 0       # Beginn des aktuellen einfachen Befehls in out_all
    complete = True
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if in_single:
            emit(ch)
            i += 1
            if ch == "'":
                in_single = False
            continue
        if ch == '\\' and i + 1 < n:
            emit(command[i:i + 2])
            i += 2
            continue
        if in_double:
            if ch == '"':
                in_double = False
            elif command.startswith('$(', i):
                stack.append('dq')
                in_double = False
                emit('$(')
                i += 2
                seg_start = state['len']
                continue
            emit(ch)
            i += 1
            continue
        if ch == "'":
            in_single = True
        elif ch == '"':
            in_double = True
        elif command.startswith('$(', i):
            stack.append('sub')
            emit('$(')
            i += 2
            seg_start = state['len']
            continue
        elif ch == '(':
            stack.append('paren')
            emit(ch)
            i += 1
            seg_start = state['len']
            continue
        elif ch == ')':
            if stack and stack.pop() == 'dq':
                in_double = True
            emit(ch)
            i += 1
            seg_start = state['len']
            continue
        elif ch == '#' and (i == 0 or command[i - 1] in ' \t\n;&|()'):
            j = command.find('\n', i)
            j = n if j == -1 else j
            emit(command[i:j])
            i = j
            continue
        elif command.startswith('<<<', i):
            emit('<<<')
            i += 3
            continue
        elif command.startswith('<<', i):
            m = _HEREDOC_OP_RE.match(command, i)
            if m:
                pending.append({'delim': m.group(4),
                                'quoted': bool(m.group(2) or m.group(3)),
                                'prefix': ''.join(out_all)[seg_start:],
                                'top': not stack})
                emit(m.group(0))
                i = m.end()
                continue
            emit('<<')
            i += 2
            continue
        elif ch in ';&|':
            emit(ch)
            i += 1
            seg_start = state['len']
            continue
        elif ch == '\n':
            emit(ch)
            i += 1
            seg_start = state['len']
            for p in pending:
                body_start, lines, closed = i, [], False
                while i < n:
                    j = command.find('\n', i)
                    line_end = n if j == -1 else j
                    line = command[i:line_end]
                    i = n if j == -1 else j + 1
                    if line.strip() == p['delim']:
                        closed = True
                        break
                    lines.append(line)
                if not p['top']:
                    out_subs.append(command[body_start:i])
                complete = complete and closed
                p['body'] = '\n'.join(lines)
                bodies.append(p)
            pending = []
            continue
        emit(ch)
        i += 1
    for p in pending:  # `<<X` in der letzten Zeile, ohne Rumpf und Abschluss
        complete = False
        p['body'] = ''
        bodies.append(p)
    return HeredocSplit(''.join(out_all), ''.join(out_subs), bodies, complete)


_SUB_PLACEHOLDER = '\x01SUB%d\x01'
_SUB_PLACEHOLDER_RE = re.compile('\x01SUB([0-9]+)\x01')


def _protect_substitutions(command):
    # shlex trennt an Leerzeichen — eine Kommandosubstitution wie
    # `$(mktemp -d)` zerfiel dadurch in die Tokens `$(mktemp` und `-d)`, und
    # jede darauf aufbauende Pruefung sah zwei sinnlose Bruchstuecke statt
    # eines Ausdrucks. Genau daran scheiterte am 2026-08-04 ein harmloses
    # `echo ... > "$P/datei"` mit `P=$(mktemp -d)`: die Zuweisung landete als
    # `P=$(mktemp` in der Variablenkarte.
    # Hier wird jede balancierte Substitution vor dem Tokenisieren durch einen
    # Platzhalter OHNE Leerzeichen ersetzt und danach wieder eingesetzt — der
    # Ausdruck bleibt ein Token und damit als Ganzes beurteilbar.
    # Unbalanciert (kein schliessendes Zeichen) bleibt unangetastet: dann ist
    # der Text ohnehin nicht sauber zerlegbar, und die bisherige Behandlung
    # gilt unveraendert weiter.
    subs = []
    out = []
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if ch == '$' and i + 1 < n and command[i + 1] == '(':
            end = _match_paren(command, i + 1)
            if end is not None:
                subs.append(command[i:end + 1])
                out.append(_SUB_PLACEHOLDER % (len(subs) - 1))
                i = end + 1
                continue
        elif ch == '`':
            end = command.find('`', i + 1)
            if end != -1:
                subs.append(command[i:end + 1])
                out.append(_SUB_PLACEHOLDER % (len(subs) - 1))
                i = end + 1
                continue
        out.append(ch)
        i += 1
    return ''.join(out), subs


def _match_paren(text, open_idx):
    depth = 0
    i, n = open_idx, len(text)
    while i < n:
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _restore_substitutions(token, subs):
    if '\x01' not in token:
        return token
    return _SUB_PLACEHOLDER_RE.sub(lambda m: subs[int(m.group(1))], token)


def _quote_aware_prepass(command):
    # Turns every unquoted, unescaped real newline into ';' (a bash newline
    # ends a statement just like ';' does) and consumes backslash+newline as
    # a line continuation (also only when not inside single quotes, where
    # bash treats backslash as a plain character). Newlines and backslashes
    # INSIDE a quote are left untouched -- a multi-line quoted string (a
    # heredoc-free `bash -c '...\n...'`, for example) must stay one token,
    # not look like several statements or an unbalanced quote.
    out = []
    in_single = in_double = False
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if not in_single and ch == '\\' and i + 1 < n:
            nxt = command[i + 1]
            if nxt == '\n':
                i += 2
                continue
            out.append(ch)
            out.append(nxt)
            i += 2
            continue
        if not in_double and ch == "'":
            in_single = not in_single
            out.append(ch)
            i += 1
            continue
        if not in_single and ch == '"':
            in_double = not in_double
            out.append(ch)
            i += 1
            continue
        if not in_single and not in_double and ch == '#' and (not out or out[-1] in ' \t;&|'):
            # Ein Kommentar endet am Zeilenende. Hier wird dieses Zeilenende
            # gleich zu ';' -- shlex las den Kommentar danach bis zum Ende des
            # GANZEN Befehls und verschluckte jede folgende Zeile. Gemessen
            # 2026-09-11: `true # x` + Zeilenumbruch + `pkill -f wb-` ging an
            # bash-guard vorbei. Deshalb faellt der Kommentar hier weg, und
            # tokenize() liest '#' nicht mehr als Kommentarzeichen.
            j = command.find('\n', i)
            i = n if j == -1 else j
            continue
        if not in_single and not in_double and ch == '\n':
            out.append(';')
            i += 1
            continue
        if (not in_single and not in_double and ch == '(' and out and out[-1] in '<>'
                and (len(out) < 2 or out[-2] not in '<>')):
            # Prozess-Substitution `<( … )` / `>( … )`: der Befehl darin wird
            # wie bei jeder Klammer zu eigenen Anweisungen, aber an seiner
            # Stelle bleibt ein Argument stehen. Bis 2026-09-11 frass
            # strip_redirections() das uebrige `<`, und `bash <(printf 'rm x')`
            # sah aus wie ein nacktes `bash`, das von stdin liest.
            out[-1] = ' ' + PROCSUB_TOKEN
            out.append(';')
            i += 1
            continue
        if not in_single and not in_double and ch in '()':
            # Eine Unterschale ist eine Befehlsgrenze, genau wie ';' -- bash
            # liest `( rm -rf x )` als eine Liste in einer Unterschale, nicht
            # als Aufruf eines Befehls namens '('. Genau das tat diese
            # Zerlegung aber bis 2026-08-05: '(' wurde zum Befehlsnamen, der
            # eigentliche Befehl rutschte ins Argument, und resolve_command()
            # lieferte etwas, das kein Guard mehr erkennt.
            # Gemessen am 2026-08-05 gegen den echten Guard-Verlauf (73 real
            # abgelehnte Befehle): 49 davon liefen in `( C )` durch, 57 in der
            # geklebten Form `(C)` -- betroffen waren kill-pattern, push-gate,
            # screencapture, snapshot und die Rueckfrage-Stufe, also jeder
            # Guard, der ueber diese Datei zerlegt.
            #
            # Warum ';' und nicht ein weiterer Eintrag in BLOCK_KEYWORDS (das
            # war der naheliegende Weg, er reicht aber nicht):
            #   - `(rm -rf /x)` ohne Leerzeichen ergibt die Tokens '(rm' und
            #     '/x)'. Ein Schluesselwort '(' trifft davon keines, und der
            #     Pfad traegt eine Klammer, die nicht zu ihm gehoert.
            #   - `(cd /tmp && rm -rf /x)` findet zwar 'rm', beurteilt aber
            #     '/x)' statt '/x' -- ein anderer Pfad als der geloeschte.
            #   - `cat <(ls /x)` verschwand ganz: strip_redirections() frass
            #     '<(ls', und der innere Befehl war unsichtbar.
            # Als Trennzeichen loesen sich alle drei Faelle mit derselben
            # Zeile, und es bleibt kein Klammer-Token als Schein-Argument
            # stehen.
            #
            # NUR unquoted und unescaped: `echo "(nicht ausgefuehrt)"`,
            # `echo '(x)'` und `find . \( -name a -o -name b \)` behalten ihre
            # Klammer als Text bzw. als Argument. Nach dem Tokenisieren waere
            # das nicht mehr unterscheidbar -- shlex wirft die Anfuehrung weg
            # -- deshalb sitzt die Entscheidung hier, im quote-bewussten
            # Vorlauf, und nicht spaeter.
            #
            # `$( … )`, `$(( … ))` und Backticks erreichen diese Stelle nie:
            # _protect_substitutions() hat sie vorher durch einen Platzhalter
            # ersetzt. Was uebrig bleibt, ist eine UNBALANCIERTE Substitution,
            # und die faellt damit in Bruchstuecke mit einem nackten '$' --
            # also in genau die unaufloesbare Form, die die Guards ohnehin
            # fail-closed behandeln.
            out.append(';')
            i += 1
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def tokenize(text):
    # '&' is deliberately NOT a punctuation char: shlex would then split
    # inside plain redirections like `2>&1` (no whitespace around the '&'),
    # corrupting an everyday, harmless construct. `&&` still works fine as
    # its own token whenever it appears with the usual surrounding
    # whitespace, which is the only form worth recognizing here.
    lexer = shlex.shlex(text, posix=True, punctuation_chars=';|')
    lexer.whitespace_split = True
    lexer.commenters = ''  # Kommentare entfernt schon _quote_aware_prepass()
    toks = []
    try:
        for t in lexer:
            toks.append(t)
    except ValueError:
        return None
    return _trenner_normalisieren(toks)


def _trenner_normalisieren(toks):
    # shlex fasst aufeinanderfolgende Satzzeichen zu EINEM Token zusammen.
    # Aus der leeren Klammer einer Funktionsdefinition `f(){ rm x; }` wurde im
    # Vorlauf `f;;{ rm x; }`, und das Token `;;` trennte nichts: `rm x` war
    # nur noch ein Argument von `f` -- gemessen 2026-09-11 gegen kill-pattern,
    # push-gate und testschutz. Genauso wurde aus `(a)|bash` das Token `;|`.
    # Jede Folge aus ';' und '|' wird hier in ihre echten Trenner zerlegt.
    out = []
    for t in toks:
        if len(t) > 1 and t != '||' and set(t) <= {';', '|'}:
            for teil in re.findall(r';+|\|\||\|', t):
                out.append(';' if teil.startswith(';') else teil)
        else:
            out.append(t)
    return out


def split_statements(tokens):
    stmts, cur = [], []
    for t in tokens:
        if t in STATEMENT_SEPS:
            stmts.append(cur)
            cur = []
        else:
            cur.append(t)
    stmts.append(cur)
    # Eine Anweisung, die mit '|' beginnt, hatte links eine Unterschale, deren
    # ')' zum Trenner wurde. Der Stellvertreter haelt die Pipeline zweistufig.
    return [[SUBSHELL_TOKEN] + s if s[0] == '|' else s for s in stmts if s]


_REDIRECT_RE = re.compile(r'^(&|[0-9]+)?(>>?|<<?<?|>&|&>>?)')
_REDIRECT_ONLY_RE = re.compile(r'^(&|[0-9]+)?(>>?|<<?<?|>&|&>>?)$')


def strip_redirections(tokens):
    # `2>&1`, `2>/dev/null`, `> out.log` etc. are shell redirections, not
    # arguments the command itself ever sees -- left in, they make an
    # everyday `kill -9 1234 2>&1` look like it has a suspicious extra
    # argument. Handles both the glued form (redirect+target as one token)
    # and the spaced form (operator and target as two tokens).
    out = []
    skip_next = False
    for t in tokens:
        if skip_next:
            skip_next = False
            continue
        if _REDIRECT_RE.match(t):
            if _REDIRECT_ONLY_RE.match(t):
                skip_next = True
            continue
        out.append(t)
    return out


def split_pipeline(tokens, *, strip=True):
    stages, cur = [], []
    for t in tokens:
        if t == '|':
            stages.append(strip_redirections(cur) if strip else cur)
            cur = []
        else:
            cur.append(t)
    stages.append(strip_redirections(cur) if strip else cur)
    return [s for s in stages if s]


def output_redirections(stage_tokens):
    """Return ``(operator, target)`` for stdout-writing redirections.

    ``tokenize`` already understands shell quoting, so this extraction shares
    its token stream instead of each permission hook regex-parsing Bash.
    Missing targets stay visible as ``None`` for fail-closed callers.
    """
    found = []
    i = 0
    while i < len(stage_tokens):
        token = stage_tokens[i]
        match = re.match(r'^(?:[0-9]+)?(>>?|&>>?)(.*)$', token)
        if not match:
            i += 1
            continue
        op, rest = match.group(1), match.group(2)
        if rest == '&':
            # `2>& 1`: das naechste Token ist ein Deskriptor, keine Datei.
            i += 2
            continue
        if re.fullmatch(r'&(?:[0-9]+-?|-)', rest):
            i += 1  # `2>&1`, `>&2`, `>&-` -- Deskriptor, keine Datei
            continue
        if rest.startswith('&'):
            rest = rest[1:]  # `>&datei` schreibt stdout und stderr in datei
        if rest:
            found.append((op, rest))
        elif i + 1 < len(stage_tokens):
            found.append((op, stage_tokens[i + 1]))
            i += 1
        else:
            found.append((op, None))
        i += 1
    return found


def all_statements(command):
    # [None] marks a command that could not be tokenized at all (a genuinely
    # unbalanced quote) -- callers must treat that as unresolvable, not as
    # "nothing found".
    statements = _statements(command)
    if statements is None:
        return [None]
    # Eine Shell oder ein Interpreter, der eine Prozess-Substitution als
    # Skript liest (`bash <(printf 'rm x')`, `source <(…)`), fuehrt die
    # AUSGABE des inneren Befehls aus -- was das ist, steht erst zur Laufzeit
    # fest. Fuer jeden Guard ist das unzerlegbar, also [None].
    if _procsub_script_consumer(statements):
        return [None]
    return statements


def _statements(command):
    protected, subs = _protect_substitutions(command)
    toks = tokenize(_quote_aware_prepass(protected))
    if toks is None:
        return None
    if subs:
        toks = [_restore_substitutions(t, subs) for t in toks]
    return expand_literal_for_loops(split_statements(toks))


SCRIPT_READERS = SHELL_INTERPRETERS | {'source', '.'}


def _procsub_script_consumer(statements):
    for stmt in statements:
        for stage in split_pipeline(stmt, strip=False):
            if not any(PROCSUB_TOKEN in t for t in stage):
                continue
            name = resolve_command(strip_redirections(stage), {})[0]
            if name in SCRIPT_READERS or interpreter_family(name):
                return name
    return None


def process_substitution_script(command):
    """Name der Shell oder des Interpreters, der in `command` eine
    Prozess-Substitution als Skript liest, sonst None. all_statements()
    liefert fuer so einen Befehl [None]; hiermit kann ein Pruefer die Form
    beim Namen nennen."""
    statements = _statements(command)
    return _procsub_script_consumer(statements) if statements else None


def command_substitutions(command, quotes=True):
    """(innere Befehle, vollstaendig) aller `$( … )`- und Backtick-
    Substitutionen, ohne sie auszufuehren.

    In doppelten Anfuehrungszeichen laufen Substitutionen weiter, in
    einfachen nicht; ein `'` in doppelten Anfuehrungszeichen ist nur ein
    Zeichen. quotes=False ist fuer den Rumpf eines ungequoteten Here-Docs:
    dort gibt es keine Anfuehrung, jedes `$(` laeuft. `$(( … ))` ist
    Arithmetik -- kein Befehl, aber darin stehende Substitutionen zaehlen.
    Eine offene Substitution meldet vollstaendig=False, damit Pruefer
    fail-closed verweigern koennen, statt sie als Text zu lesen.
    """
    found = []
    i, n = 0, len(command)
    in_single = in_double = False
    while i < n:
        ch = command[i]
        if in_single:
            if ch == "'":
                in_single = False
            i += 1
            continue
        if ch == '\\':
            i += 2
            continue
        if quotes and ch == "'" and not in_double:
            in_single = True
            i += 1
            continue
        if quotes and ch == '"':
            in_double = not in_double
            i += 1
            continue
        if command.startswith('$((', i):
            end = _match_paren(command, i + 1)
            if end is not None and command[end - 1] == ')' and _match_paren(command, i + 2) == end - 1:
                inner, ok = command_substitutions(command[i + 3:end - 1], quotes)
                if not ok:
                    return found, False
                found.extend(inner)
                i = end + 1
                continue
        if ch == '$' and i + 1 < n and command[i + 1] == '(':
            end = _match_paren(command, i + 1)
            if end is None:
                return found, False
            found.append(command[i + 2:end])
            i = end + 1
            continue
        if ch == '`':
            end = i + 1
            while end < n:
                if command[end] == '\\':
                    end += 2
                    continue
                if command[end] == '`':
                    break
                end += 1
            if end >= n:
                return found, False
            found.append(command[i + 1:end])
            i = end + 1
            continue
        i += 1
    return found, True


def shell_c_script(args):
    """(hat_c, skript) fuer die Argumente einer Shell: hat_c ist True, sobald
    irgendeine kurze Option ein `c` traegt (`-c`, `-lc`, `-ec`), skript ist
    dann das erste Nicht-Options-Argument -- oder None, wenn es fehlt. Bis
    2026-09-11 erkannten die Pruefer nur ein `-c` an erster Stelle; `bash -lc
    'rm …'` lief an ihnen vorbei."""
    has_c, i = False, 0
    while i < len(args):
        t = args[i]
        if t == '--':
            i += 1
            break
        if t.startswith('--'):
            i += 1
            continue
        if len(t) > 1 and t[0] in '-+':
            if 'c' in t[1:]:
                has_c = True
            i += 2 if t in ('-o', '+o', '-O', '+O') else 1
            continue
        break
    if not has_c:
        return False, None
    return True, (args[i] if i < len(args) else None)


_INTERP_CODE_LETTERS = {'python': 'c', 'perl': 'eE', 'ruby': 'e', 'node': 'ep'}
_INTERP_ARG_OPTS = {'python': {'-W', '-X'}, 'perl': set(), 'ruby': {'-I', '-r'},
                    'node': {'-r', '--require', '--import', '--loader'}}
# Buchstaben, nach denen der Rest einer Optionsgruppe ein Wert ist (`-i.bak`).
_INTERP_GLUE_STOP = {'python': '', 'perl': 'iMIFmlx0dDC', 'ruby': 'iIrxEFCKTWl0', 'node': ''}


def interpreter_family(name):
    if re.fullmatch(r'python[0-9.]*', name or ''):
        return 'python'
    if re.fullmatch(r'perl[0-9.]*', name or ''):
        return 'perl'
    if name in ('ruby', 'node', 'nodejs'):
        return 'ruby' if name == 'ruby' else 'node'
    return None


def interpreter_program(name, args):
    """Woher ein Interpreter sein Programm nimmt: ('code', [texte]) fuer
    `-c`/`-e`/`--eval`, ('datei', []) fuer ein Skript oder `-m modul`,
    ('stdin', []) ohne beides, ('unklar', texte), wenn eine Code-Option ihr
    Argument nicht hat. None fuer ein Programm, das kein Interpreter ist."""
    fam = interpreter_family(name)
    if fam is None:
        return None
    codes, i = [], 0
    while i < len(args):
        t = args[i]
        if t == '--':
            i += 1
            break
        if fam == 'node' and t.split('=', 1)[0] in ('--eval', '--print'):
            if '=' in t:
                codes.append(t.split('=', 1)[1])
                i += 1
                continue
            if i + 1 >= len(args):
                return 'unklar', codes
            codes.append(args[i + 1])
            i += 2
            continue
        if t in _INTERP_ARG_OPTS[fam]:
            i += 2
            continue
        if fam == 'python' and t == '-m':
            return 'datei', codes
        if t.startswith('--'):
            i += 1
            continue
        if t.startswith('-') and len(t) > 1:
            naechstes = False
            for j in range(1, len(t)):
                c = t[j]
                if c in _INTERP_CODE_LETTERS[fam]:
                    if t[j + 1:]:
                        codes.append(t[j + 1:])
                    else:
                        naechstes = True
                    break
                if c in _INTERP_GLUE_STOP[fam]:
                    break
            if naechstes:
                if i + 1 >= len(args):
                    return 'unklar', codes
                codes.append(args[i + 1])
                i += 2
            else:
                i += 1
            if fam == 'python' and codes:
                break  # nach -c beginnt bei python argv
            continue
        break
    if codes:
        return 'code', codes
    if i < len(args) and args[i] != '-':
        return 'datei', codes
    return 'stdin', codes


_XARGS_ARG_OPTS = {'-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '-E', '-d', '-a',
                   '--arg-file', '--delimiter', '--max-args', '--max-procs',
                   '--max-lines', '--replace', '--eof', '--max-chars'}


def xargs_inner(args):
    """Die Tokens des Befehls, den `xargs <args>` ausfuehrt (ohne die
    xargs-Optionen); leer, wenn xargs nur `echo` ausfuehren wuerde."""
    i = 0
    while i < len(args):
        t = args[i]
        if t == '--':
            i += 1
            break
        if t in _XARGS_ARG_OPTS:
            i += 2
            continue
        if t.startswith('-'):
            i += 1
            continue
        break
    return args[i:]


def collect_assignments(statements):
    varmap = {}
    for stmt in statements:
        if not stmt:
            continue
        for tok in stmt:
            m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', tok)
            if not m:
                continue
            varmap[m.group(1)] = m.group(2)
    return varmap


def assignment_prefixes(statements, base=None):
    # Liefert eine Liste: prefixes[i] kennt genau die Zuweisungen aus den
    # Teilbefehlen 0..i, nicht die aus spaeteren.
    #
    # collect_assignments() sammelt ueber den GANZEN Befehl und beantwortet
    # damit die falsche Frage. In `rm -rf $D/unterordner; D=/tmp/x` ist $D an
    # der Stelle, an der geloescht wird, noch leer -- die Zeile loescht
    # /unterordner, nicht /tmp/x/unterordner. Die alte Karte loeste $D
    # trotzdem auf und beurteilte einen Pfad, den es zur Laufzeit nie gibt.
    # Falsch in die gefaehrliche Richtung, deshalb positionsgebunden.
    #
    # Die Zuweisungen des Teilbefehls SELBST bleiben enthalten (i inklusive):
    # `D=/tmp/x; rm -rf "$D"` ist eine Zuweisung im eigenen Teilbefehl, und
    # das war schon immer das erlaubte, gemeinte Muster.
    out = []
    varmap = dict(base) if base else {}
    for stmt in statements:
        if stmt:
            for tok in stmt:
                m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', tok)
                if m:
                    varmap[m.group(1)] = m.group(2)
        out.append(dict(varmap))
    return out


_LOOP_OPENERS = ('for', 'while', 'until')
MAX_LOOP_VALUES = 64
MAX_EXPANDED_STATEMENTS = 512


def _is_literal_word(word):
    # Literal heisst: der Wert steht DA. Keine Variable, keine Substitution,
    # kein Glob, keine Klammer-Expansion -- sonst entscheidet erst die Laufzeit.
    if not word:
        return False
    if '$' in word or '`' in word:
        return False
    return not any(c in word for c in '*?[{')


def _parse_for_loop(statements, i):
    # (name, werte, rumpf_statements, index_des_done) oder None.
    stmt = statements[i]
    if len(stmt) < 4 or stmt[0] != 'for' or stmt[2] != 'in':
        return None
    name = stmt[1]
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', name):
        return None
    values = stmt[3:]
    if not values or len(values) > MAX_LOOP_VALUES:
        return None
    if not all(_is_literal_word(v) for v in values):
        return None
    depth, j, body = 1, i + 1, []
    while j < len(statements):
        s = statements[j]
        if s and s[0] in _LOOP_OPENERS:
            depth += 1
        if s and 'done' in s:
            depth -= 1
            if depth == 0:
                return name, values, body, j
        body.append(s)
        j += 1
    return None


def expand_literal_for_loops(statements):
    # Eine for-Schleife mit rein literaler Werteliste nennt ihre Werte
    # vollstaendig -- das ist nicht unentscheidbar, sondern nur noch nicht
    # gelesen. Der Rumpf wird deshalb je Wert einmal eingesetzt, und jede
    # dieser Fassungen durchlaeuft danach die normalen Pruefungen. Blockt eine
    # davon, blockt der ganze Befehl.
    # Der Rumpf mit der noch unaufgeloesten Schleifenvariablen wird durch die
    # Fassungen ERSETZT, nicht ergaenzt -- sonst haette jede Schleife weiterhin
    # den Deny "Ziel aus einer nicht aufloesbaren Variablen" ausgeloest.
    # Eine Liste mit Expansion (`*.sh`, `$(ls)`) bleibt unangetastet und damit
    # unentscheidbar.
    out, i, n = [], 0, len(statements)
    while i < n:
        parsed = _parse_for_loop(statements, i) if statements[i] else None
        if parsed is None:
            out.append(statements[i])
            i += 1
            continue
        name, values, body, done_at = parsed
        if len(out) + len(values) * len(body) > MAX_EXPANDED_STATEMENTS:
            out.extend(statements[i:done_at + 1])
            i = done_at + 1
            continue
        out.append(statements[i])
        for value in values:
            for stmt in body:
                out.append([resolve_vars(t, {name: value}) for t in stmt])
        out.append(statements[done_at])
        i = done_at + 1
    return out


def resolve_vars(word, varmap, depth=0):
    if depth > 6:
        return word

    def repl(m):
        return varmap.get(m.group(1), m.group(0))

    new = re.sub(r'\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?', repl, word)
    return resolve_vars(new, varmap, depth + 1) if new != word else new


_UNRESOLVED_PART_RE = re.compile(
    r'\$\([^)]*\)|`[^`]*`|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[!$#?*@0-9]')


def unresolved_to_wildcard(word):
    # Macht aus einem Wort mit unaufgeloesten Anteilen ein fnmatch-Muster:
    # jeder unbekannte Anteil wird '*', der literale Rest bleibt stehen.
    # Damit laesst sich fragen "KANN dieses Wort ueberhaupt <x> sein?", statt
    # jedes Wort mit einem '$' darin pauschal als unentscheidbar zu behandeln.
    # `wbtest-$$` wird zu `wbtest-*` und kann damit nachweislich nicht
    # `default` sein; ein blankes `$S` wird zu `*` und bleibt unentscheidbar.
    escaped = []
    pos = 0
    for m in _UNRESOLVED_PART_RE.finditer(word):
        escaped.append(_fnmatch_literal(word[pos:m.start()]))
        escaped.append('*')
        pos = m.end()
    escaped.append(_fnmatch_literal(word[pos:]))
    return ''.join(escaped)


def _fnmatch_literal(text):
    return text.replace('[', '[[]').replace('*', '[*]').replace('?', '[?]')


def var_name_if_bare_ref(token):
    m = re.match(r'^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$', token)
    return m.group(1) if m else None


def resolve_command(stage_tokens, varmap):
    # returns (resolved_name, index_of_command_token, remaining_raw_tokens) or
    # (None, len(stage_tokens), []) if the stage is only assignments/empty.
    i, n = 0, len(stage_tokens)
    wrapper = None
    while i < n:
        raw = stage_tokens[i]
        if raw in BLOCK_KEYWORDS:
            i += 1
            continue
        if raw == 'function' and not wrapper:
            i += 2  # `function f { rm x; }` -- Schluesselwort und Name
            continue
        if raw == 'coproc' and not wrapper:
            # `coproc pkill …` und `coproc NAME { pkill …; }` -- gemessen
            # 2026-09-11: beide gingen an bash-guard vorbei.
            i += 2 if i + 2 < n and stage_tokens[i + 2] == '{' else 1
            continue
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', raw):
            i += 1
            continue
        if wrapper and raw.startswith('-'):
            if wrapper == 'env' and (raw in ('-S', '--split-string')
                                     or raw.startswith('--split-string=')
                                     or (raw.startswith('-S') and not raw.startswith('--'))):
                # `env -S 'rm x'` teilt die Zeichenkette selbst in Woerter --
                # der Befehl steht IN dem Argument, nicht dahinter.
                if raw in ('-S', '--split-string'):
                    if i + 1 >= n:
                        return 'env', i, []
                    text, rest, idx = stage_tokens[i + 1], stage_tokens[i + 2:], i + 1
                else:
                    text = raw.split('=', 1)[1] if raw.startswith('--') else raw[2:]
                    rest, idx = stage_tokens[i + 1:], i
                try:
                    teile = shlex.split(text)
                except ValueError:
                    return text, idx, rest
                name, _sub_idx, remaining = resolve_command(teile + rest, varmap)
                return name, idx, remaining
            i += wrapper_option_width(wrapper, raw)
            continue
        word = resolve_vars(raw, varmap)
        name = word.split('/')[-1]
        if name in WRAPPER_CMDS:
            wrapper = name
            i += 1
            continue
        return name, i, stage_tokens[i + 1:]
    return None, i, []


def stage_text(stage_tokens):
    return ' '.join(stage_tokens)


def resolved_stage_text(stage_tokens, varmap):
    return ' '.join(resolve_vars(t, varmap) for t in stage_tokens)
