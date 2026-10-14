"""Weekly (Sunday) health audit: dead wikilinks, stale claims, gaps.
Report to 00-sources/brain-health-YYYY-WW.md."""
from __future__ import annotations

import datetime as dt
import glob
import logging
import os
import re
from pathlib import Path

from . import config
from .vault import (Note, VaultWriter, WIKILINK_RE, build_resolver, key_of,
                    parse_note, STAND_RE, _EXCLUDE_DIRS_CF)

log = logging.getLogger("gardener")

# Directories whose files may never be link targets. Everything else in the
# vault is linkable even when it is excluded from the *corpus* (INDEX.md,
# HOT.md, MOC.md, DECISIONS.md, review-queue, reports): the corpus exclusion
# means "the gardener does not rewrite/judge these", not "links to them are
# dead". Using the corpus as the target universe reported 63 false dead links.
_UNLINKABLE_DIRS_CF = {"secrets", ".obsidian", ".git", "tools"}


# Resolution like Obsidian's (Auftrag g5, 24.09.2026): of 237 dead links in
# brain-health-2026-39, 47 were false alarms - `[[20-projects/x/overview]]`
# path links, case/umlaut/hyphen variants of an existing title, a project
# folder name, template placeholders and wikilink syntax inside code. Only a
# target none of these reach is dead.
_FOLD = (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss"))
_FUZZY_SEP_RE = re.compile(r"[\s_\-\u2010-\u2015]+")
_FUZZY_DROP_RE = re.compile(r"[^\w/-]+")
_CODE_RE = re.compile(r"```.*?```|~~~.*?~~~|`[^`\n]*`", re.S)
_PLACEHOLDER_RE = re.compile(r"^(?:\W*|\w|x+|note|datei|andere-notiz|.*(?:\.\.\.|…).*)$")


def fuzzy_key(value: str) -> str:
    """Lower case, umlauts folded, any run of blanks/hyphens/underscores/dashes
    one hyphen, other punctuation dropped: `[[Myproject Deploy-Pfad: Hetzner]]`
    and `myproject-deploy-pfad-hetzner` meet."""
    k = key_of(value)
    for a, b in _FOLD:
        k = k.replace(a, b)
    k = _FUZZY_SEP_RE.sub("-", _FUZZY_DROP_RE.sub(" ", k))
    return k.strip("-/")


def is_placeholder(target: str) -> bool:
    return bool(_PLACEHOLDER_RE.match(key_of(target)))


def strip_code(text: str) -> str:
    """Wikilink syntax in code blocks and code spans is not a link (Obsidian)."""
    return _CODE_RE.sub("", text)


class LinkUniverse:
    """Every way a wikilink target can name a linkable file of the vault."""

    def __init__(self):
        self.keys: set[str] = set()     # key_of(title/stem/alias), the old test
        self.fuzzy: set[str] = set()    # fuzzy_key of the same
        self.paths: set[str] = set()    # fuzzy rel path without .md
        self.dirs: set[str] = set()     # fuzzy name of a folder holding MOC.md

    def add_note(self, n: Note) -> None:
        names = {n.path.stem, n.title, *n.aliases}
        self.keys |= {n.stem_key, n.title_key, *n.alias_keys}
        self.fuzzy |= {fuzzy_key(x) for x in names}
        self.paths.add(fuzzy_key(n.rel[:-3] if n.rel.endswith(".md") else n.rel))
        if n.path.name == "MOC.md":
            self.dirs.add(fuzzy_key(n.path.parent.name))

    def resolves(self, target: str) -> bool:
        if target in self.keys or is_placeholder(target):
            return True
        fk = fuzzy_key(target)
        if fk in self.fuzzy or fk in self.dirs:
            return True
        if "/" in fk:
            fk = fk[:-3] if fk.endswith(".md") else fk
            # Obsidian resolves a partial path by its tail: [[x/overview]]
            return any(p == fk or p.endswith("/" + fk) for p in self.paths)
        return False


def link_universe(vault: Path) -> LinkUniverse:
    uni = LinkUniverse()
    for dirpath, dirnames, filenames in os.walk(vault, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".")
                       and d.casefold() not in _UNLINKABLE_DIRS_CF
                       and not (here / d).is_symlink()]
        for name in filenames:
            if not name.endswith(".md") or (here / name).is_symlink():
                continue
            uni.add_note(parse_note(vault, here / name))
    return uni


def link_target_keys(vault: Path) -> set[str]:
    """Comparison keys (title/stem/aliases) of every linkable note in the vault."""
    return link_universe(vault).keys


def note_link_targets(n: Note) -> set[str]:
    return {key_of(t) for t in WIKILINK_RE.findall(strip_code(n.text))}


def dead_links(notes: list[Note], vault: Path | None = None) -> list[tuple[str, str]]:
    uni = link_universe(Path(vault)) if vault is not None else LinkUniverse()
    uni.keys |= set(build_resolver(notes).keys()) | {"note"}  # template placeholder
    for n in notes:
        uni.add_note(n)
    out = []
    for n in notes:
        for target in sorted(note_link_targets(n)):
            if not uni.resolves(target):
                out.append((n.rel, target))
    return out


