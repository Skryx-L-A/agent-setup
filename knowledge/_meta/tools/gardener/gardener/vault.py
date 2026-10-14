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
import subprocess
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from . import config, frontmatter, identity, protect, spaces

log = logging.getLogger("gardener")

# The gardener-managed `## Relations` section (canonical definition; linking
# imports it).  Cut from embeddings and from "mentions" checks: links the
# pipeline wrote itself are not the note's own prose.
RELATIONS_RE = re.compile(r"^## Relations[ \t]*\n(?:[ \t]*-[^\n]*\n?)*",
                          re.MULTILINE)

def embed_relations() -> bool:
    """Rollback switch of the e28 rule: ``BRAIN_EMBED_RELATIONS=1`` embeds the
    ``## Relations`` section again.  The embedding cache keys carry it (see
    ``linking.cache_key``), so flipping it re-embeds instead of mixing vectors
    of both rules in one index."""
    return os.environ.get("BRAIN_EMBED_RELATIONS", "").strip() == "1"


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


# Frontmatter fields that are content and stay in the embedded text (v4);
# every other field is bookkeeping and never touches a vector.
EMBED_FM_FIELDS = ("title", "aliases", "tags", "type", "branch", "description")


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
    def body(self) -> str:
        """The note without its leading frontmatter block(s)."""
        return frontmatter.split_blocks(self.text)[1]

    @property
    def embed_hash(self) -> str:
        """Hash of exactly the text the embedding model sees: the key of every
        embedding cache (``linking.cache_key``, braincli ``einbettung``).
        Frontmatter upkeep (id, schema, class, created, status, verified, ...)
        leaves it unchanged, so it no longer invalidates vectors."""
        return hashlib.sha256(self.embed_text.encode()).hexdigest()

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
        """Text handed to the embedding model: title, aliases and the note's
        own prose -- the gardener-managed ``## Relations`` section is cut out.
        e28 (2026-09-27): the maintenance runs of 24.09. appended Relations to
        ~780 notes; every touched note's vector changed, and the vector of
        ``a machine-bound project/2026-09-15-leiteroptimierung`` sank from cosine 0.57 to
        0.51, where the recall hook cut it (MAX_HITS 3) -- the replay warning
        e28 was lost.  ``linking.mentions`` cuts the section for the same
        reason: links the pipeline wrote itself are not the note's prose.
        ``BRAIN_EMBED_RELATIONS=1`` restores the old behavior (rollback);
        ``config.EMBED_VERSION`` 3 retired the vectors of the old rule.
        v4 (b6-embedfm, 2026-09-28): the frontmatter block is cut; the
        content fields ``EMBED_FM_FIELDS`` -- title, aliases, tags, type,
        branch, description -- form the head instead.  Bookkeeping fields such
        as id/schema/class/created/status/verified/review-after change neither
        the text nor the cache key, so frontmatter upkeep no longer re-embeds
        the vault.  The head was chosen on blind200 dev (MRR 0.439 against
        0.424 tags+description only and 0.406 title+aliases only; old rule
        with the whole frontmatter 0.455, no secured loss on test)."""
        if embed_relations():
            text = self.body
        else:
            text = RELATIONS_RE.sub("", self.body)
        head = self.title
        if self.aliases:
            head += f"\naliases: {', '.join(self.aliases)}"
        tags = self.fm.get("tags")
        if tags:
            tags = tags if isinstance(tags, list) else [tags]
            head += f"\ntags: {', '.join(str(t) for t in tags)}"
        for feld in ("type", "branch"):
            if self.fm.get(feld) and isinstance(self.fm[feld], str):
                head += f"\n{feld}: {self.fm[feld]}"
        if self.fm.get("description"):
            head += f"\n{self.fm['description']}"
        return f"{head}\n\n{text}"


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
    # One named data file besides Markdown: the per-project trap book the
    # `brain run` pipeline appends proposals to (own section, see
    # gardener/lauf/schreiben.py). Any other non-.md name stays refused.
    if path.suffix != ".md" and path.name not in config.WRITABLE_DATA_FILES:
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


