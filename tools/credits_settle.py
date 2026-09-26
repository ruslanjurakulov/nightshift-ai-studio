#!/usr/bin/env python3
"""Claim and settle a paid run's credit hold on GitHub Actions.

    python tools/credits_settle.py start    # before the run spends anything
    python tools/credits_settle.py settle   # after it, success or not

The Actions twin of what ``tools/queue_worker.py`` does around a queued job
(``modules/credits.py`` holds the rules for both). Used by
``.github/workflows/daily_video.yml`` only when the Command Center dispatched
the run with a ``credit_ref`` — i.e. with ``NIGHTSHIFT_CREDITS_ENFORCE`` on,
for an organization that is not the operator's own. Scheduled runs and plain
manual dispatches carry no reference and never reach this file.

Everything comes from the environment, never from the command line, so a
dispatch input can never become part of a shell command:

    SUPABASE_URL, SUPABASE_SERVICE_KEY   the workflow's existing secrets
    CREDIT_REF                           the dispatch input (the hold's job id)
    CHANNEL_ID                           this matrix job's channel
    REQUESTED_CHANNEL                    the dispatch's `channel` input
    INPUT_DURATION                       the dispatch's `duration` input
    RUN_OUTCOME                          settle only: steps.<run>.outcome
    GITHUB_ENV                           start writes CREDITS_* for settle

``start`` exits non-zero — and the run step is then skipped, having spent
nothing — when the hold is not open, belongs to another organization, is
smaller than the run requires, or the credits API cannot be reached. ``settle``
never fails the job: a charge it could not record is logged as an error and
the hold expires (``expire_credit_reservations``); it is never guessed.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Optional

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import credits  # noqa: E402

logger = logging.getLogger("credits_settle")

_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$")


def _append_env(path: Optional[str], values: Mapping[str, str]) -> None:
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for k, v in values.items():
            fh.write(f"{k}={v}\n")


def start(env: Mapping[str, str], client) -> int:
    ref = env.get("CREDIT_REF", "").strip()
    channel = env.get("CHANNEL_ID", "").strip()
    if not _REF.match(ref):
        print("::error::credit_ref is not a valid reservation reference — nothing was run.")
        return 1
    # One hold pays for one run. A dispatch that fans out over every channel
    # would let one reservation start several of them.
    if env.get("REQUESTED_CHANNEL", "").strip() != channel:
        print("::error::a credit_ref run must name exactly one channel — nothing was run.")
        return 1
    duration = env.get("INPUT_DURATION", "").strip()
    try:
        hold = credits.open_hold(client, job_ref=ref, channel_id=channel,
                                 duration_s=float(duration) if duration else None, enforce=True)
    except credits.CreditRefused as e:
        print(f"::error::Credits: {e}. Nothing was run.")
        return 1
    except ValueError:
        print("::error::duration is not a number — nothing was run.")
        return 1
    if hold is None:
        # The channel's organization is exempt (the operator's own).
        print("Credits: this channel's organization is exempt — no hold to settle.")
        return 0
    _append_env(env.get("GITHUB_ENV"), {
        "CREDITS_HOLD": f"{hold.amount:.2f}",
        "CREDITS_ORG": hold.org_id,
        "CREDITS_SINCE": datetime.now(timezone.utc).isoformat(),
    })
    print(f"Credits: reservation claimed ({hold.amount:.2f} credits on hold).")
    return 0


def settle(env: Mapping[str, str], client, ledger=credits.local_run_entries) -> int:
    ref = env.get("CREDIT_REF", "").strip()
    amount = env.get("CREDITS_HOLD", "").strip()
    if not _REF.match(ref) or not amount:
        print("Credits: no hold was claimed for this run — nothing to settle.")
        return 0
    hold = credits.Hold(ref, env.get("CREDITS_ORG", ""), float(amount))
    outcome = env.get("RUN_OUTCOME", "").strip()
    note = credits.settle_hold(client, hold, succeeded=outcome == "success",
                               channel_id=env.get("CHANNEL_ID", "").strip(),
                               since=env.get("CREDITS_SINCE", "").strip() or None, ledger=ledger)
    if note is None:
        print("::error::Credits: the charge for this run could not be recorded; the hold stays "
              "open until it expires. Settle it by hand if this persists.")
    else:
        print(f"Credits: {note}.")
    return 0


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(levelname)s credits_settle %(message)s")
    args = list(sys.argv[1:] if argv is None else argv)
    if args not in (["start"], ["settle"]):
        print("usage: credits_settle.py start|settle", file=sys.stderr)
        return 2
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        print("::error::SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for a paid run.")
        return 1 if args == ["start"] else 0
    client = credits.CreditsRest(url, key)
    return start(os.environ, client) if args == ["start"] else settle(os.environ, client)


if __name__ == "__main__":
    raise SystemExit(main())
