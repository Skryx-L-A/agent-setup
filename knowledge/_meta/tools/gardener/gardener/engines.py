"""Local inference endpoints for the Brain 5 pipeline.

The adapter deliberately has no fallback from a required capability.  A
pipeline stage that needs logprobs waits when no such endpoint is reachable;
using a superficially similar text-only model would make its result look more
reliable than it is.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import math
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
from typing import Any, Iterable


DEFAULT_CONFIG = Path(__file__).with_name("engines.yaml")
PROBE_TIMEOUT = 0.35
# Ollama (and the OpenAI API) return at most 20 alternatives per token; asking for
# more is HTTP 400 (measured 2026-09-24, Ollama 0.32.5, 24 options).  The chosen
# token is always among the top 20, so a question with more options still gets
# its answer; options outside the top 20 count as probability 0.
MAX_TOP_LOGPROBS = 20


class EngineError(RuntimeError):
    pass


class EngineUnavailable(EngineError):
    """No endpoint can meet a stage's explicitly requested capabilities."""


class EngineResponseError(EngineError):
    pass


@dataclass
class Endpoint:
    name: str
    kind: str
    base_url: str
    model: str
    capabilities: dict[str, Any]
    machine: str = "local"
    ssh_tunnel: str | None = None
    live_url: str | None = field(default=None, init=False, repr=False)
    _refresh: Any = field(default=None, init=False, repr=False)
    _semaphore: threading.BoundedSemaphore = field(init=False, repr=False)

    def __post_init__(self) -> None:
        parallel = int(self.capabilities.get("max_parallel", 1))
        if parallel < 1:
            raise ValueError(f"{self.name}: max_parallel must be at least 1")
        self._semaphore = threading.BoundedSemaphore(parallel)
        self.base_url = self.base_url.rstrip("/")

    @property
    def url(self) -> str:
        """Where requests go now; a tunnelled endpoint needs an open tunnel."""
        if self.live_url:
            return self.live_url
        if self.ssh_tunnel:
            raise EngineUnavailable(f"{self.name}: SSH tunnel to {self.ssh_tunnel} is not open "
                                    "(pick the endpoint inside `with EngineRegistry...`)")
        return self.base_url

    def has(self, needs: Iterable[str]) -> bool:
        return all(bool(self.capabilities.get(need)) for need in needs)


@dataclass(frozen=True)
class Question:
    """A single, independent Jev-style classification question."""
    text: str
    type: str
    options: list[str] = field(default_factory=list)
    id: str | None = None
    # a choice question gets an extra option "unklar" unless its options already
    # cover every case (e.g. a project list with "keins", j2 measurement c)
    mit_unklar: bool = True

    @property
    def prompt(self) -> str:  # convenient name for callers that use prompts
        return self.text


@dataclass(frozen=True)
class Answer:
    question: Question
    probabilities: dict[str, float]
    choice: str
    unsicher: bool


TUNNEL_TIMEOUT = 8.0


def _short_host(name: str) -> str:
    return name.split(".")[0].lower()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _port_open(port: int, timeout: float = 0.2) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


