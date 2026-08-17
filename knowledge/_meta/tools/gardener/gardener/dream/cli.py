"""Dream CLI (`brain dream` / `uv run dream`). `harvest` and `status` are
M1: no model call anywhere in those. `extract` is M2a - claude-sonnet-5 in
the cloud by default (`--backend cloud`), or grug-27b locally via MLX
(`--backend local`, what `dream run`/M8 uses since 2026-08-12); a batch the
local backend still cannot parse after its own retries is retried once on
the cloud before it is marked failed - see DREAM-PLAN.md Abschnitt 0 (D1)
and `gardener/dream/extract.py`. Runs by hand, like the gardener; no
launchd timer.

`reconcile` is M4: it groups the stored claims (locally, `embeddinggemma`),
lets grug-27b (local, via MLX, since 2026-08-12) judge only the groups whose
numbers or dates diverge - `value_signature` already catches those in code
first, which is why this is the one model step with its own deterministic
nachpruefer - and writes a `plan.json` saying where each claim belongs. It
never writes a note.

`shadow` and `apply` are M2b/M3 and call no model at all: `shadow` turns stored
claims into a changeset in the shadow tree, `apply` is the only dream command
that writes into the vault - and it re-checks every rule the reviewer was
supposed to apply (see gardener/dream/apply.py). Never pushes.

`review` is M5: it cuts the changeset into packages (per target file, twelve
hunks or 25,000 characters), sends each to claude-sonnet-5 with the full text
of `rubric.md`, and writes one verdict per hunk to `judgments.json` in the
versioned audit path. It writes no note either - `apply` overrules it wherever
the code and the model disagree. Stays cloud, unlike reconcile: the release
of a hunk has no code-level check of its own, so the model's judgement here
IS the check.

Usage:
    uv run dream harvest --dry-run --vault ~/Knowledge   # report only, zero writes
    uv run dream harvest --budget 30                     # real run, 30-minute budget
    uv run dream status                                  # counts per class/wave/status
    uv run dream extract --limit 40 --dry-run             # build batches, call nothing
    uv run dream extract --limit 40                       # real cloud calls, capped
    uv run dream reconcile --no-cloud --dry-run           # groups only, zero cost
    uv run dream reconcile --max-cloud 10                 # real judgements, capped
    uv run dream shadow --dry-run                         # changeset, no writes at all
    uv run dream shadow --plan <f>                        # changeset from a plan
    uv run dream review --changeset <f> --dry-run         # packages only, zero cost
    uv run dream review --changeset <f> --max-cloud 5     # real judgements, capped
    uv run dream projects --dry-run                       # value gate over ~/AI
    uv run dream apply --changeset <f> --verdicts <f>     # the only writing command

Every step that calls a model - `extract`, `reconcile`, `review` - books its
calls against ONE account for the run: `DREAM_BUDGET_WEEKLY_POINTS` points of
the weekly limit, `--budget-points` to override. A local call (grug, `extract
--backend local` and `reconcile`) books zero USD and so zero points; only
`review` and a local batch's cloud fallback in `extract` actually spend. The
run stops before the call that would break it and leaves a resumable state
behind.

Exit codes of `apply`: 0 clean, 4 the code overruled the reviewer somewhere
(a defect signal, see the report's first section), 5 a lock was held. `review`
uses 5 for a held lock as well; an unjudged package is not an error exit,
because it stays open and comes back in the next run. 6 means the budget or
the weekly guard stopped the run - nothing is lost, the next run continues.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import logging
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .. import blocks
from .. import config as gcfg
from ..ollama import OllamaClient
from ..runtime import Deadline, Lock, LockHeldError, git_commit
from . import apply as apply_mod
from . import budget as budget_mod
from . import config as dcfg
from . import corpus
from . import extract as extract_mod
from . import issues as issues_mod
from . import projects as projects_mod
from . import reconcile as reconcile_mod
from . import review as review_mod
from . import secrets_scan
from . import segment as segment_mod
from . import shadow as shadow_mod
from . import trace as trace_mod
from .claims import ClaimStore
from .ledger import Ledger

log = logging.getLogger("gardener.dream")


def _iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).isoformat(timespec="seconds")


def _bucket(reason: str) -> str:
    return reason.split(":", 1)[0]


@dataclass
class HarvestResult:
    aborted: bool = False
    sources_seen: dict = field(default_factory=lambda: defaultdict(int))
    new_units: int = 0
    counts: dict = field(default_factory=lambda: defaultdict(int))
    oversized_turns: list = field(default_factory=list)
    secret_paths: list = field(default_factory=list)   # source ids only, never values

    def record(self, source_class: str, wave: str, label: str) -> None:
        self.counts[(source_class, wave, label)] += 1


def read_source_text(source_class: str, path: Path) -> tuple[str, list[str]]:
    """Re-derive a source's full text the same way harvest segmented it -
    shared with extract.py, which needs to re-resolve a ledger unit's exact
    segment text without duplicating the transcript-flattening logic.

    The dream's own marker block is removed first: text this run wrote must
    never come back in as material (DREAM-PLAN.md Abschnitt 9). The pleasant
    side effect is that appending a block to a note leaves every OTHER segment
    of it byte-identical, so a dream write creates no new pending units.

    Stripping happens ONLY where the dream can have written: a vault note. A
    worker result, a transcript or a project doc is never a dream target, so a
    marker pair in one of them is quoted text, not a block - and cutting there
    would silently drop the middle of a document that merely writes about this
    build. `blocks.strip_blocks` additionally requires both markers to stand
    alone on their line, so even inside a vault note a quoted pair survives.
    """
    if source_class == corpus.SOURCE_TRANSCRIPT:
        return segment_mod.flatten_transcript(path)
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        log.warning("dream: unreadable %s: %s", path, e)
        return "", []
    if source_class != corpus.SOURCE_VAULT:
        return raw, []
    return blocks.strip_blocks(raw, dcfg.DREAM_BLOCK_START,
                               dcfg.DREAM_BLOCK_END), []


def run_harvest(args) -> HarvestResult:
    vault = Path(args.vault).expanduser().resolve()
    budget = getattr(args, "budget", None)
    budget_seconds = budget * 60 if budget is not None else dcfg.RUN_BUDGET_SECONDS
    deadline = Deadline(budget_seconds)
    dry_run = args.dry_run

    def _opt_path(name: str) -> Path | None:
        v = getattr(args, name, None)
        return Path(v).expanduser() if v else None

    ledger = Ledger(dcfg.LEDGER_DB, read_only=dry_run)
    near_dup = segment_mod.NearDupIndex()
    result = HarvestResult()
    try:
        sources = corpus.all_sources(
            vault,
            transcript_root=_opt_path("transcript_root"),
            worker_root=_opt_path("worker_root"),
            projects_root=_opt_path("projects_root"))
        for src in sources:
            if deadline.expired():
                result.aborted = True
                break
            result.sources_seen[src.source_class] += 1

            if secrets_scan.path_blocked(src.path.name):
                result.secret_paths.append(src.quell_id)
                log.warning("dream: secret-path gate skipped %s", src.quell_id)
                result.record(src.source_class, src.wave, "skipped-source:secret-path")
                continue

            text, oversized = read_source_text(src.source_class, src.path)
            for loc in oversized:
                result.oversized_turns.append(loc)
                log.warning("dream: oversized turn skipped %s", loc)

            for seg in segment_mod.segment_text(text):
                if ledger.known(src.quell_id, seg.index, seg.content_hash):
                    continue
                result.new_units += 1
                now = time.time()
                size = len(seg.text.encode("utf-8"))
                common = dict(
                    source_class=src.source_class, quell_id=src.quell_id,
                    path=str(src.path), segment_index=seg.index,
                    content_hash=seg.content_hash, size=size,
                    char_start=seg.char_start, char_end=seg.char_end,
                    wave=src.wave)

                if secrets_scan.content_hit(seg.text):
                    result.secret_paths.append(f"{src.quell_id}#{seg.index}")
                    log.warning("dream: secret-content gate skipped %s#%d",
                               src.quell_id, seg.index)
                    if not dry_run:
                        ledger.add_skipped(reason="secret-content", now=now, **common)
                        trace_mod.append(dcfg.TRACE_FILE, source_path=str(src.path),
                            content_hash=seg.content_hash, segment_index=seg.index,
                            char_start=seg.char_start, char_end=seg.char_end,
                            seen_at=_iso(now))
                    result.record(src.source_class, src.wave, "skipped:secret-content")
                    continue

                reason = segment_mod.classify_noise(seg.text)
                if reason is None and near_dup.is_duplicate(seg.content_hash, seg.text):
                    reason = "near-duplicate"

                if reason:
                    if not dry_run:
                        ledger.add_skipped(reason=reason, now=now, **common)
                        trace_mod.append(dcfg.TRACE_FILE, source_path=str(src.path),
                            content_hash=seg.content_hash, segment_index=seg.index,
                            char_start=seg.char_start, char_end=seg.char_end,
                            seen_at=_iso(now))
                    result.record(src.source_class, src.wave, f"skipped:{_bucket(reason)}")
                else:
                    near_dup.add(seg.content_hash, seg.text)
                    if not dry_run:
                        ledger.add_pending(now=now, **common)
                        trace_mod.append(dcfg.TRACE_FILE, source_path=str(src.path),
                            content_hash=seg.content_hash, segment_index=seg.index,
                            char_start=seg.char_start, char_end=seg.char_end,
                            seen_at=_iso(now))
                    result.record(src.source_class, src.wave, "pending")
    finally:
        ledger.close()
    return result


def format_harvest_report(result: HarvestResult, dry_run: bool) -> str:
    lines = [f"dream harvest{' (dry-run)' if dry_run else ''}", "", "Quellen gesehen:"]
    lines += [f"  {cls}: {n}" for cls, n in sorted(result.sources_seen.items())] or ["  keine"]
    lines += ["", f"Neue Einheiten (Segmente) in diesem Lauf: {result.new_units}", "",
             "Je Quellklasse / Welle / Status:"]
    lines += [f"  {cls:16s} welle={wave:12s} {label:28s} {n}"
             for (cls, wave, label), n in sorted(result.counts.items())] or ["  keine"]
    if result.secret_paths:
        lines += ["", f"Geheimnis-Tor ausgeloest ({len(result.secret_paths)}), "
                     "nur Pfade/Segmentindizes, nie Werte:"]
        lines += [f"  - {p}" for p in result.secret_paths]
    if result.oversized_turns:
        lines += ["", f"Zuege ueber {dcfg.SEGMENT_MAX_UNIT_BYTES} Bytes uebersprungen: "
                     f"{len(result.oversized_turns)}"]
    if result.aborted:
        lines += ["", "ABGEBROCHEN: Budget erreicht, nicht alle Quellen gesehen."]
    return "\n".join(lines)


def run_status(args) -> str:
    ledger = Ledger(dcfg.LEDGER_DB, read_only=True)
    try:
        rows = ledger.counts()
    finally:
        ledger.close()
    if not rows:
        return "dream status: keine Einheiten im Buch (noch kein harvest gelaufen)."
    lines = ["dream status", ""]
    lines += [f"  {source_class:16s} welle={wave:12s} {status:12s} {count}"
             for source_class, wave, status, count in rows]
    return "\n".join(lines)


@contextlib.contextmanager
def held(*paths, enabled: bool = True):
    """Die genannten Sperren nehmen und am Ende wieder freigeben.

    `enabled=False` heisst: eine Ebene darueber haelt sie schon. Die Sperre ist
    eine PID-Datei, und derselbe Prozess kann sie nicht zweimal nehmen - ein
    Schritt, der innerhalb von `run_chain` noch einmal sperrte, liefe gegen die
    eigene Sperre und meldete `LockHeldError`.
    """
    taken = []
    try:
        if enabled:
            for path in paths:
                lock = Lock(path)
                lock.acquire()
                taken.append(lock)
        yield
    finally:
        for lock in reversed(taken):
            lock.release()


def make_budget(args) -> budget_mod.Budget:
    """Das Konto dieses Laufs. Es gilt fuer den ganzen Lauf und nicht je
    Schritt: `extract`, `reconcile` und `review` zahlen darauf ein. Ein
    Trockenlauf bekommt ebenfalls eines - er verbraucht nichts, und der
    Bericht zeigt dann eine Null statt einer Leerstelle.

    `--wochenmarke` hebt die Marke NUR fuer diesen einen Lauf an. Die Vorgabe
    von 85 Prozent steht dafuer, dass der Rest der Woche dem Menschen gehoert
    - eine Woche, in der er sie ausdruecklich freigibt, aendert daran nichts
    fuer die naechste. Deshalb ein Schalter am Aufruf und keine neue Zahl in
    der Konfiguration."""
    return budget_mod.Budget(getattr(args, "budget_points", None),
                             weekly_ceiling=getattr(args, "wochenmarke", None))


def finish_budget(budget: budget_mod.Budget, run_id: str, dry_run: bool) -> int:
    """Kontostand sichern, Bericht anhaengen, Rueckgabewert bestimmen. 6 heisst
    'angehalten, nichts verloren' - daran erkennt ein Skript den Fall."""
    budget.save(run_id=run_id, dry_run=dry_run)
    print("\n".join(budget.report_lines()))
    return 6 if budget.account.stopped else 0


def new_run_id(now: dt.datetime | None = None) -> str:
    return (now or dt.datetime.now()).strftime("%Y%m%d-%H%M%S")


def reconcile_local_call():
    """The judge M4 hands to `build_plan`, as a named function so a test can
    reach it - the same reason it was a named function when it still called
    the cloud (renamed from `reconcile_cloud_call` 2026-08-12). Inline in
    `run_reconcile` until 2026-08-08 - and a mutation probe that removed the
    `system=` argument stayed green, because nothing exercised the wiring. A
    closure nobody can call is a closure nobody checks.

    LOCAL since 2026-08-12 (Zuschnitt des Nutzers): `reconcile` has its own
    deterministic nachpruefer in code (`value_signature`) that catches a lost
    number, date, path or model name before a model is ever asked - see the
    comment on `RECONCILE_MODEL` in config.py. grug-27b via `call_grug`, not
    `call_claude_cli`; `grug-server ensure`/`stop` happens in `run_reconcile`
    around this call, not here, since a lazy per-call `ensure` (cheap once
    the server is already up) means a slice with zero divergent pairs never
    loads the model at all."""
    def call(prompt: str) -> dict:
        extract_mod.ensure_grug_server()
        return extract_mod.call_grug(
            prompt, system=dcfg.RECONCILE_SYSTEM_PROMPT,
            timeout=dcfg.RECONCILE_JUDGE_TIMEOUT_SECONDS,
            max_tokens=dcfg.RECONCILE_LOCAL_MAX_TOKENS)
    return call


def run_reconcile(args, budget=None, lock: bool = True) -> reconcile_mod.Plan:
    """M4: group the stored claims, decide merges and supersessions, and give
    each claim a target. Reads the vault and the claim store, calls the local
    judge only for groups whose values diverge, and writes nothing but its
    own cache plus `plan.json` in the versioned audit path. Takes the dream's
    own lock only - it never touches a note (DREAM-PLAN.md Abschnitt 4).

    `grug-server stop` runs in `finally`, unconditionally whenever `--no-cloud`
    is not set: `ensure` inside `reconcile_local_call` is called lazily per
    pair, so this is the one place that knows the run is over, whether or not
    a pair ever actually needed the model. Stopping an idle server is a
    documented no-op (Prozess-Hygiene: was gestartet wird, wird auch
    beendet)."""
    vault = Path(args.vault).expanduser().resolve()
    with held(dcfg.DREAM_LOCK, enabled=lock):
        claim_store = ClaimStore(dcfg.DREAM_EXTRACT_CLAIMS_DB, read_only=True)
        try:
            rows = claim_store.list_claims()
        finally:
            claim_store.close()
        if args.limit:
            rows = rows[:args.limit]
        store = reconcile_mod.ReconcileStore(dcfg.RECONCILE_DB,
                                             read_only=args.dry_run)
        try:
            vectors = reconcile_mod.embed_claims(
                rows, OllamaClient(), store,
                preflight=extract_mod.run_check_resources)
            call = None if args.no_cloud else reconcile_local_call()
            plan = reconcile_mod.build_plan(
                vault, rows, run_id=new_run_id(), vectors=vectors, store=store,
                call=call, max_cloud_calls=args.max_cloud, budget=budget)
        finally:
            store.close()
            if not args.no_cloud:
                extract_mod.stop_grug_server()
        if not args.dry_run:
            path = reconcile_mod.write_plan(plan, vault)
            log.info("dream: plan at %s", path)
        return plan


def run_shadow(args, lock: bool = True) -> shadow_mod.Changeset:
    """Build the changeset in the shadow tree. Reads the vault, writes only
    under the state dir plus the versioned audit path - never a note. Takes
    only the dream's own lock: a reading step may run next to a gardener run
    (DREAM-PLAN.md Abschnitt 4)."""
    vault = Path(args.vault).expanduser().resolve()
    with held(dcfg.DREAM_LOCK, enabled=lock):
        store = ClaimStore(dcfg.DREAM_EXTRACT_CLAIMS_DB, read_only=True)
        try:
            rows = store.list_claims()
        finally:
            store.close()
        if args.limit:
            rows = rows[:args.limit]
        plan_path = getattr(args, "plan", None)
        plan = (reconcile_mod.load_plan(Path(plan_path).expanduser())
                if plan_path else None)
        changeset = shadow_mod.build_changeset(
            vault, rows, run_id=new_run_id(),
            known_issue_ids=issues_mod.known_hunk_ids(vault), plan=plan)
        if not args.dry_run:
            shadow_mod.write_shadow(changeset, vault)
            path = shadow_mod.write_changeset(changeset, vault)
            log.info("dream: changeset at %s", path)
        return changeset


def review_cloud_call():
    """The reviewer M5 hands to `run_review`, as a named function for the same
    reason `reconcile_local_call` is one: a closure nobody can call is a
    closure nobody checks. claude-sonnet-5 (since 2026-08-12, was Opus), its
    own system prompt, and the stripped cheap flags that live in
    `call_claude_cli` - never `--resume` (measured 06./07.08.2026: 0.1514 USD
    per unit warm against 0.0648 USD stateless)."""
    def call(prompt: str) -> dict:
        return extract_mod.call_claude_cli(
            prompt, model=dcfg.REVIEW_MODEL,
            timeout=dcfg.REVIEW_TIMEOUT_SECONDS,
            system=dcfg.REVIEW_SYSTEM_PROMPT)
    return call


def run_review(args, budget=None, lock: bool = True) -> review_mod.ReviewResult:
    """M5: judge the hunks of a changeset. Reads the vault and the changeset,
    writes `judgments.json` plus the issues - never a note. Takes the dream's
    own lock only, like every other reading step."""
    vault = Path(args.vault).expanduser().resolve()
    with held(dcfg.DREAM_LOCK, enabled=lock):
        return review_mod.run_review(
            vault, Path(args.changeset).expanduser(), review_cloud_call(),
            dry_run=args.dry_run, limit=args.limit, max_cloud=args.max_cloud,
            rubric_path=Path(args.rubric).expanduser() if args.rubric else None,
            budget=budget, time_budget=getattr(args, "time_budget", None),
            # In der Kette committet `run_chain` selbst, ueber
            # `review_mod.own_paths` - zwei Commits je Lauf waeren Rauschen.
            commit=lock)


def run_apply(args, lock: bool = True,
              write_own_report: bool = True) -> apply_mod.ApplyResult:
    """The only dream command that writes to the vault. Takes the gardener's
    lock as well as its own, so the dream and a gardener run can never stand at
    the same note at the same time (DREAM-PLAN.md Abschnitt 4)."""
    vault = Path(args.vault).expanduser().resolve()
    with held(dcfg.DREAM_LOCK, enabled=lock):
        # Die Gaertner-Sperre wird IMMER hier genommen, auch in der Kette: sie
        # gehoert um den einen Schritt, der Notizen schreibt, und nicht um eine
        # Stunde Lesen und Urteilen.
        with held(gcfg.STATE_DIR / "gardener.lock"):
            return apply_mod.run_apply(
                vault, Path(args.changeset).expanduser(),
                Path(args.verdicts).expanduser(), dry_run=args.dry_run,
                write_own_report=write_own_report)



# ---------------------------------------------------------------------------
# M8: die Kette
# ---------------------------------------------------------------------------

CHAIN_STEPS = ("harvest", "extract", "reconcile", "shadow", "review", "apply")


class _StepArgs:
    """Die Argumente eines Schrittes, aus denen der Kette ihre eigenen."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


