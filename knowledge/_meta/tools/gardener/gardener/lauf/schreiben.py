"""B5: `brain run` writes proposals, only into its own blocks and sections.

Targets per project ``p`` (BRAIN5-PIPELINE Leitentscheidung 7):

- ``20-projects/<p>/FALLEN.yaml``: packages of type ``fehler``/``lehre`` with
  a counter-measure, ``status: vorgeschlagen`` (the tripwire reads only
  ``gilt``), inside a comment-delimited section at the END of the ``fallen:``
  list.  Everything before that section stays byte-identical; the result is
  parsed again with the tripwire's own loader and every existing entry must
  come back unchanged, otherwise nothing is written.
- ``20-projects/<p>/brain-vorschlaege.md``: one table row per package of type
  entscheidung/fehler/lehre in the marker block ``<!-- brain:vorschlaege:start/end -->``;
  created with ``class: derived``. The name prefix is in ``config.EXCLUDE_PREFIXES``,
  so search, auto-recall and the reality check never see the unreviewed rows
  (Orchestrator 2026-09-23: rows in the curated ENTSCHEIDUNGEN-UND-FALLEN.md
  would have added up to 300 unreviewed lines to a note that recall hits often;
  41 % of the first packages were ``fakt``, mostly ephemeral). ``fakt``/``offen``
  stay in the book only.
- ``review-queue.md``: KERN.md proposals (decisions) one line each, in the
  marker block of the same name.  Pair judgments (same / supersedes /
  contradicts; model verdicts and, since p2, cosine ``gleich``) and project
  proposals of the model for packages whose unit the rules left without project
  (``projektwahl``) are listed in the proposed project's ``brain-vorschlaege.md``
  (sections below the table, same block) and only counted in the queue, one
  line per project (g3, 2026-09-24: 2 441 project proposals and 2 109 pair
  judgments had grown the queue to 1.5 MB).  Both only for packages that
  ``pruefen`` kept (``behalten``).  A project proposal is never written into
  FALLEN.yaml or KERN.md.

- ``20-projects/<p>/FALLEN.md``: a searchable reading view of every ``status:
  gilt`` entry of that project's FALLEN.yaml (trap, counter-measure, source,
  since), regenerated in its marker block ``<!-- brain:fallen-sicht:start/end -->``
  on every ``schreiben`` (and so on every ``brain run uebernehmen``).  Search and
  auto-recall index only Markdown and the tripwire reads only entries with an
  ``ausloeser``: without this view 109 of 140 taken-over lessons reached no
  agent (v2-dream, 2026-09-24).  Created with ``class: knowledge``, ``type:
  reference``, not ``class: derived``: the view is the only readable form of
  checked entries and must rank like a normal note (d1, 2026-09-24).
  Additionally one note ``20-projects/<p>/fallen/<id>.md`` per entry whose
  source is no note of the project (all taken-over ones): in the long view
  alone the search found 3 of 10 title questions, with these notes 10 of 10.
  An entry that leaves ``gilt`` keeps its note, rewritten to say so.

Every row carries date, source (transcript/worker id + segment) and sentence
IDs, and type.  All writes go through ``VaultWriter`` (session notes, foreign
authors, read-only spaces, uncommitted foreign work: refused and reported).
Blocks are regenerated from the book, so a repeated run writes the same bytes.
Nothing is deleted, nothing is pushed; the caller makes the one commit.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .. import blocks
from ..dream import secrets_scan
from ..vault import VaultWriter, read_text
from . import buch as b
from .buch import Buch

log = logging.getLogger("gardener.lauf")

START = "<!-- brain:vorschlaege:start -->"
END = "<!-- brain:vorschlaege:end -->"
YAML_START = "  # brain:vorschlaege:start"
YAML_END = "  # brain:vorschlaege:end"
MAX_ZEILEN = 300          # per project and file; the rest stays in the book
FALLEN_TYPEN = ("fehler", "lehre")
KERN_TYPEN = ("entscheidung",)
VORSCHLAG_TYPEN = ("entscheidung", "fehler", "lehre")
VORSCHLAG_DATEI = "brain-vorschlaege.md"
PAAR_LABELS = ("gleich", "neuere_loest_ab", "widerspruch")
PAAR_STATUS = ("entschieden", "cos")
APP_START = "<!-- brain-app:entschieden:start -->"
APP_END = "<!-- brain-app:entschieden:end -->"
APP_ENTSCHEIDUNG_RE = re.compile(
    r"^- \d{4}-\d{2}-\d{2} (abgelehnt|erledigt|angenommen) von [^:]+: (.*) "
    r"\(review [0-9a-f]{16}\)$")
PAKET_RE = re.compile(r"\[paket ([0-9a-f]+)\]")
SICHT_DATEI = "FALLEN.md"
SICHT_START = "<!-- brain:fallen-sicht:start -->"
SICHT_END = "<!-- brain:fallen-sicht:end -->"
EINZEL_DIR = "fallen"


@dataclass
class SchreibErgebnis:
    geschrieben: list[str] = field(default_factory=list)
    geplant: list[str] = field(default_factory=list)
    verweigert: list[tuple[str, str]] = field(default_factory=list)
    ohne_ziel: int = 0
    vorgeschlagen: int = 0
    uebernommen: int = 0
    gekappt: dict[str, int] = field(default_factory=dict)

    def als_dict(self) -> dict:
        return {"geschrieben": self.geschrieben, "geplant": self.geplant,
                "verweigert": [list(v) for v in self.verweigert], "ohne_ziel": self.ohne_ziel,
                "vorgeschlagen": self.vorgeschlagen, "uebernommen": self.uebernommen,
                "gekappt": self.gekappt}


def _cell(text: str | None) -> str:
    return " ".join(str(text or "").split()).replace("|", "\\|")


def _yaml_str(text: str | None) -> str:
    value = " ".join(str(text or "").split()).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{value}"'


def quelle(row) -> str:
    belege = ",".join(json.loads(row["belege"] or "[]"))
    return f"{row['quell_id']}#{row['segment_index']} {belege}"


def belegauszug(row) -> str:
    """First original evidence sentence, only when the complete quote passes the secret gate."""
    original = str(row["zitat"] or "")
    if not original or secrets_scan.content_hit(original):
        return ""
    satz = " ".join(original.split(" … ", 1)[0].split())
    return satz if len(satz) <= 300 else satz[:299] + "…"


def _vorschlag_datum(row) -> str:
    return dt.date.fromtimestamp(row["created"]).isoformat()


def _tripwire_loader():
    """The tripwire's own YAML loader (``_meta/tools/hooks/tripwire_core.py``)."""
    path = Path(__file__).resolve().parents[3] / "hooks" / "tripwire_core.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location("_tripwire_core_for_lauf", path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:           # a broken hook module must not break the run
        return None
    return module.yaml_load


