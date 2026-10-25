"""Migration 0127 (finding F4): a per-person and a platform-wide daily cap on series plans, enforced inside request_series_plan.

The attackers are the people a browser can be (an editor who owns or belongs to several organizations, a member of another organization, the anon
key, the service key where it should not reach), two presses at the same moment, and the file itself (a replay, a half-seen database, a body
somebody changed by hand). What must NOT change is checked beside every refusal: a refused request creates nothing, the organization's own cap
(0120) still answers first with its own word, and request_series_plan stays granted to nobody.

What would break without these:
  * a person making 10 organizations x 5 plans a day on the platform's shared model key (the cap counted per organization only);
  * the platform's daily quota being spent by a handful of accounts, each under its own limit;
  * two presses at the same moment both passing a cap (a person's two organizations take different organization locks);
  * a refusal that leaves a plan or a queue row behind, carries vendor text, or tells a customer how large the platform's quota is;
  * a cap counted from anything a client can write (the plan's creator, its time), or the owner's numbers writable by a member;
  * the migration replacing a body it has not seen, or running while the function is executable by an API role;
  * the rollback leaving a different body than 0122's, or lifting the caps from a function that was granted;
  * 0124 / 0125 / 0126 and this file disagreeing about the end state depending on the order they are applied in.

Everything runs on the shared scenario inside transactions that are rolled back, except the races (real concurrent transactions that clean up
after themselves) and the tests that need a database of their own (the order of the migrations); nothing calls a provider.
"""

from __future__ import annotations

import json
import re
import threading
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user
from test_sec_series_tables import (  # noqa: F401  (world is a fixture)
    SECS, RaceOrg, _dsn, become, become_claims, denied, finish, key, refused, backdate, world)
from test_sec_series_template import made, request_t

MIGRATION = sec_db.MIGRATION_0127
ROLLBACK = sec_db.ROLLBACK_0127
NEW = "public.request_series_plan(text,text,integer,text,integer,text,text,text)"
SHORT = "request_series_plan(text,text,integer,text,integer,text,text,text)"      # how regprocedure prints it with public on the search path
SETTINGS = "public.series_plan_cap_settings"
API_ROLES = ("anon", "authenticated", "service_role")

BEFORE_HASH = "e38342a6c8511d5eadb1f99ab38fb6aa"


def migration_body() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def rollback_body() -> str:
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def set_caps(s, user_cap=None, global_cap=None):
    """The owner's edit, in the SQL editor: the database owner, no API role."""
    become(s, None)
    if user_cap is not None:
        s.rows("update public.series_plan_cap_settings set user_daily_cap = %s returning 1", [user_cap])
    if global_cap is not None:
        s.rows("update public.series_plan_cap_settings set global_daily_cap = %s returning 1", [global_cap])


def plans_in_window(s):
    become(s, None)
    return s.value("select count(*) from public.series_plans where created_at > now() - interval '24 hours'")


def fill(s, org, n, *, by=None, channel="chan-a2", age="0 seconds"):
    """n finished (failed) plans, made in the last minute by ``by`` (a user id; a stranger if None), straight into the table: what the caps count."""
    become(s, None)
    by = by or str(uuid.uuid4())
    for _ in range(n):
        s.rows("insert into public.series_plans (org_id, channel_id, topic, niche, language, n_episodes, duration_s, status, error_code, "
               "idempotency_key, request_hash, requested_by, created_at, finished_at) values (%s, %s, 't', 'n', 'English', 3, 120, 'failed', 'x', %s, %s, %s, "
               "now() - %s::interval, now()) returning 1",
               [org, channel, f"fill-{uuid.uuid4().hex}", "c" * 32, by, age])


def snapshot(s):
    """Everything a refused request must leave exactly as it was."""
    become(s, None)
    return {"plans": s.value("select count(*) from public.series_plans"),
            "jobs": s.value("select count(*) from public.render_jobs where kind = 'series_plan'"),
            "holds": s.value("select count(*) from public.credit_reservations where created_at >= now() - interval '1 minute'"),
            "requested": s.value("select count(*) from public.series_plans where status = 'requested'")}


def acl(s):
    become(s, None)
    return s.value("select proacl::text from pg_proc where oid = %s::regprocedure", [NEW])


def defs(s, names=None):
    """A fingerprint of every function in public: its body, its privileges. For 'this file touches nothing else'."""
    become(s, None)
    rows = s.rows("select p.oid::regprocedure::text, md5(p.prosrc), coalesce(p.proacl::text, '') from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1")
    return {r[0]: (r[1], r[2]) for r in rows}


@pytest.fixture()
def capworld(world):
    """The shared world with the owner's numbers as the file ships them (the 0120 world raises them out of the way)."""
    s = world.su
    set_caps(s, 3, 30)
    become(s, None)
    # the platform-wide count includes whatever the lab database already holds from the last 24 hours (committed by other files); count it out
    # of the way by lifting the platform cap just above it, so a test about the person's cap meets the person's cap alone.
    world.base = plans_in_window(s)
    set_caps(s, None, world.base + 1000)
    world.ed2 = user("caps-ed2", "caps-ed2@a.test")
    become(s, None)
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [world.ed2.uid, world.ed2.email])
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor') returning 1", [world.org_a, world.ed2.uid, world.ed2.email])
    return world


