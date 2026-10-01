"""Security-lab contract for migration 0057 (storyboard review).

Kept in its own module, like sec_folders_0049. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_storyboard_0057; sec_storyboard_0057.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_storyboard_0057.seed(conn, sc)

The seed writes each tenant's waiting storyboard the way production does: the
pipeline inserts it with the service key when a run stops at "Storyboard
ready". The named attacks are in test_sec_storyboards.py.
"""

from __future__ import annotations

import json
from typing import Dict

#: Per tenant key ('a' / 'b'): the id of its waiting storyboard.
STORYBOARD: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import HELPER, SERVICE, USER, Channel

    tables.update({
        # Members of the channel's organization read; nobody writes directly —
        # the pipeline (service key) inserts, the functions decide.
        "storyboards": Channel(),
    })
    functions.update({
        "approve_storyboard": USER,
        "discard_storyboard": USER,
        "storyboard_dispatch_failed": USER,
        "storyboard_lock_for_runner": SERVICE,
        # Pure bounds check behind the scenes CHECK; nothing to reveal.
        "storyboard_scenes_valid": HELPER,
    })


def scenes(n: int = 3, seconds: int = 100) -> list:
    return [{"n": i + 1, "name": f"Scene {i + 1}", "type": "story", "narration": f"Line {i + 1}.",
             "visual": "harbour at dawn", "duration_s": seconds} for i in range(n)]


def script(n: int = 3) -> dict:
    return {"topic": "t", "title": "T", "sections": [{"name": f"s{i}", "narration": f"Line {i}."} for i in range(n)]}


def insert(s, channel: str, slug: str, *, n: int = 3, seconds: int = 100, topic: str = "A topic"):
    """A storyboard as the pipeline writes it (service key)."""
    return s.run(
        "insert into public.storyboards (channel_id, slug, topic, title, scenes, script, duration_s) "
        "values (%s, %s, %s, 'A title', %s::jsonb, %s::jsonb, %s) returning id",
        [channel, slug, topic, json.dumps(scenes(n, seconds)), json.dumps(script(n)), n * seconds])


def seed(conn, sc) -> None:
    from sec_db import SERVICE as SERVICE_ACTOR, acting

    for t in sc.tenants():
        with acting(conn, SERVICE_ACTOR, commit=True) as s:
            out = insert(s, t.channel, f"plan-{t.key}")
            if not out.ok:
                raise AssertionError(f"seed failed: {out!r}")
            STORYBOARD[t.key] = str(out.rows[0][0])
