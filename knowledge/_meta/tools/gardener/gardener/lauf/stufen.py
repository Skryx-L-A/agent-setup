"""The learning stages of `brain run` (profile ``lehren``/``dream``).

    erkennen      pending      -> erkannt | leer | stale     (no model)
    extrahieren   erkannt      -> extrahiert | leer | wartet-grossmodell
                                  | quarantaene (3 failed attempts)
    grossmodell   wartet-grossmodell -> extrahiert | leer   (Mac, only if it answers)
    abgleichen    extrahiert   -> abgeglichen               (dedup + pair judgments)

Each stage takes one unit at a time and commits its transition, so an
interrupted run resumes where it stopped.  Detector: rules v2 without the
pre-filter (B2).  Extraction: one call per event window, JSON schema whose
evidence items are the window's sentence IDs, identifier gate in code
(``pakete.extrahiere``).  Pair judgments are proposals only: nothing is merged
or superseded automatically; only an exact duplicate (same normalised text
in the same project) is a code fact and is marked ``duplikat``.
"""
from __future__ import annotations

import json
import logging
import math
import os
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from .. import ereignisse, pakete as pakete_mod, paarurteil
from ..engines import EngineError, EngineResponseError, EngineUnavailable
from ..saetze import nach_id, zerlege
from . import buch as b
from . import fremdtext
from .buch import Buch, Key
from .quellen import Leser, Router, einheit_text

try:                            # optional (``gardener[schnell]``), pure Python otherwise
    import numpy as _np
except ImportError:             # pragma: no cover - exercised without numpy only
    _np = None

log = logging.getLogger("gardener.lauf")

DETEKTOR_VERSION = "ereignisse-v2-luecke6"
# Event windows closer than this many sentences are merged into one call
# (B6, measured 2026-09-23 on the B2 gold set with gemma4:12b: recall of the
# reference packages unchanged at 55.6 %, precision 20.3 -> 25.6 %, calls
# -29 %, time -15 %; on the backlog 15,552 -> 11,429 calls).  The detector's
# own recall cannot drop: merged windows are a superset of the sentences.
FENSTER_LUECKE = 6
PROMPT_VERSION = "b2-pakete-v1"
PROMPT_VERSION_B = "b2-pakete-v2b"   # d2: hinter BRAIN_EXTRAKTION_PROMPT=b, Standard bleibt A


def prompt_version() -> str:
    """Version key of the active extraction prompt (see gardener.pakete)."""
    if os.environ.get("BRAIN_EXTRAKTION_PROMPT", "").strip().lower() == "b":
        return PROMPT_VERSION_B
    return PROMPT_VERSION
LEHREN_KLASSEN = ("transcript", "worker-result", "project-doc", "memory")
# 0,80 -> 0,65 (Orchestrator, 2026-09-23): offensichtliche Dubletten aus dem b6-Schreib-Diff lagen
# bei 0,675 / 0,773 / 0,794 (embeddinggemma) und erreichten den Paarurteiler nie. Mehr Kandidaten
# kosten nur Paarurteile (~0,3 s, peer); das Urteil bleibt Vorschlag in der Review-Queue.
KANDIDATEN_COS = 0.65
KANDIDATEN_MAX = 3
GESCHLOSSEN = "projekt-geschlossen"
MAX_TRANSPORT_FEHLER = 3


def schluessel(content_hash: str, modell: str) -> str:
    return b.sha(content_hash, modell, prompt_version(), DETEKTOR_VERSION)[:24]


def key_of(row) -> Key:
    return Key(row["quell_id"], row["segment_index"], row["content_hash"])


def fremdtext_aktiv() -> bool:
    """``BRAIN_FREMDTEXT=0`` keeps harness/skill text in the windows (p3)."""
    return os.environ.get("BRAIN_FREMDTEXT", "1").strip() != "0"


