#!/usr/bin/env python3
"""Skills with scripts per agent, per world and in the library; learning step; token measurement.

Plan section 14 (14.09.2026): agents learn.  A skill is a folder ``<name>/`` with
``SKILL.md`` (frontmatter ``name`` and ``description``, sections Auslöser, Vorgehen,
Grenzen) and ``scripts/``.  Skills live on three levels:

- agent: ``<welt>/agents/<id>/skills/<name>/`` -- the agent changes these itself;
- world: ``<welt>/skills/<name>/`` -- changed only through an accepted proposal;
- library: ``agents/bibliothek/skills/<name>/`` in the Werkbank repository -- read-only
  for agents, changed only through a proposal accepted in the global world.

Stored scripts (der Nutzer, 14.09.2026, 16:10) are a unit of their own: ``skripte/<name>/``
holds exactly one executable file ``<name>`` or ``<name>.<ext>`` that starts with an
instruction header in comments (name, zweck, aufruf, eingaben, ausgaben, grenzen) and
optionally ``tests/``.  They live on the same three levels (``<welt>/agents/<id>/skripte``,
``<welt>/skripte``, ``agents/bibliothek/skripte``) and share version, resolution, proposal
and learning step with skills; a skill refers to them with ``skripte:`` in ``SKILL.md``.

Nothing is copied downwards: ``agents/<id>/skills.json`` refers to the folder that wins
for each name (agent before world before library) together with its version, the
SHA-256 over the folder, and marks each entry with ``art`` ``skill`` or ``skript``.
Mutations run under the world lock of ``agents_data`` and use its atomic writers;
symlinks, traversal and special files are rejected.  ``--absender`` stays unverified
development metadata, as in the data library.

The module starts no process, model or harness.  ``lernschritt_anwenden`` and the
measurement functions are the interface the carrier (Träger) calls later.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import agents_data as ad  # noqa: E402
import agents_brain as ab  # noqa: E402
import agents_gedaechtnis as ag  # noqa: E402

AgentsError = ad.AgentsError

SCHEMA_VERSION = 1
# skills.json: 2 adds ``art`` to every entry, script entries, ``skript_bibliothek`` and ``fehlende_skripte``.
DIRECTORY_SCHEMA_VERSION = 2
LEVELS = ("agent", "welt", "bibliothek")
ARTS = ("skill", "skript")
UNIT_FOLDERS = {"skill": "skills", "skript": "skripte"}
UNIT_TITLES = {"skill": "Skill", "skript": "Skript"}
SCRIPT_HEADER_KEYS = ("name", "zweck", "aufruf", "eingaben", "ausgaben", "grenzen")
SCRIPT_HEADER_MARK = "# ---"
SCRIPT_HEADER_LINES = 80
SCRIPT_LANGUAGES = {"sh": ("#!/bin/sh", ".sh"), "bash": ("#!/usr/bin/env bash", ".sh"),
                    "python": ("#!/usr/bin/env python3", ".py")}
PROPOSAL_TARGETS = ("welt", "bibliothek")
# Lowercase only: macOS file systems are case-insensitive by default, so "Foo" and
# "foo" would silently be the same folder.
SKILL_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
FILE_NAME_RE = re.compile(r"^[A-Za-z0-9_.+-]{1,128}$")
KIND_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
IGNORED_NAMES = {"__pycache__", ".DS_Store"}
SKILL_FILE_LIMIT = 512 * 1024
SKILL_TOTAL_LIMIT = 4 * 1024 * 1024
SKILL_FILES_LIMIT = 200
SKILL_DEPTH_LIMIT = 8
DESCRIPTION_LIMIT = 1024
REQUIRED_SECTIONS = ("ausloeser", "vorgehen", "grenzen")
SECTION_TITLES = {"ausloeser": "Auslöser", "vorgehen": "Vorgehen", "grenzen": "Grenzen"}
TICKET_DIFF_LIMIT = 12000
SHOW_TEXT_LIMIT = 64 * 1024
LEARN_KINDS = ("lehre", "notiz", "archiv", "anweisung", "skill", "skript", "nichts")
# Lernschritte ins Brain (der Nutzer, 16.09.2026): der Traeger schreibt sie ueber agents_brain, ausserhalb der
# Welttransaktion, weil Commit und Abgleich im Vault dauern koennen.
BRAIN_KINDS = ("notiz", "archiv")
LEARN_FIELDS = ("schema_version", "art", "ziel", "text", "grund", "diff", "titel", "thema", "anhaengen", "zeilen", "neu")
LEARN_FILE = "lernschritt.json"
LEARN_FILE_LIMIT = 256 * 1024
LESSON_TEXT_LIMIT = 500
REASON_LIMIT = 300
# Notbremse in Bytes; die eigentliche Grenze ist agents_gedaechtnis.GRENZE (2.000 Zeichen, 15 Zeilen), deren
# Ueberschreitung der Traeger mit dem Posten "Gedaechtnis kuerzen" beantwortet.
MEMORY_LIMIT = 12 * 1024
INSTRUCTIONS_LIMIT = 64 * 1024
INSTRUCTION_FILES = ("AGENTS.md", "CLAUDE.md")
LESSONS_HEADING = "## Lehren"
MEMORY_PLACEHOLDER = "Noch keine Einträge."
MEASUREMENT_FILE = "messungen.jsonl"
TOKEN_FIELDS = ("input", "output", "cache_read", "cache_write", "reasoning", "gesamt")
HARNESSES = ("claude", "codex", "pi")
PROPOSAL_DIR = "skill-vorschlaege"
WORLD_LOG = "skill-verlauf.jsonl"
RESULT_ACCEPTED = "Skill übernommen:"
RESULT_REJECTED = "Skill-Vorschlag abgelehnt:"


# ---------------------------------------------------------------------------
# Paths and validation
# ---------------------------------------------------------------------------

def valid_skill_name(name: str) -> str:
    if not isinstance(name, str) or not SKILL_NAME_RE.fullmatch(name):
        raise AgentsError("Skillname ist ungueltig (Kleinbuchstaben, Zahlen und '-', hoechstens 64 Zeichen)")
    return name


def library_path(explicit: str | os.PathLike[str] | None = None) -> Path:
    """The library of the Werkbank repository; ``WB_SKILL_BIBLIOTHEK`` overrides it."""
    raw = explicit or os.environ.get("WB_SKILL_BIBLIOTHEK")
    if raw:
        path = Path(os.path.abspath(os.path.expanduser(str(raw))))
        ad._reject_symlink(path, "Bibliothekspfad")
        return path
    return Path(__file__).resolve().parents[1] / "agents" / "bibliothek" / "skills"


def valid_art(art: str) -> str:
    if art not in ARTS:
        raise AgentsError("Art muss skill oder skript sein")
    return art


def script_library_path(library: str | os.PathLike[str] | None = None) -> Path:
    """The script library next to the skill library (``agents/bibliothek/skripte``).

    An explicit skill library names its sibling; otherwise ``WB_SKRIPT_BIBLIOTHEK`` or the
    sibling of the default skill library.  So the two libraries never come from different
    sources unless the environment says so.
    """
    if not library and os.environ.get("WB_SKRIPT_BIBLIOTHEK"):
        path = Path(os.path.abspath(os.path.expanduser(os.environ["WB_SKRIPT_BIBLIOTHEK"])))
        ad._reject_symlink(path, "Skriptbibliothek")
        return path
    path = library_path(library).parent / UNIT_FOLDERS["skript"]
    ad._reject_symlink(path, "Skriptbibliothek")
    return path


def _no_symlink_below(base: Path, target: Path, label: str) -> None:
    """Reject every existing symlink component from ``base`` down to ``target``."""
    try:
        parts = target.relative_to(base).parts
    except ValueError as exc:
        raise AgentsError("%s liegt ausserhalb seiner Ebene" % label) from exc
    current = base
    if current.is_symlink():
        raise AgentsError("%s darf keine Symlink-Komponente enthalten" % label)
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise AgentsError("%s darf keine Symlink-Komponente enthalten" % label)


def level_root(root: Path, level: str, agent_id: str | None = None,
               library: str | os.PathLike[str] | None = None, art: str = "skill") -> Path:
    folder = UNIT_FOLDERS[valid_art(art)]
    if level == "agent":
        if not agent_id:
            raise AgentsError("Agentenebene braucht eine Agentenkennung")
        path = ad._agent_dir(root, agent_id) / folder
        _no_symlink_below(root, path, "Skillordner")
        return path
    if level == "welt":
        return ad.child(root, folder)
    if level == "bibliothek":
        return library_path(library) if art == "skill" else script_library_path(library)
    raise AgentsError("Ebene ungueltig (agent, welt, bibliothek)")


def skill_dir(base: Path, name: str) -> Path:
    target = base / valid_skill_name(name)
    _no_symlink_below(base, target, "Skillordner")
    return target


def _valid_rel(rel: str) -> list[str]:
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel:
        raise AgentsError("Dateipfad im Skill ist ungueltig: %r" % rel)
    parts = rel.split("/")
    if len(parts) > SKILL_DEPTH_LIMIT:
        raise AgentsError("Dateipfad im Skill ist zu tief: %s" % rel)
    for part in parts:
        if not FILE_NAME_RE.fullmatch(part) or set(part) == {"."}:
            raise AgentsError("Dateipfad im Skill ist ungueltig: %r" % rel)
    return parts


def _read_file(path: Path, limit: int) -> bytes:
    fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise AgentsError("Keine gewoehnliche Datei: %s" % path.name)
        if info.st_size > limit:
            raise AgentsError("Datei ist groesser als %d Bytes: %s" % (limit, path.name))
        chunks = []
        remaining = limit + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            raise AgentsError("Datei ist groesser als %d Bytes: %s" % (limit, path.name))
        return data
    finally:
        os.close(fd)


def skill_files(folder: Path) -> dict[str, tuple[bytes, bool]]:
    """All regular files of a skill as ``{relpath: (content, executable)}``.

    Symlinks, special files, unsafe names and oversized folders are rejected.  Python
    caches are skipped, so running a script's test does not change the version.
    Directories carry no content of their own and are not part of the version.
    """
    if folder.is_symlink():
        raise AgentsError("Skillordner darf kein Symlink sein: %s" % folder.name)
    if not folder.is_dir():
        raise AgentsError("Skillordner fehlt: %s" % folder)
    result: dict[str, tuple[bytes, bool]] = {}
    total = 0

    def walk(directory: str, prefix: str, depth: int) -> None:
        nonlocal total
        if depth > SKILL_DEPTH_LIMIT:
            raise AgentsError("Skillordner ist zu tief verschachtelt")
        with os.scandir(directory) as entries:
            items = sorted(entries, key=lambda entry: entry.name)
        for entry in items:
            if entry.name in IGNORED_NAMES or entry.name.endswith(".pyc"):
                continue
            rel = prefix + entry.name
            if not FILE_NAME_RE.fullmatch(entry.name) or set(entry.name) == {"."}:
                raise AgentsError("Dateiname im Skill ist ungueltig: %r" % rel)
            if entry.is_symlink():
                raise AgentsError("Skill enthaelt einen Symlink: %s" % rel)
            if entry.is_dir(follow_symlinks=False):
                walk(entry.path, rel + "/", depth + 1)
            elif entry.is_file(follow_symlinks=False):
                data = _read_file(Path(entry.path), SKILL_FILE_LIMIT)
                total += len(data)
                if total > SKILL_TOTAL_LIMIT:
                    raise AgentsError("Skill ist groesser als %d Bytes" % SKILL_TOTAL_LIMIT)
                mode = entry.stat(follow_symlinks=False).st_mode
                result[rel] = (data, bool(mode & 0o111))
                if len(result) > SKILL_FILES_LIMIT:
                    raise AgentsError("Skill hat mehr als %d Dateien" % SKILL_FILES_LIMIT)
            else:
                raise AgentsError("Skill enthaelt eine Sonderdatei: %s" % rel)

    walk(str(folder), "", 1)
    return result


def files_version(files: dict[str, tuple[bytes, bool]]) -> str:
    digest = hashlib.sha256()
    for rel in sorted(files):
        data, executable = files[rel]
        digest.update(("f\0%s\0%s\0%s\n" % (rel, "x" if executable else "-",
                                            hashlib.sha256(data).hexdigest())).encode("utf-8"))
    return digest.hexdigest()


def skill_version(folder: Path) -> str:
    """SHA-256 over relative path, executable bit and content of every file."""
    return files_version(skill_files(folder))


def _write_files(target: Path, files: dict[str, tuple[bytes, bool]], library_modes: bool,
                 art: str = "skill") -> None:
    """Build a new skill or script folder from ``files``; ``target`` must not exist yet."""
    target.mkdir()
    if art == "skill":
        (target / "scripts").mkdir()
    for rel in sorted(files):
        parts = _valid_rel(rel)
        data, executable = files[rel]
        destination = target.joinpath(*parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if library_modes:
            mode = 0o755 if executable else 0o644
        else:
            mode = 0o700 if executable else 0o600
        fd = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(destination, mode)  # the umask must not drop the executable bit


def _stage_name(base: Path, name: str, kind: str) -> Path:
    return base / (".%s.%s-%s" % (name, kind, uuid.uuid4().hex))


def _clean_leftovers(base: Path, name: str) -> None:
    """Remove staging folders a crashed replacement of ``name`` left behind (world lock held)."""
    if not base.is_dir():
        return
    for item in base.iterdir():
        if item.name.startswith(".%s.creating-" % name) or item.name.startswith(".%s.alt-" % name):
            if item.is_symlink():
                item.unlink()
            else:
                shutil.rmtree(item, ignore_errors=True)


def _replace_folder(base: Path, name: str, files: dict[str, tuple[bytes, bool]], library_modes: bool,
                    art: str = "skill") -> None:
    """Make ``base/name`` hold exactly ``files``; readers never see a half-written skill."""
    base.mkdir(parents=True, exist_ok=True)
    if base.is_symlink() or not base.is_dir():
        raise AgentsError("Skillebene ist kein Verzeichnis: %s" % base)
    target = skill_dir(base, name)
    stage = _stage_name(base, name, "creating")
    try:
        _write_files(stage, files, library_modes, art)
        if files_version(skill_files(stage)) != files_version(files):
            raise AgentsError("Kopie des Skills weicht vom Stand ab")
        old = None
        if target.exists():
            old = _stage_name(base, name, "alt")
            os.replace(target, old)
        os.replace(stage, target)
        if old is not None:
            shutil.rmtree(old, ignore_errors=True)
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)


# ---------------------------------------------------------------------------
# SKILL.md
# ---------------------------------------------------------------------------

def _normalize_heading(text: str) -> str:
    value = text.strip().lower()
    for old, new in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        value = value.replace(old, new)
    return value


def parse_skill_md(text: str) -> dict[str, Any]:
    """Frontmatter (single-line ``key: value`` pairs) and level-2/3 section titles."""
    if not text.startswith("---\n"):
        raise AgentsError("SKILL.md beginnt nicht mit Frontmatter (---)")
    end = text.find("\n---", 3)
    if end < 0 or text[end + 4:end + 5] not in ("\n", ""):
        raise AgentsError("Frontmatter von SKILL.md ist nicht abgeschlossen")
    fields: dict[str, str] = {}
    for number, line in enumerate(text[4:end].split("\n"), start=2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*", line)
        if not match:
            raise AgentsError("Frontmatter-Zeile %d ist kein einzeiliges 'schluessel: wert'" % number)
        key, value = match.group(1), match.group(2)
        if value in ("|", ">", "|-", ">-"):
            raise AgentsError("Mehrzeilige Frontmatter-Werte werden nicht unterstuetzt (%s)" % key)
        if len(value) >= 2 and value[0] == value[-1] == '"':
            try:
                value = json.loads(value)
            except json.JSONDecodeError as exc:
                raise AgentsError("Frontmatter-Wert %s ist falsch zitiert" % key) from exc
        elif len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1].replace("''", "'")
        if key in fields:
            raise AgentsError("Frontmatter-Schluessel doppelt: %s" % key)
        fields[key] = value
    body = text[end + 4:]
    sections = []
    in_code = False
    for line in body.split("\n"):
        if line.startswith("```"):
            in_code = not in_code
            continue
        match = re.match(r"^#{2,3}\s+(.+?)\s*#*\s*$", line)
        if match and not in_code:
            sections.append(_normalize_heading(match.group(1)))
    return {"fields": fields, "sections": sections, "body": body}


def check_skill(folder: Path, expected_name: str | None = None) -> dict[str, Any]:
    """Validate a skill folder; errors make it unusable, hints are advice."""
    return check_files(folder.name, skill_files(folder), expected_name)


def check_files(name: str, files: dict[str, tuple[bytes, bool]], expected_name: str | None = None) -> dict[str, Any]:
    """Validate the files of skill ``name`` before or after they are written."""
    findings: list[dict[str, str]] = []

    def error(text: str) -> None:
        findings.append({"stufe": "fehler", "text": text})

    def hint(text: str) -> None:
        findings.append({"stufe": "hinweis", "text": text})

    description = None
    references: list[str] = []
    if "SKILL.md" not in files:
        error("SKILL.md fehlt")
    else:
        try:
            text = files["SKILL.md"][0].decode("utf-8")
        except UnicodeDecodeError:
            text = None
            error("SKILL.md ist kein UTF-8")
        if text is not None:
            try:
                parsed = parse_skill_md(text)
            except AgentsError as exc:
                error(str(exc))
                parsed = None
            if parsed is not None:
                fields = parsed["fields"]
                if fields.get("name") != name:
                    error("Frontmatter name '%s' passt nicht zum Ordner '%s'" % (fields.get("name"), name))
                description = (fields.get("description") or "").strip()
                if not description:
                    error("Frontmatter description fehlt")
                elif len(description) > DESCRIPTION_LIMIT:
                    error("description ist laenger als %d Zeichen" % DESCRIPTION_LIMIT)
                for key in REQUIRED_SECTIONS:
                    if key not in parsed["sections"]:
                        error("Abschnitt '%s' fehlt" % SECTION_TITLES[key])
                try:
                    references = script_references(fields.get("skripte"))
                except AgentsError as exc:
                    error(str(exc))
    if expected_name is not None and expected_name != name:
        error("Skillordner '%s' ist nicht der erwartete Skill '%s'" % (name, expected_name))
    scripts = sorted(rel for rel in files if rel.startswith("scripts/"))
    for rel in scripts:
        data, executable = files[rel]
        if not executable:
            hint("Skript ist nicht ausfuehrbar: %s" % rel)
        elif not data.startswith(b"#!"):
            hint("Skript ohne Shebang-Zeile: %s" % rel)
        stem = rel[len("scripts/"):].rsplit(".", 1)[0].replace("-", "_")
        if not any(other.startswith("tests/") and stem in other.replace("-", "_") for other in files):
            hint("Skript ohne Test unter tests/: %s" % rel)
    return {
        "art": "skill", "name": name, "description": description, "version": files_version(files),
        "dateien": sorted(files), "skripte": scripts, "verweise": references,
        "gueltig": not any(item["stufe"] == "fehler" for item in findings), "befunde": findings,
    }


def script_references(value: str | None) -> list[str]:
    """Names from the ``skripte:`` field of ``SKILL.md`` (comma or space separated), in order, once each."""
    names: list[str] = []
    for raw in re.split(r"[,\s]+", (value or "").strip()):
        if not raw:
            continue
        if not SKILL_NAME_RE.fullmatch(raw):
            raise AgentsError("skripte: '%s' ist kein gueltiger Skriptname" % raw)
        if raw not in names:
            names.append(raw)
    return names


# ---------------------------------------------------------------------------
# Stored scripts: one executable file with an instruction header
# ---------------------------------------------------------------------------

def parse_script_header(data: bytes) -> dict[str, str]:
    """The instruction header of a stored script.

    Line 1 is the shebang, line 2 ``# ---``; then ``# key: value`` lines up to the closing
    ``# ---``.  A line ``#   text`` (two or more spaces after ``#``) continues the previous
    value on a new line; a bare ``#`` is skipped.  The format needs nothing but ``#``
    comments, so shell, Python, Perl and Ruby scripts carry it alike.
    """
    try:
        text = data[:SKILL_FILE_LIMIT].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AgentsError("Skriptdatei ist kein UTF-8") from exc
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # the newline that ends the file is no line of its own
    if not lines or not lines[0].startswith("#!"):
        raise AgentsError("Skriptdatei beginnt nicht mit einer Shebang-Zeile")
    if len(lines) < 2 or lines[1].rstrip() != SCRIPT_HEADER_MARK:
        raise AgentsError("Zeile 2 der Skriptdatei muss '# ---' sein (Anweisungskopf)")
    fields: dict[str, str] = {}
    current: str | None = None
    for number, line in enumerate(lines[2:SCRIPT_HEADER_LINES], start=3):
        line = line.rstrip()
        if line == SCRIPT_HEADER_MARK:
            break
        if not line.startswith("#"):
            raise AgentsError("Anweisungskopf endet in Zeile %d ohne '# ---'" % number)
        body = line[1:]
        if not body.strip():
            continue
        if body.startswith("  ") and current is not None:
            fields[current] += "\n" + body.strip()
            continue
        match = re.fullmatch(r" ?([a-z]+):[ \t]*(.*)", body)
        if not match:
            raise AgentsError("Zeile %d des Anweisungskopfs ist kein '# schluessel: wert'" % number)
        key, value = match.group(1), match.group(2).strip()
        if key not in SCRIPT_HEADER_KEYS:
            raise AgentsError("Unbekannter Schluessel im Anweisungskopf: %s" % key)
        if key in fields:
            raise AgentsError("Schluessel im Anweisungskopf doppelt: %s" % key)
        fields[key] = value
        current = key
    else:
        raise AgentsError("Anweisungskopf ist nicht mit '# ---' abgeschlossen")
    return fields


def _script_file_names(name: str, rels: Iterable[str]) -> list[str]:
    return sorted(rel for rel in rels if "/" not in rel and (
        rel == name or (rel.startswith(name + ".") and re.fullmatch(r"[A-Za-z0-9]{1,16}", rel[len(name) + 1:]))))


def check_script_files(name: str, files: dict[str, tuple[bytes, bool]],
                       expected_name: str | None = None) -> dict[str, Any]:
    """Validate a stored script unit: one executable ``<name>[.<ext>]`` with header, optional ``tests/``."""
    findings: list[dict[str, str]] = []

    def error(text: str) -> None:
        findings.append({"stufe": "fehler", "text": text})

    header: dict[str, str] = {}
    candidates = _script_file_names(name, files)
    main = candidates[0] if len(candidates) == 1 else None
    if main is None:
        error("Skript-Einheit braucht genau eine Skriptdatei '%s' oder '%s.<endung>'" % (name, name))
    others = sorted(rel for rel in files if rel != main and not rel.startswith("tests/"))
    if others:
        error("Neben der Skriptdatei ist nur tests/ erlaubt: %s" % ", ".join(others))
    executables = sorted(rel for rel, (_, executable) in files.items() if executable and rel != main)
    if executables:
        error("Nur die Skriptdatei darf ausfuehrbar sein: %s" % ", ".join(executables))
    if main is not None:
        data, executable = files[main]
        if not executable:
            error("Skriptdatei ist nicht ausfuehrbar: %s" % main)
        try:
            header = parse_script_header(data)
        except AgentsError as exc:
            error(str(exc))
        else:
            if header.get("name") != name:
                error("Kopf name '%s' passt nicht zum Ordner '%s'" % (header.get("name"), name))
            for key in SCRIPT_HEADER_KEYS[1:]:
                if not header.get(key):
                    error("Kopfzeile '%s' fehlt oder ist leer" % key)
            if len(" ".join((header.get("zweck") or "").split())) > DESCRIPTION_LIMIT:
                error("zweck ist laenger als %d Zeichen" % DESCRIPTION_LIMIT)
    if expected_name is not None and expected_name != name:
        error("Skriptordner '%s' ist nicht das erwartete Skript '%s'" % (name, expected_name))
    if main is not None and not any(rel.startswith("tests/") and name.replace("-", "_") in rel.replace("-", "_")
                                    for rel in files):
        findings.append({"stufe": "hinweis", "text": "Skript ohne Test unter tests/: %s" % main})
    return {
        "art": "skript", "name": name, "description": " ".join((header.get("zweck") or "").split()) or None,
        "version": files_version(files), "dateien": sorted(files), "datei": main, "kopf": header,
        "aufruf": header.get("aufruf"),
        "gueltig": not any(item["stufe"] == "fehler" for item in findings), "befunde": findings,
    }


def check_unit_files(art: str, name: str, files: dict[str, tuple[bytes, bool]],
                     expected_name: str | None = None) -> dict[str, Any]:
    if valid_art(art) == "skript":
        return check_script_files(name, files, expected_name)
    return check_files(name, files, expected_name)


def check_unit(folder: Path, art: str, expected_name: str | None = None) -> dict[str, Any]:
    return check_unit_files(art, folder.name, skill_files(folder), expected_name)


def script_template(name: str, purpose: str, language: str = "sh") -> tuple[str, str]:
    """File name and text of a new stored script; the body refuses to run until it is written."""
    if language not in SCRIPT_LANGUAGES:
        raise AgentsError("Sprache muss %s sein" % ", ".join(SCRIPT_LANGUAGES))
    shebang, suffix = SCRIPT_LANGUAGES[language]
    header = "\n".join([
        shebang, SCRIPT_HEADER_MARK,
        "# name: %s" % name,
        "# zweck: %s" % purpose,
        "# aufruf: %s%s [ARGUMENTE]" % (name, suffix),
        "# eingaben: Argumente, gelesene Dateien und Umgebungsvariablen nennen.",
        "# ausgaben: stdout und Exit-Codes nennen (0 Erfolg, 1 fachlich nein, 2 falscher Aufruf).",
        "# grenzen: Läuft unter derselben Weltgrenze und denselben Bash-Mustern wie der Agent;",
        "#   lockert keine Agentenregel und ersetzt keine Freigabe.",
        SCRIPT_HEADER_MARK,
    ])
    if language == "python":
        body = ('"""%s: %s"""\nimport sys\n\n\ndef main(argv=None):\n'
                '    print("%s: noch ohne Inhalt", file=sys.stderr)\n    return 2\n\n\n'
                'if __name__ == "__main__":\n    raise SystemExit(main())\n') % (name, purpose.replace('"', "'"), name)
    else:
        body = 'set -eu\necho "%s: noch ohne Inhalt" >&2\nexit 2\n' % name
    return name + suffix, header + "\n" + body


def set_script_purpose(data: bytes, purpose: str) -> bytes:
    """Replace the ``zweck`` line (and its continuation lines) of a script header."""
    lines = data.decode("utf-8").split("\n")
    result, skipping, done = [], False, False
    for index, line in enumerate(lines):
        if index > 1 and not done and line.rstrip() == SCRIPT_HEADER_MARK:
            done = True
        if not done and index > 1 and re.match(r"# ?zweck:", line):
            result.append("# zweck: %s" % purpose)
            skipping = True
            continue
        if skipping and not done and line.startswith("#  "):
            continue
        skipping = False
        result.append(line)
    return "\n".join(result).encode("utf-8")


def frontmatter_value(value: str) -> str:
    """A plain YAML scalar where that is unambiguous, otherwise a JSON (= YAML) double-quoted one."""
    if value and re.fullmatch(r"[A-Za-z0-9ÄÖÜäöüß(][^:#\"'\n]*", value) and not value.endswith(" "):
        return value
    return json.dumps(value, ensure_ascii=False)


def set_description(text: str, description: str) -> str:
    parsed = parse_skill_md(text)
    end = text.find("\n---", 3)
    header = text[4:end].split("\n")
    line = "description: %s" % frontmatter_value(description)
    replaced = [line if re.match(r"description:", item) else item for item in header]
    if replaced == header and "description" not in parsed["fields"]:
        replaced.append(line)
    return "---\n" + "\n".join(replaced) + text[end:]


def skill_template(name: str, description: str) -> str:
    return (
        "---\n"
        "name: %s\n"
        "description: %s\n"
        "---\n\n"
        "# %s\n\n"
        "## Auslöser\n\n"
        "%s\n\n"
        "Nicht verwenden, wenn die Aufgabe nur einmal vorkommt oder ein vorhandener Skill sie abdeckt.\n\n"
        "## Vorgehen\n\n"
        "1. Den wiederkehrenden Ablauf in kurzen Schritten beschreiben.\n"
        "2. Jeden Schritt, der beim zweiten Mal gleich abläuft, als Skript unter `scripts/` ablegen\n"
        "   und hier mit seinem Aufruf nennen, statt ihn neu zu erklären.\n\n"
        "## Grenzen\n\n"
        "- Skripte laufen unter derselben Weltgrenze und denselben Bash-Mustern wie der Agent.\n"
        "- Der Skill lockert keine Agentenregel und ersetzt keine Freigabe.\n"
    ) % (name, frontmatter_value(description), name, description)


# ---------------------------------------------------------------------------
# Listing and resolution
# ---------------------------------------------------------------------------

def level_units(base: Path, level: str, owner: str | None = None, art: str = "skill") -> list[dict[str, Any]]:
    """Every skill or script folder of one level; invalid ones are listed, never followed."""
    if not base.exists() and not base.is_symlink():
        return []
    if base.is_symlink() or not base.is_dir():
        raise AgentsError("%sebene %s ist ungueltig" % (UNIT_TITLES[valid_art(art)], level))
    result = []
    for item in sorted(base.iterdir()):
        if item.name.startswith("."):
            continue  # staging folder of a running replacement
        if not item.is_dir() and not item.is_symlink():
            continue
        entry: dict[str, Any] = {"art": art, "name": item.name, "ebene": level, "pfad": str(item)}
        if owner:
            entry["agent"] = owner
        try:
            if not SKILL_NAME_RE.fullmatch(item.name):
                raise AgentsError("%sname ist ungueltig: %s" % (UNIT_TITLES[art], item.name))
            entry.update(check_unit(item, art))
        except (AgentsError, OSError) as exc:
            entry.update({"description": None, "version": None, "gueltig": False,
                          "befunde": [{"stufe": "fehler", "text": str(exc)}]})
        result.append(entry)
    return result


def level_skills(base: Path, level: str, owner: str | None = None) -> list[dict[str, Any]]:
    return level_units(base, level, owner, "skill")


def _public(entry: dict[str, Any]) -> dict[str, Any]:
    item = {key: entry.get(key) for key in ("art", "name", "ebene", "pfad", "version", "description")}
    item["art"] = item["art"] or "skill"
    if item["art"] == "skript":
        item["datei"] = str(Path(entry["pfad"]) / entry["datei"]) if entry.get("datei") else None
        item["aufruf"] = entry.get("aufruf")
    else:
        item["skripte"] = list(entry.get("verweise") or [])
    return item


def _resolve_units(levels: dict[str, list[dict[str, Any]]], names: Iterable[str],
                   preloaded: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Winner per name (first valid of agent, world, library), shadowed valid ones, invalid ones."""
    units, invalid = [], []
    for name in sorted(set(names)):
        candidates = [entry for level in LEVELS for entry in levels[level] if entry["name"] == name]
        winner = next((entry for entry in candidates if entry.get("gueltig")), None)
        for entry in candidates:
            if not entry.get("gueltig"):
                invalid.append({"art": entry["art"], "name": name, "ebene": entry["ebene"], "pfad": entry["pfad"],
                                "befunde": entry.get("befunde")})
        if winner is None:
            continue
        item = _public(winner)
        item["vorgeladen"] = name in preloaded
        item["verdeckt"] = [dict(_public(entry), gleich=entry.get("version") == winner["version"])
                            for entry in candidates if entry is not winner and entry.get("gueltig")]
        units.append(item)
    return units, invalid


