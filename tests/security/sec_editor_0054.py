"""Security-lab contract for migration 0054 (video editor projects and exports).

Kept in its own module, like sec_folders_0049. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_editor_0054; sec_editor_0054.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_editor_0054.seed(conn, sc)

The seed writes everything the way production does: each tenant's files
through register_asset() (the worker, service role), the project through
create_editor_project() and the export through request_editor_export(), in
the member's own session. The named attacks are in test_sec_editor_projects.py.
"""

from __future__ import annotations

import hashlib
from typing import Dict

#: Per tenant key ('a' / 'b'): ids the attacks aim at.
VIDEO: Dict[str, str] = {}
AUDIO: Dict[str, str] = {}
PROJECT: Dict[str, str] = {}
EXPORT: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # Members read; nobody inserts, updates or deletes directly — the
        # functions below are the only write path.
        "editor_projects": Org(),
        "editor_exports": Org(),
    })
    functions.update({
        "create_editor_project": USER,
        "save_editor_project": USER,
        "delete_editor_project": USER,
        "request_editor_export": USER,
        # The media worker's side.
        "claim_editor_export": SERVICE,
        "editor_export_heartbeat": SERVICE,
        "editor_export_assets": SERVICE,
        "finish_editor_export": SERVICE,
        # Internal: called only inside the functions above.
        "editor_clean_title": SERVICE,
        "editor_doc_problem": SERVICE,
        "editor_doc_duration": SERVICE,
    })


def _hex64(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def register(conn, org: str, label: str, kind: str = "video") -> str:
    """A library file the way the worker registers one."""
    from sec_db import SERVICE as SERVICE_ACTOR, acting

    mime = {"video": "video/mp4", "audio": "audio/mpeg", "image": "image/png"}[kind]
    with acting(conn, SERVICE_ACTOR, commit=True) as s:
        return str(s.value(
            "select public.register_asset(gen_random_uuid(), %s, %s, %s, 1000, %s, 'generated', "
            "p_duration_s => %s) ->> 'id'",
            [org, kind, mime, _hex64(f"editor-{label}"), None if kind == "image" else 20]))


def doc(video: str, *, audio: str | None = None, out_s: float = 8.0, speed: float = 1.0) -> dict:
    """A small timeline: one clip of `video` (trimmed, sped), a title, and
    music when `audio` is given."""
    tracks = [
        {"id": "v1", "kind": "V", "clips": [
            {"id": "c1", "asset_id": video, "start_s": 0, "in_s": 2, "out_s": out_s,
             "speed": speed, "audio": True}]},
        {"id": "t1", "kind": "T", "clips": [
            {"id": "x1", "start_s": 0, "end_s": 2, "text": "Hello {\\b1} 'quoted' ; [x]"}]},
    ]
    if audio:
        tracks.append({"id": "a1", "kind": "A", "clips": [
            {"id": "m1", "asset_id": audio, "start_s": 0, "in_s": 0, "out_s": 5}]})
    return {"version": 1, "width": 1920, "height": 1080, "fps": 30, "tracks": tracks}


def seed(conn, sc) -> None:
    import json

    from sec_db import acting

    for t in sc.tenants():
        k = t.key
        VIDEO[k] = register(conn, t.org, f"{k}-video")
        AUDIO[k] = register(conn, t.org, f"{k}-audio", "audio")
        with acting(conn, t.actor, commit=True) as s:
            PROJECT[k] = str(s.value("select public.create_editor_project(%s, %s, %s::jsonb)",
                                     [t.org, f"Edit {k.upper()}", json.dumps(doc(VIDEO[k], audio=AUDIO[k]))]))
            EXPORT[k] = str(s.value("select public.request_editor_export(%s, 1)", [PROJECT[k]]))
