#!/usr/bin/env python3
"""Run-bound Unix-socket HTTP proxy for Agents model transports."""

from __future__ import annotations

import http.client
import ipaddress
import json
import math
import os
import re
import socket
import socketserver
import ssl
import stat
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlsplit


MAX_REQUEST_BYTES = 8 * 1024 * 1024
DEFAULT_IO_TIMEOUT = 300.0
STREAM_CHUNK_BYTES = 64 * 1024
ROUTES = {
    "anthropic-messages": "/v1/messages?beta=true",
    "openai-responses": "/v1/responses",
    # Chat-Completions fuer lokale Inferenzserver (Ollama, llama.cpp), die Pi mit openai-completions spricht.
    "openai-completions": "/v1/chat/completions",
}
FORWARDED_REQUEST_HEADERS = frozenset(
    {"accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"}
)
FORWARDED_RESPONSE_HEADERS = frozenset({"cache-control", "content-length", "content-type", "retry-after", "request-id"})
# Ratenlimit-Header tragen nur Zeiten, Anteile und Zustaende. Der Harness braucht sie, um
# ein erschoepftes Abo-Kontingent zu erkennen, statt blind zu wiederholen.
LIMIT_HEADER_PREFIX = "anthropic-ratelimit-"
LIMIT_STATUSES = frozenset({401, 403, 429, 529})
_LIMIT_VALUE = re.compile(r"[A-Za-z0-9 .:_,+-]{0,128}\Z")
FORBIDDEN_TARGET_FIELDS = frozenset({"base_url", "baseURL", "endpoint", "host", "provider", "url"})
HOP_BY_HOP_HEADERS = frozenset(
    {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}
)
_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_MODEL_PATTERN = re.compile(r"[A-Za-z0-9._:/-]{1,512}\Z")
_HEADER_PATTERN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")


class ModelProxyError(Exception):
    """Expected configuration, policy, or transport failure."""


_EFFORT_VALUES = frozenset({"low", "medium", "high", "xhigh", "max"})
_THINKING_TYPES = frozenset({"enabled", "adaptive", "disabled"})


def _forward_response_header(name: str, value: str) -> bool:
    lowered = name.lower()
    if lowered in FORWARDED_RESPONSE_HEADERS:
        return True
    return lowered.startswith(LIMIT_HEADER_PREFIX) and bool(_LIMIT_VALUE.fullmatch(value))


def _validate_model_id(value: object) -> None:
    # Opaque provider identifier; never interpret it as a filesystem path.
    if not isinstance(value, str) or not _MODEL_PATTERN.fullmatch(value):
        raise ModelProxyError("Invalid model identifier")


@dataclass(frozen=True)
class ProxyBinding:
    """Immutable identity selected by the controller."""

    world_id: str
    agent_id: str
    run_id: str
    provider: str
    model: str

    def __post_init__(self) -> None:
        for name, value in vars(self).items():
            if name == "model":
                _validate_model_id(value)
                continue
            if not isinstance(value, str) or not _ID_PATTERN.fullmatch(value):
                raise ModelProxyError(f"Invalid binding field: {name}")


@dataclass(frozen=True)
class BackendConfig:
    """Controller-owned fixed upstream configuration."""

    provider: str
    model: str
    protocol: str
    kind: str
    base_url: str
    execution_host: str
    inference_host: str
    auth_headers: tuple[tuple[str, str], ...] = ()
    local_only: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.base_url, str):
            raise ModelProxyError("Backend URL must be a string")
        _validate_model_id(self.model)
        if not _ID_PATTERN.fullmatch(self.provider):
            raise ModelProxyError("Invalid backend provider or model")
        if self.protocol not in ROUTES:
            raise ModelProxyError("Unsupported model protocol")
        if self.kind not in {"local", "cloud"}:
            raise ModelProxyError("Backend kind must be local or cloud")
        if not _ID_PATTERN.fullmatch(self.execution_host) or not _ID_PATTERN.fullmatch(self.inference_host):
            raise ModelProxyError("Invalid execution or inference host")
        if self.kind == "local":
            if self.inference_host not in {"mac", "peer"}:
                raise ModelProxyError("Local inference is allowed only on canonical mac or peer hosts")
            if self.execution_host != self.inference_host:
                raise ModelProxyError("Remote local inference needs a separate explicit route")
        elif self.inference_host != "cloud":
            raise ModelProxyError("Cloud backend must declare inference_host=cloud")
        if not isinstance(self.local_only, bool):
            raise ModelProxyError("local_only must be boolean")
        _validate_auth_headers(self.auth_headers)
        _validate_backend_url(self)


