"""Hinweis bei unsicherem Platz 1 (b14-hinweis, 30.09.2026).

Qualitaetsziel [[brain-qualitaetsziel-top5-98-top1-85]], Fehlerfall: erkennt die Suche selbst, dass die Antwort
schwach ist, kommt sie mit Hinweis. Die Rangfolge aendert diese Stufe nie; sie liest nur Werte, die die Suche
ohnehin hat, und haengt eine Zeile an (Text) bzw. setzt das JSON-Feld `hinweis` (null = kein Hinweis).

Signale (kein zusaetzlicher LLM-Aufruf, keine Prompt-Aenderung an `llm_sort`):
- BGE-Rohscore des finalen Platz 1 (`bge1`) und des besten BGE-Treffers (`bge_top`),
- Abstand Platz 1/Platz 2 (`gap_bge` in BGE-Reihenfolge, `gap_final` in der finalen Reihenfolge),
- ob die LLM-Stufe den BGE-Platz-1 verdraengt hat (`verdraengt`),
- ob der finale Platz 1 per Frontmatter abgeloest ist (`abgeloest`).
Der Dienst auf peer hat keine LLM-Stufe; dort gibt es `verdraengt` nicht, die Regel nutzt dann nur BGE-Signale.
Ohne Reranker (Recall-Hook `--no-rerank`, Rueckfall) gibt es keinen Hinweis.

Regel und Schwellen: auf Dev gewaehlt, vor dem Testlauf festgeschrieben (`_meta/tools/eval/hinweis/`).
Schalter `BRAIN_SEARCH_HINWEIS` (an/aus, Standard an)."""
from __future__ import annotations

import os
from typing import Callable, Sequence

ENV = "BRAIN_SEARCH_HINWEIS"
# Standard AN nach dem einmaligen v4-Test (30.09., n 120, eval/hinweis/BEFUNDE.md): Praezision (a) 0,759 (22/29),
# Fehlalarm 14 % (7/50); Einschaltregel des Auftrags: Praezision >= 0,75 und Fehlalarm <= 20 %. BRAIN_SEARCH_HINWEIS=0
# schaltet ab.
DEFAULT = True
# Nur fuer Messlaeufe: die Signale zusaetzlich im JSON (`hinweis_signale`).
SIGNALE_ENV = "BRAIN_SEARCH_HINWEIS_SIGNALE"
_OFF = {"0", "false", "no", "off", "nein", "aus"}
_ON = {"1", "true", "yes", "on", "ja", "an"}

# Festgeschrieben vor dem Testlauf (eval/hinweis/REGEL.md, Dev-Wahl nach eval/hinweis/WAHLREGEL.md, 30.09.). Stufe "b"
# (Antwort vermutlich in keinem Treffer der Top 5) geht vor Stufe "a" (Platz 1 womoeglich nur Umfeld). Schwellen auf
# BGE-Rohscores (Logits von bge-reranker-v2-m3). Dev v1-v4 (311 Fragen): 73 Hinweise, Praezision (a) 0,808, Fehlalarm
# 9,5 % (14/148), Praezision (b) 0,906 (29/32).
REGEL = {
    "b_bge_top": -3.3672,          # Stufe b, wenn der beste BGE-Score im Pool darunter liegt
    "a_bge1": -3.4297,             # Stufe a, wenn der BGE-Score des finalen Platz 1 darunter liegt
    "a_verdraengt_bge1": -3.0625,  # Stufe a, wenn das LLM den BGE-Platz-1 verdraengt hat und bge1 darunter liegt
    "a_abgeloest": False,          # Stufe a, wenn der finale Platz 1 abgeloest ist (auf Dev ohne Wirkung)
}

TEXTE = {
    "a": "Hinweis: kein sicherer Treffer – Platz 1 ist womöglich nur Umfeld; weitere Treffer prüfen oder Frage "
         "enger stellen.",
    "b": "Hinweis: vermutlich steht die Antwort in keinem dieser Treffer – Ergebnisse nur als Umfeld lesen; Frage "
         "anders stellen oder mit rg nach einem genauen Begriff suchen.",
}


