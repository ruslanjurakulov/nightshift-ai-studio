"""Migration 0111: a customer's job never carries a provider (D8), the API and MCP answer for a job without the worker's log
(D12), and stale credit holds are swept by pg_cron (D15).

What must hold, each attacked in a real database:

  * D8. A job inserted for an organization that pays, by ANY caller (the signed-in browser, the service key, the database
    owner, api_create_video, oauth_create_video), is refused with 42501 when its params name a video_provider or an
    image_provider with a non-blank value. A job without them is queued as before. Blank and null are not a choice: the
    trigger lets them through (the table's own CHECK still refuses them as provider ids). The operator's own organization is
    untouched. The trigger is BEFORE INSERT only; a queued job's params stay frozen, and a job that already carries a provider
    (queued before 0111) is still claimed, updated and finished.
  * D12. api_get_job and oauth_get_job return `error` as one fixed sentence and `error_code` from the `[code:xxx] ` prefix, for
    a FAILED job only; the worker's text never appears; every other field, the shape and the grants are what they were.
  * D15. The schedule is created only when pg_cron is there, replaces itself on a replay, and a failing pg_cron cannot fail the
    migration. The sweep it runs is safe beside a settlement: capture and release serialize on the account lock, a captured
    hold is never released, a released one is never captured, and the money adds up either way round.
  * Replay and rollback. Applying the file twice changes nothing; the rollback file puts the three functions back to the text a
    database built from 0001-0110 has, byte for byte, drops the helper, and 0111 then applies again.

Runs in the scratch database of test_sec_mcp_oauth.py (its `db` fixture: a customer organization with credits, a channel, an
API key, an OAuth-capable plan, and the operator's own organization).
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
import threading
import time
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, REPO, SERVICE, Actor, acting, as_superuser
from test_sec_mcp_oauth import KEY_A, ORG_A, ORG_B, UA, UB, UOP, connect, db, sha  # noqa: F401  (db is a fixture)

MIGRATION = REPO / "supabase" / "migrations" / "0111_video_safety.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0111_video_safety.sql"
# Later migrations that REDEFINE a function 0111 defines (render_jobs_payment_guard: 0120 adds a block to 0111's body). Replaying 0111 puts
# its own text back, so a replay in these tests is "0111, then the later ones", the order a database sees them in.
LATER = REPO / "supabase" / "migrations" / "0120_series_tables.sql"
# 0122 sits on 0120's bodies (render_jobs_payment_guard, render_job_params_valid) and 0120 refuses any other text, so a test that replays 0111 and then 0120
# takes 0122 off first (sec_db.take_off_0122) and the chain it replays ends at 0120.

CUSTOMER = Actor("customer", "authenticated", UA, "a@d3.io")
OPERATOR = Actor("operator", "authenticated", UOP, "op@d3.io")
CHAN, OPCHAN = "chan-a", "chan-op"

GUARD = "public.render_jobs_payment_guard()"
API_JOB = "public.api_get_job(text, bigint, text)"
OAUTH_JOB = "public.oauth_get_job(text, bigint, text)"
HELPER = "public.render_job_public_error(text, text)"
CHANGED = (GUARD, API_JOB, OAUTH_JOB)

SENTENCES = {
    "credits": "Your credits could not be reserved, so the video was not started. Nothing was charged.",
    "voice": "The narration could not be produced, so the video was not made.",
    "provider_quota": "A service that helps make the video has reached its limit. Try again later.",
    "media": "The footage and pictures for this video could not be gathered, so it was not made.",
    "render": "The video could not be put together.",
    "timeout": "The video took too long to make and was stopped.",
    "unknown": "Something went wrong and the video was not made.",
}
LOG = ("main.py exited with code 1\nTraceback (most recent call last):\n  modules.minimax_broll.VideoModelUnavailable: "
       "top up the Kling account KLING_API_KEY=sk-live-abc123 at https://vendor.example/billing")


@pytest.fixture
def conn(db):
    with psycopg.connect(db.dsn, autocommit=True) as c:
        yield c


@contextmanager
def kept(conn, who):
    """`acting`, but what the caller writes survives until the surrounding rolled-back world ends (so the test can read it
    back as the owner). The API role and the claims are dropped again on the way out."""
    try:
        with acting(conn, who, commit=True) as s:
            yield s
    finally:
        conn.execute("reset role")
        conn.execute("select set_config('request.jwt.claims', '', true)")


def hold(su, org=ORG_A, amount=50):
    ref = f"rj-{uuid.uuid4()}"
    su.value("select public.reserve_credits(%s, %s, %s)", [org, ref, amount])
    return ref


def queue(s, channel, params, **cols):
    row = {"channel_id": channel, "kind": "daily", "params": json.dumps(params), **cols}
    return s.run(f"insert into public.render_jobs ({', '.join(row)}) values ({', '.join(['%s'] * len(row))}) returning id, params",
                 list(row.values()))


def paid_job(conn, su, params=None, **cols):
    """A customer job as 'Run now' queues it (a hold of its own, the length it is held for); returns its id. Rolled back
    with the surrounding transaction."""
    ref = hold(su)
    with kept(conn, CUSTOMER) as s:
        out = queue(s, CHAN, {"duration": 30, **(params or {})}, credit_ref=ref, **cols)
    assert out.ok, out
    return out.rows[0][0]


def refused(out):
    return not out.ok and out.sqlstate == "42501" and "video_provider and image_provider cannot be set" in out.error


# ── D8: the customer's job never names a provider ───────────────────────────

PROVIDERS = [
    {"video_provider": "veo"},
    {"image_provider": "leonardo"},
    {"video_provider": "kling", "image_provider": "gpt-image"},
    {"video_provider": "veo", "image_provider": ""},        # one real choice beside a blank is still a choice
    {"video_provider": " veo "},                              # padded: not blank
    {"video_provider": "not-a-provider"},                     # the guard refuses it before the CHECK says what is wrong with it
    {"image_provider": 5},                                    # not a string: not blank either
]


@pytest.mark.parametrize("extra", PROVIDERS, ids=lambda e: json.dumps(e))
@pytest.mark.parametrize("who", ["browser", "service", "owner"])
def test_a_customer_job_that_names_a_provider_is_refused_whoever_inserts_it(conn, who, extra):
    with as_superuser(conn, commit=False) as su:
        ref = hold(su)
        before = su.value("select count(*) from public.render_jobs")
        actor = {"browser": CUSTOMER, "service": SERVICE}.get(who)
        if actor is None:
            out = queue(su, CHAN, {"duration": 30, **extra}, credit_ref=ref)
        else:
            with acting(conn, actor) as s:
                out = queue(s, CHAN, {"duration": 30, **extra}, credit_ref=ref)
        assert refused(out), out
        assert su.value("select count(*) from public.render_jobs") == before
        # the hold is still open and unused: the refusal cost nothing and burned nothing
        assert su.value("select status from public.credit_reservations where job_id = %s", [ref]) == "open"


def test_the_same_job_without_a_provider_is_queued_as_before(conn):
    with as_superuser(conn, commit=False) as su:
        for params in ({"duration": 30}, {"duration": 30, "topic": "t", "niche": "n", "language": "uz", "visual_style": "s"},
                       {"duration": 30, "tts_model": "eleven_flash_v2_5"}):
            ref = hold(su)
            with acting(conn, CUSTOMER) as s:
                out = queue(s, CHAN, params, credit_ref=ref)
            assert out.ok, (params, out)
            assert "video_provider" not in out.rows[0][1] and "image_provider" not in out.rows[0][1]


def test_blank_and_null_are_not_a_choice_the_guard_lets_them_through_and_the_check_still_refuses_them(conn):
    blanks = [{"video_provider": ""}, {"image_provider": "   "}, {"video_provider": None}, {"video_provider": "", "image_provider": None}]
    with as_superuser(conn, commit=False) as su:
        # As the table stands, the CHECK (render_job_params_valid) refuses a blank provider id: not the guard's refusal.
        for params in blanks:
            ref = hold(su)
            with acting(conn, SERVICE) as s:
                out = queue(s, CHAN, {"duration": 30, **params}, credit_ref=ref)
            assert not out.ok and out.sqlstate == "23514" and "render_jobs_params_check" in out.error, (params, out)
        # Take the CHECK away (rolled back with this test): the guard itself accepts every one of them.
        su.run("alter table public.render_jobs drop constraint render_jobs_params_check")
        for params in blanks:
            ref = hold(su)
            with acting(conn, SERVICE) as s:
                out = queue(s, CHAN, {"duration": 30, **params}, credit_ref=ref)
            assert out.ok, (params, out)


def test_the_operators_own_organization_may_still_choose_providers(conn):
    with as_superuser(conn, commit=False):
        with acting(conn, OPERATOR) as s:
            out = queue(s, OPCHAN, {"video_provider": "veo", "image_provider": "leonardo"})
        assert out.ok and out.rows[0][1] == {"video_provider": "veo", "image_provider": "leonardo"}, out
        with acting(conn, SERVICE) as s:
            assert queue(s, OPCHAN, {"video_provider": "kling"}).ok


def test_the_refusal_comes_after_the_operators_return_and_before_any_payment_check(conn):
    # No hold at all AND a provider: the provider is what is named (it is checked first), so a caller who gets the
    # provider right still meets the hold rule next. And a customer's job with a provider never reaches the hold lookup.
    with as_superuser(conn, commit=False):
        with acting(conn, CUSTOMER) as s:
            no_hold_with_provider = queue(s, CHAN, {"duration": 30, "video_provider": "veo"})
            no_hold = queue(s, CHAN, {"duration": 30})
        assert refused(no_hold_with_provider), no_hold_with_provider
        assert not no_hold.ok and no_hold.sqlstate == "42501" and "credit hold" in no_hold.error, no_hold


def test_a_scene_regeneration_and_a_storyboard_resume_are_not_affected(conn):
    # They carry topic / duration / resume / repair_scenes and never a provider; the guard must not read them as a choice.
    with as_superuser(conn, commit=False) as su:
        ref = hold(su)
        with acting(conn, SERVICE) as s:       # the approval function inserts as the definer; a browser may not send `resume`
            out = queue(s, CHAN, {"topic": "a-slug", "duration": 30, "resume": True}, credit_ref=ref)
        assert out.ok, out


def test_the_trigger_is_before_insert_only_and_the_params_of_a_queued_job_stay_frozen(conn):
    with as_superuser(conn, commit=False) as su:
        tgtype = su.value("select tgtype from pg_trigger where tgrelid = 'public.render_jobs'::regclass "
                          "and tgname = 'render_jobs_payment_guard'")
        assert tgtype & 2 and tgtype & 4 and not tgtype & (8 | 16 | 32), tgtype      # BEFORE, INSERT, nothing else
        job = paid_job(conn, su)
        for patch in ({"params": json.dumps({"duration": 30, "video_provider": "veo"})},):
            for who in (SERVICE, None):
                if who is None:
                    out = su.run("update public.render_jobs set params = %s where id = %s", [patch["params"], job])
                else:
                    with acting(conn, who) as s:
                        out = s.run("update public.render_jobs set params = %s where id = %s", [patch["params"], job])
                assert not out.ok and out.sqlstate == "42501" and "fixed when it is queued" in out.error, out


def test_a_job_queued_with_a_provider_before_0111_is_still_claimed_updated_and_finished(conn):
    with as_superuser(conn, commit=False) as su:
        ref = hold(su)
        # Simulate a row from before: the guard off for this one insert (rolled back with the test).
        su.run("alter table public.render_jobs disable trigger render_jobs_payment_guard")
        old = queue(su, CHAN, {"duration": 30, "video_provider": "veo"}, credit_ref=ref, requested_by=UA)
        assert old.ok, old
        su.run("alter table public.render_jobs enable trigger render_jobs_payment_guard")
        job = old.rows[0][0]
        for q in ("update public.render_jobs set status = 'running', attempts = 1, worker_id = 'w', heartbeat_at = now(), started_at = now() where id = %s",
                  "update public.render_jobs set heartbeat_at = now() where id = %s",
                  "update public.render_jobs set status = 'failed', finished_at = now(), error = '[code:render] x' where id = %s"):
            with acting(conn, SERVICE) as s:
                out = s.run(q, [job])
            assert out.ok and out.rowcount == 1, (q, out)


def test_the_api_route_into_the_guard_rolls_back_the_hold_with_the_refused_insert(conn):
    with as_superuser(conn, commit=False) as su:
        usd = su.rows("select balance_cents, reserved_cents from public.api_accounts where org_id = %s", [ORG_A])[0]
        jobs, holds = su.value("select count(*) from public.render_jobs"), su.value("select count(*) from public.api_holds")
        with kept(conn, ANON) as s:
            control = s.value("select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                              [sha(KEY_A), CHAN, json.dumps({"duration": 60})])
            assert control["ok"] is True and control["status"] == 201, control
        jobs_after_control = su.value("select count(*) from public.render_jobs")
        assert jobs_after_control == jobs + 1
        for params in ({"duration": 60, "video_provider": "veo"}, {"duration": 60, "image_provider": "leonardo"}):
            with acting(conn, ANON) as s:
                res = s.value("select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                              [sha(KEY_A), CHAN, json.dumps(params)])
            assert res["ok"] is False and res["status"] == 500 and res["error"]["code"] == "internal_error", res
            assert "Nothing was created or charged" in res["error"]["message"]
            assert su.value("select count(*) from public.render_jobs") == jobs_after_control      # no second job
            assert su.value("select count(*) from public.api_holds") == holds + 1                 # only the control's hold
        assert su.rows("select balance_cents, reserved_cents from public.api_accounts where org_id = %s", [ORG_A])[0][1] \
            == usd[1] + su.value("select amount_cents from public.api_holds order by created_at desc limit 1")


def test_the_oauth_route_into_the_guard_rolls_back_the_hold_with_the_refused_insert(db, conn):
    c = connect(db)
    with as_superuser(conn, commit=False) as su:
        jobs = su.value("select count(*) from public.render_jobs")
        reserved = su.value("select reserved from public.credit_accounts where org_id = %s", [ORG_A])
        with kept(conn, ANON) as s:
            ok = s.value("select public.oauth_create_video(%s, %s, %s::jsonb, null, null)", [sha(c["at"]), CHAN, json.dumps({"duration": 60})])
        assert ok["ok"] is True and ok["status"] == 201, ok
        held = su.value("select reserved from public.credit_accounts where org_id = %s", [ORG_A])
        assert held > reserved and su.value("select count(*) from public.render_jobs") == jobs + 1
        with acting(conn, ANON) as s:
            res = s.value("select public.oauth_create_video(%s, %s, %s::jsonb, null, null)",
                          [sha(c["at"]), CHAN, json.dumps({"duration": 60, "video_provider": "veo"})])
        assert res["ok"] is False and res["status"] == 500 and res["error"]["code"] == "internal_error", res
        assert su.value("select count(*) from public.render_jobs") == jobs + 1
        assert su.value("select reserved from public.credit_accounts where org_id = %s", [ORG_A]) == held


# ── D12: the API and MCP answer carries a code and a sentence, never the log ─

def failed_job(conn, su, status, error):
    job = paid_job(conn, su)
    su.run("update public.render_jobs set status = %s, error = %s, finished_at = now() where id = %s", [status, error, job])
    return job


def both(conn, su, job, token):
    with acting(conn, ANON) as s:
        a = s.value("select public.api_get_job(%s, %s, 'req_1')", [sha(KEY_A), job])
        o = s.value("select public.oauth_get_job(%s, %s, 'req_1')", [sha(token), job])
    return a, o


MATRIX = [
    # (status, raw error, error_code, sentence key)
    *[("failed", f"[code:{c}] main.py exited with code 1\nlog tail", c, c) for c in
      ("credits", "voice", "provider_quota", "media", "render", "timeout", "unknown")],
    ("failed", "[code:voice]", "voice", "voice"),
    ("failed", "[code:voice]\tmain.py exited", "voice", "voice"),
    ("failed", "[code:future_code] x", "unknown", "unknown"),
    ("failed", "[code:Voice] x", "unknown", "unknown"),
    ("failed", "[code:] x", "unknown", "unknown"),
    ("failed", "main.py exited with code 1", "unknown", "unknown"),                  # failed before codes existed
    ("failed", "x [code:voice] y", "unknown", "unknown"),                              # a prefix is at the start only
    ("failed", "\n[code:voice] x", "unknown", "unknown"),
    ("failed", " ", "unknown", "unknown"),                                             # TypeScript reads any non-empty text as a failure
    ("failed", LOG, "unknown", "unknown"),
    ("failed", "[code:provider_quota] " + LOG, "provider_quota", "provider_quota"),
    ("failed", None, None, None),
    ("failed", "", None, None),
    *[(st, "[code:voice] worker stopping before the run started", None, None) for st in
      ("queued", "running", "succeeded", "cancelled")],
    ("queued", None, None, None),
]


@pytest.mark.parametrize("status,raw,code,sentence", MATRIX, ids=lambda v: repr(v)[:40])
def test_a_job_error_is_a_code_and_a_fixed_sentence_for_a_failed_job_only(db, conn, status, raw, code, sentence):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        job = failed_job(conn, su, status, raw)
        api, oauth = both(conn, su, job, token)
        want = SENTENCES[sentence] if sentence else None
        for answer in (api, oauth):
            assert answer["ok"] is True and answer["status"] == 200, answer
            assert (answer["data"]["error"], answer["data"]["error_code"]) == (want, code), answer["data"]
            # the worker's words, the vendor and the secret-looking text are nowhere in what a caller reads
            text = json.dumps(answer)
            for leak in ("Traceback", "Kling", "KLING_API_KEY", "sk-live", "vendor.example", "exited with code", "main.py", "log tail", "worker stopping"):
                assert leak not in text, (leak, answer)


def test_every_other_field_of_the_job_answer_is_what_it_was(db, conn):
    token = connect(db)["at"]
    with as_superuser(conn, commit=False) as su:
        job = failed_job(conn, su, "failed", "[code:render] boom")
        api, oauth = both(conn, su, job, token)
        row = su.rows("select id, channel_id, status, params, attempts, created_at, started_at, finished_at from public.render_jobs where id = %s", [job])[0]
        assert set(api["data"]) == {"id", "channel_id", "status", "params", "attempts", "created_at", "started_at", "finished_at",
                                    "error", "error_code", "charge"}
        assert set(oauth["data"]) == {"id", "channel_id", "status", "params", "created_at", "started_at", "finished_at",
                                      "error", "error_code", "charge"}
        for answer in (api, oauth):
            d = answer["data"]
            assert (d["id"], d["channel_id"], d["status"], d["params"]) == (row[0], row[1], row[2], row[3])
            assert d["finished_at"] is not None and d["started_at"] is None
        assert api["data"]["attempts"] == row[4]
        assert api["data"]["charge"] is None                    # a credit-paid job has no API balance hold
        assert oauth["data"]["charge"]["status"] == "open" and "held_credits" in oauth["data"]["charge"]
        # the envelope (ok, status, rate headers) is api_finish's, as before
        assert set(api) == set(oauth) and {"ok", "status"} <= set(api)
        # a job that does not exist or is another organization's is still the same 404
        with acting(conn, ANON) as s:
            gone = s.value("select public.api_get_job(%s, 999999999, null)", [sha(KEY_A)])
            gone_o = s.value("select public.oauth_get_job(%s, 999999999, null)", [sha(token)])
        assert gone["status"] == 404 and gone["error"]["code"] == "job_not_found"
        assert gone_o["status"] == 404 and gone_o["error"]["code"] == "job_not_found"


def test_a_job_of_another_organization_is_still_a_404_and_a_stranger_a_401(db, conn):
    other = connect(db, uid=UB)["at"]
    with as_superuser(conn, commit=False) as su:
        job = failed_job(conn, su, "failed", "[code:voice] x")
        with acting(conn, ANON) as s:
            mine = s.value("select public.oauth_get_job(%s, %s, null)", [sha(other), job])
            stranger = s.value("select public.api_get_job(%s, %s, null)", [sha("nobody"), job])
        assert mine["status"] == 404 and mine["error"]["code"] == "job_not_found", mine
        assert stranger["ok"] is False and stranger["status"] == 401, stranger


# ── grants, replay, rollback ────────────────────────────────────────────────

def acls(su):
    return su.rows("select p.oid::regprocedure::text, p.proacl::text, p.prosecdef, coalesce(p.proconfig, '{}') "
                   "from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1")


def priv(su, sig):
    return [su.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [r, sig]) for r in ("anon", "authenticated", "service_role")]


def test_the_grants_are_what_0042_and_0093_and_0041_made_them(conn):
    with as_superuser(conn, commit=False) as su:
        assert priv(su, API_JOB) == [True, False, False]
        assert priv(su, OAUTH_JOB) == [True, False, False]
        assert priv(su, GUARD)[:2] == [False, False]
        # the helper is for the two definer functions alone
        assert priv(su, HELPER) == [False, False, False]
        for sig in (API_JOB, OAUTH_JOB, GUARD):
            assert su.value("select prosecdef from pg_proc where oid = %s::regprocedure", [sig]) is True
            assert "search_path=public, pg_temp" in su.value("select proconfig::text from pg_proc where oid = %s::regprocedure", [sig])
        assert "search_path=public, pg_temp" in su.value("select proconfig::text from pg_proc where oid = %s::regprocedure", [HELPER])
        assert su.value("select provolatile from pg_proc where oid = %s::regprocedure", [HELPER]) == "i"


def test_a_signed_in_user_cannot_call_the_helper_or_read_a_job_error_around_it(conn):
    with as_superuser(conn, commit=False):
        for who in (ANON, CUSTOMER, OPERATOR, SERVICE):
            with acting(conn, who) as s:
                out = s.run("select public.render_job_public_error('failed', 'x')")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_replay_changes_no_definition_and_no_privilege(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        sec_db.take_off_0122(su)
        before = acls(su)
        defs = [su.value("select pg_get_functiondef(%s::regprocedure)", [s]) for s in (*CHANGED, HELPER)]
        for _ in range(2):
            su.conn.execute(text)
            su.conn.execute(LATER.read_text(encoding="utf-8"))
        assert acls(su) == before
        assert [su.value("select pg_get_functiondef(%s::regprocedure)", [s]) for s in (*CHANGED, HELPER)] == defs


def test_the_migration_touches_no_other_function_and_no_table_policy_or_trigger(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        sec_db.take_off_0122(su)
        def snapshot():
            return (su.rows("select p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), p.proacl::text from pg_proc p "
                            "where p.pronamespace = 'public'::regnamespace and p.oid::regprocedure::text <> all(%s) order by 1",
                            [[*CHANGED, HELPER]]),
                    su.rows("select tgname, tgrelid::regclass::text, tgenabled, tgtype from pg_trigger where not tgisinternal order by 1, 2"),
                    su.rows("select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies order by 1, 2, 3"),
                    su.rows("select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint "
                            "where connamespace = 'public'::regnamespace order by 1, 2"),
                    su.rows("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by 1, 2"))
        before = snapshot()
        su.conn.execute(text)
        su.conn.execute(LATER.read_text(encoding="utf-8"))
        assert snapshot() == before


def test_the_rollback_restores_the_three_functions_byte_for_byte_and_the_migration_applies_again(db, conn):
    admin = sec_db.admin_dsn()
    base = f"ns_vsafe_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    try:
        # (0120 replaces 0111's guard and refuses to do so on a database that never had it: the base for "before 0111" stops short of it too)
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0111_", "0120_", "0122_", "0127_"))])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {s: (b.execute("select pg_get_functiondef(%s::regprocedure)", [s]).fetchone()[0],
                        b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [s]).fetchone()[0]) for s in CHANGED}
            base_fns = {r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    with as_superuser(conn, commit=False) as su:
        sec_db.take_off_0122(su)
        after_0111 = {s: su.value("select pg_get_functiondef(%s::regprocedure)", [s]) for s in (*CHANGED, HELPER)}
        assert after_0111[GUARD] != want[GUARD][0] and after_0111[API_JOB] != want[API_JOB][0]
        acl_before = su.rows("select p.oid::regprocedure::text, p.proacl::text from pg_proc p "
                             "where pronamespace = 'public'::regnamespace and p.proname <> 'render_job_public_error' order by 1")
        su.conn.execute("\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;")))
        for s in CHANGED:
            assert su.value("select pg_get_functiondef(%s::regprocedure)", [s]) == want[s][0], s
            assert su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [s]) == want[s][1], s
        later_fns = set(re.findall(r"(?m)^create or replace function public\.(\w+)\(", LATER.read_text(encoding="utf-8")))
        assert {r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")
                if r[0] in base_fns or r[0].split("(")[0] not in later_fns} == base_fns
        assert su.rows("select p.oid::regprocedure::text, p.proacl::text from pg_proc p "
                       "where pronamespace = 'public'::regnamespace order by 1") == acl_before
        # a provider is accepted again, the raw error is returned again
        ref = hold(su)
        with acting(conn, CUSTOMER) as s:
            assert queue(s, CHAN, {"duration": 30, "video_provider": "veo"}, credit_ref=ref).ok
        # and the rollback replays, then 0111 applies again to exactly what it was
        su.conn.execute("\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;")))
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        su.conn.execute(LATER.read_text(encoding="utf-8"))
        assert {s: su.value("select pg_get_functiondef(%s::regprocedure)", [s]) for s in (*CHANGED, HELPER)} == after_0111


# ── D15: the schedule ───────────────────────────────────────────────────────

JOB = "nightshift-expire-credit-reservations"
STUB = """
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $f$
declare id bigint;
begin
  if current_setting('stub.cron_fails', true) = 'on' then raise exception 'cron is unhappy'; end if;
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into id;
  return id;