def ask(s, who, channel, **kw):
    return request_t(s, who, channel, None, **kw)


def finished(s, who, channel, **kw):
    """A request that was accepted and then finished by the worker (so the channel is free again), returns the plan id."""
    out = ask(s, who, channel, **kw)
    assert out.ok, out
    plan = out.rows[0][0]["id"]
    done = finish(s, plan, ok=False, code="bad_shape", error="x")        # a failed plan still counts: the model call was spent
    assert done.ok, done
    become(s, None)
    return plan


# ═══ 1. nothing is granted ════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_function_is_still_granted_to_nobody_and_the_acl_is_exactly_what_it_was(conn, world):
    s = world.su
    become(s, None)
    assert s.value("select to_regprocedure(%s)", [NEW]) is not None
    assert s.value("select count(*) from pg_proc where proname = 'request_series_plan' and pronamespace = 'public'::regnamespace") == 1, "one door, not two"
    assert not any(s.value("select has_function_privilege(%s, %s::regprocedure, 'execute')", [r, NEW]) for r in API_ROLES)
    assert s.value("select proacl is not null from pg_proc where oid = %s::regprocedure", [NEW]), "a NULL ACL is the default, and the default includes PUBLIC"
    assert not s.value("select coalesce(bool_or(a.grantee = 0), false) from pg_proc p, aclexplode(p.proacl) a where p.oid = %s::regprocedure", [NEW])
    after = acl(s)
    sec_db.take_off_0127(s)
    assert acl(s) == after, "the ACL is the one 0122 left, not touched by 0127 (the owner alone, X/owner)"
    assert re.fullmatch(r"\{\w+=X/\w+\}", after), after


def test_no_api_role_can_call_it_and_a_refused_call_changes_nothing(conn, capworld):
    s = capworld.su
    before = snapshot(s)
    for who in (capworld.alice, capworld.adm, capworld.ed, capworld.bob, capworld.stranger, ANON, SERVICE):
        out = request_t(s, who, capworld.chan_a, None, claims=False)
        assert denied(out), (who.name, out)
    assert snapshot(s) == before


def test_every_function_except_request_series_plan_is_exactly_as_without_the_file_and_one_table_is_new(conn, world):
    s = world.su
    tables = lambda: {r[0] for r in s.rows("select tablename from pg_tables where schemaname = 'public'")}   # noqa: E731
    with_file, t_with = defs(s), tables()
    sec_db.take_off_0127(s)
    without, t_without = defs(s), tables()
    changed = {k for k in with_file.keys() | without.keys() if with_file.get(k) != without.get(k)}
    assert changed == {SHORT, "series_plan_cap_settings_guard()", "series_plan_cap_settings_trail()"}, sorted(changed)
    assert t_with - t_without == {"series_plan_cap_settings"} and not t_without - t_with
    # the two trigger functions are internal: nobody may call them
    sec_db.put_back_0127(s)
    become(s, None)
    for f in ("public.series_plan_cap_settings_guard()", "public.series_plan_cap_settings_trail()"):
        assert not any(s.value("select has_function_privilege(%s, %s::regprocedure, 'execute')", [r, f]) for r in API_ROLES), f


# ═══ 2. the person's cap ══════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_shipped_numbers_are_three_a_person_and_thirty_in_all(conn, world):
    s = world.su        # the 0120 world lifts the numbers out of the way: the seed itself is what is read, after taking the file off and putting it back
    sec_db.take_off_0127(s)
    sec_db.put_back_0127(s)      # a replay seeds `on conflict do nothing`; the table was dropped by the rollback, so this is the seed itself
    become(s, None)
    assert s.rows("select user_daily_cap, global_daily_cap from public.series_plan_cap_settings") == [(3, 30)]


def test_a_person_gets_three_plans_a_day_and_the_fourth_is_refused_by_name_with_nothing_created(conn, capworld):
    w, s = capworld, capworld.su
    for i, ch in enumerate((w.chan_a, w.chan_a2, w.chan_a3)):
        finished(s, w.ed, ch, idem=f"user-cap-{i:04d}")
    before = snapshot(s)
    out = ask(s, w.ed, w.chan_a)
    assert refused(out, "NS429", "series_user_cap"), out
    assert snapshot(s) == before, "a refusal creates no plan and no queue row"
    # the detail is the person's own number; the message is a closed word with no vendor text
    become_claims(s, w.ed)
    s.conn.execute("savepoint x")
    with pytest.raises(psycopg.Error) as e:
        s.conn.execute("select public.request_series_plan(%s, 't', 3, null, 120, null, %s)", [w.chan_a, key()])
    s.conn.execute("rollback to savepoint x")
    assert e.value.diag.message_primary == "series_user_cap" and e.value.diag.message_detail == "limit=3 per 24 hours", e.value.diag
    assert re.fullmatch(r"[a-z_]+", e.value.diag.message_primary) and not e.value.diag.message_hint
    # somebody else in the same organization still has their own three
    assert ask(s, w.ed2, w.chan_a).ok


