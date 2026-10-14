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

# Auftrag g6 (24.09.2026): one call per source note with up to
# BATCH_MAX_CANDIDATES candidates, prompt from the pilot
# `_meta/tools/eval/v2-gaertner/vorversuch_sammelurteil.py` (15 notes, 58
# pairs: 51/58 agreement with the run, stricter - 19 yes instead of 26), with
# the reason capped at 8 words and candidates cut to BATCH_CANDIDATE_CHARS.
# Splash is compute-bound (4 streams barely beat 1), so tokens are the cost:
# measured on 16 groups / 80 pairs (eval/v2-gaertner/linking-bau/), 18.1 pairs
# per minute with the pilot prompt, 22.1 with the short reason (80/80 same
# verdicts), 29.9 with short reason plus 800-char candidates (77/80 same).
BATCH_SYSTEM = (
    "You maintain a personal markdown knowledge vault. You get ONE source note "
    "and several candidate notes. For EACH candidate decide whether the source "
    "should be wiki-linked to it. Link only when a reader of the source would "
    "genuinely benefit from opening that candidate. Be conservative: shared "
    "vocabulary, both being about this machine, or both being notes of the same "
    "project is NOT a link. Answer ONLY with a JSON object: "
    '{"verdicts": [{"id": <candidate number>, "link": true|false, '
    '"type": "relates-to|depends-on|supersedes|part-of|contradicts", '
    '"confidence": 0.0-1.0, "reason": "<at most 8 words>"}, ...]} '
    "with exactly one entry per candidate. Use 'relates-to' unless a stronger "
    "type is literally true."
)
# Batch prompting loses quality from 6-8 items per call (arXiv 2301.08721).
BATCH_MAX_CANDIDATES = 5
BATCH_CANDIDATE_CHARS = 800     # the source note keeps its 1500

# Stems that say nothing about a note ("overview", "MOC"): they repeat across
# projects, so finding them in a text is no evidence that THIS note is meant.
GENERIC_KEYS = {"overview", "moc", "index", "plan", "notes", "readme", "log",
                "setup", "session", "report"}

# canonical definition lives in vault (Note.embed_text cuts the same section)
RELATIONS_RE = vault.RELATIONS_RE


@dataclass
class LinkResult:
    added: list[tuple[str, str, str]] = field(default_factory=list)   # (a, b, type)
    rejected: list[tuple[str, str, str]] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    hub_filtered: int = 0     # candidate pairs dropped because of a hub partner
    remaining: int = 0       # candidates left for a later run at the deadline


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
    """Hash of the embedded text (``Note.embed_hash``), versioned: bumping
    EMBED_VERSION retires vectors that were produced by an older embedding
    path.  The ``r`` mark keeps vectors of the rollback rule
    (``BRAIN_EMBED_RELATIONS=1``) apart.  Frontmatter-only edits keep the key."""
    marke = "r" if vault.embed_relations() else ""
    return f"v{config.EMBED_VERSION}{marke}:{note.embed_hash}"


def embed_notes(notes: list[Note], store: Store, client,
                deadline=None, dry_run: bool = False) -> dict[str, list[float]]:
    """Embed all notes, reusing the SQLite cache via content hash.
    Stops early on deadline; callers must skip notes without a vector.

    `dry_run=True` never calls the model, only the cache: a note already
    embedded on a prior run still gets its vector, everything else is left
    out of the returned dict. Auftrag "zeitgrenze" Nachtrag (04.09.2026):
    the gardener's own dry run had the same bug the dream's reconcile step
    did - `embed_notes` called the real Ollama client regardless of
    `args.dry_run`, so `gardener run --dry-run` embedded every uncached
    note for real."""
    vectors: dict[str, list[float]] = {}
    for n in notes:
        cached = store.get_embedding(n.rel, cache_key(n))
        if cached is not None:
            vectors[n.rel] = cached
            continue
        if dry_run:
            continue
        if deadline is not None and deadline.expired(
                "embed", done=len(vectors), total=len(notes)):
            log.warning("deadline during embedding: %d/%d notes embedded",
                        len(vectors), len(notes))
            break
        try:
            vec = embed_document(client, n.embed_text)  # title + aliases + prose
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


