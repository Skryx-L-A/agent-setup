#!/usr/bin/env python3
"""Agent-side typed RPC CLI for the fixed, sandbox-mounted controller channel."""
from __future__ import annotations

import argparse
import json
import socket
import sys

from agents_controller import AgentClient, ControllerError, MAX_FRAME, OPERATIONS, SLOW_OPERATIONS, _validate_request

SOCKET_PATH = '/run/wb-controller.sock'


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=sorted(OPERATIONS))
    args = parser.parse_args(argv)
    sock = None
    client = None
    try:
        raw = sys.stdin.buffer.read(MAX_FRAME + 1)
        if len(raw) > MAX_FRAME:
            raise ControllerError('RPC payload is too large')
        payload = json.loads(raw) if raw.strip() else {}
        operation, payload = _validate_request({'op': args.operation, 'payload': payload})
        sock = socket.socket(socket.AF_UNIX)
        sock.settimeout(5)
        sock.connect(SOCKET_PATH)
        client = AgentClient(sock, SLOW_OPERATIONS.get(operation, 5))
        result = client.request(operation, payload)
        print(json.dumps({'ok': True, 'data': result}, ensure_ascii=False))
        return 0
    except (ControllerError, OSError, ValueError, UnicodeError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 2
    finally:
        if client is not None:
            client.close()
        elif sock is not None:
            sock.close()


if __name__ == '__main__':
    raise SystemExit(main())
