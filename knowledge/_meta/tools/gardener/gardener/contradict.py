"""Contradiction detection: a neighbor-scoped judge pass that finds where two
notes assert opposite facts about the same thing, records the finding, and
marks both notes so a reader (human or agent) cannot miss it.

Distinct from linking.py's "contradicts" relation type (asserted but never
reliably produced) and from consolidate.py's "review" action (a *write*
collision between near-duplicate notes, not a *knowledge* contradiction). This
module never merges or rewrites a note's own claims; see `10-global/contradiction-rules.md`
in the vault for the resolution rules a human/agent applies to an open finding.

Every finding must survive a literal substring check against the two notes it
names (`_verify_quote`): the judge is a 9B local model and happily invents a
plausible-sounding quote that isn't actually in the text. A finding that fails
that check is discarded entirely, never recorded with a paraphrase.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import blocks, config
from .linking import cosine
from .vault import Note, VaultWriter

log = logging.getLogger("gardener")

CONTRADICT_TEXT_CHARS = 2000

CONTRADICT_SYSTEM = (
    "You maintain a personal markdown knowledge vault. You judge whether two "
    "notes state a real, factual contradiction about the SAME specific thing "
    "(a value, a decision, a status, a date, a fact). Different topics, "
    "different projects, or merely related content is NOT a contradiction. "
    "Answer ONLY with a JSON object: "
    '{"verdict": "contradiction|tension|compatible", "confidence": 0.0-1.0, '
    '"claim_a": "<verbatim quote from note A>", "claim_b": "<verbatim quote '
    'from note B>", "why": "<one short sentence>"}. '
    "'contradiction': both notes assert opposite facts about the same thing. "
    "'tension': related but not a clean opposite assertion - most commonly a "
    "stated intention/goal in one note versus a later measured/actual value in "
    "the other; this is often not a real contradiction, just an undated pair, "
    "but is still worth flagging. 'compatible': no real conflict - use this "
    "whenever in doubt, a missed contradiction is cheaper than a false alarm. "
    "claim_a and claim_b MUST be copied character-for-character from the "
    "respective note, never paraphrased or summarized: an answer that cannot "
    "be found verbatim in the note is discarded entirely, so paraphrasing "
    "wastes the judgment."
)

# Money / legal / health / third-party-commitment terms (DE + EN): a hit means
# the finding must be escalated, never auto-resolved by an agent alone (see
# 10-global/contradiction-rules.md rule 4).
ESCALATE_TERMS = (
    "€", "eur ", "steuer", "finanzamt", "vertrag", "kredit", "darlehen",
    "gehalt", "lohn", "rechnung", "versicherung", "recht", "gesetz", "klage",
    "anwalt", "gesundheit", "diagnose", "arzt", "krankheit", "medikament",
    "therapie", "zusage", "contract", "invoice", "salary", "lawsuit",
    "diagnosis", "prescription",
)

# The terms above are word STEMS, and German compounds them. Matching them as
# naked substrings made "rechtfertigen" a legal matter and "gesetzt" a
# legislative one: measured 2026-08-07 over the dream's real claim store, three
# of four hits were of exactly that kind. A false alarm is not free - it is a
# line in the one queue a person actually reads, and a queue of noise stops
# being read.
#
# So a term now has to start a word, and a small, named set of German words
# that merely begin with one of the stems is excluded. The list itself is
# unchanged and stays shared with the dream: two drifting copies of a rule are
# worse than one imperfect rule.
# Every entry below was measured against this vault on 2026-08-07, not guessed:
# the number is how often the word triggered a hit across all 245 notes.
ESCALATE_WORD_EXCEPTIONS = (
    "gesetzt", "gesetzte",          # "falls gesetzt", "zusammengesetzte" (5)
    "rechtfertig",                  # "rechtfertigt keinen Link" (4)
    "gehalten",                     # "in-memory gehalten" (7)
    "steuerkanal", "steuermodus",   # Workbench-Vokabular (4 + 3)
    "steuerclient", "steuersocket",  # dito (3 + 3)
    "rechtsklick",                  # (3)
    "rechtzeitig", "rechtschreib", "rechteck",
    "lohnt", "lohnend", "vertragen", "vertraeglich",
    "steuert", "steuerung", "steuernd",
)
# Two entries were too wide and are gone (2026-08-08): `steuerbar` swallowed
# "steuerbares Einkommen" and `lohnen` swallowed "Lohnentwicklung", because the
# comparison asks whether the word BEGINS with the exception. Both now escalate
# - the wide direction is the safe one here.
#
# Words that need the whole form, not a stem: they carry the term in the middle
# and would otherwise slip past the prefix rule. Each measured over the 247
# real vault notes, count in the comment.
ESCALATE_EXACT_EXCEPTIONS = frozenset({
    "ungesetzt",            # (1) "solange ... ungesetzt bleibt"
    "ungesteuerter",        # (1)
})
# German puts the meaning-bearing part at the END of a compound, so "the term
# must start a word" is the wrong rule for it: `Fachanwalt`, `Frauenarzt`,
# `Physiotherapie`, `Mietvertrag`, `Einkommensteuer` all hide the term inside
# the word. Measured over 247 vault notes on 2026-08-08: the word-start rule
# missed 48 notes the plain substring rule had caught, among them a specialist
# lawyer, a gynaecologist and a misdiagnosis - the exact class that must never
# be missed. What is asked instead is what stands IN FRONT of the term. The
# noise is almost entirely participles and a handful of prefixes.
# See 10-global/deutsche-komposita-wortgrenze.md.
ESCALATE_NOISE_PREFIXES = ("ge", "um", "ein", "an", "auf", "zurueck", "zurück",
                           "fest", "durch", "be", "natur", "ueber", "über",
                           # separable verb prefix, same class as the rest:
                           # "dynamisch zusammengesetzte Aufrufe" (measured)
                           "zusammen")
_WORD_RE = re.compile(r"[a-z0-9äöüß]+", re.IGNORECASE)


def _word_around(hay: str, i: int, term: str) -> tuple[str, str]:
    """(whole word containing the term, the part of it before the term)."""
    for m in _WORD_RE.finditer(hay):
        if m.start() <= i < m.end():
            return m.group(0), hay[m.start():i]
    return term, ""


def escalate_hit(text: str) -> str | None:
    """The escalation term this text hits, or None.

    An alphabetic term counts wherever it stands in a word, EXCEPT when one of
    the known noise prefixes sits immediately in front of it (`umgesetzt`,
    `eingesetzt`, `naturgesetz`) or the word is one of the measured exceptions.
    Symbol terms (`€`) and terms carrying their own boundary (`eur `) are
    matched as they stand.

    The direction is decided by the asymmetry of the consequences: a false
    alarm costs one line in the queue, a missed money/law/health case goes into
    the vault unchecked. So this errs wide on purpose.
    """
    hay = text.lower()
    for term in ESCALATE_TERMS:
        if not term.strip().isalpha():
            if term in hay:
                return term
            continue
        start = 0
        while (i := hay.find(term, start)) != -1:
            start = i + 1
            word, before = _word_around(hay, i, term)
            if before and any(before.endswith(p) for p in ESCALATE_NOISE_PREFIXES):
                continue                     # a participle, not a legal matter
            if any(word.startswith(x) for x in ESCALATE_WORD_EXCEPTIONS):
                continue
            if word in ESCALATE_EXACT_EXCEPTIONS:
                continue
            return term
    return None

MARKER_RE_TMPL = (
    r"<!-- contradiction:{id} status=\w+ -->.*?<!-- /contradiction:{id} -->"
)


@dataclass
class ContradictResult:
    findings: list[dict] = field(default_factory=list)  # new-or-refreshed this run
    pairs_checked: int = 0
    compatible: int = 0
    below_threshold: int = 0
    hallucinated: int = 0
    judge_failed: int = 0


# -- candidate selection ----------------------------------------------------

def top_k_neighbors(rel: str, vectors: dict[str, list[float]],
                    k: int = config.CONTRADICT_TOP_K) -> list[tuple[str, float]]:
    """Nearest k other notes by cosine, from ONE note's perspective.

    Deliberately not linking.neighbor_candidates: that builds the symmetric
    top-k over the whole corpus (every note against every other), which is the
    right shape for linking but means re-deriving it here would re-scan notes
    that did not change. This is the per-note primitive `run_contradict` needs
    to stay O(checked_notes * k), not O(n^2).
    """
    if rel not in vectors:
        return []
    sims = [(other, cosine(vectors[rel], vec))
            for other, vec in vectors.items() if other != rel]
    sims.sort(key=lambda t: -t[1])
    return sims[:k]


def changed_since(notes: list[Note], cutoff: dt.datetime) -> list[Note]:
    cutoff_ts = cutoff.timestamp()
    out = []
    for n in notes:
        try:
            mtime = n.path.stat().st_mtime
        except OSError:
            continue
        if mtime >= cutoff_ts:
            out.append(n)
    return out


def resolve_note_arg(vault: Path, arg: str, notes: list[Note]) -> Note | None:
    """Resolve a `--note` CLI argument (absolute or vault-relative path) to a
    loaded Note. Returns None rather than raising: the CLI reports it."""
    p = Path(arg)
    rel = (p.relative_to(vault) if p.is_absolute() else p).as_posix()
    return next((n for n in notes if n.rel == rel), None)


def _queue_rel(vault: Path, arg: str) -> str:
    p = Path(arg)
    return (p.relative_to(vault) if p.is_absolute() else p).as_posix()


# -- the deferred-scan queue (`_meta/state/contradiction-queue.txt`) --------
#
# Session-end used to run the full judge scan inline (~100s/note). That blocked
# every session close. Now session-end only appends paths here (milliseconds);
# `brain contradict --queue --write` (via brain-maintain, Mo/Mi launchd, or by
# hand) does the actual scan and empties the queue afterwards. See cli.py.

def queue_read(vault: Path) -> list[str]:
    """Vault-relative paths currently queued, in the order they were added."""
    path = vault / config.CONTRADICT_QUEUE_FILE
    if not path.exists():
        return []
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines()]
    return [ln for ln in lines if ln]


def queue_add(vault: Path, paths: list[str]) -> list[str]:
    """Append paths to the queue, deduplicated against what is already there
    (and against duplicates within this same call). Returns only the entries
    actually appended."""
    path = vault / config.CONTRADICT_QUEUE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = set(queue_read(vault))
    new: list[str] = []
    for arg in paths:
        rel = _queue_rel(vault, arg)
        if rel not in existing and rel not in new:
            new.append(rel)
    if new:
        with path.open("a", encoding="utf-8") as f:
            for rel in new:
                f.write(rel + "\n")
    return new


def queue_clear_processed(vault: Path, processed: list[str]) -> None:
    """Remove exactly the given entries from the queue. Entries appended by
    someone else after the run started (e.g. a session ending concurrently)
    are read fresh here and kept, not clobbered."""
    path = vault / config.CONTRADICT_QUEUE_FILE
    if not path.exists():
        return
    drop = set(processed)
    remaining = [ln for ln in queue_read(vault) if ln not in drop]
    if remaining:
        path.write_text("\n".join(remaining) + "\n", encoding="utf-8")
    else:
        path.unlink()


# -- last-run bookkeeping (_meta/tools/state/contradict.json) ---------------

def load_last_run(vault: Path) -> dt.datetime | None:
    path = vault / config.CONTRADICT_LAST_RUN_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return dt.datetime.fromisoformat(data["last_run"])
    except (OSError, ValueError, KeyError):
        return None


def save_last_run(vault: Path, when: dt.datetime, dry_run: bool) -> None:
    if dry_run:
        return
    path = vault / config.CONTRADICT_LAST_RUN_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"last_run": when.isoformat(timespec="seconds")},
                               indent=2) + "\n", encoding="utf-8")


# -- the judge call -----------------------------------------------------------

def judge_pair(client, a: Note, b: Note) -> dict:
    prompt = (
        f"Note A: {a.title} ({a.rel})\n---\n{a.text[:CONTRADICT_TEXT_CHARS]}\n\n"
        f"Note B: {b.title} ({b.rel})\n---\n{b.text[:CONTRADICT_TEXT_CHARS]}\n\n"
        "Do these notes contradict each other?"
    )
    return client.judge(CONTRADICT_SYSTEM, prompt) or {}


def _confidence_of(verdict: dict) -> float:
    try:
        return float(verdict.get("confidence"))
    except (TypeError, ValueError):
        return 0.0


def _verify_quote(quote, text: str) -> bool:
    """Literal substring test - the sole defense against a hallucinating judge."""
    return isinstance(quote, str) and bool(quote.strip()) and quote in text


# -- escalation ---------------------------------------------------------------

def escalation_reason(a: Note, b: Note) -> str | None:
    """Cheap, deterministic triggers only (see 10-global/contradiction-rules.md rule 4).

    Everything else stays `open` for a human/agent to triage with the rules
    doc - this function must never talk itself into resolving a finding, only
    into flagging it as one that must NOT be auto-resolved.
    """
    hit = escalate_hit(a.text + "\n" + b.text)
    if hit:
        return f'Geld-/Rechts-/Gesundheitsbezug (Treffer: "{hit.strip()}")'
    owner_a, owner_b = a.fm.get("owner"), b.fm.get("owner")
    if owner_a and owner_b and str(owner_a).strip().lower() != str(owner_b).strip().lower():
        return f"unterschiedliche Projekt-Owner ({owner_a} / {owner_b})"
    return None


# -- finding identity + persistence -------------------------------------------

def _note_id(n: Note) -> str:
    return str(n.fm.get("id") or n.rel)


def finding_id(id_a: str, quote_a: str, id_b: str, quote_b: str) -> str:
    """Stable regardless of which note was passed as A vs B (sorted pairing),
    so the same real-world contradiction always upserts the same JSON entry."""
    pair = sorted([f"{id_a}\x1f{quote_a}", f"{id_b}\x1f{quote_b}"])
    return hashlib.sha256("\x1e".join(pair).encode("utf-8")).hexdigest()[:16]


def build_finding(a: Note, b: Note, verdict: dict, confidence: float,
                  today: dt.datetime | None = None) -> dict:
    today = today or dt.datetime.now()
    quote_a, quote_b = verdict["claim_a"], verdict["claim_b"]
    id_a, id_b = _note_id(a), _note_id(b)
    reason = escalation_reason(a, b)
    return {
        "id": finding_id(id_a, quote_a, id_b, quote_b),
        "note_a": {"rel": a.rel, "id": id_a, "title": a.title, "quote": quote_a},
        "note_b": {"rel": b.rel, "id": id_b, "title": b.title, "quote": quote_b},
        "verdict": verdict.get("verdict"),
        "confidence": confidence,
        "why": verdict.get("why", ""),
        "found": today.isoformat(timespec="seconds"),
        "status": "escalated" if reason else "open",
        "escalation_reason": reason,
        "resolution": None,
    }


class ContradictionStore:
    """_meta/state/contradictions.json: {"findings": {id: finding}}.

    Read is unconditional (a dry-run must still see what earlier real runs
    already found, or every dry-run would look like a fresh corpus). Only
    `save()` is gated by the caller's dry_run flag.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.data: dict[str, dict] = {}
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self.data = raw.get("findings", {}) if isinstance(raw, dict) else {}
            except (OSError, ValueError) as e:
                log.warning("could not read %s: %s - starting empty", self.path, e)

    def get(self, finding_id: str) -> dict | None:
        return self.data.get(finding_id)

    def upsert(self, finding: dict) -> dict:
        """Insert if new. If the id already exists, refresh only the
        observational fields (confidence/why/found) - a rediscovery must never
        un-resolve or un-escalate a finding a human/agent already handled
        (see 10-global/contradiction-rules.md rule 5: never erase without repairing)."""
        existing = self.data.get(finding["id"])
        if existing is None:
            self.data[finding["id"]] = finding
            return finding
        existing["confidence"] = finding["confidence"]
        existing["why"] = finding["why"]
        existing["found"] = finding["found"]
        return existing

    def save(self, dry_run: bool = False) -> None:
        if dry_run:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({"findings": self.data}, indent=2, ensure_ascii=False,
                      sort_keys=True) + "\n", encoding="utf-8")

    def open_findings(self) -> list[dict]:
        return [f for f in self.data.values() if f["status"] in ("open", "escalated")]

    def open_rels(self) -> set[str]:
        rels: set[str] = set()
        for f in self.open_findings():
            rels.add(f["note_a"]["rel"])
            rels.add(f["note_b"]["rel"])
        return rels


