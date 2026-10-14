"""Learning-event detector (Brain 5, B2, idea I7).

Not every 6,000-character window goes to a model.  Rules first find the
places where something was learnt -- a user objection, a tool failure that is
later fixed, a revert, "the cause was ...", a decision, an ``OPEN`` or
findings section -- and only a window of sentence IDs around each event is
extracted.  An optional ``decide()`` pre-filter ("does this window hold
durable knowledge?") can drop windows afterwards; it never adds any.

Input is the sentence list from ``gardener.saetze.zerlege``.  Transcript
segments carry the speaker in ``Satz.rolle`` (``user``/``assistant``/
``werkzeug``); ``flache_transkript`` produces such text from a Claude Code
JSONL transcript including short tool markers, which the failure->fix rule
needs.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
import re
from typing import Iterable

from .saetze import Satz, darstellung

I = re.IGNORECASE


@dataclass(frozen=True)
class Regel:
    name: str
    muster: re.Pattern
    rollen: tuple[str | None, ...] | None = None   # None: any speaker
    davor: int = 3
    danach: int = 3


# User objections and standing instructions: only a real user turn counts, so
# "nein" inside a worker report or a tool error never fires.
WIDERSPRUCH = Regel("widerspruch", re.compile(
    r"^\W*(?:nein|nee|no|nope|stopp?|halt)\b|\b(?:falsch|stimmt (?:so )?nicht|nicht so\b|"
    r"hatten wir (?:doch )?(?:schon|bereits)|hab(?:e)? ich (?:doch )?(?:schon|bereits|dir) gesagt|"
    r"wie gesagt|warum hast du|wieso hast du|du sollst(?:est)? (?:doch )?nicht|bitte nicht|"
    r"schon wieder|immer noch nicht|funktioniert (?:immer noch |so |doch )?nicht|"
    r"geht (?:immer noch |so |doch )?nicht|that'?s (?:wrong|not)|not what i|don'?t do|"
    r"das war nicht|nicht das,? was|das ist nicht)\b", I), ("user",), davor=6, danach=5)
ANWEISUNG = Regel("anweisung", re.compile(
    r"\b(?:merk(?:e)? dir|remember|immer wenn|jedes mal|grundsätzlich|nie ohne|"
    r"bitte immer|in zukunft|ab jetzt|ab sofort|von nun an|künftig)\b", I), ("user",), davor=2, danach=4)
RUECKNAHME = Regel("ruecknahme", re.compile(
    r"\b(?:git revert|git reset --hard|git restore|zurückgenommen|rückgängig|reverted?|"
    r"rollback|zurückgerollt|zurückgesetzt|wieder entfernt|rolled back)\b", I))
URSACHE = Regel("ursache", re.compile(
    r"\b(?:ursache|root cause|lag daran|lag (?:an|am) |grund war|verursacht|caused by|"
    r"the (?:problem|issue|bug) was|das problem war|weil .{0,40}fehlte)", I), davor=3, danach=3)
LEHRE = Regel("lehre", re.compile(
    r"\b(?:lehre|lektion|lesson|merke|merksatz|künftig|in zukunft|nie wieder|nie mehr|"
    r"niemals|immer zuerst|zuerst prüfen|takeaway|pitfall|falle|fallstrick)\b", I))
FEHLER = Regel("fehler", re.compile(
    r"\b(?:fehler(?:bild|quelle|ursache)?|bug|kaputt|broken|regression|fehlgeschlagen|"
    r"schlug fehl|scheitert|gescheitert|fix(?:ed)?|gefixt|behoben|korrigiert)\b", I),
    ("assistant", None), davor=2, danach=3)
# Findings, surprises and corrections of an earlier claim.
ERKENNTNIS = Regel("erkenntnis", re.compile(
    r"\b(?:fällt (?:mir )?(?:dabei )?(?:etwas )?auf|wichtiger ist|zeigte sich|stellte sich (?:\w+ )?heraus|"
    r"herausgestellt|kernfund|kern:|in wahrheit|tatsächlich|real defect|echter (?:defekt|fehler)|"
    r"did not|didn'?t|war falsch|was wrong|nie gelaufen|nie ausgeführt|never ran|behauptet|widerspricht|"
    r"corrected|gegenprobe|nachgestellt|reproduziert|hinterlässt|risiko|blocker|nebenbefund|"
    r"ohne (?:das|dies)|sonst)\b", I), ("assistant", None), davor=2, danach=2)
ENTSCHEIDUNG = Regel("entscheidung", re.compile(
    r"\b(?:entschieden|entscheidung|beschlossen|ab jetzt|ab sofort|von nun an|künftig gilt|"
    r"gilt ab|wir nehmen|bleiben bei|decided|decision|festgelegt|verbindlich|verworfen|"
    r"stattdessen)\b", I))
OFFEN = Regel("offen", re.compile(
    r"(?:`OPEN`|\bOPEN\b|\b(?:offene punkte|befund(?:e)?|nicht geprüft|ungeprüft|ungeklärt|"
    r"unklar,? ob|noch offen|bleibt offen|offen bleibt|not verified|could not be (?:run|tested)|"
    r"nicht getestet|nicht verifiziert)\b|\bTODO\b)", I), davor=1, danach=3)
EMPFEHLUNG = Regel("empfehlung", re.compile(
    r"\b(?:empfehl(?:ung|e|en)|empfohlen\w*|recommend\w*|statt |instead of|nutzen wir|läuft über|"
    r"laufen über|muss|müssen|braucht|needs?|requires?)\b", I), ("assistant", None), davor=1, danach=2)
# Every substantial user turn: in worker transcripts it is the job itself,
# elsewhere a correction or a standing instruction.
NUTZER = Regel("nutzer", re.compile(r"(?:\S+\s+){7,}\S"), ("user",), davor=1, danach=3)

REGELN: tuple[Regel, ...] = (WIDERSPRUCH, ANWEISUNG, RUECKNAHME, URSACHE, LEHRE, FEHLER,
                             ERKENNTNIS, ENTSCHEIDUNG, OFFEN, EMPFEHLUNG, NUTZER)

# Sections whose whole body is an event (up to ABSCHNITT_MAX units).
ABSCHNITT_RE = re.compile(
    r"^#{1,6}\s*(?:\d+[.)]?\s*)?(?:OPEN|Offen|Offene Punkte|Befund|Befunde|Findings|Lehren?|"
    r"Lessons?|Fallen|Entscheidungen?|Decisions?|Ursache|Root cause|Fehler|Probleme?|"
    r"Known issues|Bekannte (?:Fallen|Probleme))\b", I)
ABSCHNITT_MAX = 15

FEHLSCHLAG_RE = re.compile(
    r"(?:\[fehler\]|Traceback|\bError\b|\bFAILED\b|\bfailed\b|exit code [1-9]|Exit code [1-9]|"
    r"command not found|No such file|Permission denied|fehlgeschlagen|schlägt fehl|"
    r"\d+ failed|AssertionError)", 0)
ERFOLG_RE = re.compile(
    r"(?:\b\d+ passed\b|\ball (?:tests )?(?:passed|green)\b|\bgrün\b|\bgreen\b|erfolgreich|"
    r"funktioniert jetzt|läuft jetzt|\bbehoben\b|\bfixed\b|✓|\bOK\b|now works|works now)", I)
FEHLER_ERFOLG_ABSTAND = 25
FEHLER_ERFOLG_MAX = 20


@dataclass(frozen=True)
class Ereignis:
    regel: str
    satz: str            # ID of the triggering unit
    von: int             # index range [von, bis] into the sentence list
    bis: int


@dataclass
class Fenster:
    von: str
    bis: str
    regeln: list[str]
    ids: list[str] = field(default_factory=list)
    vorfilter: str | None = None     # ja | nein | unsicher, when a pre-filter ran

    def enthaelt(self, satz_id: str) -> bool:
        return satz_id in self.ids


def _window(n: int, index: int, davor: int, danach: int) -> tuple[int, int]:
    return max(0, index - davor), min(n - 1, index + danach)


def erkenne(saetze: list[Satz], regeln: Iterable[Regel] = REGELN) -> list[Ereignis]:
    """All rule hits, each with its own sentence-index window."""
    n = len(saetze)
    events: list[Ereignis] = []
    for index, satz in enumerate(saetze):
        text = satz.text
        for regel in regeln:
            if regel.rollen is not None and satz.rolle not in regel.rollen:
                continue
            if satz.rolle == "werkzeug":
                continue      # tool output never counts as prose evidence of an event
            if regel.name == "nutzer" and index > 0 and saetze[index - 1].rolle == "user":
                continue      # only the start of a user turn
            if regel.muster.search(text):
                events.append(Ereignis(regel.name, satz.id, *_window(n, index, regel.davor, regel.danach)))
        if satz.art == "kopf" and ABSCHNITT_RE.match(text.strip()):
            end = index
            while end + 1 < n and saetze[end + 1].art != "kopf" and end - index < ABSCHNITT_MAX:
                end += 1
            events.append(Ereignis("abschnitt", satz.id, index, end))
    # A failed tool call is an event on its own (the reaction follows it) ...
    for index, satz in enumerate(saetze):
        if satz.rolle == "werkzeug" and satz.text.startswith("[fehler]"):
            events.append(Ereignis("werkzeugfehler", satz.id, *_window(n, index, 2, 4)))
    # ... and a failure followed by success spans the attempt, the change and the green run.
    last_success_end = -1
    for index, satz in enumerate(saetze):
        if index <= last_success_end or not FEHLSCHLAG_RE.search(satz.text):
            continue
        if satz.rolle == "user":
            continue
        for later in range(index + 1, min(n, index + 1 + FEHLER_ERFOLG_ABSTAND)):
            other = saetze[later]
            if other.rolle != "user" and ERFOLG_RE.search(other.text) and not FEHLSCHLAG_RE.search(other.text):
                start = max(0, index - 2)
                end = min(n - 1, later + 1)
                if end - start + 1 > FEHLER_ERFOLG_MAX:
                    events.append(Ereignis("fehler-erfolg", satz.id, start, min(n - 1, index + 8)))
                    events.append(Ereignis("fehler-erfolg", other.id, max(0, later - 4), end))
                else:
                    events.append(Ereignis("fehler-erfolg", satz.id, start, end))
                last_success_end = later
                break
    return events


def fenster(saetze: list[Satz], regeln: Iterable[Regel] = REGELN, *, luecke: int = 1) -> list[Fenster]:
    """Merge overlapping event windows (gap <= ``luecke`` units)."""
    events = sorted(erkenne(saetze, regeln), key=lambda e: (e.von, e.bis))
    merged: list[list] = []
    for event in events:
        if merged and event.von <= merged[-1][1] + luecke + 1:
            merged[-1][1] = max(merged[-1][1], event.bis)
            merged[-1][2].add(event.regel)
        else:
            merged.append([event.von, event.bis, {event.regel}])
    return [Fenster(saetze[a].id, saetze[b].id, sorted(rules), [s.id for s in saetze[a:b + 1]])
            for a, b, rules in merged]


def anteil(fenster_liste: list[Fenster], saetze: list[Satz]) -> float:
    """Share of the segment's characters that lies inside some window."""
    total = sum(len(s.text) for s in saetze)
    if not total:
        return 0.0
    inside = {i for f in fenster_liste for i in f.ids}
    return sum(len(s.text) for s in saetze if s.id in inside) / total


