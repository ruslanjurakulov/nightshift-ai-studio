"""Migration 0122 (the format-template carrier): the one word that decides which format a series plan was asked for.

The attackers are the people a browser can be (another member of the organization, a stranger, the anon key, the service key where it should not
reach) and the file itself (a replay, a half-seen database, a body somebody changed by hand). What must NOT change is checked beside every
refusal: a request without a format behaves exactly as under 0120, the rest of the render queue is untouched, and request_series_plan stays
granted to nobody.

What would break without these:
  * the format being free text: stored, passed to the planner or the queue, and read by a model, without being one of three known words;
  * the grant: the new eight-argument function reachable by an API role, or the old seven-argument one left behind as a second door;
  * the format changing after the request (the plan's terms), or the planning job carrying a format its plan did not ask for;
  * a replay with another format answering the first press, or a request without a format no longer replaying a plan made under 0120;
  * the migration replacing a body it has not seen, or dropping a function that somebody had granted by hand;
  * the rollback losing a record, leaving a row the 0120 validator would refuse, or leaving a trigger that names a column that is gone.

Everything runs on the shared scenario inside transactions that are rolled back; the two tests that need a database of their own (the rollback to
0120 and a plan made under 0120) build one and drop it. Nothing calls a provider.
"""

from __future__ import annotations

import json
import re
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE
from sec_db import as_superuser
# The helpers and the scenario of the 0120 file: the same world, so a plan here is a plan there.
from test_sec_series_tables import (  # noqa: F401  (world is a fixture)
    SECS, become, become_claims, denied, finish, forbidden, insert_job, jobs_of_plan, key, not_found, ready_plan, refused, world)

MIGRATION = sec_db.MIGRATION_0122
ROLLBACK = sec_db.ROLLBACK_0122
IDS = ("myth_vs_fact", "top5_countdown", "one_question_one_answer")
NEW = "public.request_series_plan(text,text,integer,text,integer,text,text,text)"
OLD = "public.request_series_plan(text,text,integer,text,integer,text,text)"
FOUR = ("public.render_job_params_valid(jsonb,text)", "public.render_jobs_payment_guard()", "public.series_plans_terms_frozen()", NEW)

#: Everything that is not one of the three words, in the shapes a browser, a script or a model could send.
NOT_IDS = ("", " ", "MYTH_VS_FACT", "Myth_vs_fact", " myth_vs_fact", "myth_vs_fact ", "myth_vs_fact\n", "\nmyth_vs_fact",
           "myth-vs-fact", "myth vs fact", "top_5_countdown", "top5", "one_question", "default", "none", "null", "NULL", "0", "1", "true", "*",
           "myth_vs_fact,top5_countdown", "myth_vs_fact;", "myth_vs_fact'", "'; drop table public.series_plans; --", "myth_vs_fact--", "%", "_",
           "mуth_vs_fact", "myth_vs_fact​", "ｍyth_vs_fact", "a" * 5000)


def request_t(s, who, channel, template=None, *, topic="The fall of an empire", n=3, language=None, duration=SECS, series=None, idem=None,
              claims=True, named=False):
    """request_series_plan with the format as its eighth argument (positional), or by name the way PostgREST calls it."""
    (become_claims if claims else become)(s, who)
    idem = idem or key()
    if named:
        return s.run("select public.request_series_plan(p_channel => %s, p_topic => %s, p_n => %s, p_language => %s, p_duration_s => %s, "
                     "p_series => %s, p_idem => %s, p_template => %s)", [channel, topic, n, language, duration, series, idem, template])
    return s.run("select public.request_series_plan(%s, %s, %s, %s, %s, %s, %s, %s)", [channel, topic, n, language, duration, series, idem, template])


def made(s, who, channel, template=None, **kw):
    out = request_t(s, who, channel, template, **kw)
    assert out.ok, out
    return out.rows[0][0]


def state(s):
    """The four functions' definitions and privileges, for 'a replay changes nothing'."""
    become(s, None)
    return {sig: (s.value("select pg_get_functiondef(%s::regprocedure)", [sig]), s.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]))
            for sig in FOUR}


def migration_body():
    return MIGRATION.read_text(encoding="utf-8")


def rollback_body():
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def clear_plan_job(s, plan):
    """Take a plan's queue row away (the owner, past the triggers) so the guard can be tried against it one more time."""
    become(s, None)
    s.conn.execute("set local session_replication_role = replica")
    s.conn.execute("delete from public.render_jobs where series_plan_id = %s", [plan])
    s.conn.execute("update public.series_plans set render_job_id = null where id = %s", [plan])
    s.conn.execute("set local session_replication_role = origin")


# ═══ 1. nobody may call it ════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_old_signature_is_gone_and_the_new_one_is_granted_to_nobody_and_not_public(conn, world):
    s = world.su
    become(s, None)
    assert s.value("select to_regprocedure(%s)", [OLD]) is None, "a second door must not be left behind"
    assert s.value("select to_regprocedure(%s)", [NEW]) is not None
    got = tuple(s.value("select has_function_privilege(%s, %s::regprocedure, 'execute')", [role, NEW]) for role in ("anon", "authenticated", "service_role"))
    assert got == (False, False, False), got
    assert s.value("select proacl is not null from pg_proc where oid = %s::regprocedure", [NEW]), "a NULL ACL is the default, and the default includes PUBLIC"
    assert not s.value("select coalesce(bool_or(a.grantee = 0), false) from pg_proc p, aclexplode(p.proacl) a where p.oid = %s::regprocedure", [NEW])
    assert s.value("select count(*) from pg_proc where proname = 'request_series_plan' and pronamespace = 'public'::regnamespace") == 1


