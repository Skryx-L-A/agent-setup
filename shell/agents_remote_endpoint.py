#!/usr/bin/env python3
"""Ein SSH-Aufruf, eine gebundene Controlleranfrage, danach Prozessende."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import stat
import sys

# Der Aufrufer startet Python mit -I. Nur die ausgelieferte eigene Bibliothek
# kommt hinzu; weder Arbeitsverzeichnis noch PYTHONPATH werden übernommen.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from agents_lauf import RunController, StartSpec
from agents_remote import RemoteDispatcher, RemoteError, MAX_MESSAGE, encode, identifier


def private_path(path: Path, *, directory: bool = False) -> Path:
    path = path.absolute()
    for component in (path, *path.parents):
        if component.is_symlink():
            raise RemoteError("Controllerpfad enthält einen Symlink")
        info = component.stat()
        if info.st_uid not in {0, os.getuid()} or info.st_mode & 0o022:
            raise RemoteError("Controllerpfad ist fremd beschreibbar")
    info = path.stat()
    if directory != stat.S_ISDIR(info.st_mode):
        raise RemoteError("Falscher Controllerpfadtyp")
    if info.st_uid != os.getuid():
        raise RemoteError("Controllerpfad gehört nicht zum SSH-Benutzer")
    return path


def configured_dispatcher(config_path: Path) -> RemoteDispatcher:
    if os.getuid() == 0:
        raise RemoteError("Agents-Controller startet nicht als root")
    config = json.loads(private_path(config_path).read_text())
    if config.get("enabled") is not True:
        raise RemoteError("Maschine ist nicht freigeschaltet")
    host, world = identifier(config["host_id"]), identifier(config["world_id"])
    state = private_path(Path(config["state_dir"]), directory=True)
    runtime = private_path(Path(f"/run/user/{os.getuid()}"), directory=True)
    os.environ["XDG_RUNTIME_DIR"] = str(runtime)
    os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + str(runtime / "bus")
    from agents_linux import LinuxLauncher
    profiles = config["agents"]
    if not isinstance(profiles, dict) or not profiles:
        raise RemoteError("Agentenprofile fehlen")

    def handle(operation: str, agent: str, expected_run: str | None):
        if agent not in profiles:
            raise RemoteError("Agent nicht auf dieser Maschine eingerichtet")
        profile = profiles[agent]
        protected = (state.resolve(), config_path.resolve(), Path(__file__).resolve().parent)
        for scope in (*profile.get("read_paths", []), *profile.get("write_paths", [])):
            resolved = Path(scope).resolve(strict=True)
            for path in protected:
                if resolved == path or resolved in path.parents or path in resolved.parents:
                    raise RemoteError("Agentenbereich überschneidet sich mit Controllerdaten")
        agent_state = state / agent
        agent_state.mkdir(mode=0o700, exist_ok=True)
        private_path(agent_state, directory=True)
        launcher = LinuxLauncher(agent_state / "launcher",
                                 read_paths=tuple(profile.get("read_paths", [])),
                                 write_paths=tuple(profile.get("write_paths", [])),
                                 allowed_env_names=tuple(profile.get("allowed_env_names", [])),
                                 bwrap=config.get("bwrap"))
        controller = RunController(agent_state / "runs.json", launcher=launcher)
        if operation == "start":
            # Kein argv, cwd, Rechtepfad oder Umgebungswert stammt aus dem RPC.
            result = controller.start(world, agent, expected_run,
                                      StartSpec.from_dict(profile["start"]))
        elif operation == "status":
            result = controller.status(world, agent)
        else:
            result = getattr(controller, operation)(world, agent,
                                                   expected_run_id=expected_run)
        return asdict(result) if result is not None else None

    return RemoteDispatcher(host, world, state / "remote-requests.json",
                            {op: lambda agent, run, op=op: handle(op, agent, run)
                             for op in ("start", "status", "pause", "resume", "stop")})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    data = sys.stdin.buffer.read(MAX_MESSAGE + 1)
    if len(data) > MAX_MESSAGE:
        raise RemoteError("Anfrage zu groß")
    request = json.loads(data)
    result = configured_dispatcher(args.config).dispatch(request)
    sys.stdout.buffer.write(encode(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Keine Profile, Pfade, Schlüssel oder Harnessausgabe auf dem Fehlerkanal.
        print(type(exc).__name__ + ": Controlleranfrage nicht bestätigt", file=sys.stderr)
        sys.exit(1)
