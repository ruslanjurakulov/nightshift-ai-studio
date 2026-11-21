"""Security-lab contract for migration 0092 (Invite friends).

Hooked in at the bottom of sec_expectations.py:
    import sec_friend_invites_0092; sec_friend_invites_0092.extend(TABLES, FUNCTIONS)

The four tables are closed to every API role: a link's token, who joined and
who was paid are read only through the functions below, which the named
attacks are run against in test_sec_friend_invites.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import PRICE_LIST, SERVICE, USER, Service

    tables.update({
        "friend_invite_settings": Service(),
        "friend_invite_links": Service(),
        "friend_invite_joins": Service(),
        "friend_invite_rewards": Service(),
    })
    functions.update({
        # the owner
        "create_friend_invite": USER,
        "my_friend_invite": USER,
        "claim_friend_invite_reward": USER,
        # the new account, after its e-mail is confirmed
        "join_friend_invite": USER,
        # the signed-out landing page asks one boolean
        "friend_invite_peek": PRICE_LIST,
        # the operator
        "friend_invite_admin": USER,
        "set_friend_invite_settings": USER,
        # internals: nobody calls these
        "friend_invite_token": SERVICE,
        "friend_invite_mail_key": SERVICE,
        "friend_invite_pay_locked": SERVICE,
    })


def seed(conn, sc) -> None:
    """One row in every table, so the isolation tests' positive control is not
    vacuous: Alice and Bob each have a link, Dana joined Alice's (uncounted: she
    predates it), and a reward row exists for Bob. Written by the database
    owner, as only the functions may write them. No credits move: the lab's
    balances stay what the other tests expect. The named attacks (and every real
    outcome) are in test_sec_friend_invites.py, which uses fresh people."""
    import hashlib

    from sec_db import as_superuser

    def key(email: str) -> str:
        return hashlib.sha256(email.encode()).hexdigest()

    with as_superuser(conn) as s:
        la = s.value(
            "insert into public.friend_invite_links (user_id, org_id, token) values (%s, %s, %s) returning id",
            [sc.alice.actor.uid, sc.alice.org, "a1" * 16])
        lb = s.value(
            "insert into public.friend_invite_links (user_id, org_id, token) values (%s, %s, %s) returning id",
            [sc.bob.actor.uid, sc.bob.org, "b2" * 16])
        s.rows(
            "insert into public.friend_invite_joins (link_id, invitee_id, email_key, counted) "
            "values (%s, %s, %s, false) returning 1", [la, sc.dana.uid, key(sc.dana.email)])
        s.rows(
            "insert into public.friend_invite_rewards (user_id, link_id, org_id, credits, joins) "
            "values (%s, %s, %s, 100, 5) returning 1", [sc.bob.actor.uid, lb, sc.bob.org])
