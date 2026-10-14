"""Harvest for `brain run`: sources, text, deterministic project routing.

Sources (BRAIN5-PIPELINE Leitentscheidung 5): Claude Code transcripts
(``~/.claude/projects/**/*.jsonl``), worker results (``~/.pi-workers/results``),
the released project docs (``~/AI/<p>``, dream's allow-list) and the Claude
auto-memory (``~/.claude/projects/*/memory/*.md``) -- on this machine, and with
``--remote <host>`` also on the other one, read over ssh and never written
there.  The vault itself is not a source of new lessons.

Before any processing every source passes the secret gate of the dream
(file name pattern; per segment the content pattern); a hit is booked as
``skipped`` with its reason, never read further, never logged by value.

Routing is deterministic (Leitentscheidung 6): working directory of the
transcript -> ``git remote get-url origin`` -> ``_meta/projekte.tsv``.  No
subject words, no model.  Worker results route via their worktree or the
working directory named in the job file, project docs via their repository,
memory files via the transcripts in the same project folder.
"""
from __future__ import annotations

import collections
import datetime as dt
import hashlib
import logging
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from .. import config
from ..dream import config as dcfg
from ..dream import corpus
from ..dream import secrets_scan
from ..dream import segment as segment_mod
from ..ereignisse import flache_transkript_text
from . import buch as buch_mod
from .buch import Buch, Key

log = logging.getLogger("gardener.lauf")

TRANSCRIPT = corpus.SOURCE_TRANSCRIPT
WORKER = corpus.SOURCE_WORKER_RESULT
DOC = corpus.SOURCE_PROJECT_DOC
MEMORY = "memory"
KLASSEN = (TRANSCRIPT, WORKER, DOC, MEMORY)
# The auto-memory's index: one summary line per memory file, so every lesson
# in it is harvested twice (B6 write test 2026-09-23: 27 of 53 proposals came
# from MEMORY.md and restated single memory files).  Not a source.
MEMORY_INDEX = "MEMORY.md"

GIT_TIMEOUT = 10
SSH_TIMEOUT = 60
_CWD_RE = re.compile(r'"cwd"\s*:\s*"([^"]+)"')
_TS_RE = re.compile(r'"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2})')


@dataclass(frozen=True)
class Quelle:
    source_class: str
    quell_id: str
    path: str            # absolute local path, or "<host>:<absolute remote path>"
    signatur: str        # size:mtime - changes when the file does
    maschine: str        # "lokal" or the remote host
    wave: str
    mtime: float


@dataclass
class Wurzeln:
    transcripts: Path = field(default_factory=lambda: config.TRANSCRIPT_DIR)
    workers: Path = field(default_factory=lambda: dcfg.WORKER_RESULTS_DIR)
    projects: Path = field(default_factory=lambda: dcfg.PROJECTS_ROOT)


def _run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                              timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None


# ---------------------------------------------------------------------------
# Reading (local or over ssh, read-only)
# ---------------------------------------------------------------------------

class Leser:
    """Reads raw source text; remote paths ``<host>:<path>`` via ``ssh cat``.
    Keeps the last few texts in memory (a transcript has many segments)."""

    def __init__(self, ssh_command: list[str] | None = None, cache_size: int = 4):
        self.ssh = list(ssh_command or ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"])
        self.cache_size = cache_size
        self._cache: dict[str, str] = {}
        self._flat: dict[str, str] = {}

    @staticmethod
    def remote(path: str) -> tuple[str, str] | None:
        if path.startswith("/") or ":" not in path:
            return None
        host, rest = path.split(":", 1)
        return (host, rest) if rest.startswith("/") else None

    def roh(self, path: str) -> str:
        if path in self._cache:
            return self._cache[path]
        remote = self.remote(path)
        if remote:
            host, rest = remote
            done = _run(self.ssh + [host, "cat -- " + shlex.quote(rest)], SSH_TIMEOUT)
            if done is None or done.returncode != 0:
                raise OSError(f"ssh {host}: cannot read {rest}")
            text = done.stdout
        else:
            text = Path(path).read_text(encoding="utf-8", errors="replace")
        if len(self._cache) >= self.cache_size:
            self._cache.pop(next(iter(self._cache)))
        self._cache[path] = text
        return text

    def text(self, source_class: str, path: str) -> str:
        """The text the detector segments: flattened turns for a transcript,
        the file as it is otherwise (same as dream's ``read_source_text``)."""
        raw = self.roh(path)
        if source_class != TRANSCRIPT:
            return raw
        if path not in self._flat:
            if len(self._flat) >= self.cache_size:
                self._flat.pop(next(iter(self._flat)))
            self._flat[path] = flache_transkript_text(raw)
        return self._flat[path]

    def ssh_run(self, host: str, command: str, timeout: float = SSH_TIMEOUT) -> str:
        done = _run(self.ssh + [host, command], timeout)
        if done is None or done.returncode != 0:
            raise OSError(f"ssh {host} failed: {command[:80]}")
        return done.stdout


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def lade_projekte(vault: Path) -> dict[str, str]:
    table: dict[str, str] = {}
    path = Path(vault) / "_meta" / "projekte.tsv"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return table
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].strip() and parts[1].strip():
            table[parts[0].strip().lower()] = parts[1].strip()
    return table


