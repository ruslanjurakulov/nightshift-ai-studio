#!/usr/bin/env python3
"""Notify worker: send the queued ``notification_outbox`` rows (migration 0102)
to the customer's linked Telegram chat.

    python tools/notify_worker.py            # loop forever
    python tools/notify_worker.py --once     # drain what is due, then exit

THE CUSTOMER BOT ONLY. This is not the operator bot (modules/telegram_control.py,
TELEGRAM_BOT_TOKEN): its token is never read here. Environment, by name:

    SUPABASE_URL, SUPABASE_SERVICE_KEY   the worker's env file, as the other workers
    TELEGRAM_CUSTOMER_BOT_TOKEN          the customer bot's token (BotFather)
    NOTIFY_APP_ORIGIN                    https://<the app>, the link back in a message
    NOTIFY_TELEGRAM_API_BASE             optional; a local fake (tools/fake_telegram.py)
                                         instead of Telegram. Unset = the real API.

Off unless the token AND the origin are set: with either missing the worker says
so and idles WITHOUT claiming, so nothing is sent and nothing is lost (queued
rows expire after 24 hours, never sent late).

What it never does: retry a message that may already have been delivered (a
lost claim ends as 'unconfirmed' in the database), keep sending to a chat that
blocked the bot (the database marks it blocked and drops its queue), or log a
token, a chat id or a message (log lines carry counts and codes).
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import log_redaction  # noqa: E402
from modules import notify_telegram as nt  # noqa: E402

logger = logging.getLogger("notify_worker")

BATCH = 10
IDLE_SECONDS = 5.0
LEASE_SECONDS = 60


class QueueUnavailable(RuntimeError):
    """The outbox could not be reached. The message holds a function name and an
    HTTP status, never a body or a key."""


class OutboxQueue:
    """claim_ / complete_notification_outbox over PostgREST with the service key."""

    def __init__(self, url: str, service_key: str, *, session: Any = None, timeout: float = 20.0):
        import requests  # noqa: PLC0415

        self.url = url.rstrip("/")
        self._key = service_key
        self._http = session or requests.Session()
        self._timeout = timeout

    def _rpc(self, name: str, body: Dict[str, Any]) -> Any:
        try:
            r = self._http.post(
                f"{self.url}/rest/v1/rpc/{name}", json=body, timeout=self._timeout,
                headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                         "Content-Type": "application/json"})
        except Exception as e:  # noqa: BLE001
            raise QueueUnavailable(f"{name}: {log_redaction.describe_http_error(e)}") from None
        if r.status_code >= 300:
            raise QueueUnavailable(f"{name}: HTTP {r.status_code} (is migration 0102 applied?)")
        try:
            return r.json()
        except ValueError:
            return None

    def claim(self, worker_id: str, limit: int = BATCH) -> List[Dict[str, Any]]:
        rows = self._rpc("claim_notification_outbox",
                         {"p_worker": worker_id, "p_limit": limit, "p_lease_seconds": LEASE_SECONDS})
        return rows if isinstance(rows, list) else []

    def complete(self, row_id: str, worker_id: str, result: nt.SendResult) -> bool:
        return bool(self._rpc("complete_notification_outbox", {
            "p_id": row_id, "p_worker": worker_id, "p_outcome": result.outcome,
            "p_error_code": result.error_code, "p_retry_after_s": result.retry_after,
            "p_provider_message_id": result.message_id}))


def process_batch(queue: Any, client: nt.TelegramClient, limiter: nt.SendLimiter, app_origin: str,
                  worker_id: str, limit: int = BATCH) -> Dict[str, int]:
    """Claim one batch, send each message, settle each. Returns counts by outcome."""
    counts: Dict[str, int] = {}
    for row in queue.claim(worker_id, limit):
        chat = str(row.get("external_id") or "")
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        payload = nt.build_message(app_origin, chat, str(row.get("event_kind")), data, row.get("locale"))
        if payload is None or not chat:
            result = nt.SendResult("dead", "bad_request")
        else:
            limiter.wait(chat)
            result = client.send_message(payload)
        try:
            queue.complete(row["id"], worker_id, result)
        except QueueUnavailable as e:
            # Sent but not settled: the lease runs out and the row ends as
            # 'unconfirmed'. It is NOT sent again.
            logger.warning("could not settle a message (%s)", e)
        key = result.error_code or result.outcome
        counts[key] = counts.get(key, 0) + 1
    return counts


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Send queued notifications to linked Telegram chats (migration 0102)")
    parser.add_argument("--once", action="store_true", help="Drain what is due, then exit")
    parser.add_argument("--worker-id", default=os.environ.get("NIGHTSHIFT_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s notify_worker %(levelname)s %(message)s")
    log_redaction.install()

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file.")
        return 2
    token = os.environ.get("TELEGRAM_CUSTOMER_BOT_TOKEN", "").strip()
    origin = nt.valid_app_origin(os.environ.get("NOTIFY_APP_ORIGIN"))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    if not token or not origin:
        logger.warning("customer notifications are OFF: set TELEGRAM_CUSTOMER_BOT_TOKEN and NOTIFY_APP_ORIGIN "
                       "(https://...) in the worker's env file. Nothing is claimed.")
        if args.once:
            return 0
        stop.wait()
        return 0

    import requests  # noqa: PLC0415

    client = nt.TelegramClient(token, nt.api_base_from_env(os.environ), requests.Session())
    queue = OutboxQueue(url, key)
    limiter = nt.SendLimiter()
    while not stop.is_set():
        try:
            counts = process_batch(queue, client, limiter, origin, args.worker_id)
        except QueueUnavailable as e:
            logger.warning("outbox unavailable (%s)", e)
            counts = {}
        if counts:
            logger.info("settled %s", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        if args.once:
            return 0
        if not counts:
            stop.wait(IDLE_SECONDS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
