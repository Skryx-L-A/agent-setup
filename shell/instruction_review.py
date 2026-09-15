#!/usr/bin/env python3
"""Inventory instruction sources, or split a long Markdown file without losing bytes.

No network, model, installation or configuration access. Inventory contains metadata,
not document bodies. Exclusions and unreadable paths are explicit in the result.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

NAMES = {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "GEMINI.md", "QWEN.md",
         "CRUSH.md", "CONVENTIONS.md", "RULES.md", "WORKER.md", "ORCHESTRATOR.md",
         "SKILL.md", "CLAUDE.md.template", "AGENTS.md.template",
         ".goosehints", ".cursorrules", ".windsurfrules"}
RULE_DIRS = {"regeln", "roles", "rules", "instructions", "commands"}
SKIP = {".git", "node_modules", "__pycache__", "site-packages", ".venv", "venv",
        ".local", "sessions", "transcripts", "90-secrets", ".secrets-sync"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(roots):
    rows, excluded, errors = [], [], []
    def collect(path):
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append({"path": str(path), "error": str(exc)})
            return
        rows.append({"path": str(path), "realpath": str(path.resolve()),
                     "bytes": len(raw), "lines": len(text.splitlines()),
                     "sha256": digest(raw), "kind": "skill" if path.name == "SKILL.md" else "instructions",
                     "frontmatter_at_start": text.startswith("---\n") if path.name == "SKILL.md" else None,
                     "review_status": "unreviewed"})
    for root in roots:
        root = Path(root).expanduser().absolute()
        if not root.exists():
            errors.append({"path": str(root), "error": "missing root"})
            continue
        if root.is_file():
            collect(root)
            continue
        seen_dirs = set()
        def onerror(exc):
            errors.append({"path": exc.filename, "error": str(exc)})
        for folder, dirs, files in os.walk(root, followlinks=True, onerror=onerror):
            real = os.path.realpath(folder)
            if real in seen_dirs:
                excluded.append({"path": folder, "reason": "directory alias already visited within root"})
                dirs[:] = []
                continue
            seen_dirs.add(real)
            for name in list(dirs):
                if name in SKIP or name.startswith(".venv-"):
                    dirs.remove(name)
                    excluded.append({"path": str(Path(folder) / name), "reason": "dependency, runtime state or private data"})
            parts = set(Path(folder).parts)
            for name in files:
                agent_profile = "agents" in parts and bool(parts & {".claude", ".codex", ".agents"}) and name.endswith((".md", ".toml"))
                if name not in NAMES and not agent_profile and not (name.endswith((".md", ".mdc")) and parts & RULE_DIRS):
                    continue
                collect(Path(folder) / name)
    unique = {row["path"]: row for row in rows}
    return {"schema": 1, "roots": [str(x) for x in roots],
            "files": sorted(unique.values(), key=lambda row: row["path"]),
            "excluded": excluded, "errors": errors}


def split_markdown(path, destination):
    """Stage a lossless section catalog; do not overwrite the source.

    Headings inside fenced examples remain content. The manifest records original
    ordering and hashes so reconstruction, not a substring test, proves preservation.
    """
    path, destination = Path(path), Path(destination)
    original = path.read_bytes()
    lines = original.decode("utf-8").splitlines(keepends=True)
    chunks, current, fence = [], [], None
    for line in lines:
        match = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if match:
            token = match.group(1)
            if fence is None:
                fence = token[0]
            elif fence == token[0]:
                fence = None
        if fence is None and re.match(r"^#{2,3} ", line) and current:
            chunks.append("".join(current))
            current = []
        current.append(line)
    if current:
        chunks.append("".join(current))
    if "".join(chunks).encode("utf-8") != original:
        raise ValueError("section reconstruction differs from source")
    destination.mkdir(parents=True, exist_ok=False)
    records = []
    for number, chunk in enumerate(chunks):
        filename = "%02d.md" % number
        (destination / filename).write_bytes(chunk.encode("utf-8"))
        heading = next((x.lstrip("# ").strip() for x in chunk.splitlines() if x.startswith("#")), "Einleitung")
        records.append({"file": filename, "heading": heading, "sha256": digest(chunk.encode("utf-8"))})
    manifest = {"source": str(path), "sha256": digest(original), "bytes": len(original), "sections": records}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


def verify_split(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    result = b""
    for row in manifest["sections"]:
        data = (directory / row["file"]).read_bytes()
        if digest(data) != row["sha256"]:
            raise ValueError("changed section: " + row["file"])
        result += data
    if digest(result) != manifest["sha256"] or len(result) != manifest["bytes"]:
        raise ValueError("reconstruction mismatch")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    inv = sub.add_parser("inventory")
    inv.add_argument("roots", nargs="+")
    inv.add_argument("--output", required=True)
    split = sub.add_parser("split")
    split.add_argument("source")
    split.add_argument("destination")
    verify = sub.add_parser("verify")
    verify.add_argument("directory")
    args = parser.parse_args()
    if args.command == "inventory":
        data = inventory(args.roots)
        Path(args.output).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        print("files=%d errors=%d excluded=%d" % (len(data["files"]), len(data["errors"]), len(data["excluded"])))
        return int(bool(data["errors"]))
    if args.command == "split":
        data = split_markdown(args.source, args.destination)
    else:
        data = verify_split(args.directory)
    print("sections=%d preserved_bytes=%d sha256=%s" % (len(data["sections"]), data["bytes"], data["sha256"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
