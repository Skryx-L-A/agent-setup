"""Hybrid search over the vault: BM25 (lexical) + Gardener embeddings
(semantic), fused with Reciprocal Rank Fusion. Falls back to BM25-only
when Ollama is unreachable."""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from gardener import config
from gardener.ollama import OllamaClient, OllamaError
from gardener.store import Store
from gardener.vault import parse_note

from .vault import load_search_notes

SESSION_HOOK_RE_PREFIXES = ("Für künftige Sessions", "Fuer kuenftige Sessions")

# Reciprocal Rank Fusion constant (standard default from the RRF paper).
RRF_K = 60

TOKEN_RE = re.compile(r"[\w']+", re.UNICODE)

# MOC.md/STATUS.md retrieval fix (2026-07-28), measured in
# _meta/tools/eval/results/moc-root-cause.md + moc-fix-comparison.md. Root cause was
# structural: gardener excludes MOC.md from its own linking corpus
# (gardener/topics.py), and braincli's search reused that same walk, so MOC.md
# got zero BM25 signal and (except the 4 30-topics hubs gardener embeds for
# its own hub logic) zero embedding signal either -- see .vault.load_search_notes
# and .extra_embed for the corpus/embedding side of the fix. These two
# constants are the second half: even after MOC.md re-enters both rankers,
# Reciprocal Rank Fusion still structurally favors a mediocre hit-in-both-lists
# over a note that is the single strongest semantic match but appears in only
# one list. Tuned via a small grid (title 1-4, nav 0.10-0.30) on 28 real
# queries: TITLE_BOOST=2.0 (title/query token-overlap bonus, any note) and
# NAV_BOOST=0.15 (MOC.md/STATUS.md bonus, navigational-looking queries only)
# together took overall recall@1 0.571->0.750 and MRR 0.707->0.839 with no
# regression, and the MOC/STATUS query subset to recall@1/3/5/MRR=1.0. A third
# option (append linked-note titles to a hub's indexed text) measured
# flat-to-negative on its own and was dropped from the combination -- the
# vault's own MOC.md files already carry real prose, not just link lists.
TITLE_BOOST = 2.0
NAV_BOOST = 0.15
HUB_BASENAMES = {"MOC.md", "STATUS.md"}
NAV_TRIGGERS = (
    "wo ", "wo faengt", "wo fängt", "themen-hub", "themenhub", "stand von",
    "stand vom", "stand beim", "aktueller stand", "übersicht", "uebersicht",
    "einstieg", "welche entscheidungen", "entscheidungen zu", "entscheidungen gibt",
    " moc", "status von", "status vom",
)


# Validity (2026-08-10). The dream retires a superseded claim by setting
# `valid_to` in state/dream/claims.db and leaves its text byte for byte in
# place (gardener/dream/apply.py, D2). Search never knew about it, so a note
# whose statements have been superseded ranked exactly like a fresh one.
# TEPA (arXiv 2608.07429) measures what that costs: under a full reversal of
# the facts an appending memory scores 0.210 and no memory at all 0.309, while
# a memory with an explicit retraction reaches 0.950 - delivering stale
# knowledge is worse than delivering none. So a hit gets marked and demoted,
# following the marker `brain contradict` already uses. It is never hidden and
# never dropped: `_flag_retired` runs on the FINAL top-k list, after
# truncation, so demotion can only reorder what search was already going to
# show. Retirement itself stays reversible in claims.db (`valid_to` back to
# NULL) and this layer follows that value, it never stores a judgement of its
# own.
#
# VALIDITY_DEMOTION is the demotion at full supersession; it scales with the
# share of a note's claims that are retired, so one wrongly retired claim in a
# note of sixteen costs 1/16 of it. Derived from the score distribution of the
# real vault ($HOME/Knowledge, 330 notes) on 2026-08-10: 30 German
# questions, hybrid search with Ollama up, no fallback run. Scores are
# max-normalized, so the top hit is 1.0 and the demotion has to carry a fully
# retired top hit below the weakest hit still in the list. Lowest last-rank
# score measured was 0.5037 at k=5 and 0.4921 at k=10, so the factor must
# exceed 1 - 0.4921 = 0.5079; 0.51 clears both (1 - 0.51 = 0.49 < 0.4921) and
# a fully retired top hit therefore sorts last in all 60 measured lists. It
# keeps 49% of its score, which is a demotion, not a removal.
VALIDITY_DEMOTION = 0.51
VALIDITY_ENV = "BRAIN_VALIDITY"
CLAIM_SOURCE_PREFIX = "vault:"   # the only source kind that names a vault note


