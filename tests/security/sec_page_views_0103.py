"""Security-lab contract for migration 0103 (first-party page counts).

Hooked in like sec_user_handles_0096:

  * sec_expectations.py, at the bottom:
        import sec_page_views_0103; sec_page_views_0103.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario():
        sec_page_views_0103.seed(conn, sc)

site_page_views is declared Service(): the isolation tests then prove that a
customer, a stranger and the anon key read nothing from it and cannot insert,
update or delete a row. record_page_view is the one callable function (anon and
signed in alike, it counts public pages for whoever opens them);
site_page_path_ok is internal and callable by nobody.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import PRICE_LIST, SERVICE, Service

    tables.update({"site_page_views": Service()})
    functions.update({
        "record_page_view": PRICE_LIST,
        "site_page_path_ok": SERVICE,
    })


def seed(conn, sc) -> None:
    """One total, so the isolation tests' "a customer reads none of it" and their
    clone-a-row attacks have a row to aim at."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        s.rows(
            "insert into public.site_page_views (day, path, ref_host, device, lang, views) "
            "values (current_date, '/', '', 'desktop', 'en', 1) returning 1"
        )
