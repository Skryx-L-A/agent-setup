"""Warm search process for `brain search` on the Mac (der Nutzer 2026-09-28, E4).

A cold `brain search` spends about half its time on process start, imports
and parsing every note. This module keeps one short-lived process per vault
that holds the parsed notes, the BM25 counts (lex cache), the stems, the
vectors and a warm embedding model, and answers `brain search` over a Unix
socket. The CLI asks it first and falls back to the cold path on any doubt.

Rules it keeps:
- Result identical to the cold path. The server runs the very same
  `cli.cmd_search`; it only memoises *reads* (a parsed note, the vector
  tables, the lex cache file), each keyed by the file's stat, so a changed
  note is parsed again and a changed index is read again.
- Unix socket only, mode 0600 in a 0700 directory owned by this user
  (`$TMPDIR/brain-warm-<uid>/`, `BRAIN_WARM_DIR` moves it); the server also
  checks the peer uid. No TCP.
- Started on demand by the first `brain search` (detached), never as a
  service. Ends after `BRAIN_WARM_IDLE` seconds idle (default 1800), when the
  code under braincli/gardener changes (version key), or when the vault is
  gone; removes socket and pid file on the way out.
- One process per vault: an flock on `<hash>.lock` guards the start.
- `BRAIN_WARM=0` switches the whole thing off (cold path only).
- `BRAIN_WARM_LANE=<name>` gives a caller its own server (own socket, own
  idle limit via `BRAIN_WARM_IDLE` at spawn). The recall hook uses the lane
  `recall` so its short searches never queue behind a long interactive one
  (reranker plus LLM sort); measured 09.10.: 16 of 106 recall searches in a
  week ran into the 2 s deadline, mostly the first one after idle or one
  queued behind another search (the user's night order 09.10.).
- `BRAIN_WARM_ONLY=1`: when no server of this lane answers, start one and,
  unless the embedding model is still loaded (then the cold path fits the
  deadline), return without a result (exit `WARM_ONLY_RC`). The hook then
  skips this one input at once instead of waiting out its deadline.

Shared with the rest of the machine (13.10.2026, the board reported this
server three times as load without an entry during full test runs):
- It runs at low priority: `nice` +10 (`BRAIN_WARM_NICE`, 0 = unchanged), and
  its children inherit that. The load was never idle time: a search with the
  LLM sort starts `claude -p` as a child of this server, and a child's CPU is
  counted for the server once it ended. With many sessions searching, that
  added up to 1.5 to 2 cores.
- It has an owner: started from a tmux pane, `wb-nohup` starts it and records
  that pane (`BRAIN_WARM_WB_NOHUP=0` = plain detached start as before), and
  every further pane that asks is added as a user (`wb-nohup benutzer`), so
  `wb-waisen` and the board name the panes instead of "unknown".
- One log line per request in `<socket name>.log` next to the socket: time,
  duration, CPU of the finished children, pane, option names. Never the query
  text. Kept below about 1 MB (one older file).
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SWITCH_ENV = "BRAIN_WARM"
DIR_ENV = "BRAIN_WARM_DIR"
LANE_ENV = "BRAIN_WARM_LANE"
ONLY_ENV = "BRAIN_WARM_ONLY"
WARM_ONLY_RC = 75        # EX_TEMPFAIL: no warm server yet, one is starting
IDLE_ENV = "BRAIN_WARM_IDLE"
NICE_ENV = "BRAIN_WARM_NICE"
NICE_DEFAULT = 10
WB_NOHUP_ENV = "BRAIN_WARM_WB_NOHUP"          # 0 = plain detached start, no owner record
WB_NOHUP_BIN_ENV = "BRAIN_WARM_WB_NOHUP_BIN"  # another wb-nohup (tests)
LOG_MAX = 1 << 20
IDLE_DEFAULT = 1800.0
TICK = 30.0              # how often the idle server looks at clock, code and vault
CONNECT_TIMEOUT = 0.2
REPLY_TIMEOUT = 5.0      # the server does what the cold path would do; past this, go cold
MAX_REQUEST = 4 << 20
PROTOCOL = 1
_SERVING = False         # set in the server: its own cmd_search runs the cold path


def enabled() -> bool:
    raw = os.environ.get(SWITCH_ENV, "1").strip().lower()
    return raw not in ("0", "off", "false", "no", "nein")


# -- places -------------------------------------------------------------------

def lane() -> str:
    """Lane name from BRAIN_WARM_LANE, only [a-z0-9], at most 12 chars; '' = default."""
    raw = os.environ.get(LANE_ENV, "").strip().lower()
    return "".join(c for c in raw if c.isascii() and c.isalnum())[:12]


def warm_only() -> bool:
    return os.environ.get(ONLY_ENV, "").strip().lower() in ("1", "on", "true", "yes", "ja")


def runtime_dir() -> Path:
    base = os.environ.get(DIR_ENV, "").strip() or tempfile.gettempdir()
    return Path(base) / f"brain-warm-{os.getuid()}"


def _secure_dir(create: bool) -> Path | None:
    """The socket directory, only if it is a real directory of this user that
    nobody else can enter; None otherwise (no warm path then)."""
    d = runtime_dir()
    if create:
        try:
            d.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError:
            return None
    try:
        st = os.lstat(d)
    except OSError:
        return None
    import stat as _stat
    if not _stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        return None
    return d


def vault_id(vault: Path) -> str:
    return hashlib.sha256(str(Path(vault).resolve()).encode()).hexdigest()[:16]


SUN_PATH_MAX = 103      # sockaddr_un.sun_path is 104 bytes on macOS, 108 on Linux


def paths(vault: Path, d: Path) -> tuple[Path, Path, Path]:
    h = vault_id(vault)
    if lane():
        h = f"{h}-{lane()}"
    return d / f"{h}.sock", d / f"{h}.lock", d / f"{h}.pid"


def _usable(d: Path | None, vault: Path) -> bool:
    """A socket path the kernel accepts; a too deep BRAIN_WARM_DIR means cold."""
    return d is not None and len(os.fsencode(str(paths(vault, d)[0]))) <= SUN_PATH_MAX


def code_key() -> str:
    """Version key over the code that shapes a result: every .py file of
    braincli and gardener (path, mtime, size) plus the interpreter. A server
    whose key differs from the client's answers `stale` and ends."""
    import gardener

    import braincli
    h = hashlib.sha256(sys.executable.encode())
    h.update(str(PROTOCOL).encode())
    for pkg in (braincli, gardener):
        root = Path(pkg.__file__).parent
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
            for name in sorted(filenames):
                if name.endswith(".py"):
                    p = os.path.join(dirpath, name)
                    try:
                        st = os.stat(p)
                    except OSError:
                        continue
                    h.update(f"{p}\0{st.st_mtime_ns}\0{st.st_size}\n".encode())
    return h.hexdigest()


