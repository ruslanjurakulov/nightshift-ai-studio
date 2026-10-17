"""Migration 0107 (owner safety): the second-factor gate in the database, the audited owner
actions, and the security trail. Everything ships DORMANT, so most of this file pins two things:

  * with the gate OFF (the default, and the live state after the merge) nothing about an existing
    path moves, and the new functions are limited only by "platform owner/admin", their caps and
    their audit;
  * with the gate ON an account that HAS a verified factor needs a fresh aal2 token for the owner
    functions, and an account that has none is never blocked (the lockout rule).

Each test runs in a transaction that is rolled back, as one caller (``Tx.as_``), with the JWT claims
PostgREST would hand the database: ``aal`` and ``amr`` included. The two lock tests use a second
connection that holds a lock without committing anything.
"""

from __future__ import annotations

import json
import re
import time
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from sec_db import ANON, SERVICE, REPO, Session, as_superuser

MIGRATION = REPO / "supabase" / "migrations" / "0107_owner_safety.sql"
GOOD = "A reason that is long enough"

OWNER_FUNCTIONS = {  # name -> a call with harmless arguments
    "owner_security_get": "select public.owner_security_get()",
    "owner_security_events": "select public.owner_security_events(5)",
    "enable_admin_mfa": "select public.enable_admin_mfa()",
    "disable_admin_mfa": "select public.disable_admin_mfa()",
    "owner_grant_credits": "select public.owner_grant_credits('{org}', 10, 'A reason that is long enough', 'key-attack-0001')",
    "owner_reverse_grant": "select public.owner_reverse_grant(1, 'A reason that is long enough')",
    "owner_set_credit_price": "select public.owner_set_credit_price('attack_unit', 1, 0)",
    "owner_delete_credit_price": "select public.owner_delete_credit_price('attack_unit', null, true)",
    "owner_restore_credit_price": "select public.owner_restore_credit_price(1)",
    "owner_add_member": "select public.owner_add_member('evil@x.test', 'owner')",
    "owner_set_member_role": "select public.owner_set_member_role(gen_random_uuid(), 'owner')",
    "owner_remove_member": "select public.owner_remove_member(gen_random_uuid())",
}
INTERNAL = {
    "admin_mfa_state": "boolean", "owner_guard": "text, integer", "owner_admin_factors": "",
    "owner_audit": "text, text, jsonb, text", "security_event_log": "text, text, text, jsonb",
    "owner_err": "text, text, jsonb",
    "owner_price_write": "text, numeric, numeric, text, boolean, boolean, text, text, boolean, bigint",
}


# ── plumbing ────────────────────────────────────────────────────────────────

def now() -> int:
    return int(time.time())


def claims_for(who, aal=None, amr=None, drop_aal=False) -> dict:
    c = who.claims()
    if not drop_aal:
        c["aal"] = aal or "aal1"
    if amr is not None:
        c["amr"] = amr
    return c


def aal2(minutes_ago: float = 1) -> dict:
    """Claims of a session that typed its authenticator code `minutes_ago` minutes ago."""
    return {"aal": "aal2", "amr": [{"method": "password", "timestamp": now() - 3600 * 12},
                                    {"method": "totp", "timestamp": now() - int(minutes_ago * 60)}]}


class Tx:
    """One rolled-back transaction in which the caller can change identity."""

    def __init__(self, conn):
        self.conn = conn
        self.s = Session(conn)

    def sup(self, query, params=None):
        self.conn.execute("reset role")
        return self.s.rows(query, params)

    def trusted(self, query, params=None):
        """The platform itself (the SQL editor, the service key's functions): no API claims at all."""
        self.conn.execute("reset role")
        self.conn.execute("select set_config('request.jwt.claims', '', true)")
        return self.s.rows(query, params)

    def as_(self, who, extra=None, **kw):
        self.conn.execute("reset role")
        c = claims_for(who, **kw)
        c.update(extra or {})
        self.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(c)])
        self.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
        return self.s

    def claims_only(self, who, extra=None, **kw):
        """The caller's claims, but the database owner's privileges: for reading internal helpers."""
        self.conn.execute("reset role")
        c = claims_for(who, **kw)
        c.update(extra or {})
        self.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(c)])
        return self.s

    def anon(self):
        self.conn.execute("reset role")
        self.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(ANON.claims())])
        self.conn.execute("set local role anon")
        return self.s


@contextmanager
def tx(conn):
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', '', true)")
        yield Tx(conn)
        conn.execute("reset role")


def gate_on(t: Tx):
    t.sup("update public.owner_security_settings set admin_aal2_required = true returning 1")


def factors(t: Tx, who, n=1, status="verified"):
    for _ in range(n):
        t.sup("insert into auth.mfa_factors (user_id, status) values (%s, %s) returning 1", [who.uid, status])


def set_caps(t: Tx, **kw):
    for k, v in kw.items():
        t.sup(sql.SQL("update public.owner_security_settings set {} = %s returning 1").format(sql.Identifier(k)), [v])


def grant(s, org, credits=10, key="key-0000-0001", reason=GOOD):
    return s.value("select public.owner_grant_credits(%s, %s, %s, %s)", [org, credits, reason, key])


def balance(t: Tx, org) -> Decimal:
    return t.sup("select balance from public.credit_accounts where org_id = %s", [org])[0][0]


def events(t: Tx, kind_like="%", target=None):
    rows = t.sup("select kind, severity, actor_user_id, actor_email, target, detail from public.security_events "
                 "where kind like %s and (%s::text is null or target = %s) order by id", [kind_like, target, target])
    return [(r[0], r[1], None if r[2] is None else str(r[2]), *r[3:]) for r in rows]


def audits(t: Tx, action):
    rows = t.sup("select action, actor_user_id, actor_email, target, detail from public.app_audit_log "
                 "where action = %s order by at, id", [action])
    return [(r[0], None if r[1] is None else str(r[1]), *r[2:]) for r in rows]


def err_code(out):
    return out.sqlstate if not out.ok else None


@pytest.fixture
def admin(sc):
    return sc.operator


# ── who may call what ───────────────────────────────────────────────────────

@pytest.mark.parametrize("fn", sorted(OWNER_FUNCTIONS))
def test_anon_cannot_execute_an_owner_function(conn, sc, fn):
    with tx(conn) as t:
        out = t.anon().run(OWNER_FUNCTIONS[fn].format(org=sc.bob.org))
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("fn", sorted(OWNER_FUNCTIONS))
def test_a_signed_in_non_admin_is_refused_by_every_owner_function(conn, sc, fn):
    # Bob owns a workspace, Dana belongs to the operator's, Sam has nothing: none is a platform admin.
    for who in (sc.bob.actor, sc.dana, sc.stranger, sc.alice.actor):
        with tx(conn) as t:
            out = t.as_(who).run(OWNER_FUNCTIONS[fn].format(org=sc.bob.org))
            assert not out.ok and out.sqlstate == "42501", (fn, who.name, out)
            assert t.sup("select count(*) from public.security_events where kind like 'credits.%%' or kind like 'member.%%'")[0][0] == 0


def test_the_service_key_is_not_a_platform_admin_either(conn, sc):
    with tx(conn) as t:
        out = t.as_(SERVICE).run("select public.owner_grant_credits(%s, 10, %s, 'key-service-001')", [sc.bob.org, GOOD])
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("fn,args", sorted(INTERNAL.items()))
def test_internal_helpers_are_closed_to_every_api_role(conn, fn, args):
    with as_superuser(conn, commit=False) as s:
        sig = f"public.{fn}({args})"
        for role in ("anon", "authenticated", "service_role"):
            assert s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, sig]) is False, (fn, role)


def test_admin_aal_ok_is_for_signed_in_callers_only(conn, sc):
    with tx(conn) as t:
        assert t.anon().run("select public.admin_aal_ok()").sqlstate == "42501"
        assert t.as_(sc.bob.actor).value("select public.admin_aal_ok()") is True
        assert t.as_(SERVICE).run("select public.admin_aal_ok()").sqlstate == "42501"


def test_the_tables_are_closed_to_the_api_roles(conn, sc):
    for table in ("owner_security_settings", "security_events"):
        with tx(conn) as t:
            for who in (sc.operator, sc.bob.actor, sc.stranger):
                out = t.as_(who).run(f"select * from public.{table}")
                assert not out.ok and out.sqlstate == "42501", (table, who.name, out)
            assert t.anon().run(f"select * from public.{table}").sqlstate == "42501"
    with tx(conn) as t:
        for who in (sc.operator, sc.bob.actor):
            for stmt in ("insert into public.security_events (kind) values ('x')",
                         "update public.security_events set kind = 'y'", "delete from public.security_events",
                         "update public.owner_security_settings set admin_aal2_required = false",
                         "insert into public.credit_price_history (unit, action) values ('u', 'set')",
                         "update public.credit_price_history set unit = 'u'", "delete from public.credit_price_history"):
                out = t.as_(who).run(stmt)
                assert not out.ok and out.sqlstate == "42501", (stmt, who.name, out)


