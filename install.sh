#!/usr/bin/env bash
# install.sh -- copies this repository into the places the tools expect.
#
#   ./install.sh              install
#   ./install.sh --trocken    say what would change, write nothing (--dry-run works too)
#
# WHAT IT DOES, AND WHERE IT STOPS
# --------------------------------
# It does the mechanical half only: five copies, a snapshot of anything it is about to
# overwrite, and a count at the end. It installs no software, edits no shell profile, loads
# no background service and fills in no template. Everything that needs a decision -- which
# rules you keep in CLAUDE.md, which model registry you want, whether a background job should
# run -- is in INSTALL.md and stays yours.
#
# A missing prerequisite is reported by name and ends the run. Guessing at package managers
# is how an installer breaks a machine it does not understand.
#
# Running it twice does the same as running it once: a file whose content already matches is
# left alone, and nothing is snapshotted that was not actually replaced.
set -uo pipefail

HIER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

TROCKEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --trocken|--dry-run) TROCKEN=1 ;;
    -h|--help) sed -n '2,4p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

sag() { printf '\n== %s\n' "$*"; }
hin() { printf '   %s\n' "$*"; }

[ -d "$HIER/claude" ] || [ -d "$HIER/shell" ] || {
  echo "ABORT: $HIER does not look like this repository (no claude/ and no shell/)." >&2; exit 1; }