# ---------------------------------------------------------------------------
# FALLEN.yaml
# ---------------------------------------------------------------------------

def _fallen_eintrag(row, lauf_id: str) -> str:
    lines = [
        f"  - id: brain-{row['paket_id'][:10]}",
        f"    falle: {_yaml_str(row['aussage'])}",
        f"    gegenmittel: {_yaml_str(row['gegenmittel'])}",
        f"    quelle: {_yaml_str(quelle(row))}",
        f"    belegauszug: {_yaml_str(belegauszug(row))}",
        f"    seit: {_yaml_str(row['datum'] or _vorschlag_datum(row))}",
        "    status: vorgeschlagen",
        "    abgeloest_durch: null",
        "    schaden: 1",
        f"    # typ {row['typ']}, vorgeschlagen {_vorschlag_datum(row)} von brain run {row['lauf_id']};"
        " schaden ungeschaetzt",
    ]
    return "\n".join(lines)


def _fallen_section(rows, lauf_id: str) -> str:
    body = [YAML_START + " -- von `brain run` erzeugt, nur Vorschlaege (status vorgeschlagen),"
            " der Tripwire liest sie nicht; uebernehmen = Eintrag ueber diesen Abschnitt"
            " verschieben und status gilt setzen"]
    body += [_fallen_eintrag(row, lauf_id) for row in rows]
    body.append(YAML_END)
    return "\n".join(body) + "\n"


def fallen_text(existing: str | None, projekt: str, rows, lauf_id: str) -> tuple[str | None, str]:
    """New file text, or (None, reason) when the file cannot take the section."""
    section = _fallen_section(rows, lauf_id)
    if existing is None:
        head = (f"# Fallenbuch {projekt}. Schema: _meta/tools/hooks/FALLEN-SCHEMA.md.\n"
                "# Angelegt von `brain run`; alle Eintraege sind Vorschlaege.\n"
                f"version: 1\nprojekt: {projekt}\nfallen:\n")
        return head + section, "neu"
    lines = existing.splitlines(keepends=True)
    top_keys = [i for i, line in enumerate(lines)
                if line[:1].isalpha() and ":" in line and not line.startswith("#")]
    if not top_keys or not lines[top_keys[-1]].startswith("fallen:"):
        return None, "fallen-nicht-letzter-schluessel"
    start = next((i for i, line in enumerate(lines) if line.rstrip("\n").startswith(YAML_START)), None)
    end = next((i for i, line in enumerate(lines) if line.rstrip("\n") == YAML_END), None)
    if (start is None) != (end is None) or (start is not None and end < start):
        return None, "abschnitt-kaputt"
    if start is not None:
        tail = "".join(lines[end + 1:])
        if tail.strip():
            return None, "text-nach-abschnitt"
        head = "".join(lines[:start])
    else:
        head = existing if existing.endswith("\n") else existing + "\n"
        if not head.endswith("\n\n"):
            head += "\n"
    return head + section, "ok"


def _pyyaml_fehler(text: str) -> str | None:
    """PyYAML's complaint about ``text``, None when it parses or PyYAML is not
    installed.  The tripwire's own loader is lenient (it read the a machine-bound project
    file with an unescaped ASCII quote inside a quoted string that PyYAML
    rejects, j2 2026-09-24); every other reader expects YAML."""
    try:
        import yaml
    except ImportError:
        return None
    try:
        yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return " ".join(str(exc).split())[:200]
    return None


def _pruefe_fallen(old: str | None, new: str, loader) -> str | None:
    """None if ``new`` keeps every entry of ``old`` unchanged and adds only
    ``brain-`` proposals with ``status: vorgeschlagen``, else the reason."""
    if old is None or _pyyaml_fehler(old) is None:
        problem = _pyyaml_fehler(new)
        if problem:
            return f"yaml-unlesbar: {problem}"
    if loader is None:
        return None
    try:
        before = ((loader(old) or {}).get("fallen") or []) if old is not None else []
        after = (loader(new) or {}).get("fallen") or []
    except Exception as exc:
        return f"yaml-unlesbar: {exc}"

    def own(entry) -> bool:
        return isinstance(entry, dict) and str(entry.get("id", "")).startswith("brain-")

    if [e for e in after if not own(e)] != [e for e in before if not own(e)]:
        return "bestehende-eintraege-veraendert"
    added = [e for e in after if own(e) and e not in before]
    if any(e.get("status") != "vorgeschlagen" for e in added):
        return "vorschlag-ohne-status-vorgeschlagen"
    return None


