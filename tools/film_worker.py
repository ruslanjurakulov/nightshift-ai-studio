#!/usr/bin/env python3
"""Film worker: drive Film Studio segments (migrations 0171 and 0198) — claim, the takes, the assembly, the settle.

    python tools/film_worker.py              # loop forever (the compose command)
    python tools/film_worker.py --once       # at most one segment and one sweep, then exit

What one segment does is ``modules/film_orchestrator.py``. This file wires it up:

* OFF unless ``NIGHTSHIFT_FILM_WORKER=on`` in this process's environment: anything else (empty, off, a typo) claims nothing and
  sweeps nothing, and the loop only waits for a stop;
* and it CLAIMS nothing unless the assembly can run too: ``NIGHTSHIFT_FILM_ASSEMBLY=on`` and ``modules.film_assembly`` importable. A
  segment claimed without them would have its takes made and charged, then wait for an assembly that cannot happen until its leases
  run out and 0171 settles it as worker_lost: a customer charged for takes that never became a film. So it fails early (CLAUDE.md
  #6): one line names what is missing, and the worker only sweeps. A queued segment is never claimed, so the sweep's unclaimed-hours
  rule settles it at 0 and its hold goes back; The database has its own two switches as well (0171's platform switch and 0198's
  per organization), both off by default; this flag only decides whether this process works at all;
* the service key comes from the env file (``SUPABASE_URL`` / ``SUPABASE_SERVICE_KEY``), never a flag, and is never printed;
* the provider adapters are the creative worker's (``NIGHTSHIFT_CREATIVE_ADAPTERS``, ``module:function``): the same resolver, so a take
  runs through exactly the adapter a Studio job of that model would;
* ``NIGHTSHIFT_MEDIA_DIR`` must be the media library volume, writable, with ffmpeg and ffprobe here: a take's file is registered
  into the library and a clip's last frame is extracted, and without them no take could be delivered, so the worker refuses to start
  (rule 6: say it before anything is spent) rather than claim segments it cannot finish;
* ``film_expire_segments`` runs on its own thread every ``FILM_EXPIRE_EVERY_SECONDS`` (default 300, never more than 900): a segment past
  its deadline and grace, or one nobody claimed, settles while its hold is open, even while this worker drives a long film. It is
  called through 0212's ``film_sweep('worker')``, which records the run; the worker is one of three runners (with pg_cron where
  installed and the film-sweep service, ``tools/film_sweep.py --loop``), so a stopped worker no longer stops the sweep;
* stored error text is scrubbed of every secret in this process's environment (the pipeline worker's scrubber);
* it reports to ``worker_status`` (0045, ``modules/worker_status.py``, kind ``other``, id ``film-<host>-<pid>``): 'starting', then
  'running' as a heartbeat, 'failed' with the remedy when it refuses to start (variable names, never values), 'stopped' at the end,
  and 'stopped' with "NIGHTSHIFT_FILM_WORKER is not on" while switched off. The operator's "worker lost" alert reads it (gate G4).

SIGTERM (``docker stop``) stops between calls: a take waiting on its provider leaves its task id stored, and the next claim polls it.
"""

from __future__ import annotations

import argparse
import importlib
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
ASSEMBLY_FLAG = fo.ASSEMBLY_FLAG
#: 0171's switch-on gate: the sweep runs at least every 15 minutes.
MAX_EXPIRE_EVERY_SECONDS = 900
DEFAULT_EXPIRE_EVERY_SECONDS = 300
IDLE_MIN_SECONDS = 5.0
IDLE_MAX_SECONDS = 60.0


def enabled(env: Mapping[str, str]) -> bool:
    """Exactly ``on`` (as every other worker switch here): anything else is off, never a quiet guess."""
    return fo.switch_on(env, FLAG)


def assembly_missing(env: Mapping[str, str]) -> Optional[str]:
    """Why no segment may be claimed here, or None: the assembly's switch and the assembly session's module, both needed to finish a
    film this worker would start."""
    if not fo.switch_on(env, ASSEMBLY_FLAG):
        return f"{ASSEMBLY_FLAG} is not 'on'"
    try:
        importlib.import_module("modules.film_assembly")
    except ModuleNotFoundError as e:
        if e.name == "modules.film_assembly":
            return "modules.film_assembly is not installed"
        return f"modules.film_assembly does not import ({type(e).__name__})"
    except Exception as e:  # noqa: BLE001 — any import failure means the assembly cannot run
        return f"modules.film_assembly does not import ({type(e).__name__})"
    return None


