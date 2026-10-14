"""wb_hub_dienst -- Socket-Uebernahme und Selbstende des Hubs unter launchd (Mac) und systemd (peer).

Entwurf 2.4: der Dienstverwalter haelt den Lausch-Socket auf 127.0.0.1:8790, `wb-hub serve
--socket-aktiviert` uebernimmt ihn, und der Hub beendet sich nach `hub.idleMinutes` ohne Anfrage und ohne
laufendes Backend. Der Dienstverwalter schaerft den Socket danach wieder an und startet den Hub bei der
naechsten Verbindung neu.

Wege (der erste passende gewinnt):
  systemd  LISTEN_PID == eigene PID und LISTEN_FDS >= 1: Deskriptor 3 (SD_LISTEN_FDS_START).
  launchd  nur macOS: launch_activate_socket("wb-hub") ueber ctypes (Schluessel im Sockets-Dict der plist).
Sonst Fehler (Exit 2 in serve): ein Hub ohne Dienstverwalter bindet selbst (`wb-hub serve`).

Umgebung (Tests): WB_HUB_SELBSTENDE_SEKUNDEN (sonst WB_HUB_IDLE_SEKUNDEN, sonst hub.idleMinutes * 60).
"""
import ctypes
import os
import socket
import sys

LAUNCHD_NAME = "wb-hub"
SD_LISTEN_FDS_START = 3
ERLAUBTE_ADRESSEN = ("127.0.0.1",)


class KeinSocket(Exception):
    pass


def _systemd_deskriptoren():
    """LISTEN_FDS/LISTEN_PID wie sd_listen_fds(3); Umgebung danach geleert, damit Kinder sie nicht erben."""
    pid = os.environ.get("LISTEN_PID")
    anzahl = os.environ.get("LISTEN_FDS")
    if pid is None and anzahl is None:
        return None
    for k in ("LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"):
        os.environ.pop(k, None)
    try:
        if int(pid) != os.getpid():
            raise KeinSocket("LISTEN_PID gehoert einem anderen Prozess")
        n = int(anzahl)
    except (TypeError, ValueError):
        raise KeinSocket("LISTEN_PID/LISTEN_FDS ungueltig")
    if n < 1:
        raise KeinSocket("LISTEN_FDS ohne Deskriptor")
    fds = list(range(SD_LISTEN_FDS_START, SD_LISTEN_FDS_START + n))
    for fd in fds:
        try:
            os.set_inheritable(fd, False)
        except OSError:
            raise KeinSocket("Deskriptor %d ist nicht offen" % fd)
    return fds


def _launchd_deskriptoren(name):
    """launch_activate_socket(3): int-Vektor mit malloc, vom Aufrufer freizugeben. rc != 0 ist die errno
    (ESRCH: nicht von launchd gestartet, ENOENT: Name steht nicht in der plist)."""
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        fn = libc.launch_activate_socket
    except AttributeError:
        raise KeinSocket("launch_activate_socket gibt es nur unter macOS")
    fn.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.POINTER(ctypes.c_int)),
                   ctypes.POINTER(ctypes.c_size_t)]
    fn.restype = ctypes.c_int
    libc.free.argtypes = [ctypes.c_void_p]
    libc.free.restype = None
    vektor = ctypes.POINTER(ctypes.c_int)()
    anzahl = ctypes.c_size_t(0)
    rc = fn(name.encode("utf-8"), ctypes.byref(vektor), ctypes.byref(anzahl))
    if rc != 0:
        raise KeinSocket("launch_activate_socket('%s'): %s" % (name, os.strerror(rc)))
    fds = [vektor[i] for i in range(anzahl.value)]
    libc.free(vektor)
    if not fds:
        raise KeinSocket("launch_activate_socket('%s') ohne Deskriptor" % name)
    for fd in fds:
        os.set_inheritable(fd, False)
    return fds


def socket_uebernehmen():
    """-> lauschender IPv4-Stream-Socket auf 127.0.0.1 (nur der erste Deskriptor; weitere werden geschlossen).
    Wirft KeinSocket, wenn kein Dienstverwalter einen Socket gibt oder er nicht loopback-gebunden ist."""
    fds = _systemd_deskriptoren()
    if fds is None:
        if sys.platform != "darwin":
            raise KeinSocket("weder LISTEN_FDS noch launchd: nicht dienstgestartet")
        fds = _launchd_deskriptoren(LAUNCHD_NAME)
    for fd in fds[1:]:
        os.close(fd)
    try:
        sock = socket.socket(fileno=fds[0])
    except OSError as e:
        raise KeinSocket("Deskriptor %d ist kein Socket: %s" % (fds[0], e.strerror))
    if sock.family != socket.AF_INET or sock.type != socket.SOCK_STREAM:
        sock.close()
        raise KeinSocket("Socket ist kein IPv4-Stream")
    adresse = sock.getsockname()[0]
    if adresse not in ERLAUBTE_ADRESSEN:
        # Schutz 2.7: ein an 0.0.0.0 gebundener Socket wuerde den Hub ins Netz stellen.
        sock.close()
        raise KeinSocket("Socket nicht an 127.0.0.1 gebunden (%s)" % adresse)
    try:
        lauscht = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN)
    except OSError:
        lauscht = 1     # macOS kennt SO_ACCEPTCONN nicht; launchd liefert nur lauschende Sockets
    if lauscht != 1:
        sock.close()
        raise KeinSocket("Socket lauscht nicht")
    return sock


def selbstende_sekunden(idle_minuten):
    roh = os.environ.get("WB_HUB_SELBSTENDE_SEKUNDEN") or os.environ.get("WB_HUB_IDLE_SEKUNDEN")
    return float(roh) if roh else 60.0 * float(idle_minuten)
