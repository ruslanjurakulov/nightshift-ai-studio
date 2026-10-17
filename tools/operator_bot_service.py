#!/usr/bin/env python3
"""The operator bot as a service: one process that never stops.

GitHub's schedule is best effort: the `*/5` Telegram poll and the `*/10` alert
pass of .github/workflows/telegram_control.yml / operator_alerts.yml were
observed to run every few HOURS, so commands were answered hours late. On the
server (compose service ``operator-bot``, profile ``operator``, switched by the
GitHub repository variable NIGHTSHIFT_OPERATOR_BOT) this process does the same
two jobs without a scheduler:

  * the MAIN thread long-polls Telegram continuously (``getUpdates``, 25 s per
    call) through the same code the workflow runs (tools/run_telegram_control.py
    ``poll_once`` -> modules/operator_bot router), so a reply goes out within a
    second or two of the message;
  * a second thread runs the alert/digest pass (tools/run_operator_alerts.py
    ``build_engine`` -> AlertEngine.tick) every the interval
    (300 s, 600 s without a GitHub token), with the same dedupe keys,
    mute, quiet hours, rate limit and language handling, because they live in
    the engine and its store, not in the scheduler. A long pass therefore never
    delays a reply.

State: nothing local. Alert memory, mutes, the digest date and the language are
`alert_events` rows ``operator.*`` (modules/operator_bot/store.py); every update
is claimed by its update_id in `telegram_updates` (0042) before it is handled.
The Actions workflows also kept the getUpdates offset in a cache; here it is
held in memory. After a restart Telegram hands over the updates it never saw
confirmed (the last batch at most) and the claims skip the ones already
handled, so a restart replays nothing. /status and /pending read Supabase
(videos), like every other view; only /channels uses the legacy deps.

Liveness: the service reports itself to `worker_status` (migration 0045) as
``operator-bot`` (kind ``other``), through the same WorkerStatusReporter the
e-mail worker uses, so Integrations shows it and a dead bot reads "not
reporting" there. It is reported 'running' only while the poll loop is getting
answers from Telegram; if the loop stalls the row simply goes stale, and the
bot's own alert pass (or a fallback workflow, while the switch is off) raises the
worker alert.

Telegram allows ONE getUpdates consumer. While this service runs, the two
workflows skip their work (`if: vars.NIGHTSHIFT_OPERATOR_BOT != 'on'`). If a
second consumer or a webhook still exists, Telegram answers 409 (a rejected
token: 401); retrying cannot fix either, so the process EXITS NON-ZERO and
docker restarts it with a growing delay, which is what shows as a restarting
container. Any other failure (network, a 5xx) is retried with a short growing
pause and never ends the process.

It listens on no port and is not routed by Caddy: it only calls out.

Environment (deploy/.env.operator.example): TELEGRAM_BOT_TOKEN,
TELEGRAM_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY (required); optional
TELEGRAM_ADMIN_USER_IDS, GITHUB_TOKEN (read-only, for /deploys and CI alerts),
GITHUB_REPOSITORY, ELEVENLABS_LOW_CREDITS and the OPERATOR_* settings of
docs/operator-bot.md. Logs carry counts and codes, never a token or a message.

Exit codes: 0 stopped by SIGTERM/SIGINT; 1 Telegram refused polling (409/401);
2 not configured.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules import log_redaction  # noqa: E402
from modules.operator_bot.i18n import tp  # noqa: E402
from modules.operator_bot.sources import BOT_WORKER_ID  # noqa: E402
from modules.telegram_control import TelegramControl  # noqa: E402
from modules.worker_status import WorkerStatusReporter  # noqa: E402
from tools import run_operator_alerts as alerts_tool  # noqa: E402
from tools import run_telegram_control as poll_tool  # noqa: E402

logger = logging.getLogger("operator_bot_service")

#: Seconds between alert/digest passes, with and without a GitHub token (the
#: unauthenticated GitHub API allows 60 requests an hour per address, and a
#: pass asks for three workflow lists).
DEFAULT_INTERVAL_S = 300
DEFAULT_INTERVAL_NO_TOKEN_S = 600
#: The first pass waits this long after a start, so a deploy's restart does not
#: race the polling thread for the same Supabase rows.
FIRST_PASS_DELAY_S = 20
#: The longest pause after consecutive poll failures.
MAX_BACKOFF_S = 30
#: The longest we honour a Telegram 429 ``retry_after`` (it is per bot).
MAX_RETRY_AFTER_S = 120
HEARTBEAT_S = 3600
#: worker_status is refreshed this often (the site calls a worker silent after
#: 120 s), but only while Telegram has answered a poll within STATUS_FRESH_S.
STATUS_BEAT_S = 30
STATUS_FRESH_S = 90

EXIT_OK, EXIT_REFUSED, EXIT_NOT_CONFIGURED = 0, 1, 2


class ServiceDeps(poll_tool.StoreDeps):
    """The legacy read-only queries, minus the ones that need the pipeline's
    local history file (chronos.db), which only exists next to the pipeline.

    The router no longer asks these two (``/status`` and ``/pending`` read
    Supabase through the operator sources); they only guard a caller that
    still does. ``/channels`` reads the channel registry, which uses Supabase."""

    def status_summary(self, lang: str = "en") -> str:
        return tp(lang, "status.unavailable")

    def pending_review(self) -> list[dict]:
        raise LookupError("no local history on the server")


def alert_interval(environ=None) -> int:
    """Seconds between alert passes: 300 with a GitHub token, 600 without (fixed,
    not a setting; the deploy passes no knob for it)."""
    env = os.environ if environ is None else environ
    return DEFAULT_INTERVAL_S if (env.get("GITHUB_TOKEN") or "").strip() else DEFAULT_INTERVAL_NO_TOKEN_S


class Stats:
    """Counters for the hourly heartbeat line (numbers only)."""

    def __init__(self):
        self.polls = 0
        self.updates = 0
        self.poll_errors = 0
        self.passes = 0
        self.pass_errors = 0
        self.last_pass = "none"
        #: When Telegram last answered a poll (monotonic seconds).
        self.last_poll_ok = time.monotonic()


def alerts_loop(engine: Any, interval: float, stop: threading.Event, stats: Stats, *,
                first_delay: float = FIRST_PASS_DELAY_S, wait: Optional[Callable[[float], bool]] = None) -> None:
    """Run ``engine.tick()`` once per ``interval`` until ``stop`` is set. One
    pass per interval, however many polls happen in between. A pass that raises
    is logged by exception type and the loop carries on."""
    wait = wait or stop.wait
    if wait(first_delay):
        return
    while True:
        try:
            report = engine.tick()
            stats.passes += 1
            stats.last_pass = str(getattr(report, "state", "ok"))
            logger.info("operator alerts: %s", report)      # counts and flags only
        except Exception as e:  # noqa: BLE001 - one bad pass must not end the service
            stats.pass_errors += 1
            logger.warning("operator alert pass failed (%s)", type(e).__name__)
        if wait(interval):
            return


def status_loop(reporter: Any, stats: Stats, stop: threading.Event, *, interval: float = STATUS_BEAT_S,
                fresh: float = STATUS_FRESH_S, clock: Callable[[], float] = time.monotonic,
                wait: Optional[Callable[[float], bool]] = None) -> None:
    """Report 'running' to worker_status every ``interval`` seconds, but only
    while the poll loop has had an answer from Telegram within ``fresh``
    seconds: a bot that cannot hear the owner is not "running". Reporting never
    raises (WorkerStatusReporter swallows its own failures)."""
    wait = wait or stop.wait
    while True:
        if clock() - stats.last_poll_ok <= fresh:
            reporter.report("running")
        if wait(interval):
            return


def poll_loop(control: TelegramControl, bot: Any, store: Any, stop: threading.Event, stats: Stats, *,
              session: Any = None,
              wait: Optional[Callable[[float], bool]] = None, timeout: int = poll_tool.LONG_POLL_S) -> int:
    """Long-poll until ``stop`` is set. Returns the final offset; raises
    :class:`tools.run_telegram_control.PollFatal` on a 409/401 (not retryable).

    ``poll_once`` swallows an ordinary failure and returns the offset it was
    given; it reports through ``outcome`` that the call failed. EVERY failed poll
    backs off, however long it took (a slow 502 included): 2, 4, ... 30 seconds,
    reset by the next good answer, and never shorter than the ``retry_after``
    Telegram sent with a 429 (capped at MAX_RETRY_AFTER_S).
    """
    wait = wait or stop.wait
    offset = 0
    failures = 0
    while not stop.is_set():
        outcome: dict = {}
        new_offset = poll_tool.poll_once(control, None, session=session, offset=offset, timeout=timeout,
                                         store=store, bot=bot, raise_fatal=True, outcome=outcome)
        stats.polls += 1
        if outcome.get("failed"):
            failures += 1
            stats.poll_errors += 1
            pause = min(MAX_BACKOFF_S, 2 ** failures)
            pause = max(pause, min(MAX_RETRY_AFTER_S, int(outcome.get("retry_after") or 0)))
            wait(pause)
            continue
        failures = 0
        stats.last_poll_ok = time.monotonic()
        if new_offset != offset:
            stats.updates += 1
            offset = new_offset
    return offset


def run_service(control: TelegramControl, bot: Any, store: Any, engine: Any, stop: threading.Event, *,
                interval: float, session: Any = None, first_delay: float = FIRST_PASS_DELAY_S,
                poll_timeout: int = poll_tool.LONG_POLL_S, reporter: Any = None) -> int:
    """Both loops until ``stop``; the exit code. ``reporter`` (a
    WorkerStatusReporter, or None) carries the bot's own status to worker_status."""
    stats = Stats()
    if reporter is not None:
        reporter.report("starting")
        threading.Thread(target=status_loop, name="operator-status", daemon=True,
                         args=(reporter, stats, stop)).start()
    final = ("failed", "the operator bot stopped unexpectedly")
    thread = threading.Thread(target=alerts_loop, name="operator-alerts", daemon=True,
                              args=(engine, interval, stop, stats), kwargs={"first_delay": first_delay})
    thread.start()
    beat = threading.Thread(target=_heartbeat, name="operator-heartbeat", daemon=True, args=(stop, stats))
    beat.start()
    try:
        poll_loop(control, bot, store, stop, stats, session=session, timeout=poll_timeout)
        final = ("stopped", None)
    except poll_tool.PollFatal as e:
        logger.error("operator bot stopped: %s", e)
        final = ("failed", str(e))          # a fixed sentence about Telegram, no value
        return EXIT_REFUSED
    finally:
        stop.set()
        thread.join(timeout=10)
        if reporter is not None:
            reporter.close(*final)
    logger.info("operator bot stopped (polls %d, updates %d, passes %d)", stats.polls, stats.updates, stats.passes)
    return EXIT_OK


