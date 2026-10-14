"""Ownership-tracked lifecycle for the gardener's own MLX judge server.

`linking`, `consolidate`, `maintain`, `synth` and `mine` (the five "smart"
phases, see `grug_client.GrugJudgeClient`) need `grug-server`/`wb-mlx-server`
serving Qwen3.8-27B on port 8080/8081. Unlike `dream/cli.py` (which provisions
its own model via `dream.extract.ensure_grug_server`/`stop_grug_server`
around `extract`/`reconcile`), `gardener/cli.py` never provisioned the model
its five phases depend on - a server that is not running makes every one of
those calls fail identically to an Ollama outage: `GrugJudgeClient.judge()`
retries once, fails, and after `MAX_CONSECUTIVE_FAILURES` in a row raises
`OllamaUnavailable`, which `cli.py`'s `_guard` reports as `ollama_dead` and
skips. That report is technically true but points at the wrong service, and
worse, for a phase that judges FEWER pairs than the failure threshold, every
call quietly returns `{}` and the phase "succeeds" with zero findings - no
error anywhere. This module exists so `cli.py` can provision the server
itself, ONCE, before any smart phase runs, and get a loud, specific error
(`MlxServerError`) if that fails - see `ensure`.

Ownership matters because the server is shared across sessions: a human or
another tool can be judging against it right now. `dream/cli.py`'s
`run_reconcile` calls `stop_grug_server()` unconditionally in `finally`,
regardless of who started the server - safe there only because `dream` holds
its own lock and nothing else is expected to touch the server while it runs.
The gardener has no such guarantee, so `ensure()` records whether THIS call
actually started (or switched) the server, and `release()` only stops it when
that is true. A server this run found already serving the model it needs is
a guest situation: the run must leave it exactly as found."""
from __future__ import annotations

import logging
import re
import subprocess
import dataclasses
import json
import os
import shutil

from .grug_client import GRUG_MODEL_PATH, MLX_ENGINE, SPLASH_ENGINE, JudgeEngine

log = logging.getLogger("gardener")

STATUS_TIMEOUT = 15.0
ENSURE_TIMEOUT = 200.0
STOP_TIMEOUT = 60.0

_PID_RE = re.compile(r"PID (\d+)")
_MODEL_RE = re.compile(r"^\s*Modell: (.+)$", re.MULTILINE)


class MlxServerError(Exception):
    """Provisioning failed BEFORE any smart phase ran - a visibly different
    failure from a server that answered fine here and then died mid-run
    (that one still raises `OllamaUnavailable` from within `grug_client`,
    unchanged, and is reported as `ollama_dead`/"died mid-run" like any
    Ollama outage - see `cli.py`'s `_guard`). The distinction the caller
    must keep visible: "could not start" (this exception) vs. "started fine,
    died later" (the existing `OllamaUnavailable` path)."""


