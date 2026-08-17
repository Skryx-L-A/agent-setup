import fnmatch
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cmdshell as cs

OWN_SCOPE_SOCKETS = ('wbtest', 'wbstress', 'wbprobe')
DANGEROUS_KILL = {'pkill', 'killall'}
PIPE_TERMINAL_INTERPRETERS = {
    'bash', 'sh', 'zsh', 'dash', 'ksh',
    'python', 'python3', 'perl', 'ruby', 'node', 'osascript',
}
MAX_DEPTH = 5
MAX_COMMAND_LEN = 200_000

INCIDENT = '[[incident-2026-07-25-killmuster-beendete-live-client]]'

# PID-Quellen, die per Definition auf einen Prozess DIESES Aufrufs zeigen:
# `$!` ist die PID des zuletzt im Hintergrund gestarteten Kommandos, und eine
# Bash-Tool-Ausfuehrung startet mit einer frischen Shell — `$!` kann also nur
# etwas benennen, was derselbe Befehl selbst gestartet hat. `$$`/`$BASHPID`
# sind die eigene Shell. Fremde Prozesse sind darueber nicht erreichbar,
# deshalb zaehlen sie wie eine ausgeschriebene PID.
# `$PPID` steht bewusst NICHT hier: der Elternprozess ist der Aufrufer, nicht
# der eigene Testprozess.
SAFE_PID_EXPANSIONS = {'$!', '${!}', '$$', '${$}', '$BASHPID', '${BASHPID}'}

# Nur wenn eine dieser Formen im ROHTEXT steht, wird ein nicht zerlegbares
# Kommando ueberhaupt fail-closed behandelt. Vorher galt jedes unzerlegbare
# Kommando als Blockfall -- ein Heredoc mit einem Apostroph im Text
# ("don't") reichte dafuer aus, obwohl darin nur Text geschrieben wird.
FAILCLOSED_RE = re.compile(
    r'\bpkill\b|\bkillall\b|\bkill\b|\bkill-server\b|\bkill-session\b|\beval\b'
    r'|\|\s*(bash|sh|zsh|dash|ksh|python3?|perl|ruby|node|osascript)\b')


def is_own_scoped(text):
    if re.search(r'-L\s+(' + '|'.join(OWN_SCOPE_SOCKETS) + r')(\s|$)', text, re.IGNORECASE):
        return True
    return 'TMUX_TMPDIR=' in text


_TMUX_SOCKET_DIR_RE = re.compile(r'(^|/)tmux-[0-9]+$')


def _is_safe_tmux_dash_s_path(path):
    # `-S <pfad>` ist nur die Langform von `-L <name>` (tmux haengt -L intern
    # unter <TMUX_TMPDIR-oder-/tmp>/tmux-<uid>/<name> ein) -- als gleichwertig
    # sicher gilt sie NUR, wenn der Pfad nachweislich unter genau so einem
    # Socketverzeichnis liegt UND nicht auf den Standardsocket zeigt. Ein
    # beliebiger anderer Pfad bleibt bewusst ungeprueft/unsicher (kein
    # pauschales Durchlassen jedes `-S`).
    if not path or '$(' in path or '`' in path:
        return False
    stripped = path.rstrip('/')
    base = stripped.split('/')[-1] if stripped else ''
    if not base or base == 'default':
        return False
    dirpart = stripped[: -len(base)].rstrip('/')
    if dirpart in ('$TMUX_TMPDIR', '${TMUX_TMPDIR}'):
        return True
    return bool(_TMUX_SOCKET_DIR_RE.search(dirpart))


def is_too_broad_ending(text):
    return bool(re.search(r"(wb-|claude)['\"]?\s*$", text.strip(), re.IGNORECASE))


def has_pgrep_reference(tokens):
    return any('pgrep' in t for t in tokens)