# -- client -------------------------------------------------------------------

def _lock_held(lock: Path) -> bool:
    try:
        fd = os.open(lock, os.O_RDONLY)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except OSError:
        return True
    finally:
        os.close(fd)
    return False


def wb_nohup() -> str | None:
    """`wb-nohup` when it may record an owner: switch on, a tmux pane to name, and the tool there."""
    if os.environ.get(WB_NOHUP_ENV, "1").strip().lower() in ("0", "off", "false", "no", "nein"):
        return None
    if not (os.environ.get("TMUX_PANE") and os.environ.get("TMUX")):
        return None
    exe = os.environ.get(WB_NOHUP_BIN_ENV, "").strip() or str(Path.home() / ".local" / "bin" / "wb-nohup")
    return exe if os.access(exe, os.X_OK) else None


def spawn(vault: Path) -> bool:
    """Start the server detached unless one is already starting. It inherits
    this environment and this interpreter, so it runs the same code. From a
    tmux pane `wb-nohup` starts it, so the server has a recorded owner; the
    client does not wait for that (wb-nohup itself runs detached)."""
    d = _secure_dir(create=True)
    if not _usable(d, vault):
        return False
    _, lock, _ = paths(vault, d)
    if _lock_held(lock):
        return False
    env = os.environ.copy()
    pkg_root = str(Path(__file__).resolve().parent.parent)
    env["PYTHONPATH"] = os.pathsep.join(
        [pkg_root] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p])
    cmd = [sys.executable, "-m", "braincli.warm", "serve", "--vault", str(Path(vault).resolve())]
    nohup = wb_nohup()
    if nohup:
        cmd = [nohup, "brain-warm-" + (lane() or "suche"), "--", *cmd]
    try:
        subprocess.Popen(
            cmd, env=env, cwd=str(d), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    except OSError:
        return False
    return True


def _recv_all(sock: socket.socket, limit: int) -> bytes:
    chunks, n = [], 0
    while True:
        b = sock.recv(65536)
        if not b:
            return b"".join(chunks)
        chunks.append(b)
        n += len(b)
        if n > limit:
            raise ValueError("message too large")


def ask(vault: Path, request: dict, timeout: float = REPLY_TIMEOUT) -> dict | None:
    """One round trip. None when no server answers (caller goes cold)."""
    d = _secure_dir(create=False)
    if not _usable(d, vault):
        return None
    sock_path, _, _ = paths(vault, d)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(CONNECT_TIMEOUT)
        s.connect(str(sock_path))
        s.settimeout(timeout)
        s.sendall(json.dumps(request, ensure_ascii=False).encode())
        s.shutdown(socket.SHUT_WR)
        raw = _recv_all(s, 64 << 20)
        return json.loads(raw.decode()) if raw else None
    except (OSError, ValueError):
        return None
    finally:
        s.close()


def _cwd() -> str:
    try:
        return os.getcwd()
    except OSError:
        return ""


def try_search(vault: Path, args) -> int | None:
    """`brain search` through the warm process. Returns the exit code when it
    answered (its output already written), None to run the cold path. A
    missing or outdated server is (re)started for the next call."""
    if _SERVING or not enabled():
        return None
    vault = Path(vault)
    request = {
        "p": PROTOCOL,
        "key": code_key(),
        "cwd": _cwd(),
        "vault": str(vault),
        "env": dict(os.environ),
        "args": {"query": args.query, "k": args.k, "json": bool(args.json),
                 "no_validity": bool(getattr(args, "no_validity", False)),
                 "space": getattr(args, "space", None),
                 "rerank": bool(getattr(args, "rerank", False))},
    }
    reply = ask(vault, request)
    if reply is None or reply.get("status") == "stale":
        # none there, or an outdated one on its way out (the new one waits for its lock)
        spawn(vault)
        if warm_only() and not _embed_model_loaded():
            return WARM_ONLY_RC
        return None
    if reply.get("status") != "ok":
        return None
    sys.stdout.write(reply.get("stdout", ""))
    sys.stderr.write(reply.get("stderr", ""))
    sys.stdout.flush()
    return int(reply.get("rc", 0))


def _embed_model_loaded() -> bool:
    """True when Ollama holds the embedding model right now. Then the cold
    path fits the recall deadline (measured 09.10.: 0.9 s), so warm-only
    still answers; without the model it would not (another 1.85 s load)."""
    try:
        import urllib.request

        from gardener import config
        url = config.OLLAMA_URL.rstrip("/") + "/api/ps"
        with urllib.request.urlopen(url, timeout=0.3) as resp:
            data = json.loads(resp.read().decode())
        want = str(getattr(config, "EMBED_MODEL", "embeddinggemma")).split(":")[0]
    except Exception:  # noqa: BLE001 - no answer means: assume cold
        return False
    return any(str(m.get("name") or m.get("model") or "").split(":")[0] == want
               for m in data.get("models", []))


# -- server caches ------------------------------------------------------------

def _stat_key(p: Path) -> tuple | None:
    try:
        st = os.stat(p)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino, st.st_ctime_ns)


