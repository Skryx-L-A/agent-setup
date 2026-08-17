"""Runtime plumbing: lock file (self-healing), deadline, git snapshots, logging."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
import json
import logging
import os
import subprocess
import time
from pathlib import Path

from . import config

log = logging.getLogger("gardener")

LAST_RUN_FILE = "last-run.json"


class LockHeldError(Exception):
    pass


class Deadline:
    def __init__(self, budget_seconds: float = config.RUN_BUDGET_SECONDS):
        self.end = time.monotonic() + budget_seconds

    def expired(self) -> bool:
        return time.monotonic() >= self.end


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

    def __bool__(self) -> bool:
        return self.committed


def _porcelain(vault: Path) -> list[tuple[str, str]]:
    """(Status, Pfad) je Eintrag aus `git status --porcelain`."""
    r = subprocess.run(["git", "-C", str(vault), "status", "--porcelain",
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


def git_commit(vault: Path, message: str, paths, dry_run: bool = False
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
    result = CommitResult(paths=rel, message=message)
    if dry_run:
        log.info("dry-run: skipping git commit (%s)", message)
        return result
    try:
        result.foreign = foreign_changes(vault, rel)
        if result.foreign:
            log.info("git: %d fremde Aenderung(en) im Baum bleiben "
                     "unangetastet und uncommittet", len(result.foreign))
        if not rel:
            log.info("git: nichts Eigenes zu committen (%s)", message)
            return result
        # `add` macht neue Dateien und Loeschungen bekannt, `--only` begrenzt
        # den Commit auf genau diese Pfade, auch wenn der Index Fremdes traegt.
        subprocess.run(["git", "-C", str(vault), "add", "--"] + rel,
                       check=True, capture_output=True, timeout=60)
        r = subprocess.run(
            ["git", "-C", str(vault), "commit", "--only",
             "--author", config.GIT_AUTHOR, "-m", message, "--"] + rel,
            capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            log.info("git commit: %s (%d Pfade)", message, len(rel))
            result.committed = True
            return result
        if "nothing to commit" in (r.stdout + r.stderr) or \
                "no changes added" in (r.stdout + r.stderr):
            log.info("git: nothing to commit (%s)", message)
            return result
        log.error("git commit failed: %s%s", r.stdout, r.stderr)
        return result
    except Exception as e:
        log.error("git commit error: %s", e)
        return result


def write_last_run(state_dir: Path, data: dict) -> Path | None:
    """Record the outcome of a real run so Brain.app can show it without
    parsing logs. Never written by a dry-run (the caller decides)."""
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
