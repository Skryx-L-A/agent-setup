"""Linking run: embedding neighbors + unlinked mentions -> judge -> apply links."""
from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import config, vault
from .ollama import OllamaError, OllamaUnavailable
from .store import Store
from .vault import Note, VaultWriter

log = logging.getLogger("gardener")

JUDGE_SYSTEM = (
    "You maintain a personal markdown knowledge vault. You judge whether two "
    "notes should be wiki-linked. Answer ONLY with a JSON object: "
    '{"link": true|false, "type": "relates-to|depends-on|supersedes|part-of|contradicts", '
    '"confidence": 0.0-1.0, "placement": "inline|relations", "reason": "<short, concrete>"}. '
    "Link only when a reader of one note would genuinely benefit from opening the "
    "other one. Be conservative: shared vocabulary, both being about this machine, "
    "or both being project notes is NOT a link - answer link:false. "
    "Type rules, in order of preference: use 'relates-to' unless a stronger claim "
    "is literally true. 'depends-on' ONLY when A cannot be understood or carried "
    "out without B. 'part-of' ONLY when A is a component of the whole B describes. "
    "'supersedes' ONLY when A replaces B. 'contradicts' ONLY when the two state "
    "opposite facts. When in any doubt about the type, use 'relates-to'. "
    "confidence is how sure you are that the link is useful."
)

# Stems that say nothing about a note ("overview", "MOC"): they repeat across
# projects, so finding them in a text is no evidence that THIS note is meant.
GENERIC_KEYS = {"overview", "moc", "index", "plan", "notes", "readme", "log",
                "setup", "session", "report"}

RELATIONS_RE = re.compile(r"^## Relations[ \t]*\n(?:[ \t]*-[^\n]*\n?)*",
                          re.MULTILINE)


@dataclass
class LinkResult:
    added: list[tuple[str, str, str]] = field(default_factory=list)   # (a, b, type)
    rejected: list[tuple[str, str, str]] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def chunk_text(text: str, size: int = config.EMBED_CHUNK_CHARS,
               overlap: int = config.EMBED_CHUNK_OVERLAP,
               max_chunks: int = config.EMBED_MAX_CHUNKS) -> list[str]:
    """Overlapping windows that each fit the embedding model's context."""
    if len(text) <= size:
        return [text]
    step = max(size - overlap, 1)
    chunks = [text[i:i + size] for i in range(0, len(text), step)]
    return [c for c in chunks[:max_chunks] if c.strip()]


def mean_pool(vectors: list[list[float]]) -> list[float]:
    if len(vectors) == 1:
        return vectors[0]
    n = len(vectors)
    return [sum(v[i] for v in vectors) / n for i in range(len(vectors[0]))]


def embed_document(client, text: str) -> list[float]:
    """Embed a whole note, not just its first 2048 tokens.

    embeddinggemma silently drops everything past its 2048-token context
    (measured: ~8000-9000 chars of German prose). `a project/overview.md` is 19932
    chars, so 60% of it never influenced a single link. Long notes are embedded
    in overlapping chunks and mean-pooled instead.
    """
    return mean_pool([client.embed(c) for c in chunk_text(text)])


def cache_key(note: Note) -> str:
    """Content hash, versioned: bumping EMBED_VERSION retires vectors that were
    produced by an older (truncating) embedding path."""
    return f"v{config.EMBED_VERSION}:{note.content_hash}"


def embed_notes(notes: list[Note], store: Store, client,
                deadline=None) -> dict[str, list[float]]:
    """Embed all notes, reusing the SQLite cache via content hash.
    Stops early on deadline; callers must skip notes without a vector."""
    vectors: dict[str, list[float]] = {}
    for n in notes:
        cached = store.get_embedding(n.rel, cache_key(n))
        if cached is not None:
            vectors[n.rel] = cached
            continue
        if deadline is not None and deadline.expired():
            log.warning("deadline during embedding: %d/%d notes embedded",
                        len(vectors), len(notes))
            break
        try:
            vec = embed_document(client, n.embed_text)  # includes fm aliases
        except OllamaUnavailable:
            raise                              # Ollama is gone: abort the run
        except OllamaError as e:
            # one note the model choked on must not cost the whole run; it
            # simply sits out this pass (callers skip notes without a vector)
            log.warning("embedding failed for %s: %s - skipping this run", n.rel, e)
            continue
        store.put_embedding(n.rel, cache_key(n), vec)
        vectors[n.rel] = vec
        log.info("embedded %s", n.rel)
    store.prune_embeddings({n.rel for n in notes})
    return vectors


