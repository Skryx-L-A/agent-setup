"""Who may take pipeline proposals over into KERN.md and FALLEN.yaml.

der Nutzer, 10.10.2026 (channel inventory measure 2): the pipeline no longer takes
KERN lines and tripwire counter-measures over automatically; they stay
proposals, and "ok eines Orchestrators reicht".  So `brain run uebernehmen
--ok` runs only for an orchestrator or the human, and the role is MEASURED,
never taken from an argument or the environment:

- human: `wb-mensch pruefen` with a clean environment (exit 0), the same
  check wb-tafel, wb-belegung and the guards use;
- orchestrator: the caller's own tmux pane (``TMUX_PANE``) counts only when
  that pane's process stands in the caller's own parent chain, and its role
  is read with ``~/.claude/hooks/lib/rollen.py`` (pane option AND register,
  strictest reading: a pane either source calls a worker is a worker).

Everything else (a worker, an agent without a pane, a pane variable pointing
at somebody else's pane, a missing helper) is refused.  The limit is the one
wb-mensch and rollen.py name: code that actively hides its origin gets
through; the measured case, a worker that just runs the command, does not.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

BERECHTIGT = ("mensch", "orchestrator")


class NichtBerechtigt(PermissionError):
    pass


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def ist_mensch() -> bool:
    pfad = _home() / ".local" / "bin" / "wb-mensch"
    if not os.access(pfad, os.X_OK):
        return False
    env = {"HOME": str(_home()), "TMPDIR": "/tmp",
           "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
    try:
        return subprocess.run([str(pfad), "pruefen"], stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=15, env=env).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def ahnen() -> set[int]:
    """PIDs of this process's parent chain (without PID 1)."""
    out: set[int] = set()
    pid = os.getpid()
    for _ in range(256):
        try:
            r = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True,
                               text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            break
        s = r.stdout.strip()
        if r.returncode != 0 or not s.isdigit() or int(s) <= 1:
            break
        pid = int(s)
        out.add(pid)
    return out


def rollen_modul():
    pfad = _home() / ".claude" / "hooks" / "lib" / "rollen.py"
    if not pfad.is_file():
        return None
    spec = importlib.util.spec_from_file_location("brain_freigabe_rollen", pfad)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        return None
    return mod


def rolle() -> tuple[str, str]:
    """(role, who): ``mensch`` | ``orchestrator`` | ``worker`` | ``agent``."""
    if ist_mensch():
        return "mensch", "Mensch (wb-mensch)"
    pane = os.environ.get("TMUX_PANE", "")
    if not pane:
        return "agent", "kein tmux-Pane"
    r = rollen_modul()
    if r is None:
        return "agent", "~/.claude/hooks/lib/rollen.py fehlt"
    fakten = r.pane_fakten(pane) or {}
    pane_pid = str(fakten.get("pane_pid", ""))
    if not pane_pid.isdigit():
        return "agent", f"Pane {pane} nicht messbar"
    if int(pane_pid) not in ahnen():
        return "agent", f"Pane {pane} steht nicht in der eigenen Elternkette"
    if r.selbst_ist_worker(pane)[0]:
        return "worker", f"Worker-Pane {pane}"
    if r.rolle_effektiv(pane) == "orchestrator":
        sitzung = fakten.get("sitzung") or "?"
        return "orchestrator", f"Orchestrator-Pane {pane} ({sitzung})"
    return "agent", f"Pane {pane} ohne Orchestrator-Rolle"


def pruefe() -> tuple[str, str]:
    """The measured role if it may approve, else ``NichtBerechtigt``."""
    r, wer = rolle()
    if r not in BERECHTIGT:
        raise NichtBerechtigt(
            f"uebernehmen --ok duerfen nur ein Orchestrator oder der Mensch (gemessen: {r}, {wer}); "
            "die Vorschlaege bleiben stehen")
    return r, wer
