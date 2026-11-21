"""Security-lab contract for migration 0108 (the brand-channel poster: posts, settings, showcase assets).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_marketing_0108; sec_marketing_0108.extend(TABLES, FUNCTIONS)

Three tables, none writable by an API role, and one readable by a platform admin:

  marketing_posts     Platform: a platform admin may SELECT (one policy); nobody writes except the definer functions.
  marketing_settings  Service: the kill switch and the limits. owner_marketing_get() reads it, owner_marketing_kill()
                      and the SQL editor change it.
  showcase_assets     Service: closed, operator organization only. Its owner functions are a later change.

Every function is declared: the owner actions are USER (a signed-in caller; the function itself raises 42501 for anyone
who is not a platform owner/admin, which test_sec_marketing_posts.py proves), the worker's and the internal helpers are
SERVICE (no anon or authenticated EXECUTE; the worker functions are granted to service_role only, also proved there).
The named attacks and behaviours are in test_sec_marketing_posts.py.
"""

from __future__ import annotations

DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Platform, Service

    tables.update({
        "marketing_posts": Platform(),
        "marketing_settings": Service(),
        "showcase_assets": Service(),
    })

    functions.update({
        # the owner page's reads and actions (each checks platform owner/admin itself)
        "owner_marketing_get": USER,
        "owner_marketing_edit": USER,
        "owner_marketing_approve": USER,
        "owner_marketing_reject": USER,
        "owner_marketing_kill": USER,
        # the poster worker (service_role only)
        "marketing_draft_upsert": SERVICE,
        "claim_marketing_post": SERVICE,
        "complete_marketing_post": SERVICE,
        # internal: only the functions above (running as the owner) reach them
        "marketing_texts_ok": SERVICE,
        "marketing_post_hash": SERVICE,
        "marketing_cap_used": SERVICE,
    })


SEED_KEY = "news:scenario-seed"


def seed(conn, sc) -> None:
    """One draft post and one showcase asset of the operator's organization, written by the database owner, so the
    isolation tests have a row to aim at in the two tables that have nothing else in them. The draft counts toward
    nothing (the weekly count reads sending, sent and dead posts only), so the cap tests are not disturbed."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        s.rows(
            "insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) "
            "values (%s, 'news', %s::jsonb, 'pr:#1') returning 1",
            [SEED_KEY, '{"uz": "Uzbek seed text", "ru": "Russian seed text", "en": "English seed text"}'])
        s.rows(
            "insert into public.showcase_assets (org_id, source_video_ref, storage_path, marked_by) "
            "values (%s, 'vid-op', 'showcase/seed.mp4', %s) returning 1",
            [DEFAULT_ORG, sc.operator.uid])
