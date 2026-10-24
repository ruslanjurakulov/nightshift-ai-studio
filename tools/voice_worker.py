#!/usr/bin/env python3
"""Voice worker: carry out ``voice_clone_jobs`` (migration 0117, docs/CUSTOM_VOICE.md) — clone, delete at the provider, purge the sample.

    python tools/voice_worker.py --once     # claim at most one job, then exit
    python tools/voice_worker.py            # loop until SIGTERM / SIGINT

NOTHING RUNS THIS. There is no service, cron entry or workflow for it, on purpose: it is started by hand, by the owner, after the
steps in docs/CUSTOM_VOICE.md. It also does nothing unless the repository variable ``NIGHTSHIFT_VOICE_CLONING`` is ``on`` (the owner
sets it; empty is off). With the switch off it exits 0 without reading the environment's keys or contacting anything.

What a job does is ``modules/voice_worker.py``. This file only wires it to the environment: ``SUPABASE_URL`` and
``SUPABASE_SERVICE_KEY`` (the queue functions and the private bucket) and ``ELEVENLABS_API_KEY`` (the provider). Without the
ElevenLabs key it claims nothing: a job it cannot run must not be claimed and failed. On the free plan every clone job ends in the
closed state ``provider_not_enabled`` and nothing is spent.
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
from typing import List, Optional

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import voice_profiles as vp  # noqa: E402
from modules import voice_worker as vw  # noqa: E402

logger = logging.getLogger("voice_worker")

POLL_SECONDS = 15.0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Carry out voice_clone_jobs (migration 0117)")
    parser.add_argument("--once", action="store_true", help="Claim at most one job, run it, and exit")
    parser.add_argument("--worker-id", default=os.environ.get("NIGHTSHIFT_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s voice_worker %(levelname)s %(message)s")

    if not vw.enabled(os.environ):
        logger.info("%s is not on: nothing was claimed and nothing was contacted.", vw.SWITCH_ENV)
        return 0

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file: the voice queue lives in Supabase.")
        return 2
    import requests  # noqa: PLC0415

    try:
        provider = vp.ElevenLabsVoiceProvider(requests.Session(), os.environ.get("ELEVENLABS_API_KEY", ""))
    except vp.ProviderError as e:
        logger.error("%s Claiming nothing.", e)
        return 2

    worker = vw.VoiceWorker(vw.VoiceStore(url, key), vw.SampleStorage(url, key), provider,
                            worker_id=args.worker_id, transcribe=vw.whisper_transcriber())
    stop = threading.Event()

    def on_signal(signum, _frame):
        logger.info("signal %s: no new jobs", signum)
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    logger.info("voice worker %s started", args.worker_id)
    while not stop.is_set():
        outcome = worker.run_once()
        if args.once:
            return 0
        # Work found: look again at once. Nothing found, or a job put back for a retry: wait.
        wait = POLL_SECONDS if outcome is None else worker.retry_wait(outcome)
        if wait:
            stop.wait(wait)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