def repo_von_url(url: str) -> str | None:
    """``owner/repo`` (lower case) from any git remote URL form."""
    url = url.strip()
    if not url:
        return None
    url = re.sub(r"\.git/?$", "", url.rstrip("/"))
    parts = re.split(r"[/:]", url)
    parts = [p for p in parts if p]
    if len(parts) < 2:
        return None
    return f"{parts[-2]}/{parts[-1]}".lower()


# Words that name the vault or the rule set rather than one project; they
# appear in almost every worker result and route nothing.
GENERISCHE_NAMEN = {"kern", "einstieg", "vault", "brain", "moc", "status"}
# Project names that are also ordinary words ("Anlass" = occasion, and the
# ANLASS paragraphs of this code base): they route by path, never as a word.
WORT_NAMEN = {"anlass"}
NAMEN_MIN = 3           # a project named once or twice in passing decides nothing
# Tiers whose decision a sibling result may inherit (paths, not words).
STARKE_REGELN = {"worktree", "auftrag-pfad", "worker-name", "ergebnis-pfad"}
GESCHWISTER_TAGE = 2    # worker names like `review` or `qa` are reused across projects
_FM_LIST_RE = re.compile(r"^(tags|aliases):\s*\[(.*)\]\s*$", re.M)
_PFAD_AI_RE = re.compile(r"(?:~|\$HOME|/Users/[\w.-]+|/home/[\w.-]+)/AI/([\w.-]+)")
_PFAD_VAULT_RE = re.compile(r"\b20-projects/([\w.-]+)")
def repo_re(konto: str) -> re.Pattern:
    """`<konto>/<repo>` in a text; the account comes from config (GITHUB_HANDLE), never from this file."""
    return re.compile(r"(?i)\b" + re.escape(konto) + r"/([\w.-]+)")


_PFAD_REPO_RE = repo_re(config.GITHUB_HANDLE)
_PFAD_WORKTREE_RE = re.compile(r"\.pi-workers/worktrees/([\w.-]+)")
# A working directory inside a worker's worktree or its scratchpad
# (``/private/tmp/claude-501/-Users-x--pi-workers-worktrees-<name>/...``).
_CWD_WORKER_RE = re.compile(r"(?:\.pi-workers/worktrees/|-pi-workers-worktrees-)([\w.-]+?)(?:/|$)")
# The vault's own tooling belongs to the vault's project (brain3).  A bare
# ``~/Knowledge`` is not counted: every worker reads rules and notes there.
_PFAD_VAULT_TOOLS_RE = re.compile(r"\b_meta/tools/")
# A worktree whose files sit at vault paths is a vault worktree, whatever the
# worker's results mention (repo layout beats subject words).
# Repo-relative vault code paths (not ``~/Knowledge/_meta/tools/...``, which any
# worker may merely use): a worker that names them this often worked in a vault
# worktree.
_VAULT_RELATIV_RE = re.compile(r"(?<![\w/.-])_meta/tools/|(?<=[`\s(])20-projects/[\w.-]+/")
_WORKTREE_VAULT_RE = re.compile(r"\.pi-workers/worktrees/[\w.-]+/(?:_meta/tools|20-projects|10-global)/")


