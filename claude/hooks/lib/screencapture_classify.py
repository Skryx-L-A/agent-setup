import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cmdshell as cs

MAX_DEPTH = 5
MAX_COMMAND_LEN = 200_000

# ssh-Optionen, die einen eigenen Wert nachziehen -- muessen uebersprungen
# werden, bevor der Host-Token und danach das Remote-Kommando beginnt.
SSH_OPTS_WITH_VALUE = {
    '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
    '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w',
}

HINT = (
    "Richtiger Weg: wb-shot <muster> <datei.png> (nimmt genau EIN Fenster ueber "
    "screencapture -l <windowid> auf, hebt es nicht an, kein Vollbild-Fallback). "
    "Fenster finden: wb-shot --list."
)


def _deny(reason):
    return "%s %s Blockiert von bash-guard-screencapture." % (reason, HINT)


def _is_window_limited(tokens):
    # Erlaubt ist genau, was die Aufnahme technisch auf einen Ausschnitt
    # begrenzt: -l <windowid> und -R x,y,w,h. Beide auch in der geklebten
    # Form (-l5, -R0,0,10,10) und im Flag-Cluster (-xol 5), weil getopt sie
    # so akzeptiert. 'l' und 'R' sind bei screencapture eindeutig -- kein
    # anderes Flag benutzt diese Buchstaben.
    for t in tokens:
        if not t.startswith('-') or t.startswith('--'):
            continue
        letters = t[1:]
        # Bei geklebtem Wert nur den fuehrenden Buchstabenteil ansehen.
        m = re.match(r'^([A-Za-z]+)', letters)
        if not m:
            continue
        if 'l' in m.group(1) or 'R' in m.group(1):
            return True
    return False


def _unresolvable(tokens):
    for t in tokens:
        if '$(' in t or '`' in t:
            return True
        if re.search(r'\$\{?[A-Za-z_][A-Za-z0-9_]*\}?', t):
            return True
    return False


def _ssh_remote_command(remaining):
    # Liefert das Remote-Kommando als Text (oder None). ssh-Optionen mit Wert
    # ueberspringen, dann faellt der erste uebrige Token als Host weg, der Rest
    # ist das Kommando auf der Gegenseite -- egal ob es als eine gequotete
    # Zeichenkette oder als lose Tokens uebergeben wurde.
    i, n = 0, len(remaining)
    while i < n:
        t = remaining[i]
        if t in SSH_OPTS_WITH_VALUE:
            i += 2
            continue
        if t.startswith('-'):
            i += 1
            continue
        break
    if i >= n:
        return None
    rest = remaining[i + 1:]
    return ' '.join(rest) if rest else None


