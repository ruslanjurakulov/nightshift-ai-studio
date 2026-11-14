"""Security-lab contract for migration 0164 (the marketing site's live public counters, hidden behind a switch).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_public_stats_0164; sec_public_stats_0164.extend(TABLES, FUNCTIONS)

One new table:

  site_settings              Service: the switch (public_stats_visible, default false) and the last measurement. RLS on, no
                             policy, every grant revoked: no API role reads or writes it, the service key included.

Three new functions:

  public_site_stats          anon and authenticated: the site's read. Hidden, it answers {"visible": false} and nothing else;
                             visible, aggregate counts only. test_sec_public_stats.py proves both.
  set_public_stats_visible   USER: a signed-in platform owner/admin (owner_guard, 0107) or the SQL editor; everyone else 42501.
  public_site_stats_measure  SERVICE: internal, called by public_site_stats only.
"""

from __future__ import annotations

#: Anyone may call it, signed in or not: it hands out aggregates and checks the switch itself.
PUBLIC_READ = (True, True)


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({"site_settings": Service()})
    functions.update({
        "public_site_stats": PUBLIC_READ,
        "set_public_stats_visible": USER,
        "public_site_stats_measure": SERVICE,
    })
