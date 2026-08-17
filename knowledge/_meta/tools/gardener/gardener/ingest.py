"""Drop-Ingest + asset-stub enrichment.

`00-sources/drop/` is the drop zone: any file put there is filed into the right
branch's `_assets/` folder, gets a `type: asset` stub note (its graph node), and
- PDF: local text extract + local summary in the stub,
- image: local vision description (when a vision model is available),
- anything else / unclear target branch: placeholder + review-queue entry.

Enrichment does the same for stubs that are still missing a description.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import blocks, config, extract, frontmatter
from .queue import ReviewQueue
from .vault import Note, VaultWriter

log = logging.getLogger("gardener")

DESC_START = "<!-- gardener:asset-desc:start -->"
DESC_END = "<!-- gardener:asset-desc:end -->"
PLACEHOLDER = ("Beschreibung offen: kein lokaler Extraktor/Vision-Modell "
               "verfuegbar. Datei bei Bedarf selbst oeffnen.")
DEFAULT_BRANCH = "10-global"


@dataclass
class IngestResult:
    ingested: list[tuple[str, str]] = field(default_factory=list)   # (file, target)
    enriched: list[str] = field(default_factory=list)
    queued: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def known_branches(vault: Path) -> list[str]:
    branches = ["10-global"]
    for top in ("20-projects", "30-topics"):
        base = vault / top
        if base.is_dir():
            branches += [f"{top}/{d.name}" for d in sorted(base.iterdir())
                         if d.is_dir() and not d.name.startswith((".", "_"))]
    return branches


def branch_key(branch: str) -> str:
    return branch.split("/")[-1].lower()


def guess_branch(vault: Path, filename: str, text: str) -> tuple[str, bool]:
    """(branch, confident). Filename beats content; ties are not confident."""
    haystack_name = filename.lower()
    haystack_text = text.lower()[:4000]
    scores: dict[str, int] = {}
    for branch in known_branches(vault):
        if branch == DEFAULT_BRANCH:
            continue
        key = branch_key(branch)
        score = 3 if key in haystack_name else 0
        score += min(haystack_text.count(key), 3)
        if score:
            scores[branch] = score
    if not scores:
        return DEFAULT_BRANCH, False
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    best, best_score = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0
    confident = best_score >= 2 and best_score >= 2 * runner_up
    return (best, True) if confident else (DEFAULT_BRANCH, False)


def free_path(path: Path, taken: set[Path]) -> Path:
    candidate, i = path, 1
    while candidate.exists() or candidate in taken:
        candidate = path.with_name(f"{path.stem}-{i}{path.suffix}")
        i += 1
    return candidate


def _slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()
    return s or "asset"


def stub_text(title: str, branch: str, asset_name: str, mime: str,
              description: str, source: str, today: dt.date) -> str:
    hook = (f"Für künftige Sessions: Stub für die Datei `{asset_name}`. "
            "Diese Note reicht in der Regel; die Datei selbst nur bei "
            "Detailfragen öffnen.")
    moc_title = f"{branch.split('/')[-1]} MOC" if "/" in branch else "INDEX"
    return (
        "---\n"
        f"title: {title}\n"
        "type: asset\n"
        f"branch: {branch}\n"
        f"path: {config.ASSET_DIR}/{asset_name}\n"
        f"mime: {mime}\n"
        f"source: {source}\n"
        f"created: {today.isoformat()}\n"
        "---\n\n"
        f"{hook}\n\n"
        f"{DESC_START}\n{description or PLACEHOLDER}\n{DESC_END}\n\n"
        f"part-of [[{moc_title}]]\n\n"
        f"Stand: {today.strftime('%Y-%m')}\n")


def set_description(text: str, description: str) -> tuple[str, bool]:
    """(new_text, ok). ok=False -> the stub's markers are malformed; do not write."""
    block = f"{DESC_START}\n{description}\n{DESC_END}"
    new, ok = blocks.replace_block(text, DESC_START, DESC_END, block)
    if not ok:
        return text, False
    if new == text and DESC_START not in text:
        new = text.rstrip("\n") + f"\n\n{block}\n"
    return new, True


RELATION_LINE = re.compile(
    r"^\s*(relates-to|part-of|depends-on|supersedes|contradicts)\s+\[\[", re.I)
MIN_DESCRIPTION_CHARS = 80


def has_own_description(note: Note) -> bool:
    """True when a person already described this asset, without our markers.

    A missing marker block means "we did not write this", not "this is empty".
    Five sidecars in this vault carry a proper hand-written description and no
    markers; treating them as undescribed made the gardener ask the model on
    every run, fail on their unknown mime, and re-queue the same five lines
    forever (measured 2026-07-29). A queue that regenerates its own false
    entries teaches the reader to ignore it.
    """
    _fm, body = frontmatter.parse(note.text)
    prose = [ln.strip() for ln in body.splitlines()]
    prose = [ln for ln in prose
             if ln and not ln.startswith(("#", ">", "<!--"))
             and not RELATION_LINE.match(ln)
             and ln != PLACEHOLDER]
    return len(" ".join(prose)) >= MIN_DESCRIPTION_CHARS


