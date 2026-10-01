"""Security-lab contract for migration 0059 (auto-captions).

Kept in its own module, like sec_editor_0054. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_captions_0059; sec_captions_0059.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_captions_0059.seed(conn, sc)

The seed writes each tenant's caption track the way production leaves one: a
captions job that has COMPLETED (the track is visible only then) and the
track the worker stored for it. creative_jobs and caption_tracks are closed to
every API role, the service key included, so the lab writes them as the
superuser, like the tenant's seeded creative job. The named attacks are in
test_sec_captions.py.
"""

from __future__ import annotations

import json
import uuid
from typing import Dict

#: Per tenant key ('a' / 'b'): the track and the job it belongs to.
TRACK: Dict[str, str] = {}
JOB: Dict[str, str] = {}

WORDS = [{"t": "Salom", "s": 0.1, "e": 0.5}, {"t": "dunyo", "s": 0.6, "e": 1.1}]


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # Members read the tracks of completed jobs of their organization;
        # nobody inserts, updates or deletes directly.
        "caption_tracks": Org(),
    })
    functions.update({
        "store_caption_track": SERVICE,
        "delete_caption_track": USER,
    })


def seed(conn, sc) -> None:
    from sec_db import as_superuser

    for t in sc.tenants():
        k = t.key
        track = str(uuid.uuid4())
        with as_superuser(conn) as s:
            JOB[k] = str(s.value(
                "insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, "
                "quoted_credits, charged_credits, result, requested_by) values (%s, 'captions', 'scribe', 'scribe', "
                "%s::jsonb, 'completed', 6, 6, %s::jsonb, (select id from auth.users limit 1)) returning id",
                [t.org, json.dumps({"source_asset_id": str(uuid.uuid4())}), json.dumps({"track_id": track})]))
            s.rows("insert into public.caption_tracks (id, org_id, job_id, language, duration_s, word_count, words) "
                   "values (%s, %s, %s, 'uz', 95, 2, %s::jsonb) returning 1", [track, t.org, JOB[k], json.dumps(WORDS)])
        TRACK[k] = track