def uebernommene(text: str, loader) -> set[str]:
    """Ids ``brain-…`` a human has taken over (status no longer vorgeschlagen)."""
    if loader is None or not text:
        return set()
    try:
        entries = (loader(text) or {}).get("fallen") or []
    except Exception:
        return set()
    return {str(e["id"])[len("brain-"):] for e in entries
            if isinstance(e, dict) and str(e.get("id", "")).startswith("brain-")
            and e.get("status") not in ("vorgeschlagen", None)}


def _normalisiert(text: str) -> str:
    return " ".join(text.casefold().split())


def app_entscheidungen(text: str) -> dict[str, str]:
    """Package-prefix -> terminal review state from the Brain-App block.

    The app block is deliberately owned by the app, so malformed or unrelated
    lines are ignored instead of making a pipeline write destructive.
    """
    try:
        inhalt = text.split(APP_START, 1)[1].split(APP_END, 1)[0]
    except IndexError:
        return {}
    entscheidungen: dict[str, str] = {}
    for line in inhalt.splitlines():
        match = APP_ENTSCHEIDUNG_RE.match(line)
        if not match:
            continue
        status, eintrag = match.groups()
        for paket in PAKET_RE.findall(eintrag):
            entscheidungen[paket] = status
    return entscheidungen


def kern_uebernommen(kern_text: str, row) -> bool:
    """The app copies the assertion into ``## Gilt``; permit provenance text
    around it but require the full normalised assertion."""
    match = re.search(r"^## Gilt\s*$\n(?P<inhalt>.*?)(?=^## |\Z)", kern_text,
                      flags=re.MULTILINE | re.DOTALL)
    return bool(match and _normalisiert(row["aussage"]) in _normalisiert(match.group("inhalt")))


# ---------------------------------------------------------------------------
# ENTSCHEIDUNGEN-UND-FALLEN.md and review-queue.md
# ---------------------------------------------------------------------------

def _abschnitt(titel: str, erklaerung: str, zeilen: list[str]) -> list[str]:
    if not zeilen:
        return []
    shown = zeilen[-MAX_ZEILEN:]
    out = ["", f"### {titel}", "", erklaerung, ""] + shown
    if len(zeilen) > len(shown):
        out += ["", f"{len(zeilen) - len(shown)} weitere stehen nur im Buch (`brain run status`)."]
    return out


def _tabelle(rows, lauf_id: str, gekappt: int, paar: list[str] | None = None,
             projektvorschlaege: list[str] | None = None) -> str:
    out = [START, "## Vorschläge der Pipeline (`brain run`, ungeprüft)", "",
           "Erzeugt von `brain run`. Quelle = Einheit (`<quelle>#<segment>`) "
           "und Satz-IDs des Belegs; übernehmen heißt: Zeile in `ENTSCHEIDUNGEN-UND-FALLEN.md` bzw. `KERN.md` übertragen.", "",
           "| Datum | Typ | Aussage | Gegenmittel | Quelle (Satz-IDs) | vorgeschlagen |",
           "|---|---|---|---|---|---|"]
    for row in rows:
        out.append(f"| {_cell(row['datum'])} | {row['typ']} | {_cell(row['aussage'])} | "
                   f"{_cell(row['gegenmittel'])} | {_cell(quelle(row))} | {_vorschlag_datum(row)} |")
    if gekappt:
        out += ["", f"{gekappt} weitere Vorschläge stehen nur im Buch (`brain run status`)."]
    out += _abschnitt("Paarurteile", "Abgleich eines behaltenen Pakets mit einem früheren "
                      "(gleich, neuere löst ab, Widerspruch); nichts davon ist angewendet.", paar or [])
    out += _abschnitt("Projektvorschläge", "Die Regeln fanden kein Projekt; das Modell schlägt "
                      "dieses vor. Das Paket liegt nur im Buch.", projektvorschlaege or [])
    out.append(END)
    return "\n".join(out)


def entscheidungen_text(existing: str | None, projekt: str, block: str) -> tuple[str | None, str]:
    if existing is None:
        today = dt.date.today().isoformat()
        head = ("---\n"
                f"title: {projekt} Pipeline-Vorschläge\n"
                "type: decision\nclass: derived\n"
                f"branch: 20-projects/{projekt}\n"
                f'created: "{today}"\nbeleg: berichtet\n---\n\n'
                f"Für künftige Sessions: von `brain run` erzeugte, ungeprüfte Vorschläge zu "
                f"Entscheidungen, Fehlern und Lehren in {projekt}. Maßgeblich sind geprüfte Zeilen "
                "außerhalb des Markerblocks und die verlinkten Quellen.\n\n")
        return head + block + "\n", "neu"
    new, ok = blocks.replace_block(existing, START, END, block)
    if not ok:
        return None, "markerblock-kaputt"
    if new == existing and not blocks.has_block(existing, START, END):
        new = existing.rstrip("\n") + "\n\n" + block + "\n"
    return new, "ok"


