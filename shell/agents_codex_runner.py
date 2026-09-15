#!/usr/bin/env python3
"""Runner innerhalb der Agents-Sandbox: genau ein Codex-Zug (Aufruf gebaut, Stand Trockenlauf).

Der Runner verbindet den fest eingebundenen Modellsocket ueber eine Loopbackbruecke und startet
``codex exec --json`` mit eigenem ``CODEX_HOME`` und einem Provider auf die Bruecke. Ohne den
eingebundenen Socket ``/run/wb-model.sock`` startet er nichts: ``--sandbox danger-full-access``
gilt nur innerhalb des LinuxLaunchers. stdout bleibt der vom Launcher erfasste Deskriptor.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PLACEHOLDER_TOKEN = "wb-agents-placeholder"
MODEL_SOCKET = "/run/wb-model.sock"
KEYS = frozenset({"harness", "cli", "model", "prompt", "session_id", "codex_home", "effort",
                  "append_system_prompt_file", "extra_env"})
EFFORTS = ("low", "medium", "high", "xhigh", "max")


def _fail(message: str) -> int:
    print("agents_codex_runner: " + message, file=sys.stderr, flush=True)
    return 70


def command(config: dict, base_url: str) -> tuple[list[str], dict[str, str]]:
    env = {
        "HOME": os.environ.get("HOME", "/home/agent"),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "LANG": "C.UTF-8",
        "USER": os.environ.get("USER", "agent"),
        "CODEX_HOME": config["codex_home"],
        "WB_CODEX_KEY": PLACEHOLDER_TOKEN,
        "BROWSER": "/usr/bin/true",
    }
    for name, value in config.get("extra_env") or []:
        env[name] = value
    settings = {
        "model_provider": "wb-bruecke", "model_providers.wb-bruecke.name": "Werkbank-Bruecke",
        "model_providers.wb-bruecke.base_url": base_url, "model_providers.wb-bruecke.env_key": "WB_CODEX_KEY",
        "model_providers.wb-bruecke.wire_api": "responses",
        "model_providers.wb-bruecke.requires_openai_auth": False,
        "analytics.enabled": False, "check_for_update_on_startup": False,
    }
    argv = [config["cli"], "exec", "--ignore-user-config", "--ignore-rules", "--strict-config",
            "--model", config["model"],
            # Nur innerhalb des geprueften Launchers: Datei-, Prozess- und Netzgrenze liegt aussen.
            "--sandbox", "danger-full-access", "--skip-git-repo-check", "--json"]
    if config.get("effort"):
        argv += ["--config", "model_reasoning_effort=%s" % config["effort"]]
    for key, value in settings.items():
        argv += ["-c", "%s=%s" % (key, json.dumps(value))]
    prompt = config["prompt"]
    if config.get("append_system_prompt_file"):
        # Codex exec kennt keine angehaengte Systemanweisung aus einer Datei; der Zug nennt sie zuerst.
        prompt = "Read your turn instructions in %s first and follow them.\n\n%s" % (
            config["append_system_prompt_file"], prompt)
    argv.append(prompt)
    return argv, env


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return _fail("Aufruf: agents_codex_runner.py <turn.json>")
    try:
        config = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _fail("Zugbeschreibung ist unlesbar")
    if not isinstance(config, dict) or set(config) != KEYS or config.get("harness") != "codex":
        return _fail("Zugbeschreibung hat unerwartete Felder")
    if not Path(config["cli"]).is_absolute() or (config.get("effort") is not None and config["effort"] not in EFFORTS):
        return _fail("Zugbeschreibung ist ungueltig")
    if not os.path.exists(MODEL_SOCKET):
        return _fail("Modellsocket fehlt; Codex startet nur innerhalb des LinuxLaunchers")
    from agents_model_bridge import ModelBridge
    Path(config["codex_home"]).mkdir(mode=0o700, parents=True, exist_ok=True)
    child = None

    def forward(signum, _frame):
        if child is not None and child.poll() is None:
            child.send_signal(signum)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    bridge = ModelBridge(MODEL_SOCKET)
    try:
        command_argv, env = command(config, bridge.url + "/v1")
        child = subprocess.Popen(command_argv, env=env, stdin=subprocess.DEVNULL, close_fds=True)
        code = child.wait()
    finally:
        try:
            bridge.close()
        except RuntimeError:
            print("agents_codex_runner: Bruecke endete nicht fristgerecht", file=sys.stderr, flush=True)
    return 128 - code if code < 0 else code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
