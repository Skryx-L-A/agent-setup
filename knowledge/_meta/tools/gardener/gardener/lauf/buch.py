"""The book of `brain run`: one SQLite file, every unit's state, resumable.

It lives in the existing ``dream.db`` (``<state>/dream/dream.db``) beside the
legacy ``units`` table, which this module never changes.  On first use every
legacy row is copied once into ``lauf_einheiten`` (same primary key, status
mapped, the old status kept in ``alt_status``) and the copy is checked by
count; a mismatch aborts instead of running on a half-migrated book.

Unit states::

    pending -> erkannt (event windows) -> extrahiert (packages)
            -> abgeglichen -> vorgeschlagen -> uebernommen
    side exits: leer, quarantaene (with grund), wartet-grossmodell,
                skipped (harvest gates), stale (source changed/vanished),
                erledigt-v1 (extracted by the old dream, claims in claims.db)

Idempotency: an extraction is keyed by ``sha256(content_hash, model,
prompt version, detector version)``; a window already extracted under that
key is never sent again, and packages have deterministic ids, so a resumed or
repeated run inserts nothing twice.  Every unit's transition is one
transaction, so SIGTERM/SIGINT between two units loses nothing and within a
unit loses at most the unfinished window.

``in_memory=True`` (``--dry-run``) works on an in-memory copy of the file: a
dry run can walk every stage and count, but nothing reaches the disk.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

PENDING = "pending"
ERKANNT = "erkannt"
EXTRAHIERT = "extrahiert"
ABGEGLICHEN = "abgeglichen"
VORGESCHLAGEN = "vorgeschlagen"
UEBERNOMMEN = "uebernommen"
ABGELEHNT = "abgelehnt"
ERLEDIGT = "erledigt"
LEER = "leer"
QUARANTAENE = "quarantaene"
WARTET = "wartet-grossmodell"
SKIPPED = "skipped"
STALE = "stale"
ERLEDIGT_V1 = "erledigt-v1"
# package state (p3): the check ``pruefen`` (closed project, foreign text,
# local decider) rejected it; reason and score stay in ``lauf_pakete.pruefung``
VERWORFEN_AUTO = "verworfen-auto"
PRUEF_TYPEN = ("entscheidung", "fehler", "lehre")

STATES = (PENDING, ERKANNT, EXTRAHIERT, ABGEGLICHEN, VORGESCHLAGEN, UEBERNOMMEN,
          ABGELEHNT, ERLEDIGT,
          LEER, QUARANTAENE, WARTET, SKIPPED, STALE, ERLEDIGT_V1)

MAX_FAILURES = 3

# Backlog order (B6): memory first, then transcripts, worker results, docs;
# inside a class the priority projects first (the user's test case: a machine-bound project
# with ProjectX, one vault project).
REIHENFOLGE_KLASSEN = ("memory", "transcript", "worker-result", "project-doc")
VORRANG_PROJEKTE = ("a machine-bound project",)

# legacy dream status -> lauf status
LEGACY_MAP = {"pending": PENDING, "extracted": ERLEDIGT_V1, "leer": LEER,
              "quarantined": QUARANTAENE, "skipped": SKIPPED, "stale": STALE}

SCHEMA = """
CREATE TABLE IF NOT EXISTS lauf_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS lauf_einheiten (
    quell_id TEXT NOT NULL, segment_index INTEGER NOT NULL, content_hash TEXT NOT NULL,
    source_class TEXT NOT NULL, path TEXT NOT NULL, wave TEXT NOT NULL,
    size INTEGER NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
    projekt TEXT, datum TEXT, maschine TEXT,
    status TEXT NOT NULL, grund TEXT, fail_count INTEGER NOT NULL DEFAULT 0,
    fenster TEXT, herkunft TEXT NOT NULL, alt_status TEXT, lauf_id TEXT,
    first_seen REAL NOT NULL, updated REAL NOT NULL,
    PRIMARY KEY (quell_id, segment_index, content_hash));
