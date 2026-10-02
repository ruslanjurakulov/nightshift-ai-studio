"""Security-lab contract for migration 0076 (scene regeneration v2).

Kept in its own module, like sec_storyboard_0057. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_scene_regen_0076; sec_scene_regen_0076.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_scene_regen_0076.seed(conn, sc)

The seed writes one ENDED regeneration per tenant (so the isolation tests have
a row of each organization to try to read, change, move and delete) the way
only the database owner could: production writes these rows through
request_scene_regenerate, which test_sec_scene_regenerate.py attacks.
"""

from __future__ import annotations

import hashlib
import json
from typing import Dict

#: Per tenant key ('a' / 'b'): the id of its seeded (ended) regeneration.
REGENERATION: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Channel, Service

    tables.update({
        # Members of the channel's organization read; nobody writes directly.
        "scene_regenerations": Channel(),
        # 0085: the worker's own text for a failed regeneration. No API role.
        "scene_regeneration_details": Service(),
    })
    functions.update({
        # Each checks who the caller is itself: quote = may read the video,
        # request = admin of the channel's organization (the Run now rule).
        "quote_scene_regenerate": USER,
        "request_scene_regenerate": USER,
        # The worker's (service key) and internal helpers: no API role.
        "start_scene_regeneration": SERVICE,
        "finish_scene_regeneration": SERVICE,
        "expire_scene_regenerations": SERVICE,
        # 0085: what the worker settles from its disk before the sweep.
        "scene_regenerations_unsettled": SERVICE,
        "scene_regen_plan": SERVICE,
        "scene_regen_price": SERVICE,
        "scene_regen_published": SERVICE,
    })


def held_id(channel: str, slug: str) -> str:
    """modules/held_video.held_video_id: a run that has not uploaded."""
    return "run-" + hashlib.sha256(f"{channel}\n{slug}".encode()).hexdigest()[:20]


def manifest(*, provider="kling", model="kling-v2-6", stock_provider="pexels") -> dict:
    """A Video IR with three scenes: s000 a generated clip, s001 two stock
    clips, s002 a generated clip whose generator was not recorded."""
    return {
        "version": 1,
        "scenes": [
            {"id": "s000", "index": 0, "start_s": 0.0, "end_s": 6.0, "asset_ids": ["a_gen0"]},
            {"id": "s001", "index": 1, "start_s": 6.0, "end_s": 14.0, "asset_ids": ["a_stk1", "a_stk2"]},
            {"id": "s002", "index": 2, "start_s": 14.0, "end_s": 20.0, "asset_ids": ["a_gen2"]},
        ],
        "assets": [
            {"id": "a_gen0", "kind": "video", "source": "generated", "provider": provider, "model": model},
            {"id": "a_stk1", "kind": "video", "source": "stock", "provider": stock_provider},
            {"id": "a_stk2", "kind": "image", "source": "stock", "provider": stock_provider},
            {"id": "a_gen2", "kind": "video", "source": "generated", "provider": None, "model": None},
        ],
    }


def seed(conn, sc) -> None:
    from sec_db import as_superuser

    for t in sc.tenants():
        with as_superuser(conn) as s:
            rid = s.value(
                "insert into public.scene_regenerations (org_id, channel_id, video_id, slug, scene_id, "
                "requested_source, source_kind, stock_assets, previous_asset_ids, status, finished_at, "
                "error_code, idempotency_key, request_hash) values "
                "(%s, %s, %s, %s, 's001', 'same', 'stock', 2, '{a_stk1,a_stk2}', 'failed', now(), "
                "'job_ended', %s, %s) returning id",
                [t.org, t.channel, t.video, f"seed-{t.key}", f"seed-key-{t.key}",
                 hashlib.md5(t.key.encode()).hexdigest()])
            REGENERATION[t.key] = str(rid)
            # 0085: the worker's own text for it (a service-only table).
            s.rows("insert into public.scene_regeneration_details (regeneration_id, detail) values (%s, %s) "
                   "returning 1", [rid, f"seed detail {t.key}"])


def manifest_json(**kw) -> str:
    return json.dumps(manifest(**kw))
