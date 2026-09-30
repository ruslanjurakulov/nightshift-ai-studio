"""Media library ingest worker — migration 0038, ``modules/media_library.py``.

Claims upload tickets the Command Center has received into the staging volume,
checks what the file really is, stores it under ``media/<aa>/<uuid>/`` with a
thumbnail / proxy, and registers the asset; also removes the files of assets a
member deleted. Runs as its own compose service (``media-worker``, profile
``worker``) from the worker image, so an upload is never stuck behind a
30-minute render in ``tools/queue_worker.py``.

Environment (the worker's env file plus the compose service's own values):
  SUPABASE_URL, SUPABASE_SERVICE_KEY   the queue lives in Supabase (service key)
  NIGHTSHIFT_MEDIA_DIR                 absolute; the `media` volume (rw here)
  NIGHTSHIFT_MEDIA_STAGING_DIR         absolute; the `media_staging` volume
  NIGHTSHIFT_WORKER_ID                 optional; defaults to host-pid

Exits 2 with the remedy when something it needs is missing, rather than
claiming tickets it could only reject.
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

from modules import media_library  # noqa: E402

logger = logging.getLogger("media_worker")

DEFAULT_POLL_SECONDS = 5.0


def _abs_dir(name: str) -> Optional[Path]:
    raw = os.environ.get(name, "").strip()
    if not raw or not os.path.isabs(raw):
        return None
    return Path(raw)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest media uploads (migration 0038)")
    parser.add_argument("--once", action="store_true", help="Handle at most one ticket and exit")
    parser.add_argument("--worker-id", default=os.environ.get("NIGHTSHIFT_WORKER_ID")
                        or f"{socket.gethostname()}-{os.getpid()}")
    parser.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s media_worker %(levelname)s %(message)s")

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file "
                     "(docs/WORKER_VPS.md) — the upload queue lives in Supabase.")
        return 2
    media_root = _abs_dir("NIGHTSHIFT_MEDIA_DIR")
    staging_root = _abs_dir("NIGHTSHIFT_MEDIA_STAGING_DIR")
    if media_root is None or staging_root is None:
        logger.error("NIGHTSHIFT_MEDIA_DIR and NIGHTSHIFT_MEDIA_STAGING_DIR must be absolute paths of the "
                     "`media` and `media_staging` volumes (deploy/docker-compose.yml, media-worker).")
        return 2
    for d in (media_root, staging_root):
        if not d.is_dir() or not os.access(d, os.W_OK):
            logger.error("%s is not a writable directory: mount the volume and make it writable by uid %s "
                         "(docker run --rm -v <volume>:/v alpine chown %s /v)", d, os.getuid(), os.getuid())
            return 2
    tools = media_library.find_tools()
    if tools is None:
        logger.error("ffmpeg and ffprobe are required to check uploads; install the ffmpeg package "
                     "(Dockerfile.worker does).")
        return 2

    service = media_library.MediaService(url, key, staging_root=staging_root, media_root=media_root,
                                         worker_id=args.worker_id, tools=tools)
    stop = threading.Event()

    def request_stop(signum, _frame=None):
        # The ticket in hand is finished; a killed one is re-claimed by the
        # database after its heartbeat goes stale.
        logger.info("stop requested (signal %s)", signum)
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    logger.info("media worker %s started (poll %ss)", args.worker_id, args.poll_seconds)
    while not stop.is_set():
        handled = service.run_once()
        if args.once:
            return 0
        if not handled:
            stop.wait(args.poll_seconds)
    logger.info("media worker stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
