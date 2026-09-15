#!/usr/bin/env python3
"""Fail-closed Linux process boundary for :mod:`agents_lauf`.

The trusted controller runs this launcher outside the sandbox.  Each explicit
launch creates one transient systemd user service.  That service contains the
whole bwrap process tree, while the bwrap mount namespace exposes only named
read roots, owned write roots, a minimal host runtime and private proc/dev/tmp.
"""

from __future__ import annotations

import hashlib
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional

import atomar_schreiben
from agents_lauf import LaunchReceipt, Observation, StartSpec


class LinuxLauncherFehler(Exception):
    """Base class for rejected or unverifiable launcher operations."""


class LinuxNichtUnterstuetzt(LinuxLauncherFehler):
    """The host lacks a required Linux execution boundary."""


class LinuxIdentitaetUnklar(LinuxLauncherFehler):
    """A receipt no longer identifies exactly one owned systemd invocation."""


class CheckpointNichtUnterstuetzt(LinuxLauncherFehler):
    """The launcher can freeze a cgroup but cannot prove an app checkpoint."""


_VERSION = 1
_UNIT = re.compile(r"^wb-agents-linux-[a-z0-9-]{1,96}\.service$")
_PREFIX = re.compile(r"^wb-agents-linux-[a-z0-9-]{1,72}-$")
_ENV = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_FIXED_ENV = frozenset({"HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR"})
_DANGEROUS_ENV = frozenset({
    "BASH_ENV", "DBUS_SESSION_BUS_ADDRESS", "DOCKER_HOST", "ENV", "GIT_SSH_COMMAND",
    "LD_AUDIT", "LD_LIBRARY_PATH", "LD_PRELOAD", "NODE_OPTIONS", "PERL5OPT",
    "PYTHONHOME", "PYTHONPATH", "RUBYOPT", "SSH_AGENT_PID", "SSH_AUTH_SOCK",
})
_SECRET_PARTS = frozenset({
    ".aws", ".config", ".docker", ".gnupg", ".kube", ".secrets-sync", ".ssh",
    "90-secrets", ".env",
})
# Nur mit freigegebenem Netz (Zugaenge einer Welt): Namensaufloesung und Zertifikate des Hosts, nur lesend.
_NETZ_DATEIEN = ("/etc/resolv.conf", "/etc/hosts", "/etc/host.conf", "/etc/gai.conf", "/etc/ssl",
                 "/etc/ca-certificates", "/etc/pki")
_SYSTEM_DENY = tuple(Path(value) for value in (
    "/", "/dev", "/etc", "/home", "/proc", "/root", "/run", "/sys", "/tmp",
    "/var/run", "/var/lib/docker",
))


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


@dataclass(frozen=True)
class SocketBinding:
    """Explicit controller channel; never an arbitrary host socket grant."""

    host_path: Path
    guest_path: str
    _identity: tuple[int, int] = field(init=False, repr=False)

    def __post_init__(self):
        object.__setattr__(self, 'host_path', Path(self.host_path))
        if self.guest_path not in {'/run/wb-model.sock', '/run/wb-controller.sock'}:
            raise ValueError('Socket destination is not an Agents channel')
        object.__setattr__(self, '_identity', self._inspect())

    def _inspect(self) -> tuple[int, int]:
        path = self.host_path
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError('Socket source must be an absolute canonical path')
        for parent in reversed(path.parents):
            info = parent.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.geteuid()}
                    or info.st_mode & 0o022):
                raise ValueError('Socket ancestor is not controller-owned and protected')
        parent_info = path.parent.lstat()
        if parent_info.st_uid != os.geteuid() or parent_info.st_mode & 0o077:
            raise ValueError('Socket parent must be a private controller directory')
        info = path.lstat()
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o007):
            raise ValueError('Source must be an owned socket without world access')
        return info.st_dev, info.st_ino

    def validate(self) -> None:
        if self._inspect() != self._identity:
            raise ValueError('Controller socket has been replaced')