def test_only_the_platform_admin_reads_the_price_history(conn, sc):
    with tx(conn) as t:
        t.sup("insert into public.credit_price_history (unit, action, new_credits_per_unit, new_margin) values ('hist_unit', 'set', 1, 0) returning 1")
        assert t.as_(sc.operator).value("select count(*) from public.credit_price_history where unit = 'hist_unit'") == 1
        for who in (sc.bob.actor, sc.dana, sc.stranger):
            assert t.as_(who).value("select count(*) from public.credit_price_history") == 0, who.name
        assert t.anon().run("select * from public.credit_price_history").sqlstate == "42501"


def test_the_service_key_may_read_the_trail_and_nothing_else_of_it(conn):
    with tx(conn) as t:
        t.sup("select public.security_event_log('probe', 'info', 'x', '{}')")
        out = t.as_(SERVICE).run("select count(*) from public.security_events")
        assert out.ok and out.rows[0][0] >= 1
        assert t.as_(SERVICE).run("update public.security_events set kind = 'z'").sqlstate == "42501"
        assert t.as_(SERVICE).run("delete from public.security_events").sqlstate == "42501"
        assert t.as_(SERVICE).run("select * from public.owner_security_settings").sqlstate == "42501"


def test_every_function_the_migration_adds_pins_its_search_path(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    names = sorted(set(re.findall(r"create or replace function public\.(\w+)", text)))
    assert len(names) >= 25, names
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select p.proname, p.prosecdef, coalesce(p.proconfig, '{}') from pg_proc p "
                      "where p.pronamespace = 'public'::regnamespace and p.proname = any(%s)", [names])
    found = {r[0] for r in rows}
    assert found == set(names), sorted(set(names) - found)
    for name, definer, config in rows:
        assert any(c.startswith("search_path=") and "pg_temp" in c for c in config), f"{name}: {config}"
    # every callable function of the owner family is a definer function
    assert all(r[1] for r in rows if r[0].startswith("owner_") and r[0] not in ("owner_err", "owner_security_append_only",
                                                                                  "owner_security_settings_no_delete",
                                                                                  "owner_security_settings_stamp"))


# ── the gate: off, then on ──────────────────────────────────────────────────

def test_the_gate_is_off_and_there_is_one_settings_row(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows("select admin_aal2_required, recent_mfa_minutes, grant_max_per_call, grant_max_per_24h, "
                     "price_max_change_ratio from public.owner_security_settings")
        assert row == [(False, 480, 100000, 500000, Decimal(3))]
        assert s.run("insert into public.owner_security_settings (id) values (false)").sqlstate == "23514"
        assert s.run("insert into public.owner_security_settings (id) values (true)").sqlstate == "23505"
        assert s.run("delete from public.owner_security_settings").sqlstate == "42501"
        assert s.run("truncate public.owner_security_settings").sqlstate == "42501"
        for col, bad in (("recent_mfa_minutes", 1), ("grant_max_per_call", 0), ("grant_max_per_call", 100000001),
                         ("grant_max_per_24h", 0), ("price_max_change_ratio", 1), ("price_max_change_ratio", 1001),
                         ("reverse_window_days", 0)):
            out = s.run(sql.SQL("update public.owner_security_settings set {} = %s").format(sql.Identifier(col)), [bad])
            assert out.sqlstate == "23514", (col, bad, out)


def test_with_the_gate_off_nobody_is_ever_refused_by_it(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 2)
        for kw in ({}, {"aal": "aal2"}, {"drop_aal": True}):
            assert t.as_(sc.operator, **kw).value("select public.admin_aal_ok()") is True
            assert t.claims_only(sc.operator, **kw).value("select public.admin_mfa_state()->>'why'") == "gate_off"


CASES = [
    # (label, factors, claims kwargs / extra, expected ok, expected why)
    ("no factor, aal1", 0, {}, True, "no_factor"),
    ("no factor, no claim", 0, {"drop_aal": True}, True, "no_factor"),
    ("only an unverified factor, aal1", "unverified", {}, True, "no_factor"),
    ("verified factor, aal1", 1, {}, False, "aal1"),
    ("verified factor, no aal claim at all", 1, {"drop_aal": True}, False, "aal1"),
    ("verified factor, garbage aal claim", 1, {"aal": "banana"}, False, "aal1"),
    ("verified factor, aal2, recent code", 1, {"aal": "aal2", "amr": aal2(5)["amr"]}, True, "aal2"),
    ("verified factor, aal2, code 9 hours old (window 8 h)", 1, {"aal": "aal2", "amr": aal2(9 * 60)["amr"]}, False, "stale_mfa"),
    ("verified factor, aal2, no amr claim", 1, {"aal": "aal2"}, True, "aal2"),
    ("verified factor, aal2, amr is not an array", 1, {"aal": "aal2", "amr": "totp"}, True, "aal2"),
    ("verified factor, aal2, amr entries are junk", 1, {"aal": "aal2", "amr": [1, "x", None, {"method": 7},
                                                                                   {"method": "totp", "timestamp": "soon"}]}, True, "aal2"),
    ("verified factor, aal2, only an old password entry", 1, {"aal": "aal2", "amr": [{"method": "password", "timestamp": 1}]}, True, "aal2"),
    ("verified factor, aal2, a timestamp in the future", 1, {"aal": "aal2", "amr": [{"method": "totp", "timestamp": now() + 5000}]}, True, "aal2"),
    ("verified factor, aal2, timestamp absurdly large", 1, {"aal": "aal2", "amr": [{"method": "totp", "timestamp": 99999999999999}]}, True, "aal2"),
]


@pytest.mark.parametrize("label,nfactors,kw,ok,why", CASES, ids=[c[0] for c in CASES])
def test_the_gate_decision_table(conn, sc, label, nfactors, kw, ok, why):
    with tx(conn) as t:
        gate_on(t)
        if nfactors == "unverified":
            factors(t, sc.operator, 1, status="unverified")
        else:
            factors(t, sc.operator, nfactors)
        kw = dict(kw)
        extra = {k: kw.pop(k) for k in ("amr",) if k in kw}
        assert t.as_(sc.operator, extra=extra, **kw).value("select public.admin_aal_ok()") is ok
        assert t.claims_only(sc.operator, extra=extra, **kw).value("select public.admin_mfa_state()->>'why'") == why


def test_the_recent_code_window_is_the_setting(conn, sc):
    with tx(conn) as t:
        gate_on(t)
        factors(t, sc.operator, 1)
        set_caps(t, recent_mfa_minutes=10)
        assert t.as_(sc.operator, extra=aal2(5), aal="aal2").value("select public.admin_aal_ok()") is True
        assert t.as_(sc.operator, extra=aal2(11), aal="aal2").value("select public.admin_aal_ok()") is False


def test_an_unreadable_factor_table_never_blocks(conn, sc):
    with tx(conn) as t:
        gate_on(t)
        factors(t, sc.operator, 1)
        t.sup("alter table auth.mfa_factors rename to mfa_factors_gone")
        assert t.as_(sc.operator).value("select public.admin_aal_ok()") is True  # aal1, but the factor table cannot be read
        assert t.claims_only(sc.operator).value("select public.admin_mfa_state()->>'why'") == "factors_unreadable"


def test_an_admin_without_a_factor_is_never_blocked_with_the_gate_on(conn, sc):
    with tx(conn) as t:
        gate_on(t)
        s = t.as_(sc.operator)  # aal1, no factor
        out = grant(s, sc.bob.org, 10, "key-nofactor-1")
        assert out["ok"] is True, out
        assert s.value("select public.owner_set_credit_price('lockout_unit', 2, 0, null, null)")["ok"] is True
        assert s.value("select public.owner_add_member('lockout@x.test', 'editor')")["ok"] is True


def test_an_admin_with_a_factor_and_a_password_only_session_is_refused_with_a_document(conn, sc):
    with tx(conn) as t:
        gate_on(t)
        factors(t, sc.operator, 1)
        before = balance(t, sc.bob.org)
        s = t.as_(sc.operator)  # aal1
        for call in ("select public.owner_grant_credits(%s, 10, %s, 'key-aal1-0001')",):
            out = s.value(call, [sc.bob.org, GOOD])
            assert out["ok"] is False and out["error"] == "mfa_required" and out["why"] == "aal1", out
        assert s.value("select public.owner_set_credit_price('gate_unit', 2, 0)")["error"] == "mfa_required"
        assert s.value("select public.owner_add_member('gate@x.test', 'viewer')")["error"] == "mfa_required"
        assert s.value("select public.owner_set_member_role(gen_random_uuid(), 'viewer')")["error"] == "mfa_required"
        assert s.value("select public.owner_remove_member(gen_random_uuid())")["error"] == "mfa_required"
        assert s.value("select public.owner_reverse_grant(1, %s)", [GOOD])["error"] == "mfa_required"
        assert s.value("select public.owner_delete_credit_price('gate_unit', null, true)")["error"] == "mfa_required"
        assert s.value("select public.owner_restore_credit_price(1)")["error"] == "mfa_required"
        assert balance(t, sc.bob.org) == before
        assert t.sup("select count(*) from public.credit_prices where unit = 'gate_unit'")[0][0] == 0
        # the same person with a fresh code passes
        assert grant(t.as_(sc.operator, extra=aal2(1), aal="aal2"), sc.bob.org, 10, "key-aal2-0001")["ok"] is True


def test_with_the_gate_on_existing_paths_are_not_touched(conn, sc):
    # The gate lives only in the new functions: a password-only admin with a factor keeps every old right.
    with tx(conn) as t:
        gate_on(t)
        factors(t, sc.operator, 2)
        s = t.as_(sc.operator)  # aal1
        assert s.value("select public.platform_role()") == "owner"
        assert s.value("select public.is_platform_admin()") is True
        assert s.value("select count(*) from public.app_members") >= 1
        assert s.value("select count(*) from public.accessible_org_ids('viewer')") >= 3
        assert s.value("select public.grant_credits(%s, 1, 'old path')", [sc.bob.org]) is not None
        assert s.run("insert into public.credit_prices (unit, credits_per_unit) values ('old_path_unit', 1)").ok
        assert s.run("delete from public.credit_prices where unit = 'old_path_unit'").ok


def test_the_owner_function_family_only_reads_with_the_gate_off(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 1)
        state = t.as_(sc.operator).value("select public.owner_security_get()")
    assert state["ok"] is True and state["settings"]["admin_aal2_required"] is False
    assert state["caller"]["why"] == "gate_off" and state["caller"]["has_verified_factor"] is True
    assert state["can_enable"] is False  # one factor is not two
    assert state["would_block_after_enable"] is True  # an aal1 session would be refused
    assert state["factors_readable"] is True
    assert [a["email"] for a in state["admins"]] == [sc.operator.email]


# ── enable / disable ────────────────────────────────────────────────────────

def test_enable_refuses_until_every_admin_has_two_verified_factors(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 1)
        out = t.as_(sc.operator, extra=aal2(1), aal="aal2").value("select public.enable_admin_mfa()")
        assert out["ok"] is False and out["error"] == "admins_need_two_factors", out
        assert out["missing"] == [{"email": sc.operator.email, "role": "owner", "bound": True, "verified_factors": 1}]
        assert t.sup("select admin_aal2_required from public.owner_security_settings")[0][0] is False


def test_enable_refuses_with_an_unverified_second_factor(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 1)
        factors(t, sc.operator, 1, status="unverified")
        out = t.as_(sc.operator, extra=aal2(1), aal="aal2").value("select public.enable_admin_mfa()")
        assert out["error"] == "admins_need_two_factors"


def test_enable_refuses_while_another_admin_has_fewer_than_two_or_is_unbound(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 2)
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [sc.dana.uid, sc.dana.email])
        out = t.as_(sc.operator, extra=aal2(1), aal="aal2").value("select public.enable_admin_mfa()")
        assert out["error"] == "admins_need_two_factors" and [m["email"] for m in out["missing"]] == [sc.dana.email]
        factors(t, sc.dana, 2)
        t.sup("insert into public.app_members (email, role) values ('invited-admin@x.test', 'admin') returning 1")
        out = t.as_(sc.operator, extra=aal2(1), aal="aal2").value("select public.enable_admin_mfa()")
        assert out["error"] == "admins_need_two_factors"
        assert out["missing"] == [{"email": "invited-admin@x.test", "role": "admin", "bound": False, "verified_factors": 0}]
        # editors and viewers do not count
    with tx(conn) as t:
        factors(t, sc.operator, 2)
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'editor') returning 1", [sc.dana.uid, sc.dana.email])
        assert t.as_(sc.operator, extra=aal2(1), aal="aal2").value("select public.enable_admin_mfa()")["ok"] is True