def fremde_ids(row, saetze, leser: Leser) -> dict[str, str]:
    """Foreign sentences of a unit (``fremdtext``); transcripts also by turn head."""
    if not fremdtext_aktiv():
        return {}
    voll = None
    if row["source_class"] == "transcript":
        try:
            voll = leser.text(row["source_class"], row["path"])
        except OSError:
            voll = None
    return fremdtext.fremde_saetze(saetze, voll=voll, offset=row["char_start"])


@dataclass
class StufenErgebnis:
    stufe: str
    bearbeitet: int = 0
    zustaende: dict[str, int] = field(default_factory=dict)
    fehler: list[str] = field(default_factory=list)
    fehlschlaege: int = 0
    sekunden: list[float] = field(default_factory=list)
    uebersprungen: str | None = None     # why the stage did not run
    abgebrochen: bool = False
    einheiten: list[str] = field(default_factory=list)   # unit per entry of `sekunden`
    # per type/project counts, only stages that compute one (nachpruefen)
    verteilung: dict[str, dict] = field(default_factory=dict)

    def zaehle(self, status: str) -> None:
        self.zustaende[status] = self.zustaende.get(status, 0) + 1

    def als_dict(self) -> dict:
        s = sorted(self.sekunden)
        out = {"stufe": self.stufe, "bearbeitet": self.bearbeitet, "zustaende": self.zustaende,
               "fehler": self.fehler[:20], "fehlschlaege": self.fehlschlaege,
               "uebersprungen": self.uebersprungen,
               "abgebrochen": self.abgebrochen,
               "sekunden_je_einheit": {"n": len(s), "median": s[len(s) // 2] if s else None,
                                       "summe": round(sum(s), 2)},
               "zeiten": [{"einheit": e, "s": round(t, 2)}
                          for e, t in list(zip(self.einheiten, self.sekunden))[:50]]}
        if self.verteilung:
            out["verteilung"] = self.verteilung
        return out


Fortschritt = Callable[[str, int, int], None]


def _noop(stufe: str, done: int, total: int) -> None:
    pass


# ---------------------------------------------------------------------------
# erkennen
# ---------------------------------------------------------------------------

def _klassen(klassen) -> tuple[str, ...]:
    return tuple(k for k in LEHREN_KLASSEN if klassen is None or k in klassen)


def erkennen(buch: Buch, *, leser: Leser, router: Router, lauf_id: str | None,
             limit: int | None = None, stop: Callable[[], bool] = lambda: False,
             fortschritt: Fortschritt = _noop, klassen=None,
             projekt: str | None = None, geschlossen: frozenset = frozenset()) -> StufenErgebnis:
    """Event windows per pending unit.  A unit of a closed project
    (``geschlossen``, p3) ends ``leer`` with grund ``projekt-geschlossen``."""
    result = StufenErgebnis("erkennen")
    rows = buch.units(b.PENDING, classes=_klassen(klassen), limit=limit, projekt=projekt,
                      reihenfolge=True)
    for n, row in enumerate(rows, 1):
        if stop():
            result.abgebrochen = True
            break
        key = key_of(row)
        started = time.perf_counter()
        text = einheit_text(row, leser)
        einheit_projekt = row["projekt"]
        if text is None:
            buch.set_status(key, b.STALE, grund="quelle-geaendert-oder-weg", lauf_id=lauf_id)
            result.zaehle(b.STALE)
        else:
            if row["projekt"] is None and row["herkunft"] == "dream-v1":
                einheit_projekt, datum = router.route(row["source_class"], row["path"],
                                                      row["maschine"] or "lokal")
                buch.conn.execute("UPDATE lauf_einheiten SET projekt=?, datum=COALESCE(datum, ?) "
                                  "WHERE quell_id=? AND segment_index=? AND content_hash=?",
                                  (einheit_projekt, datum, *key.as_tuple()))
        if text is not None and einheit_projekt in geschlossen:
            buch.set_status(key, b.LEER, grund=GESCHLOSSEN, fenster=[], lauf_id=lauf_id)
            result.zaehle(b.LEER)
        elif text is not None:
            saetze = zerlege(text)
            fremd = fremde_ids(row, saetze, leser)
            if fremd:           # harness/skill text never reaches the extractor (p3)
                saetze = [s for s in saetze if s.id not in fremd]
            windows = ereignisse.fenster(saetze, luecke=FENSTER_LUECKE)
            if not windows:
                buch.set_status(key, b.LEER, grund="kein-ereignis", fenster=[], lauf_id=lauf_id)
                result.zaehle(b.LEER)
            else:
                data = [{"von": w.von, "bis": w.bis, "regeln": w.regeln, "ids": w.ids} for w in windows]
                buch.set_status(key, b.ERKANNT, fenster=data, lauf_id=lauf_id)
                result.zaehle(b.ERKANNT)
        buch.commit()
        result.bearbeitet += 1
        result.sekunden.append(time.perf_counter() - started)
        result.einheiten.append(str(key))
        fortschritt("erkennen", n, len(rows))
    return result


# ---------------------------------------------------------------------------
# extrahieren (+ grossmodell)
# ---------------------------------------------------------------------------

def _windows(row) -> list[dict]:
    try:
        return json.loads(row["fenster"] or "[]")
    except ValueError:
        return []


TRANSPORT = ("EngineResponseError", "EngineUnavailable")


def _call_window(motoren, endpoints, stufe: str, row, chosen):
    """One window through the stage's models in order (runs in a worker
    thread when the stage is concurrent; touches no book)."""
    outcome, used = None, endpoints[0].model
    for endpoint in endpoints:
        def gen(messages, schema, _e=endpoint):
            return motoren.extrahiere_mit(_e, messages, schema, stufe=stufe)
        outcome = pakete_mod.extrahiere(chosen, gen, quelle=row["quell_id"],
                                        datum=row["datum"], projekt=row["projekt"])
        used = endpoint.model
        if outcome.fehler is None:
            break
        # transport problem: do not burn the fallback on a dead machine
        if outcome.fehler.startswith(TRANSPORT):
            break
    return outcome, used


def _commit_window(buch: Buch, key: Key, nr: int, outcome, used: str, lauf_id: str | None) -> str:
    """Book one window's outcome; 'ok', 'parse' or 'transport'."""
    k = schluessel(key.content_hash, used)
    if outcome.fehler is not None:
        buch.extraktion_merken(key, k, nr, modell=used, sekunden=outcome.sekunden,
                               fehler=outcome.fehler[:300], pakete=0, verworfen=0, lauf_id=lauf_id)
        buch.commit()
        return "transport" if outcome.fehler.startswith(TRANSPORT) else "parse"
    for i, paket in enumerate(outcome.pakete):
        buch.paket_add(key, k, nr, i, modell=used, paket=paket.als_dict(), lauf_id=lauf_id)
    buch.extraktion_merken(key, k, nr, modell=used, sekunden=outcome.sekunden, fehler=None,
                           pakete=len(outcome.pakete), verworfen=len(outcome.verworfen),
                           lauf_id=lauf_id)
    buch.commit()       # one window at a time: an abort loses at most the calls in flight
    return "ok"


def _open_windows(buch: Buch, row, text: str, motoren, leser: Leser | None = None) -> list[tuple[int, list]]:
    """(window nr, sentences) of the windows of ``row`` not yet extracted.
    Idempotent: a window done under any of this stage's models is final.
    Foreign sentences (``fremdtext``) leave windows recognised before p3."""
    key = key_of(row)
    saetze = zerlege(text)
    index = nach_id(saetze)
    if leser is not None:
        for sid in fremde_ids(row, saetze, leser):
            index.pop(sid, None)
    models = motoren.stufen["extraktion"]["modelle"] + motoren.stufen["grossmodell"]["modelle"]
    out = []
    for nr, window in enumerate(_windows(row)):
        if any(buch.extraktion_fertig(key, schluessel(key.content_hash, m), nr) for m in models):
            continue
        chosen = [index[i] for i in window["ids"] if i in index]
        if chosen:
            out.append((nr, chosen))
    return out


class _Pool:
    """Daemon worker threads for model calls; the book stays on the calling
    thread.  Daemon threads, so an interrupted run exits without waiting for
    calls still in flight (their results are simply not booked)."""

    def __init__(self, n: int, fn):
        self.fn = fn
        self.tasks: queue.Queue = queue.Queue()
        self.results: queue.Queue = queue.Queue()
        self.n = n
        for _ in range(n):
            threading.Thread(target=self._work, daemon=True).start()

    def _work(self) -> None:
        while True:
            item = self.tasks.get()
            if item is None:
                return
            tag, args = item
            try:
                self.results.put((tag, self.fn(*args), None))
            except BaseException as exc:      # handed to the calling thread
                self.results.put((tag, None, exc))

    def submit(self, tag, *args) -> None:
        self.tasks.put((tag, args))

    def get(self):
        while True:
            try:
                return self.results.get(timeout=0.5)
            except queue.Empty:
                continue

    def close(self) -> None:
        for _ in range(self.n):
            self.tasks.put(None)


def extrahieren(buch: Buch, *, motoren, leser: Leser, lauf_id: str | None,
                limit: int | None = None, grossmodell: bool = False,
                stop: Callable[[], bool] = lambda: False,
                fortschritt: Fortschritt = _noop, klassen=None,
                projekt: str | None = None, geschlossen: frozenset = frozenset()) -> StufenErgebnis:
    """Extract every open window of the units in ``erkannt`` (or
    ``wartet-grossmodell``).  ``nebenlaeufig`` in the stage's engine config
    (``engines.yaml`` -> ``stufen``) keeps that many windows in flight; the
    book is written on this thread only, one window per transaction."""
    stufe = "grossmodell" if grossmodell else "extrahieren"
    stufe_m = "grossmodell" if grossmodell else "extraktion"
    result = StufenErgebnis(stufe)
    rows = buch.units(b.WARTET if grossmodell else b.ERKANNT, limit=limit,
                      classes=_klassen(klassen), projekt=projekt, reihenfolge=True)
    if not rows:
        return result
    endpoints = (motoren.verfuegbar(stufe_m) if grossmodell else
                 motoren.warte_auf(stufe_m, stop=stop))
    if not endpoints:
        if grossmodell:
            result.uebersprungen = "keine erreichbare Maschine"
        elif stop():
            result.abgebrochen = True
        else:
            base = motoren._base(stufe_m)
            target = base.base_url if base is not None else motoren.stufen[stufe_m]["engine"]
            result.fehler.append(f"Motor nicht erreichbar: {target}")
            result.uebersprungen = "Motor nicht erreichbar"
        return result
    parallel = max(1, int(motoren.stufen[stufe_m].get("nebenlaeufig", 1)))
    zusatz = [] if grossmodell or not hasattr(motoren, "zusatz") else motoren.zusatz(stufe_m)
    saetze = [(endpoints, threading.Semaphore(parallel))] + [
        (eps, threading.Semaphore(n)) for eps, n in zusatz]
    if zusatz:
        parallel += sum(n for _eps, n in zusatz)

    def verteilt(row, chosen):
        """Take a free slot on any machine (main engine first) for one window."""
        while True:
            for eps, sem in saetze:
                if sem.acquire(blocking=False):
                    try:
                        return _call_window(motoren, eps, stufe_m, row, chosen)
                    finally:
                        sem.release()
            time.sleep(0.02)
    total = len(rows)
    state: dict[Key, dict] = {}
    pending: list[tuple[Key, int, list]] = []     # windows not yet handed out
    consecutive = 0
    stopping = False

    def finish(key: Key) -> None:
        nonlocal consecutive
        st_ = state.pop(key)
        if st_["transport"]:
            status = buch.fail(key, st_["transport"])
            result.fehler.append(f"{key}: {st_['transport']}")
        else:
            if st_["parse"]:
                status = b.QUARANTAENE if grossmodell else b.WARTET
            else:
                status = b.EXTRAHIERT if buch.pakete(key=key) else b.LEER
            grund = {b.WARTET: "extraktion-unlesbar", b.QUARANTAENE: "grossmodell-unlesbar",
                     b.LEER: "keine-pakete"}.get(status)
            buch.set_status(key, status, grund=grund, lauf_id=lauf_id)
            consecutive = 0
        buch.commit()
        result.zaehle(status)
        result.bearbeitet += 1
        result.sekunden.append(time.perf_counter() - st_["started"])
        result.einheiten.append(str(key))
        fortschritt(stufe, result.bearbeitet, total)

    def handle(key: Key, nr: int, outcome, used: str) -> None:
        nonlocal consecutive
        st_ = state[key]
        st_["offen"] -= 1
        kind = _commit_window(buch, key, nr, outcome, used, lauf_id)
        if kind != "ok":
            result.fehlschlaege += 1
        if kind == "transport" and not st_["transport"]:
            st_["transport"] = f"EngineResponseError: {outcome.fehler}"
            consecutive += 1
            # the unit's windows not yet handed out wait for the next run
            dropped = [p for p in pending if p[0] == key]
            pending[:] = [p for p in pending if p[0] != key]
            st_["offen"] -= len(dropped)
        elif kind == "parse":
            st_["parse"] += 1
        if st_["offen"] == 0:
            finish(key)

    rows_iter = iter(rows)

    def refill() -> bool:
        """Queue the next unit's windows; False when no unit is left."""
        nonlocal stopping
        while not pending:
            if stop():
                result.abgebrochen = True
                stopping = True
                return False
            if consecutive >= MAX_TRANSPORT_FEHLER:
                base = motoren._base(stufe_m)
                target = base.base_url if base is not None else motoren.stufen[stufe_m]["engine"]
                result.fehler.append(f"Motor nicht erreichbar: {target} ({consecutive} Fehler hintereinander)")
                result.uebersprungen = "Motor nicht erreichbar"
                result.abgebrochen = True
                stopping = True
                return False
            row = next(rows_iter, None)
            if row is None:
                return False
            key = key_of(row)
            started = time.perf_counter()
            if row["projekt"] in geschlossen:       # closed project (p3): no model call
                buch.set_status(key, b.LEER, grund=GESCHLOSSEN, lauf_id=lauf_id)
                buch.commit()
                result.zaehle(b.LEER)
                result.bearbeitet += 1
                result.sekunden.append(0.0)
                result.einheiten.append(str(key))
                fortschritt(stufe, result.bearbeitet, total)
                continue
            text = einheit_text(row, leser)
            if text is None:
                buch.set_status(key, b.STALE, grund="quelle-geaendert-oder-weg", lauf_id=lauf_id)
                state[key] = {"offen": 0, "parse": 0, "transport": None, "started": started}
                state.pop(key)
                buch.commit()
                result.zaehle(b.STALE)
                result.bearbeitet += 1
                result.sekunden.append(time.perf_counter() - started)
                result.einheiten.append(str(key))
                fortschritt(stufe, result.bearbeitet, total)
                continue
            windows = _open_windows(buch, row, text, motoren, leser)
            state[key] = {"offen": len(windows), "parse": 0, "transport": None,
                          "started": started, "row": row}
            if not windows:
                finish(key)
                continue
            pending.extend((key, nr, chosen) for nr, chosen in windows)
        return True

    if parallel == 1:
        while refill():
            key, nr, chosen = pending.pop(0)
            outcome, used = _call_window(motoren, endpoints, stufe_m, state[key]["row"], chosen)
            handle(key, nr, outcome, used)
        return result

    pool = _Pool(parallel, verteilt)
    in_flight = 0
    try:
        while True:
            while in_flight < parallel and not stopping and (pending or refill()):
                key, nr, chosen = pending.pop(0)
                pool.submit((key, nr), state[key]["row"], chosen)
                in_flight += 1
            if in_flight == 0:
                break
            (key, nr), value, exc = pool.get()
            in_flight -= 1
            if exc is not None:
                raise exc
            handle(key, nr, *value)
    finally:
        pool.close()
    return result


# ---------------------------------------------------------------------------
# abgleichen
# ---------------------------------------------------------------------------

def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.casefold()).split())


