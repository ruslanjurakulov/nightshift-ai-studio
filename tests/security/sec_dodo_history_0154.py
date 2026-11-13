"""Security-lab contract for migration 0154 (the Credits page's Dodo purchase history).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_dodo_history_0154; sec_dodo_history_0154.extend(TABLES, FUNCTIONS)

No new table. One new function:

  dodo_purchase_history  USER (uuid, text): a signed-in owner or admin of the organization (it checks both itself); it returns that
                         organization's credited Dodo payments and nothing of any other. anon and the service key may not call it.
                         test_sec_dodo_purchase_history.py attacks it.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "dodo_purchase_history": USER,
    })