def test_no_api_role_can_call_it_with_or_without_a_format_by_position_or_by_name(conn, world):
    s = world.su
    for who in (world.alice, world.adm, world.ed, world.bob, world.stranger, ANON, SERVICE):
        for template in (None, "myth_vs_fact", "not-a-format"):
            for named in (False, True):
                out = request_t(s, who, world.chan_a, template, claims=False, named=named)
                assert denied(out), (who.name, template, named, out)
        # the seven-argument form (what 0120's callers sent) reaches the same function and is refused the same way
        become(s, who)
        out = s.run("select public.request_series_plan(%s, %s, %s, %s, %s, %s, %s)", [world.chan_a, "t", 3, None, SECS, None, key()])
        assert denied(out), (who.name, out)
    become(s, None)
    assert s.value("select count(*) from public.series_plans where created_at >= now()") == 0
    assert s.value("select count(*) from public.render_jobs where kind = 'series_plan'") == 0


def test_the_function_is_a_definer_with_a_pinned_search_path(conn, world):
    s = world.su
    become(s, None)
    definer, config = s.rows("select prosecdef, coalesce(proconfig::text, '') from pg_proc where oid = %s::regprocedure", [NEW])[0]
    assert definer and "search_path=public, pg_temp" in config, config


def test_the_other_series_functions_keep_their_grants(conn, world):
    s = world.su
    become(s, None)
    want = {"public.finish_series_plan(uuid,boolean,text,jsonb,jsonb,jsonb,text,text)": (False, False, True),
            "public.quote_series_episode(uuid)": (False, True, False), "public.start_series_episode(uuid,numeric,text,boolean)": (False, True, False),
            "public.series_plans_terms_frozen()": (False, False, False)}
    for sig, expect in want.items():
        got = tuple(s.value("select has_function_privilege(%s, %s::regprocedure, 'execute')", [role, sig]) for role in ("anon", "authenticated", "service_role"))
        assert got == expect, (sig, got)


# ═══ 2. the format is one of three words, or the request is refused ═══════════════════════════════════════════════════════

def test_a_plan_asked_for_each_format_stores_it_and_queues_a_job_that_carries_it(conn, world):
    s = world.su
    for template, channel in zip(IDS, (world.chan_a, world.chan_a2, world.chan_a3)):
        out = made(s, world.ed, channel, template)
        assert out["status"] == "requested" and out["replayed"] is False
        become(s, None)
        assert s.value("select template_id from public.series_plans where id = %s", [out["id"]]) == template
        (job,) = jobs_of_plan(s, out["id"])
        assert job[2] == {"topic": "The fall of an empire", "niche": "tech", "language": "English", "template": template}, job
        assert job[3] is None and job[4] == "queued", "no hold, queued"
        assert s.value("select public.render_job_params_valid(%s::jsonb, 'series_plan')", [json.dumps(job[2])])
    become(s, None)
    assert s.value("select count(*) from public.credit_reservations where created_at >= now()") == 0, "planning holds nothing"


def test_the_named_argument_call_reaches_it_the_way_postgrest_does(conn, world):
    s = world.su
    with_format = made(s, world.ed, world.chan_a, "top5_countdown", named=True)
    without = made(s, world.ed, world.chan_a2, None, named=True)
    become(s, None)
    assert s.value("select template_id from public.series_plans where id = %s", [with_format["id"]]) == "top5_countdown"
    assert s.value("select template_id from public.series_plans where id = %s", [without["id"]]) is None
    # and the call that names no p_template at all (what the browser sends when no format was picked) uses the default
    become_claims(s, world.ed)
    out = s.run("select public.request_series_plan(p_channel => %s, p_topic => %s, p_n => %s, p_language => %s, p_duration_s => %s, p_series => %s, p_idem => %s)",
                [world.chan_a3, "t", 3, None, SECS, None, key()])
    assert out.ok, out
    become(s, None)
    assert s.value("select template_id from public.series_plans where id = %s", [out.rows[0][0]["id"]]) is None


def test_without_a_format_nothing_is_stored_and_the_job_has_no_template_key(conn, world):
    s = world.su
    out = made(s, world.ed, world.chan_a)          # the eighth argument is NULL
    become_claims(s, world.ed)
    r = s.run("select public.request_series_plan(%s, %s, %s, %s, %s, %s, %s)", [world.chan_a2, "The fall of an empire", 3, None, SECS, None, key()])
    assert r.ok, r
    seven = r.rows[0][0]
    for plan in (out["id"], seven["id"]):
        become(s, None)
        assert s.value("select template_id from public.series_plans where id = %s", [plan]) is None
        (job,) = jobs_of_plan(s, plan)
        assert "template" not in job[2], job
        assert job[2] == {"topic": "The fall of an empire", "niche": "tech", "language": "English"}


@pytest.mark.parametrize("bad", NOT_IDS, ids=lambda b: repr(b)[:24])
def test_anything_but_the_three_words_is_refused_by_name_and_queues_nothing(conn, world, bad):
    s = world.su
    out = request_t(s, world.ed, world.chan_a, bad)
    assert refused(out, "22023", "invalid_template"), out
    become(s, None)
    assert s.value("select count(*) from public.series_plans where created_at >= now()") == 0
    assert s.value("select count(*) from public.render_jobs where kind = 'series_plan'") == 0


