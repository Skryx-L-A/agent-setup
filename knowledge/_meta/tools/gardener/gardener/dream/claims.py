"""The claim schema and its store (M2a). A claim is a single, sourced
statement pulled from one segment - see DREAM-PLAN.md Abschnitt 7's hunk
schema, of which a claim is the smallest building block.

The quote gate lives HERE, in code, not in the extraction prompt: a claim
survives only if its `quote` is a literal substring of the segment it was
drawn from (after whitespace/quote-mark normalization), and every number,
date, path and backtick-quoted identifier in `text` also appears in `quote`.
No model is trusted to police its own citations - `verify_quote` is the
"Code als letzte Instanz" rule from the plan, applied at the claim level.
"""
from __future__ import annotations

import dataclasses
import hashlib
import logging
import re
import sqlite3
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from . import config as dcfg

log = logging.getLogger("gardener.dream")

SCHEMA = """
CREATE TABLE IF NOT EXISTS claims (
    claim_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    kind TEXT NOT NULL,
    quote TEXT NOT NULL,
    source TEXT NOT NULL,
    source_trust TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    trace_id TEXT NOT NULL,
    corrected_from TEXT
);
CREATE TABLE IF NOT EXISTS rejected_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    quote TEXT NOT NULL,
    reason TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class Claim:
    claim_id: str
    text: str
    kind: str
    quote: str
    source: str            # e.g. "vault:10-global/foo.md#0" - the TRUE source
    source_trust: str
    recorded_at: str       # ISO timestamp, when extraction produced it
    valid_from: str
    trace_id: str
    valid_to: str | None = None
    # The segment_ref the model originally claimed, when extract_batch found
    # the quote literally in a DIFFERENT sibling segment of the same batch
    # call and corrected `source`/`trace_id` to that one - see extract.py's
    # cross-batch quote resolution. None for the overwhelming majority of
    # claims, where the model named the right segment the first time.
    corrected_from: str | None = None


# The one list. Every SQL statement in this module, `shadow._claim_payload`
# and `apply.CLAIM_FIELDS` derive from the dataclass, so a new field cannot be
# carried in the changeset while the store silently drops it.
#
# That is not hypothetical: `corrected_from` was added to Claim alone, and once
# apply.py began comparing every carried field against the store, all 293
# claims were refused with `claim-field-missing (corrected_from)` - the store
# returned ten keys where the dataclass had eleven. Two changes, each right on
# its own; the drift between the lists was the defect. Deriving both from the
# same place is the actual repair, the test that holds them against each other
# is the guard (2026-08-08).
COLUMNS = tuple(f.name for f in dataclasses.fields(Claim))


def _table_columns(conn: sqlite3.Connection) -> list[str]:
    return [row[1] for row in conn.execute("PRAGMA table_info(claims)").fetchall()]


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Add whatever column the dataclass has and the table has not. Returns
    the columns added.

    Decided by the column list, never by catching the error: `ALTER TABLE ADD
    COLUMN` on a database that already has the column must be a no-op, and a
    caught exception would also swallow a genuine failure. The database this
    runs against holds the paid cloud reference of 293 claims and is never
    regenerated, so a migration is the only way a new field reaches it.
    """
    have = set(_table_columns(conn))
    added = [c for c in COLUMNS if c not in have]
    for col in added:
        conn.execute(f"ALTER TABLE claims ADD COLUMN {col} TEXT")
    if added:
        conn.commit()
        log.info("claims.db migrated: added %s", ", ".join(added))
    return added