def resolve_finding(store: ContradictionStore, finding_id: str, by: str, why: str,
                    rule: str = "", vault: Path | None = None,
                    writer: VaultWriter | None = None,
                    today: dt.datetime | None = None) -> dict:
    """Mark a finding resolved with who/when/why. Updates the marker blocks in
    both notes when a vault+writer are given; never deletes the original
    claims (CONTRADICTIONS.md rule 5 - resolving reformulates, it does not
    erase the losing statement)."""
    finding = store.get(finding_id)
    if finding is None:
        raise KeyError(f"unknown contradiction id: {finding_id}")
    today = today or dt.datetime.now()
    finding["status"] = "resolved"
    finding["resolution"] = {"by": by, "why": why, "rule": rule,
                             "at": today.isoformat(timespec="seconds")}
    if vault is not None and writer is not None:
        from .vault import parse_note
        a_path, b_path = vault / finding["note_a"]["rel"], vault / finding["note_b"]["rel"]
        if a_path.exists() and b_path.exists():
            apply_markers(writer, parse_note(vault, a_path), parse_note(vault, b_path), finding)
    return finding


# -- marker blocks in the notes themselves ------------------------------------

def _rule_label(finding: dict) -> str:
    if finding["status"] == "resolved":
        res = finding.get("resolution") or {}
        return res.get("rule") or "aufgeloest"
    if finding["status"] == "escalated":
        return f"unentscheidbar - eskaliert ({finding.get('escalation_reason') or ''})"
    return "noch offen - siehe 10-global/contradiction-rules.md"


