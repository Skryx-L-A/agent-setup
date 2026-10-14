"""Read-only, path-safe vault access for the MCP server.

The local backend deliberately reads the vault directly.  A future D1 backend
belongs behind the same interface; it must use /search, GET /notes, /resolve
and /backlinks rather than obtaining filesystem access.
"""
from __future__ import annotations

import os
from pathlib import Path

from gardener.vault import Note, build_resolver, key_of, parse_note

from . import search as search_mod


class UnsafeVaultPath(ValueError):
    """A requested path is outside the readable part of the vault."""


class LocalBackend:
    """Read-only backend for one vault, with a deny-by-default path boundary."""

    def __init__(self, vault: Path):
        self.vault = Path(vault).expanduser().resolve(strict=True)
        if not self.vault.is_dir():
            raise ValueError(f"vault is not a directory: {self.vault}")

    def _safe_path(self, value: str | Path) -> Path:
        candidate = Path(value).expanduser()
        path = candidate if candidate.is_absolute() else self.vault / candidate
        try:
            relative_input = path.relative_to(self.vault)
        except ValueError:
            raise UnsafeVaultPath("path is outside the vault") from None
        if any(part in ("", ".", "..") for part in relative_input.parts):
            raise UnsafeVaultPath("path traversal is not allowed")
        if any(part.casefold() == "secrets" for part in relative_input.parts):
            raise UnsafeVaultPath("protected path")
        if path.name.casefold() == "identity.md":
            raise UnsafeVaultPath("protected path")
        current = self.vault
        for part in relative_input.parts:
            current /= part
            if current.is_symlink():
                raise UnsafeVaultPath("symlinks are not readable")
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(self.vault)
        except (OSError, ValueError):
            raise UnsafeVaultPath("path is outside the vault") from None
        if not resolved.is_file() or resolved.suffix.lower() != ".md":
            raise UnsafeVaultPath("not a readable Markdown note")
        return resolved

    def _notes(self) -> list[Note]:
        notes: list[Note] = []
        for dirpath, dirnames, filenames in os.walk(self.vault, followlinks=False):
            here = Path(dirpath)
            dirnames[:] = sorted(
                name for name in dirnames
                if not name.startswith(".")
                and name.casefold() != "secrets"
                and not (here / name).is_symlink()
            )
            for name in sorted(filenames):
                if not name.endswith(".md"):
                    continue
                path = here / name
                try:
                    safe = self._safe_path(path)
                except UnsafeVaultPath:
                    continue
                notes.append(parse_note(self.vault, safe))
        return notes

    def _note(self, path: str | None = None, title: str | None = None) -> Note:
        if bool(path) == bool(title):
            raise ValueError("provide exactly one of path or title")
        if path:
            safe = self._safe_path(path)
            return parse_note(self.vault, safe)
        notes = self._notes()
        note = build_resolver(notes).get(key_of(title or ""))
        if note is None:
            raise ValueError("note not found")
        return note

    def search(self, question: str, k: int = 5, space: str | None = None) -> list[dict]:
        if not question.strip():
            raise ValueError("frage must not be empty")
        if not 1 <= k <= 20:
            raise ValueError("k must be between 1 and 20")
        hits, _fallback = search_mod.search(self.vault, question, k, space=space)
        out: list[dict] = []
        for hit in hits:
            try:
                self._safe_path(hit.rel)
            except UnsafeVaultPath:
                continue
            item = {
                "titel": hit.title,
                "pfad": hit.rel,
                "score": round(hit.score, 4),
                "ausschnitt": hit.snippet[:220],
            }
            if hit.status:  # Gueltigkeit aus dem Frontmatter, wie im Such-JSON (nur wenn abgewertet)
                item["status"] = hit.status
                if hit.superseded_by:
                    item["abgeloest_durch"] = list(hit.superseded_by_rel or hit.superseded_by)
            out.append(item)
        return out

    def read(self, path: str | None = None, title: str | None = None,
             section: str | None = None) -> dict:
        note = self._note(path, title)
        text = note.text
        if section:
            text = _section(text, section)
        return {"titel": note.title, "pfad": note.rel, "inhalt": text}

    def backlinks(self, title: str) -> list[dict]:
        target = self._note(title=title)
        target_keys = target.keys
        return [
            {"titel": note.title, "pfad": note.rel}
            for note in self._notes()
            if note.path != target.path and note.links & target_keys
        ]

    def kern(self, project: str) -> dict:
        if not project or Path(project).name != project:
            raise ValueError("invalid project")
        return self.read(path=f"20-projects/{project}/KERN.md")


def _section(text: str, requested: str) -> str:
    """Return one Markdown heading section, accepting its bare heading text."""
    lines = text.splitlines(keepends=True)
    wanted = requested.strip().lstrip("#").strip().casefold()
    start = None
    level = 0
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if not stripped.startswith("#"):
            continue
        heading_level = len(stripped) - len(stripped.lstrip("#"))
        heading = stripped[heading_level:].strip().rstrip("#").strip().casefold()
        if heading == wanted:
            start, level = index, heading_level
            break
    if start is None:
        raise ValueError("section not found")
    end = len(lines)
    for index in range(start + 1, len(lines)):
        stripped = lines[index].lstrip()
        if stripped.startswith("#"):
            heading_level = len(stripped) - len(stripped.lstrip("#"))
            if heading_level <= level:
                end = index
                break
    return "".join(lines[start:end]).rstrip()


class ApiBackend:
    """D1 backend placeholder; deliberately unavailable until the service exists."""

    # TODO(D1): implement search via /search, notes via GET /notes and /resolve,
    # and backlinks via /backlinks.  Keep this class read-only.
    def __init__(self, *_args, **_kwargs):
        raise NotImplementedError("D1 API backend is not available yet")