def test_the_person_cap_follows_the_person_across_organizations(conn, capworld):
    """create_organization lets one account own ten: the organization's cap alone would let that person plan 50 times a day."""
    w, s = capworld, capworld.su
    become(s, None)
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor') returning 1", [w.org_b, w.ed.uid, w.ed.email])
    finished(s, w.ed, w.chan_a, idem="across-0001")
    finished(s, w.ed, w.chan_a2, idem="across-0002")
    finished(s, w.ed, w.chan_b, idem="across-0003")      # the third plan, in ANOTHER organization
    before = snapshot(s)
    for ch in (w.chan_a, w.chan_a3, w.chan_b):
        out = ask(s, w.ed, ch)
        assert refused(out, "NS429", "series_user_cap"), (ch, out)
    assert snapshot(s) == before
    # each organization's own count is far below its cap of five: the person's cap is what stopped it
    become(s, None)
    assert s.value("select count(*) from public.series_plans where org_id = %s and requested_by = %s and created_at > now() - interval '24 hours'", [w.org_a, w.ed.uid]) == 2


def test_a_failed_plan_counts_and_a_plan_older_than_a_day_does_not(conn, capworld):
    w, s = capworld, capworld.su
    first = finished(s, w.ed, w.chan_a, idem="window-0001")      # finished as failed: the model call was spent
    finished(s, w.ed, w.chan_a2, idem="window-0002")
    finished(s, w.ed, w.chan_a3, idem="window-0003")
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "series_user_cap")
    backdate(s, first, "23 hours 59 minutes")
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "series_user_cap"), "still inside the rolling day"
    backdate(s, first, "24 hours 1 minute")
    out = ask(s, w.ed, w.chan_a)
    assert out.ok, out
    assert refused(ask(s, w.ed, w.chan_a2), "NS429", "series_user_cap"), "and the person is at three again"


def test_a_replay_of_an_accepted_press_is_never_refused_by_a_cap(conn, capworld):
    w, s = capworld, capworld.su
    keep = ask(s, w.ed, w.chan_a, idem="replay-0001")
    assert keep.ok
    become(s, None)
    finish(s, keep.rows[0][0]["id"], ok=False, code="bad_shape", error="x")
    finished(s, w.ed, w.chan_a2, idem="replay-0002")
    finished(s, w.ed, w.chan_a3, idem="replay-0003")
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "series_user_cap")
    set_caps(s, 0, 0)       # even a paused platform answers a retry of a press it already accepted
    again = ask(s, w.ed, w.chan_a, idem="replay-0001")
    assert again.ok and again.rows[0][0]["replayed"] is True and again.rows[0][0]["id"] == keep.rows[0][0]["id"], again


def test_the_organization_cap_still_answers_first_with_its_own_word(conn, capworld):
    w, s = capworld, capworld.su
    set_caps(s, 3, w.base + 1000)
    fill(s, w.org_a, 5, by=w.ed2.uid)           # five plans in the organization (by other people): the organization is at its cap
    out = ask(s, w.ed, w.chan_a)
    assert refused(out, "NS429", "rate_limited"), "0120's word, not the new ones"
    set_caps(s, 0, 0)
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "rate_limited"), "the organization is checked before the person and the platform"


def test_the_person_is_checked_before_the_platform(conn, capworld):
    w, s = capworld, capworld.su
    fill(s, w.org_b, 3, by=w.ed.uid, channel=w.chan_b)
    set_caps(s, 3, plans_in_window(s))          # both at their caps
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "series_user_cap")
    assert refused(ask(s, w.ed2, w.chan_a), "NS429", "series_global_cap")


# ═══ 3. the platform's cap ════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_platform_cap_counts_every_organization_and_the_operators_own(conn, capworld):
    w, s = capworld, capworld.su
    set_caps(s, 1000, w.base + 4)
    fill(s, w.org_b, 2, channel=w.chan_b)
    fill(s, w.org_op, 1, channel=w.chan_op)
    assert ask(s, w.ed, w.chan_a).ok, "the fourth of four is the last that fits"
    before = snapshot(s)
    out = ask(s, w.bob, w.chan_b)
    assert refused(out, "NS429", "series_global_cap"), out
    assert snapshot(s) == before
    become_claims(s, w.bob)
    s.conn.execute("savepoint y")
    with pytest.raises(psycopg.Error) as e:
        s.conn.execute("select public.request_series_plan(%s, 't', 3, null, 120, null, %s)", [w.chan_b, key()])
    s.conn.execute("rollback to savepoint y")
    assert e.value.diag.message_primary == "series_global_cap" and e.value.diag.message_detail is None, "a customer is not told how big the platform's quota is"
    assert not e.value.diag.message_hint


