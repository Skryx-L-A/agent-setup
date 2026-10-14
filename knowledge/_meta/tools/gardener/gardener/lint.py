"""Entity lint: the checks that keep the vault honest.

Dead wikilinks, stale `Stand:` markers, expired `review-after:` TTLs, orphans,
dead asset paths, MOC completeness, oversized notes and duplicate frontmatter
blocks (Basic-Memory prepends its own) and Schema-4 violations (`schema.py`: mandatory
fields, type vocabulary, class against path; new notes counted apart from the stock). Findings land in the health report; the
actionable ones additionally in the review-queue.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from . import config, frontmatter, schema
from .audit import dead_links, fuzzy_key, memory_target_keys, stale_claims, stale_months_for
from .heat import cold_notes
from .ingest import asset_file
from .maintain import find_orphans
from .queue import ReviewQueue
from .vault import Note, WIKILINK_RE, key_of, read_text

log = logging.getLogger("gardener")

MONTH_RE = re.compile(r"^\d{4}-\d{2}$")

# kinds that are worth bothering der Nutzer with directly. cold-note is NOT in
# here: maintenance queues those (capped), the report lists them all.
QUEUE_KINDS = ("dead-asset-path", "review-after-expired")

# Pruefstatus kanonischer Seiten (b6-verifikation, Guru-/Notion-Prinzip): kanonisch sind Notizen
# mit `type: system|decision|pitfall|term` und alle KERN.md/STATUS.md. `brain pruefen` setzt
# `verified`/`verified-by`/`review-after`; hier wird der Bestand gezaehlt und die faelligen Seiten
# landen gedeckelt in der Review-Queue. Die Suche liest das Signal bewusst noch nicht (erst nach
# gepaarter Messung).
KANONISCH_TYPEN = frozenset({"system", "decision", "pitfall", "term"})
KANONISCH_DATEIEN = frozenset({"KERN.md", "STATUS.md"})
PRUEF_KIND = "pruefung-faellig"
PRUEF_WOCHENLIMIT = 10
PRUEF_MONATE = 3
_VERIFIED_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_QUEUE_ZEILE_RE = re.compile(r"^- (\d{4}-\d{2}-\d{2}): Lint \[" + re.escape(PRUEF_KIND) + r"\]", re.M)


@dataclass(frozen=True)
class Finding:
    kind: str
    rel: str
    detail: str


def _month_index(value: str) -> int | None:
    if not MONTH_RE.match(value):
        return None
    y, m = value.split("-")
    return int(y) * 12 + int(m)


def expired_reviews(notes: list[Note], today: dt.date | None = None) -> list[Finding]:
    today = today or dt.date.today()
    now = today.year * 12 + today.month
    out = []
    for n in notes:
        raw = str(n.fm.get("review-after") or "").strip()
        idx = _month_index(raw)
        if idx is not None and idx <= now:
            out.append(Finding("review-after-expired", n.rel,
                               f"review-after: {raw} ist erreicht/ueberschritten"))
    return out


def ist_kanonisch(n: Note) -> bool:
    parts = Path(n.rel).parts
    if config.STAGING_DIR in parts[:1] or "sessions" in parts:
        return False
    if n.ntype == "session":
        return False
    return n.ntype in KANONISCH_TYPEN or parts[-1] in KANONISCH_DATEIEN


def _review_faellig(raw: str, today: dt.date) -> bool:
    """`review-after` ist erreicht: Monat (`JJJJ-MM`, Vault-Konvention) oder Tag (`JJJJ-MM-TT`)."""
    raw = raw.strip()
    idx = _month_index(raw)
    if idx is not None:
        return idx <= today.year * 12 + today.month
    try:
        return dt.date.fromisoformat(raw) <= today
    except ValueError:
        return False


def pruef_status(notes: list[Note], today: dt.date | None = None) -> dict:
    """Bestand des Pruefstatus. `verifiziert` = gueltiges `verified`-Datum UND `review-after`
    nicht erreicht (abgelaufene Seiten verlieren das Haekchen, Notion-Prinzip); `faellig` =
    `review-after` erreicht; `nie` = kein gueltiges `verified`. Listen sind Pfade, sortiert."""
    today = today or dt.date.today()
    kanon = sorted((n for n in notes if ist_kanonisch(n)), key=lambda n: n.rel)
    faellig, nie, gueltig = [], [], []
    for n in kanon:
        verified = _VERIFIED_RE.match(str(n.fm.get("verified") or "").strip()) is not None
        due = _review_faellig(str(n.fm.get("review-after") or ""), today)
        if due:
            faellig.append(n.rel)
        if not verified:
            nie.append(n.rel)
        elif not due:
            gueltig.append(n.rel)
    return {"kanonisch": len(kanon), "verifiziert": len(gueltig), "faellig": faellig, "nie": nie}


def pruefung_faellig(notes: list[Note], today: dt.date | None = None) -> list[Finding]:
    """Kanonische Seiten mit erreichtem `review-after`, aelteste Frist zuerst."""
    today = today or dt.date.today()
    rows = []
    for n in notes:
        raw = str(n.fm.get("review-after") or "").strip()
        if ist_kanonisch(n) and _review_faellig(raw, today):
            rows.append((raw, n.rel))
    return [Finding(PRUEF_KIND, rel, f"review-after: {raw} erreicht - `brain pruefen {rel}`")
            for raw, rel in sorted(rows)]


def dead_asset_paths(vault: Path, notes: list[Note]) -> list[Finding]:
    out = []
    for n in notes:
        if n.ntype != "asset":
            continue
        target = asset_file(vault, n)
        if target is None:
            out.append(Finding("dead-asset-path", n.rel, "kein `path:` im Frontmatter"))
        elif not target.exists():
            out.append(Finding("dead-asset-path", n.rel,
                               f"Datei fehlt: {n.fm.get('path')}"))
    return out


def moc_gaps(vault: Path, notes: list[Note]) -> list[Finding]:
    """Notes of a project branch that its MOC does not link (directly)."""
    by_project: dict[str, list[Note]] = {}
    for n in notes:
        parts = Path(n.rel).parts
        if len(parts) >= 3 and parts[0] == "20-projects":
            by_project.setdefault(parts[1], []).append(n)
    out = []
    for proj, proj_notes in sorted(by_project.items()):
        moc = vault / "20-projects" / proj / "MOC.md"
        if not moc.exists():
            out.append(Finding("moc-missing", f"20-projects/{proj}",
                               "Projekt hat keine MOC.md"))
            continue
        links = {key_of(t) for t in WIKILINK_RE.findall(read_text(moc))}
        for n in sorted(proj_notes, key=lambda x: x.rel):
            if not (n.keys & links):
                out.append(Finding("moc-gap", n.rel,
                                   f"nicht von 20-projects/{proj}/MOC.md verlinkt"))
    return out


def missing_owner(vault: Path) -> list[Finding]:
    """Project MOCs without the `owner:` field `shared-brain.md` requires.

    Read from disk rather than from `notes`, because MOC.md is excluded from the
    corpus (config.EXCLUDE_ANY_DEPTH). Only the presence of the key is checked:
    an empty `owner:` is a recorded "unclear", not an omission, and must not
    keep alarming - a check that fires on an answered question trains its reader
    to stop looking.
    """
    out = []
    base = vault / "20-projects"
    if not base.is_dir():
        return out
    for moc in sorted(base.glob("*/MOC.md")):
        fields, _body = frontmatter.parse(read_text(moc))
        if "owner" not in fields:
            out.append(Finding("missing-owner", moc.relative_to(vault).as_posix(),
                               "kein `owner:` im Frontmatter (shared-brain.md, "
                               "13.07.2026) - `gardener --phase owner` fuellt es"))
    return out


def token_estimate(text: str) -> int:
    _fm, body = frontmatter.parse(text)
    return int(len(body.split()) * config.TOKENS_PER_WORD)


def oversized(notes: list[Note],
              max_tokens: int = config.NOTE_MAX_TOKENS) -> list[Finding]:
    out = []
    for n in notes:
        if n.ntype in ("session", "report"):   # archives may be long
            continue
        est = token_estimate(n.text)
        if est > max_tokens:
            out.append(Finding("oversized", n.rel,
                               f"~{est} Tokens (> {max_tokens}) - Split vorschlagen: "
                               "Kernaussagen in Themen-Note, Details in Unter-Note"))
    return out


def duplicate_frontmatter(notes: list[Note]) -> list[Finding]:
    out = []
    for n in notes:
        blocks, _body = frontmatter.split_blocks(n.text)
        if len(blocks) > 1:
            out.append(Finding("duplicate-frontmatter", n.rel,
                               f"{len(blocks)} Frontmatter-Bloecke (Basic-Memory-Sync); "
                               "Felder werden gemerged gelesen"))
    return out


def missing_beleg(notes: list[Note]) -> list[Finding]:
    """Der epistemische Status fehlt oder traegt einen unbekannten Wert.

    Gefordert wird er NUR dort, wo er hingehoert: auf Seiten, die der Traum
    selbst erzeugt hat (`dream-generated` im Frontmatter). Handgeschriebene
    Notizen bleiben unangetastet - sie rueckwirkend umzuschreiben waere ein
    Massen-Edit an fremdem Text, und der ist tabu. Wer das Feld bei einer
    eigenen Notiz setzen will, darf; verlangt wird es nicht.

    Zwei Werte, nicht fuenf: `gemessen` oder `berichtet`. Die Begruendung
    steht in `gardener/dream/config.py` bei BELEG_FIELD - ein Feld mit fuenf
    Abstufungen pflegt niemand.
    """
    from .dream import config as dcfg
    out = []
    for n in notes:
        if dcfg.GENERATED_FIELD_LINT not in n.fm:
            continue
        raw = str(n.fm.get(dcfg.BELEG_FIELD) or "").strip()
        if not raw:
            out.append(Finding("beleg-missing", n.rel,
                               f"`{dcfg.BELEG_FIELD}:` fehlt "
                               f"({' | '.join(dcfg.BELEG_VALUES)})"))
        elif raw not in dcfg.BELEG_VALUES:
            out.append(Finding("beleg-unknown", n.rel,
                               f"`{dcfg.BELEG_FIELD}: {raw}` ist keiner der "
                               f"zwei Werte {' | '.join(dcfg.BELEG_VALUES)}"))
    return out


def schema_findings(notes: list[Note], stichtag: str = schema.STICHTAG) -> list[Finding]:
    """Schema-4-Verstoesse, je Notiz ein Befund: `schema-neu` (created ab Stichtag) getrennt von
    `schema-bestand`, damit der Altbestand die neuen Verstoesse nicht zudeckt. Doppelte
    Frontmatter-Bloecke meldet `duplicate_frontmatter` schon, sie zaehlen hier nicht doppelt."""
    out = []
    for n in notes:
        if not schema.im_geltungsbereich(n.rel):
            continue
        befunde = [b for b in schema.pruefe(n.rel, n.text) if b.kind != "mehrfach-frontmatter"]
        if befunde:
            kind = "schema-neu" if schema.ist_neu(n.text, stichtag) else "schema-bestand"
            out.append(Finding(kind, n.rel, "; ".join(b.detail for b in befunde)))
    return out


def run_lint(vault: Path, notes: list[Note], heat: dict | None = None,
             today: dt.date | None = None) -> list[Finding]:
    today = today or dt.date.today()
    findings: list[Finding] = []
    memory = memory_target_keys()
    for rel, target in dead_links(notes, vault):
        mem = memory.get(fuzzy_key(target))
        if mem:
            findings.append(Finding("memory-ziel", rel,
                                    f"[[{target}]] liegt im Claude-Auto-Memory: "
                                    f"{mem.replace(str(Path.home()), '~')}"))
        else:
            findings.append(Finding("dead-link", rel, f"[[{target}]] zeigt ins Leere"))
    months = {n.rel: stale_months_for(n) for n in notes}
    findings += [Finding("stale-stand", rel,
                         f"Stand: {stamp} ist aelter als {months[rel]} Monate")
                 for rel, stamp in stale_claims(notes, today=today)]
    findings += expired_reviews(notes, today)
    findings += pruefung_faellig(notes, today)
    findings += [Finding("orphan", n.rel, "keine Links ein/aus")
                 for n in find_orphans(notes)]
    findings += dead_asset_paths(vault, notes)
    findings += moc_gaps(vault, notes)
    findings += missing_owner(vault)
    findings += oversized(notes)
    findings += duplicate_frontmatter(notes)
    findings += missing_beleg(notes)
    findings += schema_findings(notes)
    findings += [Finding("cold-note", n.rel,
                         f"seit >{config.COLD_MONTHS} Monaten nicht gelesen")
                 for n in cold_notes(notes, heat or {})]
    return findings


def queue_findings(findings: list[Finding], queue: ReviewQueue,
                   today: dt.date | None = None) -> list[Finding]:
    queued = []
    today = today or dt.date.today()
    # Kanonische Seiten laufen ueber den gedeckelten Pruefweg, nicht doppelt ueber die TTL-Meldung.
    pruef_rels = {f.rel for f in findings if f.kind == PRUEF_KIND}
    seit = today - dt.timedelta(days=7)
    diese_woche = sum(1 for m in _QUEUE_ZEILE_RE.finditer(queue.existing)
                      if dt.date.fromisoformat(m.group(1)) > seit)
    for f in findings:
        if f.kind == PRUEF_KIND:
            if diese_woche >= PRUEF_WOCHENLIMIT:
                continue
            if queue.add(f"Lint [{f.kind}] {f.rel}: {f.detail}", today=today):
                queued.append(f)
                diese_woche += 1
            continue
        if f.kind not in QUEUE_KINDS:
            continue
        if f.kind == "review-after-expired" and f.rel in pruef_rels:
            continue
        if queue.add(f"Lint [{f.kind}] {f.rel}: {f.detail}",
                     key=f"Lint [{f.kind}] {f.rel}", today=today):
            queued.append(f)
    return queued