def compute_claim_id(text: str, source: str) -> str:
    """Same text from the same source segment is the same claim - this is
    the whole idempotency guarantee: re-extracting an unchanged segment
    produces claim_ids that already exist and are silently not re-inserted.
    """
    return hashlib.sha256(f"{text}\x1f{source}".encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Quote gate
# ---------------------------------------------------------------------------

_QUOTE_MARKS = {
    "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
    "‘": "'", "’": "'",
}
_WS_RE = re.compile(r"\s+")
_IDENTIFIER_RE = re.compile(r"`([^`]+)`")
# 2026-08-07 finding: a multi-line Markdown blockquote repeats "> " at every
# continuation line ("> Claims 1 ... sind FALSCH\n> Literal und korrekt").
# The model quotes the CONTENT verbatim but naturally drops the per-line "> "
# when it joins the lines - the quote is still the same text, just without
# the quoting markup. Stripped at each line start, before whitespace
# collapses the newlines away, so "> Literal" and "Literal" normalize equal.
# Deliberately narrow: only the blockquote marker, because that is the only
# line-prefix pattern an actual rejected claim (gardener-code-audit-
# UNVERIFIED.md#0, from the stripped-CLI Sonnet run) was found to need. List
# markers and code-fence indentation were checked against that same run's
# other 8 quote-not-found cases and none needed it - do not add speculative
# coverage here without a real case behind it.
_BLOCKQUOTE_PREFIX_RE = re.compile(r"(?m)^>+ ?")

# 2026-08-06 acceptance finding: the original coverage check flagged bare
# 1-2 digit numbers, slash-joined German word pairs ("Regel/Vorgabe"),
# differently-spelled dates and abbreviations like "z.B" as if they were
# identifiers - 47 of 82 rejections on a real 307-claim sample were exactly
# this. The fix below only loosens the COVERAGE check (is every value in
# `text` also findable in `quote`); the substring check that `quote` itself
# must appear in the source is untouched.

def normalize(s: str) -> str:
    s = unicodedata.normalize("NFC", s)
    for src, dst in _QUOTE_MARKS.items():
        s = s.replace(src, dst)
    s = _BLOCKQUOTE_PREFIX_RE.sub("", s)
    return _WS_RE.sub(" ", s).strip()


# ---------------------------------------------------------------------------
# Numbers: only "significant" ones need coverage - >=3 digits, a decimal
# separator, a percent sign, or an attached unit. A bare "1", "2", "9" is
# how German prose counts things ("neun Tests") and is never findable
# literally in a differently-worded quote.
# ---------------------------------------------------------------------------

_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)*")
_UNIT_WORDS = ("GB", "MB", "KB", "TB", "PB", "USD", "EUR", "ms", "kg", "km",
              "cm", "mm", "Hz", "GHz", "MHz", "fps", "Prozent", "Tokens?",
              "Zeichen", "Sekunden?", "Minuten?", "Stunden?", "Tage?",
              "Wochen?", "Monate?", "Jahre?")
_UNIT_SUFFIX_RE = re.compile(
    r"^(%|\s(?:" + "|".join(_UNIT_WORDS) + r")\b)")


def _digit_count(number_text: str) -> int:
    return sum(1 for c in number_text if c.isdigit())


def _number_is_significant(match_text: str, tail_after: str) -> bool:
    if _digit_count(match_text) >= 3:
        return True
    if "." in match_text or "," in match_text:
        return True
    if _UNIT_SUFFIX_RE.match(tail_after):
        return True
    return False


def _significant_numbers(text: str) -> list[str]:
    """`\\d+(?:[.,]\\d+)*` greedily swallows a dotted date ("12.07.2026") as
    one decimal-shaped number, which would otherwise force a literal-string
    match the date-normalization logic below is specifically there to avoid.
    Any number match that overlaps a recognized date span is skipped here -
    dates are checked separately, semantically, not as plain numbers."""
    date_spans = _date_spans(text)
    out = []
    for m in _NUMBER_RE.finditer(text):
        if any(m.start() < e and s < m.end() for s, e in date_spans):
            continue
        tail = text[m.end():m.end() + 12]
        if _number_is_significant(m.group(0), tail):
            out.append(m.group(0))
    return out


# ---------------------------------------------------------------------------
# Dates: compare by (day, month, year) so 2026-07-12 / 12.07.2026 /
# 12. Juli 2026 all count as the same value regardless of which spelling
# `text` and `quote` each happen to use.
# ---------------------------------------------------------------------------

