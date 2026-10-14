"""Output of `brain run`: readable lines, or ``--json`` event lines.

JSON mode writes exactly one JSON object per line to stdout and nothing
else (the gardener's own prints go to stderr).  Schema, version 1 (Brain.app
and the coming app read it; ``tests/test_lauf.py`` pins it)::

    every event   {"v": 1, "ereignis": str, "lauf_id": str, "zeit": ISO-8601}
    start         + profil: str, stufen: [str], dry_run: bool, mit_modell: bool
    stufe         + stufe: str, status: "start"|"ende"|"uebersprungen",
                    ergebnis: object (at "ende"), grund: str (at "uebersprungen")
    fortschritt   + stufe: str, fertig: int, gesamt: int, eta_s: number|null
    fehler        + stufe: str|null, meldung: str
    abschluss     + status: "ok"|"teilweise"|"abgebrochen"|"gesperrt"|"fehler",
                    exit_code: int, profil: str, stufen: [str], dry_run: bool,
                    dauer_s: number, einheiten: {status: n}, pakete: {status: n},
                    stufen_ergebnisse: [object], schreiben: object|null,
                    bericht: str|null, commits: [object]
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from typing import Any, TextIO

SCHEMA_VERSION = 1
EREIGNISSE = ("start", "stufe", "fortschritt", "fehler", "abschluss")


class Ausgabe:
    def __init__(self, lauf_id: str, *, json_mode: bool = False, stream: TextIO | None = None,
                 takt: float = 1.0):
        self.lauf_id = lauf_id
        self.json_mode = json_mode
        self.stream = stream or sys.stdout
        self.takt = takt
        self._stufe_start: dict[str, float] = {}
        self._letzte: dict[str, float] = {}

    def _emit(self, ereignis: str, **felder: Any) -> None:
        assert ereignis in EREIGNISSE, ereignis
        if not self.json_mode:
            return
        record = {"v": SCHEMA_VERSION, "ereignis": ereignis, "lauf_id": self.lauf_id,
                  "zeit": dt.datetime.now().isoformat(timespec="seconds"), **felder}
        self.stream.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        self.stream.flush()

    def text(self, line: str = "") -> None:
        if not self.json_mode:
            self.stream.write(line + "\n")
            self.stream.flush()

    def start(self, **felder: Any) -> None:
        self._emit("start", **felder)
        self.text(f"brain run {self.lauf_id}: Profil {felder.get('profil')}, Stufen "
                  f"{', '.join(felder.get('stufen', []))}"
                  + (" (Trockenlauf" + (", mit Modell" if felder.get("mit_modell") else "") + ")"
                     if felder.get("dry_run") else ""))

    def stufe_start(self, stufe: str) -> None:
        self._stufe_start[stufe] = time.monotonic()
        self._emit("stufe", stufe=stufe, status="start")
        self.text(f"- {stufe} ...")

    def stufe_ende(self, stufe: str, ergebnis: dict[str, Any]) -> None:
        self._emit("stufe", stufe=stufe, status="ende", ergebnis=ergebnis)
        took = time.monotonic() - self._stufe_start.get(stufe, time.monotonic())
        brief = ", ".join(f"{k} {v}" for k, v in (ergebnis.get("zustaende") or {}).items())
        self.text(f"  {stufe}: {ergebnis.get('bearbeitet', '')} bearbeitet"
                  + (f" ({brief})" if brief else "") + f", {took:.1f} s")

    def stufe_uebersprungen(self, stufe: str, grund: str) -> None:
        self._emit("stufe", stufe=stufe, status="uebersprungen", grund=grund)
        self.text(f"  {stufe}: uebersprungen ({grund})")

    def fortschritt(self, stufe: str, fertig: int, gesamt: int) -> None:
        now = time.monotonic()
        if fertig < gesamt and now - self._letzte.get(stufe, 0.0) < self.takt:
            return
        self._letzte[stufe] = now
        elapsed = now - self._stufe_start.get(stufe, now)
        eta = round(elapsed / fertig * (gesamt - fertig), 1) if fertig else None
        self._emit("fortschritt", stufe=stufe, fertig=fertig, gesamt=gesamt, eta_s=eta)

    def fehler(self, stufe: str | None, meldung: str) -> None:
        self._emit("fehler", stufe=stufe, meldung=meldung)
        self.text(f"  FEHLER{f' {stufe}' if stufe else ''}: {meldung}")

    def abschluss(self, **felder: Any) -> None:
        self._emit("abschluss", **felder)
