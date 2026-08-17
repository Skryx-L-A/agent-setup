import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cmdshell as cs

MAX_DEPTH = 5
MAX_COMMAND_LEN = 200_000

# Nur wenn eine dieser Formen im ROHTEXT vorkommt, gilt ein nicht zerlegbares
# Kommando ueberhaupt als moeglicher Push. Vorher zaehlte jedes unzerlegbare
# Kommando als Treffer -- ein `git commit -F - <<'MSG' ... MSG` mit einem
# Apostroph im Nachrichtentext reichte, und in einem Worker-Pane wurde daraus
# eine Push-Ablehnung fuer einen Befehl, der gar nicht pusht.
# Ein echter Push muss eines dieser Woerter im Text tragen: 'push' schreibt
# sich nicht anders, und `gh pr create` auch nicht.
FAILCLOSED_RE = re.compile(r'\bpush\b|\bgh\b')


def git_subcommand(remaining, varmap):
    i, n = 0, len(remaining)
    while i < n:
        t = cs.resolve_vars(remaining[i], varmap)
        if t in ('-C', '-c'):
            i += 2
            continue
        if t.startswith('--git-dir=') or t.startswith('--work-tree='):
            i += 1
            continue
        if t.startswith('-'):
            i += 1
            continue
        return t
    return None


def _looks_unresolvable(tokens):
    for t in tokens:
        if '$(' in t or '`' in t:
            return True
        if re.search(r'\$\{?[A-Za-z_][A-Za-z0-9_]*\}?', t):
            return True
    return False


def _unresolvable_command_word(text, varmap):
    # Wie in kill_pattern_classify: entscheidend ist nicht, ob irgendwo im Text
    # eine Substitution steht, sondern ob das auszufuehrende KOMMANDO daraus
    # kommt. Nur dann ist unbekannt, ob gepusht wird. Steht die Substitution in
    # einem Argument (`git push "$REMOTE"`), findet die normale Pruefung den
    # Push weiterhin.
    for stmt in cs.all_statements(cs.strip_heredocs(text)):
        if stmt is None:
            return bool(FAILCLOSED_RE.search(text))
        for stage in cs.split_pipeline(stmt):
            name, idx, _rest = cs.resolve_command(stage, varmap)
            if name is None:
                continue
            # Ganzes Kommandowort, nicht der Basisname -- siehe die gleich
            # lautende Stelle in kill_pattern_classify.py.
            word = cs.resolve_vars(stage[idx], varmap) if idx < len(stage) else name
            if _looks_unresolvable([word]):
                return True
    return False


def finds_push(command_text, varmap, depth=0):
    if depth > MAX_DEPTH:
        return True

    statements = cs.all_statements(cs.strip_heredocs(command_text))
    # Je Teilbefehl nur die Zuweisungen davor -- siehe cs.assignment_prefixes().
    varmaps = cs.assignment_prefixes(statements, varmap)
    for stmt_idx, stmt in enumerate(statements):
        varmap = varmaps[stmt_idx]
        if stmt is None:
            return bool(FAILCLOSED_RE.search(command_text))
        for stage in cs.split_pipeline(stmt):
            name, idx, remaining = cs.resolve_command(stage, varmap)
            if name is None:
                continue

            if name == 'eval':
                if not remaining:
                    continue
                inner = ' '.join(remaining)
                if _unresolvable_command_word(inner, varmap):
                    return True
                if finds_push(inner, varmap, depth + 1):
                    return True
                continue

            if name in cs.SHELL_INTERPRETERS and len(remaining) >= 2 and remaining[0] == '-c':
                inner = remaining[1]
                if _unresolvable_command_word(inner, varmap):
                    return True
                if finds_push(inner, varmap, depth + 1):
                    return True
                continue

            if name == 'git':
                sub = git_subcommand(remaining, varmap)
                if sub == 'push':
                    return True
                continue

            if name == 'gh':
                resolved = [cs.resolve_vars(t, varmap) for t in remaining]
                stripped = [t for t in resolved if t and not t.startswith('-')]
                if len(stripped) >= 2 and stripped[0] == 'pr' and stripped[1] == 'create':
                    return True
                continue

    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    command = (data.get('tool_input') or {}).get('command')
    if not isinstance(command, str) or not command.strip():
        return 0

    if len(command) > MAX_COMMAND_LEN:
        # Same shlex scaling issue as bash-guard-kill-pattern (see there) --
        # too large to tokenize within the hook's time budget. Report as a
        # hit so the role check downstream still gets a chance to gate it,
        # instead of silently waving an unanalyzable command through.
        print('1')
        return 0

    # Kein Gesamt-varmap mehr, siehe cs.assignment_prefixes().
    print('1' if finds_push(command, {}) else '0')
    return 0


if __name__ == '__main__':
    sys.exit(main())
