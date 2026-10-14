"""Closed-label, evidence-first judgments over two dated statements.

This module deliberately does not write to the vault.  Its only persistent
state is a content-addressed SQLite cache below Gardener's state directory.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sqlite3
import statistics
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable

from . import config
from .engines import Answer, Question, decide


PROMPT_VERSION = "b3-paarurteil-v1"
LABELS = ("gleich", "neuere_loest_ab", "widerspruch", "verschieden", "unklar")
WAITING = "wartet-grossmodell"
_ID_RE = re.compile(r"`([^`]+)`|\[\[([^\]|#]+)")
_NUMBER_RE = re.compile(r"(?<![\w.])-?\d+(?:[.,]\d+)?%?")


@dataclass(frozen=True)
class Aussage:
    text: str
    datum: str | None
    projekt: str | None
    quelle: str | None
    embedding: tuple[float, ...] | None = None

    def normalized_text(self) -> str:
        return " ".join(self.text.casefold().split())

    def parsed_date(self) -> dt.date | None:
        if not self.datum:
            return None
        try:
            return dt.date.fromisoformat(self.datum)
        except ValueError:
            return None


@dataclass(frozen=True)
class Vorstufe:
    date_fact: str
    same_project: bool | None
    same_source: bool | None
    shared_identifiers: tuple[str, ...]
    numbers_a: tuple[str, ...]
    numbers_b: tuple[str, ...]
    certain_equal: bool
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class Urteil:
    label: str
    status: str
    confidence: float
    evidence: tuple[str, ...]
    fingerprint: str
    cached: bool = False


def _identifiers(text: str) -> set[str]:
    return {value.casefold().strip() for match in _ID_RE.findall(text)
            for value in match if value.strip()}


def _numbers(text: str) -> tuple[str, ...]:
    return tuple(sorted(set(_NUMBER_RE.findall(text))))


def _cosine(a: tuple[float, ...] | None, b: tuple[float, ...] | None) -> float | None:
    if a is None or b is None or len(a) != len(b) or not a:
        return None
    dot = sum(x * y for x, y in zip(a, b))
    aa = sum(x * x for x in a) ** .5
    bb = sum(x * x for x in b) ** .5
    return dot / (aa * bb) if aa and bb else None


def vorstufe(a: Aussage, b: Aussage, *, equal_similarity: float = .95) -> Vorstufe:
    """Collect positive facts; absent fields are never treated as equal."""
    da, db = a.parsed_date(), b.parsed_date()
    if da and db:
        delta = abs((db - da).days)
        if da < db:
            date_fact = f"Aussage B ist {delta} Tage neuer als Aussage A."
        elif db < da:
            date_fact = f"Aussage A ist {delta} Tage neuer als Aussage B."
        else:
            date_fact = "Beide Aussagen haben dasselbe Datum."
    else:
        date_fact = "Die Datumsreihenfolge ist nicht bestimmt."
    ids = _identifiers(a.text) & _identifiers(b.text)
    sim = _cosine(a.embedding, b.embedding)
    identical = bool(a.normalized_text()) and a.normalized_text() == b.normalized_text()
    id_plus_similarity = bool(ids) and sim is not None and sim >= equal_similarity
    evidence: list[str] = [date_fact]
    if identical:
        evidence.append("Positiver Gleichheitsbeleg: normalisierte Texte sind identisch.")
    elif id_plus_similarity:
        evidence.append(f"Positiver Gleichheitsbeleg: gemeinsame Bezeichner {sorted(ids)} und Einbettungsähnlichkeit {sim:.3f}.")
    if a.projekt and b.projekt:
        evidence.append(f"Projektvergleich: {'gleich' if a.projekt == b.projekt else 'verschieden'}.")
    if a.quelle and b.quelle:
        evidence.append(f"Quellenvergleich: {'gleich' if a.quelle == b.quelle else 'verschieden'}.")
    return Vorstufe(date_fact, a.projekt == b.projekt if a.projekt and b.projekt else None,
                    a.quelle == b.quelle if a.quelle and b.quelle else None,
                    tuple(sorted(ids)), _numbers(a.text), _numbers(b.text),
                    identical or id_plus_similarity, tuple(evidence))


def pair_fingerprint(a: Aussage, b: Aussage, model: str, prompt_version: str = PROMPT_VERSION) -> str:
    records = [asdict(a), asdict(b)]
    for record in records:
        record.pop("embedding", None)  # model vectors are not statement content
    payload = json.dumps({"statements": sorted(records, key=lambda x: json.dumps(x, sort_keys=True)),
                          "model": model, "prompt_version": prompt_version},
                         ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


class PairCache:
    def __init__(self, path: Path | None = None):
        self.path = path or config.STATE_DIR / "paarurteil.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.execute("""CREATE TABLE IF NOT EXISTS pair_judgments (
            fingerprint TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL,
            confidence REAL NOT NULL, evidence TEXT NOT NULL, decided_at TEXT NOT NULL)""")

    def get(self, fingerprint: str) -> Urteil | None:
        row = self.conn.execute("SELECT label, status, confidence, evidence FROM pair_judgments WHERE fingerprint=?", (fingerprint,)).fetchone()
        if not row:
            return None
        return Urteil(row[0], row[1], row[2], tuple(json.loads(row[3])), fingerprint, True)

    def put(self, judgment: Urteil) -> None:
        self.conn.execute("INSERT OR REPLACE INTO pair_judgments VALUES (?, ?, ?, ?, ?, ?)",
                          (judgment.fingerprint, judgment.label, judgment.status, judgment.confidence,
                           json.dumps(judgment.evidence, ensure_ascii=False), dt.datetime.now(dt.timezone.utc).isoformat()))
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


def judge_pair(a: Aussage, b: Aussage, *, model: str, threshold: float, cache: PairCache | None = None,
               decider: Callable[..., list[Answer]] = decide) -> Urteil:
    fingerprint = pair_fingerprint(a, b, model)
    if cache and (cached := cache.get(fingerprint)):
        # The cache key intentionally excludes the operational threshold.  A
        # cached probability must therefore be routed again for this run.
        status = WAITING if cached.label == "unklar" or cached.confidence < threshold else "entschieden"
        return Urteil(cached.label, status, cached.confidence, cached.evidence, fingerprint, True)
    facts = vorstufe(a, b)
    if facts.certain_equal:
        result = Urteil("gleich", "entschieden", 1.0, facts.evidence, fingerprint)
    else:
        question = Question(
            "Welches Verhältnis gilt? Nutze nur die Aussagen und Fakten. Eine Ablösung ist nur erlaubt, wenn die neuere Aussage die ältere tatsächlich ersetzt.",
            "choice", list(LABELS[:-1]))
        state = (f"{facts.date_fact}\nProjekt gleich: {facts.same_project}. Quelle gleich: {facts.same_source}.\n"
                 f"Gemeinsame Bezeichner: {list(facts.shared_identifiers)}. Zahlen A: {list(facts.numbers_a)}; Zahlen B: {list(facts.numbers_b)}.\n"
                 f"Aussage A: {a.text}\nAussage B: {b.text}")
        answer = decider(state, [question], uncertain_threshold=threshold)[0]
        confidence = answer.probabilities.get(answer.choice, 0.0)
        status = WAITING if answer.unsicher or answer.choice == "unklar" else "entschieden"
        result = Urteil(answer.choice, status, confidence, facts.evidence, fingerprint)
    if cache:
        cache.put(result)
    return result


@dataclass(frozen=True)
class GoldPair:
    a: Aussage
    b: Aussage
    label: str
    label_source: str


def _project_from_source(source: str) -> str | None:
    match = re.search(r"(?:^|[/:])20-projects/([^/#]+)", source)
    return match.group(1) if match else None


def read_legacy_pairs(reconcile_db: Path, claims_db: Path) -> list[GoldPair]:
    """Load reusable old judgments from two databases, both read-only.

    ``pair_verdicts`` records the retained and replaced claim ids while the
    claim texts and dates reside in ``claims.db``.  The old ``unjudged`` rows
    are intentionally excluded: a missing former decision is not a label.
    """
    reconcile = sqlite3.connect(f"file:{Path(reconcile_db).resolve()}?mode=ro", uri=True)
    claims = sqlite3.connect(f"file:{Path(claims_db).resolve()}?mode=ro", uri=True)
    try:
        verdicts = reconcile.execute("SELECT relation, keep, older FROM pair_verdicts").fetchall()
        by_id = {row[0]: row[1:] for row in claims.execute(
            "SELECT claim_id, text, valid_from, source FROM claims").fetchall()}
    except sqlite3.Error as exc:
        raise ValueError(f"legacy reconcile input is unusable: {exc}") from exc
    finally:
        reconcile.close()
        claims.close()
    mapping = {"same": "gleich", "supersedes": "neuere_loest_ab", "distinct": "verschieden"}
    pairs: list[GoldPair] = []
    for relation, keep, older in verdicts:
        label = mapping.get(relation)
        if not label or not keep or not older or keep not in by_id or older not in by_id:
            continue
        old_text, old_date, old_source = by_id[older]
        new_text, new_date, new_source = by_id[keep]
        # The code's date fact is correct by construction for supersession.
        a = Aussage(old_text, old_date, _project_from_source(old_source), old_source)
        b = Aussage(new_text, new_date, _project_from_source(new_source), new_source)
        # Zeitpunkte, nicht nur Tage vergleichen: alle 30 Alt-Abloesungen lagen am selben Tag und
        # fielen mit einem reinen Datumsvergleich heraus (gemessen 2026-09-23).
        if label == "neuere_loest_ab" and (not a.datum or not b.datum or a.datum >= b.datum):
            continue
        pairs.append(GoldPair(a, b, label, "legacy-reconcile"))
    return pairs


def write_goldset(path: Path, pairs: Iterable[GoldPair]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = list(pairs)
    with path.open("w", encoding="utf-8") as handle:
        for pair in rows:
            handle.write(json.dumps({"a": asdict(pair.a), "b": asdict(pair.b), "label": pair.label,
                                     "label_source": pair.label_source}, ensure_ascii=False) + "\n")
    return len(rows)


def measure(pairs: Iterable[GoldPair], *, model: str, threshold: float,
            judge: Callable[[Aussage, Aussage], Urteil]) -> dict[str, object]:
    samples = list(pairs)
    results: list[tuple[GoldPair, Urteil, float]] = []
    for pair in samples:
        started = time.perf_counter()
        result = judge(pair.a, pair.b)
        results.append((pair, result, (time.perf_counter() - started) * 1000))
    per_label = {label: {"total": 0, "correct": 0, "accuracy": None} for label in LABELS}
    for pair, result, _ in results:
        bucket = per_label[pair.label]
        bucket["total"] += 1
        bucket["correct"] += result.label == pair.label
    for bucket in per_label.values():
        if bucket["total"]:
            bucket["accuracy"] = bucket["correct"] / bucket["total"]
    predicted_supersedes = [item for item in results if item[1].label == "neuere_loest_ab" and item[1].status == "entschieden"]
    precision = (sum(pair.label == "neuere_loest_ab" for pair, _, _ in predicted_supersedes) / len(predicted_supersedes)
                 if predicted_supersedes else None)
    latencies = [latency for _, _, latency in results]
    return {"model": model, "threshold": threshold, "pairs": len(results), "per_label": per_label,
            "precision_neuere_loest_ab": precision,
            "waiting_rate": sum(result.status == WAITING for _, result, _ in results) / len(results) if results else 0,
            "ms_per_pair": statistics.mean(latencies) if latencies else 0,
            "meets_supersedes_precision_target": precision is not None and precision >= .9}
