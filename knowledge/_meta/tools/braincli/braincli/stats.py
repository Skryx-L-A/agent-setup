"""Vault health stats: note counts, links, orphans, assets, LFS size, backups."""
from __future__ import annotations

import datetime as dt
import subprocess
from pathlib import Path

from gardener import orphans as orphans_mod
from gardener.vault import Note
from gardener.vault import load_notes as load_link_corpus_notes

from .vault import load_search_notes

BACKUP_DIR = Path.home() / "Backups" / "knowledge-vault"


def branch_of(rel: str) -> str:
    """Top-level vault directory a note lives in (its 'branch')."""
    parts = Path(rel).parts
    return parts[0] if len(parts) > 1 else "(root)"


def count_wikilinks(notes: list[Note]) -> int:
    return sum(len(n.links) for n in notes)


def catalog_incoming(vault: Path) -> set[str]:
    """Delegiert an die EINE Definition in `gardener.orphans`.

    Es gab sie zweimal - hier und im Gardener - und beide waren auf dieselbe Art
    falsch. Zwei Definitionen an zwei Orten driften auseinander, deshalb steht sie
    jetzt einmal in `gardener/orphans.py`.
    """
    return orphans_mod.catalog_incoming(vault)


def find_orphans(notes: list[Note], extra_incoming: set[str] | None = None) -> list[str]:
    """Notizen ohne eingehenden Verweis - Quellschicht NICHT ausgenommen.

    Anders als `gardener.orphans.unreachable`: hier werden Quellnotizen mitgezaehlt
    und erst danach getrennt ausgewiesen, damit `brain stats` beide Zahlen zeigen
    kann. Der Gardener dagegen stellt sie gar nicht erst in die Review-Queue.
    """
    incoming: set[str] = set(extra_incoming or ())
    for n in notes:
        incoming |= n.links
    return [n.rel for n in notes
            if n.title_key not in incoming and n.stem_key not in incoming]


def split_orphans_by_layer(notes: list[Note], orphans: list[str]) -> dict[str, list[str]]:
    """Separate orphans the vault EXPECTS from orphans that are a real gap.

    Brain 4.0 says source-layer notes (`00-sources/`, any `sessions/`) are raw
    material reached by search, not by links -- every session note is born
    without an incoming link and stays that way. Counting them together with
    knowledge notes made the number grow by one per session forever, so the one
    knowledge note nobody links drowned in the noise.

    The layer is read from the note's own `class:` frontmatter, which the Brain 4
    migration wrote into every note -- not re-derived from the path, so there is
    no second definition of the layer to drift from the first. A note without
    `class` counts as knowledge: an unclassified orphan is worth looking at.
    """
    by_rel = {n.rel: n for n in notes}
    expected, real = [], []
    for rel in orphans:
        note = by_rel.get(rel)
        is_source = note is not None and orphans_mod.is_source_layer(note)
        (expected if is_source else real).append(rel)
    return {"source": expected, "knowledge": real}


def count_assets(vault: Path) -> int:
    return sum(1 for _ in vault.rglob("_assets/*") if _.is_file())


def lfs_object_size_bytes(vault: Path) -> int:
    git_dir_proc = subprocess.run(["git", "-C", str(vault), "rev-parse", "--git-dir"],
                                  capture_output=True, text=True, timeout=15)
    if git_dir_proc.returncode != 0:
        return 0
    git_dir = Path(git_dir_proc.stdout.strip())
    if not git_dir.is_absolute():
        git_dir = vault / git_dir
    lfs_objects = git_dir / "lfs" / "objects"
    if not lfs_objects.exists():
        return 0
    return sum(f.stat().st_size for f in lfs_objects.rglob("*") if f.is_file())


def last_backup_time(backup_dir: Path = BACKUP_DIR) -> str | None:
    bundles = sorted(backup_dir.glob("*/knowledge.bundle"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    if not bundles:
        return None
    return dt.datetime.fromtimestamp(bundles[0].stat().st_mtime).isoformat()


def collect(vault: Path) -> dict:
    """`notes_total`/`notes_per_branch`/`wikilinks_total`/orphans are computed
    over the SEARCH corpus (braincli.vault.load_search_notes) -- the same one
    `brain search` uses -- not gardener's own linking corpus. Gardener
    deliberately excludes MOC.md/DECISIONS.md/review-queue.md "at any depth"
    from ITS corpus (gardener/topics.py: kept out of its own auto-link-
    suggestion machinery on purpose, not touched here). Reusing that same
    exclusion for vault-health stats was the 2026-07-28 bug: `30-topics`
    consists ONLY of MOC.md files, so the branch reported as entirely absent,
    and note/link counts were undercounted vault-wide.

    `link_corpus_notes_total` is reported alongside `notes_total` so the two
    genuinely different counts (all real notes vs. gardener's own smaller
    auto-linking corpus) are both visible, with clear names, rather than
    picking one silently."""
    notes = load_search_notes(vault)
    link_corpus_notes = load_link_corpus_notes(vault)
    per_branch: dict[str, int] = {}
    for n in notes:
        b = branch_of(n.rel)
        per_branch[b] = per_branch.get(b, 0) + 1
    orphans = find_orphans(notes, catalog_incoming(vault))
    by_layer = split_orphans_by_layer(notes, orphans)
    return {
        "notes_total": len(notes),
        "notes_per_branch": dict(sorted(per_branch.items())),
        "link_corpus_notes_total": len(link_corpus_notes),
        "wikilinks_total": count_wikilinks(notes),
        "orphans_total": len(orphans),
        "orphans": orphans,
        "orphans_knowledge": by_layer["knowledge"],
        "orphans_source": by_layer["source"],
        "assets_total": count_assets(vault),
        "lfs_object_size_bytes": lfs_object_size_bytes(vault),
        "last_backup_bundle": last_backup_time(),
    }
