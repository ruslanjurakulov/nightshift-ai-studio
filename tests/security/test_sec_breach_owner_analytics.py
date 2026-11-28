"""Breach: attacks on the owner analytics gate (migration 0182) that test_sec_owner_analytics.py does not already name.

The gate is platform_role() = 'owner'. Every attack here tries to be that, or to reach the data around it, without being it:
a JWT whose e-mail claim matches an unbound OWNER row on the roster, an unconfirmed account with that address, a platform
admin rewriting the roster under the gate, the service role carrying the owner's uid, an API role wrapping the internal
sales reader in its own view or temp function, and every direct write to the export log (including by the owner, whose
audit trail would otherwise be theirs to edit). Every world is rolled back.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from sec_db import SERVICE, Actor, acting, as_superuser, user

FROM = datetime(2026, 1, 1, tzinfo=timezone.utc)
TO = datetime(2027, 1, 1, tzinfo=timezone.utc)

IS_OWNER = "select public.owner_analytics_is_owner()"
MONEY = "select * from public.owner_analytics_money(%s, %s)"
PEOPLE = "select * from public.owner_analytics_people()"
LOG = "select * from public.owner_analytics_export_log(%s)"
RECORD = "select public.owner_analytics_record_export(%s, %s, %s, %s, %s)"

READS = [(MONEY, [FROM, TO]), (PEOPLE, None), (LOG, [5])]


def _refused_everywhere(conn, who: Actor):
    with acting(conn, who) as s:
        owner = s.run(IS_OWNER)
        outs = [s.run(q, p) for q, p in READS]
    assert owner.ok and owner.rows == [(False,)], owner
    for out in outs:
        assert not out.ok and out.sqlstate == "42501", out
        # One message for every refusal: the error text says nothing about why, or what the function would have read.
        assert out.error == "not available", out


# ── forged identity ─────────────────────────────────────────────────────────

def test_an_email_claim_matching_an_unbound_owner_invite_is_not_the_owner(conn, sc):
    # An owner invited by address (owner_add_member writes user_id null). A JWT carrying that address in its `email` claim,
    # for an account that does not exist in auth.users, must not inherit the role: platform_role() reads the CONFIRMED
    # address from auth.users (0043), never the claim.
    boss = "boss-oabreach@example.test"
    with as_superuser(conn, commit=False):
        conn.execute("insert into public.app_members (email, role) values (%s, 'owner')", [boss])
        _refused_everywhere(conn, user("ghost", boss))
        # An account that exists with that address, but never confirmed it, is not the owner either.
        unconfirmed = user("unconfirmed", boss)
        conn.execute("reset role")
        conn.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, null)", [unconfirmed.uid, boss])
        _refused_everywhere(conn, unconfirmed)
        # And a confirmed account with a DIFFERENT address, whose claim was edited to the owner's, is not either.
        other = user("other", boss)
        conn.execute("reset role")
        conn.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())",
                     [other.uid, "other-oabreach@example.test"])
        _refused_everywhere(conn, other)


def test_the_service_role_carrying_the_owners_uid_is_refused(conn, sc):
    # A leaked service key with a forged `sub`: execute is revoked from service_role, so the uid it carries never matters.
    forged = Actor("service-as-owner", "service_role", sc.operator.uid, sc.operator.email)
    with acting(conn, forged) as s:
        for q, p in READS + [(IS_OWNER, None), (RECORD, ["revenue", "csv", FROM, TO, False])]:
            out = s.run(q, p)
            assert not out.ok and out.sqlstate == "42501", (q, out)


def test_anon_carrying_the_owners_uid_is_refused(conn, sc):
    forged = Actor("anon-as-owner", "anon", sc.operator.uid, sc.operator.email)
    with acting(conn, forged) as s:
        for q, p in READS + [(IS_OWNER, None)]:
            out = s.run(q, p)
            assert not out.ok and out.sqlstate == "42501", (q, out)


# ── an admin climbing to the gate ───────────────────────────────────────────

def test_a_platform_admin_cannot_rewrite_the_roster_to_pass_the_gate(conn, sc):
    admin = user("oab-admin", "oab-admin@example.test")
    with as_superuser(conn, commit=False):
        conn.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [admin.uid, admin.email])
        conn.execute("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin')", [admin.uid, admin.email])
        conn.execute("select set_config('request.jwt.claims', %s, true)",
                     ['{"role":"authenticated","sub":"%s","email":"%s"}' % (admin.uid, admin.email)])
        conn.execute("set local role authenticated")
        from sec_db import Session
        s = Session(conn)
        attempts = [
            ("update public.app_members set role = 'owner' where user_id = %s", [admin.uid]),
            ("insert into public.app_members (user_id, email, role) values (%s, 'oab-admin2@example.test', 'owner')", [admin.uid]),
            ("insert into public.app_members (email, role) values (%s, 'owner')", [admin.email.upper()]),
            ("select public.owner_add_member(%s, 'owner')", ["oab-admin@example.test"]),
            ("select public.owner_set_member_role((select id from public.app_members where user_id = %s), 'owner')", [admin.uid]),
            # Move the real owner's row onto the admin's account.
            ("update public.app_members set user_id = %s where user_id = %s", [admin.uid, sc.operator.uid]),
        ]
        for q, p in attempts:
            s.run(q, p)
        owner = s.run(IS_OWNER)
        money = s.run(MONEY, [FROM, TO])
    assert owner.ok and owner.rows == [(False,)], owner
    assert not money.ok and money.sqlstate == "42501", money


# ── the internal sales reader, wrapped ──────────────────────────────────────

@pytest.mark.parametrize("who", ["operator", "alice", "service"])
def test_no_api_role_reaches_the_sales_reader_through_its_own_wrapper(conn, sc, who):
    actor = {"operator": sc.operator, "alice": sc.alice.actor, "service": SERVICE}[who]
    wrappers = [
        "create view public.oab_sales as select * from public.owner_analytics_sales_all()",
        "create temp view oab_sales as select * from public.owner_analytics_sales_all()",
        "create function public.oab_sales() returns setof record language sql security definer as "
        "$$ select * from public.owner_analytics_sales_all() $$",
        "create function pg_temp.oab_sales() returns bigint language sql as $$ select count(*) from public.owner_analytics_sales_all() $$",
    ]
    with acting(conn, actor) as s:
        for ddl in wrappers:
            made = s.run(ddl)
            if made.ok:
                # Created: calling it must still be refused, since the wrapper runs as the API role that made it.
                read = s.run("select count(*) from oab_sales" if "view" in ddl else "select pg_temp.oab_sales()"
                             if "pg_temp" in ddl else "select count(*) from public.oab_sales() as t(a text)")
                assert not read.ok and read.sqlstate == "42501", (ddl, read)
            else:
                assert made.sqlstate in ("42501", "42P13", "0A000"), (ddl, made)


def test_a_temp_function_cannot_shadow_the_gate(conn, sc):
    # pg_temp is last on the pinned search_path, and the gate is called schema-qualified, so a temp
    # owner_analytics_is_owner() / platform_role() that says yes is never the one the reads call.
    with acting(conn, sc.alice.actor) as s:
        s.run("create function pg_temp.owner_analytics_is_owner() returns boolean language sql as $$ select true $$")
        s.run("create function pg_temp.platform_role() returns text language sql as $$ select 'owner'::text $$")
        s.run("create temp table app_members (user_id uuid, email text, role text)")
        s.run("insert into pg_temp.app_members values (%s, %s, 'owner')", [sc.alice.actor.uid, sc.alice.actor.email])
        out = s.run(MONEY, [FROM, TO])
        gate = s.run(IS_OWNER)
    assert not out.ok and out.sqlstate == "42501", out
    assert gate.ok and gate.rows == [(False,)], gate


def test_no_api_role_can_create_in_public(conn, sc):
    # Every definer here pins search_path = public, pg_temp. If an API role could CREATE in public it could plant an
    # operator or function the definers resolve; the lab mirrors Supabase in giving USAGE only.
    with as_superuser(conn, commit=False) as su:
        rows = su.rows("select r, has_schema_privilege(r, 'public', 'CREATE') from unnest(array['anon','authenticated','service_role']) r")
    assert all(not ok for _, ok in rows), rows


# ── the export log: forged, read, rewritten, erased ─────────────────────────

@pytest.mark.parametrize("who", ["operator", "alice", "service"])
def test_nobody_rewrites_or_erases_the_export_log_directly(conn, sc, who):
    # The owner included: an audit trail its subject can edit is not an audit trail.
    actor = {"operator": sc.operator, "alice": sc.alice.actor, "service": SERVICE}[who]
    with acting(conn, actor) as s:
        outs = [
            s.run("update public.owner_analytics_exports set actor_user_id = %s", [str(uuid.uuid4())]),
            s.run("delete from public.owner_analytics_exports"),
            s.run("truncate public.owner_analytics_exports"),
            s.run("select count(*) from public.owner_analytics_exports"),
            s.run("alter table public.owner_analytics_exports disable row level security"),
        ]
    for out in outs:
        assert not out.ok and out.sqlstate == "42501", (who, out)


def test_the_owner_cannot_record_an_export_in_another_name(conn, sc):
    # The actor is auth.uid(); there is no argument for it, and a stray e-mail claim changes nothing.
    claims = Actor("operator-with-alices-email", "authenticated", sc.operator.uid, sc.alice.actor.email)
    with acting(conn, claims) as s:
        rid = s.value(RECORD, ["revenue.events", "csv", FROM, TO, False])
        log = s.rows(LOG, [1])
        named = s.run("select public.owner_analytics_record_export(p_what => 'x', p_format => 'csv', p_from => %s, "
                      "p_to => %s, p_present => false, actor_user_id => %s)", [FROM, TO, sc.alice.actor.uid])
    assert log[0][0] == rid and str(log[0][1]) == sc.operator.uid, log
    assert not named.ok and named.sqlstate == "42883", named


def test_a_customer_learns_nothing_from_the_export_log_limit(conn, sc):
    # The limit is the only argument the log reader takes; a customer gets the same refusal for every value.
    with acting(conn, sc.alice.actor) as s:
        outs = [s.run(LOG, [v]) for v in (None, -1, 0, 10**9)]
    assert all(not o.ok and o.sqlstate == "42501" and o.error == "not available" for o in outs), outs


# ── internal / test workspaces (owner_analytics_internal_orgs) ──────────────

SET_INTERNAL = "select public.owner_analytics_set_internal(%s, %s, %s)"
INTERNAL_LIST = "select * from public.owner_analytics_internal_list()"


def _has_internal_orgs(conn) -> bool:
    with as_superuser(conn, commit=False) as su:
        return su.value("select to_regprocedure('public.owner_analytics_set_internal(uuid, boolean, text)') is not null")


@pytest.mark.parametrize("who", ["alice", "bob", "dana", "service"])
def test_nobody_but_the_owner_hides_a_workspace_from_the_figures(conn, sc, who):
    # Flagging a paying customer "internal" takes its revenue out of every figure by default: a customer hiding a rival's
    # sales (or its own refunds) from the owner's books is an integrity attack on what the owner presents.
    if not _has_internal_orgs(conn):
        pytest.skip("this 0182 has no internal-workspace flag")
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "dana": sc.dana, "service": SERVICE}[who]
    with acting(conn, actor) as s:
        flag = s.run(SET_INTERNAL, [sc.bob.org, True, "test account"])
        own = s.run(SET_INTERNAL, [sc.alice.org, True, "test account"])
        bad = s.run(SET_INTERNAL, [None, None, None])
        lst = s.run(INTERNAL_LIST)
        direct = [
            s.run("insert into public.owner_analytics_internal_orgs (org_id, reason, flagged_by) values (%s, 'x', %s)",
                  [sc.bob.org, sc.operator.uid]),
            s.run("select * from public.owner_analytics_internal_orgs"),
            s.run("delete from public.owner_analytics_internal_orgs"),
            s.run("select * from public.owner_analytics_internal_org_ids()"),
        ]
    for out in [flag, own, bad, lst] + direct:
        assert not out.ok and out.sqlstate == "42501", (who, out)


def test_the_owners_flag_is_recorded_in_the_owners_own_name(conn, sc):
    if not _has_internal_orgs(conn):
        pytest.skip("this 0182 has no internal-workspace flag")
    with acting(conn, sc.operator) as s:
        assert s.value(SET_INTERNAL, [sc.bob.org, True, "QA workspace"]) is True
        nobody = s.run(SET_INTERNAL, [str(uuid.uuid4()), True, "x"])
        s.conn.execute("reset role")
        row = s.rows("select flagged_by from public.owner_analytics_internal_orgs where org_id = %s", [sc.bob.org])
    assert str(row[0][0]) == sc.operator.uid
    assert not nobody.ok and nobody.sqlstate == "22023", nobody


# ── the platform's own second-factor gate (0107) ────────────────────────────

def _owner_at_aal1(conn, sc):
    """The owner switched on 0107's admin MFA gate and has a verified factor; this session proved only a password
    (aal1), e.g. a phished password without the authenticator. Every owner ACTION refuses it (owner_guard)."""
    conn.execute("update public.owner_security_settings set admin_aal2_required = true")
    conn.execute("insert into auth.mfa_factors (user_id, status) values (%s, 'verified')", [sc.operator.uid])
    import json
    import time
    claims = {"role": "authenticated", "sub": sc.operator.uid, "email": sc.operator.email, "aal": "aal1",
              "amr": [{"method": "password", "timestamp": int(time.time()) - 30}]}
    conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
    conn.execute("set local role authenticated")
    from sec_db import Session
    return Session(conn)


def test_with_the_mfa_gate_on_a_password_only_owner_session_cannot_take_an_export(conn, sc):
    # BREACH FINDING (medium). 0107 made the second factor "the common front door of every owner action" (owner_guard):
    # with admin_aal2_required on, an aal1 owner session cannot grant a credit or change a price. 0182's export audit
    # (the step that lets every payment and every person leave as a file) never asks admin_aal_ok(), and the route's
    # "recent sign-in" check accepts a password amr. So a phished owner password, without the authenticator, exports the
    # whole revenue ledger. Expected: refused (42501 or an mfa_required answer) until the session is aal2.
    with as_superuser(conn, commit=False):
        s = _owner_at_aal1(conn, sc)
        guard = s.value("select public.admin_aal_ok()")
        rec = s.run(RECORD, ["revenue.events", "csv", FROM, TO, False])
    assert guard is False, "lab precondition: 0107 itself says this session may not act as owner"
    assert not rec.ok, f"an aal1 owner session recorded an export with the MFA gate on: {rec!r}"


def test_with_the_mfa_gate_on_a_password_only_owner_session_cannot_change_what_counts_as_revenue(conn, sc):
    # BREACH FINDING (medium), same root cause: owner_analytics_set_internal is a WRITE that removes a workspace's sales from
    # every default figure, and it skips owner_guard (no second factor, no rate limit, no owner_audit trail entry).
    if not _has_internal_orgs(conn):
        pytest.skip("this 0182 has no internal-workspace flag")
    with as_superuser(conn, commit=False):
        s = _owner_at_aal1(conn, sc)
        out = s.run(SET_INTERNAL, [sc.bob.org, True, "hide this customer"])
    assert not out.ok, f"an aal1 owner session flagged a paying workspace internal with the MFA gate on: {out!r}"


def test_a_platform_admin_cannot_take_a_customers_revenue_out_of_the_owners_figures(conn, sc):
    # BREACH FINDING (low, integrity). The on-disk 0182 counts "any workspace owned by an account on the platform roster" as
    # internal. A platform ADMIN — refused from every analytics read — may still put any account on the roster as a viewer
    # (0007's app_members_admin_insert policy; owner_add_member allows admins to add viewers). Doing that to a paying
    # customer's owner silently reclassifies the customer's sales as internal, so they drop out of every default figure the
    # owner presents. Expected: an admin's roster edit does not change what the owner's books count as revenue (internal
    # should follow roster roles the owner controls, or only the owner's explicit flag).
    if not _has_internal_orgs(conn):
        pytest.skip("this 0182 has no internal-workspace flag")
    admin = user("oab-admin3", "oab-admin3@example.test")
    with as_superuser(conn, commit=False):
        conn.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [admin.uid, admin.email])
        conn.execute("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin')", [admin.uid, admin.email])
        conn.execute("insert into public.payment_events (provider, event_id, event_type, occurred_at, status, org_id, "
                     "transaction_id, credits, currency, amount_minor) values ('dodo', 'evt-oab-alice', 'payment.succeeded', "
                     "%s, 'processed', %s, 'pay_oabalice', 100, 'USD', 4900)", [datetime(2026, 10, 1, tzinfo=timezone.utc), sc.alice.org])

        def alice_internal():
            conn.execute("reset role")
            import json
            conn.execute("select set_config('request.jwt.claims', %s, true)",
                         [json.dumps({"role": "authenticated", "sub": sc.operator.uid, "email": sc.operator.email})])
            conn.execute("set local role authenticated")
            from sec_db import Session
            rows = Session(conn).rows("select payment_ref, internal from public.owner_analytics_money(%s, %s)", [FROM, TO])
            return {r[0]: r[1] for r in rows}["pay_oabalice"]

        before = alice_internal()
        import json
        from sec_db import Session, take_off_0233

        def admin_adds_alice():
            conn.execute("reset role")
            conn.execute("select set_config('request.jwt.claims', %s, true)",
                         [json.dumps({"role": "authenticated", "sub": admin.uid, "email": admin.email})])
            conn.execute("set local role authenticated")
            return Session(conn).run("insert into public.app_members (user_id, email, role) values (%s, %s, 'viewer')",
                                     [sc.alice.actor.uid, sc.alice.actor.email])

        # Since 0233 the attack's first step is refused outright: nobody writes the roster from a browser.
        refused = admin_adds_alice()
        # And were 0233 ever rolled back (here, inside this rolled-back transaction), the books still do not move.
        conn.execute("reset role")
        take_off_0233(conn)
        added = admin_adds_alice()
        after = alice_internal()
    assert before is False
    assert not refused.ok and refused.sqlstate == "42501", f"0233: an admin's roster write must be refused ({refused!r})"
    assert added.ok, f"lab precondition with 0233 off: an admin may add a viewer to the roster ({added!r})"
    assert after is False, "a platform admin's roster edit moved a paying customer's sale out of the owner's revenue"