def _queue_block(per_projekt: dict[str, list[str]], lauf_id: str,
                 zaehlung: dict[str, tuple[int, int]] | None = None) -> str:
    """KERN proposals one line each; pair judgments and project proposals only
    as one count line per project pointing to its ``brain-vorschlaege.md``."""
    zaehlung = {p: n for p, n in (zaehlung or {}).items() if any(n)}
    out = [START, "## Vorschläge aus `brain run` (KERN.md, Paarurteile) — ungeprüft", "",
           "Erzeugt von `brain run`. Nichts davon ist angewendet."]
    for projekt in sorted(set(per_projekt) | set(zaehlung)):
        out += ["", f"### {projekt}", ""] + per_projekt.get(projekt, [])
        if projekt in zaehlung:
            paar, vorschlaege = zaehlung[projekt]
            teile = ([f"{paar} Paarurteil" + ("e" if paar > 1 else "")] if paar else []) + \
                ([f"{vorschlaege} Projektvorschl" + ("äge" if vorschlaege > 1 else "ag")]
                 if vorschlaege else [])
            out.append(f"- Sammelzeile: {', '.join(teile)} zu geprüft behaltenen Paketen — "
                       f"Liste in `20-projects/{projekt}/{VORSCHLAG_DATEI}`")
    out.append(END)
    return "\n".join(out)


def behalten(row) -> bool:
    """``pruefen`` kept the package.  While the check is off (``BRAIN_PRUEFEN=0``)
    an unchecked package counts as kept, as before p3."""
    from .pruefen import aktiv
    try:
        pruefung = json.loads(row["pruefung"]) if row["pruefung"] else None
    except (ValueError, TypeError):
        return False
    if pruefung is None:
        return not aktiv()
    return isinstance(pruefung, dict) and pruefung.get("grund") is None


def projektvorschlag_zeilen(buch: Buch, vault: Path) -> dict[str, list[str]]:
    """Review lines for packages without project whose unit has a model
    project proposal (``projektwahl``), by proposed project."""
    out: dict[str, list[str]] = {}
    vorschlaege: dict[tuple, dict | None] = {}
    for row in buch.pakete(status="ohne-ziel"):
        if row["projekt"] or row["typ"] not in VORSCHLAG_TYPEN or not behalten(row):
            continue
        key = (row["quell_id"], row["segment_index"], row["content_hash"])
        if key not in vorschlaege:
            unit = buch.unit(b.Key(*key))
            try:
                vorschlaege[key] = json.loads(unit["projekt_vorschlag"]) if unit is not None \
                    and unit["projekt_vorschlag"] else None
            except ValueError:
                vorschlaege[key] = None
        vorschlag = vorschlaege[key]
        projekt = (vorschlag or {}).get("projekt")
        if not projekt or not (vault / "20-projects" / projekt).is_dir():
            continue
        out.setdefault(projekt, []).append(
            f"- Projektvorschlag {projekt} (p {vorschlag.get('p')}, {vorschlag.get('modell')}; "
            f"{row['typ']}, {_cell(row['datum'])}): {_cell(row['aussage'])} — Quelle: "
            f"{_cell(quelle(row))} [paket {row['paket_id'][:10]}]")
    return out


# ---------------------------------------------------------------------------
# FALLEN.md and fallen/<id>.md: searchable views of the entries in force
# ---------------------------------------------------------------------------

def geltende_fallen(text: str) -> list[dict]:
    """``status: gilt`` entries of a FALLEN.yaml text (PyYAML; raises on bad YAML)."""
    import yaml
    data = yaml.safe_load(text) or {}
    return [e for e in (data.get("fallen") or []) if isinstance(e, dict) and e.get("status") == "gilt"]


def _quelle_stem(quelle_text) -> str:
    stem = " ".join(str(quelle_text or "").split()).rsplit("/", 1)[-1]
    return stem[:-3] if stem.endswith(".md") else stem


def _quelle_md(quelle_text, notizen: set[str]) -> str:
    """A source that names a note of the project becomes a wikilink, the rest stays code."""
    q = " ".join(str(quelle_text or "").split())
    if not q:
        return "–"
    if _quelle_stem(q) in notizen:
        return f"[[{_quelle_stem(q)}]]"
    return "`" + q.replace("`", "'") + "`"


def braucht_notiz(e: dict, notizen: set[str]) -> bool:
    """An entry whose source is no note of the project gets its own note: in one
    long view per project the search found 3 of 10 title questions, with one note
    per such entry 10 of 10 (d1, 2026-09-24); an entry whose lesson already has
    a note is found there, a second note only displaced it (recall set -6 at rank 1)."""
    return _quelle_stem(e.get("quelle")) not in notizen


def _einzel_rel(projekt: str, fid) -> str:
    return f"20-projects/{projekt}/{EINZEL_DIR}/{fid}.md"


def _eintrag_zeilen(e: dict, notizen: set[str]) -> list[str]:
    return [f"- Quelle: {_quelle_md(e.get('quelle'), notizen)}; seit {e.get('seit') or '–'}",
            f"- Eintrag `{e.get('id')}`, Schaden {e.get('schaden', '–')}, Tripwire-Auslöser "
            + ("ja" if e.get("ausloeser") else "nein")
            + (f", Anker `{e['anker']}`" if e.get("anker") else "")]


