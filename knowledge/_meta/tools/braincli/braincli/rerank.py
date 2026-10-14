"""Client fuer den Umsortier-Dienst auf peer (`_meta/tools/rerank/`, b6-rerank-dienst).

Schickt Frage plus Passagen (`rangkern.passage_window`) an `POST /rerank` und
sortiert die Kandidaten nach den Scores um. Jede Stoerung -- Dienst aus, VRAM
knapp (503), Fehler, Zeitbudget ueberschritten -- liefert `None`; die Aufrufer
behalten dann die unveraenderte Reihenfolge. Die Suche faellt nie deshalb aus.

Das Zeitbudget gilt fuer den ganzen Aufruf (Verbinden + Senden + Antwort): der
Aufruf laeuft in einem Hintergrund-Thread, auf den hoechstens `budget_s`
gewartet wird. Ein verspaeteter Thread endet spaetestens an seinem eigenen
Socket-Timeout und wird verworfen.

Gemessen (eval/reranker-passagen/BEFUNDE.md, 28.09.): BGE-reranker-v2-m3 auf
den Top 20 mit 2000-Zeichen-Passagen, gepoolter Test hit@1 +0,064, MRR +0,065."""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Sequence, TypeVar

from . import rangkern

T = TypeVar("T")

TOP_N = 20  # so viele Kandidaten werden umsortiert (gemessen: Top 20)
DEFAULT_URL = "http://127.0.0.1:8791"
# Mac -> peer ueber das Tailnet (RTT 43-108 ms): `brain search --rerank`
TAILNET_URL = "http://peer.tailnet.example.ts.net:8791"


def scores(url: str, query: str, passages: Sequence[str], budget_s: float,
           info: dict | None = None) -> list[float] | None:
    """Scores je Passage in Eingabereihenfolge, oder None (Grund in `info`)."""
    info = info if info is not None else {}
    if not passages:
        info["grund"] = "keine_kandidaten"
        return None
    body = json.dumps({"query": query, "passages": list(passages)}, ensure_ascii=False).encode()
    box: dict = {}

    def call() -> None:
        req = urllib.request.Request(url.rstrip("/") + "/rerank", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=max(budget_s, 0.05) + 1.0) as r:
                box["data"] = json.load(r)
        except urllib.error.HTTPError as exc:
            try:
                box["grund"] = json.load(exc).get("grund") or f"http_{exc.code}"
            except (ValueError, OSError):
                box["grund"] = f"http_{exc.code}"
        except (OSError, ValueError) as exc:
            box["grund"] = type(exc).__name__

    t = threading.Thread(target=call, daemon=True, name="brain-rerank")
    t.start()
    t.join(budget_s)
    if t.is_alive():
        info["grund"] = "zeit"
        return None
    if "grund" in box:
        info["grund"] = box["grund"]
        return None
    got = (box.get("data") or {}).get("scores")
    if not isinstance(got, list) or len(got) != len(passages):
        info["grund"] = "antwort_ungueltig"
        return None
    try:
        values = [float(s) for s in got]
    except (TypeError, ValueError):
        info["grund"] = "antwort_ungueltig"
        return None
    info["grund"] = ""
    return values


def reorder(items: Sequence[T], values: Sequence[float]) -> list[T]:
    """Nach Score absteigend; bei Gleichstand bleibt die alte Reihenfolge."""
    order = sorted(range(len(items)), key=lambda i: -values[i])
    return [items[i] for i in order]


def umsortieren(query: str, hits: Sequence[T], passage_of: Callable[[T], str], *,
                url: str, budget_s: float, info: dict | None = None,
                top_n: int | None = None, werte=None) -> list[T]:
    """Die ersten `top_n` (Vorgabe `TOP_N`) Treffer umsortieren, den Rest dahinter unveraendert.
    Bei jeder Stoerung die Eingabe unveraendert (als Liste). `werte` (`hinweis.Werte`, optional) bekommt die
    BGE-Rohscores je Treffer; die Reihenfolge haengt davon nicht ab."""
    info = info if info is not None else {}
    n = TOP_N if top_n is None else top_n
    head, tail = list(hits[:n]), list(hits[n:])
    try:
        passages = [passage_of(h) for h in head]
    except Exception as exc:  # Passagenbau darf die Suche nie stoeren
        info["grund"] = f"passage:{type(exc).__name__}"
        return list(hits)
    values = scores(url, query, passages, budget_s, info)
    if values is None:
        return list(hits)
    info["umsortiert"] = len(head)
    if werte is not None:
        werte.fuellen(head, values)
    return reorder(head, values) + tail


def vault_passage(vault: Path, cache: dict[str, str] | None = None) -> Callable:
    """Passage fuer einen `rangkern.SearchHit` aus einer Vault-Datei."""
    cache = cache if cache is not None else {}

    def build(hit) -> str:
        if hit.rel not in cache:
            try:
                cache[hit.rel] = (vault / hit.rel).read_text(encoding="utf-8")
            except OSError:
                cache[hit.rel] = ""
        return rangkern.passage_window(cache[hit.rel], hit.lines, hit.title or Path(hit.rel).stem)
    return build


# Standard fuer `brain search` (29.09., b7-bestaetigung): AN nach der Bestaetigung auf Satz v3
# (Testhaelfte 96 Fragen, 0 Rueckfaelle, Bootstrap 5000/Seed 7): nDCG@10 +0,069 [95 %: +0,022; +0,117],
# hit@1 +0,031 [-0,031; +0,104]; `brain eval gate` bestanden (eval/v3-bestaetigung/BEFUNDE.md).
# `--no-rerank` oder BRAIN_SEARCH_RERANK=0 schaltet ab; `--rerank` erzwingt.
SEARCH_ENV = "BRAIN_SEARCH_RERANK"
SEARCH_DEFAULT = True
_OFF = {"0", "false", "no", "off", "nein", "aus"}


def search_default() -> bool:
    raw = os.environ.get(SEARCH_ENV, "").strip().lower()
    return SEARCH_DEFAULT if not raw else raw not in _OFF


def cli_url() -> str:
    return os.environ.get("BRAIN_RERANK_URL", "").strip() or TAILNET_URL


def cli_budget_s() -> float:
    """CLI am Mac: Budget inklusive Tailnet-RTT, Vorgabe 1 s (BRAIN_RERANK_BUDGET_MS)."""
    try:
        return max(0.05, float(os.environ.get("BRAIN_RERANK_BUDGET_MS", "1000")) / 1000)
    except ValueError:
        return 1.0
