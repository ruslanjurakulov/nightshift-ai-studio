#!/usr/bin/env python3
"""A local stand-in for the Telegram Bot API, for the notify worker.

    python tools/fake_telegram.py [port]      # default 8081, 127.0.0.1 only
    NOTIFY_TELEGRAM_API_BASE=http://127.0.0.1:8081 python tools/notify_worker.py --once

Answers POST /bot<anything>/sendMessage, /sendPhoto and /sendVideo and records the
payload (GET /__sent lists them, GET /__calls lists method + payload, DELETE /__sent
clears both). The chat id picks the behaviour so every failure the workers handle can
be driven without Telegram:

    ends in 403   403 "Forbidden: bot was blocked by the user"
    ends in 429   429 with parameters.retry_after = 7
    ends in 500   500
    ends in 400   400 "Bad Request: chat not found"
    ends in 401   401 "Unauthorized" (a refused bot token)
    ends in 777   200 with {"ok": false}: an answer that does not say whether it was posted
    ends in 888   200 with a body that is not JSON
    ends in 000   the connection is closed after the request is read, with no answer at all
    ends in 999   no answer for 3 seconds (a client with a shorter timeout sees a read timeout)
    anything else 200 {"ok": true, "result": {"message_id": n}}

The chat id may be negative (-100...) like a channel's.

It never reaches the internet and never needs (or checks) a real token.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Tuple

BEHAVIOURS: Dict[str, Tuple[int, Dict[str, Any]]] = {
    "403": (403, {"ok": False, "error_code": 403, "description": "Forbidden: bot was blocked by the user"}),
    "429": (429, {"ok": False, "error_code": 429, "description": "Too Many Requests: retry after 7",
                  "parameters": {"retry_after": 7}}),
    "500": (500, {"ok": False, "error_code": 500, "description": "Internal Server Error"}),
    "400": (400, {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"}),
    "401": (401, {"ok": False, "error_code": 401, "description": "Unauthorized"}),
    "777": (200, {"ok": False}),
}
#: Behaviours that are not a status and a JSON body; handled by the request handler.
RAW = {"888": "notjson", "000": "close", "999": "hang"}
HANG_SECONDS = 3.0


class FakeTelegram:
    def __init__(self) -> None:
        self.sent: List[Dict[str, Any]] = []
        self.calls: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def raw_behaviour(self, payload: Dict[str, Any]) -> str:
        chat = str(payload.get("chat_id", ""))
        return next((b for suffix, b in RAW.items() if chat.endswith(suffix)), "")

    def respond(self, payload: Dict[str, Any], method: str = "sendMessage") -> Tuple[int, Dict[str, Any]]:
        chat = str(payload.get("chat_id", ""))
        with self._lock:
            self.calls.append({"method": method, "payload": payload})
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
            m = re.fullmatch(r"/bot[^/]+/(sendMessage|sendPhoto|sendVideo)", self.path)
            if not m or not isinstance(payload, dict):
                return self._send(404, {"ok": False, "description": "Not Found"})
            raw = fake.raw_behaviour(payload)
            if raw == "close":
                fake.calls.append({"method": m.group(1), "payload": payload})
                self.close_connection = True
                return
            if raw == "hang":
                fake.calls.append({"method": m.group(1), "payload": payload})
                time.sleep(HANG_SECONDS)
                return
            if raw == "notjson":
                fake.calls.append({"method": m.group(1), "payload": payload})
                data = b"<html>not json</html>"
                self.send_response(200)
                self.send_header("content-type", "text/html")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            status, body = fake.respond(payload, m.group(1))
            self._send(status, body)

        def do_GET(self):  # noqa: N802
            if self.path == "/__sent":
                return self._send(200, fake.sent)
            if self.path == "/__calls":
                return self._send(200, fake.calls)
            self._send(404, {"ok": False})

        def do_DELETE(self):  # noqa: N802
            if self.path == "/__sent":
                fake.sent.clear()
                fake.calls.clear()
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
