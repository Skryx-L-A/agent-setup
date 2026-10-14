"""The one gate every writer asks before it changes an EXISTING note.

Auftrag "p0-schutztore" (pipeline-analyse Abschnitt 0 Punkt 6): `dream apply`
had no session-note guard and no foreign-author guard at all - only
`00-sources/` plus six named files were forbidden (`dream/config.py`), and
ownership was decided from `class:`/the dream's own marker block, never from
who actually wrote the note. Gardener-side, only two of several writers
(`consolidate.py`, `maintain.py`) excluded session notes by hand; `linking.py`
writing `## Relations` into a session note was the gap that made the risk
concrete.

Three rules, each a hard refusal on an EXISTING note (a create is never
touched by this module - see `VaultWriter.write`'s call site, which only asks
when the write's `expect` matched something already on disk):

(a) Session-/source notes are an immutable archive (`INDEX.md`): `type:
    session` in the frontmatter, a path containing a `sessions` component, or
    anything under `config.STAGING_DIR` (`00-sources/`). Silent refusal - this
    is a code fact, not a judgment call, so it never goes to a human queue.
(b) A note whose git history (every commit, not just the last one - unlike
    `dream/shadow.py`'s `_file_meta`, which is informational only) names an
    author other than the one this run writes as (`config.GIT_AUTHOR`) is
    never changed either - but THIS refusal is a judgment call (two people
    share the vault, see `10-global/shared-brain.md`), so it is escalated to
    the review queue instead of silently dropped.
(c) `secrets/` is never read or written. Already enforced structurally by
    `vault.check_writable`/`is_excluded` (`config.EXCLUDE_DIRS`); repeated
    here as `is_secret` so a caller that only has a path, not a VaultWriter,
    can ask the same question before it so much as opens the file.

Nobody's name is hardcoded (`tests/test_person_by_git_author_extern.py`
documents the 2026-08-17 incident that made real names in this source tree a
solved, closed question): "foreign" is defined relative to `config.GIT_AUTHOR`,
never by naming the other person.
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import config, frontmatter

_AUTHOR_NAME_RE = re.compile(r"^\s*([^<]+?)\s*<")

GIT_LOG_TIMEOUT = 30.0


def own_author_name() -> str:
    """The name half of `config.GIT_AUTHOR`, casefolded for comparison."""
    m = _AUTHOR_NAME_RE.match(config.GIT_AUTHOR)
    name = m.group(1) if m else config.GIT_AUTHOR
    return name.strip().casefold()


def note_type(text: str) -> str:
    """Same default as `vault.parse_note`: a note without a `type:` field is
    `"note"`, never treated as session."""
    fm, _body = frontmatter.parse(text)
    return str(fm.get("type") or "note").strip() or "note"


def is_session_or_source(rel: str, text: str) -> bool:
    parts = Path(rel).parts
    if parts and parts[0] == config.STAGING_DIR:
        return True
    if "sessions" in parts:
        return True
    return note_type(text) == "session"


def is_secret(rel: str) -> bool:
    """Mirrors `vault.is_excluded`'s directory check for `secrets/`, so a
    caller with only a path can ask before it opens the file at all."""
    parts = Path(rel).parts
    return any(p.casefold() in {d.casefold() for d in config.EXCLUDE_DIRS}
              for p in parts[:-1])


def _git_authors(vault: Path, rel: str) -> tuple[str, ...]:
    """Every author who ever committed this file, oldest call site first.

    `--follow` so a renamed note keeps its history; a repo-less vault (a test
    fixture, or a fresh clone before the first commit) simply yields no
    authors - "no history" is not evidence of "own", but it is also not a
    reason to fail the run, so it degrades to "nobody foreign found" rather
    than raising.
    """
    try:
        r = subprocess.run(
            ["git", "-C", str(vault), "log", "--follow", "--format=%an",
             "--", rel],
            capture_output=True, text=True, timeout=GIT_LOG_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return ()
    if r.returncode != 0:
        return ()
    seen: dict[str, None] = {}
    for line in r.stdout.splitlines():
        name = line.strip()
        if name:
            seen[name] = None
    return tuple(seen)


class AuthorCache:
    """Caches `git log` per file for the lifetime of one run.

    A run touches thousands of notes; a `git log` subprocess per write would
    turn every phase into one subprocess spawn per file (Auftrag
    "p0-schutztore" Punkt 1: "Ergebnis gecacht je Lauf, git log nicht pro
    Aufruf"). One instance is meant to live exactly as long as the
    `VaultWriter`/apply run that owns it, not longer - a note's authors can
    change between runs.
    """

    def __init__(self, vault: Path):
        self.vault = Path(vault)
        self._authors: dict[str, tuple[str, ...]] = {}

    def authors_of(self, rel: str) -> tuple[str, ...]:
        if rel not in self._authors:
            self._authors[rel] = _git_authors(self.vault, rel)
        return self._authors[rel]

    def has_foreign_author(self, rel: str) -> bool:
        own = own_author_name()
        return any(a.casefold() != own for a in self.authors_of(rel))


@dataclass(frozen=True)
class Verdict:
    blocked: bool
    reason: str | None = None    # "protected-session" | "protected-foreign-author"
    escalate: bool = False       # True: a human decision, not a silent drop


ALLOW = Verdict(blocked=False)


def check(vault: Path, rel: str, current_text: str, cache: AuthorCache) -> Verdict:
    """Ask before `rel` (vault-relative, existing content `current_text`) is
    changed. Only meant to be called when the note already exists - a create
    is not a change and is never this module's business."""
    if is_session_or_source(rel, current_text):
        return Verdict(True, "protected-session")
    if cache.has_foreign_author(rel):
        return Verdict(True, "protected-foreign-author", escalate=True)
    return ALLOW