def _db_key(p: Path) -> tuple:
    """A SQLite file plus its WAL/SHM: a commit in WAL mode leaves the main
    file untouched."""
    p = Path(p)
    return tuple(_stat_key(Path(str(p) + suffix)) for suffix in ("", "-wal", "-shm"))


def _replace_everywhere(orig, new) -> None:
    """Every module that imported `orig` by name gets `new` (a lazy
    `from x import f` inside a function reads the patched module attribute)."""
    name = orig.__name__
    for mod in list(sys.modules.values()):
        if getattr(mod, name, None) is orig:
            setattr(mod, name, new)


def _dir_key(vault: Path) -> tuple:
    """(dir, mtime, inode) of every directory a note walk enters (same pruning
    as gardener/braincli: dot dirs, config.EXCLUDE_DIRS, symlinks). A file
    added, removed or renamed changes its directory's mtime, so an unchanged
    key means an unchanged file list."""
    from gardener import config
    cf = {d.casefold() for d in config.EXCLUDE_DIRS}
    out = []
    for dirpath, dirnames, _ in os.walk(vault, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames
                             if not d.startswith(".") and d.casefold() not in cf
                             and not os.path.islink(os.path.join(dirpath, d)))
        try:
            st = os.stat(dirpath)
        except OSError:
            return ()
        out.append((dirpath, st.st_mtime_ns, st.st_ino))
    return tuple(out)


