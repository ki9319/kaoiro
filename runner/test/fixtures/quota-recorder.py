"""Loopback recorder for the Grok quota verifier.

Logs only the method and, for HTTP, the URL pathname (a proxy's
absolute-form target is reduced to its pathname, the query dropped); for
CONNECT it logs only that one happened. Never logs headers or bodies.
Answers 503 to every request and refuses CONNECT. Writes LOG.ready once
it listens.
"""
import json
import socketserver
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

PORT = int(sys.argv[1])
LOG = sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def _record(self):
        if self.command == "CONNECT":
            entry = {"method": "CONNECT"}
        else:
            raw = self.path
            absolute = raw.startswith(("http://", "https://"))
            path = urlsplit(raw).path if absolute else raw.split("?", 1)[0]
            entry = {"method": self.command, "path": path}
        with open(LOG, "a") as log:
            log.write(json.dumps(entry) + "\n")
        self.send_response(503)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _record
    do_CONNECT = do_OPTIONS = _record

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", PORT), Handler) as server:
    open(LOG, "a").close()
    open(LOG + ".ready", "w").close()
    server.serve_forever()
