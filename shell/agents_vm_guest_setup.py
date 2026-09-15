#!/usr/bin/env python3
"""Provision the fixed unprivileged controller into one owned Lima VM."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

from agents_vm import LimaVMAdapter, VMError, VMTransportError, instance_name


AGENT_USER = "wb-agent"
CONTROLLER_DIR = "/usr/local/libexec/wb-agents-controller"
WRAPPER_PATH = "/usr/local/libexec/wb-agents-guest-controller"
CONFIG_PATH = "/home/wb-agent/.local/state/wb-agents-vm/controller.json"
STATE_DIR = "/home/wb-agent/.local/state/wb-agents-vm"
WORK_DIR = "/var/lib/wb-agents-vm/work/dummy"
SOURCE_NAMES = (
    "agents_remote_endpoint.py", "agents_remote.py", "agents_linux.py",
    "agents_lauf.py", "atomar_schreiben.py",
)


DUMMY_SOURCE = r'''#!/usr/bin/python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time

child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(86400)"],
    start_new_session=True,
)
path = Path("dummy-processes.json")
with path.open("w", encoding="utf-8") as handle:
    json.dump({"parent_pid": os.getpid(), "child_pid": child.pid,
               "child_session": os.getsid(child.pid)}, handle, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
while True:
    time.sleep(3600)
'''


GUEST_INSTALLER = r'''
import base64
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tempfile

payload = json.loads(base64.b64decode(PAYLOAD_B64))
world = payload["world_id"]
host = payload["host_id"]
agent_user = "wb-agent"
home = Path("/home/wb-agent")
controller_dir = Path("/usr/local/libexec/wb-agents-controller")
wrapper_path = Path("/usr/local/libexec/wb-agents-guest-controller")
state_dir = home / ".local/state/wb-agents-vm"
config_path = state_dir / "controller.json"
work_dir = Path("/var/lib/wb-agents-vm/work/dummy")
marker_path = controller_dir / ".provision.json"

if os.geteuid() != 0:
    raise RuntimeError("guest provisioning requires root")
if not all(isinstance(value, str) and value for value in (world, host)):
    raise RuntimeError("invalid guest binding")

try:
    account = pwd.getpwnam(agent_user)
except KeyError:
    subprocess.run([
        "/usr/sbin/useradd", "--system", "--create-home", "--home-dir", str(home),
        "--shell", "/usr/sbin/nologin", agent_user,
    ], check=True, timeout=30)
    account = pwd.getpwnam(agent_user)
if account.pw_uid == 0 or account.pw_dir != str(home):
    raise RuntimeError("existing guest user has unexpected identity")

if marker_path.exists():
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    if marker.get("world_id") != world or marker.get("host_id") != host:
        raise RuntimeError("controller directory belongs to another VM binding")

if shutil.which("bwrap") is None:
    apt_env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive",
               "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    subprocess.run(["/usr/bin/apt-get", "update"], check=True, timeout=180, env=apt_env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "/usr/bin/apt-get", "install", "-y", "--no-install-recommends", "bubblewrap",
    ], check=True, timeout=180, env=apt_env,
       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
bwrap = Path(shutil.which("bwrap") or "").resolve(strict=True)
if bwrap != Path("/usr/bin/bwrap"):
    raise RuntimeError("unexpected bubblewrap path")

def directory(path, mode, uid, gid):
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError("unsafe directory")
    os.chown(path, uid, gid)
    os.chmod(path, mode)

def atomic_write(path, data, mode, uid, gid):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, uid, gid)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

uid, gid = account.pw_uid, account.pw_gid
directory(home, 0o700, uid, gid)
directory(home / ".local", 0o700, uid, gid)
directory(home / ".local/state", 0o700, uid, gid)
directory(state_dir, 0o700, uid, gid)
directory(Path("/var/lib/wb-agents-vm"), 0o755, 0, 0)
directory(Path("/var/lib/wb-agents-vm/work"), 0o755, 0, 0)
directory(work_dir, 0o700, uid, gid)
directory(controller_dir, 0o755, 0, 0)

expected_names = {"agents_remote_endpoint.py", "agents_remote.py", "agents_linux.py",
                  "agents_lauf.py", "atomar_schreiben.py", "dummy_agent.py", "guest-controller"}
if set(payload["files"]) != expected_names:
    raise RuntimeError("unexpected controller bundle")
for name, item in payload["files"].items():
    data = base64.b64decode(item["data"], validate=True)
    if hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise RuntimeError("controller source hash mismatch")
    if name == "guest-controller":
        atomic_write(wrapper_path, data, 0o755, 0, 0)
    else:
        atomic_write(controller_dir / name, data, 0o644, 0, 0)

config = {
    "enabled": True,
    "host_id": host,
    "world_id": world,
    "state_dir": str(state_dir),
    "bwrap": str(bwrap),
    "agents": {
        "dummy": {
            "read_paths": [],
            "write_paths": [str(work_dir)],
            "allowed_env_names": [],
            "start": {
                "argv": ["/usr/bin/python3", str(controller_dir / "dummy_agent.py")],
                "cwd": str(work_dir),
                "env": [],
            },
        },
    },
}
atomic_write(config_path, (json.dumps(config, indent=2, sort_keys=True) + "\n").encode(),
             0o600, uid, gid)
marker = {"world_id": world, "host_id": host, "bundle_sha256": payload["bundle_sha256"]}
atomic_write(marker_path, (json.dumps(marker, sort_keys=True) + "\n").encode(), 0o644, 0, 0)

subprocess.run(["/usr/bin/loginctl", "enable-linger", agent_user], check=True, timeout=30)
subprocess.run(["/usr/bin/systemctl", "start", "user@%d.service" % uid], check=True, timeout=30)
active = subprocess.run(
    ["/usr/bin/systemctl", "is-active", "user@%d.service" % uid], check=True,
    text=True, stdout=subprocess.PIPE, timeout=10,
).stdout.strip()
runtime = Path("/run/user/%d" % uid)
if active != "active" or not (runtime / "bus").is_socket():
    raise RuntimeError("agent systemd user manager is unavailable")
version = subprocess.run([str(bwrap), "--version"], check=True, text=True,
                         stdout=subprocess.PIPE, timeout=10).stdout.strip()
response = {"state": "provisioned", "world_id": world, "host_id": host,
            "user": agent_user, "uid": uid, "bundle_sha256": payload["bundle_sha256"],
            "bwrap_version": version}
print(json.dumps(response, sort_keys=True))
'''


def _file_entry(data: bytes) -> dict[str, str]:
    return {
        "data": base64.b64encode(data).decode("ascii"),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def build_payload(world_id: str) -> dict[str, Any]:
    shell_dir = Path(__file__).resolve().parent
    files = {name: _file_entry((shell_dir / name).read_bytes()) for name in SOURCE_NAMES}
    files["dummy_agent.py"] = _file_entry(DUMMY_SOURCE.encode("utf-8"))
    files["guest-controller"] = _file_entry(
        (shell_dir / "messungen/agents-vm/guest-controller").read_bytes()
    )
    digest_input = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {
        "world_id": world_id,
        "host_id": instance_name(world_id),
        "files": files,
        "bundle_sha256": hashlib.sha256(digest_input).hexdigest(),
    }


def build_install_script(payload: dict[str, Any]) -> str:
    encoded = base64.b64encode(json.dumps(
        payload, ensure_ascii=False, allow_nan=False,
        sort_keys=True, separators=(",", ":"),
    ).encode()).decode("ascii")
    return "PAYLOAD_B64 = %r\n%s" % (encoded, GUEST_INSTALLER)


def provision(adapter: LimaVMAdapter, world_id: str) -> dict[str, Any]:
    payload = build_payload(world_id)
    expected = {
        "state", "world_id", "host_id", "user", "uid",
        "bundle_sha256", "bwrap_version",
    }
    with adapter._lock(world_id):
        record = adapter._read_record(world_id)
        if record is None:
            raise VMError("Keine eigene VM-Registrierung")
        current = adapter._owned_status(world_id, record)
        if current.get("state") != "running":
            raise VMError("Eigene VM läuft nicht bestätigt")
        completed = adapter._run([
            "shell", record["instance_name"], "--", "/usr/bin/sudo", "--non-interactive",
            "/usr/bin/python3", "-I", "-",
        ], timeout=6 * 60, stdin=build_install_script(payload))
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise VMTransportError("Gast-Provisionierung war nicht lesbar") from exc
        if (not isinstance(response, dict) or set(response) != expected
                or response.get("state") != "provisioned"
                or response.get("world_id") != world_id
                or response.get("host_id") != payload["host_id"]
                or response.get("user") != AGENT_USER
                or response.get("bundle_sha256") != payload["bundle_sha256"]
                or not isinstance(response.get("uid"), int) or response["uid"] <= 0
                or not isinstance(response.get("bwrap_version"), str)):
            raise VMTransportError("Gast-Provisionierung passt nicht zur VM-Bindung")
        record["guest_controller"] = {
            "state": "provisioned", "boot_id": current["boot_id"],
            "bundle_sha256": payload["bundle_sha256"], "user": AGENT_USER,
        }
        adapter._write_record(world_id, record)
        return response


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world_id")
    parser.add_argument("--lima-home", type=Path)
    parser.add_argument("--state-root", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--cpus", type=int, default=2)
    parser.add_argument("--memory-gib", type=int, default=2)
    parser.add_argument("--disk-gib", type=int, default=8)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = provision(LimaVMAdapter(
            lima_home=args.lima_home, state_root=args.state_root, config_path=args.config,
            cpus=args.cpus, memory_gib=args.memory_gib, disk_gib=args.disk_gib,
        ), args.world_id)
    except (VMError, OSError, ValueError) as exc:
        result = {"state": "error", "reason": str(exc)}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("state") == "provisioned" else 2


if __name__ == "__main__":
    raise SystemExit(main())