def needs_description(note: Note) -> bool:
    m = re.search(re.escape(DESC_START) + r"(.*?)" + re.escape(DESC_END),
                  note.text, re.DOTALL)
    if not m:
        return not has_own_description(note)
    body = m.group(1).strip()
    return not body or body == PLACEHOLDER


def asset_file(vault: Path, note: Note) -> Path | None:
    """Absolute path of the binary a `type: asset` stub points at."""
    rel_path = str(note.fm.get("path") or "").strip()
    branch = str(note.fm.get("branch") or note.branch).strip()
    if not rel_path:
        return None
    if rel_path.startswith(("10-global/", "20-projects/", "30-topics/")):
        return vault / rel_path
    return vault / branch / rel_path


def drop_files(vault: Path) -> list[Path]:
    drop = vault / config.DROP_DIR
    if not drop.is_dir():
        return []
    return [p for p in sorted(drop.rglob("*"))
            if p.is_file() and not p.name.startswith(".")]


def ingest_drop(vault: Path, writer: VaultWriter, client,
                queue: ReviewQueue, today: dt.date | None = None) -> IngestResult:
    today = today or dt.date.today()
    result = IngestResult()
    taken: set[Path] = set()
    for src in drop_files(vault):
        if src.suffix.lower() == ".md":
            dst = free_path(vault / "00-sources" / src.name, taken)
            taken.add(dst)
            writer.write(dst, src.read_text(encoding="utf-8", errors="replace"))
            if not writer.dry_run:
                src.unlink()
            result.ingested.append((src.name, dst.relative_to(vault).as_posix()))
            continue

        description, kind = extract.describe_file(client, src)
        text_hint = description
        if src.suffix.lower() == ".pdf" and not description:
            text_hint = extract.pdf_text(src, max_chars=2000)
        branch, confident = guess_branch(vault, src.name, text_hint)

        asset_dst = free_path(vault / branch / config.ASSET_DIR / src.name, taken)
        taken.add(asset_dst)
        stub_dst = free_path(
            vault / branch / config.ASSET_DIR / f"{_slug(src.stem)}.md", taken)
        taken.add(stub_dst)

        writer.move_asset(src, asset_dst)
        writer.write(stub_dst, stub_text(
            title=src.stem, branch=branch, asset_name=asset_dst.name,
            mime=extract.mime_of(src), description=description,
            source=f"{config.DROP_DIR}/{src.name}", today=today))
        result.ingested.append((src.name, asset_dst.relative_to(vault).as_posix()))

        if not confident:
            queue.add(f"Drop-Ingest: Zielbranch unklar fuer `{src.name}` - "
                      f"vorlaeufig nach {branch}/{config.ASSET_DIR}/ gelegt, "
                      f"Stub [[{src.stem}]] pruefen",
                      key=f"Drop-Ingest: Zielbranch unklar fuer `{src.name}`",
                      today=today)
            result.queued.append(src.name)
        if not description:
            queue.add(f"Asset ohne Beschreibung: [[{src.stem}]] ({kind}) - "
                      "lokal nicht extrahierbar, bitte Stub von Hand fuellen",
                      key=f"Asset ohne Beschreibung: [[{src.stem}]]", today=today)
            result.queued.append(src.name)
    return result


def enrich_stubs(vault: Path, notes: list[Note], writer: VaultWriter, client,
                 queue: ReviewQueue, result: IngestResult | None = None,
                 today: dt.date | None = None) -> IngestResult:
    """Fill in descriptions for existing asset stubs that still lack one."""
    today = today or dt.date.today()
    result = result or IngestResult()
    for n in notes:
        if n.ntype != "asset" or not needs_description(n):
            continue
        target = asset_file(vault, n)
        if target is None or not target.exists():
            result.skipped.append(n.rel)
            continue
        description, kind = extract.describe_file(client, target)
        if not description:
            queue.add(f"Asset ohne Beschreibung: [[{n.title}]] ({kind}) - "
                      "lokal nicht extrahierbar, bitte Stub von Hand fuellen",
                      key=f"Asset ohne Beschreibung: [[{n.title}]]", today=today)
            result.queued.append(n.rel)
            continue
        new_text, ok = set_description(n.text, description)
        if not ok:
            log.warning("malformed gardener block in %s - not rewriting it", n.rel)
            result.skipped.append(n.rel)
            continue
        if not writer.write(n.path, new_text, expect=n.text):
            result.skipped.append(n.rel)
            continue
        n.text = new_text
        result.enriched.append(n.rel)
    return result


def run_ingest(vault: Path, notes: list[Note], writer: VaultWriter, client,
               queue: ReviewQueue, today: dt.date | None = None) -> IngestResult:
    result = ingest_drop(vault, writer, client, queue, today)
    return enrich_stubs(vault, notes, writer, client, queue, result, today)