VORFILTER_FRAGE = ("Enthält dieser Ausschnitt dauerhaftes Wissen, das in künftigen Arbeitssitzungen "
                   "nützt (eine Entscheidung, einen Fehler mit Ursache oder Gegenmittel, eine Lehre "
                   "oder einen belastbaren Fakt über System, Werkzeug oder Projekt)?")


def vorfilter(fenster_liste: list[Fenster], saetze: list[Satz], *, registry=None,
              decide_fn=None) -> list[Fenster]:
    """Jev-style pre-filter over the windows.  Keeps ``ja`` and ``unsicher``
    (uncertainty goes on to the extractor, never silently away)."""
    from .engines import Question, decide
    decide_fn = decide_fn or decide
    index = {s.id: s for s in saetze}
    kept = []
    for window in fenster_liste:
        state = darstellung([index[i] for i in window.ids])
        answer = decide_fn(state, [Question(VORFILTER_FRAGE, "noul")], registry=registry)[0]
        window.vorfilter = "unsicher" if answer.unsicher else answer.choice
        if window.vorfilter != "nein":
            kept.append(window)
    return kept


# ---------------------------------------------------------------------------
# Transcript flattening with tool markers
# ---------------------------------------------------------------------------

def _text_blocks(content) -> list[str]:
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
    return []


