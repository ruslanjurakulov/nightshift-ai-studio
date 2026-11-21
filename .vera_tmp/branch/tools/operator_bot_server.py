#!/usr/bin/env python3
"""Operator bot, webhook mode — answers in well under a second instead of waiting
for a poll. OPTIONAL: polling (tools/run_telegram_control.py) keeps working
unchanged and is what runs until the owner does the steps in docs/operator-bot.md.

  python tools/operator_bot_server.py serve [--host 127.0.0.1] [--port 8089]
  python tools/operator_bot_server.py set-webhook --url https://<host>/telegram/operator
  python tools/operator_bot_server.py delete-webhook     # back to polling
  python tools/operator_bot_server.py info

Needs a place to run that is reachable over HTTPS: this repository's automatic
deploy does not start it (adding it would mean editing deploy_web.yml, which is
not done here). The exact steps, the Caddy snippet and the compose snippet are in
docs/operator-bot.md.

Environment (names only; values are never printed):
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ADMIN_USER_IDS   as for polling
  TELEGRAM_WEBHOOK_SECRET   the secret Telegram echoes in the
                            X-Telegram-Bot-Api-Secret-Token header (16-256 of A-Za-z0-9_-)
  SUPABASE_URL, SUPABASE_SERVICE_KEY, OPERATOR_*   as for polling

Telegram refuses getUpdates while a webhook is set (HTTP 409), so a scheduled
poll gets that answer and does nothing. `delete-webhook` returns to polling.
The secret is passed to setWebhook from the environment, never on a command line.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("operator_bot_server")

from modules import log_redaction
from modules.log_redaction import describe_http_error
from modules.operator_bot.config import valid_secret_token
from modules.operator_bot.webhook import DEFAULT_PATH, MAX_BODY_BYTES, WebhookService
from modules.telegram_control import TelegramControl

_API_BASE = "https://api.telegram.org"
ALLOWED_UPDATES = ["message", "callback_query"]


def make_handler(service: WebhookService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "op"
        sys_version = ""
        timeout = 15            # a client that stalls does not hold a thread forever

        def _respond(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                length = None
            headers = dict(self.headers.items())
            # Method, path, secret and declared size are decided BEFORE the body
            # is read: an unauthenticated caller costs one header comparison.
            refused = service.precheck("POST", self.path, headers, length)
            if refused:
                self.close_connection = True      # the unread body is not worth keeping the connection for
                return self._respond(*refused)
            body = self.rfile.read(length)
            status, out = service.handle("POST", self.path, headers, body)
            self._respond(status, out)

        def do_GET(self):
            self.close_connection = True
            self._respond(404, b"")

        do_PUT = do_DELETE = do_PATCH = do_HEAD = do_GET

        def log_message(self, *args):   # no access log: nothing here is worth a line
            return

    return Handler


def _control() -> TelegramControl:
    control = TelegramControl()
    if not control.enabled:
        raise SystemExit("Telegram is not configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).")
    return control


def serve(host: str, port: int, path: str) -> int:
    from tools.run_telegram_control import build_bot

    control = _control()
    secret = valid_secret_token(os.getenv("TELEGRAM_WEBHOOK_SECRET", ""))
    if not secret:
        raise SystemExit("TELEGRAM_WEBHOOK_SECRET is missing or malformed (16-256 of A-Za-z0-9_-): "
                         "refusing to start an endpoint that would accept anyone.")
    bot, sync = build_bot(control)
    service = WebhookService(bot, secret, sync, path=path)
    server = ThreadingHTTPServer((host, port), make_handler(service))
    server.daemon_threads = True
    logger.info("operator bot webhook listening on %s:%d%s", host, port, path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def _api(token: str, method: str, payload: dict, session=None):
    import requests

    session = session or requests
    try:
        resp = session.post(f"{_API_BASE}/bot{token}/{method}", json=payload, timeout=15)
        return resp.status_code, (resp.json() if resp.status_code == 200 else None)
    except Exception as e:
        logger.warning("Telegram %s failed (%s)", method, describe_http_error(e))
        return None, None


def valid_webhook_url(url: str) -> bool:
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(url)
        return (parts.scheme == "https" and bool(parts.hostname) and not parts.username
                and not parts.password and not parts.query and not parts.fragment and " " not in url)
    except ValueError:
        return False


def set_webhook(url: str, drop_pending: bool, session=None) -> int:
    control = _control()
    secret = valid_secret_token(os.getenv("TELEGRAM_WEBHOOK_SECRET", ""))
    if not secret:
        raise SystemExit("TELEGRAM_WEBHOOK_SECRET is missing or malformed (16-256 of A-Za-z0-9_-).")
    if not valid_webhook_url(url):
        raise SystemExit("--url must be an https:// URL without credentials or a query string.")
    status, body = _api(control._token, "setWebhook", {
        "url": url, "secret_token": secret, "allowed_updates": ALLOWED_UPDATES,
        "max_connections": 5, "drop_pending_updates": bool(drop_pending),
    }, session)
    ok = status == 200 and bool((body or {}).get("ok"))
    print("setWebhook: ok" if ok else f"setWebhook: failed (HTTP {status})")
    return 0 if ok else 1


def delete_webhook(session=None) -> int:
    control = _control()
    status, body = _api(control._token, "deleteWebhook", {"drop_pending_updates": False}, session)
    ok = status == 200 and bool((body or {}).get("ok"))
    print("deleteWebhook: ok (polling works again)" if ok else f"deleteWebhook: failed (HTTP {status})")
    return 0 if ok else 1


def info(session=None) -> int:
    control = _control()
    status, body = _api(control._token, "getWebhookInfo", {}, session)
    if status != 200 or not isinstance(body, dict):
        print(f"getWebhookInfo: failed (HTTP {status})")
        return 1
    r = body.get("result") or {}
    print(json.dumps({"webhook_set": bool(r.get("url")), "pending_update_count": r.get("pending_update_count"),
                      "last_error_date": r.get("last_error_date")}))
    return 0


def main(argv=None) -> int:
    log_redaction.install()
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("serve")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8089)
    p.add_argument("--path", default=DEFAULT_PATH)
    p = sub.add_parser("set-webhook")
    p.add_argument("--url", required=True)
    p.add_argument("--drop-pending", action="store_true")
    sub.add_parser("delete-webhook")
    sub.add_parser("info")
    args = parser.parse_args(argv)
    if args.cmd == "serve":
        return serve(args.host, args.port, args.path)
    if args.cmd == "set-webhook":
        return set_webhook(args.url, args.drop_pending)
    if args.cmd == "delete-webhook":
        return delete_webhook()
    return info()


if __name__ == "__main__":
    sys.exit(main())