def _status(timeout: float = STATUS_TIMEOUT) -> tuple[int | None, str | None]:
    """(pid, model_path) of whatever MLX model `grug-server`/`wb-mlx-server`
    is currently serving, or `(None, None)` if none is. Read-only - never
    starts or stops anything. Raises `MlxServerError` if the query itself
    fails (transport/timeout): a status that cannot be determined must never
    be silently treated as "nothing running", because that assumption is
    exactly what could make `ensure()` stop someone else's server later."""
    try:
        proc = subprocess.run(["grug-server", "status"], capture_output=True,
                              text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        raise MlxServerError(f"grug-server status failed: {e}") from e
    if proc.returncode != 0:
        return None, None
    pid_m = _PID_RE.search(proc.stdout)
    model_m = _MODEL_RE.search(proc.stdout)
    return (int(pid_m.group(1)) if pid_m else None,
           model_m.group(1).strip() if model_m else None)


def already_serving(timeout: float = STATUS_TIMEOUT) -> bool:
    """True if `grug-server` is already up and serving `GRUG_MODEL_PATH`
    right now. Read-only, exactly what `_status()` is - the one call a dry
    run may make: it wants to know whether a real run would have to
    provision the server (~20 GB), without provisioning it itself to find
    out. Raises `MlxServerError` if the query itself fails, same as
    `_status()` - a dry run must not guess "not running" from a probe that
    could not even ask."""
    if engine_name() == "splash":
        return _splash_status(timeout) is not None
    pid, model = _status(timeout)
    return pid is not None and model == GRUG_MODEL_PATH


# -- Motorwahl (Auftrag g4, 24.09.2026) ---------------------------------------
# Vorgabe ist Splash, sobald `wb-splash-server` da ist: qwen3.8-27B laeuft auf
# dem Mac seit dem 20.09.2026 dort (regeln/lokale-modelle.md). Der Gaertner
# startete bis hierher trotzdem seinen eigenen MLX-Server - ein zweites
# 27B-Modell neben dem laufenden Splash. `GARDENER_JUDGE_ENGINE=mlx` holt den
# alten Weg zurueck (Vergleichsmessung, Splash kaputt).
_active: JudgeEngine | None = None


def engine_name() -> str:
    wahl = os.environ.get("GARDENER_JUDGE_ENGINE", "").strip().lower()
    if wahl in ("splash", "mlx"):
        return wahl
    return "splash" if shutil.which("wb-splash-server") else "mlx"


def active_engine() -> JudgeEngine:
    """Der Motor, gegen den die schlauen Phasen dieses Laufs urteilen - nach
    `ensure()` mit dem vom Server gemeldeten Fenster."""
    if _active is not None:
        return _active
    return SPLASH_ENGINE if engine_name() == "splash" else MLX_ENGINE


def _splash_status(timeout: float = STATUS_TIMEOUT) -> dict | None:
    """JSON-Zeile aus `wb-splash-server status`, None wenn nichts laeuft."""
    try:
        proc = subprocess.run(["wb-splash-server", "status"], capture_output=True,
                              text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        raise MlxServerError(f"wb-splash-server status failed: {e}") from e
    # Ausgabe (Exit immer 0): "laeuft: PID n, bedient '...', Port 8000,
    # /v1/models antwortet" plus JSON-Zeile, oder "nicht aktiv (...)", oder
    # "laeuft: ..., aber /v1/models antwortet NICHT" (haengt - fuer den
    # Richter so gut wie nicht da; ensure startet ihn dann neu).
    erste = proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else ""
    if proc.returncode != 0 or not erste.startswith("laeuft:") \
            or "antwortet NICHT" in erste:
        return None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                pass
    return {}


def _ensure_splash(timeout: float) -> bool:
    global _active
    vorher = _splash_status()
    owned = vorher is None
    if owned:
        try:
            proc = subprocess.run(["wb-splash-server", "ensure", "qwen38"],
                                  capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as e:
            raise MlxServerError(f"wb-splash-server ensure failed: {e}") from e
        if proc.returncode != 0:
            raise MlxServerError(
                "wb-splash-server ensure failed: "
                f"{(proc.stderr or proc.stdout).strip()[-500:]}")
    stand = _splash_status() or {}
    kontext = stand.get("kontext")
    _active = dataclasses.replace(
        SPLASH_ENGINE, context_window=int(kontext) if isinstance(kontext, int)
        and kontext > 0 else SPLASH_ENGINE.context_window)
    if owned:
        log.info("judge: splash started for this run (kontext %s)",
                 _active.context_window)
    else:
        log.info("judge: splash already serving (PID %s, kontext %s) - guest, "
                 "this run will not stop it", stand.get("pid"),
                 _active.context_window)
    return owned


def ensure(timeout: float = ENSURE_TIMEOUT) -> bool:
    """Starts the MLX server for `GRUG_MODEL_PATH` (the model
    `grug_client.call_grug` will address) if it is not already serving it.

    Returns whether THIS call owns the resulting server: `True` if it was
    not running, or was running a DIFFERENT model (so `grug-server ensure`
    just stopped that and started ours - we caused that switch, we clean it
    up); `False` if our exact model was already being served by someone else
    before we touched anything (a guest - `release()` must then do nothing).

    Raises `MlxServerError` if provisioning itself fails, before any smart
    phase runs - see the module and class docstrings for why that must stay
    visibly distinct from a server dying mid-run.

    Auftrag g4: dispatches on `engine_name()` - Splash (default where
    `wb-splash-server` exists) or the MLX `grug-server` path below."""
    global _active
    if engine_name() == "splash":
        return _ensure_splash(timeout)
    _active = MLX_ENGINE
    pre_pid, pre_model = _status()
    owned = not (pre_pid is not None and pre_model == GRUG_MODEL_PATH)
    try:
        proc = subprocess.run(["grug-server", "ensure"], capture_output=True,
                              text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        raise MlxServerError(f"grug-server ensure failed: {e}") from e
    if proc.returncode != 0:
        raise MlxServerError(
            "grug-server ensure failed: "
            f"{(proc.stderr or proc.stdout).strip()[-500:]}")
    if owned:
        log.info("mlx server: provisioned for this run (model=%s)", GRUG_MODEL_PATH)
    else:
        log.info("mlx server: %s was already serving this run's model (PID %s) "
                 "- guest, this run will not stop it", GRUG_MODEL_PATH, pre_pid)
    return owned


def release(owned: bool, timeout: float = STOP_TIMEOUT) -> None:
    """Stops the server only if `ensure()` returned `True` for this run - a
    server this run did not start might be serving someone else right now
    (Prozess-Hygiene: was gestartet wird, wird auch beendet - aber nur, was
    dieser Lauf selbst gestartet hat)."""
    if not owned:
        return
    if engine_name() == "splash":
        subprocess.run(["wb-splash-server", "stop"], capture_output=True,
                       text=True, timeout=timeout)
        return
    subprocess.run(["grug-server", "stop"], capture_output=True, text=True,
                   timeout=timeout)
