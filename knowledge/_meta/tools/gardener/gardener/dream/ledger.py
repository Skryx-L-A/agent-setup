"""SQLite progress ledger: one row per unit (a source, or a segment of a
source). This is the "Fortschrittsbuch" of DREAM-PLAN.md Abschnitt 6 - it is
what makes harvest resumable without loss and without ever reprocessing an
unchanged unit.

Primary key is (quell_id, segment_index, content_hash), exactly as specified
in the task: an unchanged source's segments are already in the book under
that key and are never re-inserted; a changed source gets a new content_hash
and is therefore automatically open again, while its old row stays as
history.

Status lifecycle: `pending` -> `extracted` | `quarantined`. `skipped` units
are written straight to that terminal state at harvest time (deterministic
pre-filter reasons - noise, near-duplicate, secret gate) and never retried.
Only `pending` units that a later processing step (M2 extraction) attempted
and failed go through `mark_failed`; after three failures they move to
`quarantined` instead of staying `pending` forever.

Mirrors gardener.store.Store's read-only contract: in read_only mode (used
by --dry-run and by `status`) every mutation is a no-op and a missing db file
opens as an empty in-memory db instead of being created on disk, so a
dry-run - or a `status` call before the first harvest - cannot create
state/dream/ as a side effect.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS units (
    quell_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    source_class TEXT NOT NULL,
    path TEXT NOT NULL,
    wave TEXT NOT NULL,
    size INTEGER NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    first_seen REAL NOT NULL,
    updated REAL NOT NULL,
    PRIMARY KEY (quell_id, segment_index, content_hash)
);
"""

MAX_FAILURES = 3


