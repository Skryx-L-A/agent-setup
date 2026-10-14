"""Brain spaces: mounting other git repos inside this vault.

Design: `~/Knowledge` (or whatever `BRAIN_VAULT` points at) is the root space
(`kern`). Every other space is its own git clone mounted directly at a
`mount` path inside the vault, e.g. `20-projects/a machine-bound project/` -- not a
symlink, not a bind mount (`brain5-architektur-entwurf.md` Abschnitt 4.1:
`os.walk(followlinks=False)` walks straight into a real subdirectory but
skips symlinks, and the mounted repo's own `.git` falls under the existing
dot-directory exclusion in `gardener.vault`/`braincli.vault`).

Two space-list sources feed `sync()`:
  1. Forgejo (`BRAIN_FORGEJO_URL` + `BRAIN_FORGEJO_TOKEN`): one repo per
     space, the space's own `.space.yml` at its repository root is
     authoritative; a repo without one is not a declared space.
  2. `.brain/spaces.yml` in the vault root, for tests and offline use: the
     same schema as `.space.yml`, as a list, plus a `remote` per entry.

`.space.yml` / a list entry (JSON-compatible YAML, like `engines.yaml` --
stdlib `json.loads`, no YAML dependency):
    {"name": "a machine-bound project", "art": "projekt", "mount": "20-projects/a machine-bound project",
     "owner": "person-1", "schreibbar": true}

`sync()` writes the per-machine manifest `.brain/spaces.lock` (gitignored --
`update_gitignore_block` maintains the `# brain spaces` block in the vault's
own `.gitignore`) with one entry per successfully mounted space: the schema
fields above plus `remote` and the mounted repo's current `commit`. Both
`braincli.search`'s `space` label and `gardener.vault.VaultWriter`'s
read-only-space gate read this same manifest via `match_space` -- one file,
one meaning, see `load_manifest`.

Never overwrites: a `mount` that already exists and is non-empty is only
ever fetched + fast-forward-merged, never cloned over; a `mount` that
collides with another space (same path, or one nested inside the other)
aborts sync for the colliding spaces only, not the whole run.
"""
from __future__ import annotations

import dataclasses
import json
import logging
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from . import config

log = logging.getLogger("gardener")

SPACE_FILE = ".space.yml"
SPACES_DIR = ".brain"
LOCAL_SPACES_FILE = f"{SPACES_DIR}/spaces.yml"
LOCK_FILE = f"{SPACES_DIR}/spaces.lock"

VALID_ART = {"person", "projekt", "team"}
REQUIRED_FIELDS = ("name", "art", "mount", "owner", "schreibbar")

FORGEJO_URL_ENV = "BRAIN_FORGEJO_URL"
FORGEJO_TOKEN_ENV = "BRAIN_FORGEJO_TOKEN"
FORGEJO_TIMEOUT = 15.0

GIT_TIMEOUT = 60
GIT_CLONE_TIMEOUT = 300

GITIGNORE_START = "# brain spaces:start"
GITIGNORE_END = "# brain spaces:end"


class SpaceConfigError(ValueError):
    pass