def run_chain(args, call=None) -> dict:
    """`brain dream run`: harvest, extract, reconcile, shadow, review, apply,
    Bericht, Commit. der Nutzer startet, mehr nicht.

    **Ein Konto fuer die ganze Kette.** Das Budget wird EINMAL gebaut und durch
    alle Schritte gereicht. Endet ein Lauf an der Bremse, hinterlaesst er
    offene Einheiten im Buch, unbeurteilte Hunks ohne Issue-Eintrag und einen
    Bericht - derselbe Befehl macht danach weiter, er faengt nicht von vorn an.

    **Die Sperre wird einmal genommen, nicht sechsmal.** Die Traum-Sperre haelt
    ueber die ganze Kette; wuerde jeder Schritt fuer sich sperren und wieder
    freigeben, koennte sich zwischen `shadow` und `apply` ein Gaertnerlauf
    schieben und die Datei aendern, gegen die der Changeset gebaut wurde. Die
    Folge fuer einen parallel laufenden Gaertner ist bewusst gewaehlt: seine
    eigene Sperre nimmt die Kette NUR um `apply`, den einen Schritt, der
    Notizen schreibt. Ein Gaertnerlauf kann also neben dem Lesen, Extrahieren
    und Urteilen laufen und wird nur fuer die Minuten der Uebernahme
    ausgesperrt. Haelt er seine Sperre genau dann, endet die Kette vor `apply`
    mit Changeset und Urteilen auf der Platte - ein spaeterer `dream apply`
    oder ein zweiter `dream run` nimmt sie auf.

    **Committet wird der Vault, gepusht nie.** Das ist die Entscheidung des
    Orchestrators und keine, die ein autonomer Lauf trifft.
    """
    vault = Path(args.vault).expanduser().resolve()
    run_id = new_run_id()
    budget = make_budget(args)
    steps: dict = {}
    stopped = None

    with held(dcfg.DREAM_LOCK):
        harvest = run_harvest(_StepArgs(
            vault=str(vault), dry_run=args.dry_run, budget=None,
            transcript_root=getattr(args, "transcript_root", None),
            worker_root=getattr(args, "worker_root", None),
            projects_root=getattr(args, "projects_root", None)))
        steps["harvest"] = {"neue Einheiten": harvest.new_units,
                            "Geheimnis-Tor": len(harvest.secret_paths)}

        extract = extract_mod.run_extract(_StepArgs(
            limit=args.limit, backend="local", dry_run=args.dry_run,
            budget=None), call=call, budget=budget)
        steps["extract"] = {"Einheiten": extract.units_selected,
                            "Aussagen neu": extract.claims_written,
                            "Buendel": extract.batches}
        stopped = stopped or extract.budget_stopped

        plan = None
        if not stopped:
            plan = run_reconcile(_StepArgs(
                vault=str(vault), limit=None, dry_run=args.dry_run,
                no_cloud=args.no_cloud,
                # Der Abgleich hat seinen EIGENEN Deckel. Bis zum 16.08.2026
                # bekam er `--max-cloud` der Kette, also 60 - einen Wert, der
                # fuer die Wolke gedacht ist, waehrend der Richter des
                # Abgleichs seit dem 12.08. lokal laeuft und nichts kostet.
                # Das war kein Halt, sondern eine stille Kuerzung: alle
                # weiteren Gruppen blieben unentschieden (gefunden vom
                # Prueferlauf `pruefer-kette`, cli.py:691 gegen
                # config.reconcile_hard_cap() = 4000).
                max_cloud=dcfg.reconcile_hard_cap(),
                budget_points=None), budget=budget, lock=False)
            steps["reconcile"] = {"Gruppen": len(plan.groups),
                                  "Ziele": len(plan.targets)}
            stopped = stopped or plan.stats.get("budget_stopped")

        changeset = None
        if not stopped:
            plan_path = shadow_mod.audit_dir(vault, plan.run_id) / dcfg.PLAN_FILE
            changeset = run_shadow(_StepArgs(
                vault=str(vault), limit=None, dry_run=args.dry_run,
                plan=str(plan_path) if plan_path.exists() else None), lock=False)
            steps["shadow"] = {"Hunks": len(changeset.hunks)}

        review = None
        if changeset is not None and changeset.hunks and not args.dry_run:
            changeset_path = shadow_mod.audit_dir(
                vault, changeset.run_id) / "changeset.json"
            review = run_review(_StepArgs(
                vault=str(vault), changeset=str(changeset_path), limit=None,
                # Und das Urteil seinen. `--max-cloud` der Kette lag bei 60,
                # die Vorgabe des `review`-Unterbefehls bei 2500; nach 60
                # Wolkenaufrufen blieb jedes weitere Paket auf `skipped-cap`
                # liegen. Der Deckel zaehlt ausserdem VERSUCHE, nicht Pakete -
                # bei 60 waeren das im unguenstigen Fall 30 beurteilte Pakete
                # gewesen.
                max_cloud=(args.max_cloud if args.max_cloud is not None
                           else dcfg.REVIEW_HARD_CLOUD_CAP),
                rubric=None, dry_run=False,
                budget_points=None), budget=budget, lock=False)
            steps["review"] = dict(review.verdict_counts)
            stopped = stopped or review.budget_stopped

        applied = None
        if review is not None and review.judgments:
            try:
                applied = run_apply(_StepArgs(
                    vault=str(vault), dry_run=args.dry_run,
                    changeset=str(shadow_mod.audit_dir(
                        vault, changeset.run_id) / "changeset.json"),
                    verdicts=str(shadow_mod.audit_dir(
                        vault, review.run_id) / dcfg.JUDGMENTS_FILE)),
                    lock=False, write_own_report=False)
                steps["apply"] = {"angewandt": len(applied.applied),
                                  "Widersprueche": len(applied.conflicts)}
            except LockHeldError as e:
                stopped = f"Gaertner haelt seine Sperre: {e}"
                log.warning("dream run: %s - Changeset und Urteile liegen "
                            "bereit, ein spaeterer Lauf uebernimmt sie", e)

        report = chain_report(run_id, steps, budget, stopped,
                              projects_mod.scan(
                                  Path(args.projects_root).expanduser()
                                  if getattr(args, "projects_root", None)
                                  else None))
        report_path = apply_mod.write_report_text(vault, run_id, report,
                                                  dry_run=args.dry_run)
        if not args.dry_run:
            # Der Kettenlauf committet den Bericht ueber die ganze Kette und,
            # falls die Uebernahme lief, deren Pfade gleich mit. Doppelt
            # eingestellte Pfade sind harmlos - `apply` hat sie bereits
            # committet, `--only` findet dort nichts mehr zu tun. Was NICHT
            # dabeisteht, ist alles Uebrige im Baum: ein Kettenlauf nimmt
            # fremde Arbeit nicht mit (siehe `runtime.git_commit`).
            paths = [str(report_path.relative_to(vault))]
            # Die Pfade des URTEILS gehoeren immer dazu, nicht nur wenn die
            # Uebernahme lief: `review` schreibt Urteile und Vorfallsliste
            # selbst, und faellt `apply` aus - Notbremse ohne ein einziges
            # Urteil, oder der Gaertner haelt seine Sperre -, blieben beide
            # uncommittet liegen. Gerade dann erklaert die Vorfallsliste, was
            # passiert ist.
            if review is not None:
                paths += review_mod.own_paths(vault, review)
            if applied is not None:
                paths += apply_mod.own_paths(vault, applied, applied.run_id)
            git_commit(vault, f"dream: run {run_id}", paths, dry_run=False)
    budget.save(run_id=run_id, dry_run=args.dry_run)
    return {"run_id": run_id, "steps": steps, "stopped": stopped,
            "report": report, "budget": budget.account.to_dict()}