_MONTHS = {"januar": 1, "februar": 2, "märz": 3, "maerz": 3, "april": 4,
          "mai": 5, "juni": 6, "juli": 7, "august": 8, "september": 9,
          "oktober": 10, "november": 11, "dezember": 12}
_DATE_ISO_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
# The year group is exactly 2 OR exactly 4 digits, never 3 - a plain
# `{2,4}` quantifier also accepts 3, which happily misreads a version
# number like "2.1.219" (Claude Code) as day=2, month=1, year=219.
_DATE_DOTTED_RE = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b")
_DATE_PROSE_RE = re.compile(
    r"\b(\d{1,2})\.\s?(Januar|Februar|M(?:ä|ae)rz|April|Mai|Juni|Juli|August|"
    r"September|Oktober|November|Dezember)(?:\s?(\d{4}))?\b", re.IGNORECASE)
# A report/session title often carries only year-month ("ai-scout-2026-08")
# or a bare year ("2026er Quellen") - no day at all. Treated the same as a
# day-less prose date: day=None is a wildcard in _date_covered too.
_DATE_YEARMONTH_RE = re.compile(r"\b(\d{4})-(\d{2})\b(?!-\d{2}\b)")
_DATE_BARE_YEAR_RE = re.compile(r"\b(\d{4})er\b")


def _valid_day(d: int | None) -> bool:
    return d is None or 1 <= d <= 31


def _valid_month(mo: int | None) -> bool:
    return mo is None or 1 <= mo <= 12


def _dated_matches(text: str):
    """One pass, shared by _date_spans and _find_dates: (span, (d, mo, y))
    for every match that is a semantically valid date. A three-part
    version number like "uv 0.11.28" has the exact dotted-date shape
    (day=0, month=11, year=2028 once the 2-digit year is expanded to
    2000+) and day=0 is not a real day - filtering on 1-31/1-12 here
    rejects that reading instead of treating a version number as a date."""
    out = []
    for m in _DATE_ISO_RE.finditer(text):
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if _valid_day(d) and _valid_month(mo):
            out.append((m.span(), (d, mo, y)))
    for m in _DATE_DOTTED_RE.finditer(text):
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if d != 0 and _valid_day(d) and _valid_month(mo):
            out.append((m.span(), (d, mo, y + 2000 if y < 100 else y)))
    for m in _DATE_PROSE_RE.finditer(text):
        d = int(m.group(1))
        mo = _MONTHS[m.group(2).lower().replace("ä", "ae")]
        y = int(m.group(3)) if m.group(3) else None
        if _valid_day(d):
            out.append((m.span(), (d, mo, y)))
    for m in _DATE_YEARMONTH_RE.finditer(text):
        y, mo = int(m.group(1)), int(m.group(2))
        if _valid_month(mo):
            out.append((m.span(), (None, mo, y)))
    for m in _DATE_BARE_YEAR_RE.finditer(text):
        out.append((m.span(), (None, None, int(m.group(1)))))
    return out


def _date_spans(text: str) -> list[tuple[int, int]]:
    return [span for span, _ in _dated_matches(text)]


def _find_dates(text: str) -> list[tuple[int | None, int | None, int | None]]:
    return [tup for _, tup in _dated_matches(text)]


def _date_covered(needed: tuple[int | None, int | None, int | None],
                  available: list[tuple[int | None, int | None, int | None]]) -> bool:
    """True if some available date matches `needed` on every component
    `needed` actually specifies. A None in `needed` means that component is
    not required (a day-less "2026-08" title only needs a matching
    year+month somewhere). A None on the AVAILABLE side is not a wildcard,
    though - it must not let a vague quote date silently vouch for a
    specific day/month the text claims but the quote never actually named."""
    d, mo, y = needed
    for ad, amo, ay in available:
        if d is not None and ad != d:
            continue
        if mo is not None and amo != mo:
            continue
        if y is not None and ay != y:
            continue
        return True
    return False