class ForgejoError(Exception):
    """`status` is the HTTP status when Forgejo answered, None when it did not."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class SpaceSource:
    """One space, as declared in `.space.yml` or a spaces-list entry."""
    name: str
    art: str
    mount: str          # vault-relative, posix, no leading/trailing slash
    owner: str
    schreibbar: bool
    remote: str = ""    # git remote to clone from - only needed to sync


@dataclass
class SpaceOutcome:
    """What `sync()` did (or would do) for one space."""
    name: str
    mount: str
    action: str   # cloned|updated|clean|would-clone|would-update|manifest-only
                  # |missing|diverged|collision|error
    detail: str = ""


@dataclass
class SyncResult:
    outcomes: list[SpaceOutcome] = field(default_factory=list)
    manifest: list[dict] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(o.action in ("collision", "diverged", "error")
                       for o in self.outcomes)


@dataclass
class SpaceStatus:
    name: str
    mount: str
    state: str   # sauber|voraus|hinterher|divergiert|fehlt|kein-git|kein-upstream
    detail: str = ""


# --------------------------------------------------------------------- #
# Schema parsing
# --------------------------------------------------------------------- #

def _clean_mount(mount: object) -> str:
    raw = str(mount).strip()
    # Absoluteness has to be checked BEFORE stripping slashes - stripping
    # first would turn "/etc/passwd" into the harmless-looking "etc/passwd".
    if not raw or raw.startswith("/") or PurePosixPath(raw).is_absolute():
        raise SpaceConfigError(f"mount must be vault-relative: {mount!r}")
    m = raw.strip("/")
    if not m or m in (".", "..") or "/../" in f"/{m}/":
        raise SpaceConfigError(f"invalid mount: {mount!r}")
    top = PurePosixPath(m).parts[0]
    reserved = {d.casefold() for d in config.EXCLUDE_DIRS}
    if top.casefold() in reserved or top.startswith("."):
        raise SpaceConfigError(
            f"mount may not live under a reserved directory: {mount!r}")
    return m


def parse_space_dict(d: dict, *, require_remote: bool = False) -> SpaceSource:
    if not isinstance(d, dict):
        raise SpaceConfigError(f"space entry must be a mapping, got {type(d).__name__}")
    missing = [f for f in REQUIRED_FIELDS if f not in d]
    if missing:
        raise SpaceConfigError(f"space entry missing field(s): {', '.join(missing)}")
    art = str(d["art"]).strip()
    if art not in VALID_ART:
        raise SpaceConfigError(f"invalid art {art!r}, must be one of {sorted(VALID_ART)}")
    name = str(d["name"]).strip()
    if not name:
        raise SpaceConfigError("space entry needs a non-empty name")
    remote = str(d.get("remote") or "").strip()
    if require_remote and not remote:
        raise SpaceConfigError(f"space {name!r} needs a remote to sync")
    return SpaceSource(
        name=name, art=art, mount=_clean_mount(d["mount"]),
        owner=str(d["owner"]).strip(), schreibbar=bool(d["schreibbar"]),
        remote=remote)


def parse_space_file(path: Path) -> SpaceSource:
    """Parse a single `.space.yml`. JSON-compatible YAML, like `engines.yaml`
    -- stdlib `json.loads`, no third-party YAML parser required."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return parse_space_dict(data)


def load_local_spaces_list(vault: Path) -> list[SpaceSource]:
    """Source 2: `.brain/spaces.yml`, for tests and offline use."""
    path = Path(vault) / LOCAL_SPACES_FILE
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("spaces") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise SpaceConfigError(f"{path}: expected a 'spaces' list")
    return [parse_space_dict(e, require_remote=True) for e in entries]


# --------------------------------------------------------------------- #
# Source 1: Forgejo API (best-effort, never required for tests)
# --------------------------------------------------------------------- #

