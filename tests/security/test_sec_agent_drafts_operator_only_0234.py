"""Migration 0234: the Agent Builder draft functions serve platform operators only, attacked in a real database.

The finding (Breach, PR #960): any authenticated non-admin called save_agent_workflow_draft and delete_agent_workflow_draft (0130)
straight through PostgREST with the browser key, whatever the web gate said. What would break without these, finding by finding:

  a customer (an organization owner who is not a platform admin) saves or deletes        test_a_customer_*
  the check lets a call through when is_platform_admin() errors or answers NULL          test_the_check_fails_closed_*
  the check moved in front of sign-in (not_authenticated no longer the first answer)      test_no_sign_in_is_still_not_authenticated
  the platform operator can no longer save or delete (a revoke instead of a check)        test_the_operator_*
  the grants changed (0234 only restricts the bodies)                                    test_the_grants_are_0130s
  0234 lands on a body nobody read, or its rollback / replay drifts                       test_drift_guard_*, test_rollback_*

Every test runs in a transaction that is rolled back: the lab database keeps 0234 applied.
"""

from __future__ import annotations

import json
import uuid

import psycopg
import pytest
from psycopg import sql

import sec_db
from sec_agent_drafts_0130 import DOCUMENT, SAVE
from sec_db import as_superuser

DELETE = "select public.delete_agent_workflow_draft(%s)"
SAVE_SIG = "public.save_agent_workflow_draft(uuid, integer, jsonb)"
DELETE_SIG = "public.delete_agent_workflow_draft(uuid)"
#: 0230's fingerprint (comments cut, then white space folded), the one 0234's guards compare.
FP = ("select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) "
      "from pg_proc where oid = to_regprocedure(%s)")
CUT = {SAVE_SIG: ("c5175b042a9118080b0d4f12906c202d", "a95607774a410e65ccdefb1989557946"),
       DELETE_SIG: ("7b72f3679d8e9de439d753738f8b66bc", "5a506ee8e5b1fd93419b2fce831e3093")}


def _migration() -> str:
    return sec_db.MIGRATION_0234.read_text(encoding="utf-8")


