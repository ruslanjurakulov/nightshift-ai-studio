"""Security-lab contract for migration 0101 (private review links).

Hooked in like sec_friend_invites_0092:

  * sec_expectations.py, at the bottom:
        import sec_review_links_0101; sec_review_links_0101.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario():
        sec_review_links_0101.seed(conn, sc)

review_links and review_link_hits are declared Service(): the isolation tests
then prove that a customer, a stranger and the anon key read none of ANOTHER
tenant's row and cannot insert, update or delete any. The named attacks (a token
of org A against org B's objects, expiry, revoke, the storage policy) are in
test_sec_review_links.py.
"""

from __future__ import annotations

import hashlib

# One live token per tenant, known to the tests (64 lowercase hex).
TOKEN_A = "a1" * 32
TOKEN_B = "b2" * 32


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import PRICE_LIST, SERVICE, USER, Service

    tables.update({
        "review_links": Service(),
        "review_link_hits": Service(),
    })
    functions.update({
        # the owner (admin of the video's organization)
        "create_review_link": USER,
        "list_review_links": USER,
        "revoke_review_link": USER,
        # whoever holds the token, signed in or not
        "review_link_view": PRICE_LIST,
        "review_link_object": PRICE_LIST,
        "review_link_allows": PRICE_LIST,
        # internals: nobody calls these
        "review_link_token": SERVICE,
        "review_link_hash": SERVICE,
        "review_link_live": SERVICE,
    })


def seed(conn, sc) -> None:
    """Each tenant's video keeps a review copy (the object the scenario already
    stored in storage.objects) and has one live link, written by the database
    owner as only the functions may write them. Gives the isolation tests a row
    to aim at in both tables."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        for t, token in ((sc.alice, TOKEN_A), (sc.bob, TOKEN_B)):
            s.rows("update public.videos set preview_path = %s where video_id = %s returning 1",
                   [f"{t.channel}/slug-{t.key}.mp4", t.video])
            lid = s.value(
                "insert into public.review_links (org_id, channel_id, video_id, token_hash, created_by, expires_at) "
                "values (%s, %s, %s, %s, %s, now() + interval '7 days') returning id",
                [t.org, t.channel, t.video, token_hash(token), t.actor.uid])
            s.rows("insert into public.review_link_hits (link_id, minute, count) values (%s, date_trunc('minute', now()), 1) returning 1", [lid])