def _forgejo_get(base_url: str, token: str, path: str):
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(url, headers={"Authorization": f"token {token}"})
    try:
        with urllib.request.urlopen(req, timeout=FORGEJO_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ForgejoError(f"{url}: {exc}", status=exc.code) from exc
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise ForgejoError(f"{url}: {exc}") from exc


FORGEJO_PAGE_SIZE = 50
FORGEJO_MAX_PAGES = 100


def _forgejo_user_repos(base_url: str, token: str) -> list[dict]:
    """Every page of `/api/v1/user/repos` (14.10.2026: only the first 50 were read).
    Forgejo caps the page size at MAX_RESPONSE_ITEMS, so a short page is no proof of
    the end; only an empty page is."""
    repos: list[dict] = []
    seen: set[str] = set()
    for page in range(1, FORGEJO_MAX_PAGES + 1):
        batch = _forgejo_get(base_url, token,
                             f"/api/v1/user/repos?limit={FORGEJO_PAGE_SIZE}&page={page}")
        if not isinstance(batch, list):
            raise ForgejoError("unexpected /api/v1/user/repos response shape")
        if not batch:
            return repos
        for repo in batch:
            key = str(repo.get("full_name") or "") if isinstance(repo, dict) else ""
            if key and key in seen:
                continue
            seen.add(key)
            repos.append(repo)
    raise ForgejoError(f"/api/v1/user/repos: more than {FORGEJO_MAX_PAGES} pages")


def _without_credentials(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit(parts._replace(netloc=parts.netloc.rpartition("@")[2]))


def fetch_forgejo_spaces(base_url: str, token: str,
                         previous: list[dict] | None = None) -> list[SpaceSource]:
    """One repo per space (architecture Abschnitt 2); the repo's own
    `.space.yml` is authoritative. A repo without one (HTTP 404) is not a
    declared space and is silently skipped -- absence is not an error here, an
    ordinary Forgejo repo that never opted in to being a space.

    Any other failure to read or parse the file (timeout, HTTP 5xx, broken
    content) says nothing about the space: if `previous` (the last manifest)
    lists that repo, its entry is kept, so the mounted repo stays in the
    manifest and in the `.gitignore` block (14.10.2026)."""
    repos = _forgejo_user_repos(base_url, token)
    known = {_without_credentials(str(e.get("remote") or "")): e
             for e in (previous or []) if isinstance(e, dict) and e.get("remote")}
    out: list[SpaceSource] = []
    for repo in repos:
        try:
            full_name = repo["full_name"]
            branch = repo.get("default_branch") or "main"
        except (KeyError, TypeError, AttributeError) as exc:
            log.info("spaces: skipping malformed repo entry: %s", exc)
            continue
        clone_url = str(repo.get("clone_url") or "")
        try:
            raw = _forgejo_get(
                base_url, token,
                f"/api/v1/repos/{full_name}/raw/{branch}/{SPACE_FILE}")
            space = parse_space_dict(raw)
        except (ForgejoError, SpaceConfigError) as exc:
            if isinstance(exc, ForgejoError) and exc.status == 404:
                log.info("spaces: skipping repo without a %s: %s", SPACE_FILE, full_name)
                continue
            entry = known.get(_without_credentials(clone_url)) if clone_url else None
            if entry is None:
                log.info("spaces: skipping repo without a valid %s: %s",
                         SPACE_FILE, exc)
                continue
            try:
                space = parse_space_dict({k: entry.get(k) for k in REQUIRED_FIELDS}
                                         | {"name": entry.get("space")})
            except SpaceConfigError:
                continue
            log.warning("spaces: %s of %s unreadable, keeping the last manifest entry: %s",
                        SPACE_FILE, full_name, exc)
        if clone_url and token:
            parts = urllib.parse.urlsplit(clone_url)
            clone_url = urllib.parse.urlunsplit(
                parts._replace(netloc=f"brain:{token}@{parts.netloc}"))
        out.append(dataclasses.replace(space, remote=clone_url))
    return out


def list_spaces(vault: Path) -> list[SpaceSource]:
    """Source 1 if both Forgejo env vars are set, else source 2 (local
    file). No silent fallback between them: a configured-but-unreachable
    Forgejo is an error the caller should see, not a reason to quietly use
    a possibly stale local list."""
    url = os.environ.get(FORGEJO_URL_ENV, "").strip()
    token = os.environ.get(FORGEJO_TOKEN_ENV, "").strip()
    if url and token:
        return fetch_forgejo_spaces(url, token, previous=load_manifest(vault))
    return load_local_spaces_list(vault)


# --------------------------------------------------------------------- #
# Collisions
# --------------------------------------------------------------------- #

def _nested(a: PurePosixPath, b: PurePosixPath) -> bool:
    return a != b and (b in a.parents or a in b.parents)


def find_collisions(spaces: list[SpaceSource]) -> dict[str, str]:
    """name -> reason, for every space whose mount collides with another's
    (same mount, or one nested inside the other)."""
    problems: dict[str, str] = {}
    entries = [(s.name, PurePosixPath(s.mount)) for s in spaces]
    for i, (name_a, mount_a) in enumerate(entries):
        for name_b, mount_b in entries[i + 1:]:
            if mount_a == mount_b:
                problems.setdefault(
                    name_a, f"mount collision with '{name_b}': both use {mount_a}")
                problems.setdefault(
                    name_b, f"mount collision with '{name_a}': both use {mount_a}")
            elif _nested(mount_a, mount_b):
                problems.setdefault(
                    name_a, f"mount nests with '{name_b}': {mount_a} / {mount_b}")
                problems.setdefault(
                    name_b, f"mount nests with '{name_a}': {mount_b} / {mount_a}")
    return problems


# --------------------------------------------------------------------- #
# Git plumbing
# --------------------------------------------------------------------- #

def _run_git(*args: str, timeout: float = GIT_TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True,
                          timeout=timeout)


def _is_git_repo(path: Path) -> bool:
    return (path / ".git").exists()


def _is_empty_dir(path: Path) -> bool:
    return path.is_dir() and not any(path.iterdir())


def _head_commit(path: Path) -> str | None:
    r = _run_git("-C", str(path), "rev-parse", "HEAD")
    return r.stdout.strip() if r.returncode == 0 else None


def _clone(remote: str, dest: Path) -> tuple[bool, str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = _run_git("clone", "--quiet", remote, str(dest), timeout=GIT_CLONE_TIMEOUT)
    return r.returncode == 0, (r.stderr or r.stdout).strip()


KERN_FF_ENV = "BRAIN_SPACES_KERN_FF"


def kern_vorziehen(vault: Path) -> SpaceOutcome:
    """Die Kern-Arbeitskopie per Fast-Forward auf `origin/main` ziehen (09.10.2026): auf peer zog sie niemand
    nach, sie stand 9 Tage und 47 Commits zurueck, und Hooks wie Notizen der dortigen Sitzungen waren alt.
    Nur wenn es gefahrlos geht: Zweig `main`, kein Merge/Rebase/Cherry-Pick im Gang, lokaler Stand Vorfahre
    von `origin/main`; `git merge --ff-only` bricht selbst ab, wenn lokale Aenderungen im Weg sind. Nie
    push, nie Rebase, nie Reset. Abschalter: BRAIN_SPACES_KERN_FF=0."""
    vault = Path(vault)
    name, mount = "kern", "."
    if os.environ.get(KERN_FF_ENV, "1").strip().lower() in ("0", "aus", "off", "false", "no"):
        return SpaceOutcome(name, mount, "clean", "Kern-Vorziehen abgeschaltet")
    git = vault / ".git"
    if not git.is_dir():
        return SpaceOutcome(name, mount, "clean", "kein eigenes .git (Worktree oder kein Repo)")
    if any((git / f).exists() for f in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD")):
        return SpaceOutcome(name, mount, "clean", "Merge/Rebase im Gang, nicht vorgezogen")
    zweig = _run_git("-C", str(vault), "symbolic-ref", "--short", "-q", "HEAD").stdout.strip()
    if zweig != "main":
        return SpaceOutcome(name, mount, "clean", f"Zweig {zweig or 'losgeloest'}, nicht vorgezogen")
    f = _run_git("-C", str(vault), "fetch", "--quiet", "origin", "main")
    if f.returncode != 0:
        return SpaceOutcome(name, mount, "clean", "fetch fehlgeschlagen: " + (f.stderr or "").strip()[:120])
    kopf, ziel = _head_commit(vault), _run_git("-C", str(vault), "rev-parse", "origin/main").stdout.strip()
    if not kopf or not ziel or kopf == ziel:
        return SpaceOutcome(name, mount, "clean", "aktuell")
    if _run_git("-C", str(vault), "merge-base", "--is-ancestor", kopf, ziel).returncode != 0:
        return SpaceOutcome(name, mount, "clean", "eigene Commits vor origin/main, nicht vorgezogen")
    n = _run_git("-C", str(vault), "rev-list", "--count", f"{kopf}..{ziel}").stdout.strip()
    m = _run_git("-C", str(vault), "merge", "--ff-only", "--quiet", ziel)
    if m.returncode != 0:
        return SpaceOutcome(name, mount, "clean", "nicht vorgezogen: " + (m.stderr or m.stdout).strip()[:160])
    return SpaceOutcome(name, mount, "updated", f"Kern um {n} Commits vorgezogen")


LFS_HOOKS = ("pre-push", "post-checkout", "post-commit", "post-merge")


def ensure_lfs_hooks(path: Path) -> list[str]:
    """Git-LFS-Hooks direkt ins Repo legen, wenn es LFS nutzt und sie fehlen (27.09.2026): mit einer
    globalen `core.hooksPath` (Werkbank-Verteiler seit 25.09.) legt `git lfs install` sie nicht mehr an,
    und ein Push schiebt dann nur Zeiger ohne Objekt. Der Verteiler ruft die Repo-Hooks weiter auf;
    ohne Verteiler greifen sie direkt. Vorhandene Hooks bleiben unberuehrt."""
    attrs = path / ".gitattributes"
    try:
        if "filter=lfs" not in attrs.read_text(encoding="utf-8"):
            return []
    except OSError:
        return []
    r = _run_git("-C", str(path), "rev-parse", "--git-common-dir")
    if r.returncode != 0:
        return []
    common = Path(r.stdout.strip())
    if not common.is_absolute():
        common = path / common
    hooks = common / "hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    angelegt = []
    for name in LFS_HOOKS:
        ziel = hooks / name
        if ziel.exists() or ziel.is_symlink():
            continue
        ziel.write_text(
            "#!/bin/sh\n"
            "command -v git-lfs >/dev/null 2>&1 || { printf >&2 \"\\n%s\\n\\n\" "
            "\"This repository is configured for Git LFS but 'git-lfs' was not found on your path.\"; exit 2; }\n"
            f"git lfs {name} \"$@\"\n", encoding="utf-8")
        ziel.chmod(0o755)
        angelegt.append(name)
    return angelegt


def _update(path: Path) -> tuple[str, str]:
    """`fetch` + fast-forward-only merge in one atomic step: on divergence
    `pull --ff-only` fails cleanly without touching the working tree, which
    is exactly the "report, never overwrite" rule this needs."""
    before = _head_commit(path)
    r = _run_git("-C", str(path), "pull", "--ff-only", "--quiet")
    if r.returncode != 0:
        return "diverged", (r.stderr or r.stdout).strip()
    after = _head_commit(path)
    return ("updated" if before != after else "clean"), ""


def _ahead_behind(path: Path) -> tuple[int, int] | None:
    r = _run_git("-C", str(path), "rev-list", "--left-right", "--count", "HEAD...@{u}")
    if r.returncode != 0:
        return None
    a, b = r.stdout.split()
    return int(a), int(b)


def _worktree_clean(path: Path) -> bool:
    r = _run_git("-C", str(path), "status", "--porcelain", "--untracked-files=no")
    return r.returncode == 0 and not r.stdout.strip()


def _sync_push(path: Path) -> tuple[str, str]:
    """Two-way sync for a writable space (BRAIN5-PLAN Nr. 42): fetch, then
    fast-forward, rebase own commits onto the remote when both sides moved
    (only with a clean tracked worktree; a conflict aborts the rebase and is
    reported), and push own commits. Never force, never touches uncommitted
    work: a dirty worktree that cannot fast-forward waits for the next round."""
    before = _head_commit(path)
    r = _run_git("-C", str(path), "fetch", "--quiet")
    if r.returncode != 0:
        return "error", (r.stderr or r.stdout).strip()
    ab = _ahead_behind(path)
    if ab is None:
        return "error", "no upstream branch"
    ahead, behind = ab
    if behind and not ahead:
        r = _run_git("-C", str(path), "merge", "--ff-only", "--quiet", "@{u}")
        if r.returncode != 0:
            return "waiting", "local changes block the fast-forward - next round"
    elif behind and ahead:
        if not _worktree_clean(path):
            return "waiting", f"+{ahead}/-{behind} with uncommitted changes - next round"
        r = _run_git("-C", str(path), "rebase", "--quiet", "@{u}")
        if r.returncode != 0:
            _run_git("-C", str(path), "rebase", "--abort")
            return "diverged", "rebase conflict, aborted - resolve by hand: " + \
                (r.stderr or r.stdout).strip()[:300]
    ab = _ahead_behind(path)
    if ab and ab[0]:
        r = _run_git("-C", str(path), "push", "--quiet", timeout=GIT_CLONE_TIMEOUT)
        if r.returncode != 0:
            return "error", "push failed: " + (r.stderr or r.stdout).strip()[:300]
        return "pushed", f"{ab[0]} commit(s)"
    return ("updated" if before != _head_commit(path) else "clean"), ""


# --------------------------------------------------------------------- #
# sync / status
# --------------------------------------------------------------------- #

def sync(vault: Path, *, dry_run: bool = False, manifest_only: bool = False,
        spaces: list[SpaceSource] | None = None, push: bool = False) -> SyncResult:
    vault = Path(vault).resolve()
    if spaces is None:
        spaces = list_spaces(vault)
    result = SyncResult()
    collisions = find_collisions(spaces)

    for s in spaces:
        if s.name in collisions:
            result.outcomes.append(
                SpaceOutcome(s.name, s.mount, "collision", collisions[s.name]))
            continue

        mount_path = vault / s.mount
        detail = ""
        if manifest_only:
            action = "manifest-only" if mount_path.exists() else "missing"
        elif not mount_path.exists() or _is_empty_dir(mount_path):
            if dry_run:
                action = "would-clone"
            else:
                ok, detail = _clone(s.remote, mount_path)
                action = "cloned" if ok else "error"
        elif not _is_git_repo(mount_path):
            action, detail = ("error",
                              "mount exists and is not a git repository - not touching it")
        elif dry_run:
            action = "would-update"
        else:
            # One hanging remote must not end the round for every other space (14.10.2026:
            # 511 uncaught TimeoutExpired in the Mac timer log, each one skipped the rest).
            try:
                if push and s.schreibbar:
                    action, detail = _sync_push(mount_path)
                else:
                    action, detail = _update(mount_path)
            except subprocess.TimeoutExpired as e:
                action, detail = "error", f"git timed out after {e.timeout:.0f} s: {' '.join(e.cmd[3:])}"

        result.outcomes.append(SpaceOutcome(s.name, s.mount, action, detail))
        # A failed fetch/push on a repo that IS mounted stays in the manifest
        # and the .gitignore block (10.10.2026: a rejected pre-push dropped
        # claude-workbench from the block, so the whole space showed up as
        # untracked in kern and one `git add -A` would have swallowed it).
        if action == "missing" or (action == "error" and not _is_git_repo(mount_path)):
            continue
        if not dry_run and not manifest_only and _is_git_repo(mount_path):
            ensure_lfs_hooks(mount_path)
        commit = _head_commit(mount_path) if mount_path.exists() else None
        result.manifest.append({
            "space": s.name, "mount": s.mount, "remote": s.remote,
            "commit": commit, "art": s.art, "owner": s.owner,
            "schreibbar": s.schreibbar,
        })

    if not dry_run:
        write_lock(vault, result.manifest)
        update_gitignore_block(vault, [e["mount"] for e in result.manifest])
    return result


def status(vault: Path) -> list[SpaceStatus]:
    vault = Path(vault)
    out: list[SpaceStatus] = []
    for entry in load_manifest(vault):
        name, mount = entry.get("space", ""), entry.get("mount", "")
        mount_path = vault / mount
        if not mount_path.exists():
            out.append(SpaceStatus(name, mount, "fehlt"))
            continue
        if not _is_git_repo(mount_path):
            out.append(SpaceStatus(name, mount, "kein-git"))
            continue
        _run_git("-C", str(mount_path), "fetch", "--quiet")
        r = _run_git("-C", str(mount_path), "rev-list", "--left-right",
                     "--count", "HEAD...@{u}")
        if r.returncode != 0:
            out.append(SpaceStatus(name, mount, "kein-upstream"))
            continue
        try:
            ahead_s, behind_s = r.stdout.split()
            ahead, behind = int(ahead_s), int(behind_s)
        except ValueError:
            out.append(SpaceStatus(name, mount, "kein-upstream"))
            continue
        if ahead and behind:
            state = "divergiert"
        elif ahead:
            state = "voraus"
        elif behind:
            state = "hinterher"
        else:
            state = "sauber"
        out.append(SpaceStatus(name, mount, state, f"+{ahead}/-{behind}"))
    return out


# --------------------------------------------------------------------- #
# Manifest: read side, shared by search's space label and the write gate
# --------------------------------------------------------------------- #

def write_lock(vault: Path, manifest: list[dict]) -> Path:
    path = Path(vault) / LOCK_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"spaces": manifest}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8")
    return path


def load_manifest(vault: Path) -> list[dict]:
    path = Path(vault) / LOCK_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entries = data.get("spaces") if isinstance(data, dict) else None
    return entries if isinstance(entries, list) else []


def match_space(rel: str, manifest: list[dict]) -> dict | None:
    """Longest-mount-prefix match, or None (root/`kern`)."""
    rel = str(rel).strip("/")
    best: dict | None = None
    best_len = -1
    for entry in manifest:
        mount = str(entry.get("mount", "")).strip("/")
        if not mount:
            continue
        if rel == mount or rel.startswith(mount + "/"):
            if len(mount) > best_len:
                best, best_len = entry, len(mount)
    return best


def space_for_path(rel: str, manifest: list[dict]) -> str:
    entry = match_space(rel, manifest)
    return entry["space"] if entry else "kern"


# --------------------------------------------------------------------- #
# .gitignore block
# --------------------------------------------------------------------- #

def update_gitignore_block(vault: Path, mounts: list[str]) -> None:
    path = Path(vault) / ".gitignore"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    try:
        start = lines.index(GITIGNORE_START)
        end = lines.index(GITIGNORE_END, start)
        before, after = lines[:start], lines[end + 1:]
    except ValueError:
        before, after = lines, []
        if before and before[-1].strip():
            before.append("")
    block = ([GITIGNORE_START, f"/{LOCK_FILE}"]
             + [f"/{m.strip('/')}/" for m in sorted(set(mounts))]
             + [GITIGNORE_END])
    text = "\n".join(before + block + after).rstrip("\n") + "\n"
    path.write_text(text, encoding="utf-8")