def _cached_walk(orig):
    cache: dict[str, tuple[tuple, list]] = {}

    def walk(vault):
        k = str(vault)
        key = _dir_key(Path(vault))  # before the walk: a change during it shows next time
        hit = cache.get(k)
        if hit is None or hit[0] != key or not key:
            hit = (key, orig(vault))
            cache[k] = hit
        return list(hit[1])

    walk.__name__ = orig.__name__
    return walk


QUERY_VECTORS_MAX = 512


def _cache_query_vectors() -> None:
    """The query vector per (Ollama, model, text). Ollama returns the same
    vector for the same single input (checked 28.09.: four calls, one hash),
    so a repeated query - the hook sees the same short prompts again - skips
    the one step that costs 0.15-0.3 s."""
    from collections import OrderedDict

    from gardener import config
    from gardener.ollama import OllamaClient

    orig = OllamaClient.embed
    lru: OrderedDict = OrderedDict()

    def embed(self, text, keep_alive=None):
        if not isinstance(text, str):
            return orig(self, text, keep_alive)
        key = (self.base_url, self.embed_model, text[:config.EMBED_MAX_CHARS])
        vec = lru.get(key)
        if vec is None:
            vec = orig(self, text, keep_alive)
            lru[key] = vec
            if len(lru) > QUERY_VECTORS_MAX:
                lru.popitem(last=False)
        else:
            lru.move_to_end(key)
        return list(vec)

    OllamaClient.embed = embed


def _cache_norms(rangkern, live_vectors) -> None:
    """rangkern.cosine with the note side's norm taken from a table built with
    the very same expression (same floats, same result). The table holds only
    ids of vectors the embeddings cache keeps alive, and is rebuilt whenever
    that cache is, so an id can never point at a different list."""
    import math
    from operator import mul

    orig = rangkern.cosine
    state = {"src": None, "norms": {}}

    def cosine(a, b):
        src = live_vectors()
        if state["src"] is not src:
            state["src"] = src
            state["norms"] = {id(v): (v, math.sqrt(sum(map(mul, v, v)))) for _, v in src}
        hit = state["norms"].get(id(b))
        if hit is None or hit[0] is not b:
            return orig(a, b)
        nb = hit[1]
        if state.get("a") is not a:  # the query vector: once per ranking, not per note
            state["a"], state["na"] = a, math.sqrt(sum(map(mul, a, a)))
        na = state["na"]
        dot = sum(map(mul, a, b))
        return dot / (na * nb) if na and nb else 0.0

    rangkern.cosine = cosine