def _marker_block(finding_id: str, status: str, date: str, confidence: float,
                  here_quote: str, there_quote: str, other_title: str,
                  rule_label: str) -> str:
    header = {"open": "Offener Widerspruch", "escalated": "Eskalierter Widerspruch",
              "resolved": "Aufgeloester Widerspruch"}.get(status, "Widerspruch")
    return (
        f"<!-- contradiction:{finding_id} status={status} -->\n"
        f"> **{header}** ({date}, Konfidenz {confidence:.2f})\n"
        f'> Hier: "{here_quote}"\n'
        f'> Dort: "{there_quote}" — [[{other_title}]]\n'
        f"> Regel: {rule_label}\n"
        f"<!-- /contradiction:{finding_id} -->"
    )


def upsert_marker(text: str, finding_id: str, block: str) -> tuple[str, bool]:
    """(new_text, ok). ok=False means more than one block for this id already
    exists (malformed - hand edit or merge conflict): the caller must not
    write. Zero existing blocks -> append. Exactly one -> replace in place, so
    a second run never duplicates it."""
    pattern = re.compile(MARKER_RE_TMPL.format(id=re.escape(finding_id)), re.DOTALL)
    matches = pattern.findall(text)
    if len(matches) > 1:
        return text, False
    if len(matches) == 1:
        return pattern.sub(lambda _m: block, text, count=1), True
    return text.rstrip("\n") + "\n\n" + block + "\n", True