def test_a_handful_of_people_each_under_their_own_limit_cannot_spend_the_platform(conn, capworld):
    w, s = capworld, capworld.su
    set_caps(s, 3, w.base + 6)
    for i in range(3):
        fill(s, w.org_b, 1, by=str(uuid.uuid4()), channel=w.chan_b)
    for i in range(3):
        fill(s, w.org_op, 1, by=str(uuid.uuid4()), channel=w.chan_op)
    # nobody here has made a plan of their own: every one of them is under three, and the platform is full
    for who, ch in ((w.ed, w.chan_a), (w.ed2, w.chan_a2), (w.adm, w.chan_a3)):
        assert refused(ask(s, who, ch), "NS429", "series_global_cap"), who.name


def test_at_thirty_the_default_platform_cap_binds_and_at_twenty_nine_it_does_not(conn, world):
    s = world.su
    become(s, None)
    s.rows("update public.series_plan_cap_settings set user_daily_cap = 3, global_daily_cap = 30 returning 1")
    base = plans_in_window(s)
    assert base <= 28, "the lab already holds too many plans from the last day for this test"
    fill(s, world.org_b, 29 - base, channel=world.chan_b)
    assert plans_in_window(s) == 29
    assert ask(s, world.ed, world.chan_a).ok
    assert refused(ask(s, world.adm, world.chan_a2), "NS429", "series_global_cap")


def test_the_platform_window_is_a_rolling_day_not_more_and_not_less(conn, capworld):
    w, s = capworld, capworld.su
    set_caps(s, 1000, w.base + 3)
    fill(s, w.org_b, 3, channel=w.chan_b, age="24 hours 5 minutes")
    assert ask(s, w.ed, w.chan_a).ok, "plans older than a day do not count"
    assert ask(s, w.ed2, w.chan_a2).ok
    fill(s, w.org_b, 1, channel=w.chan_b, age="23 hours 55 minutes")
    assert refused(ask(s, w.adm, w.chan_a3), "NS429", "series_global_cap"), "three inside the day: full"


def test_the_owner_can_pause_planning_with_zero(conn, capworld):
    w, s = capworld, capworld.su
    set_caps(s, 0, None)
    before = snapshot(s)
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "series_user_cap")
    set_caps(s, 3, 0)
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "series_global_cap")
    assert snapshot(s) == before
    set_caps(s, 3, w.base + 1000)
    assert ask(s, w.ed, w.chan_a).ok, "a number changed in the editor takes effect on the next request, with no deploy"


# ═══ 4. a refusal creates nothing, and nothing a client sends can move a cap ═════════════════════════════════════════════

def test_a_refused_request_rolls_back_the_expiry_sweep_it_ran_first(conn, capworld):
    w, s = capworld, capworld.su
    stale = ask(s, w.ed, w.chan_a3, idem="stale-0001")
    assert stale.ok
    backdate(s, stale.rows[0][0]["id"], "3 hours")
    for i, ch in enumerate((w.chan_a, w.chan_a2)):
        finished(s, w.ed, ch, idem=f"sweep-{i:04d}")
    out = ask(s, w.ed, w.chan_a)          # this person now has three in the window (the stale one counts): refused
    assert refused(out, "NS429", "series_user_cap"), out
    become(s, None)
    assert s.value("select status from public.series_plans where id = %s", [stale.rows[0][0]["id"]]) == "requested", "the sweep ran inside the refused call and was rolled back with it"
    assert s.value("select status from public.render_jobs where series_plan_id = %s", [stale.rows[0][0]["id"]]) == "queued"


def test_a_bad_format_is_refused_by_its_own_word_before_the_caps(conn, capworld):
    w, s = capworld, capworld.su
    set_caps(s, 0, 0)
    out = request_t(s, w.ed, w.chan_a, "not-a-format")
    assert refused(out, "22023", "invalid_template"), out
    assert refused(request_t(s, w.ed, w.chan_a, "myth_vs_fact"), "NS429", "series_user_cap")


def test_a_stranger_and_a_viewer_get_the_old_answers_not_a_cap_word(conn, capworld):
    w, s = capworld, capworld.su
    set_caps(s, 0, 0)
    assert not_found_or_forbidden(ask(s, w.stranger, w.chan_a)), "a stranger learns nothing about caps"
    assert not_found_or_forbidden(ask(s, w.viewer, w.chan_a))


def not_found_or_forbidden(out):
    return not out.ok and (out.error in ("not_found", "forbidden")) and out.sqlstate in ("P0002", "42501")


