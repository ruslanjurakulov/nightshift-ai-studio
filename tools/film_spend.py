#!/usr/bin/env python3
"""One film's vendor spend so far, for a person to check after every take (docs/studio/S2_LIVE_TEST.md, step 4).

  python tools/film_spend.py --film <film uuid>

Prints the known vendor dollars of the film's takes, how they were arrived at, each take (kind, attempt, status,
dollars or why there are none) and the watch's two lines. The same reads and the same arithmetic as the operator
alert ``film:spend:*`` (modules/operator_bot/sources.py ``film_spend_for``, analysis.film_spend_rollup):

* "recorded": the cost row carries its own usd_estimate;
* "estimated (registry figure)": the row's quantity times model_registry's pricing.provider_usd_per_unit, in the
  same unit. The adapters leave usd_estimate empty by design, so this is the usual case;
* "estimated (highest variant)": the same for a model priced in variants (pricing.variants.prices: resolution, image
  size, quality, audio), at the dearest variant that states a figure: which one the vendor billed is not read, and a cap
  watcher must not guess low. A variant table with no figure is unknown, never the base figure;
* "unknown": no quantity, no figure for the model, another unit, or a finished take with no cost row at all. NEVER
  counted as 0: the total is the known sum plus the unknown lines, and for those the vendor's billing page is the
  only measure.

Read-only: it reads films, film_takes, creative_jobs, creative_job_costs and model_registry with the service key
(SUPABASE_URL, SUPABASE_SERVICE_KEY) and writes nothing, stops nothing and spends nothing. The key is never printed or
logged. NIGHTSHIFT_FILM_SPEND_WARN_USD (default 6) and NIGHTSHIFT_FILM_SPEND_STOP_USD (default 8) are the lines; a
malformed one is refused, naming the variable.

Exit codes: 0 the film was read; 2 refused (bad variable, bad film id, Supabase not configured, a read failed or the
film does not exist). Being over a line is not an error: the output says so in words.
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules import log_redaction  # noqa: E402
from modules.operator_bot.config import FilmSpendConfigError, OperatorConfig, parse_film_spend_thresholds  # noqa: E402
from modules.operator_bot.sources import OperatorSources  # noqa: E402

EXIT_OK, EXIT_REFUSED = 0, 2
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

BASIS = {"recorded": "recorded", "estimated": "estimated (registry figure)",
         "estimated_highest": "estimated (highest variant)",
         "estimated_mixed": "estimated (registry figure; highest variant where priced in variants)",
         None: "no dollar figure known yet"}
STATE = {"not_recorded": "not recorded", "unknown": "unknown", "pending": "in flight, no cost row yet",
         "no_job": "no vendor call"}


def _usd(value) -> str:
    return f"USD {float(value):,.2f}"


def render(film: dict, warn, stop) -> list[str]:
    """The report's lines, from one film_spend_rollup entry. Ids, closed words and money only."""
    out = [f"Film {film['film_id']} (org {str(film.get('org_id') or '?')[:8]})",
           f"Lines: warn {_usd(warn)}, stop {_usd(stop)} (NIGHTSHIFT_FILM_SPEND_WARN_USD / NIGHTSHIFT_FILM_SPEND_STOP_USD)",
           f"Known vendor cost: {_usd(film['usd'])}, {BASIS.get(film.get('basis'), BASIS[None])}"
           + (f"; plus {film['unknown']} unknown line(s), NOT counted" if film.get("unknown") else ""),
           "Takes (kind, attempt, status, vendor cost):"]
    for t in film.get("takes") or []:
        if t["state"] in STATE:
            cost = STATE[t["state"]]
        else:
            cost = f"{_usd(t['usd'])} {BASIS.get(t.get('basis'), '')}".rstrip()
            if t.get("unknown"):
                cost += f", plus {t['unknown']} unknown line(s)"
        out.append(f"  {t.get('kind') or '?':<10} {t.get('attempt') or '?'!s:<3} {t.get('status') or '?':<11} {cost}")
    if not film.get("takes"):
        out.append("  (no takes yet)")
    if film["usd"] >= stop:
        out.append("AT OR ABOVE THE STOP LINE: stop the film by hand now (runbook step 6): the workspace switch off, then "
                   "film_cancel_segment, then NIGHTSHIFT_FILM_WORKER empty and redeploy.")
    elif film["usd"] >= warn:
        out.append("At or above the warn line: check again after the next take.")
    else:
        out.append("Below the warn line.")
    if film.get("unknown"):
        out.append("Unknown lines are not included: check the vendor billing pages.")
    return out


def main(argv=None, sync=None, out=print) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--film", required=True, help="the film's id (uuid)")
    args = parser.parse_args(argv)
    log_redaction.install()
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    try:
        warn, stop = parse_film_spend_thresholds()
    except FilmSpendConfigError as e:
        out(f"refused: {e}")
        return EXIT_REFUSED
    film_id = args.film.strip().lower()
    if not _UUID.match(film_id):
        out("refused: --film is not a film id (a uuid like 0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8)")
        return EXIT_REFUSED
    if sync is None:
        from modules.supabase_sync import SupabaseSync

        sync = SupabaseSync()
    if not getattr(sync, "enabled", False):
        out("refused: SUPABASE_URL and SUPABASE_SERVICE_KEY are not set")
        return EXIT_REFUSED
    ops = OperatorSources(sync, lambda *_a: (None, None), OperatorConfig(film_spend_warn_usd=warn, film_spend_stop_usd=stop))
    sec = ops.film_spend_for(film_id)
    if not sec.ok:
        out(f"refused: the film's spend could not be read ({sec.note})")
        return EXIT_REFUSED
    for line in render(sec.data[0], warn, stop):
        out(line)
    if sec.cap:
        out(f"Note: a read hit its limit of {sec.cap} rows; the sum above may be short of the whole.")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
