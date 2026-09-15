"""Vault health stats: note counts, links, orphans, assets, LFS size, backups."""
from __future__ import annotations

import datetime as dt
import os
import subprocess
from pathlib import Path

from gardener import config, orphans as orphans_mod
from gardener import topics as topics_mod
from gardener.linking import cache_key as embed_cache_key
from gardener.store import Store
from gardener.vault import Note
from gardener.vault import load_notes as load_link_corpus_notes

from .vault import load_search_notes

BACKUP_DIR = Path.home() / "Backups" / "knowledge-vault"

# Thresholds for index_health() -- see that function's docstring for how they
# were picked (2026-09-02: both real incidents cleared these by a wide
# margin, ordinary editing lag between gardener runs does not).
INDEX_STALE_RATIO = 0.20   # 20%+ of today's embed corpus lacks a current-hash vector
INDEX_STALE_DAYS = 7.0     # newest vector this many days older than the latest vault commit


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


def _raw_markdown_files(vault: Path) -> list[Path]:
    """Every `.md` file on disk under only the hard structural exclusions
    (90-secrets, .git, .obsidian, _meta) -- no content-based filtering. The
    baseline `notes_excluded_by_reason` measures the search corpus against."""
    exclude_dirs_cf = {d.casefold() for d in config.EXCLUDE_DIRS}
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(vault, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".")
                       and d.casefold() not in exclude_dirs_cf
                       and not (here / d).is_symlink()]
        for name in filenames:
            if name.endswith(".md") and not (here / name).is_symlink():
                out.append(here / name)
    return out


def _exclusion_reason(vault: Path, path: Path) -> str:
    """Why the search corpus (`load_search_notes`) leaves this file out.
    Mirrors the checks in `braincli.vault._is_excluded`, but names the reason
    instead of a bare bool, so counts can be labelled instead of silent."""
    rel_parts = path.relative_to(vault).parts
    name = rel_parts[-1]
    exclude_files_cf = {f.casefold() for f in config.EXCLUDE_FILES}
    if len(rel_parts) == 1 and name.casefold() in exclude_files_cf:
        return "generated top-level file (HOT/INDEX/LOG/...)"
    if name in (config.EXCLUDE_ANY_DEPTH - {"MOC.md"}):
        return "generated aggregator (DECISIONS.md/review-queue.md)"
    if name.startswith(config.EXCLUDE_PREFIXES):
        return "generated report (gardener-report-/brain-health-/dream-report-)"
    if Path(*rel_parts[:-1]).as_posix().startswith(config.DROP_DIR):
        return "unprocessed drop zone (00-sources/drop)"
    return "other"


def notes_excluded_by_reason(vault: Path, search_notes: list[Note]) -> dict[str, int]:
    """Files that exist on disk but that `notes_total` does not count,
    grouped by reason.

    The exclusion itself is deliberate (generated reports/aggregators are not
    vault content, see `braincli.vault` module docstring) -- but a bare
    `notes_total` that silently drops files nobody reading the number would
    expect gone is a trap. Confirmed 2026-09-02: `brain stats --json` read
    "00-sources": 28 against 41 real files on disk in that branch, a 13-file
    gap with no indication anywhere in the output that anything was left out,
    let alone what. This makes that gap visible and named instead of silent.
    """
    loaded = {n.rel for n in search_notes}
    counts: dict[str, int] = {}
    for path in _raw_markdown_files(vault):
        rel = path.relative_to(vault).as_posix()
        if rel in loaded:
            continue
        reason = _exclusion_reason(vault, path)
        counts[reason] = counts.get(reason, 0) + 1
    return counts


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


def _embed_corpus(vault: Path) -> list[Note]:
    """The exact corpus gardener's own embedding pass covers today -- mirrors
    `gardener/cli.py`'s `linking.embed_notes(notes + hubs, ...)` call
    (`notes` = the link corpus, `hubs` = the topic hubs `topics.load_hubs`
    embeds for its own hub-membership logic; deduplicated by rel)."""
    notes = load_link_corpus_notes(vault)
    hubs = topics_mod.load_hubs(vault)
    seen = {n.rel for n in notes}
    return notes + [h for h in hubs if h.rel not in seen]


def _latest_vault_commit(vault: Path) -> dt.datetime | None:
    proc = subprocess.run(["git", "-C", str(vault), "log", "-1", "--format=%cI"],
                          capture_output=True, text=True, timeout=15)
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    return dt.datetime.fromisoformat(proc.stdout.strip())