def install_caches() -> None:
    """Memoise the reads the cold path repeats per query, each keyed by the
    stat of what it read. Only the server calls this."""
    from dataclasses import replace

    from gardener import vault as gvault

    from . import einbettung, search

    orig_parse = gvault.parse_note
    parsed: dict[tuple[str, str], tuple[tuple, object]] = {}

    def parse_note(vault, path):
        path = Path(path)
        key = _stat_key(path)
        ck = (str(vault), str(path))
        hit = parsed.get(ck)
        if key is not None and hit is not None and hit[0] == key:
            n = hit[1]
        else:
            n = orig_parse(vault, path)
            after = _stat_key(path)
            if key is not None and after == key:  # not rewritten while we read it
                parsed[ck] = (key, n)
        # a fresh object with fresh containers: no caller can change the cache
        return replace(n, links=set(n.links), fm=dict(n.fm), aliases=list(n.aliases))

    _replace_everywhere(orig_parse, parse_note)
    _replace_everywhere(gvault.iter_markdown, _cached_walk(gvault.iter_markdown))
    from . import vault as bvault
    _replace_everywhere(bvault.iter_search_markdown, _cached_walk(bvault.iter_search_markdown))

    orig_merged = search.load_merged_embeddings
    merged_cache: dict = {}

    def load_merged_embeddings(store, vault=None):
        from .extra_embed import EXTRA_DB_PATH, extra_db_path
        from gardener import config
        extra = EXTRA_DB_PATH if vault is None else extra_db_path(vault)
        key = (_db_key(config.STATE_DIR / "gardener.db"), _db_key(extra), str(vault))
        if merged_cache.get("key") != key:
            merged_cache["val"] = orig_merged(store, vault)
            merged_cache["key"] = key
        return list(merged_cache["val"])

    search.load_merged_embeddings = load_merged_embeddings

    orig_vec = einbettung.lade_vektoren
    vec_cache: dict = {}

    def lade_vektoren(vault, modell):
        key = (str(vault), modell.name, _db_key(einbettung.index_pfad(vault, modell)))
        hit = vec_cache.get(modell.name)
        if hit is None or hit[0] != key:
            hit = (key, orig_vec(vault, modell))
            vec_cache[modell.name] = hit
        return list(hit[1])

    einbettung.lade_vektoren = lade_vektoren

    orig_lex = search._load_lex_cache
    lex_cache: dict = {}

    def _load_lex_cache(path):
        if path is None:
            return orig_lex(path)
        key = (str(path), _stat_key(Path(path)))
        if lex_cache.get("key") != key:
            lex_cache["val"] = orig_lex(path)
            lex_cache["key"] = key
        return lex_cache["val"]

    search._load_lex_cache = _load_lex_cache

    from . import rangkern
    _cache_query_vectors()
    _cache_norms(rangkern, lambda: merged_cache.get("val") or [])
    orig_retired = getattr(rangkern, "load_retired_notes_from", None)
    if orig_retired is not None:
        retired_cache: dict = {}

        def load_retired_notes_from(path):
            key = (str(path), _db_key(Path(path)))
            if retired_cache.get("key") != key:
                retired_cache["val"] = orig_retired(path)
                retired_cache["key"] = key
            return dict(retired_cache["val"])

        rangkern.load_retired_notes_from = load_retired_notes_from


# -- server -------------------------------------------------------------------

def _peer_uid(conn: socket.socket) -> int | None:
    try:
        if sys.platform == "darwin":
            # SOL_LOCAL=0, LOCAL_PEERCRED=1 -> struct xucred {u_int version; uid_t uid; ...}
            raw = conn.getsockopt(0, 1, 76)
            return struct.unpack_from("=II", raw)[1]
        if hasattr(socket, "SO_PEERCRED"):
            raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            return struct.unpack("3i", raw)[1]
    except OSError:
        return None
    return None


@contextlib.contextmanager
def _request_context(env: dict, cwd: str):
    """The client's environment and working directory for one request (the
    search reads switches like BRAIN_VALIDITY and the usage log reads the role
    from them); the server's own come back afterwards."""
    saved_env = dict(os.environ)
    try:
        saved_cwd = os.getcwd()
    except OSError:
        saved_cwd = "/"
    os.environ.clear()
    os.environ.update(env)
    try:
        if cwd:
            try:
                os.chdir(cwd)
            except OSError:
                pass
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved_env)
        try:
            os.chdir(saved_cwd)
        except OSError:
            pass


def run_search(vault: Path, a: dict) -> tuple[int, str, str]:
    """`cli.cmd_search` itself, with the vault spelled as the client gave it
    (a result is only ever the cold path's result)."""
    from gardener import config

    from . import cli
    config.bind_vault(str(vault))
    ns = argparse.Namespace(vault=str(vault), query=a["query"], k=int(a["k"]),
                            json=bool(a.get("json")), no_validity=bool(a.get("no_validity")),
                            space=a.get("space"), rerank=bool(a.get("rerank")))
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = cli.cmd_search(ns)
    return int(rc or 0), out.getvalue(), err.getvalue()


