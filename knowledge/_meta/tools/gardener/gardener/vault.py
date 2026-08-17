"""Vault access: note discovery, parsing, and the single write gate.

Every write to the vault MUST go through VaultWriter.write(), which enforces
the safety rules (inside vault, .md only, no excluded directories).
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from . import config, frontmatter, identity

log = logging.getLogger("gardener")

WIKILINK_RE = re.compile(r"\[\[([^\]|#\n]+)")
TITLE_RE = re.compile(r"^title:\s*(.+?)\s*$", re.MULTILINE)
TYPE_RE = re.compile(r"^type:\s*(\S+)", re.MULTILINE)
STAND_RE = re.compile(r"Stand:\s*(\d{4})-(\d{2})")

# macOS filesystems are case-insensitive: compare exclusion rules casefolded.
_EXCLUDE_DIRS_CF = {d.casefold() for d in config.EXCLUDE_DIRS}
_EXCLUDE_FILES_CF = {f.casefold() for f in config.EXCLUDE_FILES}


class UnsafeWriteError(Exception):
    pass


class _NoCheck:
    """Sentinel: write unconditionally (generated files the gardener owns)."""

    def __repr__(self) -> str:
        return "NO_CHECK"


NO_CHECK = _NoCheck()


def key_of(value: str) -> str:
    """Comparison key for titles/stems/wikilink targets.

    macOS stores filenames decomposed (NFD) while frontmatter titles and
    wikilinks are typed composed (NFC): without normalizing, `[[Härtung]]` never
    resolves to `Härtung.md` and every such link is reported dead.
    """
    return unicodedata.normalize("NFC", value).strip().lower()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


@dataclass
class Note:
    path: Path          # absolute
    rel: str            # relative to vault root, posix
    title: str
    text: str           # full file content
    links: set[str] = field(default_factory=set)  # normalized targets
    ntype: str = "note"  # frontmatter `type:`; session notes are immutable
    fm: dict = field(default_factory=dict)        # merged frontmatter fields
    aliases: list[str] = field(default_factory=list)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()

    @property
    def stem_key(self) -> str:
        return key_of(self.path.stem)

    @property
    def title_key(self) -> str:
        return key_of(self.title)

    @property
    def alias_keys(self) -> set[str]:
        return {key_of(a) for a in self.aliases if a}

    @property
    def keys(self) -> set[str]:
        return {self.title_key, self.stem_key} | self.alias_keys

    @property
    def branch(self) -> str:
        """Owning branch: `10-global`, `20-projects/<p>`, `30-topics/<t>`, ..."""
        parts = Path(self.rel).parts
        if len(parts) >= 3 and parts[0] in ("20-projects", "30-topics"):
            return f"{parts[0]}/{parts[1]}"
        return parts[0] if len(parts) > 1 else ""

    @property
    def embed_text(self) -> str:
        """Text handed to the embedding model. Notes without aliases keep the
        historic format so the content-hash cache stays valid."""
        if self.aliases:
            return f"{self.title}\naliases: {', '.join(self.aliases)}\n\n{self.text}"
        return f"{self.title}\n\n{self.text}"


def is_excluded(rel: Path) -> bool:
    """True if this vault-relative path must never be touched."""
    parts = rel.parts
    if not parts:
        return True
    if any(p.casefold() in _EXCLUDE_DIRS_CF or p.startswith(".") for p in parts[:-1]):
        return True
    name = parts[-1]
    if len(parts) == 1 and name.casefold() in _EXCLUDE_FILES_CF:
        return True
    # Generated files at any depth: never part of the corpus.
    if name in config.EXCLUDE_ANY_DEPTH or name.startswith(config.EXCLUDE_PREFIXES):
        return True
    # The drop zone is raw input for the ingest phase, not corpus.
    if Path(*parts[:-1]).as_posix().startswith(config.DROP_DIR):
        return True
    return False


def check_writable(vault: Path, path: Path) -> None:
    """Raise UnsafeWriteError unless path is a safe .md target inside the vault.

    Generated files (review-queue, reports, HOT.md, MOC.md) are writable but
    excluded from the corpus, so this is looser than is_excluded: only the
    hard rules apply (inside vault, .md-only, no excluded dirs).
    """
    path = path.resolve() if path.is_absolute() else (vault / path).resolve()
    vault = vault.resolve()
    try:
        rel = path.relative_to(vault)
    except ValueError:
        raise UnsafeWriteError(f"outside vault: {path}")
    if path.suffix != ".md":
        raise UnsafeWriteError(f"not markdown: {path}")
    if any(p.casefold() in _EXCLUDE_DIRS_CF or p.startswith(".") for p in rel.parts[:-1]):
        raise UnsafeWriteError(f"excluded directory: {rel}")


def check_asset_writable(vault: Path, path: Path) -> None:
    """Raise UnsafeWriteError unless path is a binary asset target inside a
    branch `_assets/` folder of the vault."""
    path = path.resolve() if path.is_absolute() else (vault / path).resolve()
    vault = vault.resolve()
    try:
        rel = path.relative_to(vault)
    except ValueError:
        raise UnsafeWriteError(f"outside vault: {path}")
    if any(p.casefold() in _EXCLUDE_DIRS_CF or p.startswith(".") for p in rel.parts[:-1]):
        raise UnsafeWriteError(f"excluded directory: {rel}")
    if config.ASSET_DIR not in rel.parts[:-1]:
        raise UnsafeWriteError(f"not an _assets/ target: {rel}")


class VaultWriter:
    """Single write gate. In dry-run mode it records planned writes instead."""

    def __init__(self, vault: Path, dry_run: bool = False, foreign=()):
        self.vault = Path(vault)
        self.dry_run = dry_run
        self.written: list[str] = []
        self.planned: list[str] = []
        self.conflicts: list[str] = []
        # Pfade, an denen jemand anderes uncommittet arbeitet. Sie werden am
        # Tor abgewiesen, nicht am Ende beim Committen aussortiert: haette der
        # Lauf erst hineingeschrieben, stuende die fremde halbfertige Fassung
        # in seiner eigenen Aenderung und muesste entweder mitcommittet oder
        # rueckgaengig gemacht werden. Beides ist schlechter als: nicht
        # anfassen und melden.
        self.foreign = frozenset(str(p) for p in (foreign or ()))
        self.foreign_skipped: list[str] = []

    def write(self, path: Path, text: str, expect=NO_CHECK) -> bool:
        """Write `text` to `path`. Returns False when the write was refused.

        `expect` is the content the new text was derived from. A run can take
        45 minutes; Obsidian and the Basic-Memory sync keep writing to the vault
        meanwhile. Rewriting a note from a stale in-memory copy would silently
        drop whatever they wrote (Basic-Memory stamps its own `permalink:`
        block), so a note that changed on disk - or vanished - since it was read
        is left alone and reported instead.

        Three modes, deliberately distinct:
        - `NO_CHECK` (default): unconditional. Only for files the gardener owns
          and fully regenerates (HOT.md, reports, the review-queue).
        - `None`: "I expect this file NOT to exist" - a creating write. If it
          appeared since the caller checked, someone else created it and we do
          not clobber it.
        - a string: "I expect exactly this content" - a rewrite.
        """
        check_writable(self.vault, path)
        path = path if path.is_absolute() else self.vault / path
        rel = path.resolve().relative_to(self.vault.resolve()).as_posix()
        if rel in self.foreign:
            if rel not in self.foreign_skipped:
                self.foreign_skipped.append(rel)
                log.warning("skipped %s: someone else has uncommitted work "
                            "there - not touching it", rel)
            return False
        if expect is not NO_CHECK:
            current = read_text(path) if path.exists() else None
            if current != expect:
                self.conflicts.append(rel)
                log.warning("skipped %s: %s on disk since it was read "
                            "(Obsidian / basic-memory sync?) - not overwriting",
                            rel, "appeared" if expect is None else "changed")
                return False
        # Identity is stamped at the gate, not in each writer: a writer that
        # forgets it reopens the hole the Brain 4 migration closed once
        # (see identity.py). The id is taken from whatever is on disk, so a
        # rewrite keeps the note's ULID instead of minting a second one.
        if path.suffix == ".md":
            on_disk = read_text(path) if path.exists() else ""
            text = identity.stamp(text, keep_id=identity.id_of(on_disk))
        if self.dry_run:
            self.planned.append(rel)
            log.info("dry-run: would write %s (%d bytes)", rel, len(text))
            return True
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        self.written.append(rel)
        log.info("wrote %s", rel)
        return True

    def append(self, path: Path, text: str) -> None:
        path_abs = path if path.is_absolute() else self.vault / path
        old = path_abs.read_text(encoding="utf-8") if path_abs.exists() else ""
        self.write(path, old + text)

    def move_asset(self, src: Path, dst: Path) -> None:
        """Move a binary file into a branch `_assets/` folder. Same write gate
        as write(): dry-run only records the plan."""
        check_asset_writable(self.vault, dst)
        rel = dst.resolve().relative_to(self.vault.resolve()).as_posix()
        if self.dry_run:
            self.planned.append(rel)
            log.info("dry-run: would move %s -> %s", src, rel)
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        self.written.append(rel)
        log.info("moved %s -> %s", src.name, rel)


def parse_note(vault: Path, path: Path) -> Note:
    text = read_text(path)
    fm, _body = frontmatter.parse(text)
    title = str(fm.get("title") or "").strip() or path.stem
    ntype = str(fm.get("type") or "note").strip() or "note"
    raw_aliases = fm.get("aliases") or []
    aliases = [str(a).strip() for a in raw_aliases if str(a).strip()] \
        if isinstance(raw_aliases, list) else [str(raw_aliases).strip()]
    links = {key_of(t) for t in WIKILINK_RE.findall(text)}
    return Note(path=path, rel=path.relative_to(vault).as_posix(),
                title=title, text=text, links=links, ntype=ntype,
                fm=fm, aliases=aliases)


def iter_markdown(vault: Path) -> list[Path]:
    """All corpus markdown files, symlink-safe.

    `rglob` follows directory symlinks: a link back into the vault (or into
    ~) makes the walk loop or drags foreign files into the corpus, and a
    symlinked note resolves outside the vault, where the write gate then raises
    mid-run. Symlinks are skipped entirely instead.
    """
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(vault, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith(".")
            and d.casefold() not in _EXCLUDE_DIRS_CF
            and not (here / d).is_symlink())
        for name in sorted(filenames):
            if not name.endswith(".md"):
                continue
            path = here / name
            if path.is_symlink():
                log.info("skipping symlinked note: %s", path)
                continue
            if is_excluded(path.relative_to(vault)):
                continue
            out.append(path)
    return sorted(out)


def load_notes(vault: Path) -> list[Note]:
    vault = Path(vault)
    return [parse_note(vault, path) for path in iter_markdown(vault)]


def build_resolver(notes: list[Note]) -> dict[str, Note]:
    """Map lowercase title, filename stem and frontmatter aliases to the note."""
    idx: dict[str, Note] = {}
    for n in notes:
        idx.setdefault(n.stem_key, n)
        idx.setdefault(n.title_key, n)
        for a in n.alias_keys:
            idx.setdefault(a, n)
    return idx


def linked_pair(a: Note, b: Note) -> bool:
    return bool(a.links & b.keys or b.links & a.keys)
