"""Security-lab contract for migration 0232 (one storyboard plan per film, its turns reserved when it begins).

Wired in at the bottom of sec_expectations.py, like sec_ai_chat_plan_0211. The film lease table is closed (RLS on, an author-only
SELECT policy as a second wall, no grant): only ai_chat_film_plan_begin, ai_chat_reserve_turn and ai_chat_plan_end touch it. The two
helpers that add up what running plans hold are internal. Behaviour: tests/security/test_sec_film_lease_0232.py.

GUARD is the one list the tests, the drift-guard pins and sec_db's put_back_0232 read: each body 0232 replaces (the earlier md5, 0232's)
and each it relies on unchanged (the same md5 twice). Whitespace runs read as one space, the way the file's own guard reads them.
"""

from __future__ import annotations

#: (signature, the md5 0232 is written on, 0232's own md5: the same for a body it only relies on).
GUARD = (
    ("public.ai_chat_reserve_turn(uuid, text, boolean, text)", "e105fa9373fac86e9a36cf4a945a21b4", "51ecb8f5cd0226a0f89a3aa7571c605f"),
    ("public.ai_chat_plan_end(uuid, integer, text, text)", "4df6a1c4054bcacedf971a0b79f997d6", "71c2feb9b1b12295bef680822ab80c91"),
    ("public.ai_chat_quota(uuid)", "7c17f9749127303a53d039bbdc15e8c2", "09b69b04c1073ad8e79bbc8107e92f81"),
    ("public.ai_chat_plan_session(uuid)", "75c679292759d14dc51ba865f32d6f8e", "75c679292759d14dc51ba865f32d6f8e"),
    ("public.ai_chat_plan_begin(uuid, bigint, integer)", "2002d73eb60ad129f7318416ba560da6", "2002d73eb60ad129f7318416ba560da6"),
    ("public.ai_chat_plan_state(uuid)", "c2aede96712ab6d28dc6d29c060eb5f2", "c2aede96712ab6d28dc6d29c060eb5f2"),
)

#: The bodies 0232 replaces, by signature: {sig: 0232's md5}.
REPLACED = {sig: now_ for sig, was, now_ in GUARD if was != now_}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        "ai_chat_film_plan_leases": Service(),
    })
    functions.update({
        "ai_chat_film_plan_begin": USER,
        # What running film plans still hold, of a workspace and of a person, and until when; the most a film's plan may hold:
        # internal, read by ai_chat_quota, ai_chat_reserve_turn and ai_chat_film_plan_begin.
        "ai_chat_reserved": SERVICE,
        "ai_chat_reserved_until": SERVICE,
        "ai_chat_reserved_by": SERVICE,
        "ai_chat_film_plan_max_turns": SERVICE,
    })


def seed(conn, sc) -> None:
    """One finished film lease per tenant, on its seeded film (sec_films_0166) and conversation (sec_ai_chat_0199), so the isolation
    suite attacks real rows of the closed table. Finished, so it holds nothing. Written as the database owner: no API role can write
    it (the point of the attacks)."""
    from sec_db import as_superuser
    from sec_films_0166 import FILM

    with as_superuser(conn, commit=True) as s:
        for t in sc.tenants():
            s.rows("insert into public.ai_chat_film_plan_leases (film_id, org_id, session_id, created_by, attempt, reserved, taken, "
                   "released, state, expires_at, finished_at) values (%s, %s, %s, %s, 1, 1, 1, 0, 'done', now(), now()) "
                   "on conflict (film_id) do nothing returning 1",
                   [FILM[t.key], t.org, t.ai_chat_session, t.actor.uid])