def test_no_api_role_can_read_or_write_the_numbers_or_the_plans_that_are_counted(conn, capworld):
    w, s = capworld, capworld.su
    become(s, None)
    plan = finished(s, w.ed, w.chan_a, idem="tamper-0001")
    become(s, None)
    snap = s.rows("select id, requested_by, created_at from public.series_plans where id = %s", [plan])
    for who in (w.alice, w.adm, w.ed, w.viewer, w.bob, w.stranger, w.platform, ANON, SERVICE):
        become(s, who)
        for q in ("select * from public.series_plan_cap_settings",
                  "insert into public.series_plan_cap_settings (id, user_daily_cap, global_daily_cap) values (false, 1000, 10000)",
                  "update public.series_plan_cap_settings set user_daily_cap = 1000, global_daily_cap = 10000",
                  "delete from public.series_plan_cap_settings",
                  "truncate public.series_plan_cap_settings"):
            out = s.run(q)
            assert denied(out), (who.name, q, out)
        # the plans the caps count: no browser can change who made one, when, or remove it (RLS or privilege or the frozen-terms trigger)
        for q, args in (("update public.series_plans set requested_by = %s where id = %s", [str(uuid.uuid4()), plan]),
                        ("update public.series_plans set created_at = now() - interval '3 days' where id = %s", [plan]),
                        ("delete from public.series_plans where id = %s", [plan]),
                        ("insert into public.series_plans (org_id, channel_id, topic, niche, language, n_episodes, duration_s, idempotency_key, request_hash, requested_by) "
                         "values (%s, 'chan-a2', 't', 'n', 'English', 3, 120, %s, 'c', %s)", [w.org_a, f"x-{uuid.uuid4().hex}", w.ed.uid])):
            out = s.run(q, args)
            assert (not out.ok) or out.rowcount == 0, (who.name, q, out)
    become(s, None)
    assert s.rows("select id, requested_by, created_at from public.series_plans where id = %s", [plan]) == snap
    assert s.rows("select user_daily_cap, global_daily_cap from public.series_plan_cap_settings") == [(3, w.base + 1000)]
    # the owner's own door is closed to a delete of the row and to emptying the table, and to a number outside the range
    assert s.run("delete from public.series_plan_cap_settings").error == "series_plan_cap_settings keeps its one row"
    assert s.run("truncate public.series_plan_cap_settings").error == "series_plan_cap_settings keeps its one row"
    for q in ("update public.series_plan_cap_settings set user_daily_cap = -1", "update public.series_plan_cap_settings set user_daily_cap = 1001",
              "update public.series_plan_cap_settings set global_daily_cap = 10001", "update public.series_plan_cap_settings set global_daily_cap = null",
              "insert into public.series_plan_cap_settings (id) values (false)"):
        out = s.run(q)
        assert not out.ok and out.sqlstate in ("23514", "23502", "23505"), (q, out)


def test_a_change_of_a_number_leaves_a_security_event_and_never_blocks_the_change(conn, capworld):
    s = capworld.su
    become(s, None)
    n = s.value("select count(*) from public.security_events where kind = 'series.plan.caps'")
    set_caps(s, 7, None)
    assert s.value("select count(*) from public.security_events where kind = 'series.plan.caps'") == n + 1
    assert s.value("select detail -> 'user_daily_cap' from public.security_events where kind = 'series.plan.caps' order by id desc limit 1") == [3, 7]
    s.rows("update public.series_plan_cap_settings set user_daily_cap = user_daily_cap returning 1")      # no change of a number: no event
    assert s.value("select count(*) from public.security_events where kind = 'series.plan.caps'") == n + 1
    # an audit that cannot be written must not stop the owner from lowering a cap
    s.conn.execute("alter table public.security_events rename to security_events_gone")
    out = s.run("update public.series_plan_cap_settings set user_daily_cap = 2")
    assert out.ok, out
    s.conn.execute("alter table public.security_events_gone rename to security_events")
    assert s.value("select user_daily_cap from public.series_plan_cap_settings") == 2


def test_a_missing_settings_row_reads_as_the_defaults_never_as_no_cap(conn, capworld):
    w, s = capworld, capworld.su
    become(s, None)
    s.conn.execute("set local session_replication_role = replica")        # only a superuser can get past the guard trigger
    s.conn.execute("delete from public.series_plan_cap_settings")
    s.conn.execute("set local session_replication_role = origin")
    assert s.value("select count(*) from public.series_plan_cap_settings") == 0
    for i, ch in enumerate((w.chan_a, w.chan_a2, w.chan_a3)):
        finished(s, w.ed, ch, idem=f"missing-{i:04d}")
    assert refused(ask(s, w.ed, w.chan_a), "NS429", "series_user_cap"), "three, the default"
    become(s, None)
    fill(s, w.org_b, 30 - plans_in_window(s), channel=w.chan_b)
    assert refused(ask(s, w.ed2, w.chan_a2), "NS429", "series_global_cap"), "thirty, the default"


# ═══ 5. at the same moment ════════════════════════════════════════════════════════════════════════════════════════════════

def _owner_sets(conn, user_cap, global_cap):
    with as_superuser(conn) as su:
        su.rows("update public.series_plan_cap_settings set user_daily_cap = %s, global_daily_cap = %s returning 1", [user_cap, global_cap])


def _in_window(conn):
    with as_superuser(conn, commit=False) as su:
        return su.value("select count(*) from public.series_plans where created_at > now() - interval '24 hours'")


def _go(conn, who, results, barrier, calls):
    """One thread: its own connection, the owner carrying a person's claims (the function is granted to nobody), one real committed transaction."""
    with psycopg.connect(_dsn(conn), autocommit=True) as c:
        for channel, idem in calls:
            with c.transaction():
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
                barrier.wait()
                try:
                    c.execute("select public.request_series_plan(%s, 'T', 3, null, 120, null, %s)", [channel, idem])
                    results.append("ok")
                except psycopg.Error as e:
                    results.append(e.diag.message_primary)


