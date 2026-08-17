#!/bin/sh
# PostToolUse hook (Read tool): logs vault-note reads for Gardener's read-heat.
# Contract: <50ms, NEVER blocks, silent on any error/miss.

VAULT="$HOME/Knowledge"
LOG="$VAULT/_meta/tools/state/read-heat.log"

input="$(cat)"

# Lightweight grep/sed extraction (no python3 startup cost) for the hot PostToolUse
# path; tool_input.file_path is a plain path string, never containing a quote.
file_path="$(printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"file_path"[[:space:]]*:[[:space:]]*"([^"]*)"/\1/')"

[ -n "$file_path" ] || exit 0

case "$file_path" in
    "$VAULT"/*) : ;;
    *) exit 0 ;;
esac

rel="${file_path#"$VAULT"/}"

case "$rel" in
    90-secrets/*|_meta/tools/*|.git/*) exit 0 ;;
esac

mkdir -p "$VAULT/_meta/tools/state" 2>/dev/null
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\t%s\n' "$ts" "$rel" >> "$LOG" 2>/dev/null

exit 0