end $f$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $f$
begin
  delete from cron.job where jobname = job_name;
  if not found then raise exception 'could not find valid entry for job ''%''', job_name; end if;
  return true;
end $f$;
"""


def jobs(su):
    return su.rows("select jobname, schedule, command from cron.job order by jobid")


def test_without_pg_cron_the_migration_applies_and_creates_no_schedule(conn):
    with as_superuser(conn, commit=False) as su:
        assert su.value("select to_regclass('cron.job') is null and to_regprocedure('cron.schedule(text,text,text)') is null")
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert su.value("select position('video_provider' in pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)) > 0")


def test_with_pg_cron_it_schedules_the_sweep_every_ten_minutes_once_even_when_replayed(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(STUB)
        su.conn.execute(text)
        assert jobs(su) == [(JOB, "*/10 * * * *", "select public.expire_credit_reservations()")]
        first = su.value("select jobid from cron.job")
        su.conn.execute(text)
        su.conn.execute(text)
        assert jobs(su) == [(JOB, "*/10 * * * *", "select public.expire_credit_reservations()")]
        assert su.value("select jobid from cron.job") != first      # unscheduled, then scheduled again
        # somebody else's jobs are never touched
        su.conn.execute("insert into cron.job (jobname, schedule, command) values ('nightshift-expire-credit-lots', '17 * * * *', 'select 1')")
        su.conn.execute(text)
        assert sorted(r[0] for r in jobs(su)) == ["nightshift-expire-credit-lots", JOB]


def test_a_changed_schedule_by_hand_is_put_back_by_a_replay(conn):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(STUB)
        su.conn.execute("insert into cron.job (jobname, schedule, command) values (%s, '* * * * *', 'select 1')", [JOB])
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert jobs(su) == [(JOB, "*/10 * * * *", "select public.expire_credit_reservations()")]


def test_a_failing_pg_cron_cannot_fail_the_migration_and_keeps_the_old_schedule(conn):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(STUB)
        su.conn.execute("insert into cron.job (jobname, schedule, command) values (%s, '0 * * * *', 'select 1')", [JOB])
        su.conn.execute("select set_config('stub.cron_fails', 'on', true)")
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))               # raises nothing
        # all or nothing: the unschedule was undone with the failed schedule
        assert jobs(su) == [(JOB, "0 * * * *", "select 1")]
        # and everything outside the cron block still applied
        assert su.value("select position('render_job_public_error' in pg_get_functiondef('public.api_get_job(text, bigint, text)'::regprocedure)) > 0")


def test_the_rollback_removes_the_schedule_and_only_that_one(conn):
    rollback = ROLLBACK.read_text(encoding="utf-8")
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(STUB)
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        su.conn.execute("insert into cron.job (jobname, schedule, command) values ('nightshift-expire-credit-lots', '17 * * * *', 'select 1')")
        su.conn.execute(body)
        assert [r[0] for r in jobs(su)] == ["nightshift-expire-credit-lots"]
        su.conn.execute(body)                                                 # nothing to remove: no error
    with as_superuser(conn, commit=False) as su:
        su.conn.execute(body)                                                 # no pg_cron at all: no error


def test_the_sweep_cannot_be_called_by_a_browser_but_a_cron_session_may(conn):
    with as_superuser(conn, commit=False):
        for who in (ANON, CUSTOMER, OPERATOR):
            with acting(conn, who) as s:
                out = s.run("select public.expire_credit_reservations()")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
    # pg_cron's session: the database owner with no request claims, exactly what the SQL editor is
    with as_superuser(conn, commit=False) as su:
        out = su.run("select public.expire_credit_reservations()")
        assert out.ok and isinstance(out.rows[0][0], int), out
        assert su.value("select to_regprocedure('public.expire_credit_reservations(uuid, interval, interval)') is not null")


# ── D15: the sweep beside a settlement ──────────────────────────────────────

def _scratch_hold(db, ref, age="4 hours", amount=50):
    db.su("select public.reserve_credits(%s, %s, %s)", [ORG_B, ref, amount])
    db.su("update public.credit_reservations set created_at = now() - %s::interval where job_id = %s", [age, ref])


def _books(db, ref):
    status, captured = db.su("select status, captured from public.credit_reservations where job_id = %s", [ref])[0]
    notes = [r for r in db.su("select kind, amount, note from public.credit_transactions where job_id = %s order by id", [ref])]
    bal = db.su("select balance, reserved from public.credit_accounts where org_id = %s", [ORG_B])[0]
    return status, captured, notes, bal


def _wait_blocked(db, blocked_query, seconds=5.0):
    """True once some other session is waiting on a lock in the statement this query looks for."""
    end = time.time() + seconds
    while time.time() < end:
        if db.su(blocked_query)[0][0]:
            return True
        time.sleep(0.05)
    return False


def test_a_capture_and_the_sweep_racing_one_old_hold_settle_it_once_and_the_money_adds_up(db):
    ref = f"rj-race-{uuid.uuid4().hex[:8]}"
    _scratch_hold(db, ref)
    start = db.su("select balance, reserved from public.credit_accounts where org_id = %s", [ORG_B])[0]
    settle = psycopg.connect(db.dsn, autocommit=False)
    sweep_out = {}
    try:
        # The worker's settlement is mid-flight (account lock and hold row held, not yet committed) ...
        settle.execute("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)")
        settle.execute("set local role service_role")
        assert settle.execute("select public.capture_credits(%s, 20)", [ref]).fetchone()[0] == 20

        def sweep():
            with psycopg.connect(db.dsn, autocommit=True) as c:
                sweep_out["n"] = c.execute("select public.expire_credit_reservations(%s)", [ORG_B]).fetchone()[0]

        t = threading.Thread(target=sweep)
        t.start()
        # ... the sweep (pg_cron's session) waits for it instead of reading around it
        assert _wait_blocked(db, "select count(*) > 0 from pg_stat_activity where wait_event_type = 'Lock' "
                                 "and query like '%expire_credit_reservations%' and pid <> pg_backend_pid()"), "the sweep did not wait"
        assert "n" not in sweep_out
        settle.commit()
        t.join(timeout=30)
        assert not t.is_alive()
    finally:
        settle.close()
    status, captured, notes, bal = _books(db, ref)
    assert sweep_out["n"] == 0                                    # it found the hold already settled
    assert (status, captured) == ("captured", 20)
    assert [n[0] for n in notes] == ["reserve", "capture", "release"] and not any("expired" in (n[2] or "") for n in notes)
    assert (bal[0], bal[1]) == (start[0] - 20, start[1] - 50)       # 20 spent, the whole hold no longer reserved, nothing twice


def test_the_sweep_first_then_a_late_capture_charges_nothing_and_leaves_no_negative_reservation(db):
    ref = f"rj-late-{uuid.uuid4().hex[:8]}"
    _scratch_hold(db, ref)
    start = db.su("select balance, reserved from public.credit_accounts where org_id = %s", [ORG_B])[0]
    sweep = psycopg.connect(db.dsn, autocommit=False)
    cap_out = {}
    try:
        assert sweep.execute("select public.expire_credit_reservations(%s)", [ORG_B]).fetchone()[0] == 1

        def capture():
            with psycopg.connect(db.dsn, autocommit=False) as c:
                c.execute("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)")
                c.execute("set local role service_role")
                cap_out["amount"] = c.execute("select public.capture_credits(%s, 20)", [ref]).fetchone()[0]
                c.commit()

        t = threading.Thread(target=capture)
        t.start()
        assert _wait_blocked(db, "select count(*) > 0 from pg_stat_activity where wait_event_type = 'Lock' "
                                 "and query like '%capture_credits%' and pid <> pg_backend_pid()"), "the capture did not wait"
        sweep.commit()
        t.join(timeout=30)
        assert not t.is_alive()
    finally:
        sweep.close()
    status, captured, notes, bal = _books(db, ref)
    # The documented limit of releasing on time: a hold the sweep released is gone, the later capture is a no-op returning 0
    assert cap_out["amount"] == 0 and status == "released"
    assert [n[0] for n in notes] == ["reserve", "release"] and "expired" in notes[1][2]
    assert (bal[0], bal[1]) == (start[0], start[1] - 50)
    assert db.su("select reserved >= 0 from public.credit_accounts where org_id = %s", [ORG_B])[0][0]


def test_a_started_hold_is_not_released_by_the_three_hour_rule(db):
    ref = f"rj-started-{uuid.uuid4().hex[:8]}"
    _scratch_hold(db, ref)
    db.su("select public.start_credit_reservation(%s, %s)", [ref, ORG_B])
    assert db.su("select public.expire_credit_reservations(%s)", [ORG_B])[0][0] == 0
    assert db.su("select status from public.credit_reservations where job_id = %s", [ref])[0][0] == "open"
    db.su("select public.release_credits(%s)", [ref])


def test_two_sweeps_at_once_release_each_hold_once_and_do_not_deadlock(db):
    refs = [f"rj-two-{i}-{uuid.uuid4().hex[:6]}" for i in range(3)]
    for r in refs:                                  # reserve first, age after: reserve_credits itself frees an org's stale holds
        db.su("select public.reserve_credits(%s, %s, 20)", [ORG_B, r])
    db.su("update public.credit_reservations set created_at = now() - interval '4 hours' where job_id = any(%s)", [refs])
    out = []

    def sweep():
        with psycopg.connect(db.dsn, autocommit=True) as c:
            out.append(c.execute("select public.expire_credit_reservations(%s)", [ORG_B]).fetchone()[0])

    threads = [threading.Thread(target=sweep) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads)
    assert len(out) == 2 and sum(out) == 3                    # three holds, three releases between the two sweeps
    for r in refs:
        assert db.su("select status from public.credit_reservations where job_id = %s", [r])[0][0] == "released"
        assert db.su("select count(*) from public.credit_transactions where job_id = %s and kind = 'release'", [r])[0][0] == 1
