"""Private Unix transport for one controller-selected agent identity."""
from __future__ import annotations

import os
import select
from pathlib import Path
import socket
import stat
import threading
import time

from agents_controller import AgentController, ControllerError, _recv_frame, _send_frame, _validate_request
from agents_linux import SocketBinding


class ControllerEndpoint:
    """Finite, run-bound typed RPC channel without identity supplied by clients."""

    def __init__(self, controller: AgentController, agent_id: str, role: str,
                 path: Path, *, max_connections: int = 8, timeout: float = 5.0,
                 session_timeout: float = 300.0):
        if type(max_connections) is not int or not 1 <= max_connections <= 64:
            raise ValueError('Invalid controller connection limit')
        if not 0 < timeout <= 300 or not 0 < session_timeout <= 3600:
            raise ValueError('Invalid controller time limit')
        self.path = Path(path)
        if not self.path.is_absolute() or '..' in self.path.parts:
            raise ValueError('Controller socket path must be absolute and canonical')
        for parent in self.path.parents:
            info = parent.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.geteuid()}
                    or info.st_mode & 0o022):
                raise ValueError('Untrusted controller socket ancestor')
        parent = self.path.parent.stat()
        if parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
            raise ValueError('Controller socket needs a private owned directory')
        self._timeout = timeout
        self._session_timeout = session_timeout
        self._closed = threading.Event()
        self._lock = threading.Lock()
        self._clients: set[socket.socket] = set()
        self._threads: set[threading.Thread] = set()
        self._slots = threading.BoundedSemaphore(max_connections)
        self._client = controller.bind_agent(agent_id, role)
        self._listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._binding = None
        self._created_identity = None
        try:
            self._listener.bind(str(self.path))
            info = self.path.lstat()
            self._created_identity = (info.st_dev, info.st_ino)
            self.path.chmod(0o600)
            self._binding = SocketBinding(self.path, '/run/wb-controller.sock')
            self._listener.listen(max_connections)
            self._listener.settimeout(0.2)
            self._accept_thread = threading.Thread(target=self._accept, daemon=False,
                                                   name='agents-controller-listener')
            self._accept_thread.start()
        except BaseException:
            self._listener.close()
            self._client.close()
            self._unlink_owned()
            raise

    @property
    def binding(self) -> SocketBinding:
        return self._binding

    def _unlink_owned(self):
        try:
            info = self.path.lstat()
            if (info.st_dev, info.st_ino) == self._created_identity and stat.S_ISSOCK(info.st_mode):
                self.path.unlink()
        except FileNotFoundError:
            pass

    def _accept(self):
        while not self._closed.is_set():
            try:
                client, _ = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if not self._slots.acquire(blocking=False):
                client.close()
                continue
            with self._lock:
                if self._closed.is_set():
                    client.close()
                    self._slots.release()
                    return
                thread = threading.Thread(target=self._serve, args=(client,), daemon=False,
                                          name='agents-controller-connection')
                self._clients.add(client)
                self._threads.add(thread)
                try:
                    thread.start()
                except RuntimeError:
                    self._clients.discard(client)
                    self._threads.discard(thread)
                    client.close()
                    self._slots.release()

    def _serve(self, client):
        client.settimeout(self._timeout)
        deadline = time.monotonic() + self._session_timeout
        try:
            while not self._closed.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                if not select.select([client], [], [], min(0.2, remaining))[0]:
                    continue
                try:
                    frame_deadline = min(deadline, time.monotonic() + self._timeout)
                    operation, payload = _validate_request(_recv_frame(client, frame_deadline, self._timeout))
                    result = self._client.request(operation, payload)
                    _send_frame(client, {'ok': True, 'data': result})
                except ControllerError as exc:
                    _send_frame(client, {'ok': False, 'error': str(exc)})
                    return
        except (ControllerError, OSError, ValueError):
            pass
        finally:
            client.close()
            with self._lock:
                self._clients.discard(client)
                self._threads.discard(threading.current_thread())
            self._slots.release()

    def close(self):
        self._closed.set()
        self._listener.close()
        self._client.close()
        with self._lock:
            clients, threads = list(self._clients), list(self._threads)
        for client in clients:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            client.close()
        self._accept_thread.join(2)
        for thread in threads:
            thread.join(self._timeout + 1)
        self._unlink_owned()
        if self._accept_thread.is_alive() or any(thread.is_alive() for thread in threads):
            raise ControllerError('Controller endpoint did not stop within its deadline')