def lade_namen(vault: Path, projekte: dict[str, str]) -> dict[str, str]:
    """Lower-case name -> vault project, for routing by the words of a text.

    Sources, all deterministic: the project folders under ``20-projects/``,
    the repository names and ``ordner:`` lines of ``_meta/projekte.tsv``, its
    ``name:<wort>`` lines, the tags of each ``KERN.md`` and the first word of
    its aliases (``another service KERN`` -> another service).  A name claimed by two projects
    is dropped: it cannot decide anything.
    """
    claims: dict[str, set[str]] = {}

    def add(name: str, projekt: str) -> None:
        name = name.strip().strip("'\"").lower()
        if len(name) >= 4 and name not in GENERISCHE_NAMEN:
            claims.setdefault(name, set()).add(projekt)

    root = Path(vault) / "20-projects"
    projects = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    for projekt in projects:
        add(projekt, projekt)
        try:
            head = (root / projekt / "KERN.md").read_text(encoding="utf-8")[:2000]
        except OSError:
            continue
        for kind, items in _FM_LIST_RE.findall(head):
            for item in items.split(","):
                item = item.strip()
                if item:
                    add(item.split()[0] if kind == "aliases" else item, projekt)
    for key, projekt in projekte.items():
        if key.startswith(("ordner:", "name:")):
            add(key.split(":", 1)[1], projekt)
        elif "/" in key:
            add(key.split("/", 1)[1], projekt)
    return {name: next(iter(owners)) for name, owners in claims.items() if len(owners) == 1}


DOMINANZ_MIN = 3        # a clear majority: at least 3 mentions ...
DOMINANZ_FAKTOR = 3     # ... and 3x as many as the runner-up


def eindeutig(treffer: Iterable[str | None]) -> tuple[str | None, bool]:
    """(project, decided): the one project named, or the clear majority of
    several (``DOMINANZ_*``); (None, True) when several compete, (None,
    False) when none is named."""
    counts = collections.Counter(t for t in treffer if t)
    if not counts:
        return None, False
    ranked = counts.most_common(2)
    if len(ranked) == 1:
        return ranked[0][0], True
    (top, n), (_, m) = ranked
    if n >= DOMINANZ_MIN and n >= DOMINANZ_FAKTOR * m:
        return top, True
    return None, True


