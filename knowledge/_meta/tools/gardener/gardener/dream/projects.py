"""M6: die Projekte aus `~/AI` kommen als WISSEN in den Vault, nicht als
Dateien (DREAM-PLAN.md Abschnitt 8).

Die Messung, an der das hängt, steht im Plan: `~/AI` sind rund 270 GB und
122.000 Dateien, der Vault hat 309 Notizen. Ein Durchmarsch würde ihn
versechsfachen, überwiegend mit Maschinenausgabe. Drei Schichten halten
dagegen, und dieses Modul baut die zweite und dritte:

1. **Die Erlaubnisliste** steht schon in `corpus.project_doc_sources` und wird
   hier NICHT zweitgebaut: Markdown auf oberster Ebene, `docs/`, `knowledge/`,
   `research/`, `reports/`, dazu die `.gitignore` des Projekts. Vorgabe ist
   Verbot.
2. **Das Werttor** entscheidet je Datei, ob sie kopiert wird, ob nur eine
   Sidecar-Notiz sie beschreibt oder ob sie draußen bleibt.
3. **Die Projektseite** trägt das Wissen zeilenweise mit Zitat und Pfad.

## Wie eine Projektseite aussieht, und warum

Eine belegte Aussage bleibt **eine Zeile**. Das ist eine Entscheidung, keine
Bequemlichkeit: `block_lines` und `applied_claim_ids` erkennen genau diese
Form, `gate_rendering` lässt nur Zeilen durch, die `render_claim` selbst
erzeugt hat, und `gate_values` prüft den Satz gegen sein eigenes Zitat. Ein
Absatz als eine Aussage würde alle vier Tore an der Stelle aufweichen, an der
der meiste fremde Text in den Vault kommt - und die Idempotenz gleich mit,
denn ein Absatz ohne wiederauffindbare Kennung wird bei jedem Lauf neu
vorgeschlagen. Die Lücke aus der C8-Notiz vom 09.08.2026 wird hier also nicht
geschlossen, sondern umgangen.

Lesbar wird die Seite durch **Abschnitte, die der Code selbst schreibt**: die
Zeilen werden nach `kind` gruppiert, jede Gruppe bekommt eine feste
Überschrift aus `PAGE_SECTIONS`. Damit beantwortet die Seite die vier Fragen
aus Abschnitt 8 - was das Projekt ist, wie der Stand ist, was feststeht, was
schiefgehen kann - ohne dass eine einzige Zeile ihre Form ändert. Die
Überschriften sind Code-Text wie der Markerblock selbst, deshalb kennt
`apply.gate_rendering` sie und lässt sonst nichts durch.

## Sicherheit

Die Geheimnisprüfung läuft über JEDE Projektdatei, bevor ein Zeichen davon in
einen Prompt oder in den Vault geht - Projektverzeichnisse sind der
wahrscheinlichste Ort für einen eingecheckten Schlüssel. Gemeldet wird der
Pfad, nie der Wert. Dazu greift Regel 8 schon beim Einlesen: eine Datei, die
wie eine Anweisung an einen Agenten klingt, wird als Quelle abgelehnt. Beide
Prüfungen sind die bestehenden (`secrets_scan`, `apply._INSTRUCTION_RE`), nicht
neue.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..frontmatter import parse as parse_frontmatter
from ..frontmatter import render as frontmatter_render
from . import config as dcfg
from . import corpus
from . import secrets_scan
from . import segment as segment_mod
from . import shadow as shadow_mod

log = logging.getLogger("gardener.dream")

# Was mit einer Projektdatei geschieht.
TAKE_COPY = "kopiert"          # class: source im Vault
TAKE_SIDECAR = "sidecar"       # nur eine Notiz, die die Datei beschreibt
TAKE_SKIP = "uebersprungen"    # nichts davon

# Die festen Abschnitte einer Projektseite, nach `kind` der Aussage. Der Code
# schreibt sie, nicht das Modell - deshalb dürfen sie in einem Markerblock
# stehen, ohne die Zitatprüfung zu berühren.
PAGE_SECTIONS = (
    ("### Was das Projekt ist", ("setup-fact",)),
    ("### Was feststeht", ("decision", "rule")),
    ("### Was gemessen ist", ("measurement",)),
    ("### Was schiefgehen kann", ("gotcha",)),
    ("### Woertlich uebernommen", ("prose",)),
)
SECTION_HEADINGS = tuple(heading for heading, _kinds in PAGE_SECTIONS)
_KIND_SECTION = {kind: heading for heading, kinds in PAGE_SECTIONS
                 for kind in kinds}

# Ein Datums- oder Versionsanhang am Dateinamen, der zwei Fassungen derselben
# Sache trennt: `STATUS.md` und `STATUS-2026-08.md` sind dasselbe Dokument in
# zwei Ständen, und nur der neuere wird kopiert.
_VERSION_SUFFIX_RE = re.compile(
    r"[-_ ]?(?:v?\d+(?:[._]\d+)*|\d{4}(?:[-_]\d{2}){0,2})$", re.IGNORECASE)


def _generated(text: str) -> str | None:
    """Warum dieser Text Maschinenausgabe ist, oder None.

    Zwei Merkmale, beide aus vorhandenem Code: ein Erzeuger-Feld im
    Frontmatter, und der Rauschfilter der Segmentierung, der Codezäune, JSON
    und Befehlsausgaben schon für den Korpus erkennt.
    """
    fields, _body = parse_frontmatter(text)
    for key in fields:
        if key == shadow_mod.GENERATED_FIELD or key.startswith("gardener-"):
            return f"erzeugt ({key})"
    reason = segment_mod.classify_noise(text)
    return f"maschinell ({reason})" if reason else None


def _stem_key(path: Path) -> str:
    return _VERSION_SUFFIX_RE.sub("", path.stem.strip().lower())


@dataclass
class FileVerdict:
    path: Path
    project: str
    rel: str
    chars: int
    take: str
    reason: str

    def to_dict(self) -> dict:
        return {"project": self.project, "rel": self.rel, "chars": self.chars,
                "take": self.take, "reason": self.reason}


def judge_file(source: corpus.Source, text: str, *,
               newer_same_stem: bool = False) -> FileVerdict:
    """Das Werttor aus Abschnitt 8, je Datei, in der Reihenfolge, in der es
    zählt: erst die Sicherheit, dann der Wert, dann die Größe.

    Kopiert wird nur handgeschriebene Prosa über
    `PROJECT_VALUE_MIN_CHARS` Zeichen, die keine neuere Fassung neben sich hat.
    Alles Große bleibt eine Sidecar-Notiz, die die Datei beschreibt, statt sie
    zu holen - der Vault soll nicht wachsen, er soll wissen, wo etwas steht.
    """
    project, rel = source.quell_id.split(":", 1)[1].split("/", 1)
    chars = len(text)

    def verdict(take: str, reason: str) -> FileVerdict:
        return FileVerdict(path=source.path, project=project, rel=rel,
                           chars=chars, take=take, reason=reason)

    if secrets_scan.path_blocked(source.path.name):
        return verdict(TAKE_SKIP, "Geheimnis-Tor: Dateiname")
    if secrets_scan.content_hit(text):
        return verdict(TAKE_SKIP, "Geheimnis-Tor: Inhalt")
    if instruction_shaped(text):
        return verdict(TAKE_SKIP, "anweisungsartig (Regel 8)")

    # Die Laenge steht VOR der Maschinenpruefung, und das ist kein Zufall:
    # `classify_noise` zaehlt unter anderem Woerter und nennt eine Datei mit
    # drei Woertern "zu wenig Prosa". Andersherum bekaeme jede Kurzdatei eine
    # Sidecar-Notiz, und eine Notiz ueber acht Zeichen ist genau das Rauschen,
    # das Abschnitt 8 aus dem Vault heraushalten will.
    if chars < dcfg.PROJECT_VALUE_MIN_CHARS:
        return verdict(TAKE_SKIP, f"unter {dcfg.PROJECT_VALUE_MIN_CHARS} Zeichen")
    machine = _generated(text)
    if machine:
        return verdict(TAKE_SIDECAR, machine)
    if newer_same_stem:
        return verdict(TAKE_SIDECAR, "von einer neueren Fassung abgeloest")
    if chars > dcfg.PROJECT_COPY_MAX_CHARS:
        return verdict(TAKE_SIDECAR,
                       f"ueber {dcfg.PROJECT_COPY_MAX_CHARS} Zeichen")
    return verdict(TAKE_COPY, "handgeschriebene Prosa")


def instruction_shaped(text: str) -> bool:
    """Regel 8 schon beim Einlesen, über dasselbe Muster, das der Applier
    benutzt. Ein zweites Muster hier wäre zwei Wahrheiten über dieselbe
    Frage."""
    from .apply import _INSTRUCTION_RE
    return bool(_INSTRUCTION_RE.search(text))


# ---------------------------------------------------------------------------
# Die Projektseite
# ---------------------------------------------------------------------------

def page_rel(project: str) -> str:
    """`20-projects/<name>/<name>-traum.md`. Der Zweig existiert und trägt 164
    handgeschriebene Notizen; die Traum-Seite bekommt einen eigenen Namen, statt
    sich an einen bestehenden zu hängen."""
    return f"{dcfg.PROJECT_PAGE_DIR}/{shadow_mod.slug(project)}/" \
           f"{shadow_mod.slug(project)}-traum.md"


def project_of(source: str) -> str | None:
    """Das Projekt einer Aussage, oder None, wenn sie nicht aus `~/AI` kommt."""
    text = str(source or "")
    if not text.startswith(f"{corpus.SOURCE_PROJECT_DOC}:"):
        return None
    rest = text.split(":", 1)[1]
    project = rest.split("/", 1)[0].strip()
    return project or None


def sectioned_lines(claims: list[dict], today: str,
                    supersedes: dict | None = None) -> list[str]:
    """Die Zeilen einer Projektseite, nach `kind` gruppiert und unter feste
    Überschriften gestellt. Jede einzelne Zeile ist unverändert das, was
    `render_claim` erzeugt - die Gruppierung ordnet nur an."""
    by_section: dict[str, list[str]] = {}
    for claim in claims:
        heading = _KIND_SECTION.get(str(claim.get("kind") or ""),
                                    PAGE_SECTIONS[0][0])
        by_section.setdefault(heading, []).append(
            shadow_mod.render_claim(claim, today, supersedes=supersedes))
    out: list[str] = []
    for heading, _kinds in PAGE_SECTIONS:
        lines = by_section.get(heading)
        if not lines:
            continue
        if out:
            out.append("")
        out.append(heading)
        out.extend(lines)
    return out


# ---------------------------------------------------------------------------
# Sidecar-Notizen: die Datei beschreiben, statt sie zu holen
# ---------------------------------------------------------------------------

SIDECAR_INTRO = ("Beschreibt eine Projektdatei, die der Traum bewusst NICHT "
                 "kopiert hat. Der Inhalt bleibt an seinem Ort; hier steht nur, "
                 "wo er liegt und warum er hier nicht steht.")


def sidecar_rel(project: str, rel: str) -> str:
    return (f"{dcfg.PROJECT_PAGE_DIR}/{shadow_mod.slug(project)}/"
            f"quelle-{shadow_mod.slug(rel)}.md")


def sidecar_text(verdict: FileVerdict, today: str) -> str:
    """Die Sidecar-Notiz. Sie trägt keinen Satz aus der Datei - was hier steht,
    ist Buchhaltung: Pfad, Größe, Grund. Damit kann sie auch keine Aussage
    ohne Zitat in den Vault tragen."""
    fields = {"title": f"{verdict.project}: {verdict.rel}",
              "type": "note", "class": "derived",
              # Eine Sidecar-Notiz beschreibt eine Datei; ueber deren Inhalt
              # sagt sie nichts, was jemand gemessen haette.
              dcfg.BELEG_FIELD: dcfg.BELEG_BERICHTET,
              shadow_mod.GENERATED_FIELD: today,
              "source-path": str(verdict.path)}
    body = [SIDECAR_INTRO, "",
            f"- Projekt: {verdict.project}",
            f"- Datei: `{verdict.rel}`",
            f"- Pfad: `{verdict.path}`",
            f"- Groesse: {verdict.chars} Zeichen",
            f"- Nicht kopiert, weil: {verdict.reason}"]
    return frontmatter_render(fields) + "\n" + "\n".join(body) + "\n"


# ---------------------------------------------------------------------------
# Der Lauf
# ---------------------------------------------------------------------------

@dataclass
class ProjectScan:
    projects: dict = field(default_factory=dict)     # name -> counters
    verdicts: list = field(default_factory=list)     # FileVerdict
    secret_paths: list = field(default_factory=list)  # nur Pfade, nie Werte
    files_seen: int = 0
    chars_seen: int = 0

    def note(self, verdict: FileVerdict) -> None:
        self.verdicts.append(verdict)
        p = self.projects.setdefault(verdict.project, {
            "dateien": 0, "zeichen": 0, TAKE_COPY: 0, TAKE_SIDECAR: 0,
            TAKE_SKIP: 0, "kopierte_zeichen": 0})
        p["dateien"] += 1
        p["zeichen"] += verdict.chars
        p[verdict.take] += 1
        if verdict.take == TAKE_COPY:
            p["kopierte_zeichen"] += verdict.chars

    @property
    def copies(self) -> list:
        return [v for v in self.verdicts if v.take == TAKE_COPY]

    @property
    def sidecars(self) -> list:
        return [v for v in self.verdicts if v.take == TAKE_SIDECAR]

    def to_dict(self) -> dict:
        return {"files_seen": self.files_seen, "chars_seen": self.chars_seen,
                "projects": self.projects,
                "secret_paths": self.secret_paths,
                "notes_new": len(self.copies) + len(self.sidecars)
                             + len(self.projects)}


def scan(root: Path | None = None) -> ProjectScan:
    """Jede erlaubte Projektdatei einmal ansehen und beurteilen. Liest, schreibt
    nichts - was entstünde, sagt der Bericht."""
    sources = corpus.project_doc_sources(root)
    by_project_stem: dict[tuple[str, str], list[corpus.Source]] = {}
    for source in sources:
        project = source.quell_id.split(":", 1)[1].split("/", 1)[0]
        by_project_stem.setdefault((project, _stem_key(source.path)),
                                   []).append(source)

    result = ProjectScan()
    for source in sources:
        result.files_seen += 1
        try:
            text = source.path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            log.warning("dream projects: %s nicht lesbar (%s)",
                        source.quell_id, e)
            continue
        result.chars_seen += len(text)
        project = source.quell_id.split(":", 1)[1].split("/", 1)[0]
        siblings = by_project_stem[(project, _stem_key(source.path))]
        newer = any(other.mtime > source.mtime for other in siblings)
        verdict = judge_file(source, text, newer_same_stem=newer)
        if verdict.take == TAKE_SKIP and verdict.reason.startswith("Geheimnis"):
            result.secret_paths.append(source.quell_id)
            log.warning("dream projects: Geheimnis-Tor bei %s - nur der Pfad, "
                        "nie der Wert", source.quell_id)
        result.note(verdict)
    return result


def format_scan_report(result: ProjectScan, dry_run: bool = True) -> str:
    lines = [f"dream projects{' (dry-run)' if dry_run else ''}", "",
             f"Projekte: {len(result.projects)}",
             f"Dateien gesehen: {result.files_seen}",
             f"Zeichen gesehen: {result.chars_seen}", "",
             "Je Projekt (Dateien / kopiert / sidecar / uebersprungen / "
             "kopierte Zeichen):"]
    for name in sorted(result.projects):
        p = result.projects[name]
        lines.append(f"  {name:28s} {p['dateien']:5d} {p[TAKE_COPY]:5d} "
                     f"{p[TAKE_SIDECAR]:5d} {p[TAKE_SKIP]:5d} "
                     f"{p['kopierte_zeichen']:9d}")
    lines += ["", f"Neue Notizen, wenn angewandt: {len(result.copies)} Kopien "
                  f"+ {len(result.sidecars)} Sidecars + {len(result.projects)} "
                  f"Projektseiten = "
                  f"{len(result.copies) + len(result.sidecars) + len(result.projects)}"]
    if result.secret_paths:
        lines += ["", f"Geheimnis-Tor ausgeloest ({len(result.secret_paths)}), "
                      "nur Pfade, nie Werte:"]
        lines += [f"  - {p}" for p in result.secret_paths]
    gruende: dict[str, int] = {}
    for v in result.verdicts:
        key = f"{v.take}: {v.reason.split('(')[0].strip()}"
        gruende[key] = gruende.get(key, 0) + 1
    lines += ["", "Gruende:"]
    lines += [f"  {k:44s} {n}" for k, n in sorted(gruende.items())]
    return "\n".join(lines)


def today_iso(today: dt.date | None = None) -> str:
    return (today or dt.date.today()).isoformat()
