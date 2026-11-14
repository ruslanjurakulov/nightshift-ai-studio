"""Named attacks on the site's live public counters (migration 0164), and what they count.

public_site_stats() is SECURITY DEFINER and executable by anon: it reads every tenant's videos, intents, generations and runs,
which no anon caller may read. So the whole defence is that (1) while the switch is off it answers {"visible": false} and
nothing else, (2) when on it hands out the named aggregate counts and nothing that identifies a tenant, and (3) the switch is a
platform owner/admin's (or the SQL editor's), audited, and nobody else can turn it.

The second half pins the arithmetic against a world built here: the operator's own workspace and a staff member's workspace are
in none of it; a held row with no cut is not a rendered video; an upload that went public straight away is not "uploaded as
private"; a null stays null. Counts are checked as the difference this world makes, so the rest of the lab cannot move them.

Every world is built inside one transaction that is rolled back, so nothing is left for another test to trip over.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from contextlib import contextmanager

import pytest

from sec_db import ANON, REPO, SERVICE, acting, as_superuser
from sec_scenario import DEFAULT_ORG

READ = "select public.public_site_stats()"
SWITCH = "select public.set_public_stats_visible(%s)"
MEASURE = "select public.public_site_stats_measure()"
MIGRATION = REPO / "supabase" / "migrations" / "0164_public_site_stats.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0164_public_site_stats.sql"
COUNTS = ("videos_rendered", "videos_uploaded_private", "videos_approved", "studio_generations")
VISIBLE_KEYS = {"visible", "as_of", *COUNTS, "last_run_at"}
SIGS = ("public.public_site_stats()", "public.set_public_stats_visible(boolean)", "public.public_site_stats_measure()")


def _hex(s: str) -> str:
    return uuid.uuid5(uuid.NAMESPACE_URL, s).hex * 2


def _call(conn, who, query, params=None):
    with acting(conn, who) as s:
        return s.run(query, params)


def _back_to_owner(su):
    """After acting(..., commit=True) inside an owner's transaction the API role and claims are still set: drop them."""
    su.conn.execute("reset role")
    su.conn.execute("select set_config('request.jwt.claims', '', true)")


def _events(su):
    return su.value("select count(*) from public.security_events where kind = 'site.public_stats'")


@contextmanager
def switched(conn, on: bool):
    """The switch set as the SQL editor would set it, inside a transaction that is rolled back."""
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.site_settings set public_stats_visible = %s, stats = null, stats_at = null where id returning 1", [on])
        yield su


# ── building a world ────────────────────────────────────────────────────────

def _workspace(su, key: str, *, staff_role: str | None = None):
    uid = str(uuid.uuid4())
    email = f"{key}-statslab@example.test"
    su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [uid, email])
    org = str(su.value("insert into public.organizations (name, slug) values (%s, %s) returning id",
                       [f"Statslab {key.upper()} Studio", f"statslab-{key.replace('_', '-')}-{uid[:8]}"]))
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
            [org, uid, email])
    if staff_role:
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, %s) returning 1", [uid, email, staff_role])
    return org, uid


def _channel(su, org: str, key: str) -> str:
    ch = f"chan-statslab-{key.replace('_', '-')}"
    su.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', %s) returning 1",
            [ch, f"Statslab {key}", org])
    return ch


def _video(su, ch, vid, *, cut=False, privacy=None, published=False, state=None):
    su.rows("insert into public.videos (video_id, channel_id, title, slug, review_state, cut_sha256, privacy, published_at, publish_state) "
            "values (%s, %s, %s, %s, 'pending', %s, %s, %s, %s) returning 1",
            [vid, ch, f"Secret title {vid}", f"slug-{vid}", _hex(vid) if cut else None, privacy,
             "2026-11-01T00:00:00Z" if published else None, state])


def _approve(su, ch, vid, uid):
    su.rows("insert into public.review_intents (channel_id, video_id, action, created_by, approved_cut_sha256, consumed_at, outcome) "
            "values (%s, %s, 'approve', %s, %s, now(), 'recorded') returning 1", [ch, vid, uid, _hex(vid)])


def _generation(su, org, status):
    su.rows("insert into public.creative_jobs (org_id, capability, requested_model, params, status, quoted_credits, finished_at) "
            "values (%s, 't2i', 'm-statslab', '{}', %s, 0, now()) returning 1", [org, status])


def _run(su, ch, status, kind="daily", finished="2026-11-10T12:00:00Z"):
    # render_jobs is closed to direct writes (0041's payment guard): only the ledger of the run matters here, so triggers are off.
    su.conn.execute("set local session_replication_role = replica")
    params = {"daily": {}, "repair": {"repair_scenes": "s001"}}[kind]
    su.rows("insert into public.render_jobs (channel_id, kind, params, status, finished_at) values (%s, %s, %s, %s, %s) returning 1",
            [ch, kind, json.dumps(params), status, finished])
    su.conn.execute("set local session_replication_role = origin")