def _validate_auth_headers(headers: object) -> tuple[tuple[str, str], ...]:
    # Fehlermeldungen nennen nie einen Headerwert: dort stehen Zugangsdaten.
    if not isinstance(headers, tuple) or any(
        not isinstance(item, tuple) or len(item) != 2 for item in headers
    ):
        raise ModelProxyError("Controller authentication headers must be an immutable tuple")
    seen: set[str] = set()
    for name, value in headers:
        if not isinstance(name, str):
            raise ModelProxyError("Invalid controller authentication header")
        lowered = name.lower()
        if not _HEADER_PATTERN.fullmatch(name) or lowered in seen or lowered in HOP_BY_HOP_HEADERS:
            raise ModelProxyError("Invalid controller authentication header")
        if lowered in {"host", "content-length"} or not isinstance(value, str) or "\r" in value or "\n" in value:
            raise ModelProxyError("Invalid controller authentication header")
        seen.add(lowered)
    return headers


@dataclass(frozen=True)
class _BackendTarget:
    scheme: str
    host: str | None
    port: int | None
    unix_path: Path | None


def _validate_backend_url(config: BackendConfig) -> _BackendTarget:
    parsed = urlsplit(config.base_url)
    if parsed.scheme == "unix":
        if parsed.netloc or parsed.query or parsed.fragment or not parsed.path.startswith("/"):
            raise ModelProxyError("Unix backend URL must contain one absolute socket path")
        if config.kind != "local":
            raise ModelProxyError("Unix backend must be local")
        return _BackendTarget("unix", None, None, Path(parsed.path))
    if parsed.scheme not in {"http", "https"}:
        raise ModelProxyError("Backend URL scheme is not allowed")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ModelProxyError("Backend URL must be an origin without credentials, query, or path")
    if not parsed.hostname:
        raise ModelProxyError("Backend URL has no host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ModelProxyError("Backend URL has an invalid port") from exc
    local_address = False
    try:
        local_address = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        local_address = False
    if config.kind == "local" and not local_address:
        raise ModelProxyError("Local backend must use a numeric loopback address or Unix socket")
    if config.local_only and (config.kind != "local" or config.execution_host != config.inference_host or not local_address):
        raise ModelProxyError("local_only refuses cloud, DNS, and remote backends")
    return _BackendTarget(parsed.scheme, parsed.hostname, port, None)


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: Path, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._unix_path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self._unix_path))


class _ThreadingUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, path: str, owner: "AgentsModelProxy"):
        self.owner = owner
        self.revoked = threading.Event()
        self._active_clients: set[socket.socket] = set()
        self._active_upstreams: set[http.client.HTTPConnection] = set()
        self._active_lock = threading.Lock()
        self._client_slots = threading.BoundedSemaphore(owner.max_connections)
        super().__init__(path, _ProxyHandler)

    def process_request(self, request, client_address):
        if not self._client_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._client_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._client_slots.release()

    def is_current(self) -> bool:
        if self.revoked.is_set():
            return False
        try:
            return self.owner.current_run_checker(self.owner.binding) is True
        except Exception:
            return False

    def register_client(self, client: socket.socket) -> None:
        with self._active_lock:
            self._active_clients.add(client)

    def unregister_client(self, client: socket.socket) -> None:
        with self._active_lock:
            self._active_clients.discard(client)

    def register_upstream(self, upstream: http.client.HTTPConnection) -> None:
        with self._active_lock:
            self._active_upstreams.add(upstream)

    def unregister_upstream(self, upstream: http.client.HTTPConnection) -> None:
        with self._active_lock:
            self._active_upstreams.discard(upstream)

    def close_active(self) -> None:
        with self._active_lock:
            clients = list(self._active_clients)
            upstreams = list(self._active_upstreams)
        for upstream in upstreams:
            try:
                upstream.close()
            except OSError:
                pass
        for client in clients:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                client.close()
            except OSError:
                pass

    def revoke_after_response(self) -> None:
        if self.revoked.is_set():
            return
        self.revoked.set()
        self.owner._schedule_stop()