class Router:
    def __init__(self, vault: Path, leser: Leser):
        self.vault = Path(vault)
        self.projekte = lade_projekte(vault)
        self.namen = lade_namen(vault, self.projekte)
        self.vault_projekte = set(self.namen.values()) | set(self.projekte.values())
        root = self.vault / "20-projects"
        if root.is_dir():
            self.vault_projekte |= {p.name for p in root.iterdir() if p.is_dir()}
        wort = sorted((n for n in self.namen if n not in WORT_NAMEN), key=len, reverse=True)
        self._namen_re = (re.compile(r"(?<![\w-])(" + "|".join(map(re.escape, wort))
                                     + r")(?![\w-])", re.IGNORECASE) if wort else None)
        self._vault_projekt: str | None | bool = False
        self.leser = leser
        self._ordner: dict[tuple[str, str], str | None] = {}
        self._memory: dict[str, str | None] = {}
        self._worker: dict[str, tuple[str | None, str]] = {}

    def _nach_ordnername(self, ordner: str) -> str | None:
        """Fallback without a remote, as the SessionStart hook does it: the
        folder or one of up to four parents, ``ordner:<name>`` first, then a
        folder named like a vault project."""
        path = Path(ordner)
        for part in [path, *list(path.parents)[:4]]:
            name = part.name.lower()
            if not name or str(part) in ("/", str(Path.home())):
                break
            projekt = self.projekte.get(f"ordner:{name}")
            if projekt:
                return projekt
            if name in self.vault_projekte:
                return name
        return None

    def fuer_ordner(self, ordner: str | None, maschine: str = "lokal") -> str | None:
        if not ordner:
            return None
        key = (maschine, ordner)
        if key not in self._ordner:
            self._ordner[key] = None    # guards the worker detour against recursion
            url = ""
            if maschine == "lokal":
                if Path(ordner).is_dir():
                    done = _run(["git", "-C", ordner, "remote", "get-url", "origin"], GIT_TIMEOUT)
                    url = done.stdout if done is not None and done.returncode == 0 else ""
            else:
                try:
                    url = self.leser.ssh_run(
                        maschine, "git -C " + shlex.quote(ordner) + " remote get-url origin 2>/dev/null || true",
                        timeout=GIT_TIMEOUT + 5)
                except OSError:
                    url = ""
            repo = repo_von_url(url)
            projekt = self.projekte.get(repo) if repo else None
            # A remote the table does not know (a foreign upstream such as
            # dgrauet/ltx-2-mlx) falls back to the folder name, as the
            # SessionStart hook does (p2, 2026-09-24).
            if not projekt:
                projekt = self._nach_ordnername(ordner) or (
                    self._nach_worker(ordner) if maschine == "lokal" and not repo else None)
            self._ordner[key] = projekt
        return self._ordner[key]

    @staticmethod
    def _worker_name(ordner: str) -> str | None:
        """The worker whose worktree (or scratchpad) ``ordner`` lies in."""
        root = str(dcfg.WORKER_RESULTS_DIR.parent / "worktrees") + "/"
        if ordner.startswith(root):
            return ordner[len(root):].split("/", 1)[0] or None
        found = _CWD_WORKER_RE.search(ordner)
        return found.group(1) if found else None

    def _nach_worker(self, ordner: str) -> str | None:
        """A worktree that is gone (or a worker's scratchpad): the project
        the results of the worker of that name route to (``fuer_worker``)."""
        name = self._worker_name(ordner)
        if not name:
            return None
        results = dcfg.WORKER_RESULTS_DIR / name
        if not results.is_dir():
            return None
        files = [p for p in sorted(results.glob("*.md")) if p.is_file() and not p.is_symlink()][:50]
        return eindeutig(self.fuer_worker(p)[0] for p in files)[0]

    @staticmethod
    def kopf(raw: str) -> tuple[str | None, str | None]:
        """Working directory and date of a transcript (first occurrence)."""
        cwd = _CWD_RE.search(raw)
        ts = _TS_RE.search(raw)
        return (cwd.group(1) if cwd else None), (ts.group(1) if ts else None)

    def _memory_cwd(self, memory_path: str, maschine: str) -> str | None:
        project_dir = str(Path(Leser.remote(memory_path)[1] if maschine != "lokal"
                               else memory_path).parent.parent)
        if project_dir in self._memory:
            return self._memory[project_dir]
        cwd = None
        if maschine == "lokal":
            for jsonl in sorted(Path(project_dir).glob("*.jsonl"))[:3]:
                try:
                    with jsonl.open(encoding="utf-8", errors="replace") as fh:
                        for _ in range(50):
                            line = fh.readline()
                            if not line:
                                break
                            found = _CWD_RE.search(line)
                            if found:
                                cwd = found.group(1)
                                break
                except OSError:
                    continue
                if cwd:
                    break
        else:
            try:
                out = self.leser.ssh_run(maschine, "cat " + shlex.quote(project_dir) +
                                         "/*.jsonl 2>/dev/null | head -c 200000")
                found = _CWD_RE.search(out)
                cwd = found.group(1) if found else None
            except OSError:
                cwd = None
        self._memory[project_dir] = cwd
        return cwd

    # ------------------------------------------------------------ worker results
    def _ai_ordner(self, name: str) -> str | None:
        """``~/AI/<name>``: the repository's remote when it exists here, else
        the folder name (``ordner:`` line or a project of that name)."""
        path = dcfg.PROJECTS_ROOT / name
        if path.is_dir():
            projekt = self.fuer_ordner(str(path))
            if projekt:
                return projekt
        lower = name.lower()
        return self.projekte.get(f"ordner:{lower}") or (lower if lower in self.vault_projekte
                                                        else self.namen.get(lower))

    def pfad_treffer(self, text: str) -> list[str]:
        """Projects named by an explicit repository path in ``text``:
        ``~/AI/<repo>``, ``<github-konto>/<repo>`` and an existing worker worktree
        (one entry per mention)."""
        out: list[str | None] = []
        for name in _PFAD_AI_RE.findall(text):
            out.append(self._ai_ordner(name.rstrip(".")))
        for repo in _PFAD_REPO_RE.findall(text):
            repo = re.sub(r"\.git$", "", repo.rstrip(".")).lower()
            out.append(self.projekte.get(f"{config.GITHUB_HANDLE.lower()}/{repo}"))
        worktrees = dcfg.WORKER_RESULTS_DIR.parent / "worktrees"
        for name in _PFAD_WORKTREE_RE.findall(text):
            path = worktrees / name.rstrip(".")
            if path.is_dir():
                out.append(self.fuer_ordner(str(path)))
        vault_worktree = _WORKTREE_VAULT_RE.findall(text)
        if vault_worktree:
            out += [self._vault_inhalt(text)] * len(vault_worktree)
        return [p for p in out if p]

    def _vault_inhalt(self, text: str) -> str | None:
        """Vault work belongs to the project whose notes it edits, not to brain3
        (der Nutzer, 2026-09-23, BRAIN5-PLAN Nr. 25): ``20-projects/<p>/`` at least
        ``NAMEN_MIN`` times and more often than ``_meta/tools/`` -> <p>; otherwise the
        vault's own project."""
        counts = collections.Counter(
            n.rstrip(".") for n in _PFAD_VAULT_RE.findall(text)
            if n.rstrip(".") in self.vault_projekte)
        eigen = self._vault_eigen()
        counts.pop(eigen, None)
        if counts:
            (top, n), *rest = counts.most_common(2) + [(None, 0)]
            second = rest[0][1] if rest else 0
            if n >= NAMEN_MIN and n > len(_PFAD_VAULT_TOOLS_RE.findall(text)) and n > second:
                return top
        return eigen

    def _vault_eigen(self) -> str | None:
        if self._vault_projekt is False:
            self._vault_projekt = self.fuer_ordner(str(self.vault))
        return self._vault_projekt

    @staticmethod
    def _vault_layout(text: str, cwd: str) -> bool:
        """Files of the vault layout below ``cwd`` (a vanished worktree)."""
        base = re.escape(cwd.rstrip("/"))
        return re.search(base + r"/(?:_meta/tools|20-projects|10-global)/", text) is not None

    def vault_treffer(self, text: str) -> list[str]:
        """Weaker: vault paths.  ``20-projects/<p>`` names a note about <p>,
        ``_meta/tools/`` the vault's own project (brain3)."""
        out: list[str | None] = []
        for name in _PFAD_VAULT_RE.findall(text):
            name = name.rstrip(".")
            out.append(name if name in self.vault_projekte else None)
        vault_hits = _PFAD_VAULT_TOOLS_RE.findall(text)
        if vault_hits:
            out += [self._vault_eigen()] * len(vault_hits)
        return [p for p in out if p]

    def namen_treffer(self, text: str) -> list[str]:
        if self._namen_re is None:
            return []
        return [self.namen[m.lower()] for m in self._namen_re.findall(text)]

    def fuer_worker(self, path: Path, raw: str | None = None, *,
                    geschwister: bool = True) -> tuple[str | None, str]:
        """(projekt, rule) for one worker result, strongest evidence first.
        The first tier with any hit decides: its one project, its clear
        majority (``eindeutig``), or no project (``mehrdeutig:<tier>``).

        1. the worker's worktree, if it still exists (its remote)
        1b. a vanished vault worktree: repo-relative vault paths
            (``_meta/tools/``, ``20-projects/<p>/``) at least ``NAMEN_MIN`` times
        2. explicit paths/remotes in the job files of the worker
        3. the worker's name (``anlass-p3`` -> anlass; ``worker:<prefix>`` lines)
        4. explicit paths/remotes in the result itself
        5. vault paths in job files and result together (``NAMEN_MIN``)
        6. project names in job files and result together (``NAMEN_MIN``)
        7. the other results of the same worker within ``GESCHWISTER_TAGE``,
           when at least two of them were routed by a path tier (1-4) and
           all of those name the same project
        """
        key = str(path)
        if key in self._worker and (geschwister or self._worker[key][1] != "geschwister"):
            return self._worker[key]
        worker = path.parent.name
        worktree = dcfg.WORKER_RESULTS_DIR.parent / "worktrees" / worker
        auftraege = ""
        same = path.with_name(path.stem + ".auftrag.txt")
        jobs = ([same] if same.is_file() else []) + [
            j for j in sorted(path.parent.glob("*.auftrag.txt"))[:3] if j != same]
        for job in jobs:
            try:
                auftraege += job.read_text(encoding="utf-8", errors="replace")[:20000] + "\n"
            except OSError:
                continue
        if raw is None:
            try:
                raw = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                raw = ""
        raw = raw[:60000]
        tiers = [
            ("worktree", lambda: [self.fuer_ordner(str(worktree))] if worktree.is_dir() else []),
            ("vault-worktree", lambda: [self._vault_inhalt(auftraege + "\n" + raw)] * (
                len(_WORKTREE_VAULT_RE.findall(auftraege + raw))
                + len(_VAULT_RELATIV_RE.findall(auftraege + raw)) >= NAMEN_MIN)),
            ("auftrag-pfad", lambda: self.pfad_treffer(auftraege)),
            ("worker-name", lambda: [self.worker_praefix(worker)] + [
                self.namen.get(t) for t in re.split(r"[-_.]", worker.lower()) + [worker.lower()]]),
            ("ergebnis-pfad", lambda: self.pfad_treffer(raw)),
            ("vault-pfad", lambda: self.vault_treffer(auftraege + "\n" + raw)),
            ("namen", lambda: self.namen_treffer(auftraege + "\n" + raw)),
        ]
        result: tuple[str | None, str] = (None, "ohne-treffer")
        for rule, find in tiers:
            hits = find()
            if rule in ("namen", "vault-pfad"):
                counts = collections.Counter(h for h in hits if h)
                hits = [h for h in hits if h and counts[h] >= NAMEN_MIN]
            projekt, decided = eindeutig(hits)
            if not decided:
                continue
            result = (projekt, rule) if projekt else (None, f"mehrdeutig:{rule}")
            break
        if result[1] == "ohne-treffer" and geschwister:
            try:
                own = path.stat().st_mtime
            except OSError:
                own = None
            others = [p for p in sorted(path.parent.glob("*.md"))
                      if p != path and p.is_file() and not p.is_symlink() and own is not None
                      and abs(p.stat().st_mtime - own) <= GESCHWISTER_TAGE * 86400][:50]
            decisions = [self.fuer_worker(p, geschwister=False) for p in others]
            named = [projekt for projekt, rule in decisions if rule in STARKE_REGELN]
            if len(set(named)) == 1 and len(named) >= 2:
                result = (named[0], "geschwister")
            elif len(set(named)) > 1:
                result = (None, "mehrdeutig:geschwister")
        if geschwister or result[1] != "ohne-treffer":
            self._worker[key] = result
        return result

    def worker_praefix(self, worker: str) -> str | None:
        """``worker:<prefix>`` lines of the table: the part of the worker name
        before the first ``-`` (``cmp-chatrein`` -> ``worker:cmp`` -> companion)."""
        prefix = worker.lower().split("-", 1)[0]
        return self.projekte.get(f"worker:{prefix}") if prefix and "-" in worker else None

    def route(self, source_class: str, path: str, maschine: str,
              raw: str | None = None) -> tuple[str | None, str | None]:
        """(projekt, datum) for one source."""
        datum = None
        if source_class == TRANSCRIPT:
            text = raw if raw is not None else self.leser.roh(path)
            cwd, datum = self.kopf(text)
            if cwd and not (maschine == "lokal" and Path(cwd).is_dir()) \
                    and self._worker_name(cwd) and self._vault_layout(text, cwd):
                return self._vault_inhalt(text), datum
            return self.fuer_ordner(cwd, maschine), datum
        if source_class == MEMORY:
            return self.fuer_ordner(self._memory_cwd(path, maschine), maschine), None
        if maschine != "lokal":
            return None, None
        local = Path(path)
        if source_class == WORKER:
            return self.fuer_worker(local, raw)[0], None
        if source_class == DOC:
            try:
                rel = local.relative_to(dcfg.PROJECTS_ROOT)
                return self.fuer_ordner(str(dcfg.PROJECTS_ROOT / rel.parts[0])), None
            except (ValueError, IndexError):
                return None, None
        return None, None


