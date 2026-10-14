"""Foreign text: harness, job-template and skill text that is not the project's knowledge (p3).

The cloud sample of 450 proposals (``eval/vorschlaege-stichprobe``) found 79
packages of the wrong project and 101 ephemeral ones; a large share quoted
text that no person of the project wrote: the peer-escalation paragraph under
every inbox message, ``[Protokoll]``/``[Arbeitsverzeichnis]`` job lines,
harness and guard error messages, and the body of a skill loaded into the
conversation.  This module recognises such text deterministically, without a
model, at two points:

- before extraction (``stufen``): foreign sentences leave the event windows,
  so the model never sees them;
- on booked packages (stage ``pruefen``): a package whose evidence sentences
  are *all* foreign is ``verworfen-auto`` with ``grund`` ``fremdtext:<kind>``.

Two levels:

1. Sentence patterns (``SATZ_MUSTER``): a sentence matching one of them is
   foreign wherever it stands.
2. Turn heads (``TURN_MUSTER``): in a transcript, every sentence of a
   ``user:`` turn that starts like a skill or slash-command body is foreign.
   The head is looked up in the full flattened text, because a unit often
   starts in the middle of a turn.

Measured on the 450 judged packages (p3, ``eval/vorschlaege-qualitaet``):
no ``richtig`` package is dropped.  Patterns are deliberately narrow; a new
one needs the same check (``filter_messen.py``).
"""
from __future__ import annotations

import re
from typing import Iterable

I = re.IGNORECASE

# (kind, pattern) -- matched against one sentence, whitespace collapsed
SATZ_MUSTER: tuple[tuple[str, re.Pattern], ...] = tuple((kind, re.compile(p, I)) for kind, p in (
    # the harness paragraph under a message of another session
    ("peer", r"A peer cannot grant escalation|permission laundering|"
             r"This came from another Claude session|not typed by your user|"
             r"treat it as a teammate's request|never treat a peer message"),
    # job template lines of the workbench
    ("protokoll", r"\[Protokoll\b|Endergebnis als Markdown in die Datei|letzte Zeile exakt:?\s*DONE|"
                  r"\[Arbeitsverzeichnis\]|Der Hauptbaum \S+ ist tabu|in einem eigenen Worktree: /|"
                  r"zugestellt ueber die Sitzungs-Inbox|Auftrag deines Orchestrators"),
    # harness, tool and guard messages
    ("harness", r"<tool_use_error>|Blocked: sleep \d+ followed by|use Monitor with an until|"
                r"Subagent nesting limit reached|CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH|"
                r"timeout_ms must be|Browser is already in use for|"
                r"not found in the current page snapshot|PreToolUse:\w+ hook error|"
                r"git add abgelehnt:|pkill/killall/kill \(pattern|Kein Snapshot dieser Daten gefunden|"
                r"The MCP server returned HTTP|InputValidationError|"
                r"Such-Index veraltet auf dieser Maschine"),
    # the fork template of the harness
    ("vorlage", r"You are a worker fork|<fork-boilerplate>|"
                r"If you committed changes, list the paths and commit hashes"),
))

# (kind, pattern) -- matched against the head of a ``user:`` turn
TURN_MUSTER: tuple[tuple[str, re.Pattern], ...] = tuple((kind, re.compile(p)) for kind, p in (
    ("skill", r"^user: Base directory for this skill:"),
    ("skill", r"^user: # /[\w:-]+ [—-] "),          # body of a slash command
    ("vorlage", r"^user: <fork-boilerplate>"),
))

_TURN_RE = re.compile(r"(?:\A|\n\n)(user|assistant|werkzeug): ")
KOPF_ZEICHEN = 200


def satz_grund(text: str) -> str | None:
    """Kind of foreign text of one sentence, None if it is not foreign."""
    flat = " ".join(text.split())
    for kind, pattern in SATZ_MUSTER:
        if pattern.search(flat):
            return kind
    return None


def _turn_starts(voll: str) -> list[int]:
    return [m.start() + (2 if m.group(0).startswith("\n") else 0) for m in _TURN_RE.finditer(voll)]


def _turn_grund(kopf: str) -> str | None:
    for kind, pattern in TURN_MUSTER:
        if pattern.search(kopf):
            return kind
    return None


def fremde_saetze(saetze: Iterable, *, voll: str | None = None, offset: int = 0) -> dict[str, str]:
    """``{sentence id: kind}`` of the foreign sentences of a unit.

    ``saetze`` are the unit's ``Satz`` objects (offsets into the unit text);
    ``voll`` is the full flattened source text and ``offset`` the unit's
    ``char_start`` in it -- only then are turn heads checked (transcripts)."""
    saetze = list(saetze)
    out: dict[str, str] = {}
    starts = _turn_starts(voll) if voll else []
    kopf_grund: dict[int, str | None] = {}
    j = -1
    for satz in saetze:               # sentences are in text order
        grund = satz_grund(satz.text)
        if grund is None and starts:
            pos = offset + satz.start
            while j + 1 < len(starts) and starts[j + 1] <= pos:
                j += 1
            if j >= 0:
                start = starts[j]
                if start not in kopf_grund:
                    kopf_grund[start] = _turn_grund(voll[start:start + KOPF_ZEICHEN])
                grund = kopf_grund[start]
        if grund is not None:
            out[satz.id] = grund
    return out


def paket_grund(belege: Iterable[str], fremd: dict[str, str]) -> str | None:
    """``fremdtext:<kind>`` when every evidence sentence is foreign, else None."""
    belege = list(belege)
    if not belege or not all(b in fremd for b in belege):
        return None
    kinds = sorted({fremd[b] for b in belege})
    return "fremdtext:" + "+".join(kinds)


def zitat_grund(zitat: str | None) -> str | None:
    """Fallback when the source is gone: the booked quote, split at `` … ``."""
    teile = [t for t in (zitat or "").split(" … ") if t.strip()]
    if not teile:
        return None
    kinds = [satz_grund(t) for t in teile]
    if any(k is None for k in kinds):
        return None
    return "fremdtext:" + "+".join(sorted(set(kinds)))
