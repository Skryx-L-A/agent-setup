"""review-queue.md (vault root): the single place unclear cases end up.

Moved to the vault root on 2026-07-29. 00-sources/ is the immutable layer and a
queue is the opposite of that; _meta/ is the tooling layer and the VaultWriter
refuses to write there on purpose, so the gardener can never rewrite its own
tools. The queue had also ended up split - the contradiction scanner wrote to
_meta/ while the gardener wrote to 00-sources/ - so "the single place" was two
places and checking one missed the other.

Entries are deduplicated against what is already in the file AND against what
this run already queued, so repeated runs do not pile up the same line.
"""
from __future__ import annotations

import datetime as dt
import logging

from .vault import VaultWriter

log = logging.getLogger("gardener")

HEADER = "# Review-Queue (Gardener)\n\nUnklare Faelle fuer den Nutzer.\n"


class ReviewQueue:
    def __init__(self, writer: VaultWriter):
        self.writer = writer
        self.path = writer.vault / "review-queue.md"
        self.existing = (self.path.read_text(encoding="utf-8")
                         if self.path.exists() else "")
        self.added: list[str] = []

    def add(self, body: str, key: str | None = None,
            today: dt.date | None = None) -> bool:
        """Append `- <date>: <body>` unless an entry with the same key exists."""
        k = key or body
        if k in self.existing or any(k in a for a in self.added):
            return False
        stamp = (today or dt.date.today()).isoformat()
        line = f"- {stamp}: {body}"
        if not self.existing.strip():
            self.writer.append(self.path, HEADER)
            self.existing = HEADER
        self.writer.append(self.path, f"\n{line}\n")
        self.existing += f"\n{line}\n"
        self.added.append(line)
        return True