def apply_markers(writer: VaultWriter, a: Note, b: Note, finding: dict) -> bool:
    date = str(finding.get("found") or "")[:10] or "unbekannt"
    conf = finding["confidence"]
    status = finding["status"]
    rule_label = _rule_label(finding)
    block_a = _marker_block(finding["id"], status, date, conf,
                            finding["note_a"]["quote"], finding["note_b"]["quote"],
                            b.title, rule_label)
    block_b = _marker_block(finding["id"], status, date, conf,
                            finding["note_b"]["quote"], finding["note_a"]["quote"],
                            a.title, rule_label)
    new_a, ok_a = upsert_marker(a.text, finding["id"], block_a)
    new_b, ok_b = upsert_marker(b.text, finding["id"], block_b)
    if not (ok_a and ok_b):
        log.warning("malformed contradiction marker for id %s - not rewriting",
                    finding["id"])
        return False
    ok = True
    if new_a != a.text:
        ok = writer.write(a.path, new_a, expect=a.text) and ok
        if ok:
            a.text = new_a
    if new_b != b.text:
        wrote_b = writer.write(b.path, new_b, expect=b.text)
        ok = wrote_b and ok
        if wrote_b:
            b.text = new_b
    return ok


# -- human-readable review queue (review-queue.md, vault root) ---------------

