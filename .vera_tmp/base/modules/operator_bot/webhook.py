"""The webhook half of the operator bot: what runs on an incoming POST.

Telegram can push updates to an HTTPS URL instead of waiting to be polled. This
module is the request handler, kept free of any server so it can be tested with
nothing but bytes and a dict; tools/operator_bot_server.py wraps it in a small
HTTP server and holds the setWebhook / deleteWebhook helpers.

The order of the checks is the point, and it is fixed:

1. method and path: anything else is a 404 with an empty body;
2. the ``X-Telegram-Bot-Api-Secret-Token`` header against TELEGRAM_WEBHOOK_SECRET,
   compared in constant time (``hmac.compare_digest``). No secret configured
   means the endpoint accepts NOTHING, never "everything";
3. the body size, then the JSON;
4. the sender allow-list (``router.classify``: allow-listed ``from.id`` in the
   admin chat, a message or a button press, not forwarded or edited) — BEFORE any
   database write or data read. A stranger's update costs a hash comparison and a
   dict lookup and then gets an empty 200 (a non-200 would only make Telegram
   retry it);
5. only then the durable claim of the ``update_id`` (a retried delivery is
   skipped) and the router.

The response is always an empty JSON object: a webhook reply is never where an
answer travels (the router sends messages itself), and a reply body would be one
more place for data to leak.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading
from typing import Mapping, Optional

from modules.operator_bot.router import CLAIMED_KINDS, OperatorBot, classify

logger = logging.getLogger(__name__)

SECRET_HEADER = "x-telegram-bot-api-secret-token"
DEFAULT_PATH = "/telegram/operator"
MAX_BODY_BYTES = 1_000_000

_OK = (200, b"{}")


def verify_secret(presented: Optional[str], expected: Optional[str]) -> bool:
    """Constant-time comparison. An empty/unset ``expected`` never matches, so a
    missing configuration refuses everything instead of opening the endpoint."""
    if not expected:
        return False
    return hmac.compare_digest((presented or "").encode("utf-8", "replace"), expected.encode("utf-8", "replace"))


def _header(headers: Mapping[str, str], name: str) -> str:
    for k, v in headers.items():
        if k.lower() == name:
            return v
    return ""


class WebhookService:
    def __init__(self, bot: OperatorBot, secret: Optional[str], claim_store=None, path: str = DEFAULT_PATH):
        self.bot = bot
        self.secret = secret or ""
        self.claim_store = claim_store
        self.path = path
        self._lock = threading.Lock()   # the router's limiters are not thread-safe

    def precheck(self, method: str, path: str, headers: Mapping[str, str],
                 content_length: Optional[int]) -> Optional[tuple[int, bytes]]:
        """The checks that need no body: method, path, the secret, the declared
        size. A server calls this BEFORE reading a single byte of the body, so a
        caller without the secret cannot make it buffer a megabyte. Returns the
        refusal, or None when the request may be read."""
        if method != "POST" or path != self.path:
            return 404, b""
        if not verify_secret(_header(headers, SECRET_HEADER), self.secret):
            return 403, b""
        if content_length is None:
            return 411, b""
        if content_length < 0 or content_length > MAX_BODY_BYTES:
            return 413, b""
        return None

    def handle(self, method: str, path: str, headers: Mapping[str, str], body: bytes) -> tuple[int, bytes]:
        refused = self.precheck(method, path, headers, len(body))
        if refused:
            return refused
        try:
            upd = json.loads(body.decode("utf-8"))
        except Exception:
            return 400, b""
        if not isinstance(upd, dict):
            return 400, b""

        # The allow-list, before any work that touches data or the database.
        inbound = classify(upd, self.bot.control)
        if inbound.kind not in CLAIMED_KINDS:
            return _OK

        durable = False
        try:
            update_id = int(upd.get("update_id"))
        except (TypeError, ValueError):
            return _OK
        store = self.claim_store
        if store is not None and getattr(store, "enabled", False):
            rows = store.insert_new("telegram_updates", [{"update_id": update_id}], on_conflict="update_id")
            if rows is not None:
                durable = True
                if not rows:
                    logger.info("Telegram update %d was already handled — skipped", update_id)
                    return _OK
        with self._lock:
            self.bot.handle_update(upd, durable=durable)
        return _OK
