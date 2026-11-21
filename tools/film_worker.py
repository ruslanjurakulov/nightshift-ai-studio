#!/usr/bin/env python3
"""Film worker: drive Film Studio segments (migrations 0171 and 0198) — claim, the takes, the assembly, the settle.

    python tools/film_worker.py              # loop forever (the compose command)
    python tools/film_worker.py --once       # at most one segment and one sweep, then exit

What one segment does is ``modules/film_orchestrator.py``. This file wires it up:

* OFF unless ``NIGHTSHIFT_FILM_WORKER=on`` in this process's environment: anything else (empty, off, a typo) claims nothing and
  sweeps nothing, and the loop only waits for a stop. The database has its own two switches as well (0171's platform switch and 0198's
  per organization), both off by default; this flag only decides whether this process works at all;
* the service key comes from the env file (``SUPABASE_URL`` / ``SUPABASE_SERVICE_KEY``), never a flag, and is never printed;
* the provider adapters are the creative worker's (``NIGHTSHIFT_CREATIVE_ADAPTERS``, ``module:function``): the same resolver, so a take
  runs through exactly the adapter a Studio job of that model would;
* ``NIGHTSHIFT_MEDIA_DIR`` must be the media library volume, writable, with ffmpeg and ffprobe here: a take's file is registered
  into the library and a clip's last frame is extracted, and without them no take could be delivered, so the worker refuses to start
  (rule 6: say it before anything is spent) rather than claim segments it cannot finish;
* ``film_expire_segments`` runs on its own thread every ``FILM_EXPIRE_EVERY_SECONDS`` (default 300, never more than 900): a segment past
  its deadline and grace, or one nobody claimed, settles while its hold is open, even while this worker drives a long film;
* stored error text is scrubbed of every secret in this process's environment (the pipeline worker's scrubber).

SIGTERM (``docker stop``) stops between calls: a take waiting on its provider leaves its task id stored, and the next claim polls it.
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
from typing import Callable, List, Mapping, Optional

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import creative_worker as cw  # noqa: E402
from modules import film_orchestrator as fo  # noqa: E402

logger = logging.getLogger("film_worker")

FLAG = "NIGHTSHIFT_FILM_WORKER"
#: 0171's switch-on gate: the sweep runs at least every 15 minutes.
MAX_EXPIRE_EVERY_SECONDS = 900
DEFAULT_EXPIRE_EVERY_SECONDS = 300
IDLE_MIN_SECONDS = 5.0
IDLE_MAX_SECONDS = 60.0


def enabled(env: Mapping[str, str]) -> bool:
    """Exactly ``on`` (as every other worker switch here): anything else is off, never a quiet guess."""
    return str(env.get(FLAG, "") or "").strip() == "on"


def make_scrubber(env) -> Callable[[str], str]:
    from tools.queue_worker import scrub, secret_values  # noqa: PLC0415

    secrets = secret_values(env)
    return lambda text: scrub(text, secrets)


def expire_every(env: Mapping[str, str]) -> int:
    return cw.parse_int(env, "FILM_EXPIRE_EVERY_SECONDS", DEFAULT_EXPIRE_EVERY_SECONDS, 30, MAX_EXPIRE_EVERY_SECONDS)


def sweep_once(db) -> None:
    try:
        n = db.expire()
        if n:
            logger.info("the sweep settled or drained %s film segment(s)", n)
    except Exception as e:  # the next sweep tries again; the claim does not depend on it
        logger.warning("film_expire_segments failed (%s)", type(e).__name__)


def sweeper(db, stop: threading.Event, every: float) -> None:
    while not stop.wait(every):
        sweep_once(db)


def loop(orch, db, stop: threading.Event, *, once: bool) -> int:
    """Claim and drive until stopped, backing off while there is nothing to claim."""
    idle = IDLE_MIN_SECONDS
    while not stop.is_set():
        try:
            out = orch.run_once()
        except Exception as e:  # the worker must outlive any one claim
            logger.warning("claim failed (%s)", type(e).__name__)
            out = None
        if out is not None:
            logger.info("segment %s: %s (%s)", out.segment_id, out.result, out.reason or "-")
            idle = IDLE_MIN_SECONDS
        if once:
            return 0
        if out is None:
            stop.wait(idle)
            idle = min(idle * 2, IDLE_MAX_SECONDS)
    return 0


def main(argv: Optional[List[str]] = None, env: Optional[Mapping[str, str]] = None, *,
         make_db: Callable[[str, str], object] = lambda url, key: fo.FilmRest(url, key),
         make_orchestrator: Optional[Callable[..., object]] = None,
         stop: Optional[threading.Event] = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description="Drive Film Studio segments (migrations 0171, 0198)")
    parser.add_argument("--once", action="store_true", help="At most one segment and one sweep, then exit")
    parser.add_argument("--worker-id", default=env.get("NIGHTSHIFT_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s film_worker %(levelname)s %(message)s")
    stop = stop or threading.Event()

    if not enabled(env):
        logger.info("%s is not 'on': this worker claims nothing and sweeps nothing", FLAG)
        if not args.once:
            stop.wait()
        return 0

    url = str(env.get("SUPABASE_URL", "") or "").strip()
    key = str(env.get("SUPABASE_SERVICE_KEY", "") or "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file: the film segments live in Supabase")
        return 2
    spec = str(env.get(cw.ADAPTERS_ENV, "") or "").strip()
    if not spec:
        logger.error("%s is not set: no provider adapters, so no take could be made; nothing is claimed", cw.ADAPTERS_ENV)
        return 2
    try:
        resolver = cw.load_resolver(spec)
    except Exception as e:
        logger.error("%s=%s could not be loaded (%s); nothing is claimed", cw.ADAPTERS_ENV, spec, type(e).__name__)
        return 2
    raw = str(env.get("NIGHTSHIFT_MEDIA_DIR", "") or "").strip()
    media_root = Path(raw) if raw else None
    if media_root is None or not media_root.is_absolute() or not media_root.is_dir() or not os.access(media_root, os.W_OK):
        logger.error("NIGHTSHIFT_MEDIA_DIR must be the media library volume, writable here: a take's file is registered into the "
                     "library; nothing is claimed")
        return 2
    from modules import media_library as ml  # noqa: PLC0415

    tools = ml.find_tools()
    if tools is None:
        logger.error("ffmpeg and ffprobe are needed (a clip's last frame, the narration's clock and loudness); nothing is claimed")
        return 2

    db = make_db(url, key)
    out_dir = Path(str(env.get("NIGHTSHIFT_FILM_DIR", "") or "").strip() or media_root / ".film-segments")
    if make_orchestrator is None:
        media = fo.Media(ml.MediaStore(url, key), media_root, tools)
        orch = fo.FilmOrchestrator(db, resolver, worker_id=args.worker_id, media=media, out_dir=out_dir, media_root=media_root,
                                   tools=tools, scrub=make_scrubber(env), stop=stop)
    else:
        orch = make_orchestrator(db, resolver, worker_id=args.worker_id, out_dir=out_dir, media_root=media_root, tools=tools,
                                 stop=stop)

    def on_signal(signum, _frame):
        logger.info("signal %s: no new take begins; a take waiting on its provider is polled again by the next claim", signum)
        stop.set()

    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, on_signal)
        signal.signal(signal.SIGINT, on_signal)

    every = expire_every(env)
    logger.info("film worker %s started (sweep every %s s, media library read/write)", args.worker_id, every)
    sweep_once(db)
    if args.once:
        return loop(orch, db, stop, once=True)
    t = threading.Thread(target=sweeper, args=(db, stop, every), daemon=True, name="film-sweep")
    t.start()
    try:
        return loop(orch, db, stop, once=False)
    finally:
        stop.set()
        t.join(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
