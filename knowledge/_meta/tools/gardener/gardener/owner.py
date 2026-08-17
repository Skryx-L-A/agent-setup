"""Project ownership: which person a project branch primarily belongs to.

`10-global/shared-brain.md` requires since 2026-07-13 that every project marks
"im MOC/Frontmatter, wessen Projekt es primaer ist (Owner-Feld)". Nothing ever
wrote that field: on 2026-08-10 a search for `owner:` over all 380 notes found
zero hits. This module fills exactly the gap the rule already describes.

What the field is NOT: a permission check. Retrieval never filters on it, and no
caller may treat a missing or foreign owner as "not allowed to read". MemArena
(arXiv 2608.02613, 20.05.2026) measures that permission-aware access to agent
memory fails in both directions at today's state of the art - the oracle leaks,
everything else is too timid to answer. The field records who holds the context,
and is the precondition for ever building more than that.

The owner is inferred from who CREATED a branch's notes, read from the commit
that added each file. Where no single person reaches `OWNER_MIN_SHARE` of them,
the field is written EMPTY rather than guessed: an unclear owner has to look
unclear, otherwise the first reader turns a guess into a fact.
"""
from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import config, frontmatter, identity
from .vault import read_text

log = logging.getLogger("gardener")

MOC_NAME = "MOC.md"
PROJECT_DIR = "20-projects"


@dataclass
class OwnerResult:
    stamped: list[tuple[str, str]] = field(default_factory=list)   # (rel, person)
    empty: list[tuple[str, str]] = field(default_factory=list)     # (rel, reason)
    kept: list[str] = field(default_factory=list)      # already had the field
    skipped: list[tuple[str, str]] = field(default_factory=list)   # (rel, reason)


def _git(vault: Path, *args: str) -> str:
    """git output, or "" when git is unavailable or the call fails."""
    try:
        done = subprocess.run(["git", "-C", str(vault), *args],
                              capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("git %s failed: %s", " ".join(args), e)
        return ""
    if done.returncode != 0:
        return ""
    return done.stdout


def creator_of(vault: Path, rel: str) -> str | None:
    """The git author identity of the commit that ADDED this file.

    `--follow` is load-bearing, not decoration: without it a move re-attributes
    the note to whoever moved it. Measured on 2026-08-10 against the real vault -
    the Brain-4 reshuffle moved ein Mitnutzer's <fremde-sitzung> session note into
    `claude-setup/sessions/`, and the plain query credited that note to the
    person who ran the reshuffle.
    """
    out = _git(vault, "log", "--follow", "--diff-filter=A", "--format=%an <%ae>",
               "--", rel)
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    return lines[-1] if lines else None       # oldest add wins


def person_of(author: str | None) -> str | None:
    """Map a git author identity to a `40-people/` slug, or None if unknown.

    Matched on the full `Name <mail>` identity, never on the mail alone: per
    [[person-2]] the account mail is shared between both people and explicitly
    "kein Identitaetsbeweis". An identity that is not in the table makes the
    project unclear - which is the point, not a defect.
    """
    if not author:
        return None
    return config.PERSON_BY_GIT_AUTHOR.get(author.strip())


def project_notes(vault: Path, project: str) -> list[str]:
    """Vault-relative paths of the project's notes, without its own MOC."""
    base = vault / PROJECT_DIR / project
    return sorted(p.relative_to(vault).as_posix()
                  for p in base.rglob("*.md") if p.name != MOC_NAME)


def infer_owner(vault: Path, project: str) -> tuple[str | None, str]:
    """(person slug or None, reason). None means: leave the field empty."""
    notes = project_notes(vault, project)
    if not notes:
        return None, "keine Notizen im Zweig"
    tally: dict[str, int] = {}
    unresolved = 0
    for rel in notes:
        person = person_of(creator_of(vault, rel))
        if person is None:
            unresolved += 1
        else:
            tally[person] = tally.get(person, 0) + 1
    if not tally:
        return None, f"kein Ersteller zuzuordnen ({len(notes)} Notizen)"
    top, count = max(tally.items(), key=lambda kv: kv[1])
    share = count / len(notes)
    detail = (f"{count}/{len(notes)} Notizen"
              + (f", {unresolved} ohne zuordenbaren Ersteller" if unresolved else ""))
    if share < config.OWNER_MIN_SHARE:
        return None, f"kein klarer Mehrheits-Ersteller: {top} nur {detail}"
    return top, detail


def has_owner(text: str) -> bool:
    fields, _body = frontmatter.parse(text)
    return "owner" in fields


def stamp(text: str, person: str | None) -> str:
    """Insert `owner:` into the frontmatter, leaving everything else alone.

    Prose is never touched, field order is preserved and an existing `owner:` is
    kept whatever it says - a human decision outranks an inference.
    """
    if has_owner(text):
        return text
    parts = identity.split_frontmatter(text)
    if not parts:
        return text
    fm, rest = parts
    lines = fm.splitlines()
    entry = f"owner: {person}" if person else "owner:"
    for anchor in ("branch", "type"):
        for i, line in enumerate(lines):
            if line.startswith(f"{anchor}:"):
                lines = lines[:i + 1] + [entry] + lines[i + 1:]
                return "---\n" + "\n".join(lines) + "\n" + rest
    return "---\n" + "\n".join(lines + [entry]) + "\n" + rest


def run_owner(vault: Path, writer) -> OwnerResult:
    """Stamp `owner:` into every project MOC that has no such field yet."""
    res = OwnerResult()
    base = vault / PROJECT_DIR
    if not base.is_dir():
        return res
    for moc in sorted(base.glob(f"*/{MOC_NAME}")):
        rel = moc.relative_to(vault).as_posix()
        project = moc.parent.name
        old = read_text(moc)
        blocks, _body = frontmatter.split_blocks(old)
        if len(blocks) != 1:
            res.skipped.append((rel, f"{len(blocks)} Frontmatter-Bloecke"))
            continue
        if has_owner(old):
            res.kept.append(rel)
            continue
        person, reason = infer_owner(vault, project)
        new = stamp(old, person)
        if new == old:
            res.skipped.append((rel, "Frontmatter nicht lesbar"))
            continue
        if not writer.write(moc, new, expect=old):
            res.skipped.append((rel, "auf Platte geaendert - nicht ueberschrieben"))
            continue
        if person:
            res.stamped.append((rel, person))
        else:
            res.empty.append((rel, reason))
    log.info("owner: %d gestempelt, %d leer, %d unveraendert, %d uebersprungen",
             len(res.stamped), len(res.empty), len(res.kept), len(res.skipped))
    return res
