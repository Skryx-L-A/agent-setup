#!/bin/sh
# Installiert das Nachbetten (post-commit, post-merge, post-rewrite) in den Kern und alle Space-Repos.
#   sh _meta/tools/git-hooks/install-nachbetten.sh [-n] [VAULT]    (Vorgabe: ~/Knowledge; -n = nur anzeigen)
# Wie install-notiz-lint.sh: ein Symlink je Hook auf git-hooks/post-commit dieses Vaults (Aenderungen
# greifen ohne Neuinstallation). Die von `git lfs install` erzeugten Hooks (drei Zeilen, nur
# `git lfs <name>`) ersetzt der Hook, denn er ruft git lfs selbst zuerst auf; sie werden vorher
# nach $BRAIN_NACHBETTEN_SNAPSHOT (Vorgabe ~/.local/trash-snapshots/<datum>-nachbetten-hooks/<repo>/)
# gesichert. Jeder andere fremde Hook bleibt unangetastet (Meldung statt Ueberschreiben).
# Ein repo-eigenes core.hooksPath (husky u. a.) wird respektiert. Kern-Worktrees teilen die Hooks des Kerns.
set -u
DRY=0
[ "${1:-}" = "-n" ] && { DRY=1; shift; }
VAULT="${1:-$HOME/Knowledge}"
SRC="$VAULT/_meta/tools/git-hooks/post-commit"
[ -f "$SRC" ] || { echo "fehlt: $SRC" >&2; exit 1; }
SNAP="${BRAIN_NACHBETTEN_SNAPSHOT:-$HOME/.local/trash-snapshots/$(date +%Y-%m-%d)-nachbetten-hooks}"

ist_lfs_stub() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -q 'git lfs ' "$1" && [ "$(wc -l < "$1")" -le 6 ]
}

install_one() {
  repo="$1"
  if [ -n "$(git -C "$repo" config --local --get core.hooksPath 2>/dev/null)" ]; then
    hooks="$(git -C "$repo" rev-parse --git-path hooks 2>/dev/null)" || return 0
  else
    hooks="$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null)/hooks" || return 0
  fi
  case "$hooks" in /*) ;; *) hooks="$repo/$hooks" ;; esac
  for name in post-commit post-merge post-rewrite; do
    ziel="$hooks/$name"
    if [ -L "$ziel" ] && [ "$(readlink "$ziel")" = "$SRC" ]; then echo "schon da: $repo ($name)"; continue; fi
    if [ -e "$ziel" ] || [ -L "$ziel" ]; then
      if ist_lfs_stub "$ziel"; then
        if [ "$DRY" = 1 ]; then echo "wuerde LFS-Hook ersetzen: $ziel"; continue; fi
        s="$SNAP/$(basename "$repo")"; mkdir -p "$s" && cp -p "$ziel" "$s/$name" || { echo "Sicherung fehlgeschlagen: $ziel" >&2; continue; }
        rm -f "$ziel"
      else
        echo "fremder $name, nicht ersetzt: $ziel" >&2; continue
      fi
    fi
    if [ "$DRY" = 1 ]; then echo "wuerde installieren: $ziel"; continue; fi
    mkdir -p "$hooks" && ln -s "$SRC" "$ziel" && echo "installiert: $repo ($name)"
  done
}
install_one "$VAULT"
for d in "$VAULT"/20-projects/*/ "$VAULT"/30-topics/*/; do
  [ -d "$d.git" ] && install_one "${d%/}"
done
exit 0
