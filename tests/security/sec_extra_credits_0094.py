"""Security-lab contract for migration 0094 (extra credits switch, Usage page).

Hooked in at sec_expectations.py, next to the other migration hooks:
    import sec_extra_credits_0094; sec_extra_credits_0094.extend(TABLES, FUNCTIONS)

No new table: the switch is a column on credit_accounts, which keeps its
Org() isolation (a tenant reads its own row, nobody writes it directly).
The named attacks and regression pins are in test_sec_extra_credits.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        # the person who runs the workspace flips the switch (checks org_members itself)
        "set_use_extra_credits": USER,
        # the Usage page's read of the caller's own workspace (billing_may_read gate)
        "usage_summary": USER,
        # what a new hold may draw on under the switch: internal, nobody through the API
        "credit_spendable_internal": SERVICE,
    })
