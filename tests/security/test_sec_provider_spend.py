"""Named attacks and the arithmetic of migration 0106.

Two things ship in 0106:

* video_costs.row_key + a UNIQUE index, so the nightly mirror (modules/
  supabase_sync.py) can upsert with on_conflict=row_key and a re-sent row is
  ignored. The lab proves the SQL half of that contract: the exact statement
  PostgREST issues works against the index, NULL keys coexist, and the owner's
  one-time script (docs/sql/dedupe-video-costs.sql) writes the same keys the
  Python mirror does (tests/fixtures/video_cost_keys.json is the shared proof).
* owner_provider_spend(), SECURITY DEFINER over every organization's provider
  costs. The whole defence is that it refuses everyone but a platform
  owner/admin before it reads anything, that anon and the service role cannot
  execute it, and that unknown stays unknown in the numbers it returns.

Every world is built inside one transaction that is rolled back.
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from sec_db import ANON, REPO, SERVICE, acting, as_superuser
from sec_scenario import DEFAULT_ORG

D = Decimal
SPEND = "select * from public.owner_provider_spend(%s)"
COLUMNS = ["day", "provider", "usd", "usd_priced", "unpriced_rows", "units", "unit", "runs"]
SCRIPT = REPO / "docs" / "sql" / "dedupe-video-costs.sql"
KEYS = REPO / "tests" / "fixtures" / "video_cost_keys.json"


def _day(ago=0):
    return (datetime.now(timezone.utc) - timedelta(days=ago)).strftime("%Y-%m-%d")


def _vc(su, provider, *, day=None, ago=0, unit="video_gen_clips", qty=1, usd=None, slug="s", video="v",
        row_key=None, recorded_at=None, channel="default"):
    stage = f"broll:{provider}"
    at = recorded_at if recorded_at is not None else f"{day or _day(ago)}T10:00:00.5+00:00"
    return su.value(
        "insert into public.video_costs (video_id, channel_id, slug, unit, quantity, stage, estimated_usd, recorded_at, row_key) "
        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning id",
        [video, channel, slug, unit, qty, stage, usd, at, row_key])


def _job(su, org):
    return su.value(
        "insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, "
        "quoted_credits, charged_credits, payer, submit_started_at, finished_at) "
        "values (%s, 't2i', 'm', 'm', '{}', 'completed', 1, 1, 'credits', now(), now()) returning id", [org])


def _cc(su, job, org, provider, *, ago=0, unit="image", qty=1, usd=None):
    su.rows("insert into public.creative_job_costs (job_id, org_id, provider, unit, quantity, usd_estimate, price_source, recorded_at) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s::timestamptz) returning 1",
            [job, org, provider, unit, qty, usd, "lab price" if usd is not None else None,
             f"{_day(ago)} 09:00:00+00"])


def spend(conn, who, days=30):
    with acting(conn, who) as s:
        return s.run(SPEND, [days])


def mine(conn, who, prefix, days=30):
    """The rows of this test's own providers, by (day, provider)."""
    out = spend(conn, who, days)
    assert out.ok, out
    return {(r[0], r[1]): dict(zip(COLUMNS, r)) for r in out.rows if r[1] and r[1].startswith(prefix)}


# ── attacks: who may call it ────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["alice", "bob", "stranger", "dana", "invitee"])
def test_customers_are_refused_inside_the_function(conn, sc, who):
    actor = {"alice": sc.alice.actor, "bob": sc.bob.actor, "stranger": sc.stranger,
             "dana": sc.dana, "invitee": sc.invitee}[who]
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-secret", usd=D("9.99"))
        out = spend(conn, actor)
    assert not out.ok and out.sqlstate == "42501", out
    assert "lab-secret" not in (out.error or "") and "9.99" not in (out.error or "")