def test_the_format_is_judged_after_the_caller_so_it_is_no_oracle(conn, world):
    """A stranger, a viewer and a member of another organization get what they got under 0120, whatever they put in the format."""
    s = world.su
    for template in ("myth_vs_fact", "not-a-format", ""):
        assert not_found(request_t(s, world.bob, world.chan_a, template)), template
        assert not_found(request_t(s, world.stranger, world.chan_a, template)), template
        assert not_found(request_t(s, world.ed, "no-such-channel", template)), template
        assert forbidden(request_t(s, world.viewer, world.chan_a, template)), template
    a, b = request_t(s, world.bob, world.chan_a, "myth_vs_fact"), request_t(s, world.bob, world.chan_a, "not-a-format")
    assert (a.sqlstate, a.error) == (b.sqlstate, b.error), "the same answer for a good format and a bad one"


def test_the_other_refusals_keep_their_words_and_their_order_with_a_format_present(conn, world):
    s = world.su
    assert refused(request_t(s, world.ed, world.chan_a, "myth_vs_fact", topic=""), "22023", "invalid_topic")
    assert refused(request_t(s, world.ed, world.chan_a, "myth_vs_fact", n=5), "22023", "invalid_episode_count")
    assert refused(request_t(s, world.ed, world.chan_a, "myth_vs_fact", duration=10), "22023", "invalid_duration")
    assert refused(request_t(s, world.ed, world.chan_a, "myth_vs_fact", language="Русский"), "22023", "invalid_language")
    assert refused(request_t(s, world.ed, world.chan_a, "myth_vs_fact", idem="x"), "22023", "invalid_idempotency_key")
    # a bad format is judged among them, before the series is looked up and before the lock: a bad format with a missing series is the format's word
    assert refused(request_t(s, world.ed, world.chan_a, "nope", series="no-such-series"), "22023", "invalid_template")
    become(s, None)
    assert s.value("select count(*) from public.series_plans where created_at >= now()") == 0


def test_a_format_does_not_get_around_the_cap_the_channel_slot_or_the_series_check(conn, world):
    s = world.su
    sid = f"series-{world.sc.alice.key}"
    first = made(s, world.ed, world.chan_a, "myth_vs_fact", series=sid)
    assert refused(request_t(s, world.ed, world.chan_a, "top5_countdown"), "NS409", "plan_in_progress")
    assert not_found(request_t(s, world.ed, world.chan_a2, "myth_vs_fact", series=sid)), "the series is the channel's own"
    become(s, None)
    assert jobs_of_plan(s, first["id"])[0][2]["series"] == sid
    assert jobs_of_plan(s, first["id"])[0][2]["template"] == "myth_vs_fact"
    for channel in (world.chan_a2, world.chan_a3):
        made(s, world.ed, channel, "one_question_one_answer")
    for i in range(2):
        ch = f"chan-cap-{i}"
        become(s, None)
        s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', %s) returning 1", [ch, ch, world.org_a])
        made(s, world.ed, ch, "top5_countdown")
    ch = "chan-cap-over"
    become(s, None)
    s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', %s) returning 1", [ch, ch, world.org_a])
    out = request_t(s, world.ed, ch, "top5_countdown")
    assert not out.ok and out.error == "rate_limited" and out.sqlstate == "NS429", out


# ═══ 3. the idempotency hash ══════════════════════════════════════════════════════════════════════════════════════════════

def test_the_same_press_with_the_same_format_replays_and_queues_nothing_more(conn, world):
    s = world.su
    k = key()
    one = made(s, world.ed, world.chan_a, "myth_vs_fact", idem=k)
    two = made(s, world.ed, world.chan_a, "myth_vs_fact", idem=k)
    assert one["id"] == two["id"] and two["replayed"] is True and one["replayed"] is False
    become(s, None)
    assert s.value("select count(*) from public.render_jobs where series_plan_id = %s", [one["id"]]) == 1
    k2 = key()
    p1 = made(s, world.ed, world.chan_a2, None, idem=k2)
    p2 = made(s, world.ed, world.chan_a2, None, idem=k2)
    assert p1["id"] == p2["id"] and p2["replayed"] is True


@pytest.mark.parametrize("first,second", [("myth_vs_fact", "top5_countdown"), ("myth_vs_fact", None), (None, "myth_vs_fact"),
                                          ("top5_countdown", "one_question_one_answer")])
def test_the_same_key_with_another_format_is_a_conflict_and_changes_nothing(conn, world, first, second):
    s = world.su
    k = key()
    plan = made(s, world.ed, world.chan_a, first, idem=k)
    out = request_t(s, world.ed, world.chan_a, second, idem=k)
    assert refused(out, "NS409", "idempotency_conflict"), out
    become(s, None)
    assert s.value("select count(*) from public.series_plans where idempotency_key = %s", [k]) == 1
    assert s.value("select template_id from public.series_plans where id = %s", [plan["id"]]) == first
    assert s.value("select count(*) from public.render_jobs where series_plan_id = %s", [plan["id"]]) == 1


def test_a_request_without_a_format_hashes_exactly_as_0120_did(conn, world):
    s = world.su
    k = key()
    plan = made(s, world.ed, world.chan_a, None, idem=k, topic="A topic", language="Uzbek", duration=240)
    become(s, None)
    hashes = "md5(jsonb_build_object('channel', p.channel_id, 'topic', p.topic, 'n', p.n_episodes, 'language', p.language, 'duration', p.duration_s, 'series', null::text)::text)"
    stored, expected = s.rows(f"select p.request_hash, {hashes} from public.series_plans p where p.id = %s", [plan["id"]])[0]
    assert stored == expected, "0120's object, key for key: a plan made before this migration still replays"
    with_format = made(s, world.ed, world.chan_a2, "myth_vs_fact", idem=key())
    stored, base = s.rows(f"select p.request_hash, {hashes} from public.series_plans p where p.id = %s", [with_format["id"]])[0]
    assert stored != base, "the format is part of what was asked"


