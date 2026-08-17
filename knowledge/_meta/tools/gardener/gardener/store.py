"""SQLite state: embedding cache (content-hash keyed) and persistent blocklist."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS embeddings (
    rel TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    vector TEXT NOT NULL,
    updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS blocklist (
    pair TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    reason TEXT,
    ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS mined (
    key TEXT PRIMARY KEY,
    ts REAL NOT NULL
);
"""


def pair_key(rel_a: str, rel_b: str) -> str:
    return "||".join(sorted((rel_a, rel_b)))


class Store:
    """SQLite state. In read_only mode (dry-run) every mutation is a no-op, so a
    dry-run cannot poison the blocklist or the embedding cache of the next real run.
    """

    def __init__(self, db_path: Path, read_only: bool = False):
        db_path = Path(db_path)
        self.read_only = read_only
        if read_only:
            # a dry-run must not even create the state db or its schema
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
            # read-only db from an older schema: a missing table means "no data"
            return None

    # -- embeddings ---------------------------------------------------------
    def get_embedding(self, rel: str, content_hash: str) -> list[float] | None:
        row = self._fetchone(
            "SELECT vector FROM embeddings WHERE rel=? AND hash=?",
            (rel, content_hash))
        return json.loads(row[0]) if row else None

    def put_embedding(self, rel: str, content_hash: str, vector: list[float]) -> None:
        if self.read_only:
            return
        self.conn.execute(
            "INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?)",
            (rel, content_hash, json.dumps(vector), time.time()))
        self.conn.commit()

    def prune_embeddings(self, live_rels: set[str]) -> None:
        if self.read_only:
            return
        rows = self.conn.execute("SELECT rel FROM embeddings").fetchall()
        for (rel,) in rows:
            if rel not in live_rels:
                self.conn.execute("DELETE FROM embeddings WHERE rel=?", (rel,))
        self.conn.commit()

    # -- blocklist ----------------------------------------------------------
    def is_blocked(self, rel_a: str, rel_b: str, kind: str) -> bool:
        return self._fetchone(
            "SELECT 1 FROM blocklist WHERE pair=? AND kind=?",
            (pair_key(rel_a, rel_b), kind)) is not None

    def block(self, rel_a: str, rel_b: str, kind: str, reason: str = "") -> None:
        if self.read_only:
            return
        self.conn.execute(
            "INSERT OR REPLACE INTO blocklist VALUES (?,?,?,?)",
            (pair_key(rel_a, rel_b), kind, reason, time.time()))
        self.conn.commit()

    # -- transcript mining --------------------------------------------------
    def is_mined(self, key: str) -> bool:
        return self._fetchone("SELECT 1 FROM mined WHERE key=?", (key,)) is not None

    def mark_mined(self, key: str) -> None:
        if self.read_only:
            return
        self.conn.execute("INSERT OR REPLACE INTO mined VALUES (?,?)",
                          (key, time.time()))
        self.conn.commit()
