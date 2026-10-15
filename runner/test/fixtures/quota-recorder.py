"""Loopback recorder for the Grok quota verifier.

Logs only the method and, for HTTP, the URL pathname (a proxy's
absolute-form target is reduced to its pathname, the query dropped); for
CONNECT it logs only that one happened. Never logs headers or bodies.
Every request is logged before anything depends on its method, so no
method can go unrecorded; one that cannot be parsed is logged as "?".
Answers 503 to every request, CONNECT included. Port 0 picks a free port.
Writes LOG.ready, holding the port, once it listens.
"""
import json
import socketserver
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

PORT = int(sys.argv[1])
LOG = sys.argv[2]


def record(entry):
    with open(LOG, "a") as log:
        log.write(json.dumps(entry) + "\n")


class Handler(BaseHTTPRequestHandler):
    def handle_one_request(self):
        self.raw_requestline = self.rfile.readline(65537)
        if not self.raw_requestline:
            self.close_connection = True
            return
        if len(self.raw_requestline) > 65536 or not self.parse_request():
            record({"method": "?"})
            self.close_connection = True
            return
        if self.command == "CONNECT":
            record({"method": "CONNECT"})
        else:
            raw = self.path
            absolute = raw.startswith(("http://", "https://"))
            path = urlsplit(raw).path if absolute else raw.split("?", 1)[0]
            record({"method": self.command, "path": path})
        self.send_response(503)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", PORT), Handler) as server:
    open(LOG, "a").close()
    with open(LOG + ".ready", "w") as ready:
        ready.write(str(server.server_address[1]))
    server.serve_forever()