# ═══ 4. the plan's terms ══════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_format_is_frozen_with_the_other_terms_even_for_the_owner(conn, world):
    s = world.su
    plan = made(s, world.ed, world.chan_a, "myth_vs_fact")["id"]
    plain = made(s, world.ed, world.chan_a2)["id"]
    become(s, None)
    for target, to in ((plan, "top5_countdown"), (plan, None), (plain, "myth_vs_fact")):
        out = s.run("update public.series_plans set template_id = %s where id = %s", [to, target])
        assert not out.ok and out.sqlstate == "42501" and "terms are fixed" in out.error, (to, out)
    assert s.value("select template_id from public.series_plans where id = %s", [plan]) == "myth_vs_fact"
    assert s.value("select template_id from public.series_plans where id = %s", [plain]) is None
    for who in (world.alice, world.ed, ANON, SERVICE):
        become(s, who)
        out = s.run("update public.series_plans set template_id = 'top5_countdown' where id = %s", [plan])
        assert not out.ok and out.error.startswith("permission denied"), (who.name, out)


def test_finishing_a_plan_keeps_its_format_and_the_ended_plan_is_still_final(conn, world):
    s = world.su
    plan = made(s, world.ed, world.chan_a, "one_question_one_answer")["id"]
    assert finish(s, plan).ok
    become(s, None)
    assert s.rows("select status, template_id from public.series_plans where id = %s", [plan]) == [("ready", "one_question_one_answer")]
    out = s.run("update public.series_plans set template_id = null where id = %s", [plan])
    assert not out.ok and out.sqlstate == "42501"
    failed = made(s, world.ed, world.chan_a2, "top5_countdown")["id"]
    assert finish(s, failed, ok=False, code="timeout", error="Planning took too long.").ok
    become(s, None)
    assert s.rows("select status, template_id from public.series_plans where id = %s", [failed]) == [("failed", "top5_countdown")]


def test_a_member_reads_the_format_of_their_own_plans_and_nobody_elses(conn, world):
    s = world.su
    plan = made(s, world.ed, world.chan_a, "myth_vs_fact")["id"]
    for who, want in ((world.ed, 1), (world.alice, 1), (world.viewer, 1), (world.bob, 0), (world.stranger, 0), (ANON, 0)):
        become(s, who)
        out = s.run("select template_id from public.series_plans where id = %s", [plan])
        if who is ANON:
            assert not out.ok and out.error.startswith("permission denied"), out
        else:
            assert len(out.rows) == want and (not want or out.rows[0][0] == "myth_vs_fact"), (who.name, out)


def test_the_table_refuses_a_word_outside_the_list_whoever_writes_it(conn, world):
    s = world.su
    become(s, None)
    plan = made(s, world.ed, world.chan_a, "myth_vs_fact")["id"]
    become(s, None)
    cols = "org_id, channel_id, topic, niche, language, n_episodes, duration_s, idempotency_key, request_hash, requested_by, template_id, status, finished_at, error_code"

    def insert(template):
        become(s, None)
        return s.run(f"insert into public.series_plans ({cols}) select org_id, channel_id || '', topic, niche, language, n_episodes, duration_s, "
                     "%s, request_hash, requested_by, %s, 'failed', now(), 'x' from public.series_plans where id = %s",
                     [f"direct-{uuid.uuid4().hex}", template, plan])

    assert insert("myth_vs_fact").ok and insert(None).ok
    for bad in ("", "Myth_vs_fact", "myth_vs_fact ", "other"):
        out = insert(bad)
        assert not out.ok and out.sqlstate == "23514" and "series_plans_template_check" in out.error, (bad, out)
    definition = s.value("select pg_get_constraintdef(oid) from pg_constraint where conname = 'series_plans_template_check'")
    assert "template_id IS NULL" in definition and all(f"'{tid}'::text" in definition for tid in IDS), definition


# ═══ 5. the queue ═════════════════════════════════════════════════════════════════════════════════════════════════════════

def valid(s, params, kind="series_plan"):
    become(s, None)
    return s.value("select public.render_job_params_valid(%s::jsonb, %s)", [json.dumps(params), kind])


def test_the_validator_accepts_a_format_only_on_a_planning_job_and_only_one_of_the_three(conn, world):
    s = world.su
    base = {"topic": "t", "niche": "n"}
    for tid in IDS:
        assert valid(s, {**base, "template": tid}), tid
        assert valid(s, {**base, "template": tid, "language": "Uzbek", "series": "s-1"}), tid
    assert valid(s, base), "no format is still the normal case"
    for bad in NOT_IDS:
        assert not valid(s, {**base, "template": bad}), repr(bad)[:30]
    for bad in (None, 1, 0, True, False, ["myth_vs_fact"], {"id": "myth_vs_fact"}, 1.5):
        assert not valid(s, {**base, "template": bad}), repr(bad)
    for kind in ("daily", "repair", "surprise", ""):
        assert not valid(s, {"topic": "t", "template": "myth_vs_fact"}, kind), kind
    assert not s.value("select public.render_job_params_valid(%s::jsonb, null)", [json.dumps({"topic": "t", "niche": "n", "template": "myth_vs_fact"})]), "a NULL kind"
    assert not valid(s, {"topic": "t", "duration": 120, "template": "myth_vs_fact"}, "daily")
    for extra in ({"duration": 120}, {"resume": True}, {"voice_id": "A" * 20}, {"video_provider": "veo"}, {"repair_scenes": "1"}, {"privacy": "public"}):
        assert not valid(s, {**base, "template": "myth_vs_fact", **extra}), extra
    assert not valid(s, {"template": "myth_vs_fact"}), "a format alone is not a planning job"
    # and nothing about the rules from 0029 and 0120 moved
    assert valid(s, {"topic": "t", "series": "series-a"}, "daily") and not valid(s, {"topic": "t", "series": "Bad"}, "daily")
    assert valid(s, {"repair_scenes": "1"}, "repair") and not valid(s, {"topic": "t", "series": "a", "repair_scenes": "1"}, "repair")
    assert valid(s, {"topic": "t", "duration": 30, "publish_hint": "youtube:abc", "resume": True}, "daily")