def _everything(su, org, ch, uid, key):
    """One of each thing that counts, and one of each that does not, on one workspace's channel."""
    _video(su, ch, f"{key}-held-nocut", state="blocked")                                  # not rendered
    _video(su, ch, f"{key}-held-cut", cut=True, state="held")                             # rendered
    _video(su, ch, f"{key}-up-priv", cut=True, privacy="private", published=True, state="uploaded")  # rendered, private
    _video(su, ch, f"{key}-up-pub", cut=True, privacy="public", published=True, state="uploaded")    # rendered, went public at once
    _video(su, ch, f"{key}-up-later", cut=True, privacy="public", published=True, state="uploaded")  # private, then approved public
    su.rows("insert into public.video_visibility_requests (org_id, channel_id, video_id, approved_cut_sha256, decided_by, decided_at, "
            "expires_at, status, before_privacy, after_privacy, finished_at) "
            "values (%s, %s, %s, %s, %s, now(), now() + interval '1 day', 'applied', 'private', 'public', now()) returning 1",
            [org, ch, f"{key}-up-later", _hex(f"{key}-up-later"), uid])
    _approve(su, ch, f"{key}-up-priv", uid)
    _approve(su, ch, f"{key}-up-priv", uid)                                               # the same video twice: one approval
    _approve(su, ch, f"{key}-up-later", uid)
    su.rows("insert into public.review_intents (channel_id, video_id, action, created_by) values (%s, %s, 'approve', %s) returning 1",
            [ch, f"{key}-up-pub", uid])                                                   # the dead button's row: no cut, not counted
    for status in ("completed", "completed", "failed", "running"):
        _generation(su, org, status)
    _run(su, ch, "succeeded")
    _run(su, ch, "failed", finished="2026-11-12T12:00:00Z")
    _run(su, ch, "cancelled", finished="2026-11-13T12:00:00Z")


EXPECTED = {"videos_rendered": 4, "videos_uploaded_private": 2, "videos_approved": 2, "studio_generations": 2}


def _measure(su):
    return su.value(MEASURE)


def _delta(after, before):
    return {k: after[k] - before[k] for k in COUNTS}


# ── attacks: the switch ─────────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["alice", "bob", "stranger", "dana", "invitee"])
def test_a_customer_cannot_turn_the_counters_on_and_no_event_is_written(conn, sc, who):
    # dana is a member of the operator's own workspace: the closest a customer-shaped account gets without being on the roster.
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger, "dana": sc.dana, "invitee": sc.invitee}[who]
    for value in (True, False):
        out = _call(conn, actor, SWITCH, [value])
        assert not out.ok and out.sqlstate == "42501", out
    with as_superuser(conn, commit=False) as su:
        assert su.value("select public_stats_visible from public.site_settings") is False
        assert _events(su) == 0


def test_anon_and_the_service_key_cannot_execute_the_switch(conn, sc):
    for who in (ANON, SERVICE):
        out = _call(conn, who, SWITCH, [True])
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_nobody_but_the_owner_reaches_the_measurement_or_the_table(conn, sc):
    for who in (ANON, SERVICE, sc.alice.actor, sc.operator):
        out = _call(conn, who, MEASURE)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
        for q in ("select * from public.site_settings", "update public.site_settings set public_stats_visible = true where id"):
            out = _call(conn, who, q)
            assert (not out.ok and out.sqlstate == "42501") or (out.ok and out.rowcount == 0 and not out.rows), (who.name, q, out)


def test_the_platform_admin_turns_it_on_once_and_one_audit_row_names_who_and_what(conn, sc):
    with as_superuser(conn, commit=False) as su:
        before = _events(su)
        with acting(conn, sc.operator, commit=True) as s:
            first = s.value(SWITCH, [True])
            again = s.value(SWITCH, [True])
            state = s.value(READ)
        _back_to_owner(su)
        rows = su.rows("select actor_user_id::text, actor_role, target, detail from public.security_events "
                       "where kind = 'site.public_stats' order by id")
        assert su.value("select public_stats_visible from public.site_settings") is True
    assert first == {"ok": True, "visible": True, "changed": True}
    assert again == {"ok": True, "visible": True, "changed": False}
    assert state["visible"] is True and set(state) == VISIBLE_KEYS
    # One row for the change, none for the call that changed nothing.
    assert len(rows) == before + 1
    uid, role, target, detail = rows[-1]
    assert (uid, role, target) == (sc.operator.uid, "authenticated", "public_stats_visible")
    assert detail == {"from": False, "to": True, "via": "admin"}


