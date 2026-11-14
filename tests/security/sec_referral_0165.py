"""Security-lab contract for migration 0165 (the referral programme: credits for a friend's first payment, after a hold).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_referral_0165; sec_referral_0165.extend(TABLES, FUNCTIONS)

Two new tables, closed to every API role (Service()): referral_rewards and referral_settle_runs, read only through the
functions below. The functions:

  claim_referral_rewards     USER: the caller's own referrals settled (under their link lock, rate-limited), then my_referrals().
  my_referrals               USER: the caller's own link and counts; never a friend's id, mailbox, workspace or payment.
  referral_terms             PRICE_LIST: the switch and the numbers, anon and signed in (the public /referral page).
  referral_admin             USER: a platform owner/admin only (it checks itself).
  set_referral_settings      USER: a platform owner/admin only, through owner_guard (second factor, rate limit).
  referral_settle_all        SERVICE: pg_cron and the service role; no browser.
  referral_settle_locked     SERVICE: internal, nobody calls it through the API (execute revoked from every API role).
  referral_payment_reversed  SERVICE: internal, the same.

The attacks and the money paths are in test_sec_referral_rewards.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import PRICE_LIST, SERVICE, USER, Service

    tables.update({
        "referral_rewards": Service(),
        # the settle job's log: written by referral_settle_all, read through referral_admin
        "referral_settle_runs": Service(),
    })
    functions.update({
        # internal: is a payment reversed (credit_refunds, or the provider's own event)
        "referral_payment_reversed": SERVICE,
        # the referrer, in their own session
        "claim_referral_rewards": USER,
        "my_referrals": USER,
        # the public terms page, signed in or out
        "referral_terms": PRICE_LIST,
        # the operator
        "referral_admin": USER,
        "set_referral_settings": USER,
        # the platform's hourly settle
        "referral_settle_all": SERVICE,
        # internal: nobody calls it
        "referral_settle_locked": SERVICE,
    })


def seed(conn, sc) -> None:
    """One referral row, so the isolation tests' positive control is not vacuous: Dana (who joined Alice's seeded link, 0092's
    seed) made a payment that is on hold. Written by the database owner, as only the functions write this table. No credits move:
    a held referral pays nothing, and the payment it names is a made-up id no ledger row carries."""
    import hashlib

    from sec_db import as_superuser

    with as_superuser(conn) as s:
        link = s.value("select id from public.friend_invite_links where user_id = %s", [sc.alice.actor.uid])
        s.rows(
            "insert into public.referral_rewards (invitee_id, invitee_email_key, referrer_id, link_id, org_id, invitee_org_id, "
            "purchase_external_id, purchase_kind, purchased_at, credits, status, release_at) "
            "values (%s, %s, %s, %s, %s, %s, 'seed-payment-0165', 'purchase', now(), 200, 'held', now() + interval '30 days') "
            "returning 1",
            [sc.dana.uid, hashlib.sha256(sc.dana.email.encode()).hexdigest(), sc.alice.actor.uid, link, sc.alice.org, sc.bob.org])
        s.rows("insert into public.referral_settle_runs (links, changed, failed) values (0, 0, 0) returning 1")
