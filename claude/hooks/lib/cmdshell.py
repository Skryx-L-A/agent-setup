import re
import shlex

STATEMENT_SEPS = {';', '&', '&&', '||'}
WRAPPER_CMDS = {'command', 'exec', 'builtin', 'nohup', 'sudo', 'env'}
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
    lines = command.split('\n')
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.search(r'<<-?\s*[\'"]?([A-Za-z_][A-Za-z0-9_]*)[\'"]?', line)
        i += 1
        if not m:
            continue
        delim = m.group(1)
        while i < len(lines) and lines[i].strip() != delim:
            i += 1
        if i < len(lines):
            i += 1
    return '\n'.join(out)


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
        if not in_single and not in_double and ch == '\n':
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
    toks = []
    try:
        for t in lexer:
            toks.append(t)
    except ValueError:
        return None
    return toks


def split_statements(tokens):
    stmts, cur = [], []
    for t in tokens:
        if t in STATEMENT_SEPS:
            stmts.append(cur)
            cur = []
        else:
            cur.append(t)
    stmts.append(cur)
    return [s for s in stmts if s]


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


def split_pipeline(tokens):
    stages, cur = [], []
    for t in tokens:
        if t == '|':
            stages.append(strip_redirections(cur))
            cur = []
        else:
            cur.append(t)
    stages.append(strip_redirections(cur))
    return [s for s in stages if s]


def all_statements(command):
    # [None] marks a command that could not be tokenized at all (a genuinely
    # unbalanced quote) -- callers must treat that as unresolvable, not as
    # "nothing found".
    protected, subs = _protect_substitutions(command)
    toks = tokenize(_quote_aware_prepass(protected))
    if toks is None:
        return [None]
    if subs:
        toks = [_restore_substitutions(t, subs) for t in toks]
    return expand_literal_for_loops(split_statements(toks))


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
    skip_flags = False
    while i < n:
        raw = stage_tokens[i]
        if raw in BLOCK_KEYWORDS:
            i += 1
            continue
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', raw):
            i += 1
            continue
        if skip_flags and raw.startswith('-'):
            i += 1
            continue
        word = resolve_vars(raw, varmap)
        name = word.split('/')[-1]
        if name in WRAPPER_CMDS:
            skip_flags = True
            i += 1
            continue
        return name, i, stage_tokens[i + 1:]
    return None, i, []


def stage_text(stage_tokens):
    return ' '.join(stage_tokens)


def resolved_stage_text(stage_tokens, varmap):
    return ' '.join(resolve_vars(t, varmap) for t in stage_tokens)
