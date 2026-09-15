#!/usr/bin/env python3
"""Controllerseitige Ressourcen genau eines Claude-Code-Zuges auf Linux.

Ein ``ClaudeLauf`` baut fuer eine Laufkennung den gebundenen Modellproxy, den
privaten Controllerkanal und einen LinuxLauncher mit genau diesen beiden Sockets,
startet den Zug ueber den ``RunController`` und bewertet das Ende. Die
Controllerseite haelt die Anmeldung; der Harness sieht nur einen Platzhalter.
"""
from __future__ import annotations

import json
import os
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import agents_data as ad
from agents_claude import (
    ClaudeAdapterFehler, ClaudeZug, StreamBefund, ZugUrteil, ausgabe_lesen, start_spec,
    stream_befund, zug_schreiben, zug_urteil,
)
from agents_controller import AgentController
from agents_controller_endpoint import ControllerEndpoint
from agents_lauf import LaunchReceipt, RunController, RunHandle
from agents_linux import LinuxLauncher, SocketBinding
from agents_model_proxy import AgentsModelProxy, BackendConfig, ProxyBinding


def _private_dir(path: Path, label: str) -> Path:
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ClaudeAdapterFehler("%s muss eigener privater Ordner sein" % label)
    return path


class ClaudeZugLauncher(LinuxLauncher):
    """LinuxLauncher fuer zugbasierte Harnesses.

    ``claude -p`` endet nach genau einem Zug; das Zugende ist der Anwendungscheckpoint.
    Eine Pause wird deshalb angenommen, ohne den Prozess anzuhalten: der Zug laeuft
    zu Ende, neue Starts bleiben durch den RunController gesperrt. Ein erfundener
    Checkpoint waehrend des Zuges wird weiterhin abgewiesen.
    """

    def request_pause(self, receipt: LaunchReceipt) -> None:
        self._require_live(receipt)


def anthropic_backend(model: str, execution_host: str) -> BackendConfig:
    """Cloudbackend ohne feste Header; die Anmeldung kommt je Anfrage aus der Quelle."""
    return BackendConfig("anthropic", model, "anthropic-messages", "cloud", "https://api.anthropic.com",
                         execution_host, "cloud")


@dataclass(frozen=True)
class LaufOrte:
    """Controller- und Agentenpfade eines Tragers; Controllerpfade liegen nie in Agentenbereichen."""

    register: Path           # RunController-Register
    launcher_state: Path     # Receipts des LinuxLaunchers
    output: Path             # stdout/stderr der Units
    controller: Path         # Socketordner je Lauf
    turns: Path              # nur lesend eingebundene Zugbeschreibungen je Lauf
    runtime: Path            # nur lesend eingebundene Runner-/RPC-Module