def test_the_payment_guard_accepts_a_planning_job_only_when_its_format_is_its_plans(conn, world):
    s = world.su
    plan = made(s, world.ed, world.chan_a, "myth_vs_fact")["id"]
    base = {"topic": "The fall of an empire", "niche": "tech", "language": "English"}
    again = insert_job(s, None, "series_plan", {**base, "template": "myth_vs_fact"}, plan=plan, channel=world.chan_a)
    assert not again.ok and again.sqlstate == "42501" and "not the job its series plan queued" in again.error, again
    clear_plan_job(s, plan)
    for label, params in (("no format", base), ("another format", {**base, "template": "top5_countdown"}),
                          ("an empty format", {**base, "template": ""}), ("a format that is not one", {**base, "template": "nope"}),
                          ("the format and a run key", {**base, "template": "myth_vs_fact", "duration": 120}),
                          ("a null format", {**base, "template": None})):
        out = insert_job(s, None, "series_plan", params, plan=plan, channel=world.chan_a)
        assert not out.ok and out.sqlstate in ("42501", "23514"), (label, out)
    ok = insert_job(s, None, "series_plan", {**base, "template": "myth_vs_fact"}, plan=plan, channel=world.chan_a)
    assert ok.ok, ok
    plain = made(s, world.ed, world.chan_a2)["id"]
    clear_plan_job(s, plain)
    for tid in IDS:
        out = insert_job(s, None, "series_plan", {**base, "template": tid}, plan=plain, channel=world.chan_a2)
        assert not out.ok and out.sqlstate == "42501" and "not the job its series plan queued" in out.error, (tid, out)
    assert insert_job(s, None, "series_plan", base, plan=plain, channel=world.chan_a2).ok


def test_a_browser_cannot_insert_a_planning_job_or_a_run_that_carries_a_format(conn, world):
    s = world.su
    plan = made(s, world.adm, world.chan_a, "top5_countdown")["id"]
    clear_plan_job(s, plan)
    exact = {"topic": "The fall of an empire", "niche": "tech", "language": "English", "template": "top5_countdown"}
    for who in (world.alice, world.adm, world.ed, world.bob, ANON):
        out = insert_job(s, who, "series_plan", exact, plan=plan, channel=world.chan_a)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
        daily = insert_job(s, who, "daily", {"topic": "t", "duration": 120, "template": "top5_countdown"}, credit_ref="rj-nothing", channel=world.chan_a)
        assert not daily.ok and daily.sqlstate in ("42501", "23514"), (who.name, daily)
        daily = insert_job(s, who, "daily", {"topic": "t", "duration": 120, "template": "top5_countdown"}, plan=plan, channel=world.chan_a)
        assert not daily.ok and daily.sqlstate in ("42501", "23514"), (who.name, daily)
    become(s, None)
    assert jobs_of_plan(s, plan) == []
    assert insert_job(s, None, "series_plan", exact, plan=plan, channel=world.chan_a).ok


def test_an_ordinary_run_with_a_template_param_is_refused_by_the_tables_own_check(conn, world):
    s = world.su
    become(s, None)
    out = s.run("insert into public.render_jobs (channel_id, kind, params) values (%s, 'daily', %s::jsonb)",
                [world.chan_op, json.dumps({"topic": "t", "template": "myth_vs_fact"})])
    assert not out.ok and out.sqlstate == "23514" and "render_jobs_params_check" in out.error, out
    out = s.run("insert into public.render_jobs (channel_id, kind, params) values (%s, 'daily', %s::jsonb)", [world.chan_op, json.dumps({"topic": "t"})])
    assert out.ok, out


def test_a_queue_row_with_a_format_can_still_be_updated_by_the_worker(conn, world):
    """The CHECK is evaluated on every update of a row: the worker claims, heartbeats and finishes a planning job, so the row must stay valid."""
    s = world.su
    plan = made(s, world.ed, world.chan_a, "one_question_one_answer")
    become(s, None)
    for status in ("running", "succeeded"):
        out = s.run("update public.render_jobs set status = %s, started_at = coalesce(started_at, now()), finished_at = case when %s = 'succeeded' then now() end "
                    "where id = %s", [status, status, plan["render_job_id"]])
        assert out.ok, (status, out)


def test_a_customers_ordinary_run_is_unchanged(conn, world):
    s = world.su
    become(s, None)
    out = s.run("insert into public.render_jobs (channel_id, kind, params, credit_ref) values (%s, 'daily', %s::jsonb, null)",
                [world.chan_a, json.dumps({"topic": "t", "duration": 120})])
    assert not out.ok and out.sqlstate == "42501" and "credit hold" in out.error, "no hold, no run: as before 0122"


