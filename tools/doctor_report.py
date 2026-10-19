#!/usr/bin/env python3
"""The scheduled readiness check: run the doctor, tell the operator bot what failed.

    python tools/doctor_report.py            # what .github/workflows/doctor_scheduled.yml runs

``tools/doctor.py`` answers "can the pipeline run?" but only when somebody asks. This runs the same read-only
checks on a schedule and leaves ONE row in the alert feed (``alert_events``, kind ``operator.doctor``): title
``ok`` or ``fail``, body the names of the failing checks (``group/name``, the doctor's own fixed words, never a
detail line and so never a value). The operator bot (modules/operator_bot/reliability.py) reads that row and
turns each failing check into an alert through its usual dedupe, rate limit, quiet hours and mute, and says when a
check recovers or when the check itself stops reporting.

What it does and does not do
* Read-only against every provider: the doctor's own free GETs, and its one in-memory YouTube token refresh
  (nothing saved). It starts, retries and changes no run, publishes nothing, spends nothing.
* The one write is that row, with the service key the daily workflow already holds, and no channel (the bot
  trusts only rows without one).
* It prints the doctor's scrubbed report to the job log and summary, which already says only ``set`` / ``missing``
  for a secret. The row carries names, never a value.
* The ``host`` group (free disk, ffmpeg, the whisper cache) describes the machine the check runs on, which is not
  the machine a video renders on, so it is not judged here. Every other FAIL is.
* Exit 0 whenever a verdict was recorded, FAIL or not: the alert is the bot's job, and a red job would be a second
  alert for the same fact. Exit 1 when no verdict could be recorded (no Supabase, a failed write), because then
  nobody would hear about it.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Callable, Mapping, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools import doctor  # noqa: E402

#: Groups whose verdict is about the machine the check runs on, not about the pipeline's credentials.
IGNORED_GROUPS = ("host",)
KIND = "operator.doctor"
MAX_BODY = 280
_SAFE = re.compile(r"[^A-Za-z0-9 _./-]")


def failing_names(checks: Sequence[doctor.Check]) -> list:
    """``group/name`` of every FAIL outside the ignored groups, safe to store: the doctor's fixed words only."""
    out = []
    for c in checks:
        if c.status == doctor.FAIL and c.group not in IGNORED_GROUPS:
            name = _SAFE.sub("", f"{c.group}/{c.name}").strip()[:60]
            if name and name not in out:
                out.append(name)
    return out


def build_row(checks: Sequence[doctor.Check]) -> dict:
    names = failing_names(checks)
    body = ",".join(names)
    while len(body) > MAX_BODY and names:      # whole names only: a cut name would read as a different check
        names.pop()
        body = ",".join(names)
    return {"kind": KIND, "severity": "info", "title": "fail" if failing_names(checks) else "ok",
            "body": body, "delivered": False}


def summary(checks: Sequence[doctor.Check], env: Mapping[str, str]) -> str:
    return doctor.render(list(checks), env)


def main(argv: Optional[Sequence[str]] = None, *, env: Optional[Mapping[str, str]] = None,
         run: Optional[Callable] = None, sync=None, out=print) -> int:
    env = os.environ if env is None else env
    try:
        checks = (run or (lambda: doctor.run_checks(doctor.default_ctx(env=None if env is os.environ else env))))()
    except Exception as e:  # noqa: BLE001 - say that the check could not run, record nothing
        out(f"the readiness check could not run ({type(e).__name__})")
        return 1
    out(summary(checks, env))
    if sync is None:
        from modules.supabase_sync import SupabaseSync  # noqa: PLC0415

        sync = SupabaseSync()
    if not getattr(sync, "enabled", False):
        out("Supabase is not configured: no verdict can be recorded, so the operator bot cannot be told")
        return 1
    try:
        written = sync.upsert("alert_events", [build_row(checks)])
    except Exception as e:  # noqa: BLE001
        out(f"the verdict could not be recorded ({type(e).__name__})")
        return 1
    if not written:
        out("the verdict could not be recorded (Supabase refused the row)")
        return 1
    out(f"recorded: {build_row(checks)['title']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
