"""Security-lab contract for migration 0047 (style kits and characters).

Kept in its own module, like sec_plans_0034. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_style_0047; sec_style_0047.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_style_0047.seed(conn, sc)

The seed writes everything the way production does: the reference images
through register_asset() (the worker, service role), the kits and characters
through save_style_kit() / save_character() in the member's own session, and
the channel's default kit through the channels update policy. The named
attacks are in test_sec_style_kits.py.
"""

from __future__ import annotations

import hashlib
from typing import Dict, List

#: Per tenant key ('a' / 'b'): ids the attacks aim at.
IMAGES: Dict[str, List[str]] = {}
VIDEO: Dict[str, str] = {}
KIT: Dict[str, str] = {}
CHARACTER: Dict[str, str] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # Members read; editors delete; nobody inserts or updates directly —
        # save_style_kit / save_character are the only write path.
        "style_kits": Org(),
        "characters": Org(),
        # Read-only to every API role; written only inside the save functions.
        "style_kit_references": Org(),
        "character_references": Org(),
    })
    functions.update({
        "save_style_kit": USER,
        "save_character": USER,
        "style_clean_text": SERVICE,
        "style_check_assets": SERVICE,
    })


def _hex64(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def register(conn, org: str, label: str, kind: str = "image") -> str:
    """A library asset the way the worker registers a generated file."""
    from sec_db import SERVICE as SERVICE_ACTOR, acting

    mime = "image/png" if kind == "image" else "video/mp4"
    with acting(conn, SERVICE_ACTOR, commit=True) as s:
        return str(s.value(
            "select public.register_asset(gen_random_uuid(), %s, %s, %s, 1000, %s, 'generated', "
            "p_width => 64, p_height => 64) ->> 'id'",
            [org, kind, mime, _hex64(f"style-{label}")]))


def seed(conn, sc) -> None:
    from sec_db import acting

    for t in sc.tenants():
        k = t.key
        IMAGES[k] = [register(conn, t.org, f"{k}-img-{i}") for i in range(5)]
        VIDEO[k] = register(conn, t.org, f"{k}-video", kind="video")
        with acting(conn, t.actor, commit=True) as s:
            KIT[k] = str(s.value(
                "select public.save_style_kit(%s, null, %s, 'warm film grain, soft daylight', %s::uuid[])",
                [t.org, f"Kit {k.upper()}", IMAGES[k][:3]]))
            CHARACTER[k] = str(s.value(
                "select public.save_character(%s, null, 'hero', 'character', 'red scarf, round glasses', %s::uuid[])",
                [t.org, IMAGES[k][:1]]))
        # The channel's default look, through the ordinary channels update policy.
        with acting(conn, t.actor, commit=True) as s:
            s.rows("update public.channels set default_style_kit_id = %s where channel_id = %s returning 1",
                   [KIT[k], t.channel])
