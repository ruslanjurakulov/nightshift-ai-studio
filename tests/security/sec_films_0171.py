"""Security-lab contract for migration 0171 (Film Studio P2: the film's price, its one credit hold, the worker's settle functions).

Kept in its own module, like sec_films_0166. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_films_0171; sec_films_0171.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after sec_films_0166.seed:
        sec_films_0171.seed(conn, sc)

The seed gives each tenant one settled (released) segment of its seeded draft, one stored quote and one settings row, written by the
database owner:
the shared lab has no priced models, so start_film cannot run there, and the isolation tests only need a row of each tenant to aim
at. Every money path is attacked in a scratch database of its own: test_sec_films_money.py.
"""

from __future__ import annotations

#: Per tenant key ('a' / 'b'): the seeded segment the isolation tests aim at.
SEGMENT: dict = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org, Service

    tables.update({
        # Members read (column grants, never the request hash or the worker); nobody inserts, updates or deletes directly.
        "film_segments": Org(),
        "org_film_settings": Org(),
        # No API role reads or writes these: quote_film answers both (the stored quote and the switch).
        "film_quotes": Service(),
        "film_studio_settings": Service(),
    })
    functions.update({
        # The browser's two calls: an editor quotes, an admin starts.
        "quote_film": USER,
        "start_film": USER,
        # The switch: a signed-in caller reaches it, and owner_guard refuses everyone but a platform owner/admin (42501).
        "set_film_studio_enabled": USER,
        # The worker's state machine: the service role only (no anon, no authenticated).
        "film_claim_segment": SERVICE,
        "film_heartbeat_segment": SERVICE,
        "film_begin_take": SERVICE,
        "film_take_succeeded": SERVICE,
        "film_take_failed": SERVICE,
        "film_begin_assembly": SERVICE,
        "film_record_assembly": SERVICE,
        "film_settle_segment": SERVICE,
        "film_cancel_segment": SERVICE,
        "film_expire_segments": SERVICE,
        # Internal: called only inside the functions above.
        "film_money_limits": SERVICE,
        "film_settings_of": SERVICE,
        "film_moderation_billing": SERVICE,
        "film_stand_in": SERVICE,
        "film_model_problem": SERVICE,
        "film_try_price": SERVICE,
        "film_price": SERVICE,
        "film_segment_json": SERVICE,
        "film_take_money_json": SERVICE,
        "film_settle_locked": SERVICE,
        "film_lock_segment": SERVICE,
        "film_lock_take": SERVICE,
        "film_studio_on": SERVICE,
        "film_available": SERVICE,
        "film_precheck": SERVICE,
        "film_fail_locked": SERVICE,
        "film_lose_inflight_locked": SERVICE,
        "film_discard_assets": SERVICE,
        "film_record_skip": SERVICE,
    })


def seed(conn, sc) -> None:
    import sec_films_0166
    from sec_db import as_superuser

    for t in sc.tenants():
        k = t.key
        with as_superuser(conn) as s:
            s.rows("insert into public.org_film_settings (org_id, max_credits_per_film, max_active_films) values (%s, 500, 1) "
                   "on conflict (org_id) do nothing returning 1", [t.org])
            SEGMENT[k] = str(s.value(
                "insert into public.film_segments (film_id, org_id, n, film_version, quote_id, status, confirmed_credits, "
                "captured_credits, assembly_minutes, assembly_unit_credits, assembly_confirmed_credits, assembly_status, "
                "assembly_charged_credits, settle_reason, idempotency_key, request_hash, settled_at) "
                "values (%s, %s, 1, 1, 'fq-1-' || md5(%s), 'released', 0, 0, 1, 0, 0, 'skipped', 0, 'cancelled', %s, md5(%s), now()) "
                "returning id",
                [sec_films_0166.FILM[k], t.org, f"seed-quote-{k}", f"seed-segment-{k}", f"seed-segment-{k}"]))
            # A stored quote of the seeded draft (version 2 after its save): the isolation tests aim at it.
            s.rows("insert into public.film_quotes (film_id, org_id, version, quote_id, total, expires_at) "
                   "values (%s, %s, 2, 'fq-2-' || md5(%s), 10, now() + interval '30 minutes') returning 1",
                   [sec_films_0166.FILM[k], t.org, f"seed-stored-quote-{k}"])
