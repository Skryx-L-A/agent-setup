"""Sidecar layer: a `<name>.<ext>.md` note next to every non-.md vault file.

Any binary/text file that is not itself a note gets a sibling markdown file
describing what it contains, so future sessions can skip opening the real
file unless they actually need it. This is a general safety net alongside the
older `00-sources/drop/` -> `_assets/` ingest mechanism (ingest.py): files that
already carry a hand-curated `type: asset` stub in a branch's `_assets/`
folder are recognized as "legacy" and only have missing frontmatter fields
filled in - their body is never touched.

Extraction is local only (pdftotext/textutil/ffprobe/Ollama vision+judge). A
file whose type nobody can extract still gets a sidecar - metadata plus a
placeholder - never nothing. `sha256` in the sidecar's frontmatter is the
idempotency key: unchanged -> skip, changed -> regenerate the auto block only
(everything outside `wb:auto:start/end`, and any file with `human-edited:
true`, is never overwritten).
"""
from __future__ import annotations

import datetime as dt
import fnmatch
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import blocks, config, extract, frontmatter
from .ingest import asset_file
from .queue import ReviewQueue
from .vault import Note, VaultWriter, _EXCLUDE_DIRS_CF, load_notes, read_text

log = logging.getLogger("gardener")

AUTO_START = "<!-- wb:auto:start -->"
AUTO_END = "<!-- wb:auto:end -->"
PLACEHOLDER = "Inhalt nicht automatisch lesbar - Datei bei Bedarf selbst oeffnen."

DOC_SUFFIXES = {".doc", ".docx", ".rtf"}
AUDIO_SUFFIXES = {".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
TEXT_SUFFIXES = {".txt", ".csv", ".json", ".yaml", ".yml", ".log", ".ini",
                 ".cfg", ".toml", ".xml", ".html", ".htm", ".css"}
CODE_SUFFIXES = {".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".rb", ".go",
                 ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".swift", ".kt",
                 ".php", ".sql"}
IMAGE_SUFFIXES = extract.IMAGE_SUFFIXES | {".heic", ".svg"}

HOOK_LINES = {
    "pdf": ("Nur oeffnen bei Detailfragen zum genauen Wortlaut; fuer den "
           "Ueberblick reicht diese Stub-Note."),
    "doc": ("Nur oeffnen bei Detailfragen zum genauen Wortlaut; fuer den "
           "Ueberblick reicht diese Stub-Note."),
    "text": ("Nur oeffnen, wenn der genaue Inhalt (Werte, exakter Text) "
            "gebraucht wird; sonst reicht diese Stub-Note."),
    "image": ("Nur oeffnen, wenn visuelle Details gebraucht werden; sonst "
             "reicht die Beschreibung hier."),
    "audio": ("Nur oeffnen/abspielen, wenn der genaue akustische Inhalt "
             "gebraucht wird; sonst reichen die Metadaten hier."),
    "video": ("Nur oeffnen/ansehen, wenn der genaue Inhalt gebraucht wird; "
             "sonst reichen die Metadaten hier."),
    "unknown": ("Datei bei Bedarf selbst oeffnen - lokal ist kein Extraktor "
               "fuer diesen Dateityp vorhanden."),
}

LEGACY_REQUIRED = ("sha256", "bytes", "mime", "created", "source",
                   "generated-by", "generated-at", "human-edited")

STOPWORDS = {
    "und", "der", "die", "das", "ist", "fuer", "für", "mit", "eine", "einen",
    "von", "the", "and", "for", "that", "this", "with", "dies", "diese",
    "dieser", "auf", "bei", "aus", "enthaelt", "enthält", "zeigt",
    "beschreibt", "wird", "sind", "einem", "einer", "nicht", "auch",
}

_SIDECAR_EXCLUDE_DIRS_CF = _EXCLUDE_DIRS_CF | {
    d.casefold() for d in config.SIDECAR_EXTRA_EXCLUDE_DIRS}


# --------------------------------------------------------------------------
# .brainignore (gitignore-subset syntax)
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class IgnoreRule:
    pattern: str
    negate: bool
    dir_only: bool
    anchored: bool


def parse_brainignore(text: str) -> list[IgnoreRule]:
    rules = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        if negate:
            line = line[1:]
        dir_only = line.endswith("/")
        if dir_only:
            line = line[:-1]
        anchored = line.startswith("/")
        if anchored:
            line = line[1:]
        if not line:
            continue
        rules.append(IgnoreRule(line, negate, dir_only, anchored))
    return rules


def load_brainignore(vault: Path) -> list[IgnoreRule]:
    path = vault / config.BRAINIGNORE_FILE
    if not path.is_file():
        return []
    return parse_brainignore(read_text(path))


def _rule_matches(rule: IgnoreRule, rel: str, is_dir: bool) -> bool:
    if rule.dir_only and not is_dir:
        return False
    pat = rule.pattern
    if rule.anchored or "/" in pat:
        return fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, pat + "/*")
    parts = rel.split("/")
    return any(fnmatch.fnmatch(part, pat) for part in parts)