def test_the_sql_editor_turns_it_on_and_off_and_each_change_is_audited_as_the_editor(conn, sc):
    with as_superuser(conn, commit=False) as su:
        before = _events(su)
        assert su.value(SWITCH, [True]) == {"ok": True, "visible": True, "changed": True}
        assert su.value(SWITCH, [False]) == {"ok": True, "visible": False, "changed": True}
        rows = su.rows("select actor_user_id, actor_role, detail from public.security_events where kind = 'site.public_stats' order by id")
        assert len(rows) == before + 2
        assert [r[2] for r in rows[-2:]] == [{"from": False, "to": True, "via": "sql_editor"},
                                              {"from": True, "to": False, "via": "sql_editor"}]
        assert all(r[0] is None and r[1] is None for r in rows[-2:])


def test_a_null_is_not_a_choice(conn, sc):
    with as_superuser(conn, commit=False) as su:
        out = su.run(SWITCH, [None])
        assert not out.ok and out.sqlstate == "22023", out
    out = _call(conn, sc.operator, SWITCH, [None])
    assert not out.ok and out.sqlstate == "22023", out


def test_a_session_that_sets_the_role_but_drops_its_claims_is_not_the_sql_editor(conn, sc):
    # The editor is "no API claims AND no API role": a browser role with its claims cleared must not pass as it.
    for role in ("authenticated", "anon"):
        with as_superuser(conn, commit=False) as su:
            su.conn.execute(f"set local role {role}")
            out = su.run(SWITCH, [True])
            su.conn.execute("reset role")
            assert not out.ok and out.sqlstate == "42501", (role, out)
            assert su.value("select public_stats_visible from public.site_settings") is False


# ── attacks: the read ───────────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["anon", "alice", "stranger"])
def test_hidden_means_visible_false_and_nothing_else(conn, sc, who):
    actor = {"anon": ANON, "alice": sc.alice.actor, "stranger": sc.stranger}[who]
    out = _call(conn, actor, READ)
    assert out.ok, out
    assert out.rows[0][0] == {"visible": False}


def test_hidden_the_operator_and_the_editor_see_what_turning_it_on_would_show(conn, sc):
    with as_superuser(conn, commit=False) as su:
        editor = su.value(READ)
        with acting(conn, sc.operator) as s:
            admin = s.value(READ)
    for got in (editor, admin):
        assert set(got) == VISIBLE_KEYS and got["visible"] is False


def test_the_service_key_cannot_read_it(conn, sc):
    out = _call(conn, SERVICE, READ)
    assert not out.ok and out.sqlstate == "42501", out


def test_visible_it_answers_only_the_named_aggregates_and_nothing_that_identifies_a_tenant(conn, sc):
    with switched(conn, True) as su:
        org, uid = _workspace(su, "id")
        ch = _channel(su, org, "id")
        _everything(su, org, ch, uid, "id")
        out = _call(conn, ANON, READ)
    assert out.ok, out
    got = out.rows[0][0]
    assert set(got) == VISIBLE_KEYS and got["visible"] is True
    for k in COUNTS:
        assert isinstance(got[k], int) and got[k] >= 0, k
    text = json.dumps(got)
    for leak in (org, uid, ch, "id-up-priv", "Secret title", "statslab", "example.test", sc.alice.org, sc.alice.channel,
                 sc.alice.video, DEFAULT_ORG, "chan-", "vid-"):
        assert leak not in text, leak


