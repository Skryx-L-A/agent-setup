"""M2b: stored claims become a changeset of hunks in a SHADOW tree.

Nothing here writes to the vault. The shadow is a parallel tree under the
dream's own state directory (`state/dream/shadow/<vault-relative path>`) that
holds what each target file WOULD look like; the vault only ever sees a hunk
that apply.py has re-checked itself (M3). Two properties are tested rather
than assumed, in test_dream_shadow_is_isolated: `VaultWriter` refuses to write
anywhere under the state directory, and no shadow file is ever picked up by
`vault.load_notes()`.

Ownership is read from the TARGET FILE, never from the changeset, and it must
be positively proven: `class: derived`, or the dream's own marker block. A
note whose frontmatter has no `class` field at all is FOREIGN - the one case
this kind of check habitually gets wrong, because "no statement of ownership"
reads so easily as "free". It is the opposite: on 2026-07-29 exactly that
inference converted four hand-curated hubs into generated pages and replaced
114 hand-written lines.

Routing (which claim ends up in which note) is deliberately deterministic and
provisional: no model is involved in M2b/M3, and M4 (reconcile) replaces it
with real grouping and supersession judgement. What is NOT provisional is the
shape of a hunk and the ownership metadata on it - apply.py's gates are built
against exactly this schema (DREAM-PLAN.md Abschnitt 7).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from .. import blocks as blocks_mod
from .. import frontmatter
from ..contradict import escalate_hit
from ..vault import Note, build_resolver, key_of, load_notes, read_text
from . import claims as claims_mod
from . import config as dcfg

log = logging.getLogger("gardener.dream")

OP_REPLACE = "replace-section"
OP_APPEND = "append-section"
OP_CREATE = "create-note"
OP_RETIRE = "retire-claim"
OPS = (OP_REPLACE, OP_APPEND, OP_CREATE, OP_RETIRE)

BLOCK_START = dcfg.DREAM_BLOCK_START
BLOCK_END = dcfg.DREAM_BLOCK_END
BLOCK_HEADING = "## Traum (automatisch, belegt)"

# C8 (SESSION-STATE.md 07.08.2026): the one extraction kind whose `text` is a
# longer, verbatim passage rather than a one-sentence fact - see prose_line.
KIND_PROSE = "prose"

# Frontmatter field that marks a note as dream output. Its only job is to keep
# the dream's own prose out of the dream's input (DREAM-PLAN.md Abschnitt 9,
# "gegen semantische Drift"): a summary of a summary is the failure mode, and
# the structural exclusion is what bounds it.
GENERATED_FIELD = "dream-generated"

_WIKILINK_RE = re.compile(r"\[\[([^\]|#\n]+)")
_BACKTICK_RE = re.compile(r"`([^`]+)`")
_CLAIM_LINE_RE = re.compile(r"^- .*claim: ([0-9a-f]{12})\)")
_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")
# Machine-generated file stems that must never become a note title: UUIDs,
# timestamps/run ids, and a handful of generic names (see usable_subject).
_ID_LIKE_RE = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[0-9a-f]{16,}|\d{6,}(?:[-_]\d+)*)", re.IGNORECASE)
_GENERIC_STEMS = {"done", "index", "log", "notes", "output", "result",
                  "results", "tmp", "untitled"}


# ---------------------------------------------------------------------------
# Ownership
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Ownership:
    klass: str                  # knowledge | derived | source | absent | <other>
    dream_marker: bool
    last_author: str | None
    last_touched: str | None
    exists: bool
    generator: str | None = None    # "dream" | "gardener" | None

    @property
    def owned(self) -> bool:
        """Ownership is proven, never inferred. `absent` (no `class` field) is
        the interesting case and answers False on purpose."""
        return self.klass == "derived" or self.dream_marker

    @property
    def dream_owns_file(self) -> bool:
        """Whether the dream may rewrite this file end to end.

        `class: derived` alone is not enough: the gardener's synth phase writes
        that same field on `30-topics/<t>/MOC.md`. Replacing such a page costs
        no knowledge - it is regenerable - but it breaks its stored
        `gardener-content-hash`, after which `run_synth` reports
        `skipped_hand_edited` and never writes the page again. A regenerable
        page would become a dead one (reported 2026-08-07 by the review pass).

        Stated positively: `generator == "dream"`, never "not the gardener,
        so us". The negative form was the same inference from a missing field
        that this module's own header warns about, and a `class: derived` page
        from a third tool - or one a person set that field on by hand - counted
        as the dream's (second review pass, 2026-08-07). A page carrying BOTH
        generator fields belongs to no writer at all, which read_ownership
        expresses as `generator = "ambiguous"`.
        """
        return self.klass == "derived" and self.generator == "dream"

    def to_dict(self) -> dict:
        return {"class": self.klass, "dream_marker": self.dream_marker,
                "generator": self.generator,
                "last_author": self.last_author, "last_touched": self.last_touched}


def _file_meta(path: Path) -> tuple[str | None, str | None]:
    """(last_author, last_touched). Informational metadata for the reviewer,
    never a gate - so a missing git history simply degrades to the file's
    mtime instead of failing anything."""
    author = None
    try:
        import subprocess
        r = subprocess.run(
            ["git", "-C", str(path.parent), "--no-optional-locks", "log", "-1",
             "--format=%an\x1f%ad", "--date=short", "--", str(path)],
            capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and "\x1f" in r.stdout:
            author, touched = r.stdout.strip().split("\x1f", 1)
            if author and touched:
                return author, touched
    except Exception:            # git missing, not a repo, timeout - all fine
        pass
    try:
        touched = dt.date.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        touched = None
    return author, touched


def ownership_of_text(text: str, author: str | None = None,
                      touched: str | None = None) -> Ownership:
    """Ownership as the file's own content states it. Split out from
    read_ownership so a dry run can judge a file it has only planned to write,
    without inventing a second set of rules for that case."""
    fm, _body = frontmatter.parse(text)
    raw = str(fm.get("class") or "").strip()
    dream_field = GENERATED_FIELD in fm
    gardener_field = any(k.startswith("gardener-") for k in fm)
    if dream_field and gardener_field:
        generator = "ambiguous"     # two writers claim it: it belongs to neither
    elif dream_field:
        generator = "dream"
    elif gardener_field:
        generator = "gardener"
    else:
        generator = None
    return Ownership(klass=raw or "absent",
                     dream_marker=blocks_mod.has_block(text, BLOCK_START, BLOCK_END),
                     last_author=author, last_touched=touched, exists=True,
                     generator=generator)


def read_ownership(vault: Path, rel: str) -> Ownership:
    """The ownership of a target, read from the file on disk. apply.py calls
    this again at write time: a changeset's own `ownership` block is a claim
    about the world, not the world."""
    path = Path(vault) / rel
    if not path.exists():
        return Ownership(klass="absent", dream_marker=False, last_author=None,
                         last_touched=None, exists=False)
    author, touched = _file_meta(path)
    return ownership_of_text(read_text(path), author, touched)


def is_dream_output(note: Note) -> bool:
    """A note the dream wrote end to end. Never input again - see
    GENERATED_FIELD. A hand-written note that merely CARRIES a dream block is
    not dream output: only the block itself is stripped from the input text
    (blocks.strip_blocks), the note around it stays material."""
    return GENERATED_FIELD in note.fm or note.rel.startswith(
        dcfg.DREAM_DERIVED_DIR + "/")


# ---------------------------------------------------------------------------
# The dream's marker block
# ---------------------------------------------------------------------------

def short_id(claim_id: str) -> str:
    return claim_id[:12]


def contains_marker(*values: object) -> bool:
    """True if any value carries one of the dream's own markers.

    Such a claim can never be rendered into a block: the marker inside the
    text closes the block early, the file ends up with two end markers, and
    from then on nobody owns it - `has_block` is false, so the dream refuses
    every further hunk on that note, and on a derived page the changed
    fingerprint makes the gardener treat it as hand-edited and stop
    regenerating it. Reported 2026-08-07 by the review pass; the claim stays in
    the store, only the rendering is refused.
    """
    return any(BLOCK_START in str(v) or BLOCK_END in str(v) for v in values)


def claim_line(claim: dict, today: str, supersedes: dict | None = None) -> str:
    """One dated, sourced line. Everything outside the claim's own `text` is
    generated here in code, so apply.py's citation gate can tell scaffold from
    content instead of demanding a quote for the word "Quelle"."""
    prefix = f"- {today}: "
    body = claim["text"].strip()
    if supersedes is not None:
        body = (f"Stand heute: {body} (loest ab: claim "
                f"{short_id(supersedes['claim_id'])} vom {supersedes['recorded_at']})")
    return (f"{prefix}{body} (Quelle: {claim['source']}, erfasst: "
            f"{claim['recorded_at']}, claim: {short_id(claim['claim_id'])})")


def prose_line(claim: dict, today: str, supersedes: dict | None = None) -> str:
    """A `kind: prose` claim's own line shape (C8, SESSION-STATE.md
    07.08.2026): no leading application-date. `claim_line`'s "{today}: "
    prefix dates a fact as of the run that applied it; a prose claim is a
    verbatim passage cited by where and when it was ORIGINALLY recorded, so it
    reads as a quote standing on its own instead of a dated fact.

    The permission this names is the line shape alone. Everything that keeps a
    claim honest stays identical to claim_line's: gate_rendering still accepts
    only the exact string this function produces, and gate_values still checks
    `claim["text"]` against `claim["quote"]` through the same
    `claims.uncovered_values` call, unconditional on kind. Widening either of
    those for `prose` would be the gate loosened, not the permission named.
    """
    body = claim["text"].strip()
    if supersedes is not None:
        body = (f"Stand heute: {body} (loest ab: claim "
                f"{short_id(supersedes['claim_id'])} vom {supersedes['recorded_at']})")
    return (f"- {body} (Quelle: {claim['source']}, erfasst: "
            f"{claim['recorded_at']}, claim: {short_id(claim['claim_id'])})")


def render_claim(claim: dict, today: str, supersedes: dict | None = None) -> str:
    """The one line this code renders for a claim, chosen by `kind` alone.

    The single place `build_changeset` (below) and apply.py's `gate_rendering`
    both call, so the two can never render one claim two different ways - the
    same reasoning as `claims.COLUMNS` being the one list every SQL statement
    and the applier derive from instead of a hand-kept copy: two lists in sync
    by hand are a bug waiting for the day they drift.
    """
    render = prose_line if claim.get("kind") == KIND_PROSE else claim_line
    return render(claim, today, supersedes=supersedes)


def block_lines(block_text: str | None) -> list[str]:
    """The claim lines already inside a dream block, verbatim and in order."""
    if not block_text:
        return []
    out = []
    for line in block_text.splitlines():
        if line.startswith("- "):
            out.append(line)
    return out


def applied_claim_ids(block_text: str | None) -> set[str]:
    return {m.group(1) for line in (block_text or "").splitlines()
            if (m := _CLAIM_LINE_RE.match(line))}


def render_block(lines: list[str]) -> str:
    return "\n".join([BLOCK_START, "", BLOCK_HEADING, ""] + lines + [BLOCK_END])


def current_block(text: str) -> str | None:
    return blocks_mod.block_of(text, BLOCK_START, BLOCK_END)


def apply_block(text: str, block: str) -> tuple[str, bool]:
    """Put `block` into `text`, replacing an existing one. (new_text, ok);
    ok=False means the file's markers are unbalanced and it must be left
    alone - blocks.replace_block's contract, which is exactly why the dream
    does not do its own regex surgery here.

    Asks `blocks` for the STRUCTURAL state instead of testing for the marker as
    a substring: a note that only quotes the pair inside a sentence has no
    block, so the dream appends its own below instead of replacing the words
    between the two quoted markers (second review pass, 2026-08-07).
    """
    state = blocks_mod.block_state(text, BLOCK_START, BLOCK_END)
    if state != blocks_mod.NONE:
        return blocks_mod.replace_block(text, BLOCK_START, BLOCK_END, block)
    body = text.rstrip("\n")
    return (body + "\n\n" + block + "\n") if body else (block + "\n"), True


# ---------------------------------------------------------------------------
# Routing: claim -> target note
# ---------------------------------------------------------------------------

def subject_key(claim: dict) -> str:
    """A claim's subject, deterministically: the first wikilink it names, else
    the first backtick-quoted identifier, else the stem of the source document
    it came from. No model, no embedding - M4 replaces this with real
    grouping."""
    for pattern in (_WIKILINK_RE, _BACKTICK_RE):
        m = pattern.search(str(claim.get("text") or ""))
        if m and m.group(1).strip():
            return m.group(1).strip()
    src = str(claim.get("source") or "").split("#", 1)[0]
    stem = src.split(":", 1)[-1].rsplit("/", 1)[-1]
    return stem[:-3] if stem.endswith(".md") else stem


def usable_subject(claim: dict) -> bool:
    """Whether this claim's subject is good enough to NAME a new note after.

    Measured against the real claim store on 2026-08-07: of 42 proposed hunks,
    ten would have created pages called `3d96c080-3b8e-496f-8638-...-jsonl`,
    `20260806-144051` or `done` - the file names of transcripts and worker
    results, not subjects. A wikilink or a backticked identifier is a subject a
    person named; a machine-generated file stem is not, and a claim that has
    only that one waits for M4's real grouping instead of getting a page whose
    title means nothing. It stays in the store either way - nothing is lost,
    only nothing is invented.
    """
    text = str(claim.get("text") or "")
    if _WIKILINK_RE.search(text) or _BACKTICK_RE.search(text):
        return True
    key = subject_key(claim)
    if _ID_LIKE_RE.match(key) or key.lower() in _GENERIC_STEMS:
        return False
    return bool(key)


def slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return _SLUG_STRIP_RE.sub("-", ascii_value.lower()).strip("-") or "ohne-thema"


_FORBIDDEN_FILES_CF = {f.casefold() for f in dcfg.APPLY_FORBIDDEN_FILES}
_FORBIDDEN_PREFIXES_CF = tuple(p.casefold() for p in dcfg.APPLY_FORBIDDEN_PREFIXES)


def is_forbidden_target(rel: str) -> bool:
    """Areas the applier refuses anyway (00-sources as pure input, the managed
    root files). Checked HERE too, so a claim whose subject happens to resolve
    to a note in the staging area is routed elsewhere instead of producing a
    hunk that is refused every single run and then remembered as an issue
    forever. Measured 2026-08-07 against the real store: ten of 42 hunks.

    Judges the path in normalized form - `10-global/../review-queue.md` is
    review-queue.md and must read as one here too, whoever calls this.

    Casefolded, because this is a string compared against a filesystem that
    compares differently: macOS resolves `00-Sources/Roh.md` to the same file
    as `00-sources/roh.md`, `Path.resolve()` does not change the spelling, and
    the hunk landed in the staging branch (second review pass, 2026-08-07).
    Same treatment `vault.py` gives its own exclusion rules since the move to
    the Mac (`_EXCLUDE_DIRS_CF`, `_EXCLUDE_FILES_CF`).
    """
    rel = Path(rel).as_posix()
    if ".." in Path(rel).parts:
        rel = str(PurePosixPath(*_collapse(Path(rel).parts)))
    rel_cf = rel.casefold()
    return rel_cf in _FORBIDDEN_FILES_CF or \
        any(rel_cf.startswith(p) for p in _FORBIDDEN_PREFIXES_CF)


def _collapse(parts: tuple) -> list:
    """`a/b/../c` -> `a/c`, without touching the filesystem."""
    out: list = []
    for part in parts:
        if part == "..":
            if out:
                out.pop()
        elif part not in (".", ""):
            out.append(part)
    return out


def route(claim: dict, resolver: dict[str, Note], vault: Path) -> tuple[str, str] | None:
    """(target rel, op), or None when the claim has no usable target yet.

    A subject that resolves to an existing note is appended to inside the
    dream's own block; anything else becomes a new dream-owned note - or, once
    that note exists, an append to it. Dream notes are deliberately not in the
    resolver (is_dream_output), so their own page is found by path here, never
    by title from a claim's text.
    """
    # Eine Aussage aus einem Projekt gehoert auf die Seite ihres Projekts,
    # bevor irgendein Subjektschluessel sie woandershin traegt (DREAM-PLAN.md
    # Abschnitt 8). Der Import steht hier drin, weil projects.py dieses Modul
    # benutzt - er waere sonst ein Kreis.
    from . import projects as projects_mod
    project = projects_mod.project_of(str(claim.get("source") or ""))
    if project:
        rel = projects_mod.page_rel(project)
        if not is_forbidden_target(rel):
            return rel, (OP_APPEND if (Path(vault) / rel).exists() else OP_CREATE)

    key = subject_key(claim)
    note = resolver.get(key_of(key))
    if note is not None and not is_forbidden_target(note.rel):
        return note.rel, OP_APPEND
    if not usable_subject(claim):
        return None
    rel = f"{dcfg.DREAM_DERIVED_DIR}/{slug(key)}.md"
    return rel, (OP_APPEND if (Path(vault) / rel).exists() else OP_CREATE)


# The intro of a dream-created page is a CONSTANT, and deliberately names no
# subject. The subject comes from the claim text, which is the part a model
# writes freely: repeating it in the body made it its own citation - a model
# name inside a wikilink covered itself, and two brackets were enough to write
# an unsourced one into the vault (reported 2026-08-07 by the review pass).
# The subject still titles the page; frontmatter is machine-written structure
# and is not what the citation gate is about.
NEW_NOTE_INTRO = ("Automatisch erzeugte Traum-Seite. Jede Zeile traegt ihren "
                  "Beleg und ihr Datum; der Traum schreibt hier nur innerhalb "
                  "seines Markerblocks.")


def beleg_of(claims: list[dict]) -> str:
    """Der epistemische Status einer Seite aus der Datenlage ihrer Aussagen.

    `gemessen` nur, wenn JEDE Aussage eine Messung ist - eine einzige
    berichtete Zeile macht die Seite zu einer berichteten. Die Abbildung steht
    in `config.BELEG_BY_KIND` und wird hier nicht zweitgebaut.
    """
    kinds = [str(c.get("kind") or "") for c in claims]
    if kinds and all(dcfg.BELEG_BY_KIND.get(k) == dcfg.BELEG_GEMESSEN
                     for k in kinds):
        return dcfg.BELEG_GEMESSEN
    return dcfg.BELEG_BERICHTET


def new_note_text(subject: str, lines: list[str], generated_at: str,
                  beleg: str = dcfg.BELEG_BERICHTET) -> str:
    fields = {"title": subject, "type": "note", "class": "derived",
              dcfg.BELEG_FIELD: beleg,
              GENERATED_FIELD: generated_at}
    return (frontmatter.render(fields) + "\n" + NEW_NOTE_INTRO + "\n\n"
            + render_block(lines) + "\n")


# ---------------------------------------------------------------------------
# Hunks
# ---------------------------------------------------------------------------

@dataclass
class Hunk:
    hunk_id: str
    target: str
    op: str
    ownership: dict
    before: str | None
    after: str
    claims: list = field(default_factory=list)
    supersedes: list = field(default_factory=list)
    risk: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def compute_hunk_id(op: str, target: str, claim_ids: list[str]) -> str:
    payload = f"{op}\x1f{target}\x1f{','.join(sorted(claim_ids))}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def claim_content(claims: list[dict], added: str, today: str) -> str:
    """`added` with everything this code rendered AROUND the claims removed.

    Derived from `render_claim`, never from a pattern rebuilt by hand: a line
    that is exactly what the renderer produces for one of these claims
    contributes that claim's own `text` and nothing else, because everything
    else on such a line - the leading date, "Quelle:", the source path, the
    recording timestamp, the short claim id, and the supersession note - is
    generated here in `claim_line`/`prose_line`. Change the frame and this
    follows along; rebuild the frame as a regex here and the two drift apart
    the first time one of them changes.

    Two fallbacks, both deliberately conservative. A line rendered WITH a
    supersession no longer matches the plain rendering, so a claim whose text
    still sits inside the line contributes that text. A line from nowhere
    recognizable counts in full: unknown provenance is judged, not waved
    through.
    """
    out: list[str] = []
    rendered = {render_claim(claim, today).strip(): str(claim.get("text") or "")
                for claim in claims}
    for line in added.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped in rendered:
            out.append(rendered[stripped])
            continue
        for claim in claims:
            text = str(claim.get("text") or "").strip()
            if text and text in stripped:
                out.append(text)
                break
        else:
            out.append(stripped)
    return "\n".join(out)


def risk_markers(claims: list[dict], ownership: Ownership, added: str,
                 today: str) -> list[str]:
    risk: list[str] = []
    if ownership.klass == "knowledge":
        risk.append("ziel-ist-class-knowledge")
    if any(c.get("kind") == "rule" for c in claims):
        risk.append("regelsatz-beruehrt")
    # Only digits that come from the STATEMENT count. Measured 2026-08-10 over
    # the real changeset: against the whole added text this fired on 20 of 20
    # hunks, because the code puts a date in front of every single line. A
    # marker that fires on everything says nothing, and it is not free - a
    # marked hunk gets a package of its own, so the twelve-hunk portioning of
    # DREAM-PLAN.md Abschnitt 7 never once took effect and the reviewer paid
    # the per-call base price for every hunk (factor 4.7 on a cold start).
    # ... und nur, wenn es ueberhaupt etwas gibt, das sich AENDERN kann. Die
    # Marke heisst `zahl-geaendert`, geprueft wurde aber "enthaelt eine
    # Ziffer" - in einer Datei, die es noch nicht gibt, kann keine Zahl
    # geaendert worden sein. Das ist kein Abwaegen, sondern der Begriff.
    #
    # Was es kostet, dass sie zu breit war (gemessen 16.08.2026 am Changeset
    # des ersten Volllaufs): Sie sprang auf 4.247 von 6.381 Hunks an, davon
    # 2.083 auf Dateien, die noch gar nicht existierten. Eine markierte Hunk
    # bekommt ein eigenes Paket, also einen eigenen bezahlten Aufruf - die
    # Zwoelfer-Portionierung aus DREAM-PLAN.md Abschnitt 7 kam nie zum Zug.
    # Der Kommentar darueber sagt es selbst: eine Marke, die auf alles
    # anspringt, sagt nichts. 2026-08-10 wurde sie schon einmal von 100 auf
    # 67 Prozent verengt; das hier ist derselbe Schritt zu Ende gegangen.
    #
    # Was eine NEUE Zahl in einer NEUEN Notiz schuetzt, ist unveraendert das
    # Zitattor: sie muss im Zitat stehen, sonst wird die Zeile nicht
    # geschrieben. Dafuer braucht es keine Isolierung in ein eigenes Paket.
    if ownership.exists and any(char.isdigit()
                                for char in claim_content(claims, added, today)):
        risk.append("zahl-geaendert")
    if escalate_hit(added):
        risk.append("geld-recht-gesundheit")
    if any(c.get("source_trust") == "third-party" for c in claims):
        risk.append("fremdtext")
    return risk


def _claim_payload(claim: dict) -> dict:
    """The claim as the reviewer sees it - DREAM-PLAN.md Abschnitt 7's schema
    plus `claim_id`, which the plan's example leaves implicit but `supersedes`
    and apply.py's store lookup both need by name.

    The field list comes from `claims.COLUMNS`, not from a copy: this tuple was
    written out by hand once, a field was added to the dataclass alone, and
    every claim was then refused because the changeset carried ten fields where
    the applier expected eleven."""
    return {k: claim.get(k) for k in claims_mod.COLUMNS}


@dataclass
class Changeset:
    run_id: str
    created_at: str
    hunks: list = field(default_factory=list)
    skipped_known_issue: list = field(default_factory=list)
    skipped_already_applied: int = 0
    skipped_no_subject: int = 0
    skipped_marker_in_claim: int = 0
    skipped_merged: int = 0

    def to_dict(self) -> dict:
        return {"run_id": self.run_id, "created_at": self.created_at,
                "hunks": [h.to_dict() for h in self.hunks]}


def build_changeset(vault: Path, claim_rows: list[dict], *,
                    run_id: str, today: dt.date | None = None,
                    notes: list[Note] | None = None,
                    known_issue_ids: set[str] | None = None,
                    plan=None) -> Changeset:
    """Turn stored claims into hunks against the CURRENT vault.

    Idempotence (test_dream_idempotent) has no extra bookkeeping behind it: a
    claim whose short id already stands in the target's dream block produces no
    hunk, and a hunk already recorded as rejected/refused in issues.json is not
    proposed a second time. Run twice over an unchanged corpus and the second
    changeset is empty.

    `plan` is M4's reconciliation (`reconcile.Plan`). With one, routing and
    supersession come from it: the plan groups the claims, merges the ones that
    say the same thing, and names a subject a page can be titled after. Without
    one, the provisional routing below still applies - first wikilink, else
    backticked identifier, else the source stem - which measured 20 hunks from
    93 of 293 claims and named pages after transcript UUIDs
    (`messungen/m4/BEFUNDE.md`).
    """
    vault = Path(vault)
    today = today or dt.date.today()
    today_iso = today.isoformat()
    known_issue_ids = known_issue_ids or set()
    notes = load_notes(vault) if notes is None else notes
    resolver = build_resolver([n for n in notes if not is_dream_output(n)])
    by_id = {row["claim_id"]: row for row in claim_rows}

    changeset = Changeset(run_id=run_id, created_at=dt.datetime.now().isoformat(
        timespec="seconds"))

    # Group by target, keeping claim order stable (oldest recorded first) so a
    # chained hunk sequence over one file is deterministic.
    grouped: dict[str, list[dict]] = {}
    for claim in sorted(claim_rows, key=lambda c: (c["recorded_at"], c["claim_id"])):
        if claim.get("valid_to"):
            continue            # already retired: never re-proposed
        if contains_marker(claim.get("text"), claim.get("quote")):
            changeset.skipped_marker_in_claim += 1
            log.warning("dream: claim %s carries a dream marker - not rendered",
                        short_id(str(claim.get("claim_id") or "")))
            continue
        if plan is not None and plan.representative_of(claim["claim_id"]):
            # Another claim in its group says the same thing and carries the
            # line; this one keeps its row in the store and simply is not
            # rendered twice.
            changeset.skipped_merged += 1
            continue
        routed = (plan.route(claim) if plan is not None
                  else route(claim, resolver, vault))
        if routed is None:
            changeset.skipped_no_subject += 1
            continue
        target, op = routed
        grouped.setdefault(f"{target}\x1f{op}", []).append(claim)

    for group_key, claims in grouped.items():
        target, op = group_key.split("\x1f", 1)
        path = vault / target
        text = read_text(path) if path.exists() else ""
        block = current_block(text)
        seen = applied_claim_ids(block)
        lines = block_lines(block)
        ownership = read_ownership(vault, target)

        fresh = [c for c in claims if short_id(c["claim_id"]) not in seen]
        changeset.skipped_already_applied += len(claims) - len(fresh)
        if not fresh:
            continue

        # Several hunks on one file are CHAINED: each one's `before` is the
        # previous one's `after`, and only the first may create the note. The
        # first version of this built every hunk against the file's current
        # state, so hunk 2 carried hunk 1's lines without carrying its claims -
        # and the citation gate then refused hunk 2 for values whose quotes
        # were sitting in the hunk right before it (measured 2026-08-07 on the
        # real store: seven refusals, every one of them this).
        state = _TargetState(op=op, block=block, lines=lines)
        subject = (plan.subject_for(claims[0]["claim_id"])
                   if plan is not None else None)

        # A claim that supersedes one already standing in this note is its own
        # hunk: it carries a different op, a different risk and a store change.
        applied_claims = [row for cid, row in by_id.items() if short_id(cid) in seen]
        pending: list[dict] = []
        retiring: list[tuple[dict, dict]] = []
        for claim in fresh:
            older = None
            if plan is not None:
                # The plan's supersessions are store-wide and judged; the
                # note-local rule below only ever sees what already stands in
                # this file.
                old_id = plan.supersedes_for(claim["claim_id"])
                older = by_id.get(old_id) if old_id else None
            older = older or _supersedes(claim, applied_claims)
            if older is None:
                pending.append(claim)
            else:
                retiring.append((claim, older))

        # Plain hunks first, retirements after. Only the first hunk of a chain
        # may create the note, and a retirement can never be that first hunk: it
        # is an append into a block, so on a page that does not exist yet it
        # reports `target-missing` and takes the whole chain down with it - the
        # create it displaced never happens either. Unreachable while
        # supersession was note-local (`_supersedes` only sees claims already
        # standing in the file, so the file existed); a plan's supersessions are
        # store-wide and reach a brand-new page. Measured 2026-08-08 on the real
        # store: 2 of 37 hunks, both on 10-global/dream/<ein eigenes Mailwerkzeug>.md.
        for chunk in _chunks(pending, dcfg.SHADOW_MAX_CLAIMS_PER_HUNK):
            new_lines = [render_claim(c, today_iso) for c in chunk]
            _add(changeset, _next_hunk(vault, target, state, state.op, chunk,
                                       ownership, text, new_lines, today_iso,
                                       subject=subject),
                 known_issue_ids)

        for claim, older in retiring:
            line = render_claim(claim, today_iso, supersedes=older)
            _add(changeset, _next_hunk(vault, target, state, OP_RETIRE, [claim],
                                       ownership, text, [line], today_iso,
                                       supersedes=[older["claim_id"]],
                                       subject=subject),
                 known_issue_ids)

    return changeset


@dataclass
class _TargetState:
    """How far a chain of hunks over one file has got."""
    op: str
    block: str | None
    lines: list


def _next_hunk(vault: Path, target: str, state: _TargetState, op: str,
               claims: list[dict], ownership: Ownership, text: str,
               new_lines: list[str], today_iso: str,
               supersedes: list[str] | None = None,
               subject: str | None = None) -> Hunk:
    after_lines = state.lines + new_lines
    hunk = _make_hunk(target, op, claims, ownership, text, state.block,
                      after_lines, "\n".join(new_lines), today_iso,
                      supersedes=supersedes, subject=subject)
    state.lines = after_lines
    state.block = render_block(after_lines)
    # Only the first hunk of a chain may create the note; after that the file
    # exists and everything else is an append into the block it now has.
    if state.op == OP_CREATE:
        state.op = OP_APPEND
    return hunk


def _add(changeset: Changeset, hunk: Hunk, known_issue_ids: set[str]) -> None:
    if hunk.hunk_id in known_issue_ids:
        changeset.skipped_known_issue.append(hunk.hunk_id)
        log.info("dream: hunk %s skipped - already rejected in an earlier run",
                 hunk.hunk_id)
        return
    changeset.hunks.append(hunk)


def _chunks(items: list[dict], size: int) -> list[list[dict]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def _supersedes(claim: dict, applied: list[dict]) -> dict | None:
    """The already-applied claim this one replaces, or None.

    Deterministic and narrow on purpose: same subject, same kind, strictly
    NEWER `recorded_at`. "Strictly" is the whole rule - an older source can
    never retire a younger statement (DREAM-PLAN.md Abschnitt 7, Regel 3),
    and equal timestamps decide nothing.
    """
    key, kind = subject_key(claim), claim.get("kind")
    best = None
    for other in applied:
        if other["claim_id"] == claim["claim_id"] or other.get("valid_to"):
            continue
        if subject_key(other) != key or other.get("kind") != kind:
            continue
        if not claim["recorded_at"] > other["recorded_at"]:
            continue
        if best is None or other["recorded_at"] > best["recorded_at"]:
            best = other
    return best


def _make_hunk(target: str, op: str, claims: list[dict], ownership: Ownership,
               text: str, before_block: str | None, lines: list[str],
               added: str, today_iso: str,
               supersedes: list[str] | None = None,
               subject: str | None = None) -> Hunk:
    """`subject` titles a created page. Without one the provisional
    `subject_key` decides, and that falls back to the source document's stem:
    measured 2026-08-08, a page correctly ROUTED to `10-global/dream/aes.md`
    was titled `20260729-185314`, the file name of the worker result it came
    from. The title is not covered by `added_text` (which strips frontmatter)
    and it is what `brain search` and the resolver key on, so it must come from
    the same decision the path came from."""
    block = render_block(lines)
    if op == OP_CREATE:
        before = None
        after = new_note_text(subject or subject_key(claims[0]), lines,
                              today_iso, beleg=beleg_of(claims))
    elif op == OP_REPLACE:
        before = text or None
        after, _ok = apply_block(text, block)
    else:                        # append-section / retire-claim
        before = before_block
        after = block
    return Hunk(
        hunk_id=compute_hunk_id(op, target, [c["claim_id"] for c in claims]),
        target=target, op=op, ownership=ownership.to_dict(),
        before=before, after=after,
        claims=[_claim_payload(c) for c in claims],
        supersedes=list(supersedes or []),
        risk=risk_markers(claims, ownership, added, today_iso))


# ---------------------------------------------------------------------------
# The shadow tree and the changeset file
# ---------------------------------------------------------------------------

def write_shadow(changeset: Changeset, vault: Path,
                 shadow_dir: Path | None = None) -> list[Path]:
    """Materialize what each target WOULD look like, under the state dir.

    Written with plain filesystem calls on purpose: `VaultWriter` is the
    vault's write gate and must never be handed a path outside it. That
    separation is the isolation property, not a detail of this function.
    """
    shadow_dir = Path(shadow_dir or dcfg.SHADOW_DIR)
    vault = Path(vault)
    out: list[Path] = []
    working: dict[str, str] = {}
    shadow_dir.mkdir(parents=True, exist_ok=True)
    root = shadow_dir.resolve()
    for hunk in changeset.hunks:
        path = shadow_dir / hunk.target
        # A `..` in the target used to walk the shadow out of its own
        # directory (reported 2026-08-07). The shadow is run state and stays
        # inside its tree, whatever a changeset asks for.
        if not _inside(path, root):
            log.warning("dream: shadow target %s leaves the shadow tree - skipped",
                        hunk.target)
            continue
        target_path = vault / hunk.target
        # Hunks over one file are chained, so the shadow follows the chain:
        # a file's shadow shows the state after ALL its hunks, not after the
        # last one applied to today's vault text.
        text = working.get(hunk.target,
                           read_text(target_path) if target_path.exists() else "")
        if hunk.op in (OP_APPEND, OP_RETIRE):
            proposed, ok = apply_block(text, hunk.after)
            if not ok:
                log.warning("dream: %s has unbalanced dream markers - no shadow",
                            hunk.target)
                continue
        else:
            proposed = hunk.after
        working[hunk.target] = proposed
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(proposed, encoding="utf-8")
        if path not in out:
            out.append(path)
    return out


def _inside(path: Path, root: Path) -> bool:
    """Whether `path` stays under `root` once `..` is resolved. The parent is
    resolved rather than the file, which need not exist yet."""
    try:
        return (path.parent.resolve() / path.name).is_relative_to(root)
    except (OSError, ValueError):
        return False


def audit_dir(vault: Path, run_id: str) -> Path:
    return Path(vault) / dcfg.DREAM_AUDIT_DIR / run_id


def write_changeset(changeset: Changeset, vault: Path) -> Path:
    """`_meta/state/dream/<run-id>/changeset.json` - vault-relative and
    versioned (DREAM-PLAN.md Abschnitt 3): what an autonomous run proposed has
    to stay diffable. Written directly, not through VaultWriter, which refuses
    `_meta/` by design."""
    path = audit_dir(vault, changeset.run_id) / "changeset.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(changeset.to_dict(), ensure_ascii=False,
                               indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def load_changeset(path: Path) -> tuple[str, list[dict]]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return str(data.get("run_id") or ""), list(data.get("hunks") or [])


def format_shadow_report(changeset: Changeset) -> str:
    lines = [f"dream shadow (Lauf {changeset.run_id})", "",
             f"Hunks: {len(changeset.hunks)}",
             f"Aussagen schon in der Notiz: {changeset.skipped_already_applied}",
             f"Aussagen ohne brauchbares Ziel (warten auf M4): "
             f"{changeset.skipped_no_subject}",
             f"Aussagen, die eine andere vertritt (zusammengefuehrt): "
             f"{changeset.skipped_merged}",
             f"Aussagen mit Traum-Marker im Text (nicht darstellbar): "
             f"{changeset.skipped_marker_in_claim}",
             f"Hunks aus frueheren Ablehnungen uebersprungen: "
             f"{len(changeset.skipped_known_issue)}"]
    if changeset.hunks:
        lines += ["", "Je Hunk:"]
        for h in changeset.hunks:
            risk = f" risiko={','.join(h.risk)}" if h.risk else ""
            lines.append(f"  {h.hunk_id} {h.op:16s} {h.target} "
                         f"(class={h.ownership['class']}, "
                         f"marker={'ja' if h.ownership['dream_marker'] else 'nein'}, "
                         f"aussagen={len(h.claims)}){risk}")
    return "\n".join(lines)
