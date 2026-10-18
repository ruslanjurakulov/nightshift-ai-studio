"""Security-lab contract for migration 0110 (promo and custom brand-channel posts, Telegram only).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_marketing_0110; sec_marketing_0110.extend(TABLES, FUNCTIONS)

No new table (marketing_posts keeps its 0108 contract, so there is nothing to seed in sec_scenario.py either) and two new
functions:

  owner_marketing_create       USER: a signed-in caller. The function itself raises 42501 for anyone who is not a platform
                               owner/admin, and the service key is not one; test_sec_marketing_promo.py proves it.
  marketing_draft_upsert_v2    SERVICE: EXECUTE for service_role only, none for anon or authenticated (also proved there).

The named attacks and behaviours are in test_sec_marketing_promo.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        "owner_marketing_create": USER,
        "marketing_draft_upsert_v2": SERVICE,
    })
