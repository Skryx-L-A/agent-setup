"""Enumerate every dream source: one function per source class, each source
getting a stable id and a content hash. Nothing is read into memory here for
the big files (transcripts can be over 100 MB) - only stat()'d and hashed in
chunks. Segmentation happens later in segment.py.

Reuses gardener.vault.load_notes / is_excluded for the vault side and
gardener.sidecar's .brainignore parser (gitignore-subset syntax) for project
doc filtering, per DREAM-PLAN.md Abschnitt 1/8: nothing here is reimplemented
that the gardener already has.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .. import vault as vault_mod
from ..sidecar import IgnoreRule, is_ignored, parse_brainignore
from . import config as dcfg
from . import shadow

log = logging.getLogger("gardener.dream")

WAVE_VAULT = "1"
WAVE_PROJECTS = "2"

SOURCE_VAULT = "vault"
SOURCE_GARDENER_REPORT = "gardener-report"
SOURCE_WORKER_RESULT = "worker-result"
SOURCE_TRANSCRIPT = "transcript"
SOURCE_PROJECT_DOC = "project-doc"


@dataclass(frozen=True)
class Source:
    source_class: str
    quell_id: str        # stable, unique across the whole corpus
    path: Path            # absolute, readable
    size: int              # bytes
    mtime: float
    content_hash: str      # sha256 of the raw file bytes
    wave: str


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def vault_sources(vault: Path) -> list[Source]:
    """Every corpus note except the dream's own output.

    A derived dream text is never input to another dream (DREAM-PLAN.md
    Abschnitt 9): the summary of a summary is how semantic drift starts, and
    the countermeasure is structural, the same way synth.py excludes its own
    generated pages from the linking corpus. A hand-written note that merely
    CARRIES a dream block stays material - only the block itself is stripped,
    in cli.read_source_text.
    """
    out = []
    for note in vault_mod.load_notes(vault):
        if shadow.is_dream_output(note):
            log.debug("dream: %s is dream output - never input", note.rel)
            continue
        try:
            mtime = note.path.stat().st_mtime
        except OSError:
            mtime = 0.0
        out.append(Source(
            source_class=SOURCE_VAULT, quell_id=f"vault:{note.rel}",
            path=note.path, size=len(note.text.encode("utf-8")),
            mtime=mtime, content_hash=note.content_hash, wave=WAVE_VAULT))
    return out


def gardener_report_sources(vault: Path) -> list[Source]:
    out = []
    staging = vault / dcfg.STAGING_DIR
    if not staging.is_dir():
        return out
    for path in sorted(staging.glob(dcfg.GARDENER_REPORT_GLOB)):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(vault).as_posix()
        out.append(Source(
            source_class=SOURCE_GARDENER_REPORT, quell_id=f"gardener-report:{rel}",
            path=path, size=st.st_size, mtime=st.st_mtime,
            content_hash=_sha256_file(path), wave=WAVE_VAULT))
    return out


def worker_result_sources(root: Path | None = None) -> list[Source]:
    root = root if root is not None else dcfg.WORKER_RESULTS_DIR
    out = []
    if not root.is_dir():
        return out
    for path in sorted(root.rglob("*.md")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        out.append(Source(
            source_class=SOURCE_WORKER_RESULT, quell_id=f"worker-result:{rel}",
            path=path, size=st.st_size, mtime=st.st_mtime,
            content_hash=_sha256_file(path), wave=WAVE_VAULT))
    return out


def transcript_sources(root: Path | None = None) -> list[Source]:
    root = root if root is not None else dcfg.TRANSCRIPT_DIR
    out = []
    if not root.is_dir():
        return out
    for path in sorted(root.rglob("*.jsonl")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        month = dt.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m")
        out.append(Source(
            source_class=SOURCE_TRANSCRIPT, quell_id=f"transcript:{rel}",
            path=path, size=st.st_size, mtime=st.st_mtime,
            content_hash=_sha256_file(path), wave=f"3:{month}"))
    return out


def _project_ignore_rules(project_dir: Path) -> list[IgnoreRule]:
    rules: list[IgnoreRule] = []
    for name in (".gitignore", dcfg.BRAINIGNORE_FILE):
        p = project_dir / name
        if p.is_file():
            try:
                rules.extend(parse_brainignore(
                    p.read_text(encoding="utf-8", errors="replace")))
            except OSError:
                pass
    return rules


def _project_files(project_dir: Path) -> list[Path]:
    """Markdown at project top level, plus the allowed subtrees - nothing
    else is ever visible (DREAM-PLAN.md Abschnitt 8: Vorgabe ist Verbot)."""
    out: list[Path] = []
    for p in sorted(project_dir.glob("*.md")):
        if p.is_file() and not p.is_symlink():
            out.append(p)
    for sub in dcfg.PROJECT_ALLOWED_DIRS:
        base = project_dir / sub
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            here = Path(dirpath)
            # `.` und `_` sind beide Maschinen-Namensraeume, und der Vault
            # haelt es selbst so (`_meta/`). Gemessen am 10.08.2026 ueber die
            # echten 24 Projekte: allein `a machine-bound project/knowledge/_graph/` haette
            # 132 der 296 Kopien gestellt - ein von Basic Memory gepflegter
            # Graph, keine handgeschriebene Prosa. Vorgabe ist Verbot, und ein
            # Verzeichnis, dessen Name mit einem Unterstrich beginnt, hat
            # niemand freigeschaltet.
            dirnames[:] = sorted(
                d for d in dirnames
                if not d.startswith((".", "_")) and not (here / d).is_symlink())
            for name in sorted(filenames):
                fp = here / name
                if (fp.suffix.lower() in dcfg.PROJECT_TEXT_SUFFIXES
                        and fp.is_file() and not fp.is_symlink()):
                    out.append(fp)
    return out


def project_doc_sources(root: Path | None = None) -> list[Source]:
    root = root if root is not None else dcfg.PROJECTS_ROOT
    out = []
    if not root.is_dir():
        return out
    for project_dir in sorted(p for p in root.iterdir()
                              if p.is_dir() and not p.name.startswith(".")):
        rules = _project_ignore_rules(project_dir)
        for path in _project_files(project_dir):
            rel = path.relative_to(project_dir).as_posix()
            if is_ignored(rules, rel):
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            out.append(Source(
                source_class=SOURCE_PROJECT_DOC,
                quell_id=f"project-doc:{project_dir.name}/{rel}",
                path=path, size=st.st_size, mtime=st.st_mtime,
                content_hash=_sha256_file(path), wave=WAVE_PROJECTS))
    return out


def all_sources(vault: Path, transcript_root: Path | None = None,
                worker_root: Path | None = None,
                projects_root: Path | None = None) -> list[Source]:
    return (vault_sources(vault)
            + gardener_report_sources(vault)
            + worker_result_sources(worker_root)
            + transcript_sources(transcript_root)
            + project_doc_sources(projects_root))
