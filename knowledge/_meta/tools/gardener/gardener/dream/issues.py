"""Where a refused, rejected or escalated hunk goes - the dream's memory of
what must not be proposed again, and the one place a human looks.

Two destinations, per DREAM-PLAN.md Abschnitt 7:

- machine-readable `_meta/state/dream/issues.json`, so the NEXT dream knows
  what was already turned down instead of tabling the same hunk forever;
- human-readable inside `<!-- dream:start -->`/`<!-- dream:end -->` in the
  shared `review-queue.md`, fully regenerated, byte-preserving outside the
  markers. That is exactly the mechanism the contradiction scanner has shared
  with the gardener since 2026-07-29 - here it is the same code
  (`blocks.upsert_section`), not a second implementation of it.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from .. import blocks as blocks_mod
from . import config as dcfg

log = logging.getLogger("gardener.dream")

SECTION_START = dcfg.DREAM_QUEUE_SECTION_START
SECTION_END = dcfg.DREAM_QUEUE_SECTION_END
SECTION_HEADER = "## Traum (`brain dream`)"

# States that belong in front of a human. A hunk the reviewer plainly rejected
# is machine memory; a code refusal and an escalation are not - the first means
# model and code disagree about ownership, the second means the rules say a
# person has to decide.
HUMAN_STATES = ("refused-by-code", "escalated")


def issues_path(vault: Path) -> Path:
    return Path(vault) / dcfg.ISSUES_FILE


def load_issues(vault: Path) -> dict[str, dict]:
    path = issues_path(vault)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("dream: issues.json unreadable (%s) - treated as empty", e)
        return {}
    entries = data.get("issues") if isinstance(data, dict) else data
    return {str(e["hunk_id"]): e for e in (entries or []) if e.get("hunk_id")}


def known_hunk_ids(vault: Path) -> set[str]:
    """What shadow.py must not propose again."""
    return set(load_issues(vault))


def merge(existing: dict[str, dict], new: list[dict], *,
          now: str | None = None) -> dict[str, dict]:
    """New issues are added, known ones keep their `first_seen` and only get a
    fresh `last_seen`. Nothing is ever dropped here: an issue disappearing
    would let the next run re-propose exactly what was turned down."""
    now = now or dt.datetime.now().isoformat(timespec="seconds")
    out = dict(existing)
    for issue in new:
        hid = str(issue["hunk_id"])
        prior = out.get(hid)
        merged = dict(issue)
        merged["first_seen"] = (prior or {}).get("first_seen") or now
        merged["last_seen"] = now
        merged["seen_count"] = int((prior or {}).get("seen_count") or 0) + 1
        out[hid] = merged
    return out


def write_issues(vault: Path, issues: dict[str, dict], dry_run: bool = False) -> Path:
    """Written directly, not through VaultWriter: `_meta/` is refused by the
    write gate on purpose (the gardener may never rewrite its own tooling
    layer), while this file is the versioned audit trail of an autonomous
    run - same case as `_meta/state/contradictions.json`."""
    path = issues_path(vault)
    payload = {"issues": [issues[k] for k in sorted(issues)]}
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2,
                                   sort_keys=True) + "\n", encoding="utf-8")
    return path


HELD_BACK = ("[Text zurueckgehalten: anweisungsartig. Der Wortlaut steht "
             "maschinenlesbar in issues.json.]")


def safe_detail(detail: str) -> str:
    """Die Begruendung, wie sie in einer Datei stehen darf, die spaeter gelesen
    wird.

    `review-queue.md` ist ein dauerhafter Traeger: sie liegt im Vault, `brain
    search` findet sie, und Menschen wie Agenten lesen sie. Eine Begruendung
    traegt aber fremden Text - genau den, an dem der Hunk gescheitert ist. Ein
    `instruction-shaped`-Fall schrieb damit den eingeschleusten Satz woertlich
    in die Queue und von dort in jede spaetere Sitzung, die sie liest (gemessen
    10.08.2026 im Traeger-Pruefsatz, nach dem Lebenszyklus-Modell von
    HarnessSafe, arXiv 2608.06984).

    Zurueckgehalten wird der WORTLAUT, nicht der Fall: Kennung, Ziel, Operation
    und Grund stehen weiter da. Wer den Text braucht, findet ihn in
    `issues.json` - eine Datei, die niemand als Anweisung liest.
    """
    from .apply import _INSTRUCTION_RE     # lokal: apply importiert dieses Modul
    text = str(detail or "").strip()
    return HELD_BACK if text and _INSTRUCTION_RE.search(text) else text


def escalation_detail_path(vault: Path, run_id: str) -> Path:
    """Where a hunk's full proposal text lives for one run - vault-relative,
    versioned, next to that run's `judgments.json`/`applied.json`."""
    return Path(vault) / dcfg.DREAM_AUDIT_DIR / run_id / dcfg.ESCALATION_DETAIL_FILE


