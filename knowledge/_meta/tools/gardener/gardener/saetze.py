"""Segment -> numbered sentences with stable IDs (Brain 5, B2, idea I8).

An extraction model names evidence only by sentence ID; the code rebuilds the
quote from the original text.  An invented quote is therefore impossible by
construction, only the choice of sentence can be wrong.

Units:
- a fenced code block (```...```) is one unit, however long;
- every list item (``-``, ``*``, ``+``, ``1.``, ``1)``) and every heading is
  one unit, continuation lines of an item belong to it;
- a Markdown table is one unit, and so is a ``werkzeug:`` marker line;
- running prose is split into sentences (German and English punctuation,
  common abbreviations, ordinals and decimals do not end a sentence).

IDs are ``S1``, ``S2``, ... in text order, so the same segment text always
yields the same IDs.  Each ``Satz`` keeps ``start``/``end`` offsets into the
original string; ``text`` is exactly ``original[start:end]``.

Transcript segments (``user: ...`` / ``assistant: ...`` turns, as produced by
``dream.segment.flatten_transcript``) additionally get the speaker in
``rolle``; the event detector uses it for user objections.
"""
from __future__ import annotations

from dataclasses import dataclass
import re

ROLE_RE = re.compile(r"^(user|assistant|werkzeug):[ \t]*", re.IGNORECASE)
FENCE_RE = re.compile(r"^[ \t]*(```|~~~)")
LIST_RE = re.compile(r"^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+\S")
HEADING_RE = re.compile(r"^[ \t]*#{1,6}[ \t]+\S")
TABLE_RE = re.compile(r"^[ \t]*\|")
# Tokens directly before a period that do not end a sentence.
ABBREVIATIONS = frozenset("""
z.b zb d.h dh u.a ua bzw ca nr vgl usw etc e.g eg i.e ie dr mr mrs ms prof
inkl evtl ggf s o.ä u.ä sog bspw zzgl abs abb kap bd hrsg jh jan feb mär apr jun
jul aug sep sept okt nov dez vs st mio mrd tsd min max sek std
""".split())
# End of sentence: . ! ? … (optionally followed by closing quotes/brackets),
# then whitespace.  The candidate is confirmed in _split_prose.
END_RE = re.compile(r"[.!?…]+[\"'”“»«)\]]*(?=\s)")


@dataclass(frozen=True)
class Satz:
    id: str
    start: int
    end: int
    text: str
    art: str            # satz | code | liste | kopf | tabelle | werkzeug
    rolle: str | None   # user | assistant | werkzeug | None

    @property
    def nummer(self) -> int:
        return int(self.id[1:])


def _line_spans(text: str) -> list[tuple[int, int]]:
    spans, pos = [], 0
    for line in text.splitlines(keepends=True):
        end = pos + len(line.rstrip("\r\n"))
        spans.append((pos, end))
        pos += len(line)
    return spans