def memory_target_keys(pattern: str | None = None) -> dict[str, str]:
    """{fuzzy slug: path} of the Claude auto-memory files (config.MEMORY_GLOB).
    A dead vault link that names one of them points at knowledge that lives
    outside the vault - input for the lessons pipeline, not a typo."""
    pattern = os.path.expanduser(pattern or config.MEMORY_GLOB)
    out: dict[str, str] = {}
    for path in sorted(glob.glob(pattern)):
        stem = Path(path).stem
        if stem.upper() == "MEMORY":
            continue
        out.setdefault(fuzzy_key(stem), path)
    return out


# Das Frontmatter-Feld `stand:` (Vorlage seit 2026-09-28) zaehlt wie ein `Stand:`-Marker im Text;
# STAND_RE (vault.py) ist gross geschrieben und sieht es nicht.
STAND_FIELD_RE = re.compile(r"^stand:\s*[\"']?(\d{4})-(\d{2})", re.M)


def stand_markers(text: str) -> list[tuple[str, str]]:
    return STAND_RE.findall(text) + STAND_FIELD_RE.findall(text)


def stale_months_for(note: Note) -> int:
    """Schwelle in Monaten je Notiz: KERN/STATUS und `type: system` kurz, der Rest lang."""
    if note.ntype in config.STALE_FAST_TYPES or Path(note.rel).name in config.STALE_FAST_NAMES:
        return config.STALE_MARKER_MONTHS_FAST
    return config.STALE_MARKER_MONTHS


def stale_claims(notes: list[Note],
                 months: int | None = None,
                 today: dt.date | None = None) -> list[tuple[str, str]]:
    """(rel, "JJJJ-MM") je Notiz mit einem `Stand:`-Marker aelter als die Schwelle.
    `months=None` nimmt die Schwelle je Notiz (`stale_months_for`), sonst eine feste."""
    today = today or dt.date.today()
    now = today.year * 12 + today.month
    out = []
    for n in notes:
        cutoff = now - (stale_months_for(n) if months is None else months)
        for y, m in stand_markers(n.text):
            if int(y) * 12 + int(m) < cutoff:
                out.append((n.rel, f"{y}-{m}"))
                break
    return out


# Abschnitte, die nur zum Teil ausgeschrieben werden: der Bestand soll den Bericht nicht fluten.
LINT_SECTION_CAP = {"schema-bestand": 10}

LINT_SECTIONS = [
    ("dead-link", "Tote Wikilinks"),
    ("memory-ziel", "Links auf Claude-Auto-Memory (Wissen ausserhalb des Vaults)"),
    ("stale-stand", "Veraltete Claims (Stand-Marker)"),
    ("review-after-expired", "Abgelaufene review-after-TTLs"),
    ("pruefung-faellig", "Kanonische Seiten mit faelliger Pruefung (brain pruefen)"),
    ("orphan", "Orphans / Luecken"),
    ("dead-asset-path", "Tote Asset-Pfade"),
    ("moc-missing", "Projekte ohne MOC"),
    ("moc-gap", "Notes, die ihr Projekt-MOC nicht verlinkt"),
    ("oversized", "Zu grosse Notes (Split-Vorschlag)"),
    ("duplicate-frontmatter", "Doppelte Frontmatter-Bloecke"),
    ("schema-neu", "Schema-Verstoesse in neuen Notizen (ab Stichtag)"),
    ("schema-bestand", "Schema-Verstoesse im Bestand (vor dem Stichtag, gedeckelt)"),
    ("cold-note", "Lange nicht gelesen (Read-Heat)"),
]


def run_audit(notes: list[Note], writer: VaultWriter,
              today: dt.date | None = None, findings: list | None = None,
              heat: dict | None = None) -> str:
    from . import lint  # local import: lint builds on this module

    today = today or dt.date.today()
    week = today.isocalendar()
    if findings is None:
        findings = lint.run_lint(writer.vault, notes, heat, today)
    by_kind: dict[str, list] = {}
    for f in findings:
        by_kind.setdefault(f.kind, []).append(f)

    lines = [
        "---",
        f"title: brain-health-{week.year}-{week.week:02d}",
        "type: report",
        "---",
        "",
        f"# Brain-Health-Audit KW {week.week:02d}/{week.year} ({today.isoformat()})",
        "",
        f"Notes: {len(notes)} | Findings: {len(findings)}",
        "",
        "Zaehlung je Kategorie: " + (", ".join(
            f"{kind}={len(by_kind.get(kind, []))}" for kind, _t in LINT_SECTIONS)),
    ]
    for kind, title in LINT_SECTIONS:
        lines += ["", f"## {title}"]
        items = by_kind.get(kind, [])
        cap = LINT_SECTION_CAP.get(kind)
        shown = items if cap is None else items[:cap]
        lines += [f"- {f.rel}: {f.detail}" for f in shown] or ["- keine"]
        if len(shown) < len(items):
            lines.append(f"- ... und {len(items) - len(shown)} weitere (nur gezaehlt)")
    lines.append("")

    rel_path = f"00-sources/brain-health-{week.year}-{week.week:02d}.md"
    writer.write(writer.vault / rel_path, "\n".join(lines))
    return rel_path