def escalation_detail_ref(issue: dict) -> str | None:
    """The pointer `queue_line` prints for a human-facing issue, or None if
    the issue carries no `run_id`/`hunk_id` to build one from (old issues.json
    entries from before this existed)."""
    run_id, hunk_id = issue.get("run_id"), issue.get("hunk_id")
    if not run_id or not hunk_id:
        return None
    return (f"{dcfg.DREAM_AUDIT_DIR}/{run_id}/{dcfg.ESCALATION_DETAIL_FILE}"
            f"#{hunk_id}")


def write_escalation_details(vault: Path, run_id: str, hunks: list[dict],
                             new_issues: list[dict],
                             dry_run: bool = False) -> Path | None:
    """The full proposal - `before`, `after`, `claims` - of every hunk that
    just became human-facing (state in `HUMAN_STATES`), keyed by hunk_id.

    This is the one place that keeps a hunk's own text once `dream shadow`'s
    `changeset.json` is gone: that file is deliberately gitignored and
    machine-local (the first full run's changeset was 120 MB), so nothing
    versioned survived it - found 02.09.2026 when the 87 escalations of
    2026-08-16 turned out to have no recoverable wording anywhere: not in
    `trace.jsonl`, not in `dream.db`, not in `reconcile.db`, not in the shadow.
    Six of them had to be rejected unread as a result.

    Merges into whatever this run already wrote (a review step and an apply
    step over the SAME run_id both call this); nothing already stored here is
    ever dropped."""
    by_id = {str(h.get("hunk_id") or ""): h for h in hunks}
    relevant = [i for i in new_issues if i.get("state") in HUMAN_STATES]
    if not relevant:
        return None
    path = escalation_detail_path(vault, run_id)
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            log.warning("dream: %s unreadable (%s) - treated as empty", path, e)
            existing = {}
    for issue in relevant:
        hid = str(issue.get("hunk_id") or "")
        hunk = by_id.get(hid)
        if hunk is None:
            continue          # this run's own hunks did not carry this id
        existing[hid] = {"hunk_id": hid, "target": hunk.get("target"),
                         "op": hunk.get("op"), "before": hunk.get("before"),
                         "after": hunk.get("after"), "claims": hunk.get("claims"),
                         "state": issue.get("state"), "reason": issue.get("reason"),
                         "detail": issue.get("detail")}
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(existing, ensure_ascii=False, indent=2,
                                   sort_keys=True) + "\n", encoding="utf-8")
    return path


def queue_line(issue: dict) -> str:
    detail = safe_detail(issue.get("detail"))
    ref = escalation_detail_ref(issue)
    return (f"- {str(issue.get('last_seen') or '')[:10]}: "
            f"[{issue.get('state')}] {issue.get('target')} "
            f"({issue.get('op')}, hunk {issue.get('hunk_id')}): "
            f"{issue.get('reason')}" + (f" - {detail}" if detail else "") +
            (f" (Vorschlag: {ref})" if ref else ""))


def render_section(issues: dict[str, dict]) -> str:
    human = [issues[k] for k in sorted(issues)
             if issues[k].get("state") in HUMAN_STATES]
    body = [SECTION_START, "", SECTION_HEADER, ""]
    body += [queue_line(i) for i in sorted(
        human, key=lambda i: str(i.get("last_seen") or ""))] or \
        ["(keine offenen Traum-Faelle)"]
    body += ["", SECTION_END]
    return "\n".join(body)


def write_review_queue(vault: Path, issues: dict[str, dict],
                       dry_run: bool = False) -> Path:
    """Regenerate ONLY the dream's own section of the shared queue."""
    path = Path(vault) / dcfg.REVIEW_QUEUE_FILE
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    text = blocks_mod.upsert_section(existing, SECTION_START, SECTION_END,
                                     render_section(issues))
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return path


def record(vault: Path, new_issues: list[dict], dry_run: bool = False,
           now: str | None = None, hunks: list[dict] | None = None,
           run_id: str | None = None) -> dict[str, dict]:
    """Merge, then write both destinations. Returns the merged set.

    `hunks` is the full changeset a caller happens to hold (review and apply
    both do) - when given, the full proposal text of every NEW human-facing
    issue is kept next to that run's judgments/applied file, so a later
    session can read it back through `queue_line`'s pointer. Optional and
    keyed by `run_id` (falling back to the first new issue's own `run_id`,
    which is what `review.issues_from`/`apply.issues_from` already set) so
    every existing caller that does not pass it keeps working unchanged."""
    merged = merge(load_issues(vault), new_issues, now=now)
    write_issues(vault, merged, dry_run=dry_run)
    write_review_queue(vault, merged, dry_run=dry_run)
    if hunks:
        rid = run_id or next((str(i.get("run_id")) for i in new_issues
                              if i.get("run_id")), None)
        if rid:
            write_escalation_details(vault, rid, hunks, new_issues,
                                     dry_run=dry_run)
    return merged