def make_scrubber(env) -> Callable[[str], str]:
    from tools.queue_worker import scrub, secret_values  # noqa: PLC0415

    secrets = secret_values(env)
    return lambda text: scrub(text, secrets)


def expire_every(env: Mapping[str, str]) -> int:
    return cw.parse_int(env, "FILM_EXPIRE_EVERY_SECONDS", DEFAULT_EXPIRE_EVERY_SECONDS, 30, MAX_EXPIRE_EVERY_SECONDS)


#: Set once the worker has said that 0212 is missing, so a sweep every 5 minutes does not repeat it.
_SWEEP_UNRECORDED = threading.Event()


def sweep_once(db) -> None:
    try:
        try:
            n = db.sweep("worker")
        except fo.FilmFunctionMissing as e:
            # 0212 is not applied here. Calling film_expire_segments directly is NOT a quality fallback (CLAUDE.md #4): film_sweep
            # runs exactly this function and only adds the record of the run. What is lost until 0212 is applied is the record,
            # never a rule of the sweep, so the sweep must not stop because its bookkeeping is missing.
            if not _SWEEP_UNRECORDED.is_set():
                _SWEEP_UNRECORDED.set()
                logger.warning("%s: calling film_expire_segments directly; this worker's sweeps are not recorded until it is", e)
            n = db.expire()
        if n:
            logger.info("the sweep settled or drained %s film segment(s)", n)
    except fo.FilmUnavailable as e:  # its text is a function name and a status or SQLSTATE, never a key or a body
        logger.warning("the film sweep failed (%s); the next one tries again", e)
    except fo.FilmRefused as e:
        logger.warning("the film sweep was refused (%s); the next one tries again", e.word)
    except Exception as e:  # the next sweep tries again; the claim does not depend on it
        logger.warning("the film sweep failed (%s)", type(e).__name__)


def prune_cache(media_root: Path) -> None:
    """Housekeeping at start (throttled to once per 24h inside): never raises, a failure must not stop a paid film."""
    try:
        from modules import film_assembly as fa  # noqa: PLC0415

        fa.prune_word_cache(media_root)
    except Exception as e:  # noqa: BLE001
        logger.warning("word cache prune skipped (%s)", type(e).__name__)


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


def status_id(worker_id: str) -> str:
    """The worker_status id: ``film-<host>-<pid>`` (or ``film-`` + NIGHTSHIFT_WORKER_ID). The prefix is what the operator
    alerts group by (kind 'other' is shared with the e-mail worker), so one's heartbeat never hides the other's silence."""
    return ("film-" + str(worker_id or "").removeprefix("film-"))[:64]


def default_reporter(url: str, key: str, worker_id: str, env: Mapping[str, str]):
    from modules.worker_status import WorkerStatusReporter  # noqa: PLC0415

    return WorkerStatusReporter(url, key, worker_id=status_id(worker_id), kind="other", scrub=make_scrubber(env))


class _NoReporter:
    """No SUPABASE_URL / key: nowhere to report to, and the log line already names what is missing."""

    def report(self, state, detail=None):
        return False

    def start_heartbeat(self):
        return None

    def close(self, state="stopped", detail=None):
        return False


