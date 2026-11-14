"""Security-lab contract for migration 0166 (Film Studio P1: films, their storyboard, references, takes and audit trail).

Kept in its own module, like sec_workflows_0073. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_films_0166; sec_films_0166.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_films_0166.seed(conn, sc)

The seed writes what production writes: each tenant's draft through create_film_draft() and its storyboard through save_film(), in
the member's own session. A take is written by the database owner, because nothing in 0166 writes takes (the orchestrator of a later
migration does), and the isolation tests need a row of each tenant to aim at. The named attacks, which commit, run in a scratch
database of their own: test_sec_films_core.py.
"""

from __future__ import annotations

import json
from typing import Dict

#: Per tenant key ('a' / 'b'): the ids the isolation tests aim at.
FILM: Dict[str, str] = {}
SCENE: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # Members read; nobody inserts, updates or deletes directly, the service key included: the functions are the only write path.
        "films": Org(),
        "film_scenes": Org(),
        "film_refs": Org(),
        "film_takes": Org(),
        "film_events": Org(),
    })
    functions.update({
        "create_film_draft": USER,
        "save_film": USER,
        "archive_film": USER,
        "film_json": USER,
        # Internal: called only inside the four above.
        "film_clean_text": SERVICE,
        "film_text_ok": SERVICE,
        "film_limits": SERVICE,
        "film_is_editable": SERVICE,
        "film_log": SERVICE,
        "film_uuid": SERVICE,
        "film_text": SERVICE,
        "film_asset_live": SERVICE,
        "film_check_asset": SERVICE,
        "film_check_model": SERVICE,
        "film_apply_settings": SERVICE,
        "film_save_refs": SERVICE,
        "film_save_scenes": SERVICE,
        "film_check_storyboard": SERVICE,
        "film_read": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import acting, as_superuser

    for t in sc.tenants():
        k = t.key
        with acting(conn, t.actor, commit=True) as s:
            film = s.value(
                "select public.create_film_draft(%s, %s, 'topic', %s, %s::jsonb, %s)",
                [t.org, t.channel, f"A film of tenant {k}",
                 json.dumps({"title": f"Film {k.upper()}", "language": "en", "target_seconds": 180}), f"seed-film-{k}"])
            FILM[k] = film["film"]["id"]
            saved = s.value(
                "select public.save_film(%s, 1, %s::jsonb)",
                [FILM[k], json.dumps({
                    "refs": [{"kind": "style", "asset_id": t.media_asset}],
                    "scenes": [{"title": "Open", "narration": "It begins.", "planned_seconds": 12},
                               {"title": "Close", "narration": "It ends.", "planned_seconds": 8, "first_frame": "previous"}]})])
            SCENE[k] = saved["scenes"][0]["id"]
        with as_superuser(conn) as s:
            s.rows("insert into public.film_takes (film_id, org_id, scene_id, version, shot_index, kind, status) "
                   "values (%s, %s, %s, 1, 0, 'keyframe', 'planned') returning 1", [FILM[k], t.org, SCENE[k]])
