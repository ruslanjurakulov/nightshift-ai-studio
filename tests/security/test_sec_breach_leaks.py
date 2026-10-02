"""Breach wave 7, lane G: platform-private state that reaches a member of an
organization, and a counter the caller can reset.

Held (a passing test):
  * the platform's economics: no member reads ``credit_prices``, the routed
    quote has no margin, and ``creative_economics`` / ``creative_job_costs`` /
    ``creative_job_routes`` / ``model_probe_runs`` / ``worker_status`` answer a
    member nothing (wave 6 + 0084 + 0075; re-attacked here from the member's side
    through the tables the new migrations added).

Fixed (migrations 0087 and 0088):
  * BR-G-004  ``take_web_rate`` deleted the caller's rows of the same bucket from
    EARLIER windows, so one call with a one-second window reset the counter a
    route keeps with a ten-minute window. The counter is keyed by window length.
  * BR-G-005  the real failover reason (auth, quota, not_configured ...: the state
    of the platform's vendor accounts) was also copied into
    ``creative_job_events.detail`` and read by every member; BR-L-032 is the same
    value on ``creative_jobs``. Both now say 'unavailable'; the real code is in
    the platform-only ``creative_job_routes.reasons``.

Fixed elsewhere (the marker is dropped, migration 0085, BR-L-040 = BR-G-006):
  * BR-G-006  ``scene_regenerations.error`` was readable by every member over
    PostgREST, and the worker fills it with the refusal's raw text (the
    platform's configured vendor model, key and error text). Members are now
    granted every column but ``error`` and the raw text goes to a service-only
    table. The Command Center reads only ``error_code``.
"""

from __future__ import annotations

import json

import psycopg
import pytest

from sec_db import acting, as_superuser
import sec_db

# The router world (its own scratch database, committing): models, prices, two orgs.
from test_sec_model_router import (  # noqa: F401  (db is a fixture)
    ORG_A, UA, UB, create, db, drain, rquote, svc, claim, job,
)


# ── held ────────────────────────────────────────────────────────────────────

def test_members_read_none_of_the_platforms_economics_tables(conn, sc):
    """Every table the 0037 / 0035 / 0045 / 0075 migrations keep for the operator
    answers an ordinary member with no rows or a refusal."""
    for table in ("credit_prices", "creative_job_costs", "creative_job_routes", "model_probe_runs",
                  "worker_status", "model_registry", "creative_economics"):
        with acting(conn, sc.alice.actor) as s:
            out = s.run(f"select * from public.{table}")
        assert (not out.ok and out.sqlstate == "42501") or (out.ok and out.rows == []), f"{table}: {out!r}"


# ── BR-G-004 ────────────────────────────────────────────────────────────────