def _tool_use_line(block: dict) -> str | None:
    name = block.get("name", "?")
    data = block.get("input") or {}
    if name == "Bash":
        detail = str(data.get("command", ""))
    elif name in ("Edit", "Write", "Read", "MultiEdit", "NotebookEdit"):
        detail = str(data.get("file_path", ""))
    else:
        return None
    detail = " ".join(detail.split())[:160]
    return f"werkzeug: [{name}] {detail}"


def _tool_result_line(block: dict) -> str | None:
    if not block.get("is_error"):
        return None
    content = block.get("content")
    if isinstance(content, list):
        content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    text = " ".join(str(content or "").split())[:240]
    return f"werkzeug: [fehler] {text}"


HARNESS_RE = re.compile(
    r"<(system-reminder|command-name|command-message|command-args|local-command-stdout|"
    r"local-command-caveat|task-notification|user-prompt-submit-hook)>.*?</\1>", re.S)


def flache_transkript(path: Path, *, max_turn_chars: int = 20_000) -> str:
    """``user:``/``assistant:`` turns plus ``werkzeug:`` lines for shell
    commands, file edits and failed tool calls.  Thinking blocks, tool output
    of successful calls and harness metadata are left out."""
    try:
        raw = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return flache_transkript_text(raw, max_turn_chars=max_turn_chars)


def flache_transkript_text(raw: str, *, max_turn_chars: int = 20_000) -> str:
    """``flache_transkript`` for JSONL text already in memory (a transcript
    read over ssh from the other machine)."""
    chunks: list[str] = []
    for line in raw.splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict) or msg.get("role") not in ("user", "assistant"):
            continue
        role = msg["role"]
        content = msg.get("content")
        text = "\n".join(t for t in _text_blocks(content) if t.strip())
        text = HARNESS_RE.sub("", text).strip()
        if text and len(text) <= max_turn_chars:
            chunks.append(f"{role}: {text}")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                marker = (_tool_use_line(block) if block.get("type") == "tool_use"
                          else _tool_result_line(block) if block.get("type") == "tool_result" else None)
                if marker:
                    chunks.append(marker)
    return "\n\n".join(chunks)