def test_enable_refuses_if_the_factor_table_cannot_be_read(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 2)
        t.sup("alter table auth.mfa_factors rename to mfa_factors_gone")
        out = t.as_(sc.operator, extra=aal2(1), aal="aal2").value("select public.enable_admin_mfa()")
        assert out["error"] == "factors_unreadable"
        assert t.sup("select admin_aal2_required from public.owner_security_settings")[0][0] is False


def test_enable_will_not_switch_the_gate_on_under_a_session_that_would_fail_it(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 2)
        for kw, extra in (({}, {}), ({"aal": "aal2"}, aal2(60 * 9))):
            out = t.as_(sc.operator, extra=extra, **kw).value("select public.enable_admin_mfa()")
            assert out["ok"] is False and out["error"] == "session_not_fresh", out
        assert t.sup("select admin_aal2_required from public.owner_security_settings")[0][0] is False


def test_enable_then_the_gate_bites_and_disable_needs_the_code(conn, sc):
    with tx(conn) as t:
        factors(t, sc.operator, 2)
        fresh = t.as_(sc.operator, extra=aal2(1), aal="aal2")
        out = fresh.value("select public.enable_admin_mfa()")
        assert out == {"ok": True, "enabled": True, "already": False}
        assert fresh.value("select public.enable_admin_mfa()")["already"] is True
        assert t.sup("select admin_aal2_required from public.owner_security_settings")[0][0] is True
        # a stolen password (aal1) now gets nothing from the owner functions ...
        stolen = t.as_(sc.operator)
        assert grant(stolen, sc.bob.org, 10, "key-stolen-001")["error"] == "mfa_required"
        # ... cannot switch the gate off either, and is told about the break-glass
        out = stolen.value("select public.disable_admin_mfa()")
        assert out["error"] == "mfa_required" and "update public.owner_security_settings" in out["message"]
        assert t.sup("select admin_aal2_required from public.owner_security_settings")[0][0] is True
        # the real owner can
        assert t.as_(sc.operator, extra=aal2(1), aal="aal2").value("select public.disable_admin_mfa()") == {
            "ok": True, "enabled": False, "already": False}
        assert t.as_(sc.operator).value("select public.disable_admin_mfa()")["already"] is True
        kinds = [(e[0], e[1]) for e in events(t)]
        assert ("security.gate", "critical") in kinds and ("settings.change", "critical") in kinds
        gate = audits(t, "security.gate")
        assert sorted(g[4]["enabled"] for g in gate) == [False, True]  # (one transaction: the rows share a timestamp)
        gate = [g for g in gate if g[4]["enabled"]]
        assert gate[0][2] == sc.operator.email  # stamped from the session by the audit trigger
        assert gate[0][1] == sc.operator.uid


def test_an_admin_with_no_factor_can_switch_the_gate_off(conn, sc):
    with tx(conn) as t:
        gate_on(t)
        out = t.as_(sc.operator).value("select public.disable_admin_mfa()")
        assert out["ok"] is True and out["enabled"] is False


def test_breaking_the_glass_in_the_sql_editor_works_and_leaves_a_mark(conn, sc):
    with tx(conn) as t:
        gate_on(t)
        t.sup("update public.owner_security_settings set admin_aal2_required = false returning 1")
        assert t.sup("select admin_aal2_required from public.owner_security_settings")[0][0] is False
        rows = [e for e in events(t, "settings.change")]
        assert len(rows) == 2 and rows[1][1] == "critical" and rows[1][2] is None  # no signed-in actor in the editor
        assert rows[1][5]["admin_aal2_required"] == [True, False]


# ── credits: grant ──────────────────────────────────────────────────────────

def test_a_grant_moves_the_balance_once_and_leaves_both_records(conn, sc):
    with tx(conn) as t:
        before = balance(t, sc.bob.org)
        out = grant(t.as_(sc.operator), sc.bob.org, 250, "key-grant-0001")
        assert out["ok"] is True and out["duplicate"] is False and out["credits"] == 250
        assert Decimal(str(out["balance"])) == before + 250
        assert balance(t, sc.bob.org) == before + 250
        ledger = t.sup("select kind, amount, external_id, created_by, note from public.credit_transactions where id = %s",
                       [out["transaction_id"]])[0]
        assert ledger[:3] == ("grant", Decimal(250), "owner-grant:key-grant-0001") and str(ledger[3]) == sc.operator.uid
        assert GOOD in ledger[4]
        a = audits(t, "credits.grant")
        assert len(a) == 1 and a[0][2] == sc.operator.email and a[0][3] == sc.bob.org
        assert a[0][4]["credits"] == 250 and a[0][4]["reason"] == GOOD and a[0][4]["transaction_id"] == out["transaction_id"]
        e = events(t, "credits.grant")
        assert len(e) == 1 and e[0][2] == sc.operator.uid and e[0][3] == sc.operator.email
        # the 0034 trigger gave the grant its own lot and the balance still equals the lots
        assert t.sup("select remaining from public.credit_lots where created_txn = %s", [out["transaction_id"]])[0][0] == 250


