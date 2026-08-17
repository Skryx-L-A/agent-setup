"""Immutable note identity (Brain 4.0): every note carries a ULID that a move
does not change.

The Brain 4 migration stamped `id:` and `schema: 4` into every note that existed
on 2026-07-28 -- and nothing stamped the ones written afterwards. Measured on
2026-07-29: 22 real notes had no `id`, among them all ten topic pages the
synthesis phase had just generated. The promise "identity no longer hangs on the
path" was true only for the notes that happened to predate the migration, and the
gap grew with every note written.

Stamping lives at the single write gate (`VaultWriter.write`) rather than in each
writer, because every writer that forgets it reopens the same hole. An existing
`id` is read back from disk and kept: a rewrite must never mint a new identity.
"""
from __future__ import annotations

import re
import secrets
import time

SCHEMA_VERSION = 4

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")

_ID_RE = re.compile(r"^id:\s*(\S+)\s*$", re.M)
_SCHEMA_RE = re.compile(r"^schema:\s*\S+\s*$", re.M)


def ulid(now_ms: int | None = None) -> str:
    """Crockford-base32 ULID: 48 bit ms timestamp + 80 bit randomness.

    Same construction as the migration tool's, kept here because that tool is a
    finished one-off and importing a retired migration from live code would tie
    the vault's daily operation to a script nobody runs any more.
    """
    ts = int(time.time() * 1000) if now_ms is None else now_ms
    value = (ts << 80) | secrets.randbits(80)
    return "".join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))


def split_frontmatter(text: str) -> tuple[str, str] | None:
    """`(frontmatter_without_fences, rest_including_closing_fence)` or None."""
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    return text[4:end + 1], text[end + 1:]


def id_of(text: str) -> str | None:
    """The ULID in a note's frontmatter, if it has a valid one."""
    parts = split_frontmatter(text)
    if not parts:
        return None
    m = _ID_RE.search(parts[0])
    return m.group(1) if m and ULID_RE.match(m.group(1)) else None


def stamp(text: str, keep_id: str | None = None) -> str:
    """Ensure the note carries `id:` and `schema:`; leave everything else alone.

    Text without frontmatter is returned unchanged -- generated aggregates
    (HOT.md, reports) are not notes and get no identity. A note that already has
    a valid ULID keeps it, whatever `keep_id` says, so a stale caller cannot
    overwrite an identity.
    """
    parts = split_frontmatter(text)
    if not parts:
        return text
    fm, rest = parts
    own = id_of(text)
    if own and _SCHEMA_RE.search(fm):
        return text
    lines = fm.splitlines()
    if not own:
        new_id = keep_id if (keep_id and ULID_RE.match(keep_id)) else ulid()
        lines = _upsert(lines, "id", new_id, prepend=True)
    if not _SCHEMA_RE.search(fm):
        lines = _upsert(lines, "schema", str(SCHEMA_VERSION), after="id")
    return "---\n" + "\n".join(lines) + "\n" + rest


def _upsert(lines: list[str], key: str, value: str, *,
            prepend: bool = False, after: str | None = None) -> list[str]:
    entry = f"{key}: {value}"
    for i, line in enumerate(lines):
        if line.startswith(f"{key}:"):
            lines[i] = entry
            return lines
    if after:
        for i, line in enumerate(lines):
            if line.startswith(f"{after}:"):
                return lines[:i + 1] + [entry] + lines[i + 1:]
    return ([entry] + lines) if prepend else (lines + [entry])
