"""Migration 0120 (Series Factory, slice S2): plans, episodes, and the one function that spends.

The attackers are the people a browser can be: another member of the same organization (a viewer, an editor), a member of another
organization, the anon key, and the service key where it should not reach. What must NOT change is checked beside every refusal: the
rest of the render queue (a customer's "Run now" row, the payment guard) behaves as before.

The money is the point. start_series_episode() holds credits and queues a paid run, so the tests pin: the database prices the episode (the
browser's number is only a confirmation), an unpriced episode is refused rather than held at 0, a double press holds once, a short balance
changes nothing, an expired hold is not revived, and two presses at the same moment hold once.

request_series_plan() is DORMANT in this migration (granted to no API role, as 0117 did with request_voice_clone): the tests call it as the
database owner carrying a person's JWT claims, the way the later server-side caller would, and a separate test proves that no API role can
call it. Everything runs on the shared scenario (conftest ``conn`` / ``sc``) inside transactions that are rolled back, except the two races,
which need real concurrent transactions and clean up after themselves. Nothing calls a provider: the worker is played by the test.
"""

from __future__ import annotations

import json
import re
import threading
import uuid

import psycopg
import pytest
from psycopg import sql

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0120_series_tables.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0120_series_tables.sql"

# video_minute 6 credits/min with a 25% margin = 7.5/min: 120 s = 15.00, 30 s = 3.75 -> the 5.00 floor, 300 s = 37.50.
PRICES = {"video_minute": (6, "0.25"), "job_minimum": (5, "0")}
SECS = 120
PRICE = 15
TABLES = ["series_plans", "series_episodes"]


# ── building blocks ───────────────────────────────────────────────────────────────────────────────────────────────────────

def become(s, who):
    """Continue the same transaction as another API caller (the database owner when ``who`` is None)."""
    s.conn.execute("reset role")
    if who is None:
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        return s
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def become_claims(s, who):
    """The database owner carrying a person's JWT claims: auth.uid() is theirs, but no API role is in force. request_series_plan() is granted
    to nobody until S3, so a later server-side caller (or this test) reaches it this way."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    return s


def key() -> str:
    return f"k-{uuid.uuid4().hex}"


def set_prices(su, prices=PRICES):
    for unit, (rate, margin) in prices.items():
        su.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, %s) "
                "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = excluded.margin "
                "returning 1", [unit, rate, margin])


def not_found(out):
    return not out.ok and out.sqlstate == "P0002" and out.error == "not_found"


def forbidden(out):
    return not out.ok and out.sqlstate == "42501" and out.error == "forbidden"


def refused(out, state, word):
    return not out.ok and out.sqlstate == state and out.error == word


def denied(out):
    """The API role has no privilege at all (a GRANT is missing): not the function's own refusal."""
    return not out.ok and out.sqlstate == "42501" and out.error.startswith("permission denied")


def request(s, who, channel, *, topic="The fall of an empire", n=3, language=None, duration=SECS, series=None, idem=None, claims=True):
    (become_claims if claims else become)(s, who)
    return s.run("select public.request_series_plan(%s, %s, %s, %s, %s, %s, %s)",
                 [channel, topic, n, language, duration, series, idem or key()])


def requested(s, who, channel, **kw):
    out = request(s, who, channel, **kw)
    assert out.ok, out
    return out.rows[0][0]


def episodes_json(n=3, *, usable=None, confirm=None):
    usable = usable or {}
    confirm = confirm or {}
    return [{"topic": f"Episode {i} of the series {uuid.uuid4().hex[:6]}", "outline": {"working_title": f"Part {i}", "key_facts": ["x"]},
             "usable": usable.get(i, True), "needs_confirmation": confirm.get(i, False)} for i in range(1, n + 1)]


def finish(s, plan, *, ok=True, title="A series", report=None, quote=None, episodes=None, n=3, code=None, error=None, who=SERVICE):
    become(s, who)
    return s.run("select public.finish_series_plan(%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s)",
                 [plan, ok, title if ok else None, json.dumps(report or {"fact_checked": False}) if ok else None,
                  json.dumps(quote) if quote else None, json.dumps(episodes or episodes_json(n)) if ok else None, code, error])


def ready_plan(s, who, channel, *, n=3, usable=None, confirm=None, **kw):
    """A requested plan the worker has finished: returns (plan id, [episode ids in order])."""
    plan = requested(s, who, channel, n=n, **kw)["id"]
    done = finish(s, plan, episodes=episodes_json(n, usable=usable, confirm=confirm), n=n)
    assert done.ok, done
    become(s, None)
    return plan, [str(r[0]) for r in s.rows("select id from public.series_episodes where plan_id = %s order by n", [plan])]


def quote(s, who, episode):
    become(s, who)
    return s.run("select public.quote_series_episode(%s)", [episode])


def start(s, who, episode, max_credits=PRICE, *, idem=None, confirmed=None):
    become(s, who)
    idem = f"se:{episode}" if idem is None else idem
    if confirmed is None:
        return s.run("select public.start_series_episode(%s, %s::numeric, %s)", [episode, max_credits, idem])
    return s.run("select public.start_series_episode(%s, %s::numeric, %s, %s)", [episode, max_credits, idem, confirmed])


def started(s, who, episode, max_credits=PRICE, **kw):
    out = start(s, who, episode, max_credits, **kw)
    assert out.ok, out
    return out.rows[0][0]


def finish_job(su, job_id, status="succeeded", *, settle=True):
    """The worker's end of a run, played by the database owner (the worker's own function needs a claim and a heartbeat), and its
    settlement as the service role: a succeeded run captures its hold, any other end releases it (a plan's parallel limit counts open holds)."""
    become(su, None)
    ref = su.value("select credit_ref from public.render_jobs where id = %s", [job_id])
    su.rows("update public.render_jobs set status = %s, started_at = now(), finished_at = now() where id = %s returning 1", [status, job_id])
    if settle and ref and status in ("succeeded", "failed", "cancelled"):
        become(su, SERVICE)
        if status == "succeeded":
            su.value("select public.capture_credits(%s, %s)", [ref, PRICE])
        else:
            su.value("select public.release_credits(%s)", [ref])
        become(su, None)


def backdate(su, plan, interval):
    """Make a plan look older. created_at is frozen by a trigger (the daily cap counts it), so the owner steps past the triggers for this."""
    become(su, None)
    su.conn.execute("set local session_replication_role = replica")
    su.conn.execute("update public.series_plans set created_at = now() - %s::interval where id = %s", [interval, plan])
    su.conn.execute("set local session_replication_role = origin")


def hold(su, ref):
    become(su, None)
    rows = su.rows("select amount, status from public.credit_reservations where job_id = %s", [ref])
    return rows[0] if rows else None


def holds(su, org):
    """Every series hold of the organization, however old."""
    become(su, None)
    return su.rows("select job_id, amount, status from public.credit_reservations where org_id = %s and job_id like 'rj-se-%%' order by created_at",
                   [org])


def jobs_of_plan(su, plan):
    become(su, None)
    return su.rows("select id, kind, params, credit_ref, status from public.render_jobs where series_plan_id = %s", [plan])


def episode_row(su, episode):
    become(su, None)
    return su.rows("select status, credit_ref, credits_held, render_job_id, idempotency_key from public.series_episodes where id = %s", [episode])[0]


def run_jobs(su, channel):
    """The channel's 'daily' queue rows made by an episode start (they carry a series or an rj-se hold)."""
    become(su, None)
    return su.rows("select id, params, credit_ref from public.render_jobs where channel_id = %s and credit_ref like 'rj-se-%%'", [channel])


@pytest.fixture()
def world(conn, sc):
    """A rolled-back transaction with: the price list, org A with an owner (alice), an admin, a second admin, an editor and a viewer, a
    platform administrator, org B (bob), the operator's own (credit-exempt) organization and two more channels in org A. Namespace."""
    with as_superuser(conn, commit=False) as su:
        w = type("World", (), {})()
        w.su, w.sc = su, sc
        for key_, role in (("adm", "admin"), ("adm2", "admin"), ("ed", "editor"), ("viewer", "viewer")):
            who = user(f"series-{key_}", f"series-{key_}@a.test")
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [sc.alice.org, who.uid, who.email, role])
            setattr(w, key_, who)
        w.platform = user("series-platform", "series-platform@nightshift.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [w.platform.uid, w.platform.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1", [w.platform.uid, w.platform.email])
        w.alice, w.bob, w.operator, w.stranger = sc.alice.actor, sc.bob.actor, sc.operator, sc.stranger
        w.org_a, w.org_b = sc.alice.org, sc.bob.org
        w.chan_a, w.chan_b = sc.alice.channel, sc.bob.channel
        w.chan_op = su.value("select channel_id from public.channels where org_id = public.default_org_id() limit 1")
        w.org_op = su.value("select public.default_org_id()")
        for ch in ("chan-a2", "chan-a3"):
            su.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', %s) returning 1",
                    [ch, ch, w.org_a])
        w.chan_a2, w.chan_a3 = "chan-a2", "chan-a3"
        set_prices(su)
        # 0127 adds a per-person (3) and a platform-wide (30) daily cap beside the organization's (5). The 0120 / 0122 tests here are about the
        # ORGANIZATION's cap and the rest of the function, and one editor makes five plans in several of them, so the owner's numbers are raised
        # out of the way for these rolled-back worlds (tests/security/test_sec_series_plan_caps.py owns the new caps and leaves them as shipped).
        if su.value("select to_regclass('public.series_plan_cap_settings') is not null"):
            su.rows("update public.series_plan_cap_settings set user_daily_cap = 1000, global_daily_cap = 10000 returning 1")
        # Alice is on the Creator plan (two parallel runs) and the scenario holds two for her: free them, so what these tests hold is
        # counted by the plan's limit alone.
        become(su, SERVICE)
        for ref in ("job-a", "rj-seed-a"):
            su.value("select public.release_credits(%s)", [ref])
        become(su, None)
        yield w


# ═══ 1. who may call what (the privileges) ═════════════════════════════════════════════════════════════════════════════════

SIGS = {
    # 0122 replaced the seven-argument function with an eight-argument one (p_template); the tests that take 0122 off use SIGS_0120.
    "request_series_plan": "public.request_series_plan(text,text,integer,text,integer,text,text,text)",
    "finish_series_plan": "public.finish_series_plan(uuid,boolean,text,jsonb,jsonb,jsonb,text,text)",
    "quote_series_episode": "public.quote_series_episode(uuid)",
    "start_series_episode": "public.start_series_episode(uuid,numeric,text,boolean)",
    "series_plan_daily_limit": "public.series_plan_daily_limit()",
    "series_episode_price": "public.series_episode_price(integer)",
    "series_episode_blocker": "public.series_episode_blocker(uuid)",
    "series_episode_json": "public.series_episode_json(uuid)",
    "series_plans_terms_frozen": "public.series_plans_terms_frozen()",
    "series_episodes_terms_frozen": "public.series_episodes_terms_frozen()",
    "series_rows_no_delete": "public.series_rows_no_delete()",
}
SIGS_0120 = {**SIGS, "request_series_plan": "public.request_series_plan(text,text,integer,text,integer,text,text)"}
# (anon, authenticated, service_role, PUBLIC-by-way-of-anon-or-authenticated): the grant matrix the file promises.
GRANTS = {
    "request_series_plan": (False, False, False),   # dormant until S3
    "finish_series_plan": (False, False, True),     # the worker
    "quote_series_episode": (False, True, False),
    "start_series_episode": (False, True, False),
    "series_plan_daily_limit": (False, False, False),
    "series_episode_price": (False, False, False),
    "series_episode_blocker": (False, False, False),
    "series_episode_json": (False, False, False),
    "series_plans_terms_frozen": (False, False, False),
    "series_episodes_terms_frozen": (False, False, False),
    "series_rows_no_delete": (False, False, False),
}