def _heartbeat(stop: threading.Event, stats: Stats) -> None:
    while not stop.wait(HEARTBEAT_S):
        logger.info("operator bot alive: polls=%d batches=%d poll_errors=%d passes=%d pass_errors=%d last_pass=%s",
                    stats.polls, stats.updates, stats.poll_errors, stats.passes, stats.pass_errors, stats.last_pass)


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    log_redaction.install()
    control = TelegramControl()
    if not control.enabled:
        logger.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set — nothing to run")
        return EXIT_NOT_CONFIGURED
    bot, sync = poll_tool.build_bot(control, ServiceDeps())
    if not getattr(sync, "enabled", False):
        logger.error("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set — the bot has no state to read or remember")
        return EXIT_NOT_CONFIGURED
    engine = alerts_tool.build_engine(control, sync)

    import requests

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    interval = alert_interval()
    logger.info("operator bot service started: long-polling Telegram, alert pass every %d s", interval)
    reporter = WorkerStatusReporter(sync.url, sync.service_key, worker_id=BOT_WORKER_ID, kind="other",
                                    scrub=log_redaction.redact)      # sync.enabled was checked above
    return run_service(control, bot, sync, engine, stop, interval=interval, session=requests.Session(),
                       reporter=reporter)


if __name__ == "__main__":
    sys.exit(main())