# ---------------------------------------------------------------------------
# Enumeration
# ---------------------------------------------------------------------------

def _sig(path: Path) -> tuple[str, float] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return f"{st.st_size}:{st.st_mtime_ns}", st.st_mtime


def _month(mtime: float) -> str:
    return dt.datetime.fromtimestamp(mtime).strftime("%Y-%m")


def lokale_quellen(wurzeln: Wurzeln, klassen: Iterable[str] = KLASSEN) -> list[Quelle]:
    klassen = set(klassen)
    out: list[Quelle] = []
    if TRANSCRIPT in klassen and wurzeln.transcripts.is_dir():
        for path in sorted(wurzeln.transcripts.rglob("*.jsonl")):
            if path.is_symlink() or not path.is_file() or not (s := _sig(path)):
                continue
            rel = path.relative_to(wurzeln.transcripts).as_posix()
            out.append(Quelle(TRANSCRIPT, f"transcript:{rel}", str(path), s[0], "lokal",
                              f"3:{_month(s[1])}", s[1]))
    if MEMORY in klassen and wurzeln.transcripts.is_dir():
        for path in sorted(wurzeln.transcripts.glob("*/memory/*.md")):
            if path.name == MEMORY_INDEX:
                continue
            if path.is_symlink() or not path.is_file() or not (s := _sig(path)):
                continue
            rel = path.relative_to(wurzeln.transcripts).as_posix()
            out.append(Quelle(MEMORY, f"memory:{rel}", str(path), s[0], "lokal", "4", s[1]))
    if WORKER in klassen and wurzeln.workers.is_dir():
        for path in sorted(wurzeln.workers.rglob("*.md")):
            if path.is_symlink() or not path.is_file() or not (s := _sig(path)):
                continue
            rel = path.relative_to(wurzeln.workers).as_posix()
            out.append(Quelle(WORKER, f"worker-result:{rel}", str(path), s[0], "lokal", "1", s[1]))
    if DOC in klassen:
        for src in corpus.project_doc_sources(wurzeln.projects):
            out.append(Quelle(DOC, src.quell_id, str(src.path), f"{src.size}:{src.content_hash[:16]}",
                              "lokal", src.wave, src.mtime))
    return out


