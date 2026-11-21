"""Breach: attacks on audit_account_switch (migration 0204, PR #859), in the lab database.

Complements test_sec_account_switch_audit.py (Forge's). What these pin, each an attack that is refused today:
- anon carrying a forged `sub` claim cannot write a row (no EXECUTE, whatever the claims say);
- the service role has no auth.uid() and cannot write an anonymous "switch" row;
- the 60-an-hour limit holds against a loop (the 61st call writes nothing), and one person's loop does not spend another's;
- the definer function did not widen audit_action_allowed() to the browser roles, and app_audit_log is still not
  writable directly with this action by a member.

Noted, not a hole (see the report): `p_from` is whatever the caller says. A member can write up to 60 rows an hour that
claim "switched here from <any uuid>". The row's `from` is a claim, never a verified fact.
"""

from __future__ import annotations

import json

from sec_db import ANON, SERVICE, Actor, acting, as_superuser


def _count(conn, uid):
    conn.execute("reset role")
    with as_superuser(conn, commit=False) as s:
        return s.value(
            "select count(*) from public.app_audit_log where action = 'account.switch' and actor_user_id = %s", [uid]
        )


def test_anon_with_a_forged_sub_claim_is_refused(conn, sc):
    forged = Actor("anon-forged", "anon", sc.alice.actor.uid, sc.alice.actor.email)
    with acting(conn, forged) as s:
        out = s.run("select public.audit_account_switch(%s::uuid)", [sc.bob.actor.uid])
        assert not out.ok and out.sqlstate == "42501", out


def test_service_role_cannot_write_an_unattributed_switch(conn):
    with acting(conn, SERVICE) as s:
        out = s.run("select public.audit_account_switch(null)")
        assert not out.ok and out.sqlstate == "42501", out


def test_the_hourly_limit_holds_against_a_loop_and_is_per_person(conn, sc):
    a, b = sc.alice.actor, sc.bob.actor
    with conn.transaction(force_rollback=True):
        with acting(conn, a, commit=True) as s:
            results = [s.run("select public.audit_account_switch(%s::uuid)", [b.uid]) for _ in range(61)]
        assert all(r.ok for r in results[:60]), [r for r in results[:60] if not r.ok][:1]
        assert not results[60].ok and results[60].sqlstate == "54000", results[60]
        assert _count(conn, a.uid) == 60
        # Alice's loop spent only Alice's budget.
        with acting(conn, b, commit=True) as s:
            assert s.run("select public.audit_account_switch(%s::uuid)", [a.uid]).ok
        assert _count(conn, b.uid) == 1


def test_the_browser_roles_still_cannot_call_audit_action_allowed_or_the_stamp(conn):
    with as_superuser(conn, commit=False) as s:
        for role in ("anon", "authenticated"):
            assert s.value(f"select has_function_privilege('{role}', 'public.audit_action_allowed(text)', 'execute')") is False
            assert s.value(f"select has_function_privilege('{role}', 'public.app_audit_log_stamp()', 'execute')") is False


def test_detail_cannot_be_widened_through_the_argument(conn, sc):
    """The only argument is a uuid: no text, no json reaches the row."""
    a = sc.alice.actor
    with acting(conn, a) as s:
        out = s.run("select public.audit_account_switch(%s::uuid)", ["x'); delete from app_audit_log; --"])
        assert not out.ok and out.sqlstate == "22P02", out
        out = s.run("select public.audit_account_switch(%s::jsonb)", [json.dumps({"from": "x", "rt": "secret"})])
        assert not out.ok, out