# ═══ 6. the migration itself: replay and drift guards ═════════════════════════════════════════════════════════════════════

def test_applying_the_migration_again_changes_nothing_and_keeps_every_row(conn, world):
    s = world.su
    sec_db.take_off_0127(s)   # 0127 sits on 0122's request_series_plan(); 0122's file and rollback refuse any other body
    ready_plan(s, world.ed, world.chan_a, topic="Replay one")
    plan = made(s, world.ed, world.chan_a2, "myth_vs_fact")
    become(s, None)
    counts = {t: s.value(f"select count(*) from public.{t}") for t in ("series_plans", "series_episodes", "render_jobs")}
    before = state(s)
    for _ in range(2):
        s.conn.execute(migration_body())
        become(s, None)
    assert state(s) == before, "a replay changes no body and no grant"
    assert {t: s.value(f"select count(*) from public.{t}") for t in ("series_plans", "series_episodes", "render_jobs")} == counts
    assert s.value("select template_id from public.series_plans where id = %s", [plan["id"]]) == "myth_vs_fact"
    assert s.value("select to_regprocedure(%s)", [OLD]) is None
    assert denied(request_t(s, world.ed, world.chan_a3, "myth_vs_fact", claims=False))
    assert refused(request_t(s, world.ed, world.chan_a2, "nope"), "22023", "invalid_template")


@pytest.mark.parametrize("sig,word", [("public.render_job_params_valid(jsonb,text)", "render_job_params_valid"),
                                     ("public.render_jobs_payment_guard()", "render_jobs_payment_guard"),
                                     ("public.series_plans_terms_frozen()", "series_plans_terms_frozen")])
def test_the_migration_refuses_to_replace_a_body_it_has_not_seen_and_replaces_nothing(conn, world, sig, word):
    s = world.su
    become(s, None)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [sig])
    marker = "begin\n" if "begin\n" in ddl else "BEGIN\n"
    changed = ddl.replace(marker, marker + "  -- applied by hand, after the repo's migrations\n", 1)
    assert changed != ddl
    s.conn.execute(changed)
    others = {x: s.value("select pg_get_functiondef(%s::regprocedure)", [x]) for x in FOUR if x != sig}
    out = s.run(migration_body())
    assert not out.ok and out.error.startswith(f"0122 found a {word}() that is neither"), out
    assert s.value("select pg_get_functiondef(%s::regprocedure)", [sig]) == changed, "the foreign body is still there"
    assert {x: s.value("select pg_get_functiondef(%s::regprocedure)", [x]) for x in others} == others


def test_the_migration_refuses_an_eight_argument_function_that_is_not_its_own(conn, world):
    s = world.su
    become(s, None)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [NEW])
    changed = ddl.replace("begin\n", "begin\n  -- by hand\n", 1)
    assert changed != ddl
    s.conn.execute(changed)
    s.conn.execute(f"revoke all on function {NEW} from public, anon, authenticated, service_role")
    out = s.run(migration_body())
    assert not out.ok and "eight-argument request_series_plan() that is not 0122's body" in out.error, out
    assert s.value("select pg_get_functiondef(%s::regprocedure)", [NEW]) == changed


def with_0120_state(s):
    """The database as it was after 0120: 0122 taken off with its own rollback."""
    become(s, None)
    sec_db.take_off_0122(s)
    become(s, None)
    assert s.value("select to_regprocedure(%s)", [OLD]) is not None and s.value("select to_regprocedure(%s)", [NEW]) is None


def test_the_migration_applies_on_0120s_state_and_leaves_the_end_state_it_asserts(conn, world):
    s = world.su
    with_0120_state(s)
    s.conn.execute(migration_body())
    become(s, None)
    assert s.value("select to_regprocedure(%s)", [OLD]) is None and s.value("select to_regprocedure(%s)", [NEW]) is not None
    assert not any(s.value("select has_function_privilege(%s, %s::regprocedure, 'execute')", [r, NEW]) for r in ("anon", "authenticated", "service_role"))


@pytest.mark.parametrize("how", ["authenticated", "anon", "service_role", "public", "null_acl"])
def test_the_migration_refuses_to_drop_a_seven_argument_function_that_somebody_granted(conn, world, how):
    """A grant made by hand makes the drop a live change to a callable: a decision for a person, so the file stops and changes nothing."""
    s = world.su
    with_0120_state(s)
    if how == "null_acl":
        s.conn.execute("update pg_proc set proacl = null where oid = %s::regprocedure", [OLD])
    else:
        s.conn.execute(f"grant execute on function {OLD} to {how}")
    acl = s.value("select proacl::text from pg_proc where oid = %s::regprocedure", [OLD])
    out = s.run(migration_body())
    assert not out.ok and "executable by public or by an API role" in out.error, (how, out)
    become(s, None)
    assert s.value("select to_regprocedure(%s)", [OLD]) is not None, "the function is still there"
    assert s.value("select proacl::text from pg_proc where oid = %s::regprocedure", [OLD]) == acl
    assert s.value("select to_regprocedure(%s)", [NEW]) is None, "nothing of 0122 was created"
    assert s.value("select count(*) from pg_attribute where attrelid = 'public.series_plans'::regclass and attname = 'template_id' and not attisdropped") == 0