def scan(command_text, varmap, depth=0):
    # Billiger Vorfilter: kommt das Wort ueberhaupt vor, ist der Rest egal.
    # Haelt den Hook fuer jeden normalen Befehl bei praktisch null Aufwand und
    # verhindert, dass Default-Deny-Zweige (unausgeglichene Quotes) Befehle
    # treffen, die mit Aufnahmen nichts zu tun haben.
    if 'screencapture' not in command_text:
        return None
    if depth > MAX_DEPTH:
        return _deny(
            "Verschachtelte eval/-c/ssh-Aufloesung zu tief (>%d Ebenen) und der Text enthaelt "
            "'screencapture' -- statisch nicht mehr pruefbar, deshalb Default-Deny." % MAX_DEPTH
        )

    statements = cs.all_statements(command_text)
    # Je Teilbefehl nur die Zuweisungen davor -- siehe cs.assignment_prefixes().
    varmaps = cs.assignment_prefixes(statements, varmap)
    for stmt_idx, stmt in enumerate(statements):
        varmap = varmaps[stmt_idx]
        if stmt is None:
            return _deny(
                "Kommando enthaelt 'screencapture', laesst sich aber wegen unausgeglichener "
                "Anfuehrungszeichen nicht sauber in Teilbefehle zerlegen -- nicht entscheidbar, "
                "ob die Aufnahme auf ein Fenster begrenzt waere."
            )
        for stage in cs.split_pipeline(stmt):
            name, _idx, remaining = cs.resolve_command(stage, varmap)
            if name is None:
                continue

            if name == 'eval':
                if not remaining:
                    continue
                inner = ' '.join(remaining)
                if 'screencapture' not in inner:
                    continue
                if _unresolvable(remaining):
                    return _deny(
                        "eval eines Ausdrucks, der 'screencapture' und zugleich eine nicht "
                        "aufloesbare Variable/Kommandosubstitution enthaelt -- der Aufruf ist zur "
                        "Laufzeit beliebig, die Fensterbegrenzung damit nicht pruefbar."
                    )
                r = scan(inner, varmap, depth + 1)
                if r:
                    return r
                continue

            if name in cs.SHELL_INTERPRETERS and len(remaining) >= 2 and remaining[0] == '-c':
                inner = remaining[1]
                if 'screencapture' not in inner:
                    continue
                if _unresolvable([inner]):
                    return _deny(
                        "%s -c mit einem Ausdruck, der 'screencapture' und eine nicht aufloesbare "
                        "Variable/Kommandosubstitution enthaelt -- Fensterbegrenzung nicht "
                        "pruefbar." % name
                    )
                r = scan(inner, varmap, depth + 1)
                if r:
                    return r
                continue

            if name == 'ssh':
                # Die Regel gilt auf BEIDEN Maschinen. Anders als beim Snapshot-
                # Guard ist die Pruefung hier rein syntaktisch (welche Flags
                # stehen da), sie braucht keinen Blick ins entfernte Dateisystem
                # -- deshalb kann sie ueber ssh hinweg gelten.
                inner = _ssh_remote_command(remaining)
                if not inner or 'screencapture' not in inner:
                    continue
                r = scan(inner, varmap, depth + 1)
                if r:
                    return r
                continue

            if name != 'screencapture':
                continue

            args = [cs.resolve_vars(t, varmap) for t in remaining]
            if _is_window_limited(args):
                # -l/-R vorhanden: der Aufruf KANN keinen ganzen Schirm nehmen,
                # auch wenn die Fenster-ID selbst aus einer Variablen kommt
                # (eine ungueltige ID laesst screencapture scheitern, sie faellt
                # nicht auf Vollbild zurueck). Genau diese Form benutzt wb-shot.
                continue
            if not args:
                return _deny(
                    "screencapture ohne jedes Argument nimmt den GESAMTEN Bildschirm auf. "
                    "Stehende Regel: jede Aufnahme wird exakt auf ein Fenster begrenzt."
                )
            if _unresolvable(remaining):
                return _deny(
                    "screencapture mit Argumenten aus einer nicht aufloesbaren Variablen/"
                    "Kommandosubstitution und ohne literal sichtbares -l/-R -- es ist statisch "
                    "nicht entscheidbar, ob die Aufnahme auf ein Fenster begrenzt bleibt. "
                    "Teilbefehl: %s" % cs.stage_text(stage)
                )
            if any(a in ('-i', '-w', '-W') or
                   (a.startswith('-') and not a.startswith('--') and
                    re.search(r'[iwW]', re.match(r'^-([A-Za-z]*)', a).group(1)))
                   for a in args):
                return _deny(
                    "screencapture im interaktiven Auswahlmodus (-i/-w/-W). Die Auswahl trifft zwar "
                    "ein Mensch, aber der Aufruf kommt von einem Agenten: er legt ein Fadenkreuz "
                    "ueber den Bildschirm des Nutzers, erzwingt eine Eingabe und laesst per Leertaste/Klick "
                    "trotzdem den ganzen Schirm zu -- damit ist weder die Fensterbegrenzung garantiert "
                    "noch der Fokus unangetastet, die beiden Punkte, um die es in der Regel geht. "
                    "Teilbefehl: %s" % cs.stage_text(stage)
                )
            return _deny(
                "screencapture ohne Fensterbegrenzung (weder -l <windowid> noch -R x,y,w,h) -- "
                "nimmt einen ganzen Bildschirm auf. Stehende Regel: NIEMALS den gesamten "
                "Bildschirm, jede Aufnahme exakt auf ein Fenster begrenzt. Teilbefehl: %s"
                % cs.stage_text(stage)
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
    if 'screencapture' not in command:
        return 0

    if len(command) > MAX_COMMAND_LEN:
        print(json.dumps({
            'hookSpecificOutput': {
                'hookEventName': 'PreToolUse',
                'permissionDecision': 'deny',
                'permissionDecisionReason': _deny(
                    "Kommando ist %d Zeichen lang (Limit %d) und enthaelt 'screencapture' -- zu "
                    "gross, um im Hook-Zeitbudget sicher zerlegt zu werden."
                    % (len(command), MAX_COMMAND_LEN)
                ),
            }
        }))
        return 0

    # Kein Gesamt-varmap mehr, siehe cs.assignment_prefixes().
    reason = scan(command, {})
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
