"""Thin wrapper around the existing gardener CLI: run in foreground, report status."""
from __future__ import annotations

import datetime as dt
import os
from pathlib import Path

from gardener import config
from gardener.cli import main as gardener_main
from gardener.runtime import read_last_run

VALID_PHASES = config.PHASES   # linking|consolidate|maintain|ingest|mine|lint|all


def run(vault: Path, phase: str = "all", dry_run: bool = False,
        audit: bool = False, verbose: bool = False,
        topic: str | None = None, min_notes: int | None = None) -> int:
    """Wraps gardener.cli.main(); passes its exit code straight through.

    Phases are handed to the gardener core, which runs exactly the requested one
    (ingest -> linking -> consolidation -> maintenance -> mining -> lint on 'all').
    """
    if phase not in VALID_PHASES:
        raise ValueError(f"unknown phase {phase!r}, expected one of {VALID_PHASES}")
    argv = ["--vault", str(vault), "--phase", phase]
    if dry_run:
        argv.append("--dry-run")
    if audit:
        argv.append("--audit")
    if verbose:
        argv.append("--verbose")
    # Nur fuer die synth-Phase belegt; der Gardener ignoriert sie sonst.
    if topic:
        argv += ["--topic", topic]
    if min_notes is not None:
        argv += ["--min-notes", str(min_notes)]
    return gardener_main(argv)


def _lock_status() -> dict:
    lock_path = config.STATE_DIR / "gardener.lock"
    if not lock_path.exists():
        return {"running": False, "lock_path": str(lock_path)}
    try:
        pid_str, *_ = lock_path.read_text().split()
        pid = int(pid_str)
        os.kill(pid, 0)
        alive = True
    except ProcessLookupError:
        alive = False
    except (OSError, ValueError, IndexError):
        alive = None  # unreadable lock; can't tell
    age = dt.datetime.now().timestamp() - lock_path.stat().st_mtime
    return {"running": bool(alive), "lock_path": str(lock_path), "lock_age_seconds": age}


def _latest_report(vault: Path) -> dict | None:
    reports = sorted((vault / "00-sources").glob("gardener-report-*.md"),
                      key=lambda p: p.stat().st_mtime, reverse=True)
    if not reports:
        return None
    p = reports[0]
    return {"path": str(p.relative_to(vault)),
            "modified": dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat()}


def _latest_log() -> dict | None:
    if not config.LOG_DIR.exists():
        return None
    logs = sorted(config.LOG_DIR.glob("*.log"), key=lambda p: p.stat().st_mtime,
                  reverse=True)
    if not logs:
        return None
    p = logs[0]
    return {"path": str(p), "modified": dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat()}


def status(vault: Path) -> dict:
    return {
        "lock": _lock_status(),
        # outcome of the last REAL run (phase, counts, conflicts): what the
        # Brain.app status line shows. None when the gardener never ran here.
        "last_run": read_last_run(config.STATE_DIR),
        "latest_report": _latest_report(vault),
        "latest_log": _latest_log(),
    }
