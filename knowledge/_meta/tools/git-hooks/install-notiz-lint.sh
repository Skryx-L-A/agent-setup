#!/bin/sh
# Installiert den Notiz-Lint (pre-commit, nur Warnung) in den Kern und alle Space-Repos.
#   sh _meta/tools/git-hooks/install-notiz-lint.sh [VAULT]    (Vorgabe: ~/Knowledge)
# Kern-Worktrees teilen die Hooks des Kerns. Spaces haben ein eigenes .git und brauchen einen
# eigenen Eintrag. Gesetzt wird ein Symlink auf git-hooks/pre-commit dieses Vaults, damit
# Aenderungen am Linter ohne Neuinstallation greifen. Ein fremder pre-commit bleibt
# unangetastet (Meldung statt Ueberschreiben). Ein repo-eigenes core.hooksPath wird respektiert.
set -u
VAULT="${1:-$HOME/Knowledge}"
SRC="$VAULT/_meta/tools/git-hooks/pre-commit"
[ -f "$SRC" ] || { echo "fehlt: $SRC" >&2; exit 1; }
install_one() {
  repo="$1"
  # Ein repo-eigenes core.hooksPath (husky u. a.) gilt. Ein nur globales (seit 25.09.2026
  # ~/.claude/git-hooks, ein Verteiler, der danach die Hooks des Repos aufruft) nicht: dann
  # gehoert der Hook ins Repo (<git-common-dir>/hooks), sonst landete er im globalen Verteiler.
  if [ -n "$(git -C "$repo" config --local --get core.hooksPath 2>/dev/null)" ]; then
    hooks="$(git -C "$repo" rev-parse --git-path hooks 2>/dev/null)" || return 0
  else
    hooks="$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null)/hooks" || return 0
  fi
  case "$hooks" in /*) ;; *) hooks="$repo/$hooks" ;; esac
  mkdir -p "$hooks"
  ziel="$hooks/pre-commit"
  if [ -L "$ziel" ] && [ "$(readlink "$ziel")" = "$SRC" ]; then echo "schon da: $repo"; return 0; fi
  if [ -e "$ziel" ] || [ -L "$ziel" ]; then echo "fremder pre-commit, nicht ersetzt: $ziel" >&2; return 0; fi
  ln -s "$SRC" "$ziel" && echo "installiert: $repo"
}
install_one "$VAULT"
for d in "$VAULT"/20-projects/*/ "$VAULT"/30-topics/*/; do
  [ -d "$d.git" ] && install_one "${d%/}"
done
exit 0