class _ProxyHandler(BaseHTTPRequestHandler):
    server: _ThreadingUnixServer
    protocol_version = "HTTP/1.1"
    server_version = "AgentsModelProxy/1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(self.server.owner.io_timeout)
        self.server.register_client(self.connection)

    def finish(self) -> None:
        self.server.unregister_client(self.connection)
        try:
            super().finish()
        except OSError:
            pass

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send_json_error(self, status_code: int, code: str) -> None:
        body = json.dumps({"error": {"type": code, "message": code}}, separators=(",", ":")).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True

    def _reject_method(self) -> None:
        self._send_json_error(405, "method_not_allowed")

    do_CONNECT = _reject_method
    do_DELETE = _reject_method
    do_GET = _reject_method
    do_HEAD = _reject_method
    do_OPTIONS = _reject_method
    do_PATCH = _reject_method
    do_PUT = _reject_method
    do_TRACE = _reject_method

    def _drain_small_body(self) -> None:
        """Liest einen erlaubten, begrenzten Body vor einer Ablehnung weg.

        Ohne das schliesst der Proxy, waehrend der Client noch sendet, und der Client
        sieht statt der Fehlerantwort einen abgebrochenen Schreibvorgang.
        """
        if self.headers.get("Transfer-Encoding"):
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            return
        if length <= 0 or length > self.server.owner.max_request_bytes:
            return
        deadline = time.monotonic() + min(1.0, self.server.owner.io_timeout)
        remaining_bytes = length
        try:
            while remaining_bytes > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self.connection.settimeout(remaining)
                chunk = self.rfile.read(min(STREAM_CHUNK_BYTES, remaining_bytes))
                if not chunk:
                    return
                remaining_bytes -= len(chunk)
        except (OSError, ValueError):
            return
        finally:
            try:
                self.connection.settimeout(self.server.owner.io_timeout)
            except OSError:
                pass

    def _read_request_body(self) -> bytes | None:
        if self.headers.get("Transfer-Encoding"):
            self._send_json_error(400, "transfer_encoding_not_allowed")
            return None
        if self.headers.get("Content-Encoding"):
            self._drain_small_body()
            self._send_json_error(400, "content_encoding_not_allowed")
            return None
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            length = -1
        if length < 0:
            self._send_json_error(411, "content_length_required")
            return None
        if length > self.server.owner.max_request_bytes:
            self._send_json_error(413, "request_too_large")
            return None
        body = bytearray()
        deadline = time.monotonic() + self.server.owner.io_timeout
        while len(body) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._send_json_error(408, "request_timeout")
                return None
            self.connection.settimeout(remaining)
            try:
                chunk = self.rfile.read(min(STREAM_CHUNK_BYTES, length - len(body)))
            except socket.timeout:
                self._send_json_error(408, "request_timeout")
                return None
            except (OSError, ValueError):
                self.close_connection = True
                return None
            if not chunk:
                self._send_json_error(400, "incomplete_request")
                return None
            body.extend(chunk)
        self.connection.settimeout(self.server.owner.io_timeout)
        return bytes(body)

    def do_POST(self) -> None:  # noqa: N802
        if not self.server.is_current():
            self._send_json_error(410, "run_revoked")
            self.server.revoke_after_response()
            return
        expected_path = ROUTES[self.server.owner.backend.protocol]
        if self.path != expected_path:
            self._drain_small_body()
            self._send_json_error(404, "route_not_allowed")
            return
        body = self._read_request_body()
        if body is None:
            return
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json_error(400, "invalid_json")
            return
        if not isinstance(payload, dict) or payload.get("model") != self.server.owner.binding.model:
            self._send_json_error(409, "model_binding_mismatch")
            return
        if set(payload) & FORBIDDEN_TARGET_FIELDS:
            self._send_json_error(400, "target_field_not_allowed")
            return
        if not self.server.is_current():
            self._send_json_error(410, "run_revoked")
            self.server.revoke_after_response()
            return
        self._forward(body, expected_path, payload)

    def _forward(self, body: bytes, path: str, payload: dict[str, object] | None = None) -> None:
        owner = self.server.owner
        try:
            auth_headers = owner._current_auth_headers()
        except Exception:
            owner._count("controller_auth_unavailable")
            self._send_json_error(503, "controller_auth_unavailable")
            return
        if payload is not None:
            owner._note_request(payload)
        upstream = owner._new_upstream()
        self.server.register_upstream(upstream)
        headers: dict[str, str] = {}
        for name, value in self.headers.items():
            lowered = name.lower()
            if lowered in FORWARDED_REQUEST_HEADERS:
                headers[name] = value
        for name, value in auth_headers:
            headers[name] = value
        headers["Content-Length"] = str(len(body))
        response_started = False
        try:
            upstream.request("POST", path, body=body, headers=headers)
            response = upstream.getresponse()
            owner._count(str(response.status))
            if 300 <= response.status < 400:
                response.close()
                self._send_json_error(502, "backend_redirect_refused")
                return
            if response.status in LIMIT_STATUSES:
                owner._record_limit(response.status, response.getheaders())
            self.send_response(response.status)
            for name, value in response.getheaders():
                if _forward_response_header(name, value):
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
            response_started = True
            while True:
                if not self.server.is_current():
                    self.server.revoke_after_response()
                    return
                chunk = response.read1(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                if not self.server.is_current():
                    self.server.revoke_after_response()
                    return
                self.wfile.write(chunk)
                self.wfile.flush()
            self.close_connection = True
        except (TimeoutError, socket.timeout, ConnectionError, OSError, http.client.HTTPException, ssl.SSLError):
            owner._count("transport_error")
            if not response_started and not self.wfile.closed:
                try:
                    self._send_json_error(502, "backend_transport_error")
                except (BrokenPipeError, OSError):
                    pass
            self.close_connection = True
        finally:
            upstream.close()
            self.server.unregister_upstream(upstream)


class AgentsModelProxy:
    """One controller-owned model endpoint for one immutable agent run."""

    def __init__(
        self,
        binding: ProxyBinding,
        backend: BackendConfig,
        socket_path: Path,
        controller_root: Path,
        agent_write_roots: Iterable[Path],
        current_run_checker: Callable[[ProxyBinding], bool],
        *,
        socket_mode: int = 0o660,
        socket_group_gid: int | None = None,
        max_request_bytes: int = MAX_REQUEST_BYTES,
        io_timeout: float = DEFAULT_IO_TIMEOUT,
        max_connections: int = 8,
        auth_headers_provider: Callable[[], tuple[tuple[str, str], ...]] | None = None,
    ):
        if binding.provider != backend.provider or binding.model != backend.model:
            raise ModelProxyError("Backend does not match immutable provider/model binding")
        if not callable(current_run_checker):
            raise ModelProxyError("current-run checker is required")
        if auth_headers_provider is not None and not callable(auth_headers_provider):
            raise ModelProxyError("Authentication provider must be callable")
        if auth_headers_provider is not None and backend.auth_headers:
            raise ModelProxyError("Use either fixed or provided controller authentication")
        if type(max_connections) is not int or max_connections <= 0:
            raise ModelProxyError("Connection limit must be a positive integer")
        if socket_mode & 0o007 or socket_mode & ~0o777:
            raise ModelProxyError("Socket mode must not grant world access")
        if (type(max_request_bytes) is not int or max_request_bytes <= 0
                or type(io_timeout) not in (int, float)
                or not math.isfinite(io_timeout) or io_timeout <= 0):
            raise ModelProxyError("Request limit and I/O timeout must be positive")
        self.binding = binding
        self.backend = backend
        self.current_run_checker = current_run_checker
        self.socket_path = Path(socket_path)
        self.controller_root = Path(controller_root)
        self.agent_write_roots = tuple(Path(path) for path in agent_write_roots)
        self.socket_mode = socket_mode
        self.socket_group_gid = socket_group_gid
        self.max_request_bytes = max_request_bytes
        self.io_timeout = io_timeout
        self.max_connections = max_connections
        self._server: _ThreadingUnixServer | None = None
        self._thread: threading.Thread | None = None
        self._socket_inode: int | None = None
        self.auth_headers_provider = auth_headers_provider
        self._state_lock = threading.Lock()
        self._closed = False
        self._counts: dict[str, int] = {}
        self._counts_lock = threading.Lock()
        self._last_limit: dict[str, object] | None = None
        self._request_shapes: dict[str, int] = {}
        if socket_group_gid is not None and (not isinstance(socket_group_gid, int) or socket_group_gid < 0):
            raise ModelProxyError("Socket group id must be a non-negative integer")

    def _current_auth_headers(self) -> tuple[tuple[str, str], ...]:
        # Die Quelle wird je Anfrage gelesen, damit eine erneuerte Anmeldung ohne
        # Neustart wirkt. Ein Fehler der Quelle leitet nichts weiter.
        if self.auth_headers_provider is None:
            return self.backend.auth_headers
        return _validate_auth_headers(self.auth_headers_provider())

    def _count(self, key: str) -> None:
        with self._counts_lock:
            self._counts[key] = self._counts.get(key, 0) + 1

    def _note_request(self, payload: dict[str, object]) -> None:
        # Nur Form, kein Inhalt: welche Denkstufe und welche Thinking-Art die Anfrage traegt.
        config = payload.get("output_config")
        effort = config.get("effort") if isinstance(config, dict) else None
        thinking = payload.get("thinking")
        kind = thinking.get("type") if isinstance(thinking, dict) else None
        key = "effort=%s thinking=%s" % (effort if effort in _EFFORT_VALUES else "-",
                                         kind if kind in _THINKING_TYPES else "-")
        with self._counts_lock:
            self._request_shapes[key] = self._request_shapes.get(key, 0) + 1

    def request_shapes(self) -> dict[str, int]:
        """Weitergeleitete Anfragen je Denkstufe und Thinking-Art, ohne Inhalte."""
        with self._counts_lock:
            return dict(self._request_shapes)

    def upstream_counts(self) -> dict[str, int]:
        """Upstream-Statusklassen je Anzahl, ohne Inhalte oder Headerwerte."""
        with self._counts_lock:
            return dict(self._counts)

    def _record_limit(self, status: int, headers: Iterable[tuple[str, str]]) -> None:
        values = {name.lower(): value for name, value in headers
                  if (name.lower() == "retry-after" or name.lower().startswith(LIMIT_HEADER_PREFIX))
                  and _LIMIT_VALUE.fullmatch(value)}
        with self._counts_lock:
            self._last_limit = {"status": status, "at": time.time(), "headers": values}

    def upstream_limit(self) -> dict[str, object] | None:
        """Letzte Kontingent- oder Anmeldeabweisung des Backends: Status, Zeit, Limit-Header."""
        with self._counts_lock:
            return None if self._last_limit is None else dict(self._last_limit, headers=dict(self._last_limit["headers"]))

    def _validate_socket_location(self) -> None:
        if not self.socket_path.is_absolute() or not self.controller_root.is_absolute():
            raise ModelProxyError("Controller root and socket path must be absolute")
        for configured in (self.controller_root, self.socket_path.parent):
            if '..' in configured.parts:
                raise ModelProxyError("Controller paths must be canonical")
            for component in (configured, *configured.parents):
                try:
                    info = component.lstat()
                except OSError as exc:
                    raise ModelProxyError("Controller path ancestor is unavailable") from exc
                sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
                if (not stat.S_ISDIR(info.st_mode)
                        or info.st_uid not in {0, os.geteuid()}
                        or (info.st_mode & 0o022 and not sticky_root)):
                    raise ModelProxyError("Controller path ancestor is not trusted")
        if self.controller_root.is_symlink() or self.socket_path.parent.is_symlink():
            raise ModelProxyError("Controller socket path must not traverse configured symlinks")
        try:
            root = self.controller_root.resolve(strict=True)
            parent = self.socket_path.parent.resolve(strict=True)
        except OSError as exc:
            raise ModelProxyError("Controller socket parent does not exist") from exc
        if not root.is_dir() or not parent.is_dir() or not _is_within(parent, root):
            raise ModelProxyError("Socket must be inside the private controller root")
        if root.stat().st_uid != os.geteuid() or stat.S_IMODE(root.stat().st_mode) & 0o077:
            raise ModelProxyError("Controller root must be private")
        for component in (root, parent):
            if component.is_symlink() or stat.S_IMODE(component.stat().st_mode) & 0o022:
                raise ModelProxyError("Controller socket directory is not trusted")
        socket_candidate = parent / self.socket_path.name
        for write_root in self.agent_write_roots:
            try:
                resolved_write_root = write_root.resolve(strict=True)
            except OSError as exc:
                raise ModelProxyError("Agent write root does not exist") from exc
            if _is_within(socket_candidate, resolved_write_root):
                raise ModelProxyError("Controller socket is inside an agent-writable root")
        if self.socket_path.exists() or self.socket_path.is_symlink():
            raise ModelProxyError("Controller socket path already exists")

    def start(self) -> Path:
        with self._state_lock:
            if self._server is not None or self._closed:
                raise ModelProxyError("Model proxy cannot be started again")
            self._validate_socket_location()
            try:
                server = _ThreadingUnixServer(str(self.socket_path), self)
                self._socket_inode = self.socket_path.lstat().st_ino
                os.chmod(self.socket_path, self.socket_mode)
                if self.socket_group_gid is not None:
                    os.chown(self.socket_path, -1, self.socket_group_gid)
                thread = threading.Thread(target=server.serve_forever, name="agents-model-proxy", daemon=False)
                self._server = server
                self._thread = thread
                thread.start()
            except Exception:
                try:
                    server.server_close()  # type: ignore[possibly-undefined]
                except (OSError, UnboundLocalError):
                    pass
                self._unlink_owned_socket()
                raise
        return self.socket_path

    def _new_upstream(self) -> http.client.HTTPConnection:
        target = _validate_backend_url(self.backend)
        if target.scheme == "unix":
            assert target.unix_path is not None
            return _UnixHTTPConnection(target.unix_path, self.io_timeout)
        if target.scheme == "https":
            return http.client.HTTPSConnection(target.host, target.port, timeout=self.io_timeout)
        return http.client.HTTPConnection(target.host, target.port, timeout=self.io_timeout)

    def _schedule_stop(self) -> None:
        threading.Thread(target=self.stop, name="agents-model-proxy-revoke", daemon=True).start()

    def _unlink_owned_socket(self) -> None:
        try:
            current = self.socket_path.lstat()
        except FileNotFoundError:
            return
        if self._socket_inode is not None and current.st_ino == self._socket_inode and stat.S_ISSOCK(current.st_mode):
            self.socket_path.unlink()

    def stop(self) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            server = self._server
            thread = self._thread
        if server is not None:
            server.revoked.set()
            server.close_active()
            if thread is not None and thread.is_alive():
                server.shutdown()
            server.server_close()
        self._unlink_owned_socket()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(1.0, min(self.io_timeout, 5.0)))

    def join(self, timeout: float | None = None) -> None:
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)
            if thread.is_alive():
                raise ModelProxyError("Model proxy did not stop before deadline")

    def endpoint(self) -> str:
        """Return the exact controller socket path for typed launcher injection."""

        return str(self.socket_path)

    def __enter__(self) -> "AgentsModelProxy":
        self.start()
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.stop()