def chain_report(run_id: str, steps: dict, budget, stopped, projects) -> str:
    """Der menschenlesbare Bericht der ganzen Kette, in beiden Einheiten."""
    lines = [f"dream run (Lauf {run_id})", ""]
    for name in CHAIN_STEPS:
        werte = steps.get(name)
        if werte is None:
            lines.append(f"  {name:10s} nicht gelaufen")
            continue
        lines.append(f"  {name:10s} " + ", ".join(
            f"{k}: {v}" for k, v in werte.items()))
    lines += ["", "Projektaufnahme (M6, nur beurteilt, nicht geschrieben):",
              f"  Projekte {len(projects.projects)}, Dateien "
              f"{projects.files_seen}, Kopien {len(projects.copies)}, "
              f"Sidecars {len(projects.sidecars)}"]
    lines += budget.report_lines()
    if stopped:
        lines += ["", f"ANGEHALTEN: {stopped}",
                  "Offene Einheiten stehen weiter im Buch, Unbeurteiltes hat "
                  "keinen Issue-Eintrag bekommen, und derselbe Befehl macht "
                  "beim naechsten Mal dort weiter."]
    lines += ["", "Der Traum loescht nie, aendert nie einen handgeschriebenen "
                  "Satz und pusht nie."]
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="dream", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    harvest_p = sub.add_parser(
        "harvest", help="enumerate, segment, pre-filter; fill ledger + trace")
    harvest_p.add_argument("--vault", default=str(gcfg.DEFAULT_VAULT))
    harvest_p.add_argument("--dry-run", action="store_true",
                           help="report only: no ledger, no trace, no state dir")
    harvest_p.add_argument("--budget", type=float, default=None,
                           help="minutes; stop cleanly when exceeded")
    harvest_p.add_argument("--transcript-root", default=None,
                           help="override ~/.claude/projects (tests)")
    harvest_p.add_argument("--worker-root", default=None,
                           help="override ~/.pi-workers/results (tests)")
    harvest_p.add_argument("--projects-root", default=None,
                           help="override ~/AI (tests)")
    harvest_p.add_argument("--verbose", action="store_true")

    status_p = sub.add_parser("status", help="counts per source class / wave / status")
    status_p.add_argument("--verbose", action="store_true")

    extract_p = sub.add_parser(
        "extract", help="extraction (cloud claude-sonnet-5 or local grug-27b "
                        "via MLX) over open ledger units")
    extract_p.add_argument("--limit", type=int, required=True,
                           help="how many open units to extract, mandatory - "
                                "there is no default that would run the whole book")
    extract_p.add_argument("--backend", choices=("cloud", "local"), default="cloud",
                           help="cloud=claude-sonnet-5 (60-segment hard cap, "
                                "also the cloud fallback for a batch the local "
                                "backend quarantines), local=grug-27b via MLX "
                                "(`grug-server`, no cap but memory)")
    extract_p.add_argument("--dry-run", action="store_true",
                           help="build batches and show them; call nothing")
    extract_p.add_argument("--budget", type=float, default=None,
                           help="minutes; stop cleanly when exceeded")
    extract_p.add_argument("--budget-points", type=float, default=None,
                          help="Punkte Wochenlimit fuer diesen Lauf "
                               f"(Vorgabe {dcfg.DREAM_BUDGET_WEEKLY_POINTS}). Der Lauf haelt an, bevor der naechste Aufruf sie reisst, und bleibt "
                               "fortsetzbar.")
    extract_p.add_argument("--verbose", action="store_true")

    reconcile_p = sub.add_parser(
        "reconcile", help="group the stored claims, decide merges and "
                          "supersessions, give each claim a target")
    reconcile_p.add_argument("--vault", default=str(gcfg.DEFAULT_VAULT))
    reconcile_p.add_argument("--limit", type=int, default=None,
                             help="use at most this many stored claims")
    reconcile_p.add_argument("--dry-run", action="store_true",
                             help="report only: no cache writes, no plan.json")
    reconcile_p.add_argument("--no-cloud", action="store_true",
                             help="skip every judgement (grug-27b, local since "
                                  "2026-08-12, kept the flag's old name); "
                                  "groups whose values diverge stay undecided")
    reconcile_p.add_argument("--max-cloud", type=int, default=None,
                             help="ceiling on real judge calls this run "
                                  "(default: the cap that fits the judge - "
                                  f"{dcfg.RECONCILE_HARD_CLOUD_CAP} for a cloud "
                                  f"model, {dcfg.RECONCILE_LOCAL_CAP} for a "
                                  "local one, see config.reconcile_hard_cap)")
    reconcile_p.add_argument("--budget-points", type=float, default=None,
                          help="Punkte Wochenlimit fuer diesen Lauf "
                               f"(Vorgabe {dcfg.DREAM_BUDGET_WEEKLY_POINTS}). Der Lauf haelt an, bevor der naechste Aufruf sie reisst, und bleibt "
                               "fortsetzbar.")
    reconcile_p.add_argument("--verbose", action="store_true")

    shadow_p = sub.add_parser(
        "shadow", help="build the changeset (hunks) in the shadow tree - "
                       "no model, no vault write")
    shadow_p.add_argument("--vault", default=str(gcfg.DEFAULT_VAULT))
    shadow_p.add_argument("--limit", type=int, default=None,
                          help="use at most this many stored claims")
    shadow_p.add_argument("--plan", default=None,
                          help="plan.json from `dream reconcile`; without it "
                               "the provisional M3 routing is used")
    shadow_p.add_argument("--dry-run", action="store_true",
                          help="report only: no shadow tree, no changeset file")
    shadow_p.add_argument("--verbose", action="store_true")

    run_p = sub.add_parser(
        "run", help="M8: harvest, extract, reconcile, shadow, review, apply, "
                    "report and commit - one account, one lock, never a push")
    run_p.add_argument("--vault", default=str(gcfg.DEFAULT_VAULT))
    run_p.add_argument("--limit", type=int, default=dcfg.RUN_EXTRACT_LIMIT,
                       help="units the extraction step may take this run")
    run_p.add_argument("--max-cloud", type=int, default=None,
                       help="Deckel fuer WOLKEN-Aufrufe des Urteils. Ohne "
                            "Angabe gilt REVIEW_HARD_CLOUD_CAP; der Abgleich "
                            "hat seinen eigenen Deckel und wird davon nie "
                            "beruehrt.")
    run_p.add_argument("--no-cloud", action="store_true",
                       help="skip every relation judgement in reconcile")
    run_p.add_argument("--budget-points", type=float, default=None,
                       help="Punkte Wochenlimit fuer die ganze Kette "
                            f"(Vorgabe {dcfg.DREAM_BUDGET_WEEKLY_POINTS})")
    run_p.add_argument("--dry-run", action="store_true",
                       help="walk the chain, write nothing, call nothing")
    run_p.add_argument("--transcript-root", default=None)
    run_p.add_argument("--worker-root", default=None)
    run_p.add_argument("--projects-root", default=None)
    run_p.add_argument("--verbose", action="store_true")

    projects_p = sub.add_parser(
        "projects", help="M6: judge every allowed file under ~/AI against the "
                         "value gate - reads, writes nothing yet")
    projects_p.add_argument("--projects-root", default=None,
                            help="override ~/AI (tests)")
    projects_p.add_argument("--dry-run", action="store_true", default=True,
                            help="the only mode today: report what would be "
                                 "created, write nothing")
    projects_p.add_argument("--verbose", action="store_true")

    review_p = sub.add_parser(
        "review", help="judge the hunks of a changeset (cloud claude-sonnet-5), "
                       "one verdict per hunk - writes no note")
    review_p.add_argument("--vault", default=str(gcfg.DEFAULT_VAULT))
    review_p.add_argument("--changeset", required=True,
                          help="path to a changeset.json from `dream shadow`")
    review_p.add_argument("--limit", type=int, default=None,
                          help="judge at most this many hunks")
    review_p.add_argument("--max-cloud", type=int,
                          default=dcfg.REVIEW_HARD_CLOUD_CAP,
                          help="ceiling on real cloud calls this run "
                               f"(default {dcfg.REVIEW_HARD_CLOUD_CAP})")
    review_p.add_argument("--rubric", default=None,
                          help="use a different rule file than "
                               f"{dcfg.RUBRIC_FILE}; it must carry all eight "
                               "rules and the four verdicts or the run refuses "
                               "to start")
    review_p.add_argument("--dry-run", action="store_true",
                          help="build packages and show them; call nothing, "
                               "write nothing")
    review_p.add_argument("--budget-points", type=float, default=None,
                          help="Punkte Wochenlimit fuer diesen Lauf "
                               f"(Vorgabe {dcfg.DREAM_BUDGET_WEEKLY_POINTS}). Der Lauf haelt an, bevor der naechste Aufruf sie reisst, und bleibt "
                               "fortsetzbar.")
    review_p.add_argument("--wochenmarke", type=float, default=None,
                          help="Prozentmarke des Wochenlimits, ab der dieser "
                               f"Lauf pausiert (Vorgabe "
                               f"{dcfg.DREAM_WEEKLY_PCT_CEILING}); 100 laesst "
                               "ihn bis ans Wochenlimit laufen. Gilt NUR fuer "
                               "diesen Aufruf.")
    review_p.add_argument("--time-budget", type=float, default=None,
                          help="Sekunden Urteilszeit fuer diesen Lauf "
                               f"(Vorgabe {dcfg.REVIEW_TIME_BUDGET_SECONDS}); "
                               "0 schaltet die Frist ab. Seit jedes bezahlte "
                               "Urteil sofort im Journal steht, kostet ein "
                               "Abbruch nichts mehr - fuer den Volllauf am "
                               "Stueck ist 0 richtig.")
    review_p.add_argument("--verbose", action="store_true")

    apply_p = sub.add_parser(
        "apply", help="apply approved hunks - re-checks every rule in code")
    apply_p.add_argument("--vault", default=str(gcfg.DEFAULT_VAULT))
    apply_p.add_argument("--changeset", required=True,
                         help="path to a changeset.json from `dream shadow`")
    apply_p.add_argument("--verdicts", required=True,
                         help="path to verdicts.json (M5 reviewer; until then "
                              "a fixed rule)")
    apply_p.add_argument("--dry-run", action="store_true",
                         help="run every gate, write nothing")
    apply_p.add_argument("--verbose", action="store_true")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s")
    if args.command == "harvest":
        result = run_harvest(args)
        print(format_harvest_report(result, args.dry_run))
        return 3 if result.aborted else 0
    if args.command == "status":
        print(run_status(args))
        return 0
    if args.command == "extract":
        budget = make_budget(args)
        result = extract_mod.run_extract(args, budget=budget)
        print(extract_mod.format_extract_report(result, args.dry_run))
        code = finish_budget(budget, "extract", args.dry_run)
        return code or (3 if result.aborted else 0)
    if args.command == "reconcile":
        budget = make_budget(args)
        plan = run_reconcile(args, budget=budget)
        print(reconcile_mod.format_reconcile_report(plan, args.dry_run))
        return finish_budget(budget, plan.run_id, args.dry_run)
    if args.command == "shadow":
        changeset = run_shadow(args)
        print(shadow_mod.format_shadow_report(changeset))
        return 0
    if args.command == "run":
        try:
            result = run_chain(args)
        except LockHeldError as e:
            log.error("%s", e)
            return 5
        print(result["report"])
        return 6 if result["stopped"] else 0
    if args.command == "projects":
        root = Path(args.projects_root).expanduser() if args.projects_root \
            else None
        result = projects_mod.scan(root)
        print(projects_mod.format_scan_report(result, dry_run=True))
        return 0
    if args.command == "review":
        budget = make_budget(args)
        try:
            result = run_review(args, budget=budget)
        except LockHeldError as e:
            log.error("%s", e)
            return 5
        print(review_mod.format_review_report(result))
        return finish_budget(budget, result.run_id, args.dry_run)
    if args.command == "apply":
        try:
            result = run_apply(args)
        except LockHeldError as e:
            log.error("%s", e)
            return 5
        print(apply_mod.format_apply_report(result))
        # A model/code disagreement is a defect signal: it must be visible in
        # the exit status too, not only in the text a caller may not read.
        return 4 if result.conflicts else 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