def test_a_customer_is_refused_with_the_default_argument_too(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select * from public.owner_provider_spend()")
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("who", [ANON, SERVICE])
def test_anon_and_the_service_role_cannot_execute_it(conn, sc, who):
    out = spend(conn, who)
    assert not out.ok and out.sqlstate == "42501", out


def test_the_operator_may_call_it(conn, sc):
    out = spend(conn, sc.operator)
    assert out.ok, out


def test_the_function_is_security_definer_with_a_pinned_search_path_and_a_closed_acl(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows(
            "select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute'), "
            "has_function_privilege('service_role', p.oid, 'execute'), "
            "has_function_privilege('authenticated', p.oid, 'execute'), "
            "exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) "
            "from pg_proc p where p.oid = 'public.owner_provider_spend(integer)'::regprocedure")[0]
    secdef, config, anon, service, authed, public_grant = row
    assert secdef is True
    assert any(c.startswith("search_path=public") for c in config), config
    assert (anon, service, authed, public_grant) == (False, False, True, False)


def test_a_customer_cannot_borrow_the_functions_rights_through_a_view_or_wrapper(conn, sc):
    with acting(conn, sc.alice.actor) as s:
        view = s.run("create view public.leak as select * from public.owner_provider_spend(30)")
        func = s.run("create function public.leak() returns setof record language sql as "
                     "'select * from public.owner_provider_spend(30)'")
    assert not view.ok and view.sqlstate == "42501", view
    assert not func.ok and func.sqlstate == "42501", func


def test_the_new_column_gives_no_one_a_new_door(conn, sc):
    # No grant or policy changed: a customer still reads only their own channel's rows
    # (the existing isolation tests), and cannot write the key.
    with acting(conn, sc.alice.actor) as s:
        out = s.run("update public.video_costs set row_key = 'x'")
        ins = s.run("insert into public.video_costs (unit, quantity, recorded_at, row_key) values ('u', 1, 't', 'k')")
    assert (not out.ok) or out.rowcount == 0, out        # no policy lets a customer update a cost row
    assert not ins.ok, ins
    with acting(conn, ANON) as s:
        seen = s.run("select row_key from public.video_costs")
        assert (not seen.ok) or seen.rows == [], seen


# ── what the operator reads ─────────────────────────────────────────────────

def test_the_columns_name_no_organization_job_channel_or_person(conn, sc):
    with acting(conn, sc.operator) as s:
        cur = s.conn.execute(SPEND, [30])
        names = [c.name for c in cur.description]
    assert names == COLUMNS


def test_both_sources_add_up_per_provider_and_day(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-p1", unit="video_gen_clips", qty=2, usd=D("0.50"), slug="a")
        _vc(su, "lab-p1", unit="video_gen_clips", qty=1, usd=D("0.25"), slug="b")
        j = _job(su, sc.alice.org)
        _cc(su, j, sc.alice.org, "lab-p1", unit="video_gen_clips", qty=3, usd=D("1.25"))
        _cc(su, _job(su, sc.bob.org), sc.bob.org, "lab-p1", unit="video_gen_clips", qty=1, usd=D("0.10"))
        _vc(su, "lab-p2", ago=1, unit="tts_characters", qty=500, usd=D("0.01"))
        got = mine(conn, sc.operator, "lab-p")
    r = got[(_day(0), "lab-p1")]
    assert r["usd"] == D("2.10") and r["usd_priced"] == D("2.10") and r["unpriced_rows"] == 0
    assert (r["units"], r["unit"]) == (D("7"), "video_gen_clips")
    assert r["runs"] == 4          # two videos (slugs a, b) and two creative jobs
    other = got[(_day(1), "lab-p2")]
    assert (other["usd"], other["units"], other["unit"], other["runs"]) == (D("0.01"), D("500"), "tts_characters", 1)
    assert len(got) == 2


def test_an_unpriced_row_makes_the_total_unknown_not_zero(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-u", usd=D("0.30"), slug="a")
        _vc(su, "lab-u", usd=None, slug="b")
        _vc(su, "lab-n", usd=None, slug="c")
        got = mine(conn, sc.operator, "lab-")
    u = got[(_day(0), "lab-u")]
    assert u["usd"] is None and u["usd_priced"] == D("0.30") and u["unpriced_rows"] == 1
    n = got[(_day(0), "lab-n")]
    assert n["usd"] is None and n["usd_priced"] is None and n["unpriced_rows"] == 1


def test_mixed_units_are_not_added_together(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-m", unit="video_gen_clips", qty=1, usd=D("0.1"), slug="a")
        j = _job(su, sc.alice.org)
        _cc(su, j, sc.alice.org, "lab-m", unit="image", qty=4, usd=D("0.2"))
        r = mine(conn, sc.operator, "lab-m")[(_day(0), "lab-m")]
    assert r["unit"] == "mixed" and r["units"] is None and r["usd"] == D("0.3")


def test_the_provider_is_the_media_stage_provider_else_the_first_word_of_the_unit(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into public.video_costs (video_id, channel_id, slug, unit, quantity, stage, estimated_usd, recorded_at) "
                "values ('v', 'default', 'lab-s', 'gemini_input_tokens', 10, 'script', 0.001, %s) returning 1", [f"{_day()}T01:00:00+00:00"])
        su.rows("insert into public.video_costs (video_id, channel_id, slug, unit, quantity, stage, estimated_usd, recorded_at) "
                "values ('v', 'default', 'lab-s', 'image_generations', 1, 'image:Lab-Leo', 0.04, %s) returning 1", [f"{_day()}T01:00:00+00:00"])
        out = spend(conn, sc.operator)
    providers = {r[1] for r in out.rows if r[0] == _day()}
    assert {"gemini", "lab-leo"} <= providers


def test_a_row_with_no_readable_date_is_shown_not_hidden_and_nothing_raises(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-d", recorded_at="not a date", usd=D("0.2"), slug="a")
        _vc(su, "lab-d", recorded_at="2026-02-31T00:00:00+00:00", usd=D("0.2"), slug="b")  # impossible day
        _vc(su, "lab-d", recorded_at="2026-13-01", usd=D("0.2"), slug="c")
        got = mine(conn, sc.operator, "lab-d")
    # "not a date" and month 13 are undated: listed under day NULL. 02-31 is shaped like a
    # date and sorts as text, so it is simply outside this window. Nothing raised.
    assert list(got) == [(None, "lab-d")]
    assert got[(None, "lab-d")]["usd"] == D("0.4") and got[(None, "lab-d")]["runs"] == 2


def test_the_window_is_clamped_to_1_through_180_days(conn, sc):
    with as_superuser(conn, commit=False) as su:
        for ago in (0, 1, 2, 179, 180, 181):
            _vc(su, "lab-w", ago=ago, usd=D("1"), slug=f"s{ago}")
        days = lambda n: sorted(d for (d, p) in mine(conn, sc.operator, "lab-w", n))  # noqa: E731
        assert days(1) == [_day(0)]
        assert days(0) == [_day(0)] and days(-7) == [_day(0)]          # clamped up to 1
        assert days(2) == sorted([_day(1), _day(0)])
        assert days(180) == sorted(_day(a) for a in (0, 1, 2, 179))      # day 180 ago is the 181st day
        assert days(100000) == days(180)                                  # clamped down to 180
        assert days(181) == days(180)


def test_a_null_window_means_30_days(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-null", ago=29, usd=D("1"), slug="in")
        _vc(su, "lab-null", ago=30, usd=D("1"), slug="out")
        with acting(conn, sc.operator) as s:
            rows = s.rows("select day from public.owner_provider_spend(null) where provider = 'lab-null'")
    assert rows == [(_day(29),)]


def test_old_rows_are_outside_the_window(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-old", ago=400, usd=D("5"))
        got = mine(conn, sc.operator, "lab-old", 180)
    assert got == {}


def test_the_result_is_a_few_hundred_rows_at_most_for_a_month(conn, sc):
    with acting(conn, sc.operator) as s:
        n = s.value("select count(*) from public.owner_provider_spend(30)")
    assert n < 500


# ── the mirror's half: row_key and its unique index ─────────────────────────

def test_the_index_is_unique_and_not_partial(conn):
    # PostgREST's on_conflict=row_key cannot carry a partial index's WHERE, so a
    # partial index would answer 42P10 to the mirror. Unique + plain is the contract.
    with as_superuser(conn, commit=False) as s:
        row = s.rows("select i.indisunique, i.indpred is null, a.attname "
                     "from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) "
                     "where i.indexrelid = 'public.video_costs_row_key_uidx'::regclass")
    assert row == [(True, True, "row_key")]


def test_the_column_is_nullable_without_a_default(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows("select is_nullable, column_default, data_type from information_schema.columns "
                     "where table_schema = 'public' and table_name = 'video_costs' and column_name = 'row_key'")
    assert row == [("YES", None, "text")]


def test_rows_without_a_key_coexist(conn):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-k", slug="a")
        _vc(su, "lab-k", slug="a")        # identical, both NULL key: allowed (rows from before 0106)
        assert su.value("select count(*) from public.video_costs where stage = 'broll:lab-k'") == 2


def test_the_statement_postgrest_sends_ignores_a_resent_row(conn):
    insert = ("insert into public.video_costs (video_id, channel_id, slug, unit, quantity, stage, recorded_at, row_key) "
              "values ('v', 'default', 's', 'u', 1, 'broll:lab-pg', 't', %s) on conflict (row_key) do nothing returning 1")
    with as_superuser(conn, commit=False) as su:
        assert su.rows(insert, ["v1:aaa"]) == [(1,)]
        assert su.rows(insert, ["v1:aaa"]) == []          # ignored, no error
        assert su.rows(insert, ["v1:bbb"]) == [(1,)]
        assert su.value("select count(*) from public.video_costs where stage = 'broll:lab-pg'") == 2


def test_a_duplicate_key_is_refused_without_on_conflict(conn):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-dup", row_key="v1:dup")
        out = su.run("insert into public.video_costs (unit, quantity, recorded_at, row_key) values ('u', 1, 't', 'v1:dup')")
        assert not out.ok and out.sqlstate == "23505", out


def test_a_keyed_row_is_counted_once_by_the_report(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _vc(su, "lab-once", usd=D("1"), row_key="v1:once", slug="a")
        _vc(su, "lab-once", usd=D("2"), slug="b")        # an old row, no key
        got = mine(conn, sc.operator, "lab-once")
    assert got[(_day(0), "lab-once")]["usd"] == D("3")


# ── the owner's one-time script writes the keys the mirror writes ───────────

def _script():
    """The script's body without its own transaction control, so the test can run
    it inside a transaction it rolls back afterwards (and look at the result)."""
    text = SCRIPT.read_text(encoding="utf-8")
    assert text.rstrip().splitlines()[-1].startswith("rollback;"), "the script must end in ROLLBACK by default"
    text = re.sub(r"(?m)^begin;\s*$", "", text)
    return re.sub(r"(?m)^rollback;.*$", "", text)


def _insert_case(su, row, **extra):
    return su.value(
        "insert into public.video_costs (video_id, channel_id, slug, unit, quantity, stage, recorded_at, estimated_usd, row_key) "
        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning id",
        [row.get("video_id"), row.get("channel_id"), row.get("slug"), row["unit"], row["quantity"], row.get("stage"),
         row["recorded_at"], extra.get("usd"), extra.get("row_key")])


def test_the_script_gives_survivors_the_key_the_python_mirror_computes(conn):
    cases = json.loads(KEYS.read_text(encoding="utf-8"))
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.video_costs")
        ids = {}
        for c in cases:
            ids[c["row_key"]] = _insert_case(su, c["row"], usd=0.01)
            _insert_case(su, c["row"], usd=0.01)           # the nightly copies
            _insert_case(su, c["row"], usd=0.01)
        # a row that is already keyed (written after 0106) and its unkeyed twin
        twin = cases[0]
        su.run("delete from public.video_costs where id = %s", [ids[twin["row_key"]]])
        keyed = _insert_case(su, twin["row"], row_key=twin["row_key"], usd=0.01)
        before = su.value("select count(*) from public.video_costs")
        assert before == 3 * len(cases)

        su.run(_script())

        rows = dict(su.rows("select row_key, count(*) from public.video_costs group by row_key"))
        assert set(rows) == {c["row_key"] for c in cases}, "every survivor carries exactly the Python key"
        assert set(rows.values()) == {1}, "one row per group"
        assert su.value("select count(*) from public.video_costs where row_key is null") == 0
        assert su.value("select id from public.video_costs where row_key = %s", [twin["row_key"]]) == keyed, \
            "an already keyed row is the copy that counts"
        # running it again is a no-op
        su.run(_script())
        assert su.value("select count(*) from public.video_costs") == len(cases)


def test_the_script_leaves_distinct_charges_alone(conn):
    with as_superuser(conn, commit=False) as su:
        su.run("delete from public.video_costs")
        base = {"video_id": "v", "channel_id": "default", "slug": "s", "unit": "tts_characters", "stage": "tts",
                "recorded_at": "2026-09-01T10:00:00+00:00", "quantity": 10}
        for over in ({}, {"quantity": 11}, {"video_id": "v2"}, {"stage": "voice"}, {"recorded_at": "2026-09-01T10:00:01+00:00"}):
            _insert_case(su, {**base, **over})
        su.run(_script())
        assert su.value("select count(*) from public.video_costs") == 5
        assert su.value("select count(distinct row_key) from public.video_costs") == 5