def test_a_customer_cannot_borrow_the_rights_through_a_view_or_wrapper(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        view = s.run("create view public.leak as select public.public_site_stats_measure()")
        func = s.run("create function public.leak() returns jsonb language sql as 'select public.public_site_stats_measure()'")
    assert not view.ok and view.sqlstate == "42501", view
    assert not func.ok and func.sqlstate == "42501", func


# ── what is counted ─────────────────────────────────────────────────────────

def test_a_customer_workspace_counts_each_thing_once_and_only_what_it_names(conn, sc):
    with as_superuser(conn, commit=False) as su:
        before = _measure(su)
        org, uid = _workspace(su, "c")
        _everything(su, org, _channel(su, org, "c"), uid, "c")
        after = _measure(su)
    assert _delta(after, before) == EXPECTED


@pytest.mark.parametrize("where", ["operator", "staff_viewer", "staff_admin"])
def test_the_operators_own_and_a_staff_members_workspace_are_in_none_of_it(conn, sc, where):
    with as_superuser(conn, commit=False) as su:
        before = _measure(su)
        if where == "operator":
            org, uid = DEFAULT_ORG, sc.operator.uid
        else:
            org, uid = _workspace(su, where, staff_role=where.split("_")[1])
        _everything(su, org, _channel(su, org, where), uid, where)
        after = _measure(su)
    assert _delta(after, before) == {k: 0 for k in COUNTS}
    assert after["last_run_at"] == before["last_run_at"]


def test_a_member_whose_address_matches_a_staff_address_but_is_not_bound_still_counts(conn, sc):
    # The rule matches the roster by user id only: typing a staff member's address excludes nothing.
    with as_superuser(conn, commit=False) as su:
        before = _measure(su)
        org, uid = _workspace(su, "lookalike")
        su.rows("update public.org_members set email = %s where org_id = %s returning 1", [sc.operator.email, org])
        _everything(su, org, _channel(su, org, "lookalike"), uid, "lookalike")
        after = _measure(su)
    assert _delta(after, before) == EXPECTED


def test_no_finished_run_is_null_never_zero_or_a_made_up_time(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute("set local session_replication_role = replica")
        su.rows("update public.render_jobs set status = 'failed' where status = 'succeeded' returning 1")
        su.conn.execute("set local session_replication_role = origin")
        got = _measure(su)
        assert "last_run_at" in got and got["last_run_at"] is None
        org, uid = _workspace(su, "run")
        ch = _channel(su, org, "run")
        _run(su, ch, "succeeded", kind="repair", finished="2026-11-11T08:30:00Z")
        got = _measure(su)
        assert got["last_run_at"] is not None
        assert datetime.fromisoformat(got["last_run_at"]) == datetime(2026, 11, 11, 8, 30, tzinfo=timezone.utc)


def test_visible_nulls_reach_the_caller_as_null(conn, sc):
    with switched(conn, True) as su:
        su.conn.execute("set local session_replication_role = replica")
        su.rows("update public.render_jobs set status = 'failed' where status = 'succeeded' returning 1")
        su.conn.execute("set local session_replication_role = origin")
        out = _call(conn, ANON, READ)
    assert out.ok, out
    got = out.rows[0][0]
    assert "last_run_at" in got and got["last_run_at"] is None


# ── the snapshot (anon must not cost five counts a call) ────────────────────

def test_visible_one_measurement_serves_five_minutes_and_as_of_is_when_it_was_taken(conn, sc):
    with switched(conn, True) as su:
        with acting(conn, ANON, commit=True) as s:
            first = s.value(READ)
        _back_to_owner(su)
        stored_at = su.value("select stats_at from public.site_settings")
        org, _ = _workspace(su, "snap")
        _generation(su, org, "completed")
        with acting(conn, ANON) as s:
            cached = s.value(READ)
        su.rows("update public.site_settings set stats_at = now() - interval '6 minutes' where id returning 1")
        with acting(conn, ANON) as s:
            fresh = s.value(READ)
    assert stored_at is not None
    # Within five minutes the stored numbers are served as they were, with the time they were measured.
    assert cached["studio_generations"] == first["studio_generations"]
    assert cached["as_of"] == first["as_of"]
    # Older than five minutes, the next caller measures again.
    assert fresh["studio_generations"] == first["studio_generations"] + 1


# ── the file itself ─────────────────────────────────────────────────────────

def test_the_functions_are_definers_with_a_fixed_search_path(conn, sc):
    with as_superuser(conn, commit=False) as su:
        for sig in SIGS:
            definer, config = su.rows("select p.prosecdef, p.proconfig from pg_proc p where p.oid = to_regprocedure(%s)", [sig])[0]
            assert definer and "search_path=public, pg_temp" in (config or []), sig


def test_a_replay_changes_nothing_and_keeps_the_switch(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.site_settings set public_stats_visible = true where id returning 1")
        md5 = {sig: su.value("select md5(prosrc) from pg_proc where oid = to_regprocedure(%s)", [sig]) for sig in SIGS}
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert su.value("select public_stats_visible from public.site_settings") is True
        assert su.value("select count(*) from public.site_settings") == 1
        assert {sig: su.value("select md5(prosrc) from pg_proc where oid = to_regprocedure(%s)", [sig]) for sig in SIGS} == md5


def test_the_drift_guard_refuses_a_body_edited_by_hand(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute("create or replace function public.public_site_stats() returns jsonb language sql "
                        "security definer set search_path = public, pg_temp as $$ select '{\"visible\": true}'::jsonb $$")
        out = su.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "is not this file's" in (out.error or ""), out
        out = su.run("\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;")))
        assert not out.ok and "is not 0164's body" in (out.error or ""), out


def test_the_rollback_takes_it_all_out_and_the_file_goes_back_on(conn, sc):
    body = "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(body)
        assert su.value("select to_regclass('public.site_settings') is null and to_regprocedure('public.public_site_stats()') is null")
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert su.value("select public_stats_visible from public.site_settings") is False
        with acting(conn, ANON) as s:
            assert s.value(READ) == {"visible": False}
