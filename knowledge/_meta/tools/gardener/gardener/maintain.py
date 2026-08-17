"""Maintenance run: orphan healing, MOC updates, HOT.md regeneration (read-heat
aware, with a resurfacing section), missing recency markers (Stand: YYYY-MM),
plus the generated DECISIONS.md / OPEN-QUESTIONS.md indexes."""
from __future__ import annotations

import datetime as dt
import logging
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import blocks, config, frontmatter, heat as heat_mod, orphans as orphans_mod
from .queue import ReviewQueue
from .vault import Note, VaultWriter, STAND_RE, read_text

log = logging.getLogger("gardener")

MOC_START = "<!-- gardener:moc:start -->"
MOC_END = "<!-- gardener:moc:end -->"

# [[Target|alias]] / [[Target]] -> the visible text, for hook lines
WIKILINK_INLINE_RE = re.compile(r"\[\[([^\]|#\n]+)(?:\|[^\]\n]*)?\]\]")

HOT_SYSTEM = (
    "You maintain a personal markdown knowledge vault. Write a dense recent-"
    "context summary (about 300 words, plain markdown, no emoji, German or "
    "English matching the input) of what happened recently, from the git log "
    "and the most recently changed notes. Facts only, no filler."
)


@dataclass
class MaintainResult:
    orphans_queued: list[str] = field(default_factory=list)
    mocs_updated: list[str] = field(default_factory=list)
    hot_updated: bool = False
    markers_added: list[str] = field(default_factory=list)
    resurfaced: list[str] = field(default_factory=list)
    cold_queued: list[str] = field(default_factory=list)
    decisions_written: list[str] = field(default_factory=list)
    open_questions: int = 0


def _git(vault: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(vault), *args],
                              capture_output=True, text=True, timeout=60).stdout
    except Exception as e:
        log.warning("git %s failed: %s", args, e)
        return ""


def find_orphans(notes: list[Note], vault: Path | None = None) -> list[Note]:
    """Notes that neither point anywhere nor are pointed at.

    `vault` lets the shared definition also read the pointer files that are not
    part of this corpus - INDEX.md, and the `MOC.md` hubs, which gardener
    excludes from its own linking corpus on purpose. Without it, a note that a
    hub page names looked like an orphan and was queued for review on every run
    (measured 2026-07-29 on macos-steam-civ6-damaged-fix.md).
    """
    incoming = orphans_mod.incoming_keys(notes, vault)
    return [n for n in notes
            if not n.links
            and not orphans_mod.is_source_layer(n)
            and n.title_key not in incoming and n.stem_key not in incoming]


def heal_orphans(notes: list[Note], writer: VaultWriter,
                 queue: ReviewQueue | None = None) -> list[str]:
    """Linking already tried to connect everything; leftover orphans go to review."""
    queue = queue or ReviewQueue(writer)
    queued = []
    for n in find_orphans(notes, writer.vault):
        queued.append(n.rel)
        queue.add(f"orphan [[{n.title}]] - keine Links ein/aus, Linking fand "
                  f"keinen Partner", key=f"orphan [[{n.title}]]")
    return queued


def first_hook_line(n: Note) -> str:
    """First real prose line of a note - the hook shown in MOC/DECISIONS lists.

    All frontmatter blocks are stripped, not just the first: Basic-Memory's sync
    prepends its own `permalink:` block, and stripping one block left the hook as
    literally `title: <x>` in every synced note.
    Wikilinks are flattened, so a hook cannot silently link notes the MOC does
    not actually list (which would also mask real moc-gap findings).
    """
    _fm, body = frontmatter.parse(n.text)
    for line in body.splitlines():
        line = line.strip().lstrip("#").strip()
        if line and not line.startswith(("<!--", "-", "[", "---")):
            return WIKILINK_INLINE_RE.sub(r"\1", line)[:100]
    return ""


def update_mocs(notes: list[Note], writer: VaultWriter) -> list[str]:
    projects: dict[str, list[Note]] = {}
    for n in notes:
        parts = Path(n.rel).parts
        if len(parts) >= 2 and parts[0] == "20-projects":
            projects.setdefault(parts[1], []).append(n)
    updated = []
    for proj, proj_notes in sorted(projects.items()):
        moc_path = writer.vault / "20-projects" / proj / "MOC.md"
        listing = "\n".join(
            f"- [[{n.title}]] - {first_hook_line(n)}"
            for n in sorted(proj_notes, key=lambda x: x.title.lower())
            if n.path != moc_path)
        block = f"{MOC_START}\n{listing}\n{MOC_END}"
        old = None
        if moc_path.exists():
            old = read_text(moc_path)
            new, ok = blocks.replace_block(old, MOC_START, MOC_END, block)
            if not ok:
                # unbalanced markers (hand edit, merge conflict): a regex sub
                # would swallow everything between them. Leave the file alone.
                log.warning("malformed gardener block in 20-projects/%s/MOC.md - "
                            "not rewriting it", proj)
                continue
            if new == old:
                if MOC_START in old:
                    continue                     # block already current
                new = old.rstrip("\n") + f"\n\n## Notes\n{block}\n"
        else:
            new = (f"---\ntitle: {proj} MOC\ntype: note\nbranch: 20-projects/{proj}\n---\n\n"
                   f"# {proj} - Map of Content\n\nKuratierter Einstieg (gardener-gepflegt).\n\n"
                   f"## Notes\n{block}\n")
        if writer.write(moc_path, new, expect=old):
            updated.append(f"20-projects/{proj}/MOC.md")
    return updated


