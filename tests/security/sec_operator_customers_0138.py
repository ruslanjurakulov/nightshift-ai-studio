"""Security-lab contract for migration 0138 (the operator's Customers page).

No table: 0138 adds three SECURITY DEFINER functions. Wired in at the bottom of sec_expectations.py, like the other
per-migration files:

    import sec_operator_customers_0138; sec_operator_customers_0138.extend(TABLES, FUNCTIONS)

A signed-in user may EXECUTE them (the Command Center reads them with the operator's own session, never the service key),
so USER here means "the function refuses everyone but a platform owner/admin itself" — test_sec_operator_customers.py is
the proof, with the arithmetic.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "operator_customer_totals": USER,
        "operator_customer_daily": USER,
        "operator_customer_accounts": USER,
    })