def _link_prompt(a: Note, b: Note) -> str:
    return (
        f"Note A: {a.title} ({a.rel})\n---\n{a.text[:1500]}\n\n"
        f"Note B: {b.title} ({b.rel})\n---\n{b.text[:1500]}\n\n"
        "Should these notes be linked?"
    )


def judge_pair(client, a: Note, b: Note) -> dict:
    verdict = client.judge(JUDGE_SYSTEM, _link_prompt(a, b))
    if not verdict:
        return {}  # judge failed (non-JSON): caller must not treat as "no"
    return validate_verdict(verdict, a, b)


def _is_kern(note) -> bool:
    """KERN.md files are session start context: never append links to them."""
    return str(getattr(note, "rel", "")).rsplit("/", 1)[-1] == "KERN.md"


def judge_pairs(client, pairs: list[tuple[Note, Note]], *,
                parallel: int) -> list[dict]:
    """Wie `judge_pair`, aber fuer mehrere Paare auf einmal - nutzt
    `client.judge_many` (gleichzeitige Stroeme, siehe grug_client.py), wenn
    der Client das anbietet, sonst seriell wie bisher. Ergebnisreihenfolge
    entspricht `pairs`.

    `parallel` wird EXPLIZIT durchgereicht statt `judge_many` seinen eigenen
    Vorgabewert waehlen zu lassen - sonst waeren `run_linking`s Buendelgroesse
    und die tatsaechliche Strom-Zahl im Client zwei verschiedene Zahlen, und
    "eine Stelle, an der die Zahl aenderbar ist" (Auftrag "modellwege") waere
    keine mehr."""
    prompts = [(JUDGE_SYSTEM, _link_prompt(a, b)) for a, b in pairs]
    judge_many = getattr(client, "judge_many", None)
    if judge_many is not None:
        raw = judge_many(prompts, parallel=parallel)
    else:
        raw = [client.judge(system, prompt) for system, prompt in prompts]
    return [validate_verdict(v, a, b) if v else {}
           for (a, b), v in zip(pairs, raw)]


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


def is_hub(note) -> bool:
    """KERN/STATUS/E&F/LOG/overview files and everything in the vault root.

    Auftrag g6 (24.09.2026): in the sample of 40 links from the run of 24.09.
    all 14 links with a hub partner were trivial - the hub is reachable from
    the project folder anyway - and 28 % of all judged pairs had one. They are
    dropped before the judge is asked, on either side of the pair."""
    parts = Path(str(getattr(note, "rel", ""))).parts
    if len(parts) <= 1:
        return True
    name = parts[-1]
    if name in config.LINK_HUB_NAMES or name.endswith(config.LINK_HUB_SUFFIXES):
        return True
    # Some old overview files have ordinary names. A dense list of links with
    # little prose is a hub regardless of its filename.
    body = str(getattr(note, "text", ""))
    lines = body.splitlines()
    relation_lines = sum(bool(re.match(r"\s*-\s+(?:relates-to|part-of|depends-on|"
                                       r"supersedes|contradicts)\s+\[\[", line))
                         for line in lines)
    links = len(re.findall(r"\[\[[^\]]+\]\]", body))
    return (relation_lines >= 20 and relation_lines * 2 >= len(lines)
            or links >= 8 and links * 35 >= len(body))


def batch_prompt(a: Note, cands: list[Note]) -> str:
    parts = [f"SOURCE: {a.title} ({a.rel})\n---\n{a.text[:1500]}\n"]
    for i, b in enumerate(cands, 1):
        parts.append(f"CANDIDATE {i}: {b.title} ({b.rel})\n---\n"
                     f"{b.text[:BATCH_CANDIDATE_CHARS]}\n")
    parts.append("Judge every candidate.")
    return "\n".join(parts)


