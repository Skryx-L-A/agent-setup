#!/usr/bin/env python3
"""Runner innerhalb der Agents-Sandbox: genau ein Claude-Code-Zug.

Der Runner verbindet den fest eingebundenen Modellsocket ueber eine Loopbackbruecke,
startet Claude Code mit Platzhalteranmeldung und gibt dessen Exitcode weiter.
stdout bleibt der vom Launcher erfasste Deskriptor; der Runner schreibt dort nichts.
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
ALLOWED_TOOLS = frozenset({"Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"})
KEYS = frozenset({"claude_binary", "model", "prompt", "session_id", "config_dir", "resume",
                  "tools", "append_system_prompt", "extra_env", "effort", "append_system_prompt_file",
                  "settings_file"})
EFFORT_STUFEN = ("low", "medium", "high", "xhigh", "max")


def _fail(message: str) -> int:
    print("agents_claude_runner: " + message, file=sys.stderr, flush=True)
    return 70


def command(config: dict) -> tuple[list[str], dict[str, str]]:
    model = config["model"]
    env = {
        "HOME": os.environ.get("HOME", "/home/agent"),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "LANG": "C.UTF-8",
        "USER": os.environ.get("USER", "agent"),
        "CLAUDE_CONFIG_DIR": config["config_dir"],
        "CLAUDE_CODE_OAUTH_TOKEN": PLACEHOLDER_TOKEN,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
        "ANTHROPIC_SMALL_FAST_MODEL": model,
        "BROWSER": "/usr/bin/true",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }
    for name, value in config.get("extra_env") or []:
        env[name] = value
    argv = [
        config["claude_binary"], "-p", "--output-format", "stream-json", "--verbose",
        "--model", model,
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "", "--no-chrome", "--disable-slash-commands",
        "--tools", ",".join(config["tools"]),
        # Nur innerhalb des geprueften Launchers: Datei-, Prozess- und Netzgrenze liegt aussen.
        "--dangerously-skip-permissions",
    ]
    argv += ["--resume", config["session_id"]] if config["resume"] else ["--session-id", config["session_id"]]
    if config.get("append_system_prompt"):
        argv += ["--append-system-prompt", config["append_system_prompt"]]
    if config.get("append_system_prompt_file"):
        argv += ["--append-system-prompt-file", config["append_system_prompt_file"]]
    if config.get("settings_file"):
        # Zug-eigene Einstellungen mit den Sperr-Hooks; Nutzereinstellungen bleiben ausgeschlossen.
        argv += ["--settings", config["settings_file"]]
    if config.get("effort"):
        # Gemessen an 2.1.241: erscheint bei Sonnet 5 und Opus 5 als output_config.effort.
        argv += ["--effort", config["effort"]]
    return argv, env


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return _fail("Aufruf: agents_claude_runner.py <turn.json>")
    try:
        config = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _fail("Zugbeschreibung ist unlesbar")
    if not isinstance(config, dict) or set(config) != KEYS:
        return _fail("Zugbeschreibung hat unerwartete Felder")
    if (not isinstance(config["tools"], list) or not config["tools"]
            or set(config["tools"]) - ALLOWED_TOOLS or not Path(config["claude_binary"]).is_absolute()
            or config["effort"] not in (None,) + EFFORT_STUFEN):
        return _fail("Zugbeschreibung ist ungueltig")
    Path(config["config_dir"]).mkdir(mode=0o700, parents=True, exist_ok=True)
    child = None

    def forward(signum, _frame):
        if child is not None and child.poll() is None:
            child.send_signal(signum)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    bridge = ModelBridge()
    try:
        command_argv, env = command(config)
        env["ANTHROPIC_BASE_URL"] = bridge.url
        child = subprocess.Popen(command_argv, env=env, stdin=subprocess.PIPE, close_fds=True)
        try:
            child.stdin.write(config["prompt"].encode("utf-8"))
            child.stdin.close()
        except BrokenPipeError:
            pass
        code = child.wait()
    finally:
        try:
            bridge.close()
        except RuntimeError:
            print("agents_claude_runner: Bruecke endete nicht fristgerecht", file=sys.stderr, flush=True)
    return 128 - code if code < 0 else code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