_FIND = 'find . -type f \\( -name "*.jsonl" -o -path "./*/memory/*.md" \\)'
# GNU find (peer) prints size/mtime itself; the portable fallback (BSD, macOS)
# asks stat per file.  Read-only either way.
REMOTE_LIST = ('cd "$HOME/.claude/projects" 2>/dev/null || exit 0; '
               + _FIND + ' -printf "%s\\t%T@\\t%P\\n" 2>/dev/null || '
               + _FIND + ' -exec sh -c \'for f; do printf "%s\\t%s\\t%s\\n" '
               '"$(($(wc -c < "$f")))" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" '
               '"${f#./}"; done\' sh {} +')


def remote_quellen(host: str, leser: Leser, klassen: Iterable[str] = KLASSEN) -> list[Quelle]:
    """Transcripts and auto-memory of ``host``, listed in one ssh call."""
    klassen = set(klassen)
    home = leser.ssh_run(host, 'printf %s "$HOME"').strip()
    listing = leser.ssh_run(host, REMOTE_LIST)
    out: list[Quelle] = []
    for line in listing.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        size, mtime, rel = parts[0], float(parts[1] or 0), parts[2]
        full = f"{host}:{home}/.claude/projects/{rel}"
        sig = f"{size}:{parts[1]}"
        if rel.endswith(".jsonl") and TRANSCRIPT in klassen:
            out.append(Quelle(TRANSCRIPT, f"{host}:transcript:{rel}", full, sig, host,
                              f"3:{_month(mtime)}", mtime))
        elif ("/memory/" in rel and rel.endswith(".md") and MEMORY in klassen
              and rel.rsplit("/", 1)[-1] != MEMORY_INDEX):
            out.append(Quelle(MEMORY, f"{host}:memory:{rel}", full, sig, host, "4", mtime))
    return sorted(out, key=lambda q: q.quell_id)


