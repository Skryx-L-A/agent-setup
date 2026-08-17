"""Wer gilt als Waise - EINE Definition für alle, die danach fragen.

Es gab zwei, und beide waren auf dieselbe Art falsch:

- `brain stats` zählte Quellnotizen mit, die bauartbedingt keinen eingehenden Link
  haben, und übersah die über hundert Verweise aus `INDEX.md`, weil die Datei nicht
  im Notizkorpus steht.
- Der Gardener stellte dieselben Notizen in die Review-Queue und sah zusätzlich die
  Links aus den Hub-Seiten nicht, weil `MOC.md` aus SEINEM Korpus ausgeschlossen ist
  (gemessen 2026-07-29 an `macos-steam-civ6-damaged-fix.md`, auf die
  `30-topics/macos-setup/MOC.md` zeigt).

Zwei Definitionen an zwei Orten driften auseinander; deshalb steht sie hier einmal.
"""
from __future__ import annotations

from pathlib import Path

from .vault import WIKILINK_RE, Note, key_of, read_text

# Zeigerdateien, die selbst nicht im Notizkorpus stehen, deren Verweise aber
# zaehlen: eine Notiz, die dort genannt wird, ist erreichbar.
CATALOG_ROOT_FILES = ("INDEX.md", "CRITICAL-FACTS.md", "HOT.md")
CATALOG_ANY_DEPTH = ("MOC.md", "DECISIONS.md")

# NICHT dabei: review-queue.md. Sie verlinkt Waisen, WEIL sie Waisen sind - als
# eingehender Verweis gezaehlt loeschte sie genau den Befund aus, fuer den sie da
# ist. Ebenso die erzeugten Berichte (gardener-report-*, brain-health-*).
EXCLUDED_FROM_CATALOG = ("review-queue.md",)


def catalog_incoming(vault: Path) -> set[str]:
    """Verweisziele der Zeigerdateien ausserhalb des Notizkorpus."""
    targets: set[str] = set()
    paths = [vault / name for name in CATALOG_ROOT_FILES]
    for name in CATALOG_ANY_DEPTH:
        paths += [p for p in vault.rglob(name) if not p.is_symlink()]
    for p in paths:
        if p.is_file() and p.name not in EXCLUDED_FROM_CATALOG:
            targets |= {key_of(t) for t in WIKILINK_RE.findall(read_text(p))}
    return targets


def is_source_layer(note: Note) -> bool:
    """Quellschicht: Rohmaterial, das ueber die Suche gefunden wird, nicht ueber Links.

    Gelesen aus dem `class:`-Frontmatter der Notiz, das die Brain-4-Migration in
    jede Notiz geschrieben hat - nicht aus dem Pfad neu abgeleitet, damit es keine
    zweite Definition der Schicht gibt.
    """
    return str(note.fm.get("class") or "").strip() == "source"


def incoming_keys(notes: list[Note], vault: Path | None = None) -> set[str]:
    keys: set[str] = set()
    for n in notes:
        keys |= n.links
    if vault is not None:
        keys |= catalog_incoming(vault)
    return keys


def unreachable(notes: list[Note], vault: Path | None = None) -> list[Note]:
    """Notizen, auf die niemand zeigt - Quellschicht ausgenommen."""
    incoming = incoming_keys(notes, vault)
    return [n for n in notes
            if not is_source_layer(n)
            and n.title_key not in incoming and n.stem_key not in incoming]