class ClaudeLauf:
    """Ein Claude-Zug mit exklusiv gebundenen Kanaelen."""

    def __init__(self, orte: LaufOrte, *, world_root: Path, agent_id: str, run_id: str,
                 workspace: Path, agent_state: Path, zug: ClaudeZug, backend: BackendConfig,
                 auth_headers: Optional[Callable[[], tuple[tuple[str, str], ...]]],
                 extra_read_paths: tuple[Path, ...] = (), launcher_options: Optional[dict[str, Any]] = None,
                 unit_prefix: str = "wb-agents-linux-claude-"):
        self.orte = orte
        self.world_root = Path(world_root)
        self.world = ad.read_world(self.world_root)
        self.world_id = self.world["id"]
        self.agent_id = ad.valid_id(agent_id, "Agentenkennung")
        self.agent = ad.read_agent(self.world_root, self.agent_id)
        self.run_id = ad.valid_id(run_id, "Laufkennung")
        self.workspace = Path(workspace)
        self.agent_state = Path(agent_state)
        self.zug = zug
        self.backend = backend
        self.auth_headers = auth_headers
        self.extra_read_paths = tuple(Path(path) for path in extra_read_paths)
        self.launcher_options = dict(launcher_options or {})
        self.unit_prefix = unit_prefix
        if backend.model != zug.model:
            raise ClaudeAdapterFehler("Backend und Zug nennen verschiedene Modelle")
        self.proxy: Optional[AgentsModelProxy] = None
        self.control: Optional[AgentController] = None
        self.endpoint: Optional[ControllerEndpoint] = None
        self.launcher: Optional[LinuxLauncher] = None
        self.handle: Optional[RunHandle] = None
        self.runs = RunController(orte.register, launcher=None)

    # Laufbindung -----------------------------------------------------------------
    def is_current(self) -> bool:
        return self.runs.is_current(self.world_id, self.agent_id, self.run_id)

    def controller(self, launcher: Optional[LinuxLauncher] = None) -> RunController:
        return RunController(self.orte.register, launcher=launcher or self.observer())

    def observer(self) -> "ClaudeZugLauncher":
        """Launcher ohne Kanaele fuer Beobachtung und Stop derselben Receipts."""
        return ClaudeZugLauncher(self.orte.launcher_state, output_dir=self.orte.output,
                                 unit_prefix=self.unit_prefix, **self.launcher_options)

    # Start -------------------------------------------------------------------------
    def start(self) -> RunHandle:
        if self.handle is not None:
            raise ClaudeAdapterFehler("Zug wurde bereits gestartet")
        for path, label in ((self.orte.controller, "Controllerordner"), (self.orte.turns, "Zugordner"),
                            (self.orte.output, "Ausgabeordner"), (self.orte.launcher_state, "Launcherordner")):
            _private_dir(path, label)
        run_dir = _private_dir(self.orte.controller / self.run_id, "Laufsocketordner")
        turn_dir = _private_dir(self.orte.turns / self.run_id, "Zugordner des Laufs")
        turn_file = zug_schreiben(self.zug, turn_dir)
        binding = ProxyBinding(self.world_id, self.agent_id, self.run_id, self.backend.provider, self.zug.model)
        try:
            self.proxy = AgentsModelProxy(
                binding, self.backend, run_dir / "model.sock", run_dir,
                (self.workspace, self.agent_state), lambda _binding: self.is_current(),
                auth_headers_provider=self.auth_headers)
            self.proxy.start()
            self.control = AgentController(self.world_root, self.run_id, lambda _binding: self.is_current())
            self.endpoint = ControllerEndpoint(self.control, self.agent_id, self.agent["stage"], run_dir / "rpc.sock")
            read_paths = (self.orte.runtime, turn_dir, *self.zug.lese_pfade(), *self.extra_read_paths)
            self.launcher = ClaudeZugLauncher(
                self.orte.launcher_state, read_paths=read_paths,
                write_paths=(self.workspace, self.agent_state),
                socket_bindings=(SocketBinding(self.proxy.socket_path, "/run/wb-model.sock"), self.endpoint.binding),
                output_dir=self.orte.output, unit_prefix=self.unit_prefix, **self.launcher_options)
            spec = start_spec(self.orte.runtime, turn_file, self.workspace, self.zug.runner)
            self.handle = self.controller(self.launcher).start(self.world_id, self.agent_id, self.run_id, spec)
            return self.handle
        except BaseException:
            if self.handle is None:
                self.close()
            raise

    # Beobachtung -------------------------------------------------------------------
    def receipt(self) -> LaunchReceipt:
        if self.handle is None or self.handle.receipt is None:
            raise ClaudeAdapterFehler("Zug hat keine bestaetigte Prozessidentitaet")
        return self.handle.receipt

    def stdout(self) -> bytes:
        stdout, _ = self.observer().output_paths(self.receipt())
        return ausgabe_lesen(stdout)

    def stderr_tail(self, limit: int = 2000) -> str:
        _, stderr = self.observer().output_paths(self.receipt())
        return ausgabe_lesen(stderr)[-limit:].decode("utf-8", "replace")

    def status(self) -> Optional[RunHandle]:
        return self.controller().status(self.world_id, self.agent_id)

    def record(self) -> dict[str, Any]:
        state = json.loads(Path(self.orte.register).read_text(encoding="utf-8"))
        return dict(state["runs"][self.run_id])

    def wait(self, deadline: float, *, poll: float = 0.5,
             progress: Optional[Callable[[], bool]] = None) -> dict[str, Any]:
        """Wartet bis zum bestaetigten Ende oder bis ``progress`` True meldet; nie unbegrenzt."""
        while True:
            handle = self.status()
            record = self.record()
            if handle is None or record.get("observed_state") == "stopped":
                return record
            if progress is not None and progress():
                return record
            if time.monotonic() > deadline:
                raise TimeoutError("Zug endete nicht vor der Frist")
            time.sleep(poll)

    def stop(self) -> Optional[RunHandle]:
        return self.controller().stop(self.world_id, self.agent_id, expected_run_id=self.run_id)

    # Ende --------------------------------------------------------------------------
    def urteil(self, ticket_id: Optional[str], result_revision_before: int) -> tuple[ZugUrteil, StreamBefund]:
        record = self.record()
        if record.get("observed_state") != "stopped":
            raise ClaudeAdapterFehler("Urteil erst nach bestaetigtem Laufende")
        befund = stream_befund(self.stdout(), self.zug.session_id)
        ticket = ad.read_ticket(self.world_root, ticket_id) if ticket_id else None
        verdict = zug_urteil(befund, record.get("exit_code"), stop_requested=record.get("desired_state") == "stopped",
                             ticket=ticket, agent_id=self.agent_id, result_revision_before=result_revision_before)
        return verdict, befund

    def close(self) -> None:
        errors: list[BaseException] = []
        if self.endpoint is not None:
            try:
                self.endpoint.close()
            except BaseException as exc:  # noqa: BLE001 - alle Kanaele trotzdem schliessen
                errors.append(exc)
        if self.control is not None:
            self.control.close()
            try:
                self.control.join()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
        if self.proxy is not None:
            self.proxy.stop()
        if errors:
            raise errors[0]


__all__ = ["ClaudeLauf", "ClaudeZugLauncher", "LaufOrte", "anthropic_backend"]
