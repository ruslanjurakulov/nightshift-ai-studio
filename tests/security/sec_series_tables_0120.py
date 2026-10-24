"""Security-lab contract for migration 0120 (Series Factory, slice S2: series_plans, series_episodes, the series queue kind).

Wired in like the other per-migration files:

  * sec_expectations.py, at the bottom:
        import sec_series_tables_0120; sec_series_tables_0120.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_series_tables_0120.seed(conn, sc)

Two tables, both Org(): a member reads the rows of THEIR organization, and no API role writes either (the isolation tests then prove that
Bob reads none of Alice's plans and cannot insert, update or delete any). Every function is declared:

  * quote_series_episode and start_series_episode are USER (the function itself checks the organization and the role);
  * finish_series_plan is SERVICE (the worker; granted to service_role only);
  * request_series_plan is SERVICE too, and that is the dormant state: granted to NO API role until the migration that ships the worker and the
    UI (S3). The named tests call it as the database owner carrying a person's JWT claims, the way a later server-side caller would;
  * the helpers and the trigger-adjacent functions are SERVICE (no API role at all).
"""

from __future__ import annotations

import hashlib
import json
from typing import Dict

#: Per tenant key ('a' / 'b'): ids the isolation tests aim at.
PLAN: Dict[str, str] = {}
EPISODES: Dict[str, list] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # Members read; nobody inserts, updates or deletes directly: the functions are the only write path.
        "series_plans": Org(),
        "series_episodes": Org(),
    })
    functions.update({
        "quote_series_episode": USER,
        "start_series_episode": USER,
        # the worker (service role only)
        "finish_series_plan": SERVICE,
        # B1-style: granted to nobody until the migration that ships the worker and the UI
        "request_series_plan": SERVICE,
        # internal: called only inside the functions above
        "series_plan_daily_limit": SERVICE,
        "series_episode_price": SERVICE,
        "series_episode_blocker": SERVICE,
        "series_episode_json": SERVICE,
    })


def seed(conn, sc) -> None:
    """Each tenant has one READY plan of three episodes, written by the database owner (the function that writes one needs a worker and a
    queued plan, and a queued plan would add a render job the other lab files count). The plan is two days old, so it does not count
    against the daily cap the named tests exercise."""
    from sec_db import as_superuser

    for t in sc.tenants():
        k = t.key
        with as_superuser(conn) as s:
            PLAN[k] = str(s.value(
                "insert into public.series_plans (org_id, channel_id, topic, niche, language, n_episodes, duration_s, status, title, "
                "report, idempotency_key, request_hash, result_hash, requested_by, created_at, finished_at) "
                "values (%s, %s, %s, 'tech', 'English', 3, 300, 'ready', %s, '{\"fact_checked\": false}', %s, %s, %s, %s, "
                "now() - interval '2 days', now() - interval '2 days') returning id",
                [t.org, t.channel, f"Seed topic {k}", f"Seed series {k}", f"seed-plan-{k}-0000",
                 hashlib.md5(f"plan-{k}".encode()).hexdigest(), hashlib.md5(f"result-{k}".encode()).hexdigest(), t.actor.uid]))
            EPISODES[k] = []
            for n in (1, 2, 3):
                EPISODES[k].append(str(s.value(
                    "insert into public.series_episodes (plan_id, org_id, n, topic, outline, usable, needs_confirmation, duration_s) "
                    "values (%s, %s, %s, %s, %s::jsonb, true, false, 300) returning id",
                    [PLAN[k], t.org, n, f"Seed episode {k}{n}", json.dumps({"working_title": f"Seed {k}{n}"})])))
