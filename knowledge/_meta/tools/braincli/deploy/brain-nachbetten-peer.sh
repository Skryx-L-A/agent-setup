#!/usr/bin/env bash
# Nightly recovery for missed post-commit embeddings on peer. No model judge.
set -euo pipefail

vault=${BRAIN_VAULT:-"$HOME/Knowledge"}
python="$vault/_meta/tools/braincli/.venv/bin/python"

# No trader deferral (decision der Nutzer 2026-10-09: the vault has priority over the trader on peer).
# braincli.nachbetten only checks feasibility: wait briefly for GPU memory, else embed on the CPU.

if [[ ! -x "$python" ]]; then
  echo "error: braincli Python missing: $python" >&2
  exit 1
fi
exec "$python" -m braincli.nachbetten --vault "$vault" --sofort --json
