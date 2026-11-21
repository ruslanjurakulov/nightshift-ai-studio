"""Pending-approval notifier — tells a human when a run is waiting on them.

The pipeline (see `modules/pipeline_stages.py`) already refuses to reach
PUBLISH without an explicit `PipelineStateMachine.approve()` call, and
`tools/approve_run.py --list-pending` already shows what is waiting — but
nothing surfaces that fact unless a human remembers to go look. This module
is the small notification layer that closes that gap:

  - `build_pending_approval_summary()` renders a human-readable summary of
    every run sitting at HUMAN_APPROVAL without `human_approved`, including
    how long each has been waiting and (mirroring `tools/approve_run.py`'s
    `_print_run`) a fact-check flag count when `output/<slug>/fact_check.json`
    exists.
  - `Notifier` dispatches that summary to whichever channels are configured.

Channels
--------
`log`   — always on, zero configuration. `Notifier` should never end up
          doing nothing for a non-empty summary, so this channel exists as
          the always-available floor.
`slack` — attempted only when `SLACK_WEBHOOK_URL` is set in the environment;
          posts `{"text": summary}` to that webhook. A misconfigured URL or a
          Slack outage must never crash the caller — failures are logged and
          reported in the returned status dict, never raised.

Deliberate non-goal: email. Real email delivery needs an SMTP host, port,
credentials, and a from/to address the repo owner hasn't specified anywhere
in this codebase — assuming any of that would just be guessing. Adding a
channel (email or otherwise) later means adding one more
`if os.getenv(...): ...` branch in `Notifier.send()`, following the same
shape as the `slack` branch below.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone

import requests

from config import OUTPUT_DIR
from modules.log_redaction import describe_http_error
from modules.pipeline_stages import PipelineStage, PipelineStateMachine

logger = logging.getLogger(__name__)


def slugify(text: str) -> str:
    """Mirrors main.py's / tools/approve_run.py's slugify() so fact-check
    sidecar files can be found. Duplicated deliberately rather than imported
    from tools/approve_run.py — that's a script, not a package module.
    """
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50]


def _format_wait(since_iso: str) -> str:
    """Render how long a run has been sitting at HUMAN_APPROVAL, e.g. '3h 12m'."""
    try:
        since = datetime.fromisoformat(since_iso)
    except (ValueError, TypeError):
        return "unknown"
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - since
    total_minutes = max(0, int(delta.total_seconds() // 60))
    days, rem_minutes = divmod(total_minutes, 24 * 60)
    hours, minutes = divmod(rem_minutes, 60)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def _fact_check_flag_line(topic: str) -> str | None:
    """Mirrors tools/approve_run.py's _print_run fact-check block: locate
    output/<slug>/fact_check.json and, if it has flagged claims, return a
    one-line summary. Returns None when there's nothing to report (no file,
    unreadable file, or no flags).
    """
    fc_path = OUTPUT_DIR / slugify(topic) / "fact_check.json"
    if not fc_path.exists():
        return None
    try:
        results = json.loads(fc_path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Could not read fact-check results at %s: %s", fc_path, e)
        return None
    flagged = [r for r in results if r.get("requires_human_review")]
    if not flagged:
        return None
    return f"    fact-check: {len(flagged)}/{len(results)} claim(s) flagged for review"


def build_pending_approval_summary(pipeline: PipelineStateMachine | None = None) -> str:
    """Render a human-readable summary of runs waiting at HUMAN_APPROVAL.

    Returns "" when nothing is pending — callers must treat an empty string
    as "nothing to send", never send an empty notification.
    """
    if pipeline is None:
        pipeline = PipelineStateMachine()

    runs = pipeline.list_runs()
    pending = [
        r for r in runs
        if r.current_stage == PipelineStage.HUMAN_APPROVAL and not r.human_approved
    ]
    if not pending:
        return ""

    lines = [f"{len(pending)} run(s) pending human approval:"]
    for run in pending:
        waiting_since = next(
            (t.timestamp for t in run.history if t.stage == PipelineStage.HUMAN_APPROVAL),
            None,
        )
        waited = _format_wait(waiting_since) if waiting_since else "unknown"
        lines.append(f"  {run.run_id}  waiting {waited}  — {run.topic}")
        flag_line = _fact_check_flag_line(run.topic)
        if flag_line:
            lines.append(flag_line)

    return "\n".join(lines)


class Notifier:
    """Dispatches a summary to whichever channels are configured.

    `send()` always tries the `log` channel (zero configuration) and the
    `slack` channel only if SLACK_WEBHOOK_URL is set. See the module
    docstring for why there is no email channel here.
    """

    def send(self, summary: str) -> dict[str, bool]:
        if not summary or not summary.strip():
            return {}

        results: dict[str, bool] = {}
        results["log"] = self._send_log(summary)

        webhook_url = os.getenv("SLACK_WEBHOOK_URL")
        if webhook_url:
            results["slack"] = self._send_slack(webhook_url, summary)

        # Telegram, when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set. Same
        # opt-in, degrade-safe posture as slack — TelegramControl.notify never
        # raises, so a missing token or a blip can't affect the run.
        telegram = self._telegram()
        if telegram is not None and telegram.enabled:
            results["telegram"] = telegram.notify(summary)

        return results

    @staticmethod
    def _telegram():
        try:
            from modules.telegram_control import TelegramControl

            return TelegramControl()
        except Exception:  # import guard — never let it break notifications
            return None

    def _send_log(self, summary: str) -> bool:
        logger.info("Pending approval notification:\n%s", summary)
        return True

    def _send_slack(self, webhook_url: str, summary: str) -> bool:
        try:
            response = requests.post(webhook_url, json={"text": summary}, timeout=10)
            if 200 <= response.status_code < 300:
                return True
            logger.warning(
                "Slack notification failed: webhook returned status %d", response.status_code
            )
            return False
        except requests.RequestException as e:
            # Type and HTTP status only: the exception's text quotes the
            # webhook URL, and for Slack that URL is the secret.
            logger.warning("Slack notification failed: %s", describe_http_error(e))
            return False
