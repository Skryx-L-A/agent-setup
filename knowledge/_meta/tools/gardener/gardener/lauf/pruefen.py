"""Stage ``pruefen`` of `brain run`: quality check of proposals before they are written (p3).

Between ``abgleichen`` and ``schreiben``.  Every package of the proposal
types (entscheidung, fehler, lehre) in ``abgeglichen`` -- and, as backlog,
in ``vorgeschlagen`` -- gets exactly one check, booked in
``lauf_pakete.pruefung`` (JSON).  In this order, the first hit decides:

1. Closed project (``geschlossen:<projekt>`` in ``_meta/projekte.tsv``):
   ``verworfen-auto``, grund ``projekt-geschlossen``.
2. Foreign text (``fremdtext``): all evidence sentences are harness, job
   template or skill text, or all are ``werkzeug:`` lines: ``verworfen-auto``,
   grund ``fremdtext:<kind>`` / ``nur-werkzeugzeilen``.  Deterministic.
   ``BRAIN_FREMDTEXT=0`` switches it off.
3. Local decider (Jev style, one prefill token, logprobs; stage ``pruefen``
   in ``engines.yaml``): score = P(``dauerhaft``) of the question
   ``frage_art``; below the threshold the package is ``verworfen-auto`` with
   its score.  Since d3 the weights file may carry ``schwellen_je_art`` — a
   working point per package type (fehler/lehre fitted on their replay
   utility, more generous than entscheidung); ``stufe_cfg.schwelle`` stays the
   fallback for types without one.  ``BRAIN_PRUEFEN=0`` switches the model
   part off.

A rejected package is never deleted: it stays in the book with its reason
and score (``brain run status`` counts it); ``schreiben`` shows only kept
packages.  Nothing here writes into the vault.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable

from ..engines import EngineError, Question
from ..saetze import zerlege
from . import buch as b
from . import fremdtext
from .buch import Buch
from .projektwahl import PROJEKTE
from .quellen import Leser, einheit_text, lade_projekte
from .stufen import Fortschritt, StufenErgebnis, _klassen, _noop, fremde_ids, fremdtext_aktiv

GESCHLOSSEN = "projekt-geschlossen"
NUR_WERKZEUG = "nur-werkzeugzeilen"
SCHWELLE_STANDARD = 0.5

ZITAT_MAX = 600
UMFELD_MAX = 1500

FRAGE_ART = "Was ist dieser Vorschlag für das Projekt {projekt}?"
OPTIONEN_ART = (
    ("dauerhaft", "dauerhaftes Projektwissen: eine heute gültige Entscheidung, Falle oder Lehre, "
                  "die künftige Arbeit an diesem Projekt verändert"),
    ("einzelfall", "Zwischenstand oder Einzelfall: einmaliger Fehler an einer Datei/Zeile, Laufstatus, "
                   "Arbeitsauftrag, Zwischenergebnis"),
    ("fremd", "gehört nicht zu diesem Projekt: allgemeine Werkzeug-, Harness- oder Arbeitsregel "
              "oder ein anderes Projekt"),
    ("trivial", "trivial oder selbstverständlich: Code-Detail, Umbenennung, Tippfehler, Pfad"),
    ("unbelegt", "Empfehlung, offene Frage oder Vermutung, nicht entschieden oder nicht belegt"),
)


def frage_art(projekt: str) -> Question:
    return Question(FRAGE_ART.format(projekt=projekt), "choice",
                    [f"{name}: {text}" for name, text in OPTIONEN_ART], mit_unklar=False)


FRAGE_JANEIN = ("Gehört diese Aussage als geltende Regel in das Projektwissen von {projekt}, "
                "das künftige Sitzungen vor der Arbeit lesen?")


def frage_janein(projekt: str) -> Question:
    return Question(FRAGE_JANEIN.format(projekt=projekt), "noul")


def umfeld_text(saetze, belege, *, n: int = 3) -> str | None:
    """``[S12] rolle: text`` lines of the evidence sentences and ``n`` on each side."""
    saetze = list(saetze)
    pos = {s.id: i for i, s in enumerate(saetze)}
    idx = sorted(pos[b] for b in belege if b in pos)
    if not idx:
        return None
    lo, hi = max(0, idx[0] - n), min(len(saetze), idx[-1] + n + 1)
    out = []
    for s in saetze[lo:hi]:
        mark = ">" if s.id in belege else " "
        rolle = f"{s.rolle}: " if s.rolle else ""
        out.append(f"{mark}[{s.id}] {rolle}{_flach(s.text, 300)}")
    return "\n".join(out)


def _flach(text: str | None, limit: int) -> str:
    body = " ".join(str(text or "").split())
    return body if len(body) <= limit else body[:limit - 1] + "…"


def zustand(row, *, umfeld: str | None = None) -> str:
    """The decider's view of one package: project, type, date, statement,
    counter-measure, quote and (optionally) the sentences around it."""
    projekt = row["projekt"] or "?"
    kurz = PROJEKTE.get(projekt, projekt)
    lines = [f"Projekt: {projekt} ({kurz})", f"Art: {row['typ']}",
             f"Datum der Quelle: {row['datum'] or '?'}",
             f"Aussage: {_flach(row['aussage'], 600)}"]
    if (row["gegenmittel"] or "").strip():
        lines.append(f"Gegenmittel: {_flach(row['gegenmittel'], 400)}")
    lines.append(f"Beleg: {_flach(row['zitat'], ZITAT_MAX)}")
    if umfeld:
        lines.append(f"Umfeld des Belegs:\n{umfeld[:UMFELD_MAX]}")
    return "\n".join(lines)


# v2: five independent yes/no questions over a state that also shows the most
# similar existing entries (KERN, FALLEN, decision note, house rules)
FRAGEN_V2 = (
    ("dauerhaft", "Ist die Aussage eine dauerhaft gültige Regel, Entscheidung oder Falle, und nicht ein "
                  "einmaliger Zwischenstand, Laufstatus, Arbeitsauftrag oder Einzelbug?"),
    ("projekt", "Betrifft die Aussage speziell das Projekt {projekt}, und nicht allgemeine Werkzeug-, "
                "Harness- oder Arbeitsregeln oder ein anderes Projekt?"),
    ("neu", "Ist die Aussage neu, also nicht schon sinngemäß in den vorhandenen Einträgen oben enthalten?"),
    ("nichttrivial", "Würde jemand, der am Projekt arbeitet, ohne diesen Hinweis wahrscheinlich einen "
                     "Fehler machen oder Zeit verlieren?"),
    ("belegt", "Ist die Aussage tatsächlich entschieden oder beobachtet worden, und nicht nur eine "
               "Empfehlung, Frage oder Vermutung?"),
)
AEHNLICHE_MAX = 6


def fragen_v2(projekt: str) -> list[Question]:
    return [Question(text.format(projekt=projekt), "noul", id=name) for name, text in FRAGEN_V2]


def zustand_v2(row, *, umfeld: str | None = None, aehnliche: list[str] | None = None) -> str:
    base = zustand(row, umfeld=umfeld)
    if aehnliche:
        lines = "\n".join(f"- {_flach(t, 240)}" for t in aehnliche[:AEHNLICHE_MAX])
        base += f"\nVorhandene Einträge (Projektwissen und Hausregeln, die ähnlichsten):\n{lines}"
    else:
        base += "\nVorhandene Einträge: keine ähnlichen"
    return base


def _zeilen_md(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(("- ", "* ")) and len(line) > 20:
            out.append(line[2:].strip())
        elif line.startswith("|") and not line.startswith("|---") and line.count("|") >= 4:
            cells = [c.strip() for c in line.strip("|").split("|")]
            longest = max(cells, key=len)
            if len(longest) > 25 and longest not in ("Aussage",):
                out.append(longest)
    return out


def vorhandene_eintraege(vault: Path, projekt: str, hausregeln: list[Path] | None = None) -> list[str]:
    """Existing statements the decider compares with: KERN.md lines, FALLEN
    entries in force, rows of the decision note (outside generated blocks),
    and the house rules (``hausregeln``: Markdown files, bullet lines)."""
    from .. import blocks as blocks_mod
    from .schreiben import _tripwire_loader
    base = Path(vault) / "20-projects" / projekt
    out: list[str] = []
    kern = base / "KERN.md"
    if kern.is_file():
        out += _zeilen_md(kern.read_text(encoding="utf-8", errors="replace"))
    ent = base / "ENTSCHEIDUNGEN-UND-FALLEN.md"
    if ent.is_file():
        text = ent.read_text(encoding="utf-8", errors="replace")
        text = blocks_mod.strip_blocks(text, "<!-- brain:vorschlaege:start -->", "<!-- brain:vorschlaege:end -->")
        out += _zeilen_md(text)
    fallen = base / "FALLEN.yaml"
    loader = _tripwire_loader()
    if fallen.is_file() and loader is not None:
        try:
            for e in (loader(fallen.read_text(encoding="utf-8")) or {}).get("fallen") or []:
                if isinstance(e, dict) and e.get("status") == "gilt" and e.get("falle"):
                    out.append(f"{e['falle']} -> {e.get('gegenmittel') or ''}".strip(" ->"))
        except Exception:          # noqa: BLE001 - an unreadable file adds nothing
            pass
    for path in hausregeln or []:
        try:
            out += [f"Hausregel: {t}" for t in _zeilen_md(Path(path).read_text(encoding="utf-8"))]
        except OSError:
            continue
    seen, uniq = set(), []
    for t in out:
        key = " ".join(t.split()).casefold()
        if key not in seen:
            seen.add(key)
            uniq.append(" ".join(t.split()))
    return uniq


def hausregel_dateien() -> list[Path]:
    """The workbench rules on this machine (``~/.claude/AGENTS.md``, until 2026-09-25
    ``CLAUDE.md``, plus ``regeln/*.md``); may be empty. Both start files count if both
    exist; the same text twice only repeats corpus entries, which ``Aehnlich`` dedups."""
    root = Path.home() / ".claude"
    files = [root / "AGENTS.md", root / "CLAUDE.md"] + sorted((root / "regeln").glob("*.md"))
    return [f for f in files if f.is_file()]


class Aehnlich:
    """Most similar existing entries per package (embedding cosine), corpus
    embedded once per project."""

    def __init__(self, vault: Path, einbetten, *, hausregeln: list[Path] | None = None):
        self.vault = Path(vault)
        self.einbetten = einbetten
        self.hausregeln = hausregeln if hausregeln is not None else hausregel_dateien()
        self._korpus: dict[str, tuple[list[str], list[list[float]]]] = {}

    @staticmethod
    def _norm(v: list[float]) -> list[float]:
        n = sum(x * x for x in v) ** 0.5 or 1.0
        return [x / n for x in v]

    def korpus(self, projekt: str) -> tuple[list[str], list[list[float]]]:
        if projekt not in self._korpus:
            texte = vorhandene_eintraege(self.vault, projekt, self.hausregeln)
            vecs = []
            for i in range(0, len(texte), 64):
                vecs += [self._norm(v) for v in self.einbetten(texte[i:i + 64])]
            self._korpus[projekt] = (texte, vecs)
        return self._korpus[projekt]

    def fuer(self, row, k: int = AEHNLICHE_MAX) -> tuple[list[str], float]:
        """(the ``k`` most similar entries, highest cosine)."""
        texte, vecs = self.korpus(row["projekt"] or "?")
        if not texte:
            return [], 0.0
        q = self._norm(self.einbetten([row["aussage"]])[0])
        scored = sorted(((sum(a * b for a, b in zip(q, v)), t) for t, v in zip(texte, vecs)), reverse=True)
        return [t for _s, t in scored[:k]], scored[0][0]


# v3: the project's KERN.md in front of the package (prefix cache per project),
# one choice question with "already known / superseded" as its own option
KERN_ZEICHEN = 4000
FRAGE_V3 = "Was ist der Vorschlag unten für das Projektwissen von {projekt}?"
OPTIONEN_V3 = (
    ("neu", "neues, heute gültiges Projektwissen (Entscheidung, Falle oder Lehre), das noch nicht im "
            "Projektwissen steht und künftige Arbeit an diesem Projekt verändert"),
    ("bekannt", "steht sinngemäß schon im Projektwissen oder ist durch dessen heutigen Stand überholt"),
    ("einzelfall", "Zwischenstand oder Einzelfall: einmaliger Fehler an einer Datei/Zeile, Laufstatus, "
                   "Arbeitsauftrag, Zwischenergebnis"),
    ("fremd", "gehört nicht zu diesem Projekt: allgemeine Werkzeug-, Harness- oder Arbeitsregel "
              "oder ein anderes Projekt"),
    ("trivial", "trivial oder selbstverständlich: Code-Detail, Umbenennung, Tippfehler, Pfad"),
    ("unbelegt", "Empfehlung, offene Frage oder Vermutung, nicht entschieden oder nicht belegt"),
)


def frage_v3(projekt: str) -> Question:
    return Question(FRAGE_V3.format(projekt=projekt), "choice",
                    [f"{name}: {text}" for name, text in OPTIONEN_V3], mit_unklar=False)


def kern_text(vault: Path, projekt: str) -> str:
    """KERN.md of the project without frontmatter (empty when missing)."""
    path = Path(vault) / "20-projects" / projekt / "KERN.md"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:]
    return text.strip()[:KERN_ZEICHEN]


def zustand_v3(row, kern: str, *, umfeld: str | None = None) -> str:
    projekt = row["projekt"] or "?"
    return (f"Projektwissen von {projekt} (KERN.md, heutiger Stand):\n{kern or '(leer)'}\n\n"
            f"Vorschlag:\n{zustand(row, umfeld=umfeld)}")


# ---------------------------------------------------------------------------
# the decider of the stage
# ---------------------------------------------------------------------------

GEWICHTE_DATEI = Path(__file__).with_name("pruefen-gewichte.json")


def _logit(p: float) -> float:
    import math
    p = min(max(p, 1e-6), 1 - 1e-6)          # as in the fit (eval auswerten.py)
    return math.log(p / (1 - p))


def merkmalswerte(gewichte: dict, raw: float, meta: dict[str, str | None]) -> list[float]:
    """Feature vector of the check's regression (one ``logit`` plus one-hot
    ``key=value`` entries).  Module level so ``nachpruefen`` recomputes scores
    from the booked raw value with exactly the stage's math, no model call."""
    out = []
    for name in gewichte["merkmale"]:
        if name == "logit":
            out.append(_logit(raw))
        else:
            key, value = name.split("=", 1)
            out.append(1.0 if (meta.get(key) or "?") == value else 0.0)
    return out


def regressions_score(gewichte: dict, werte: list[float]) -> float:
    import math
    g = gewichte
    z = g["b"] + sum(w * (v - m) / s for w, v, m, s in zip(g["w"], werte, g["mu"], g["sd"]))
    return 1 / (1 + math.exp(-z))


class Entscheider:
    """Model part of the check.  ``frage`` ``art`` (package only) or ``v3``
    (the project's KERN.md in front); raw score = P(first option).  With
    ``gewichte`` (logistic regression fitted on the dev half, JSON) the score
    is the regression over [logit(raw), one-hot source class / type /
    project]; otherwise the raw score."""

    def __init__(self, decide, modell: str | None, vault: Path, *, frage: str = "art",
                 gewichte: dict | None = None):
        self.decide = decide
        self.modell = modell
        self.vault = Path(vault)
        self.frage = frage
        self.gewichte = gewichte
        self.schwellen_je_art: dict[str, float] = {}
        if isinstance(gewichte, dict):
            for typ, wert in (gewichte.get("schwellen_je_art") or {}).items():
                self.schwellen_je_art[str(typ)] = float(wert)
        self._kern: dict[str, str] = {}

    @classmethod
    def aus_konfiguration(cls, decide, modell, vault: Path, cfg: dict) -> "Entscheider":
        """Weights file: ``BRAIN_PRUEFEN_GEWICHTE`` (absolute path, e.g. the frozen
        p3 baseline ``_meta/tools/eval/v2-dream/d3/alt-gewichte.json`` for a
        rollback of d3 — a file without ``schwellen_je_art`` also restores the
        single fallback threshold) overrides ``cfg['gewichte']``."""
        gewichte = None
        name = os.environ.get("BRAIN_PRUEFEN_GEWICHTE") or cfg.get("gewichte")
        if name:
            path = Path(name) if Path(name).is_absolute() else Path(__file__).with_name(name)
            gewichte = json.loads(path.read_text(encoding="utf-8"))
        return cls(decide, modell, vault, frage=cfg.get("frage", "art"), gewichte=gewichte)

    def roh(self, row, saetze) -> float:
        umfeld = umfeld_text(saetze, json.loads(row["belege"] or "[]")) if saetze else None
        projekt = row["projekt"] or "?"
        if self.frage == "v3":
            if projekt not in self._kern:
                self._kern[projekt] = kern_text(self.vault, projekt)
            state, q = zustand_v3(row, self._kern[projekt], umfeld=umfeld), frage_v3(projekt)
        else:
            state, q = zustand(row, umfeld=umfeld), frage_art(projekt)
        answer = self.decide(state, [q])[0]
        return float(answer.probabilities[q.options[0]])

    def merkmale(self, raw: float, meta: dict[str, str | None]) -> list[float]:
        return merkmalswerte(self.gewichte, raw, meta)

    def score(self, row, saetze, source_class: str | None) -> tuple[float, float]:
        """(score, raw model probability)."""
        raw = self.roh(row, saetze)
        if not self.gewichte:
            return raw, raw
        import math
        werte = self.merkmale(raw, {"source_class": source_class, "typ": row["typ"],
                                    "projekt": row["projekt"]})
        return regressions_score(self.gewichte, werte), raw

    def schwelle_fuer(self, typ: str | None, standard: float = SCHWELLE_STANDARD) -> float:
        """d3: working point per package type (``schwellen_je_art`` in the
        weights file, fitted separately for fehler/lehre because their replay
        utility differs); ``standard`` (``stufe_cfg.schwelle``) is the fallback."""
        return self.schwellen_je_art.get(typ or "", standard)


def einbett_text(row) -> str:
    """Text embedded for the logistic-regression candidate."""
    return (f"{row['typ']} | {row['projekt'] or '?'} | {_flach(row['aussage'], 600)} | "
            f"{_flach(row['gegenmittel'], 400)}")


# ---------------------------------------------------------------------------
# the stage
# ---------------------------------------------------------------------------

def aktiv() -> bool:
    """``BRAIN_PRUEFEN=0`` switches the model part of the check off."""
    return os.environ.get("BRAIN_PRUEFEN", "1").strip() != "0"


def lade_geschlossene(vault: Path) -> frozenset[str]:
    """Projects marked ``geschlossen:<projekt>`` in ``_meta/projekte.tsv``."""
    return frozenset(key.split(":", 1)[1] for key in lade_projekte(vault)
                     if key.startswith("geschlossen:"))


class _Einheit:
    """Unit view of a joined ``zu_pruefen`` row (``e_*`` columns)."""

    def __init__(self, row):
        self._d = {"source_class": row["e_source_class"], "path": row["e_path"],
                   "char_start": row["e_char_start"], "char_end": row["e_char_end"],
                   "content_hash": row["e_content_hash"], "maschine": row["e_maschine"]}

    def __getitem__(self, key):
        return self._d[key]


def deterministisch(row, leser: Leser, geschlossen: frozenset[str]) -> tuple[str | None, list | None]:
    """(reason to reject or None, the unit's sentences or None)."""
    if row["projekt"] in geschlossen:
        return GESCHLOSSEN, None
    einheit = _Einheit(row)
    text = einheit_text(einheit, leser)
    if text is None:
        return (fremdtext.zitat_grund(row["zitat"]) if fremdtext_aktiv() else None), None
    saetze = zerlege(text)
    if not fremdtext_aktiv():
        return None, saetze
    belege = json.loads(row["belege"] or "[]")
    grund = fremdtext.paket_grund(belege, fremde_ids(einheit, saetze, leser))
    if grund is None:
        rollen = {s.id: s.rolle for s in saetze}
        if belege and all(rollen.get(x) == "werkzeug" for x in belege):
            grund = NUR_WERKZEUG
    return grund, saetze


def pruefen(buch: Buch, *, motoren, leser: Leser, vault: Path, lauf_id: str | None,
            limit: int | None = None, stop: Callable[[], bool] = lambda: False,
            fortschritt: Fortschritt = _noop, klassen=None,
            projekt: str | None = None) -> StufenErgebnis:
    result = StufenErgebnis("pruefen")
    rows = buch.zu_pruefen(classes=_klassen(klassen), projekt=projekt, limit=limit)
    if not rows:
        return result
    geschlossen = lade_geschlossene(vault)
    entscheider = None
    schwelle = SCHWELLE_STANDARD
    if aktiv():
        stufe_cfg = getattr(motoren, "stufen", {}).get("pruefen") if motoren is not None else None
        if stufe_cfg is None:
            result.fehler.append("engines.yaml: Stufe pruefen fehlt")
            result.uebersprungen = "Motor nicht erreichbar"
        elif motoren.warte_auf("pruefen", stop=stop):
            decide, modell = motoren.decider("pruefen")
            entscheider = Entscheider.aus_konfiguration(decide, modell, vault, stufe_cfg)
            schwelle = float(stufe_cfg.get("schwelle", SCHWELLE_STANDARD))
        else:
            base = motoren._base("pruefen")
            result.fehler.append(f"Motor nicht erreichbar: {base.base_url if base else 'pruefen'} (pruefen)")
            result.uebersprungen = "Motor nicht erreichbar"
    for n, row in enumerate(rows, 1):
        if stop():
            result.abgebrochen = True
            break
        started = time.perf_counter()
        grund, saetze = deterministisch(row, leser, geschlossen)
        if grund is not None:
            buch.pruefung_merken(row["paket_id"], {"grund": grund, "lauf_id": lauf_id}, verwerfen=True)
            result.zaehle(grund.split(":", 1)[0])
        elif not aktiv():
            buch.pruefung_merken(row["paket_id"], {"grund": None, "modell": None, "lauf_id": lauf_id},
                                 verwerfen=False)
            result.zaehle("behalten-ohne-modell")
        elif entscheider is None:
            continue                    # the model part waits for the next run
        else:
            try:
                score, roh = entscheider.score(row, saetze, row["e_source_class"])
            except EngineError as exc:
                buch.conn.rollback()
                result.fehlschlaege += 1
                result.fehler.append(f"{row['paket_id']}: {type(exc).__name__}: {exc}")
                result.uebersprungen = "Motor nicht erreichbar"
                result.abgebrochen = True
                break
            verwerfen = score < entscheider.schwelle_fuer(row["typ"], schwelle)
            buch.pruefung_merken(row["paket_id"], {
                "grund": "entscheider" if verwerfen else None, "score": round(score, 4),
                "roh": round(roh, 6), "schwelle": round(entscheider.schwelle_fuer(row["typ"], schwelle), 6),
                "modell": entscheider.modell,
                "frage": entscheider.frage, "gewichte": bool(entscheider.gewichte),
                "lauf_id": lauf_id}, verwerfen=verwerfen)
            result.zaehle("entscheider-verworfen" if verwerfen else "behalten")
        buch.commit()
        result.bearbeitet += 1
        result.sekunden.append(time.perf_counter() - started)
        result.einheiten.append(row["paket_id"])
        fortschritt("pruefen", n, len(rows))
    return result
