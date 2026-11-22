#!/usr/bin/env python3
"""One Film Studio sweep, recorded: ``film_sweep('actions')`` (migration 0212), which runs 0171's ``film_expire_segments``.

    python tools/film_sweep.py

It spends nothing. The sweep only applies 0171's settle rules to segments that are already paid for by an open hold: a segment
past its deadline and grace, one nobody claimed within 3 hours, or one whose hold 0020 let go is settled (what was made is
captured, the rest released). It calls no provider, claims no segment, starts no take and publishes nothing.

Why it exists (switch-on gate G2, docs/FILM_STUDIO.md): the film worker's own sweep stops whenever the worker does, and pg_cron is
not installed on the live project, so ``.github/workflows/film_sweep.yml`` runs this every 10 minutes from GitHub, independent of the
server. Each run is recorded under the runner ``actions`` in ``film_sweep_runs``; ``film_sweep_status()`` says when any runner last
swept, and whether that is overdue.

Needs ``SUPABASE_URL`` and ``SUPABASE_SERVICE_KEY`` (Actions secrets). Without them it logs that it is off, prints a ``::warning::``
annotation for the Actions page, and exits 0. The key is never printed. Exit 1 when the sweep could not run or failed in the database (the run turns red; the database recorded the
SQLSTATE), so a broken sweep is seen rather than assumed.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Callable, Mapping, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules import film_orchestrator as fo  # noqa: E402

logger = logging.getLogger("film_sweep")

RUNNER = "actions"


def main(env: Optional[Mapping[str, str]] = None, *,
         make_db: Callable[[str, str], object] = lambda url, key: fo.FilmRest(url, key)) -> int:
    env = os.environ if env is None else env
    url = str(env.get("SUPABASE_URL", "") or "").strip()
    key = str(env.get("SUPABASE_SERVICE_KEY", "") or "").strip()
    if not url or not key:
        logger.info("SUPABASE_URL and SUPABASE_SERVICE_KEY are not both set: the film sweep is off here; nothing was swept")
        # Exit 0 (an unset secret is a choice, not a crash) but say so where the Actions page shows it: a green run that swept nothing
        # must not read as a sweep. The annotation names only the two variable names.
        print("::warning title=Film sweep is off::SUPABASE_URL and SUPABASE_SERVICE_KEY are not set; no film sweep ran from Actions")
        return 0
    db = make_db(url, key)
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
    logger.info("film sweep (%s): %s segment(s) settled or drained", RUNNER, n)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s film_sweep %(levelname)s %(message)s")
    raise SystemExit(main())