@dataclass
class SearchHit:
    rel: str
    score: float
    title: str = ""
    snippet: str = ""
    match: str = ""  # "semantic" | "text" | "hybrid"
    cosine: float = 0.0  # raw cosine similarity, 0.0 if never seen by semantic_search
    contradiction: bool = False  # True if `brain contradict` has an open finding on this note
    retired: bool = False  # True if the dream has retired at least one claim from this note
    retired_claims: int = 0  # how many of the note's claims carry a valid_to
    total_claims: int = 0  # how many claims the dream drew from this note at all
    retired_since: str = ""  # newest valid_to among them, ISO date, "" if none


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def rank(query_vector: list[float], entries: list[tuple[str, list[float]]],
         k: int) -> list[SearchHit]:
    """Pure ranking: cosine-similarity top-k over (rel, vector) entries."""
    scored = [SearchHit(rel=rel, score=cosine(query_vector, vec))
              for rel, vec in entries]
    scored.sort(key=lambda h: h.score, reverse=True)
    return scored[:k]


def hook_snippet(text: str) -> str:
    """First line matching the vault's 'Für künftige Sessions' recall convention,
    else the first non-empty, non-frontmatter body line."""
    lines = text.splitlines()
    in_frontmatter = False
    body_start = 0
    for i, line in enumerate(lines):
        if i == 0 and line.strip() == "---":
            in_frontmatter = True
            continue
        if in_frontmatter:
            if line.strip() == "---":
                body_start = i + 1
                in_frontmatter = False
            continue
        body_start = i
        break
    for line in lines[body_start:]:
        s = line.strip()
        if s.startswith(SESSION_HOOK_RE_PREFIXES):
            return s
    for line in lines[body_start:]:
        s = line.strip()
        if s and not s.startswith("#"):
            return s
    return ""


def load_all_embeddings(store: Store) -> list[tuple[str, list[float]]]:
    rows = store.conn.execute("SELECT rel, vector FROM embeddings").fetchall()
    import json
    return [(rel, json.loads(vec)) for rel, vec in rows]


def load_merged_embeddings(store: Store, vault: Path | None = None
                           ) -> list[tuple[str, list[float]]]:
    """Gardener's own embeddings, topped up with braincli's supplementary
    MOC.md cache (see extra_embed.py) so project MOC.md notes -- which
    gardener never embeds -- get a semantic signal too. On a rel present in
    both (the 4 30-topics hubs gardener embeds for its own hub-membership
    logic), the supplementary store wins: it is guaranteed freshly recomputed
    against the current file content, gardener's may be stale."""
    from .extra_embed import EXTRA_DB_PATH, extra_db_path

    extra_db = EXTRA_DB_PATH if vault is None else extra_db_path(vault)
    merged: dict[str, list[float]] = dict(load_all_embeddings(store))
    if extra_db.exists():
        extra_store = Store(extra_db, read_only=True)
        try:
            merged.update(dict(load_all_embeddings(extra_store)))
        finally:
            extra_store.close()
    return list(merged.items())


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def _max_normalize(hits: list[SearchHit]) -> list[SearchHit]:
    """Rescale scores to [0, 1] by dividing by the top hit's score, so callers
    (the auto-recall hook's score threshold) see a comparable range regardless
    of which ranker - or fusion - produced the list."""
    if not hits:
        return hits
    top = hits[0].score
    if top > 0:
        for h in hits:
            h.score = h.score / top
    return hits


def _title_boosted_scores(notes: list, query_tokens: set[str], scores) -> list[float]:
    """Adds TITLE_BOOST per query/title token overlap -- a note whose title
    literally names what's asked for should not have to out-lexical a longer,
    more verbose note on raw term frequency alone."""
    if not query_tokens:
        return list(scores)
    boosted = list(scores)
    for i, n in enumerate(notes):
        overlap = len(query_tokens & set(tokenize(n.title)))
        if overlap:
            boosted[i] += TITLE_BOOST * overlap
    return boosted


def bm25_rank(vault: Path, query: str, k: int) -> list[SearchHit]:
    """Lexical top-k over the whole corpus, built in-memory at query time
    (the vault is small enough - ~100 notes, single-digit ms - that a
    persistent index isn't worth the staleness risk). Title/query token
    overlap gets a fixed bonus on top of the raw BM25 score (TITLE_BOOST)."""
    from rank_bm25 import BM25Okapi

    notes = load_search_notes(vault)
    if not notes:
        return []
    corpus_tokens = [tokenize(n.text) for n in notes]
    bm25 = BM25Okapi(corpus_tokens)
    scores = _title_boosted_scores(notes, set(tokenize(query)), bm25.get_scores(tokenize(query)))
    ranked = sorted(zip(notes, scores), key=lambda p: p[1], reverse=True)
    hits = [SearchHit(rel=n.rel, score=float(s), title=n.title,
                       snippet=hook_snippet(n.text), match="text")
            for n, s in ranked[:k] if s > 0]
    return _max_normalize(hits)


