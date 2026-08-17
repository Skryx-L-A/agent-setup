"""Frontmatter parsing/serialization (YAML subset, stdlib only).

Basic-Memory's sync prepends its own `permalink:`-only block ABOVE an existing
frontmatter block, so a vault file may legitimately start with two consecutive
blocks. Parsing merges them (later block wins); everything the gardener writes
carries exactly one block.
"""
from __future__ import annotations

import re

BLOCK_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.DOTALL)
KEY_RE = re.compile(r"([A-Za-z0-9_-]+):\s*(.*)$")
COMMENT_RE = re.compile(r"\s{2,}#.*$")


def _unescape_double_quoted(inner: str) -> str:
    escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}
    out = []
    i = 0
    n = len(inner)
    while i < n:
        c = inner[i]
        if c == "\\" and i + 1 < n and inner[i + 1] in escapes:
            out.append(escapes[inner[i + 1]])
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _scalar(raw: str) -> str:
    s = raw.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return _unescape_double_quoted(s[1:-1])
    if len(s) >= 2 and s[0] == "'" and s[-1] == "'":
        return s[1:-1].replace("''", "'")
    return s.strip('"\'').strip()


def _strip_comment(raw: str) -> str:
    return COMMENT_RE.sub("", raw).strip()


def looks_like_yaml(block: str) -> bool:
    """True if the block's first meaningful line is a `key: value` pair.

    Without this, a body that starts with a `---` rule and has another `---`
    further down is swallowed as if it were frontmatter - and the text between
    the two rules is silently dropped. That is a data-loss path on the merge
    route, where `ensure_single()` runs over free-form LLM output.
    """
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        return bool(KEY_RE.match(line))
    return False        # empty block: a horizontal rule, not frontmatter


def split_blocks(text: str) -> tuple[list[str], str]:
    """Return (raw leading frontmatter blocks without delimiters, body)."""
    blocks: list[str] = []
    rest = text
    while True:
        # Basic-Memory separates its prepended block from the original one with a
        # blank line, so skip leading newlines before looking for the next block.
        candidate = rest.lstrip("\n")
        m = BLOCK_RE.match(candidate)
        if not m or not looks_like_yaml(m.group(1)):
            break       # not frontmatter: everything from here on is body
        blocks.append(m.group(1))
        rest = candidate[m.end():]
    return blocks, rest


def parse_fields(blocks: list[str]) -> dict:
    """Merge the blocks into one field dict. Later blocks override earlier ones."""
    fields: dict = {}
    for block in blocks:
        key: str | None = None
        for line in block.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if line[:1] in (" ", "\t", "-") and key:
                if stripped.startswith("- "):
                    if not isinstance(fields.get(key), list):
                        fields[key] = []
                    fields[key].append(_scalar(_strip_comment(stripped[2:])))
                elif isinstance(fields.get(key), str):
                    # YAML wraps a long scalar onto indented continuation lines
                    # and joins them with a space. Dropping them silently
                    # truncated every wrapped field: the 2026-07-29 incident
                    # note's title ended mid-sentence at "weil das Tor eine",
                    # so no wikilink could resolve to it and the note counted
                    # as an orphan although two notes named it.
                    fields[key] = f"{fields[key]} {_strip_comment(stripped)}".strip()
                continue
            m = KEY_RE.match(line)
            if not m:
                key = None
                continue
            key = m.group(1)
            raw = _strip_comment(m.group(2))
            if raw == "":
                fields[key] = []
            elif raw.startswith("[") and raw.endswith("]"):
                inner = raw[1:-1].strip()
                fields[key] = [_scalar(x) for x in inner.split(",") if x.strip()]
            else:
                fields[key] = _scalar(raw)
    return fields


def parse(text: str) -> tuple[dict, str]:
    blocks, body = split_blocks(text)
    return parse_fields(blocks), body


_YAML_LEADING_INDICATORS = set("!&*?|>%@`\"'#,[]{}")


def _needs_quoting(s: str) -> bool:
    """True if writing `s` bare on a single YAML line would corrupt the file:
    an embedded newline (e.g. a filename that contains one - B18) breaks the
    one-field-per-line format this module's own parser relies on, and can even
    inject a stray `---` that closes the frontmatter block early."""
    if s == "" or s != s.strip():
        return True
    if any(c in s for c in ("\n", "\r", "\t")):
        return True
    if s[0] in _YAML_LEADING_INDICATORS:
        return True
    if s[0] == "-" and (len(s) == 1 or s[1] == " "):
        return True
    if s[0] == ":" or s.endswith(":") or " #" in s:
        return True
    return False


def _escape_double_quoted(s: str) -> str:
    out = []
    for c in s:
        if c == "\\":
            out.append("\\\\")
        elif c == '"':
            out.append('\\"')
        elif c == "\n":
            out.append("\\n")
        elif c == "\r":
            out.append("\\r")
        elif c == "\t":
            out.append("\\t")
        else:
            out.append(c)
    return "".join(out)


def _render_scalar(v) -> str:
    s = str(v)
    if _needs_quoting(s):
        return f'"{_escape_double_quoted(s)}"'
    return s


def render(fields: dict) -> str:
    lines = ["---"]
    for k, v in fields.items():
        if isinstance(v, list):
            lines.append(f"{k}: [{', '.join(_render_scalar(x) for x in v)}]")
        else:
            lines.append(f"{k}: {_render_scalar(v)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def ensure_single(text: str, fallback: dict | None = None) -> str:
    """Guarantee exactly one frontmatter block. Untouched when there already is
    exactly one (comments/formatting preserved)."""
    blocks, body = split_blocks(text)
    if len(blocks) == 1:
        return text
    if not blocks:
        if not fallback:
            return text
        return render(fallback) + "\n" + body.lstrip("\n")
    return render(parse_fields(blocks)) + "\n" + body.lstrip("\n")