def is_bare_pid_kill(resolved_tokens):
    # Bis 2026-08-05 galt JEDE blanke Variablenreferenz als sichere PID, auch
    # eine, die im selben Befehl nirgends zugewiesen wird. Das war genau
    # verkehrt herum: `kill $CPID` MIT Zuweisung wurde abgelehnt, OHNE
    # Zuweisung durchgelassen. Seit die Aufloesung funktioniert, ist die
    # Begruendung fuer die Grosszuegigkeit weg.
    # Gemessen an fuenfzehn realistischen kill-Formen: vier werden dadurch neu
    # abgelehnt, und keine davon tut, was sie soll -- eine Bash-Ausfuehrung
    # startet mit einer frischen Shell, eine Variable aus einem FRUEHEREN
    # Aufruf ist zur Laufzeit leer, `kill` bekaeme gar kein Argument. Bleibt
    # `kill $EINE_UMGEBUNGSVARIABLE`: die existiert wirklich und kann auf
    # jeden beliebigen fremden Prozess zeigen -- der unpruefbare Fall, den
    # dieser Guard gerade abfangen soll.
    # Umweg: PID ausschreiben oder im selben Befehl zuweisen.
    if not resolved_tokens:
        return False
    for t in resolved_tokens:
        if re.match(r'^-[A-Za-z0-9]+$', t):
            continue
        if re.match(r'^[0-9]+$', t):
            continue
        if t in SAFE_PID_EXPANSIONS:
            continue
        return False
    return True


def socket_cannot_be_default(sock):
    # `-L <name>` kann den Live-Server nur treffen, wenn <name> "default" ist.
    # Frueher galt jeder Socketname mit einem '$' darin als unsicher; ein
    # `tmux -L "$S" kill-server` mit `S=wbtest-$$` zwei Zeilen darueber wurde
    # damit abgelehnt, obwohl der Name den Live-Socket gar nicht treffen KANN.
    # Jetzt wird gefragt, ob der Name ueberhaupt "default" sein koennte:
    # unbekannte Anteile werden zu '*', der literale Rest bleibt. Bleibt nichts
    # Literales uebrig (blankes `$S` ohne Zuweisung), lautet die Antwort "ja,
    # koennte" -- und es bleibt beim Blocken.
    if not sock:
        return False
    return not fnmatch.fnmatchcase('default', cs.unresolved_to_wildcard(sock))


def _pattern_deny(check_text, display_text):
    if is_own_scoped(check_text):
        return None
    if is_too_broad_ending(check_text):
        return (
            "Kill-Muster endet auf generischem Praefix (wb-/claude) ohne spezifischen Suffix -- trifft "
            "JEDE passende Session/Prozess, nicht nur den eigenen Test. Vorfall: pkill -f \"tmux attach "
            "-t =wb-\" hat den Live-Client des Nutzers beendet. Umweg: konkrete PID nennen (kill <pid>) oder "
            "eigenen Test-Socket/-Sessionnamen mit Suffix verwenden. Blockiert von "
            "bash-guard-kill-pattern. Teilbefehl: %s" % display_text
        )
    return (
        "pkill/killall/kill (pattern-basiert, z.B. ueber pgrep) ohne nachweisbar engen Bezug im selben "
        "Teilbefehl (kein eigener Test-Socket/-Sessionname erkennbar). Default-Deny lt. Standing Rule "
        "'Kein Kill-Muster, das ueber die eigenen Testprozesse hinausreicht'. Umweg: konkrete PID nennen "
        "(kill <pid>) oder Muster mit eigenem Test-Socket/-Sessionnamen (z.B. -L wbtest) im selben "
        "Teilbefehl versehen. Blockiert von bash-guard-kill-pattern. Teilbefehl: %s" % display_text
    )


def _looks_unresolvable(tokens):
    for t in tokens:
        if '$(' in t or '`' in t:
            return True
        if re.search(r'\$\{?[A-Za-z_][A-Za-z0-9_]*\}?', t):
            return True
    return False


