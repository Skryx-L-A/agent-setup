"""Content-level credential gate. Two independent tores, applied to every
source class including transcripts (a transcript is exactly where a pasted
key is most likely to appear) - DREAM-PLAN.md Abschnitt 0 (D3) and 8.

This module never accepts an exception list. The 2026-07-29 rule this repo
already lives by: a cleanliness check that carves itself an exception is a
broken check, not a check with a special case - person- or project-specific
patterns belong in an EXTERNAL, not-shipped config file whose path is a
constant below and which is allowed to simply not exist. On a hit, callers
must log only the source path, never the matched text - this module itself
never returns or logs the matched substring, only True/False.
"""
from __future__ import annotations

import fnmatch
import json
import logging
import math
import re
from collections import Counter
from pathlib import Path

from . import config as dcfg

log = logging.getLogger("gardener.dream")

_RUN_RE = re.compile(r"[A-Za-z0-9+/_\-=.]{%d,}" % dcfg.SECRET_MIN_RUN_LEN)
# Narrower charset for the bare-entropy path only (no '/'): measured
# 2026-08-06 against the real vault, dropping '/' cut notes tripping the
# entropy gate from 234/241 to 169/241 - '/' is what turns a path or URL
# into a long, slash-separated run that reads as high-entropy over the
# broader alphabet above. A known-prefix hit still uses the broader charset,
# since a real prefixed token's own value may legitimately contain '/'.
_ENTROPY_RUN_RE = re.compile(r"[A-Za-z0-9+_\-=.]{%d,}" % dcfg.SECRET_ENTROPY_MIN_LEN)
# '/' is real base64's own alphabet, though, so excluding it also stops a
# base64-with-padding secret from ever reaching SECRET_ENTROPY_MIN_LEN once
# it happens to contain a '/'. A run that ends in real base64 padding ('='
# or '==', not followed by more base64 chars) is a distinct, strong shape a
# path/URL essentially never produces - '/'-containing paths are matched
# here too, but only when terminated by that padding.
_BASE64_PADDED_RUN_RE = re.compile(
    r"[A-Za-z0-9+/]{%d,}={1,2}(?![A-Za-z0-9+/=])" % max(dcfg.SECRET_ENTROPY_MIN_LEN - 2, 1))
# Gate 3: a pure-hex or pure-base32 run (git SHAs, content hashes, ULIDs,
# the sha256 marker in roles/orchestrator.md) can never be told apart from a
# real hex/base32 secret by entropy alone - a random hex string tops out at
# 4.0 bits/char, below any threshold that also keeps prose false alarms
# near zero (2026-08-06 measurement, see gardener.dream.config). Such a run
# only counts with a credential word close in front of it.
_NARROW_RUN_RE = re.compile(r"[0-9A-Za-z]{%d,}" % dcfg.SECRET_NARROW_RUN_MIN_LEN)
_HEX_CHARS = frozenset("0123456789abcdefABCDEF")
_BASE32_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz234567")
# Letter-adjacency, not \b: \b treats '_' as a word char, so plain \b would
# miss the single most common real-world spelling of this context, API_KEY /
# api_key (no boundary between "api" and "_key" under \b). Digits and
# underscores count as separators here; only a letter on both sides means
# the run continues past the credential word.
_CREDENTIAL_WORD_RE = re.compile(
    r"(?<![A-Za-z])(?:%s)(?![A-Za-z])"
    % "|".join(re.escape(w) for w in dcfg.SECRET_CREDENTIAL_WORDS),
    re.IGNORECASE)


def path_blocked(name_or_path: str) -> bool:
    """Gate 1: filename pattern. Applied to the source's own name, never to
    directory components (a note *about* secrets living in a normal
    directory is not itself a secret)."""
    name = Path(name_or_path).name
    return any(fnmatch.fnmatch(name, pat) for pat in dcfg.SECRET_PATH_GLOBS)


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _load_extra_patterns() -> list[str]:
    path = dcfg.SECRET_EXTRA_PATTERNS_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []          # absent or unreadable - "none configured", not an error
    patterns = data.get("patterns") if isinstance(data, dict) else None
    if not isinstance(patterns, list):
        return []
    return [p for p in patterns if isinstance(p, str)]


def _is_narrow_alphabet(run: str) -> bool:
    chars = set(run)
    return chars <= _HEX_CHARS or chars <= _BASE32_CHARS


def _narrow_alphabet_context_hit(text: str) -> bool:
    for m in _NARROW_RUN_RE.finditer(text):
        if not _is_narrow_alphabet(m.group(0)):
            continue
        window = text[max(0, m.start() - dcfg.SECRET_CONTEXT_WINDOW):m.start()]
        if _CREDENTIAL_WORD_RE.search(window):
            return True
    return False


def content_hit(text: str) -> bool:
    """Gate 2: prefixes + entropy + narrow-alphabet-with-context +
    (optional) external patterns. Returns only whether the content is
    credential-shaped; never what matched - see module docstring."""
    for run in _RUN_RE.findall(text):
        if run.startswith(dcfg.SECRET_KNOWN_PREFIXES):
            return True
    for run in _ENTROPY_RUN_RE.findall(text):
        if _shannon_entropy(run) >= dcfg.SECRET_ENTROPY_THRESHOLD:
            return True
    for run in _BASE64_PADDED_RUN_RE.findall(text):
        if _shannon_entropy(run.rstrip("=")) >= dcfg.SECRET_ENTROPY_THRESHOLD_BASE64:
            return True
    if _narrow_alphabet_context_hit(text):
        return True
    for pattern in _load_extra_patterns():
        try:
            if re.search(pattern, text):
                return True
        except re.error:
            log.warning("dream: invalid pattern in %s ignored",
                       dcfg.SECRET_EXTRA_PATTERNS_FILE)
    return False