def test_the_end_state_rolls_the_whole_file_back_if_something_re_grants_the_new_function(conn, world):
    """The revoke runs before the drop; an event trigger that grants EXECUTE again when the old function is dropped (a platform default, a hand-made rule)
    must make the last block of the file raise, and the transaction must leave nothing of 0122 behind."""
    s = world.su
    with_0120_state(s)
    s.conn.execute("create function pg_temp.regrant() returns event_trigger language plpgsql as $f$ begin "
                   f"execute 'grant execute on function {NEW} to anon'; end $f$")
    s.conn.execute("create event trigger regrant_after_drop on ddl_command_end when tag in ('DROP FUNCTION') execute function pg_temp.regrant()")
    out = s.run(migration_body())
    assert not out.ok, out
    become(s, None)
    assert "0122 end state: request_series_plan() is executable by public or an API role" in out.error, out
    assert s.value("select to_regprocedure(%s)", [NEW]) is None and s.value("select to_regprocedure(%s)", [OLD]) is not None, "nothing of 0122 is left"


def test_the_migration_refuses_a_seven_argument_function_that_is_not_0120s_body(conn, world):
    s = world.su
    with_0120_state(s)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [OLD])
    changed = ddl.replace("begin\n", "begin\n  -- by hand\n", 1)
    s.conn.execute(changed)
    s.conn.execute(f"revoke all on function {OLD} from public, anon, authenticated, service_role")
    out = s.run(migration_body())
    assert not out.ok and "seven-argument request_series_plan() that is not 0120's body" in out.error, out
    become(s, None)
    assert s.value("select pg_get_functiondef(%s::regprocedure)", [OLD]) == changed


