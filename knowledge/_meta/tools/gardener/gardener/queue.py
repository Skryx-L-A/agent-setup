"""review-queue.md (vault root): the single place unclear cases end up.

Moved to the vault root on 2026-07-29. 00-sources/ is the immutable layer and a
queue is the opposite of that; _meta/ is the tooling layer and the VaultWriter
refuses to write there on purpose, so the gardener can never rewrite its own
tools. The queue had also ended up split - the contradiction scanner wrote to
_meta/ while the gardener wrote to 00-sources/ - so "the single place" was two
places and checking one missed the other.

Entries are deduplicated against what is already in the file AND against what
this run already queued, so repeated runs do not pile up the same line.

A buffered queue (``gepuffert=True``, the gardener run) collects its lines and
writes the file once in ``flush()``: the queue is the largest root file, and a
dry run listed it once per queued line (g3, 2026-09-24: twelve times).
"""
from __future__ import annotations

import datetime as dt
import logging

from .vault import VaultWriter

log = logging.getLogger("gardener")

HEADER = "# Review-Queue (Gardener)\n\nUnklare Faelle fuer den Nutzer.\n"


class ReviewQueue:
    def __init__(self, writer: VaultWriter, gepuffert: bool = False):
        self.writer = writer
        self.path = writer.vault / "review-queue.md"
        self.existing = (self.path.read_text(encoding="utf-8")
                         if self.path.exists() else "")
        self.added: list[str] = []
        self.gepuffert = gepuffert
        self.pending = ""

    def add(self, body: str, key: str | None = None,
            today: dt.date | None = None) -> bool:
        """Append `- <date>: <body>` unless an entry with the same key exists."""
        k = key or body
        if k in self.existing or any(k in a for a in self.added):
            return False
        stamp = (today or dt.date.today()).isoformat()
        line = f"- {stamp}: {body}"
        text = f"\n{line}\n"
        if not self.existing.strip():
            text = HEADER + text
        self.existing += text
        self.added.append(line)
        if self.gepuffert:
            self.pending += text
        else:
            self.writer.append(self.path, text)
        return True

    def flush(self) -> None:
        """Write the buffered lines in one go (no-op when nothing is pending)."""
        if self.pending:
            self.writer.append(self.path, self.pending)
            self.pending = ""