def main(argv: Optional[List[str]] = None, env: Optional[Mapping[str, str]] = None, *,
         make_db: Callable[[str, str], object] = lambda url, key: fo.FilmRest(url, key),
         make_orchestrator: Optional[Callable[..., object]] = None,
         make_reporter: Optional[Callable[..., object]] = None,
         stop: Optional[threading.Event] = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description="Drive Film Studio segments (migrations 0171, 0198)")
    parser.add_argument("--once", action="store_true", help="At most one segment and one sweep, then exit")
    parser.add_argument("--worker-id", default=env.get("NIGHTSHIFT_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s film_worker %(levelname)s %(message)s")
    stop = stop or threading.Event()

    url = str(env.get("SUPABASE_URL", "") or "").strip()
    key = str(env.get("SUPABASE_SERVICE_KEY", "") or "").strip()
    # worker_status (0045): without it a dead film worker was invisible to the operator's "worker lost" alert (gate G4).
    # Every detail below names a variable or a module, never a value, and goes through the secret scrubber anyway.
    if not url or not key:
        reporter = _NoReporter()
    else:
        reporter = (make_reporter or default_reporter)(url, key, args.worker_id, env)

    def refuse(detail: str) -> int:
        reporter.close("failed", detail)
        return 2

    if not enabled(env):
        logger.info("%s is not 'on': this worker claims nothing and sweeps nothing", FLAG)
        # 'stopped' is never "lost": an operator who switched it off is not paged for it.
        reporter.close("stopped", f"{FLAG} is not on")
        if not args.once:
            stop.wait()
        return 0

    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file: the film segments live in Supabase")
        return 2
    reporter.report("starting")
    missing = assembly_missing(env)
    if missing:
        # Deliberately NOT fully idle: the sweep never claims and never spends. It only runs 0171's rules, so a queued segment nobody
        # can assemble is settled at 0 after the unclaimed hours and its fm- hold released, instead of holding a customer's credits open.
        logger.warning("%s: no film segment is claimed until the assembly can run; only the sweep runs", missing)
        # 'failed', not 'running': the switch says films should be made here and none can be, which is the operator's to fix.
        reporter.close("failed", f"{missing}: no film segment is claimed until the assembly can run; only the sweep runs")
        db = make_db(url, key)
        sweep_once(db)
        if not args.once:
            sweeper(db, stop, expire_every(env))
        return 0
    spec = str(env.get(cw.ADAPTERS_ENV, "") or "").strip()
    if not spec:
        logger.error("%s is not set: no provider adapters, so no take could be made; nothing is claimed", cw.ADAPTERS_ENV)
        return refuse(f"{cw.ADAPTERS_ENV} is not set: no provider adapters, so no take could be made; nothing is claimed")
    try:
        resolver = cw.load_resolver(spec)
    except Exception as e:
        # The variable's name and the exception's type only: the value is whatever was typed into the env file.
        logger.error("%s could not be loaded (%s); nothing is claimed", cw.ADAPTERS_ENV, type(e).__name__)
        return refuse(f"{cw.ADAPTERS_ENV} could not be loaded ({type(e).__name__}); nothing is claimed")
    raw = str(env.get("NIGHTSHIFT_MEDIA_DIR", "") or "").strip()
    media_root = Path(raw) if raw else None
    if media_root is None or not media_root.is_absolute() or not media_root.is_dir() or not os.access(media_root, os.W_OK):
        logger.error("NIGHTSHIFT_MEDIA_DIR must be the media library volume, writable here: a take's file is registered into the "
                     "library; nothing is claimed")
        return refuse("NIGHTSHIFT_MEDIA_DIR must be the media library volume, writable here; nothing is claimed")
    from modules import media_library as ml  # noqa: PLC0415

    tools = ml.find_tools()
    if tools is None:
        logger.error("ffmpeg and ffprobe are needed (a clip's last frame, the narration's clock and loudness); nothing is claimed")
        return refuse("ffmpeg and ffprobe are needed (a clip's last frame, the narration's clock and loudness); nothing is claimed")

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
    t = threading.Thread(target=sweeper, args=(db, stop, every), daemon=True, name="film-sweep")
    if args.once:
        reporter.report("running")
    else:
        # 'running' now and every 30 s on its own thread, so a take that waits minutes on its provider still beats.
        reporter.start_heartbeat()
    try:
        sweep_once(db)
        prune_cache(media_root)
        if args.once:
            rc = loop(orch, db, stop, once=True)
        else:
            t.start()
            rc = loop(orch, db, stop, once=False)
    except BaseException as e:
        # Not 'stopped': a worker that died on an error must read as failed, by its exception's name only.
        reporter.close("failed", f"the film worker stopped on an unexpected error ({type(e).__name__}); restart it")
        raise
    finally:
        stop.set()
        if t.is_alive():
            t.join(timeout=5)
    reporter.close("stopped")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