# ═══ 7. the rollback ══════════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_rollback_restores_0120_byte_for_byte_and_0122_applies_again(conn, sc):
    admin = sec_db.admin_dsn()
    base = f"ns_series_tpl_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    sigs = [*FOUR[:3], OLD]
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0122_", "0127_"))])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {x: (b.execute("select pg_get_functiondef(%s::regprocedure)", [x]).fetchone()[0],
                        b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [x]).fetchone()[0]) for x in sigs}
            fns = {r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
            cols = {r[0] for r in b.execute("select column_name from information_schema.columns where table_name = 'series_plans'")}
            cons = {r[0] for r in b.execute("select conname from pg_constraint where conrelid = 'public.series_plans'::regclass")}
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    with as_superuser(conn, commit=False) as su:
        sec_db.take_off_0127(su)   # 0127 sits on 0122's request_series_plan(); 0122's file and rollback refuse any other body
        def snapshot():
            return {x: (su.value("select pg_get_functiondef(%s::regprocedure)", [x]), su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [x]))
                    for x in (*FOUR[:3], NEW)}
        applied = snapshot()
        su.conn.execute(migration_body())
        assert snapshot() == applied, "a replay changes nothing"
        su.conn.execute(rollback_body())
        got = {x: (su.value("select pg_get_functiondef(%s::regprocedure)", [x]), su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [x])) for x in sigs}
        assert got == want, "0120's validator, guard, trigger function and seven-argument function are back, byte for byte, with their privileges"
        now = {r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
        assert now == fns, sorted(now ^ fns)
        assert {r[0] for r in su.rows("select column_name from information_schema.columns where table_name = 'series_plans'")} == cols
        assert {r[0] for r in su.rows("select conname from pg_constraint where conrelid = 'public.series_plans'::regclass")} == cons
        assert not any(su.value("select has_function_privilege(%s, %s::regprocedure, 'execute')", [r, OLD]) for r in ("anon", "authenticated", "service_role"))
        assert not su.value("select public.render_job_params_valid('{\"topic\": \"t\", \"niche\": \"n\", \"template\": \"myth_vs_fact\"}', 'series_plan')"), "the key is refused again"
        again = su.run(rollback_body())      # a second rollback finds 0120's bodies and refuses to "restore" what is not 0122's
        assert not again.ok and "is not 0122's body" in again.error, again
        su.conn.execute(migration_body())
        assert snapshot() == applied, "and 0122 applies again on top, to exactly what it was"


def test_the_rollback_refuses_while_a_plan_has_asked_for_a_format_and_changes_nothing(conn, world):
    s = world.su
    sec_db.take_off_0127(s)   # 0127 sits on 0122's request_series_plan(); 0122's file and rollback refuse any other body
    made(s, world.ed, world.chan_a, "myth_vs_fact")
    before = state(s)
    out = s.run(rollback_body())
    assert not out.ok and "a series plan asked for a format" in out.error, out
    assert state(s) == before
    assert s.value("select count(*) from pg_attribute where attrelid = 'public.series_plans'::regclass and attname = 'template_id' and not attisdropped") == 1


def test_the_rollback_refuses_while_a_queue_row_carries_a_format(conn, world):
    """No plan has a format, but a job does (put there by hand): the 0120 validator would refuse the row on its next update."""
    s = world.su
    sec_db.take_off_0127(s)   # 0127 sits on 0122's request_series_plan(); 0122's file and rollback refuse any other body
    plan = made(s, world.ed, world.chan_a)
    become(s, None)
    s.conn.execute("set local session_replication_role = replica")
    s.conn.execute("update public.render_jobs set params = params || '{\"template\": \"myth_vs_fact\"}' where id = %s", [plan["render_job_id"]])
    s.conn.execute("set local session_replication_role = origin")
    before = state(s)
    out = s.run(rollback_body())
    assert not out.ok and "a queue row carries a template param" in out.error, out
    assert state(s) == before


def test_the_rollback_with_no_format_anywhere_succeeds_and_the_plain_plans_stay(conn, world):
    s = world.su
    sec_db.take_off_0127(s)   # 0127 sits on 0122's request_series_plan(); 0122's file and rollback refuse any other body
    ready, _eps = ready_plan(s, world.ed, world.chan_a, topic="Kept")
    plain = made(s, world.ed, world.chan_a2)
    become(s, None)
    s.conn.execute(rollback_body())
    become(s, None)
    assert s.value("select count(*) from public.series_plans where id = any(%s::uuid[])", [[ready, plain["id"]]]) == 2, "the record stays"
    assert s.value("select to_regprocedure(%s)", [NEW]) is None and s.value("select to_regprocedure(%s)", [OLD]) is not None
    out = s.run("update public.render_jobs set status = 'running', started_at = now() where id = %s", [plain["render_job_id"]])
    assert out.ok, out
    for who in (world.ed, world.alice, ANON, SERVICE):
        become(s, who)
        assert denied(s.run("select public.request_series_plan(%s, %s, %s, %s, %s, %s, %s)", [world.chan_a, "t", 3, None, SECS, None, key()])), who.name
    # and the trigger function no longer names the column that is gone: a plan can still end
    assert finish(s, plain["id"]).ok


@pytest.mark.parametrize("sig,word", [("public.render_job_params_valid(jsonb,text)", "render_job_params_valid"),
                                     ("public.render_jobs_payment_guard()", "render_jobs_payment_guard"),
                                     ("public.series_plans_terms_frozen()", "series_plans_terms_frozen"),
                                     (NEW, "request_series_plan")])
def test_the_rollback_refuses_to_undo_a_later_change_to_any_of_the_four(conn, world, sig, word):
    s = world.su
    become(s, None)
    ddl = s.value("select pg_get_functiondef(%s::regprocedure)", [sig])
    changed = ddl.replace("begin\n", "begin\n  -- a later change, by hand\n", 1)
    assert changed != ddl
    s.conn.execute(changed)
    if sig == NEW:
        s.conn.execute(f"revoke all on function {NEW} from public, anon, authenticated, service_role")
    out = s.run(rollback_body())
    assert not out.ok and f"rollback 0122: {word}() is not 0122's body" in out.error, out
    assert s.value("select position('a later change' in pg_get_functiondef(%s::regprocedure)) > 0", [sig]), "nothing was restored over it"
    assert s.value("select count(*) from pg_attribute where attrelid = 'public.series_plans'::regclass and attname = 'template_id' and not attisdropped") == 1


# ═══ 8. a plan made under 0120 ════════════════════════════════════════════════════════════════════════════════════════════

def test_a_plan_made_before_the_migration_still_replays_and_its_job_is_still_valid_after_it(conn):
    """Build a database that stops at 0121, make a plan with 0120's seven-argument function, apply 0122, and press the same request again.

    The world is made by hand (one person, one organization, one channel) and NOT with build_scenario: that fills module-level registries that the
    other lab files read (folders, plans, tickets), and a second scenario would overwrite their ids and fail every file that runs after this one."""
    admin = sec_db.admin_dsn()
    name = f"ns_series_tpl_legacy_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.create_database(admin, name)
    try:
        sec_db.apply_files(dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0122_", "0127_"))])
        with psycopg.connect(dsn, autocommit=True) as c:
            who = sec_db.user("legacy-editor", "legacy@a.test")
            with as_superuser(c, commit=True) as su:
                su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
            with sec_db.acting(c, who, commit=True) as su:
                org = str(su.value("select public.create_organization(%s)", ["Legacy org"]))
            with as_superuser(c, commit=True) as su:
                su.rows("insert into public.channels (channel_id, name, niche, status, org_id) values ('chan-legacy', 'Legacy', 'tech', 'PAUSED', %s) returning 1", [org])
            alice = type("Alice", (), {"actor": who, "channel": "chan-legacy"})
            k = key()
            args = [alice.channel, "A plan made under 0120", 3, "Russian", 240, None, k]
            with as_superuser(c, commit=True) as su:
                become_claims(su, alice.actor)
                first = su.run("select public.request_series_plan(%s, %s, %s, %s, %s, %s, %s)", args)
                assert first.ok, first
                old = first.rows[0][0]
                become(su, None)
                assert su.value("select to_regprocedure(%s)", [OLD]) is not None
                legacy_hash = su.value("select request_hash from public.series_plans where id = %s", [old["id"]])
                (job,) = jobs_of_plan(su, old["id"])
            sec_db.apply_files(dsn, [MIGRATION])
            with as_superuser(c, commit=False) as su:
                become(su, None)
                assert su.value("select template_id from public.series_plans where id = %s", [old["id"]]) is None, "no row was rewritten"
                assert su.value("select request_hash from public.series_plans where id = %s", [old["id"]]) == legacy_hash
                for named in (False, True):
                    out = request_t(su, alice.actor, alice.channel, None, topic="A plan made under 0120", language="Russian", duration=240, idem=k, named=named)
                    assert out.ok and out.rows[0][0]["id"] == old["id"] and out.rows[0][0]["replayed"] is True, (named, out)
                out = request_t(su, alice.actor, alice.channel, "myth_vs_fact", topic="A plan made under 0120", language="Russian", duration=240, idem=k)
                assert refused(out, "NS409", "idempotency_conflict"), out
                become(su, None)
                for status in ("running", "succeeded"):
                    up = su.run("update public.render_jobs set status = %s, started_at = coalesce(started_at, now()), "
                                "finished_at = case when %s = 'succeeded' then now() end where id = %s", [status, status, job[0]])
                    assert up.ok, (status, up)
                assert finish(su, old["id"]).ok
                become(su, None)
                assert su.rows("select status, template_id from public.series_plans where id = %s", [old["id"]]) == [("ready", None)]
    finally:
        sec_db.drop_database(admin, name)