def sicht_block(eintraege: list[dict], notizen: set[str] = frozenset(), projekt: str = "",
                ruhend: tuple = ()) -> str:
    mit = sum(1 for e in eintraege if e.get("ausloeser"))
    out = [SICHT_START, f"## Geltende Fallen ({len(eintraege)})", "",
           f"Erzeugt von `brain run` aus `FALLEN.yaml` (alle Einträge mit `status: gilt`); "
           f"{mit} davon hat der Tripwire als Auslöser. Maßgeblich und zu ändern ist `FALLEN.yaml`; "
           "dieser Block wird bei jedem `brain run` (schreiben, uebernehmen) neu erzeugt."]
    if not eintraege:
        out += ["", "Derzeit gilt kein Eintrag."]
    for e in eintraege:
        falle = " ".join(str(e.get("falle") or "").split()) or str(e.get("id"))
        out += ["", f"### {falle}", "",
                f"- Gegenmittel: {' '.join(str(e.get('gegenmittel') or '–').split())}"]
        out += _eintrag_zeilen(e, notizen)
        if projekt and braucht_notiz(e, notizen):
            # Wikilink statt Pfad: ohne ihn waren alle 115 fallen/-Notizen Waisen (ana-struktur, 28.09.)
            out.append(f"- Eigene Notiz: [[{e.get('id')}]]")
    if ruhend:
        out += ["", "## Nicht mehr geltend (eigene Notizen)", ""]
        out += [f"- [[{fid}]]" for fid in ruhend]
    out.append(SICHT_END)
    return "\n".join(out)


TITEL_MAX = 100
_TITEL_SCHNITTE = (";", ":", " – ", " — ", ",", " (", " bzw. ", " wodurch", " weshalb", " sodass",
                   " da ", " weil ", " obwohl ", " ohne dass", " was ", " dabei")
_TITEL_ENDWOERTER = {"und", "oder", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen",
                     "einem", "einer", "eines", "in", "im", "an", "am", "auf", "aus", "bei", "mit",
                     "nach", "von", "vom", "zu", "zum", "zur", "für", "fuer", "über", "ueber", "als",
                     "wenn", "dass", "ist", "sind", "wird", "werden", "nicht", "kein", "keine", "the",
                     "a", "of", "to", "and", "or", "is", "dazu", "damit", "es", "er", "sie", "dann"}


def kurztitel(falle: str, limit: int = TITEL_MAX) -> str:
    """Titel aus einer Kurzform der Falle statt aus dem abgeschnittenen Satz: der erste Satz, bei
    Ueberlaenge am letzten Nebensatz- oder Klammerschnitt vor dem Limit (nie kuerzer als die
    60 Prozent des Limits), sonst am Wortende ohne hangende Fuellwoerter. Nie mit Auslassungspunkten: 115 von
    115 Titeln der ersten Fassung endeten auf `(…` oder `…` (ana-struktur, 28.09.)."""
    s = " ".join(str(falle or "").split())
    if len(s) <= limit:
        return s                        # eine kurze Falle ist ihr eigener Titel
    m = re.search(r"(?<!\bz)(?<!\bB)(?<!\bca)(?<!\bDr)(?<!\bMin)[.!?](?=\s+[A-ZÄÖÜ`\"„])", s)
    if m:
        s = s[:m.start() + 1]
    s = s.rstrip(" .:;,")
    if len(s) <= limit:
        return s
    best = -1
    for marker in _TITEL_SCHNITTE:
        i = s.rfind(marker, 0, limit + 1)
        while i != -1 and s[:i].count("`") % 2:        # nie mitten in einem Backtick-Ausdruck
            i = s.rfind(marker, 0, i)
        if i >= limit * 6 // 10:
            best = max(best, i)
    if best == -1:
        best = s.rfind(" ", 0, limit + 1)
        while best != -1 and s[:best].count("`") % 2:
            best = s.rfind(" ", 0, best)
        if best == -1:
            best = limit
    kurz = s[:best].rstrip(" .:;,–—")
    woerter = kurz.split(" ")
    while len(woerter) > 3 and woerter[-1].lower().strip("`") in _TITEL_ENDWOERTER:
        woerter.pop()
    kurz = " ".join(woerter).rstrip(" .:;,–—")
    return kurz + ("`" if kurz.count("`") % 2 else "")


def _titel(falle: str) -> str:
    return kurztitel(falle)


def titel_erneuern() -> bool:
    """Bestandsnotizen behalten ihren Titel; `BRAIN_FALLEN_TITEL_ERNEUERN=1` setzt die Kurzform auch
    dort (einmal nach Messung, siehe ergebnis b6-struktur)."""
    return os.environ.get("BRAIN_FALLEN_TITEL_ERNEUERN", "0") == "1"


def einzel_block(e: dict, projekt: str, notizen: set[str]) -> str:
    falle = " ".join(str(e.get("falle") or "").split())
    return "\n".join([SICHT_START, f"**Falle:** {falle}", "",
                      f"**Gegenmittel:** {' '.join(str(e.get('gegenmittel') or '–').split())}", ""]
                     + _eintrag_zeilen(e, notizen)
                     + [f"- Übersicht aller geltenden Fallen: `20-projects/{projekt}/{SICHT_DATEI}`; "
                        f"maßgeblich ist `20-projects/{projekt}/FALLEN.yaml`", SICHT_END])


def einzel_block_ruhend(fid, projekt: str) -> str:
    return "\n".join([SICHT_START, f"**Gilt nicht mehr:** Eintrag `{fid}` steht in "
                      f"`20-projects/{projekt}/FALLEN.yaml` nicht mehr mit `status: gilt` (abgelöst, "
                      "zurückgenommen oder inzwischen in einer eigenen Notiz). Die geltenden Fallen stehen in "
                      f"`20-projects/{projekt}/{SICHT_DATEI}`.", SICHT_END])


