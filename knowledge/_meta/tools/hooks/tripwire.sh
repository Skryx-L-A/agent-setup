#!/usr/bin/env sh
# PreToolUse hook: Fallenbuch-Tripwire (I2/I6/I10, brain5-forschung-gedaechtnis.md).
# Vertrag: BLOCKIERT NIE. Egal was passiert (python3 fehlt, FALLEN.yaml kaputt, kein
# Projekt erkannt) -- exit 0, hoechstens Zusatzkontext im "allow"-Format, nie "deny".
# Portabel macOS/Linux: kein GNU-/BSD-Sonderschalter, `sh` statt bash-spezifischer Syntax.

HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0

if command -v python3 >/dev/null 2>&1; then
  python3 "$HOOK_DIR/tripwire_cli.py" 2>/dev/null
fi

exit 0
