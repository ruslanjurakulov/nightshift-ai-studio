#!/usr/bin/env python3
"""Operator alerts and the daily digest — one pass, run on a schedule.

Looks at the system's own state (modules/operator_bot/alerts.py), sends what is
new and worth an interruption to the admin chat, and exits 0. De-duplicated,
rate-limited and quiet-hours aware: running it every ten minutes is the design.

  python tools/run_operator_alerts.py                 # one pass
  python tools/run_operator_alerts.py --digest-now    # also send the digest now

Outbound only: it never reads a Telegram update, never writes anything but its
own memory (rows of the alert feed, modules/operator_bot/store.py), and calls no
paid provider. Off unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and
SUPABASE_URL + SUPABASE_SERVICE_KEY are set. Its log carries counts only.

Configuration (env): see docs/operator-bot.md — TELEGRAM_BOT_TOKEN,
TELEGRAM_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY, GITHUB_TOKEN /
GITHUB_REPOSITORY (supplied by Actions), ELEVENLABS_LOW_CREDITS and the optional
OPERATOR_APP_URL, OPERATOR_TZ, OPERATOR_QUIET_HOURS, OPERATOR_DIGEST_HOUR,
OPERATOR_STUCK_MINUTES, OPERATOR_ALERT_MAX_PER_HOUR, OPERATOR_DEADMAN_HOURS (1-12, `off`: the dead-man switch
of modules/operator_bot/reliability.py).

The owner's e-mail copy (docs/OWNER_EMAIL.md) is off unless NIGHTSHIFT_OWNER_EMAIL
is exactly `on`; it also needs RESEND_API_KEY and NIGHTSHIFT_EMAIL_FROM, and takes
the optional OWNER_EMAIL_KINDS. It rides this pass: no pass, no e-mail.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("run_operator_alerts")

from modules import log_redaction
from modules.operator_bot.alerts import AlertEngine, send_digest_reply
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.owner_mail import OwnerMail
from modules.operator_bot.sources import OperatorSources, default_http_get
from modules.operator_bot.store import SupabaseAlertStore
from modules.supabase_sync import SupabaseSync
from modules.telegram_control import TelegramControl


def build_engine(control, sync) -> AlertEngine:
    """The alert engine with its real sources. Shared with the always-on service
    (tools/operator_bot_service.py), which runs ``tick()`` on its own timer."""
    cfg = OperatorConfig.from_env()
    ops = OperatorSources(sync, default_http_get, cfg, github_token=os.getenv("GITHUB_TOKEN", ""))
    store = SupabaseAlertStore(sync)
    # The e-mail copy for the owner (docs/OWNER_EMAIL.md): None unless NIGHTSHIFT_OWNER_EMAIL is exactly `on`.
    owner_mail = OwnerMail.from_env(ops, store, sync, cfg, os.environ)
    return AlertEngine(ops, store, control, cfg, owner_mail=owner_mail)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--digest-now", action="store_true", help="send the daily digest now (not recorded)")
    args = parser.parse_args(argv)
    log_redaction.install()

    control = TelegramControl()
    if not control.enabled:
        logger.info("Telegram not configured — operator alerts are off")
        return 0
    sync = SupabaseSync()
    if not sync.enabled:
        logger.info("Supabase not configured — operator alerts are off (no state to read or remember)")
        return 0
    engine = build_engine(control, sync)
    if args.digest_now:
        reply = send_digest_reply(engine.ops)
        control.send(control.chat_id, reply.text, parse_mode=reply.parse_mode, reply_markup=reply.markup())
    report = engine.tick()
    logger.info("operator alerts: %s", report)   # counts and flags only
    return 0


if __name__ == "__main__":
    sys.exit(main())