def parse_batch(raw: dict | None, n: int) -> list[dict]:
    """The judge's batch answer as one raw verdict per candidate (1..n).

    A missing, duplicate-shadowed or malformed entry comes back as `{}`, the
    same "judge failed" marker `judge_pair` uses: the caller skips that pair
    without blocklisting it, so a later run asks again."""
    out: list[dict] = [{} for _ in range(n)]
    if not isinstance(raw, dict):
        return out
    entries = raw.get("verdicts")
    if entries is None and n == 1 and "link" in raw:
        entries = [dict(raw, id=1)]      # a bare verdict for a single candidate
    if not isinstance(entries, list):
        return out
    for e in entries:
        if not isinstance(e, dict) or "link" not in e:
            continue
        try:
            idx = int(e.get("id")) - 1
        except (TypeError, ValueError):
            continue
        if 0 <= idx < n and not out[idx]:
            out[idx] = {k: v for k, v in e.items() if k != "id"}
    return out


def judge_batches(client, groups: list[tuple[Note, list[Note]]], *,
                  parallel: int) -> list[list[dict]]:
    """One call per `(source, candidates)` group, up to `parallel` groups at
    the same time via `client.judge_many` (serial `judge` otherwise). Returns,
    per group, one validated verdict per candidate, `{}` where the judge left
    the candidate out."""
    prompts = [(BATCH_SYSTEM, batch_prompt(a, cands)) for a, cands in groups]
    judge_many = getattr(client, "judge_many", None)
    if judge_many is not None:
        raw = judge_many(prompts, parallel=parallel)
    else:
        raw = [client.judge(system, prompt) for system, prompt in prompts]
    return [[validate_verdict(v, a, b) if v else {}
             for b, v in zip(cands, parse_batch(r, len(cands)))]
            for (a, cands), r in zip(groups, raw)]


def _capped(a: Note, b: Note, counts: dict[str, int]) -> bool:
    return (counts[a.rel] >= config.MAX_NEW_LINKS_PER_NOTE
            or counts[b.rel] >= config.MAX_NEW_LINKS_PER_NOTE)


def _prefilter(a: Note, b: Note, store: Store, writer, result: LinkResult,
               counts: dict[str, int] | None) -> tuple[Note, Note] | None:
    """Everything decided BEFORE the model is asked, because after it the
    verdict would be thrown away. Returns the pair oriented (source first)
    or None. Run of 24.09.2026: 777 of 2213 candidates judged in 44 minutes,
    43 links written, 192 rejected - the rest of the judge time went to pairs
    dropped after the verdict (cap reached, note not writable).

    `counts=None` leaves the cap to the caller (batch mode checks it per
    round, right before the call)."""
    if vault.linked_pair(a, b):
        return None
    # Titles like "overview"/"MOC" repeat across projects; a [[title]] link
    # would resolve to the same-named note in the source's own folder.
    if a.title_key == b.title_key:
        return None
    # Titles containing wikilink syntax would produce broken/mis-parsed links.
    if any(ch in a.title or ch in b.title for ch in "[]|#\n"):
        result.skipped.append(f"unsafe title: {a.rel} <-> {b.rel}")
        return None
    if is_hub(a) or is_hub(b):
        result.hub_filtered += 1
        return None
    if store.is_blocked(a.rel, b.rel, "link"):
        return None
    if counts is not None and _capped(a, b, counts):
        result.skipped.append(f"cap: {a.rel} <-> {b.rel}")
        return None
    # KERN.md is start context (injected every session, size-capped): it may
    # be a link target, but nothing is ever appended to it. (The hub filter
    # already drops KERN pairs; this stays as the hard guarantee, a9ac43a.)
    if _is_kern(a) and _is_kern(b):
        return None
    if _is_kern(a):
        a, b = b, a
    can_rewrite = getattr(writer, "can_rewrite", None)
    if can_rewrite is not None:
        is_local = getattr(writer, "is_local")
        if is_local(a.path) or is_local(b.path):
            # IDENTITY/HANDOFF/gitignored: never source, never target
            return None
        ok_a, ok_b = can_rewrite(a.path, a.text), can_rewrite(b.path, b.text)
        if not ok_a and not ok_b:
            return None
        if not ok_a:
            # the link is written into the source first; a protected source
            # (session, foreign author) would drop the whole link, a
            # protected target only the back-link
            a, b = b, a
    if _is_kern(a):
        return None
    return a, b