def _strip_span(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def _ends_sentence(text: str, dot: int, after: int) -> bool:
    """``dot`` is the index of the first end mark, ``after`` the index after
    the mark run.  Decide whether this really ends a sentence."""
    mark = text[dot]
    nxt = text[after:after + 40].lstrip()
    if not nxt:
        return True
    if mark == ".":
        word = re.search(r"([\w.äöüÄÖÜß]+)$", text[max(0, dot - 30):dot])
        token = word.group(1).lower().rstrip(".") if word else ""
        if token in ABBREVIATIONS or (len(token) == 1 and token.isalpha()):
            return False
        # "23. September", "3. Schritt": an ordinal, not a full stop.
        if token.isdigit() and nxt[:1].isalpha() and not nxt[:1].isupper():
            return False
        if token.isdigit() and len(token) <= 2 and re.match(
                r"(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|"
                r"November|Dezember|Jahrhundert|Schritt|Stelle|Platz)\b", nxt):
            return False
    first = nxt[0]
    return first.isupper() or first.isdigit() or first in "\"'„“”»«([`*_-#" or not first.isalnum()


def _split_prose(text: str, start: int, end: int) -> list[tuple[int, int]]:
    pieces, cursor = [], start
    for match in END_RE.finditer(text, start, end):
        if _ends_sentence(text, match.start(), match.end()):
            pieces.append((cursor, match.end()))
            cursor = match.end()
    pieces.append((cursor, end))
    out = []
    for a, b in pieces:
        a, b = _strip_span(text, a, b)
        if b > a:
            out.append((a, b))
    return out


def zerlege(text: str) -> list[Satz]:
    """Split ``text`` into numbered units with offsets."""
    raw: list[tuple[int, int, str, str | None]] = []
    rolle: str | None = None
    lines = _line_spans(text)
    i = 0
    para_start = para_end = None

    def flush_para():
        nonlocal para_start, para_end
        if para_start is not None and rolle == "werkzeug":
            s, e = _strip_span(text, para_start, para_end)
            raw.append((s, e, "werkzeug", rolle))
        elif para_start is not None:
            for a, b in _split_prose(text, para_start, para_end):
                raw.append((a, b, "satz", rolle))
        para_start = para_end = None

    while i < len(lines):
        a, b = lines[i]
        line = text[a:b]
        role = ROLE_RE.match(line)
        if role:
            flush_para()
            rolle = role.group(1).lower()
            a += role.end()
            line = text[a:b]
        if not line.strip():
            flush_para()
            i += 1
            continue
        if FENCE_RE.match(line):
            flush_para()
            fence = FENCE_RE.match(line).group(1)
            j = i + 1
            while j < len(lines) and not text[lines[j][0]:lines[j][1]].lstrip().startswith(fence):
                j += 1
            end = lines[min(j, len(lines) - 1)][1]
            s, e = _strip_span(text, a, end)
            raw.append((s, e, "code", rolle))
            i = j + 1
            continue
        if HEADING_RE.match(line):
            flush_para()
            s, e = _strip_span(text, a, b)
            raw.append((s, e, "kopf", rolle))
            i += 1
            continue
        if TABLE_RE.match(line):
            flush_para()
            j = i
            while j + 1 < len(lines) and TABLE_RE.match(text[lines[j + 1][0]:lines[j + 1][1]]):
                j += 1
            s, e = _strip_span(text, a, lines[j][1])
            raw.append((s, e, "tabelle", rolle))
            i = j + 1
            continue
        if LIST_RE.match(line):
            flush_para()
            indent = len(line) - len(line.lstrip())
            j = i
            while j + 1 < len(lines):
                nxt = text[lines[j + 1][0]:lines[j + 1][1]]
                if (not nxt.strip() or LIST_RE.match(nxt) or HEADING_RE.match(nxt)
                        or FENCE_RE.match(nxt) or ROLE_RE.match(nxt)
                        or len(nxt) - len(nxt.lstrip()) <= indent):
                    break
                j += 1
            s, e = _strip_span(text, a, lines[j][1])
            raw.append((s, e, "liste", rolle))
            i = j + 1
            continue
        if para_start is None:
            para_start = a
        para_end = b
        i += 1
    flush_para()
    return [Satz(f"S{n}", s, e, text[s:e], art, r)
            for n, (s, e, art, r) in enumerate(raw, 1)]


def nach_id(saetze: list[Satz]) -> dict[str, Satz]:
    return {satz.id: satz for satz in saetze}


def zitat(saetze: list[Satz] | dict[str, Satz], ids: list[str]) -> str:
    """Rebuild the quoted original text for ``ids`` (unknown IDs raise)."""
    index = saetze if isinstance(saetze, dict) else nach_id(saetze)
    chosen = sorted((index[i] for i in dict.fromkeys(ids)), key=lambda s: s.start)
    return " … ".join(satz.text for satz in chosen)


def darstellung(saetze: list[Satz], *, max_zeichen: int = 700) -> str:
    """Prompt form: one ``[S12] text`` line per unit, whitespace collapsed,
    very long units shortened (evidence is always rebuilt from the original)."""
    lines, previous = [], None
    for satz in saetze:
        body = " ".join(satz.text.split())
        if len(body) > max_zeichen:
            body = body[:max_zeichen - 1] + "…"
        speaker = f"{satz.rolle}: " if satz.rolle and satz.rolle != previous else ""
        previous = satz.rolle
        lines.append(f"[{satz.id}] {speaker}{body}")
    return "\n".join(lines)