def neighbor_candidates(notes: list[Note], vectors: dict[str, list[float]],
                        top_k: int | None = None,
                        min_sim: float | None = None,
                        ) -> list[tuple[Note, Note, float]]:
    """Brute-force cosine top-k per note (fine at this vault size)."""
    top_k = config.NEIGHBOR_TOP_K if top_k is None else top_k
    min_sim = config.LINK_MIN_SIMILARITY if min_sim is None else min_sim
    pairs: dict[tuple[str, str], tuple[Note, Note, float]] = {}
    for i, a in enumerate(notes):
        sims = []
        for b in notes:
            if b.rel == a.rel:
                continue
            sims.append((cosine(vectors[a.rel], vectors[b.rel]), b))
        sims.sort(key=lambda t: -t[0])
        for sim, b in sims[:top_k]:
            if sim < min_sim:
                break
            key = tuple(sorted((a.rel, b.rel)))
            if key not in pairs:
                pairs[key] = (a, b, sim)
    return list(pairs.values())


def mention_candidates(notes: list[Note]) -> list[tuple[Note, Note, float]]:
    """Pairs where one note's title appears in another's text but is not linked."""
    out = []
    seen: set[tuple[str, str]] = set()
    for target in notes:
        title = target.title.strip()
        if len(title) < 4:
            continue
        pat = re.compile(r"(?<!\[)\b" + re.escape(title) + r"\b", re.IGNORECASE)
        for src in notes:
            if src.rel == target.rel:
                continue
            if target.title_key in src.links or target.stem_key in src.links:
                continue
            if pat.search(src.text):
                key = tuple(sorted((src.rel, target.rel)))
                if key not in seen:
                    seen.add(key)
                    out.append((src, target, 1.0))
    return out


def mentions(src: Note, dst: Note) -> bool:
    """True if src's own prose names dst.

    The gardener-managed `## Relations` section is cut out first: otherwise a
    link the gardener wrote itself counts as evidence for that same link on the
    next run (self-confirming).
    """
    hay = RELATIONS_RE.sub("", src.text).lower()
    keys = {k for k in dst.keys if len(k) >= 5 and k not in GENERIC_KEYS}
    return any(k in hay for k in keys)


def is_staging(note: Note) -> bool:
    """True for raw, unreviewed material (00-sources/: mined candidates, drops).

    These notes are explicitly UNVERIFIED and a human still has to promote them.
    """
    parts = Path(note.rel).parts
    return bool(parts) and parts[0] == config.STAGING_DIR


def validate_verdict(verdict: dict, a: Note, b: Note) -> dict:
    """Normalize the judge's answer and downgrade claims it cannot support.

    A 9B judge happily asserts `depends-on` between two notes that never mention
    each other (run 2026-07-12: `grundschule-wasbuettel overview` depends-on
    `BRAIN3-PLAN`). Structural types make a hard claim about the graph, so they
    are only accepted when one note actually references the other; otherwise the
    edge survives as the honest weaker claim, `relates-to`.

    Mentioning something is not the same as standing in a relation TO it, so the
    evidence gate alone still let two bad edges through (run 2026-07-12): a mined
    00-sources candidate claimed to SUPERSEDE the canonical note it was extracted
    from, and `brain-cli depends-on Brain.app` was simply inverted. Nothing in
    00-sources/ is reviewed yet, so it may never carry a structural type at all -
    in either direction.
    """
    if verdict.get("type") not in config.RELATION_TYPES:
        verdict["type"] = "relates-to"
    if verdict.get("placement") not in ("inline", "relations"):
        verdict["placement"] = "relations"
    if verdict["type"] in config.STRUCTURAL_TYPES:
        if is_staging(a) or is_staging(b):
            log.info("downgraded %s -> relates-to for %s <-> %s "
                     "(unreviewed 00-sources note)", verdict["type"], a.rel, b.rel)
            verdict["type"] = "relates-to"
        elif not (mentions(a, b) or mentions(b, a)):
            log.info("downgraded %s -> relates-to for %s <-> %s "
                     "(no textual evidence)", verdict["type"], a.rel, b.rel)
            verdict["type"] = "relates-to"
    return verdict