CREATE INDEX IF NOT EXISTS lauf_einheiten_status ON lauf_einheiten(status);
CREATE TABLE IF NOT EXISTS lauf_quellen (
    quell_id TEXT PRIMARY KEY, signatur TEXT NOT NULL, projekt TEXT, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS lauf_extraktionen (
    quell_id TEXT NOT NULL, segment_index INTEGER NOT NULL, content_hash TEXT NOT NULL,
    schluessel TEXT NOT NULL, fenster_nr INTEGER NOT NULL, modell TEXT NOT NULL,
    sekunden REAL, fehler TEXT, pakete INTEGER NOT NULL DEFAULT 0,
    verworfen INTEGER NOT NULL DEFAULT 0, lauf_id TEXT, created REAL NOT NULL,
    PRIMARY KEY (quell_id, segment_index, content_hash, schluessel, fenster_nr));
CREATE TABLE IF NOT EXISTS lauf_pakete (
    paket_id TEXT PRIMARY KEY,
    quell_id TEXT NOT NULL, segment_index INTEGER NOT NULL, content_hash TEXT NOT NULL,
    schluessel TEXT NOT NULL, modell TEXT NOT NULL,
    typ TEXT NOT NULL, aussage TEXT NOT NULL, gegenmittel TEXT, ausloeser TEXT,
    belege TEXT NOT NULL, zitat TEXT, datum TEXT, projekt TEXT,
    status TEXT NOT NULL, abgleich TEXT, ziel TEXT,
    lauf_id TEXT, created REAL NOT NULL, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS lauf_pakete_einheit ON lauf_pakete(quell_id, segment_index, content_hash);
CREATE TABLE IF NOT EXISTS laeufe (
    lauf_id TEXT PRIMARY KEY, profil TEXT, stufen TEXT, gestartet TEXT, beendet TEXT,
    status TEXT, zusammenfassung TEXT);
"""


def sha(*parts: object) -> str:
    return hashlib.sha256("\x1f".join(str(p) for p in parts).encode("utf-8")).hexdigest()


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Key:
    quell_id: str
    segment_index: int
    content_hash: str

    def as_tuple(self) -> tuple[str, int, str]:
        return (self.quell_id, self.segment_index, self.content_hash)

    def __str__(self) -> str:
        return f"{self.quell_id}#{self.segment_index}"


class Buch:
    def __init__(self, db_path: Path, *, in_memory: bool = False):
        self.path = Path(db_path)
        self.in_memory = in_memory
        if in_memory:
            self.conn = sqlite3.connect(":memory:")
            if self.path.exists():
                source = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
                try:
                    source.backup(self.conn)
                finally:
                    source.close()
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.conn = sqlite3.connect(self.path, timeout=30)
            self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._spalten_ergaenzen()
        self.conn.commit()
        self.migration = self._migrate_legacy()

    def close(self) -> None:
        self.conn.close()

    def _spalten_ergaenzen(self) -> None:
        """Columns added after the first book existed (ALTER TABLE, idempotent).
        ``projekt_vorschlag`` (p2): the model's project choice for a unit the
        rules left without project, JSON; never copied into ``projekt``."""
        have = {row[1] for row in self.conn.execute("PRAGMA table_info(lauf_einheiten)")}
        if "projekt_vorschlag" not in have:
            self.conn.execute("ALTER TABLE lauf_einheiten ADD COLUMN projekt_vorschlag TEXT")
        # ``pruefung`` (p3): JSON of the stage ``pruefen`` (grund, score, modell, schwelle)
        have = {row[1] for row in self.conn.execute("PRAGMA table_info(lauf_pakete)")}
        if "pruefung" not in have:
            self.conn.execute("ALTER TABLE lauf_pakete ADD COLUMN pruefung TEXT")

    # ------------------------------------------------------------------ meta
    def meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM lauf_meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute("INSERT OR REPLACE INTO lauf_meta VALUES (?,?)", (key, value))

    # -------------------------------------------------------------- migration
    def _migrate_legacy(self) -> dict[str, Any]:
        """Copy every legacy dream ``units`` row (INSERT OR IGNORE, so rows the
        old ``brain dream`` adds later follow on the next open, and a row
        already copied keeps its lauf state); verify the copy by count."""
        has_units = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='units'").fetchone()
        if not has_units:
            return {"legacy": 0, "kopiert": 0, "neu": 0}
        legacy = self.conn.execute("SELECT COUNT(*) FROM units").fetchone()[0]
        before = self._legacy_present()
        if before < legacy:
            now = time.time()
            with self.conn:
                for row in self.conn.execute(
                        "SELECT quell_id, segment_index, content_hash, source_class, path, wave, size, "
                        "char_start, char_end, status, reason, fail_count, first_seen FROM units"
                ).fetchall():
                    status = LEGACY_MAP.get(row[9], row[9])
                    grund = row[10]
                    # A transcript unit of the old dream was cut from a differently
                    # flattened text; its offsets do not fit the detector's text.
                    # The source is harvested afresh, the old row stays as history.
                    if status == PENDING and row[3] == "transcript":
                        status, grund = STALE, "dream-v1-segmentierung (neu geerntet)"
                    self.conn.execute(
                        "INSERT OR IGNORE INTO lauf_einheiten (quell_id, segment_index, content_hash, "
                        "source_class, path, wave, size, char_start, char_end, projekt, datum, maschine, "
                        "status, grund, fail_count, fenster, herkunft, alt_status, lauf_id, first_seen, updated) "
                        "VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,'lokal',?,?,?,NULL,'dream-v1',?,NULL,?,?)",
                        (row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8],
                         status, grund, row[11], row[9], row[12], now))
        copied = self._legacy_present()
        if copied != legacy:
            raise MigrationError(f"Migration dream.db unvollstaendig: units={legacy}, "
                                 f"lauf_einheiten(dream-v1)={copied}")
        return {"legacy": legacy, "kopiert": copied, "neu": copied - before}

    def _legacy_present(self) -> int:
        """Legacy rows whose key exists in the lauf book (any origin)."""
        return self.conn.execute(
            "SELECT COUNT(*) FROM units u WHERE EXISTS (SELECT 1 FROM lauf_einheiten l "
            "WHERE l.quell_id=u.quell_id AND l.segment_index=u.segment_index "
            "AND l.content_hash=u.content_hash)").fetchone()[0]

    # ---------------------------------------------------------------- harvest
    def quelle_bekannt(self, quell_id: str, signatur: str) -> bool:
        """Source unchanged since its last complete harvest (size + mtime)."""
        row = self.conn.execute("SELECT signatur FROM lauf_quellen WHERE quell_id=?",
                                (quell_id,)).fetchone()
        return bool(row and row[0] == signatur)

    def quelle_merken(self, quell_id: str, signatur: str, projekt: str | None) -> None:
        self.conn.execute("INSERT OR REPLACE INTO lauf_quellen VALUES (?,?,?,?)",
                          (quell_id, signatur, projekt, time.time()))

    def known(self, key: Key) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM lauf_einheiten WHERE quell_id=? AND segment_index=? AND content_hash=?",
            key.as_tuple()).fetchone() is not None

    def add_unit(self, key: Key, *, source_class: str, path: str, wave: str, size: int,
                 char_start: int, char_end: int, projekt: str | None, datum: str | None,
                 maschine: str, status: str = PENDING, grund: str | None = None,
                 lauf_id: str | None = None) -> bool:
        now = time.time()
        try:
            self.conn.execute(
                "INSERT INTO lauf_einheiten (quell_id, segment_index, content_hash, source_class, path, "
                "wave, size, char_start, char_end, projekt, datum, maschine, status, grund, fail_count, "
                "fenster, herkunft, alt_status, lauf_id, first_seen, updated) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,'lauf',NULL,?,?,?)",
                (*key.as_tuple(), source_class, path, wave, size, char_start, char_end, projekt,
                 datum, maschine, status, grund, lauf_id, now, now))
            return True
        except sqlite3.IntegrityError:
            return False

    def commit(self) -> None:
        self.conn.commit()

    # ------------------------------------------------------------- selection
    def units(self, status: str | Iterable[str], *, classes: Iterable[str] | None = None,
              limit: int | None = None, projekt: str | None = None,
              reihenfolge: bool = False) -> list[sqlite3.Row]:
        """Units in ``status``; ``projekt`` narrows to one project.

        ``reihenfolge=True`` is the backlog order (``REIHENFOLGE_KLASSEN``):
        Claude memory (small, many lessons) -> transcripts newest first ->
        worker results -> project docs; inside each class the projects of
        ``VORRANG_PROJEKTE`` first.  Otherwise harvest order."""
        statuses = [status] if isinstance(status, str) else list(status)
        sql = (f"SELECT * FROM lauf_einheiten WHERE status IN ({','.join('?' * len(statuses))})")
        params: list[Any] = list(statuses)
        if classes is not None:
            classes = list(classes)
            sql += f" AND source_class IN ({','.join('?' * len(classes))})"
            params += classes
        if projekt is not None:
            sql += " AND projekt=?"
            params.append(projekt)
        if reihenfolge:
            klasse = " ".join(f"WHEN ? THEN {i}" for i in range(len(REIHENFOLGE_KLASSEN)))
            vorrang = ",".join("?" * len(VORRANG_PROJEKTE)) or "NULL"
            sql += (f" ORDER BY CASE source_class {klasse} ELSE {len(REIHENFOLGE_KLASSEN)} END, "
                    f"CASE WHEN projekt IN ({vorrang}) THEN 0 ELSE 1 END, "
                    "COALESCE(datum, '') DESC, first_seen, quell_id, segment_index")
            params += list(REIHENFOLGE_KLASSEN) + list(VORRANG_PROJEKTE)
        else:
            sql += " ORDER BY first_seen, quell_id, segment_index"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return self.conn.execute(sql, params).fetchall()

    def ohne_projekt(self, *, classes: Iterable[str] | None = None,
                     limit: int | None = None) -> list[sqlite3.Row]:
        """Units without project and without a project proposal that have
        packages (only those can yield a lesson for a project), backlog order."""
        sql = ("SELECT * FROM lauf_einheiten e WHERE projekt IS NULL AND projekt_vorschlag IS NULL "
               "AND status NOT IN (?, ?) AND EXISTS (SELECT 1 FROM lauf_pakete p WHERE "
               "p.quell_id=e.quell_id AND p.segment_index=e.segment_index "
               "AND p.content_hash=e.content_hash)")
        params: list[Any] = [SKIPPED, STALE]
        if classes is not None:
            classes = list(classes)
            sql += f" AND source_class IN ({','.join('?' * len(classes))})"
            params += classes
        klasse = " ".join(f"WHEN ? THEN {i}" for i in range(len(REIHENFOLGE_KLASSEN)))
        sql += (f" ORDER BY CASE source_class {klasse} ELSE {len(REIHENFOLGE_KLASSEN)} END, "
                "COALESCE(datum, '') DESC, first_seen, quell_id, segment_index")
        params += list(REIHENFOLGE_KLASSEN)
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return self.conn.execute(sql, params).fetchall()

    def projekt_zuordnen(self, key: Key, projekt: str) -> int:
        """A routing rule found the unit's project after its packages were
        booked: the unit and its packages get it, packages that ended
        ``ohne-ziel`` start over at ``neu`` and the unit goes back to
        ``extrahiert`` so ``abgleichen`` and ``schreiben`` take them.
        Returns the number of reopened packages."""
        now = time.time()
        self.conn.execute("UPDATE lauf_einheiten SET projekt=?, updated=? "
                          "WHERE quell_id=? AND segment_index=? AND content_hash=?",
                          (projekt, now, *key.as_tuple()))
        self.conn.execute("UPDATE lauf_pakete SET projekt=?, updated=? "
                          "WHERE quell_id=? AND segment_index=? AND content_hash=? AND projekt IS NULL",
                          (projekt, now, *key.as_tuple()))
        reopened = self.conn.execute(
            "UPDATE lauf_pakete SET status='neu', ziel=NULL, abgleich=NULL, updated=? "
            "WHERE quell_id=? AND segment_index=? AND content_hash=? AND status='ohne-ziel'",
            (now, *key.as_tuple())).rowcount
        if reopened:
            self.conn.execute("UPDATE lauf_einheiten SET status=?, updated=? WHERE quell_id=? "
                              "AND segment_index=? AND content_hash=? AND status IN (?, ?)",
                              (EXTRAHIERT, now, *key.as_tuple(), ABGEGLICHEN, VORGESCHLAGEN))
        return reopened

    def projekt_vorschlag_merken(self, key: Key, vorschlag: dict[str, Any]) -> None:
        self.conn.execute("UPDATE lauf_einheiten SET projekt_vorschlag=?, updated=? "
                          "WHERE quell_id=? AND segment_index=? AND content_hash=?",
                          (json.dumps(vorschlag, ensure_ascii=False), time.time(), *key.as_tuple()))

    def abgleich_zuruecksetzen(self, bis_lauf: str) -> dict[str, int]:
        """Reopen the pair comparison of every package extracted in a run up
        to ``bis_lauf`` (run ids sort by time): packages ``abgeglichen`` or
        ``vorgeschlagen`` go back to ``neu`` (verdicts cleared, nothing
        deleted), their units from ``abgeglichen``/``vorgeschlagen`` back to
        ``extrahiert``.  Code facts (``duplikat``) and human decisions
        (``uebernommen``, ``abgelehnt``, ``erledigt``) stay.  For the runs whose
        comparison ran without embeddings or pair model (p2, 2026-09-24)."""
        now = time.time()
        keys = self.conn.execute(
            "SELECT DISTINCT quell_id, segment_index, content_hash FROM lauf_pakete "
            "WHERE lauf_id <= ? AND status IN ('abgeglichen', 'vorgeschlagen')", (bis_lauf,)).fetchall()
        pakete = self.conn.execute(
            "UPDATE lauf_pakete SET status='neu', abgleich=NULL, ziel=NULL, updated=? "
            "WHERE lauf_id <= ? AND status IN ('abgeglichen', 'vorgeschlagen')",
            (now, bis_lauf)).rowcount
        einheiten = 0
        for key in keys:
            einheiten += self.conn.execute(
                "UPDATE lauf_einheiten SET status=?, updated=? WHERE quell_id=? AND segment_index=? "
                "AND content_hash=? AND status IN (?, ?)",
                (EXTRAHIERT, now, *key, ABGEGLICHEN, VORGESCHLAGEN)).rowcount
        return {"pakete": pakete, "einheiten": einheiten}

    def unit(self, key: Key) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM lauf_einheiten WHERE quell_id=? AND segment_index=? AND content_hash=?",
            key.as_tuple()).fetchone()

    # ------------------------------------------------------------ transitions
    def set_status(self, key: Key, status: str, *, grund: str | None = None,
                   fenster: list[dict] | None = None, lauf_id: str | None = None) -> None:
        assert status in STATES, status
        sets, params = ["status=?", "updated=?"], [status, time.time()]
        if grund is not None:
            sets.append("grund=?")
            params.append(grund)
        if fenster is not None:
            sets.append("fenster=?")
            params.append(json.dumps(fenster, ensure_ascii=False))
        if lauf_id is not None:
            sets.append("lauf_id=?")
            params.append(lauf_id)
        self.conn.execute(f"UPDATE lauf_einheiten SET {', '.join(sets)} "
                          "WHERE quell_id=? AND segment_index=? AND content_hash=?",
                          (*params, *key.as_tuple()))

    def fail(self, key: Key, error: str) -> str:
        """A failed attempt: retry later, quarantine after MAX_FAILURES."""
        row = self.unit(key)
        count = (row["fail_count"] if row else 0) + 1
        status = QUARANTAENE if count >= MAX_FAILURES else row["status"]
        self.conn.execute("UPDATE lauf_einheiten SET fail_count=?, status=?, grund=?, updated=? "
                          "WHERE quell_id=? AND segment_index=? AND content_hash=?",
                          (count, status, error[:500], time.time(), *key.as_tuple()))
        return status

    # ------------------------------------------------------------ extraction
    def extraktion_fertig(self, key: Key, schluessel: str, fenster_nr: int) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM lauf_extraktionen WHERE quell_id=? AND segment_index=? AND content_hash=? "
            "AND schluessel=? AND fenster_nr=? AND fehler IS NULL",
            (*key.as_tuple(), schluessel, fenster_nr)).fetchone() is not None

    def extraktion_merken(self, key: Key, schluessel: str, fenster_nr: int, *, modell: str,
                          sekunden: float, fehler: str | None, pakete: int, verworfen: int,
                          lauf_id: str | None) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO lauf_extraktionen VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (*key.as_tuple(), schluessel, fenster_nr, modell, sekunden, fehler, pakete, verworfen,
             lauf_id, time.time()))

    def paket_add(self, key: Key, schluessel: str, fenster_nr: int, index: int, *, modell: str,
                  paket: dict[str, Any], lauf_id: str | None) -> bool:
        paket_id = sha(*key.as_tuple(), schluessel, fenster_nr, index)[:16]
        now = time.time()
        try:
            self.conn.execute(
                "INSERT INTO lauf_pakete (paket_id, quell_id, segment_index, content_hash, schluessel, "
                "modell, typ, aussage, gegenmittel, ausloeser, belege, zitat, datum, projekt, status, "
                "abgleich, ziel, lauf_id, created, updated) VALUES "
                "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'neu',NULL,NULL,?,?,?)",
                (paket_id, *key.as_tuple(), schluessel, modell, paket["typ"], paket["aussage"],
                 paket.get("gegenmittel", ""), paket.get("ausloeser", ""),
                 json.dumps(paket["belege"]), paket.get("zitat", ""), paket.get("datum"),
                 paket.get("projekt"), lauf_id, now, now))
            return True
        except sqlite3.IntegrityError:
            return False

    def pakete(self, *, key: Key | None = None, status: str | Iterable[str] | None = None,
               projekt: str | None = None) -> list[sqlite3.Row]:
        sql, params = "SELECT * FROM lauf_pakete WHERE 1=1", []
        if key is not None:
            sql += " AND quell_id=? AND segment_index=? AND content_hash=?"
            params += list(key.as_tuple())
        if status is not None:
            statuses = [status] if isinstance(status, str) else list(status)
            sql += f" AND status IN ({','.join('?' * len(statuses))})"
            params += statuses
        if projekt is not None:
            sql += " AND projekt=?"
            params.append(projekt)
        sql += " ORDER BY created, paket_id"
        return self.conn.execute(sql, params).fetchall()

    def paket_update(self, paket_id: str, **fields: Any) -> None:
        if not fields:
            return
        fields["updated"] = time.time()
        for name in ("abgleich",):
            if name in fields and not isinstance(fields[name], str) and fields[name] is not None:
                fields[name] = json.dumps(fields[name], ensure_ascii=False)
        sets = ", ".join(f"{name}=?" for name in fields)
        self.conn.execute(f"UPDATE lauf_pakete SET {sets} WHERE paket_id=?",
                          (*fields.values(), paket_id))

    # ---------------------------------------------------------------- pruefen
    def zu_pruefen(self, *, classes: Iterable[str] | None = None, projekt: str | None = None,
                   limit: int | None = None) -> list[sqlite3.Row]:
        """Packages of the proposal types without a check: fresh ones
        (``abgeglichen``) first, then the backlog (``vorgeschlagen``); inside
        each grouped by source so a source is read once.  Each row carries the
        unit's ``source_class``, ``path``, ``char_start``, ``char_end`` and
        ``maschine`` (prefixed ``e_``)."""
        sql = ("SELECT p.*, e.source_class AS e_source_class, e.path AS e_path, "
               "e.char_start AS e_char_start, e.char_end AS e_char_end, e.maschine AS e_maschine, "
               "e.content_hash AS e_content_hash FROM lauf_pakete p JOIN lauf_einheiten e "
               "ON e.quell_id=p.quell_id AND e.segment_index=p.segment_index AND e.content_hash=p.content_hash "
               f"WHERE p.pruefung IS NULL AND p.status IN ('abgeglichen', 'vorgeschlagen') "
               f"AND p.typ IN ({','.join('?' * len(PRUEF_TYPEN))})")
        params: list[Any] = list(PRUEF_TYPEN)
        if classes is not None:
            classes = list(classes)
            sql += f" AND e.source_class IN ({','.join('?' * len(classes))})"
            params += classes
        if projekt is not None:
            sql += " AND p.projekt=?"
            params.append(projekt)
        sql += (" ORDER BY CASE p.status WHEN 'abgeglichen' THEN 0 ELSE 1 END, e.path, "
                "p.segment_index, p.paket_id")
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return self.conn.execute(sql, params).fetchall()

    def pruefung_merken(self, paket_id: str, pruefung: dict[str, Any], *, verwerfen: bool) -> None:
        sets = "pruefung=?, updated=?" + (", status=?" if verwerfen else "")
        params: list[Any] = [json.dumps(pruefung, ensure_ascii=False), time.time()]
        if verwerfen:
            params.append(VERWORFEN_AUTO)
        self.conn.execute(f"UPDATE lauf_pakete SET {sets} WHERE paket_id=?", (*params, paket_id))

    # ------------------------------------------------------------------- runs
    def lauf_start(self, lauf_id: str, profil: str, stufen: list[str], gestartet: str) -> None:
        self.conn.execute("INSERT OR REPLACE INTO laeufe VALUES (?,?,?,?,NULL,'laeuft',NULL)",
                          (lauf_id, profil, ",".join(stufen), gestartet))
        self.conn.commit()

    def lauf_ende(self, lauf_id: str, status: str, beendet: str, zusammenfassung: dict) -> None:
        self.conn.execute("UPDATE laeufe SET beendet=?, status=?, zusammenfassung=? WHERE lauf_id=?",
                          (beendet, status, json.dumps(zusammenfassung, ensure_ascii=False), lauf_id))
        self.conn.commit()

    def zaehlung(self) -> dict[str, int]:
        return {row[0]: row[1] for row in self.conn.execute(
            "SELECT status, COUNT(*) FROM lauf_einheiten GROUP BY status ORDER BY status")}

    def paket_zaehlung(self) -> dict[str, int]:
        return {row[0]: row[1] for row in self.conn.execute(
            "SELECT status, COUNT(*) FROM lauf_pakete GROUP BY status ORDER BY status")}