def test_one_person_pressing_in_three_organizations_at_once_cannot_pass_the_person_cap(conn, sc):
    """Five organizations take five different organization locks, so only the platform lock (taken after, held to the commit) keeps the person's count honest."""
    races = [RaceOrg(conn, role="editor", channels=[f"chan-pc{i}-{j}" for j in range(2)], credits=False) for i in range(1)]
    one = races[0]
    others = [RaceOrg(conn, role="editor", channels=[f"chan-pd{i}"], credits=False) for i in range(5)]
    old = None
    try:
        with as_superuser(conn, commit=False) as su:
            old = su.rows("select user_daily_cap, global_daily_cap from public.series_plan_cap_settings")[0]
        _owner_sets(conn, 3, _in_window(conn) + 1000)
        with as_superuser(conn) as su:
            for o in others:       # the one person is an editor in every organization
                su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'editor') returning 1", [o.org, one.who.uid, one.who.email])
        barrier = threading.Barrier(5)
        results = []
        threads = [threading.Thread(target=_go, args=(conn, one.who, results, barrier, [(o.channels[0], f"race-user-{i:04d}-{uuid.uuid4().hex[:6]}")]))
                   for i, o in enumerate(others)]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(60)
        assert sorted(results) == ["ok", "ok", "ok", "series_user_cap", "series_user_cap"], results
        assert one.count("select count(*) from public.series_plans where requested_by = %s", [one.who.uid]) == 3
    finally:
        if old:
            _owner_sets(conn, *old)
        for r in (*races, *others):
            r.purge()


def test_many_people_pressing_at_once_cannot_pass_the_platform_cap(conn, sc):
    orgs = [RaceOrg(conn, role="editor", channels=[f"chan-pg{i}"], credits=False) for i in range(7)]
    old = None
    try:
        with as_superuser(conn, commit=False) as su:
            old = su.rows("select user_daily_cap, global_daily_cap from public.series_plan_cap_settings")[0]
        _owner_sets(conn, 1000, _in_window(conn) + 3)
        barrier = threading.Barrier(7)
        results = []
        threads = [threading.Thread(target=_go, args=(conn, o.who, results, barrier, [(o.channels[0], f"race-glob-{i:04d}-{uuid.uuid4().hex[:6]}")]))
                   for i, o in enumerate(orgs)]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(60)
        assert sorted(results) == ["ok", "ok", "ok", "series_global_cap", "series_global_cap", "series_global_cap", "series_global_cap"], results
        assert sum(o.count("select count(*) from public.series_plans where org_id = %s", [o.org]) for o in orgs) == 3
    finally:
        if old:
            _owner_sets(conn, *old)
        for o in orgs:
            o.purge()


def test_the_same_press_sent_twice_at_once_makes_one_plan_and_the_second_is_a_replay(conn, sc):
    one = RaceOrg(conn, role="editor", channels=["chan-pr0"], credits=False)
    old = None
    try:
        with as_superuser(conn, commit=False) as su:
            old = su.rows("select user_daily_cap, global_daily_cap from public.series_plan_cap_settings")[0]
        _owner_sets(conn, 1, _in_window(conn) + 1000)          # a cap of one: the second press is a retry, not a second plan
        barrier = threading.Barrier(2)
        out = []
        same = f"race-same-{uuid.uuid4().hex[:8]}"

        def go():
            with psycopg.connect(_dsn(conn), autocommit=True) as c:
                with c.transaction():
                    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(one.who.claims())])
                    barrier.wait()
                    try:
                        out.append(c.execute("select public.request_series_plan('chan-pr0', 'T', 3, null, 120, null, %s)", [same]).fetchone()[0]["replayed"])
                    except psycopg.Error as e:
                        out.append(e.diag.message_primary)

        threads = [threading.Thread(target=go) for _ in range(2)]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(60)
        assert sorted(map(str, out)) == ["False", "True"], out
        assert one.count("select count(*) from public.series_plans where org_id = %s", [one.org]) == 1
    finally:
        if old:
            _owner_sets(conn, *old)
        one.purge()


# ═══ 6. the file: refusals, replay ════════════════════════════════════════════════════════════════════════════════════════

def test_applying_the_migration_again_changes_nothing_and_keeps_the_owners_numbers(conn, capworld):
    s = capworld.su
    set_caps(s, 5, 50)
    want = (defs(s), acl(s))
    for _ in range(2):
        s.conn.execute(migration_body())
        become(s, None)
    assert (defs(s), acl(s)) == want, "a replay changes no body and no grant"
    assert s.rows("select user_daily_cap, global_daily_cap from public.series_plan_cap_settings") == [(5, 50)], "the seed never undoes what the owner set"


