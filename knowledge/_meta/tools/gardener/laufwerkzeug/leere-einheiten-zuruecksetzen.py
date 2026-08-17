#!/usr/bin/env python3
"""Setzt Einheiten, die ohne eine einzige Aussage durchgelaufen sind, wieder
auf `pending`.

Anlass (12.08.2026): 147 von 325 bearbeiteten Einheiten hatten null Aussagen,
45 Prozent, gleichmaessig ueber alle Quellklassen. Der Grund war nicht leeres
Material, sondern die Buendelgroesse: Dieselbe Einheit, die in einem Buendel
von 25.000 Zeichen NICHTS lieferte, gab einzeln 22 Aussagen (gemessen an
`project-doc:Feingeister_Schul-KI-System/PROJEKT_FEINGEISTER.md#0`, 6.000
Zeichen). Das Modell steigt bei langen Buendeln aus und antwortet mit leeren
Claim-Listen.

Wer die Ursache behebt, muss die Opfer zurueckholen - sonst bleibt fast die
halbe Ernte fuer immer liegen, und zwar unsichtbar, weil sie im Buch als
erledigt steht.

Das Werkzeug ist bewusst allgemein und nicht auf diesen einen Vorfall
zugeschnitten: Massgeblich ist der Claim-Speicher, nicht ein Datum. Was dort
keine Aussage hat, war nicht wirklich bearbeitet.

    leere-einheiten-zuruecksetzen.py               # nur zeigen
    leere-einheiten-zuruecksetzen.py --wirklich    # schreiben

VORHER eine Momentaufnahme anlegen. Das Werkzeug tut es nicht selbst, weil es
sonst bei jedem Trockenlauf eine anlegte:

    cp state/dream/dream.db ~/.local/trash-snapshots/<datum>-dream.db
"""
from __future__ import annotations

import argparse
import collections
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gardener.dream import config as dcfg          # noqa: E402
from gardener.dream.ledger import Ledger           # noqa: E402

ERLEDIGT = ("extracted", "leer")


def ohne_aussage() -> list[dict]:
    """Einheiten in einem Endzustand, zu denen der Claim-Speicher nichts
    kennt. Er ist die Wahrheit: Das Buch sagt nur, dass etwas gelaufen ist,
    nicht dass es etwas gebracht hat."""
    ledger = Ledger(dcfg.LEDGER_DB, read_only=True)
    try:
        fertig = [r for z in ERLEDIGT for r in ledger.list_units(status=z)]
    finally:
        ledger.close()
    con = sqlite3.connect(f"file:{dcfg.DREAM_EXTRACT_CLAIMS_DB}?mode=ro", uri=True)
    try:
        mit = collections.Counter(q for (q,) in con.execute("SELECT source FROM claims"))
    finally:
        con.close()
    return [r for r in fertig
            if mit.get(f"{r['quell_id']}#{r['segment_index']}", 0) == 0]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--wirklich", action="store_true",
                   help="schreiben statt nur zeigen")
    args = p.parse_args()

    betroffen = ohne_aussage()
    if not betroffen:
        print("Keine Einheit ohne Aussage. Nichts zu tun.")
        return 0

    nach_klasse = collections.Counter(r["source_class"] for r in betroffen)
    nach_status = collections.Counter(r["status"] for r in betroffen)
    print(f"Einheiten in einem Endzustand ohne eine einzige Aussage: "
          f"{len(betroffen)}")
    print(f"  bisheriger Status: {dict(nach_status)}")
    print(f"  nach Quellklasse:  {dict(nach_klasse)}")
    if not args.wirklich:
        print("\nTrockenlauf. Mit --wirklich zuruecksetzen (vorher sichern).")
        return 0

    ledger = Ledger(dcfg.LEDGER_DB)
    jetzt = time.time()
    n = 0
    try:
        for r in betroffen:
            cur = ledger.conn.execute(
                "UPDATE units SET status='pending', fail_count=0, reason=NULL, "
                "updated=? WHERE quell_id=? AND segment_index=? AND "
                "content_hash=? AND status IN (?,?)",
                (jetzt, r["quell_id"], r["segment_index"], r["content_hash"],
                 *ERLEDIGT))
            n += cur.rowcount
        ledger.conn.commit()
    finally:
        ledger.close()
    print(f"\nAuf `pending` zurueckgesetzt: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