def index_health(vault: Path, db_path: Path | None = None) -> dict:
    """How far the gardener embedding index (`_meta/tools/gardener/state/
    gardener.db`) has drifted from the vault's current content.

    That index is deliberately machine-local, never in git (gardener/
    config.py STATE_DIR) -- which is exactly why it drifts silently between
    machines without anyone noticing. Confirmed 2026-09-02: the Mac held 301
    vectors from 2026-08-20 while peer held 2 vectors from 2026-08-04 --
    `brain search` on peer was running its semantic ranker off almost
    nothing, with nothing anywhere saying so. This function is the
    visibility fix; callers (`brain stats`, `brain search`) decide how loud
    to be about it.

    Two independent signals, either one enough to call the index stale:

    - `stale_ratio`: share of today's embed corpus with no embeddings-table
      row whose `hash` matches the note's CURRENT content hash -- exact, via
      the same cache key gardener's own `embed_notes()` uses, no Ollama call
      needed (so this is cheap enough to run on every invocation). Flags at
      INDEX_STALE_RATIO = 20%: normal lag between gardener runs (a handful of
      edited/new notes not yet re-embedded) stays a few percent on this
      vault's size; the real peer incident measured ~99%.
    - `days_behind_commit`: how much older the newest vector in the index is
      than the vault's latest git commit. Flags at INDEX_STALE_DAYS = 7 days:
      comfortably past a normal multi-day gap between sessions (this vault
      sees session gaps of well under a day in normal use, per `git log`),
      but far under both real incidents (13 and 29 days behind respectively).

    Scoped to gardener.db on purpose -- braincli's own supplementary MOC.md
    cache (`extra_embed.py`, a different machine-local file with its own,
    much smaller, lifecycle) is not this finding's subject and is left out.
    """
    db_path = (config.tool_dir_for(vault) / "state" / "gardener.db"
              if db_path is None else Path(db_path))
    corpus = _embed_corpus(vault)
    if db_path.exists():
        store = Store(db_path, read_only=True)
        try:
            rows = dict(store.conn.execute("SELECT rel, hash FROM embeddings").fetchall())
            newest_ts = store.conn.execute(
                "SELECT max(updated) FROM embeddings").fetchone()[0]
        finally:
            store.close()
    else:
        rows, newest_ts = {}, None

    stale_rels = [n.rel for n in corpus if rows.get(n.rel) != embed_cache_key(n)]
    stale_ratio = (len(stale_rels) / len(corpus)) if corpus else 0.0

    newest_vector_at = (dt.datetime.fromtimestamp(newest_ts, tz=dt.timezone.utc)
                        if newest_ts else None)
    latest_commit_at = _latest_vault_commit(vault)
    days_behind = None
    if newest_vector_at is not None and latest_commit_at is not None:
        days_behind = (latest_commit_at - newest_vector_at).total_seconds() / 86400

    reasons: list[str] = []
    if stale_ratio >= INDEX_STALE_RATIO:
        reasons.append(f"{len(stale_rels)}/{len(corpus)} Notizen im Suchindex ohne "
                       f"aktuellen Vektor ({stale_ratio:.0%})")
    if days_behind is not None and days_behind >= INDEX_STALE_DAYS:
        reasons.append(f"juengster Vektor {days_behind:.1f} Tage aelter als der "
                       f"juengste Vault-Commit")

    return {
        "vectors_total": len(rows),
        "embed_corpus_total": len(corpus),
        "stale_notes_total": len(stale_rels),
        "stale_ratio": round(stale_ratio, 4),
        "newest_vector_at": newest_vector_at.isoformat() if newest_vector_at else None,
        "latest_commit_at": latest_commit_at.isoformat() if latest_commit_at else None,
        "days_behind_commit": round(days_behind, 2) if days_behind is not None else None,
        "stale": bool(reasons),
        "reasons": reasons,
    }


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
    picking one silently.

    `notes_excluded_by_reason` names every file on disk that `notes_total`
    itself leaves out (generated reports, aggregators, the drop zone), so
    that number never silently undercounts either -- see
    `notes_excluded_by_reason`'s own docstring for the 2026-09-02 case that
    made this necessary."""
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
        "notes_excluded_by_reason": notes_excluded_by_reason(vault, notes),
        "link_corpus_notes_total": len(link_corpus_notes),
        "wikilinks_total": count_wikilinks(notes),
        "orphans_total": len(orphans),
        "orphans": orphans,
        "orphans_knowledge": by_layer["knowledge"],
        "orphans_source": by_layer["source"],
        "assets_total": count_assets(vault),
        "lfs_object_size_bytes": lfs_object_size_bytes(vault),
        "last_backup_bundle": last_backup_time(),
        "index_health": index_health(vault),
    }