@pytest.mark.parametrize("name", sorted(GRANTS))
def test_the_grant_matrix_is_exactly_what_the_migration_promises(conn, name):
    with as_superuser(conn, commit=False) as su:
        got = tuple(su.value("select has_function_privilege(%s, %s::regprocedure, 'execute')", [role, SIGS[name]])
                    for role in ("anon", "authenticated", "service_role"))
        public = su.value("select coalesce(bool_or(a.grantee = 0), false) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a "
                          "where p.oid = %s::regprocedure", [SIGS[name]])
    assert got == GRANTS[name], f"{name}: anon/authenticated/service_role = {got}"
    assert public is False, f"{name} is executable by PUBLIC"


@pytest.mark.parametrize("name", sorted(SIGS))
def test_every_function_is_a_definer_with_a_pinned_search_path_or_a_plain_trigger_function(conn, name):
    with as_superuser(conn, commit=False) as su:
        definer, config = su.rows("select prosecdef, coalesce(proconfig::text, '') from pg_proc where oid = %s::regprocedure", [SIGS[name]])[0]
    assert "search_path=public, pg_temp" in config, f"{name}: {config}"
    if name in ("series_plans_terms_frozen", "series_episodes_terms_frozen", "series_rows_no_delete", "series_plan_daily_limit"):
        return  # trigger functions and a constant run as the caller; they read nothing a caller must not
    assert definer, f"{name} must be SECURITY DEFINER"


def test_request_series_plan_is_dormant_no_api_role_can_call_it(conn, world):
    s = world.su
    for who in (world.alice, world.adm, world.ed, world.bob, ANON, SERVICE):
        out = request(s, who, world.chan_a, claims=False)
        assert denied(out), (who.name, out)
    assert s.value("select count(*) from public.series_plans where created_at >= now()") == 0


def test_the_helpers_are_not_callable_through_the_api(conn, world):
    s = world.su
    for who in (ANON, world.alice, SERVICE):
        become(s, who)
        for call in ("public.series_plan_daily_limit()", "public.series_episode_price(120)",
                     f"public.series_episode_blocker('{uuid.uuid4()}')", f"public.series_episode_json('{uuid.uuid4()}')"):
            out = s.run(f"select {call}")
            assert denied(out), (who.name, call, out)


def test_anon_can_call_nothing_here_and_sees_no_row(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, ANON)
    for call, args in (("quote_series_episode", [eps[0]]), ("start_series_episode", [eps[0], PRICE, f"se:{eps[0]}"]),
                       ("finish_series_plan", [plan, True, "t", "{}", None, "[]", None, None])):
        marks = ", ".join(["%s"] * len(args))
        out = s.run(f"select public.{call}({marks})", args)
        assert denied(out), (call, out)
    for t in TABLES:
        assert denied(s.run(f"select count(*) from public.{t}")), t


# ═══ 2. no direct writes, members read their own organization only ═════════════════════════════════════════════════════════

