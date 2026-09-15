"""Loopback access to one model-proxy socket inside an isolated run namespace."""
from __future__ import annotations

import selectors
import socket
import stat
import threading
from pathlib import Path


class ModelBridge:
    """Relay bytes; the external proxy owns authentication and request policy.

    Start this object inside the run's isolated network namespace, never in the
    host controller. Each connection has one bounded buffer in each direction.
    """

    def __init__(self, socket_path: str | Path = "/run/wb-model.sock", *,
                 max_connections: int = 8, idle_timeout: float = 120.0):
        self.path = Path(socket_path)
        if not self.path.is_absolute() or self.path.is_symlink():
            raise ValueError("Model socket must be an absolute non-symlink path")
        if not stat.S_ISSOCK(self.path.stat().st_mode):
            raise ValueError("Model socket is not a Unix socket")
        if not 1 <= max_connections <= 64 or not 0 < idle_timeout <= 3600:
            raise ValueError("Invalid bridge limits")
        self.idle_timeout = idle_timeout
        self._slots = threading.BoundedSemaphore(max_connections)
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._connections: set[socket.socket] = set()
        self._threads: set[threading.Thread] = set()
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(max_connections)
        self._listener.settimeout(0.2)
        self.url = "http://127.0.0.1:%d" % self._listener.getsockname()[1]
        self._accept_thread = threading.Thread(target=self._accept, daemon=True)
        self._accept_thread.start()

    def _accept(self) -> None:
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
                self._connections.add(client)
                thread = threading.Thread(target=self._relay, args=(client,), daemon=True)
                self._threads.add(thread)
                thread.start()

    def _relay(self, client: socket.socket) -> None:
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            with self._lock:
                if self._closed.is_set():
                    return
                self._connections.add(upstream)
            upstream.settimeout(min(self.idle_timeout, 5.0))
            upstream.connect(str(self.path))
            for connection in (client, upstream):
                connection.setblocking(False)
            peers = {client: upstream, upstream: client}
            buffers = {client: bytearray(), upstream: bytearray()}
            ended: set[socket.socket] = set()
            write_closed: set[socket.socket] = set()
            with selectors.DefaultSelector() as selector:
                while not self._closed.is_set():
                    active = False
                    for connection, peer in peers.items():
                        events = 0
                        if connection not in ended and len(buffers[peer]) < 65536:
                            events |= selectors.EVENT_READ
                        if buffers[connection]:
                            events |= selectors.EVENT_WRITE
                        elif peer in ended and connection not in write_closed:
                            connection.shutdown(socket.SHUT_WR)
                            write_closed.add(connection)
                        try:
                            selector.unregister(connection)
                        except KeyError:
                            pass
                        if events:
                            selector.register(connection, events)
                            active = True
                    if not active:
                        return
                    ready = selector.select(self.idle_timeout)
                    if not ready:
                        return
                    for key, events in ready:
                        connection = key.fileobj
                        peer = peers[connection]
                        if events & selectors.EVENT_READ:
                            try:
                                chunk = connection.recv(65536 - len(buffers[peer]))
                            except BlockingIOError:
                                chunk = None
                            if chunk:
                                buffers[peer].extend(chunk)
                            elif chunk == b"":
                                ended.add(connection)
                        if events & selectors.EVENT_WRITE:
                            try:
                                sent = connection.send(buffers[connection])
                            except BlockingIOError:
                                sent = 0
                            del buffers[connection][:sent]
        except OSError:
            # EOF is intentional on loss of the bound proxy. Never choose a
            # fallback network endpoint or replay a possibly processed request.
            pass
        finally:
            with self._lock:
                self._connections.discard(client)
                self._connections.discard(upstream)
                self._threads.discard(threading.current_thread())
            client.close()
            upstream.close()
            self._slots.release()

    def close(self) -> None:
        self._closed.set()
        self._listener.close()
        with self._lock:
            for connection in self._connections:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            threads = tuple(self._threads)
        self._accept_thread.join(timeout=1)
        for thread in threads:
            thread.join(timeout=1)
        if self._accept_thread.is_alive() or any(thread.is_alive() for thread in threads):
            raise RuntimeError("Bridge did not stop")

    def __enter__(self) -> "ModelBridge":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