def _unresolvable_command_word(text, varmap):
    # Frueher galt ein `eval`/`bash -c`-Argument schon dann als unpruefbar,
    # wenn IRGENDWO darin eine Substitution oder Variable vorkam -- ein
    # `bash -c 'echo start; d=$(date +%s); echo done'` fiel darunter, obwohl
    # jedes Kommando darin ausgeschrieben dasteht.
    # Entscheidend ist nicht, ob der Text eine Substitution enthaelt, sondern
    # ob sie an der Stelle steht, an der das KOMMANDO steht: nur dann ist
    # unbekannt, WAS ausgefuehrt wird. Steht sie in einem Argument, greifen die
    # normalen Pruefungen darunter (kill/pkill/tmux) unveraendert weiter.
    for stmt in cs.all_statements(cs.strip_heredocs(text)):
        if stmt is None:
            return True
        for stage in cs.split_pipeline(stmt):
            name, idx, _rest = cs.resolve_command(stage, varmap)
            if name is None:
                continue
            # Das GANZE Kommandowort pruefen, nicht cs.resolve_command()s
            # Basisnamen: der schneidet am letzten '/' ab, und aus
            # `$(curl -s http://x)` wuerde damit `x)` -- unauffaellig, obwohl
            # das auszufuehrende Kommando voellig offen ist.
            word = cs.resolve_vars(stage[idx], varmap) if idx < len(stage) else name
            if _looks_unresolvable([word]):
                return True
    return False


def _check_single(name, remaining, stage, resolved_stages, pos, varmap, depth):
    if name is None:
        return None

    if name == 'eval':
        if not remaining:
            return None
        inner = ' '.join(remaining)
        if _unresolvable_command_word(inner, varmap):
            return (
                "eval eines Ausdrucks, in dem das auszufuehrende KOMMANDO selbst aus einer nicht "
                "aufloesbaren Kommandosubstitution/Variablen kommt -- was hier laeuft, steht erst "
                "zur Laufzeit fest. Blockiert von bash-guard-kill-pattern (Default-Deny fuer "
                "unentscheidbare Formen). eval-Argument: %s" % inner
            )
        return scan_for_danger(inner, varmap, depth + 1)

    if name in cs.SHELL_INTERPRETERS and len(remaining) >= 2 and remaining[0] == '-c':
        inner = remaining[1]
        if _unresolvable_command_word(inner, varmap):
            return (
                "%s -c mit einem Skripttext, in dem das auszufuehrende KOMMANDO selbst aus einer "
                "nicht aufloesbaren Kommandosubstitution/Variablen kommt -- was hier laeuft, steht "
                "erst zur Laufzeit fest. Blockiert von bash-guard-kill-pattern (Default-Deny fuer "
                "unentscheidbare Formen). -c-Argument: %s" % (name, inner)
            )
        return scan_for_danger(inner, varmap, depth + 1)

    if name == 'tmux':
        if any(t in ('kill-server', 'kill-session') for t in remaining):
            check_text = cs.resolved_stage_text(stage, varmap)
            if is_own_scoped(check_text):
                return None
            # Jeder EXPLIZIT benannte Socket ist sicher, nicht nur die drei bekannten
            # Namen: der Live-Server laeuft auf dem Default-Socket, den `-L <name>`
            # per Definition nicht treffen kann. Die Namensliste war zu eng — sie hat
            # am 2026-07-28 zwei legitime Aufraeum-Befehle auf einem Wegwerf-Socket
            # blockiert und damit zu einem Umweg ueber rohe PIDs gezwungen, der
            # riskanter ist als das, was sie verhindern sollte. `-L default` bleibt
            # gesperrt, das IST der Live-Socket.
            for i, tok in enumerate(remaining):
                sock = None
                if tok == '-L' and i + 1 < len(remaining):
                    sock = remaining[i + 1]
                elif tok.startswith('-L') and len(tok) > 2:
                    sock = tok[2:]
                if sock and socket_cannot_be_default(cs.resolve_vars(sock, varmap)):
                    return None
                sockpath = None
                if tok == '-S' and i + 1 < len(remaining):
                    sockpath = remaining[i + 1]
                elif tok.startswith('-S') and len(tok) > 2:
                    sockpath = tok[2:]
                if sockpath and _is_safe_tmux_dash_s_path(cs.resolve_vars(sockpath, varmap)):
                    return None
            return (
                "tmux kill-server/kill-session ohne eigenen Test-Socket (-L <name> oder -S <pfad> "
                "unterhalb des tmux-Socketverzeichnisses) erkannt -- toetet direkt eine LIVE-tmux-"
                "Session/den ganzen Server, nicht nur eigene Testprozesse. Vorfall-Klasse: %s. "
                "Umweg: eigenen Testsocket verwenden (tmux -L wbtest ... oder tmux -S "
                "<TMUX_TMPDIR-oder-/tmp>/tmux-<uid>/wbtest ...) oder die Session ueber "
                "wb-session-close schliessen, das die Sicherheitspruefungen selbst mitbringt. "
                "Blockiert von bash-guard-kill-pattern. Teilbefehl: %s"
                % (INCIDENT, cs.stage_text(stage))
            )
        return None

    if name in DANGEROUS_KILL:
        check_text = cs.resolved_stage_text(stage, varmap)
        display_text = cs.stage_text(stage)
        return _pattern_deny(check_text, display_text)

    if name == 'kill':
        resolved_remaining = [cs.resolve_vars(t, varmap) for t in remaining]
        if has_pgrep_reference(resolved_remaining):
            return _pattern_deny(' '.join(resolved_remaining), cs.stage_text(stage))
        if is_bare_pid_kill(resolved_remaining):
            return None
        if not remaining:
            return None
        return (
            "kill ohne erkennbare reine PID-/Signal-Argumente und ohne pgrep/ps-Herkunft im selben "
            "Teilbefehl -- Argument nicht als sicher einstufbar. Blockiert von bash-guard-kill-pattern "
            "(Default-Deny). Teilbefehl: %s" % cs.stage_text(stage)
        )

    if name == 'xargs':
        first_real = None
        for t in remaining:
            if t.startswith('-'):
                continue
            first_real = cs.resolve_vars(t, varmap)
            break
        if first_real in ('kill', 'pkill', 'killall'):
            earlier_pgrep = [s for (n, _, _, s) in resolved_stages[:pos] if n == 'pgrep']
            if earlier_pgrep:
                src_stage = earlier_pgrep[-1]
                check_text = cs.resolved_stage_text(src_stage, varmap)
                display_text = 'pgrep ... | xargs %s (Quelle: %s)' % (
                    first_real, cs.stage_text(src_stage))
                return _pattern_deny(check_text, display_text)
        return None

    return None