def is_ignored(rules: list[IgnoreRule], rel: str, is_dir: bool = False) -> bool:
    """Last matching rule wins, like git: a later `!pattern` can un-ignore."""
    ignored = False
    for rule in rules:
        if _rule_matches(rule, rel, is_dir):
            ignored = not rule.negate
    return ignored


# --------------------------------------------------------------------------
# Candidate walk
# --------------------------------------------------------------------------

def sidecar_path_for(asset_path: Path) -> Path:
    return asset_path.with_name(asset_path.name + ".md")


def iter_asset_candidates(vault: Path,
                          rules: list[IgnoreRule] | None = None) -> list[Path]:
    """Every non-.md file in the vault that is a sidecar candidate.

    Sidecars themselves (they end in `.md`) never show up here, so "sidecars
    get no sidecars" falls out for free.
    """
    rules = rules if rules is not None else load_brainignore(vault)
    vault = Path(vault)
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(vault, followlinks=False):
        here = Path(dirpath)
        rel_here = here.relative_to(vault).as_posix()
        rel_here = "" if rel_here == "." else rel_here
        pruned = []
        for d in sorted(dirnames):
            if d.startswith(".") or d.casefold() in _SIDECAR_EXCLUDE_DIRS_CF:
                continue
            if (here / d).is_symlink():
                continue
            rel_d = f"{rel_here}/{d}" if rel_here else d
            if is_ignored(rules, rel_d, is_dir=True):
                continue
            pruned.append(d)
        dirnames[:] = pruned
        for name in sorted(filenames):
            if name.endswith(".md") or name in config.SIDECAR_EXCLUDE_FILE_NAMES:
                continue
            if any(fnmatch.fnmatch(name, pat)
                  for pat in config.SIDECAR_EXCLUDE_FILE_GLOBS):
                continue
            path = here / name
            if path.is_symlink():
                continue
            rel = f"{rel_here}/{name}" if rel_here else name
            if rel.startswith(config.DROP_DIR):
                continue    # raw ingest input, not corpus - ingest phase owns it
            if is_ignored(rules, rel, is_dir=False):
                continue
            out.append(path)
    return sorted(out)


# --------------------------------------------------------------------------
# Local extraction (no cloud calls anywhere in this module)
# --------------------------------------------------------------------------