def _mit_titel(text: str, titel: str) -> str:
    """Set the frontmatter ``title:`` (the rest, including the writer's id stamp, stays)."""
    m = re.match(r"---\n(.*?\n)---\n", text, flags=re.DOTALL)
    if not m:
        return text
    fm = re.sub(r"^title:.*$", lambda _m: f"title: {_yaml_str(titel)}", m.group(1), count=1,
                flags=re.MULTILINE)
    return "---\n" + fm + "---\n" + text[m.end():]


def einzel_text(existing: str | None, projekt: str, e: dict | None, fid, block: str,
                created: str) -> tuple[str | None, str]:
    """Text of ``fallen/<id>.md``; ``e`` None = the entry is no longer in force."""
    if e is not None:
        titel = _titel(" ".join(str(e.get("falle") or fid).split()))
    else:
        alt = re.search(r"^title:\s*\"?(.*?)\"?\s*$", existing or "", flags=re.MULTILINE)
        alt_titel = alt.group(1).replace('\\"', '"') if alt else str(fid)
        titel = alt_titel if alt_titel.startswith("Gilt nicht mehr: ") else "Gilt nicht mehr: " + alt_titel
    if existing is None:
        head = ("---\n"
                f"title: {_yaml_str(titel)}\n"
                "type: pitfall\nclass: knowledge\n"
                f"branch: 20-projects/{projekt}\n"
                f"tags: [{projekt}, falle]\n"
                f'created: "{created}"\nstand: "{created[:7]}"\nbeleg: berichtet\n---\n\n'
                f"Für künftige Sessions: eine geltende Falle in {projekt} und ihr Gegenmittel, erzeugt aus "
                "`FALLEN.yaml` von `brain run` (eigene Notiz, weil die Lehre sonst in keiner Notiz steht).\n\n")
        return head + block + "\n", "neu"
    state = blocks.block_state(existing, SICHT_START, SICHT_END)
    if state != blocks.ONE:
        return None, "markerblock-kaputt"
    new, _ = blocks.replace_block(existing, SICHT_START, SICHT_END, block)
    alt = re.search(r"^title:\s*\"?Gilt nicht mehr: ", existing, flags=re.MULTILINE)
    if e is not None and not alt and not titel_erneuern():
        return new, "ok"                # der Titel der Bestandsnotiz bleibt (Suche ist auf ihn gemessen)
    return _mit_titel(new, titel), "ok"


def sicht_text(existing: str | None, projekt: str, block: str, created: str) -> tuple[str | None, str]:
    if existing is None:
        head = ("---\n"
                f"title: {projekt} Fallen (geltend)\n"
                "type: reference\nclass: knowledge\n"
                f"branch: 20-projects/{projekt}\n"
                f"tags: [{projekt}, fallen, lehren]\n"
                f'created: "{created}"\nbeleg: berichtet\n---\n\n'
                f"Für künftige Sessions: welche Fallen in {projekt} gelten und was dagegen hilft. "
                "Lesesicht von `FALLEN.yaml`, damit Suche und Auto-Recall die geprüften Lehren finden; "
                "auch Einträge ohne Tripwire-Auslöser stehen hier.\n\n")
        return head + block + "\n", "neu"
    state = blocks.block_state(existing, SICHT_START, SICHT_END)
    if state == blocks.MALFORMED:
        return None, "markerblock-kaputt"
    if state == blocks.ONE:
        new, _ = blocks.replace_block(existing, SICHT_START, SICHT_END, block)
        return new, "ok"
    return existing.rstrip("\n") + "\n\n" + block + "\n", "ok"


def fallen_sicht(writer: VaultWriter, result: SchreibErgebnis, projekte=None) -> None:
    """Regenerate ``20-projects/<p>/FALLEN.md`` (all entries in force) and one
    note ``20-projects/<p>/fallen/<id>.md`` per entry whose source is no note of
    the project, for every project with a FALLEN.yaml (or only ``projekte``).
    Nothing is created for a project without an entry in force; an own entry
    note whose entry left ``gilt`` is rewritten to say so, never deleted."""
    vault = writer.vault
    base = vault / "20-projects"
    if not base.is_dir():
        return
    namen = sorted(projekte) if projekte is not None else \
        sorted(p.name for p in base.iterdir() if (p / "FALLEN.yaml").is_file())
    for projekt in namen:
        yaml_path = base / projekt / "FALLEN.yaml"
        rel = f"20-projects/{projekt}/{SICHT_DATEI}"
        path = vault / rel
        if not yaml_path.is_file():
            continue
        try:
            eintraege = geltende_fallen(read_text(yaml_path))
        except Exception as exc:        # noqa: BLE001 - the view waits for a readable book
            result.verweigert.append((rel, f"yaml-unlesbar: {' '.join(str(exc).split())[:120]}"))
            continue
        old = read_text(path) if path.exists() else None
        einzel_dir = base / projekt / EINZEL_DIR
        eigene = {p.stem: p for p in sorted(einzel_dir.glob("*.md"))
                  if SICHT_START in read_text(p)} if einzel_dir.is_dir() else {}
        if old is None and not eintraege and not eigene:
            continue
        notizen = {p.stem for p in (base / projekt).rglob("*.md")
                   if p.parent != einzel_dir} - {Path(SICHT_DATEI).stem}
        seit = sorted(str(e.get("seit")) for e in eintraege if e.get("seit"))
        created = seit[0] if seit else dt.date.today().isoformat()
        noetig = {str(e.get("id")): e for e in eintraege if braucht_notiz(e, notizen)}
        ruhend = tuple(sorted(set(eigene) - set(noetig)))
        new, why = sicht_text(old, projekt, sicht_block(eintraege, notizen, projekt, ruhend), created)
        if new is None:
            result.verweigert.append((rel, why))
        elif new != old:
            _write(writer, vault, rel, new, old, result)
        for fid in sorted(set(noetig) | set(eigene)):
            erel = _einzel_rel(projekt, fid)
            epath = vault / erel
            e_old = read_text(epath) if epath.exists() else None
            if e_old is not None and fid not in eigene:
                result.verweigert.append((erel, "fremde-datei"))
                continue
            e = noetig.get(fid)
            block = einzel_block(e, projekt, notizen) if e is not None else einzel_block_ruhend(fid, projekt)
            e_new, why = einzel_text(e_old, projekt, e, fid, block, str(e.get("seit") or created)
                                     if e is not None else created)
            if e_new is None:
                result.verweigert.append((erel, why))
            elif e_new != e_old:
                _write(writer, vault, erel, e_new, e_old, result)