class Ledger:
    def __init__(self, db_path: Path, read_only: bool = False):
        db_path = Path(db_path)
        self.read_only = read_only
        if read_only:
            if db_path.exists():
                self.conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            else:
                self.conn = sqlite3.connect(":memory:")
                self.conn.executescript(SCHEMA)
            return
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    def _fetchone(self, sql: str, params: tuple):
        try:
            return self.conn.execute(sql, params).fetchone()
        except sqlite3.OperationalError:
            return None

    def known(self, quell_id: str, segment_index: int, content_hash: str) -> bool:
        return self._fetchone(
            "SELECT 1 FROM units WHERE quell_id=? AND segment_index=? "
            "AND content_hash=?",
            (quell_id, segment_index, content_hash)) is not None

    def _insert(self, *, source_class: str, quell_id: str, path: str,
               segment_index: int, content_hash: str, size: int,
               char_start: int, char_end: int, wave: str, status: str,
               reason: str | None, now: float) -> bool:
        if self.read_only:
            return not self.known(quell_id, segment_index, content_hash)
        try:
            self.conn.execute(
                "INSERT INTO units (quell_id, segment_index, content_hash, "
                "source_class, path, wave, size, char_start, char_end, "
                "status, reason, fail_count, first_seen, updated) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
                (quell_id, segment_index, content_hash, source_class, path,
                 wave, size, char_start, char_end, status, reason, now, now))
            self.conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def add_pending(self, *, source_class: str, quell_id: str, path: str,
                    segment_index: int, content_hash: str, size: int,
                    char_start: int, char_end: int, wave: str,
                    now: float | None = None) -> bool:
        """Book a unit that passed the pre-filter and awaits extraction.
        Returns True iff this was a new row (an unseen or changed unit)."""
        return self._insert(
            source_class=source_class, quell_id=quell_id, path=path,
            segment_index=segment_index, content_hash=content_hash, size=size,
            char_start=char_start, char_end=char_end, wave=wave,
            status="pending", reason=None, now=now if now is not None else time.time())

    def add_skipped(self, *, source_class: str, quell_id: str, path: str,
                    segment_index: int, content_hash: str, size: int,
                    char_start: int, char_end: int, wave: str, reason: str,
                    now: float | None = None) -> bool:
        """Book a unit the deterministic pre-filter rejected. Returns True
        iff this was a new row."""
        return self._insert(
            source_class=source_class, quell_id=quell_id, path=path,
            segment_index=segment_index, content_hash=content_hash, size=size,
            char_start=char_start, char_end=char_end, wave=wave,
            status="skipped", reason=reason, now=now if now is not None else time.time())

    def mark_extracted(self, quell_id: str, segment_index: int,
                       content_hash: str, now: float | None = None) -> bool:
        if self.read_only:
            return False
        now = now if now is not None else time.time()
        cur = self.conn.execute(
            "UPDATE units SET status='extracted', updated=? "
            "WHERE quell_id=? AND segment_index=? AND content_hash=? "
            "AND status='pending'",
            (now, quell_id, segment_index, content_hash))
        self.conn.commit()
        return cur.rowcount > 0

    def mark_failed(self, quell_id: str, segment_index: int, content_hash: str,
                    error: str, now: float | None = None) -> str | None:
        """Record a failed processing attempt on a `pending` unit. Returns
        the resulting status ("pending" if it may be retried, "quarantined"
        after the third failure), or None if the key is not a pending unit."""
        if self.read_only:
            return None
        now = now if now is not None else time.time()
        row = self._fetchone(
            "SELECT fail_count FROM units WHERE quell_id=? AND segment_index=? "
            "AND content_hash=? AND status='pending'",
            (quell_id, segment_index, content_hash))
        if row is None:
            return None
        fail_count = row[0] + 1
        status = "quarantined" if fail_count >= MAX_FAILURES else "pending"
        self.conn.execute(
            "UPDATE units SET fail_count=?, status=?, reason=?, updated=? "
            "WHERE quell_id=? AND segment_index=? AND content_hash=?",
            (fail_count, status, error, now, quell_id, segment_index, content_hash))
        self.conn.commit()
        return status

    def mark_empty(self, quell_id: str, segment_index: int, content_hash: str,
                   now: float | None = None) -> bool:
        """Eine Einheit, die bearbeitet wurde und KEINE einzige Aussage
        hergab, bekommt `leer` statt `extracted`.

        Warum das einen eigenen Zustand braucht (gemessen 2026-08-12): 147 von
        325 bearbeiteten Einheiten hatten null Aussagen, 45 Prozent,
        gleichmaessig ueber alle Quellklassen. Im Buch standen sie neben den
        ergiebigen als `extracted`, waren also von nichts zu unterscheiden -
        eine Ausbeute von null sah aus wie Erfolg. Stichproben zeigten
        Segmente voller zitierbarer Tatsachen.

        `leer` ist ein Endzustand wie `extracted`: `select_pending_units` holt
        nur `pending`, ein spaeterer Lauf fasst diese Einheiten also nicht von
        selbst wieder an. Er macht den Fall nur SICHTBAR - in `dream status`
        und fuer jede Entscheidung, sie nach einer Verbesserung noch einmal zu
        fahren."""
        if self.read_only:
            return False
        now = now if now is not None else time.time()
        cur = self.conn.execute(
            "UPDATE units SET status='leer', updated=? "
            "WHERE quell_id=? AND segment_index=? AND content_hash=? "
            "AND status='pending'",
            (now, quell_id, segment_index, content_hash))
        self.conn.commit()
        return cur.rowcount > 0

    def mark_stale(self, quell_id: str, segment_index: int, content_hash: str,
                   reason: str, now: float | None = None) -> bool:
        """Take a `pending` unit out of the queue whose source no longer
        matches the hash it was harvested under. This is not a failure: the
        processing never ran, the ground moved underneath it. Without this
        the unit stays `pending` forever - every later run resolves it again,
        logs the same warning again and drops it again (measured 2026-08-12:
        330 such units, 165 of them with a source file that no longer
        exists).

        The row stays for the record. Its primary key carries the old
        content_hash, so a fresh harvest of the changed file writes a NEW row
        under the new hash - marking the old one stale loses nothing that
        still exists."""
        if self.read_only:
            return False
        now = now if now is not None else time.time()
        cur = self.conn.execute(
            "UPDATE units SET status='stale', reason=?, updated=? "
            "WHERE quell_id=? AND segment_index=? AND content_hash=? "
            "AND status='pending'",
            (reason, now, quell_id, segment_index, content_hash))
        self.conn.commit()
        return cur.rowcount > 0

    def counts(self) -> list[tuple[str, str, str, int]]:
        rows = self.conn.execute(
            "SELECT source_class, wave, status, COUNT(*) FROM units "
            "GROUP BY source_class, wave, status "
            "ORDER BY source_class, wave, status").fetchall()
        return [tuple(r) for r in rows]

    def list_units(self, status: str | None = None) -> list[dict]:
        if status is None:
            rows = self.conn.execute(
                "SELECT quell_id, segment_index, content_hash, source_class, "
                "path, wave, size, status, reason, fail_count, first_seen, "
                "updated FROM units").fetchall()
        else:
            rows = self.conn.execute(
                "SELECT quell_id, segment_index, content_hash, source_class, "
                "path, wave, size, status, reason, fail_count, first_seen, "
                "updated FROM units WHERE status=?", (status,)).fetchall()
        keys = ("quell_id", "segment_index", "content_hash", "source_class",
               "path", "wave", "size", "status", "reason", "fail_count",
               "first_seen", "updated")
        return [dict(zip(keys, r)) for r in rows]