def _swappable(b: Note, writer) -> bool:
    """True when the oriented pair's target could be the source as well."""
    if _is_kern(b):
        return False
    can_rewrite = getattr(writer, "can_rewrite", None)
    return can_rewrite is None or can_rewrite(b.path, b.text)


def _apply_verdict(a: Note, b: Note, verdict: dict, store: Store, writer,
                   result: LinkResult, counts: dict[str, int]) -> None:
    # Deferred cap check: live counts, evaluated in the order the candidates
    # were originally sorted in.
    if _capped(a, b, counts):
        result.skipped.append(f"cap: {a.rel} <-> {b.rel}")
        return
    if not verdict:
        # transient judge failure or entry missing from a batch answer: skip
        # WITHOUT blocklisting, retry next run
        result.skipped.append(f"judge failed: {a.rel} <-> {b.rel}")
        return
    if verdict.get("link"):
        conf = confidence_of(verdict)
        if conf is not None and conf < config.LINK_MIN_CONFIDENCE:
            # an unsure "yes" is not a "no": skip it, do NOT blocklist - a
            # later run (better context, more text) may be sure.
            result.skipped.append(f"low confidence {conf:.2f}: {a.rel} <-> {b.rel}")
            return
        rel_type = verdict["type"]
        if not add_link(writer, a, b, rel_type, verdict["placement"]):
            return
        back = rel_type if rel_type in ("relates-to", "contradicts") else "relates-to"
        if not _is_kern(b):
            add_link(writer, b, a, back, "relations")
        counts[a.rel] += 1
        counts[b.rel] += 1
        result.added.append((a.rel, b.rel, rel_type))
    else:
        store.block(a.rel, b.rel, "link", verdict.get("reason", ""))
        result.rejected.append((a.rel, b.rel, verdict.get("reason", "")))


def run_linking(notes: list[Note], vectors: dict[str, list[float]],
                store: Store, client, writer: VaultWriter,
                deadline=None, parallel: int | None = None,
                mode: str | None = None) -> LinkResult:
    """Judge link candidates and write the accepted links.

    `mode` (default `config.LINK_JUDGE_MODE`): "batch" groups the candidates
    by source note and judges up to BATCH_MAX_CANDIDATES per call, `parallel`
    calls at a time; "pair" is the old one-call-per-pair path (way back).

    DEFEKT 2 (Nachtrag zum Auftrag "modellwege", 02.09.2026): die
    Urteilsaufrufe laufen in Buendeln von bis zu `parallel` Aufrufen
    gleichzeitig (Vorgabe: `grug_client.GRUG_JUDGE_PARALLEL`). Die einzige
    Pruefung, die von zuvor in DIESEM Lauf geschriebenen Links abhaengt
    (`MAX_NEW_LINKS_PER_NOTE`), wird NACH dem Urteil erneut geprueft, mit dem
    dann aktuellen Stand - genau da, wo seriell auch geschrieben wuerde. Das
    kostet hoechstens ein paar bereits verbrauchte Urteile fuer ein
    inzwischen gedeckeltes Paar; es lockert die Deckelung selbst nicht."""
    if parallel is None:
        from .grug_client import GRUG_JUDGE_PARALLEL
        engine = getattr(client, "engine", None)
        parallel = getattr(engine, "parallel", GRUG_JUDGE_PARALLEL)
    parallel = max(1, parallel)
    mode = mode or config.LINK_JUDGE_MODE
    result = LinkResult()
    counts: dict[str, int] = {n.rel: 0 for n in notes}

    candidates = neighbor_candidates(notes, vectors) + mention_candidates(notes)
    seen: set[tuple[str, str]] = set()
    candidates = [c for c in candidates
                  if not (key := tuple(sorted((c[0].rel, c[1].rel)))) in seen
                  and not seen.add(key)]
    candidates.sort(key=lambda t: -t[2])
    log.info("%d link candidates, judge mode %s", len(candidates), mode)

    if mode == "pair":
        _run_pairs(candidates, store, client, writer, deadline, parallel,
                   result, counts)
    else:
        _run_batches(candidates, store, client, writer, deadline, parallel,
                     result, counts)
    log.info("linking: %d added, %d rejected, %d hub pairs filtered",
             len(result.added), len(result.rejected), result.hub_filtered)
    return result