def semantic_search(vault: Path, query: str, k: int) -> list[SearchHit]:
    store = Store(config.STATE_DIR / "gardener.db", read_only=True)
    try:
        entries = load_merged_embeddings(store, vault)
    finally:
        store.close()
    if not entries:
        return []
    client = OllamaClient()
    qvec = client.embed(query)  # raises OllamaError if Ollama is down
    hits = rank(qvec, entries, k)
    for h in hits:
        h.match = "semantic"
        h.cosine = h.score  # score gets rescaled downstream (RRF/normalize); cosine stays raw
        note_path = vault / h.rel
        if note_path.exists():
            note = parse_note(vault, note_path)
            h.title = note.title
            h.snippet = hook_snippet(note.text)
    return hits


def rrf_fuse(rankings: list[tuple[str, list[SearchHit]]], k: int,
             rrf_k: int = RRF_K) -> list[SearchHit]:
    """Reciprocal Rank Fusion: combine several ranked hit lists (each tagged
    with a source label, e.g. "semantic"/"text") into one ranking. A note that
    scores well in *both* rankers - a hybrid match - naturally floats up
    without any hand-tuned weight between BM25 and cosine scores, which live
    on incomparable scales."""
    rrf_scores: dict[str, float] = {}
    best_hit: dict[str, SearchHit] = {}
    sources: dict[str, set[str]] = {}
    cosines: dict[str, float] = {}
    for label, hits in rankings:
        for i, h in enumerate(hits):
            rrf_scores[h.rel] = rrf_scores.get(h.rel, 0.0) + 1.0 / (rrf_k + i + 1)
            sources.setdefault(h.rel, set()).add(label)
            cosines[h.rel] = max(cosines.get(h.rel, 0.0), h.cosine)
            if h.rel not in best_hit or (h.title and not best_hit[h.rel].title):
                best_hit[h.rel] = h

    fused = []
    for rel, score in rrf_scores.items():
        h = best_hit[rel]
        labels = sources[rel]
        match = "hybrid" if len(labels) > 1 else next(iter(labels))
        fused.append(SearchHit(rel=rel, score=score, title=h.title,
                                snippet=h.snippet, match=match, cosine=cosines[rel]))
    fused.sort(key=lambda h: h.score, reverse=True)
    return _max_normalize(fused[:k])


def _is_navigational(query: str) -> bool:
    q = query.lower()
    return any(t in q for t in NAV_TRIGGERS)


def _apply_nav_boost(hits: list[SearchHit], query: str) -> list[SearchHit]:
    """Fixed post-fusion bonus for MOC.md/STATUS.md hits, only on
    navigational-looking queries ("Themen-Hub fuer X", "Stand von Y", ...).
    See the NAV_BOOST/TITLE_BOOST comment above for why RRF needs this."""
    if not _is_navigational(query) or not hits:
        return hits
    boosted = [
        SearchHit(rel=h.rel,
                  score=h.score + NAV_BOOST if Path(h.rel).name in HUB_BASENAMES else h.score,
                  title=h.title, snippet=h.snippet, match=h.match, cosine=h.cosine)
        for h in hits
    ]
    boosted.sort(key=lambda h: h.score, reverse=True)
    return boosted


def hybrid_search(vault: Path, query: str, k: int) -> list[SearchHit]:
    """BM25 + embedding search, fused with RRF, then a small structural boost
    for MOC.md/STATUS.md hits on navigational-looking queries. Raises
    OllamaError if Ollama is unreachable - callers fall back to bm25_rank alone."""
    pool = max(k * 4, 20)  # wider candidate pool per ranker before fusion
    semantic_hits = semantic_search(vault, query, pool)
    text_hits = bm25_rank(vault, query, pool)
    fused = rrf_fuse([("semantic", semantic_hits), ("text", text_hits)], pool)
    return _apply_nav_boost(fused, query)[:k]


