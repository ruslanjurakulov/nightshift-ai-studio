"""Brand scan worker — migration 0133, ``modules/brand_scan.py`` (docs/ADS_FACTORY.md, "Phase 2: brand scan").

DARK. It does nothing unless ``NIGHTSHIFT_ADS_BRAND_SCAN=on``: with the switch off (the default) it says so and exits 0
without connecting to anything. It runs as the `brand-scan-worker` service of deploy/docker-compose.yml (profile
`brandscan`), which the deploy starts only while the repository variable NIGHTSHIFT_ADS_BRAND_SCAN is `on`
(docs/ADS_FACTORY.md, "Releasing Phase 2": the owner sets the price after the worker runs).

With the switch on it claims, one at a time, the DNS TXT checks people asked for ("Check now") and the brand scans they
paid for, runs each (modules/dns_txt.py, modules/brand_fetch.py, modules/brand_extract.py) and records the result
through 0133's worker functions with the service key.

Environment:
  NIGHTSHIFT_ADS_BRAND_SCAN            on, or the worker exits at once
  SUPABASE_URL, SUPABASE_SERVICE_KEY   0133's worker functions (service key)
  NIGHTSHIFT_MEDIA_DIR                 absolute; the `media` volume (rw), where a logo or product picture is stored as a
                                       library asset. Without it the scan still runs and proposes no picture.
  NIGHTSHIFT_WORKER_ID                 optional; defaults to brand-scan-<host>-<pid>

Exits 2 with the remedy when the URL or the key is missing. Nothing secret is logged.
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

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import brand_scan  # noqa: E402

logger = logging.getLogger("brand_scan_worker")

POLL_SECONDS = 5.0


def enabled(env=os.environ) -> bool:
    return (env.get(brand_scan.FLAG) or "").strip().lower() == "on"


def build_worker(env=os.environ) -> brand_scan.BrandScanWorker:
    url, key = (env.get("SUPABASE_URL") or "").strip(), (env.get("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        raise SystemExit("brand scan worker: set SUPABASE_URL and SUPABASE_SERVICE_KEY (the service key) and start it again")
    worker_id = (env.get("NIGHTSHIFT_WORKER_ID") or "").strip() or f"brand-scan-{socket.gethostname()}-{os.getpid()}"
    library = None
    media = (env.get("NIGHTSHIFT_MEDIA_DIR") or "").strip()
    if media and os.path.isabs(media) and Path(media).is_dir():
        from modules import media_library  # noqa: PLC0415

        library = brand_scan.Library(store=media_library.MediaStore(url, key), media_root=Path(media),
                                     tools=media_library.find_tools())
    else:
        logger.warning("NIGHTSHIFT_MEDIA_DIR is not an absolute directory: scans will propose no logo or product picture")
    return brand_scan.BrandScanWorker(brand_scan.ScanStore(url, key), worker_id=worker_id, library=library,
                                      scratch=Path(media) / ".brand-scan" if library else None)


def main(argv=None, env=os.environ) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="run at most one check or scan, then exit")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if not enabled(env):
        logger.info("%s is not on: the brand scan is dark, nothing is claimed", brand_scan.FLAG)
        return 0
    try:
        worker = build_worker(env)
    except SystemExit as e:
        logger.error("%s", e)
        return 2
    if worker.scratch is not None:
        worker.scratch.mkdir(mode=0o700, exist_ok=True)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    while not stop.is_set():
        try:
            busy = worker.run_once()
        except brand_scan.StoreUnavailable as e:
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
