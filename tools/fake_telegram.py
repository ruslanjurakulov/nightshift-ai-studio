#!/usr/bin/env python3
"""A local stand-in for the Telegram Bot API, for the notify worker.

    python tools/fake_telegram.py [port]      # default 8081, 127.0.0.1 only
    NOTIFY_TELEGRAM_API_BASE=http://127.0.0.1:8081 python tools/notify_worker.py --once

Answers POST /bot<anything>/sendMessage and records the payload (GET /__sent
lists them, DELETE /__sent clears). The chat id picks the behaviour so every
failure the worker handles can be driven without Telegram:

    ends in 403   403 "Forbidden: bot was blocked by the user"
    ends in 429   429 with parameters.retry_after = 7
    ends in 500   500
    ends in 400   400 "Bad Request: chat not found"
    anything else 200 {"ok": true, "result": {"message_id": n}}

It never reaches the internet and never needs (or checks) a real token.
"""

from __future__ import annotations

import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Tuple

BEHAVIOURS: Dict[str, Tuple[int, Dict[str, Any]]] = {
    "403": (403, {"ok": False, "error_code": 403, "description": "Forbidden: bot was blocked by the user"}),
    "429": (429, {"ok": False, "error_code": 429, "description": "Too Many Requests: retry after 7",
                  "parameters": {"retry_after": 7}}),
    "500": (500, {"ok": False, "error_code": 500, "description": "Internal Server Error"}),
    "400": (400, {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"}),
}


class FakeTelegram:
    def __init__(self) -> None:
        self.sent: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def respond(self, payload: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        chat = str(payload.get("chat_id", ""))
        with self._lock:
            for suffix, answer in BEHAVIOURS.items():
                if chat.endswith(suffix):
                    return answer
            self.sent.append(payload)
            return 200, {"ok": True, "result": {"message_id": len(self.sent)}}


def make_handler(fake: FakeTelegram):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: Any) -> None:
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            try:
                payload = json.loads(self.rfile.read(min(length, 65536)) or b"{}")
            except ValueError:
                return self._send(400, {"ok": False, "description": "Bad Request: invalid json"})
            if not re.fullmatch(r"/bot[^/]+/sendMessage", self.path) or not isinstance(payload, dict):
                return self._send(404, {"ok": False, "description": "Not Found"})
            status, body = fake.respond(payload)
            self._send(status, body)

        def do_GET(self):  # noqa: N802
            if self.path == "/__sent":
                return self._send(200, fake.sent)
            self._send(404, {"ok": False})

        def do_DELETE(self):  # noqa: N802
            if self.path == "/__sent":
                fake.sent.clear()
                return self._send(200, [])
            self._send(404, {"ok": False})

        def log_message(self, *_):  # no access log: it would carry chat ids
            pass

    return Handler


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
    server = HTTPServer(("127.0.0.1", port), make_handler(FakeTelegram()))
    print(f"fake Telegram on http://127.0.0.1:{port} (nothing leaves this machine)")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