def test_BR_G_004_a_caller_cannot_reset_their_own_rate_counter(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        first = [s.value("select public.take_web_rate('w7_bucket', 3, 600)") for _ in range(5)]
        assert first == [True, True, True, False, False], "the limiter does not limit at all"
        # One call with a one-second window "starts a new window" and deleted the older ones.
        s.value("select public.take_web_rate('w7_bucket', 1000, 1)")
        again = [s.value("select public.take_web_rate('w7_bucket', 3, 600)") for _ in range(5)]
        assert again == [False] * 5, f"the counter was reset by the caller: {again}"


def test_BR_G_004_the_limiter_still_counts_per_bucket_and_per_user(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert [s.value("select public.take_web_rate('w7_a', 2, 600)") for _ in range(3)] == [True, True, False]
        assert s.value("select public.take_web_rate('w7_b', 2, 600)") is True       # another bucket
        assert s.value("select public.take_web_rate('w7_a', 2, 60)") is True        # another window length is another counter
        assert s.value("select public.take_web_rate('w7_a', 2, 600)") is False      # and the route's own is untouched
    with acting(conn, sc.bob.actor) as s:
        assert s.value("select public.take_web_rate('w7_a', 2, 600)") is True       # another user


def test_BR_G_004_a_new_window_clears_only_older_windows_of_its_own_length_and_dead_rows(conn, sc):
    uid = sc.alice.actor.uid
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into public.web_rate_counters (user_id, bucket, window_start, count) values "
                "(%s, 'w7_c@600', now() - interval '1 hour', 9), (%s, 'w7_c@60', now() - interval '1 hour', 9), "
                "(%s, 'w7_d@600', now() - interval '3 days', 9) returning 1", [uid, uid, uid])
        with acting(conn, sc.alice.actor) as s:
            assert s.value("select public.take_web_rate('w7_c', 5, 600)") is True
            s.conn.execute("reset role")
            left = {r[0] for r in s.rows("select bucket from public.web_rate_counters "
                                         "where user_id = %s and bucket like 'w7\\_%%'", [uid])}
    # the old 600 s row went (and the new one is there), the 60 s row stayed, the 3-day row went
    assert left == {"w7_c@600", "w7_c@60"}, left


def test_the_rate_counter_table_is_still_closed_to_the_api_roles(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        assert not s.run("select * from public.web_rate_counters").ok
        assert not s.run("delete from public.web_rate_counters").ok


# ── BR-G-005 ────────────────────────────────────────────────────────────────

def test_BR_G_005_a_member_never_reads_the_platforms_vendor_account_state_in_the_job_log(db):
    drain(db)
    q = rquote(db, UA, ORG_A, "cheap")
    jid = create(db, UA, ORG_A, "cheap", q["routed_model"], q["credits"], idem="w7-g005")["job"]["id"]
    claim(db, jid)
    svc(db, "select public.advance_creative_job(%s,'w-r','submitting')", [jid])
    # The cheapest model's vendor account has no key (or no balance): the worker fails over.
    db.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_img_mid_image'")
    try:
        moved = svc(db, "select public.reroute_creative_job(%s,'w-r','quota')", [jid])[0][0]
    finally:
        db.su("update public.credit_prices set credits_per_unit = 5 where unit = 'model_img_mid_image'")
    assert moved is not None, "the failover did not happen; the test would be vacuous"
    try:
        rows = db.act("authenticated", UA, "select event, detail from public.creative_job_events where job_id = %s", [jid])
        seen = json.dumps([(e, d) for e, d in rows])
        assert "quota" not in seen, f"a member reads the vendor account state in the job log: {seen}"
        rerouted = [d for e, d in rows if e == "rerouted"]
        assert len(rerouted) == 1 and rerouted[0]["code"] == "unavailable" and rerouted[0]["to"] == moved["model"], rerouted
        # BR-L-032: the job row (table SELECT) and the web job answer say the same.
        row = db.act("authenticated", UA, "select fallback_reason, fallback_from from public.creative_jobs where id = %s", [jid])[0]
        assert row[0] == "unavailable" and row[1], row
        answer = db.su("select public.creative_job_json(j) from public.creative_jobs j where id = %s", [jid])[0][0]
        assert answer["fallback_reason"] == "unavailable" and "quota" not in json.dumps(answer), answer
        # The platform keeps the real reason, where no API role reads it.
        assert db.su("select reasons from public.creative_job_routes where job_id = %s", [jid])[0][0] == ["quota"]
        denied = None
        try:
            db.act("authenticated", UA, "select reasons from public.creative_job_routes where job_id = %s", [jid])
        except psycopg.Error as e:
            denied = e.sqlstate
        assert denied == "42501"
    finally:
        svc(db, "select public.finish_creative_job(%s,'w-r',false,null,null,'quota','x')", [jid])


def test_BR_G_005_a_second_run_of_the_migration_finds_nothing_to_move_and_a_first_one_scrubs_old_rows(db):
    """Rows written by 0075's version of the failover carried the real code on
    the job and in the log. Seed such a pair, replay 0088: the real code moves
    to the platform's table, the member-readable copies say 'unavailable', the
    append-only trigger is back on, and a replay changes nothing more."""
    drain(db)
    q = rquote(db, UA, ORG_A, "cheap")
    jid = create(db, UA, ORG_A, "cheap", q["routed_model"], q["credits"], idem="w7-g005-old")["job"]["id"]
    db.su("update public.creative_jobs set fallback_reason = 'auth', fallback_from = routed_model where id = %s", [jid])
    db.su("update public.creative_job_routes set reasons = '[]'::jsonb where job_id = %s", [jid])
    db.su("alter table public.creative_job_events disable trigger creative_job_events_append_only")
    db.su("insert into public.creative_job_events (job_id, org_id, event, status, detail) "
          "values (%s, %s, 'rerouted', 'running', '{\"code\": \"auth\", \"from\": \"a\", \"to\": \"b\"}')", [jid, ORG_A])
    db.su("alter table public.creative_job_events enable trigger creative_job_events_append_only")
    migration = (sec_db.MIGRATIONS / "0088_router_failover_reason.sql").read_text(encoding="utf-8")
    for _ in range(2):
        db.su(migration)
        assert db.su("select fallback_reason from public.creative_jobs where id = %s", [jid])[0][0] == "unavailable"
        assert db.su("select reasons from public.creative_job_routes where job_id = %s", [jid])[0][0] == ["auth"]
        assert db.su("select detail ->> 'code' from public.creative_job_events where job_id = %s and event = 'rerouted'",
                     [jid])[0][0] == "unavailable"
        assert db.su("select tgenabled from pg_trigger where tgname = 'creative_job_events_append_only' "
                     "and tgrelid = 'public.creative_job_events'::regclass")[0][0] == "O"
    err = None
    try:
        db.su("update public.creative_job_events set event = event where job_id = %s", [jid])
    except psycopg.Error as e:
        err = e.sqlstate
    assert err == "42501", "the log is append-only again"


# ── BR-G-006 ────────────────────────────────────────────────────────────────

def test_BR_G_006_a_member_cannot_read_the_raw_error_text_of_a_regeneration(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select error from public.scene_regenerations")
    assert not out.ok and out.sqlstate == "42501", \
        "a member reads scene_regenerations.error, which holds the worker's text (vendor model, key and error text)"


def test_a_member_reads_the_columns_the_page_uses_and_only_their_own_organizations_rows(conn, sc):
    """The control: the regeneration list the video page shows still works, and
    nothing of another organization's comes with it."""
    cols = "id,scene_id,status,source_kind,explicit_stock,quoted_credits,charged_credits,error_code,previous_asset_ids,created_at,finished_at"
    with acting(conn, sc.alice.actor) as s:
        out = s.run(f"select {cols}, org_id from public.scene_regenerations")
    assert out.ok and out.rows, out
    assert {str(r[-1]) for r in out.rows} == {sc.alice.org}
