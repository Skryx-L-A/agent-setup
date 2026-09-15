#!/usr/bin/env python3
"""Lima VZ carrier for one registered VM per Agents world.

The trusted host controller chooses the world and calls this adapter. Guest
work is exposed only through one fixed controller executable with JSON stdin;
no agent-provided command is ever placed in a shell command line.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from agents_remote import RemoteError, make_request


SCHEMA_VERSION = 1
WORLD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
GUEST_CONTROLLER = "/usr/local/libexec/wb-agents-guest-controller"
MAX_CONTROLLER_REQUEST = 64 * 1024
VM_REQUEST_FIELDS = {"host", "world", "request_id", "op", "agent", "run"}


class VMError(Exception):
    """Expected carrier, ownership, configuration, or transport error."""


class VMTransportError(VMError):
    """The external command did not provide a conclusive result."""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def instance_name(world_id: str) -> str:
    """Return a stable Lima-safe instance name without exposing the world ID."""
    if not isinstance(world_id, str) or not WORLD_ID_RE.fullmatch(world_id):
        raise VMError("Weltkennung ist ungueltig")
    # Keep enough room for Lima's SSH socket suffix even under an isolated,
    # deliberately descriptive LIMA_HOME. A collision remains fail-closed as
    # a pre-existing foreign instance and is never adopted.
    digest = hashlib.sha256(world_id.encode("utf-8")).hexdigest()[:12]
    return "wb-agents-" + digest


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".%s." % path.name, dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class LimaVMAdapter:
    """Synchronous, lock-serialized adapter for world-bound Lima instances."""

    def __init__(
        self,
        *,
        lima_home: Path | None = None,
        state_root: Path | None = None,
        config_path: Path | None = None,
        cpus: int = 2,
        memory_gib: int = 2,
        disk_gib: int = 8,
        create_timeout: float = 20 * 60,
        start_timeout: float = 5 * 60,
        stop_timeout: float = 2 * 60,
        exec_timeout: float = 60,
        limactl: str = "limactl",
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        home = Path.home()
        default_config = Path(__file__).resolve().parent / "messungen/agents-vm/lima-vz.yaml"
        self.lima_home = Path(lima_home or home / ".local/share/wb-agents-vm/lima").expanduser().absolute()
        self.state_root = Path(state_root or home / ".local/state/wb-agents-vm").expanduser().absolute()
        self.config_path = Path(config_path or default_config).expanduser().absolute()
        for label, value in (("CPU", cpus), ("RAM", memory_gib), ("Platte", disk_gib)):
            if not isinstance(value, int) or value <= 0:
                raise VMError("%s muss eine positive ganze Zahl sein" % label)
        for label, value in (
            ("Erstellung", create_timeout), ("Start", start_timeout),
            ("Stop", stop_timeout), ("Exec", exec_timeout),
        ):
            if value <= 0:
                raise VMError("%s braucht ein positives Zeitlimit" % label)
        self.cpus = cpus
        self.memory_gib = memory_gib
        self.disk_gib = disk_gib
        self.create_timeout = create_timeout
        self.start_timeout = start_timeout
        self.stop_timeout = stop_timeout
        self.exec_timeout = exec_timeout
        self.limactl = limactl
        self.runner = runner
        self.lima_home.mkdir(parents=True, exist_ok=True)
        self.state_root.mkdir(parents=True, exist_ok=True)

    def _key(self, world_id: str) -> str:
        instance_name(world_id)
        return hashlib.sha256(world_id.encode("utf-8")).hexdigest()

    def _record_path(self, world_id: str) -> Path:
        return self.state_root / "worlds" / (self._key(world_id) + ".json")

    @contextmanager
    def _lock(self, world_id: str) -> Iterator[None]:
        lock_path = self.state_root / "locks" / (self._key(world_id) + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _read_record(self, world_id: str) -> dict[str, Any] | None:
        path = self._record_path(world_id)
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise VMError("VM-Registrierung ist nicht lesbar") from exc
        if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
            raise VMError("VM-Registrierung hat unbekanntes Format")
        if value.get("world_id") != world_id or value.get("instance_name") != instance_name(world_id):
            raise VMError("VM-Registrierung passt nicht zur Welt")
        return value

    def _write_record(self, world_id: str, record: dict[str, Any]) -> None:
        record["updated_at"] = _now()
        _atomic_json(self._record_path(world_id), record)

    def _run(self, arguments: list[str], *, timeout: float,
             stdin: str | None = None) -> subprocess.CompletedProcess[str]:
        command = [self.limactl] + arguments
        environment = dict(os.environ)
        environment["LIMA_HOME"] = str(self.lima_home)
        try:
            completed = self.runner(
                command,
                input=stdin,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                env=environment,
                check=False,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            raise VMTransportError("Lima-Aufruf ohne bestaetigtes Ergebnis") from exc
        if completed.returncode != 0:
            raise VMTransportError("Lima-Aufruf ohne bestaetigtes Ergebnis")
        return completed

    def _inspect(self, name: str) -> dict[str, Any] | None:
        completed = self._run(
            ["list", "--all-fields", "--format", "json"], timeout=15,
        )
        raw = completed.stdout.strip()
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
            values = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError:
            try:
                values = [json.loads(line) for line in raw.splitlines() if line.strip()]
            except json.JSONDecodeError as exc:
                raise VMTransportError("Lima-Status war nicht lesbar") from exc
        matches = [value for value in values
                   if isinstance(value, dict) and value.get("name") == name]
        if len(matches) > 1:
            raise VMError("Lima meldet mehr als eine gleichnamige Instanz")
        return matches[0] if matches else None

    def _profile(self) -> dict[str, int]:
        return {"cpus": self.cpus, "memory_gib": self.memory_gib, "disk_gib": self.disk_gib}

    def _validate_effective_config(self, info: dict[str, Any], record: dict[str, Any]) -> None:
        config = info.get("config")
        if not isinstance(config, dict):
            raise VMError("Effektive Lima-Konfiguration fehlt")
        ssh = config.get("ssh") or {}
        containerd = config.get("containerd") or {}
        mounts = config.get("mounts") or []
        port_forwards = config.get("portForwards") or []
        expected = record["profile"]
        checks = (
            info.get("vmType") == "vz",
            info.get("arch") == "aarch64",
            info.get("cpus") == expected["cpus"],
            info.get("memory") == expected["memory_gib"] * 1024 ** 3,
            info.get("disk") == expected["disk_gib"] * 1024 ** 3,
            config.get("plain") is True,
            mounts == [],
            port_forwards == [],
            ssh.get("forwardAgent") is False,
            ssh.get("overVsock") is True,
            containerd.get("system") is False,
            containerd.get("user") is False,
            info.get("sshAddress") == "127.0.0.1",
        )
        if not all(checks):
            raise VMError("Effektive Lima-Konfiguration verletzt VM-Profil")

    def _safe_instance_dir(self, info: dict[str, Any]) -> Path:
        raw = info.get("dir")
        if not isinstance(raw, str) or not raw:
            raise VMError("Lima-Instanzverzeichnis fehlt")
        try:
            directory = Path(raw).resolve(strict=True)
            lima_root = self.lima_home.resolve(strict=True)
        except OSError as exc:
            raise VMError("Lima-Instanzverzeichnis ist nicht lesbar") from exc
        try:
            directory.relative_to(lima_root)
        except ValueError as exc:
            raise VMError("Lima-Instanz liegt ausserhalb des eigenen LIMA_HOME") from exc
        return directory

    def _marker_path(self, info: dict[str, Any]) -> Path:
        return self._safe_instance_dir(info) / ".wb-agents-vm-owner.json"

    def _write_marker(self, info: dict[str, Any], record: dict[str, Any]) -> None:
        _atomic_json(self._marker_path(info), {
            "schema_version": SCHEMA_VERSION,
            "world_id": record["world_id"],
            "instance_name": record["instance_name"],
            "ownership_token": record["ownership_token"],
        })

    def _marker_matches(self, info: dict[str, Any], record: dict[str, Any]) -> bool:
        try:
            marker = json.loads(self._marker_path(info).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return (
            isinstance(marker, dict)
            and marker.get("world_id") == record.get("world_id")
            and marker.get("instance_name") == record.get("instance_name")
            and secrets.compare_digest(
                str(marker.get("ownership_token", "")), str(record.get("ownership_token", "x")),
            )
        )

    def _guest_identity(self, name: str) -> tuple[str, str]:
        completed = self._run(
            ["shell", name, "--", "/bin/cat", "/etc/machine-id",
             "/proc/sys/kernel/random/boot_id"],
            timeout=self.exec_timeout,
        )
        lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        if len(lines) != 2 or not all(re.fullmatch(r"[A-Za-z0-9-]{16,64}", line) for line in lines):
            raise VMTransportError("Gastidentitaet war nicht eindeutig lesbar")
        return lines[0], lines[1]

    def _owned_status(self, world_id: str, record: dict[str, Any]) -> dict[str, Any]:
        name = record["instance_name"]
        info = self._inspect(name)
        if info is None:
            return {"state": "missing", "world_id": world_id, "instance_name": name}
        if not self._marker_matches(info, record):
            return {"state": "foreign", "world_id": world_id, "instance_name": name,
                    "reason": "Eigentuemer-Marker passt nicht"}
        try:
            self._validate_effective_config(info, record)
        except VMError as exc:
            return {"state": "foreign", "world_id": world_id, "instance_name": name,
                    "reason": str(exc)}
        lima_state = str(info.get("status", "Unknown"))
        if lima_state != "Running":
            record["last_status"] = lima_state.lower()
            record["observed_state"] = lima_state.lower()
            self._write_record(world_id, record)
            return {"state": lima_state.lower(), "world_id": world_id, "instance_name": name,
                    "last_boot_id": record.get("last_boot_id")}
        machine_id, boot_id = self._guest_identity(name)
        known_machine = record.get("machine_id")
        if known_machine and not secrets.compare_digest(str(known_machine), machine_id):
            return {"state": "foreign", "world_id": world_id, "instance_name": name,
                    "reason": "Gastidentitaet hat gewechselt"}
        previous_boot = record.get("last_boot_id")
        record["machine_id"] = machine_id
        record["previous_boot_id"] = previous_boot if previous_boot != boot_id else record.get("previous_boot_id")
        record["last_boot_id"] = boot_id
        record["last_status"] = "running"
        record["observed_state"] = "running"
        self._write_record(world_id, record)
        return {"state": "running", "world_id": world_id, "instance_name": name,
                "machine_id": machine_id, "boot_id": boot_id,
                "boot_changed": bool(previous_boot and previous_boot != boot_id)}

    def status(self, world_id: str) -> dict[str, Any]:
        """Read status without ever starting an instance."""
        name = instance_name(world_id)
        with self._lock(world_id):
            try:
                record = self._read_record(world_id)
                if record is None:
                    return {"state": "foreign" if self._inspect(name) else "absent",
                            "world_id": world_id, "instance_name": name}
                return self._owned_status(world_id, record)
            except VMTransportError as exc:
                return {"state": "unknown", "world_id": world_id, "instance_name": name,
                        "reason": str(exc)}

    def start(self, world_id: str) -> dict[str, Any]:
        """Create if absent, then start only this world's registered instance."""
        name = instance_name(world_id)
        with self._lock(world_id):
            try:
                self._run(["validate", str(self.config_path)], timeout=30)
                record = self._read_record(world_id)
                info = self._inspect(name)
                if record is None:
                    if info is not None:
                        return {"state": "foreign", "world_id": world_id,
                                "instance_name": name, "reason": "Name ist bereits belegt"}
                    record = {
                        "schema_version": SCHEMA_VERSION,
                        "world_id": world_id,
                        "instance_name": name,
                        "ownership_token": secrets.token_hex(32),
                        "profile": self._profile(),
                        "config_path": str(self.config_path),
                        "phase": "registering",
                        "desired_state": "running",
                        "observed_state": "registering",
                        "registered_at": _now(),
                    }
                    self._write_record(world_id, record)
                    self._run([
                        "create", "--tty=false", "--name=" + name,
                        "--cpus=" + str(self.cpus), "--memory=" + str(self.memory_gib),
                        "--disk=" + str(self.disk_gib), str(self.config_path),
                    ], timeout=self.create_timeout)
                    info = self._inspect(name)
                    if info is None:
                        raise VMTransportError("Lima-Erstellung blieb unbestaetigt")
                    self._validate_effective_config(info, record)
                    self._write_marker(info, record)
                    record["phase"] = "owned"
                    record["instance_dir"] = str(self._safe_instance_dir(info))
                    record["last_status"] = str(info.get("status", "unknown")).lower()
                    record["observed_state"] = record["last_status"]
                    self._write_record(world_id, record)
                else:
                    if info is None:
                        return {"state": "missing", "world_id": world_id, "instance_name": name}
                    if not self._marker_matches(info, record):
                        return {"state": "foreign", "world_id": world_id,
                                "instance_name": name, "reason": "Eigentuemer-Marker passt nicht"}
                    self._validate_effective_config(info, record)
                if str(info.get("status")) == "Running":
                    record["desired_state"] = "running"
                    self._write_record(world_id, record)
                    return self._owned_status(world_id, record)
                if str(info.get("status")) != "Stopped":
                    return {"state": "unknown", "world_id": world_id, "instance_name": name,
                            "reason": "Lima-Instanz ist weder Running noch Stopped"}
                record["desired_state"] = "running"
                record["observed_state"] = "starting"
                self._write_record(world_id, record)
                self._run(["start", "--tty=false", name], timeout=self.start_timeout)
                return self._owned_status(world_id, record)
            except VMTransportError as exc:
                return {"state": "unknown", "world_id": world_id, "instance_name": name,
                        "reason": str(exc)}
            except VMError as exc:
                return {"state": "foreign", "world_id": world_id, "instance_name": name,
                        "reason": str(exc)}

    def stop(self, world_id: str) -> dict[str, Any]:
        """Force-stop only an instance whose registry and owner marker agree."""
        name = instance_name(world_id)
        with self._lock(world_id):
            try:
                record = self._read_record(world_id)
                info = self._inspect(name)
                if record is None:
                    return {"state": "foreign" if info else "absent", "world_id": world_id,
                            "instance_name": name, "reason": "Keine eigene Registrierung"}
                if info is None:
                    return {"state": "missing", "world_id": world_id, "instance_name": name}
                if not self._marker_matches(info, record):
                    return {"state": "foreign", "world_id": world_id,
                            "instance_name": name, "reason": "Eigentuemer-Marker passt nicht"}
                self._validate_effective_config(info, record)
                if str(info.get("status")) == "Stopped":
                    record["desired_state"] = "stopped"
                    record["observed_state"] = "stopped"
                    self._write_record(world_id, record)
                    return self._owned_status(world_id, record)
                if str(info.get("status")) != "Running":
                    return {"state": "unknown", "world_id": world_id, "instance_name": name,
                            "reason": "Lima-Instanz ist weder Running noch Stopped"}
                # Check stable guest identity before destructive action. A connection
                # loss is unknown and never relaxes the ownership gate.
                current = self._owned_status(world_id, record)
                if current["state"] != "running":
                    return current
                record["desired_state"] = "stopped"
                record["observed_state"] = "stopping"
                record["stop_snapshot"] = {
                    "machine_id": record.get("machine_id"),
                    "boot_id": record.get("last_boot_id"),
                    "registered_at": _now(),
                }
                self._write_record(world_id, record)
                self._run(["stop", "--force", name], timeout=self.stop_timeout)
                after = self._inspect(name)
                if after is None or str(after.get("status")) != "Stopped":
                    raise VMTransportError("Lima-Stop blieb unbestaetigt")
                record["last_status"] = "stopped"
                record["observed_state"] = "stopped"
                self._write_record(world_id, record)
                return {"state": "stopped", "world_id": world_id, "instance_name": name,
                        "last_boot_id": record.get("last_boot_id")}
            except VMTransportError as exc:
                return {"state": "unknown", "world_id": world_id, "instance_name": name,
                        "reason": str(exc)}
            except VMError as exc:
                return {"state": "foreign", "world_id": world_id, "instance_name": name,
                        "reason": str(exc)}

    def execute_controller(self, world_id: str, request: dict[str, Any]) -> dict[str, Any]:
        """Execute the fixed guest controller once; never retry a lost acknowledgement."""
        name = instance_name(world_id)
        if not isinstance(request, dict) or set(request) != VM_REQUEST_FIELDS:
            raise VMError("Controlleranfrage hat nicht die festen RemoteRequest-Felder")
        request_id = request.get("request_id")
        try:
            remote_request = make_request(
                request["host"], request["world"], request_id,
                request["op"], request["agent"], request["run"],
            )
        except (RemoteError, KeyError, TypeError) as exc:
            raise VMError("Controlleranfrage verletzt RemoteRequest") from exc
        canonical_request = dict(remote_request)
        canonical_request["request_id"] = canonical_request.pop("id")
        if canonical_request != request:
            raise VMError("Controlleranfrage ist nicht kanonisch")
        if canonical_request["world"] != world_id:
            raise VMError("Controlleranfrage gehört zu einer anderen Welt")
        if canonical_request["host"] != name:
            raise VMError("Controlleranfrage gehört zu einem anderen VM-Host")
        try:
            payload = json.dumps(
                canonical_request, ensure_ascii=False, separators=(",", ":"),
                sort_keys=True, allow_nan=False,
            )
        except (TypeError, ValueError) as exc:
            raise VMError("Controlleranfrage ist nicht JSON-faehig") from exc
        if len(payload.encode("utf-8")) > MAX_CONTROLLER_REQUEST:
            raise VMError("Controlleranfrage ist zu gross")
        request_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        with self._lock(world_id):
            try:
                record = self._read_record(world_id)
                if record is None:
                    return {"state": "foreign", "world_id": world_id,
                            "instance_name": name, "reason": "Keine eigene Registrierung"}
                current = self._owned_status(world_id, record)
                if current["state"] != "running":
                    return current
                operations = record.setdefault("operations", {})
                if not isinstance(operations, dict):
                    raise VMError("Operationsregister ist ungueltig")
                existing = operations.get(request_id)
                if existing is not None:
                    if not isinstance(existing, dict) or existing.get("request_sha256") != request_hash:
                        raise VMError("request_id ist an andere Nutzlast gebunden")
                    if existing.get("state") == "ok":
                        return {"state": "ok", "world_id": world_id, "instance_name": name,
                                "boot_id": existing.get("boot_id"),
                                "response": existing.get("response"), "replayed": True}
                    return {"state": "unknown", "world_id": world_id, "instance_name": name,
                            "reason": "Operation wurde bereits ohne sichere Quittung ausgefuehrt",
                            "retry": False}
                operations[request_id] = {
                    "request_sha256": request_hash,
                    "state": "pending",
                    "boot_id": current["boot_id"],
                    "registered_at": _now(),
                }
                self._write_record(world_id, record)
                try:
                    completed = self._run([
                        "shell", name, "--", "/usr/bin/sudo", "--non-interactive",
                        GUEST_CONTROLLER,
                    ], timeout=self.exec_timeout, stdin=payload)
                except VMTransportError as exc:
                    operations[request_id]["state"] = "unknown"
                    operations[request_id]["finished_at"] = _now()
                    self._write_record(world_id, record)
                    return {"state": "unknown", "world_id": world_id,
                            "instance_name": name, "reason": str(exc), "retry": False}
                try:
                    response = json.loads(completed.stdout)
                except json.JSONDecodeError:
                    response = None
                if (not isinstance(response, dict)
                        or set(response) != {"request", "state", "result"}
                        or response.get("request") != canonical_request
                        or response.get("state") != "done"):
                    operations[request_id]["state"] = "unknown"
                    operations[request_id]["finished_at"] = _now()
                    self._write_record(world_id, record)
                    return {"state": "unknown", "world_id": world_id,
                            "instance_name": name,
                            "reason": "Gastquittung passt nicht zur gebundenen Anfrage",
                            "retry": False}
                operations[request_id]["state"] = "ok"
                operations[request_id]["response"] = response
                operations[request_id]["finished_at"] = _now()
                self._write_record(world_id, record)
                return {"state": "ok", "world_id": world_id, "instance_name": name,
                        "boot_id": current["boot_id"], "response": response}
            except VMTransportError as exc:
                return {"state": "unknown", "world_id": world_id, "instance_name": name,
                        "reason": str(exc), "retry": False}
            except VMError as exc:
                return {"state": "foreign", "world_id": world_id, "instance_name": name,
                        "reason": str(exc)}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="World-bound Lima carrier for Agents")
    parser.add_argument("command", choices=("start", "status", "stop", "exec"))
    parser.add_argument("world_id")
    parser.add_argument("--lima-home", type=Path)
    parser.add_argument("--state-root", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--cpus", type=int, default=2)
    parser.add_argument("--memory-gib", type=int, default=2)
    parser.add_argument("--disk-gib", type=int, default=8)
    parser.add_argument("--create-timeout", type=float, default=20 * 60)
    parser.add_argument("--start-timeout", type=float, default=5 * 60)
    parser.add_argument("--stop-timeout", type=float, default=2 * 60)
    parser.add_argument("--exec-timeout", type=float, default=60)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        adapter = LimaVMAdapter(
            lima_home=args.lima_home, state_root=args.state_root, config_path=args.config,
            cpus=args.cpus, memory_gib=args.memory_gib, disk_gib=args.disk_gib,
            create_timeout=args.create_timeout, start_timeout=args.start_timeout,
            stop_timeout=args.stop_timeout, exec_timeout=args.exec_timeout,
        )
        if args.command == "exec":
            try:
                request = json.load(sys.stdin)
            except json.JSONDecodeError as exc:
                raise VMError("stdin enthaelt kein gueltiges JSON") from exc
            result = adapter.execute_controller(args.world_id, request)
        else:
            result = getattr(adapter, args.command)(args.world_id)
    except VMError as exc:
        result = {"state": "error", "reason": str(exc)}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("state") in {"ok", "running", "stopped", "absent", "missing"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