@pytest.mark.parametrize("how", ["authenticated", "anon", "service_role", "public", "null_acl"])
def test_the_migration_refuses_to_run_when_somebody_granted_the_function_and_changes_nothing(conn, world, how):
    s = world.su
    sec_db.take_off_0127(s)
    become(s, None)
    if how == "null_acl":
        s.conn.execute("update pg_proc set proacl = null where oid = %s::regprocedure", [NEW])
    else:
        s.conn.execute(f"grant execute on function {NEW} to {how}")
    want = (defs(s), acl(s))
    out = s.run(migration_body())
    assert not out.ok and "executable by public or by an API role" in out.error, (how, out)
    become(s, None)
    assert (defs(s), acl(s)) == want
    assert s.value("select to_regclass('public.series_plan_cap_settings')") is None, "nothing of 0127 was created"


def test_the_migration_refuses_a_body_it_has_not_seen_and_replaces_nothing(conn, world):
    s = world.su
    for state in ("0122", "0127"):
        if state == "0122":
            sec_db.take_off_0127(s)
        become(s, None)
        ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [NEW])
        changed = ddl.replace("begin\n", "begin\n  -- applied by hand, after the repo's migrations\n", 1)
        assert changed != ddl
        s.conn.execute(changed)
        s.conn.execute(f"revoke all on function {NEW} from public, anon, authenticated, service_role")
        out = s.run(migration_body())
        assert not out.ok and out.error.startswith("0127 found a request_series_plan() that is neither 0122's body nor 0127's"), out
        assert s.value("select pg_get_functiondef(%s::regprocedure)", [NEW]) == changed, "the foreign body is still there"
        if state == "0122":
            s.conn.execute(ddl)       # put it back for the second pass
            s.conn.execute(f"revoke all on function {NEW} from public, anon, authenticated, service_role")
            sec_db.put_back_0127(s)


@pytest.mark.parametrize("fn", ["series_plan_cap_settings_guard", "series_plan_cap_settings_trail"])
def test_the_migration_refuses_a_trigger_function_that_is_not_its_own(conn, world, fn):
    s = world.su
    become(s, None)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [f"public.{fn}()"])
    changed = ddl.replace("begin\n", "begin\n  -- by hand\n", 1)
    assert changed != ddl
    s.conn.execute(changed)
    out = s.run(migration_body())
    assert not out.ok and f"0127 found a {fn}() that is not 0127's body" in out.error, out


def test_the_migration_needs_0122_and_says_so(conn, world):
    s = world.su
    sec_db.take_off_0127(s)
    sec_db.take_off_0122(s)
    become(s, None)
    out = s.run(migration_body())
    assert not out.ok and "0127 needs 0122_series_template_carrier.sql" in out.error, out


def test_the_end_state_rolls_the_whole_file_back_if_something_re_grants_the_function(conn, world):
    """A platform default or a hand-made rule that grants EXECUTE on every new or replaced function must make the last block raise and leave nothing."""
    s = world.su
    sec_db.take_off_0127(s)
    s.conn.execute("create function pg_temp.regrant() returns event_trigger language plpgsql as $f$ begin "
                   f"execute 'grant execute on function {NEW} to anon'; end $f$")
    # the file's own revoke comes after the replace, so the rule fires after a REVOKE (the last word on the function's privileges)
    s.conn.execute("create event trigger regrant_after_revoke on ddl_command_end when tag in ('REVOKE') execute function pg_temp.regrant()")
    out = s.run(migration_body())
    assert not out.ok and "0127 end state: request_series_plan() is executable by public or an API role" in out.error, out
    become(s, None)
    assert s.value("select to_regclass('public.series_plan_cap_settings')") is None, "nothing of 0127 is left"


def test_the_end_state_notices_a_policy_or_a_grant_on_the_settings_table(conn, world):
    s = world.su
    become(s, None)
    out = s.run("create policy open_read on public.series_plan_cap_settings for select using (true);\n" + migration_body())
    assert not out.ok and "series_plan_cap_settings has a policy" in out.error, out
    s.conn.execute("create function pg_temp.regrant_table() returns event_trigger language plpgsql as $f$ begin "
                   "execute 'grant select on public.series_plan_cap_settings to authenticated'; end $f$")
    s.conn.execute("create event trigger regrant_table on ddl_command_end when tag in ('REVOKE') execute function pg_temp.regrant_table()")
    out = s.run(migration_body())
    assert not out.ok and "authenticated holds select on series_plan_cap_settings" in out.error, out


