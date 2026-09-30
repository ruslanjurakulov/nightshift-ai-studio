#!/usr/bin/env python3
"""Creative worker: run ``creative_jobs`` (migration 0036) — image, video,
speech and sound generations started from the Command Center.

    python tools/creative_worker.py              # loop forever (the compose command)
    python tools/creative_worker.py --once       # claim at most one job, then exit

A separate process (compose service ``creative-worker``) from the pipeline
worker, so a generation never waits behind a 30-minute render. Several jobs
run at once (``CREATIVE_WORKER_CONCURRENCY``, default 4): a provider job is
mostly waiting on the provider.

What each job does is ``modules/creative_worker.py``. This file wires it up:

* the queue and the settlement are the 0036 functions, called with the
  service key (``SUPABASE_URL`` / ``SUPABASE_SERVICE_KEY``, the worker's env
  file) — the Command Center never holds that key;
* credit holds are checked under ``NIGHTSHIFT_CREDITS_ENFORCE`` exactly as the
  pipeline worker checks them;
* the provider adapters come from ``NIGHTSHIFT_CREATIVE_ADAPTERS``
  (``module:function``, a resolver ``model_id -> adapter | None`` from the
  capability layer). Without it the worker claims NOTHING — a job it cannot
  run must not be claimed and failed — and only returns the holds of jobs
  nobody picked up in time (``expire_creative_jobs``);
* outputs are written under ``NIGHTSHIFT_CREATIVE_DIR/<job id>/`` (default
  ``output/creative``);
* stored error text is scrubbed of every secret in this process's
  environment (the pipeline worker's scrubber) and of token-shaped strings.

SIGTERM (``docker stop``) stops claiming; a job waiting on its provider is
handed back with its task id stored, so the next start polls it instead of
paying for it again.
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
from typing import Callable, List, Optional

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import credits as credit_rules  # noqa: E402
from modules import creative_worker as cw  # noqa: E402

logger = logging.getLogger("creative_worker")

DEFAULT_CONCURRENCY = 4
EXPIRE_EVERY_SECONDS = 60.0


def make_scrubber(env) -> Callable[[str], str]:
    # The pipeline worker's scrubber: every secret-named env value, and
    # token-shaped strings. Imported here so modules/ never imports tools/.
    from tools.queue_worker import scrub, secret_values  # noqa: PLC0415

    secrets = secret_values(env)
    return lambda text: scrub(text, secrets)


def idle_loop(queue, stop: threading.Event, every: float = EXPIRE_EVERY_SECONDS) -> None:
    """No adapters: claim nothing, but still give back the holds of jobs that
    expired in the queue, so a member's credits are never stuck."""
    while not stop.is_set():
        try:
            n = queue.expire()
            if n:
                logger.info("expired %s creative job(s) nobody picked up; their credits were released", n)
        except Exception as e:
            logger.warning("expire failed (%s)", type(e).__name__)
        stop.wait(every)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Claim and run creative_jobs (migration 0036)")
    parser.add_argument("--once", action="store_true", help="Claim at most one job, run it, and exit")
    parser.add_argument("--worker-id", default=os.environ.get("NIGHTSHIFT_WORKER_ID")
                        or f"{socket.gethostname()}-{os.getpid()}")
    parser.add_argument("--concurrency", type=int,
                        default=cw.parse_int(os.environ, "CREATIVE_WORKER_CONCURRENCY",
                                             DEFAULT_CONCURRENCY, 1, 16))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s creative_worker %(levelname)s %(message)s")

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file "
                     "— the creative queue lives in Supabase.")
        return 2

    out_dir = Path(os.environ.get("NIGHTSHIFT_CREATIVE_DIR", "").strip() or REPO_DIR / "output" / "creative")
    enforce = credit_rules.enforcement_enabled(os.environ)
    scrub = make_scrubber(os.environ)
    stop = threading.Event()

    def on_signal(signum, _frame):
        logger.info("signal %s: no new jobs; jobs waiting on a provider are handed back", signum)
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    spec = os.environ.get(cw.ADAPTERS_ENV, "").strip()
    resolver = None
    if spec:
        try:
            resolver = cw.load_resolver(spec)
        except Exception as e:
            logger.error("%s=%s could not be loaded (%s); claiming nothing", cw.ADAPTERS_ENV, spec,
                         type(e).__name__)
    else:
        logger.warning("%s is not set: no provider adapters, so no creative job is claimed "
                       "(queued jobs expire and their credits are released)", cw.ADAPTERS_ENV)
    if resolver is None:
        if args.once:
            return 1
        idle_loop(cw.CreativeRest(url, key), stop)
        return 0

    def run_thread(n: int) -> None:
        worker = cw.CreativeWorker(
            cw.CreativeRest(url, key), resolver,
            worker_id=f"{args.worker_id}-{n}", out_dir=out_dir,
            credits=credit_rules.CreditsRest(url, key), enforce=enforce, scrub=scrub, stop=stop)
        worker.run_forever(once=args.once)

    concurrency = 1 if args.once else args.concurrency
    logger.info("creative worker %s started (%s at once, credits %s, outputs in %s)",
                args.worker_id, concurrency, "enforced" if enforce else "not enforced", out_dir)
    threads = [threading.Thread(target=run_thread, args=(i,), name=f"creative-{i}")
               for i in range(concurrency)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
