"""Self-declared canonical pages: ageing detector (b18-doctor-kanon, 30.09.2026).

Restanalyse `eval/rest/BEFUNDE.md` Abschnitt 2 (M2, 8 von 74 Top-1-Fehlern): kanonische
Seiten tragen keinen Tagesstand, Veraltung ist so nicht erkennbar. "Kanonisch" heisst hier
textbasiert: die Notiz nennt sich selbst "kanonische Seite/Antwortseite/Quelle/Uebersicht"
(dieselbe Erkennung wie `eval/rest/kandidaten.py`, dort 42 Treffer im Hauptvault am 30.09.).
Das ist eine andere Definition als `gardener.lint.ist_kanonisch` (typbasiert: `type` in
system/decision/pitfall/term oder KERN.md/STATUS.md, fuer den Pruefstatus) und zaehlt nicht
dasselbe.

Veraltet heisst: eine Entscheidung oder Sitzung mit neuerem Datum verlinkt die Seite (Wikilink
auf Titel/Stem/Alias), UND die Seite selbst traegt kein gleich altes oder neueres Tagesdatum
(juengstes von `stand:` mit Tag, `verified:` und Abschnitt "Aktueller Zustand (Stand ...)").
Die blosse Nennung des Titels reicht nicht: am 30.09. waren so alle 11 Meldungen Fehlalarme
(Glossarbegriffe wie "Worker" stehen in fast jeder Sitzung). Seiten ganz ohne Tagesdatum zaehlen separat als "Datum unbekannt", nie als
veraltet (so vom Restbefund verlangt: es ist eine eigene Zaehlung, kein Alarm)."""
from __future__ import annotations

import datetime as dt
import re

KANON_RE = re.compile(r"kanonische (Seite|Antwortseite|Quelle|Übersicht)", re.I)
_SCAN_LINES = 40

_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_AKTUELL_RE = re.compile(
    r"Aktueller Zustand\s*\(Stand\s+(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\.(\d{1,2})\.(\d{4}))\)")

DOC_TYPEN = ("decision", "session")


def _skip(note) -> bool:
    """Wie `kandidaten.py`: rohe Quellen und abgeleitete Seiten sind keine Kandidaten."""
    if note.rel.startswith("00-sources/"):
        return True
    return str(note.fm.get("class") or "").strip() in ("source", "derived")


def is_canonical(note) -> bool:
    """True, wenn die Notiz sich in den ersten `_SCAN_LINES` Zeilen selbst kanonisch nennt."""
    if note.ntype == "session" or _skip(note):
        return False
    for line in note.text.splitlines()[:_SCAN_LINES]:
        if KANON_RE.search(line):
            return True
    return False


def _iso(value) -> dt.date | None:
    m = _ISO_DATE.match(str(value or "").strip())
    return dt.date(int(m[1]), int(m[2]), int(m[3])) if m else None


def page_datum(note) -> dt.date | None:
    """Tagesgenauer Stand der kanonischen Seite selbst: das juengste von `stand:` mit Tag,
    `verified:` (Pruefung gegen Quellen) und dem Abschnitt "Aktueller Zustand (Stand JJJJ-MM-TT)"
    bzw. "(Stand TT.MM.JJJJ)"."""
    daten = [d for d in (_iso(note.fm.get("stand")), _iso(note.fm.get("verified"))) if d is not None]
    m = _AKTUELL_RE.search(note.text)
    if m:
        if m.group(1):
            daten.append(dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
        else:
            daten.append(dt.date(int(m.group(6)), int(m.group(5)), int(m.group(4))))
    return max(daten) if daten else None


def _doc_datum(note) -> dt.date | None:
    """Datum einer Entscheidung/Sitzung: `decided`/`created`/`stand` mit Tag, sonst das
    Dateidatum (mtime als Naeherung fuer "Dateidatum aus Git"; wie `doctor._kern_datum`
    faellt auch hier auf die Dateizeit zurueck, wenn das Frontmatter keinen Tag traegt)."""
    for feld in ("decided", "created", "stand"):
        d = _iso(note.fm.get(feld))
        if d is not None:
            return d
    try:
        return dt.date.fromtimestamp(note.path.stat().st_mtime)
    except OSError:
        return None


def scan(notes: list) -> dict:
    """Bestand der selbst-kanonischen Seiten: Anzahl, veraltete (mit dem je aeltesten
    ausloesenden neueren Dokument), Anzahl ohne Tagesdatum."""
    kanon = [n for n in notes if is_canonical(n)]
    docs = [n for n in notes if n.ntype in DOC_TYPEN]
    doc_data = [(d, _doc_datum(d)) for d in docs]
    unbekannt = 0
    veraltet = []
    for c in kanon:
        stand = page_datum(c)
        if stand is None:
            unbekannt += 1
            continue
        beste = None  # (datum, dokument)
        for d, d_datum in doc_data:
            if d.rel == c.rel or d_datum is None or d_datum <= stand:
                continue
            if not (d.links & c.keys):
                continue
            if beste is None or d_datum > beste[0]:
                beste = (d_datum, d)
        if beste is not None:
            veraltet.append({"pfad": c.rel, "stand": stand.isoformat(),
                             "dokument": beste[1].rel, "datum": beste[0].isoformat()})
    veraltet.sort(key=lambda v: (v["datum"], v["pfad"]), reverse=True)
    return {"kanonisch": len(kanon), "unbekannt": unbekannt, "veraltet": veraltet}