# Unterabschnitt, keine eigene Seitenueberschrift: seit die Queue EINE Datei mit
# zwei Schreibern ist, hat die Datei bereits einen Titel und nennt die
# Aufloesungsregeln. Beides hier zu wiederholen ergab zwei H1 untereinander.
REVIEW_QUEUE_HEADER = "## Wissenswidersprueche (`brain contradict`)\n"


def review_queue_line(finding: dict) -> str:
    a, b = finding["note_a"], finding["note_b"]
    tag = "ESKALIERT" if finding["status"] == "escalated" else finding["verdict"]
    date = finding["found"][:10]
    return (f"- {date}: [{tag}] [[{a['title']}]] vs [[{b['title']}]] "
            f"(Konfidenz {finding['confidence']:.2f}, id {finding['id']}): "
            f"\"{a['quote']}\" <-> \"{b['quote']}\"")


# Abschnittsmarker: seit die Queue EINE Datei ist, teilen sich zwei Schreiber sie.
# Der Gardener haengt unklare Faelle an (append-only), dieser Schreiber regeneriert
# seine Befunde vollstaendig - ein aufgeloester Widerspruch muss verschwinden statt
# liegenzubleiben. Ohne Marker wuerde das vollstaendige Neuschreiben die Eintraege
# des Gardeners mitloeschen; genau das waere beim Zusammenlegen am 2026-07-29
# passiert.
QUEUE_SECTION_START = "<!-- contradictions:start -->"
QUEUE_SECTION_END = "<!-- contradictions:end -->"