# ------------------------------------------------------------------ prerequisites
# Named, not installed. Each line says what the tool is for, so a missing one is a decision
# you can make rather than an error message to search for.
sag "Prerequisites"
FEHLT=""
pruefe() { command -v "$1" >/dev/null 2>&1 || FEHLT="$FEHLT
   $1 -- $2"; }
pruefe git  "the tools and the knowledge base are git repositories"
pruefe tmux "every worker pane is a tmux pane; without it nothing can be spawned"
pruefe node "the workbench is an Electron program and is built from source (version 22 or newer)"
pruefe rg   "ripgrep; the hooks and several tools search with it"
if [ -n "$FEHLT" ]; then
  echo "ABORT: missing prerequisites:$FEHLT" >&2
  echo >&2
  echo "       Install them with your own package manager, then run this again." >&2
  echo "       This script does not install software for you." >&2
  exit 1
fi
if NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" \
   && [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  echo "ABORT: node $(node -v) is too old; the workbench needs 22 or newer." >&2
  exit 1
fi
hin "git, tmux, node $(node -v 2>/dev/null), ripgrep -- all present."

# ------------------------------------------------------------------------ the map
# Source directory in this repository -> where it goes. This list is the only place that
# knows the layout; the copy, the snapshot and the check at the end all read it, so there is
# no second list that can fall out of step with the first.
ZIELE=(
  "claude:$HOME/.claude"
  "shell:$HOME/.local/bin"
  "pi:$HOME/.pi"
  "knowledge:$HOME/Knowledge"
  "tmux.conf:$HOME/.tmux.conf"
)

DATUM="$(date +%Y-%m-%d)"
SNAP="$HOME/.local/trash-snapshots/$DATUM-install"

NEU=0; ERSETZT=0; GLEICH=0; GESICHERT=0

# sichere <zieldatei> <kennung> -- copies a file that is about to be overwritten into the
# snapshot directory, keeping its path so it can be put back by hand.
sichere() {
  local ziel="$1" kennung="$2" ablage="$SNAP/$kennung"
  mkdir -p "$(dirname "$ablage")" || return 1
  cp -p "$ziel" "$ablage" || return 1
  GESICHERT=$((GESICHERT + 1))
}

# lege_ab <quelldatei> <zieldatei> <kennung>
lege_ab() {
  local q="$1" z="$2" kennung="$3"
  if [ -f "$z" ] && cmp -s "$q" "$z"; then
    GLEICH=$((GLEICH + 1)); return 0
  fi
  if [ -e "$z" ]; then
    if [ "$TROCKEN" = 1 ]; then hin "replace $z (old version to $SNAP/$kennung)"
    else sichere "$z" "$kennung" || { echo "ABORT: could not snapshot $z" >&2; exit 1; }; fi
    ERSETZT=$((ERSETZT + 1))
  else
    [ "$TROCKEN" = 1 ] && hin "new     $z"
    NEU=$((NEU + 1))
  fi
  if [ "$TROCKEN" = 0 ]; then
    mkdir -p "$(dirname "$z")" || { echo "ABORT: could not create $(dirname "$z")" >&2; exit 1; }
    cp -p "$q" "$z" || { echo "ABORT: could not write $z" >&2; exit 1; }
  fi
}

sag "Copying"
for eintrag in "${ZIELE[@]}"; do
  name="${eintrag%%:*}"; ziel="${eintrag#*:}"
  quelle="$HIER/$name"
  [ -e "$quelle" ] || { hin "$name -- not in this repository, skipped"; continue; }
  if [ -f "$quelle" ]; then
    lege_ab "$quelle" "$ziel" "$name"
    hin "$name -> $ziel"
    continue
  fi
  anzahl=0
  while IFS= read -r p; do
    rel="${p#$quelle/}"
    lege_ab "$p" "$ziel/$rel" "$name/$rel"
    anzahl=$((anzahl + 1))
  done < <(find "$quelle" -type f)
  hin "$name/ -> $ziel/ ($anzahl files in the repository)"
done

if [ "$TROCKEN" = 1 ]; then
  echo
  echo "Dry run: $NEU new, $ERSETZT to replace, $GLEICH already identical. Nothing written."
  exit 0
fi

hin "$NEU new, $ERSETZT replaced, $GLEICH unchanged."
[ "$GESICHERT" -gt 0 ] && hin "$GESICHERT replaced file(s) kept in $SNAP"

# --------------------------------------------------------------------- the check
# Counted off against the repository itself, not against a list written down somewhere:
# every file that lies in the tree has to be at its target, with the same content and the
# same executable bit. A list that expects thirteen rule files and knows twelve is exactly
# the error this avoids -- it cannot go out of date, because it is derived from what is here.
sag "Checking"
GEPRUEFT=0; ABWEICHUNG=0
melde() { echo "   MISSING $*" >&2; ABWEICHUNG=$((ABWEICHUNG + 1)); }
for eintrag in "${ZIELE[@]}"; do
  name="${eintrag%%:*}"; ziel="${eintrag#*:}"
  quelle="$HIER/$name"
  [ -e "$quelle" ] || continue
  while IFS= read -r p; do
    if [ -f "$quelle" ]; then z="$ziel"; else z="$ziel/${p#$quelle/}"; fi
    GEPRUEFT=$((GEPRUEFT + 1))
    if [ ! -f "$z" ]; then melde "$z"; continue; fi
    cmp -s "$p" "$z" || { melde "$z (content differs)"; continue; }
    if [ -x "$p" ] && [ ! -x "$z" ]; then
      melde "$z (not executable, but it is in the repository)"
    fi
  done < <(if [ -f "$quelle" ]; then printf '%s\n' "$quelle"; else find "$quelle" -type f; fi)
done
if [ "$ABWEICHUNG" -gt 0 ]; then
  echo "ABORT: $ABWEICHUNG of $GEPRUEFT files did not arrive as they lie in the repository." >&2
  exit 1
fi
hin "$GEPRUEFT files, each one where it belongs and identical to the repository."

# ------------------------------------------------------------------------- the rest
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) sag "One thing left for you"
     hin "$HOME/.local/bin is not on your PATH. Add this to ~/.zshrc or ~/.bashrc:"
     hin '  export PATH="$HOME/.local/bin:$PATH"' ;;
esac

sag "wb-doctor"
if [ -x "$HOME/.local/bin/wb-doctor" ]; then
  "$HOME/.local/bin/wb-doctor"
  hin "wb-doctor finished with exit code $?."
else
  hin "not installed -- this repository does not carry it. Skipped."
fi

echo
echo "Done. INSTALL.md continues at the steps this script deliberately leaves to you:"
echo "the model registry, your own CLAUDE.md, and the knowledge base if you want one."
