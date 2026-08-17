"""Consolidation run: duplicate/contradiction candidates via high-similarity
embedding neighbors. Clear cases are auto-merged (rewrite), unclear cases go
to review-queue.md (vault root). Never destructive beyond the pre-run git commit.
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field

from . import config, frontmatter
from .linking import cosine
from .queue import ReviewQueue
from .store import Store
from .vault import Note, VaultWriter

log = logging.getLogger("gardener")

MERGE_SYSTEM = (
    "You maintain a personal markdown knowledge vault. Two notes look very "
    "similar. Decide: are they duplicates that should be merged into one note, "
    "contradictory/unclear (needs human review), or genuinely distinct? "
    'Answer ONLY with JSON: {"action": "merge|review|distinct", '
    '"confidence": 0.0-1.0, "reason": "<short>", '
    '"merged_markdown": "<full merged note body, only when action=merge>"}. '
    "When merging, keep the frontmatter of note A, integrate all unique facts, "
    "resolve contradictions in favor of the more recent statement, keep wikilinks."
)


@dataclass
class ConsolidateResult:
    merged: list[tuple[str, str]] = field(default_factory=list)
    queued: list[tuple[str, str, str]] = field(default_factory=list)
    distinct: list[tuple[str, str]] = field(default_factory=list)


def merge_candidates(notes: list[Note], vectors: dict[str, list[float]],
                     min_sim: float = config.MERGE_MIN_SIMILARITY,
                     ) -> list[tuple[Note, Note, float]]:
    out = []
    for i, a in enumerate(notes):
        for b in notes[i + 1:]:
            sim = cosine(vectors[a.rel], vectors[b.rel])
            if sim >= min_sim:
                out.append((a, b, sim))
    return out


def queue_review(writer: VaultWriter, a: Note, b: Note, reason: str,
                 queue: ReviewQueue | None = None) -> None:
    q = queue or ReviewQueue(writer)
    q.add(f"[[{a.title}]] vs [[{b.title}]] - {reason}",
          key=f"[[{a.title}]] vs [[{b.title}]]")


def run_consolidation(notes: list[Note], vectors: dict[str, list[float]],
                      store: Store, client, writer: VaultWriter,
                      deadline=None, queue: ReviewQueue | None = None,
                      ) -> ConsolidateResult:
    result = ConsolidateResult()
    queue = queue or ReviewQueue(writer)
    for a, b, sim in merge_candidates(notes, vectors):
        if deadline is not None and deadline.expired():
            break
        # Session notes are an immutable archive (vault convention): never merge.
        if a.ntype == "session" or b.ntype == "session":
            continue
        if store.is_blocked(a.rel, b.rel, "merge"):
            continue
        prompt = (
            f"Note A: {a.title} ({a.rel})\n---\n{a.text[:3000]}\n\n"
            f"Note B: {b.title} ({b.rel})\n---\n{b.text[:3000]}\n\n"
            f"Cosine similarity: {sim:.2f}. Merge, review, or distinct?"
        )
        verdict = client.judge(MERGE_SYSTEM, prompt)
        if not verdict:
            # transient judge failure: skip WITHOUT queueing/blocking, retry next run
            log.warning("judge failed for %s / %s - skipping", a.rel, b.rel)
            continue
        action = verdict.get("action")
        try:
            confidence = float(verdict.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        merged = verdict.get("merged_markdown") or ""
        # Merged text must roughly cover the LARGER note, else data loss.
        if (action == "merge" and confidence >= config.MERGE_MIN_CONFIDENCE
                and len(merged) >= 0.5 * max(len(a.text), len(b.text))):
            # The judge may return a body without frontmatter, or (worse) a copy
            # of a Basic-Memory double block. Normalize to exactly one block.
            merged = frontmatter.ensure_single(merged, fallback=a.fm or
                                               {"title": a.title, "type": a.ntype})
            if not writer.write(a.path, merged, expect=a.text):
                # A changed on disk mid-run. Writing B's stub now would delete B
                # while the merged text never landed: skip the pair entirely.
                log.warning("merge aborted: %s changed on disk", a.rel)
                continue
            stub = (f"---\ntitle: {b.title}\ntype: note\n---\n\n"
                    f"Merged into [[{a.title}]] by gardener "
                    f"({dt.date.today().isoformat()}).\n\n"
                    f"supersedes: see [[{a.title}]]\n")
            if not writer.write(b.path, stub, expect=b.text):
                # A now holds the merged content; B keeps its own. Duplicated,
                # but nothing is lost - the next run sees it again.
                log.warning("merge half-applied: %s kept (changed on disk)", b.rel)
                continue
            # Keep in-memory notes in sync: maintenance runs on the same objects
            # afterwards and would otherwise rewrite files with pre-merge text.
            a.text = merged
            b.text = stub
            b.links = {a.title_key, a.stem_key}
            # Idempotency: without this the next run re-judges the merged note
            # against its own stub.
            store.block(a.rel, b.rel, "merge", "merged")
            result.merged.append((a.rel, b.rel))
            log.info("merged %s <- %s (confidence %.2f)", a.rel, b.rel, confidence)
        elif action == "distinct" and confidence >= config.MERGE_MIN_CONFIDENCE:
            store.block(a.rel, b.rel, "merge", verdict.get("reason", "distinct"))
            result.distinct.append((a.rel, b.rel))
        else:
            reason = verdict.get("reason", f"unclear (action={action}, conf={confidence:.2f})")
            queue_review(writer, a, b, reason, queue)
            store.block(a.rel, b.rel, "merge", "queued for review")
            result.queued.append((a.rel, b.rel, reason))
    return result