def confidence_of(verdict: dict) -> float | None:
    """The judge's confidence, or None when it did not report one (older models
    omit the field - that must not be read as zero and reject every link)."""
    raw = verdict.get("confidence")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def judge_pair(client, a: Note, b: Note) -> dict:
    prompt = (
        f"Note A: {a.title} ({a.rel})\n---\n{a.text[:1500]}\n\n"
        f"Note B: {b.title} ({b.rel})\n---\n{b.text[:1500]}\n\n"
        "Should these notes be linked?"
    )
    verdict = client.judge(JUDGE_SYSTEM, prompt)
    if not verdict:
        return {}  # judge failed (non-JSON): caller must not treat as "no"
    return validate_verdict(verdict, a, b)


def _apply_relation(text: str, rel_type: str, title: str) -> str:
    line = f"- {rel_type} [[{title}]]"
    # Insert inside the existing Relations section (it may not be the last
    # block: recency markers etc. can follow), else append a new section.
    m = re.search(r"^## Relations[ \t]*\n((?:[ \t]*-[^\n]*\n?)*)", text, re.MULTILINE)
    if m:
        end = m.end()
        return text[:end].rstrip("\n") + f"\n{line}\n" + text[end:]
    return text.rstrip("\n") + f"\n\n## Relations\n{line}\n"


def add_link(writer: VaultWriter, src: Note, dst: Note,
             rel_type: str, placement: str) -> bool:
    # Only the Relations section is ever touched. Inline substitution corrupted
    # frontmatter, paths, and existing wikilinks in run 1 (2026-07-10).
    new_text = _apply_relation(src.text, rel_type, dst.title)
    if not writer.write(src.path, new_text, expect=src.text):
        return False        # changed on disk mid-run: leave it to the next run
    src.text = new_text
    src.links.add(dst.title_key)
    src.links.add(dst.stem_key)
    return True


def run_linking(notes: list[Note], vectors: dict[str, list[float]],
                store: Store, client, writer: VaultWriter,
                deadline=None) -> LinkResult:
    result = LinkResult()
    new_links_count: dict[str, int] = {n.rel: 0 for n in notes}

    candidates = neighbor_candidates(notes, vectors) + mention_candidates(notes)
    seen: set[tuple[str, str]] = set()
    candidates = [c for c in candidates
                  if not (key := tuple(sorted((c[0].rel, c[1].rel)))) in seen
                  and not seen.add(key)]
    candidates.sort(key=lambda t: -t[2])
    log.info("%d link candidates", len(candidates))

    for a, b, sim in candidates:
        if deadline is not None and deadline.expired():
            result.skipped.append("deadline reached")
            break
        if vault.linked_pair(a, b):
            continue
        # Titles like "overview"/"MOC" repeat across projects; a [[title]] link
        # would resolve to the same-named note in the source's own folder.
        if a.title_key == b.title_key:
            continue
        # Titles containing wikilink syntax would produce broken/mis-parsed links.
        if any(ch in a.title or ch in b.title for ch in "[]|#\n"):
            result.skipped.append(f"unsafe title: {a.rel} <-> {b.rel}")
            continue
        if store.is_blocked(a.rel, b.rel, "link"):
            continue
        if (new_links_count[a.rel] >= config.MAX_NEW_LINKS_PER_NOTE
                or new_links_count[b.rel] >= config.MAX_NEW_LINKS_PER_NOTE):
            result.skipped.append(f"cap: {a.rel} <-> {b.rel}")
            continue
        verdict = judge_pair(client, a, b)
        if not verdict:
            # transient judge failure: skip WITHOUT blocklisting, retry next run
            result.skipped.append(f"judge failed: {a.rel} <-> {b.rel}")
            continue
        if verdict.get("link"):
            conf = confidence_of(verdict)
            if conf is not None and conf < config.LINK_MIN_CONFIDENCE:
                # an unsure "yes" is not a "no": skip it, do NOT blocklist -
                # a later run (better context, more text) may be sure.
                result.skipped.append(
                    f"low confidence {conf:.2f}: {a.rel} <-> {b.rel}")
                continue
            rel_type = verdict["type"]
            if not add_link(writer, a, b, rel_type, verdict["placement"]):
                continue
            back = rel_type if rel_type in ("relates-to", "contradicts") else "relates-to"
            add_link(writer, b, a, back, "relations")
            new_links_count[a.rel] += 1
            new_links_count[b.rel] += 1
            result.added.append((a.rel, b.rel, rel_type))
        else:
            store.block(a.rel, b.rel, "link", verdict.get("reason", ""))
            result.rejected.append((a.rel, b.rel, verdict.get("reason", "")))
    return result
