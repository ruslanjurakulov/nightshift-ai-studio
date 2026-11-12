"""Character Studio worker — migration 0135, ``modules/character_swap.py`` (docs/CHARACTER_STUDIO.md).

DARK. It does nothing unless ``NIGHTSHIFT_CHARACTER_STUDIO=on``: with the switch off (the default) it says so and exits 0 without connecting
to anything. It is not in deploy/docker-compose.yml yet: adding a service for it is a release step (docs/CHARACTER_STUDIO.md, "Releasing"),
after the owner has the vendors' written answers and has set a price per model.

With the switch on it claims one priced swap at a time, refuses what the vendor would refuse before any paid call, submits it to the model
the person chose (Kling 4.0 Omni or BytePlus Seedance 2.5, each its maker's own API), records the vendor's task BEFORE polling, stores the
result in the media library (source 'generated') and finishes the job, which captures exactly the charge; every failure releases the hold.

Environment:
  NIGHTSHIFT_CHARACTER_STUDIO                 on, or the worker exits at once
  SUPABASE_URL, SUPABASE_SERVICE_KEY          0135's worker functions and register_asset (service key)
  NIGHTSHIFT_MEDIA_DIR                        absolute; the `media` volume (rw): the inputs are read and the result is stored there
  NIGHTSHIFT_CHARACTER_STUDIO_PUBLIC_ORIGIN   the Command Center's public https origin: the vendors fetch the inputs from it
  MEDIA_URL_SECRET                            the web app's signing key (the same value): the input links are signed with it
  KLING_API_KEY / SEEDANCE_API_KEY            the vendors' keys, read by the adapters from the environment; never stored
  NIGHTSHIFT_WORKER_ID                        optional; defaults to character-swap-<host>-<pid>

Exits 2 with the remedy when something it needs is missing. Nothing secret is logged.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import signal
import socket
import sys
import threading
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import character_swap  # noqa: E402

logger = logging.getLogger("character_swap_worker")

POLL_SECONDS = 5.0


def enabled(env=os.environ) -> bool:
    return (env.get(character_swap.FLAG) or "").strip().lower() == "on"


def build_worker(env=os.environ) -> character_swap.CharacterSwapWorker:
    url, key = (env.get("SUPABASE_URL") or "").strip(), (env.get("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        raise SystemExit("character swap worker: set SUPABASE_URL and SUPABASE_SERVICE_KEY (the service key) and start it again")
    media = (env.get("NIGHTSHIFT_MEDIA_DIR") or "").strip()
    if not (media and os.path.isabs(media) and Path(media).is_dir()):
        raise SystemExit("character swap worker: set NIGHTSHIFT_MEDIA_DIR to the media volume (an absolute directory): the inputs are "
                         "read and the result is stored there")
    origin = (env.get(character_swap.ORIGIN_ENV) or "").strip().rstrip("/")
    if not re.fullmatch(r"https://[a-z0-9.-]+", origin):
        raise SystemExit(f"character swap worker: set {character_swap.ORIGIN_ENV} to the Command Center's public https origin (the vendors "
                         "fetch the signed inputs from it)")
    secret = (env.get(character_swap.SECRET_ENV) or "")
    if len(secret) < character_swap.MIN_SECRET_CHARS:
        raise SystemExit(f"character swap worker: set {character_swap.SECRET_ENV} to the web app's media signing key (the same value)")
    from modules import media_library  # noqa: PLC0415

    worker_id = (env.get("NIGHTSHIFT_WORKER_ID") or "").strip() or f"character-swap-{socket.gethostname()}-{os.getpid()}"
    library = character_swap.Library(store=media_library.MediaStore(url, key), media_root=Path(media), tools=media_library.find_tools())
    return character_swap.CharacterSwapWorker(character_swap.SwapStore(url, key), worker_id=worker_id, library=library,
                                              scratch=Path(media) / ".character-swap", origin=origin, secret=secret.encode("utf-8"))


def main(argv=None, env=os.environ) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="run at most one job, then exit")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if not enabled(env):
        logger.info("%s is not on: Character Studio is dark, nothing is claimed", character_swap.FLAG)
        return 0
    try:
        worker = build_worker(env)
    except SystemExit as e:
        logger.error("%s", e)
        return 2
    worker.scratch.mkdir(mode=0o700, exist_ok=True)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    while not stop.is_set():
        try:
            busy = worker.run_once()
        except character_swap.StoreUnavailable as e:
            logger.warning("the database is out of reach (%s)", e)
            busy = False
        except Exception as e:  # noqa: BLE001 — a claim that failed: wait and try again
            logger.error("claim failed (%s)", type(e).__name__)
            busy = False
        if args.once:
            return 0
        if not busy:
            stop.wait(POLL_SECONDS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