def regenerate_hot(notes: list[Note], writer: VaultWriter, client,
                   heat: dict | None = None) -> tuple[bool, list[str]]:
    """HOT.md = LLM recent-context summary + read-heat top list + resurfacing.
    Returns (written, resurfaced rels)."""
    vault = writer.vault
    heat = heat if heat is not None else heat_mod.load_heat(vault)
    git_log = _git(vault, "log", "--since=14.days", "--oneline", "--no-merges")[:4000]
    recent = sorted(notes, key=heat_mod.mtime_of, reverse=True)[:10]
    hot_read = heat_mod.hottest(notes, heat, k=5)
    recent_txt = "\n\n".join(f"## {n.title} ({n.rel})\n{n.text[:800]}" for n in recent)
    summary = ""
    if client is not None:
        verdict = client.judge(
            HOT_SYSTEM,
            f"Git log (14 days):\n{git_log or '(empty)'}\n\nRecent notes:\n{recent_txt}\n\n"
            'Answer as JSON: {"summary": "<~300 words markdown>"}')
        summary = (verdict.get("summary") or "").strip()
    if not summary:
        summary = ("Recent notes:\n" +
                   "\n".join(f"- [[{n.title}]]" for n in recent) +
                   ("\n\nGit (14 days):\n```\n" + git_log.strip() + "\n```" if git_log.strip() else ""))

    parts = [f"---\ntitle: HOT\ntype: note\n---\n\n# HOT - Recent Context\n",
             f"Generated by gardener {dt.date.today().isoformat()}. "
             f"Do not edit by hand.\n",
             summary]
    if hot_read:
        parts.append(f"\n## Meistgelesen ({config.HOT_HEAT_DAYS} Tage)\n" +
                     "\n".join(f"- [[{n.title}]] ({c}x)" for n, c in hot_read))
    resurfaced = heat_mod.resurface(notes, heat)
    if resurfaced:
        parts.append("\n## Vergessene Schaetze\n" +
                     "Lange nicht gelesen, aber substanziell - lohnt einen Blick:\n" +
                     "\n".join(f"- [[{n.title}]] - {first_hook_line(n)}"
                               for n in resurfaced))
    writer.write(vault / "HOT.md", "\n".join(parts) + "\n")
    return True, [n.rel for n in resurfaced]


def add_recency_markers(notes: list[Note], writer: VaultWriter) -> list[str]:
    added = []
    for n in notes:
        # session notes are an immutable archive (INDEX.md); reports are transient
        if n.ntype in ("session", "report"):
            continue
        if STAND_RE.search(n.text):
            continue
        date = _git(writer.vault, "log", "-1", "--format=%as", "--", n.rel).strip()
        month = date[:7] if date else dt.date.today().strftime("%Y-%m")
        new_text = n.text.rstrip("\n") + f"\n\nStand: {month}\n"
        if not writer.write(n.path, new_text, expect=n.text):
            continue
        n.text = new_text
        added.append(n.rel)
    return added


def run_maintenance(notes: list[Note], writer: VaultWriter, client,
                    queue: ReviewQueue | None = None,
                    heat: dict | None = None,
                    today: dt.date | None = None) -> MaintainResult:
    from . import indexes  # local import: indexes builds on this module

    today = today or dt.date.today()
    queue = queue or ReviewQueue(writer)
    heat = heat if heat is not None else heat_mod.load_heat(writer.vault)
    r = MaintainResult()
    # before any write: add_recency_markers rewrites files and would reset the
    # mtime that cold_notes falls back on for never-read notes
    cold = heat_mod.cold_notes(notes, heat)
    r.orphans_queued = heal_orphans(notes, writer, queue)
    r.mocs_updated = update_mocs(notes, writer)
    r.hot_updated, r.resurfaced = regenerate_hot(notes, writer, client, heat)
    r.markers_added = add_recency_markers(notes, writer)
    r.decisions_written = indexes.update_decisions(notes, writer, today)
    _changed, r.open_questions = indexes.update_open_questions(notes, writer, today)
    # capped: the health report lists all cold notes, the queue only the top few
    for n in cold[:config.COLD_QUEUE_MAX]:
        if queue.add(f"lange nicht gelesen: [[{n.title}]] - seit >"
                     f"{config.COLD_MONTHS} Monaten kein Zugriff, noch relevant?",
                     key=f"lange nicht gelesen: [[{n.title}]]", today=today):
            r.cold_queued.append(n.rel)
    return r
