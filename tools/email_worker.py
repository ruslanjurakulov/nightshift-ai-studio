#!/usr/bin/env python3
"""E-mail worker: send the "your video is ready" mails and the weekly summaries
(migration 0101, modules/email_notify.py).

    python tools/email_worker.py              # loop forever (poll every EMAIL_WORKER_POLL_SECONDS)
    python tools/email_worker.py --once       # one pass, then exit (cron, local runs)

OFF until the owner configures it: with NIGHTSHIFT_EMAIL_TRANSPORT / APP_ORIGIN
(and, for the real transport, RESEND_API_KEY and NIGHTSHIFT_EMAIL_FROM) unset, it
says which NAMES are missing and exits without touching the database or the
network. ``NIGHTSHIFT_EMAIL_TRANSPORT=fake`` writes the mails to a folder and
sends nothing: that is the setting for local runs and for the tests.

Who gets what is decided in the database, not here: email_claim_ready and
email_claim_weekly (service key only) return only mails a person has not switched
off, for a confirmed address, not sent before, with a lease so two workers never
send the same one; email_complete records the verdict. A crash between "sent" and
"recorded" can send one mail twice; the lease and the 6-hour window keep that
rare, and nothing here ever sends more than the database handed over.

Wiring it into the deploy (a compose service next to creative-worker) is a
separate change to the deploy files; this file runs wherever SUPABASE_URL and
SUPABASE_SERVICE_KEY are in the environment, which stays on the server, never in
the web app.

Logging: counts and machine codes only, never an address, a token, a body or a key.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import email_notify as mail  # noqa: E402
from modules.worker_status import WorkerStatusReporter  # noqa: E402

logger = logging.getLogger("email_worker")

DEFAULT_POLL_SECONDS = 60.0
BATCH = 20
LEASE_SECONDS = 300


class StoreError(RuntimeError):
    """A database call that did not answer. ``detail`` is safe to log."""

    def __init__(self, name: str, status: int):
        super().__init__(f"{name}: HTTP {status}")
        self.detail = f"{name} HTTP {status}"


class EmailStore:
    """The 0101 worker functions over PostgREST with the service key."""

    def __init__(self, url: str, service_key: str, *, session: Any = None, timeout: float = 30.0):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._session = session
        self._timeout = timeout

    def _http(self):
        if self._session is None:
            import requests  # noqa: PLC0415

            self._session = requests.Session()
        return self._session

    def rpc(self, name: str, payload: Dict[str, Any]) -> Any:
        r = self._http().post(
            f"{self.url}/rest/v1/rpc/{name}", json=payload, timeout=self._timeout,
            headers={"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
        if r.status_code >= 300:
            raise StoreError(name, int(r.status_code))
        return r.json()

    def claim_ready(self, worker: str, limit: int = BATCH) -> List[Dict[str, Any]]:
        out = self.rpc("email_claim_ready", {"p_worker": worker, "p_limit": limit, "p_lease_seconds": LEASE_SECONDS})
        return out if isinstance(out, list) else []

    def claim_weekly(self, worker: str, limit: int = BATCH) -> List[Dict[str, Any]]:
        out = self.rpc("email_claim_weekly", {"p_worker": worker, "p_limit": limit, "p_lease_seconds": LEASE_SECONDS})
        return out if isinstance(out, list) else []

    def complete(self, item: Mapping[str, Any], outcome: str, error: Optional[str] = None) -> None:
        self.rpc("email_complete", {"p_user": item["user_id"], "p_kind": item["kind"], "p_ref": item["ref"],
                                    "p_outcome": outcome, "p_error": error})


def send_one(item: Mapping[str, Any], transport: Any, origin: str) -> tuple[str, Optional[str]]:
    """Render and send one claimed item. Returns (outcome, error code) for
    email_complete: 'sent', 'retry' or 'dead'."""
    language = str(item.get("locale") or "en")
    try:
        render = mail.render_weekly if item.get("kind") == "weekly" else mail.render_ready
        message = render(item, language=language, origin=origin)
    except Exception as e:  # noqa: BLE001 — a malformed item will not fix itself
        return "dead", "render_" + type(e).__name__.lower()[:20]
    try:
        transport.send(message)
    except mail.TransportError as e:
        return ("dead" if e.permanent else "retry"), e.code
    except Exception as e:  # noqa: BLE001
        return "retry", "send_" + type(e).__name__.lower()[:20]
    return "sent", None


def run_once(store: EmailStore, transport: Any, origin: str, worker: str) -> Dict[str, int]:
    """One pass: claim ready mails, claim due summaries, send, record. Never raises."""
    counts = {"sent": 0, "retry": 0, "dead": 0, "claim_errors": 0}
    for claim in (store.claim_ready, store.claim_weekly):
        try:
            items = claim(worker)
        except Exception as e:  # noqa: BLE001
            counts["claim_errors"] += 1
            logger.warning("claim failed (%s)", getattr(e, "detail", type(e).__name__))
            continue
        for item in items:
            outcome, error = send_one(item, transport, origin)
            counts[outcome] += 1
            try:
                store.complete(item, outcome, error)
            except Exception as e:  # noqa: BLE001 — the lease will expire and the claim repeat
                logger.warning("could not record %s (%s)", outcome, getattr(e, "detail", type(e).__name__))
    return counts


def main(argv: Optional[List[str]] = None, env: Optional[Mapping[str, str]] = None,
         store_factory: Optional[Callable[[], EmailStore]] = None,
         reporter_factory: Optional[Callable[[str], Any]] = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--once", action="store_true", help="one pass, then exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    transport = mail.transport_from_env(env)
    if transport is None:
        logger.info("e-mail notifications are OFF; not configured: %s", mail.describe_off(env) or "unknown")
        return 0
    if store_factory is None:
        url, key = env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_KEY", "")
        if not url or not key:
            logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required")
            return 2
        store = EmailStore(url, key)
    else:
        store = store_factory()
    origin = mail.safe_origin(env.get("APP_ORIGIN")) or ""
    # The id starts with "email-": that prefix is what email_worker_online() looks for,
    # and the Settings switches are shown only while it reports.
    worker = ("email-" + (env.get("NIGHTSHIFT_WORKER_ID") or socket.gethostname()).removeprefix("email-"))[:64]
    poll = float(env.get("EMAIL_WORKER_POLL_SECONDS") or DEFAULT_POLL_SECONDS)

    reporter: Optional[Any] = None
    if not args.once:
        if reporter_factory is not None:
            reporter = reporter_factory(worker)
        elif env.get("SUPABASE_URL") and env.get("SUPABASE_SERVICE_KEY"):
            reporter = WorkerStatusReporter(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"], worker_id=worker, kind="other")
        if reporter is not None:
            reporter.start_heartbeat()

    stop = {"now": False}
    previous = (signal.signal(signal.SIGTERM, lambda *_: stop.update(now=True)),
                signal.signal(signal.SIGINT, lambda *_: stop.update(now=True)))
    while True:
        counts = run_once(store, transport, origin, worker)
        if any(counts.values()):
            logger.info("pass done via %s: %s", transport.name, counts)
        if args.once or stop["now"]:
            break
        slept = 0.0
        while slept < poll and not stop["now"]:
            time.sleep(1.0)
            slept += 1.0
        if stop["now"]:
            break
    signal.signal(signal.SIGTERM, previous[0])
    signal.signal(signal.SIGINT, previous[1])
    if reporter is not None:
        reporter.close("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