def _check_for_loop(statements):
    # Statement-positionsgebunden (stmt[0] == "for"), NICHT eine Textsuche
    # ueber die ganze Kommandozeile -- sonst triggert jede Erwaehnung eines
    # solchen Konstrukts als Text (Doku, Heredoc-Inhalt) genau das False-
    # Positive-Problem, das dieser Hook eigentlich beheben soll (B13).
    for i, stmt in enumerate(statements):
        if not stmt or stmt[0] != 'for':
            continue
        text = cs.stage_text(stmt)
        m = re.match(r'^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+\$\(([^)]*\bpgrep\b[^)]*)\)', text)
        if not m:
            continue
        loopvar, pgrep_expr = m.group(1), m.group(2)
        for later in statements[i + 1:i + 7]:
            if not later:
                continue
            later_text = cs.stage_text(later)
            if re.search(r'\bkill\s+"?\$\{?' + re.escape(loopvar) + r'\}?"?\b', later_text):
                display = 'for %s in $(%s); do ... kill $%s ...; done' % (
                    loopvar, pgrep_expr.strip(), loopvar)
                return _pattern_deny(pgrep_expr.strip(), display)
    return None


def scan_for_danger(command_text, varmap, depth=0):
    if depth > MAX_DEPTH:
        return (
            "Verschachtelte eval/-c-Aufloesung zu tief (>%d Ebenen) -- als nicht auswertbar geblockt. "
            "Blockiert von bash-guard-kill-pattern." % MAX_DEPTH
        )

    # Heredoc-Inhalt ist Text, kein Befehl: er wird vor dem Zerlegen entfernt.
    # Ohne das galt ein Apostroph oder ein Anfuehrungszeichen im Fliesstext
    # eines `git commit -F - <<'MSG' ... MSG` als unausgeglichene Anfuehrung
    # und blockierte den ganzen Aufruf.
    statements = cs.all_statements(cs.strip_heredocs(command_text))
    # Je Teilbefehl nur die Zuweisungen davor -- siehe cs.assignment_prefixes().
    varmaps = cs.assignment_prefixes(statements, varmap)

    for_reason = _check_for_loop(statements)
    if for_reason:
        return for_reason

    for stmt_idx, stmt in enumerate(statements):
        varmap = varmaps[stmt_idx]
        if stmt is None:
            # Nicht zerlegbar UND ohne jede beendende Form im Rohtext: dann gibt
            # es hier nichts zu entscheiden, was diesen Guard angeht. Erst wenn
            # eine solche Form vorkommt, ist das Nicht-Zerlegen-Koennen ein
            # Grund zu blocken.
            if not FAILCLOSED_RE.search(command_text):
                return None
            return (
                "Kommando enthaelt eine prozessbeendende Form, laesst sich aber wegen "
                "unausgeglichener Anfuehrungszeichen nicht in Teilbefehle zerlegen -- welche "
                "Prozesse betroffen waeren, ist nicht feststellbar. Blockiert von "
                "bash-guard-kill-pattern (Default-Deny fuer unentscheidbare Formen)."
            )

        pipeline = cs.split_pipeline(stmt)
        resolved_stages = []
        for stage in pipeline:
            name, idx, remaining = cs.resolve_command(stage, varmap)
            resolved_stages.append((name, idx, remaining, stage))

        for pos, (name, idx, remaining, stage) in enumerate(resolved_stages):
            reason = _check_single(name, remaining, stage, resolved_stages, pos, varmap, depth)
            if reason:
                return reason

        if len(resolved_stages) >= 2:
            last_name, _, last_remaining, _ = resolved_stages[-1]
            if last_name in PIPE_TERMINAL_INTERPRETERS:
                extra = [t for t in last_remaining if not t.startswith('-')]
                if not extra:
                    return (
                        "Pipeline endet in einem nackten Interpreter-Aufruf (%s) ohne Skriptdatei -- "
                        "liest das Kommando aus der vorherigen Pipe-Stufe und fuehrt es aus. Statisch "
                        "nicht pruefbar (z.B. base64/xxd/openssl vor bash|sh). Umweg: Skript in eine "
                        "Datei schreiben, die dann geprueft/separat ausgefuehrt wird. Blockiert von "
                        "bash-guard-kill-pattern (Default-Deny fuer unentscheidbare Formen). "
                        "Pipeline: %s" % (last_name, cs.stage_text(stmt))
                    )
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    command = (data.get('tool_input') or {}).get('command')
    if not isinstance(command, str) or not command.strip():
        return 0

    if len(command) > MAX_COMMAND_LEN:
        # shlex-based tokenizing scales worse than linearly on one very long
        # token (measured: ~2.6s at 400k chars) -- a real 10MB command would
        # blow past the hook's 5s timeout. Deny fast instead of hanging;
        # this is well above any realistic legitimate command.
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'deny',
                'permissionDecisionReason': (
                    "Kommando ist %d Zeichen lang (Limit %d) -- zu gross, um innerhalb des "
                    "Hook-Zeitbudgets sicher zerlegt zu werden. Blockiert von "
                    "bash-guard-kill-pattern (Default-Deny fuer unentscheidbare/zu grosse Formen)."
                    % (len(command), MAX_COMMAND_LEN)
                ),
            }
        }))
        return 0

    # Kein Gesamt-varmap mehr: scan_for_danger() baut die Karte
    # positionsgebunden auf (cs.assignment_prefixes).
    reason = scan_for_danger(command, {})
    if reason:
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'deny',
                'permissionDecisionReason': reason,
            }
        }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