def _spec_digest(spec: StartSpec) -> str:
    payload = json.dumps(spec.as_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _proc_identity(pid: int) -> tuple[int, int]:
    """Return process group and Linux start ticks for a currently live PID."""
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        tail = text[text.rfind(")") + 2:].split()
        return int(tail[2]), int(tail[19])
    except (OSError, ValueError, IndexError) as exc:
        raise LinuxIdentitaetUnklar(f"PID {pid} besitzt keine lesbare Startidentitaet") from exc


class LinuxLauncher:
    """Verified ``RunController`` launcher for an unprivileged Linux host.

    ``state_dir`` is controller-owned and must remain outside every exposed
    scope.  Read roots are bind-mounted read-only.  Write roots must already
    exist, be directories owned by the current uid and are the only persistent
    writable host paths visible inside the sandbox.
    """

    # Fail-closed default, also for instances built without ``__init__``: no shared network.
    network = False

    def __init__(
        self,
        state_dir: str | os.PathLike[str],
        *,
        read_paths: Iterable[str | os.PathLike[str]] = (),
        write_paths: Iterable[str | os.PathLike[str]] = (),
        socket_bindings: Iterable[SocketBinding] = (),
        allowed_env_names: Iterable[str] = (),
        unit_prefix: str = "wb-agents-linux-run-",
        stop_timeout: float = 5.0,
        systemctl: Optional[str] = None,
        systemd_run: Optional[str] = None,
        bwrap: Optional[str] = None,
        output_dir: str | os.PathLike[str] | None = None,
        network: bool = False,
    ):
        if sys.platform != "linux":
            raise LinuxNichtUnterstuetzt("Linux-Launcher laeuft nur auf Linux")
        if not _PREFIX.fullmatch(unit_prefix) or not _UNIT.fullmatch(f"{unit_prefix}{'0' * 32}.service"):
            raise ValueError("unit_prefix muss mit wb-agents-linux- beginnen und mit - enden")
        if not isinstance(stop_timeout, (int, float)) or stop_timeout <= 0:
            raise ValueError("stop_timeout muss positiv sein")
        if not isinstance(network, bool):
            raise ValueError("network muss boolesch sein")
        # Ohne Zugaenge bleibt der Netz-Namensraum getrennt; nur ein Zug mit Zugaengen teilt das Hostnetz.
        self.network = network

        self.systemctl = self._tool(systemctl, "systemctl")
        self.systemd_run = self._tool(systemd_run, "systemd-run")
        self.bwrap = self._tool(bwrap, "bwrap")
        self.unit_prefix = unit_prefix
        self.stop_timeout = float(stop_timeout)
        self.state_dir = Path(state_dir).expanduser().resolve(strict=False)
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._require_private_owned_dir(self.state_dir, "state_dir")

        self.read_paths = self._paths(read_paths, writable=False)
        self.write_paths = self._paths(write_paths, writable=True)
        self.socket_bindings = tuple(socket_bindings)
        destinations = set()
        for binding in self.socket_bindings:
            if not isinstance(binding, SocketBinding):
                raise ValueError('Explicit SocketBinding required')
            binding.validate()
            if binding.guest_path in destinations:
                raise ValueError('Duplicate controller channel')
            destinations.add(binding.guest_path)
            if any(_inside(binding.host_path, root) or _inside(root, binding.host_path.parent)
                   for root in (*self.read_paths, *self.write_paths)):
                raise ValueError('Controller socket directory overlaps agent filesystem scope')
        for path in (*self.read_paths, *self.write_paths):
            if _inside(self.state_dir, path) or _inside(path, self.state_dir):
                raise ValueError("state_dir darf in keinem Sandbox-Scope liegen")
        # Standardausgabe und Fehlerausgabe gehen in controllereigene Dateien. systemd
        # oeffnet sie ausserhalb der Sandbox; der Lauf erhaelt nur die Deskriptoren.
        self.output_dir: Optional[Path] = None
        if output_dir is not None:
            self.output_dir = Path(output_dir).expanduser().resolve(strict=True)
            self._require_private_owned_dir(self.output_dir, "output_dir")
            for path in (*self.read_paths, *self.write_paths):
                if _inside(self.output_dir, path) or _inside(path, self.output_dir):
                    raise ValueError("output_dir darf in keinem Sandbox-Scope liegen")
        for read_path in self.read_paths:
            if any(_inside(read_path, write_path) for write_path in self.write_paths):
                raise ValueError("Nur-Lese-Pfad darf nicht innerhalb eines Schreibpfads liegen")

        names = set(allowed_env_names)
        if any(not isinstance(name, str) or not _ENV.fullmatch(name) for name in names):
            raise ValueError("allowed_env_names enthaelt ungueltigen Namen")
        forbidden = names & (_DANGEROUS_ENV | _FIXED_ENV)
        if forbidden:
            raise ValueError("Umgebungsvariable ist fuer den Sandbox-Vertrag gesperrt: " + ", ".join(sorted(forbidden)))
        self.allowed_env_names = frozenset(names)
        self._check_host()

    @staticmethod
    def _tool(value: Optional[str], name: str) -> str:
        resolved = shutil.which(name) if value is None else value
        if not resolved:
            raise LinuxNichtUnterstuetzt(f"{name} fehlt")
        path = Path(resolved).resolve(strict=True)
        if not path.is_file() or not os.access(path, os.X_OK):
            raise LinuxNichtUnterstuetzt(f"{name} ist nicht ausfuehrbar")
        return str(path)

    @staticmethod
    def _require_private_owned_dir(path: Path, field: str) -> None:
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise ValueError(f"{field} muss eigenes Verzeichnis sein")
        if info.st_mode & 0o077:
            raise ValueError(f"{field} darf keine Gruppen-/Fremdrechte haben")

    def _paths(self, values: Iterable[str | os.PathLike[str]], *, writable: bool) -> tuple[Path, ...]:
        result: list[Path] = []
        user_home = Path(pwd.getpwuid(os.geteuid()).pw_dir).resolve(strict=False)
        for value in values:
            raw = Path(value).expanduser()
            if not raw.is_absolute():
                raise ValueError("Sandbox-Pfade muessen absolut sein")
            path = raw.resolve(strict=True)
            if path == user_home or any(path == denied or _inside(denied, path) for denied in _SYSTEM_DENY):
                raise ValueError(f"zu breiter oder systemnaher Sandbox-Pfad: {path}")
            if any(part in _SECRET_PARTS for part in path.parts):
                raise ValueError(f"Secrets-/Konfigurationspfad ist gesperrt: {path}")
            mode = path.stat().st_mode
            if stat.S_ISSOCK(mode):
                raise ValueError(f"Socket darf nicht eingebunden werden: {path}")
            if writable:
                if not path.is_dir() or path.stat().st_uid != os.geteuid():
                    raise ValueError(f"Schreibpfad muss eigenes Verzeichnis sein: {path}")
                if not os.access(path, os.R_OK | os.W_OK | os.X_OK):
                    raise ValueError(f"Schreibpfad ist nicht nutzbar: {path}")
            if path not in result:
                result.append(path)
        result.sort(key=lambda item: (len(item.parts), str(item)))
        return tuple(result)

    def _check_host(self) -> None:
        if not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
            raise LinuxNichtUnterstuetzt("cgroup v2 fehlt")
        result = subprocess.run(
            [self.systemctl, "--user", "show", "--property=Version", "--value"],
            text=True, capture_output=True, timeout=3,
        )
        if result.returncode != 0 or not result.stdout.strip():
            raise LinuxNichtUnterstuetzt("systemd --user ist nicht erreichbar")

    def launch(self, spec: StartSpec) -> LaunchReceipt:
        self._validate_spec(spec)
        for binding in self.socket_bindings:
            binding.validate()
        digest = _spec_digest(spec)
        token = uuid.uuid4().hex
        unit = f"{self.unit_prefix}{uuid.uuid4().hex}.service"
        description = f"wb-agents-linux token={token} spec={digest}"
        record: dict[str, Any] = {
            "version": _VERSION,
            "phase": "starting",
            "unit": unit,
            "token": token,
            "description": description,
            "spec_digest": digest,
            "created_at": time.time(),
        }
        self._write_record(record)
        command = [
            self.systemd_run, "--user", "--quiet", f"--unit={unit}", "--service-type=exec",
            "--remain-after-exit", "--expand-environment=no",
            f"--description={description}",
            "--property=KillMode=control-group", "--property=Restart=no",
            f"--property=TimeoutStopSec={self.stop_timeout}s", "--property=SendSIGKILL=yes",
            "--property=UMask=0077", "--property=Delegate=no",
            *self._output_properties(unit),
            *self._bwrap_command(spec),
        ]
        try:
            result = subprocess.run(command, text=True, capture_output=True, timeout=10)
        except subprocess.TimeoutExpired as exc:
            self._abort_launch(record, "systemd-run Zeitgrenze erreicht")
            raise LinuxLauncherFehler("transiente systemd-Unit antwortete nicht rechtzeitig") from exc
        if result.returncode != 0:
            self._abort_launch(record, (result.stderr or result.stdout).strip()[:500])
            raise LinuxLauncherFehler("transiente systemd-Unit konnte nicht gestartet werden")
        properties = self._wait_properties(unit, lambda value: int(value.get("MainPID", "0")) > 0)
        if properties is None or not self._description_matches(record, properties):
            self._abort_launch(record, "gestartete Unit besitzt keine bestaetigte Identitaet")
            raise LinuxIdentitaetUnklar("gestartete Unit besitzt keine bestaetigte Identitaet")
        pid = int(properties["MainPID"])
        pgid, start_ticks = _proc_identity(pid)
        record.update({
            "phase": "running", "invocation_id": properties["InvocationID"], "main_pid": pid,
            "process_group_id": pgid, "start_ticks": start_ticks,
            "control_group": properties["ControlGroup"],
        })
        self._write_record(record)
        receipt = self._receipt(record)
        if not self.verify(receipt, spec):
            self._abort_launch(record, "Launcher-Receipt konnte nach Start nicht bestaetigt werden")
            raise LinuxIdentitaetUnklar("Launcher-Receipt konnte nach Start nicht bestaetigt werden")
        return receipt

    def verify(self, receipt: LaunchReceipt, spec: Optional[StartSpec]) -> bool:
        try:
            identity, record = self._owned_identity(receipt)
            if spec is not None and identity["spec_digest"] != _spec_digest(spec):
                return False
            if record.get("phase") == "stopped":
                return True
            properties = self._show(identity["unit"])
            if not self._properties_match(identity, properties):
                return False
            if properties.get("SubState") == "running":
                pgid, ticks = _proc_identity(receipt.pid)
                return pgid == receipt.process_group_id and ticks == identity["start_ticks"] and self._pid_in_cgroup(receipt.pid, identity["control_group"])
            return properties.get("SubState") in {"exited", "failed", "dead"}
        except (LinuxLauncherFehler, OSError, ValueError, KeyError):
            return False

    def observe(self, receipt: LaunchReceipt, spec: StartSpec) -> Observation:
        try:
            identity, record = self._owned_identity(receipt)
            if identity["spec_digest"] != _spec_digest(spec):
                return Observation("unclear", False)
            if record.get("phase") == "stopped":
                return Observation("stopped", True, record.get("exit_code"))
            properties = self._show(identity["unit"])
            if not self._properties_match(identity, properties):
                if record.get("phase") == "terminating" and properties.get("LoadState") == "not-found":
                    self._mark_stopped(record, None)
                    return Observation("stopped", True)
                return Observation("unclear", False)
            substate = properties.get("SubState")
            if substate in {"exited", "failed", "dead"} or properties.get("ActiveState") == "failed":
                exit_code = self._exit_code(properties)
                self._mark_stopped(record, exit_code)
                self._stop_loaded_unit(identity["unit"])
                return Observation("stopped", True, exit_code)
            if substate != "running" or not self.verify(receipt, spec):
                return Observation("unclear", False)
            return Observation("paused" if properties.get("FreezerState") == "frozen" else "running", True)
        except (LinuxLauncherFehler, OSError, ValueError, KeyError):
            return Observation("unclear", False)

    def request_pause(self, receipt: LaunchReceipt) -> None:
        self._require_live(receipt)
        raise CheckpointNichtUnterstuetzt(
            "Pause am naechsten Anwendungscheckpoint braucht einen belegten Harnessadapter"
        )

    def freeze(self, receipt: LaunchReceipt) -> None:
        """Freeze the exact unit cgroup without claiming an app checkpoint."""
        identity, _ = self._require_live(receipt)
        self._systemctl("freeze", identity["unit"])
        if self._wait_properties(identity["unit"], lambda value: value.get("FreezerState") == "frozen") is None:
            raise LinuxLauncherFehler("cgroup-Pause wurde nicht bestaetigt")

    def resume(self, receipt: LaunchReceipt) -> None:
        self.thaw(receipt)

    def thaw(self, receipt: LaunchReceipt) -> None:
        """Thaw an exact unit cgroup previously frozen by :meth:`freeze`."""
        identity, _ = self._require_live(receipt)
        self._systemctl("thaw", identity["unit"])
        if self._wait_properties(identity["unit"], lambda value: value.get("FreezerState") == "running") is None:
            raise LinuxLauncherFehler("cgroup-Fortsetzung wurde nicht bestaetigt")

    def confirm_checkpoint(self, receipt: LaunchReceipt, spec: StartSpec, checkpoint_id: str) -> Observation:
        if not self.verify(receipt, spec):
            return Observation("unclear", False)
        raise CheckpointNichtUnterstuetzt(
            "systemd freeze ist kein Anwendungscheckpoint; Checkpoint-Bestaetigung nicht unterstuetzt"
        )

    def terminate(self, receipt: LaunchReceipt) -> None:
        identity, record = self._require_live(receipt, allow_paused=True)
        if self._show(identity["unit"]).get("FreezerState") == "frozen":
            self._systemctl("thaw", identity["unit"])
            if self._wait_properties(identity["unit"], lambda value: value.get("FreezerState") == "running") is None:
                raise LinuxLauncherFehler("pausierte cgroup konnte vor Stop nicht aufgetaut werden")
        record["phase"] = "terminating"
        self._write_record(record)
        self._systemctl("stop", identity["unit"], timeout=self.stop_timeout + 3)
        properties = self._wait_properties(
            identity["unit"],
            lambda value: value.get("LoadState") == "not-found" or value.get("ActiveState") == "inactive",
        )
        if properties is None or self._cgroup_pids(identity["control_group"]):
            raise LinuxLauncherFehler("systemd bestaetigt das Ende der eigenen cgroup nicht")
        self._mark_stopped(record, None)

    def resolve(self, world: str, agent: str, run_id: str, spec: StartSpec) -> Optional[LaunchReceipt]:
        """Recover one exact pre-receipt launch; never start a replacement."""
        del world, agent, run_id
        digest = _spec_digest(spec)
        candidates: list[LaunchReceipt] = []
        for path in self.state_dir.glob(f"{self.unit_prefix}*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("spec_digest") != digest or record.get("phase") == "stopped":
                    continue
                if record.get("phase") == "starting":
                    properties = self._show(record["unit"])
                    if not self._description_matches(record, properties):
                        continue
                    pid = int(properties.get("MainPID", "0"))
                    if pid <= 0:
                        continue
                    pgid, ticks = _proc_identity(pid)
                    record.update({
                        "phase": "running", "invocation_id": properties["InvocationID"],
                        "main_pid": pid, "process_group_id": pgid, "start_ticks": ticks,
                        "control_group": properties["ControlGroup"],
                    })
                    self._write_record(record)
                receipt = self._receipt(record)
                if self.verify(receipt, spec):
                    candidates.append(receipt)
            except (OSError, ValueError, KeyError, LinuxLauncherFehler):
                continue
        return candidates[0] if len(candidates) == 1 else None

    def output_paths(self, receipt: LaunchReceipt) -> tuple[Path, Path]:
        """Return the controller-owned stdout and stderr files of one owned receipt."""
        if self.output_dir is None:
            raise LinuxLauncherFehler("Launcher erfasst keine Ausgabe")
        identity, _ = self._owned_identity(receipt)
        return self._output_files(str(identity["unit"]))

    def beendet_belegt(self, world: str, agent: str, run_id: str, spec: StartSpec,
                       receipt: Optional[LaunchReceipt] = None) -> bool:
        """Belegt, dass zu dieser Startbeschreibung keine eigene Unit mehr laeuft.

        Geprueft werden alle Receiptdateien mit demselben Spec-Digest, ihre cgroups und
        jede geladene Unit dieses Praefixes, deren Beschreibung den Digest traegt. Nur wenn
        nirgends ein aktiver Prozess steht, gilt das Ende als belegt. Es wird nichts beendet.
        """
        del world, agent, run_id
        digest = _spec_digest(spec)
        active_states = {"active", "activating", "deactivating", "reloading", "refreshing"}
        units: set[str] = set()
        for path in self.state_dir.glob(f"{self.unit_prefix}*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return False
            if record.get("spec_digest") != digest:
                continue
            units.add(str(record.get("unit")))
            if record.get("control_group") and self._cgroup_pids(str(record["control_group"])):
                return False
        receipt_unit = ""
        if receipt is not None:
            try:
                receipt_unit = str(json.loads(receipt.identity)["unit"])
            except (TypeError, ValueError, KeyError):
                return False
            units.add(receipt_unit)
        listing = subprocess.run(
            [self.systemctl, "--user", "list-units", f"{self.unit_prefix}*", "--all", "--no-legend", "--plain"],
            text=True, capture_output=True, timeout=5,
        )
        if listing.returncode != 0:
            return False
        units.update(line.split()[0] for line in listing.stdout.splitlines() if line.strip())
        for unit in sorted(units):
            if not _UNIT.fullmatch(unit) or not unit.startswith(self.unit_prefix):
                continue
            properties = self._show(unit)
            if properties.get("LoadState") == "not-found":
                continue
            if f"spec={digest}" not in properties.get("Description", "") and unit != receipt_unit:
                continue
            if properties.get("ActiveState") in active_states:
                return False
            if properties.get("ControlGroup") and self._cgroup_pids(properties["ControlGroup"]):
                return False
        return True

    def cgroup_members(self, receipt: LaunchReceipt) -> tuple[int, ...]:
        """Return current host PIDs of the owned unit cgroup, for diagnostics and proofs."""
        identity, _ = self._owned_identity(receipt)
        return self._cgroup_pids(str(identity["control_group"]))

    def _output_files(self, unit: str) -> tuple[Path, Path]:
        assert self.output_dir is not None
        self._record_path(unit)
        return self.output_dir / f"{unit}.stdout", self.output_dir / f"{unit}.stderr"

    def _output_properties(self, unit: str) -> list[str]:
        if self.output_dir is None:
            return []
        stdout, stderr = self._output_files(unit)
        return [f"--property=StandardOutput=append:{stdout}", f"--property=StandardError=append:{stderr}"]

    def receipt_details(self, receipt: LaunchReceipt) -> Mapping[str, Any]:
        """Return a copy of the launcher identity for controller diagnostics."""
        identity, _ = self._owned_identity(receipt)
        return dict(identity)

    def _validate_spec(self, spec: StartSpec) -> None:
        if not isinstance(spec, StartSpec):
            raise ValueError("StartSpec fehlt")
        cwd = Path(spec.cwd).resolve(strict=True)
        if not cwd.is_dir() or not any(_inside(cwd, root) for root in (*self.read_paths, *self.write_paths)):
            raise ValueError("cwd liegt ausserhalb benannter Sandbox-Pfade")
        executable = Path(spec.argv[0])
        if not executable.is_absolute() or not executable.exists() or not os.access(executable, os.X_OK):
            raise ValueError("argv[0] muss absolute ausfuehrbare Datei sein")
        resolved_executable = executable.resolve(strict=True)
        if not (_inside(resolved_executable, Path("/usr")) or any(
                _inside(resolved_executable, root) for root in (*self.read_paths, *self.write_paths))):
            raise ValueError("argv[0] liegt ausserhalb sichtbarer Laufzeit-/Sandbox-Pfade")
        env = dict(spec.env)
        if len(env) != len(spec.env):
            raise ValueError("env enthaelt doppelte Namen")
        if set(env) - self.allowed_env_names:
            raise ValueError("env enthaelt nicht freigegebene Namen")

    def _bwrap_command(self, spec: StartSpec) -> list[str]:
        uid = os.geteuid()
        account = pwd.getpwuid(uid).pw_name
        command = [
            self.bwrap, "--unshare-user", "--disable-userns", "--unshare-pid",
            "--share-net" if self.network else "--unshare-net",
            "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--new-session",
            "--die-with-parent", "--cap-drop", "ALL", "--clearenv", "--hostname", "wb-agent",
            "--ro-bind", "/usr", "/usr",
        ]
        for destination in ("/bin", "/sbin", "/lib", "/lib64"):
            path = Path(destination)
            if path.is_symlink():
                command.extend(("--symlink", os.readlink(path), destination))
            elif path.exists():
                command.extend(("--ro-bind", destination, destination))
        for path in ("/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ld.so.cache"):
            if Path(path).exists():
                command.extend(("--ro-bind", path, path))
        if self.network:
            for path in _NETZ_DATEIEN:
                # /etc/resolv.conf zeigt oft nach /run (systemd-resolved); /run ist im Zug privat, also das Ziel binden.
                source = Path(path).resolve(strict=False)
                if source.exists():
                    command.extend(("--ro-bind", str(source), path))
        command.extend((
            "--proc", "/proc", "--dev", "/dev",
            "--size", str(256 * 1024 * 1024), "--perms", "0700", "--tmpfs", "/tmp",
            "--size", str(16 * 1024 * 1024), "--perms", "0700", "--tmpfs", "/run",
            "--dir", "/home", "--perms", "0700", "--dir", "/home/agent",
            "--dir", "/run/user", "--perms", "0700", "--dir", f"/run/user/{uid}",
        ))
        for path in self.read_paths:
            command.extend(("--ro-bind", str(path), str(path)))
        for path in self.write_paths:
            command.extend(("--bind", str(path), str(path)))
        for binding in self.socket_bindings:
            binding.validate()
            command.extend(("--ro-bind", str(binding.host_path), binding.guest_path))
        environment = {
            "HOME": "/home/agent", "PATH": "/usr/local/bin:/usr/bin:/bin", "TMPDIR": "/tmp",
            "USER": account, "LOGNAME": account, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "XDG_RUNTIME_DIR": f"/run/user/{uid}", **dict(spec.env),
        }
        for name, value in sorted(environment.items()):
            command.extend(("--setenv", name, value))
        command.extend(("--chdir", spec.cwd, "--", *spec.argv))
        return command

    def _require_live(self, receipt: LaunchReceipt, *, allow_paused: bool = True) -> tuple[dict[str, Any], dict[str, Any]]:
        identity, record = self._owned_identity(receipt)
        properties = self._show(identity["unit"])
        if not self._properties_match(identity, properties):
            raise LinuxIdentitaetUnklar("Unit-Identitaet passt nicht zum Receipt")
        if properties.get("SubState") != "running":
            raise LinuxIdentitaetUnklar("Receipt bezeichnet keinen laufenden Prozess")
        if not allow_paused and properties.get("FreezerState") == "frozen":
            raise LinuxLauncherFehler("Operation auf pausiertem Lauf gesperrt")
        return identity, record

    def _owned_identity(self, receipt: LaunchReceipt) -> tuple[dict[str, Any], dict[str, Any]]:
        if not isinstance(receipt, LaunchReceipt):
            raise LinuxIdentitaetUnklar("ungueltiges Receipt")
        try:
            identity = json.loads(receipt.identity)
        except (TypeError, ValueError) as exc:
            raise LinuxIdentitaetUnklar("Receipt-Identitaet ist unlesbar") from exc
        required = {"version", "unit", "token", "description", "spec_digest", "invocation_id", "main_pid", "process_group_id", "start_ticks", "control_group"}
        if not isinstance(identity, dict) or set(identity) != required or identity.get("version") != _VERSION:
            raise LinuxIdentitaetUnklar("Receipt-Identitaet hat unbekanntes Format")
        if not _UNIT.fullmatch(str(identity["unit"])) or not str(identity["unit"]).startswith(self.unit_prefix):
            raise LinuxIdentitaetUnklar("Receipt-Unit gehoert nicht diesem Launcher")
        if receipt.pid != identity["main_pid"] or receipt.process_group_id != identity["process_group_id"]:
            raise LinuxIdentitaetUnklar("Receipt-PID/PGID widerspricht Identitaet")
        record = self._read_record(identity["unit"])
        if any(record.get(key) != identity[key] for key in required):
            raise LinuxIdentitaetUnklar("controllerseitiges Receipt passt nicht")
        return identity, record

    @staticmethod
    def _identity(record: Mapping[str, Any]) -> dict[str, Any]:
        keys = ("version", "unit", "token", "description", "spec_digest", "invocation_id", "main_pid", "process_group_id", "start_ticks", "control_group")
        return {key: record[key] for key in keys}

    def _receipt(self, record: Mapping[str, Any]) -> LaunchReceipt:
        identity = self._identity(record)
        encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"))
        return LaunchReceipt(int(record["main_pid"]), int(record["process_group_id"]), encoded)

    def _record_path(self, unit: str) -> Path:
        if not _UNIT.fullmatch(unit) or not unit.startswith(self.unit_prefix):
            raise LinuxIdentitaetUnklar("ungueltiger Unitname")
        return self.state_dir / f"{unit}.json"

    def _write_record(self, record: Mapping[str, Any]) -> None:
        atomar_schreiben.schreiben(
            self._record_path(str(record["unit"])),
            json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            modus=0o600,
            dauerhaft=True,
        )

    def _read_record(self, unit: str) -> dict[str, Any]:
        try:
            value = json.loads(self._record_path(unit).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise LinuxIdentitaetUnklar("Launcher-Receiptdatei fehlt oder ist unlesbar") from exc
        if not isinstance(value, dict) or value.get("version") != _VERSION or value.get("unit") != unit:
            raise LinuxIdentitaetUnklar("Launcher-Receiptdatei ist ungueltig")
        return value

    def _show(self, unit: str) -> dict[str, str]:
        fields = "Id,Description,LoadState,ActiveState,SubState,InvocationID,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus,Result,ControlGroup,FreezerState,KillMode,Restart,Delegate"
        result = subprocess.run(
            [self.systemctl, "--user", "show", unit, f"--property={fields}"],
            text=True, capture_output=True, timeout=3,
        )
        values: dict[str, str] = {}
        for line in result.stdout.splitlines():
            key, separator, value = line.partition("=")
            if separator:
                values[key] = value
        if result.returncode != 0 and not values:
            values["LoadState"] = "not-found"
        return values

    def _wait_properties(self, unit: str, predicate: Any, timeout: float = 4.0) -> Optional[dict[str, str]]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            properties = self._show(unit)
            if predicate(properties):
                return properties
            time.sleep(0.05)
        return None

    @staticmethod
    def _description_matches(record: Mapping[str, Any], properties: Mapping[str, str]) -> bool:
        return (
            properties.get("LoadState") == "loaded"
            and properties.get("Id") == record.get("unit")
            and properties.get("Description") == record.get("description")
            and bool(properties.get("InvocationID"))
            and properties.get("KillMode") == "control-group"
            and properties.get("Restart") == "no"
            and properties.get("Delegate") == "no"
        )

    @classmethod
    def _properties_match(cls, identity: Mapping[str, Any], properties: Mapping[str, str]) -> bool:
        if not cls._description_matches(identity, properties):
            return False
        try:
            executable_pid = int(properties.get("ExecMainPID", "0"))
        except ValueError:
            return False
        if properties.get("InvocationID") != identity.get("invocation_id") or executable_pid != identity.get("main_pid"):
            return False
        if properties.get("SubState") == "running":
            return properties.get("ControlGroup") == identity.get("control_group")
        return properties.get("SubState") in {"exited", "failed", "dead"}

    @staticmethod
    def _pid_in_cgroup(pid: int, control_group: str) -> bool:
        try:
            for line in Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8").splitlines():
                if line.partition("::")[2] == control_group:
                    return True
        except OSError:
            pass
        return False

    @staticmethod
    def _cgroup_pids(control_group: str) -> tuple[int, ...]:
        path = Path("/sys/fs/cgroup") / control_group.lstrip("/") / "cgroup.procs"
        try:
            return tuple(int(value) for value in path.read_text(encoding="utf-8").split())
        except FileNotFoundError:
            return ()
        except (OSError, ValueError) as exc:
            raise LinuxIdentitaetUnklar("cgroup-Mitgliedschaft ist unlesbar") from exc

    @staticmethod
    def _exit_code(properties: Mapping[str, str]) -> Optional[int]:
        try:
            return int(properties["ExecMainStatus"])
        except (KeyError, ValueError):
            return None

    def _mark_stopped(self, record: dict[str, Any], exit_code: Optional[int]) -> None:
        record["phase"] = "stopped"
        record["exit_code"] = exit_code
        record["stopped_at"] = time.time()
        self._write_record(record)

    def _abort_launch(self, record: dict[str, Any], reason: str) -> None:
        """Stop only the unique unit from this failed launch and record the proof."""
        record["phase"] = "aborting"
        record["launch_error"] = reason
        self._write_record(record)
        unit = str(record["unit"])
        try:
            before = self._show(unit)
        except (OSError, subprocess.TimeoutExpired):
            before = {}
        control_group = before.get("ControlGroup", "")
        result: Optional[subprocess.CompletedProcess[str]] = None
        try:
            result = subprocess.run(
                [self.systemctl, "--user", "stop", unit], text=True, capture_output=True,
                timeout=self.stop_timeout + 3,
            )
            after = self._wait_properties(
                unit,
                lambda value: value.get("LoadState") == "not-found" or value.get("ActiveState") == "inactive",
            )
        except (OSError, subprocess.TimeoutExpired):
            after = None
        try:
            empty = not control_group or not self._cgroup_pids(control_group)
        except LinuxLauncherFehler:
            empty = False
        record["cleanup_verified"] = bool(after is not None and empty)
        if result is None:
            record["cleanup_error"] = "systemctl stop antwortete nicht"
        elif result.returncode != 0 and before.get("LoadState") == "loaded":
            record["cleanup_error"] = (result.stderr or result.stdout).strip()[:500]
        record["phase"] = "stopped" if record["cleanup_verified"] else "unclear"
        record["stopped_at"] = time.time()
        self._write_record(record)

    def _stop_loaded_unit(self, unit: str) -> None:
        try:
            self._systemctl("stop", unit, timeout=self.stop_timeout + 3)
        except LinuxLauncherFehler:
            pass
        properties = self._show(unit)
        if properties.get("LoadState") == "loaded" and properties.get("ActiveState") == "failed":
            try:
                self._systemctl("reset-failed", unit)
            except LinuxLauncherFehler:
                pass

    def _systemctl(self, action: str, unit: str, *, timeout: Optional[float] = None) -> None:
        if not _UNIT.fullmatch(unit) or not unit.startswith(self.unit_prefix):
            raise LinuxIdentitaetUnklar("fremde Unit wird nicht angesteuert")
        result = subprocess.run(
            [self.systemctl, "--user", action, unit], text=True, capture_output=True,
            timeout=self.stop_timeout + 3 if timeout is None else timeout,
        )
        if result.returncode != 0:
            raise LinuxLauncherFehler(f"systemctl {action} ist fehlgeschlagen")


__all__ = [
    "CheckpointNichtUnterstuetzt", "LinuxIdentitaetUnklar", "LinuxLauncher",
    "LinuxLauncherFehler", "LinuxNichtUnterstuetzt",
]