def write_review_queue(vault: Path, findings: list[dict], dry_run: bool) -> Path:
    """Regenerate ONLY this writer's own section of the shared review queue.

    Everything outside the marker pair belongs to the gardener and is preserved
    byte for byte.
    """
    path = vault / config.CONTRADICT_REVIEW_QUEUE
    ordered = sorted(findings, key=lambda f: f["found"])
    body = [QUEUE_SECTION_START, "", REVIEW_QUEUE_HEADER.rstrip("\n"), ""]
    body += [review_queue_line(f) for f in ordered] if ordered else \
        ["(keine offenen Widersprueche)"]
    body += ["", QUEUE_SECTION_END]
    section = "\n".join(body)

    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    text = blocks.upsert_section(existing, QUEUE_SECTION_START,
                                 QUEUE_SECTION_END, section)

    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return path


# -- the scan itself -----------------------------------------------------------

def run_contradict(to_check: list[Note], all_notes: list[Note],
                   vectors: dict[str, list[float]], client,
                   store: ContradictionStore,
                   min_confidence: float = config.CONTRADICT_MIN_CONFIDENCE,
                   top_k: int = config.CONTRADICT_TOP_K,
                   deadline=None) -> ContradictResult:
    result = ContradictResult()
    by_rel = {n.rel: n for n in all_notes}
    seen: set[tuple[str, str]] = set()
    for note in to_check:
        for other_rel, _sim in top_k_neighbors(note.rel, vectors, top_k):
            key = tuple(sorted((note.rel, other_rel)))
            if key in seen:
                continue
            seen.add(key)
            if deadline is not None and deadline.expired():
                return result
            other = by_rel.get(other_rel)
            if other is None:
                continue
            result.pairs_checked += 1
            verdict = judge_pair(client, note, other)
            if verdict.get("verdict") not in ("contradiction", "tension", "compatible"):
                result.judge_failed += 1
                continue
            if verdict["verdict"] == "compatible":
                result.compatible += 1
                continue
            confidence = _confidence_of(verdict)
            if confidence < min_confidence:
                result.below_threshold += 1
                continue
            if not (_verify_quote(verdict.get("claim_a"), note.text)
                    and _verify_quote(verdict.get("claim_b"), other.text)):
                result.hallucinated += 1
                continue
            finding = build_finding(note, other, verdict, confidence)
            result.findings.append(store.upsert(finding))
    return result
