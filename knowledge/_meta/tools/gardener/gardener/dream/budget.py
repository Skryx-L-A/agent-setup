"""Die Limit-Bremse: ein Konto in Punkten Wochenlimit, das den ganzen Lauf
umfasst, und ein Halt, der den Lauf fortsetzbar zurücklässt.

Anweisung des Nutzers vom 10.08.2026 lautet: 20 Punkte Wochenlimit als Budget,
fortführbarer Zustand. Dazu gilt seine Rangfolge vom selben Tag - Qualität wird
nie gegen Kosten eingetauscht. Daraus folgt, was diese Bremse ist und was
nicht:

- Sie ist ein **Budget-Stopp**. Sie hält an, wenn das Konto leer ist, und
  hinterlässt einen Zustand, in dem der nächste Lauf weitermacht.
- Sie ist **kein Qualitätsschalter**. Sie wechselt nie auf ein billigeres
  Modell, kürzt nie einen Prompt, lässt nie eine Einheit aus und beurteilt nie
  mehrere Aussagen zusammen, um Aufrufe zu sparen.

Drei Eigenschaften, an denen die Bremse hängt:

1. **Geprüft wird vor dem Aufruf.** Ein Lauf, der die Grenze erst hinterher
   bemerkt, hat sie schon gerissen. Geschätzt wird aus dem teuersten bisher
   gemessenen Aufruf desselben Schrittes, mit Aufschlag; vor dem ersten Aufruf
   aus den Messungen unter `messungen/`.
2. **Ein Wiederholungsversuch ist ein bezahlter Aufruf.** Deshalb sitzt die
   Buchung im Aufruf selbst und nicht in der Schleife darüber - genau der
   Fehler, den der Reviewer am 10.08.2026 für `--max-cloud` gefunden hat.
3. **Die konservativere Umrechnung gewinnt.** Siehe `config.py`: ein zu
   optimistisch geführtes Konto fällt erst auf, wenn es zu spät ist.

Dazu ein zweiter Wächter. Das Konto weiß nur, was DIESER Lauf verbraucht, und
nichts von der Arbeit, die daneben läuft. Vor jedem Aufruf wird deshalb der
tatsächliche Wochenstand aus der Datei der Statuszeile gelesen; treibt der
nächste Aufruf die Woche über die Marke, pausiert der Lauf. Fehlt die Datei
oder ist sie alt, läuft er mit dem eigenen Budget allein weiter und nennt diese
Blindheit im Bericht.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .. import config as gcfg
from . import config as dcfg

log = logging.getLogger("gardener.dream")


def default_state_path() -> Path:
    """Aufgeloest beim Aufruf, nie beim Import - derselbe Grund, aus dem
    `apply.snapshot_root_default()` eine Funktion ist. Ein Test, der das
    Zustandsverzeichnis umlenkt, muss in seinem eigenen tmp-Verzeichnis landen.

    Am 10.08.2026 gemessen, als es noch ein Modulwert war: die CLI-Tests des
    Pruefers schrieben ihre Konten in die echte `state/dream/budget.json`
    dieses Repos, weil sie `gcfg.STATE_DIR` umlenken und der eingefrorene Pfad
    davon nichts mitbekam.
    """
    return gcfg.STATE_DIR / "dream" / "budget.json"

STOP_BUDGET = "budget"
STOP_WEEKLY_GUARD = "wochenwaechter"


class BudgetExhausted(Exception):
    """Vor dem Aufruf geworfen, nie danach. Wer sie fängt, hält den Schritt an
    und lässt die angefangene Einheit offen - sie ist kein Fehler der Einheit,
    sondern das Ende des Budgets."""

    def __init__(self, step: str, needed: float, remaining: float,
                 reason: str = STOP_BUDGET, detail: str = ""):
        self.step, self.needed, self.remaining = step, needed, remaining
        self.reason, self.detail = reason, detail
        super().__init__(
            f"{reason}: {step} braucht {needed:.4f} Punkte, frei sind "
            f"{remaining:.4f}{(' - ' + detail) if detail else ''}")


def points_for(usd: float, model: str | None) -> float:
    """USD in Punkte Wochenlimit, immer über die teurere der beiden
    Rechnungen. Ein unbekanntes Modell bekommt den naiven Faktor, nie null."""
    naive = float(usd) / dcfg.LIMIT_NAIVE_USD_PER_POINT
    weighted = float(usd) * dcfg.LIMIT_POINTS_PER_USD_BY_MODEL.get(
        str(model or ""), 0.0)
    return max(naive, weighted)


@dataclass
class StepAccount:
    calls: int = 0
    usd: float = 0.0
    points: float = 0.0
    max_call_usd: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Account:
    limit_points: float
    spent_points: float = 0.0
    spent_usd: float = 0.0
    calls: int = 0
    steps: dict = field(default_factory=dict)
    stopped: str | None = None          # STOP_* oder None
    stop_detail: str | None = None

    @property
    def remaining_points(self) -> float:
        return max(0.0, self.limit_points - self.spent_points)

    def to_dict(self) -> dict:
        return {"limit_points": self.limit_points,
                "spent_points": round(self.spent_points, 6),
                "spent_usd": round(self.spent_usd, 6),
                "remaining_points": round(self.remaining_points, 6),
                "calls": self.calls,
                "steps": {k: v.to_dict() for k, v in sorted(self.steps.items())},
                "stopped": self.stopped, "stop_detail": self.stop_detail}


class Budget:
    """Ein Konto für den ganzen Lauf. `extract`, `reconcile` und `review`
    zahlen auf dasselbe ein."""

    def __init__(self, limit_points: float | None = None, *,
                 state_path: Path | None = None,
                 weekly_ceiling: float | None = None,
                 limits_file: Path | None = None,
                 now=time.time):
        self.account = Account(limit_points=float(
            dcfg.DREAM_BUDGET_WEEKLY_POINTS if limit_points is None
            else limit_points))
        self._state_path = Path(state_path) if state_path is not None else None
        self.weekly_ceiling = float(dcfg.DREAM_WEEKLY_PCT_CEILING
                                    if weekly_ceiling is None else weekly_ceiling)
        self.limits_file = Path(limits_file) if limits_file is not None \
            else dcfg.LIMITS_LATEST_FILE
        self._now = now
        self.blind_reason: str | None = None     # Wochenwächter ohne Sicht
        # Prüfen und Buchen sind zwei Schritte, und dazwischen passt ein
        # zweiter Aufruf. Genau deshalb war Nebenläufigkeit für die WOLKE
        # gesperrt: vier Aufrufe kamen durch `check` , wo einer hätte anhalten
        # müssen, weil keiner von ihnen den Verbrauch der anderen sah.
        #
        # Die Sperre allein reicht nicht - sie macht jeden Schritt für sich
        # atomar, aber nicht das PAAR aus Prüfen und Buchen. Deshalb dieselbe
        # Mechanik, die `wb-belegung` für Speicher benutzt: vor dem Aufruf wird
        # der geschätzte Betrag RESERVIERT und zählt sofort gegen das Konto,
        # nach dem Aufruf wird die Reservierung durch den echten Betrag
        # ersetzt. Ein gescheiterter Aufruf gibt sie frei - täte er das nicht,
        # bliebe Budget für immer gebunden, derselbe Fehler wie eine Belegung,
        # die niemand zurückgibt.
        self._sperre = threading.Lock()
        self._reserviert: dict[int, float] = {}
        self._reserviert_naechste = 0

    @property
    def state_path(self) -> Path:
        return self._state_path or default_state_path()

    # -- Buchführung -------------------------------------------------------

    def step(self, name: str) -> StepAccount:
        return self.account.steps.setdefault(name, StepAccount())

    def estimate_points(self, step: str, model: str | None) -> float:
        """Was der nächste Aufruf dieses Schrittes kosten dürfte. Der teuerste
        bisher gemessene Aufruf desselben Schrittes mit Aufschlag; vor dem
        ersten der gemessene Höchstwert aus `messungen/`. Der Mittelwert wäre
        die falsche Wahl - er unterschätzt genau den Aufruf, der die Grenze
        reißt."""
        seen = self.step(step).max_call_usd
        seed = float(dcfg.DREAM_BUDGET_FIRST_CALL_USD.get(step, 0.35))
        return points_for(max(seen, seed) * dcfg.DREAM_BUDGET_SAFETY, model)

    def record(self, step: str, model: str | None, usd: float) -> float:
        """Einen bezahlten Aufruf verbuchen. Gibt die Punkte zurück."""
        usd = float(usd or 0.0)
        points = points_for(usd, model)
        acc, s = self.account, self.step(step)
        acc.spent_usd += usd
        acc.spent_points += points
        acc.calls += 1
        s.calls += 1
        s.usd += usd
        s.points += points
        s.max_call_usd = max(s.max_call_usd, usd)
        return points

    # -- Der Wochenwächter -------------------------------------------------

    def weekly_pct(self) -> float | None:
        """Der tatsächliche Wochenstand aus der Datei der Statuszeile, oder
        None samt gesetztem `blind_reason`. Eine fehlende Messung ist kein
        Grund weiterzulaufen, ohne es zu sagen."""
        path = self.limits_file
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            self.blind_reason = f"{path} nicht lesbar ({e.__class__.__name__})"
            return None
        try:
            pct = float(raw["seven_day_pct"])
        except (KeyError, TypeError, ValueError):
            self.blind_reason = f"{path} ohne brauchbares Feld seven_day_pct"
            return None
        try:
            age_min = (self._now() - path.stat().st_mtime) / 60.0
        except OSError:
            age_min = 0.0
        if age_min > dcfg.LIMITS_LATEST_MAX_AGE_MINUTES:
            self.blind_reason = (f"{path} ist {age_min:.0f} Minuten alt, aelter "
                                 f"als {dcfg.LIMITS_LATEST_MAX_AGE_MINUTES}")
            return None
        self.blind_reason = None
        return pct

    # -- Die Bremse selbst -------------------------------------------------

    def check(self, step: str, model: str | None) -> None:
        """Vor jedem Aufruf. Wirft `BudgetExhausted`, wenn der geschätzte
        Aufruf das eigene Konto oder die Wochenmarke reißen würde.

        Ein LOKALER Aufruf wird nicht geprüft, weil er nichts kosten kann.
        Bis zum 16.08.2026 wurde er es doch, und das war ein echter Fehler
        (gefunden vom Prüferlauf `pruefer-kette`): `estimate_points` nimmt vor
        dem ersten Aufruf den gemessenen Wolken-Höchstwert als Startwert
        (`extract: 0.3464 USD`) und rechnet ihn gegen die Wochenmarke -
        auch dann, wenn der Aufruf an grug oder Qwen3.8 auf dieser Maschine
        geht. Gebucht wurde er anschließend korrekt mit null, weil
        `total_cost_usd` null ist; geprüft wurde er mit dem Preis von Sonnet.

        Die Folge stand für diese Nacht bereit: Bei einem Wochenstand von
        85 Prozent hätte die Bremse die GANZE lokale Extraktion angehalten -
        einen Schritt, der das Wochenlimit gar nicht anfassen kann. Der Lauf
        hätte mit Rückgabewert 6 und fortsetzbarem Zustand geendet und dabei
        nichts verrichtet.

        Erkannt wird die Wolke am Namen, wie in `config.reconcile_hard_cap`
        auch: alles, was mit `claude-` beginnt. Ein unbekannter Name gilt
        vorsichtshalber als Wolke - die Richtung des Irrtums ist hier
        entscheidend, und zu früh anzuhalten kostet einen Lauf, zu spät die
        Woche."""
        if not str(model or "").startswith("claude-"):
            return
        need = self.estimate_points(step, model)
        # Was andere Spuren gerade reserviert haben, ist so gut wie ausgegeben.
        # Ohne diesen Abzug sieht jede Spur das Konto als voll, und genau so
        # kamen vier Aufrufe durch, wo einer haette anhalten muessen.
        offen = sum(self._reserviert.values())
        free = max(0.0, self.account.remaining_points - offen)
        if need > free:
            self.account.stopped = STOP_BUDGET
            self.account.stop_detail = (
                f"{step}: geschaetzt {need:.4f} Punkte, frei {free:.4f}")
            raise BudgetExhausted(step, need, free, STOP_BUDGET)
        pct = self.weekly_pct()
        # Das eigene Verbrauchte wird DAZUGERECHNET, nicht als schon enthalten
        # angenommen. Die Datei schreibt die Statuszeile, und die laeuft nur in
        # einer interaktiven Sitzung - waehrend eines autonomen Traumlaufs
        # bewegt sie sich also gar nicht. Hat sie sich doch bewegt, zaehlt der
        # eigene Verbrauch doppelt; das haelt frueher an, und zu frueh
        # anzuhalten kostet einen Lauf, zu spaet die Woche.
        eigen = self.account.spent_points + offen
        if pct is not None and pct + eigen + need >= self.weekly_ceiling:
            self.account.stopped = STOP_WEEKLY_GUARD
            self.account.stop_detail = (
                f"Woche steht bei {pct:.1f} Prozent, dazu {eigen:.4f} aus "
                f"diesem Lauf und {need:.4f} fuer den naechsten Aufruf - das "
                f"erreicht die Marke {self.weekly_ceiling:.1f}")
            raise BudgetExhausted(step, need,
                                  self.weekly_ceiling - pct - eigen,
                                  STOP_WEEKLY_GUARD, self.account.stop_detail)

    def reserviere(self, step: str, model: str | None) -> int | None:
        """Prüfen und den geschätzten Betrag in einem Zug festhalten.

        Der Rückgabewert ist die Kennung der Reservierung, die `verbuche`
        wieder braucht, oder None für einen Aufruf, der nichts kosten kann.
        Beides zusammen unter EINER Sperre - getrennt geprüft und getrennt
        gebucht ist genau die Lücke, durch die nebenläufige Aufrufe das Konto
        überziehen."""
        if not str(model or "").startswith("claude-"):
            return None
        with self._sperre:
            self.check(step, model)
            kennung = self._reserviert_naechste
            self._reserviert_naechste += 1
            self._reserviert[kennung] = self.estimate_points(step, model)
            return kennung

    def verbuche(self, kennung: int | None, step: str,
                 model: str | None, usd: float | None) -> None:
        """Die Reservierung durch den echten Betrag ersetzen. `usd=None` heißt:
        der Aufruf ist gescheitert, es wird nur freigegeben."""
        with self._sperre:
            if kennung is not None:
                self._reserviert.pop(kennung, None)
            if usd is not None:
                self.record(step, model, usd)

    def guard(self, call, step: str, model: str | None):
        """Der Aufruf mit Konto. Reserviert davor, verbucht danach - und weil
        das hier sitzt und nicht in der Schleife darüber, zählt jeder
        Wiederholungsversuch mit.

        Das `finally` ist nicht Kosmetik: ohne es bliebe die Reservierung eines
        gescheiterten Aufrufs für immer stehen und würde das Konto Stück für
        Stück auffressen, bis der Lauf ohne Grund anhält. Dieselbe Klasse von
        Fehler wie eine Speicher-Belegung, die niemand zurückgibt."""
        def guarded(prompt: str) -> dict:
            kennung = self.reserviere(step, model)
            gebucht = False
            try:
                envelope = call(prompt)
                # `usage` kommt aus einer fremden Antwort: sie kann fehlen,
                # null sein oder kein Modell nennen. Der uebergebene Name ist
                # dann die Wahrheit - ein Absturz hier wuerde einen bezahlten
                # Lauf abbrechen, nachdem das Geld schon ausgegeben ist.
                usage = envelope.get("usage")
                seen = usage.get("model") if isinstance(usage, dict) else None
                self.verbuche(kennung, step, seen or model,
                              envelope.get("total_cost_usd") or 0.0)
                gebucht = True
                return envelope
            finally:
                if not gebucht:
                    self.verbuche(kennung, step, model, None)
        return guarded

    # -- Zustand und Bericht -----------------------------------------------

    def snapshot(self) -> dict:
        return {"konto": self.account.to_dict(),
                "wochenstand_prozent": self.weekly_pct(),
                "blind": self.blind_reason,
                "marke_prozent": self.weekly_ceiling,
                "anker": dcfg.LIMIT_ANCHOR}

    def save(self, run_id: str = "", dry_run: bool = False) -> Path:
        """Der Kontostand in die Zustandsdatei, in beiden Einheiten, plus die
        laufende Summe über alle Läufe. Maschinenlokal wie das Buch."""
        path = self.state_path
        previous: dict = {}
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {}
        gesamt = previous.get("gesamt") or {"usd": 0.0, "punkte": 0.0, "laeufe": 0}
        payload = {
            "letzter_lauf": dict(self.snapshot(), run_id=run_id,
                                 beendet=dt.datetime.now().isoformat(
                                     timespec="seconds")),
            "gesamt": {"usd": round(float(gesamt.get("usd") or 0.0)
                                    + self.account.spent_usd, 6),
                       "punkte": round(float(gesamt.get("punkte") or 0.0)
                                       + self.account.spent_points, 6),
                       "laeufe": int(gesamt.get("laeufe") or 0) + 1},
        }
        if not dry_run:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2,
                                       sort_keys=True) + "\n", encoding="utf-8")
        return path

    def report_lines(self) -> list[str]:
        acc = self.account
        lines = ["", f"Budget: {acc.spent_points:.4f} von {acc.limit_points:.4f} "
                     f"Punkten Wochenlimit verbraucht "
                     f"({acc.spent_usd:.4f} USD, {acc.calls} Aufrufe)"]
        lines += [f"  {name:10s} {s.calls:4d} Aufrufe  {s.usd:8.4f} USD  "
                  f"{s.points:8.4f} Punkte" for name, s in sorted(acc.steps.items())]
        pct = self.weekly_pct()
        if pct is not None:
            lines.append(f"  Wochenstand laut Statuszeile: {pct:.1f} Prozent "
                         f"(Marke {self.weekly_ceiling:.1f})")
        else:
            lines.append(f"  WOCHENWAECHTER BLIND: {self.blind_reason} - der "
                         f"Lauf faehrt mit dem eigenen Budget allein weiter")
        if acc.stopped:
            lines += ["", f"ANGEHALTEN ({acc.stopped}): {acc.stop_detail}",
                      "Nichts ist verloren: offene Einheiten stehen weiter im "
                      "Buch, Unbeurteiltes bekommt keinen Issue-Eintrag, der "
                      "naechste Lauf macht dort weiter."]
        return lines
