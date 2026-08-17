"""Weekly (Sunday) health audit: dead wikilinks, stale claims, gaps.
Report to 00-sources/brain-health-YYYY-WW.md."""
from __future__ import annotations

import datetime as dt
import logging
import os
from pathlib import Path

from . import config
from .vault import (Note, VaultWriter, build_resolver, key_of, parse_note,
                    STAND_RE, _EXCLUDE_DIRS_CF)

log = logging.getLogger("gardener")

# Directories whose files may never be link targets. Everything else in the
# vault is linkable even when it is excluded from the *corpus* (INDEX.md,
# HOT.md, MOC.md, DECISIONS.md, review-queue, reports): the corpus exclusion
# means "the gardener does not rewrite/judge these", not "links to them are
# dead". Using the corpus as the target universe reported 63 false dead links.
_UNLINKABLE_DIRS_CF = {"90-secrets", ".obsidian", ".git", "tools"}


def link_target_keys(vault: Path) -> set[str]:
    """Comparison keys (title/stem/aliases) of every linkable note in the vault."""
    keys: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(vault, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".")
                       and d.casefold() not in _UNLINKABLE_DIRS_CF
                       and not (here / d).is_symlink()]
        for name in filenames:
            if not name.endswith(".md") or (here / name).is_symlink():
                continue
            n = parse_note(vault, here / name)
            keys.add(n.stem_key)
            keys.add(n.title_key)
            keys.update(n.alias_keys)
    return keys


def dead_links(notes: list[Note], vault: Path | None = None) -> list[tuple[str, str]]:
    resolver = build_resolver(notes)
    known = set(resolver.keys()) | {"note"}  # template placeholder
    if vault is not None:
        known |= link_target_keys(Path(vault))
    out = []
    for n in notes:
        for target in sorted(n.links):
            if target not in known:
                out.append((n.rel, target))
    return out


def stale_claims(notes: list[Note],
                 months: int = config.STALE_MARKER_MONTHS,
                 today: dt.date | None = None) -> list[tuple[str, str]]:
    today = today or dt.date.today()
    cutoff = (today.year * 12 + today.month) - months
    out = []
    for n in notes:
        for y, m in STAND_RE.findall(n.text):
            if int(y) * 12 + int(m) < cutoff:
                out.append((n.rel, f"{y}-{m}"))
                break
    return out


LINT_SECTIONS = [
    ("dead-link", "Tote Wikilinks"),
    ("stale-stand", "Veraltete Claims (Stand-Marker)"),
    ("review-after-expired", "Abgelaufene review-after-TTLs"),
    ("orphan", "Orphans / Luecken"),
    ("dead-asset-path", "Tote Asset-Pfade"),
    ("moc-missing", "Projekte ohne MOC"),
    ("moc-gap", "Notes, die ihr Projekt-MOC nicht verlinkt"),
    ("oversized", "Zu grosse Notes (Split-Vorschlag)"),
    ("duplicate-frontmatter", "Doppelte Frontmatter-Bloecke"),
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
        lines += [f"- {f.rel}: {f.detail}" for f in by_kind.get(kind, [])] or ["- keine"]
    lines.append("")

    rel_path = f"00-sources/brain-health-{week.year}-{week.week:02d}.md"
    writer.write(writer.vault / rel_path, "\n".join(lines))
    return rel_path