def _cos(a: list[float], b_: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b_))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b_))
    return dot / (na * nb) if na and nb else 0.0


def cos_allein() -> bool:
    """``BRAIN_ABGLEICH_COS_ALLEIN=0`` restores the model pair judgment."""
    return os.environ.get("BRAIN_ABGLEICH_COS_ALLEIN", "1").strip() != "0"


class _Vektoren:
    """Embeddings of this run's packages, fetched in batches; numpy when
    installed (a project holds up to ~12,000 packages)."""

    def __init__(self, motoren, batch: int = 64):
        self.motoren = motoren
        self.batch = batch
        self.v: dict[str, object] = {}

    def hole(self, pakete) -> None:
        """Embed every package of ``pakete`` not yet known; EngineError on failure."""
        fehlend = [(p["paket_id"], p["aussage"]) for p in pakete if p["paket_id"] not in self.v]
        for i in range(0, len(fehlend), self.batch):
            chunk = fehlend[i:i + self.batch]
            vectors = self.motoren.einbetten([text for _, text in chunk])
            for (pid, _), vec in zip(chunk, vectors):
                if _np is not None:
                    arr = _np.asarray(vec, dtype=_np.float32)
                    norm = float(_np.linalg.norm(arr))
                    vec = arr / norm if norm else arr
                self.v[pid] = vec

    def naehe(self, pid: str, others: list[str]) -> list[float]:
        if not others:
            return []
        if _np is not None:
            return [float(x) for x in _np.stack([self.v[o] for o in others]) @ self.v[pid]]
        own = self.v[pid]
        return [_cos(own, self.v[o]) for o in others]