def git_ignored(path: Path) -> bool:
    """Whether git ignores `path` in the repo that contains it (asked from the
    file's own directory, so a mounted space answers with its own rules, not
    the vault root's `.gitignore`, which lists every space as ignored).
    Outside any repo, or when git cannot answer: False - nothing to protect
    against, and the other gates still apply."""
    path = Path(path)
    parent = path.parent
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    try:
        r = subprocess.run(["git", "-C", str(parent), "check-ignore", "-q",
                            "--", str(path)],
                           capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


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
        # One cache per writer, i.e. per run (gardener/cli.py builds exactly
        # one VaultWriter and reuses it across every phase) - see
        # protect.AuthorCache.
        self.protect_cache = protect.AuthorCache(self.vault)
        self.protected_skipped: list[tuple[str, str]] = []  # (rel, reason)
        # Loaded once per run (like the author cache above): a space's
        # `schreibbar` flag does not change mid-run, and a run can touch
        # thousands of paths (S2, brain5-architektur-entwurf.md Abschnitt 4.2).
        self.space_manifest = spaces.load_manifest(self.vault)
        # What this writer last put on disk, per rel, AFTER the identity stamp.
        # A caller keeps the text it asked to write (without `id:`/`schema:`),
        # so its next `expect=` differs from disk by exactly our own stamp -
        # see _own_stamp_only. Run of 24.09.2026: 25 notes reported as
        # "changed on disk mid-run" were nothing but that.
        self.final_text: dict[str, str] = {}
        self._local_cache: dict[str, bool] = {}

    def is_local(self, path) -> bool:
        """True for a file that exists only on this machine and must never be
        written or linked by the gardener: `IDENTITY.md`, `HANDOFF-*.md`
        (a handoff between two sessions, not knowledge), and anything git
        ignores in the repo the file lives in (vault root or a mounted space).

        Run of 24.09.2026: linking appended `relates-to [[AGENTS]]` to the
        gitignored `IDENTITY.md` and `relates-to [[IDENTITY]]` to `AGENTS.md`
        (a link that is dead on every other machine); the commit then failed on
        `git add` of the ignored file and left the index half staged."""
        p = Path(path)
        p = p if p.is_absolute() else self.vault / p
        name = p.name
        if name == "IDENTITY.md" or name.startswith("HANDOFF-"):
            return True
        key = str(p)
        if key not in self._local_cache:
            self._local_cache[key] = git_ignored(p)
        return self._local_cache[key]

    def can_rewrite(self, path, current_text: str) -> bool:
        """Would `write(path, ..., expect=current_text)` pass the gate?
        Read-only preview for callers that pay for a model call before they
        write (linking): a pair whose note cannot be written is not judged."""
        p = Path(path)
        p = p if p.is_absolute() else self.vault / p
        try:
            rel = p.resolve().relative_to(self.vault.resolve()).as_posix()
        except ValueError:
            return False
        if self._readonly_space(rel) is not None or rel in self.foreign:
            return False
        if self.is_local(p):
            return False
        return not protect.check(self.vault, rel, current_text,
                                 self.protect_cache).blocked

    def _own_stamp_only(self, rel: str, current: str | None, expect) -> bool:
        """Disk differs from `expect` only by the id/schema stamp this writer
        added itself on its last write of `rel` - no one else touched it."""
        if current is None or not isinstance(expect, str):
            return False
        if self.final_text.get(rel) != current:
            return False
        return identity.stamp(expect, keep_id=identity.id_of(current)) == current

    def _readonly_space(self, rel: str) -> str | None:
        entry = spaces.match_space(rel, self.space_manifest)
        if entry is not None and entry.get("schreibbar") is False:
            return str(entry.get("space", "?"))
        return None

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
        readonly = self._readonly_space(rel)
        if readonly is not None:
            if rel not in {r for r, _ in self.protected_skipped}:
                self.protected_skipped.append((rel, "protected-readonly-space"))
                log.warning("skipped %s: space '%s' is schreibbar: false - "
                            "not writable through the gate", rel, readonly)
            return False
        if self.is_local(path):
            if rel not in {r for r, _ in self.protected_skipped}:
                self.protected_skipped.append((rel, "protected-local-file"))
                log.warning("skipped %s: local file (IDENTITY/HANDOFF or "
                            "gitignored) - not writable through the gate", rel)
            return False
        if rel in self.foreign:
            if rel not in self.foreign_skipped:
                self.foreign_skipped.append(rel)
                log.warning("skipped %s: someone else has uncommitted work "
                            "there - not touching it", rel)
            return False
        if expect is not NO_CHECK:
            current = read_text(path) if path.exists() else None
            if current != expect and not self._own_stamp_only(rel, current, expect):
                self.conflicts.append(rel)
                log.warning("skipped %s: %s on disk since it was read "
                            "(Obsidian / basic-memory sync?) - not overwriting",
                            rel, "appeared" if expect is None else "changed")
                return False
            # A create (expect=None, file did not exist -> current is None)
            # is never a change to an existing note and is not this gate's
            # business - see protect.py's module docstring. Only a genuine
            # rewrite of something already on disk reaches here.
            if current is not None:
                verdict = protect.check(self.vault, rel, current,
                                        self.protect_cache)
                if verdict.blocked:
                    self.protected_skipped.append((rel, verdict.reason))
                    log.warning("skipped %s: %s - not writable through the "
                                "gate", rel, verdict.reason)
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
        self.final_text[rel] = text
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
        readonly = self._readonly_space(rel)
        if readonly is not None:
            if rel not in {r for r, _ in self.protected_skipped}:
                self.protected_skipped.append((rel, "protected-readonly-space"))
                log.warning("skipped %s: space '%s' is schreibbar: false - "
                            "not writable through the gate", rel, readonly)
            return
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