def classify(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    if suffix in DOC_SUFFIXES:
        return "doc"
    if suffix in AUDIO_SUFFIXES:
        return "audio"
    if suffix in VIDEO_SUFFIXES:
        return "video"
    if suffix in TEXT_SUFFIXES or suffix in CODE_SUFFIXES:
        return "text"
    return "unknown"


def doc_text(path: Path, max_chars: int = config.SIDECAR_EXTRACT_MAX_CHARS) -> str:
    """Office doc/rtf text via macOS textutil. "" when unavailable/failed."""
    if not shutil.which("textutil"):
        return ""
    try:
        r = subprocess.run(["textutil", "-convert", "txt", "-stdout", str(path)],
                           capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            return r.stdout[:max_chars]
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("textutil failed on %s: %s", path.name, e)
    return ""


def ffprobe_description(path: Path) -> str:
    """Audio/video metadata (duration, codecs, resolution) via ffprobe. No LLM
    call: this is metadata, not content - stt is opt-in, never default."""
    if not shutil.which("ffprobe"):
        return ""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return ""
        data = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as e:
        log.warning("ffprobe failed on %s: %s", path.name, e)
        return ""
    parts = []
    duration = (data.get("format") or {}).get("duration")
    if duration:
        try:
            parts.append(f"Dauer {float(duration):.0f}s")
        except ValueError:
            pass
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            parts.append(f"Video {s.get('width', '?')}x{s.get('height', '?')} "
                         f"({s.get('codec_name', '?')})")
        elif s.get("codec_type") == "audio":
            parts.append(f"Audio {s.get('codec_name', '?')} "
                         f"{s.get('sample_rate', '?')}Hz")
    if not parts:
        return ""
    return "Metadaten: " + ", ".join(parts) + "."


def describe(client, path: Path, kind: str) -> tuple[str, str]:
    """(description, generated_by). Empty description -> metadata-only sidecar."""
    if kind == "pdf":
        text = extract.pdf_text(path, max_chars=config.SIDECAR_EXTRACT_MAX_CHARS)
        if not text:
            return "", ""
        desc = extract.summarize(client, text, hint=f"PDF: {path.name}")
        return desc, (config.JUDGE_MODEL if desc else "")
    if kind == "image":
        desc = extract.describe_image(client, path)
        return desc, (config.VISION_MODEL if desc else "")
    if kind == "doc":
        text = doc_text(path)
        if not text:
            return "", ""
        desc = extract.summarize(client, text, hint=f"Dokument: {path.name}")
        return desc, (config.JUDGE_MODEL if desc else "")
    if kind == "text":
        try:
            text = read_text(path)[:config.SIDECAR_EXTRACT_MAX_CHARS]
        except OSError:
            return "", ""
        if not text.strip():
            return "", ""
        desc = extract.summarize(client, text, hint=f"Datei: {path.name}")
        return desc, (config.JUDGE_MODEL if desc else "")
    if kind in ("audio", "video"):
        desc = ffprobe_description(path)
        return desc, ("ffprobe" if desc else "")
    return "", ""


def guess_tags(path: Path, description: str, max_tags: int = 6) -> list[str]:
    """Cheap deterministic tags: no extra Ollama call per asset."""
    tags: list[str] = []
    ext = path.suffix.lstrip(".").lower()
    if ext:
        tags.append(ext)
    seen = set(tags)
    for w in re.findall(r"[A-Za-zÄÖÜäöüß0-9-]{4,}", description.lower()):
        if w in STOPWORDS or w in seen:
            continue
        seen.add(w)
        tags.append(w)
        if len(tags) >= max_tags:
            break
    return tags


def sha256_of(path: Path, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def _created_of(path: Path) -> str:
    try:
        ts = path.stat().st_birthtime  # macOS/BSD
    except AttributeError:
        ts = path.stat().st_mtime
    return dt.date.fromtimestamp(ts).isoformat()


def _permissions_of(path: Path) -> str:
    try:
        return format(path.stat().st_mode & 0o777, "03o")
    except OSError:
        return "?"


def _mtime_of(path: Path) -> str:
    try:
        return dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
    except OSError:
        return "?"


def unreadable_description(path: Path, size: int, error: OSError) -> str:
    """Metadata-only stand-in for a file whose content cannot be read at all.

    Content extraction failing must never mean no sidecar at all (sidecar-001):
    whatever is knowable without opening the file - size, mtime, permissions,
    mime by suffix - goes in instead, plus the reason."""
    reason = error.strerror or str(error)
    return (f"Inhalt nicht automatisch lesbar ({reason}). "
           f"Groesse {size} Bytes, geaendert {_mtime_of(path)}, "
           f"Rechte {_permissions_of(path)}, Mime (nach Endung) "
           f"{extract.mime_of(path)}.")


# --------------------------------------------------------------------------
# Legacy stub recognition (old hand/ingest-written `_assets/*.md` stubs)
# --------------------------------------------------------------------------

def build_legacy_index(vault: Path, notes: list[Note]) -> dict[Path, Note]:
    """`type: asset` notes that are NOT themselves a new-format sidecar.

    A new-format sidecar (`<asset>.<ext>.md`) also carries `type: asset` plus
    a `path:` pointing at its asset, so without this check every sidecar this
    module writes would immediately be mistaken for a legacy stub of itself on
    the very next run.
    """
    idx: dict[Path, Note] = {}
    for n in notes:
        if n.ntype != "asset":
            continue
        target = asset_file(vault, n)
        if target is None:
            continue
        if n.path.resolve() == sidecar_path_for(target).resolve():
            continue
        idx[target.resolve()] = n
    return idx


def missing_legacy_fields(note: Note) -> list[str]:
    return [k for k in LEGACY_REQUIRED if k not in note.fm]


def enrich_legacy_stub(writer: VaultWriter, note: Note, asset_path: Path,
                       today: dt.date) -> bool:
    """Add only the frontmatter fields the new contract needs but this legacy
    stub predates. The body - and any field the stub already has - is never
    touched."""
    missing = missing_legacy_fields(note)
    if not missing:
        return False
    _, body = frontmatter.split_blocks(note.text)
    current = dict(note.fm)
    computed = {
        "sha256": sha256_of(asset_path),
        "bytes": asset_path.stat().st_size,
        "mime": extract.mime_of(asset_path),
        "created": today.isoformat(),
        "source": "legacy",
        "generated-by": "legacy",
        "generated-at": today.isoformat(),
        "human-edited": "false",
    }
    for k in missing:
        current[k] = computed[k]
    new_text = frontmatter.render(current) + "\n" + body.lstrip("\n")
    return writer.write(note.path, new_text, expect=note.text)


# --------------------------------------------------------------------------
# New-format sidecar body
# --------------------------------------------------------------------------

def build_sidecar_text(*, vault: Path, asset_path: Path, kind: str, digest: str,
                       size: int, description: str, generated_by: str,
                       today: dt.date, existing_text: str | None,
                       external: bool) -> str | None:
    """None means: existing sidecar's markers are malformed - do not write."""
    rel = asset_path.relative_to(vault).as_posix()
    mime = extract.mime_of(asset_path)
    hook = HOOK_LINES.get(kind, HOOK_LINES["unknown"])
    if external:
        hook += (f" Datei > {config.SIDECAR_EXTERNAL_MB} MB - liegt extern, "
                "nicht committen (.gitignore/.gitattributes pruefen).")
    tags = guess_tags(asset_path, description)
    auto_block = (f"{AUTO_START}\n{description or PLACEHOLDER}\n\n{hook}\n\n"
                 f"Schlagworte: {', '.join(tags)}\n{AUTO_END}")

    if existing_text is None:
        fields = {
            "title": asset_path.name, "type": "asset", "path": rel,
            "mime": mime, "bytes": size, "sha256": digest,
            "created": _created_of(asset_path), "source": "vault",
            "generated-by": generated_by or "metadata-only",
            "generated-at": today.isoformat(), "human-edited": "false",
        }
        body = (f"{auto_block}\n\n"
               "<!-- Wikilinks zum Projekt/Topic, zu dem diese Datei gehoert: -->\n"
               "<!-- relates-to [[...]] -->\n")
        return frontmatter.render(fields) + "\n" + body

    new_text, ok = blocks.replace_block(existing_text, AUTO_START, AUTO_END, auto_block)
    if not ok:
        return None
    blocks_list, body = frontmatter.split_blocks(new_text)
    if not blocks_list:
        return None
    fields = frontmatter.parse_fields(blocks_list)
    fields.update({
        "mime": mime, "bytes": size, "sha256": digest,
        "generated-by": generated_by or "metadata-only",
        "generated-at": today.isoformat(),
    })
    return frontmatter.render(fields) + "\n" + body.lstrip("\n")


# --------------------------------------------------------------------------
# Public API: scan (read-only) / generate (writes) / check (gate)
# --------------------------------------------------------------------------

@dataclass
class SidecarEntry:
    rel: str
    sidecar_rel: str | None
    status: str   # ok | missing | stale | human-edited | legacy-ok | legacy-needs-fields | unreadable
    bytes: int = 0
    external: bool = False


@dataclass
class SidecarResult:
    generated: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    legacy_enriched: list[str] = field(default_factory=list)
    metadata_only: list[str] = field(default_factory=list)
    external: list[str] = field(default_factory=list)
    skipped_human_edited: list[str] = field(default_factory=list)
    skipped_malformed: list[str] = field(default_factory=list)
    skipped_unreadable: list[str] = field(default_factory=list)


def _filter_by_path(vault: Path, candidates: list[Path],
                    path: str | None) -> list[Path]:
    if not path:
        return candidates
    base = (vault / path).resolve()
    return [p for p in candidates if p == base or p.is_relative_to(base)]


def scan(vault: Path, path: str | None = None,
        notes: list[Note] | None = None) -> list[SidecarEntry]:
    """Read-only: what is missing or stale. Never writes anything."""
    vault = Path(vault)
    notes = notes if notes is not None else load_notes(vault)
    legacy_index = build_legacy_index(vault, notes)
    candidates = _filter_by_path(vault, iter_asset_candidates(vault), path)
    out: list[SidecarEntry] = []
    for asset_path in candidates:
        rel = asset_path.relative_to(vault).as_posix()
        try:
            size = asset_path.stat().st_size
            external = size > config.SIDECAR_EXTERNAL_MB * 1024**2
            legacy_note = legacy_index.get(asset_path.resolve())
            if legacy_note is not None:
                status = ("legacy-needs-fields" if missing_legacy_fields(legacy_note)
                          else "legacy-ok")
                out.append(SidecarEntry(rel, None, status, size, external))
                continue
            sidecar_path = sidecar_path_for(asset_path)
            sidecar_rel = sidecar_path.relative_to(vault).as_posix()
            if not sidecar_path.is_file():
                out.append(SidecarEntry(rel, sidecar_rel, "missing", size, external))
                continue
            fields, _ = frontmatter.parse(read_text(sidecar_path))
            if str(fields.get("human-edited", "")).strip().lower() == "true":
                out.append(SidecarEntry(rel, sidecar_rel, "human-edited", size, external))
                continue
            status = "ok" if fields.get("sha256") == sha256_of(asset_path) else "stale"
            out.append(SidecarEntry(rel, sidecar_rel, status, size, external))
        except OSError as e:
            log.warning("scan: %s unreadable - skipping just this file: %s", rel, e)
            out.append(SidecarEntry(rel, None, "unreadable"))
    return out


def generate(vault: Path, writer: VaultWriter, client, *, path: str | None = None,
            force: bool = False, notes: list[Note] | None = None,
            today: dt.date | None = None, deadline=None) -> SidecarResult:
    vault = Path(vault)
    today = today or dt.date.today()
    notes = notes if notes is not None else load_notes(vault)
    legacy_index = build_legacy_index(vault, notes)
    candidates = _filter_by_path(vault, iter_asset_candidates(vault), path)
    result = SidecarResult()

    for asset_path in candidates:
        if deadline is not None and deadline.expired():
            break
        rel = asset_path.relative_to(vault).as_posix()
        try:
            size = asset_path.stat().st_size
            external = size > config.SIDECAR_EXTERNAL_MB * 1024**2
            if external:
                result.external.append(rel)

            legacy_note = legacy_index.get(asset_path.resolve())
            if legacy_note is not None:
                if enrich_legacy_stub(writer, legacy_note, asset_path, today):
                    result.legacy_enriched.append(rel)
                continue

            sidecar_path = sidecar_path_for(asset_path)
            existing_text = read_text(sidecar_path) if sidecar_path.is_file() else None
            existing_fields = frontmatter.parse(existing_text)[0] if existing_text else {}
            if str(existing_fields.get("human-edited", "")).strip().lower() == "true":
                result.skipped_human_edited.append(rel)
                continue

            kind = classify(asset_path)
            try:
                digest = sha256_of(asset_path)
            except OSError as e:
                # Content unreadable (permissions/IO): skip the EXTRACTION
                # only, never the sidecar itself - a file nobody can describe
                # still needs a marker that it exists, or the next run drops
                # it again silently (sidecar-001).
                result.skipped_unreadable.append(rel)
                digest = existing_fields.get("sha256", "")
                description = unreadable_description(asset_path, size, e)
                generated_by = "metadata-only"
            else:
                if existing_text is not None and not force and existing_fields.get("sha256") == digest:
                    continue   # up to date
                description, generated_by = describe(client, asset_path, kind)
                if not description:
                    result.metadata_only.append(rel)

            new_text = build_sidecar_text(
                vault=vault, asset_path=asset_path, kind=kind, digest=digest,
                size=size, description=description, generated_by=generated_by,
                today=today, existing_text=existing_text, external=external)
            if new_text is None:
                log.warning("malformed wb:auto markers in %s - not rewriting it",
                           sidecar_path.relative_to(vault))
                result.skipped_malformed.append(rel)
                continue
            expect = existing_text if existing_text is not None else None
            if writer.write(sidecar_path, new_text, expect=expect):
                (result.updated if existing_text is not None else result.generated).append(rel)
        except OSError as e:
            log.warning("%s unreadable - skipping just this file, run continues: %s", rel, e)
            result.skipped_unreadable.append(rel)
            continue
    return result


def run_sidecar_phase(vault: Path, notes: list[Note], writer: VaultWriter, client,
                      queue: ReviewQueue, deadline=None,
                      today: dt.date | None = None) -> SidecarResult:
    today = today or dt.date.today()
    result = generate(vault, writer, client, notes=notes, today=today,
                      deadline=deadline)
    for rel in result.metadata_only:
        queue.add(f"Sidecar ohne Beschreibung: `{rel}` - lokal nicht "
                 "extrahierbar, Stub bei Bedarf von Hand ergaenzen",
                 key=f"Sidecar ohne Beschreibung: `{rel}`", today=today)
    for rel in result.skipped_unreadable:
        queue.add(f"Sidecar nur mit Metadaten: `{rel}` - Datei nicht lesbar "
                 "(Rechte/IO-Fehler), Zugriff pruefen; Inhalt wird beim "
                 "naechsten Lauf automatisch nachgezogen sobald lesbar",
                 key=f"Sidecar nur mit Metadaten: `{rel}`", today=today)
    return result