def _motor_fehlt(result: StufenErgebnis, motoren, stufe_m: str, stop) -> None:
    if stop():
        result.abgebrochen = True
        return
    base = motoren._base(stufe_m)
    target = base.base_url if base is not None else motoren.stufen[stufe_m]["engine"]
    result.fehler.append(f"Motor nicht erreichbar: {target} ({stufe_m})")
    result.uebersprungen = "Motor nicht erreichbar"
    result.abgebrochen = True


def abgleichen(buch: Buch, *, motoren, lauf_id: str | None, limit: int | None = None,
               stop: Callable[[], bool] = lambda: False,
               fortschritt: Fortschritt = _noop, klassen=None,
               projekt: str | None = None) -> StufenErgebnis:
    """Compare each new package with the project's earlier packages.

    Candidates: embedding cosine (embeddinggemma), at most three per package.
    Default (p2, j2 measurement b): cosine >= ``gleich_cos`` (0.62) is the
    verdict ``gleich`` with status ``cos``, no model call; below it the package
    stays new.  ``BRAIN_ABGLEICH_COS_ALLEIN=0``: candidates from
    ``KANDIDATEN_COS`` go to the pair-judgment model as before.  Verdicts are
    proposals only.

    The stage needs its engines and never degrades silently (p2: three runs
    booked 1,617 pair verdicts ``unklar`` with confidence 0 and word overlap
    instead of embeddings, because the peer tunnel was gone): it waits for the
    engines up to ``start_warten_s`` (tunnel rebuilt), a transport error rolls
    the unit back and waits again; without engines the stage fails and the
    units stay ``extrahiert`` for the next run.
    """
    result = StufenErgebnis("abgleichen")
    rows = buch.units(b.EXTRAHIERT, limit=limit, classes=_klassen(klassen), projekt=projekt,
                      reihenfolge=True)
    if not rows:
        return result
    nur_cos = cos_allein()
    benoetigt = ("einbettung",) if nur_cos else ("einbettung", "paarurteil")

    def bereit() -> str | None:
        """None when every needed engine answers, else the missing stage."""
        for stufe_m in benoetigt:
            if not motoren.warte_auf(stufe_m, stop=stop):
                return stufe_m
        return None

    fehlt = bereit()
    if fehlt:
        _motor_fehlt(result, motoren, fehlt, stop)
        return result
    decide, urteil_modell = (None, None) if nur_cos else motoren.decider()
    gleich = motoren.gleich_cos
    kandidat = gleich if nur_cos else KANDIDATEN_COS
    vektoren = _Vektoren(motoren)
    cache = (paarurteil.PairCache(buch.path.parent.parent / "paarurteil.db")
             if not buch.in_memory and not nur_cos else None)

    def einheit(key: Key) -> None:
        for paket in buch.pakete(key=key, status="neu"):
            earlier = [p for p in buch.pakete(projekt=paket["projekt"])
                       if p["paket_id"] != paket["paket_id"]
                       and p["status"] not in ("neu", "duplikat")] if paket["projekt"] else []
            exact = next((p for p in earlier if _norm(p["aussage"]) == _norm(paket["aussage"])), None)
            if exact is not None:
                buch.paket_update(paket["paket_id"], status="duplikat",
                                  abgleich=[{"mit": exact["paket_id"], "urteil": "gleich",
                                             "status": "code", "konfidenz": 1.0}])
                continue
            vektoren.hole([paket, *earlier])
            naehe = vektoren.naehe(paket["paket_id"], [p["paket_id"] for p in earlier])
            scored = [(score, other) for score, other in zip(naehe, earlier) if score >= kandidat]
            verdicts = []
            for score, other in sorted(scored, key=lambda x: -x[0])[:KANDIDATEN_MAX]:
                if nur_cos:
                    verdicts.append({"mit": other["paket_id"], "urteil": "gleich", "status": "cos",
                                     "konfidenz": round(score, 3), "naehe": round(score, 3)})
                    continue
                a = paarurteil.Aussage(other["aussage"], other["datum"], other["projekt"], other["quell_id"])
                c = paarurteil.Aussage(paket["aussage"], paket["datum"], paket["projekt"], paket["quell_id"])
                urteil = paarurteil.judge_pair(a, c, model=urteil_modell, threshold=motoren.schwelle,
                                               cache=cache, decider=decide)
                verdicts.append({"mit": other["paket_id"], "urteil": urteil.label,
                                 "status": urteil.status, "konfidenz": round(urteil.confidence, 3),
                                 "naehe": round(score, 3)})
            buch.paket_update(paket["paket_id"], status="abgeglichen", abgleich=verdicts)

    try:
        n, versuche = 0, 0
        while n < len(rows):
            if stop():
                result.abgebrochen = True
                break
            row = rows[n]
            key = key_of(row)
            started = time.perf_counter()
            try:
                einheit(key)
            except EngineError as exc:
                buch.conn.rollback()        # nothing of the unit is booked
                result.fehlschlaege += 1
                result.fehler.append(f"{key}: {type(exc).__name__}: {exc}")
                versuche += 1
                fehlt = bereit() if versuche < MAX_TRANSPORT_FEHLER else benoetigt[0]
                if fehlt:
                    _motor_fehlt(result, motoren, fehlt, stop)
                    break
                if not nur_cos:
                    decide, urteil_modell = motoren.decider()
                continue                    # the same unit again
            versuche = 0
            buch.set_status(key, b.ABGEGLICHEN, lauf_id=lauf_id)
            buch.commit()
            n += 1
            result.zaehle(b.ABGEGLICHEN)
            result.bearbeitet += 1
            result.sekunden.append(time.perf_counter() - started)
            result.einheiten.append(str(key))
            fortschritt("abgleichen", n, len(rows))
    finally:
        if cache is not None:
            cache.close()
    return result
