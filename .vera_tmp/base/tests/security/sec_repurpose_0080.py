"""Security-lab contract for migration 0080 (multi-clip repurposing).

Kept in its own module, like sec_scene_regen_0076. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_repurpose_0080; sec_repurpose_0080.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_repurpose_0080.seed(conn, sc)

The seed writes one ENDED (failed) request with one failed clip per tenant, so
the isolation tests have a row of each organization to try to read, change,
move and delete — the way only the database owner could: production writes
these rows through request_repurpose and the worker's functions, which
test_sec_repurpose.py attacks.
"""

from __future__ import annotations

import hashlib
import json
from typing import Dict

#: Per tenant key ('a' / 'b'): the id of its seeded (ended) request.
REQUEST: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Channel

    tables.update({
        # Members of the channel's organization read; nobody writes directly.
        "repurpose_requests": Channel(),
        "repurpose_clips": Channel(),
    })
    functions.update({
        # Each checks who the caller is itself: quote = may read the video,
        # request = admin of the channel's organization (the Run now rule).
        "quote_repurpose": USER,
        "request_repurpose": USER,
        # The worker's (service key) and internal helpers: no API role.
        "claim_repurpose_request": SERVICE,
        "heartbeat_repurpose": SERVICE,
        "record_repurpose_clip": SERVICE,
        "finish_repurpose_request": SERVICE,
        "expire_repurpose_requests": SERVICE,
        "repurpose_plan": SERVICE,
        "repurpose_master_state": SERVICE,
        "repurpose_price": SERVICE,
        "repurpose_settle": SERVICE,
    })


def held_id(channel: str, slug: str) -> str:
    """modules/held_video.held_video_id: a run that has not uploaded."""
    return "run-" + hashlib.sha256(f"{channel}\n{slug}".encode()).hexdigest()[:20]


def manifest(*, audio_s: float = 150.0) -> dict:
    """A Video IR of ten scenes (s000..s009): lengths 20, 5, 8, 12, 25, 10, 30,
    15, 18, 7 seconds, back to back from 0 (the audio mixer's own timeline)."""
    lengths = [20, 5, 8, 12, 25, 10, 30, 15, 18, 7]
    scenes, t = [], 0.0
    for i, n in enumerate(lengths):
        scenes.append({"id": f"s{i:03d}", "index": i, "start_s": t, "end_s": t + n,
                       "narration": f"Scene {i} narration.", "asset_ids": []})
        t += n
    return {"version": 1, "scenes": scenes, "assets": [], "audio": {"duration_s": audio_s}}


def manifest_json(**kw) -> str:
    return json.dumps(manifest(**kw))


def seed(conn, sc) -> None:
    from sec_db import as_superuser

    for t in sc.tenants():
        with as_superuser(conn) as s:
            rid = s.value(
                "insert into public.repurpose_requests (org_id, channel_id, video_id, slug, clip_count, status, "
                "finished_at, error_code, idempotency_key, request_hash) values "
                "(%s, %s, %s, %s, 1, 'failed', now(), 'job_ended', %s, %s) returning id",
                [t.org, t.channel, t.video, f"seed-{t.key}", f"seed-key-{t.key}",
                 hashlib.md5(t.key.encode()).hexdigest()])
            s.rows(
                "insert into public.repurpose_clips (request_id, org_id, channel_id, master_id, ordinal, "
                "first_scene, last_scene, scene_ids, start_s, end_s, duration_s, status, finished_at, error_code) "
                "values (%s, %s, %s, %s, 1, 's000', 's001', '{s000,s001}', 0, 25, 25, 'failed', now(), "
                "'job_ended') returning 1",
                [rid, t.org, t.channel, t.video])
            REQUEST[t.key] = str(rid)
