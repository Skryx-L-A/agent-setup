"""Installiert versionierte Linux-Werkzeuge ohne Dienste oder globale Konfiguration."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile

NODE_VERSION = "24.21.0"
NODE_HASHES = {
    "x86_64": ("x64", "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"),
    "aarch64": ("arm64", "6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"),
}


def run(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=180).stdout.strip()


def install(prefix: Path) -> dict[str, str]:
    if platform.system() != "Linux" or os.getuid() == 0:
        raise RuntimeError("Nur als eigener unprivilegierter Linux-Benutzer ausführen")
    arch, expected = NODE_HASHES[platform.machine()]
    prefix = prefix.absolute()
    if prefix.is_symlink():
        raise RuntimeError("Installationsziel darf kein Symlink sein")
    prefix.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = prefix / f"node-v{NODE_VERSION}-linux-{arch}"
    # Bestehende Installationen werden nie überschrieben oder ungeprüft übernommen.
    if target.exists():
        raise RuntimeError(f"Ziel existiert bereits: {target}")
    with tempfile.TemporaryDirectory(prefix=".setup-", dir=prefix) as temporary:
        stage = Path(temporary)
        filename = f"node-v{NODE_VERSION}-linux-{arch}.tar.xz"
        archive = stage / filename
        run("curl", "--fail", "--silent", "--show-error", "--location",
            "--proto", "=https", "--proto-redir", "=https", "--max-time", "150",
            "--output", str(archive), f"https://nodejs.org/dist/v{NODE_VERSION}/{filename}")
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Node-Prüfsumme stimmt nicht")
        with tarfile.open(archive) as package:
            package.extractall(stage, filter="data")
        staged_node = stage / target.name
        version = run(str(staged_node / "bin/node"), "--version")
        if version != f"v{NODE_VERSION}":
            raise RuntimeError("Node-Version stimmt nicht")
        bwrap = shutil.which("bwrap")
        staged_bwrap = None
        bwrap_target = None
        if not bwrap:
            # apt prüft den Download gegen die Hashes seines signierten Paketindexes.
            # dpkg-deb -x führt keine Paket- oder Installationsskripte aus.
            run("apt-get", "download", "bubblewrap", cwd=stage)
            packages = list(stage.glob("bubblewrap_*.deb"))
            if len(packages) != 1:
                raise RuntimeError("Genau ein Bubblewrap-Paket erwartet")
            package = packages[0]
            package_version = run("dpkg-deb", "--field", str(package), "Version")
            if not package_version or any(c not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+:~-" for c in package_version):
                raise RuntimeError("Ungültige Paketversion")
            bwrap_target = prefix / ("bubblewrap-" + package_version)
            if bwrap_target.exists():
                raise RuntimeError("Bubblewrap-Ziel existiert bereits")
            staged_bwrap = stage / "bubblewrap"
            run("dpkg-deb", "--extract", str(package), str(staged_bwrap))
            bwrap = str(staged_bwrap / "usr/bin/bwrap")
        bubblewrap_version = run(bwrap, "--version")
        # Ein ausführbares Binary allein belegt noch keine zulässigen User-Namespaces.
        run(bwrap, "--unshare-all", "--die-with-parent", "--new-session",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true")
        if staged_bwrap is not None:
            staged_bwrap.rename(bwrap_target)
            bwrap = str(bwrap_target / "usr/bin/bwrap")
        staged_node.rename(target)
    return {"node": str(target / "bin/node"), "node_version": version,
            "node_sha256": expected, "bwrap": bwrap,
            "bwrap_version": bubblewrap_version}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    if not args.install:
        print(json.dumps({"platform": platform.system(), "architecture": platform.machine(),
                          "uid": os.getuid(), "prefix": str(args.prefix.absolute()),
                          "node": shutil.which("node"), "bwrap": shutil.which("bwrap"),
                          "systemd_run": shutil.which("systemd-run")}, indent=2))
        return
    print(json.dumps(install(args.prefix), indent=2))


if __name__ == "__main__":
    main()