class _Tunnels:
    """SSH local forwards opened on demand, one per (host, remote port).

    A server that listens only on the remote host's loopback (peer-Ollama) is
    reached through ``ssh -N -L <free port>:127.0.0.1:<port> <host>``.  On the
    host itself the loopback address is used directly and no process starts.
    """

    def __init__(self, *, hostname: str | None, ssh_command: list[str] | None, timeout: float):
        self.hostname = _short_host(hostname or socket.gethostname())
        self.ssh_command = list(ssh_command or ["ssh"])
        self.timeout = timeout
        self._open: dict[tuple[str, int], tuple[subprocess.Popen, int]] = {}
        # Re-entrant: a signal handler may call close() while the same thread
        # is already inside it (measured 2026-09-23: a second SIGTERM during
        # shutdown deadlocked a plain Lock).
        self._lock = threading.RLock()

    def url_for(self, host: str, base_url: str) -> str:
        parsed = urllib.parse.urlsplit(base_url)
        remote_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if _short_host(host) == self.hostname:
            return base_url
        with self._lock:
            key = (host, remote_port)
            if key in self._open and self._open[key][0].poll() is None:
                local_port = self._open[key][1]
            else:
                local_port = self._start(host, remote_port)
        netloc = f"127.0.0.1:{local_port}"
        return urllib.parse.urlunsplit((parsed.scheme, netloc, parsed.path, "", "")).rstrip("/")

    def _start(self, host: str, remote_port: int) -> int:
        local_port = _free_port()
        command = self.ssh_command + [
            "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
            "-o", "ConnectTimeout=5",
            "-L", f"{local_port}:127.0.0.1:{remote_port}", host]
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise EngineUnavailable(f"ssh tunnel to {host} exited with {process.returncode}")
            if _port_open(local_port):
                self._open[(host, remote_port)] = (process, local_port)
                return local_port
            time.sleep(0.05)
        _stop(process)
        raise EngineUnavailable(f"ssh tunnel to {host} did not open within {self.timeout:.0f} s")

    def restart(self, host: str, base_url: str, old_url: str) -> str:
        """Replace a failed forward, without closing a newer forward from another worker."""
        parsed = urllib.parse.urlsplit(base_url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        with self._lock:
            current = self._open.get((host, port))
            if current and f"127.0.0.1:{current[1]}" in old_url:
                _stop(current[0])
                del self._open[(host, port)]
            return self.url_for(host, base_url)

    def close(self) -> None:
        with self._lock:
            for process, _port in self._open.values():
                _stop(process)
            self._open.clear()

    def pids(self) -> list[int]:
        return [process.pid for process, _port in self._open.values()]


def _stop(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


class EngineRegistry:
    """Configuration and per-run reachability cache for inference engines."""

    def __init__(self, endpoints: Iterable[Endpoint], *, probe_timeout: float = PROBE_TIMEOUT,
                 hostname: str | None = None, ssh_command: list[str] | None = None,
                 tunnel_timeout: float = TUNNEL_TIMEOUT):
        self.endpoints = list(endpoints)
        self.probe_timeout = probe_timeout
        self._reachable: dict[str, bool] = {}
        self._tunnels = _Tunnels(hostname=hostname, ssh_command=ssh_command,
                                 timeout=tunnel_timeout)
        self._previous_sigterm: Any = None
        self._terminating = False

    # A registry that may open SSH tunnels is a context manager: every tunnel
    # it started ends with the block, on an exception and on SIGTERM too.
    def __enter__(self) -> "EngineRegistry":
        if threading.current_thread() is threading.main_thread():
            self._previous_sigterm = signal.signal(signal.SIGTERM, self._on_sigterm)
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _on_sigterm(self, signum: int, frame: Any) -> None:
        if self._terminating:
            return      # a repeated SIGTERM (e.g. forwarded by `uv run`) while shutting down
        self._terminating = True
        # close() restores and forgets the previous handler, so read it first
        # (else a caller's SIGTERM=SIGINT handler never ran: SystemExit instead
        # of KeyboardInterrupt, found by `brain run`'s resume test 2026-09-23).
        previous = self._previous_sigterm
        self.close()
        if callable(previous):
            previous(signum, frame)
        raise SystemExit(128 + signum)

    def close(self) -> None:
        self._tunnels.close()
        for endpoint in self.endpoints:
            if endpoint.ssh_tunnel:
                endpoint.live_url = None
                endpoint._refresh = None
        self._reachable = {name: ok for name, ok in self._reachable.items()
                           if not any(e.name == name and e.ssh_tunnel for e in self.endpoints)}
        if self._previous_sigterm is not None and threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, self._previous_sigterm)
            self._previous_sigterm = None

    def base_url(self, endpoint: Endpoint) -> str:
        """The URL to call now: the configured one, or its local tunnel end."""
        if not endpoint.ssh_tunnel:
            return endpoint.base_url
        endpoint.live_url = self._tunnels.url_for(endpoint.ssh_tunnel, endpoint.base_url)
        def refresh(old_url: str) -> str:
            endpoint.live_url = self._tunnels.restart(endpoint.ssh_tunnel, endpoint.base_url, old_url)
            self._reachable.pop(endpoint.name, None)
            return endpoint.live_url
        endpoint._refresh = refresh
        return endpoint.live_url

    @classmethod
    def from_file(cls, path: str | Path | None = None) -> "EngineRegistry":
        config = Path(path or os.environ.get("BRAIN_ENGINES", DEFAULT_CONFIG))
        try:
            # engines.yaml is deliberately JSON-compatible YAML.  This keeps the
            # base tool stdlib-only while allowing an operator to use any YAML
            # parser later without changing the configuration format.
            raw = json.loads(config.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise EngineError(f"cannot load engine configuration {config}: {exc}") from exc
        values = raw.get("engines", raw if isinstance(raw, list) else [])
        if not isinstance(values, list):
            raise EngineError("engines configuration needs an 'engines' list")
        try:
            return cls(Endpoint(
                name=item["name"], kind=item["kind"], base_url=item["base_url"],
                model=item["model"], capabilities=dict(item.get("capabilities", {})),
                machine=item.get("machine", "local"), ssh_tunnel=item.get("ssh_tunnel"),
            ) for item in values)
        except (KeyError, TypeError, ValueError) as exc:
            raise EngineError(f"invalid engines configuration: {exc}") from exc

    def reachable(self, endpoint: Endpoint) -> bool:
        if endpoint.name not in self._reachable:
            path = "/api/tags" if endpoint.kind == "ollama" else "/models"
            try:
                url = self.base_url(endpoint)
            except EngineError:
                self._reachable[endpoint.name] = False
                return False
            try:
                with urllib.request.urlopen(url + path,
                                            timeout=self.probe_timeout) as response:
                    self._reachable[endpoint.name] = 200 <= response.status < 300
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                self._reachable[endpoint.name] = False
        return self._reachable[endpoint.name]

    def pick(self, stage_needs: Iterable[str]) -> Endpoint | None:
        needs = set(stage_needs)
        for endpoint in self.endpoints:
            if endpoint.has(needs) and self.reachable(endpoint):
                return endpoint
        return None


def _request(url: str, payload: dict[str, Any], timeout: float = 30.0,
             endpoint: Endpoint | None = None) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    transport_retries = 0
    server_retries = 0
    while True:
        request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            if exc.code == 500 and server_retries < 1:
                server_retries += 1
                continue
            raise EngineResponseError(f"engine request to {url} failed: {exc}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if endpoint is not None and endpoint._refresh and transport_retries < 3:
                transport_retries += 1
                time.sleep(min(0.2 * 2 ** (transport_retries - 1), 0.8))
                old = endpoint.url
                try:
                    new = endpoint._refresh(old)
                    url = url.replace(old, new, 1)
                    continue
                except EngineError as restart_exc:
                    if transport_retries < 3:
                        continue
                    exc = restart_exc
            raise EngineResponseError(f"engine request to {url} failed: {exc}") from exc
        except ValueError as exc:
            raise EngineResponseError(f"engine request to {url} failed: {exc}") from exc


def generate(endpoint: Endpoint, messages: list[dict[str, str]], *,
             json_schema: dict[str, Any] | None = None, max_tokens: int,
             think: bool = False, timeout: float = 30.0,
             options: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run one constrained generation and return the provider's raw response.

    ``options`` go to Ollama's ``options`` (e.g. ``num_ctx``, ``temperature``)
    and are merged top-level into an OpenAI-style payload."""
    if not endpoint._semaphore.acquire(timeout=timeout):
        raise EngineResponseError(f"{endpoint.name}: parallel request limit timed out")
    try:
        if endpoint.kind == "ollama":
            payload: dict[str, Any] = {"model": endpoint.model, "messages": messages,
                                       "stream": False, "think": think,
                                       "options": {"num_predict": max_tokens, **(options or {})}}
            if "keep_alive" in endpoint.capabilities:
                payload["keep_alive"] = endpoint.capabilities["keep_alive"]
            if json_schema is not None:
                payload["format"] = json_schema
            return _request(endpoint.url + "/api/chat", payload, timeout, endpoint)
        if endpoint.kind == "openai":
            payload = {"model": endpoint.model, "messages": messages,
                       "max_tokens": max_tokens, "temperature": 0,
                       "enable_thinking": think, **(options or {})}
            # Servers differ in how thinking is switched off; Splash ignores
            # enable_thinking and needs reasoning_effort "none" (measured
            # 2026-09-23: 46 vs 0 reasoning tokens).  engines.yaml says which.
            if not think and isinstance(endpoint.capabilities.get("no_think"), dict):
                payload.update(endpoint.capabilities["no_think"])
            if json_schema is not None:
                payload["response_format"] = {"type": "json_schema", "json_schema": {
                    "name": "pipeline_response", "strict": True, "schema": json_schema}}
            return _request(endpoint.url + "/chat/completions", payload, timeout, endpoint)
        raise EngineError(f"{endpoint.name}: unknown endpoint kind {endpoint.kind!r}")
    finally:
        endpoint._semaphore.release()


def _labels(question: Question) -> list[str]:
    if question.type == "choice":
        choices = list(question.options)
        if question.mit_unklar and "unklar" not in choices:
            choices.append("unklar")
        return choices
    if question.type == "noul":
        return ["ja", "nein"]
    if question.type == "score":
        return list(question.options) or [str(value) for value in range(2, 11)]
    raise ValueError(f"unknown question type {question.type!r}")


def _top_logprobs(response: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    if kind == "ollama":
        data = (response.get("message") or {}).get("logprobs") or response.get("logprobs")
    else:
        choices = response.get("choices") or []
        data = (choices[0].get("logprobs") or {}).get("content") if choices else None
    if not isinstance(data, list) or not data:
        raise EngineResponseError("engine did not return logprobs")
    token = data[0]
    candidates = token.get("top_logprobs", token) if isinstance(token, dict) else token
    if not isinstance(candidates, list):
        raise EngineResponseError("engine returned malformed top_logprobs")
    return [entry for entry in candidates if isinstance(entry, dict)]


def _probabilities(entries: list[dict[str, Any]], labels: list[str], temperature: float) -> dict[str, float]:
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    seen: dict[str, float] = {}
    for entry in entries:
        token = str(entry.get("token", "")).strip()
        if token in labels and "logprob" in entry:
            seen[token] = max(seen.get(token, float("-inf")), float(entry["logprob"]))
    weights = {label: math.exp(value / temperature) if label in seen else 0.0
               for label, value in ((label, seen.get(label, float("-inf"))) for label in labels)}
    total = sum(weights.values())
    if total == 0:
        return {label: 0.0 for label in labels}
    return {label: weight / total for label, weight in weights.items()}


def decide(state: str, questions: list[Question], *, registry: EngineRegistry | None = None,
           temperature: float | None = None, uncertain_threshold: float | None = None,
           timeout: float = 30.0, options: dict[str, Any] | None = None) -> list[Answer]:
    """Answer independently using one prefill-only token per question.

    ``temperature`` is intentionally an explicit calibration parameter.  Its
    default is neutral until B2's gold set supplies a fitted value.
    ``options`` go to Ollama's ``options`` (e.g. ``num_ctx``); the answer
    stays one token at temperature 0.
    """
    registry = registry or EngineRegistry.from_file()
    endpoint = registry.pick({"logprobs"})
    if endpoint is None:
        raise EngineUnavailable("no reachable engine with logprobs")
    temp = temperature if temperature is not None else float(os.environ.get("BRAIN_DECISION_TEMPERATURE", "1"))
    threshold = uncertain_threshold if uncertain_threshold is not None else float(os.environ.get("BRAIN_DECISION_UNCERTAIN_THRESHOLD", "0.65"))
    answers: list[Answer] = []
    for question in questions:
        choices = _labels(question)
        labels = [chr(ord("A") + index) for index in range(len(choices))]
        if len(labels) != len(choices) or len(labels) > 26:
            raise ValueError("a decision question supports at most 26 options")
        listing = "\n".join(f"{label}: {choice}" for label, choice in zip(labels, choices))
        top = min(len(labels), MAX_TOP_LOGPROBS)
        messages = [{"role": "system", "content": "Antworte nur mit einem Optionsbuchstaben."},
                    {"role": "user", "content": f"Zustand:\n{state}\n\nFrage: {question.text}\nOptionen:\n{listing}\nAntwort:"}]
        if endpoint.kind == "ollama":
            payload = {"model": endpoint.model, "messages": messages, "stream": False,
                       "think": False, "logprobs": True, "top_logprobs": top,
                       "options": {**(options or {}), "num_predict": 1, "temperature": 0}}
            if "keep_alive" in endpoint.capabilities:
                payload["keep_alive"] = endpoint.capabilities["keep_alive"]
            raw = _request(endpoint.url + "/api/chat", payload, timeout, endpoint)
        elif endpoint.kind == "openai":
            payload = {"model": endpoint.model, "messages": messages, "max_tokens": 1,
                       "temperature": 0, "logprobs": True, "top_logprobs": top,
                       "enable_thinking": False}
            raw = _request(endpoint.url + "/chat/completions", payload, timeout, endpoint)
        else:
            raise EngineError(f"{endpoint.name}: unknown endpoint kind {endpoint.kind!r}")
        label_probs = _probabilities(_top_logprobs(raw, endpoint.kind), labels, temp)
        probabilities = {choice: label_probs[label] for label, choice in zip(labels, choices)}
        choice = max(probabilities, key=probabilities.get)
        answers.append(Answer(question, probabilities, choice,
                              choice == "unklar" or probabilities[choice] < threshold))
    return answers


def pick(stage_needs: Iterable[str]) -> Endpoint | None:
    """Convenience entry point for later pipeline stages."""
    return EngineRegistry.from_file().pick(stage_needs)