def fulltext_fallback(vault: Path, query: str, k: int) -> list[str]:
    """rg full-text fallback, used only if BM25 itself can't run (e.g. the
    vault can't be walked at all)."""
    try:
        proc = subprocess.run(
            ["rg", "-i", "-l", "--glob", "!90-secrets/**", "--glob", "*.md",
             query, str(vault)],
            capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return []
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    return lines[:k]


def load_contradicted_rels(vault: Path) -> set[str]:
    """Notes carrying an open (or escalated) `brain contradict` finding.

    Best-effort: a missing/corrupt/absent-tool findings file just means "no
    known contradictions" - search must never fail because this file doesn't
    exist yet on a vault where the contradict tool hasn't run.
    """
    path = vault / config.CONTRADICTIONS_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    findings = raw.get("findings", {}) if isinstance(raw, dict) else {}
    rels: set[str] = set()
    for f in findings.values():
        if not isinstance(f, dict) or f.get("status") not in ("open", "escalated"):
            continue
        for side in ("note_a", "note_b"):
            rel = (f.get(side) or {}).get("rel")
            if rel:
                rels.add(rel)
    return rels


def _flag_contradictions(hits: list[SearchHit], vault: Path) -> list[SearchHit]:
    flagged = load_contradicted_rels(vault)
    if not flagged:
        return hits
    for h in hits:
        if h.rel in flagged:
            h.contradiction = True
    return hits


def claims_db_path(vault: Path) -> Path:
    """The dream's claim store for THIS vault. Derived from the vault the same
    way `config.bind_vault` derives the rest of the machine-local state, so a
    search against a test or throwaway vault never reads the real one's claims
    (see the bind_vault comment in gardener/config.py for what that mix-up
    cost once)."""
    return config.tool_dir_for(vault) / "state" / "dream" / "claims.db"


def load_retired_notes(vault: Path) -> dict[str, tuple[int, int, str]]:
    """Per vault note: (retired claims, claims in total, newest valid_to).

    Only claims whose `source` names a vault note (`vault:<rel>#<segment>`)
    can say anything about a note; a retired claim drawn from a transcript,
    a worker result or project documentation has no note to mark and is
    ignored here. A note the dream never drew a claim from - the normal case
    by a wide margin - simply does not appear in the map and stays untouched.

    Best-effort, like `load_contradicted_rels`: a missing, unreadable or
    pre-migration claims.db means "nothing is known to be retired". Search
    must not fail because a vault has never run the dream.
    """
    from gardener.dream.claims import ClaimStore

    path = claims_db_path(vault)
    if not path.exists():
        return {}
    try:
        store = ClaimStore(path, read_only=True)
    except Exception:
        return {}
    try:
        rows = store.list_claims()
    except Exception:
        return {}
    finally:
        store.close()

    out: dict[str, tuple[int, int, str]] = {}
    for row in rows:
        source = row.get("source") or ""
        if not source.startswith(CLAIM_SOURCE_PREFIX):
            continue
        rel = source[len(CLAIM_SOURCE_PREFIX):].rsplit("#", 1)[0]
        if not rel:
            continue
        retired, total, since = out.get(rel, (0, 0, ""))
        valid_to = row.get("valid_to")
        if valid_to:
            retired += 1
            since = max(since, str(valid_to))
        out[rel] = (retired, total + 1, since)
    return out


def validity_enabled(explicit: bool | None = None) -> bool:
    """Whether retired claims get marked and demoted. `explicit` (the CLI
    flag) wins; otherwise BRAIN_VALIDITY=0/off/false switches it off. The
    switch touches only this pass - the ranking, the embeddings and the BM25
    corpus are the same either way, so turning it off needs no reindexing and
    turning it back on needs no rebuild."""
    if explicit is not None:
        return explicit
    raw = os.environ.get(VALIDITY_ENV)
    if raw is None:
        return True
    return raw.strip().lower() not in ("0", "off", "false", "no", "nein")


def _flag_retired(hits: list[SearchHit], vault: Path,
                  enabled: bool = True) -> list[SearchHit]:
    """Mark hits whose claims the dream has retired and demote them by
    VALIDITY_DEMOTION times the retired share, then re-sort.

    Runs on the final list, so it can only change the ORDER of hits search had
    already chosen - no hit is ever dropped, filtered or hidden here, and a
    note with no retired claim keeps its score to the last digit."""
    if not enabled:
        return hits
    known = load_retired_notes(vault)
    if not known:
        return hits
    changed = False
    for h in hits:
        retired, total, since = known.get(h.rel, (0, 0, ""))
        if not retired or not total:
            continue
        h.retired = True
        h.retired_claims = retired
        h.total_claims = total
        h.retired_since = since
        h.score *= 1.0 - VALIDITY_DEMOTION * (retired / total)
        changed = True
    if changed:
        hits.sort(key=lambda h: h.score, reverse=True)
    return hits


def search(vault: Path, query: str, k: int = 5,
           validity: bool | None = None) -> tuple[list[SearchHit], bool]:
    """Returns (hits, used_fallback). used_fallback means Ollama was down and
    results are BM25-only (no semantic signal). `validity` overrides the
    BRAIN_VALIDITY switch for the retired-claim marking."""
    enabled = validity_enabled(validity)
    try:
        hits = hybrid_search(vault, query, k)
        return _flag_retired(_flag_contradictions(hits, vault), vault, enabled), False
    except OllamaError:
        pass
    hits = bm25_rank(vault, query, k)
    if not hits:
        paths = fulltext_fallback(vault, query, k)
        hits = [SearchHit(rel=str(Path(p).relative_to(vault)), score=0.0, match="text")
                for p in paths]
    return _flag_retired(_flag_contradictions(hits, vault), vault, enabled), True