def enabled() -> bool:
    raw = os.environ.get(ENV, "").strip().lower()
    return DEFAULT if not raw else raw not in _OFF


def signale_gewuenscht() -> bool:
    return os.environ.get(SIGNALE_ENV, "").strip().lower() in _ON


class Werte(dict):
    """BGE-Rohscores je Treffer (Schluessel `id(hit)`), gefuellt von `rerank.umsortieren`, dazu die BGE-Reihenfolge
    (`reihe`: Treffer absteigend nach Score). Die Treffer-Objekte bleiben durch alle spaeteren Umordnungen dieselben."""

    def __init__(self) -> None:
        super().__init__()
        self.reihe: list = []

    def fuellen(self, head: Sequence, values: Sequence[float]) -> None:
        self.clear()
        for h, v in zip(head, values):
            self[id(h)] = float(v)
        self.reihe = sorted(head, key=lambda h: -self[id(h)])

    def von(self, hit) -> float | None:
        return self.get(id(hit))


def signale(hits: Sequence, werte: Werte, llm_info: dict | None, abgeloest: Callable[[object], bool]) -> dict | None:
    """Signale des finalen Platz 1, oder None ohne BGE-Scores (Reranker aus oder Rueckfall)."""
    if not hits or not werte or not werte.reihe:
        return None
    top, bge_top = werte.reihe[0], werte.von(werte.reihe[0])
    bge_zweit = werte.von(werte.reihe[1]) if len(werte.reihe) > 1 else None
    bge1 = werte.von(hits[0])
    bge2 = werte.von(hits[1]) if len(hits) > 1 else None
    llm = bool(llm_info) and llm_info.get("grund") == "" and bool(llm_info.get("umsortiert"))
    return {
        "bge1": _r(bge1), "bge2": _r(bge2), "bge_top": _r(bge_top), "bge_zweit": _r(bge_zweit),
        "gap_bge": _r(bge_top - bge_zweit) if bge_zweit is not None else None,
        "gap_final": _r(bge1 - bge2) if bge1 is not None and bge2 is not None else None,
        "llm": llm,
        "verdraengt": llm and hits[0] is not top,
        "abgeloest": bool(abgeloest(hits[0])),
    }


def _r(x: float | None) -> float | None:
    return None if x is None else round(float(x), 4)


def stufe(sig: dict | None, regel: dict | None = None) -> str | None:
    """"b", "a" oder None nach der festgeschriebenen Regel."""
    if not sig:
        return None
    regel = REGEL if regel is None else regel
    bge1, bge_top = sig.get("bge1"), sig.get("bge_top")
    t = regel.get("b_bge_top")
    if t is not None and bge_top is not None and bge_top < t:
        return "b"
    t = regel.get("a_bge1")
    if t is not None and (bge1 is None or bge1 < t):
        return "a"
    t = regel.get("a_verdraengt_bge1")
    if t is not None and sig.get("verdraengt") and (bge1 is None or bge1 < t):
        return "a"
    if regel.get("a_abgeloest") and sig.get("abgeloest"):
        return "a"
    return None


def bewerten(hits: Sequence, werte: Werte, llm_info: dict | None,
             abgeloest: Callable[[object], bool]) -> tuple[str | None, dict | None]:
    """(Hinweistext oder None, Signale). Aendert `hits` nicht."""
    sig = signale(hits, werte, llm_info, abgeloest)
    s = stufe(sig)
    return (TEXTE[s] if s else None), sig


def json_felder(text: str | None, sig: dict | None) -> dict:
    """Felder fuer die JSON-Ausgabe hinter dem Reranker: `hinweis` immer (null = sicher), Signale nur im Messlauf."""
    out: dict = {"hinweis": text}
    if signale_gewuenscht():
        out["hinweis_signale"] = sig
    return out