def _as(s, who) -> None:
    """Switch the open transaction to `who`, the way PostgREST would serve them."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))


def _owner(s) -> None:
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def _save(s, draft_id=None, version=None):
    return s.run(SAVE, [draft_id, version, json.dumps(DOCUMENT)])


def _refused_operator_only(out):
    assert not out.ok and out.sqlstate == "42501" and out.error == "operator_only", out


def _plans(s, uid) -> int:
    return s.value("select count(*) from public.agent_workflow_drafts where owner_id = %s", [uid])


# ── the finding ─────────────────────────────────────────────────────────────

def test_the_lab_database_has_0234(conn):
    with as_superuser(conn, commit=False) as s:
        assert sec_db.has_0234(s)
        for sig, (_, new) in CUT.items():
            assert s.value(FP, [sig]) == new, sig


@pytest.mark.parametrize("who", ["alice", "bob", "stranger"])
def test_a_customer_cannot_save_a_plan(conn, sc, who):
    actor = sc.stranger if who == "stranger" else getattr(sc, who).actor
    with as_superuser(conn, commit=False) as s:
        before = _plans(s, actor.uid)
        _as(s, actor)
        _refused_operator_only(_save(s))  # a new plan
        if who != "stranger":
            _refused_operator_only(_save(s, getattr(sc, who).agent_draft, 2))  # a new version of their own, older plan
        _owner(s)
        assert _plans(s, actor.uid) == before
        if who != "stranger":
            assert s.value("select current_version from public.agent_workflow_drafts where id = %s", [getattr(sc, who).agent_draft]) == 2


def test_a_customer_cannot_delete_even_their_own_plan(conn, sc):
    with as_superuser(conn, commit=False) as s:
        _as(s, sc.alice.actor)
        _refused_operator_only(s.run(DELETE, [sc.alice.agent_draft]))
        _refused_operator_only(s.run(DELETE, [str(uuid.uuid4())]))  # a made-up id answers the same: nothing to probe
        # They still read what they saved before 0234 (0130's owner-only SELECT is untouched).
        assert s.value("select count(*) from public.agent_workflow_drafts where id = %s", [sc.alice.agent_draft]) == 1
        _owner(s)
        assert s.value("select count(*) from public.agent_workflow_draft_versions where draft_id = %s", [sc.alice.agent_draft]) == 2


def test_a_member_of_the_operators_own_organization_is_refused(conn, sc):
    # Dana is a member of the operator's own default organization: being in the operator's workspace is not being the operator.
    with as_superuser(conn, commit=False) as s:
        _as(s, sc.dana)
        _refused_operator_only(_save(s))


def test_no_sign_in_is_still_not_authenticated(conn):
    nobody = sec_db.Actor("nobody", "authenticated")
    with as_superuser(conn, commit=False) as s:
        _as(s, nobody)
        for out in (_save(s), s.run(DELETE, [str(uuid.uuid4())])):
            assert not out.ok and out.sqlstate == "42501" and out.error == "not_authenticated", out


@pytest.mark.parametrize("who", [sec_db.ANON, sec_db.SERVICE], ids=["anon", "service_role"])
def test_the_anon_key_and_the_service_role_still_call_neither(conn, who):
    with as_superuser(conn, commit=False) as s:
        _as(s, who)
        for out in (_save(s), s.run(DELETE, [str(uuid.uuid4())])):
            assert not out.ok and out.sqlstate == "42501" and "permission denied" in out.error, out


# ── the operator ────────────────────────────────────────────────────────────

def test_the_operator_saves_versions_and_deletes(conn, sc):
    with as_superuser(conn, commit=False) as s:
        _as(s, sc.operator)
        out = _save(s)
        assert out.ok, out
        draft_id, version = str(out.rows[0][0]), out.rows[0][1]
        assert version == 1
        second = _save(s, draft_id, 1)
        assert second.ok and second.rows[0][1] == 2, second
        assert s.run(DELETE, [draft_id]).ok
        assert s.value("select count(*) from public.agent_workflow_drafts where id = %s", [draft_id]) == 0


def test_the_operator_still_meets_0130s_own_guards(conn, sc):
    # 0234's check comes before 0130's; it does not replace them. Another person's plan is still missing for the operator.
    with as_superuser(conn, commit=False) as s:
        _as(s, sc.operator)
        out = _save(s, sc.alice.agent_draft, 2)
        assert not out.ok and out.sqlstate == "P0002" and out.error == "draft_not_found", out
        out = s.run(DELETE, [sc.alice.agent_draft])
        assert not out.ok and out.sqlstate == "P0002", out
        out = s.run(SAVE, [None, None, json.dumps({"format": "x"})])
        assert not out.ok and out.sqlstate == "22023" and out.error == "invalid_agent_draft", out


# ── fail closed ─────────────────────────────────────────────────────────────

def test_the_check_fails_closed_when_is_platform_admin_errors(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("create or replace function public.is_platform_admin() returns boolean language plpgsql stable "
                       "security definer set search_path = public as $$ begin raise exception 'lookup down'; end $$")
        _as(s, sc.operator)
        for out in (_save(s), s.run(DELETE, [str(uuid.uuid4())])):
            assert not out.ok and out.error == "lookup down", out
        _owner(s)
        assert _plans(s, sc.operator.uid) == 0


def test_the_check_fails_closed_when_is_platform_admin_answers_null(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("create or replace function public.is_platform_admin() returns boolean language sql stable "
                       "security definer set search_path = public as $$ select null::boolean $$")
        _as(s, sc.operator)
        _refused_operator_only(_save(s))
        _refused_operator_only(s.run(DELETE, [str(uuid.uuid4())]))


# ── grants ──────────────────────────────────────────────────────────────────

def test_the_grants_are_0130s(conn):
    with as_superuser(conn, commit=False) as s:
        for sig in (SAVE_SIG, DELETE_SIG):
            assert s.value("select has_function_privilege('authenticated', %s, 'EXECUTE')", [sig]), sig
            for role in ("anon", "service_role", "public"):
                if role == "public":
                    assert not s.value("select exists (select 1 from pg_proc p, aclexplode(p.proacl) a "
                                       "where p.oid = to_regprocedure(%s) and a.grantee = 0)", [sig]), sig
                else:
                    assert not s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, sig]), (role, sig)
            grantees = {r[0] for r in s.rows("select a.grantee::regrole::text from pg_proc p, aclexplode(p.proacl) a "
                                              "where p.oid = to_regprocedure(%s)", [sig])}
            owner = s.value("select proowner::regrole::text from pg_proc where oid = to_regprocedure(%s)", [sig])
            assert grantees == {owner, "authenticated"}, (sig, grantees)
            assert s.value("select prosecdef and proconfig = array['search_path=\"\"'] from pg_proc where oid = to_regprocedure(%s)", [sig])


def test_the_grants_survive_the_rollback_and_a_replay_byte_for_byte(conn):
    acl = "select proacl::text from pg_proc where oid = to_regprocedure(%s)"
    with as_superuser(conn, commit=False) as s:
        before = [s.value(acl, [sig]) for sig in (SAVE_SIG, DELETE_SIG)]
        s.conn.execute(sec_db.rollback_0234_body())
        assert [s.value(acl, [sig]) for sig in (SAVE_SIG, DELETE_SIG)] == before
        s.conn.execute(_migration())
        assert [s.value(acl, [sig]) for sig in (SAVE_SIG, DELETE_SIG)] == before


# ── drift guard, rollback, replay ───────────────────────────────────────────

def _tamper(s, sig: str) -> None:
    body = s.value("select pg_get_functiondef(to_regprocedure(%s))", [sig])
    s.conn.execute(body.replace("raise exception 'operator_only'", "raise notice 'operator_only'"))


@pytest.mark.parametrize("sig", [SAVE_SIG, DELETE_SIG], ids=["save", "delete"])
def test_drift_guard_refuses_a_tampered_body(conn, sig):
    with as_superuser(conn, commit=False) as s:
        _tamper(s, sig)
        assert s.value(FP, [sig]) not in CUT[sig]
        out = s.run(_migration())
        name = sig.split("(")[0].removeprefix("public.")
        assert not out.ok and f"0234 found a {name}() that is neither 0130's body nor 0234's" in out.error, out
        # The rollback refuses it too: it would undo a change nobody read.
        out = s.run(sec_db.rollback_0234_body())
        assert not out.ok and f"rollback 0234: {name}() is neither 0234's body nor 0130's" in out.error, out


def test_a_check_swallowed_by_its_comment_reads_as_0130s_body_and_a_replay_puts_the_check_back(conn, sc):
    # The check folded onto the comment line above it: no check is left. A fold-only md5 would read that as 0234's body (and an
    # idempotent replay would keep it); 0230's fingerprint cuts comments first, so it reads as 0130's and the replay rewrites it.
    fold = "select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)"
    with as_superuser(conn, commit=False) as s:
        src = s.value("select prosrc from pg_proc where oid = to_regprocedure(%s)", [DELETE_SIG])
        start = src.index("  -- 0234: operators only")
        end = src.index("  -- The versions go with it")
        planted = src[:start] + " ".join(src[start:end].split()) + "\n" + src[end:]
        s.conn.execute("create or replace function public.delete_agent_workflow_draft(p_draft_id uuid) returns void "
                       "language plpgsql security definer set search_path = '' as $body$" + planted + "$body$")
        assert s.value(FP, [DELETE_SIG]) == CUT[DELETE_SIG][0]          # comments cut: 0130's body, no check
        assert s.value(fold, [DELETE_SIG]) == sec_db.AGENT_DELETE_0234  # folding alone cannot tell it from 0234's (BR-S6-05)
        _as(s, sc.alice.actor)
        assert s.run(DELETE, [str(uuid.uuid4())]).error == "draft_not_found"  # the swallowed check let a customer through
        _owner(s)
        s.conn.execute(_migration())
        assert s.value(FP, [DELETE_SIG]) == CUT[DELETE_SIG][1]
        _as(s, sc.alice.actor)
        _refused_operator_only(s.run(DELETE, [str(uuid.uuid4())]))


def test_drift_guard_refuses_without_is_platform_admin(conn):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(sec_db.rollback_0234_body())
        s.conn.execute("alter function public.is_platform_admin() rename to is_platform_admin_gone")
        out = s.run(_migration())
        assert not out.ok and "0234 needs 0130" in out.error, out


def test_rollback_reopens_the_finding_and_a_replay_closes_it_again(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(sec_db.rollback_0234_body())
        for sig, (old, _) in CUT.items():
            assert s.value(FP, [sig]) == old, sig
        _as(s, sc.alice.actor)
        assert _save(s).ok  # 0130's bodies: a customer saves again (the finding is back)
        _owner(s)
        s.conn.execute(_migration())
        assert sec_db.has_0234(s)
        _as(s, sc.alice.actor)
        _refused_operator_only(_save(s))


def test_a_second_run_is_accepted_and_changes_nothing(conn):
    with as_superuser(conn, commit=False) as s:
        before = [s.value(FP, [sig]) for sig in (SAVE_SIG, DELETE_SIG)]
        s.conn.execute(_migration())
        assert [s.value(FP, [sig]) for sig in (SAVE_SIG, DELETE_SIG)] == before
