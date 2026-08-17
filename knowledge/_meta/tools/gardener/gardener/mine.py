"""Transcript mining: durable knowledge that never made it into a note.

Reads the local Claude Code transcripts (~/.claude/projects/**/*.jsonl) of the
last 7 days, hands each one to the LOCAL judge model, and writes candidates to
00-sources/ as UNVERIFIED notes. Nothing is uploaded anywhere, and nothing is ever
written into an existing topic note - a human promotes candidates by hand.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import config
from .ollama import OllamaError, OllamaUnavailable
from .store import Store
from .vault import Note, VaultWriter, build_resolver

log = logging.getLogger("gardener")

MINE_SYSTEM = (
    "You read a raw developer/assistant session transcript and extract DURABLE "
    "knowledge that would otherwise be lost: decisions with their reason, root "
    "causes of bugs, setup/config facts, rules the user stated, gotchas. "
    "DURABLE means: still true and useful in three months, independent of this "
    "session. NOT durable, never extract: status/progress reports, what was done, "
    "test counts, open next steps, file paths of result files, chit-chat, code "
    "diffs, tool noise, anything already listed as a known note title. "
    "At most 3 items, the most valuable ones - fewer is better, empty is fine. "
    "Answer ONLY with JSON: "
    '{"items": [{"title": "<short note title>", "body": "<3-8 dense sentences, '
    'German, facts only>"}]}.'
)


@dataclass
class MineResult:
    candidates: list[str] = field(default_factory=list)   # written rel paths
    transcripts: int = 0
    skipped: list[str] = field(default_factory=list)


def recent_transcripts(root: Path | None = None, days: int = config.TRANSCRIPT_DAYS,
                       limit: int = config.TRANSCRIPT_MAX_FILES,
                       now: float | None = None) -> list[Path]:
    root = root or config.TRANSCRIPT_DIR
    if not root.is_dir():
        return []
    cutoff = (now or time.time()) - days * 86400

    def mtime(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:     # a live session file can vanish under us
            return 0.0

    files = [p for p in root.rglob("*.jsonl") if p.is_file() and mtime(p) >= cutoff]
    files.sort(key=lambda p: -mtime(p))
    return files[:limit]


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content
                         if isinstance(c, dict) and c.get("type") == "text")
    return ""


def transcript_text(path: Path, max_chars: int = config.TRANSCRIPT_MAX_CHARS) -> str:
    """Flatten a JSONL transcript to plain user/assistant text (tail-biased)."""
    chunks: list[str] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        log.warning("transcript unreadable %s: %s", path, e)
        return ""
    for line in lines:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        text = _text_of(msg.get("content")).strip()
        if text:
            chunks.append(f"{role}: {text}")
    joined = "\n\n".join(chunks)
    return joined[-max_chars:] if len(joined) > max_chars else joined


def _slug(title: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    return (s or "kandidat")[:60]


def candidate_note(title: str, body: str, source: str,
                   today: dt.date) -> str:
    return (
        "---\n"
        f"title: {title}\n"
        "type: note\n"
        "branch: 00-sources\n"
        # Die Schicht steht beim Anlegen fest, so wie die ULID: dies ist
        # Rohmaterial in 00-sources/, das ueber die Suche gefunden wird und keinen
        # eingehenden Link braucht. Ohne `class` zaehlten geschuerfte Notizen als
        # Wissens-Waisen und tauchten in der Review-Queue auf (2026-07-29, neun
        # Stueck) - ein Befund, der nie zu beheben war.
        "class: source\n"
        "quelle: transcript-mining\n"
        "status: UNVERIFIED\n"
        f"created: {today.isoformat()}\n"
        "---\n\n"
        "Für künftige Sessions: UNVERIFIED. Vom Gardener aus einem lokalen "
        "Session-Transcript extrahiert, von niemandem geprüft. Erst nach "
        "Prüfung in eine Themen-Note übernehmen, dann diese Kandidaten-Note "
        "löschen.\n\n"
        f"{body.strip()}\n\n"
        f"Quelle: transcript-mining aus `{source}`\n\n"
        f"Stand: {today.strftime('%Y-%m')}\n")


def run_mining(vault: Path, notes: list[Note], writer: VaultWriter, client,
               store: Store, deadline=None, root: Path | None = None,
               today: dt.date | None = None) -> MineResult:
    today = today or dt.date.today()
    result = MineResult()
    if client is None:
        return result
    resolver = build_resolver(notes)
    known_titles = sorted({n.title for n in notes})[:200]
    seen_slugs: set[str] = set()   # two transcripts must not fight over one filename

    for path in recent_transcripts(root):
        if deadline is not None and deadline.expired():
            result.skipped.append("deadline reached")
            break
        result.transcripts += 1
        text = transcript_text(path)
        if len(text) < 500:
            continue
        try:
            verdict = client.judge(
                MINE_SYSTEM,
                "Known note titles (do not repeat these):\n"
                + ", ".join(known_titles)
                + f"\n\nTranscript ({path.name}):\n---\n{text}\n---")
        except OllamaUnavailable:
            raise                       # Ollama is gone: abort, do not "mine" nothing
        except OllamaError as e:
            log.warning("mining judge failed for %s: %s", path.name, e)
            result.skipped.append(path.name)
            continue
        items = verdict.get("items")
        if not isinstance(items, list):
            continue
        taken = 0
        for item in items:
            if taken >= config.MINE_MAX_PER_TRANSCRIPT:
                break
            if len(result.candidates) >= config.MINE_MAX_PER_RUN:
                result.skipped.append("run cap reached")
                return result
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            body = str(item.get("body") or "").strip()
            if not title or len(body) < 40:
                continue
            if title.lower() in resolver:
                continue
            slug = _slug(title)
            key = f"{path.name}:{slug}"
            if store.is_mined(key) or slug in seen_slugs:
                continue
            rel = f"{config.MINED_DIR}/mined-{today.isoformat()}-{slug}.md"
            out_path = vault / rel
            if out_path.exists():
                store.mark_mined(key)
                continue
            writer.write(out_path, candidate_note(title, body, path.name, today))
            store.mark_mined(key)
            seen_slugs.add(slug)
            result.candidates.append(rel)
            taken += 1
    return result