def _reply(conn: socket.socket, obj: dict) -> None:
    try:
        conn.sendall(json.dumps(obj, ensure_ascii=False).encode())
    except OSError:
        pass


def _lower_priority() -> None:
    try:
        n = int(os.environ.get(NICE_ENV, "") or NICE_DEFAULT)
    except ValueError:
        n = NICE_DEFAULT
    if n > 0:
        with contextlib.suppress(OSError):
            os.nice(n)


def _children_cpu() -> float:
    import resource
    r = resource.getrusage(resource.RUSAGE_CHILDREN)
    return r.ru_utime + r.ru_stime


def _log(log_path: Path, entry: dict) -> None:
    """One JSON line per request; at LOG_MAX the file becomes `.1` (one older file)."""
    try:
        if log_path.exists() and log_path.stat().st_size > LOG_MAX:
            os.replace(log_path, log_path.with_name(log_path.name + ".1"))
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


class _Users:
    """Panes that asked this server, added to its wb-nohup record as users (once each)."""

    def __init__(self) -> None:
        self.seen: set[tuple[str, str]] = set()
        self.procs: list[subprocess.Popen] = []

    def reap(self) -> None:
        self.procs = [p for p in self.procs if p.poll() is None]

    def add(self, env: dict) -> None:
        self.reap()
        pane, tmux = env.get("TMUX_PANE", ""), env.get("TMUX", "")
        if not pane or not tmux or os.environ.get(WB_NOHUP_ENV, "1").strip().lower() in ("0", "off", "false", "no", "nein"):
            return
        sock = tmux.split(",", 1)[0]
        if (pane, sock) in self.seen:
            return
        self.seen.add((pane, sock))
        record = Path.home() / ".local" / "state" / "wb-nohup" / "eigentuemer" / f"{os.getpid()}.json"
        exe = os.environ.get(WB_NOHUP_BIN_ENV, "").strip() or str(Path.home() / ".local" / "bin" / "wb-nohup")
        if not (os.environ.get(WB_NOHUP_BIN_ENV) or record.exists()) or not os.access(exe, os.X_OK):
            return
        with contextlib.suppress(OSError):
            self.procs.append(subprocess.Popen(
                [exe, "benutzer", str(os.getpid()), "--pane", pane, "--socket", sock],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True, close_fds=True))


def _handle(conn: socket.socket, vault: Path, key: str, log_path: Path | None = None,
            users: _Users | None = None) -> bool:
    """Answer one request. False when the server should end (stale code)."""
    conn.settimeout(REPLY_TIMEOUT)
    uid = _peer_uid(conn)
    if uid is not None and uid != os.getuid():
        return True
    try:
        req = json.loads(_recv_all(conn, MAX_REQUEST).decode())
    except (OSError, ValueError):
        return True
    if req.get("p") != PROTOCOL or req.get("key") != key:
        _reply(conn, {"status": "stale"})
        return False
    if Path(req.get("vault") or vault).resolve() != vault:
        _reply(conn, {"status": "error", "error": "other vault"})
        return True
    env = req.get("env") or {}
    t0, c0 = time.monotonic(), _children_cpu()
    status, rc = "ok", None
    try:
        with _request_context(env, req.get("cwd") or ""):
            rc, out, err = run_search(Path(req.get("vault") or vault), req["args"])
    except BaseException as e:  # noqa: BLE001 - any doubt goes cold on the client side
        if isinstance(e, KeyboardInterrupt):
            raise
        status = "error:" + type(e).__name__
        _reply(conn, {"status": "error", "error": type(e).__name__})
    else:
        _reply(conn, {"status": "ok", "rc": rc, "stdout": out, "stderr": err})
    if log_path is not None:
        args = req.get("args") or {}
        _log(log_path, {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "dauer_s": round(time.monotonic() - t0, 3),
            "kind_cpu_s": round(_children_cpu() - c0, 3), "status": status, "rc": rc,
            "pane": env.get("TMUX_PANE", ""), "worker": env.get("WB_WORKER", ""),
            "optionen": sorted(k for k, v in args.items() if k != "query" and v not in (None, False, ""))})
    if users is not None:
        users.add(env)
    return True