# ---------------------------------------------------------------------------
# the stage
# ---------------------------------------------------------------------------

def _wartet_auf_pruefung(row) -> bool:
    """A fresh package of a proposal type that ``pruefen`` has not checked yet
    (only while the check is on: ``BRAIN_PRUEFEN`` not ``0``)."""
    from .pruefen import aktiv
    return (row["status"] == "abgeglichen" and row["typ"] in b.PRUEF_TYPEN
            and row["pruefung"] is None and aktiv())


def _write(writer: VaultWriter, vault: Path, rel: str, text: str, existing: str | None,
           result: SchreibErgebnis) -> bool:
    ok = writer.write(vault / rel, text, expect=existing)
    if ok:
        (result.geplant if writer.dry_run else result.geschrieben).append(rel)
    else:
        reason = next((r for p, r in writer.protected_skipped if p == rel), None) or \
            ("konflikt" if rel in writer.conflicts else
             "fremde-aenderung" if rel in writer.foreign_skipped else "verweigert")
        result.verweigert.append((rel, reason))
    return ok


def schreiben(buch: Buch, writer: VaultWriter, *, lauf_id: str) -> SchreibErgebnis:
    vault = writer.vault
    result = SchreibErgebnis()
    loader = _tripwire_loader()
    queue_path = vault / "review-queue.md"
    queue_text = read_text(queue_path) if queue_path.exists() else ""
    decisions = app_entscheidungen(queue_text)
    for row in buch.pakete(status=("abgeglichen", "vorgeschlagen", "ohne-ziel")):
        status = decisions.get(row["paket_id"][:10])
        if status == "abgelehnt":
            buch.paket_update(row["paket_id"], status=b.ABGELEHNT)
        elif status == "erledigt":
            buch.paket_update(row["paket_id"], status=b.ERLEDIGT)
    # An accepted KERN proposal is durable only once its assertion is actually
    # present in KERN.md; the app's protocol line alone is not enough.
    for row in buch.pakete(status=("abgeglichen", "vorgeschlagen")):
        if row["typ"] not in KERN_TYPEN:
            continue
        kern = vault / "20-projects" / str(row["projekt"] or "") / "KERN.md"
        if kern.is_file() and kern_uebernommen(read_text(kern), row):
            buch.paket_update(row["paket_id"], status=b.UEBERNOMMEN)
            result.uebernommen += 1
    # packages that are ready, plus those proposed earlier (blocks are regenerated);
    # a fresh proposal waits for its check while ``pruefen`` is on (p3)
    rows = [r for r in buch.pakete(status=("abgeglichen", "vorgeschlagen")) if not _wartet_auf_pruefung(r)]
    per_projekt: dict[str, list] = {}
    for row in rows:
        projekt = row["projekt"]
        if not projekt or not (vault / "20-projects" / projekt).is_dir():
            if row["status"] == "abgeglichen":
                buch.paket_update(row["paket_id"], status="ohne-ziel",
                                  ziel="projekt-unbekannt" if not projekt else "projektordner-fehlt")
                result.ohne_ziel += 1
            continue
        per_projekt.setdefault(projekt, []).append(row)
    # A reviewed package is no longer in ``rows``.  Keep its project in the
    # rewrite set nevertheless, otherwise its last generated proposal block
    # would survive forever after the book state changed.
    for row in buch.pakete(status=(b.UEBERNOMMEN, b.ABGELEHNT, b.ERLEDIGT, b.VERWORFEN_AUTO)):
        projekt = row["projekt"]
        if projekt and (vault / "20-projects" / projekt).is_dir():
            per_projekt.setdefault(projekt, [])

    # computed before the loop, so each proposals file is written once per run
    projekt_lines = projektvorschlag_zeilen(buch, vault)
    for projekt in projekt_lines:
        per_projekt.setdefault(projekt, [])
    queue_lines: dict[str, list[str]] = {}
    zaehlung: dict[str, tuple[int, int]] = {}
    written_ids: set[str] = set()
    for projekt, prows in sorted(per_projekt.items()):
        base = f"20-projects/{projekt}"
        # FALLEN.yaml
        fallen_rel = f"{base}/FALLEN.yaml"
        fallen_path = vault / fallen_rel
        fallen_old = read_text(fallen_path) if fallen_path.exists() else None
        taken = uebernommene(fallen_old or "", loader)
        for row in prows:
            if row["paket_id"][:10] in taken:
                buch.paket_update(row["paket_id"], status="uebernommen")
                result.uebernommen += 1
        prows = [r for r in prows if r["paket_id"][:10] not in taken]
        fallen_rows = [r for r in prows if r["typ"] in FALLEN_TYPEN and (r["gegenmittel"] or "").strip()]
        fallen_ok = True
        if fallen_rows or (fallen_old is not None and YAML_START in fallen_old):
            shown = fallen_rows[-MAX_ZEILEN:]
            if len(fallen_rows) > len(shown):
                result.gekappt[fallen_rel] = len(fallen_rows) - len(shown)
            new, why = fallen_text(fallen_old, projekt, shown, lauf_id)
            problem = why if new is None else _pruefe_fallen(fallen_old, new, loader)
            if problem:
                result.verweigert.append((fallen_rel, problem))
                fallen_ok = False
            elif new != fallen_old:
                fallen_ok = _write(writer, vault, fallen_rel, new, fallen_old, result)
        # pair judgments of kept packages (listed in brain-vorschlaege.md) and
        # KERN proposals (one line each in review-queue.md)
        lines, paar = [], []
        by_id = {r["paket_id"]: r for r in buch.pakete(projekt=projekt)}
        for row in prows:
            if row["typ"] in KERN_TYPEN:
                auszug = belegauszug(row)
                beleg = f" — Belegauszug: {auszug}" if auszug else ""
                lines.append(f"- KERN-Vorschlag ({row['typ']}, {_cell(row['datum'])}): "
                             f"{_cell(row['aussage'])}{beleg} — Quelle: {_cell(quelle(row))} "
                             f"[paket {row['paket_id'][:10]}]")
            if not behalten(row):
                continue
            for verdict in json.loads(row["abgleich"] or "[]"):
                if verdict.get("urteil") in PAAR_LABELS and verdict.get("status") in PAAR_STATUS:
                    other = by_id.get(verdict.get("mit"))
                    paar.append(f"- Paarurteil {verdict['urteil']} ({verdict.get('konfidenz')}): "
                                f"[paket {row['paket_id'][:10]}] „{_cell(row['aussage'])}“ ↔ "
                                f"[paket {str(verdict.get('mit'))[:10]}] "
                                f"„{_cell(other['aussage']) if other is not None else '?'}“")
        if lines:
            queue_lines[projekt] = lines[-MAX_ZEILEN:]
        pvs = projekt_lines.get(projekt, [])
        # brain-vorschlaege.md (nur Entscheidungen, Fehler, Lehren; nicht im Suchkorpus)
        ent_rel = f"{base}/{VORSCHLAG_DATEI}"
        ent_path = vault / ent_rel
        ent_old = read_text(ent_path) if ent_path.exists() else None
        vrows = [r for r in prows if r["typ"] in VORSCHLAG_TYPEN]
        shown = vrows[-MAX_ZEILEN:]
        if len(vrows) > len(shown):
            result.gekappt[ent_rel] = len(vrows) - len(shown)
        ent_ok = True
        noetig = bool(vrows or paar or pvs) or (ent_old is not None and START in ent_old)
        new, why = (entscheidungen_text(ent_old, projekt, _tabelle(
            shown, lauf_id, len(vrows) - len(shown), paar, pvs)) if noetig else (ent_old, "leer"))
        if new is None and noetig:
            result.verweigert.append((ent_rel, why))
            ent_ok = False
        elif new != ent_old:
            ent_ok = _write(writer, vault, ent_rel, new, ent_old, result)
        if ent_ok and (paar or pvs):
            zaehlung[projekt] = (len(paar), len(pvs))
        if ent_ok and fallen_ok:
            written_ids.update(r["paket_id"] for r in prows)

    queue_ok = True
    if queue_lines or zaehlung or (queue_path.exists() and START in queue_text):
        q_rel = "review-queue.md"
        q_path = vault / q_rel
        q_old = queue_text if q_path.exists() else None
        q_new = blocks.upsert_section(q_old or "", START, END,
                                      _queue_block(queue_lines, lauf_id, zaehlung))
        if blocks.block_state(q_old or "", START, END) == blocks.MALFORMED:
            result.verweigert.append((q_rel, "markerblock-kaputt"))
            queue_ok = False
        elif q_new != (q_old or ""):
            queue_ok = _write(writer, vault, q_rel, q_new, q_old, result)
    # the view reads FALLEN.yaml after this run's (and ``uebernehmen``'s) writes
    fallen_sicht(writer, result)
    for row in rows:
        if row["paket_id"] in written_ids and row["status"] == "abgeglichen" and queue_ok:
            buch.paket_update(row["paket_id"], status="vorgeschlagen",
                              ziel=("FALLEN.yaml" if row["typ"] in FALLEN_TYPEN else
                                    VORSCHLAG_DATEI if row["typ"] in VORSCHLAG_TYPEN else "buch"))
            result.vorgeschlagen += 1
    # a unit is proposed when none of its packages is still waiting to be written
    for unit in buch.units(b.ABGEGLICHEN):
        key = b.Key(unit["quell_id"], unit["segment_index"], unit["content_hash"])
        states = {p["status"] for p in buch.pakete(key=key)}
        if not states & {"neu", "abgeglichen"}:
            new_status = b.UEBERNOMMEN if states == {"uebernommen"} else b.VORGESCHLAGEN
            buch.set_status(key, new_status, lauf_id=lauf_id)
    buch.commit()
    return result