# ---------------------------------------------------------------------------
# Slash tokens: split and judge each part on its own. A part that looks
# like a capitalized German word (no extension, no underscore, no digit)
# is prose, not an identifier - "Regel/Vorgabe", "SEAT/VW",
# "Mensch/Agent-Pruefung" are all two ordinary words joined by a slash. A
# token with a file extension or more than one slash is still a real path
# and is checked whole and unchanged - "app/src/main/main.ts" stays strict.
# ---------------------------------------------------------------------------

_SLASH_TOKEN_RE = re.compile(r"\S*/\S+")
_FILE_EXT_RE = re.compile(r"\.[A-Za-z0-9]{1,5}$")
# Sentence punctuation German prose wraps a path/word-pair in - "(shell/
# context-guard:1017)," must be judged as "shell/context-guard:1017", not
# as the literal string with the parenthesis and comma still attached,
# or the coverage check compares against noise neither side ever wrote.
_LEADING_PUNCT_RE = re.compile(r"^[(\[{«»„“”‚'\"]+")
_TRAILING_PUNCT_RE = re.compile(r"[)\]}«»„“”‚'\".,;:!?]+$")


def _strip_punct(token: str) -> str:
    return _TRAILING_PUNCT_RE.sub("", _LEADING_PUNCT_RE.sub("", token))


def _looks_like_real_path(token: str) -> bool:
    return bool(_FILE_EXT_RE.search(token)) or token.count("/") >= 2


def _looks_like_german_word(part: str) -> bool:
    return bool(part) and part[0].isupper() and not _FILE_EXT_RE.search(part) \
        and "_" not in part and not any(c.isdigit() for c in part)


def _slash_values(text: str) -> list[str]:
    out: list[str] = []
    for m in _SLASH_TOKEN_RE.finditer(text):
        token = _strip_punct(m.group(0))
        if not token or "/" not in token:
            continue
        if _looks_like_real_path(token):
            out.append(token)          # whole path, unchanged strict check
            continue
        for part in token.split("/"):
            part = _strip_punct(part)
            if not part:
                continue
            if part.isdigit():
                if _number_is_significant(part, ""):
                    out.append(part)
                continue
            if _looks_like_german_word(part):
                continue                # a plain capitalized word, not an id
            out.append(part)
    return out


# ---------------------------------------------------------------------------
# Bare filenames/identifiers (no slash) and backtick-quoted spans stay
# exactly as strict as before - this is the anti-hallucination core and is
# never loosened. German abbreviations that happen to match the
# word.letters shape ("z.B", "d.h", "u.a", "ca.", "bzw.", "ggf.", "evtl.",
# "o.ä.") are excluded explicitly, since they are not identifiers.
# ---------------------------------------------------------------------------

_BARE_FILENAME_RE = re.compile(r"\b[\w\-]+\.[A-Za-z]{1,5}\b")
_ABBREVIATIONS = {"z.b", "d.h", "u.a", "ca.", "bzw.", "ggf.", "evtl.",
                  "o.ä.", "o.ae.", "u.u.", "usw.", "etc.", "vgl.", "u.ä.",
                  "u.ae."}


def _bare_filenames(text: str) -> list[str]:
    out = []
    for m in _BARE_FILENAME_RE.finditer(text):
        token = m.group(0)
        if "/" in text[max(0, m.start() - 1):m.end() + 1]:
            continue   # part of a slash token, handled by _slash_values
        if token.lower().rstrip(".") + "." in _ABBREVIATIONS or \
                token.lower() in _ABBREVIATIONS:
            continue
        out.append(token)
    return out


# ---------------------------------------------------------------------------
# Model names. Checked by the applier's Protokoll-Tor (DREAM-PLAN.md Abschnitt
# 7, rule 4 names them explicitly next to numbers, dates, paths and
# identifiers), NOT by verify_quote: at extraction time a claim may legitimately
# say "Opus urteilt" about a quote that never spells the model out, while a
# sentence about to be written INTO the vault may not. Same values, stricter
# gate the closer the text gets to the vault.
# ---------------------------------------------------------------------------