def _idle_limit() -> float:
    try:
        return float(os.environ.get(IDLE_ENV, "") or IDLE_DEFAULT)
    except ValueError:
        return IDLE_DEFAULT


def _prime(vault: Path) -> None:
    """Fill the caches and wake the embedding model before taking requests,
    so the first answered request is already warm."""
    from . import search, stats
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            search.search(vault, "brain warm", 5)
            stats.index_health(vault, notes=list(search.LAST_NOTES))
        except Exception:  # noqa: BLE001 - priming is best effort
            pass


def serve(vault: Path) -> int:
    from gardener import config
    vault = Path(vault).resolve()
    d = _secure_dir(create=True)
    if not _usable(d, vault) or not vault.is_dir():
        return 1
    sock_path, lock_path, pid_path = paths(vault, d)
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = time.monotonic() + 5.0
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.monotonic() > deadline:
                os.close(lock_fd)
                return 0  # another server owns this vault
            time.sleep(0.05)

    global _SERVING
    _SERVING = True
    _lower_priority()
    config.bind_vault(str(vault))
    key = code_key()
    install_caches()
    _prime(vault)

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    ino = None

    def cleanup(*_):
        try:
            srv.close()
        except OSError:
            pass
        with contextlib.suppress(OSError):
            if ino is not None and os.stat(sock_path).st_ino == ino:
                os.unlink(sock_path)
        with contextlib.suppress(OSError):
            if pid_path.read_text().strip() == str(os.getpid()):
                os.unlink(pid_path)
        with contextlib.suppress(OSError):
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)

    def on_signal(signum, _frame):
        cleanup()
        os._exit(0)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGHUP, on_signal)
    try:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(sock_path)  # stale: we hold the lock, so nobody serves it
        old = os.umask(0o177)
        try:
            srv.bind(str(sock_path))
        finally:
            os.umask(old)
        os.chmod(sock_path, 0o600)
        ino = os.stat(sock_path).st_ino
        srv.listen(16)
        pid_path.write_text(f"{os.getpid()}\n")
        os.chmod(pid_path, 0o600)
        idle = _idle_limit()
        srv.settimeout(min(TICK, max(idle / 2, 0.2)))
        last = time.monotonic()
        log_path = sock_path.with_suffix(".log")
        users = _Users()
        while True:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                users.reap()
                if (time.monotonic() - last > idle or not vault.is_dir()
                        or code_key() != key):
                    break
                continue
            with conn:
                keep = _handle(conn, vault, key, log_path, users)
            last = time.monotonic()
            if not keep:
                break
    finally:
        cleanup()
    return 0


def status(vault: Path) -> dict:
    d = _secure_dir(create=False)
    if d is None:
        return {"running": False}
    sock_path, lock_path, pid_path = paths(vault, d)
    try:
        pid = int(pid_path.read_text().strip())
    except (OSError, ValueError):
        pid = None
    return {"running": sock_path.exists() and _lock_held(lock_path), "pid": pid,
            "socket": str(sock_path)}


def stop(vault: Path) -> bool:
    st = status(vault)
    if st.get("running") and st.get("pid"):
        try:
            os.kill(st["pid"], signal.SIGTERM)
            return True
        except OSError:
            return False
    return False


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m braincli.warm")
    p.add_argument("cmd", choices=["serve", "status", "stop"])
    p.add_argument("--vault", required=True)
    a = p.parse_args(argv)
    if a.cmd == "serve":
        return serve(Path(a.vault))
    if a.cmd == "status":
        print(json.dumps(status(Path(a.vault))))
        return 0
    return 0 if stop(Path(a.vault)) else 1


if __name__ == "__main__":
    # Run as braincli.warm, not as a second module named __main__: cmd_search
    # must see the _SERVING flag of the very module the server set.
    from braincli import warm as _warm
    sys.exit(_warm.main())
