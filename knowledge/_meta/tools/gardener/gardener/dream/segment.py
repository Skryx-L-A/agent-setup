"""Break sources into segments, and the two deterministic pre-filter gates
that run on them before anything is booked as `pending` in the ledger.

Segmentation: a sliding character window (SEG_CHARS, SEG_OVERLAP), keyed by
position so the same input text always yields the same segments in the same
order - the stability test_dream_segment_boundaries relies on.

Noise gate: a segment whose lines are overwhelmingly code-fence, diff, JSON
or bare path/grep output, or that simply has too little prose, is dropped.

Near-duplicate gate: exact content-hash match, or a shingle-Jaccard match
above a threshold. The Jaccard check is bucketed by a single min-hash of each
segment's shingle set instead of compared against every previously-seen
segment, which would be O(n^2) and the plan requires harvest to finish in
minutes over the full corpus (tens of thousands of segments). Bucketing only
risks a *missed* near-duplicate (an extra segment passed through), never a
wrongly-dropped unique one - the safe direction for a filter that must never
silently lose content.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass

from . import config as dcfg

log = logging.getLogger("gardener.dream")

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
_SHINGLE_WORD_RE = re.compile(r"\w+", re.UNICODE)
_DIFF_LINE_RE = re.compile(
    r"^(diff --git |index [0-9a-fA-F]{4,}\.\.|@@ -\d|\+\+\+ |--- )")
_JSON_LINE_RE = re.compile(r'^([{}\[\]]|"[^"]+"\s*:\s*.+[,{}\[\]]?)$')
_PATH_LINE_RE = re.compile(
    r"^((/[\w.\-]+){2,}/?|[A-Za-z]:\\\S+|\S+\.\w+:\d+:.*)$")


# ---------------------------------------------------------------------------
# Segmentation
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Segment:
    index: int
    text: str
    char_start: int
    char_end: int
    content_hash: str


def segment_text(text: str, seg_chars: int = dcfg.SEG_CHARS,
                 overlap: int = dcfg.SEG_OVERLAP) -> list[Segment]:
    if not text:
        return []
    step = max(seg_chars - overlap, 1)
    n = len(text)
    segments: list[Segment] = []
    start = 0
    index = 0
    while start < n:
        end = min(start + seg_chars, n)
        chunk = text[start:end]
        segments.append(Segment(
            index=index, text=chunk, char_start=start, char_end=end,
            content_hash=hashlib.sha256(chunk.encode("utf-8")).hexdigest()))
        index += 1
        if end >= n:
            break
        start += step
    return segments


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content
                         if isinstance(c, dict) and c.get("type") == "text")
    return ""


def flatten_transcript(
        path, max_turn_bytes: int = dcfg.SEGMENT_MAX_UNIT_BYTES,
) -> tuple[str, list[str]]:
    """Flatten a JSONL transcript to plain `role: text` turns, in order, with
    no truncation (mine.py's tail-truncation is right for a quick summary but
    would silently drop material a lossless harvest must keep). A single turn
    over `max_turn_bytes` is skipped and its location returned, never chunked
    mid-turn."""
    chunks: list[str] = []
    skipped: list[str] = []
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        log.warning("dream: transcript unreadable %s: %s", path, e)
        return "", skipped
    for i, line in enumerate(raw.splitlines()):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        text = _text_of(msg.get("content")).strip()
        if not text:
            continue
        if len(text.encode("utf-8")) > max_turn_bytes:
            skipped.append(f"{path}:{i}")
            continue
        chunks.append(f"{role}: {text}")
    return "\n\n".join(chunks), skipped


# ---------------------------------------------------------------------------
# Noise gate
# ---------------------------------------------------------------------------

def _tooly_line_ratio(text: str) -> float:
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return 0.0
    tooly = 0
    in_fence = False
    for line in lines:
        s = line.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            tooly += 1
            continue
        if in_fence:
            tooly += 1
            continue
        if (_DIFF_LINE_RE.match(s) or _JSON_LINE_RE.match(s)
                or _PATH_LINE_RE.match(s)):
            tooly += 1
    return tooly / len(lines)


def _letter_ratio(text: str) -> float:
    stripped = re.sub(r"\s+", "", text)
    if not stripped:
        return 0.0
    letters = sum(1 for c in stripped if c.isalpha())
    return letters / len(stripped)


def _word_count(text: str) -> int:
    return len(_WORD_RE.findall(text))


def classify_noise(text: str) -> str | None:
    """Return a drop reason, or None if the segment passes the noise gate."""
    ratio = _tooly_line_ratio(text)
    if ratio >= dcfg.NOISE_TOOLY_LINE_RATIO:
        return f"noise-tool-output:{ratio:.2f}"
    if _word_count(text) < dcfg.NOISE_MIN_WORDS:
        return "noise-too-few-words"
    if _letter_ratio(text) < dcfg.NOISE_MIN_LETTER_RATIO:
        return "noise-too-few-letters"
    return None


# ---------------------------------------------------------------------------
# Near-duplicate gate
# ---------------------------------------------------------------------------

def shingles(text: str, k: int = dcfg.SHINGLE_SIZE) -> frozenset[str]:
    words = _SHINGLE_WORD_RE.findall(text.lower())
    if len(words) < k:
        return frozenset({" ".join(words)}) if words else frozenset()
    return frozenset(" ".join(words[i:i + k]) for i in range(len(words) - k + 1))


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


NEAR_DUP_BANDS = 4   # LSH bands: landing in the SAME bucket in ANY one band
                     # is enough to trigger the (exact) Jaccard check below.
                     # A single min-hash band missed a one-word edit in
                     # practice (the changed word can be the band's minimum
                     # shingle); several independent bands fix that without
                     # going back to an O(n^2) all-pairs comparison.


def _band_min_hashes(sh: frozenset[str], bands: int = NEAR_DUP_BANDS) -> tuple[int, ...]:
    if not sh:
        return (0,) * bands
    return tuple(min(hash((band, s)) for s in sh) for band in range(bands))


class NearDupIndex:
    """Tracks segments already accepted in this harvest run so a near-
    identical one (boilerplate repeated across many transcripts) is skipped
    instead of booked twice. Scoped to a single harvest process - it is not
    persisted, so a segment can only be caught as a near-duplicate of one
    seen earlier in the *same* run.

    Bucketed LSH instead of all-pairs comparison, which would be O(n^2) and
    the plan requires harvest to finish in minutes over tens of thousands of
    segments. This can only miss a near-duplicate (an extra segment passed
    through), never wrongly drop a unique one - the safe failure direction
    for a filter that must never silently lose content.
    """

    def __init__(self, threshold: float = dcfg.NEAR_DUP_JACCARD_THRESHOLD,
                bands: int = NEAR_DUP_BANDS):
        self.threshold = threshold
        self.bands = bands
        self._hashes: set[str] = set()
        self._buckets: dict[tuple[int, int], list[frozenset[str]]] = {}

    def is_duplicate(self, content_hash: str, text: str) -> bool:
        if content_hash in self._hashes:
            return True
        sh = shingles(text)
        checked: list[frozenset[str]] = []
        for band, bh in enumerate(_band_min_hashes(sh, self.bands)):
            for seen in self._buckets.get((band, bh), ()):
                if seen in checked:
                    continue
                checked.append(seen)
                if jaccard(sh, seen) >= self.threshold:
                    return True
        return False

    def add(self, content_hash: str, text: str) -> None:
        self._hashes.add(content_hash)
        sh = shingles(text)
        for band, bh in enumerate(_band_min_hashes(sh, self.bands)):
            self._buckets.setdefault((band, bh), []).append(sh)