_MODEL_NAME_RE = re.compile(
    r"\b(?:claude|gpt|llama|qwen[\d.]*|gemma|embeddinggemma|mistral|mixtral|"
    r"ornith|sonnet|opus|haiku|fable|deepseek|phi|nomic)[\w.:@\-]*",
    re.IGNORECASE)


def _model_names(text: str) -> list[str]:
    return [m.group(0) for m in _MODEL_NAME_RE.finditer(text)]


def uncovered_values(text: str, quote: str, *,
                     include_model_names: bool = False) -> list[str]:
    """Every value in `text` that no part of `quote` supports.

    The one implementation behind both citation gates: verify_quote uses it per
    claim at extraction time, apply.py uses it over a hunk's added lines
    against ALL its quotes joined. Values are numbers, dates, paths,
    filenames, backtick-quoted identifiers and - only when asked - model names.
    """
    missing: list[str] = []
    norm_quote = normalize(quote)
    for v in _significant_numbers(text):
        # German prose writes 217,9 where an English-sourced quote says
        # 217.9 (and 12.500 where it says 12,500) - the same value, a
        # different decimal/thousands mark. A digit actually being wrong
        # ("217,9" claimed against a "17,9" quote) still fails: swapping
        # the separator on a wrong number does not manufacture a match.
        swapped = v.translate(str.maketrans(",.", ".,"))
        if (v not in quote and normalize(v) not in norm_quote
                and swapped not in quote and normalize(swapped) not in norm_quote):
            missing.append(v)
    quote_dates = _find_dates(quote)
    if quote_dates:
        # The quote names at least one date itself - a text date must then
        # match one of them, in any spelling. If the quote names none at
        # all, a date the model attached to `text` is almost always drawn
        # from the segment's own filename/frontmatter (a gardener-report's
        # own date, a session's own day) rather than repeated in the
        # excerpt - that is not a hallucination risk the way an invented
        # statistic is, so it is not required here (2026-08-06 finding: 10
        # of 49 remaining rejections on a real 307-claim sample were
        # exactly this pattern).
        for needed in _find_dates(text):
            if not _date_covered(needed, quote_dates):
                parts = [f"{v:02d}" if v is not None else "?" for v in needed]
                missing.append("date:" + ".".join(parts))
    for v in _slash_values(text) + _bare_filenames(text):
        if v not in quote and normalize(v) not in norm_quote:
            missing.append(v)
    for v in _IDENTIFIER_RE.findall(text):
        if v not in quote and normalize(v) not in norm_quote:
            missing.append(v)
    if include_model_names:
        for v in _model_names(text):
            if v not in quote and normalize(v) not in norm_quote:
                missing.append(v)
    return missing


def quote_in_source(quote: str, source_text: str) -> bool:
    """The literal-substring half of the quote gate, on its own - lets a
    caller test a quote against several candidate source texts (a batch's
    sibling segments) without re-running the number/date/path coverage
    check, which never depends on source_text in the first place."""
    norm_quote = normalize(quote)
    return bool(norm_quote) and norm_quote in normalize(source_text)


