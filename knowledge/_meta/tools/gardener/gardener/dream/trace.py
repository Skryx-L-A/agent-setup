"""Append-only provenance log (JSONL). Never rewritten, never deleted - the
raw trail the ledger's mutable working layer can later be checked against
(SSGM's fixed-point-drift countermeasure, see DREAM-PLAN.md Abschnitt 2/9).

M1 records only unit identity (which source, which segment, which byte
range, when first seen) - no statements yet. The statement layer with quote
verification against this file arrives in M2.

One line per NEWLY seen unit. The caller (cli.py) is responsible for only
calling append() after the ledger has confirmed the unit is new - trace.py
itself has no dedup logic, on purpose: an append-only file must never decide
to skip a write based on its own prior content, or "append-only" stops being
true.
"""
from __future__ import annotations

import json
from pathlib import Path


def append(trace_path: Path, *, source_path: str, content_hash: str,
          segment_index: int, char_start: int, char_end: int,
          seen_at: str) -> None:
    trace_path = Path(trace_path)
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({
        "source_path": source_path,
        "content_hash": content_hash,
        "segment_index": segment_index,
        "char_start": char_start,
        "char_end": char_end,
        "seen_at": seen_at,
    }, ensure_ascii=False, sort_keys=True)
    with trace_path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def read_all(trace_path: Path) -> list[dict]:
    trace_path = Path(trace_path)
    if not trace_path.exists():
        return []
    out: list[dict] = []
    for line in trace_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out
