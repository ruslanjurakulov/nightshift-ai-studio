#!/usr/bin/env python3
"""The Film Studio sweep, recorded (migration 0212), and the watchdog that reads whether it is running.

    python tools/film_sweep.py            # one pass, recorded as runner `server` (by hand, on the server)
    python tools/film_sweep.py --loop     # the film-sweep service: a pass every 300 s until SIGTERM, runner `server`
    python tools/film_sweep.py --check    # the hourly watchdog: READS film_sweep_status(), never sweeps

A pass calls ``film_sweep(runner)``, which runs 0171's ``film_expire_segments`` and records the run. It spends nothing: the sweep
only applies 0171's settle rules to segments already paid for by an open hold (past their deadline and grace, unclaimed for 3
hours, or whose hold 0020 let go: what was made is captured, the rest released). It calls no provider, claims no segment, starts
no take and publishes nothing.

Who sweeps (switch-on gate G2, docs/FILM_STUDIO.md): pg_cron every 5 minutes where it is installed (the primary), this file's
``--loop`` in the film-sweep service on our own server (the fallback, while ``NIGHTSHIFT_FILM_SWEEP=on``, independent of the film
worker), and the film worker's own thread. GitHub Actions does not sweep: ``.github/workflows/film_sweep_watchdog.yml`` runs
``--check`` once an hour and turns red only when the database says the sweep is overdue.

Needs ``SUPABASE_URL`` and ``SUPABASE_SERVICE_KEY`` from the environment (the server's env file, or Actions secrets for the
watchdog), never a flag; the key is never printed. Exit codes:

* one pass: 0 swept; 1 the sweep could not run, failed in the database, or 0212 is missing; 0 with a ``::warning::`` when the two
  values are unset;
* ``--loop``: runs until SIGTERM and exits 0; a failed pass is a log line and the next pass tries again. Off (the switch is not
  exactly ``on``, or the two values are unset) it says so once and waits for the stop, so the container does not restart in a loop;
* ``--check``: 1 when ``overdue`` is true (``::error::`` with the stuck counts) or the status cannot be read; 0 otherwise, with a
  ``::notice::`` (and a neutral ``::notice`` when 0212 is not applied, a ``::warning::`` when the secrets are unset).
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading
from pathlib import Path
from typing import Callable, List, Mapping, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules import film_orchestrator as fo  # noqa: E402

logger = logging.getLogger("film_sweep")

RUNNER = "server"
SWITCH = "NIGHTSHIFT_FILM_SWEEP"
EVERY_SECONDS = 300


def credentials(env: Mapping[str, str]):
    url = str(env.get("SUPABASE_URL", "") or "").strip()
    key = str(env.get("SUPABASE_SERVICE_KEY", "") or "").strip()
    return (url, key) if url and key else None


def one_pass(db) -> int:
    try:
        n = db.sweep(RUNNER)
    except fo.FilmFunctionMissing as e:
        # No quiet substitute here: this runner exists to leave a record, and an unrecorded sweep would make the measurement lie.
        logger.error("%s: apply it (docs/MIGRATIONS.md, 0212); nothing was swept", e)
        return 1
    except fo.FilmUnavailable as e:  # a function name and a status or SQLSTATE, never a key or a body
        logger.error("%s", e)
        return 1
    except fo.FilmRefused as e:
        logger.error("film_sweep refused: %s", e.word)
        return 1
    except Exception as e:  # noqa: BLE001 — the loop must outlive any one pass; the type name only, never its text
        logger.error("the film sweep failed (%s)", type(e).__name__)
        return 1
    logger.info("film sweep (%s): %s segment(s) settled or drained", RUNNER, n)
    return 0


def loop(db, stop: threading.Event, every: float = EVERY_SECONDS) -> int:
    while not stop.is_set():
        one_pass(db)
        stop.wait(every)
    logger.info("film sweep stopped")
    return 0


def check(db) -> int:
    """The watchdog: what film_sweep_status() says, as one Actions annotation. Counts and times only."""
    try:
        st = db.sweep_status()
    except fo.FilmFunctionMissing:
        # Neutral, never red: 0212 not applied yet is the state before the owner applies it, not a sweep that stopped.
        print("::notice title=0212 not applied::film_sweep_status is missing; nothing to watch until migration 0212 is applied")
        return 0
    except (fo.FilmUnavailable, fo.FilmRefused) as e:
        word = e.word if isinstance(e, fo.FilmRefused) else str(e)
        print(f"::error title=Film sweep status unreadable::{word}")
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"::error title=Film sweep status unreadable::{type(e).__name__}")
        return 1
    if not isinstance(st, dict):
        print("::error title=Film sweep status unreadable::no answer")
        return 1

    def num(k):
        v = st.get(k)
        return v if isinstance(v, int) and not isinstance(v, bool) else "unknown"

    def when(k):
        v = st.get(k)
        return v if isinstance(v, str) and len(v) <= 40 else "never"

    facts = (f"stuck_segments={num('stuck_segments')} oldest_stuck_minutes={num('oldest_stuck_minutes')} "
             f"open_segments={num('open_segments')} last_at={when('last_at')} line={num('overdue_after_minutes')}min")
    overdue = st.get("overdue")
    if overdue is True:
        print(f"::error title=Film sweep overdue::{facts}")
        return 1
    state = "not overdue" if overdue is False else "unknown (no sweep recorded yet)"
    print(f"::notice title=Film sweep {state}::{facts}")
    return 0


def main(env: Optional[Mapping[str, str]] = None, *, argv: Optional[List[str]] = None,
         make_db: Callable[[str, str], object] = lambda url, key: fo.FilmRest(url, key),
         stop: Optional[threading.Event] = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description="The Film Studio sweep (migration 0212)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--loop", action="store_true", help=f"a pass every {EVERY_SECONDS} s until SIGTERM (the film-sweep service)")
    mode.add_argument("--check", action="store_true", help="read film_sweep_status() only, never sweep (the watchdog)")
    args = parser.parse_args([] if argv is None else argv)
    stop = stop or threading.Event()
    creds = credentials(env)

    if args.loop:
        if not fo.switch_on(env, SWITCH):
            logger.info("%s is not 'on': this service sweeps nothing", SWITCH)
            stop.wait()
            return 0
        if creds is None:
            logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the server's env file; nothing is swept")
            stop.wait()
            return 0
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda signum, _frame: stop.set())
        logger.info("film sweep service started (runner %s, a pass every %s s)", RUNNER, EVERY_SECONDS)
        return loop(make_db(*creds), stop)

    if creds is None:
        logger.info("SUPABASE_URL and SUPABASE_SERVICE_KEY are not both set: nothing was %s", "checked" if args.check else "swept")
        # Exit 0 (an unset secret is a choice, not a crash) but say so where the Actions page shows it. Names only, never values.
        print("::warning title=Film sweep is off::SUPABASE_URL and SUPABASE_SERVICE_KEY are not set; "
              + ("the sweep's status was not checked" if args.check else "no film sweep ran"))
        return 0
    db = make_db(*creds)
    return check(db) if args.check else one_pass(db)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s film_sweep %(levelname)s %(message)s")
    raise SystemExit(main(argv=sys.argv[1:]))
