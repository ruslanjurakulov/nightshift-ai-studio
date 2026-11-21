"""Security-lab contract for migration 0049 (media library folders).

Kept in its own module, like sec_style_0047. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_folders_0049; sec_folders_0049.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_folders_0049.seed(conn, sc)

The seed writes everything the way production does: each tenant's files
through register_asset() (the worker, service role), the folder through
save_media_folder() and the move through move_media_assets(), both in the
member's own session. The named attacks are in test_sec_media_folders.py.
"""

from __future__ import annotations

import hashlib
from typing import Dict, List

#: Per tenant key ('a' / 'b'): ids the attacks aim at.
FOLDER: Dict[str, str] = {}
#: Files in that folder.
FILED: Dict[str, List[str]] = {}
#: Files in no folder.
LOOSE: Dict[str, List[str]] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # Members read; nobody inserts, updates or deletes directly —
        # save_media_folder / delete_media_folder are the only write path.
        "media_folders": Org(),
    })
    functions.update({
        "save_media_folder": USER,
        "delete_media_folder": USER,
        "move_media_assets": USER,
        # Security invoker: counts only what RLS already lets the caller read.
        "media_folder_counts": USER,
        "media_folder_clean_name": SERVICE,
    })


def _hex64(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def register(conn, org: str, label: str) -> str:
    """A library file the way the worker registers a generated one."""
    from sec_db import SERVICE as SERVICE_ACTOR, acting

    with acting(conn, SERVICE_ACTOR, commit=True) as s:
        return str(s.value(
            "select public.register_asset(gen_random_uuid(), %s, 'image', 'image/png', 1000, %s, 'generated', "
            "p_width => 64, p_height => 64) ->> 'id'",
            [org, _hex64(f"folder-{label}")]))


def seed(conn, sc) -> None:
    from sec_db import acting

    for t in sc.tenants():
        k = t.key
        FILED[k] = [register(conn, t.org, f"{k}-filed-{i}") for i in range(2)]
        LOOSE[k] = [register(conn, t.org, f"{k}-loose-{i}") for i in range(2)]
        with acting(conn, t.actor, commit=True) as s:
            FOLDER[k] = str(s.value("select public.save_media_folder(%s, null, %s)", [t.org, f"Brand {k.upper()}"]))
            s.value("select public.move_media_assets(%s, %s, %s::uuid[])", [t.org, FOLDER[k], FILED[k]])