# ═══ 7. the rollback ══════════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_rollback_restores_0122_byte_for_byte_drops_the_table_and_0127_applies_again(conn, sc):
    admin = sec_db.admin_dsn()
    base = f"ns_series_caps_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith("0127_")])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = (b.execute("select pg_get_functiondef(%s::regprocedure)", [NEW]).fetchone()[0],
                    b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [NEW]).fetchone()[0])
            fns = {r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
            tables = {r[0] for r in b.execute("select tablename from pg_tables where schemaname = 'public'")}
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback) and len(re.findall(r"(?m)^commit;$", rollback)) == 1
    with as_superuser(conn, commit=False) as su:
        applied = (defs(su), acl(su))
        su.conn.execute(rollback_body())
        become(su, None)
        got = (su.value("select pg_get_functiondef(%s::regprocedure)", [NEW]), su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [NEW]))
        assert got == want, "0122's function is back, byte for byte, with its privileges"
        assert {r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")} == fns
        assert {r[0] for r in su.rows("select tablename from pg_tables where schemaname = 'public'")} == tables
        assert su.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = %s::regprocedure", [NEW]) == BEFORE_HASH
        again = su.run(rollback_body())      # a second rollback finds 0122's body and refuses to "restore" what is not 0127's
        assert not again.ok and "is not 0127's body" in again.error, again
        su.conn.execute(migration_body())
        assert (defs(su), acl(su)) == applied, "and 0127 applies again on top, to exactly what it was"


def test_the_rollback_runs_before_0122s_and_0122s_then_runs_clean(conn, world):
    s = world.su
    out = s.run(sec_db.ROLLBACK_0122.read_text(encoding="utf-8").replace("begin;", "").replace("commit;", ""))
    assert not out.ok and "request_series_plan() is not 0122's body" in out.error, "0122's rollback refuses while 0127 is on"
    sec_db.take_off_0127(s)
    sec_db.take_off_0122(s)
    become(s, None)
    assert s.value("select to_regclass('public.series_plan_cap_settings')") is None


@pytest.mark.parametrize("how", ["authenticated", "anon", "service_role", "public"])
def test_the_rollback_refuses_while_the_function_is_granted(conn, world, how):
    """Putting 0122's body back would lift the caps from a live callable that spends the shared key: a decision for a person."""
    s = world.su
    become(s, None)
    s.conn.execute(f"grant execute on function {NEW} to {how}")
    want = defs(s)
    out = s.run(rollback_body())
    assert not out.ok and "executable by public or an API role" in out.error, out
    assert defs(s) == want and s.value("select to_regclass('public.series_plan_cap_settings')") is not None


def test_the_rollback_refuses_to_undo_a_later_change(conn, world):
    s = world.su
    become(s, None)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [NEW])
    changed = ddl.replace("begin\n", "begin\n  -- a later change, by hand\n", 1)
    s.conn.execute(changed)
    s.conn.execute(f"revoke all on function {NEW} from public, anon, authenticated, service_role")
    out = s.run(rollback_body())
    assert not out.ok and "rollback 0127: request_series_plan() is not 0127's body" in out.error, out
    assert s.value("select position('a later change' in pg_get_functiondef(%s::regprocedure)) > 0", [NEW])
    assert s.value("select to_regclass('public.series_plan_cap_settings')") is not None


def test_the_rollback_keeps_every_plan_row(conn, capworld):
    w, s = capworld, capworld.su
    plan = finished(s, w.ed, w.chan_a, idem="keep-0001")
    become(s, None)
    s.conn.execute(rollback_body())
    become(s, None)
    assert s.value("select count(*) from public.series_plans where id = %s", [plan]) == 1


# ═══ 8. 0124 / 0125 / 0126 and this file, in any order ═══════════════════════════════════════════════════════════════════

ORDER_CASES = [("0124", "0125", "0126", "0127"), ("0127", "0124", "0125", "0126"), ("0124", "0127", "0125", "0126"), ("0124", "0125", "0127", "0126")]


def _build_in_order(order):
    admin = sec_db.admin_dsn()
    name = f"ns_series_caps_order_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    try:
        late = tuple(f"{n}_" for n in order)
        sec_db.apply_files(dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(late)])
        by_num = {f.name[:4]: f for f in sec_db.migration_files()}
        for n in order:
            sec_db.apply_files(dsn, [by_num[n]])
        with psycopg.connect(dsn, autocommit=True) as c:
            fns = {r[0]: (r[1], r[2]) for r in c.execute(
                "select p.oid::regprocedure::text, md5(p.prosrc), coalesce(p.proacl::text, '') from pg_proc p where pronamespace = 'public'::regnamespace")}
            tables = {r[0] for r in c.execute("select tablename from pg_tables where schemaname = 'public'")}
            cols = {(r[0], r[1]) for r in c.execute("select table_name, column_name from information_schema.columns where table_schema = 'public'")}
            policies = {(r[0], r[1]) for r in c.execute("select tablename, policyname from pg_policies where schemaname = 'public'")}
            caps = c.execute("select user_daily_cap, global_daily_cap from public.series_plan_cap_settings").fetchall()
        return fns, tables, cols, policies, caps
    finally:
        sec_db.drop_database(admin, name)


def test_0127_applies_with_0124_0125_0126_in_every_order_to_the_same_end_state(conn, sc):
    results = {order: _build_in_order(order) for order in ORDER_CASES}
    first = results[ORDER_CASES[0]]
    for order, got in results.items():
        assert got[4] == [(3, 30)], order
        assert got == first, (order, sorted(k for k in got[0] if got[0][k] != first[0].get(k)))
    # and the function it is about is the one this file ships, granted to nobody, in each of them
    assert first[0][SHORT][1] != "" and "anon" not in first[0][SHORT][1] and "authenticated" not in first[0][SHORT][1]