def verify_quote(text: str, quote: str, source_text: str) -> tuple[bool, str | None]:
    """(ok, reason). reason is None iff ok. Never leaks a matched secret -
    this only ever compares against already secret-gated segment text."""
    if not normalize(quote):
        return False, "empty-quote"
    if not quote_in_source(quote, source_text):
        return False, "quote-not-found"
    missing = uncovered_values(text, quote)
    if missing:
        return False, "value-not-in-quote:" + ",".join(missing[:5])
    return True, None


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class ClaimStore:
    """Mirrors gardener.dream.ledger.Ledger's read_only contract: a dry-run
    or a pre-first-extract `status` call must not create claims.db."""

    def __init__(self, db_path: Path, read_only: bool = False):
        db_path = Path(db_path)
        self.read_only = read_only
        if read_only:
            if db_path.exists():
                self.conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            else:
                self.conn = sqlite3.connect(":memory:")
                self.conn.executescript(SCHEMA)
            # A read-only handle cannot migrate, so it reads whatever columns
            # the file has and reports the rest as None - a dry-run must not
            # fail on a database an earlier real run has not migrated yet.
            self.columns = tuple(c for c in COLUMNS
                                 if c in set(_table_columns(self.conn)))
            return
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.executescript(SCHEMA)
        migrate(self.conn)
        self.columns = COLUMNS

    def close(self) -> None:
        self.conn.close()

    def add(self, claim: Claim) -> bool:
        """Returns True iff newly inserted - see compute_claim_id."""
        if self.read_only:
            row = self.conn.execute(
                "SELECT 1 FROM claims WHERE claim_id=?", (claim.claim_id,)).fetchone()
            return row is None
        cols = ", ".join(self.columns)
        marks = ", ".join("?" * len(self.columns))
        try:
            self.conn.execute(
                f"INSERT INTO claims ({cols}) VALUES ({marks})",
                tuple(getattr(claim, c) for c in self.columns))
            self.conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def add_rejected(self, source: str, text: str, quote: str, reason: str,
                     recorded_at: str | None = None) -> None:
        if self.read_only:
            return
        self.conn.execute(
            "INSERT INTO rejected_claims (source, text, quote, reason, recorded_at) "
            "VALUES (?,?,?,?,?)",
            (source, text, quote, reason, recorded_at or _now_iso()))
        self.conn.commit()

    def list_claims(self) -> list[dict]:
        rows = self.conn.execute(
            f"SELECT {', '.join(self.columns)} FROM claims").fetchall()
        return [self._row(r) for r in rows]

    def _row(self, row: tuple) -> dict:
        """Always every field of the dataclass. A column the file does not
        have yet reads as None instead of being absent - a missing KEY is what
        broke every claim once the applier started comparing all of them."""
        out = dict.fromkeys(COLUMNS)
        out.update(zip(self.columns, row))
        return out

    def get(self, claim_id: str) -> dict | None:
        row = self.conn.execute(
            f"SELECT {', '.join(self.columns)} FROM claims WHERE claim_id=?",
            (claim_id,)).fetchone()
        return None if row is None else self._row(row)

    def retire(self, claim_id: str, valid_to: str) -> bool:
        """End a claim's validity. Nothing is ever deleted (DREAM-PLAN.md D2 /
        Abschnitt 9): the row stays, keeps its text and quote, and only gains
        an end date - a statement that stopped being current stays findable and
        stays true for its time. Returns False if the claim is already retired,
        so a second run cannot move an end date that was set earlier."""
        if self.read_only:
            return False
        cur = self.conn.execute(
            "UPDATE claims SET valid_to=? WHERE claim_id=? AND valid_to IS NULL",
            (valid_to, claim_id))
        self.conn.commit()
        return cur.rowcount > 0

    def list_rejected(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT source, text, quote, reason, recorded_at FROM rejected_claims"
        ).fetchall()
        keys = ("source", "text", "quote", "reason", "recorded_at")
        return [dict(zip(keys, r)) for r in rows]

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0]


def _now_iso() -> str:
    import datetime as dt
    return dt.datetime.fromtimestamp(time.time()).isoformat(timespec="seconds")


def default_source_trust(source_class: str) -> str:
    return {
        "vault": "own-vault",
        "gardener-report": "own-vault",
        "transcript": "own-transcript",
        "worker-result": "worker-result",
        "project-doc": "project-doc",
    }.get(source_class, "third-party")


def resolve_source_trust(claimed: object, source_class: str) -> str:
    """The model may name a claim's source_trust explicitly (e.g. a segment
    quoting third-party material inside our own transcript); anything
    outside the fixed enum is replaced by the source class's own default -
    code is the final authority on this field, per DREAM-PLAN.md Regel 8."""
    if isinstance(claimed, str) and claimed in dcfg.DREAM_EXTRACT_SOURCE_TRUST:
        return claimed
    return default_source_trust(source_class)
