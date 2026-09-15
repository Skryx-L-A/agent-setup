#!/usr/bin/env python3
"""Runner innerhalb der Agents-Sandbox: genau ein Pi-Zug.

Der Runner verbindet den fest eingebundenen Modellsocket ueber eine Loopbackbruecke, schreibt die
Pi-Providerdatei mit der Bruecke als einzigem Provider in den Agentenordner des Zuges und startet
Pi im JSON-Modus. stdout bleibt der vom Launcher erfasste Deskriptor.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agents_model_bridge import ModelBridge  # noqa: E402

PLACEHOLDER_TOKEN = "wb-agents-placeholder"
KEYS = frozenset({"harness", "node", "cli", "model", "prompt", "session_id", "session_dir", "agent_dir", "api",
                  "context_window", "tools", "thinking", "append_system_prompt_file", "extra_env"})
PI_TOOLS = frozenset({"bash", "read", "write", "edit", "grep", "find", "ls"})


def _fail(message: str) -> int:
    print("agents_pi_runner: " + message, file=sys.stderr, flush=True)
    return 70


def command(config: dict, base_url: str) -> tuple[list[str], dict[str, str]]:
    env = {
        "HOME": os.environ.get("HOME", "/home/agent"),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "LANG": "C.UTF-8",
        "USER": os.environ.get("USER", "agent"),
        "PI_CODING_AGENT_DIR": config["agent_dir"],
        "PI_TELEMETRY": "0",
        "PI_OFFLINE": "1",
        "BROWSER": "/usr/bin/true",
    }
    for name, value in config.get("extra_env") or []:
        env[name] = value
    argv = [
        config["node"], config["cli"], "--print", "--mode", "json", "--offline", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "--tools", ",".join(config["tools"]), "--provider", "wb-lokal", "--model", config["model"],
        "--session-dir", config["session_dir"], "--session-id", config["session_id"],
    ]
    if config.get("thinking"):
        argv += ["--thinking", config["thinking"]]
    if config.get("append_system_prompt_file"):
        argv += ["--append-system-prompt", config["append_system_prompt_file"]]
    argv.append(config["prompt"])
    models = {"providers": {"wb-lokal": {
        "baseUrl": base_url, "api": config["api"], "apiKey": PLACEHOLDER_TOKEN,
        "compat": {"supportsDeveloperRole": False},
        "models": [{"id": config["model"], "name": config["model"], "contextWindow": config["context_window"]}]}}}
    return argv, dict(env, _WB_MODELS_JSON=json.dumps(models))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return _fail("Aufruf: agents_pi_runner.py <turn.json>")
    try:
        config = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _fail("Zugbeschreibung ist unlesbar")
    if not isinstance(config, dict) or set(config) != KEYS or config.get("harness") != "pi":
        return _fail("Zugbeschreibung hat unerwartete Felder")
    if (not isinstance(config["tools"], list) or not config["tools"] or set(config["tools"]) - PI_TOOLS
            or not Path(config["node"]).is_absolute() or not Path(config["cli"]).is_absolute()):
        return _fail("Zugbeschreibung ist ungueltig")
    for name in ("agent_dir", "session_dir"):
        Path(config[name]).mkdir(mode=0o700, parents=True, exist_ok=True)
    child = None

    def forward(signum, _frame):
        if child is not None and child.poll() is None:
            child.send_signal(signum)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    bridge = ModelBridge()
    try:
        command_argv, env = command(config, bridge.url + "/v1")
        models = env.pop("_WB_MODELS_JSON")
        target = Path(config["agent_dir"]) / "models.json"
        target.write_text(models, encoding="utf-8")
        os.chmod(target, 0o600)
        child = subprocess.Popen(command_argv, env=env, stdin=subprocess.DEVNULL, close_fds=True)
        code = child.wait()
    finally:
        try:
            bridge.close()
        except RuntimeError:
            print("agents_pi_runner: Bruecke endete nicht fristgerecht", file=sys.stderr, flush=True)
    return 128 - code if code < 0 else code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
