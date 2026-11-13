"""Security-lab contract for migration 0144 (Dodo Payments next to Paddle).

No table: 0144 widens two tables' checks and adds two SECURITY DEFINER functions, the provider-aware twins of 0034's
upsert_subscription and grant_subscription_credits. Wired in at the bottom of sec_expectations.py, like the other
per-migration files:

    import sec_dodo_0144; sec_dodo_0144.extend(TABLES, FUNCTIONS)

The attacks and the money path are in test_sec_dodo_payments.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        # the webhooks (service role): Paddle through 0034's names, Dodo through these
        "upsert_subscription_for": SERVICE,
        "grant_subscription_credits_for": SERVICE,
    })