def test_no_api_role_can_write_either_table(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    writes = [
        ("insert into public.series_plans (org_id, channel_id, topic, niche, language, n_episodes, duration_s, idempotency_key, request_hash) "
         "values (%s, %s, 't', 'n', 'English', 3, 120, 'direct-write-1', %s)", [world.org_a, world.chan_a, "a" * 32]),
        ("update public.series_plans set topic = 'hijacked' where id = %s", [plan]),
        ("delete from public.series_plans where id = %s", [plan]),
        ("insert into public.series_episodes (plan_id, org_id, n, topic, outline, usable, duration_s) values (%s, %s, 4, 't', '{}', true, 120)",
         [plan, world.org_a]),
        ("update public.series_episodes set usable = true, status = 'started' where id = %s", [eps[0]]),
        ("update public.series_episodes set credit_ref = 'rj-se-' || repeat('0', 32) where id = %s", [eps[0]]),
        ("delete from public.series_episodes where id = %s", [eps[0]]),
    ]
    for who in (world.alice, world.adm, world.ed, world.bob, SERVICE, ANON):
        become(s, who)
        for q, p in writes:
            out = s.run(q, p)
            assert denied(out), (who.name, q[:60], out)
    become(s, None)
    assert s.value("select topic from public.series_plans where id = %s", [plan]) == "The fall of an empire"


def test_the_owner_cannot_rewrite_a_finished_plan_or_a_started_episode_and_nothing_is_deleted(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    started(s, world.adm, eps[0])
    become(s, None)
    for q, p in (("update public.series_plans set topic = 'x' where id = %s", [plan]),
                 ("update public.series_plans set status = 'failed', error_code = 'x' where id = %s", [plan]),
                 ("update public.series_episodes set topic = 'x' where id = %s", [eps[0]]),
                 ("update public.series_episodes set credits_held = 1 where id = %s", [eps[0]]),
                 ("update public.series_episodes set status = 'planned' where id = %s", [eps[0]]),
                 ("delete from public.series_plans where id = %s", [plan]),
                 ("delete from public.series_episodes where id = %s", [eps[1]])):
        out = s.run(q, p)
        assert not out.ok and out.sqlstate == "42501", (q, out)


def test_a_member_reads_only_their_own_organizations_rows(conn, sc, world):
    s = world.su
    plan_a, eps_a = ready_plan(s, world.ed, world.chan_a)
    plan_b, eps_b = ready_plan(s, world.bob, world.chan_b)
    for who, mine, theirs, mine_eps, their_eps in ((world.viewer, plan_a, plan_b, eps_a, eps_b), (world.bob, plan_b, plan_a, eps_b, eps_a)):
        become(s, who)
        assert s.value("select count(*) from public.series_plans where id = %s", [mine]) == 1
        assert s.value("select count(*) from public.series_plans where id = %s", [theirs]) == 0
        assert s.value("select count(*) from public.series_episodes where id = any(%s)", [mine_eps]) == 3
        assert s.value("select count(*) from public.series_episodes where id = any(%s)", [their_eps]) == 0
    become(s, world.stranger)
    assert s.value("select count(*) from public.series_plans") == 0


PLAN_COLS = ("org_id, channel_id, series_id, topic, niche, language, n_episodes, duration_s, status, title, report, error_code, "
             "idempotency_key, request_hash, result_hash, finished_at")


def plan_values(**over):
    base = dict(org_id=None, channel_id="chan-a", series_id=None, topic="A topic", niche="tech", language="English", n_episodes=3,
                duration_s=120, status="requested", title=None, report=None, error_code=None,
                idempotency_key="table-check-0001", request_hash="c" * 32, result_hash=None, finished_at=None)
    base.update(over)
    return base


def insert_plan(s, org, **over):
    v = plan_values(org_id=org, **over)
    cols = ", ".join(v)
    marks = ", ".join(["%s" if k != "report" else "%s::jsonb" for k in v])
    return s.run(f"insert into public.series_plans ({cols}) values ({marks}) returning id",
                 [json.dumps(x) if k == "report" and x is not None else x for k, x in v.items()])


def test_the_tables_own_checks_refuse_what_the_functions_never_write(conn, world):
    """Defence in depth: even the database owner cannot store a malformed row, a second plan in flight on one channel, or a plan that
    says it is finished without saying how."""
    s = world.su
    become(s, None)
    ok = insert_plan(s, world.org_a)
    assert ok.ok, ok
    bad = [
        ("one plan in flight per channel", dict(idempotency_key="table-check-0002"), "23505"),
        ("the same key again", dict(channel_id="chan-a2"), "23505"),
        ("5 episodes", dict(n_episodes=5, channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("2 episodes", dict(n_episodes=2, channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("29 seconds", dict(duration_s=29, channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("3601 seconds", dict(duration_s=3601, channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("a language with markup", dict(language="<b>", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("a padded topic", dict(topic=" padded ", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("a topic with a line break", dict(topic="a\nb", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("an empty niche", dict(niche="", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("a series slug with a slash", dict(series_id="a/b", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("a channel id with capitals", dict(channel_id="Chan-A", idempotency_key="table-check-0003"), "23514"),
        ("a short key", dict(idempotency_key="short", channel_id="chan-a2"), "23514"),
        ("a bad hash", dict(request_hash="xyz", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("ready without a title", dict(status="ready", report={"a": 1}, result_hash="d" * 32, finished_at="now()", channel_id="chan-a2",
                                       idempotency_key="table-check-0003"), "23514"),
        ("failed without a code", dict(status="failed", finished_at="2026-01-01", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("requested but finished", dict(finished_at="2026-01-01", channel_id="chan-a2", idempotency_key="table-check-0003"), "23514"),
        ("a failed plan that kept a title", dict(status="failed", error_code="x", title="t", finished_at="2026-01-01", channel_id="chan-a2",
                                                 idempotency_key="table-check-0003"), "23514"),
    ]
    for label, over, state in bad:
        if over.get("finished_at") == "now()":
            over["finished_at"] = "2026-01-01"
            over["title"] = None
        out = insert_plan(s, world.org_a, **over)
        assert not out.ok and out.sqlstate == state, (label, out)
    # the same organization-scoped key under another organization is allowed (a key is the organization's own)
    assert insert_plan(s, world.org_b, channel_id="chan-b").ok
    plan = ok.rows[0][0]
    ep = lambda **o: s.run("insert into public.series_episodes (plan_id, org_id, n, topic, outline, usable, needs_confirmation, duration_s, status, "  # noqa: E731
                           "idempotency_key, request_hash, credit_ref, credits_held, render_job_id, started_by, started_at) "
                           "values (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                           [plan, o.get("org", world.org_a), o.get("n", 1), o.get("topic", "T"), json.dumps(o.get("outline", {})), o.get("usable", True),
                            o.get("confirm", False), o.get("dur", 120), o.get("status", "planned"), o.get("key"), o.get("hash"), o.get("ref"),
                            o.get("held"), o.get("job"), o.get("by"), o.get("at")])
    assert ep(n=1).ok
    for label, out, state in (
        ("the same number twice", ep(n=1), "23505"),
        ("episode 5", ep(n=5), "23514"),
        ("an unconfirmed episode that is unusable", ep(n=2, usable=False, confirm=True), "23514"),
        ("another organization's plan", ep(n=2, org=world.org_b), "23503"),
        ("a started episode with no run", ep(n=2, status="started", key=f"se:{uuid.uuid4()}", hash="e" * 32, by=world.adm.uid, at="2026-01-01"), "23514"),
        ("a hold on a planned episode", ep(n=2, ref="rj-se-" + "a" * 32, held=15), "23514"),
        ("a hold of zero", ep(n=2, status="started", key=f"se:{uuid.uuid4()}", hash="e" * 32, by=world.adm.uid, at="2026-01-01", job=99999,
                              ref="rj-se-" + "a" * 32, held=0), "23514"),
        ("a hold reference of another shape", ep(n=2, status="started", key=f"se:{uuid.uuid4()}", hash="e" * 32, by=world.adm.uid,
                                                 at="2026-01-01", job=99999, ref="rj-" + "a" * 32, held=15), "23514"),
        ("an oversize outline", ep(n=2, outline={"k": "x" * 9000}), "23514"),
        ("an outline that is not an object", ep(n=2, outline=[1]), "23514"),
    ):
        assert not out.ok and out.sqlstate == state, (label, out)


# ═══ 3. request_series_plan: ownership, validation, idempotency, the cap ═══════════════════════════════════════════════════

def test_an_editor_may_request_a_viewer_may_not_and_a_stranger_learns_nothing(conn, world):
    s = world.su
    for who, ch in ((world.ed, world.chan_a), (world.adm, world.chan_a2), (world.alice, world.chan_a3)):
        out = request(s, who, ch)
        assert out.ok and out.rows[0][0]["replayed"] is False, (who.name, out)
    assert forbidden(request(s, world.viewer, world.chan_a)), "a viewer reads, never queues"
    become(s, None)
    assert s.value("select count(*) from public.series_plans where requested_by = %s", [world.viewer.uid]) == 0
    missing = request(s, world.bob, "no-such-channel")
    cross = request(s, world.bob, world.chan_a)
    stranger = request(s, world.stranger, world.chan_a)
    assert not_found(missing) and not_found(cross) and not_found(stranger)
    assert (missing.sqlstate, missing.error) == (cross.sqlstate, cross.error) == (stranger.sqlstate, stranger.error)
    # a caller with no identity at all
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    assert forbidden(s.run("select public.request_series_plan(%s, 't', 3, null, 120, null, %s)", [world.chan_a, key()]))


def test_the_plan_row_carries_the_organization_the_channel_belongs_to_not_one_the_caller_names(conn, world):
    s = world.su
    out = requested(s, world.ed, world.chan_a)
    become(s, None)
    org, ch, by, status, job = s.rows("select org_id, channel_id, requested_by, status, render_job_id from public.series_plans where id = %s",
                                      [out["id"]])[0]
    assert (str(org), ch, str(by), status) == (world.org_a, world.chan_a, world.ed.uid, "requested")
    assert out["replayed"] is False and job == out["render_job_id"]


def test_the_niche_comes_from_the_series_or_the_channel_and_no_niche_is_refused_before_anything_is_queued(conn, world):
    s = world.su
    sid = f"series-{world.sc.alice.key}"  # the scenario's series of channel chan-a
    become(s, None)
    s.rows("update public.channels set niche = 'ancient history' where channel_id = %s returning 1", [world.chan_a])
    p1 = requested(s, world.ed, world.chan_a)["id"]
    become(s, None)
    assert s.value("select niche from public.series_plans where id = %s", [p1]) == "ancient history"
    assert s.value("select series_id from public.series_plans where id = %s", [p1]) is None
    assert finish(s, p1).ok
    become(s, None)
    s.rows("update public.content_series set niche = 'roman engineering' where series_id = %s returning 1", [sid])
    p2 = requested(s, world.ed, world.chan_a, series=sid)["id"]
    become(s, None)
    assert s.rows("select niche, series_id from public.series_plans where id = %s", [p2]) == [("roman engineering", sid)]
    assert jobs_of_plan(s, p2)[0][2]["niche"] == "roman engineering"
    s.rows("update public.channels set niche = '   ' where channel_id = %s returning 1", [world.chan_a3])
    assert refused(request(s, world.ed, world.chan_a3), "22023", "no_niche")
    become(s, None)
    assert s.value("select count(*) from public.series_plans where channel_id = %s", [world.chan_a3]) == 0
    assert s.value("select count(*) from public.render_jobs where channel_id = %s and kind = 'series_plan'", [world.chan_a3]) == 0


def test_a_series_of_another_channel_or_organization_is_not_found_like_a_missing_one(conn, world):
    s = world.su
    own_other_channel = request(s, world.ed, world.chan_a2, series=f"series-{world.sc.alice.key}")  # alice's series lives on chan-a
    bobs = request(s, world.ed, world.chan_a, series=f"series-{world.sc.bob.key}")
    missing = request(s, world.ed, world.chan_a, series="no-such-series")
    assert not_found(own_other_channel) and not_found(bobs) and not_found(missing)
    assert own_other_channel.error == bobs.error == missing.error
    become(s, None)
    assert s.value("select count(*) from public.series_plans where created_at >= now()") == 0


def test_the_planning_job_is_one_model_call_with_no_hold_and_no_run_parameters(conn, world):
    s = world.su
    sid = f"series-{world.sc.alice.key}"
    out = requested(s, world.ed, world.chan_a, language="Uzbek", series=sid)
    (job,) = jobs_of_plan(s, out["id"])
    assert job[0] == out["render_job_id"] and job[1] == "series_plan" and job[3] is None and job[4] == "queued"
    assert job[2] == {"topic": "The fall of an empire", "niche": "tech", "language": "Uzbek", "series": sid}
    become(s, None)
    assert s.value("select count(*) from public.credit_reservations where created_at >= now()") == 0, "planning holds nothing"
    assert s.value("select api_hold_ref is null and scene_regeneration_id is null from public.render_jobs where id = %s", [job[0]])
    # without a series the key is absent, not null
    plain = requested(s, world.ed, world.chan_a2)
    assert "series" not in jobs_of_plan(s, plain["id"])[0][2]


def test_invalid_input_is_refused_by_name_and_queues_nothing(conn, world):
    s = world.su
    cases = [
        (dict(topic=""), "invalid_topic"), (dict(topic="   "), "invalid_topic"), (dict(topic="x" * 301), "invalid_topic"),
        (dict(topic="two\nlines"), "invalid_topic"), (dict(topic="tab\there"), "invalid_topic"),
        (dict(n=2), "invalid_episode_count"), (dict(n=5), "invalid_episode_count"), (dict(n=0), "invalid_episode_count"),
        (dict(n=None), "invalid_episode_count"),
        (dict(duration=29), "invalid_duration"), (dict(duration=3601), "invalid_duration"), (dict(duration=None), "invalid_duration"),
        (dict(language="English; drop table x"), "invalid_language"), (dict(language="<script>"), "invalid_language"),
        (dict(language="x" * 41), "invalid_language"), (dict(language="Русский"), "invalid_language"),
        (dict(idem="short"), "invalid_idempotency_key"), (dict(idem="has space in it"), "invalid_idempotency_key"),
        (dict(idem="a" * 129), "invalid_idempotency_key"), (dict(idem="semi;colon;key"), "invalid_idempotency_key"),
    ]
    for kw, word in cases:
        kw = dict(kw)
        idem = kw.pop("idem", None)
        become_claims(s, world.ed)
        out = s.run("select public.request_series_plan(%s, %s, %s, %s, %s, %s, %s)",
                    [world.chan_a, kw.get("topic", "A topic"), kw["n"] if "n" in kw else 3, kw.get("language"),
                     kw["duration"] if "duration" in kw else SECS, None, idem or key()])
        assert refused(out, "22023", word), (kw, idem, out)
    become(s, None)
    assert s.value("select count(*) from public.series_plans where created_at >= now()") == 0


def test_hostile_channel_and_series_strings_are_not_found_not_errors(conn, world):
    s = world.su
    hostile = ["'; drop table public.series_plans; --", "../../etc/passwd", "chan-a\n", " chan-a", "CHAN-A", "chan-a\u200b", "%", "_",
               "chan-a' or '1'='1", "x" * 10000, "", "chan-\u0430"]  # the last has a Cyrillic a
    for h in hostile:
        out = request(s, world.ed, h)
        assert not_found(out), (h[:30], out)
    for h in hostile[:-1]:
        if not h.strip():
            continue
        out = request(s, world.ed, world.chan_a, series=h)
        assert not out.ok and out.sqlstate in ("P0002", "22023"), (h[:30], out)
    become(s, None)
    assert s.value("select count(*) from public.series_plans where created_at >= now()") == 0
    assert s.value("select count(*) from public.series_plans") >= 2, "the tables are still there"


def test_a_replay_with_the_same_key_answers_the_first_press_and_queues_nothing_more(conn, world):
    s = world.su
    k = key()
    first = requested(s, world.ed, world.chan_a, idem=k)
    again = requested(s, world.ed, world.chan_a, idem=k)
    other_editor = requested(s, world.adm, world.chan_a, idem=k)
    assert again["replayed"] is True and other_editor["replayed"] is True
    assert again["id"] == other_editor["id"] == first["id"] and again["render_job_id"] == first["render_job_id"]
    become(s, None)
    assert s.value("select count(*) from public.series_plans where idempotency_key = %s", [k]) == 1
    assert len(jobs_of_plan(s, first["id"])) == 1


def test_the_same_key_for_a_different_request_is_a_conflict_and_changes_nothing(conn, world):
    s = world.su
    k = key()
    first = requested(s, world.ed, world.chan_a, idem=k)
    for kw in (dict(topic="Another topic"), dict(n=4), dict(language="Russian"), dict(duration=SECS + 1)):
        assert refused(request(s, world.ed, world.chan_a, idem=k, **kw), "NS409", "idempotency_conflict"), kw
    # the same key under another organization is that organization's own, unrelated key
    other = requested(s, world.bob, world.chan_b, idem=k)
    assert other["id"] != first["id"] and other["replayed"] is False


def test_one_plan_in_flight_per_channel_and_an_unfinished_one_expires_after_two_hours(conn, world):
    s = world.su
    first = requested(s, world.ed, world.chan_a)
    assert refused(request(s, world.ed, world.chan_a), "NS409", "plan_in_progress")
    assert refused(request(s, world.adm, world.chan_a, topic="Different"), "NS409", "plan_in_progress")
    assert requested(s, world.ed, world.chan_a2)["replayed"] is False, "another channel is not blocked"
    backdate(s, first["id"], "3 hours")
    nxt = requested(s, world.ed, world.chan_a)
    become(s, None)
    assert s.value("select status from public.series_plans where id = %s", [first["id"]]) == "failed"
    assert s.value("select error_code from public.series_plans where id = %s", [first["id"]]) == "expired"
    assert [j[4] for j in jobs_of_plan(s, first["id"])] == ["cancelled"], "its queue row is cancelled with it"
    assert nxt["replayed"] is False and nxt["id"] != first["id"]
    # a late answer from the worker cannot revive an expired plan
    assert refused(finish(s, first["id"]), "NS409", "plan_already_finished")


def test_an_expired_plan_whose_worker_already_took_the_job_keeps_the_job_running(conn, world):
    s = world.su
    first = requested(s, world.ed, world.chan_a)
    become(s, None)
    s.rows("update public.render_jobs set status = 'running', started_at = now() where id = %s returning 1", [first["render_job_id"]])
    backdate(s, first["id"], "3 hours")
    requested(s, world.ed, world.chan_a)
    become(s, None)
    assert [j[4] for j in jobs_of_plan(s, first["id"])] == ["running"], "only a job nobody has claimed is cancelled"


def test_the_daily_cap_counts_every_plan_of_the_organization_and_a_replay_is_free(conn, world):
    s = world.su
    limit = s.value("select public.series_plan_daily_limit()")
    assert limit == 5
    channels = [world.chan_a, world.chan_a2, world.chan_a3]
    made = []
    for i in range(limit):
        ch = channels[i % 3]
        p = requested(s, world.ed, ch, idem=f"cap-key-{i:04d}")["id"]
        made.append(p)
        done = finish(s, p, ok=(i % 2 == 0), code=None if i % 2 == 0 else "bad_shape", error=None if i % 2 == 0 else "x")
        assert done.ok, done  # a failed plan still counts: the model call was spent
        become(s, None)
    over = request(s, world.ed, world.chan_a, idem="cap-key-over")
    assert not over.ok and over.sqlstate == "NS429" and over.error == "rate_limited", over
    assert requested(s, world.ed, world.chan_a, idem="cap-key-0000")["replayed"] is True, "a replay is not a new press"
    # the other organization has its own count; plans older than a day do not count
    assert requested(s, world.bob, world.chan_b)["replayed"] is False
    backdate(s, made[0], "25 hours")
    assert requested(s, world.ed, world.chan_a, idem="cap-key-after")["replayed"] is False
    # the seeded two-day-old plan never counted
    assert s.value("select count(*) from public.series_plans where org_id = %s and created_at > now() - interval '24 hours'", [world.org_a]) == limit


def test_the_cap_applies_to_the_operators_own_organization_too(conn, world):
    s = world.su
    become(s, None)
    chans = [world.chan_op]
    for i in range(1, 5):
        c = f"op-extra-{i}"
        s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', public.default_org_id()) "
               "returning 1", [c, c])
        chans.append(c)
    s.rows("update public.channels set niche = 'tech' where channel_id = %s returning 1", [world.chan_op])
    for i, c in enumerate(chans):
        out = request(s, world.operator, c, idem=f"op-key-{i:04d}")
        assert out.ok, out
        become(s, None)
    s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values ('op-extra-5', 'op-extra-5', 'tech', 'PAUSED', public.default_org_id()) "
           "returning 1")
    over = request(s, world.operator, "op-extra-5", idem="op-key-over")
    assert over.sqlstate == "NS429" and over.error == "rate_limited", over


# ═══ 4. the queue: the kind, the link, the payment guard, the `series` key ═════════════════════════════════════════════════

def insert_job(s, who, kind, params, *, plan=None, credit_ref=None, channel=None, claims=False):
    (become_claims if claims else become)(s, who)
    return s.run("insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref, series_plan_id) "
                 "values (%s, %s, %s::jsonb, %s, %s, %s)",
                 [channel or "chan-a", kind, json.dumps(params), who.uid if who not in (ANON, SERVICE, None) else None, credit_ref, plan])


def test_a_browser_cannot_insert_a_planning_job_or_link_one_or_carry_a_series(conn, world):
    s = world.su
    out = requested(s, world.ed, world.chan_a)
    for who in (world.alice, world.adm, world.ed):
        become(s, None)
        # a planning job for a plan that is waiting, from the signed-in admin's own session
        p = {"topic": "The fall of an empire", "niche": "tech", "language": "English"}
        r1 = insert_job(s, who, "series_plan", p, plan=out["id"])
        assert not r1.ok and r1.sqlstate in ("42501", "23505"), r1
        r2 = insert_job(s, who, "series_plan", p)
        assert not r2.ok, r2
        r3 = insert_job(s, who, "daily", {"topic": "t", "duration": 120}, plan=out["id"])
        assert not r3.ok and r3.sqlstate in ("23514", "42501"), r3
        # the run parameter that names a series is not in the browser's insert policy either
        r4 = insert_job(s, who, "daily", {"topic": "t", "duration": 120, "series": "series-a"}, credit_ref="rj-nothing")
        assert not r4.ok and r4.sqlstate == "42501", r4
    become(s, None)
    assert s.value("select count(*) from public.render_jobs where kind = 'series_plan'") == 1, "only the one request_series_plan queued"


def test_the_payment_guard_accepts_only_the_exact_job_a_plan_queued(conn, world):
    s = world.su
    sid = f"series-{world.sc.alice.key}"
    plan = requested(s, world.ed, world.chan_a, series=sid)
    base = {"topic": "The fall of an empire", "niche": "tech", "language": "English", "series": sid}
    # the plan already has its job: a second job for it is refused by the guard (before the unique link would say so)
    again = insert_job(s, None, "series_plan", base, plan=plan["id"], channel=world.chan_a)
    assert not again.ok and again.sqlstate == "42501" and "not the job its series plan queued" in again.error, again
    # take the plan's job away (the owner, past the triggers) to try each way of getting another one in
    become(s, None)
    s.conn.execute("set local session_replication_role = replica")
    s.conn.execute("delete from public.render_jobs where series_plan_id = %s", [plan["id"]])
    s.conn.execute("update public.series_plans set render_job_id = null where id = %s", [plan["id"]])
    s.conn.execute("set local session_replication_role = origin")
    tweaks = [
        ("another topic", dict(base, topic="Hijacked"), world.chan_a, None),
        ("another niche", dict(base, niche="gossip"), world.chan_a, None),
        ("another language", dict(base, language="Russian"), world.chan_a, None),
        ("no series", {k: v for k, v in base.items() if k != "series"}, world.chan_a, None),
        ("another series", dict(base, series="series-b"), world.chan_a, None),
        ("an extra key", dict(base, duration=120), world.chan_a, None),
        ("another channel", base, world.chan_a2, None),
        ("a credit hold", base, world.chan_a, "rj-se-" + "0" * 32),
    ]
    for label, params, channel, ref in tweaks:
        out = insert_job(s, None, "series_plan", params, plan=plan["id"], channel=channel, credit_ref=ref)
        assert not out.ok and out.sqlstate in ("42501", "23514"), (label, out)
    # an unknown plan, a daily job pretending to belong to one
    out = insert_job(s, None, "series_plan", base, plan=str(uuid.uuid4()), channel=world.chan_a)
    assert not out.ok and out.sqlstate in ("23503", "42501"), out
    # the control: the exact job goes in
    ok = insert_job(s, None, "series_plan", base, plan=plan["id"], channel=world.chan_a)
    assert ok.ok, ok
    # and once the plan has ended, no job can be added for it
    become(s, None)
    s.conn.execute("set local session_replication_role = replica")
    s.conn.execute("delete from public.render_jobs where series_plan_id = %s", [plan["id"]])
    s.conn.execute("set local session_replication_role = origin")
    assert finish(s, plan["id"]).ok
    become(s, None)
    late = insert_job(s, None, "series_plan", base, plan=plan["id"], channel=world.chan_a)
    assert not late.ok and late.sqlstate == "42501", late


def test_a_browser_cannot_insert_the_exact_planning_job_either(conn, world):
    """The guard accepts the job a plan queued from any caller (an editor requests a plan, and an editor may not insert render jobs). What keeps
    a signed-in browser from inserting it is the insert policy, which admits only kind 'daily'."""
    s = world.su
    sid = f"series-{world.sc.alice.key}"
    plan = requested(s, world.adm, world.chan_a, series=sid)
    become(s, None)
    s.conn.execute("set local session_replication_role = replica")
    s.conn.execute("delete from public.render_jobs where series_plan_id = %s", [plan["id"]])
    s.conn.execute("update public.series_plans set render_job_id = null where id = %s", [plan["id"]])
    s.conn.execute("set local session_replication_role = origin")
    exact = {"topic": "The fall of an empire", "niche": "tech", "language": "English", "series": sid}
    for who in (world.alice, world.adm, world.ed, world.bob, ANON):
        out = insert_job(s, who, "series_plan", exact, plan=plan["id"], channel=world.chan_a)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
        assert "row-level security" in out.error or out.error.startswith("permission denied"), (who.name, out)
    become(s, None)
    assert jobs_of_plan(s, plan["id"]) == []
    # the control: with the policy out of the way (the database owner), the same row is accepted
    assert insert_job(s, None, "series_plan", exact, plan=plan["id"], channel=world.chan_a).ok


def test_the_validator_accepts_a_series_slug_and_refuses_everything_else(conn, world):
    s = world.su
    become(s, None)
    ok = lambda p, kind="daily": s.value("select public.render_job_params_valid(%s::jsonb, %s)", [json.dumps(p), kind])  # noqa: E731
    for slug in ("a", "series-a", "my.series_2", "0lead", "a" * 64):
        assert ok({"topic": "t", "series": slug}), slug
    for bad in ("", " ", "A", "Series", "-lead", ".lead", "_lead", "a" * 65, "a b", "a/b", "a\\b", "../x", "a\n", "\na", "a\r", "a​",
                "ａ", "series;rm", "--flag", "a$b", "a'b", 'a"b', "a`b", "%s", None, 5, True, ["a"], {"a": 1}):
        assert not ok({"topic": "t", "series": bad}), repr(bad)
    assert not ok({"topic": "t", "series": "a", "repair_scenes": "1"}, "repair"), "a repair names no series"
    assert ok({"repair_scenes": "1"}, "repair")
    # nothing else changed: the keys and rules from 0029 and before
    assert ok({"topic": "t", "duration": 30, "publish_hint": "youtube:abc", "resume": True})
    assert not ok({"topic": "t", "unknown": 1}) and not ok({"duration": 29}) and not ok({"privacy": "x"}) and not ok({"voice_id": "short"})
    assert not ok({"topic": "t", "repair_scenes": "1"}) and not ok({"topic": "t"}, "repair")


def test_the_series_plan_kind_takes_a_topic_and_a_niche_and_nothing_a_run_takes(conn, world):
    s = world.su
    become(s, None)
    ok = lambda p: s.value("select public.render_job_params_valid(%s::jsonb, 'series_plan')", [json.dumps(p)])  # noqa: E731
    assert ok({"topic": "t", "niche": "n"}) and ok({"topic": "t", "niche": "n", "language": "Uzbek", "series": "s-1"})
    for bad in ({}, {"topic": "t"}, {"niche": "n"}, {"topic": " ", "niche": "n"}, {"topic": "t", "niche": ""},
                {"topic": "t", "niche": "n", "duration": 120}, {"topic": "t", "niche": "n", "resume": True},
                {"topic": "t", "niche": "n", "voice_id": "A" * 20}, {"topic": "t", "niche": "n", "video_provider": "veo"},
                {"topic": "t", "niche": "n", "privacy": "public"}, {"topic": "t", "niche": "n", "publish_hint": "youtube:x"},
                {"topic": "t", "niche": "n", "repair_scenes": "1"}, {"topic": "t", "niche": "n", "series": "Bad Slug"},
                {"topic": 5, "niche": "n"}, {"topic": "t" * 301, "niche": "n"}):
        assert not ok(bad), bad
    # a kind that is not one of the three is not accepted by the table either (see the kind-check test)


def test_the_kind_check_allows_exactly_three_kinds_and_a_job_has_its_plan_iff_it_is_a_planning_job(conn, world):
    s = world.su
    become(s, None)
    kinds = set(re.findall(r"'([a-z_]+)'", s.value("select pg_get_constraintdef(oid) from pg_constraint "
                                                 "where conrelid = 'public.render_jobs'::regclass and conname = 'render_jobs_kind_check'")))
    assert kinds == {"daily", "repair", "series_plan"}
    ch = world.chan_op  # the operator's own channel: the payment guard lets it through, so the table's own checks answer
    assert s.run("insert into public.render_jobs (channel_id, kind, params) values (%s, 'surprise', '{}')", [ch]).sqlstate == "23514"
    out = s.run("insert into public.render_jobs (channel_id, kind, params) values (%s, 'series_plan', '{\"topic\":\"t\",\"niche\":\"n\"}')", [ch])
    assert not out.ok and out.sqlstate == "23514"  # a planning job without its plan
    out = s.run("insert into public.render_jobs (channel_id, kind, params, series_plan_id) values (%s, 'daily', '{}', gen_random_uuid())", [ch])
    assert not out.ok and out.sqlstate == "42501", "the guard answers first: a daily job is not a plan's job"


def test_a_customers_ordinary_run_is_still_held_to_its_credit_hold(conn, world):
    """The replaced payment guard still refuses what it refused before: no hold, no run."""
    s = world.su
    out = insert_job(s, world.alice, "daily", {"topic": "t", "duration": 120}, channel="chan-a")
    assert not out.ok and out.sqlstate == "42501", out
    become(s, None)
    out = insert_job(s, None, "daily", {"topic": "t", "duration": 120}, channel="chan-a")
    assert not out.ok and out.sqlstate == "42501" and "credit hold" in out.error, out
    out = insert_job(s, None, "daily", {"topic": "t", "duration": 120, "video_provider": "veo"}, channel="chan-a")
    assert not out.ok and out.sqlstate == "42501", out


# ═══ 5. finish_series_plan: the worker's answer ════════════════════════════════════════════════════════════════════════════

def test_finish_is_the_service_roles_alone_and_a_person_carrying_claims_is_refused_too(conn, world):
    s = world.su
    plan = requested(s, world.ed, world.chan_a)["id"]
    for who in (world.alice, world.adm, world.ed, world.bob, ANON):
        out = finish(s, plan, who=who)
        assert denied(out), (who.name, out)
    # a signed-in person's claims reaching the function without an API role (the owner's connection) are not the platform's either
    become_claims(s, world.alice)
    out = s.run("select public.finish_series_plan(%s, true, 't', '{}', null, '[]', null, null)", [plan])
    assert forbidden(out), out
    become(s, None)
    assert s.value("select status from public.series_plans where id = %s", [plan]) == "requested"
    assert s.value("select count(*) from public.series_episodes where plan_id = %s", [plan]) == 0


def test_finish_stores_the_outline_and_creates_the_episodes_in_order_with_the_plans_length(conn, world):
    s = world.su
    plan = requested(s, world.ed, world.chan_a, n=4, duration=300)["id"]
    eps = episodes_json(4, usable={3: False}, confirm={2: True})
    out = finish(s, plan, n=4, episodes=eps, title="  Four parts  ", report={"fact_checked": False, "notice": "Outline only"},
                 quote={"total_credits": None})
    assert out.ok and out.rows[0][0]["status"] == "ready" and out.rows[0][0]["replayed"] is False
    become(s, None)
    assert s.rows("select status, title, report ->> 'fact_checked', quote is not null, finished_at is not null from public.series_plans where id = %s",
                  [plan]) == [("ready", "Four parts", "false", True, True)]
    rows = s.rows("select n, topic, usable, needs_confirmation, duration_s, status from public.series_episodes where plan_id = %s order by n", [plan])
    assert [(r[0], r[2], r[3], r[4], r[5]) for r in rows] == [(1, True, False, 300, "planned"), (2, True, True, 300, "planned"),
                                                              (3, False, False, 300, "planned"), (4, True, False, 300, "planned")]
    assert [r[1] for r in rows] == [e["topic"] for e in eps]


def test_finish_is_idempotent_and_an_ended_plan_cannot_be_rewritten(conn, world):
    s = world.su
    plan = requested(s, world.ed, world.chan_a)["id"]
    eps = episodes_json(3)
    first = finish(s, plan, episodes=eps)
    again = finish(s, plan, episodes=eps)
    assert first.ok and again.ok and again.rows[0][0]["replayed"] is True
    other = finish(s, plan, episodes=episodes_json(3))
    assert refused(other, "NS409", "plan_already_finished")
    failing = finish(s, plan, ok=False, code="gemini_quota", error="spent")
    assert refused(failing, "NS409", "plan_already_finished")
    become(s, None)
    assert s.value("select count(*) from public.series_episodes where plan_id = %s", [plan]) == 3


def test_a_failed_plan_keeps_only_its_error_and_frees_the_channel(conn, world):
    s = world.su
    plan = requested(s, world.ed, world.chan_a)["id"]
    out = finish(s, plan, ok=False, code="empty_response", error="The model returned no text.")
    assert out.ok and out.rows[0][0]["status"] == "failed"
    become(s, None)
    assert s.rows("select status, error_code, title is null, report is null from public.series_plans where id = %s", [plan]) == \
        [("failed", "empty_response", True, True)]
    assert s.value("select count(*) from public.series_episodes where plan_id = %s", [plan]) == 0
    assert finish(s, plan, ok=False, code="empty_response", error="again").rows[0][0]["replayed"] is True
    assert requested(s, world.ed, world.chan_a)["replayed"] is False, "the channel is free again"


def test_finish_refuses_a_malformed_answer_and_stores_nothing(conn, world):
    s = world.su
    plan = requested(s, world.ed, world.chan_a)["id"]
    good = episodes_json(3)
    bad_answers = [
        dict(episodes=good[:2]), dict(episodes=good + episodes_json(1)), dict(episodes="not-a-list"), dict(episodes=None),
        dict(episodes=[dict(e, extra=1) for e in good]), dict(episodes=[{k: v for k, v in e.items() if k != "usable"} for e in good]),
        dict(episodes=[dict(e, usable="yes") for e in good]), dict(episodes=[dict(e, topic=5) for e in good]),
        dict(episodes=[dict(e, topic="") for e in good]), dict(episodes=[dict(e, topic="x" * 301) for e in good]),
        dict(episodes=[dict(e, topic="a\nb") for e in good]), dict(episodes=[dict(e, outline=[1]) for e in good]),
        dict(episodes=[dict(e, outline={"k": "x" * 9000}) for e in good]),
        dict(episodes=[dict(e, usable=False, needs_confirmation=True) for e in good]),
        dict(episodes=[5, 6, 7]), dict(title=""), dict(title="x" * 201), dict(title="a\nb"), dict(report=[1]), dict(report={"k": "x" * 17000}),
        dict(quote=[1]), dict(quote={"k": "x" * 17000}),
    ]
    for kw in bad_answers:
        become(s, SERVICE)
        args = dict(title="Title", report={"fact_checked": False}, quote=None, episodes=good)
        args.update(kw)
        out = s.run("select public.finish_series_plan(%s, true, %s, %s::jsonb, %s::jsonb, %s::jsonb, null, null)",
                    [plan, args["title"], json.dumps(args["report"]), json.dumps(args["quote"]), json.dumps(args["episodes"])])
        assert not out.ok and out.sqlstate == "22023", (list(kw), out)
    become(s, SERVICE)
    for code, err in (("Bad Code", None), ("", None), (None, "x"), ("x" * 49, None), ("ok_code", "x" * 501), ("ok_code", "a\nb")):
        out = s.run("select public.finish_series_plan(%s, false, null, null, null, null, %s, %s)", [plan, code, err])
        assert not out.ok and out.sqlstate == "22023", (code, err, out)
    assert not_found(s.run("select public.finish_series_plan(%s, true, 't', '{}', null, '[]', null, null)", [str(uuid.uuid4())]))
    become(s, None)
    assert s.value("select status from public.series_plans where id = %s", [plan]) == "requested"
    assert s.value("select count(*) from public.series_episodes where plan_id = %s", [plan]) == 0


# ═══ 6. quote_series_episode ═══════════════════════════════════════════════════════════════════════════════════════════════

def test_the_quote_is_the_databases_price_and_says_why_an_episode_cannot_start(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a, usable={3: False}, confirm={2: True})
    q = quote(s, world.viewer, eps[0])
    assert q.ok
    q = q.rows[0][0]
    assert (q["price_status"], float(q["credits"]), q["exempt"], q["blocked_by"], q["startable"], q["may_start"]) == ("priced", PRICE, False, None, True, False)
    assert q["duration_s"] == SECS and q["status"] == "planned" and q["n"] == 1
    assert quote(s, world.adm, eps[0]).rows[0][0]["may_start"] is True
    assert quote(s, world.viewer, eps[1]).rows[0][0]["blocked_by"] == "earlier_episode_not_finished"
    assert quote(s, world.viewer, eps[2]).rows[0][0]["blocked_by"] == "episode_not_usable"
    assert quote(s, world.viewer, eps[1]).rows[0][0]["needs_confirmation"] is True


def test_the_price_follows_the_formula_the_payment_guard_enforces(conn, world):
    s = world.su
    become(s, None)
    price = lambda secs: s.value("select public.series_episode_price(%s)", [secs])  # noqa: E731
    assert float(price(120)) == 15.00 and float(price(300)) == 37.50
    assert float(price(30)) == 5.00, "the job_minimum floor wins over 3.75"
    assert float(price(3600)) == 450.00
    # rounded UP to the cent, never to the nearest: 0.07 x 61 / 60 = 0.07116..., which is 0.08, not 0.07
    set_prices(s, {"video_minute": (0.07, "0"), "job_minimum": (0, "0")})
    assert float(price(61)) == 0.08 and float(price(30)) == 0.04
    set_prices(s)
    assert price(29) is None and price(3601) is None and price(None) is None and price(-5) is None, "an unbounded length is unpriced"


def test_an_unpriced_episode_is_refused_not_held_at_zero(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    for label, setup in (("no video_minute row", "delete from public.credit_prices where unit = 'video_minute'"),
                         ("a zero rate", "update public.credit_prices set credits_per_unit = 0 where unit = 'video_minute'")):
        become(s, None)
        s.conn.execute(setup)
        q = quote(s, world.adm, eps[0]).rows[0][0]
        assert (q["price_status"], q["credits"], q["startable"]) == ("unpriced", None, False), label
        for confirmed in (PRICE, 0, 0.0, None):
            out = start(s, world.adm, eps[0], confirmed)
            assert not out.ok and out.sqlstate == "NS400" and out.error == "unpriced", (label, confirmed, out)
        assert episode_row(s, eps[0])[0] == "planned"
        assert holds(s, world.org_a) == [] and run_jobs(s, world.chan_a) == [], label
        set_prices(s)


def test_the_operators_own_organization_pays_nothing_and_needs_no_price(conn, world):
    s = world.su
    become(s, None)
    s.rows("update public.channels set niche = 'tech' where channel_id = %s returning 1", [world.chan_op])
    plan, eps = ready_plan(s, world.operator, world.chan_op)
    become(s, None)
    s.conn.execute("delete from public.credit_prices where unit = 'video_minute'")
    q = quote(s, world.platform, eps[0]).rows[0][0]
    assert (q["price_status"], q["credits"], q["exempt"], q["startable"], q["may_start"]) == ("included", None, True, True, True)
    # only a platform administrator spends there: an explicit admin of the operator's organization who is not one is refused
    become(s, None)
    boss = user("series-op-admin", "series-op-admin@op.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [boss.uid, boss.email])
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin') returning 1", [world.org_op, boss.uid, boss.email])
    assert forbidden(start(s, boss, eps[0], None))
    assert not_found(start(s, world.bob, eps[0], None))
    assert episode_row(s, eps[0])[0] == "planned"
    out = started(s, world.platform, eps[0], None)
    assert out["credit_ref"] is None and out["credits_held"] is None and out["replayed"] is False
    become(s, None)
    assert holds(s, world.org_op) == []
    (job,) = run_jobs_any(s, out["render_job_id"])
    assert job[2] is None and job[1]["topic"] and job[1]["duration"] == SECS


def run_jobs_any(su, job_id):
    become(su, None)
    return su.rows("select id, params, credit_ref from public.render_jobs where id = %s", [job_id])


# ═══ 7. start_series_episode: ownership ═══════════════════════════════════════════════════════════════════════════════════

def test_only_an_admin_of_the_organization_starts_an_episode(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    for who in (world.viewer, world.ed):
        out = start(s, who, eps[0])
        assert forbidden(out), (who.name, out)
    for who in (world.bob, world.stranger):
        out = start(s, who, eps[0])
        assert not_found(out), (who.name, out)
    missing = start(s, world.bob, str(uuid.uuid4()))
    cross = start(s, world.bob, eps[0])
    assert (missing.sqlstate, missing.error) == (cross.sqlstate, cross.error) == ("P0002", "not_found")
    assert start(s, ANON, eps[0]).error.startswith("permission denied")
    become(s, None)
    assert episode_row(s, eps[0])[0] == "planned" and holds(s, world.org_a) == []
    out = started(s, world.adm, eps[0])
    assert out["status"] == "started"


def test_the_quote_of_another_organizations_episode_is_not_found_like_a_missing_one(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    missing = quote(s, world.bob, str(uuid.uuid4()))
    cross = quote(s, world.bob, eps[0])
    stranger = quote(s, world.stranger, eps[0])
    assert not_found(missing) and not_found(cross) and not_found(stranger)
    assert missing.error == cross.error == stranger.error
    assert quote(s, ANON, eps[0]).error.startswith("permission denied")


def test_a_platform_administrator_reaches_every_organization_as_the_role_system_already_says(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    assert quote(s, world.platform, eps[0]).ok
    out = started(s, world.platform, eps[0])
    assert out["credits_held"] is not None


def test_a_hostile_episode_id_or_key_never_reaches_a_row(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, world.adm)
    for bad in ("'; drop table public.series_episodes; --", "not-a-uuid", "", " ", eps[0] + "x", "00000000-0000-0000-0000-00000000000g"):
        out = s.run("select public.start_series_episode(%s, 15, %s)", [bad, f"se:{bad}"])
        assert not out.ok and out.sqlstate == "22P02", (bad, out)
        out = s.run("select public.quote_series_episode(%s)", [bad])
        assert not out.ok and out.sqlstate == "22P02", (bad, out)
    for idem in (None, "", "se:", f"se:{eps[0].upper()}", f"se:{eps[0]} ", f" se:{eps[0]}", f"se:{eps[0]}\n", "k" * 5000, f"s:{eps[0]}",
                 f"se:{plan}", f"se:{uuid.uuid4()}", "'; select 1; --"):
        out = start(s, world.adm, eps[0], idem=idem) if idem is not None else \
            s.run("select public.start_series_episode(%s, 15, null)", [eps[0]])
        assert refused(out, "22023", "invalid_idempotency_key"), (idem, out)
    for mc in (-1, 100000001, float("inf")):
        out = start(s, world.adm, eps[0], mc)
        assert not out.ok and out.sqlstate in ("22023", "22P02", "22003"), (mc, out)
    become(s, None)
    assert episode_row(s, eps[0])[0] == "planned" and holds(s, world.org_a) == []


# ═══ 8. start_series_episode: the money ═══════════════════════════════════════════════════════════════════════════════════

def test_a_start_holds_the_databases_price_and_queues_one_ordinary_run_with_that_hold(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, None)
    before = s.rows("select balance, reserved from public.credit_accounts where org_id = %s", [world.org_a])[0]
    out = started(s, world.adm, eps[0])
    ref = "rj-se-" + eps[0].replace("-", "")
    assert out["replayed"] is False and out["status"] == "started" and out["credit_ref"] == ref and float(out["credits_held"]) == PRICE
    become(s, None)
    assert hold(s, ref) == (PRICE, "open")
    after = s.rows("select balance, reserved from public.credit_accounts where org_id = %s", [world.org_a])[0]
    assert (after[0], after[1] - before[1]) == (before[0], PRICE), "the hold reserves, it does not spend"
    (job,) = run_jobs_any(s, out["render_job_id"])
    kind, status, uid = s.rows("select kind, status, requested_by from public.render_jobs where id = %s", [job[0]])[0]
    assert (kind, status, str(uid)) == ("daily", "queued", world.adm.uid)
    assert job[2] == ref
    p = job[1]
    assert set(p) == {"topic", "niche", "language", "duration"}, "no series on a plan without one, no provider, no voice"
    assert p["duration"] == SECS and p["language"] == "English" and p["niche"] == "tech"
    assert p["topic"] == s.value("select topic from public.series_episodes where id = %s", [eps[0]])
    row = episode_row(s, eps[0])
    assert (row[0], row[1], float(row[2]), row[3], row[4]) == ("started", ref, PRICE, job[0], f"se:{eps[0]}")
    assert s.value("select started_by from public.series_episodes where id = %s", [eps[0]]) is not None


def test_the_run_carries_the_series_when_the_plan_has_one_and_the_series_must_be_active(conn, world):
    s = world.su
    sid = f"series-{world.sc.alice.key}"
    plan, eps = ready_plan(s, world.ed, world.chan_a, series=sid)
    become(s, None)
    assert s.value("select upper(status) from public.content_series where series_id = %s", [sid]) in ("PAUSED", "ACTIVE", "ARCHIVED")
    s.rows("update public.content_series set status = 'PAUSED' where series_id = %s returning 1", [sid])
    out = start(s, world.adm, eps[0])
    assert refused(out, "NS409", "series_not_runnable")
    become(s, None)
    assert holds(s, world.org_a) == [] and episode_row(s, eps[0])[0] == "planned", "nothing was held for a series that cannot run"
    s.rows("update public.content_series set status = 'ARCHIVED' where series_id = %s returning 1", [sid])
    assert refused(start(s, world.adm, eps[0]), "NS409", "series_not_runnable")
    become(s, None)
    s.rows("update public.content_series set status = 'ACTIVE' where series_id = %s returning 1", [sid])
    out = started(s, world.adm, eps[0])
    (job,) = run_jobs_any(s, out["render_job_id"])
    assert job[1]["series"] == sid


def test_the_series_of_a_plan_must_still_belong_to_the_plans_channel(conn, world):
    s = world.su
    sid = f"series-{world.sc.alice.key}"
    s.rows("update public.content_series set status = 'ACTIVE' where series_id = %s returning 1", [sid])
    plan, eps = ready_plan(s, world.ed, world.chan_a, series=sid)
    become(s, None)
    s.rows("update public.content_series set channel_id = %s where series_id = %s returning 1", [world.chan_a2, sid])
    assert refused(start(s, world.adm, eps[0]), "NS409", "series_not_runnable")
    become(s, None)
    assert holds(s, world.org_a) == []


def test_the_browser_cannot_pick_the_price_in_either_direction(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    for mc in (0, 0.01, PRICE - 0.01, PRICE + 0.01, PRICE * 2, 100000000):
        out = start(s, world.adm, eps[0], mc)
        assert not out.ok and out.sqlstate == "NS409" and out.error == "price_changed", (mc, out)
    out = s.run("select public.start_series_episode(%s, null, %s)", [eps[0], f"se:{eps[0]}"])
    assert refused(out, "22023", "price_required")
    become(s, None)
    assert holds(s, world.org_a) == [] and run_jobs(s, world.chan_a) == []
    assert float(started(s, world.adm, eps[0], 15.00)["credits_held"]) == PRICE
    # the price is read again at every start: a rate change after the quote is a price_changed, with nothing held
    plan2, eps2 = ready_plan(s, world.ed, world.chan_a2)
    become(s, None)
    s.rows("update public.credit_prices set credits_per_unit = 8 where unit = 'video_minute' returning 1")
    assert refused(start(s, world.adm, eps2[0], PRICE), "NS409", "price_changed")
    out = started(s, world.adm, eps2[0], 20)
    assert float(out["credits_held"]) == 20.00


def test_price_changed_tells_the_current_price_in_its_detail(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, world.adm)
    try:
        s.conn.execute("savepoint sp")
        s.conn.execute("select public.start_series_episode(%s, 1, %s)", [eps[0], f"se:{eps[0]}"])
    except psycopg.Error as e:
        assert e.sqlstate == "NS409" and e.diag.message_detail == f"credits={PRICE}.00", e.diag.message_detail
    else:
        pytest.fail("a wrong confirmed price must be refused")
    finally:
        s.conn.execute("rollback to savepoint sp")


def test_a_short_balance_changes_nothing(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, None)
    s.rows("update public.credit_prices set credits_per_unit = 100000 where unit = 'video_minute' returning 1")
    price = s.value("select public.series_episode_price(%s)", [SECS])
    assert price == 250000
    out = start(s, world.adm, eps[0], price)
    assert not out.ok and out.sqlstate == "NS402" and out.error == "insufficient credits", out
    become(s, None)
    assert episode_row(s, eps[0])[0] == "planned" and holds(s, world.org_a) == [] and run_jobs(s, world.chan_a) == []
    assert s.value("select count(*) from public.credit_reservations where org_id = %s and job_id like 'rj-se-%%'", [world.org_a]) == 0
    # after a top-up the same press works, with the same key
    s.rows("update public.credit_prices set credits_per_unit = 6 where unit = 'video_minute' returning 1")
    assert started(s, world.adm, eps[0])["status"] == "started"


def test_a_double_press_holds_once_whoever_presses(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    first = started(s, world.adm, eps[0])
    again = started(s, world.adm, eps[0])
    other = started(s, world.adm2, eps[0])
    owner = started(s, world.alice, eps[0])
    assert first["replayed"] is False and again["replayed"] is True and other["replayed"] is True and owner["replayed"] is True
    assert {again["render_job_id"], other["render_job_id"], owner["render_job_id"]} == {first["render_job_id"]}
    assert again["credit_ref"] == other["credit_ref"] == first["credit_ref"]
    become(s, None)
    assert holds(s, world.org_a) == [("rj-se-" + eps[0].replace("-", ""), PRICE, "open")]
    assert len(run_jobs(s, world.chan_a)) == 1


def test_the_same_key_with_another_confirmed_price_or_flag_is_a_conflict(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    started(s, world.adm, eps[0])
    assert refused(start(s, world.adm, eps[0], PRICE + 1), "NS409", "idempotency_conflict")
    assert refused(start(s, world.adm, eps[0], PRICE, confirmed=True), "NS409", "idempotency_conflict")
    become(s, None)
    assert len(holds(s, world.org_a)) == 1


def test_a_hold_that_already_exists_for_the_episode_blocks_a_second_one(conn, world):
    """reserve_credits refuses a reused reference, even a released one: no path holds twice for one episode."""
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, None)
    ref = "rj-se-" + eps[0].replace("-", "")
    s.value("select public.reserve_credits(%s, %s, 15)", [world.org_a, ref])
    out = start(s, world.adm, eps[0])
    assert not out.ok and out.sqlstate == "23505", out
    become(s, None)
    assert episode_row(s, eps[0])[0] == "planned" and run_jobs(s, world.chan_a) == []


def test_episodes_start_one_at_a_time_in_order(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    for later in (eps[1], eps[2]):
        assert refused(start(s, world.adm, later), "NS409", "earlier_episode_not_finished")
    a = started(s, world.adm, eps[0])
    # episode 1 is queued, not finished: 2 still waits
    assert refused(start(s, world.adm, eps[1]), "NS409", "earlier_episode_not_finished")
    finish_job(s, a["render_job_id"], "running")
    assert refused(start(s, world.adm, eps[1]), "NS409", "earlier_episode_not_finished")
    finish_job(s, a["render_job_id"], "succeeded")
    assert refused(start(s, world.adm, eps[2]), "NS409", "earlier_episode_not_finished"), "3 does not jump over 2"
    b = started(s, world.adm, eps[1])
    assert b["replayed"] is False
    finish_job(s, b["render_job_id"], "succeeded")
    c = started(s, world.adm, eps[2])
    assert c["status"] == "started"
    become(s, None)
    assert len(holds(s, world.org_a)) == 3 and len(run_jobs(s, world.chan_a)) == 3
    # each episode has its own hold, taken when it started: the first one is a different reference from the others
    assert len({h[0] for h in holds(s, world.org_a)}) == 3


@pytest.mark.parametrize("end", ["failed", "cancelled"])
def test_a_failed_or_cancelled_earlier_episode_blocks_the_rest_and_is_never_restarted_here(conn, world, end):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    a = started(s, world.adm, eps[0])
    finish_job(s, a["render_job_id"], end)
    assert refused(start(s, world.adm, eps[1]), "NS409", "earlier_episode_not_finished")
    # the same press on the failed episode answers as a replay: it is not started a second time, and nothing new is held
    again = started(s, world.adm, eps[0])
    assert again["replayed"] is True and again["render_job_id"] == a["render_job_id"]
    become(s, None)
    assert len(holds(s, world.org_a)) == 1
    q = quote(s, world.adm, eps[0]).rows[0][0]
    assert q["blocked_by"] == "already_started" and q["startable"] is False


def test_an_unusable_episode_never_starts_and_an_unconfirmed_one_starts_only_when_the_caller_confirms(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a, usable={1: False}, confirm={2: True})
    assert refused(start(s, world.adm, eps[0], confirmed=True), "NS409", "episode_not_usable")
    plan2, eps2 = ready_plan(s, world.ed, world.chan_a2, confirm={1: True})
    for flag in (None, False):
        out = start(s, world.adm, eps2[0], confirmed=flag)
        assert refused(out, "NS400", "confirmation_required"), (flag, out)
    become(s, None)
    assert holds(s, world.org_a) == []
    assert started(s, world.adm, eps2[0], confirmed=True)["status"] == "started"
    # confirming an episode that does not need it changes nothing
    plan3, eps3 = ready_plan(s, world.ed, world.chan_a3)
    assert started(s, world.adm, eps3[0], confirmed=True)["status"] == "started"


def test_an_episode_of_a_plan_that_is_not_ready_cannot_be_started(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, None)
    # the only way a ready plan stops being ready is a row written past the triggers by the owner: the function still refuses
    s.conn.execute("set local session_replication_role = replica")
    s.conn.execute("update public.series_plans set status = 'failed', error_code = 'x', title = null, report = null, quote = null, "
                   "result_hash = null where id = %s", [plan])
    s.conn.execute("set local session_replication_role = origin")
    assert refused(start(s, world.adm, eps[0]), "NS409", "plan_not_ready")
    assert quote(s, world.adm, eps[0]).rows[0][0]["blocked_by"] == "plan_not_ready"
    become(s, None)
    assert holds(s, world.org_a) == []


def test_a_hold_that_expired_is_not_revived_and_the_episode_is_not_started_again(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    a = started(s, world.adm, eps[0])
    ref = a["credit_ref"]
    become(s, None)
    reserved_with = s.value("select reserved from public.credit_accounts where org_id = %s", [world.org_a])
    s.rows("update public.credit_reservations set created_at = now() - interval '4 hours' where job_id = %s returning 1", [ref])
    become(s, SERVICE)
    assert s.value("select public.expire_credit_reservations(%s)", [world.org_a]) >= 1
    become(s, None)
    assert hold(s, ref)[1] == "released"
    assert s.value("select reserved from public.credit_accounts where org_id = %s", [world.org_a]) == reserved_with - PRICE
    # the worker cannot start a released hold: the queued run is refused before anything is spent
    become(s, SERVICE)
    assert s.value("select public.start_credit_reservation(%s, %s)", [ref, world.org_a]) is None
    # the press again is a replay of the first start: no second hold (the reference is burnt), no second run, the episode stays started
    again = started(s, world.adm, eps[0])
    assert again["replayed"] is True and again["credit_ref"] == ref
    become(s, None)
    assert [h[2] for h in holds(s, world.org_a)] == ["released"] and len(run_jobs(s, world.chan_a)) == 1
    # and the next episode stays blocked until a person decides what to do about the first
    assert refused(start(s, world.adm, eps[1]), "NS409", "earlier_episode_not_finished")


def test_a_failed_run_releases_its_hold_through_the_ordinary_sweep(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    a = started(s, world.adm, eps[0])
    finish_job(s, a["render_job_id"], "failed", settle=False)
    become(s, SERVICE)
    assert s.value("select public.expire_credit_reservations(%s)", [world.org_a]) >= 1
    become(s, None)
    assert hold(s, a["credit_ref"])[1] == "released"


def test_the_replaced_payment_guard_checks_the_episodes_hold_like_any_queued_run(conn, world):
    s = world.su
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    become(s, None)
    # a run for this episode's length with a hold that is too small is refused by the guard (the formula is the same one)
    ref = f"rj-se-small-{uuid.uuid4().hex[:8]}"
    s.value("select public.reserve_credits(%s, %s, 5)", [world.org_a, ref])
    out = insert_job(s, None, "daily", {"topic": "t", "duration": SECS}, credit_ref=ref, channel="chan-a")
    assert not out.ok and out.sqlstate == "22023", out
    ok_ref = f"rj-se-big-{uuid.uuid4().hex[:8]}"
    s.value("select public.reserve_credits(%s, %s, %s)", [world.org_a, ok_ref, PRICE])
    out = insert_job(s, None, "daily", {"topic": "t", "duration": SECS, "series": "series-a"}, credit_ref=ok_ref, channel="chan-a")
    assert out.ok, out


# ═══ 9. concurrency ═══════════════════════════════════════════════════════════════════════════════════════════════════════
#
# Real concurrent transactions need COMMITTED rows. They live in an organization of their own, built here and purged afterwards, so
# the shared scenario's balances, holds and ledgers (asserted exactly by other files) are never touched.

def _dsn(conn):
    return psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)


class RaceOrg:
    def __init__(self, conn, *, role, channels, credits):
        self.conn, self.channels = conn, list(channels)
        self.org = str(uuid.uuid4())
        self.who = user(f"series-race-{role}", f"series-race-{role}-{uuid.uuid4().hex[:6]}@race.test")
        with as_superuser(conn) as su:
            su.rows("insert into public.organizations (id, name, slug) values (%s, 'Series race', %s) returning 1", [self.org, f"series-race-{self.org[:8]}"])
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [self.who.uid, self.who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [self.org, self.who.uid, self.who.email, role])
            for ch in self.channels:
                su.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', %s) returning 1",
                        [ch, ch, self.org])
            set_prices(su)
        if credits:
            with acting(conn, SERVICE, commit=True) as s:
                s.value("select public.grant_credits(%s, 500, 'series race')", [self.org])

    def purge(self):
        """Everything the race committed, gone. Written past the append-only triggers on purpose (the owner, in replica mode)."""
        with as_superuser(self.conn) as su:
            su.conn.execute("set local session_replication_role = replica")
            tables = [r[0] for r in su.rows(
                "select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name) "
                "where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'")]
            su.conn.execute("delete from public.credit_hold_lots where job_id in (select job_id from public.credit_reservations where org_id = %s)", [self.org])
            su.conn.execute("delete from public.render_jobs where channel_id = any(%s)", [self.channels])
            for t_ in tables:
                su.conn.execute(sql.SQL("delete from public.{} where org_id = %s").format(sql.Identifier(t_)), [self.org])
            su.conn.execute("delete from public.organizations where id = %s", [self.org])
            su.conn.execute("delete from auth.users where id = %s", [self.who.uid])

    def count(self, q, params=()):
        with as_superuser(self.conn, commit=False) as su:
            return su.value(q, list(params))


def _plan_for(race, channel, topic="Race topic"):
    with as_superuser(race.conn) as su:
        become_claims(su, race.who)
        plan = su.value("select (public.request_series_plan(%s, %s, 3, null, 120, null, %s) ->> 'id')::uuid", [channel, topic, f"race-seed-{uuid.uuid4().hex[:8]}"])
        become(su, SERVICE)
        su.value("select public.finish_series_plan(%s, true, 'Race', '{}', null, %s::jsonb, null, null)", [plan, json.dumps(episodes_json(3))])
        become(su, None)
        return str(plan), [str(r[0]) for r in su.rows("select id from public.series_episodes where plan_id = %s order by n", [plan])]


def test_two_presses_at_the_same_moment_hold_once(conn, sc):
    """The account lock makes the second press wait, then find the first one's rows: one hold, one run, one start."""
    race = RaceOrg(conn, role="admin", channels=["chan-race"], credits=True)
    barrier = threading.Barrier(2)
    results = []
    try:
        plan, eps = _plan_for(race, "chan-race")
        ep = eps[0]

        def go():
            with psycopg.connect(_dsn(conn), autocommit=True) as c:
                with acting(c, race.who, commit=True) as s:
                    barrier.wait()
                    results.append(s.run("select public.start_series_episode(%s, 15::numeric, %s)", [ep, f"se:{ep}"]))

        threads = [threading.Thread(target=go) for _ in range(2)]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(30)
        assert len(results) == 2 and all(r.ok for r in results), results
        assert sorted(r.rows[0][0]["replayed"] for r in results) == [False, True], results
        assert race.count("select count(*) from public.credit_reservations where org_id = %s and job_id = %s", [race.org, "rj-se-" + ep.replace("-", "")]) == 1
        assert race.count("select count(*) from public.credit_reservations where org_id = %s and job_id like 'rj-se-%%'", [race.org]) == 1
        assert race.count("select reserved from public.credit_accounts where org_id = %s", [race.org]) == PRICE
        assert race.count("select count(*) from public.render_jobs where channel_id = 'chan-race' and kind = 'daily'") == 1
    finally:
        race.purge()


def test_two_different_episodes_of_one_plan_cannot_both_start(conn, sc):
    """Episode 1 and episode 2 pressed at the same moment: 2 is blocked by the order rule whichever transaction runs first."""
    race = RaceOrg(conn, role="admin", channels=["chan-race3"], credits=True)
    barrier = threading.Barrier(2)
    results = {}
    try:
        plan, eps = _plan_for(race, "chan-race3")

        def go(i):
            with psycopg.connect(_dsn(conn), autocommit=True) as c:
                with acting(c, race.who, commit=True) as s:
                    barrier.wait()
                    results[i] = s.run("select public.start_series_episode(%s, 15::numeric, %s)", [eps[i], f"se:{eps[i]}"])

        threads = [threading.Thread(target=go, args=(i,)) for i in (0, 1)]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(30)
        assert results[0].ok and refused(results[1], "NS409", "earlier_episode_not_finished"), results
        assert race.count("select count(*) from public.credit_reservations where org_id = %s and job_id like 'rj-se-%%'", [race.org]) == 1
    finally:
        race.purge()


def test_two_requests_at_the_same_moment_on_one_channel_queue_one_plan(conn, sc):
    race = RaceOrg(conn, role="editor", channels=["chan-race2"], credits=False)
    barrier = threading.Barrier(3)
    results = []

    def go(i):
        with psycopg.connect(_dsn(conn), autocommit=True) as c:
            with c.transaction():
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(race.who.claims())])
                barrier.wait()
                try:
                    c.execute("select public.request_series_plan('chan-race2', 'T', 3, null, 120, null, %s)", [f"race-req-{i:04d}"])
                    results.append("ok")
                except psycopg.Error as e:
                    results.append(e.diag.message_primary)

    try:
        threads = [threading.Thread(target=go, args=(i,)) for i in range(3)]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(30)
        assert sorted(results) == ["ok", "plan_in_progress", "plan_in_progress"], results
        assert race.count("select count(*) from public.render_jobs where channel_id = 'chan-race2' and kind = 'series_plan'") == 1
    finally:
        race.purge()


def test_concurrent_requests_cannot_pass_the_daily_cap_together(conn, sc):
    race = RaceOrg(conn, role="editor", channels=[f"chan-cap{i}" for i in range(4)], credits=False)
    barrier = threading.Barrier(3)
    results = []

    def go(i):
        with psycopg.connect(_dsn(conn), autocommit=True) as c:
            with c.transaction():
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(race.who.claims())])
                barrier.wait()
                try:
                    c.execute("select public.request_series_plan(%s, 'T', 3, null, 120, null, %s)", [f"chan-cap{i + 1}", f"race-cap-{i:04d}"])
                    results.append("ok")
                except psycopg.Error as e:
                    results.append(e.diag.message_primary)

    try:
        with as_superuser(conn) as su:
            # four recent plans already count (finished, so no channel is blocked); the limit is five
            for i in range(4):
                su.rows("insert into public.series_plans (org_id, channel_id, topic, niche, language, n_episodes, duration_s, status, error_code, "
                        "idempotency_key, request_hash, finished_at) values (%s, 'chan-cap0', 't', 'n', 'English', 3, 120, 'failed', 'x', %s, %s, now()) "
                        "returning 1", [race.org, f"pre-cap-{i:05d}", "b" * 32])
        threads = [threading.Thread(target=go, args=(i,)) for i in range(3)]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(30)
        assert sorted(results) == ["ok", "rate_limited", "rate_limited"], results
        assert race.count("select count(*) from public.series_plans where org_id = %s", [race.org]) == 5
    finally:
        race.purge()


# ═══ 10. the migration itself: replay and rollback ════════════════════════════════════════════════════════════════════════

def test_applying_the_migration_again_changes_nothing_and_keeps_every_row(conn, sc, world):
    s = world.su
    # 0122 sits on 0120's bodies and 0120 refuses any other: take it off (its own rollback), then 0120 is the head of the chain again
    sec_db.take_off_0122(s)
    plan, eps = ready_plan(s, world.ed, world.chan_a)
    started(s, world.adm, eps[0])
    become(s, None)
    counts = {t: s.value(f"select count(*) from public.{t}") for t in TABLES}
    sigs = {n: (s.value("select pg_get_functiondef(%s::regprocedure)", [SIGS_0120[n]]), s.value("select proacl::text from pg_proc where oid = %s::regprocedure", [SIGS_0120[n]]))
            for n in SIGS_0120}
    for _ in range(2):
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        become(s, None)
    assert {t: s.value(f"select count(*) from public.{t}") for t in TABLES} == counts
    assert {n: (s.value("select pg_get_functiondef(%s::regprocedure)", [SIGS_0120[n]]), s.value("select proacl::text from pg_proc where oid = %s::regprocedure", [SIGS_0120[n]]))
            for n in SIGS_0120} == sigs, "a replay changes no body and no grant"
    # the rules still hold after the replay
    assert denied(request(s, world.ed, world.chan_a, claims=False))
    assert refused(start(s, world.adm, eps[1]), "NS409", "earlier_episode_not_finished")


def test_the_rollback_puts_0029s_validator_and_0111s_guard_back_and_0120_applies_again(conn, sc):
    """The rollback restores render_job_params_valid and render_jobs_payment_guard byte for byte, puts the kind check back, drops the link
    column and every callable function, KEEPS the two tables and their rows, and the migration applies again on top."""
    admin = sec_db.admin_dsn()
    base = f"ns_series_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    sigs = ("public.render_job_params_valid(jsonb,text)", "public.render_jobs_payment_guard()")
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0120_", "0122_", "0127_"))])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {s_: (b.execute("select pg_get_functiondef(%s::regprocedure)", [s_]).fetchone()[0],
                         b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [s_]).fetchone()[0]) for s_ in sigs}
            fns = {r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
            kind_def = b.execute("select pg_get_constraintdef(oid) from pg_constraint where conname = 'render_jobs_kind_check'").fetchone()[0]
            cols = {r[0] for r in b.execute("select column_name from information_schema.columns where table_name = 'render_jobs'")}
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    kept = {"series_plans_terms_frozen()", "series_episodes_terms_frozen()", "series_rows_no_delete()"}
    with as_superuser(conn, commit=False) as su:
        sec_db.take_off_0122(su)       # 0122 sits on 0120's bodies; 0120's rollback and replay refuse any other text
        def snapshot():
            return {s_: (su.value("select pg_get_functiondef(%s::regprocedure)", [s_]),
                         su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [s_])) for s_ in sigs}
        applied = snapshot()
        rows_before = su.value("select count(*) from public.series_plans")
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert snapshot() == applied, "a replay changes nothing"
        su.conn.execute(body)
        assert snapshot() == want, "0029's validator and 0111's guard are back, byte for byte"
        now = {r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
        assert {f.replace("public.", "") for f in now - fns} == kept, sorted(now - fns)
        assert fns - now == set()
        assert su.value("select count(*) from public.series_plans") == rows_before, "the record stays"
        assert su.value("select pg_get_constraintdef(oid) from pg_constraint where conname = 'render_jobs_kind_check'") == kind_def
        assert {r[0] for r in su.rows("select column_name from information_schema.columns where table_name = 'render_jobs'")} == cols
        assert not su.value("select public.render_job_params_valid('{\"topic\": \"t\", \"series\": \"a\"}', 'daily')"), "the key is refused again"
        again = su.run(body)  # a second rollback finds the old bodies and refuses to "restore" what is not 0120's
        assert not again.ok and "is not 0120's body" in again.error, again
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert snapshot() == applied


def test_the_rollback_refuses_while_a_series_job_is_in_flight_and_changes_nothing(conn, world):
    s = world.su
    sec_db.take_off_0122(s)
    requested(s, world.ed, world.chan_a)
    become(s, None)
    before = (s.value("select pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)"),
              s.value("select count(*) from public.render_jobs where kind = 'series_plan'"))
    body = "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    out = s.run(body)
    assert not out.ok and "still queued or running" in out.error, out
    become(s, None)
    assert before == (s.value("select pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)"),
                      s.value("select count(*) from public.render_jobs where kind = 'series_plan'"))


@pytest.mark.parametrize("sig,word", [("public.render_job_params_valid(jsonb,text)", "render_job_params_valid"),
                                     ("public.render_jobs_payment_guard()", "render_jobs_payment_guard")])
def test_the_rollback_refuses_to_undo_a_later_change_to_either_function(conn, world, sig, word):
    s = world.su
    become(s, None)
    sec_db.take_off_0122(s)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [sig])
    changed = ddl.replace("begin\n", "begin\n  -- a later change, by hand\n", 1)
    assert changed != ddl
    s.conn.execute(changed)
    body = "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    out = s.run(body)
    assert not out.ok and f"rollback 0120: {word}() is not 0120's body" in out.error, out
    assert s.value("select position('a later change' in pg_get_functiondef(%s::regprocedure)) > 0", [sig]), "nothing was restored over it"


@pytest.mark.parametrize("sig,word", [("public.render_job_params_valid(jsonb,text)", "render_job_params_valid"),
                                     ("public.render_jobs_payment_guard()", "render_jobs_payment_guard")])
def test_the_migration_refuses_to_replace_a_body_it_has_not_seen_and_replaces_nothing(conn, world, sig, word):
    """The drift guard: a live body that is neither the repo's latest nor 0120's own (something applied by hand after it) is not overwritten."""
    s = world.su
    become(s, None)
    sec_db.take_off_0122(s)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [sig])
    changed = ddl.replace("begin\n", "begin\n  -- applied by hand, after the repo's migrations\n", 1)
    assert changed != ddl
    s.conn.execute(changed)
    other = "public.render_jobs_payment_guard()" if word == "render_job_params_valid" else "public.render_job_params_valid(jsonb,text)"
    other_before = s.value("select pg_get_functiondef(%s::regprocedure)", [other])
    out = s.run(MIGRATION.read_text(encoding="utf-8"))
    assert not out.ok and out.error.startswith(f"0120 found a {word}() that is neither"), out
    assert s.value("select pg_get_functiondef(%s::regprocedure)", [sig]) == changed, "the foreign body is still there"
    assert s.value("select pg_get_functiondef(%s::regprocedure)", [other]) == other_before


def test_the_rollback_strips_the_series_key_from_finished_runs_so_the_old_validator_accepts_them(conn, world):
    s = world.su
    sec_db.take_off_0122(s)
    sid = f"series-{world.sc.alice.key}"
    s.rows("update public.content_series set status = 'ACTIVE' where series_id = %s returning 1", [sid])
    plan, eps = ready_plan(s, world.ed, world.chan_a, series=sid)
    run = started(s, world.adm, eps[0])
    (job,) = run_jobs_any(s, run["render_job_id"])
    assert job[1]["series"] == sid
    finish_job(s, run["render_job_id"], "succeeded")
    become(s, None)
    s.rows("update public.render_jobs set status = 'cancelled', finished_at = now() where series_plan_id = %s returning 1", [plan])
    body = "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    s.conn.execute(body)
    become(s, None)
    assert s.value("select params ? 'series' from public.render_jobs where id = %s", [run["render_job_id"]]) is False
    assert s.value("select count(*) from public.render_jobs where kind = 'series_plan'") == 0, "the finished planning rows go with the kind"
    # the finished run is still a valid row for the old validator, and the migration applies again on top
    assert s.value("select public.render_job_params_valid(params, kind) from public.render_jobs where id = %s", [run["render_job_id"]])
    s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