def skill_directory(root: Path, agent_id: str, library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Resolve the skills and stored scripts of one agent.

    Skills: own and world skills, library skills named in the profile.  Scripts: own and
    world scripts, library scripts that a resolved skill names under ``skripte:`` or the
    profile names under ``skills``.  For each name the most specific valid folder wins
    (agent, world, library); the others are listed under ``verdeckt``.  Nothing is copied.
    """
    root = ad.world_path(str(root))
    world = ad.read_world(root)
    agent = ad.read_agent(root, agent_id)
    preloaded = [name for name in (agent.get("skills") or []) if isinstance(name, str)]

    def levels_of(art: str) -> dict[str, list[dict[str, Any]]]:
        return {
            "agent": level_units(level_root(root, "agent", agent_id, art=art), "agent", agent_id, art),
            "welt": level_units(level_root(root, "welt", art=art), "welt", None, art),
            "bibliothek": level_units(level_root(root, "bibliothek", library=library, art=art), "bibliothek", None, art),
        }

    def wanted(levels: dict[str, list[dict[str, Any]]], extra: Iterable[str]) -> set[str]:
        names = {entry["name"] for entry in levels["agent"] + levels["welt"]}
        names.update(name for name in extra if any(e["name"] == name for e in levels["bibliothek"]))
        return names

    skill_levels = levels_of("skill")
    skills, invalid = _resolve_units(skill_levels, wanted(skill_levels, preloaded), preloaded)
    used_by: dict[str, list[str]] = {}
    for skill in skills:
        for reference in skill["skripte"]:
            used_by.setdefault(reference, []).append(skill["name"])
    script_levels = levels_of("skript")
    scripts, invalid_scripts = _resolve_units(script_levels, wanted(script_levels, list(preloaded) + list(used_by)),
                                              preloaded)
    for script in scripts:
        script["genutzt_von"] = sorted(used_by.get(script["name"], []))
    resolved = {unit["name"] for unit in skills + scripts}
    missing = sorted({name for name in preloaded if name not in resolved})
    missing_scripts = [{"skript": name, "skills": sorted(users)} for name, users in sorted(used_by.items())
                       if name not in {script["name"] for script in scripts}]
    return {"schema_version": DIRECTORY_SCHEMA_VERSION, "agent": agent_id, "welt": world.get("id"),
            "bibliothek": str(level_root(root, "bibliothek", library=library)),
            "skript_bibliothek": str(level_root(root, "bibliothek", library=library, art="skript")),
            "skills": skills + scripts, "fehlend": missing, "fehlende_skripte": missing_scripts,
            "ungueltig": invalid + invalid_scripts}


def _write_directory_locked(root: Path, agent_id: str, library: str | os.PathLike[str] | None) -> dict[str, Any]:
    data = skill_directory(root, agent_id, library)
    path = ad._agent_dir(root, agent_id) / "skills.json"
    stored = ad._read_optional_json(path, "Skillverzeichnis")
    if isinstance(stored, dict) and {k: v for k, v in stored.items() if k != "updated_at"} == data:
        return dict(stored, geaendert=False)
    data["updated_at"] = ad.now()
    ad._write_json(path, data)
    return dict(data, geaendert=True)


def write_skill_directory(root: Path, agent_id: str | None = None,
                          library: str | os.PathLike[str] | None = None) -> list[dict[str, Any]]:
    """Write ``skills.json`` for one agent or for every agent of the world."""
    root = ad.world_path(str(root))
    with ad.transaction(root):
        ids = [agent_id] if agent_id else [agent["id"] for agent in ad.list_agents(root)]
        return [_write_directory_locked(root, item, library) for item in ids]


def world_project(root: Path) -> Path | None:
    """The project folder a world guards: ``<projekt>`` for ``<projekt>/.werkbank/agents``, ``~/AI`` for
    the global world (plan section 3), ``None`` when the layout names no project."""
    root = ad.world_path(str(root))
    if ad.read_world(root).get("kind") == "global":
        return Path.home() / "AI"
    if root.name == "agents" and root.parent.name == ".werkbank":
        return root.parent.parent
    return None


def _absolute_dir(value: str | os.PathLike[str] | None, label: str) -> str:
    if value is None or str(value) == "":
        return ""
    path = Path(os.path.abspath(os.path.expanduser(str(value))))
    if not path.is_dir():
        raise AgentsError("%s ist kein Ordner: %s" % (label, path))
    if os.path.realpath(path) in ("/", os.path.realpath(Path.home())):
        raise AgentsError("%s umfasst zu viel: %s" % (label, path))
    return str(path)


def profil_umgebung(root: Path, agent_id: str, worktree: str | os.PathLike[str] | None = None,
                    tmp: str | os.PathLike[str] | None = None,
                    project: str | os.PathLike[str] | None = None) -> dict[str, str]:
    """Environment for the profile lock hook: world, agent, ``agent.json``, the world's project folder,
    the agent's worktree and private temp folder.  An empty value means "not set"; the hook then grants
    nothing for that place."""
    root = ad.world_path(str(root))
    ad.read_agent(root, agent_id)
    guarded = project if project is not None else world_project(root)
    return {
        "WB_WELT": str(root),
        "WB_AGENT_ID": agent_id,
        "WB_AGENT_PROFIL": str(ad._agent_dir(root, agent_id) / "agent.json"),
        "WB_WELT_PROJEKT": _absolute_dir(guarded, "Projektordner") if guarded is not None and Path(guarded).is_dir() else "",
        "WB_AGENT_WORKTREE": _absolute_dir(worktree, "Worktree"),
        "WB_AGENT_TMP": _absolute_dir(tmp, "Temp-Ordner"),
    }


def skills_umgebung(root: Path, agent_id: str) -> dict[str, str]:
    """Environment for the skills lock hook and the agent's turn, from the written ``skills.json``.

    The carrier calls ``write_skill_directory`` first; the hook checks exactly that file.
    ``WB_SKILL_PFADE`` lists the folders of the resolved skills, ``WB_SKRIPT_PFADE`` those of
    the resolved stored scripts, each ``os.pathsep``-separated; a script folder's basename is
    its name.  ``WB_AGENT_PROFIL`` and ``WB_WELT_PROJEKT`` come from ``profil_umgebung``;
    worktree and temp folder are known only to the carrier and are passed there.
    """
    root = ad.world_path(str(root))
    ad.read_agent(root, agent_id)
    path = ad._agent_dir(root, agent_id) / "skills.json"
    data = ad._read_optional_json(path, "Skillverzeichnis")
    if not isinstance(data, dict):
        raise AgentsError("skills.json fehlt fuer %s; zuerst wb-skill verzeichnis" % agent_id)
    if data.get("agent") != agent_id or not isinstance(data.get("skills"), list):
        raise AgentsError("skills.json gehoert nicht zu %s" % agent_id)
    paths: dict[str, list[str]] = {"skill": [], "skript": []}
    for entry in data["skills"]:
        if isinstance(entry, dict) and isinstance(entry.get("pfad"), str):
            art = entry.get("art") or "skill"
            if art not in paths:
                raise AgentsError("skills.json enthaelt eine unbekannte Art: %r" % art)
            paths[art].append(entry["pfad"])
    if any(os.pathsep in path_ for items in paths.values() for path_ in items):
        raise AgentsError("Skillpfad enthaelt das Trennzeichen %r" % os.pathsep)
    profile = profil_umgebung(root, agent_id)

    def existing(value: Any) -> str:
        # The profile lock refuses every tool for a library variable that names no folder; a library
        # that does not exist grants nothing, so it is passed as "not set".
        return str(value) if isinstance(value, str) and value and os.path.isdir(value) else ""

    return {
        "WB_WELT": str(root),
        "WB_AGENT_ID": agent_id,
        "WB_AGENT_PROFIL": profile["WB_AGENT_PROFIL"],
        "WB_WELT_PROJEKT": profile["WB_WELT_PROJEKT"],
        "WB_SKILLS_JSON": str(path),
        "WB_SKILL_PFADE": os.pathsep.join(paths["skill"]),
        "WB_SKILL_BIBLIOTHEK": existing(data.get("bibliothek")),
        "WB_SKRIPT_PFADE": os.pathsep.join(paths["skript"]),
        "WB_SKRIPT_BIBLIOTHEK": existing(data.get("skript_bibliothek")),
    }


def list_skills(root: Path, agent_id: str | None = None,
                library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """The agent's directory, or every level: skills at the top, stored scripts under ``skripte``."""
    root = ad.world_path(str(root))
    if agent_id:
        return skill_directory(root, agent_id, library)

    def levels(art: str) -> dict[str, Any]:
        agents = {agent["id"]: level_units(level_root(root, "agent", agent["id"], art=art), "agent", agent["id"], art)
                  for agent in ad.list_agents(root)}
        return {"welt": level_units(level_root(root, "welt", art=art), "welt", None, art),
                "bibliothek": level_units(level_root(root, "bibliothek", library=library, art=art), "bibliothek",
                                          None, art),
                "agenten": agents}

    return dict(levels("skill"), skripte=levels("skript"))


def show_unit(root: Path, name: str, art: str = "skill", agent_id: str | None = None, level: str | None = None,
              library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    root = ad.world_path(str(root))
    valid_skill_name(name)
    valid_art(art)
    if level:
        order = [level]
    else:
        order = list(LEVELS) if agent_id else ["welt", "bibliothek"]
    for candidate in order:
        if candidate == "agent" and not agent_id:
            raise AgentsError("Ebene agent braucht --agent")
        folder = skill_dir(level_root(root, candidate, agent_id, library, art), name)
        if not folder.exists() and not folder.is_symlink():
            continue
        info = check_unit(folder, art)
        files = skill_files(folder)
        shown = "SKILL.md" if art == "skill" else info.get("datei")
        text = files.get(shown, (b"", False))[0] if shown else b""
        return dict(info, ebene=candidate, pfad=str(folder),
                    **{"skill_md" if art == "skill" else "inhalt": text[:SHOW_TEXT_LIMIT].decode("utf-8", errors="replace")},
                    gekuerzt=len(text) > SHOW_TEXT_LIMIT,
                    groessen={rel: len(data) for rel, (data, _) in files.items()},
                    ausfuehrbar=sorted(rel for rel, (_, executable) in files.items() if executable))
    raise AgentsError("%s nicht gefunden: %s" % (UNIT_TITLES[art], name))


def show_skill(root: Path, name: str, agent_id: str | None = None, level: str | None = None,
               library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    return show_unit(root, name, "skill", agent_id, level, library)


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------

def skill_diff(old: dict[str, tuple[bytes, bool]] | None, new: dict[str, tuple[bytes, bool]]) -> str:
    """Unified diff from ``old`` (``None``: new skill) to ``new``, readable by ``apply_diff``."""
    old = old or {}
    out: list[str] = []
    for rel in sorted(set(old) | set(new)):
        before = old.get(rel)
        after = new.get(rel)
        if before == after:
            continue
        if before is not None and after is not None and before[0] == after[0]:
            out.append("diff --git a/%s b/%s\n" % (rel, rel))
            out.append("old mode %s\nnew mode %s\n" % ("100755" if before[1] else "100644",
                                                      "100755" if after[1] else "100644"))
            continue
        try:
            a_text = before[0].decode("utf-8") if before else ""
            b_text = after[0].decode("utf-8") if after else ""
        except UnicodeDecodeError:
            out.append("Binaerdatei %s: %s -> %s\n" % (
                rel, hashlib.sha256(before[0]).hexdigest()[:12] if before else "neu",
                hashlib.sha256(after[0]).hexdigest()[:12] if after else "entfernt"))
            continue
        out.append("diff --git a/%s b/%s\n" % (rel, rel))
        if before is None:
            out.append("new file mode %s\n" % ("100755" if after[1] else "100644"))
        elif after is None:
            out.append("deleted file mode %s\n" % ("100755" if before[1] else "100644"))
        elif before[1] != after[1]:
            out.append("old mode %s\nnew mode %s\n" % ("100755" if before[1] else "100644",
                                                      "100755" if after[1] else "100644"))
        lines = difflib.unified_diff(a_text.splitlines(keepends=True), b_text.splitlines(keepends=True),
                                     fromfile="a/" + rel if before else "/dev/null",
                                     tofile="b/" + rel if after else "/dev/null", n=3)
        for line in lines:
            if line.endswith("\n"):
                out.append(line)
            else:
                out.append(line + "\n\\ No newline at end of file\n")
    return "".join(out)


def _diff_path(raw: str) -> str | None:
    value = raw.split("\t", 1)[0].strip()
    if value == "/dev/null":
        return None
    if value.startswith(("a/", "b/")):
        value = value[2:]
    _valid_rel(value)
    return value


def parse_diff(text: str) -> list[dict[str, Any]]:
    """Parse a unified or git diff strictly by hunk line counts."""
    if not isinstance(text, str) or not text.strip():
        raise AgentsError("Diff fehlt")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    files: list[dict[str, Any]] = []
    mode: bool | None = None
    git_path: str | None = None  # a git header without ---/+++ changes only the mode

    def flush_mode_only() -> None:
        if git_path and mode is not None and not any((f["neu"] or f["alt"]) == git_path for f in files):
            files.append({"alt": git_path, "neu": git_path, "hunks": [], "mode": mode})

    index = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("diff --git ") or line.startswith("index ") or line.startswith("similarity "):
            if line.startswith("diff --git "):
                flush_mode_only()
                match = re.fullmatch(r"diff --git a/(\S+) b/(\S+)", line.rstrip())
                git_path = _diff_path(match.group(2)) if match and match.group(1) == match.group(2) else None
                mode = None
            index += 1
            continue
        if line.startswith(("new file mode ", "new mode ")):
            mode = line.rstrip().endswith("755")
            index += 1
            continue
        if line.startswith(("old mode ", "deleted file mode ")):
            index += 1
            continue
        if line.startswith("rename ") or line.startswith("copy "):
            raise AgentsError("Umbenennungen im Diff werden nicht unterstuetzt")
        if line.startswith("Binary files") or line.startswith("GIT binary patch"):
            raise AgentsError("Binaerdiffs werden nicht unterstuetzt")
        if not line.startswith("--- "):
            if line.strip():
                raise AgentsError("Diff-Zeile %d ist nicht lesbar" % (index + 1))
            index += 1
            continue
        if index + 1 >= len(lines) or not lines[index + 1].startswith("+++ "):
            raise AgentsError("Diff-Zeile %d: '+++' fehlt" % (index + 2))
        old_path = _diff_path(lines[index][4:])
        new_path = _diff_path(lines[index + 1][4:])
        if old_path and new_path and old_path != new_path:
            raise AgentsError("Umbenennungen im Diff werden nicht unterstuetzt")
        if not old_path and not new_path:
            raise AgentsError("Diff nennt keine Datei")
        entry: dict[str, Any] = {"alt": old_path, "neu": new_path, "hunks": [], "mode": mode}
        mode = None
        git_path = None
        index += 2
        while index < len(lines) and lines[index].startswith("@@"):
            match = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", lines[index])
            if not match:
                raise AgentsError("Hunk-Kopf in Zeile %d ist ungueltig" % (index + 1))
            old_start, new_start = int(match.group(1)), int(match.group(3))
            old_len = int(match.group(2)) if match.group(2) is not None else 1
            new_len = int(match.group(4)) if match.group(4) is not None else 1
            index += 1
            body: list[tuple[str, str]] = []
            seen_old = seen_new = 0
            old_eol = new_eol = True
            while seen_old < old_len or seen_new < new_len:
                if index >= len(lines):
                    raise AgentsError("Hunk endet vorzeitig")
                current = lines[index]
                tag, content = (current[:1], current[1:]) if current else (" ", "")
                if tag == " ":
                    seen_old += 1
                    seen_new += 1
                elif tag == "-":
                    seen_old += 1
                elif tag == "+":
                    seen_new += 1
                else:
                    raise AgentsError("Hunk-Zeile %d ist ungueltig" % (index + 1))
                if seen_old > old_len or seen_new > new_len:
                    raise AgentsError("Hunk in Zeile %d hat mehr Zeilen als angegeben" % (index + 1))
                body.append((tag, content))
                index += 1
                if index < len(lines) and lines[index].startswith("\\"):
                    if tag in (" ", "-") and seen_old == old_len:
                        old_eol = False
                    if tag in (" ", "+") and seen_new == new_len:
                        new_eol = False
                    index += 1
            entry["hunks"].append({"old_start": old_start, "old_len": old_len, "new_start": new_start,
                                   "new_len": new_len, "lines": body, "old_eol": old_eol, "new_eol": new_eol})
        if not entry["hunks"] and entry["mode"] is None:
            raise AgentsError("Diff fuer %s enthaelt keine Aenderung" % (new_path or old_path))
        files.append(entry)
    flush_mode_only()
    if not files:
        raise AgentsError("Diff enthaelt keine Datei")
    return files


def _apply_file_diff(original: str | None, entry: dict[str, Any]) -> str | None:
    """Apply one file's hunks exactly, without fuzz; ``None`` means the file is deleted."""
    if entry["alt"] is None and original is not None:
        raise AgentsError("Diff legt %s neu an, die Datei existiert aber" % entry["neu"])
    if entry["alt"] is not None and original is None:
        raise AgentsError("Diff aendert %s, die Datei fehlt" % entry["alt"])
    source = (original or "").split("\n")
    had_eol = original is None or original.endswith("\n") or original == ""
    if original and original.endswith("\n"):
        source.pop()
    elif original == "" or original is None:
        source = []
    # Like patch's "previously applied" check: if every hunk's new side already stands at its
    # place, applying again would only duplicate the added lines.
    present = original is not None and bool(entry["hunks"]) and all(
        source[(h["new_start"] - 1 if h["new_len"] else h["new_start"]):][:h["new_len"]]
        == [content for tag, content in h["lines"] if tag in (" ", "+")] for h in entry["hunks"])
    if present and entry["neu"] is not None and not any(tag == "-" for h in entry["hunks"] for tag, _ in h["lines"]):
        return original
    result: list[str] = []
    position = 0
    new_eol = had_eol
    for hunk in entry["hunks"]:
        start = hunk["old_start"] - 1 if hunk["old_len"] else hunk["old_start"]
        if start < position or start > len(source):
            if present:
                return original
            raise AgentsError("Hunk passt nicht zu %s" % (entry["alt"] or entry["neu"]))
        result.extend(source[position:start])
        position = start
        for tag, content in hunk["lines"]:
            if tag in (" ", "-"):
                if position >= len(source) or source[position] != content:
                    if present and entry["neu"] is not None:
                        return original
                    raise AgentsError("Diff passt nicht zum Stand von %s (Zeile %d)" % (
                        entry["alt"] or entry["neu"], position + 1))
                position += 1
            if tag in (" ", "+"):
                result.append(content)
        if position == len(source):
            new_eol = hunk["new_eol"]
    result.extend(source[position:])
    if entry["neu"] is None:
        if result:
            raise AgentsError("Loeschdiff fuer %s entfernt nicht alle Zeilen" % entry["alt"])
        return None
    if not result:
        return ""
    return "\n".join(result) + ("\n" if new_eol else "")


def apply_diff(files: dict[str, tuple[bytes, bool]], diff: str, art: str = "skill") -> dict[str, tuple[bytes, bool]]:
    """Apply ``diff``; a new file with shebang becomes executable under ``scripts/`` of a skill
    or at the top of a script unit, unless the diff names a mode."""
    result = dict(files)
    for entry in parse_diff(diff):
        rel = entry["neu"] or entry["alt"]
        current = result.get(rel)
        if current is not None:
            try:
                text = current[0].decode("utf-8")
            except UnicodeDecodeError as exc:
                raise AgentsError("Datei %s ist kein UTF-8 und nicht per Diff aenderbar" % rel) from exc
        else:
            text = None
        if not entry["hunks"]:
            if current is None:
                raise AgentsError("Modusaenderung fuer fehlende Datei %s" % rel)
            result[rel] = (current[0], bool(entry["mode"]))
            continue
        changed = _apply_file_diff(text, entry)
        if changed is None:
            result.pop(rel, None)
            continue
        data = changed.encode("utf-8")
        if current is not None:
            executable = current[1] if entry["mode"] is None else bool(entry["mode"])
        elif entry["mode"] is not None:
            executable = bool(entry["mode"])
        else:
            place = ("/" not in rel) if art == "skript" else rel.startswith("scripts/")
            executable = place and data.startswith(b"#!")
        result[rel] = (data, executable)
    return result


# ---------------------------------------------------------------------------
# Actors, history
# ---------------------------------------------------------------------------

def _own_actor(root: Path, agent_id: str, sender: str | None) -> dict[str, Any]:
    ad.read_agent(root, agent_id)
    actor = ad._actor(root, sender or agent_id)
    if actor.get("kind") == "agent" and actor["id"] != agent_id:
        raise AgentsError("Agent '%s' aendert nur eigene Skills" % actor["id"])
    return actor


def _history(root: Path, agent_id: str, entry: dict[str, Any]) -> None:
    ad._append_history(root, agent_id, dict({"id": ad.new_id("h"), "time": ad.now()}, **entry))


def _world_log(root: Path, entry: dict[str, Any]) -> None:
    ad._append_jsonl(ad.child(root, WORLD_LOG), dict({"id": ad.new_id("sv"), "time": ad.now()}, **entry))


def _main_agent(root: Path) -> str:
    main = [agent["id"] for agent in ad.list_agents(root) if agent.get("stage") == "hauptagent"]
    if not main:
        raise AgentsError("Welt hat keinen Hauptagenten")
    return main[0]


def _reviewer(root: Path, agent: dict[str, Any], target: str) -> str:
    """Team leader of the proposer's team for world skills, otherwise the main agent."""
    if target == "welt" and agent.get("stage") == "mitglied" and agent.get("team"):
        leaders = sorted(other["id"] for other in ad.list_agents(root)
                         if other.get("stage") == "teamleiter" and other.get("team") == agent.get("team")
                         and other.get("state") != "archiviert")
        if leaders:
            return leaders[0]
    return _main_agent(root)


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------

def create_unit(root: Path, agent_id: str, name: str, description: str | None = None,
                source_level: str | None = None, sender: str | None = None,
                library: str | os.PathLike[str] | None = None, art: str = "skill",
                language: str = "sh") -> dict[str, Any]:
    """Create an own skill or stored script from the template, or as an editable copy of a world or
    library one.  ``description`` is the skill's description or the script's ``zweck``."""
    root = ad.world_path(str(root))
    valid_skill_name(name)
    title = UNIT_TITLES[valid_art(art)]
    description = " ".join((description or "").split())
    if source_level is None and not description:
        raise AgentsError("Beschreibung fehlt" if art == "skill" else "Zweck fehlt")
    if len(description) > DESCRIPTION_LIMIT:
        raise AgentsError("Beschreibung ist laenger als %d Zeichen" % DESCRIPTION_LIMIT)
    if source_level not in (None, "welt", "bibliothek"):
        raise AgentsError("Vorlage muss welt oder bibliothek sein")
    with ad.transaction(root):
        actor = _own_actor(root, agent_id, sender)
        base = level_root(root, "agent", agent_id, art=art)
        target = skill_dir(base, name)
        if target.exists() or target.is_symlink():
            raise AgentsError("%s existiert bereits: %s" % (title, name))
        if source_level:
            source = skill_dir(level_root(root, source_level, library=library, art=art), name)
            info = check_unit(source, art, name)
            if not info["gueltig"]:
                raise AgentsError("Vorlage ist ungueltig: %s" % "; ".join(f["text"] for f in info["befunde"]))
            files = skill_files(source)
            if description and art == "skill":
                text = set_description(files["SKILL.md"][0].decode("utf-8"), description)
                files["SKILL.md"] = (text.encode("utf-8"), files["SKILL.md"][1])
            elif description:
                data, executable = files[info["datei"]]
                files[info["datei"]] = (set_script_purpose(data, description), executable)
        elif art == "skill":
            files = {"SKILL.md": (skill_template(name, description).encode("utf-8"), False)}
        else:
            file_name, text = script_template(name, description, language)
            files = {file_name: (text.encode("utf-8"), True)}
        _clean_leftovers(base, name)
        _replace_folder(base, name, files, library_modes=False, art=art)
        info = check_unit(target, art, name)
        _history(root, agent_id, {"event": "skill", "art": art, "aktion": "neu", "skill": name, "ebene": "agent",
                                  "version": info["version"], "vorlage": source_level, "actor": actor})
        _write_directory_locked(root, agent_id, library)
    result = {"art": art, "name": name, "ebene": "agent", "agent": agent_id, "pfad": str(target),
              "version": info["version"], "gueltig": info["gueltig"], "befunde": info["befunde"]}
    if art == "skript":
        result["datei"] = str(target / info["datei"]) if info.get("datei") else None
    return result


def create_skill(root: Path, agent_id: str, name: str, description: str | None = None,
                 source_level: str | None = None, sender: str | None = None,
                 library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Create an own skill from the template, or as an editable copy of a world or library skill."""
    return create_unit(root, agent_id, name, description, source_level, sender, library, "skill")


def create_script(root: Path, agent_id: str, name: str, purpose: str | None = None,
                  source_level: str | None = None, sender: str | None = None,
                  library: str | os.PathLike[str] | None = None, language: str = "sh") -> dict[str, Any]:
    """Create an own stored script from the template (sh, bash, python) or as a copy of a world or library one."""
    return create_unit(root, agent_id, name, purpose, source_level, sender, library, "skript", language)


# ---------------------------------------------------------------------------
# Proposal, acceptance, rejection
# ---------------------------------------------------------------------------

def _proposal_dir(root: Path, ticket_id: str) -> Path:
    return ad.child(root, PROPOSAL_DIR, ad.valid_id(ticket_id, "Ticketkennung"))


def read_proposal(root: Path, ticket_id: str) -> dict[str, Any]:
    root = ad.world_path(str(root))
    path = _proposal_dir(root, ticket_id) / "vorschlag.json"
    data = ad._read_optional_json(path, "Skill-Vorschlag")
    if not isinstance(data, dict):
        raise AgentsError("Ticket %s ist kein Skill-Vorschlag" % ticket_id)
    return data


def _ticket_text(proposal: dict[str, Any], diff: str) -> tuple[str, str, str, dict[str, Any]]:
    """Ticket fields from the stored proposal only, so a repeated proposal yields the same ticket.

    A skill proposal keeps its text and limits exactly as before stored scripts existed; a script
    proposal says ``Skript`` and carries ``einheit: skript`` in the limits.
    """
    script = proposal.get("art") == "skript"
    unit = "Skript " if script else ""
    command = "wb-skill skript" if script else "wb-skill"
    title = "Skill-Vorschlag: %s%s von %s in %s" % (unit, proposal["skill"], proposal["agent"], proposal["ziel"])
    shown = diff if len(diff) <= TICKET_DIFF_LIMIT else diff[:TICKET_DIFF_LIMIT] + "\n[... gekuerzt; vollstaendig in diff.txt]\n"
    goal = "\n".join([
        "%s \"%s\" von %s in die Ebene %s übernehmen." % ("Skript" if script else "Skill", proposal["skill"],
                                                        proposal["agent"], proposal["ziel"]),
        "%s: %s" % ("Zweck" if script else "Beschreibung", proposal.get("beschreibung")),
        "Begründung: %s" % (proposal.get("begruendung") or "keine angegeben"),
        "Stand %s, Zielebene bisher %s." % (proposal["version"][:12],
                                           (proposal.get("basis_version") or "neu")[:12]),
        "Diff: %s/%s/diff.txt, vorgeschlagener Stand: %s/%s/stand/." % (
            PROPOSAL_DIR, proposal["id"], PROPOSAL_DIR, proposal["id"]),
        "Übernehmen: %s abnehmen <welt> %s --absender <prüfer>" % (command, proposal["id"]),
        "Ablehnen: %s ablehnen <welt> %s --absender <prüfer> --grund TEXT" % (command, proposal["id"]),
        "Prüfen: keine Agentenregel gelockert, keine Freigabe umgangen, kein doppelter Zweck.",
        "",
        shown,
    ])
    done = "Diff geprüft; mit %s abnehmen übernommen oder mit %s ablehnen begründet abgelehnt." % (command, command)
    limits = {"art": "skill-vorschlag", "skill": proposal["skill"], "ziel": proposal["ziel"],
              "version": proposal["version"], "basis_version": proposal.get("basis_version")}
    if script:
        limits["einheit"] = "skript"
    return title, goal, done, limits


def propose_skill(root: Path, agent_id: str, name: str, target: str, source: str | None = None,
                  from_world: str | os.PathLike[str] | None = None, reason: str | None = None,
                  sender: str | None = None, library: str | os.PathLike[str] | None = None,
                  art: str = "skill") -> dict[str, Any]:
    """Freeze a skill or stored script, compute its diff against the target level and open a
    ticket "Skill-Vorschlag".

    ``target`` ``welt`` takes the agent's own unit.  ``bibliothek`` is only possible in the
    global world and takes the own unit, the world unit (``source="welt"``) or the world
    unit of another world (``from_world``).  Repeating the same proposal returns it again.
    """
    root = ad.world_path(str(root))
    valid_skill_name(name)
    title = UNIT_TITLES[valid_art(art)]
    if target not in PROPOSAL_TARGETS:
        raise AgentsError("Ziel muss welt oder bibliothek sein")
    if source not in (None, "agent", "welt"):
        raise AgentsError("Quelle muss agent oder welt sein")
    reason = " ".join((reason or "").split())[:REASON_LIMIT] or None
    with ad.transaction(root):
        world = ad.read_world(root)
        actor = _own_actor(root, agent_id, sender)
        agent = ad.read_agent(root, agent_id)
        if target == "bibliothek" and world.get("kind") != "global":
            raise AgentsError("Bibliotheksvorschlaege gehen nur von der globalen Welt aus; "
                              "zuerst in die Welt uebernehmen")
        if from_world is not None:
            if target != "bibliothek":
                raise AgentsError("--aus-welt gilt nur fuer das Ziel bibliothek")
            other = ad.world_path(str(from_world))
            ad.read_world(other)
            source_dir = skill_dir(level_root(other, "welt", art=art), name)
            source_level, source_ref = "welt", str(other)
        elif source == "welt":
            if target != "bibliothek":
                raise AgentsError("Ein Welt%s kann nur in die Bibliothek vorgeschlagen werden" % title.lower())
            source_dir = skill_dir(level_root(root, "welt", art=art), name)
            source_level, source_ref = "welt", str(root)
        else:
            source_dir = skill_dir(level_root(root, "agent", agent_id, art=art), name)
            source_level, source_ref = "agent", agent_id
        if not source_dir.exists():
            raise AgentsError("%s %s fehlt in der Quelle %s" % (title, name, source_level))
        info = check_unit(source_dir, art, name)
        if not info["gueltig"]:
            raise AgentsError("%s ist ungueltig: %s" % (title, "; ".join(f["text"] for f in info["befunde"]
                                                                        if f["stufe"] == "fehler")))
        files = skill_files(source_dir)
        target_dir = skill_dir(level_root(root, target, library=library, art=art), name)
        base_files = skill_files(target_dir) if target_dir.exists() else None
        base_version = files_version(base_files) if base_files is not None else None
        if base_version == info["version"]:
            raise AgentsError("Die Ebene %s hat diesen Stand bereits" % target)
        reviewer = _reviewer(root, agent, target)
        ticket_id = ad.derived_id(art, agent_id, name, target, info["version"][:16])
        folder = _proposal_dir(root, ticket_id)
        if folder.exists():
            proposal = read_proposal(root, ticket_id)
            if proposal.get("stand") == "abgelehnt":
                raise AgentsError("Dieser Stand wurde bereits abgelehnt (%s); erst den %s aendern" % (ticket_id, title))
        else:
            diff = skill_diff(base_files, files)
            proposal = {
                "schema_version": SCHEMA_VERSION, "id": ticket_id, "ticket": ticket_id, "agent": agent_id,
                "art": art, "skill": name, "ziel": target, "quelle": {"ebene": source_level, "ort": source_ref},
                "version": info["version"], "basis_version": base_version, "beschreibung": info["description"],
                "begruendung": reason, "pruefer": reviewer, "stand": "offen", "erstellt_at": ad.now(),
                "actor": actor, "ticket_angelegt": False,
            }
            parent = ad.child(root, PROPOSAL_DIR)
            parent.mkdir(exist_ok=True)
            stage = parent / (".%s.creating-%s" % (ticket_id, uuid.uuid4().hex))
            try:
                stage.mkdir()
                _write_files(stage / "stand", files, library_modes=False, art=art)
                ad._write_text(stage / "diff.txt", diff)
                ad._write_json(stage / "vorschlag.json", proposal)
                os.replace(stage, folder)
            finally:
                if stage.exists():
                    shutil.rmtree(stage, ignore_errors=True)
        diff = _read_file(folder / "diff.txt", SKILL_TOTAL_LIMIT * 2).decode("utf-8")
    title, goal, done, limits = _ticket_text(proposal, diff)
    ticket = ad.create_ticket(root, title, goal, done, [proposal["pruefer"]], agent_id, None,
                              limits=limits, ticket_id=ticket_id)
    with ad.transaction(root):
        proposal = read_proposal(root, ticket_id)
        if not proposal.get("ticket_angelegt"):
            proposal["ticket_angelegt"] = True
            ad._write_json(_proposal_dir(root, ticket_id) / "vorschlag.json", proposal)
            _world_log(root, {"event": "vorschlag", "art": art, "skill": name, "ziel": target, "agent": agent_id,
                              "ticket": ticket_id, "version": proposal["version"],
                              "basis_version": proposal.get("basis_version"), "actor": actor})
            _history(root, agent_id, {"event": "skill", "art": art, "aktion": "vorschlag", "skill": name,
                                      "ziel": target, "ticket": ticket_id, "version": proposal["version"],
                                      "actor": actor})
    return {"ticket": ticket_id, "art": art, "skill": name, "ziel": target, "pruefer": proposal["pruefer"],
            "version": proposal["version"], "basis_version": proposal.get("basis_version"),
            "diff": str(_proposal_dir(root, ticket_id) / "diff.txt"), "ticket_stand": ticket.get("state")}


def _reviewer_actor(root: Path, proposal: dict[str, Any], ticket: dict[str, Any], sender: str | None) -> dict[str, Any]:
    if not sender:
        raise AgentsError("--absender fehlt")
    actor = ad._actor(root, sender)
    if actor.get("kind") == "external":
        return actor
    if actor["id"] == proposal["agent"]:
        raise AgentsError("Der Vorschlagende nimmt seinen eigenen Skill nicht ab")
    if actor["id"] not in (ticket.get("recipients") or []):
        raise AgentsError("Nur der adressierte Pruefer nimmt diesen Vorschlag ab")
    role = actor.get("role")
    if proposal["ziel"] == "bibliothek":
        if role != "hauptagent" or ad.read_world(root).get("kind") != "global":
            raise AgentsError("Bibliotheksskills nimmt nur der Hauptagent der globalen Welt ab")
    elif role == "teamleiter":
        if ad.read_agent(root, proposal["agent"]).get("team") != ad.read_agent(root, actor["id"]).get("team"):
            raise AgentsError("Teamleiter nimmt nur Skills seines Teams ab")
    elif role != "hauptagent":
        raise AgentsError("Mitglieder nehmen keine Skills ab")
    return actor


def _begin_ticket(root: Path, ticket: dict[str, Any], actor: dict[str, Any], prefix: str) -> str:
    """Claim the proposal ticket for its reviewer; returns the assignee."""
    assignee = actor["id"] if actor.get("kind") == "agent" else (ticket.get("recipients") or [None])[0]
    state = ticket.get("state")
    if state in ("offen", "zurückgegeben"):
        ad.claim_ticket(root, ticket["id"], assignee, actor["id"], None)
    elif state == "läuft":
        if ticket.get("assignee") != assignee and actor.get("kind") != "external":
            raise AgentsError("Ticket wird von %s bearbeitet" % ticket.get("assignee"))
        assignee = ticket.get("assignee")
    elif state in ("zur Abnahme", "abgenommen"):
        text = ((ticket.get("result") or {}).get("text") or "")
        if not text.startswith(prefix):
            raise AgentsError("Ticket ist bereits %s mit anderem Ergebnis" % state)
        assignee = ticket.get("assignee")
    else:
        raise AgentsError("Ticket ist %s; keine Entscheidung ueber den Vorschlag moeglich" % state)
    return assignee


def _finish_ticket(root: Path, ticket_id: str, assignee: str, actor: dict[str, Any], text: str,
                   note: str | None) -> dict[str, Any]:
    ticket = ad.read_ticket(root, ticket_id)
    if ticket.get("state") == "läuft":
        ticket = ad.write_result(root, ticket_id, assignee, text, None, actor["id"], None)
    # A team leader closes the ticket too: the data library lets a leader approve an own
    # ticket sent by a member of the team, and _reviewer_actor only lets that leader decide.
    if ticket.get("state") == "zur Abnahme" and (actor.get("kind") == "external"
                                                 or actor.get("role") in ("hauptagent", "teamleiter")):
        ticket = ad.approve_ticket(root, ticket_id, actor["id"], None, note, True)
    return ticket


def accept_proposal(root: Path, ticket_id: str, sender: str | None, note: str | None = None,
                    library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Copy the proposed state to the target level, keep the replaced state, log it, close the ticket.

    A team leader's acceptance approves the ticket as well (``approve_ticket`` allows a leader
    an own ticket from a member of the team).
    """
    root = ad.world_path(str(root))
    proposal = read_proposal(root, ticket_id)
    ticket = ad.read_ticket(root, ticket_id)
    if (ticket.get("limits") or {}).get("art") != "skill-vorschlag":
        raise AgentsError("Ticket %s ist kein Skill-Vorschlag" % ticket_id)
    if proposal.get("stand") == "abgelehnt":
        raise AgentsError("Vorschlag wurde bereits abgelehnt")
    actor = _reviewer_actor(root, proposal, ticket, sender)
    assignee = _begin_ticket(root, ticket, actor, RESULT_ACCEPTED)
    name, target, art = proposal["skill"], proposal["ziel"], valid_art(proposal.get("art") or "skill")
    with ad.transaction(root):
        proposal = read_proposal(root, ticket_id)
        folder = _proposal_dir(root, ticket_id)
        files = skill_files(folder / "stand")
        if files_version(files) != proposal["version"]:
            raise AgentsError("Vorgeschlagener Stand wurde veraendert; Vorschlag ungueltig")
        base = level_root(root, target, library=library, art=art)
        base.mkdir(parents=True, exist_ok=True)
        _clean_leftovers(base, name)
        target_dir = skill_dir(base, name)
        current = skill_version(target_dir) if target_dir.exists() else None
        previous = folder / "vorher"
        if proposal.get("stand") != "übernommen":
            if current != proposal["version"]:
                recovered = current is None and previous.exists() and skill_version(previous) == proposal.get("basis_version")
                if current != proposal.get("basis_version") and not recovered:
                    raise AgentsError("Der %s der Ebene %s hat sich seit dem Vorschlag geaendert; "
                                      "neuer Vorschlag noetig" % (UNIT_TITLES[art], target))
                if current is not None and not previous.exists():
                    _replace_folder(folder, "vorher", skill_files(target_dir), library_modes=False, art=art)
                _replace_folder(base, name, files, library_modes=(target == "bibliothek"), art=art)
            proposal.update({"stand": "übernommen", "entschieden_at": ad.now(), "entschieden_von": actor,
                             "bemerkung": note})
            ad._write_json(folder / "vorschlag.json", proposal)
            _world_log(root, {"event": "abgenommen", "art": art, "skill": name, "ziel": target,
                              "agent": proposal["agent"], "ticket": ticket_id, "version": proposal["version"],
                              "vorher": proposal.get("basis_version"), "actor": actor, "bemerkung": note})
            _history(root, proposal["agent"], {"event": "skill", "art": art, "aktion": "abgenommen", "skill": name,
                                               "ziel": target, "ticket": ticket_id,
                                               "version": proposal["version"], "actor": actor})
        for agent in ad.list_agents(root):
            _write_directory_locked(root, agent["id"], library)
    text = "%s %s%s Version %s in Ebene %s." % (RESULT_ACCEPTED, "Skript " if art == "skript" else "", name,
                                                proposal["version"][:12], target)
    ticket = _finish_ticket(root, ticket_id, assignee, actor, text, note)
    return {"ticket": ticket_id, "art": art, "skill": name, "ziel": target, "version": proposal["version"],
            "pfad": str(skill_dir(level_root(root, target, library=library, art=art), name)),
            "vorher": str(_proposal_dir(root, ticket_id) / "vorher") if proposal.get("basis_version") else None,
            "ticket_stand": ticket.get("state")}


def reject_proposal(root: Path, ticket_id: str, sender: str | None, reason: str) -> dict[str, Any]:
    root = ad.world_path(str(root))
    reason = " ".join((reason or "").split())
    if not reason:
        raise AgentsError("Grund fehlt")
    proposal = read_proposal(root, ticket_id)
    ticket = ad.read_ticket(root, ticket_id)
    if (ticket.get("limits") or {}).get("art") != "skill-vorschlag":
        raise AgentsError("Ticket %s ist kein Skill-Vorschlag" % ticket_id)
    if proposal.get("stand") == "übernommen":
        raise AgentsError("Vorschlag wurde bereits uebernommen")
    actor = _reviewer_actor(root, proposal, ticket, sender)
    assignee = _begin_ticket(root, ticket, actor, RESULT_REJECTED)
    art = valid_art(proposal.get("art") or "skill")
    with ad.transaction(root):
        proposal = read_proposal(root, ticket_id)
        if proposal.get("stand") != "abgelehnt":
            proposal.update({"stand": "abgelehnt", "entschieden_at": ad.now(), "entschieden_von": actor,
                             "grund": reason})
            ad._write_json(_proposal_dir(root, ticket_id) / "vorschlag.json", proposal)
            _world_log(root, {"event": "abgelehnt", "art": art, "skill": proposal["skill"], "ziel": proposal["ziel"],
                              "agent": proposal["agent"], "ticket": ticket_id, "actor": actor, "grund": reason})
            _history(root, proposal["agent"], {"event": "skill", "art": art, "aktion": "abgelehnt",
                                               "skill": proposal["skill"], "ziel": proposal["ziel"],
                                               "ticket": ticket_id, "actor": actor, "grund": reason})
    text = "%s %s%s. Grund: %s" % (RESULT_REJECTED, "Skript " if art == "skript" else "", proposal["skill"],
                                   proposal.get("grund") or reason)
    ticket = _finish_ticket(root, ticket_id, assignee, actor, text, reason)
    return {"ticket": ticket_id, "art": art, "skill": proposal["skill"], "stand": "abgelehnt",
            "ticket_stand": ticket.get("state")}


# ---------------------------------------------------------------------------
# Duplicate purpose (finding only)
# ---------------------------------------------------------------------------

_STOPWORDS = {"eine", "einen", "einem", "einer", "und", "oder", "nicht", "wenn", "fuer", "für", "mit", "aus",
              "the", "and", "for", "with", "when", "from", "into", "that", "this", "your", "use", "über",
              "ueber", "dass", "wird", "werden", "sind", "auch", "nach", "eines", "skill"}


def _words(text: str | None) -> set[str]:
    return {word for word in re.findall(r"[a-zäöüß0-9]+", (text or "").lower())
            if len(word) >= 4 and word not in _STOPWORDS}


def merge_findings(root: Path, agent_id: str | None = None, names: Iterable[str] = (),
                   threshold: float = 0.5, library: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Find skills and stored scripts with the same purpose.  Nothing is deleted or changed."""
    root = ad.world_path(str(root))
    if not 0 < threshold <= 1:
        raise AgentsError("Schwelle muss zwischen 0 und 1 liegen")
    wanted = {valid_skill_name(name) for name in names}
    skills: list[dict[str, Any]] = []
    for art in ARTS:
        skills += level_units(level_root(root, "bibliothek", library=library, art=art), "bibliothek", None, art) + \
            level_units(level_root(root, "welt", art=art), "welt", None, art)
        for agent in ad.list_agents(root):
            if agent_id and agent["id"] != agent_id:
                continue
            skills += level_units(level_root(root, "agent", agent["id"], art=art), "agent", agent["id"], art)
    skills = [skill for skill in skills if skill.get("gueltig")]

    def ref(skill: dict[str, Any]) -> dict[str, Any]:
        return {"art": skill["art"], "name": skill["name"], "ebene": skill["ebene"], "agent": skill.get("agent"),
                "pfad": skill["pfad"], "version": skill["version"]}

    def relevant(*items: dict[str, Any]) -> bool:
        return not wanted or any(item["name"] in wanted for item in items)

    findings: list[dict[str, Any]] = []
    by_name: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for skill in skills:
        by_name.setdefault((skill["art"], skill["name"]), []).append(skill)
    for (art, name), group in sorted(by_name.items()):
        if len(group) < 2 or not relevant(*group):
            continue
        identical = len({skill["version"] for skill in group}) == 1
        findings.append({
            "art": "gleicher-name", "skills": [ref(skill) for skill in group], "identisch": identical,
            "empfehlung": ("Gleicher Stand an mehreren Orten: die spezifischere Kopie kann entfallen, "
                           "sobald der Hauptagent es entscheidet." if identical else
                           "Abweichende Fassungen desselben %ss: Hauptagent führt sie zusammen und "
                           "schlägt die bessere Fassung für die höhere Ebene vor." % UNIT_TITLES[art]),
        })
    for index, first in enumerate(skills):
        for second in skills[index + 1:]:
            if (first["art"], first["name"]) == (second["art"], second["name"]) or not relevant(first, second):
                continue
            a, b = _words(first.get("description")), _words(second.get("description"))
            if not a or not b:
                continue
            score = len(a & b) / len(a | b)
            if score >= threshold:
                findings.append({
                    "art": "aehnlicher-zweck", "skills": [ref(first), ref(second)], "aehnlichkeit": round(score, 2),
                    "gemeinsame_woerter": sorted(a & b),
                    "empfehlung": "Beschreibungen decken sich; prüfen, ob ein Skill genügt.",
                })
    scripts: dict[str, list[tuple[dict[str, Any], str]]] = {}
    for skill in skills:
        for rel, (data, _) in skill_files(Path(skill["pfad"])).items():
            if (rel.startswith("scripts/") if skill["art"] == "skill" else rel == skill.get("datei")):
                scripts.setdefault(hashlib.sha256(data).hexdigest(), []).append((skill, rel))
    for digest, group in sorted(scripts.items()):
        if len({(skill["art"], skill["name"]) for skill, _ in group}) < 2 or \
                not relevant(*(skill for skill, _ in group)):
            continue
        stored = any(skill["art"] == "skript" for skill, _ in group)
        findings.append({
            "art": "gleiches-skript", "sha256": digest,
            "skills": [dict(ref(skill), skript=rel) for skill, rel in group],
            "empfehlung": ("Ein Skill kopiert ein gespeichertes Skript: Kopie entfernen und in SKILL.md unter "
                           "skripte: verweisen." if stored else
                           "Dasselbe Skript in mehreren Skills: als gespeichertes Skript auf höherer Ebene "
                           "ablegen und unter skripte: verweisen."),
        })
    return {"befunde": findings, "anzahl_skills": len(skills),
            "hinweis": "Befund, kein automatisches Löschen; zusammengeführt wird über einen Vorschlag."}


# ---------------------------------------------------------------------------
# Learning step
# ---------------------------------------------------------------------------

def read_learning_step(run_dir: str | os.PathLike[str]) -> Optional[dict[str, Any]]:
    """Read and validate ``lernschritt.json`` of a run directory; ``None`` if it is missing."""
    folder = Path(os.path.abspath(os.path.expanduser(str(run_dir))))
    if folder.is_symlink() or not folder.is_dir():
        raise AgentsError("Zugordner fehlt oder ist ein Symlink")
    path = folder / LEARN_FILE
    if path.is_symlink():
        raise AgentsError("lernschritt.json darf kein Symlink sein")
    if not path.exists():
        return None
    raw = _read_file(path, LEARN_FILE_LIMIT)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AgentsError("lernschritt.json ist kein gueltiges JSON") from exc
    if not isinstance(data, dict):
        raise AgentsError("lernschritt.json muss ein Objekt sein")
    unknown = sorted(set(data) - set(LEARN_FIELDS))
    if unknown:
        raise AgentsError("Unbekannte Felder im Lernschritt: %s" % ", ".join(unknown))
    if data.get("schema_version", SCHEMA_VERSION) != SCHEMA_VERSION:
        raise AgentsError("Unbekannte Schema-Version des Lernschritts")
    kind = data.get("art")
    if kind not in LEARN_KINDS:
        raise AgentsError("Art des Lernschritts muss %s sein" % ", ".join(LEARN_KINDS))
    for key in ("ziel", "text", "grund", "diff", "titel", "thema"):
        if key in data and data[key] is not None and not isinstance(data[key], str):
            raise AgentsError("Feld %s muss Text sein" % key)
    step: dict[str, Any] = {"art": kind, "sha256": hashlib.sha256(raw).hexdigest(), "zug": folder.name}
    reason = " ".join((data.get("grund") or "").split())
    if len(reason) > REASON_LIMIT:
        raise AgentsError("Grund ist laenger als %d Zeichen" % REASON_LIMIT)
    if kind != "nichts" and not reason:
        raise AgentsError("Grund fehlt")
    step["grund"] = reason or None
    if kind == "lehre":
        text = " ".join((data.get("text") or "").split())
        if not text:
            raise AgentsError("Text der Lehre fehlt")
        if len(text) > LESSON_TEXT_LIMIT:
            raise AgentsError("Lehre ist laenger als %d Zeichen; Lehren sind kurz" % LESSON_TEXT_LIMIT)
        step.update(ziel="MEMORY.md", text=text)
    elif kind == "notiz":
        titel = " ".join((data.get("titel") or "").split())
        if not titel:
            raise AgentsError("Titel der Notiz fehlt")
        if len(titel) > ab.TITEL_LIMIT:
            raise AgentsError("Titel ist laenger als %d Zeichen" % ab.TITEL_LIMIT)
        text = (data.get("text") or "").strip("\n")
        if not text.strip():
            raise AgentsError("Text der Notiz fehlt")
        if len(text.encode("utf-8")) > ab.TEXT_LIMIT:
            raise AgentsError("Notiz ist groesser als %d Bytes" % ab.TEXT_LIMIT)
        if data.get("anhaengen") is not None and not isinstance(data["anhaengen"], bool):
            raise AgentsError("anhaengen muss true oder false sein")
        thema = " ".join((data.get("thema") or "").split()) or None
        step.update(ziel="brain", titel=titel, text=text, thema=thema, anhaengen=bool(data.get("anhaengen")))
    elif kind == "archiv":
        zeilen = data.get("zeilen")
        if not isinstance(zeilen, list) or not zeilen or len(zeilen) > ag.AUSWAHL_LIMIT or not all(
                isinstance(item, (int, str)) and not isinstance(item, bool) for item in zeilen):
            raise AgentsError("zeilen nennt 1 bis %d Zeilen (Nummer oder genauer Text)" % ag.AUSWAHL_LIMIT)
        neu = data.get("neu")
        if neu is not None and (not isinstance(neu, list) or len(neu) > ag.NEU_LIMIT
                                or not all(isinstance(item, str) for item in neu)):
            raise AgentsError("neu ist eine Liste mit hoechstens %d Zeilen" % ag.NEU_LIMIT)
        step.update(ziel="lehren.md", zeilen=list(zeilen), neu=list(neu or []))
    elif kind == "anweisung":
        target = data.get("ziel") or "AGENTS.md"
        if target not in INSTRUCTION_FILES:
            raise AgentsError("Ziel einer Anweisung muss AGENTS.md oder CLAUDE.md sein")
        if not (data.get("diff") or "").strip():
            raise AgentsError("Diff der Anweisung fehlt")
        step.update(ziel=target, diff=data["diff"])
    elif kind in ARTS:
        step.update(ziel=valid_skill_name(data.get("ziel") or ""), diff=data.get("diff") or "")
        if not step["diff"].strip():
            raise AgentsError("Diff des %ss fehlt" % UNIT_TITLES[kind])
    else:
        step.update(ziel=None, text=" ".join((data.get("text") or "").split())[:LESSON_TEXT_LIMIT] or None)
    return step


def _add_lesson(memory: str, line: str) -> str:
    lines = memory.split("\n")
    if MEMORY_PLACEHOLDER in lines:
        lines.remove(MEMORY_PLACEHOLDER)
    try:
        start = lines.index(LESSONS_HEADING)
    except ValueError:
        while lines and not lines[-1].strip():
            lines.pop()
        return "\n".join(lines + ["", LESSONS_HEADING, "", line]) + "\n"
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^#{1,2} ", lines[i])), len(lines))
    insert = end
    while insert > start + 1 and not lines[insert - 1].strip():
        insert -= 1
    lines[insert:insert] = [line] if insert > start + 1 else ["", line]
    text = "\n".join(lines)
    return text if text.endswith("\n") else text + "\n"


def _apply_lesson(root: Path, agent_id: str, step: dict[str, Any], date: str) -> dict[str, Any]:
    path = ad._agent_dir(root, agent_id) / "MEMORY.md"
    if path.is_symlink():
        raise AgentsError("Gedaechtnisdatei darf kein Symlink sein")
    before = _read_file(path, ad.MEMORY_WRITE_LIMIT).decode("utf-8") if path.exists() else ""
    line = "- %s: %s Grund: %s" % (date, step["text"], step["grund"])
    if any(existing.endswith(": %s Grund: %s" % (step["text"], step["grund"])) for existing in before.split("\n")):
        return {"status": "vorhanden"}
    after = ag.normalisieren(_add_lesson(before, line), agent_id)
    if len(after.encode("utf-8")) > MEMORY_LIMIT:
        return {"status": "abgewiesen",
                "fehler": "MEMORY.md waere groesser als %d Bytes; erst Altes zusammenfassen" % MEMORY_LIMIT}
    ad._write_text(path, after)
    result = {"status": "angewendet", "zeile": line,
              "sha256_vorher": hashlib.sha256(before.encode("utf-8")).hexdigest(),
              "sha256_nachher": hashlib.sha256(after.encode("utf-8")).hexdigest()}
    if ag.messen(after)["ueber_grenze"]:
        # Die Lehre geht nicht verloren; der naechste Zug ist "Gedaechtnis kuerzen" (agents_traeger).
        result.update(ueber_grenze=True, hinweis="MEMORY.md ist ueber der Grenze von %d Zeichen oder %d Zeilen; "
                                                 "der naechste Zug kuerzt es" % (ag.GRENZE_ZEICHEN, ag.GRENZE_ZEILEN))
    return result


def _apply_brain_step(root: Path, agent_id: str, step: dict[str, Any], run_name: str, date: str,
                      brain: Any) -> dict[str, Any]:
    """Lernschritte notiz und archiv: ins Brain ueber agents_brain, ausserhalb der Welttransaktion."""
    if not brain:
        return {"status": "abgewiesen", "fehler": "Kein Brain-Vault auf diesem Traeger eingerichtet"}
    try:
        if step["art"] == "notiz":
            result = ab.notiz(brain, root, agent_id, step["titel"], step["text"], thema=step.get("thema"),
                              anhaengen=bool(step.get("anhaengen")), zug=run_name, datum=date)
            return {"status": "angewendet", "brain": {key: result.get(key) for key in ("rel", "status", "commit", "sync")}}
        result = ag.archivieren(root, agent_id, step["zeilen"], brain, zug=run_name, neu=step.get("neu"), datum=date)
        brain_result = result.pop("brain")
        result["brain"] = {key: brain_result.get(key) for key in ("rel", "status", "commit", "sync")}
        return result
    except (AgentsError, OSError, ValueError) as exc:
        return {"status": "abgewiesen", "fehler": str(exc)[:300]}


def _apply_instruction(root: Path, agent_id: str, step: dict[str, Any]) -> dict[str, Any]:
    path = ad._agent_dir(root, agent_id) / step["ziel"]
    if path.is_symlink():
        raise AgentsError("Anweisungsdatei darf kein Symlink sein")
    if not path.exists():
        return {"status": "abgewiesen", "fehler": "%s fehlt im Agentenordner" % step["ziel"]}
    entries = parse_diff(step["diff"])
    if len(entries) != 1 or (entries[0]["neu"] or entries[0]["alt"]) not in (step["ziel"],):
        return {"status": "abgewiesen", "fehler": "Diff muss genau die Datei %s aendern" % step["ziel"]}
    if any(tag == "-" for hunk in entries[0]["hunks"] for tag, _ in hunk["lines"]) or entries[0]["neu"] is None:
        return {"status": "abgewiesen",
                "fehler": "Anweisungsdiff entfernt bestehende Zeilen; automatisch gelten nur Ergaenzungen"}
    before = _read_file(path, INSTRUCTIONS_LIMIT).decode("utf-8")
    after = _apply_file_diff(before, entries[0])
    if after is None or len(after.encode("utf-8")) > INSTRUCTIONS_LIMIT:
        return {"status": "abgewiesen", "fehler": "Anweisungsdatei waere groesser als %d Bytes" % INSTRUCTIONS_LIMIT}
    if after == before:
        return {"status": "vorhanden"}
    ad._write_text(path, after)
    return {"status": "angewendet", "sha256_vorher": hashlib.sha256(before.encode("utf-8")).hexdigest(),
            "sha256_nachher": hashlib.sha256(after.encode("utf-8")).hexdigest()}


def _apply_skill_change(root: Path, agent_id: str, step: dict[str, Any],
                        library: str | os.PathLike[str] | None, art: str = "skill") -> dict[str, Any]:
    name = step["ziel"]
    title = UNIT_TITLES[valid_art(art)]
    own_base = level_root(root, "agent", agent_id, art=art)
    own = skill_dir(own_base, name)
    upper_level = None
    if own.exists():
        files = skill_files(own)
    else:
        for level in ("welt", "bibliothek"):
            candidate = skill_dir(level_root(root, level, library=library, art=art), name)
            if candidate.exists() and check_unit(candidate, art, name)["gueltig"]:
                upper_level, files = level, skill_files(candidate)
                break
        else:
            files = {}
    before = files_version(files) if files else None
    changed = apply_diff(files, step["diff"], art)
    if files_version(changed) == before:
        return {"status": "vorhanden", "skill": name}
    if sum(len(data) for data, _ in changed.values()) > SKILL_TOTAL_LIMIT or len(changed) > SKILL_FILES_LIMIT:
        return {"status": "abgewiesen", "skill": name, "fehler": "%s waere zu gross" % title}
    info = check_unit_files(art, name, changed)
    if not info["gueltig"]:
        return {"status": "abgewiesen", "skill": name,
                "fehler": "; ".join(f["text"] for f in info["befunde"] if f["stufe"] == "fehler")}
    _clean_leftovers(own_base, name)
    _replace_folder(own_base, name, changed, library_modes=False, art=art)
    result = {"status": "angewendet", "skill": name, "version_vorher": before, "version": info["version"],
              "ebene": "agent"}
    if upper_level:
        result.update(status="vorschlag", kopie_von=upper_level)
    elif before is not None:
        shadowed = [level for level in ("welt", "bibliothek")
                    if skill_dir(level_root(root, level, library=library, art=art), name).exists()]
        if shadowed:
            result["hinweis"] = ("Eigene Fassung verdeckt den %s der Ebene %s; weitergeben mit %s vorschlag"
                                 % (title, shadowed[0], "wb-skill skript" if art == "skript" else "wb-skill"))
    _write_directory_locked(root, agent_id, library)
    return result


def apply_learning_step(root: Path, agent_id: str, run_dir: str | os.PathLike[str], *,
                        library: str | os.PathLike[str] | None = None, date: str | None = None,
                        brain: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Check and apply the learning step a turn left in its run directory.

    Result ``status``: ``fehlt`` (no file), ``ungueltig``, ``nichts``, ``angewendet``,
    ``vorhanden`` (already in effect), ``abgewiesen`` (valid but not applied, with reason)
    or ``vorschlag`` (change of a world or library skill: own copy plus proposal ticket).
    Every outcome except ``fehlt`` is written once to the agent history; a repeated call
    for the same run and file returns the stored outcome.
    """
    root = ad.world_path(str(root))
    ad.valid_id(agent_id, "Agentenkennung")
    folder = Path(os.path.abspath(os.path.expanduser(str(run_dir))))
    try:
        step = read_learning_step(folder)
    except (AgentsError, OSError) as exc:
        step = {"art": None, "fehler": str(exc), "zug": folder.name,
                "sha256": hashlib.sha256(str(exc).encode("utf-8")).hexdigest()}
    if step is None:
        ad.read_agent(root, agent_id)
        return {"status": "fehlt", "agent": agent_id, "zug": folder.name}
    step_id = ad.derived_id("lern", agent_id, folder.name, step["sha256"][:16])
    date = date or ad.now()[:10]
    brain_outcome = None
    if not step.get("fehler") and step["art"] in BRAIN_KINDS:
        ad.read_agent(root, agent_id)
        known = ad._read_optional_json(ad._agent_dir(root, agent_id) / "history.json", "Verlauf") or {}
        if not any(entry.get("id") == step_id for entry in known.get("entries") or []):
            brain_outcome = _apply_brain_step(root, agent_id, step, folder.name, date, brain)
    with ad.transaction(root):
        ad.read_agent(root, agent_id)
        history = ad._read_optional_json(ad._agent_dir(root, agent_id) / "history.json", "Verlauf") or {}
        stored = next((entry for entry in history.get("entries") or [] if entry.get("id") == step_id), None)
        if stored is None:
            try:
                if step.get("fehler"):
                    outcome = {"status": "ungueltig", "fehler": step["fehler"]}
                elif step["art"] == "nichts":
                    outcome = {"status": "nichts"}
                elif step["art"] == "lehre":
                    outcome = _apply_lesson(root, agent_id, step, date)
                elif step["art"] in BRAIN_KINDS:
                    outcome = brain_outcome or _apply_brain_step(root, agent_id, step, folder.name, date, None)
                elif step["art"] == "anweisung":
                    outcome = _apply_instruction(root, agent_id, step)
                else:
                    outcome = _apply_skill_change(root, agent_id, step, library, step["art"])
            except AgentsError as exc:
                outcome = {"status": "abgewiesen", "fehler": str(exc)}
            stored = {"id": step_id, "time": ad.now(), "event": "lernschritt", "art": step.get("art"),
                      "ziel": step.get("ziel"), "grund": step.get("grund"),
                      "text": step.get("text") if step.get("art") != "notiz" else step.get("titel"),
                      "zug": folder.name, "sha256": step["sha256"],
                      "actor": {"id": agent_id, "verified": False, "source": "lernschritt"}}
            stored.update(outcome)
            ad._append_history(root, agent_id, stored)
    result = {key: value for key, value in stored.items() if key not in ("actor",)}
    result["agent"] = agent_id
    if stored.get("status") == "vorschlag":
        if stored.get("kopie_von") == "bibliothek" and ad.read_world(root).get("kind") != "global":
            result["vorschlag_fehler"] = ("Bibliotheks%s: eigene Kopie angelegt; "
                                          "der Vorschlag geht über die Welt oder die globale Welt"
                                          % ("skript" if stored.get("art") == "skript" else "skill"))
        else:
            try:
                result["vorschlag"] = propose_skill(root, agent_id, stored["ziel"], stored["kopie_von"],
                                                    reason=stored.get("grund"), library=library,
                                                    art=stored.get("art") or "skill")
            except AgentsError as exc:
                result["vorschlag_fehler"] = str(exc)
    return result


# The carrier contract names the German function; both spellings stay importable.
lernschritt_anwenden = apply_learning_step


# ---------------------------------------------------------------------------
# Token measurement per ticket kind
# ---------------------------------------------------------------------------

def _events(data: bytes | str) -> list[dict[str, Any]]:
    text = data.decode("utf-8", errors="replace") if isinstance(data, (bytes, bytearray)) else data
    events = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue  # truncated tail or foreign line: measure what is readable
        if isinstance(value, dict):
            events.append(value)
    return events


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _tokens(input_: int, output: int, cache_read: int, cache_write: int, reasoning: int) -> dict[str, int]:
    return {"input": input_, "output": output, "cache_read": cache_read, "cache_write": cache_write,
            "reasoning": reasoning, "gesamt": input_ + output + cache_read + cache_write}


def measure_turn(data: bytes | str, harness: str = "claude") -> Optional[dict[str, Any]]:
    """Token counts of one turn from harness output; ``None`` if it carries none.

    - claude: ``--output-format stream-json``; the ``usage`` of the ``result`` event, otherwise
      the last usage per assistant message id (then ``vollstaendig`` is false).
    - codex: ``exec --json`` ``turn.completed`` usages, or rollout ``token_count`` events.
      Cached input is counted as ``cache_read``, not twice.
    - pi: ``message.usage`` of assistant messages, each message once.

    ``gesamt`` is input + output + cache_read + cache_write; ``reasoning`` is part of output
    where the harness reports it and is shown separately only.
    """
    if harness not in HARNESSES:
        raise AgentsError("Harness muss claude, codex oder pi sein")
    events = _events(data)
    if harness == "claude":
        model = next((event.get("model") for event in events
                      if event.get("type") == "system" and isinstance(event.get("model"), str)), None)
        results = [event for event in events if event.get("type") == "result" and isinstance(event.get("usage"), dict)]
        if results:
            result = results[-1]
            usage = result["usage"]
            cost = result.get("total_cost_usd")
            models = result.get("modelUsage")
            if isinstance(models, dict) and models:
                model = model or sorted(models)[0]
            return {"harness": harness, "quelle": "result.usage", "vollstaendig": True, "modell": model,
                    "kosten_usd": float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None,
                    "anfragen": _int(result.get("num_turns")) or None,
                    "tokens": _tokens(_int(usage.get("input_tokens")), _int(usage.get("output_tokens")),
                                      _int(usage.get("cache_read_input_tokens")),
                                      _int(usage.get("cache_creation_input_tokens")), 0)}
        per_message: dict[str, dict[str, Any]] = {}
        for event in events:
            message = event.get("message") if event.get("type") == "assistant" else None
            if isinstance(message, dict) and isinstance(message.get("usage"), dict):
                per_message[str(message.get("id") or len(per_message))] = message["usage"]
                model = model or message.get("model")
        if not per_message:
            return None
        sums = [sum(_int(usage.get(key)) for usage in per_message.values()) for key in
                ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
        return {"harness": harness, "quelle": "assistant.usage", "vollstaendig": False, "modell": model,
                "kosten_usd": None, "anfragen": len(per_message), "tokens": _tokens(*sums, 0)}
    if harness == "codex":
        model = None
        for event in events:
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if event.get("type") == "turn_context" and isinstance(payload.get("model"), str):
                model = payload["model"]
        completed = [event["usage"] for event in events
                     if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict)]
        source = "turn.completed"
        usages = completed
        if not usages:
            infos = [event["payload"].get("info") for event in events
                     if isinstance(event.get("payload"), dict) and event["payload"].get("type") == "token_count"
                     and isinstance(event["payload"].get("info"), dict)]
            totals = [info["total_token_usage"] for info in infos if isinstance(info.get("total_token_usage"), dict)]
            if totals:
                usages, source = [totals[-1]], "token_count.total"
            else:
                usages = [info["last_token_usage"] for info in infos if isinstance(info.get("last_token_usage"), dict)]
                source = "token_count.last"
        if not usages:
            return None
        cached = sum(_int(usage.get("cached_input_tokens")) for usage in usages)
        raw_input = sum(_int(usage.get("input_tokens")) for usage in usages)
        return {"harness": harness, "quelle": source, "vollstaendig": True, "modell": model, "kosten_usd": None,
                "anfragen": len(usages) if source != "token_count.total" else None,
                "tokens": _tokens(max(0, raw_input - cached), sum(_int(u.get("output_tokens")) for u in usages),
                                  cached, sum(_int(u.get("cache_write_input_tokens")) for u in usages),
                                  sum(_int(u.get("reasoning_output_tokens")) for u in usages))}
    seen: dict[str, dict[str, Any]] = {}
    model = None
    cost = 0.0
    has_cost = False
    for event in events:
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant" or not isinstance(message.get("usage"), dict):
            continue
        usage = message["usage"]
        key = json.dumps([message.get("timestamp"), message.get("responseId"), usage], sort_keys=True)
        if key in seen:
            continue
        seen[key] = usage
        model = message.get("model") or model
        total = (usage.get("cost") or {}).get("total") if isinstance(usage.get("cost"), dict) else None
        if isinstance(total, (int, float)) and not isinstance(total, bool):
            cost += float(total)
            has_cost = True
    if not seen:
        return None
    usages = list(seen.values())
    return {"harness": harness, "quelle": "message.usage", "vollstaendig": True, "modell": model,
            "kosten_usd": cost if has_cost else None, "anfragen": len(usages),
            "tokens": _tokens(*(sum(_int(u.get(key)) for u in usages)
                                for key in ("input", "output", "cacheRead", "cacheWrite", "reasoning")))}


def ticket_kind(ticket: dict[str, Any] | None = None, item_kind: str | None = None) -> str:
    """Kind a measurement is filed under: the ticket's ``art`` (field or limits), else ``ticket``;
    for turns without a ticket the delivery kind (``nachricht``, ``rueckmeldung``, ``antwort``)."""
    if ticket:
        raw = ticket.get("art") or (ticket.get("limits") or {}).get("art") or "ticket"
    else:
        raw = item_kind or "sonstiges"
    value = re.sub(r"[^a-z0-9-]+", "-", str(raw).lower()).strip("-")[:64]
    return value or "sonstiges"


def record_measurement(root: Path, agent_id: str, kind: str, measurement: dict[str, Any], run_id: str,
                       ticket_id: str | None = None) -> dict[str, Any]:
    """Append one turn's token counts to ``agents/<id>/messungen.jsonl``; once per run."""
    root = ad.world_path(str(root))
    if not isinstance(kind, str) or not KIND_RE.fullmatch(kind):
        raise AgentsError("Ticketart ist ungueltig (Kleinbuchstaben, Zahlen, '-')")
    ad.valid_id(run_id, "Laufkennung")
    if ticket_id is not None:
        ad.valid_id(ticket_id, "Ticketkennung")
    tokens = (measurement or {}).get("tokens")
    if not isinstance(tokens, dict) or any(not isinstance(tokens.get(key), int) for key in TOKEN_FIELDS):
        raise AgentsError("Messung enthaelt keine Tokenzahlen")
    entry = {"schema_version": SCHEMA_VERSION, "id": ad.derived_id("messung", run_id), "zeit": ad.now(),
             "lauf": run_id, "ticket": ticket_id, "ticketart": kind, "harness": measurement.get("harness"),
             "modell": measurement.get("modell"), "quelle": measurement.get("quelle"),
             "vollstaendig": bool(measurement.get("vollstaendig")), "kosten_usd": measurement.get("kosten_usd"),
             "anfragen": measurement.get("anfragen"), "tokens": {key: tokens[key] for key in TOKEN_FIELDS}}
    with ad.transaction(root):
        ad.read_agent(root, agent_id)
        path = ad._agent_dir(root, agent_id) / MEASUREMENT_FILE
        entries, _ = _read_measurements(path)
        for existing in entries:
            if existing.get("id") == entry["id"]:
                return existing
        if path.exists():
            raw = path.read_bytes()
            if raw and not raw.endswith(b"\n"):
                # A crashed append left half a line; drop it so this one stays readable.
                ad._write_text(path, raw[:raw.rfind(b"\n") + 1].decode("utf-8", errors="replace"))
        ad._append_jsonl(path, entry)
    return entry


def _read_measurements(path: Path) -> tuple[list[dict[str, Any]], int]:
    """Readable measurements and the number of unreadable lines; one bad line blocks nothing."""
    if path.is_symlink():
        raise AgentsError("Messdatei darf kein Symlink sein")
    entries, broken = [], 0
    if not path.exists():
        return entries, broken
    for line in path.read_text(encoding="utf-8", errors="replace").split("\n"):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            broken += 1
            continue
        tokens = value.get("tokens") if isinstance(value, dict) else None
        if isinstance(tokens, dict) and all(isinstance(tokens.get(key), int) for key in TOKEN_FIELDS):
            entries.append(value)
        else:
            broken += 1
    return entries, broken


def _mean(entries: list[dict[str, Any]]) -> dict[str, float]:
    return {key: round(sum(entry["tokens"][key] for entry in entries) / len(entries), 1) for key in TOKEN_FIELDS}


def evaluate_measurements(root: Path, agent_id: str, last: int = 5) -> dict[str, Any]:
    """Mean per ticket kind over all turns and over the last ``last`` turns, for the inspector.

    ``veraenderung`` compares the mean total of the last turns with the turns before them;
    a skill that lowers it is evidence, not a claim.
    """
    root = ad.world_path(str(root))
    if last < 1:
        raise AgentsError("Anzahl letzter Zuege muss positiv sein")
    ad.read_agent(root, agent_id)
    entries, broken = _read_measurements(ad._agent_dir(root, agent_id) / MEASUREMENT_FILE)
    kinds: dict[str, Any] = {}
    for kind in sorted({entry.get("ticketart") or "sonstiges" for entry in entries}):
        group = [entry for entry in entries if (entry.get("ticketart") or "sonstiges") == kind]
        recent, earlier = group[-last:], group[:-last]
        summary: dict[str, Any] = {
            "anzahl": len(group), "mittel": _mean(group), "mittel_letzte": _mean(recent),
            "letzte": [{"zeit": e.get("zeit"), "lauf": e.get("lauf"), "ticket": e.get("ticket"),
                        "modell": e.get("modell"), "tokens": e["tokens"]} for e in recent],
            "veraenderung": None,
        }
        if earlier:
            before = _mean(earlier)["gesamt"]
            if before:
                summary["veraenderung"] = round((summary["mittel_letzte"]["gesamt"] - before) / before, 3)
        kinds[kind] = summary
    return {"agent": agent_id, "anzahl": len(entries), "letzte_n": last, "arten": kinds,
            "fehlerhafte_zeilen": broken}


# ---------------------------------------------------------------------------
# CLI: wb-skill
# ---------------------------------------------------------------------------

def _wake(root: Path) -> None:
    """Wake the world's carrier after a ticket was written, like wb-ticket does."""
    try:
        import agents_traeger_wecken
        state = agents_traeger_wecken.wecken_welt(Path(os.path.abspath(os.path.expanduser(str(root)))))
    except Exception as exc:  # noqa: BLE001 - the write already succeeded
        print("wb-agents: Traeger nicht geweckt (%s: %s)" % (type(exc).__name__, str(exc)[:200]), file=sys.stderr)
        return
    if state != "nicht_konfiguriert":
        print("wb-agents: Traeger %s" % state, file=sys.stderr)


def parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--bibliothek", help="Bibliotheksordner (Vorgabe: agents/bibliothek/skills im Repo)")
    common.add_argument("--json", action="store_true")
    result = argparse.ArgumentParser(prog="wb-skill", description="Skills mit Skripten je Agent, Welt und Bibliothek")
    sub = result.add_subparsers(dest="command", required=True)
    p = sub.add_parser("neu", parents=[common]); p.add_argument("world"); p.add_argument("--agent", required=True); p.add_argument("--name", required=True); p.add_argument("--beschreibung"); p.add_argument("--aus", choices=("welt", "bibliothek")); p.add_argument("--absender")
    p = sub.add_parser("liste", parents=[common]); p.add_argument("world"); p.add_argument("--agent")
    p = sub.add_parser("zeigen", parents=[common]); p.add_argument("world"); p.add_argument("name"); p.add_argument("--agent"); p.add_argument("--ebene", choices=LEVELS)
    p = sub.add_parser("verzeichnis", parents=[common]); p.add_argument("world"); p.add_argument("--agent")
    p = sub.add_parser("vorschlag", parents=[common]); p.add_argument("world"); p.add_argument("--agent", required=True); p.add_argument("--name", required=True); p.add_argument("--ziel", required=True, choices=PROPOSAL_TARGETS); p.add_argument("--quelle", choices=("agent", "welt")); p.add_argument("--aus-welt"); p.add_argument("--begruendung"); p.add_argument("--absender")
    p = sub.add_parser("abnehmen", parents=[common]); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--absender", required=True); p.add_argument("--bemerkung")
    p = sub.add_parser("ablehnen", parents=[common]); p.add_argument("world"); p.add_argument("ticket"); p.add_argument("--absender", required=True); p.add_argument("--grund", required=True)
    p = sub.add_parser("zusammenfuehren", parents=[common]); p.add_argument("world"); p.add_argument("--agent"); p.add_argument("--name", action="append", default=[]); p.add_argument("--schwelle", type=float, default=0.5)
    p = sub.add_parser("lernschritt", parents=[common]); p.add_argument("world"); p.add_argument("--agent", required=True); p.add_argument("--zug", required=True)
    p = sub.add_parser("skript", help="Gespeicherte Skripte je Agent, Welt und Bibliothek")
    scripts = p.add_subparsers(dest="skript_command", required=True)
    q = scripts.add_parser("neu", parents=[common]); q.add_argument("world"); q.add_argument("--agent", required=True); q.add_argument("--name", required=True); q.add_argument("--zweck", "--beschreibung", dest="zweck"); q.add_argument("--sprache", choices=sorted(SCRIPT_LANGUAGES), default="sh"); q.add_argument("--aus", choices=("welt", "bibliothek")); q.add_argument("--absender")
    q = scripts.add_parser("liste", parents=[common]); q.add_argument("world"); q.add_argument("--agent")
    q = scripts.add_parser("zeigen", parents=[common]); q.add_argument("world"); q.add_argument("name"); q.add_argument("--agent"); q.add_argument("--ebene", choices=LEVELS)
    q = scripts.add_parser("vorschlag", parents=[common]); q.add_argument("world"); q.add_argument("--agent", required=True); q.add_argument("--name", required=True); q.add_argument("--ziel", required=True, choices=PROPOSAL_TARGETS); q.add_argument("--quelle", choices=("agent", "welt")); q.add_argument("--aus-welt"); q.add_argument("--begruendung"); q.add_argument("--absender")
    q = scripts.add_parser("abnehmen", parents=[common]); q.add_argument("world"); q.add_argument("ticket"); q.add_argument("--absender", required=True); q.add_argument("--bemerkung")
    q = scripts.add_parser("ablehnen", parents=[common]); q.add_argument("world"); q.add_argument("ticket"); q.add_argument("--absender", required=True); q.add_argument("--grund", required=True)
    return result


def _print(args: argparse.Namespace, data: Any, lines: Iterable[str]) -> None:
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        for line in lines:
            print(line)


def _skill_line(entry: dict[str, Any]) -> str:
    owner = ("/" + entry["agent"]) if entry.get("agent") else ""
    version = (entry.get("version") or "ungueltig")[:12]
    return "%-10s %-28s %-12s %s" % (entry["ebene"] + owner, entry["name"], version, entry.get("description") or "")


def _listing_rows(data: dict[str, Any], art: str, agent: bool) -> list[str]:
    if agent:
        rows = [_skill_line(entry) for entry in data["skills"] if (entry.get("art") or "skill") == art]
        if art == "skill":
            rows += ["fehlt      %s" % name for name in data["fehlend"]]
        else:
            rows += ["fehlt      %s (genutzt von %s)" % (item["skript"], ", ".join(item["skills"]))
                     for item in data.get("fehlende_skripte") or []]
        return rows
    levels = data if art == "skill" else data["skripte"]
    rows = [_skill_line(entry) for entry in levels["bibliothek"] + levels["welt"]]
    return rows + [_skill_line(entry) for entries in levels["agenten"].values() for entry in entries]


def _proposal_art(world: Path, ticket: str) -> None:
    if (read_proposal(world, ticket).get("art") or "skill") != "skript":
        raise AgentsError("Ticket %s schlaegt kein Skript vor; dafuer wb-skill abnehmen|ablehnen" % ticket)


def _script_command(args: argparse.Namespace, world: Path, library: str | None) -> None:
    command = args.skript_command
    if command == "neu":
        data = create_script(world, args.agent, args.name, args.zweck, args.aus, args.absender, library, args.sprache)
        _print(args, data, [data["datei"] or data["pfad"]])
    elif command == "liste":
        data = list_skills(world, args.agent, library)
        _print(args, data, _listing_rows(data, "skript", bool(args.agent)))
    elif command == "zeigen":
        data = show_unit(world, args.name, "skript", args.agent, args.ebene, library)
        _print(args, data, ["%s (%s) %s" % (data["name"], data["ebene"], data["version"]),
                            str(Path(data["pfad"]) / data["datei"]) if data.get("datei") else data["pfad"], ""]
               + ["%s: %s" % (f["stufe"], f["text"]) for f in data["befunde"]] + [data["inhalt"]])
    elif command == "vorschlag":
        data = propose_skill(world, args.agent, args.name, args.ziel, args.quelle, args.aus_welt,
                             args.begruendung, args.absender, library, art="skript")
        _wake(world)
        _print(args, data, [data["ticket"]])
    elif command == "abnehmen":
        _proposal_art(world, args.ticket)
        data = accept_proposal(world, args.ticket, args.absender, args.bemerkung, library)
        _wake(world)
        _print(args, data, ["%s %s -> %s" % (data["skill"], data["version"][:12], data["pfad"])])
    else:
        _proposal_art(world, args.ticket)
        data = reject_proposal(world, args.ticket, args.absender, args.grund)
        _wake(world)
        _print(args, data, ["%s abgelehnt" % data["skill"]])


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    world = Path(args.world)
    library = args.bibliothek
    try:
        if args.command == "skript":
            _script_command(args, world, library)
        elif args.command == "neu":
            data = create_skill(world, args.agent, args.name, args.beschreibung, args.aus, args.absender, library)
            _print(args, data, [data["pfad"]])
        elif args.command == "liste":
            data = list_skills(world, args.agent, library)
            _print(args, data, _listing_rows(data, "skill", bool(args.agent)))
        elif args.command == "zeigen":
            data = show_skill(world, args.name, args.agent, args.ebene, library)
            _print(args, data, ["%s (%s) %s" % (data["name"], data["ebene"], data["version"]), data["pfad"], ""]
                   + ["%s: %s" % (f["stufe"], f["text"]) for f in data["befunde"]] + [data["skill_md"]])
        elif args.command == "verzeichnis":
            data = write_skill_directory(world, args.agent, library)
            _print(args, data, ["%s: %d Skills, %d Skripte%s" % (
                item["agent"], sum(1 for e in item["skills"] if (e.get("art") or "skill") == "skill"),
                sum(1 for e in item["skills"] if e.get("art") == "skript"),
                " (geaendert)" if item["geaendert"] else "") for item in data])
        elif args.command == "vorschlag":
            data = propose_skill(world, args.agent, args.name, args.ziel, args.quelle, args.aus_welt,
                                 args.begruendung, args.absender, library)
            _wake(world)
            _print(args, data, [data["ticket"]])
        elif args.command == "abnehmen":
            data = accept_proposal(world, args.ticket, args.absender, args.bemerkung, library)
            _wake(world)
            _print(args, data, ["%s %s -> %s" % (data["skill"], data["version"][:12], data["pfad"])])
        elif args.command == "ablehnen":
            data = reject_proposal(world, args.ticket, args.absender, args.grund)
            _wake(world)
            _print(args, data, ["%s abgelehnt" % data["skill"]])
        elif args.command == "zusammenfuehren":
            data = merge_findings(world, args.agent, args.name, args.schwelle, library)
            _print(args, data, ["%s: %s" % (f["art"], ", ".join("%s/%s" % (s["ebene"] + ("/" + s["agent"] if s.get("agent") else ""), s["name"]) for s in f["skills"]))
                                for f in data["befunde"]] or ["keine Befunde"])
        else:
            data = apply_learning_step(world, args.agent, args.zug, library=library)
            _print(args, data, ["%s %s" % (data["status"], data.get("fehler") or data.get("ziel") or "")])
        return 0
    except (AgentsError, OSError, ValueError) as exc:
        print("wb-skill: FEHLER - %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
