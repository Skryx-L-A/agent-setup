"""Versionierte Agenten-CLIs im eigenen Linux-Benutzerpfad installieren."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

PACKAGES = ("@anthropic-ai/claude-code@2.1.269", "@openai/codex@0.146.0",
            "@earendil-works/pi-coding-agent@0.84.2")


def install(node: Path, destination: Path) -> dict:
    if platform.system() != "Linux" or os.getuid() == 0:
        raise RuntimeError("Nur als unprivilegierter Linux-Benutzer installieren")
    node = node.resolve(strict=True)
    npm = node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
    destination = destination.absolute()
    if destination.exists():
        raise RuntimeError("Versioniertes Installationsziel existiert bereits")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    environment = {"HOME": str(Path.home()), "PATH": f"{node.parent}:/usr/bin:/bin",
                   "LANG": "C.UTF-8", "BROWSER": "/usr/bin/true",
                   "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1"}
    with tempfile.TemporaryDirectory(prefix=".harness-setup-", dir=destination.parent) as temporary:
        stage = Path(temporary)
        user_config, global_config = stage / "npm-user.conf", stage / "npm-global.conf"
        user_config.write_text("")
        global_config.write_text("")
        # Kein fremdes lifecycle-Skript wird von npm automatisch ausgeführt.
        command = [str(node), str(npm), "install", "--prefix", str(stage), "--ignore-scripts",
                   "--no-audit", "--no-fund", "--save-exact", f"--userconfig={user_config}",
                   f"--globalconfig={global_config}", "--registry=https://registry.npmjs.org", *PACKAGES]
        subprocess.run(command, env=environment, check=True, timeout=300)
        claude = stage / "node_modules/@anthropic-ai/claude-code"
        # Dieser konkrete Hook wurde im Originalpaket gelesen: er verlinkt nur
        # dessen plattformspezifisches Binary innerhalb desselben Paketbaums.
        installer = claude / "install.cjs"
        if hashlib.sha256(installer.read_bytes()).hexdigest() != "5cbab1670597f492cd4eeb946f3c344ebcb1fbd43c623ba192c9b33744461b85":
            raise RuntimeError("Claude-Installationshook weicht von gelesener Fassung ab")
        subprocess.run([str(node), str(installer)], env=environment,
                       check=True, timeout=20)
        versions = {}
        for name, expected in (("claude", "2.1.269"), ("codex", "0.146.0"), ("pi", "0.84.2")):
            result = subprocess.run([str(stage / "node_modules/.bin" / name), "--version"],
                                    env=environment, check=True, timeout=20,
                                    text=True, capture_output=True)
            if expected not in result.stdout:
                raise RuntimeError(f"Unerwartete Version für {name}")
            versions[name] = result.stdout.strip()
        # Umbenennung erst nach erfolgreichem Start aller drei Programme.
        stage.rename(destination)
    return {"directory": str(destination), "versions": versions,
            "packages": list(PACKAGES), "agents_started": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.node, args.destination), indent=2))
