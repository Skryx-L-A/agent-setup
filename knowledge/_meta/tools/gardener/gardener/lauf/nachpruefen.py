"""Stage ``nachpruefen`` of `brain run`: re-check the discarded backlog under
the current rule, without any model call (v3-dream, 2026-09-27).

The stage ``pruefen`` checks each package exactly once: the book still holds
every package the old single-threshold rule (p3, 0.522) discarded, with its
raw model value booked (``pruefung.roh``).  Since d3 the working point is per
package type (``schwellen_je_art`` in ``pruefen-gewichte.json``) over newly
fitted weights.  This stage recomputes the new score from the booked raw
value -- the same features, weights and math as the stage, nothing is asked
again -- and re-opens the packages that pass it: status ``verworfen-auto``
back to ``abgeglichen``, pruefung re-booked with ``grund: null`` and the
recompute marked (``nachrechnung``).  The next ``schreiben`` lists them as
plain proposals (``brain run --stufen nachpruefen,schreiben``); nothing is
taken over directly.

Deterministic rejections (fremdtext, nur-werkzeugzeilen, projekt-geschlossen)
are never revisited, and packages the new rule still rejects stay discarded
(their booked pruefung is untouched).  A re-opened package is never asked
again: ``zu_pruefen`` only takes packages without a booked check.

It is never part of the default profiles -- only
``brain run --stufen nachpruefen[,schreiben]``.  ``--dry-run`` runs on the
in-memory book copy: it counts and plans, nothing reaches disk.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path
from typing import Callable

from . import buch as b
from .buch import Buch
from .pruefen import GEWICHTE_DATEI, merkmalswerte, regressions_score
from .stufen import Fortschritt, StufenErgebnis, _noop

# deterministic reasons never revisited (the stage's own gates)
DETERMINISTISCH = ("fremdtext", "nur-werkzeugzeilen", "projekt-geschlossen")
STUFE = "nachpruefen"


def lade_gewichte(standard: float | None = None) -> tuple[dict, float]:
    """(weights, fallback threshold): the same file resolution as the stage
    (``BRAIN_PRUEFEN_GEWICHTE`` overrides the default file, a rollback file
    without ``schwellen_je_art`` falls back to ``standard``)."""
    name = os.environ.get("BRAIN_PRUEFEN_GEWICHTE") or str(GEWICHTE_DATEI)
    path = Path(name) if os.path.isabs(name) else GEWICHTE_DATEI.with_name(name)
    gewichte = json.loads(path.read_text(encoding="utf-8"))
    return gewichte, standard if standard is not None else \
        float(gewichte.get("schwelle_dev", 0.522))


def schwelle_fuer(gewichte: dict, typ: str | None, standard: float) -> float:
    """d3: working point per package type, ``standard`` as fallback."""
    return float((gewichte.get("schwellen_je_art") or {}).get(typ or "", standard))


def score_von_buchung(gewichte: dict, pruefung: dict, row, source_class: str | None) -> float | None:
    """The new rule's score of one package from its booked raw value
    (``pruefung.roh``), None when the booking carries no raw value or a
    deterministic reason (those are not revisited)."""
    if pruefung.get("roh") is None:
        return None
    grund = str(pruefung.get("grund") or "")
    if grund.split(":")[0] in DETERMINISTISCH:
        return None
    meta = {"source_class": source_class, "typ": row["typ"], "projekt": row["projekt"]}
    return regressions_score(gewichte, merkmalswerte(gewichte, float(pruefung["roh"]), meta))


def kandidaten(buch: Buch, *, klassen=None, projekt: str | None = None,
               limit: int | None = None) -> list:
    """Packages ``verworfen-auto`` of the proposal types, discarded by the
    decider (``grund: entscheider``, raw-value bookings only: ``frage: art``);
    classes and project narrow the backlog.  Bookings without a raw value
    count as ``ohne-roh`` and are skipped."""
    sql = ("SELECT p.*, e.source_class AS e_source_class FROM lauf_pakete p "
           "JOIN lauf_einheiten e ON e.quell_id=p.quell_id AND e.segment_index=p.segment_index "
           "AND e.content_hash=p.content_hash "
           f"WHERE p.status=? AND p.typ IN ({','.join('?' * len(b.PRUEF_TYPEN))}) "
           "AND p.pruefung IS NOT NULL AND json_extract(p.pruefung, '$.grund')='entscheider' "
           "AND json_extract(p.pruefung, '$.frage')='art'")
    params: list = [b.VERWORFEN_AUTO, *b.PRUEF_TYPEN]
    if klassen is not None:
        klassen = list(klassen)
        sql += f" AND e.source_class IN ({','.join('?' * len(klassen))})"
        params += klassen
    if projekt is not None:
        sql += " AND p.projekt=?"
        params.append(projekt)
    sql += " ORDER BY p.paket_id"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return buch.conn.execute(sql, params).fetchall()


def verteilung(buch: Buch, *, klassen=None, projekt: str | None = None,
               gewichte: dict | None = None, standard: float | None = None) -> dict:
    """Counts without writing: how many discarded packages would the current
    rule keep, per type and per project (the ``--dry-run`` view and the
    backlog report).  ``ohne_roh`` counts booked ``entscheider`` rejections
    without a raw value."""
    if gewichte is None:
        gewichte, standard = lade_gewichte(standard)
    elif standard is None:
        standard = float(gewichte.get("schwelle_dev", 0.522))
    rows = kandidaten(buch, klassen=klassen, projekt=projekt)
    je_art: dict[str, int] = {}
    je_projekt: dict[str, int] = {}
    ohne_roh = 0
    for row in rows:
        pruefung = json.loads(row["pruefung"])
        score = score_von_buchung(gewichte, pruefung, row, row["e_source_class"])
        if score is None:
            ohne_roh += 1
            continue
        if score < schwelle_fuer(gewichte, row["typ"], standard):
            continue
        je_art[row["typ"]] = je_art.get(row["typ"], 0) + 1
        p = row["projekt"] or "?"
        je_projekt[p] = je_projekt.get(p, 0) + 1
    return {"kandidaten": len(rows), "ohne_roh": ohne_roh, "behalten": sum(je_art.values()),
            "je_art": dict(sorted(je_art.items())), "je_projekt": dict(sorted(je_projekt.items(),
            key=lambda kv: -kv[1]))}


def nachpruefen(buch: Buch, *, lauf_id: str | None = None, limit: int | None = None,
                stop: Callable[[], bool] = lambda: False, fortschritt: Fortschritt = _noop,
                klassen=None, projekt: str | None = None, schwelle_standard: float | None = None,
                gewichte: dict | None = None) -> StufenErgebnis:
    """Re-open the discarded packages the current rule keeps.  One transaction
    per package; an interrupted run resumes (re-opened packages are no longer
    candidates).  No engine is touched."""
    result = StufenErgebnis(STUFE)
    g, standard = lade_gewichte(schwelle_standard)
    if gewichte is not None:
        g = gewichte
        if schwelle_standard is None:
            standard = float(gewichte.get("schwelle_dev", 0.522))
    rows = kandidaten(buch, klassen=klassen, projekt=projekt, limit=limit)
    name = os.path.basename(os.environ.get("BRAIN_PRUEFEN_GEWICHTE") or GEWICHTE_DATEI.name)
    heute = dt.date.today().isoformat()
    je_art: dict[str, int] = {}
    je_projekt: dict[str, int] = {}
    for n, row in enumerate(rows, 1):
        if stop():
            result.abgebrochen = True
            break
        started = time.perf_counter()
        pruefung = json.loads(row["pruefung"])
        score = score_von_buchung(g, pruefung, row, row["e_source_class"])
        if score is None:
            result.zaehle("ohne-roh")
        else:
            schwelle = schwelle_fuer(g, row["typ"], standard)
            if score < schwelle:
                result.zaehle("bleibt-verworfen")
            else:
                buch.pruefung_merken(row["paket_id"], {
                    "grund": None, "score": round(score, 4), "roh": pruefung.get("roh"),
                    "schwelle": round(schwelle, 6), "modell": pruefung.get("modell"),
                    "frage": pruefung.get("frage", "art"), "gewichte": True,
                    "nachrechnung": {"stand": heute, "gewichte": name,
                                     "alt_grund": pruefung.get("grund"),
                                     "alt_score": pruefung.get("score"),
                                     "alt_schwelle": pruefung.get("schwelle")},
                    "lauf_id": lauf_id}, verwerfen=False)
                buch.paket_update(row["paket_id"], status=b.ABGEGLICHEN)
                result.zaehle("neu-behalten")
                result.einheiten.append(row["paket_id"])
                je_art[row["typ"]] = je_art.get(row["typ"], 0) + 1
                p = row["projekt"] or "?"
                je_projekt[p] = je_projekt.get(p, 0) + 1
        buch.commit()
        result.bearbeitet += 1
        result.sekunden.append(time.perf_counter() - started)
        fortschritt(STUFE, n, len(rows))
    result.verteilung = {"je_art": je_art, "je_projekt": je_projekt,
                         "kandidaten": len(rows), "behalten": sum(je_art.values())}
    return result