def test_a_retried_grant_is_a_no_op_that_says_so(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        before = balance(t, sc.bob.org)
        first = grant(s, sc.bob.org, 40, "key-retry-0001")
        second = grant(s, sc.bob.org, 40, "key-retry-0001")
        third = grant(s, sc.bob.org, 40, "  key-retry-0001  ")
        assert first["duplicate"] is False and second["duplicate"] is True and third["duplicate"] is True
        assert second["transaction_id"] == first["transaction_id"]
        assert balance(t, sc.bob.org) == before + 40
        assert t.sup("select count(*) from public.credit_transactions where external_id = 'owner-grant:key-retry-0001'")[0][0] == 1
        assert len(audits(t, "credits.grant")) == 1 and len(events(t, "credits.grant")) == 1


def test_a_reused_key_for_a_different_grant_is_refused_not_merged(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        grant(s, sc.bob.org, 40, "key-reuse-0001")
        before = balance(t, sc.bob.org)
        assert grant(s, sc.bob.org, 41, "key-reuse-0001")["error"] == "key_reused"
        assert grant(s, sc.alice.org, 40, "key-reuse-0001")["error"] == "key_reused"
        assert balance(t, sc.bob.org) == before


def test_the_key_cannot_collide_with_a_purchase_or_another_ledger_row(conn, sc):
    with tx(conn) as t:
        t.trusted("select public.add_purchased_credits(%s, 5, 'owner-grant:key-collide-01', 'x')", [sc.bob.org])
        before = balance(t, sc.bob.org)
        assert grant(t.as_(sc.operator), sc.bob.org, 5, "key-collide-01")["error"] == "key_reused"
        assert balance(t, sc.bob.org) == before


@pytest.mark.parametrize("credits,code", [
    (0, "bad_amount"), (-5, "bad_amount"), (None, "bad_amount"), ("NaN", "bad_amount"), ("Infinity", "bad_amount"),
    ("-Infinity", "bad_amount"), (100001, "per_call_cap"), ("1e30", "per_call_cap"), ("99999999999999999999", "per_call_cap"),
    ("100000.001", "per_call_cap"),
])
def test_a_bad_amount_is_refused_with_a_document(conn, sc, credits, code):
    with tx(conn) as t:
        before = balance(t, sc.bob.org)
        out = t.as_(sc.operator).value("select public.owner_grant_credits(%s, %s::numeric, %s, 'key-amount-001')",
                                       [sc.bob.org, credits, GOOD])
        assert out["ok"] is False and out["error"] == code, out
        assert balance(t, sc.bob.org) == before
        assert t.sup("select count(*) from public.app_audit_log where action = 'credits.grant'")[0][0] == 0


def test_the_amount_rounds_up_to_the_cent_and_the_cap_is_inclusive(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        assert grant(s, sc.bob.org, "0.001", "key-round-0001")["credits"] == 0.01
        assert grant(s, sc.bob.org, 100000, "key-round-0002")["ok"] is True


def test_reason_and_key_are_required(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        for reason in (None, "", "   ", "short", "x" * 301):
            assert grant(s, sc.bob.org, 1, "key-reason-001", reason)["error"] == "reason_required", reason
        for key in (None, "", "short", "has space in it", "x" * 101, "semi;colon-key", "ключ-ключ-ключ"):
            assert grant(s, sc.bob.org, 1, key)["error"] == "idempotency_key_required", key


def test_unknown_and_exempt_organizations_are_refused(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        assert grant(s, "11111111-1111-1111-1111-111111111111", 5, "key-unknown-01")["error"] == "unknown_org"
        assert s.value("select public.owner_grant_credits(null, 5, %s, 'key-unknown-02')", [GOOD])["error"] == "unknown_org"
        assert grant(s, "00000000-0000-0000-0000-000000000001", 5, "key-exempt-001")["error"] == "exempt_org"


def test_the_per_call_cap_is_the_setting(conn, sc):
    with tx(conn) as t:
        set_caps(t, grant_max_per_call=50)
        s = t.as_(sc.operator)
        out = grant(s, sc.bob.org, 51, "key-percall-01")
        assert out["error"] == "per_call_cap" and out["cap"] == 50
        assert grant(s, sc.bob.org, 50, "key-percall-02")["ok"] is True


def test_the_rolling_24_hour_cap_counts_every_actor_and_manual_grants(conn, sc):
    with tx(conn) as t:
        set_caps(t, grant_max_per_call=100, grant_max_per_24h=150)
        s = t.as_(sc.operator)
        assert grant(s, sc.bob.org, 100, "key-daily-0001")["ok"] is True
        out = grant(s, sc.alice.org, 60, "key-daily-0002")  # another org, same pool
        assert out["error"] == "daily_cap" and out["granted_24h"] == 100 and out["cap"] == 150 and out["requested"] == 60
        # a manual grant_credits row counts too ...
        t.as_(sc.operator).value("select public.grant_credits(%s, 30, 'manual')", [sc.alice.org])
        assert grant(s, sc.alice.org, 21, "key-daily-0003")["error"] == "daily_cap"
        assert grant(s, sc.alice.org, 20, "key-daily-0004")["ok"] is True
        # ... a retry of one that already counted is not blocked by the cap
        assert grant(s, sc.bob.org, 100, "key-daily-0001")["duplicate"] is True
        # a second admin shares the pool
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [sc.dana.uid, sc.dana.email])
        assert grant(t.as_(sc.dana), sc.bob.org, 1, "key-daily-0005")["error"] == "daily_cap"


def test_welcome_credits_and_invite_rewards_do_not_use_up_the_owner_cap(conn, sc):
    with tx(conn) as t:
        set_caps(t, grant_max_per_call=100, grant_max_per_24h=100)
        t.sup("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, external_id, created_by) "
              "select %s, 'grant', 5000, balance, reserved, 'invite-reward:probe', %s from public.credit_accounts where org_id = %s returning 1",
              [sc.bob.org, sc.operator.uid, sc.bob.org])
        t.sup("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, external_id) "
              "select %s, 'grant', 5000, balance, reserved, 'welcome:probe' from public.credit_accounts where org_id = %s returning 1",
              [sc.bob.org, sc.bob.org])
        assert grant(t.as_(sc.operator), sc.bob.org, 100, "key-welcome-01")["ok"] is True


def test_a_balance_that_would_overflow_is_an_answer(conn, sc):
    with tx(conn) as t:
        t.sup("update public.credit_accounts set balance = 999999999999.00 where org_id = %s returning 1", [sc.bob.org])
        out = grant(t.as_(sc.operator), sc.bob.org, 100, "key-overflow-01")
        assert out["ok"] is False and out["error"] == "balance_limit", out


def test_a_rate_limit_stops_a_runaway_script(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        results = [s.value("select public.owner_grant_credits(null, 1, %s, 'key-rate-000001')", [GOOD])["error"] for _ in range(24)]
        assert results[:20] == ["unknown_org"] * 20 and set(results[20:]) == {"rate_limited"}


def test_two_grants_cannot_both_pass_the_cap_check(conn, sc):
    # The cap's lock is taken before the balance is read: a second grant waits for the first.
    other = psycopg.connect(conn.info.dsn)
    try:
        other.execute("select pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('grant_cap'))")
        with tx(conn) as t:
            t.conn.execute("set local lock_timeout = '300ms'")
            out = t.as_(sc.operator).run("select public.owner_grant_credits(%s, 5, %s, 'key-lock-000001')", [sc.bob.org, GOOD])
        assert not out.ok and out.sqlstate == "55P03", out
    finally:
        other.rollback()
        other.close()


def test_a_grant_waits_for_the_organizations_account_lock(conn, sc):
    other = psycopg.connect(conn.info.dsn)
    try:
        other.execute("select 1 from public.credit_accounts where org_id = %s for update", [sc.bob.org])
        with tx(conn) as t:
            t.conn.execute("set local lock_timeout = '300ms'")
            out = t.as_(sc.operator).run("select public.owner_grant_credits(%s, 5, %s, 'key-lock-000002')", [sc.bob.org, GOOD])
        assert not out.ok and out.sqlstate == "55P03", out
    finally:
        other.rollback()
        other.close()


# ── credits: reverse ────────────────────────────────────────────────────────

def test_a_grant_can_be_reversed_once(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        before = balance(t, sc.bob.org)
        g = grant(s, sc.bob.org, 70, "key-rev-000001")
        out = s.value("select public.owner_reverse_grant(%s, %s)", [g["transaction_id"], "granted to the wrong workspace"])
        assert out["ok"] is True and out["reversed"] == 70 and out["shortfall"] == 0 and out["duplicate"] is False
        assert balance(t, sc.bob.org) == before
        row = t.sup("select kind, amount, external_id from public.credit_transactions where id = %s", [out["transaction_id"]])[0]
        assert row == ("adjust", Decimal(-70), f"owner-reverse:{g['transaction_id']}")
        again = s.value("select public.owner_reverse_grant(%s, %s)", [g["transaction_id"], "granted to the wrong workspace"])
        assert again["duplicate"] is True and balance(t, sc.bob.org) == before
        assert t.sup("select count(*) from public.credit_transactions where external_id = %s", [f"owner-reverse:{g['transaction_id']}"])[0][0] == 1
        r = audits(t, "credits.reverse")
        assert len(r) == 1 and r[0][4]["reversed"] == 70 and r[0][4]["shortfall"] == 0


def test_a_reversal_is_bounded_by_what_is_left_and_records_the_shortfall(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        g = grant(s, sc.bob.org, 100, "key-rev-000002")
        avail = t.sup("select balance - reserved from public.credit_accounts where org_id = %s", [sc.bob.org])[0][0]
        # a run holds all but 30 credits
        t.sup("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        t.sup("select public.reserve_credits(%s, 'rev-hold-0001', %s)", [sc.bob.org, avail - 30])
        out = t.as_(sc.operator).value("select public.owner_reverse_grant(%s, %s)", [g["transaction_id"], "taking back what is left"])
        assert out["ok"] is True and out["reversed"] == 30 and out["shortfall"] == 70, out
        acc = t.sup("select balance, reserved from public.credit_accounts where org_id = %s", [sc.bob.org])[0]
        assert acc[0] >= acc[1]  # never below what is on hold
        assert audits(t, "credits.reverse")[0][4]["shortfall"] == 70


def test_nothing_left_to_reverse_is_an_answer_not_an_error(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        g = grant(s, sc.bob.org, 100, "key-rev-000003")
        avail = t.sup("select balance - reserved from public.credit_accounts where org_id = %s", [sc.bob.org])[0][0]
        t.sup("select set_config('request.jwt.claims', %s, true)", [json.dumps(sc.bob.actor.claims())])
        t.sup("select public.reserve_credits(%s, 'rev-hold-0002', %s)", [sc.bob.org, avail])
        out = t.as_(sc.operator).value("select public.owner_reverse_grant(%s, %s)", [g["transaction_id"], "all of it is on hold"])
        assert out["ok"] is False and out["error"] == "nothing_to_reverse" and out["shortfall"] == 100


def test_only_owner_grants_can_be_reversed(conn, sc):
    with tx(conn) as t:
        welcome = t.sup("select id from public.credit_transactions where kind = 'grant' and external_id is not null "
                        "and external_id not like 'owner-grant:%%' limit 1")
        assert welcome, "the lab seeds welcome credits"
        purchase = t.trusted("select public.add_purchased_credits(%s, 5, 'rev-purchase-0001', 'x') ->> 'transaction_id'", [sc.bob.org])[0][0]
        reserve = t.sup("select id from public.credit_transactions where kind = 'reserve' limit 1")[0][0]
        s = t.as_(sc.operator)
        for txn in [r[0] for r in welcome][:1] + [int(purchase), reserve, 999999999]:
            out = s.value("select public.owner_reverse_grant(%s, %s)", [txn, GOOD])
            assert out["ok"] is False and out["error"] in ("not_reversible", "not_a_grant"), (txn, out)
        manual = s.value("select public.grant_credits(%s, 3, 'old path')", [sc.bob.org])
        row = t.sup("select id from public.credit_transactions where org_id = %s and kind = 'grant' and external_id is null "
                    "order by id desc limit 1", [sc.bob.org])[0][0]
        assert s.value("select public.owner_reverse_grant(%s, %s)", [row, GOOD])["ok"] is True


def test_an_old_grant_is_outside_the_reversal_window(conn, sc):
    with tx(conn) as t:
        t.sup("update public.credit_accounts set balance = balance + 5 where org_id = %s returning 1", [sc.bob.org])
        old = t.sup("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, created_by, created_at) "
                    "select %s, 'grant', 5, balance, reserved, %s, now() - interval '20 days' from public.credit_accounts where org_id = %s "
                    "returning id", [sc.bob.org, sc.operator.uid, sc.bob.org])[0][0]
        out = t.as_(sc.operator).value("select public.owner_reverse_grant(%s, %s)", [old, GOOD])
        assert out["error"] == "too_old" and out["window_days"] == 14


def test_a_reversal_needs_a_reason(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        g = grant(s, sc.bob.org, 5, "key-rev-000004")
        assert s.value("select public.owner_reverse_grant(%s, 'no')", [g["transaction_id"]])["error"] == "reason_required"


# ── prices ──────────────────────────────────────────────────────────────────

def price(s, unit, rate, margin, note=None, reason=None, confirm=False):
    return s.value("select public.owner_set_credit_price(%s, %s::numeric, %s::numeric, %s, %s, %s)",
                   [unit, rate, margin, note, reason, confirm])


def current(t, unit):
    rows = t.sup("select credits_per_unit, margin, note from public.credit_prices where unit = %s", [unit])
    return rows[0] if rows else None


def history(t, unit):
    return t.sup("select action, old_credits_per_unit, old_margin, new_credits_per_unit, new_margin, source, reason, restored_from, id "
                 "from public.credit_price_history where unit = %s order by id", [unit])


def test_a_new_price_is_written_with_one_history_row_and_both_records(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        out = price(s, "unit_new_1", 2.5, 0.5, "first", "launch price")
        assert out["ok"] is True and out["old"] is None and out["new"] == {"credits_per_unit": 2.5, "margin": 0.5}
        assert current(t, "unit_new_1") == (Decimal("2.5"), Decimal("0.5"), "first")
        h = history(t, "unit_new_1")
        assert len(h) == 1 and h[0][0] == "set" and h[0][1] is None and h[0][3] == Decimal("2.5") and h[0][5] == "rpc"
        assert h[0][6] == "launch price"  # no second 'direct' row from the trail trigger
        assert len(audits(t, "credits.price")) == 1 and audits(t, "credits.price")[0][4]["history_id"] == h[0][8]
        assert [e[0] for e in events(t, "credits.price", "unit_new_1")] == ["credits.price"]
        trail = events(t, "price.%", "unit_new_1")
        assert [e[0] for e in trail] == ["price.add"] and trail[0][5]["via"] == "owner_function"
        # updated_by is the actor (the existing stamp trigger)
        assert str(t.sup("select updated_by from public.credit_prices where unit = 'unit_new_1'")[0][0]) == sc.operator.uid


def test_a_price_change_inside_the_ratio_goes_through_and_keeps_the_note(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        price(s, "unit_chg_1", 10, 1, "keep me")
        out = price(s, "unit_chg_1", 25, 1, None, "within x3")
        assert out["ok"] is True and out["old"]["credits_per_unit"] == 10 and out["new"]["credits_per_unit"] == 25
        assert current(t, "unit_chg_1")[2] == "keep me"
        assert price(s, "unit_chg_1", 25, 1)["unchanged"] is True
        assert len(history(t, "unit_chg_1")) == 2  # the no-op wrote nothing
        assert price(s, "unit_chg_1", 25, 1, "")["ok"] is True and current(t, "unit_chg_1")[2] is None  # '' clears the note


@pytest.mark.parametrize("rate,margin,reason_code", [
    (31, 1, "ratio"),            # more than x3 up
    (3.3, 1, "ratio"),           # less than 1/3
    (10, 7, "ratio"),            # same rate, charged x4: the margin counts
    (0, 1, "zero"),              # free
])
def test_a_big_change_needs_an_explicit_confirm(conn, sc, rate, margin, reason_code):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        price(s, "unit_big_1", 10, 1)
        out = price(s, "unit_big_1", rate, margin)
        assert out["ok"] is False and out["error"] == "confirm_required" and out["reason"] == reason_code, out
        assert out["old"]["credits_per_unit"] == 10 and out["max_ratio"] == 3
        assert current(t, "unit_big_1")[0] == Decimal(10)  # nothing changed
        assert len(history(t, "unit_big_1")) == 1
        ok = price(s, "unit_big_1", rate, margin, None, "confirmed", True)
        assert ok["ok"] is True and current(t, "unit_big_1")[0] == Decimal(str(rate))


@pytest.mark.parametrize("rate,margin", [(30, 1), (3.34, 1), (10, 0), (10, 5), (11, 1.5)])
def test_a_change_inside_the_ratio_needs_no_confirm(conn, sc, rate, margin):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        price(s, "unit_ok_1", 10, 1)
        assert price(s, "unit_ok_1", rate, margin)["ok"] is True


def test_the_ratio_is_the_setting_and_a_zero_price_cannot_be_raised_silently(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        price(s, "unit_big_2", 10, 0)
        set_caps(t, price_max_change_ratio=1.5)
        assert price(s, "unit_big_2", 16, 0)["error"] == "confirm_required"
        assert price(s, "unit_big_2", 14, 0)["ok"] is True
        price(s, "unit_free_1", 0, 0, None, "promo", True)
        assert price(s, "unit_free_1", 5, 0)["reason"] == "was_zero"


@pytest.mark.parametrize("rate,margin,note,code", [
    (-1, 0, None, "bad_rate"), ("NaN", 0, None, "bad_rate"), ("Infinity", 0, None, "bad_rate"), (1000001, 0, None, "bad_rate"),
    (None, 0, None, "bad_rate"), ("0.000000001", 0, None, "bad_rate"), (1, -0.1, None, "bad_margin"), (1, 10.5, None, "bad_margin"),
    (1, "NaN", None, "bad_margin"), (1, None, None, "bad_margin"), (1, 0, "x" * 301, "bad_note"),
])
def test_bad_price_figures_are_refused_with_a_document(conn, sc, rate, margin, note, code):
    with tx(conn) as t:
        out = price(t.as_(sc.operator), "unit_bad_1", rate, margin, note)
        assert out["ok"] is False and out["error"] == code, out
        assert current(t, "unit_bad_1") is None and history(t, "unit_bad_1") == []


@pytest.mark.parametrize("unit", ["", "  ", "Upper", "1abc", "has space", "a" * 64, "semi;colon", "ünit", "a-b"])
def test_a_bad_unit_name_is_refused(conn, sc, unit):
    with tx(conn) as t:
        assert price(t.as_(sc.operator), unit, 1, 0)["error"] == "bad_unit"


def test_deleting_a_price_needs_the_confirm_and_can_be_undone(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        price(s, "unit_del_1", 4, 1, "to be deleted")
        out = s.value("select public.owner_delete_credit_price('unit_del_1', 'tidy up')")
        assert out["error"] == "confirm_required" and out["reason"] == "delete" and current(t, "unit_del_1") is not None
        gone = s.value("select public.owner_delete_credit_price('unit_del_1', 'tidy up', true)")
        assert gone["ok"] is True and current(t, "unit_del_1") is None
        assert s.value("select public.owner_delete_credit_price('unit_del_1', null, true)")["error"] == "no_such_price"
        h = history(t, "unit_del_1")
        assert [x[0] for x in h] == ["set", "delete"] and h[1][1] == Decimal(4) and h[1][3] is None
        back = s.value("select public.owner_restore_credit_price(%s, 'oops')", [gone["history_id"]])
        assert back["ok"] is True and back["action"] == "restore"
        assert current(t, "unit_del_1") == (Decimal(4), Decimal(1), "to be deleted")
        h = history(t, "unit_del_1")
        assert h[-1][0] == "restore" and h[-1][7] == gone["history_id"]
        assert [e[0] for e in events(t, "price.%", "unit_del_1")] == ["price.add", "price.remove", "price.add"]


def test_restoring_a_change_puts_the_price_back_and_a_creation_is_undone_by_deleting(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        created = price(s, "unit_rest_1", 8, 0.5)
        changed = price(s, "unit_rest_1", 12, 0.5)
        assert s.value("select public.owner_restore_credit_price(%s)", [changed["history_id"]])["ok"] is True
        assert current(t, "unit_rest_1")[0] == Decimal(8)
        out = s.value("select public.owner_restore_credit_price(%s, 'undo create')", [created["history_id"]])
        assert out["error"] == "confirm_required" and out["reason"] == "delete"
        assert s.value("select public.owner_restore_credit_price(%s, 'undo create', true)", [created["history_id"]])["ok"] is True
        assert current(t, "unit_rest_1") is None
        assert s.value("select public.owner_restore_credit_price(999999999)")["error"] == "no_such_history"


def test_a_restore_goes_through_the_same_ratio_guard(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        price(s, "unit_rest_2", 100, 0)
        first = price(s, "unit_rest_2", 200, 0)  # old = 100
        price(s, "unit_rest_2", 500, 0, None, None, True)   # now 500 (x2.5)
        out = s.value("select public.owner_restore_credit_price(%s)", [first["history_id"]])  # back to 100: x0.2
        assert out["error"] == "confirm_required" and out["reason"] == "ratio"


def test_a_direct_browser_write_leaves_a_trail_and_can_be_restored(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        assert s.run("insert into public.credit_prices (unit, credits_per_unit, margin, note) values ('unit_dir_1', 3, 1, 'direct')").ok
        assert s.run("update public.credit_prices set credits_per_unit = 9 where unit = 'unit_dir_1'").ok
        assert s.run("delete from public.credit_prices where unit = 'unit_dir_1'").ok
        h = history(t, "unit_dir_1")
        assert [(x[0], x[5]) for x in h] == [("set", "direct"), ("set", "direct"), ("delete", "direct")]
        assert h[1][1] == Decimal(3) and h[1][3] == Decimal(9) and h[2][1] == Decimal(9)
        assert str(t.sup("select actor_user_id from public.credit_price_history where id = %s", [h[2][8]])[0][0]) == sc.operator.uid
        trail = events(t, "price.%", "unit_dir_1")
        assert [e[0] for e in trail] == ["price.add", "price.change", "price.remove"]
        assert all(e[5]["via"] == "direct" for e in trail) and trail[2][1] == "warning" and trail[2][3] == sc.operator.email
        # the deleted price comes back through the restore function (a delete is a big change: confirm)
        out = t.as_(sc.operator).value("select public.owner_restore_credit_price(%s, 'browser delete', true)", [h[2][8]])
        assert out["ok"] is True and current(t, "unit_dir_1") == (Decimal(9), Decimal(1), "direct")


def test_a_zero_price_written_directly_is_a_critical_event(conn, sc):
    with tx(conn) as t:
        assert t.as_(sc.operator).run("insert into public.credit_prices (unit, credits_per_unit) values ('unit_zero_1', 0)").ok
        assert events(t, "price.add", "unit_zero_1")[-1][1] == "critical"


def test_a_no_op_update_writes_nothing(conn, sc):
    with tx(conn) as t:
        t.sup("insert into public.credit_prices (unit, credits_per_unit) values ('unit_noop_1', 1) returning 1")
        n = len(events(t, "price.%", "unit_noop_1"))
        t.sup("update public.credit_prices set credits_per_unit = credits_per_unit where unit = 'unit_noop_1' returning 1")
        assert len(events(t, "price.%", "unit_noop_1")) == n == 1


def test_the_price_trails_exist_for_the_seeded_prices(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.value("select count(*) from public.credit_price_history where source = 'direct'") >= 3  # the lab's seed prices


# ── the trail never blocks the write it observes ───────────────────────────

def test_a_failing_trail_never_fails_a_price_or_roster_write(conn, sc):
    with tx(conn) as t:
        t.sup("alter table public.security_events add constraint security_events_break check (false) not valid")
        t.sup("alter table public.credit_price_history add constraint credit_price_history_break check (false) not valid")
        before = t.sup("select count(*) from public.security_events")[0][0]
        s = t.as_(sc.operator)
        assert s.run("insert into public.credit_prices (unit, credits_per_unit) values ('unit_trail_1', 1)").ok
        assert s.run("update public.credit_prices set credits_per_unit = 2 where unit = 'unit_trail_1'").ok
        assert s.run("delete from public.credit_prices where unit = 'unit_trail_1'").ok
        assert s.run("insert into public.app_members (email, role) values ('trail-viewer@x.test', 'viewer')").ok
        assert s.run("update public.app_members set role = 'editor' where email = 'trail-viewer@x.test'").ok
        assert s.run("delete from public.app_members where email = 'trail-viewer@x.test'").ok
        assert t.sup("select count(*) from public.security_events")[0][0] == before
        assert t.sup("select count(*) from public.credit_price_history where unit = 'unit_trail_1'")[0][0] == 0
    # ... whereas an owner function whose audit cannot be written rolls back with it
    with tx(conn) as t:
        t.sup("alter table public.security_events add constraint security_events_break check (false) not valid")
        out = t.as_(sc.operator).run("select public.owner_set_credit_price('unit_trail_2', 1, 0)")
        assert not out.ok and out.sqlstate == "23514"
        assert current(t, "unit_trail_2") is None


# ── roster ──────────────────────────────────────────────────────────────────

def make_admin(t, sc):
    t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [sc.dana.uid, sc.dana.email])


def member_id(t, email):
    return t.sup("select id from public.app_members where lower(email) = lower(%s)", [email])[0][0]


def test_an_owner_adds_changes_and_removes_members_with_both_records(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        added = s.value("select public.owner_add_member('  New.Person@X.test ', 'editor', 'joined the team')")
        assert added["ok"] is True and added["email"] == "new.person@x.test" and added["role"] == "editor"
        mid = added["member_id"]
        assert s.value("select public.owner_set_member_role(%s, 'viewer')", [mid])["role"] == "viewer"
        assert s.value("select public.owner_set_member_role(%s, 'viewer')", [mid])["unchanged"] is True
        assert s.value("select public.owner_remove_member(%s, 'left')", [mid])["removed_role"] == "viewer"
        assert t.sup("select count(*) from public.app_members where id = %s", [mid])[0][0] == 0
        assert [a[0] for a in audits(t, "member.add") + audits(t, "member.role") + audits(t, "member.remove")] == [
            "member.add", "member.role", "member.remove"]
        assert audits(t, "member.add")[0][4]["reason"] == "joined the team" and audits(t, "member.add")[0][2] == sc.operator.email
        assert [e[0] for e in events(t, "member.%")] == ["member.add", "member.role", "member.remove"]
        # the trigger saw the facts too
        assert [e[0] for e in events(t, "roster.%", "new.person@x.test")] == ["roster.add", "roster.role", "roster.remove"]


def test_the_audit_names_match_what_the_operator_bot_alerts_on(conn, sc):
    bot = (REPO / "modules" / "operator_bot" / "sources.py").read_text(encoding="utf-8")
    prefixes = re.search(r"SECURITY_AUDIT_PREFIXES = \(([^)]*)\)", bot).group(1)
    actions = re.search(r"SECURITY_AUDIT_ACTIONS = \(([^)]*)\)", bot).group(1)
    assert '"member."' in prefixes  # member.add / member.role / member.remove are covered by the prefix
    for name in ("credits.grant", "credits.reverse", "credits.price", "security.gate"):
        assert f'"{name}"' in actions, name
    # and every audit row an owner function writes is a name the bot looks for (and has no channel)
    with tx(conn) as t:
        s = t.as_(sc.operator)
        grant(s, sc.bob.org, 5, "key-bot-000001")
        price(s, "unit_bot_1", 1, 0)
        s.value("select public.owner_add_member('bot@x.test', 'viewer')")
        rows = t.sup("select action, channel_id from public.app_audit_log where actor_user_id = %s", [sc.operator.uid])
        written = {r[0] for r in rows if r[0] in ("credits.grant", "credits.price", "member.add")}
        assert written == {"credits.grant", "credits.price", "member.add"}
        assert all(r[1] is None for r in rows if r[0] in written)
        assert all(f'"{a}"' in actions or a.startswith("member.") for a in written)


@pytest.mark.parametrize("email", ["", "plain", "a@b", "@x.test", "a b@x.test", "a@@x.test", "x" * 250 + "@x.test", None])
def test_a_bad_address_is_refused(conn, sc, email):
    with tx(conn) as t:
        assert t.as_(sc.operator).value("select public.owner_add_member(%s, 'viewer')", [email])["error"] == "bad_email"


def test_bad_roles_and_duplicates_and_missing_people_are_answers(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        for role in (None, "", "root", "OWNER", "owner "):
            assert s.value("select public.owner_add_member('role@x.test', %s)", [role])["error"] == "bad_role"
        assert s.value("select public.owner_add_member('dup@x.test', 'viewer')")["ok"] is True
        assert s.value("select public.owner_add_member('DUP@x.test', 'editor')")["error"] == "already_member"
        assert s.value("select public.owner_add_member(%s, 'viewer')", [sc.operator.email])["error"] == "already_member"
        mid = member_id(t, "dup@x.test")
        assert s.value("select public.owner_set_member_role(%s, 'root')", [mid])["error"] == "bad_role"
        assert s.value("select public.owner_set_member_role(gen_random_uuid(), 'viewer')")["error"] == "no_such_member"
        assert s.value("select public.owner_set_member_role(null, 'viewer')")["error"] == "no_such_member"
        assert s.value("select public.owner_remove_member(gen_random_uuid())")["error"] == "no_such_member"


def test_only_an_owner_mints_or_touches_admins_and_owners(conn, sc):
    with tx(conn) as t:
        make_admin(t, sc)
        t.sup("insert into public.app_members (email, role) values ('target-editor@x.test', 'editor') returning 1")
        t.sup("insert into public.app_members (email, role) values ('target-admin@x.test', 'admin') returning 1")
        editor, other_admin = member_id(t, "target-editor@x.test"), member_id(t, "target-admin@x.test")
        owner_row = member_id(t, sc.operator.email)
        s = t.as_(sc.dana)  # an admin
        assert s.value("select public.owner_add_member('x1@x.test', 'viewer')")["ok"] is True
        assert s.value("select public.owner_add_member('x2@x.test', 'editor')")["ok"] is True
        for role in ("admin", "owner"):
            assert s.value("select public.owner_add_member('x3@x.test', %s)", [role])["error"] == "owner_required"
            assert s.value("select public.owner_set_member_role(%s, %s)", [editor, role])["error"] == "owner_required"
        assert s.value("select public.owner_set_member_role(%s, 'editor')", [other_admin])["error"] == "owner_required"
        assert s.value("select public.owner_set_member_role(%s, 'viewer')", [owner_row])["error"] == "owner_required"
        assert s.value("select public.owner_remove_member(%s)", [other_admin])["error"] == "owner_required"
        assert s.value("select public.owner_remove_member(%s)", [owner_row])["error"] == "owner_required"
        assert s.value("select public.owner_set_member_role(%s, 'viewer')", [editor])["ok"] is True  # an admin may manage editors/viewers
        assert s.value("select public.owner_remove_member(%s)", [editor])["ok"] is True
        # an owner can do all of it
        o = t.as_(sc.operator)
        assert o.value("select public.owner_set_member_role(%s, 'editor')", [other_admin])["ok"] is True
        assert o.value("select public.owner_add_member('x4@x.test', 'admin')")["ok"] is True
        assert o.value("select public.owner_add_member('x5@x.test', 'owner')")["ok"] is True


def test_nobody_changes_or_removes_themselves(conn, sc):
    with tx(conn) as t:
        make_admin(t, sc)
        me, dana = member_id(t, sc.operator.email), member_id(t, sc.dana.email)
        o = t.as_(sc.operator)
        assert o.value("select public.owner_set_member_role(%s, 'viewer')", [me])["error"] == "self_change"
        assert o.value("select public.owner_set_member_role(%s, 'owner')", [me])["error"] == "self_change"
        assert o.value("select public.owner_remove_member(%s)", [me])["error"] == "self_change"
        d = t.as_(sc.dana)
        assert d.value("select public.owner_set_member_role(%s, 'viewer')", [dana])["error"] == "self_change"
        assert d.value("select public.owner_remove_member(%s)", [dana])["error"] == "self_change"
        assert t.sup("select role from public.app_members where id = %s", [me])[0][0] == "owner"


def test_the_last_confirmed_owner_cannot_be_demoted_or_removed(conn, sc):
    with tx(conn) as t:
        # a second owner exists, but only by an unconfirmed address ... and a pending invite does not count either
        t.sup("update auth.users set email_confirmed_at = null where id = %s", [sc.operator.uid])
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner') returning 1", [sc.dana.uid, sc.dana.email])
        t.sup("insert into public.app_members (email, role) values ('pending-owner@x.test', 'owner') returning 1")
        dana = member_id(t, sc.dana.email)
        o = t.as_(sc.operator)  # a bound owner whose address is not confirmed
        out = o.value("select public.owner_set_member_role(%s, 'admin')", [dana])
        assert out["ok"] is False and out["error"] == "last_owner", out
        assert o.value("select public.owner_remove_member(%s)", [dana])["error"] == "last_owner"
        assert t.sup("select role from public.app_members where id = %s", [dana])[0][0] == "owner"
        # with a confirmed second owner the first can step the other down
        t.sup("update auth.users set email_confirmed_at = now() where id = %s", [sc.operator.uid])
        assert t.as_(sc.operator).value("select public.owner_set_member_role(%s, 'admin')", [dana])["ok"] is True


def test_a_second_confirmed_owner_can_be_removed_by_the_first(conn, sc):
    with tx(conn) as t:
        t.sup("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner') returning 1", [sc.dana.uid, sc.dana.email])
        out = t.as_(sc.operator).value("select public.owner_remove_member(%s)", [member_id(t, sc.dana.email)])
        assert out["ok"] is True and out["removed_role"] == "owner"
        assert t.sup("select count(*) from public.app_members where role = 'owner'")[0][0] == 1


def test_the_roster_functions_do_not_open_the_empty_roster_bootstrap(conn, sc):
    with tx(conn) as t:
        t.sup("delete from public.app_members")
        # nobody is a platform admin on an empty roster except a default-org member: the operator is one
        out = t.as_(sc.operator).value("select public.owner_set_member_role(gen_random_uuid(), 'viewer')")
        assert out["error"] == "no_such_member"
        assert t.as_(sc.bob.actor).run("select public.owner_add_member('x@x.test', 'owner')").sqlstate == "42501"


def test_roster_changes_wait_for_each_other(conn, sc):
    other = psycopg.connect(conn.info.dsn)
    try:
        other.execute("select pg_advisory_xact_lock(hashtext('nightshift.owner'), hashtext('roster'))")
        with tx(conn) as t:
            t.conn.execute("set local lock_timeout = '300ms'")
            out = t.as_(sc.operator).run("select public.owner_add_member('lock@x.test', 'viewer')")
        assert not out.ok and out.sqlstate == "55P03"
    finally:
        other.rollback()
        other.close()


def test_the_direct_roster_paths_are_unchanged_while_dormant(conn, sc):
    # The Team page still writes app_members straight from the browser; 0107 adds no guard there.
    with tx(conn) as t:
        s = t.as_(sc.operator)
        assert s.run("insert into public.app_members (email, role) values ('direct@x.test', 'admin')").ok
        assert s.run("update public.app_members set role = 'viewer' where email = 'direct@x.test'").ok
        assert s.run("delete from public.app_members where email = 'direct@x.test'").ok
        assert [e[0] for e in events(t, "roster.%", "direct@x.test")] == ["roster.add", "roster.role", "roster.remove"]
        add = events(t, "roster.add", "direct@x.test")[0]
        assert add[1] == "critical" and add[2] == sc.operator.uid and add[3] == sc.operator.email and add[4] == "direct@x.test"
        assert t.as_(sc.bob.actor).run("insert into public.app_members (email, role) values ('x@x.test', 'viewer')").sqlstate == "42501"


def test_binding_an_invitation_is_logged_quietly(conn, sc):
    with tx(conn) as t:
        t.sup("insert into public.app_members (email, role) values (%s, 'viewer') returning 1", [sc.stranger.email])
        t.as_(sc.stranger).value("select public.bind_current_member()")
        bind = events(t, "roster.bind", sc.stranger.email)
        assert len(bind) == 1 and bind[0][1] == "info" and bind[0][2] == sc.stranger.uid


# ── the security trail ──────────────────────────────────────────────────────

def test_the_trail_is_append_only_for_everyone_including_the_owner_role(conn):
    with tx(conn) as t:
        t.sup("select public.security_event_log('probe', 'info', 'x', '{}')")
        t.sup("insert into public.credit_price_history (unit, action) values ('probe_unit', 'set') returning 1")
        for stmt in ("update public.security_events set kind = 'x'", "delete from public.security_events",
                     "truncate public.security_events",
                     "update public.credit_price_history set unit = 'x'", "delete from public.credit_price_history",
                     "truncate public.credit_price_history"):
            out = t.s.run(stmt)
            assert not out.ok and out.sqlstate == "42501" and "append-only" in out.error, (stmt, out)
        assert t.sup("select count(*) from public.security_events where kind = 'probe'")[0][0] == 1


def test_security_events_checks_its_columns(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.run("insert into public.security_events (kind, severity) values ('k', 'loud')").sqlstate == "23514"
        assert s.run("insert into public.security_events (kind) values ('')").sqlstate == "23514"
        assert s.run("insert into public.security_events (kind, detail) values ('k', '[]')").sqlstate == "23514"
        assert s.run("insert into public.security_events (kind, detail) values ('k', %s::jsonb)",
                     [json.dumps({"x": "y" * 5000})]).sqlstate == "23514"


def test_the_admin_reads_the_newest_events_first_with_a_clamped_limit(conn, sc):
    with tx(conn) as t:
        for i in range(7):
            t.sup("select public.security_event_log(%s, 'info', 'x', '{}')", [f"probe.{i}"])
        s = t.as_(sc.operator)
        rows = s.value("select public.owner_security_events(3)")
        assert [r["kind"] for r in rows] == ["probe.6", "probe.5", "probe.4"]
        assert len(s.value("select public.owner_security_events(0)")) == 1
        assert len(s.value("select public.owner_security_events(-5)")) == 1
        assert len(s.value("select public.owner_security_events(null)")) <= 100
        assert len(s.value("select public.owner_security_events(100000)")) <= 500
        assert set(rows[0]) == {"id", "at", "kind", "severity", "actor_user_id", "actor_email", "actor_role", "target", "detail"}


def test_the_actor_is_the_sessions_answer_not_an_argument(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.operator)
        grant(s, sc.bob.org, 5, "key-actor-0001")
        row = t.sup("select actor_user_id, actor_email, actor_role from public.security_events where kind = 'credits.grant'")[0]
        assert (str(row[0]), row[1], row[2]) == (sc.operator.uid, sc.operator.email, "authenticated")


def test_the_audit_list_keeps_every_0093_action_and_adds_exactly_seven(conn):
    old = (REPO / "supabase" / "migrations" / "0093_mcp_oauth.sql").read_text(encoding="utf-8")
    block = re.search(r"create or replace function public\.audit_action_allowed.*?any \(array\[(.*?)\]::text\[\]\)", old, re.S).group(1)
    old_actions = set(re.findall(r"'([a-z_.]+)'", block))
    new = MIGRATION.read_text(encoding="utf-8")
    block = re.search(r"create or replace function public\.audit_action_allowed.*?any \(array\[(.*?)\]::text\[\]\)", new, re.S).group(1)
    new_actions = set(re.findall(r"'([a-z_.]+)'", block))
    assert new_actions - old_actions == {"credits.grant", "credits.reverse", "credits.price", "member.add", "member.role",
                                         "member.remove", "security.gate"}
    assert old_actions <= new_actions
    with as_superuser(conn, commit=False) as s:
        for a in sorted(new_actions) + ["social.instagram.connect", "learning.approve"]:
            assert s.value("select public.audit_action_allowed(%s)", [a]) is True, a
        for a in ("credits.steal", "member.promote", "security", "", None, "Credits.grant"):
            assert s.value("select public.audit_action_allowed(%s)", [a]) is False, a


def test_a_customer_cannot_forge_an_owner_audit_row(conn, sc):
    # The new names are in the audit list, which the stamp trigger holds the browser roles to. What a
    # customer still cannot do (0008 / 0033 / 0087, unchanged): write as someone else, or write a row
    # with no channel (those are the operator's own stream, which the bot and the Audit page read).
    # What they could always do, and still can, is add a row about THEIR OWN channel.
    with tx(conn) as t:
        s = t.as_(sc.bob.actor)
        forged = s.run("insert into public.app_audit_log (actor_user_id, action, channel_id) values (%s, 'credits.grant', null)", [sc.operator.uid])
        assert not forged.ok and forged.sqlstate == "42501", forged
        global_row = s.run("insert into public.app_audit_log (actor_user_id, action, channel_id) values (%s, 'member.add', null)", [sc.bob.actor.uid])
        assert not global_row.ok and global_row.sqlstate == "42501", global_row
        own = s.run("insert into public.app_audit_log (actor_user_id, action, channel_id) values (%s, 'member.add', %s)", [sc.bob.actor.uid, sc.bob.channel])
        assert own.ok  # about his own channel only, stamped with his own address
        assert t.sup("select count(*) from public.app_audit_log where action = 'member.add' and channel_id is null")[0][0] == 0


def test_the_migration_replays_without_changing_state(conn, sc):
    text = MIGRATION.read_text(encoding="utf-8")
    with tx(conn) as t:
        set_caps(t, grant_max_per_call=7)
        gate_on(t)
        before = t.sup("select count(*) from public.security_events")[0][0]
        t.conn.execute(text)
        row = t.sup("select admin_aal2_required, grant_max_per_call from public.owner_security_settings")
        assert row == [(True, 7)]  # the seed is ON CONFLICT DO NOTHING
        assert t.sup("select count(*) from public.security_events")[0][0] == before
        assert t.as_(sc.operator).value("select public.owner_security_get()")["ok"] is True


def test_the_function_acls_survive_a_replay(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    with tx(conn) as t:
        t.conn.execute(text)
        for fn in ("owner_grant_credits(uuid,numeric,text,text)", "owner_set_credit_price(text,numeric,numeric,text,text,boolean)",
                   "admin_aal_ok()", "enable_admin_mfa()"):
            assert t.sup("select has_function_privilege('authenticated', %s, 'EXECUTE')", ["public." + fn])[0][0] is True
            assert t.sup("select has_function_privilege('anon', %s, 'EXECUTE')", ["public." + fn])[0][0] is False
            assert t.sup("select has_function_privilege('service_role', %s, 'EXECUTE')", ["public." + fn])[0][0] is False


def test_no_api_role_can_execute_a_trigger_function_of_the_migration(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    names = sorted(set(re.findall(r"create or replace function public\.(\w+)\([^)]*\)\s+returns trigger", text)))
    assert len(names) >= 6, names
    with as_superuser(conn, commit=False) as s:
        for n in names:
            for role in ("anon", "authenticated", "service_role"):
                assert s.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [role, f"public.{n}()"]) is False, (n, role)


def test_the_rollback_file_removes_exactly_what_the_migration_added_and_the_migration_comes_back(conn, sc):
    rollback = (REPO / "docs" / "sql" / "rollback_0107_owner_safety.sql").read_text(encoding="utf-8")
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    assert "begin;" in rollback and "commit;" in rollback
    with tx(conn) as t:
        before_fn = {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")}
        t.conn.execute(body)
        after_fn = {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")}
        added = set(re.findall(r"create or replace function public\.(\w+)", MIGRATION.read_text(encoding="utf-8"))) - {"audit_action_allowed"}
        assert before_fn - after_fn == added, (sorted(before_fn - after_fn ^ added))
        assert t.sup("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in "
                     "('owner_security_settings', 'security_events', 'credit_price_history')")[0][0] == 0
        assert t.sup("select count(*) from pg_trigger where not tgisinternal and tgname in "
                     "('app_members_security_trail', 'credit_prices_security_trail')")[0][0] == 0
        assert t.sup("select public.audit_action_allowed('credits.grant'), public.audit_action_allowed('mcp.limit')")[0] == (False, True)
        # the old paths still work with the trails gone
        s = t.as_(sc.operator)
        assert s.run("insert into public.credit_prices (unit, credits_per_unit) values ('unit_rb_1', 1)").ok
        assert s.run("insert into public.app_members (email, role) values ('rb@x.test', 'viewer')").ok
        # and applying the migration again restores everything
        t.conn.execute("reset role")
        t.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")} == before_fn
        assert t.sup("select public.audit_action_allowed('credits.grant')")[0][0] is True
        assert t.as_(sc.operator).value("select public.owner_security_get()")["ok"] is True
