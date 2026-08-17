"""Safe rewrite of gardener-managed marker blocks (`<!-- gardener:*:start/end -->`).

A `re.sub(START.*?END)` silently corrupts a file whose markers are unbalanced: a
leftover START (truncated file, merge conflict, hand edit) swallows everything up
to the NEXT END. Replacement is therefore index-based, and a file whose markers
are not exactly one well-formed pair is refused instead of rewritten.
"""
from __future__ import annotations


def _own_line_spans(text: str, marker: str) -> list[tuple[int, int]]:
    """(start, end) of every line that consists solely of `marker`."""
    out, offset = [], 0
    for line in text.splitlines(keepends=True):
        if line.strip() == marker:
            out.append((offset, offset + len(line)))
        offset += len(line)
    return out


def _content_end(text: str, span: tuple[int, int]) -> int:
    """The end of a marker line WITHOUT its newline.

    Every caller here splices `text[...:]` back on after a marker, and the
    newline belongs to what follows, not to the marker: consuming it drops the
    file's final newline on every rewrite, which the write gate then reports as
    a change on a file nobody edited.
    """
    j = span[1]
    return j - 1 if j > span[0] and text[j - 1] == "\n" else j


NONE, ONE, MALFORMED = "none", "one", "malformed"


def block_state(text: str, start: str, end: str) -> str:
    """`none`, `one` or `malformed` - what this file holds STRUCTURALLY.

    A marker only counts when it stands alone on its line, the way every writer
    here emits one. This is the same rule strip_blocks uses, and both paths must
    use it: while only the reading side was line-bound, a hand-written note that
    merely EXPLAINED the marker pair inside a sentence read as an owned block on
    the way out - `has_block` was true, `read_ownership` reported
    `dream_marker: True`, and the next append replaced the words between the two
    quoted markers with a claim block. Reported 2026-08-07 by the second review
    pass; the note that triggers it is the session note about this build.
    """
    starts, ends = _own_line_spans(text, start), _own_line_spans(text, end)
    if not starts and not ends:
        return NONE
    if len(starts) == 1 and len(ends) == 1 and starts[0][0] < ends[0][0]:
        return ONE
    return MALFORMED


def has_block(text: str, start: str, end: str) -> bool:
    return block_state(text, start, end) == ONE


def replace_block(text: str, start: str, end: str, block: str) -> tuple[str, bool]:
    """(new_text, ok).

    ok=False means the markers are malformed - the caller must NOT write.
    With no markers at all the text is returned unchanged (ok=True): appending
    the block is the caller's business, since only it knows the heading.
    """
    state = block_state(text, start, end)
    if state == NONE:
        return text, True
    if state == MALFORMED:
        return text, False
    i = _own_line_spans(text, start)[0][0]
    j = _content_end(text, _own_line_spans(text, end)[0])
    return text[:i] + block + text[j:], True


def block_of(text: str, start: str, end: str) -> str | None:
    """The block INCLUDING its markers, or None when there is no well-formed
    pair. Unbalanced markers read as "no block", never as a half one."""
    if not has_block(text, start, end):
        return None
    i = _own_line_spans(text, start)[0][0]
    j = _content_end(text, _own_line_spans(text, end)[0])
    return text[i:j]


def strip_blocks(text: str, start: str, end: str) -> str:
    """Remove every STRUCTURAL block of this kind, and the blank line that
    separated it from its surroundings.

    Used by a writer that must hash, or re-read, only its OWN content: another
    writer's block inside the same file is neither its input nor part of its
    fingerprint. Swallowing the separator matters, it is not cosmetic - the
    dream re-reads a note with its own block stripped, and if removal left
    behind a changed run of newlines, appending a block would silently change
    the note's segment hashes and put the whole note back in the queue as
    unseen material on the next run.

    Structural means: both markers stand ALONE on their line, which is how
    every writer here emits them. A document that merely QUOTES the marker pair
    inside a sentence - a worker result about this build, a session note, this
    module's own documentation - keeps every character. Removing it there was
    silent data loss on the way in: reported 2026-08-07 by the review pass,
    against a corpus whose worker results are 11.4 MB.
    """
    while True:
        starts = _own_line_spans(text, start)
        ends = _own_line_spans(text, end)
        if not starts:
            return text
        opening = starts[0]
        closing = next((e for e in ends if e[0] >= opening[1]), None)
        if closing is None:
            return text         # unbalanced tail: leave it exactly as it is
        head = text[:opening[0]].rstrip("\n")
        tail = text[closing[1]:].lstrip("\n")
        if head and tail:
            text = f"{head}\n\n{tail}"
        elif head:
            text = head + "\n"
        else:
            text = tail


def upsert_section(existing: str, start: str, end: str, section: str) -> str:
    """Replace this writer's own section of a SHARED file, byte-preserving
    everything outside the marker pair; append it when the file has none.

    The shared review-queue.md has had two writers since 2026-07-29 (the
    gardener appends, the contradiction scanner regenerates); the dream is the
    third. Each regenerates only between its own markers - `section` must
    therefore already carry them.

    Line-bound like the rest of this module: a queue entry that happens to
    QUOTE a section marker (an issue detail can carry one) is text, not a
    section boundary.
    """
    starts, ends = _own_line_spans(existing, start), _own_line_spans(existing, end)
    if starts and ends and starts[0][0] < ends[-1][1]:
        return (existing[:starts[0][0]] + section
                + existing[_content_end(existing, ends[-1]):])
    if existing.strip():
        return existing.rstrip("\n") + "\n\n" + section + "\n"
    return section + "\n"
