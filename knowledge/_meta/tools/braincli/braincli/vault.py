"""Search-specific note corpus: a superset of gardener's linking corpus.

Gardener's own note walk (`gardener.vault.load_notes` / `is_excluded`) hard-
excludes `MOC.md` (and `DECISIONS.md`, `review-queue.md`) "at any depth" --
correct for gardener's own purpose (keeping its auto-link-suggestion
machinery out of hub pages it wrote itself: see `gardener/topics.py`'s
docstring, "MOC.md is excluded from the linking corpus"). `braincli.search`
used to reuse that exact same walk for search, so every `MOC.md` in the vault
-- the vault's own curated project/topic entry points -- got zero BM25 signal,
and (except the 4 `30-topics/*/MOC.md` hubs gardener embeds separately for its
own hub-membership logic via `topics.load_hubs()`) zero embedding signal
either. Measured root cause: _meta/tools/eval/results/moc-root-cause.md.

This loader restores `MOC.md` to the searchable corpus but keeps
`DECISIONS.md`/`review-queue.md` excluded -- those really are pure
gardener-generated aggregators whose content duplicates notes already in the
corpus (confirmed by reading a sample: `zasterzentrale/DECISIONS.md` is just a
generated wikilink pointer to the real `type: decision` note, which already
indexes fine on its own).
"""
from __future__ import annotations

import os
from pathlib import Path

from gardener import config
from gardener.vault import Note, parse_note

_EXCLUDE_DIRS_CF = {d.casefold() for d in config.EXCLUDE_DIRS}
_ROOT_EXCLUDE_FILES_CF = {f.casefold() for f in config.EXCLUDE_FILES}
# The one deliberate difference from gardener's linking-corpus exclusion:
# MOC.md stays searchable. Everything else gardener excludes at any depth
# (DECISIONS.md, review-queue.md) stays excluded here too.
_SEARCH_ANY_DEPTH_EXCLUDE = config.EXCLUDE_ANY_DEPTH - {"MOC.md"}


def _is_excluded(rel: Path) -> bool:
    parts = rel.parts
    if not parts:
        return True
    if any(p.casefold() in _EXCLUDE_DIRS_CF or p.startswith(".") for p in parts[:-1]):
        return True
    name = parts[-1]
    if len(parts) == 1 and name.casefold() in _ROOT_EXCLUDE_FILES_CF:
        return True
    if name in _SEARCH_ANY_DEPTH_EXCLUDE or name.startswith(config.EXCLUDE_PREFIXES):
        return True
    if Path(*parts[:-1]).as_posix().startswith(config.DROP_DIR):
        return True
    return False


def iter_search_markdown(vault: Path) -> list[Path]:
    """All search-corpus markdown files. Mirrors gardener.vault.iter_markdown's
    walk (symlink-safe, same directory exclusions) but with the MOC.md fix."""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(vault, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith(".")
            and d.casefold() not in _EXCLUDE_DIRS_CF
            and not (here / d).is_symlink())
        for name in sorted(filenames):
            if not name.endswith(".md"):
                continue
            path = here / name
            if path.is_symlink():
                continue
            if _is_excluded(path.relative_to(vault)):
                continue
            out.append(path)
    return sorted(out)


def load_search_notes(vault: Path) -> list[Note]:
    vault = Path(vault)
    return [parse_note(vault, path) for path in iter_search_markdown(vault)]