# ---------------------------------------------------------------------------
# Harvest
# ---------------------------------------------------------------------------

@dataclass
class ErnteErgebnis:
    quellen: dict[str, int] = field(default_factory=dict)
    unveraendert: int = 0
    neu_pending: int = 0
    uebersprungen: dict[str, int] = field(default_factory=dict)
    geheimnis: list[str] = field(default_factory=list)   # ids only, never values
    fehler: list[str] = field(default_factory=list)
    abgebrochen: bool = False

    def zaehle(self, bucket: dict[str, int], name: str) -> None:
        bucket[name] = bucket.get(name, 0) + 1


def ernte(buch: Buch, quellen: list[Quelle], *, leser: Leser, router: Router,
          lauf_id: str | None, stop: Callable[[], bool] = lambda: False,
          fortschritt: Callable[[int, int], None] = lambda done, total: None) -> ErnteErgebnis:
    result = ErnteErgebnis()
    near_dup = segment_mod.NearDupIndex()
    total = len(quellen)
    for done, quelle in enumerate(quellen, 1):
        if stop():
            result.abgebrochen = True
            break
        result.zaehle(result.quellen, quelle.source_class)
        if buch.quelle_bekannt(quelle.quell_id, quelle.signatur):
            result.unveraendert += 1
            continue
        name = quelle.path.rsplit("/", 1)[-1]
        if secrets_scan.path_blocked(name):
            result.geheimnis.append(quelle.quell_id)
            buch.quelle_merken(quelle.quell_id, quelle.signatur, None)
            buch.commit()
            continue
        try:
            raw = leser.roh(quelle.path)
            text = leser.text(quelle.source_class, quelle.path)
        except OSError as exc:
            result.fehler.append(f"{quelle.quell_id}: {exc}")
            continue
        projekt, datum = router.route(quelle.source_class, quelle.path, quelle.maschine, raw=raw)
        datum = datum or dt.date.fromtimestamp(quelle.mtime).isoformat()
        for seg in segment_mod.segment_text(text):
            key = Key(quelle.quell_id, seg.index, seg.content_hash)
            if buch.known(key):
                continue
            status, grund = buch_mod.PENDING, None
            if secrets_scan.content_hit(seg.text):
                status, grund = buch_mod.SKIPPED, "secret-content"
                result.geheimnis.append(str(key))
            else:
                grund = segment_mod.classify_noise(seg.text)
                if grund is None and near_dup.is_duplicate(seg.content_hash, seg.text):
                    grund = "near-duplicate"
                if grund:
                    status = buch_mod.SKIPPED
                else:
                    near_dup.add(seg.content_hash, seg.text)
            buch.add_unit(key, source_class=quelle.source_class, path=quelle.path,
                          wave=quelle.wave, size=len(seg.text.encode("utf-8")),
                          char_start=seg.char_start, char_end=seg.char_end,
                          projekt=projekt, datum=datum, maschine=quelle.maschine,
                          status=status, grund=grund, lauf_id=lauf_id)
            if status == buch_mod.PENDING:
                result.neu_pending += 1
            else:
                result.zaehle(result.uebersprungen, grund.split(":", 1)[0])
        buch.quelle_merken(quelle.quell_id, quelle.signatur, projekt)
        buch.commit()          # one transaction per source
        fortschritt(done, total)
    return result


def einheit_text(unit, leser: Leser) -> str | None:
    """The unit's exact segment text, or None when the source changed or
    vanished since harvest (the caller marks it stale)."""
    try:
        text = leser.text(unit["source_class"], unit["path"])
    except OSError:
        return None
    chunk = text[unit["char_start"]:unit["char_end"]]
    if hashlib.sha256(chunk.encode("utf-8")).hexdigest() != unit["content_hash"]:
        return None
    return chunk

