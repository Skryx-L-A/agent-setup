"""Runtime plumbing: lock file (self-healing), deadline, git snapshots, logging."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
import json
import logging
import os
import signal
import subprocess
import time
from pathlib import Path

from . import config

log = logging.getLogger("gardener")

LAST_RUN_FILE = "last-run.json"


def install_termination_handler() -> None:
    """Make SIGTERM behave exactly like SIGINT (Ctrl-C): raise
    `KeyboardInterrupt` in the main thread instead of killing the process on
    the spot.

    Auftrag "p0-schutztore" (pipeline-analyse Abschnitt 0 Punkt 6): before
    this, nothing in the tree ever called `signal.signal` - SIGINT already
    worked by Python's own default (it raises `KeyboardInterrupt`, which
    `gardener/cli.py`'s `main()` already caught), but SIGTERM did not raise
    anything at all. A hard kill skips every `finally` and every `with`
    block on the way down - the lock is never released, a mid-write is never
    reported as a conflict on the next run, nothing gets the chance to leave
    a resumable state. `signal.default_int_handler` is the exact function
    Python installs for SIGINT itself, so this does not reimplement the
    "clean stop" path, it only routes a second signal into the one that
    already existed.

    Call once, from the main thread, at the top of a CLI entry point (`grug-
    server`/model calls and the reviewer's worker threads never call this
    themselves - a signal handler can only be installed on the main thread,
    and every long run in this tree is driven from there)."""
    signal.signal(signal.SIGTERM, signal.default_int_handler)


class LockHeldError(Exception):
    pass


class Deadline:
    def __init__(self, budget_seconds: float = config.RUN_BUDGET_SECONDS):
        self.end = time.monotonic() + budget_seconds
        # Jeder Treffer, den ein Aufrufer per `phase` gemeldet hat - der Stoff,
        # aus dem build_report() den "ANGEHALTEN"-Abschnitt baut. Ohne `phase`
        # (Altaufrufer, oder ein Check, der nur wissen will ob Zeit uebrig ist)
        # bleibt der Aufruf folgenlos fuer diese Liste.
        self.stops: list[dict] = []

    def share(self, fraction: float) -> "Deadline":
        """A sub-budget: at most `fraction` of the time still left, never past
        this deadline. Stops land in the same list, so the report sees them.
        Run of 24.09.2026: linking alone used the whole 45-minute budget and
        every later phase ran on an exhausted one."""
        sub = Deadline.__new__(Deadline)
        now = time.monotonic()
        sub.end = min(self.end, now + max(0.0, self.end - now) * fraction)
        sub.stops = self.stops
        return sub

    def expired(self, phase: str | None = None, done: int | None = None,
               total: int | None = None) -> bool:
        hit = time.monotonic() >= self.end
        if hit and phase is not None:
            self.stops.append({"phase": phase, "done": done, "total": total})
        return hit


class Lock:
    """PID+timestamp lock file. A lock whose holder PID is dead, or whose age
    exceeds the stale threshold when the PID is unreadable, is taken over.
    A live holder keeps the lock regardless of age (runs may exceed 15 min)."""

    def __init__(self, path: Path, stale_seconds: float = config.LOCK_STALE_SECONDS):
        self.path = Path(path)
        self.stale_seconds = stale_seconds

    def _stale(self) -> bool:
        try:
            pid = int(self.path.read_text().split()[0])
        except (OSError, ValueError, IndexError):
            pid = None
        if pid is not None:
            try:
                os.kill(pid, 0)
                return False            # holder alive
            except ProcessLookupError:
                return True             # holder dead
            except PermissionError:
                return False            # alive, other user
        age = time.time() - self.path.stat().st_mtime
        return age >= self.stale_seconds

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in (1, 2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if attempt == 2 or not self._stale():
                    raise LockHeldError(
                        f"lock held ({self.path}) - another run active")
                log.warning("taking over stale lock %s", self.path)
                try:
                    self.path.unlink()
                except FileNotFoundError:
                    pass
                continue
            with os.fdopen(fd, "w") as f:
                f.write(f"{os.getpid()} {dt.datetime.now().isoformat()}\n")
            return

    def release(self) -> None:
        try:
            if self.path.read_text().split()[0] == str(os.getpid()):
                self.path.unlink()
        except (OSError, IndexError):
            pass


@dataclass
class CommitResult:
    """Was ein Commit-Versuch getan hat - und was er bewusst liegen liess."""
    committed: bool = False
    paths: list = field(default_factory=list)      # eingestellt, vault-relativ
    foreign: list = field(default_factory=list)    # fremd, unangetastet
    message: str = ""
    ignored: list = field(default_factory=list)    # von git ignoriert, nie eingestellt
    error: str = ""                                # sichtbarer Fehler, leer = keiner
    repo: str = ""

    def __bool__(self) -> bool:
        return self.committed


def _porcelain(vault: Path) -> list[tuple[str, str]]:
    """(Status, Pfad) je Eintrag aus `git status --porcelain`."""
    # core.quotePath=false: sonst kommen Namen mit Umlaut als Oktal-Escapes und treffen keinen Pfad.
    r = subprocess.run(["git", "-C", str(vault), "-c", "core.quotePath=false", "status", "--porcelain",
                        "--untracked-files=all"],
                       capture_output=True, text=True, timeout=60)
    out = []
    for line in r.stdout.splitlines():
        if len(line) < 4:
            continue
        status, rest = line[:2], line[3:]
        if " -> " in rest:                 # Umbenennung: das Ziel zaehlt
            rest = rest.split(" -> ", 1)[1]
        out.append((status, rest.strip().strip('"')))
    return out


def dirty_paths(vault: Path, own=()) -> list[str]:
    """Alle vault-relativen Pfade mit uncommitteter Aenderung, ausser `own`.

    Vor dem Lauf aufgerufen ist das die Arbeit ANDERER: der Gaertner selbst
    faengt auf einem sauberen Baum an. Wem etwas gehoert, dem schreibt er
    nicht hinein - sonst traegt sein eigener Commit die halbfertige Fassung
    des anderen mit, und genau so ist es am 10.08.2026 passiert.
    """
    eigene = {str(p) for p in (own or [])}
    return [p for _st, p in _porcelain(vault) if p not in eigene]


def foreign_changes(vault: Path, own=()) -> list[str]:
    """Dasselbe als "XY pfad", lesbar fuer den Bericht.

    Getrennt vom Committer, weil der Bericht die Liste frueher braucht als der
    Commit: er wird selbst geschrieben, bevor committet wird.
    """
    eigene = {str(p) for p in (own or [])}
    return [f"{st.strip()} {p}" for st, p in _porcelain(vault)
            if p not in eigene]


def git_commit(vault: Path, message: str, paths, dry_run: bool = False,
               author: str | None = None
               ) -> CommitResult:
    """Commit GENAU die Pfade, die dieser Lauf selbst geschrieben hat.

    Bis zum 10.08.2026 stand hier `git add -A`, und damit stellte der Committer
    alles ein, was zufaellig im Baum lag. Der belegte Schaden desselben Tages:
    `9b7829f` traegt die Nachricht "Status freshness marker for 2026-08-10" und
    darunter die halbfertigen Hook-Dateien eines anderen Workers und ein 3053
    Zeilen langes Changeset aus einem Messlauf. Beim Zusammenfuehren gab das
    einen Konflikt in einer Datei, an der der Gaertner nie gearbeitet hat, und
    die halbfertige Fassung stand danach als committeter Stand im Vault.

    Deshalb zwei Regeln. Erstens: eingestellt wird nur, was der Aufrufer
    NAMENTLICH uebergibt - die Phasen wissen, was sie anfassen, und reichen es
    durch, statt dass der Committer es am Ende erraet. `git commit --only`
    haelt das auch dann durch, wenn jemand anderes bereits etwas in den Index
    gelegt hat. Zweitens: fremde Aenderungen im Baum werden weder mitgenommen
    noch fuehren sie zum Abbruch. Sie werden gemeldet - ein Gaertnerlauf soll
    nicht daran scheitern, dass jemand parallel arbeitet, und er soll auch
    nicht so tun, als haette er nichts gesehen.
    """
    rel = sorted({str(p) for p in (paths or []) if str(p).strip()})
    result = CommitResult(paths=rel, message=message, repo=str(vault))
    if dry_run:
        log.info("dry-run: skipping git commit (%s)", message)
        return result
    try:
        result.foreign = foreign_changes(vault, rel)
        if result.foreign:
            log.info("git: %d fremde Aenderung(en) im Baum bleiben "
                     "unangetastet und uncommittet", len(result.foreign))
        # Ignorierte Pfade vorher heraus: EIN ignorierter Pfad laesst `git
        # add` mit Exit 1 scheitern, nachdem es die uebrigen schon in den
        # Index gelegt hat - Lauf vom 24.09.2026 (`IDENTITY.md`): kein Commit,
        # halb gestageter Index, Bericht "status ok".
        result.ignored = _ignored_paths(vault, rel)
        if result.ignored:
            log.warning("git: %d ignorierte(r) Pfad(e) nicht eingestellt: %s",
                        len(result.ignored), ", ".join(result.ignored))
            rel = [p for p in rel if p not in set(result.ignored)]
            result.paths = rel
        if not rel:
            log.info("git: nichts Eigenes zu committen (%s)", message)
            return result
        # `add` macht neue Dateien und Loeschungen bekannt, `--only` begrenzt
        # den Commit auf genau diese Pfade, auch wenn der Index Fremdes traegt.
        a = subprocess.run(["git", "-C", str(vault), "add", "--"] + rel,
                           capture_output=True, text=True, timeout=60)
        if a.returncode != 0:
            # Was `add` schon eingestellt hat, wieder heraus - nur die eigenen
            # Pfade, der Index anderer bleibt, wie er war.
            subprocess.run(["git", "-C", str(vault), "reset", "-q", "--"] + rel,
                           capture_output=True, timeout=60)
            result.error = f"git add: {(a.stderr or a.stdout).strip()[-300:]}"
            log.error("git commit error in %s: %s", vault, result.error)
            return result
        r = subprocess.run(
            ["git", "-C", str(vault), "commit", "--only",
             "--author", author or config.GIT_AUTHOR, "-m", message, "--"] + rel,
            capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            log.info("git commit: %s (%d Pfade)", message, len(rel))
            result.committed = True
            return result
        if "nothing to commit" in (r.stdout + r.stderr) or \
                "no changes added" in (r.stdout + r.stderr):
            log.info("git: nothing to commit (%s)", message)
            return result
        result.error = f"git commit: {(r.stdout + r.stderr).strip()[-300:]}"
        log.error("git commit failed: %s%s", r.stdout, r.stderr)
        return result
    except Exception as e:
        result.error = f"{type(e).__name__}: {e}"[:300]
        log.error("git commit error: %s", e)
        return result


def _ignored_paths(repo: Path, rel: list[str]) -> list[str]:
    """Die Pfade aus `rel`, die git in `repo` ignoriert (`check-ignore`,
    Exit 1 = keiner). Eine bereits versionierte Datei gilt nicht als ignoriert
    (`--no-index` fehlt absichtlich): die darf ein Commit weiter tragen."""
    if not rel:
        return []
    r = subprocess.run(["git", "-C", str(repo), "check-ignore", "--stdin", "-z"],
                       input="\0".join(rel) + "\0", capture_output=True,
                       text=True, timeout=60)
    if r.returncode not in (0, 1):
        return []
    return sorted(p for p in r.stdout.split("\0") if p)


def _repo_root_for(vault: Path, rel: str) -> Path:
    """Nearest enclosing `.git`, walking up from `rel`'s directory but never
    past `vault` itself -- a mounted space is its own repo directly under
    the vault (S1, `gardener.spaces`), the vault root is the fallback repo
    for everything not inside one."""
    vault = vault.resolve()
    here = (vault / rel).resolve().parent
    while True:
        if (here / ".git").exists():
            return here
        if here == vault:
            return vault
        here = here.parent


def commit_by_repo(vault: Path, message: str, paths, dry_run: bool = False,
                   author: str | None = None
                   ) -> list[CommitResult]:
    """Like `git_commit`, but for a vault with mounted space repos (S2):
    groups vault-relative `paths` by the nearest enclosing `.git` and
    commits each repo separately, with paths made relative to THAT repo --
    the vault root's own `git commit --only` never sees a mounted space's
    files (its `.gitignore` block excludes them), so a single commit there
    would silently drop them. A run touching only the vault root behaves
    exactly like a single `git_commit` call. Same argument order as
    `git_commit` so either can sit behind a `git_commit_fn=` injection point.
    """
    vault = Path(vault)
    groups: dict[Path, list[str]] = {}
    for p in sorted({str(x) for x in (paths or []) if str(x).strip()}):
        root = _repo_root_for(vault, p)
        rel_in_repo = (vault / p).resolve().relative_to(root.resolve()).as_posix()
        groups.setdefault(root, []).append(rel_in_repo)
    return [git_commit(root, message, rel_paths, dry_run=dry_run, author=author)
            for root, rel_paths in groups.items()]


def commit_by_repo_single(vault: Path, message: str, paths, dry_run: bool = False
                         ) -> CommitResult:
    """`commit_by_repo`, folded into one `CommitResult` for call sites
    (`dream/apply.py`, `dream/review.py`) whose `git_commit_fn=` injection
    point expects exactly one result, same shape as `git_commit`."""
    combined = CommitResult(message=message)
    for r in commit_by_repo(vault, message, paths, dry_run=dry_run):
        combined.committed = combined.committed or r.committed
        combined.paths.extend(r.paths)
        combined.foreign.extend(r.foreign)
    return combined


def write_last_run(state_dir: Path, data: dict) -> Path | None:
    """Record the outcome of a real run so Brain.app can show it without
    parsing logs. Never written by a dry-run (the caller decides).

    Full overwrite of the file - callers that also want the attempt merged
    in (the success case) put a "last_attempt" key into `data` themselves."""
    path = Path(state_dir) / LAST_RUN_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        return path
    except OSError as e:
        log.warning("could not write %s: %s", path, e)
        return None


def read_last_run(state_dir: Path) -> dict | None:
    path = Path(state_dir) / LAST_RUN_FILE
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def record_attempt(state_dir: Path, attempt: dict) -> Path | None:
    """Merge `attempt` into the "last_attempt" key of last-run.json, leaving
    every other (top-level) key untouched.

    ANLASS 02.09.2026: write_last_run() above is only ever called after a run
    finished cleanly, so a run that fails or is killed mid-way leaves the old
    successful run's record standing - a human reading last-run.json sees a
    stale "ok" and has no reason to suspect anything went wrong since. This
    function tracks the last ATTEMPT (started/finished/phase/status/detail)
    separately from the last SUCCESS (the unchanged top-level fields), so a
    fresh failure can no longer hide behind an old success. Call it once when
    a real run starts (status "running", no "finished" yet) and once when it
    ends, whatever the outcome. A run that is killed outright (process
    killed, power loss) never reaches the second call, so the "running" entry
    with no "finished" simply stays - itself the visible sign of an abort."""
    path = Path(state_dir) / LAST_RUN_FILE
    try:
        existing = json.loads(path.read_text())
        if not isinstance(existing, dict):
            existing = {}
    except (OSError, ValueError):
        existing = {}
    existing["last_attempt"] = attempt
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n")
        return path
    except OSError as e:
        log.warning("could not write %s: %s", path, e)
        return None


def setup_logging(log_dir: Path, verbose: bool = False) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    logfile = log_dir / f"gardener-{dt.date.today().strftime('%Y%m%d')}.log"
    handlers = [logging.FileHandler(logfile), logging.StreamHandler()]
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers, force=True)
    # date-based rotation: prune logs older than 30 days
    cutoff = time.time() - 30 * 86400
    for f in log_dir.glob("gardener-*.log"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass          # vanished under us: nothing to prune
    return logfile
