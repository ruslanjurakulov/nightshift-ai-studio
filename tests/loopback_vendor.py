"""A real HTTPS server on 127.0.0.1 that plays a vendor, for adapter tests.

The older capability tests drive adapters through a fake ``session`` object,
which cannot show what only a real socket shows: that a key is (not) sent to
the download host, that a redirect is (not) followed, that a stream cut short
leaves no file, that a connection dropped after the request was read is
reported as a lost answer and not as a refusal. This server is the smallest
thing that can: ``ThreadingHTTPServer`` wrapped in TLS with a throw-away
certificate made by ``openssl`` for ``localhost`` / ``127.0.0.1``, and a
``requests.Session`` that trusts only that certificate (and ignores any proxy
from the environment, so 127.0.0.1 never goes through the agent proxy).

Nothing here reaches the internet and no real key is involved.
"""

from __future__ import annotations

import json
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Dict, List, Optional

import requests

_CERT_DIR: Optional[Path] = None


def _certificate() -> Path:
    """One self-signed certificate per test process (openssl takes a moment)."""
    global _CERT_DIR
    if _CERT_DIR is None:
        d = Path(tempfile.mkdtemp(prefix="loopback_vendor_"))
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
             "-keyout", str(d / "key.pem"), "-out", str(d / "cert.pem"), "-subj", "/CN=localhost",
             "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
            check=True, capture_output=True, timeout=60)
        _CERT_DIR = d
    return _CERT_DIR / "cert.pem"


def cleanup_certificate() -> None:
    global _CERT_DIR
    if _CERT_DIR is not None:
        shutil.rmtree(_CERT_DIR, ignore_errors=True)
        _CERT_DIR = None


class Req:
    """What the server saw."""

    def __init__(self, method: str, path: str, headers: Dict[str, str], body: bytes):
        self.method, self.path, self.headers, self.body = method, path, headers, body

    def json(self):
        return json.loads(self.body or b"{}")


class Resp:
    def __init__(self, status: int = 200, body=None, *, headers: Optional[Dict[str, str]] = None,
                 raw: Optional[bytes] = None, declared_length: Optional[int] = None,
                 drop: bool = False, hang_s: float = 0.0, chunks=None):
        """``body`` is JSON-encoded; ``raw`` is sent as is. ``declared_length`` lies about
        Content-Length (a stream cut short); ``drop`` closes the connection without an
        answer; ``hang_s`` waits before answering; ``chunks`` streams an iterable of bytes
        with no Content-Length."""
        self.status, self.headers = status, dict(headers or {})
        self.raw = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
        self.declared_length, self.drop, self.hang_s, self.chunks = declared_length, drop, hang_s, chunks


Handler = Callable[[Req], Resp]


class FakeVendor:
    def __init__(self):
        self.requests: List[Req] = []
        self._routes: List[tuple] = []
        self._lock = threading.Lock()
        vendor = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # keep test output quiet
                pass

            def _serve(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                req = Req(self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body)
                with vendor._lock:
                    vendor.requests.append(req)
                    handler = next((h for m, prefix, h in vendor._routes
                                    if m == self.command and self.path.startswith(prefix)), None)
                resp = handler(req) if handler else Resp(404, {"error": {"code": "NotFound", "message": "no route"}})
                if resp.hang_s:
                    time.sleep(resp.hang_s)
                if resp.drop:
                    # The request was read in full; the answer never comes.
                    self.close_connection = True
                    self.connection.shutdown(2)
                    return
                try:
                    self._answer(resp)
                except OSError:
                    pass                                # the client gave up (a size cap, a timeout): not news

            def _answer(self, resp):
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    self.send_header(k, v)
                if resp.chunks is not None:
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    for c in resp.chunks:
                        self.wfile.write(b"%x\r\n" % len(c) + c + b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                    self.close_connection = True
                    return
                length = len(resp.raw) if resp.declared_length is None else resp.declared_length
                self.send_header("Content-Length", str(length))
                self.end_headers()
                self.wfile.write(resp.raw)
                if resp.declared_length is not None and resp.declared_length > len(resp.raw):
                    self.wfile.flush()
                    self.close_connection = True   # cut short: the client gets fewer bytes than promised

            do_GET = do_POST = do_PUT = do_DELETE = _serve

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self._httpd.daemon_threads = True
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cert = _certificate()
        ctx.load_cert_chain(str(cert), str(cert.with_name("key.pem")))
        self._httpd.socket = ctx.wrap_socket(self._httpd.socket, server_side=True)
        self.port = self._httpd.server_address[1]
        self.base_url = f"https://localhost:{self.port}"
        self._thread = threading.Thread(target=lambda: self._httpd.serve_forever(poll_interval=0.02), daemon=True)
        self._thread.start()

    def on(self, method: str, prefix: str, handler) -> "FakeVendor":
        """Answer ``method`` requests whose path starts with ``prefix``: ``handler`` is a
        ``Resp`` or a ``Req -> Resp`` function; a list of them answers in turn (the last one repeats)."""
        if isinstance(handler, Resp):
            fn = lambda req, r=handler: r  # noqa: E731
        elif isinstance(handler, list):
            queue = list(handler)

            def fn(req, q=queue):
                return q.pop(0) if len(q) > 1 else q[0]
        else:
            fn = handler
        with self._lock:
            self._routes.append((method, prefix, fn))
        return self

    def session(self) -> requests.Session:
        s = requests.Session()
        s.trust_env = False                      # 127.0.0.1 must not go through the agent proxy
        s.verify = str(_certificate())           # trust this certificate and nothing else
        return s

    def seen(self, method: str, prefix: str) -> List[Req]:
        with self._lock:
            return [r for r in self.requests if r.method == method and r.path.startswith(prefix)]

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


def closed_port_url() -> str:
    """An https URL whose port nothing listens on (a connection that cannot be opened)."""
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"https://localhost:{port}"
