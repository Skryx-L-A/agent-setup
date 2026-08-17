"""Read-heat: which notes actually get read.

The B4 read-tracking hook appends `<ISO8601>\t<note path>` lines to
`_meta/tools/state/read-heat.log`. The file may not exist (hook not installed yet) -
every function here degrades to "no data" instead of failing.
"""
from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

from . import config
from .vault import Note

log = logging.getLogger("gardener")


def mtime_of(note: Note) -> float:
    """mtime of a note's file, 0.0 when it vanished mid-run (a 45-minute run
    races with the human deleting notes; a crash here would kill the whole run)."""
    try:
        return note.path.stat().st_mtime
    except OSError:
        return 0.0


def _parse_ts(raw: str) -> dt.datetime | None:
    """Parse an ISO8601 stamp to NAIVE local time (the hook writes UTC with 'Z';
    mixing aware and naive datetimes would blow up every comparison below)."""
    try:
        ts = dt.datetime.fromisoformat(raw.strip())
    except ValueError:
        return None
    return ts.astimezone().replace(tzinfo=None) if ts.tzinfo else ts


def load_heat(vault: Path, log_path: Path | None = None) -> dict[str, list[dt.datetime]]:
    """{vault-relative note path: [read timestamps]}. {} when there is no log."""
    path = log_path or (vault / config.HEAT_LOG)
    if not path.exists():
        return {}
    heat: dict[str, list[dt.datetime]] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        log.warning("read-heat log unreadable: %s", e)
        return {}
    for line in lines:
        if "\t" not in line:
            continue
        raw_ts, raw_path = line.split("\t", 1)
        ts = _parse_ts(raw_ts)
        if ts is None:
            continue
        p = raw_path.strip()
        if not p:
            continue
        candidate = Path(p)
        if candidate.is_absolute():
            try:
                rel = candidate.resolve().relative_to(vault.resolve()).as_posix()
            except ValueError:
                continue          # read outside the vault: not our business
        else:
            # already vault-relative; resolving would anchor it at the CWD
            rel = candidate.as_posix().lstrip("./")
        heat.setdefault(rel, []).append(ts)
    return heat


def counts(heat: dict[str, list[dt.datetime]], days: int = config.HOT_HEAT_DAYS,
           now: dt.datetime | None = None) -> dict[str, int]:
    now = now or dt.datetime.now()
    cutoff = now - dt.timedelta(days=days)
    return {rel: sum(1 for ts in stamps if ts >= cutoff)
            for rel, stamps in heat.items()
            if any(ts >= cutoff for ts in stamps)}


def last_read(heat: dict[str, list[dt.datetime]], rel: str) -> dt.datetime | None:
    stamps = heat.get(rel)
    return max(stamps) if stamps else None


def hottest(notes: list[Note], heat: dict[str, list[dt.datetime]], k: int = 5,
            days: int = config.HOT_HEAT_DAYS,
            now: dt.datetime | None = None) -> list[tuple[Note, int]]:
    c = counts(heat, days, now)
    scored = [(n, c[n.rel]) for n in notes if c.get(n.rel)]
    scored.sort(key=lambda t: (-t[1], t[0].rel))
    return scored[:k]


def cold_notes(notes: list[Note], heat: dict[str, list[dt.datetime]],
               months: int = config.COLD_MONTHS,
               now: dt.datetime | None = None) -> list[Note]:
    """Notes not read for `months`. Empty without heat data - otherwise every
    note would look cold on day one. A note that was never read but recently
    written is not cold either: its mtime stands in for the missing read."""
    if not heat:
        return []
    now = now or dt.datetime.now()
    cutoff = now - dt.timedelta(days=months * 30)
    out = []
    for n in notes:
        if n.ntype in ("report", "asset"):
            continue
        seen = last_read(heat, n.rel)
        if seen is None:
            mtime = mtime_of(n)
            if not mtime:
                continue
            seen = dt.datetime.fromtimestamp(mtime)
        if seen < cutoff:
            out.append(n)
    return out


def resurface(notes: list[Note], heat: dict[str, list[dt.datetime]],
              k: int = config.RESURFACE_COUNT,
              months: int = config.COLD_MONTHS,
              now: dt.datetime | None = None) -> list[Note]:
    """1-2 valuable but long-unread notes ("Vergessene Schaetze"). Value proxy:
    substance (length) plus how well connected the note is."""
    candidates = cold_notes(notes, heat, months, now)
    if not candidates:
        # no heat data yet: fall back to the longest, best-linked notes that are
        # not sessions/reports, so the section is never empty on a fresh install
        candidates = [n for n in notes if n.ntype not in ("session", "report", "asset")]
    scored = sorted(candidates,
                    key=lambda n: (-(len(n.text) + 200 * len(n.links)), n.rel))
    return scored[:k]
