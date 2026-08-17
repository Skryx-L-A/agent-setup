#!/usr/bin/env python3
"""Local dev server for the scroll-welt demo.

Serves engine/ (so demo/index.html reaches ../scrub-welt.js) and accepts PUT for
exactly one purpose: the headless build step hands a PNG that exportFrame()
produced back onto disk, without dragging a multi-megabyte data URL through the
tooling. Writes are confined to demo/assets/seams/ and to *.png.

    python3 demo/tools/serve.py [port]
"""
import os
import posixpath
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# Two write targets, both narrow: the seam frames the build step produces, and
# the evidence folder the verification run fills with screenshots.
WRITE_DIRS = (
    os.path.join(ROOT, 'demo', 'assets', 'seams'),
    os.path.join(ROOT, 'demo', 'verify'),
)
MAX_BYTES = 32 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_PUT(self):
        # Normalise first, then check containment: '..' must not be able to
        # climb out of the seam directory.
        rel = posixpath.normpath(self.path.lstrip('/'))
        target = os.path.abspath(os.path.join(ROOT, rel))
        allowed = any(os.path.commonpath([target, d]) == d for d in WRITE_DIRS)
        if not allowed or not target.endswith('.png'):
            self.send_error(403, 'writes are limited to *.png under demo/assets/seams/ and demo/verify/')
            return
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BYTES:
            self.send_error(413, 'bad content length')
            return
        data = self.rfile.read(length)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as fh:
            fh.write(data)
        self.send_response(201)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', '3')
        self.end_headers()
        self.wfile.write(b'ok\n')
        sys.stderr.write('PUT %s (%d bytes)\n' % (rel, len(data)))

    def end_headers(self):
        # No caching: the build step rewrites assets between page loads.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '200' not in (args[1] if len(args) > 1 else ''):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    sys.stderr.write('serving %s on http://127.0.0.1:%d/demo/index.html\n' % (ROOT, port))
    srv.serve_forever()
