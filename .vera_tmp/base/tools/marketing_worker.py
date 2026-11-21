#!/usr/bin/env python3
"""Marketing worker: draft the brand channel's posts and send the ones a person approved
(migration 0108, docs/MARKETING_POSTS.md).

    python tools/marketing_worker.py            # loop forever
    python tools/marketing_worker.py --once     # one drafting pass and one claim, then exit

THE BRAND CHANNEL BOT ONLY. Its own token, ``TELEGRAM_CHANNEL_BOT_TOKEN`` (never the operator bot's
``TELEGRAM_BOT_TOKEN``, never the customer bot's ``TELEGRAM_CUSTOMER_BOT_TOKEN``), and its own env file
(``.env.marketing``). Environment, by name:

    SUPABASE_URL, SUPABASE_SERVICE_KEY   this worker's own env file
    TELEGRAM_CHANNEL_BOT_TOKEN           the dedicated bot (BotFather); an admin of the channel with
                                         "Post messages" only
    MARKETING_TELEGRAM_CHAT              the ONE channel it posts to: ``@name`` or a numeric id. Point it at a
                                         private test channel first (docs/MARKETING_POSTS.md)
    NOTIFY_APP_ORIGIN                    https://<our site>: the link in a post, and where media is fetched
    NIGHTSHIFT_MARKETING_POSTS           ``on`` or nothing. Anything but ``on`` and this worker does NOTHING:
                                         no draft, no claim, no request to Telegram
    NOTIFY_TELEGRAM_API_BASE             optional, local runs only: tools/fake_telegram.py instead of Telegram

Per loop it (1) drafts, at most once an hour: the public items of docs/news/, the public, unexpired and evidenced
files of docs/promo/ (migration 0110) and, from the database's plans and entitlements only, the month's price
post; then (2) claims AT MOST ONE approved post and sends it. What it
never does: send anything the database did not hand over (the cap, the kill switch, the approval and the hash
are all checked there), send a post again after the answer was lost (a lost lease ends as dead/unconfirmed in
the database), overwrite words a person edited (the SQL refuses), put a currency amount in a price post, or log
a token, a chat, a text or a body (log lines carry counts and codes).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import logging
import os
import re
import signal
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlsplit

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import channel_post as cp  # noqa: E402
from modules import log_redaction  # noqa: E402
from modules import marketing_content as mc  # noqa: E402
from modules import notify_telegram as nt  # noqa: E402

logger = logging.getLogger("marketing_worker")
# urllib3 logs `POST /bot<token>/sendMessage` at DEBUG, and the bot token is that path segment. Never let it
# speak below WARNING, whatever level the root logger is turned up to (CLAUDE.md non-negotiable 1).
logging.getLogger("urllib3").setLevel(logging.WARNING)

LEASE_SECONDS = 120
#: After a send, settling is retried on a short backoff (the post is never sent again), and abandoned this
#: many seconds after the claim: well inside the lease, so a late settle cannot race the database's own.
SETTLE_BACKOFF_SECONDS = (0.5, 1.0, 2.0)
SETTLE_GIVE_UP_AFTER_SECONDS = 90.0
IDLE_SECONDS = 60.0
DRAFT_EVERY_SECONDS = 3600.0
#: A refused bot token is nobody's post's fault: the whole worker stops asking for this long.
TOKEN_REFUSED_PAUSE_SECONDS = 300.0
MAX_RATE_PAUSE_SECONDS = 600.0
REPORT_EVERY_SECONDS = 30.0
#: The Bot API's timeout for a media post: Telegram fetches the file from our storage itself.
SEND_TIMEOUT_SECONDS = 30.0

_CHAT = re.compile(r"^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?[0-9]{5,20})$")


class StoreUnavailable(RuntimeError):
    """A database call that did not answer. The message holds a function name and an HTTP status, never a body
    or a key."""


class MarketingStore:
    """The 0108 worker functions, and the plan tables, over PostgREST with the service key."""

    def __init__(self, url: str, service_key: str, *, session: Any = None, timeout: float = 20.0):
        import requests  # noqa: PLC0415

        self.url = url.rstrip("/")
        self._key = service_key
        self._http = session or requests.Session()
        self._timeout = timeout

    def _headers(self) -> Dict[str, str]:
        return {"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}

    def _rpc(self, name: str, body: Dict[str, Any]) -> Any:
        try:
            r = self._http.post(f"{self.url}/rest/v1/rpc/{name}", json=body, timeout=self._timeout,
                                headers=self._headers())
        except Exception as e:  # noqa: BLE001
            raise StoreUnavailable(f"{name}: {log_redaction.describe_http_error(e)}") from None
        if r.status_code >= 300:
            raise StoreUnavailable(f"{name}: HTTP {r.status_code} (is migration {'0110' if name.endswith('_v2') else '0108'} applied?)")
        try:
            return r.json()
        except ValueError:
            return None

    def _select(self, table: str, query: str) -> List[Dict[str, Any]]:
        try:
            r = self._http.get(f"{self.url}/rest/v1/{table}?{query}", timeout=self._timeout, headers=self._headers())
        except Exception as e:  # noqa: BLE001
            raise StoreUnavailable(f"{table}: {log_redaction.describe_http_error(e)}") from None
        if r.status_code >= 300:
            raise StoreUnavailable(f"{table}: HTTP {r.status_code}")
        try:
            rows = r.json()
        except ValueError:
            raise StoreUnavailable(f"{table}: unreadable answer") from None
        if not isinstance(rows, list) or not all(isinstance(x, dict) for x in rows):
            raise StoreUnavailable(f"{table}: unexpected answer")
        return rows

    def draft(self, d: mc.Draft) -> Dict[str, Any]:
        # promo goes through the 0110 function (service_role only, same arguments); news and price keep calling
        # the 0108 function they always called.
        out = self._rpc("marketing_draft_upsert_v2" if d.kind == "promo" else "marketing_draft_upsert", {
            "p_idempotency_key": d.key, "p_kind": d.kind, "p_texts": d.texts, "p_source_ref": d.source_ref,
            "p_facts": d.facts, "p_facts_as_of": d.facts_as_of, "p_media_path": None, "p_target": "telegram",
            "p_link": d.link})
        return out if isinstance(out, dict) else {"ok": False, "error": "unreadable"}

    def claim(self, worker_id: str) -> List[Dict[str, Any]]:
        rows = self._rpc("claim_marketing_post", {"p_worker": worker_id, "p_lease_seconds": LEASE_SECONDS,
                                                  "p_target": "telegram"})
        return rows if isinstance(rows, list) else []

    def complete(self, post_id: str, worker_id: str, c: cp.Completion) -> bool:
        return bool(self._rpc("complete_marketing_post", {
            "p_id": post_id, "p_worker": worker_id, "p_outcome": c.outcome, "p_error_code": c.error_code,
            "p_retry_after_s": c.retry_after, "p_provider_message_id": c.message_id}))

    def price_plans(self) -> Optional[List[Dict[str, Any]]]:
        """Paid, public plans with their credits and concurrency, from ``plans`` / ``plan_entitlements`` /
        ``entitlement_keys``; None when anything cannot be read or is not an enforced fact. Never a default."""
        try:
            plans = self._select("plans", "select=id,name,sort_order,monthly_credits,is_default,is_public&order=sort_order.asc")
            key = self._select("entitlement_keys", "select=key,value_type,default_value,status&key=eq.concurrency")
            ents = self._select("plan_entitlements", "select=plan_id,key,value&key=eq.concurrency")
        except StoreUnavailable as e:
            logger.warning("price post skipped: %s", e)
            return None
        if len(key) != 1 or key[0].get("status") != "enforced" or key[0].get("value_type") != "int":
            logger.warning("price post skipped: concurrency is not an enforced entitlement")
            return None
        by_plan = {e.get("plan_id"): e.get("value") for e in ents}
        out: List[Dict[str, Any]] = []
        for p in plans:
            if p.get("is_default") is not False or p.get("is_public") is not True:
                continue
            credits = p.get("monthly_credits")
            if not isinstance(credits, (int, float)) or isinstance(credits, bool):
                logger.warning("price post skipped: a plan's monthly credits are unreadable")
                return None                  # a partial list would misstate the plans: no post at all
            if credits <= 0:
                continue                     # no credits to name: not a price-post plan
            conc = by_plan.get(p.get("id"), key[0].get("default_value"))
            out.append({"id": p.get("id"), "name": p.get("name"), "monthly_credits": credits, "concurrency": conc})
        return out or None


# ── one pass of each job ────────────────────────────────────────────────────

class MarketingWorker:
    def __init__(self, store: Any, sender: Any, worker_id: str, *, news_dir: Path = mc.NEWS_DIR,
                 promo_dir: Optional[Path] = None, now: Callable[[], _dt.datetime] = lambda: _dt.datetime.now(_dt.timezone.utc),
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 origin: Optional[str] = None):
        self.store, self.sender, self.worker_id = store, sender, worker_id
        # The origin the sender completes links with: a draft is checked against it before it is stored.
        given = origin if origin is not None else getattr(sender, "origin", None)
        self._origin = given if isinstance(given, str) else None
        self._sleep, self._clock = sleep, clock
        self._news_dir = news_dir
        self._promo_dir = promo_dir if promo_dir is not None else mc.PROMO_DIR
        self._now = now

    def draft_pass(self) -> Dict[str, int]:
        """Draft the public news items, the public promo files and the month's price post. Idempotent: the database
        refuses a second draft of the same key and leaves a draft a person edited alone. Counts by outcome. Drafting
        is not capped (the 2 posts per 7 days cap is on sending), and nothing here approves or sends anything."""
        counts: Dict[str, int] = {}

        def bump(k: str, n: int = 1) -> None:
            counts[k] = counts.get(k, 0) + n

        try:
            news, skipped = mc.load_news(self._news_dir, self._now().date())
        except (OSError, RecursionError):
            news, skipped = [], {"news_dir_unreadable": 1}
        for reason, n in skipped.items():
            if reason != "not_public":
                bump("news_skipped_" + reason, n)
        if skipped.get("too_old"):
            logger.info("%d public news item(s) shipped more than %d days ago were not drafted "
                        "(edit their date to announce them)", skipped["too_old"], mc.NEWS_MAX_AGE_DAYS)
        drafts = list(news)
        try:
            promos, promo_skipped, promo_notes = mc.load_promo(self._promo_dir, self._now().date(), self._news_dir)
        except (OSError, RecursionError):
            promos, promo_skipped, promo_notes = [], {"promo_dir_unreadable": 1}, []
        for reason, n in promo_skipped.items():
            if reason != "not_public":
                bump("promo_skipped_" + reason, n)
        for slug, reason, detail in promo_notes:
            # The slug is a file name in this repository and the detail is a list of rule ids: codes, never the words.
            log = logger.info if reason == "expired" else logger.warning
            log("promo %s not drafted: %s%s", slug, reason, f" ({detail})" if detail else "")
        drafts.extend(promos)
        plans = self.store.price_plans()
        price = mc.price_draft(plans, self._now(), self._news_dir) if plans else None
        if price is not None:
            drafts.append(price)
        down: set = set()                 # sources whose database call failed this pass; the others still go on
        for d in drafts:
            if d.kind in down:
                continue
            # The sender's own rules, before the owner is shown anything: a draft it would refuse (too long, text that
            # looks like a key or an address, a bad link, no site origin) is not stored. Stored, it would be approved on
            # screen and then fail at send time, using up its key (a news item is drafted once) and a weekly slot's worth
            # of the owner's attention. Codes only are counted and logged, never the words.
            refusal = cp.preflight(d.texts, d.link, self._origin, False)
            if refusal is not None:
                bump("not_drafted_" + refusal)
                if d.kind == "promo":
                    logger.warning("promo %s not drafted: the sender would refuse it (%s)", d.source_ref[len("promo:"):], refusal)
                continue
            try:
                res = self.store.draft(d)
            except StoreUnavailable as e:
                # One source failing (news, promo or price) must not keep the next one from being tried.
                logger.warning("drafting %s stopped: %s", d.kind, e)
                bump("store_unavailable")
                down.add(d.kind)
                continue
            if res.get("ok") is not True:
                bump("refused_" + str(res.get("error") or "unknown")[:40].replace(" ", "_"))
            elif res.get("created"):
                bump("created")
            elif res.get("updated"):
                bump("updated")
            elif d.kind == "promo":
                # Nothing changed: a promo key is permanent, so a rejected or expired promo is never redrafted. Say so.
                status = res.get("status")
                status = status if isinstance(status, str) and re.fullmatch(r"[a-z_]{1,20}", status) else "unknown"
                logger.info("promo %s already exists (status %s)", d.source_ref[len("promo:"):], status)
                bump("promo_exists_" + status)
            else:
                bump("unchanged")
        refused = {k: v for k, v in counts.items() if k.startswith("not_drafted_")}
        if refused:
            logger.warning("%d draft(s) the sender would refuse were not stored (%s)", sum(refused.values()),
                           ", ".join(f"{k[len('not_drafted_'):]}={v}" for k, v in sorted(refused.items())))
        return counts

    def _settle(self, post_id: str, completion: cp.Completion, claimed_at: float) -> bool:
        """Tell the database what happened, retrying a database that did not answer. Only the SETTLE is
        repeated, never the send. False means the database said the lease was lost; True otherwise, including
        when every try failed (the lease then runs out and the post ends as dead/unconfirmed, not resent)."""
        for attempt in range(len(SETTLE_BACKOFF_SECONDS) + 1):
            try:
                return self.store.complete(post_id, self.worker_id, completion)
            except StoreUnavailable as e:
                last = attempt == len(SETTLE_BACKOFF_SECONDS)
                if last or self._clock() - claimed_at > SETTLE_GIVE_UP_AFTER_SECONDS:
                    logger.warning("could not settle post %s (%s) after %d tries; it will not be sent again",
                                   post_id[:8], e, attempt + 1)
                    return True
                logger.warning("could not settle post %s (%s); trying again", post_id[:8], e)
                self._sleep(SETTLE_BACKOFF_SECONDS[attempt])
        return True

    def send_pass(self) -> Tuple[Optional[cp.Completion], float]:
        """Claim at most ONE approved post, send it, settle it. Returns (what was reported or None when nothing
        was due, seconds the whole worker should wait)."""
        rows = self.store.claim(self.worker_id)
        if not rows:
            return None, 0.0
        claimed_at = self._clock()
        post = rows[0]                                  # one post per loop, whatever the database returned
        post_id = str(post.get("post_id") or "")
        completion = self.sender.send(post)
        if completion.refused:
            logger.warning("post %s was not sent: %s", post_id[:8], completion.refused)
        settled = self._settle(post_id, completion, claimed_at)
        if not settled:
            logger.warning("post %s: the lease was lost before it was settled; the database ends it as "
                           "unconfirmed and it is not sent again", post_id[:8])
        logger.info("post %s settled: %s%s", post_id[:8], completion.outcome,
                    f" ({completion.error_code})" if completion.error_code else "")
        pause = 0.0
        if completion.error_code == "not_configured":
            pause = TOKEN_REFUSED_PAUSE_SECONDS
            logger.error("ALARM: Telegram refused the channel bot token (revoked or mistyped). Nothing is sent and "
                         "no post is failed; fix TELEGRAM_CHANNEL_BOT_TOKEN. Pausing %ss.", int(pause))
        elif completion.error_code == "rate_limited":
            pause = float(min(completion.retry_after or 30, MAX_RATE_PAUSE_SECONDS))
        return completion, pause


# ── settings and the loop ───────────────────────────────────────────────────

def posts_switch_on(env: Mapping[str, str]) -> bool:
    """Exactly ``on``. Empty, ``off``, ``true``, ``1`` or a typo is off: the default of every switch here."""
    return (env.get("NIGHTSHIFT_MARKETING_POSTS") or "").strip() == "on"


def missing_settings(env: Mapping[str, str]) -> List[str]:
    """Names (never values) of what a switched-on worker still needs."""
    need = []
    if not (env.get("TELEGRAM_CHANNEL_BOT_TOKEN") or "").strip():
        need.append("TELEGRAM_CHANNEL_BOT_TOKEN")
    if not _CHAT.match((env.get("MARKETING_TELEGRAM_CHAT") or "").strip()):
        need.append("MARKETING_TELEGRAM_CHAT (@channelname or a numeric id)")
    if nt.valid_app_origin(env.get("NOTIFY_APP_ORIGIN")) is None:
        need.append("NOTIFY_APP_ORIGIN (https://<our site>)")
    return need


def build_sender(env: Mapping[str, str], session: Any) -> cp.ChannelSender:
    origin = nt.valid_app_origin(env.get("NOTIFY_APP_ORIGIN"))
    client = nt.TelegramClient((env.get("TELEGRAM_CHANNEL_BOT_TOKEN") or "").strip(), nt.api_base_from_env(env), session,
                               timeout=SEND_TIMEOUT_SECONDS)
    return cp.ChannelSender(client, (env.get("MARKETING_TELEGRAM_CHAT") or "").strip(), origin,
                            nt.valid_app_origin(env.get("SUPABASE_URL")))


class _Status:
    """worker_status ('other'), at most every 30 s, with the detail that says WHY. Never raises."""

    def __init__(self, reporter: Optional[Any], clock: Callable[[], float] = time.monotonic):
        self._reporter, self._clock = reporter, clock
        self._last: Tuple[Optional[Tuple[str, str]], float] = (None, -1e9)

    def report(self, state: str, detail: str) -> None:
        if self._reporter is None:
            return
        key, at = self._last
        now = self._clock()
        if key == (state, detail) and now - at < REPORT_EVERY_SECONDS:
            return
        self._last = ((state, detail), now)
        try:
            self._reporter.report(state, detail)
        except Exception:  # noqa: BLE001 - reporting never stops the worker
            pass

    def close(self) -> None:
        if self._reporter is not None:
            try:
                self._reporter.report("stopped", None)
            except Exception:  # noqa: BLE001
                pass


def main(argv: Optional[List[str]] = None, *, env: Optional[Mapping[str, str]] = None,
         store_factory: Optional[Callable[[], Any]] = None, session_factory: Optional[Callable[[], Any]] = None,
         reporter_factory: Optional[Callable[[str], Any]] = None, stop: Optional[threading.Event] = None,
         install_signals: bool = True) -> int:
    parser = argparse.ArgumentParser(description="Draft and send the brand channel's posts (migration 0108)")
    parser.add_argument("--once", action="store_true", help="One drafting pass and one claim, then exit")
    parser.add_argument("--worker-id", default=None)
    args = parser.parse_args(argv)
    env = os.environ if env is None else env

    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s marketing_worker %(levelname)s %(message)s")
    log_redaction.install()

    url = (env.get("SUPABASE_URL") or "").strip()
    key = (env.get("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the marketing worker's env file (.env.marketing).")
        return 2
    worker_id = (args.worker_id or env.get("NIGHTSHIFT_WORKER_ID") or f"marketing-{socket.gethostname()}")[:64]
    if not worker_id.startswith("marketing"):
        worker_id = ("marketing-" + worker_id)[:64]
    stop = stop or threading.Event()
    if install_signals:
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())

    reporter = reporter_factory(worker_id) if reporter_factory else None
    if reporter is None and reporter_factory is None:
        from modules.worker_status import WorkerStatusReporter  # noqa: PLC0415

        reporter = WorkerStatusReporter(url, key, worker_id=worker_id, kind="other", scrub=log_redaction.redact)
    status = _Status(reporter)

    # Off by default, and quiet: no drafting, no claiming, no request to Telegram. The container idles (it does
    # not exit: compose restarts a process that exits) and tells worker_status why, so /health shows "off".
    if not posts_switch_on(env):
        logger.info("marketing posts are OFF (NIGHTSHIFT_MARKETING_POSTS is not 'on'). Nothing is drafted or sent.")
        while not stop.is_set():
            status.report("running", "off: NIGHTSHIFT_MARKETING_POSTS is not on; nothing is drafted or sent")
            if args.once:
                return 0
            stop.wait(IDLE_SECONDS)
        status.close()
        return 0

    need = missing_settings(env)
    if need:
        logger.warning("marketing posts are ON but cannot run: set %s in the marketing worker's env file. "
                       "Nothing is drafted, claimed or sent.", ", ".join(need))
        while not stop.is_set():
            status.report("failed", "set in .env.marketing: " + ", ".join(n.split(" ")[0] for n in need))
            if args.once:
                return 0
            stop.wait(IDLE_SECONDS)
        status.close()
        return 0

    import requests  # noqa: PLC0415

    store = store_factory() if store_factory else MarketingStore(url, key)
    sender = build_sender(env, session_factory() if session_factory else requests.Session())
    worker = MarketingWorker(store, sender, worker_id)
    chat = (env.get("MARKETING_TELEGRAM_CHAT") or "").strip()
    # Host only: a mistyped NOTIFY_APP_ORIGIN shows here before a post carries it. Never the token, the chat
    # id, or the Supabase URL (a repository secret).
    logger.info("marketing posts are ON: links use the origin host %s; the chat is %s",
                urlsplit(nt.valid_app_origin(env.get("NOTIFY_APP_ORIGIN")) or "").netloc,
                "a channel name" if chat.startswith("@") else "a numeric id")
    next_draft = -1e9
    while not stop.is_set():
        pause = 0.0
        detail = "on: drafting and sending approved posts"
        state = "running"
        if time.monotonic() >= next_draft:
            try:
                counts = worker.draft_pass()
            except StoreUnavailable as e:
                logger.warning("drafting skipped (%s)", e)
                counts = {}
            next_draft = time.monotonic() + DRAFT_EVERY_SECONDS
            if counts:
                logger.info("drafting: %s", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
            if counts.get("created"):
                logger.info("%d new draft(s) waiting for approval", counts["created"])
        try:
            completion, pause = worker.send_pass()
            if completion is not None and completion.error_code == "not_configured":
                state, detail = "failed", "Telegram refused the channel bot token: fix TELEGRAM_CHANNEL_BOT_TOKEN"
        except StoreUnavailable as e:
            logger.warning("queue unavailable (%s)", e)
        status.report(state, detail)
        if args.once:
            return 0
        stop.wait(pause if pause > 0 else IDLE_SECONDS)
    status.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
