"""Generated index files: per-project DECISIONS.md and the vault-wide
OPEN-QUESTIONS.md. Both are fully regenerated each run (answered questions and
deleted decisions simply disappear) and are excluded from the linking corpus.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
from pathlib import Path

from .maintain import MOC_END, MOC_START, first_hook_line
from .vault import Note, VaultWriter, read_text

log = logging.getLogger("gardener")

OPEN_RE = re.compile(r"^\s*(?:[-*]\s*)?(?:OFFEN|TODO|OPEN)[:\s]\s*(.+)$",
                     re.IGNORECASE)
OPEN_HEADING_RE = re.compile(r"^#{2,6}\s*(?:Offene Fragen|Open Questions|"
                             r"Offene Punkte|Fragen)\s*$", re.IGNORECASE)
HEADING_RE = re.compile(r"^#{1,6}\s")


def _block(lines: list[str]) -> str:
    body = "\n".join(lines) or "- keine"
    return f"{MOC_START}\n{body}\n{MOC_END}"


def _write_generated(writer: VaultWriter, path: Path, header: str,
                     lines: list[str]) -> bool:
    block = _block(lines)
    new = header + block + "\n"
    if path.exists() and read_text(path) == new:
        return False
    writer.write(path, new)
    return True


def update_decisions(notes: list[Note], writer: VaultWriter,
                     today: dt.date | None = None) -> list[str]:
    """20-projects/<p>/DECISIONS.md: index of that project's type:decision notes."""
    today = today or dt.date.today()
    by_project: dict[str, list[Note]] = {}
    for n in notes:
        parts = Path(n.rel).parts
        if n.ntype == "decision" and len(parts) >= 2 and parts[0] == "20-projects":
            by_project.setdefault(parts[1], []).append(n)
    written = []
    for proj, decisions in sorted(by_project.items()):
        lines = [f"- [[{n.title}]] - {first_hook_line(n)}"
                 for n in sorted(decisions, key=lambda x: x.rel)]
        header = (f"---\ntitle: {proj} DECISIONS\ntype: report\n"
                  f"branch: 20-projects/{proj}\n---\n\n"
                  f"# {proj} - Entscheidungen\n\n"
                  f"Generiert vom Gardener {today.isoformat()}. Nicht von Hand "
                  f"editieren - Quelle sind die `type: decision`-Notes.\n\n")
        path = writer.vault / "20-projects" / proj / "DECISIONS.md"
        if _write_generated(writer, path, header, lines):
            written.append(f"20-projects/{proj}/DECISIONS.md")
    return written


def open_questions(note: Note) -> list[str]:
    """Open questions in a note: OFFEN:/TODO: lines and 'Offene Fragen' sections."""
    out: list[str] = []
    in_section = False
    for line in note.text.splitlines():
        m = OPEN_RE.match(line)
        if m:
            out.append(m.group(1).strip())
            continue
        if OPEN_HEADING_RE.match(line):
            in_section = True
            continue
        if in_section:
            if HEADING_RE.match(line):
                in_section = False
                continue
            s = line.strip()
            if s.startswith(("-", "*")):
                q = s.lstrip("-* ").strip()
                if q:
                    out.append(q)
    return out


def update_open_questions(notes: list[Note], writer: VaultWriter,
                          today: dt.date | None = None) -> tuple[bool, int]:
    today = today or dt.date.today()
    lines: list[str] = []
    total = 0
    for n in sorted(notes, key=lambda x: x.rel):
        if n.ntype == "report":
            continue
        questions = open_questions(n)
        if not questions:
            continue
        lines.append(f"- [[{n.title}]] ({n.rel})")
        for q in questions:
            lines.append(f"  - {q[:200]}")
            total += 1
    header = ("---\ntitle: OPEN-QUESTIONS\ntype: report\n---\n\n"
              "# Offene Fragen (Gardener)\n\n"
              f"Generiert {today.isoformat()} aus `OFFEN:`/`TODO:`-Zeilen und "
              "'Offene Fragen'-Sektionen aller Notes. Beantwortetes verschwindet "
              "hier automatisch, sobald es aus der Quell-Note raus ist.\n\n")
    changed = _write_generated(writer, writer.vault / "OPEN-QUESTIONS.md",
                               header, lines)
    return changed, total
