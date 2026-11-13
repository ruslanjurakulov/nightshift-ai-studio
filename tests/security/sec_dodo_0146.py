"""Security-lab contract for migration 0146 (Dodo Payments next to Paddle).

0146 widens two tables' checks and adds two SECURITY DEFINER functions, the provider-aware twins of 0034's
upsert_subscription and grant_subscription_credits, plus the checkout nonces: one table no API role reads or writes
(Service()), the member function that issues a nonce (USER: it checks sign-in and owner/admin itself) and the webhook's
function that spends one (SERVICE). Wired in at the bottom of sec_expectations.py, like the other
per-migration files:

    import sec_dodo_0146; sec_dodo_0146.extend(TABLES, FUNCTIONS)

The attacks and the money path are in test_sec_dodo_payments.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        # One row per Dodo checkout opened; written and read only through the two functions below.
        "dodo_checkout_nonces": Service(),
    })
    functions.update({
        # an owner/admin opens a checkout (the Command Center, in the member's own session)
        "dodo_issue_checkout_nonce": USER,
        # the webhook spends a nonce once
        "dodo_consume_checkout_nonce": SERVICE,
        # the webhooks (service role): Paddle through 0034's names, Dodo through these
        "upsert_subscription_for": SERVICE,
        "grant_subscription_credits_for": SERVICE,
    })


def seed(conn, sc) -> None:
    """One checkout nonce per tenant, the way production writes one: the owner, in their own session, through
    dodo_issue_checkout_nonce (the isolation tests then prove nobody reads, inserts, updates or deletes these rows)."""
    from sec_db import acting

    for t in sc.tenants():
        with acting(conn, t.actor, commit=True) as s:
            out = s.run("select public.dodo_issue_checkout_nonce(%s, 'pack:starter')", [t.org])
        assert out.ok, out