def _run_pairs(candidates, store, client, writer, deadline, parallel,
               result: LinkResult, counts: dict[str, int]) -> None:
    i = 0
    while i < len(candidates):
        if deadline is not None and deadline.expired(
                "linking", done=i, total=len(candidates)):
            result.skipped.append("deadline reached")
            result.remaining = len(candidates) - i
            break
        batch: list[tuple[Note, Note]] = []
        while len(batch) < parallel and i < len(candidates):
            a, b, _sim = candidates[i]
            i += 1
            pair = _prefilter(a, b, store, writer, result, counts)
            if pair is not None:
                batch.append(pair)
        if not batch:
            continue
        verdicts = judge_pairs(client, batch, parallel=parallel)
        for (a, b), verdict in zip(batch, verdicts):
            _apply_verdict(a, b, verdict, store, writer, result, counts)


def _run_batches(candidates, store, client, writer, deadline, parallel,
                 result: LinkResult, counts: dict[str, int]) -> None:
    # Orient and filter every pair once, then group by source note in the
    # order of each group's best similarity (candidates are sorted), so a
    # deadline cuts the weakest groups.
    pairs: list[tuple[int, Note, Note, bool]] = []
    for idx, (a, b, _sim) in enumerate(candidates):
        pair = _prefilter(a, b, store, writer, result, None)
        if pair is not None:
            pairs.append((idx, *pair, _swappable(pair[1], writer)))
    # A pair whose target may just as well be the source (writable, not KERN)
    # joins the note with more candidates: the source text is sent once per
    # call, so fuller groups mean fewer tokens per pair. Run of 24.09. on a
    # copy without this: 544 pairs in 200 calls (2.7 per call).
    degree: dict[str, int] = {}
    for _idx, a, b, _free in pairs:
        degree[a.rel] = degree.get(a.rel, 0) + 1
        degree[b.rel] = degree.get(b.rel, 0) + 1
    groups: dict[str, list[tuple[int, Note, Note]]] = {}
    for idx, a, b, free in pairs:
        if free and degree[b.rel] > degree[a.rel]:
            a, b = b, a
        groups.setdefault(a.rel, []).append((idx, a, b))
    chunks = [g[j:j + BATCH_MAX_CANDIDATES] for g in groups.values()
              for j in range(0, len(g), BATCH_MAX_CANDIDATES)]
    total = sum(len(c) for c in chunks)
    log.info("%d pairs in %d batch calls after filtering (%d hub pairs dropped)",
             total, len(chunks), result.hub_filtered)
    done = 0
    for r in range(0, len(chunks), parallel):
        if deadline is not None and deadline.expired(
                "linking", done=done, total=total):
            result.skipped.append("deadline reached")
            result.remaining = total - done
            break
        round_: list[tuple[Note, list[tuple[int, Note, Note]]]] = []
        for chunk in chunks[r:r + parallel]:
            done += len(chunk)
            live = []
            for item in chunk:
                if _capped(item[1], item[2], counts):
                    result.skipped.append(f"cap: {item[1].rel} <-> {item[2].rel}")
                else:
                    live.append(item)
            if live:
                round_.append((live[0][1], live))
        if not round_:
            continue
        verdicts = judge_batches(
            client, [(a, [it[2] for it in items]) for a, items in round_],
            parallel=parallel)
        flat = [(item, v) for (_a, items), vs in zip(round_, verdicts)
                for item, v in zip(items, vs)]
        flat.sort(key=lambda t: t[0][0])
        for (_idx, a, b), verdict in flat:
            _apply_verdict(a, b, verdict, store, writer, result, counts)
