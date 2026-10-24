"""Migration 0117 (Custom Voice): a user may clone THEIR OWN voice, and ONLY THAT USER may use it.

The attackers are the people a browser can be: another member of the same organization (even an administrator, even the
platform owner), a member of another organization, the anon key, and the service key where it should not reach. The behaviour that
must NOT change is checked beside every refusal: a voice that is in no voice_profiles row (the operator's own) is still accepted
at every entry point.

Everything runs on the shared scenario (conftest ``conn`` / ``sc``), inside transactions that are rolled back. Nothing calls a
provider: the worker is played by the test with the service role and a fake result.
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from modules import voice_profiles as pure  # noqa: E402

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0117_voice_profiles.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0117_voice_profiles.sql"

GOOD = {"own_voice": True, "sole_speaker": True, "over_18": True, "voice_data_to_provider": True,
        "no_impersonation": True}
TABLES = ["user_voice_refs", "voice_profiles", "voice_consents", "voice_deletion_records", "voice_clone_jobs",
          "voice_channel_attachments"]
SHA = "a" * 64


def vid() -> str:
    """A fresh provider voice id: 20 letters and digits."""
    return "V" + uuid.uuid4().hex[:19]


def become(s, who):
    """Continue the same transaction as another API caller (the database owner when who is None)."""
    s.conn.execute("reset role")
    if who is None:
        s.conn.execute("select set_config('request.jwt.claims', '', true)")
        return s
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def blocked(out, word=None):
    """Refused by the voice rule (SQLSTATE 42501, message 'voice_not_allowed')."""
    return (not out.ok and out.sqlstate == "42501" and "voice_not_allowed" in (out.error or "")
            and (word is None or word in out.error))


@pytest.fixture()
def world(conn, sc):
    """A rolled-back transaction with: ``vo`` (an administrator of org A, the voice owner), ``ed`` (an editor of org A who also
    owns voices), ``alice`` (the owner of org A, another person), ``bob`` (org B), ``helper`` (a platform administrator), the
    platform owner, and a second channel in org A. Returns a namespace."""
    with as_superuser(conn, commit=False) as su:
        w = type("World", (), {})()
        w.su, w.sc = su, sc
        for key, role in (("vo", "admin"), ("ed", "editor"), ("viewer", "viewer")):
            who = user(f"voice-{key}", f"voice-{key}@a.test")
            su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                    [who.uid, who.email])
            su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                    [sc.alice.org, who.uid, who.email, role])
            setattr(w, key, who)
        w.helper = user("voice-helper", "voice-helper@nightshift.test")
        su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
                [w.helper.uid, w.helper.email])
        su.rows("insert into public.app_members (user_id, email, role) values (%s, %s, 'admin') returning 1",
                [w.helper.uid, w.helper.email])
        w.alice, w.bob, w.operator, w.stranger = sc.alice.actor, sc.bob.actor, sc.operator, sc.stranger
        w.org_a, w.org_b = sc.alice.org, sc.bob.org
        w.chan_a, w.chan_b = sc.alice.channel, sc.bob.channel
        w.chan_a2 = "chan-a2"
        su.rows("insert into public.channels (channel_id, name, niche, status, org_id) "
                "values (%s, 'Second', 'tech', 'PAUSED', %s) returning 1", [w.chan_a2, w.org_a])
        # The payment guard (0041) wants a credit hold for a customer's run; this file is about the voice rule.
        su.conn.execute("alter table public.render_jobs disable trigger render_jobs_payment_guard")
        yield w


# ── building blocks: the owner's calls and the worker played by the test ──────────────────────────────────────────────────

def request(s, who, name="My own voice", *, keep=False, idem=None, org=None, decl=GOOD, version="v1"):
    become(s, who)
    return s.run("select public.request_voice_clone(%s, %s::jsonb, %s, %s, %s, %s)",
                 [name, json.dumps(decl), version, keep, idem or f"i-{uuid.uuid4().hex}", org])


def requested(s, who, **kw):
    out = request(s, who, **kw)
    assert out.ok, out
    return out.rows[0][0]


def upload(s, who, profile_id, ext="webm", owner_uid=None):
    become(s, who)
    return s.run("insert into storage.objects (bucket_id, name, owner) values ('voice-samples', %s, %s)",
                 [f"{owner_uid or who.uid}/{profile_id}/sample.{ext}", who.uid])


def claim(s, worker="w1"):
    become(s, SERVICE)
    return s.value("select public.claim_voice_job(%s)", [worker])


def finish(s, job, *, verification="passed", voice=None, worker="w1", sha=SHA, error=None, provider="elevenlabs"):
    become(s, SERVICE)
    return s.value("select public.finish_voice_clone(%s, %s, %s, %s, %s, %s, %s)",
                   [job["job_id"], worker, verification, provider, voice, sha, error])


def make_testing(s, who, *, keep=False, voice=None, **kw):
    """request -> upload -> worker claims -> worker finishes (passed): the profile is 'testing'."""
    r = requested(s, who, keep=keep, **kw)
    pid = r["profile_id"]
    assert upload(s, who, pid).ok
    job = claim(s)
    assert job and job["profile_id"] == pid, job
    voice = voice or vid()
    res = finish(s, job, voice=voice)
    assert res["ok"] and res["status"] == "testing", res
    return pid, voice


def tts_job(s, who, org, voice, *, status="completed", capability="tts", requested_by="who"):
    become(s, None)
    by = who.uid if requested_by == "who" else requested_by
    return s.run("insert into public.creative_jobs (org_id, capability, requested_model, routed_model, params, status, "
                 "quoted_credits, requested_by) values (%s, %s, 'm-x', 'm-x', %s::jsonb, %s, 0, %s) returning id",
                 [org, capability, json.dumps({"prompt": "hello", "voice_id": voice}), status, by])


def make_approved(s, who, org, **kw):
    pid, voice = make_testing(s, who, **kw)
    assert tts_job(s, who, org, voice).ok  # the owner's test: a completed Studio tts clip with this voice
    become(s, who)
    res = s.value("select public.approve_voice(%s)", [pid])
    assert res["ok"] and res["status"] == "approved", res
    return pid, voice


def run_job(s, channel, params=None, *, by=None, kind="daily"):
    become(s, None)
    return s.run("insert into public.render_jobs (channel_id, kind, params, requested_by) values (%s, %s, %s::jsonb, %s) returning id",
                 [channel, kind, json.dumps(params or {}), by.uid if by else None])


def set_cfg(s, who, channel, patch):
    become(s, who)
    return s.run("update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) || %s::jsonb "
                 "where channel_id = %s", [json.dumps(patch), channel])


def cfg(s, channel):
    become(s, None)
    return s.value("select agent_config from public.channels where channel_id = %s", [channel]) or {}


def attach(s, who, pid, channel, slot="narrator"):
    become(s, who)
    return s.run("select public.attach_voice_to_channel(%s, %s, %s)", [pid, channel, slot])


# ═══ 1. the traceable per-user reference ═══════════════════════════════════════════════════════════════════════════════════

def test_every_user_gets_one_random_reference_that_is_stable_and_unique(conn, sc, world):
    s = world.su
    become(s, world.vo)
    a = s.value("select public.my_voice_ref()")
    assert pure.is_owner_ref(a), a
    assert s.value("select public.my_voice_ref()") == a, "the reference is made once"
    become(s, world.ed)
    b = s.value("select public.my_voice_ref()")
    assert pure.is_owner_ref(b) and b != a
    become(s, None)
    refs = [r[0] for r in s.rows("select owner_ref from public.user_voice_refs")]
    assert len(refs) == len(set(refs)), "owner_ref is unique by constraint"
    assert str(world.vo.uid).replace("-", "") not in refs, "it never exposes the auth user id"


def test_the_reference_is_not_derived_from_the_user_id(conn, sc, world):
    s = world.su
    become(s, world.vo)
    ref = s.value("select public.my_voice_ref()")
    for candidate in (world.vo.uid, str(world.vo.uid).replace("-", "")):
        assert candidate not in ref
    # a second database would mint a different one for the same user id: it is random, not computed
    become(s, None)
    other = s.value("select replace(gen_random_uuid()::text, '-', '')")
    assert other != ref


def test_a_user_reads_only_their_own_reference_and_cannot_change_it(conn, sc, world):
    s = world.su
    become(s, world.vo)
    mine = s.value("select public.my_voice_ref()")
    become(s, world.ed)
    s.value("select public.my_voice_ref()")
    become(s, world.vo)
    assert [r[0] for r in s.rows("select owner_ref from public.user_voice_refs")] == [mine]
    out = s.run("update public.user_voice_refs set owner_ref = repeat('0', 32)")
    assert not out.ok and out.sqlstate == "42501", out
    become(s, None)
    out = s.run("update public.user_voice_refs set owner_ref = repeat('0', 32) where owner_ref = %s", [mine])
    assert not out.ok and "never changes" in out.error, "not even the database owner can rewrite a reference"


def test_the_backfill_gives_every_existing_user_a_reference_and_is_idempotent(conn, sc, world):
    s = world.su
    become(s, None)
    s.conn.execute("delete from public.user_voice_refs where user_id = %s", [world.viewer.uid])
    text = MIGRATION.read_text(encoding="utf-8")
    backfill = re.search(r"insert into public\.user_voice_refs \(user_id\)\s+select u\.id from auth\.users u\s+on conflict \(user_id\) do nothing;", text)
    assert backfill, "the backfill statement is in the migration"
    before = s.value("select count(*) from public.user_voice_refs")
    s.conn.execute(backfill.group(0))
    mid = s.value("select count(*) from public.user_voice_refs")
    assert mid == s.value("select count(*) from auth.users"), "every user has one"
    assert mid >= before
    keep = s.value("select owner_ref from public.user_voice_refs where user_id = %s", [world.vo.uid])
    s.conn.execute(backfill.group(0))
    assert s.value("select owner_ref from public.user_voice_refs where user_id = %s", [world.vo.uid]) == keep


def test_the_provider_voice_name_carries_the_reference(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    name = pure.provider_voice_name(r["owner_ref"], r["profile_id"])
    assert pure.parse_provider_voice_name(name) == (r["owner_ref"], r["profile_id"][:8])
    become(s, None)
    uid = s.value("select user_id from public.user_voice_refs where owner_ref = %s", [r["owner_ref"]])
    assert str(uid) == world.vo.uid, "a voice found in the provider account traces back to its user"


# ═══ 2. no direct writes, own rows only ════════════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("table", TABLES)
def test_no_api_role_can_write_any_voice_table(conn, sc, world, role, table):
    s = world.su
    who = {"anon": ANON, "authenticated": world.alice, "service_role": SERVICE}[role]
    become(s, who)
    col = {"user_voice_refs": "owner_ref", "voice_profiles": "name", "voice_consents": "kind", "voice_deletion_records": "event",
           "voice_clone_jobs": "status", "voice_channel_attachments": "status"}[table]
    for stmt in (f"insert into public.{table} default values", f"update public.{table} set {col} = {col}",
                 f"delete from public.{table}"):
        out = s.run(stmt)
        assert not out.ok and out.sqlstate == "42501", (role, table, stmt, out)
    out = s.run(f"truncate public.{table}")
    assert not out.ok and out.sqlstate == "42501", (role, table, out)


@pytest.mark.parametrize("table", ["voice_deletion_records", "voice_clone_jobs"])
def test_the_closed_tables_are_unreadable_by_every_api_role(conn, sc, world, table):
    s = world.su
    for who in (ANON, world.alice, SERVICE):
        become(s, who)
        out = s.run(f"select * from public.{table}")
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


@pytest.mark.parametrize("table", ["user_voice_refs", "voice_profiles", "voice_consents", "voice_channel_attachments"])
def test_a_person_reads_only_their_own_rows_and_nobody_else_does(conn, sc, world, table):
    s = world.su
    col = "user_id"
    become(s, world.alice)
    mine = s.rows(f"select {col} from public.{table}")
    assert mine and {str(r[0]) for r in mine} == {world.alice.uid}, "Alice has a seeded row and sees only hers"
    for who in (world.bob, world.vo, world.stranger, world.helper, world.operator):
        become(s, who)
        assert [r for r in s.rows(f"select {col} from public.{table}") if str(r[0]) == world.alice.uid] == [], who.name
    for who in (ANON, SERVICE):
        become(s, who)
        out = s.run(f"select * from public.{table}")
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_nobody_can_read_another_persons_consent_or_profile_even_by_id(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    for who in (world.alice, world.bob, world.ed, world.operator, world.helper):
        become(s, who)
        assert s.rows("select 1 from public.voice_profiles where id = %s", [r["profile_id"]]) == []
        assert s.rows("select 1 from public.voice_consents where voice_profile_id = %s", [r["profile_id"]]) == []


# ═══ 3. append-only consent ═══════════════════════════════════════════════════════════════════════════════════════════════

def test_the_consent_trail_is_append_only_for_everyone_including_the_database_owner(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    become(s, None)
    for stmt in ("update public.voice_consents set consent_text_version = 'v9'", "delete from public.voice_consents",
                 "truncate public.voice_consents"):
        out = s.run(stmt)
        assert not out.ok and out.sqlstate == "42501" and "append-only" in out.error, (stmt, out)
    assert s.value("select count(*) from public.voice_consents where voice_profile_id = %s", [r["profile_id"]]) == 1


def test_the_deletion_record_is_append_only_even_for_the_purge_setting(conn, sc, world):
    s = world.su
    become(s, None)
    s.conn.execute("select set_config('nightshift.voice_purge', 'on', true)")
    for stmt in ("update public.voice_deletion_records set event = 'purged'", "delete from public.voice_deletion_records"):
        out = s.run(stmt)
        assert not out.ok and out.sqlstate == "42501" and "append-only" in out.error, (stmt, out)


def test_an_api_role_cannot_use_the_purge_setting_even_with_the_table_privilege(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    become(s, None)
    s.conn.execute("grant delete on public.voice_consents, public.voice_profiles to service_role")  # rolled back with the test
    become(s, SERVICE)
    s.conn.execute("select set_config('nightshift.voice_purge', 'on', true)")
    for stmt in ("delete from public.voice_consents", "delete from public.voice_profiles"):
        out = s.run(stmt)
        assert not out.ok and out.sqlstate == "42501", (stmt, out)
    become(s, None)
    assert s.value("select count(*) from public.voice_profiles where id = %s", [r["profile_id"]]) == 1


def test_a_verification_result_is_a_new_row_not_an_update(conn, sc, world):
    s = world.su
    pid, voice = make_testing(s, world.vo)
    become(s, None)
    rows = s.rows("select kind, verification_result from public.voice_consents where voice_profile_id = %s order by accepted_at, kind", [pid])
    assert [tuple(r) for r in rows] == [("accepted", "pending"), ("verification", "passed")]


# ═══ 4. request_voice_clone ═══════════════════════════════════════════════════════════════════════════════════════════════

def test_a_request_writes_a_profile_a_consent_and_a_queue_row_and_stops(conn, sc, world):
    s = world.su
    r = requested(s, world.vo, keep=True)
    assert r["status"] == "pending_verification" and r["replay"] is False
    assert r["upload_prefix"] == f"{world.vo.uid}/{r['profile_id']}/"
    words = r["phrase"].split()
    assert len(words) == 6 and len(set(words)) == 6 and set(words) <= set(pure.PHRASE_WORDS)
    become(s, None)
    p = s.rows("select status, provider, provider_voice_id, keep_sample, sample_state, org_id, owner_ref, user_id "
               "from public.voice_profiles where id = %s", [r["profile_id"]])[0]
    assert (p[0], p[1], p[2], p[3], p[4]) == ("pending_verification", None, None, True, "awaiting")
    assert str(p[5]) == world.org_a and p[6] == r["owner_ref"] and str(p[7]) == world.vo.uid
    c = s.rows("select kind, consent_text_version, verification_result, verification_phrase_hash, declarations "
               "from public.voice_consents where voice_profile_id = %s", [r["profile_id"]])
    assert len(c) == 1 and c[0][0] == "accepted" and c[0][1] == "v1" and c[0][2] == "pending"
    assert c[0][3] == pure.hash_phrase(r["phrase"]), "the stored hash is the Python hash of the phrase it issued"
    assert c[0][4] == GOOD
    j = s.rows("select kind, status, phrase from public.voice_clone_jobs where profile_id = %s", [r["profile_id"]])
    assert [tuple(x) for x in j] == [("clone", "queued", r["phrase"])]
    assert s.value("select count(*) from public.app_audit_log where action = 'voice.clone_request' and target = %s", [r["profile_id"]]) == 1


def test_each_request_gets_its_own_unpredictable_phrase(conn, sc, world):
    s = world.su
    phrases = set()
    for _ in range(3):
        r = requested(s, world.vo)
        phrases.add(r["phrase"])
        become(s, world.vo)
        s.value("select public.delete_voice(%s)", [r["profile_id"]])
    assert len(phrases) == 3


@pytest.mark.parametrize("name", ["", "x", "a" * 61, "Morgan Freeman voice of", "sounds like Elvis", "My voice sounds-like Obama",
                                  "voice of the president", "http://x.io", "name@mail", "12345", "<b>x</b>", "Deepfake Dave",
                                  "голос как у Путина", "Ovozi kabi mashhur"])
def test_a_name_that_reads_as_a_real_person_or_is_malformed_is_refused(conn, sc, world, name):
    out = request(world.su, world.vo, name=name)
    assert not out.ok and out.sqlstate == "22023" and "voice_request" in out.error, (name, out)


@pytest.mark.parametrize("decl", [{}, {**GOOD, "over_18": False}, {**GOOD, "extra": True}, {**{k: v for k, v in GOOD.items() if k != "own_voice"}},
                                  {**GOOD, "sole_speaker": "true"}, [], "x"])
def test_every_declaration_must_be_made_and_nothing_else_is_accepted(conn, sc, world, decl):
    out = request(world.su, world.vo, decl=decl)
    assert not out.ok and out.sqlstate == "22023", (decl, out)


@pytest.mark.parametrize("version", ["", "1", "v", "v1234", "V1", "v1; drop"])
def test_a_consent_version_has_a_fixed_shape(conn, sc, world, version):
    out = request(world.su, world.vo, version=version)
    assert not out.ok and out.sqlstate == "22023", (version, out)


def test_an_idempotency_key_is_required(conn, sc, world):
    s = world.su
    become(s, world.vo)
    out = s.run("select public.request_voice_clone('My voice', %s::jsonb, 'v1', false, null)", [json.dumps(GOOD)])
    assert not out.ok and out.sqlstate == "22023", out
    out = s.run("select public.request_voice_clone('My voice', %s::jsonb, 'v1', false, 'bad key!')", [json.dumps(GOOD)])
    assert not out.ok and out.sqlstate == "22023", out


def test_a_replay_returns_the_same_profile_and_creates_nothing(conn, sc, world):
    s = world.su
    first = requested(s, world.vo, idem="same-key")
    again = requested(s, world.vo, idem="same-key")
    assert again["replay"] is True and again["profile_id"] == first["profile_id"] and again["phrase"] == first["phrase"]
    become(s, None)
    assert s.value("select count(*) from public.voice_profiles where user_id = %s and idempotency_key = 'same-key'", [world.vo.uid]) == 1
    assert s.value("select count(*) from public.voice_clone_jobs where profile_id = %s", [first["profile_id"]]) == 1


def test_the_same_key_for_a_different_request_is_a_conflict(conn, sc, world):
    s = world.su
    requested(s, world.vo, idem="k1", name="First voice")
    out = request(s, world.vo, idem="k1", name="Other voice")
    assert not out.ok and out.sqlstate == "NS409", out
    out = request(s, world.vo, idem="k1", name="First voice", keep=True)
    assert not out.ok and out.sqlstate == "NS409", "the keep_sample choice is part of the request"


def test_two_people_may_use_the_same_key(conn, sc, world):
    s = world.su
    a = requested(s, world.vo, idem="shared")
    b = requested(s, world.ed, idem="shared")
    assert a["profile_id"] != b["profile_id"]


def test_at_most_three_live_voices_per_person(conn, sc, world):
    s = world.su
    for _ in range(3):
        requested(s, world.vo)
    out = request(s, world.vo)
    assert not out.ok and out.sqlstate == "NS429" and "at most 3" in out.error, out
    requested(s, world.ed)  # another person is not affected


def test_at_most_five_requests_per_person_per_day_even_when_voices_are_deleted(conn, sc, world):
    s = world.su
    for _ in range(5):
        r = requested(s, world.vo)
        become(s, world.vo)
        s.value("select public.delete_voice(%s)", [r["profile_id"]])
    out = request(s, world.vo)
    assert not out.ok and out.sqlstate == "NS429" and "a day" in out.error, out
    requested(s, world.ed)  # another person is not affected


def test_the_daily_window_rolls(conn, sc, world):
    s = world.su
    for _ in range(5):
        r = requested(s, world.vo)
        become(s, world.vo)
        s.value("select public.delete_voice(%s)", [r["profile_id"]])
    become(s, None)
    s.conn.execute("alter table public.voice_profiles disable trigger voice_profiles_guard")
    s.conn.execute("update public.voice_profiles set created_at = now() - interval '25 hours' where user_id = %s", [world.vo.uid])
    s.conn.execute("alter table public.voice_profiles enable trigger voice_profiles_guard")
    assert request(s, world.vo).ok


@pytest.mark.parametrize("who", ["viewer", "stranger"])
def test_only_an_editor_of_an_organization_can_request(conn, sc, world, who):
    out = request(world.su, getattr(world, who))
    assert not out.ok and out.sqlstate in ("42501", "22023"), out


def test_a_member_of_another_organization_cannot_request_in_this_one(conn, sc, world):
    out = request(world.su, world.bob, org=world.org_a)
    assert not out.ok and out.sqlstate == "42501", out


def test_a_platform_administrator_is_not_a_member_of_a_customers_organization_for_this(conn, sc, world):
    out = request(world.su, world.operator, org=world.org_a)
    assert not out.ok and out.sqlstate == "42501", out


def test_anon_and_the_service_key_cannot_request(conn, sc, world):
    for who in (ANON, SERVICE):
        out = request(world.su, who)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


# ═══ 5. the worker ════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_a_clone_job_is_not_handed_out_until_the_sample_exists(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    assert claim(s) is None, "no object, no work"
    assert upload(s, world.vo, r["profile_id"]).ok
    job = claim(s)
    assert job["kind"] == "clone" and job["profile_id"] == r["profile_id"] and job["phrase"] == r["phrase"]
    assert job["owner_ref"] == r["owner_ref"] and job["sample_path"] == f"{world.vo.uid}/{r['profile_id']}/sample.webm"
    assert claim(s) is None, "a running job is not handed out twice"


def test_the_worker_functions_are_for_the_service_role_only(conn, sc, world):
    s = world.su
    calls = ["select public.claim_voice_job('w')",
             f"select public.finish_voice_clone('{uuid.uuid4()}', 'w', 'passed', 'elevenlabs', '{vid()}', '{SHA}', null)",
             f"select public.finish_voice_task('{uuid.uuid4()}', 'w', true, null)",
             f"select public.purge_voice_records('{uuid.uuid4()}')"]
    for who in (ANON, world.alice, world.operator, world.helper):
        for q in calls:
            become(s, who)
            out = s.run(q)
            assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
    become(s, SERVICE)
    for q in calls:
        assert s.run(q).ok, q


def test_a_passed_clone_makes_the_profile_testing_and_queues_the_purge_of_the_sample(conn, sc, world):
    s = world.su
    pid, voice = make_testing(s, world.vo, keep=False)
    become(s, None)
    p = s.rows("select status, provider, provider_voice_id, sample_sha256, sample_state from public.voice_profiles where id = %s", [pid])[0]
    assert tuple(p) == ("testing", "elevenlabs", voice, SHA, "purge_pending")
    kinds = {r[0] for r in s.rows("select kind from public.voice_clone_jobs where profile_id = %s and status in ('queued','running')", [pid])}
    assert kinds == {"purge_sample"}
    assert s.value("select verification_result from public.voice_consents where voice_profile_id = %s and kind = 'verification'", [pid]) == "passed"


def test_a_kept_sample_is_not_purged_until_the_owner_says_so(conn, sc, world):
    s = world.su
    pid, _ = make_testing(s, world.vo, keep=True)
    become(s, None)
    assert s.value("select sample_state from public.voice_profiles where id = %s", [pid]) == "stored"
    assert s.rows("select 1 from public.voice_clone_jobs where profile_id = %s and kind = 'purge_sample'", [pid]) == []
    become(s, world.vo)
    out = s.value("select public.delete_voice_sample(%s)", [pid])
    assert out["ok"] and out["already"] is False
    become(s, None)
    assert s.value("select sample_state from public.voice_profiles where id = %s", [pid]) == "purge_pending"
    assert len(s.rows("select 1 from public.voice_clone_jobs where profile_id = %s and kind = 'purge_sample' and status = 'queued'", [pid])) == 1
    become(s, world.vo)
    s.value("select public.delete_voice_sample(%s)", [pid])  # a second press queues nothing new
    become(s, None)
    assert len(s.rows("select 1 from public.voice_clone_jobs where profile_id = %s and kind = 'purge_sample'", [pid])) == 1


def test_a_failed_verification_rejects_the_profile_and_purges_the_sample(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    upload(s, world.vo, r["profile_id"])
    job = claim(s)
    res = finish(s, job, verification="failed")
    assert res == {"ok": True, "status": "rejected"}
    become(s, None)
    p = s.rows("select status, reject_reason, sample_state, provider_voice_id from public.voice_profiles where id = %s", [r["profile_id"]])[0]
    assert tuple(p) == ("rejected", "verification_failed", "purge_pending", None)
    assert s.value("select verification_result from public.voice_consents where voice_profile_id = %s and kind = 'verification'", [r["profile_id"]]) == "failed"
    assert s.value("select count(*) from public.voice_clone_jobs where profile_id = %s and kind = 'purge_sample'", [r["profile_id"]]) == 1


def test_only_the_worker_that_holds_the_job_can_finish_it(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    upload(s, world.vo, r["profile_id"])
    job = claim(s, "w1")
    assert finish(s, job, voice=vid(), worker="w2") == {"ok": False, "error": "not_holder"}
    assert finish(s, job, voice=vid(), worker="w1")["ok"]
    assert finish(s, job, voice=vid(), worker="w1") == {"ok": False, "error": "not_holder"}, "a finished job cannot be finished again"


@pytest.mark.parametrize("voice,provider,sha,err", [("short", "elevenlabs", SHA, "bad_voice"), ("x" * 21, "elevenlabs", SHA, "bad_voice"),
                                                    ("V" + "a" * 19, "openai", SHA, "bad_voice"), ("V" + "a" * 19, "elevenlabs", "zz", "bad_sample_hash"),
                                                    (None, "elevenlabs", SHA, "bad_voice")])
def test_a_worker_result_with_a_bad_shape_is_refused(conn, sc, world, voice, provider, sha, err):
    s = world.su
    r = requested(s, world.vo)
    upload(s, world.vo, r["profile_id"])
    job = claim(s)
    assert finish(s, job, voice=voice, provider=provider, sha=sha) == {"ok": False, "error": err}


def test_one_provider_voice_id_belongs_to_one_profile(conn, sc, world):
    s = world.su
    _, voice = make_testing(s, world.vo, keep=True)  # keep: no purge job is queued ahead of the next clone job
    r = requested(s, world.ed)
    upload(s, world.ed, r["profile_id"])
    job = claim(s)
    assert job["profile_id"] == r["profile_id"]
    assert finish(s, job, voice=voice) == {"ok": False, "error": "voice_id_taken"}
    become(s, None)
    out = s.run("update public.voice_profiles set provider = 'elevenlabs', provider_voice_id = %s where id = %s", [voice, r["profile_id"]])
    assert not out.ok and out.sqlstate == "23505", out


def test_a_transient_failure_goes_back_in_the_queue_until_the_attempts_are_spent(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    upload(s, world.vo, r["profile_id"])
    for attempt in (1, 2):
        job = claim(s)
        assert job["attempts"] == attempt
        assert finish(s, job, error="transient") == {"ok": True, "retry": True}
    job = claim(s)
    assert job["attempts"] == 3
    assert finish(s, job, error="transient") == {"ok": True, "status": "rejected"}
    become(s, None)
    assert s.value("select reject_reason from public.voice_profiles where id = %s", [r["profile_id"]]) == "transient"


def test_a_voice_deleted_while_it_was_being_made_is_deleted_at_the_provider_too(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    upload(s, world.vo, r["profile_id"])
    job = claim(s)
    become(s, world.vo)
    s.value("select public.delete_voice(%s)", [r["profile_id"]])
    voice = vid()
    res = finish(s, job, voice=voice)
    assert res["ok"] and res["status"] == "deleted"
    become(s, None)
    assert s.value("select status from public.voice_profiles where id = %s", [r["profile_id"]]) == "deleted"
    assert s.value("select count(*) from public.voice_clone_jobs where profile_id = %s and kind = 'delete_provider' and status = 'queued'", [r["profile_id"]]) == 1
    assert run_job(s, world.chan_a, {"voice_id": voice}, by=world.vo).ok is False


def test_a_request_nobody_uploaded_a_sample_for_lapses(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    become(s, None)
    s.conn.execute("update public.voice_clone_jobs set created_at = now() - interval '3 hours' where profile_id = %s", [r["profile_id"]])
    assert claim(s) is None
    become(s, None)
    p = s.rows("select status, reject_reason from public.voice_profiles where id = %s", [r["profile_id"]])[0]
    assert tuple(p) == ("rejected", "sample_timeout")
    assert s.value("select status from public.voice_clone_jobs where profile_id = %s", [r["profile_id"]]) == "expired"


def test_a_lost_worker_gives_the_job_back_and_then_fails_it(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    upload(s, world.vo, r["profile_id"])
    for n in (1, 2, 3):
        job = claim(s, f"w{n}")
        assert job and job["attempts"] == n
        become(s, None)
        s.conn.execute("update public.voice_clone_jobs set heartbeat_at = now() - interval '1 hour' where id = %s", [job["job_id"]])
    assert claim(s) is None
    become(s, None)
    assert s.value("select status from public.voice_profiles where id = %s", [r["profile_id"]]) == "rejected"


# ═══ 6. approve ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

def test_approval_needs_a_test_and_the_owner(conn, sc, world):
    s = world.su
    pid, voice = make_testing(s, world.vo)
    become(s, world.vo)
    assert s.value("select public.approve_voice(%s)", [pid]) == {"ok": False, "error": "not_tested"}
    for who in (world.alice, world.bob, world.helper, world.operator, world.ed):
        become(s, who)
        out = s.run("select public.approve_voice(%s)", [pid])
        assert not out.ok and out.sqlstate == "P0002", (who.name, out)
    # someone else's clip with this voice is not the owner's test, and an unfinished one is not a test
    assert tts_job(s, world.vo, world.org_a, voice, status="queued").ok
    become(s, world.vo)
    assert s.value("select public.approve_voice(%s)", [pid]) == {"ok": False, "error": "not_tested"}
    assert tts_job(s, world.vo, world.org_a, voice).ok
    become(s, world.vo)
    res = s.value("select public.approve_voice(%s)", [pid])
    assert res == {"ok": True, "already": False, "status": "approved"}
    assert s.value("select public.approve_voice(%s)", [pid])["already"] is True
    become(s, None)
    assert s.value("select approved_at is not null from public.voice_profiles where id = %s", [pid])
    assert s.value("select count(*) from public.app_audit_log where action = 'voice.approve' and target = %s", [pid]) == 1


def test_a_clip_made_with_another_voice_or_before_the_request_is_not_the_test(conn, sc, world):
    s = world.su
    pid, voice = make_testing(s, world.vo)
    assert tts_job(s, world.vo, world.org_a, "pNInz6obpgDQGcFmaJgB").ok  # a completed clip, but with a different voice
    become(s, world.vo)
    assert s.value("select public.approve_voice(%s)", [pid]) == {"ok": False, "error": "not_tested"}
    become(s, None)
    s.conn.execute("alter table public.voice_profiles disable trigger voice_profiles_guard")
    s.conn.execute("update public.voice_profiles set created_at = now() + interval '1 hour' where id = %s", [pid])
    s.conn.execute("alter table public.voice_profiles enable trigger voice_profiles_guard")
    assert tts_job(s, world.vo, world.org_a, voice).ok  # completed, but before the (moved) request time
    become(s, world.vo)
    assert s.value("select public.approve_voice(%s)", [pid]) == {"ok": False, "error": "not_tested"}


def test_a_voice_that_is_not_testing_cannot_be_approved(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    become(s, world.vo)
    assert s.value("select public.approve_voice(%s)", [r["profile_id"]]) == {"ok": False, "error": "not_testing"}
    pid, _ = make_testing(s, world.ed)
    become(s, world.ed)
    s.value("select public.delete_voice(%s)", [pid])
    assert s.value("select public.approve_voice(%s)", [pid]) == {"ok": False, "error": "not_testing"}


# ═══ 7. OWNERSHIP ENFORCEMENT — entry point 1: creative_jobs (tts and voice_change) ════════════════════════════════════════

@pytest.mark.parametrize("capability", ["tts", "voice_change"])
def test_creative_job_another_person_cannot_use_an_approved_voice(conn, sc, world, capability):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    for who in (world.alice, world.ed, world.bob, world.helper, world.operator):
        out = tts_job(s, who, world.org_a if who is not world.bob else world.org_b, voice, capability=capability, status="queued")
        assert blocked(out), (who.name, capability, out)
    assert blocked(tts_job(s, None, world.org_a, voice, capability=capability, status="queued", requested_by=None)), \
        "a job with no person behind it is not the owner's"


@pytest.mark.parametrize("capability", ["tts", "voice_change"])
def test_creative_job_the_owner_can_use_an_approved_voice(conn, sc, world, capability):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert tts_job(s, world.vo, world.org_a, voice, capability=capability, status="queued").ok


def test_creative_job_a_voice_in_testing_is_for_the_owners_tts_test_only(conn, sc, world):
    s = world.su
    pid, voice = make_testing(s, world.vo)
    assert tts_job(s, world.vo, world.org_a, voice, capability="tts", status="queued").ok, "the owner's own test"
    assert blocked(tts_job(s, world.vo, world.org_a, voice, capability="voice_change", status="queued")), "not a real use yet"
    assert blocked(tts_job(s, world.ed, world.org_a, voice, capability="tts", status="queued")), "nobody else's test"


@pytest.mark.parametrize("how", ["deleted", "pending", "rejected"])
def test_creative_job_a_deleted_pending_or_rejected_voice_is_unusable_even_by_its_owner(conn, sc, world, how):
    s = world.su
    if how == "deleted":
        pid, voice = make_approved(s, world.vo, world.org_a)
        become(s, world.vo)
        s.value("select public.delete_voice(%s)", [pid])
    elif how == "rejected":
        r = requested(s, world.vo)
        upload(s, world.vo, r["profile_id"])
        job = claim(s)
        finish(s, job, verification="failed")
        voice = vid()
        become(s, None)
        # give the rejected row a voice to aim at (the database owner may; no function ever does)
        s.conn.execute("update public.voice_profiles set provider = 'elevenlabs', provider_voice_id = %s where id = %s", [voice, r["profile_id"]])
    else:
        r = requested(s, world.vo)
        voice = vid()
        become(s, None)
        s.conn.execute("update public.voice_profiles set provider = 'elevenlabs', provider_voice_id = %s where id = %s", [voice, r["profile_id"]])
    for capability in ("tts", "voice_change"):
        assert blocked(tts_job(s, world.vo, world.org_a, voice, capability=capability, status="queued")), (how, capability)


def test_creative_job_a_voice_that_is_in_no_profile_is_still_accepted_by_everyone(conn, sc, world):
    s = world.su
    premade = "pNInz6obpgDQGcFmaJgB"
    for who, org in ((world.vo, world.org_a), (world.bob, world.org_b), (world.operator, world.org_a)):
        for capability in ("tts", "voice_change"):
            assert tts_job(s, who, org, premade, capability=capability, status="queued").ok, (who.name, capability)
    assert tts_job(s, world.vo, world.org_a, "short-id_1", capability="tts", status="queued").ok, "tts shapes are the old rules"


def test_creative_job_a_recased_or_padded_copy_of_the_id_is_the_same_voice(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    for variant in (voice.upper(), " " + voice, voice + "\n", " " + voice + "　"):
        assert blocked(tts_job(s, world.ed, world.org_a, variant, status="queued")), repr(variant)


def test_creative_job_the_service_role_and_the_api_functions_pass_through_the_same_trigger(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, None)
    # even the database owner inserting directly is held to it: the trigger is on the table, not on a caller
    out = s.run("insert into public.creative_jobs (org_id, capability, requested_model, params, requested_by) "
                "values (%s, 'tts', 'm-x', %s::jsonb, %s)", [world.org_a, json.dumps({"prompt": "x", "voice_id": voice}), world.ed.uid])
    assert blocked(out), out


# ═══ 8. entry point 2: render_jobs ═══════════════════════════════════════════════════════════════════════════════════════

def test_run_the_voice_chosen_for_one_run_is_the_owners_only(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    for who in (world.alice, world.ed, world.bob, world.helper, None):
        assert blocked(run_job(s, world.chan_a, {"voice_id": voice}, by=who)), getattr(who, "name", None)
    assert run_job(s, world.chan_a, {"voice_id": voice}, by=world.vo).ok


def test_run_a_voice_in_testing_is_not_usable_in_a_run_even_by_its_owner(conn, sc, world):
    s = world.su
    pid, voice = make_testing(s, world.vo)
    assert blocked(run_job(s, world.chan_a, {"voice_id": voice}, by=world.vo))


def test_run_a_deleted_voice_is_unusable_even_by_its_owner(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, world.vo)
    s.value("select public.delete_voice(%s)", [pid])
    assert blocked(run_job(s, world.chan_a, {"voice_id": voice}, by=world.vo))


def test_run_a_voice_that_is_in_no_profile_is_accepted_as_before(conn, sc, world):
    s = world.su
    for who in (world.vo, world.alice, None):
        assert run_job(s, world.chan_a, {"voice_id": "pNInz6obpgDQGcFmaJgB"}, by=who).ok
        assert run_job(s, world.chan_a, {}, by=who).ok


def test_run_the_channels_configured_voice_must_be_attached_to_it(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    # a custom voice cannot be put in the config unattached (entry point 3); put it there as the owner of the database to test the run
    become(s, None)
    s.conn.execute("alter table public.channels disable trigger channels_config_guard")
    s.conn.execute("update public.channels set agent_config = agent_config || %s::jsonb where channel_id = %s",
                   [json.dumps({"elevenlabs_voice_id": voice}), world.chan_a])
    s.conn.execute("alter table public.channels enable trigger channels_config_guard")
    out = run_job(s, world.chan_a, {}, by=world.ed)
    assert blocked(out), out
    res = attach(s, world.vo, pid, world.chan_a)
    assert res.ok and res.rows[0][0]["ok"], res
    assert run_job(s, world.chan_a, {}, by=world.ed).ok, "attached: any member who may run the channel may run it"
    # detached: the run is refused again, before it spends anything
    become(s, world.vo)
    s.value("select public.detach_voice_from_channel(%s, %s)", [pid, world.chan_a])
    assert blocked(run_job(s, world.chan_a, {}, by=world.ed))


def test_run_the_secondary_voice_is_held_to_the_same_rule_and_its_own_slot(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert attach(s, world.vo, pid, world.chan_a, "secondary").rows[0][0]["ok"]
    assert run_job(s, world.chan_a, {}, by=world.ed).ok
    # the narrator slot was never granted for this voice
    out = set_cfg(s, world.ed, world.chan_a, {"elevenlabs_voice_id": voice})
    assert blocked(out), "attached as secondary only"


def test_run_a_repair_does_not_need_the_voice(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, None)
    s.conn.execute("alter table public.channels disable trigger channels_config_guard")
    s.conn.execute("update public.channels set agent_config = agent_config || %s::jsonb where channel_id = %s",
                   [json.dumps({"elevenlabs_voice_id": voice}), world.chan_a])
    s.conn.execute("alter table public.channels enable trigger channels_config_guard")
    become(s, None)
    out = s.run("insert into public.render_jobs (channel_id, kind, params, requested_by) values (%s, 'repair', %s::jsonb, %s) returning id",
                [world.chan_a, json.dumps({"repair_scenes": "s1", "topic": "t"}), world.ed.uid])
    assert out.ok, out
    assert blocked(run_job(s, world.chan_a, {}, by=world.ed)), "a daily run still is"


def test_run_the_owner_leaving_the_organization_ends_the_attachment(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert attach(s, world.vo, pid, world.chan_a).rows[0][0]["ok"]
    assert run_job(s, world.chan_a, {}, by=world.ed).ok
    become(s, None)
    s.conn.execute("delete from public.org_members where org_id = %s and user_id = %s", [world.org_a, world.vo.uid])
    assert blocked(run_job(s, world.chan_a, {}, by=world.ed)), "the owner is no longer an administrator of this organization"


def test_run_the_owner_demoted_below_administrator_ends_the_attachment(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert attach(s, world.vo, pid, world.chan_a).rows[0][0]["ok"]
    become(s, None)
    s.conn.execute("update public.org_members set role = 'editor' where org_id = %s and user_id = %s", [world.org_a, world.vo.uid])
    assert blocked(run_job(s, world.chan_a, {}, by=world.ed))


def test_run_a_channel_moved_to_another_organization_loses_the_attachment(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert attach(s, world.vo, pid, world.chan_a).rows[0][0]["ok"]
    become(s, None)
    s.conn.execute("update public.channels set org_id = %s where channel_id = %s", [world.org_b, world.chan_a])
    assert blocked(run_job(s, world.chan_a, {}, by=world.bob)), "the owner attached it in another organization"


# ═══ 9. entry point 3: the channels guard ════════════════════════════════════════════════════════════════════════════════

KEYS = ["elevenlabs_voice_id", "elevenlabs_secondary_voice_id"]


@pytest.mark.parametrize("key", KEYS)
@pytest.mark.parametrize("writer", ["vo", "ed", "alice", "service", "owner_of_db"])
def test_channel_config_a_custom_voice_cannot_be_set_by_anyone_who_did_not_attach_it(conn, sc, world, key, writer):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    who = {"vo": world.vo, "ed": world.ed, "alice": world.alice, "service": SERVICE, "owner_of_db": None}[writer]
    out = set_cfg(s, who, world.chan_a, {key: voice})
    assert blocked(out, key), (writer, out)
    assert cfg(s, world.chan_a).get(key) != voice, "the refused write left nothing behind"


def test_channel_config_a_voice_that_is_in_no_profile_is_set_exactly_as_before(conn, sc, world):
    s = world.su
    for who in (world.ed, world.alice, SERVICE, None):
        for key in KEYS:
            out = set_cfg(s, who, world.chan_a, {key: "pNInz6obpgDQGcFmaJgB"})
            assert out.ok, (getattr(who, "name", None), key, out)
            assert cfg(s, world.chan_a)[key] == "pNInz6obpgDQGcFmaJgB", (getattr(who, "name", None), key)
            set_cfg(s, None, world.chan_a, {key: "AbCdEfGhIjKlMnOpQrSt"})


@pytest.mark.parametrize("variant", [str.upper, lambda v: f" {v} ", lambda v: v + "\t", lambda v: " " + v])
def test_channel_config_a_padded_or_recased_copy_is_the_same_voice(conn, sc, world, variant):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert blocked(set_cfg(s, world.ed, world.chan_a, {"elevenlabs_secondary_voice_id": variant(voice)}))


def test_channel_config_whole_blob_replacement_and_jsonb_set_are_not_ways_round(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, world.ed)
    for stmt in ("update public.channels set agent_config = %s::jsonb where channel_id = %s",
                 "update public.channels set agent_config = jsonb_set(coalesce(agent_config, '{}'::jsonb), '{elevenlabs_voice_id}', to_jsonb(%s::text)) where channel_id = %s"):
        arg = json.dumps({"elevenlabs_voice_id": voice}) if "jsonb where" in stmt and "jsonb_set" not in stmt else voice
        assert blocked(s.run(stmt, [arg, world.chan_a])), stmt


def test_channel_config_set_channel_dna_and_create_channel_are_held_to_it(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, world.ed)
    out = s.run("select public.set_channel_dna(%s, null, null, %s, null, null, null, null)", [world.chan_a, voice])
    assert blocked(out), "set_channel_dna is a definer function: the trigger is on the table, so it sees it"
    out = s.run("select public.set_channel_dna(%s, null, null, %s, null, null, null, null)", [world.chan_a, "pNInz6obpgDQGcFmaJgB"])
    assert out.ok, out
    out = s.run("select public.create_channel('voice-new-1', %s, 'N', 'x', %s::jsonb, '{}'::jsonb, null, false)",
                [world.org_a, json.dumps({"elevenlabs_secondary_voice_id": voice})])
    assert blocked(out), out
    out = s.run("select public.create_channel('voice-new-2', %s, 'N', 'x', %s::jsonb, '{}'::jsonb, null, false)",
                [world.org_a, json.dumps({"elevenlabs_voice_id": "pNInz6obpgDQGcFmaJgB"})])
    assert out.ok, out


def test_channel_config_an_unchanged_voice_does_not_block_an_unrelated_edit(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert attach(s, world.vo, pid, world.chan_a).rows[0][0]["ok"]
    become(s, world.vo)
    s.value("select public.delete_voice(%s)", [pid])
    out = set_cfg(s, world.ed, world.chan_a, {"language": "Russian"})
    assert out.ok and out.rowcount == 1, "the voice id is still in the config; the edit does not touch it"
    assert blocked(run_job(s, world.chan_a, {}, by=world.ed)), "but a run on it is refused"
    assert set_cfg(s, world.ed, world.chan_a, {"elevenlabs_voice_id": "pNInz6obpgDQGcFmaJgB"}).ok, "and the voice can be replaced"


def test_channel_config_the_0114_lock_is_untouched(conn, sc, world):
    s = world.su
    out = set_cfg(s, world.alice, world.chan_a, {"ai_disclosure_voice": "own_clone"})
    assert not out.ok and out.sqlstate == "42501" and "ai_disclosure_lock" in out.error, out
    out = set_cfg(s, world.alice, world.chan_a, {"ai_disclosure": "never"})
    assert not out.ok and "ai_disclosure_lock" in out.error, out
    assert set_cfg(s, world.helper, world.chan_a, {"ai_disclosure_voice": "own_clone"}).ok, "a platform administrator still may"


# ═══ 10. attach / detach ════════════════════════════════════════════════════════════════════════════════════════════════

def test_attach_writes_the_channel_the_label_and_the_audit_row(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    out = attach(s, world.vo, pid, world.chan_a)
    res = out.rows[0][0]
    assert res["ok"] and res["ai_disclosure_voice"] == "own_clone" and res["slot"] == "narrator"
    c = cfg(s, world.chan_a)
    assert c["elevenlabs_voice_id"] == voice and c["ai_disclosure_voice"] == "own_clone"
    become(s, None)
    assert s.value("select count(*) from public.app_audit_log where action = 'voice.attach' and target = %s and channel_id = %s", [pid, world.chan_a]) == 1
    assert s.value("select count(*) from public.voice_channel_attachments where voice_profile_id = %s and status = 'active'", [pid]) == 1
    again = attach(s, world.vo, pid, world.chan_a).rows[0][0]
    assert again["ok"] and again["attachment_id"] == res["attachment_id"], "idempotent"
    become(s, None)
    assert s.value("select count(*) from public.voice_channel_attachments where voice_profile_id = %s", [pid]) == 1


def test_attach_is_the_owners_alone(conn, sc, world):
    s = world.su
    pid, _ = make_approved(s, world.vo, world.org_a)
    for who in (world.alice, world.ed, world.bob, world.helper, world.operator, world.stranger):
        out = attach(s, who, pid, world.chan_a)
        assert not out.ok and out.sqlstate == "P0002", (who.name, out)
    for who in (ANON, SERVICE):
        out = attach(s, who, pid, world.chan_a)
        assert not out.ok and out.sqlstate == "42501", (who.name, out)
    assert cfg(s, world.chan_a).get("elevenlabs_voice_id") != _, "nobody but the owner put it there"


def test_attach_needs_the_owner_to_be_an_administrator_of_the_channels_organization(conn, sc, world):
    s = world.su
    pid, _ = make_approved(s, world.ed, world.org_a)  # ed owns it, but is only an editor of org A
    out = attach(s, world.ed, pid, world.chan_a)
    assert not out.ok and out.sqlstate == "42501" and out.error == "forbidden", out  # the function's own check, not the guard's second line
    out = attach(s, world.ed, pid, world.chan_b)
    assert not out.ok and out.sqlstate == "P0002", "another organization's channel reads as missing"


def test_attach_a_platform_administrator_is_not_an_administrator_of_a_customers_organization(conn, sc, world):
    s = world.su
    become(s, None)
    # the helper is a platform admin and a viewer-with-nothing in org A; give it a voice of its own in the operator's org
    pid, voice = make_approved(s, world.helper, "00000000-0000-0000-0000-000000000001")
    out = attach(s, world.helper, pid, world.chan_a)
    assert not out.ok and out.sqlstate == "P0002", out
    become(s, None)
    assert cfg(s, world.chan_a).get("elevenlabs_voice_id") != voice


def test_attach_needs_an_approved_voice(conn, sc, world):
    s = world.su
    pid, _ = make_testing(s, world.vo)
    assert attach(s, world.vo, pid, world.chan_a).rows[0][0] == {"ok": False, "error": "not_approved"}
    r = requested(s, world.vo)
    assert attach(s, world.vo, r["profile_id"], world.chan_a).rows[0][0] == {"ok": False, "error": "not_approved"}


def test_attach_a_bad_slot_is_refused(conn, sc, world):
    s = world.su
    pid, _ = make_approved(s, world.vo, world.org_a)
    out = attach(s, world.vo, pid, world.chan_a, "main")
    assert not out.ok and out.sqlstate == "22023", out


def test_attach_a_narrator_voice_already_on_another_elevenlabs_channel_is_refused_cleanly(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    for ch in (world.chan_a, world.chan_a2):
        assert set_cfg(s, world.alice, ch, {"tts_provider": "elevenlabs"}).ok
    assert attach(s, world.vo, pid, world.chan_a).rows[0][0]["ok"]
    out = attach(s, world.vo, pid, world.chan_a2)
    assert out.ok and out.rows[0][0] == {"ok": False, "error": "voice_in_use"}, out
    become(s, None)
    assert s.value("select count(*) from public.voice_channel_attachments where voice_profile_id = %s", [pid]) == 1, "the second attachment was undone"
    assert cfg(s, world.chan_a2).get("elevenlabs_voice_id") != voice


def test_detach_is_the_owners_and_leaves_the_channels_id_in_place(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    attach(s, world.vo, pid, world.chan_a)
    become(s, world.alice)
    out = s.run("select public.detach_voice_from_channel(%s, %s)", [pid, world.chan_a])
    assert not out.ok and out.sqlstate == "P0002"
    become(s, world.vo)
    assert s.value("select public.detach_voice_from_channel(%s, %s)", [pid, world.chan_a]) == {"ok": True, "detached": 1}
    assert s.value("select public.detach_voice_from_channel(%s, %s)", [pid, world.chan_a]) == {"ok": True, "detached": 0}
    assert cfg(s, world.chan_a)["elevenlabs_voice_id"] == voice, "the id stays; a run on it is refused (rule 4: no silent substitute)"
    assert blocked(run_job(s, world.chan_a, {}, by=world.ed))


# ═══ 11. delete and purge ═════════════════════════════════════════════════════════════════════════════════════════════════

def test_delete_marks_the_voice_unusable_queues_the_provider_and_the_sample_and_keeps_a_record(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    attach(s, world.vo, pid, world.chan_a)
    become(s, world.vo)
    res = s.value("select public.delete_voice(%s)", [pid])
    assert res == {"ok": True, "already": False, "status": "deleted", "provider_delete_queued": True,
                   "sample_purge_queued": True}
    assert s.value("select public.delete_voice(%s)", [pid])["already"] is True
    become(s, None)
    p = s.rows("select status, deleted_at is not null, sample_state from public.voice_profiles where id = %s", [pid])[0]
    assert tuple(p) == ("deleted", True, "purge_pending")
    assert s.value("select count(*) from public.voice_channel_attachments where voice_profile_id = %s and status = 'active'", [pid]) == 0
    kinds = {r[0] for r in s.rows("select kind from public.voice_clone_jobs where profile_id = %s and status = 'queued'", [pid])}
    assert kinds == {"delete_provider", "purge_sample"}
    rec = s.rows("select owner_ref, event, consent_text_version, provider_voice_id from public.voice_deletion_records where voice_profile_id = %s", [pid])
    assert len(rec) == 1 and rec[0][1] == "deleted" and rec[0][2] == "v1" and rec[0][3] == voice
    assert s.value("select count(*) from public.voice_consents where voice_profile_id = %s", [pid]) == 2, "the consent trail stays"
    cols = {r[0] for r in s.rows("select column_name from information_schema.columns where table_name = 'voice_deletion_records'")}
    assert "user_id" not in cols, "the minimal record names no user"
    assert tts_job(s, world.vo, world.org_a, voice, status="queued").ok is False


def test_only_the_owner_can_delete(conn, sc, world):
    s = world.su
    pid, _ = make_approved(s, world.vo, world.org_a)
    for who in (world.alice, world.ed, world.bob, world.helper, world.operator):
        become(s, who)
        out = s.run("select public.delete_voice(%s)", [pid])
        assert not out.ok and out.sqlstate == "P0002", (who.name, out)
        out = s.run("select public.delete_voice_sample(%s)", [pid])
        assert not out.ok and out.sqlstate == "P0002", (who.name, out)
    for who in (ANON, SERVICE):
        become(s, who)
        assert not s.run("select public.delete_voice(%s)", [pid]).ok


def test_a_deleted_profile_stays_deleted_and_keeps_its_voice_id(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, world.vo)
    s.value("select public.delete_voice(%s)", [pid])
    become(s, None)
    for stmt in ("update public.voice_profiles set status = 'approved' where id = %s",
                 "update public.voice_profiles set provider_voice_id = 'Z' || substr(provider_voice_id, 2) where id = %s",
                 "update public.voice_profiles set user_id = gen_random_uuid() where id = %s",
                 "delete from public.voice_profiles where id = %s"):
        out = s.run(stmt, [pid])
        assert not out.ok and out.sqlstate in ("42501", "23503"), (stmt, out)


def test_the_workers_confirmation_marks_the_sample_purged_and_the_provider_copy_gone(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, world.vo)
    s.value("select public.delete_voice(%s)", [pid])
    done = set()
    for _ in range(2):
        job = claim(s, "w9")
        assert job["profile_id"] == pid and job["kind"] in ("delete_provider", "purge_sample")
        become(s, SERVICE)
        assert s.value("select public.finish_voice_task(%s, 'w9', true, null)", [job["job_id"]]) == {"ok": True}
        done.add(job["kind"])
    assert done == {"delete_provider", "purge_sample"}
    become(s, None)
    assert s.value("select sample_state from public.voice_profiles where id = %s", [pid]) == "purged"
    events = {r[0] for r in s.rows("select event from public.voice_deletion_records where voice_profile_id = %s", [pid])}
    assert events == {"deleted", "provider_deleted", "sample_purged"}


def test_a_failed_task_is_retried_and_then_fails(conn, sc, world):
    s = world.su
    pid, _ = make_approved(s, world.vo, world.org_a)
    become(s, world.vo)
    s.value("select public.delete_voice(%s)", [pid])
    for n in (1, 2):
        job = claim(s, "w9")
        become(s, SERVICE)
        assert s.value("select public.finish_voice_task(%s, 'w9', false, 'provider_down')", [job["job_id"]]) == {"ok": True, "retry": True}
        _ = n
    become(s, None)
    assert s.value("select count(*) from public.voice_clone_jobs where profile_id = %s and status = 'running'", [pid]) == 0


def test_purge_refuses_while_anything_is_outstanding_then_removes_the_record_and_keeps_the_minimal_one(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    become(s, SERVICE)
    assert s.value("select public.purge_voice_records(%s)", [pid]) == {"ok": False, "error": "not_deleted"}
    become(s, world.vo)
    s.value("select public.delete_voice(%s)", [pid])
    become(s, SERVICE)
    assert s.value("select public.purge_voice_records(%s)", [pid])["error"] == "sample_outstanding"
    for _ in range(2):
        job = claim(s, "w9")
        become(s, SERVICE)
        s.value("select public.finish_voice_task(%s, 'w9', true, null)", [job["job_id"]])
    become(s, SERVICE)
    assert s.value("select public.purge_voice_records(%s)", [pid]) == {"ok": True}
    become(s, None)
    assert s.value("select count(*) from public.voice_profiles where id = %s", [pid]) == 0
    assert s.value("select count(*) from public.voice_consents where voice_profile_id = %s", [pid]) == 0
    events = {r[0] for r in s.rows("select event from public.voice_deletion_records where voice_profile_id = %s", [pid])}
    assert events == {"deleted", "provider_deleted", "sample_purged", "purged"}, "the minimal record survives"
    assert s.value("select count(*) from public.app_audit_log where action = 'voice.purge' and target = %s", [pid]) == 1
    # and the id stays unusable: nothing outside the profile table can bring the voice back, and a purged id is simply unknown
    assert s.value("select public.purge_voice_records(%s)", [pid]) == {"ok": False, "error": "no_such_voice"}


# ═══ 12. the bucket ═══════════════════════════════════════════════════════════════════════════════════════════════════════

def test_the_bucket_is_private_audio_only_and_50_mb(conn, sc, world):
    become(world.su, None)
    row = world.su.rows("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'voice-samples'")[0]
    assert row[0] is False and row[1] == 50 * 1024 * 1024
    assert row[2] and all(m.startswith("audio/") for m in row[2])
    assert {"audio/webm", "audio/ogg", "audio/wav", "audio/mpeg"} <= set(row[2])


def test_the_owner_can_put_a_recording_in_their_own_prefix_for_a_waiting_profile(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    for ext in ("webm", "ogg", "wav", "m4a"):
        assert upload(s, world.vo, r["profile_id"], ext).ok, ext


def test_nobody_can_put_a_file_in_someone_elses_prefix_or_for_someone_elses_profile(conn, sc, world):
    s = world.su
    mine = requested(s, world.vo)
    theirs = requested(s, world.ed)
    # the victim's prefix, with the attacker as the signed-in user
    assert not upload(s, world.ed, theirs["profile_id"], owner_uid=world.vo.uid).ok
    # the attacker's own prefix but the VICTIM's profile id
    assert not upload(s, world.ed, mine["profile_id"]).ok
    # a profile id that does not exist
    assert not upload(s, world.vo, str(uuid.uuid4())).ok
    for who in (ANON,):
        become(s, who)
        assert not s.run("insert into storage.objects (bucket_id, name) values ('voice-samples', %s)",
                         [f"{world.vo.uid}/{mine['profile_id']}/sample.webm"]).ok


@pytest.mark.parametrize("name_tail", ["sample.exe", "sample", "other.webm", "../sample.webm", "x/sample.webm", "sample.webm.exe", "SAMPLE.webm"])
def test_only_the_expected_object_name_is_accepted(conn, sc, world, name_tail):
    s = world.su
    r = requested(s, world.vo)
    become(s, world.vo)
    out = s.run("insert into storage.objects (bucket_id, name, owner) values ('voice-samples', %s, %s)",
                [f"{world.vo.uid}/{r['profile_id']}/{name_tail}", world.vo.uid])
    assert not out.ok, name_tail


def test_a_profile_that_is_no_longer_waiting_takes_no_more_files(conn, sc, world):
    s = world.su
    pid, _ = make_testing(s, world.vo)
    assert not upload(s, world.vo, pid).ok
    r = requested(s, world.ed)
    become(s, world.ed)
    s.value("select public.delete_voice(%s)", [r["profile_id"]])
    assert not upload(s, world.ed, r["profile_id"]).ok


def test_nobody_can_read_list_change_or_delete_a_sample_through_the_api(conn, sc, world):
    s = world.su
    r = requested(s, world.vo)
    assert upload(s, world.vo, r["profile_id"]).ok
    for who in (world.vo, world.alice, world.bob, world.operator, world.helper, ANON):
        become(s, who)
        assert s.rows("select name from storage.objects where bucket_id = 'voice-samples'") == [], who.name
        out = s.run("update storage.objects set name = name || 'x' where bucket_id = 'voice-samples'")
        assert (not out.ok) or out.rowcount == 0, who.name
        out = s.run("delete from storage.objects where bucket_id = 'voice-samples'")
        assert (not out.ok) or out.rowcount == 0, who.name
    become(s, None)
    assert len(s.rows("select 1 from storage.objects where bucket_id = 'voice-samples'")) == 1, "it is still there"
    become(s, SERVICE)
    assert len(s.rows("select 1 from storage.objects where bucket_id = 'voice-samples'")) == 1, "the worker's key reads it"


def test_a_broad_policy_added_by_hand_still_cannot_open_the_bucket(conn, sc, world):
    """The lesson of 0098: storage policies add up and a dashboard-made one is in no migration. The restrictive ones close the bucket anyway."""
    s = world.su
    r = requested(s, world.vo)
    assert upload(s, world.vo, r["profile_id"]).ok
    become(s, None)
    s.conn.execute("insert into storage.buckets (id, name, public) values ('other-bucket', 'other-bucket', false) on conflict do nothing")
    s.conn.execute("insert into storage.objects (bucket_id, name) values ('other-bucket', 'a/b.txt')")
    for cmd in ("select", "update", "delete"):
        s.conn.execute(f"create policy drift_{cmd} on storage.objects for {cmd} to authenticated, anon using (true)")
    s.conn.execute("create policy drift_insert on storage.objects for insert to authenticated, anon with check (true)")
    for who in (world.bob, world.alice, ANON):
        become(s, who)
        names = {x[0] for x in s.rows("select name from storage.objects")}
        assert "a/b.txt" in names, "the drift policy works for other buckets (so the test is not vacuous)"
        assert not any(n.endswith("sample.webm") for n in names), who.name
        out = s.run("delete from storage.objects where bucket_id = 'voice-samples'")
        assert (not out.ok) or out.rowcount == 0
        out = s.run("update storage.objects set name = name where bucket_id = 'voice-samples'")
        assert (not out.ok) or out.rowcount == 0
        out = s.run("insert into storage.objects (bucket_id, name) values ('voice-samples', %s)", [f"{world.vo.uid}/{r['profile_id']}/sample.ogg"])
        assert not out.ok, f"{who.name} wrote into someone else's prefix through the drift policy"


def test_the_policies_are_the_ones_the_migration_declares(conn, sc, world):
    become(world.su, None)
    rows = world.su.rows("select policyname, permissive, cmd, roles::text from pg_policies where schemaname = 'storage' "
                         "and tablename = 'objects' and policyname like 'voice\\_samples\\_%' order by 1")
    by = {r[0]: r for r in rows}
    assert set(by) == {"voice_samples_insert_own", "voice_samples_closed_select", "voice_samples_closed_update",
                       "voice_samples_closed_delete", "voice_samples_closed_insert"}
    assert by["voice_samples_insert_own"][1] == "PERMISSIVE" and by["voice_samples_insert_own"][2] == "INSERT"
    assert "anon" not in by["voice_samples_insert_own"][3]
    for name in ("closed_select", "closed_update", "closed_delete", "closed_insert"):
        assert by[f"voice_samples_{name}"][1] == "RESTRICTIVE"


# ═══ 13. the migration is safe to apply again, and the pure code agrees with it ═══════════════════════════════════════════

def test_applying_the_migration_again_changes_nothing_and_keeps_every_row(conn, sc, world):
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    attach(s, world.vo, pid, world.chan_a)
    become(s, None)
    counts = {t: s.value(f"select count(*) from public.{t}") for t in TABLES}
    policies = s.value("select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'")
    ref = s.value("select owner_ref from public.user_voice_refs where user_id = %s", [world.vo.uid])
    s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    become(s, None)
    # the first replay's backfill gives every user created since a reference (the scenario's users are newer than the file)
    assert s.value("select count(*) from public.user_voice_refs") == s.value("select count(*) from auth.users")
    counts = {t: s.value(f"select count(*) from public.{t}") for t in TABLES}
    s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    become(s, None)
    assert {t: s.value(f"select count(*) from public.{t}") for t in TABLES} == counts
    assert s.value("select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'") == policies
    assert s.value("select owner_ref from public.user_voice_refs where user_id = %s", [world.vo.uid]) == ref
    assert blocked(tts_job(s, world.ed, world.org_a, voice, status="queued")), "the rule still holds after a replay"
    assert tts_job(s, world.vo, world.org_a, voice, status="queued").ok


def test_the_sql_and_python_name_screens_agree_on_one_corpus(conn, sc, world):
    s = world.su
    become(s, None)
    corpus = [
        "My own voice", "Ruslan narrator", "Голос диктора", "Ovozim", "a b", "x" * 60, "x" * 61, "", " ", "  padded name  ",
        "sounds like Elvis", "Sounds  LIKE  elvis", "soundalike", "sound-alike", "voice of Morgan", "in the style of X", "In The Voice Of Y",
        "impression of Z", "impressions", "impersonating", "imitation", "mimicry", "parody", "clone of Anna", "lookalike of B", "deepfake",
        "deep fakes", "fake", "real person", "public figure", "celebrity", "politician", "president Bob", "prime minister", "senator",
        "actor", "actress", "singer", "rapper", "streamer", "youtuber", "influencer",
        "S​ounds like X", "ｓｏｕｎｄｓ ｌｉｋｅ", "звучит как Путин", "ПОХОЖ НА кого-то", "голос как у него", "имитация", "пародия", "знаменитость",
        "президент", "ovozi kabi", "ovoz kabi biri", "https://x.io", "www.x.io", "a@b.io", "a/b", "a\\b", "<x>", "a{b}", "a[b]", "a|b", "a`b",
        "a$b", "a%b", "a^b", "a*b", "a=b", "a+b", "a~b", 'a"b', "a'b", "O'Neil voice", "a_b-c.d", "1234", "123 456", "---", "!!", "a\tb",
        "President", "my presidential voice", "factor", "unfaked", "singers", "action hero", "soundscape", "voiceover", "voice over",
        "Apple pie", "kitchen", "clone", "my clone", "copy of me", "double of me", "doubles",
    ]
    for name in corpus:
        py = pure.voice_name_problem(name)
        db = s.value("select public.voice_name_problem(%s)", [name])
        assert py == db, (name, py, db)


def test_the_sql_and_python_phrase_helpers_agree(conn, sc, world):
    s = world.su
    become(s, None)
    assert list(s.value("select public.voice_phrase_words()")) == list(pure.PHRASE_WORDS)
    assert list(s.value("select public.voice_real_person_patterns()")) == list(pure.REAL_PERSON_PATTERNS)
    for text in ("apple river CANDLE", "  apple,  river! candle.  ", "Apple​ River", "яблоко река", "ａｐｐｌｅ river", ""):
        assert s.value("select public.voice_phrase_hash(%s)", [text]) == pure.hash_phrase(text), text
    for _ in range(80):  # 6 draws from 128 collide about 11% of the time: 80 phrases make a missing distinctness check certain to show
        p = s.value("select public.voice_phrase_new()")
        w = p.split()
        assert len(w) == 6 and len(set(w)) == 6 and set(w) <= set(pure.PHRASE_WORDS)
        assert pure.check_transcript(p, p).passed


def test_every_word_of_the_list_is_reachable_by_the_sql_draw(conn, sc, world):
    s = world.su
    become(s, None)
    seen = set()
    for _ in range(400):
        seen.update(s.value("select public.voice_phrase_new()").split())
        if len(seen) == 128:
            break
    assert len(seen) >= 120, f"the draw reaches {len(seen)} of 128 words"


def test_the_rollback_puts_0114s_guard_and_0116s_audit_list_back_and_0117_applies_again(conn, sc):
    """The rollback restores channels_config_guard and audit_action_allowed byte for byte (and their grants), drops every callable
    function and the two entry triggers, KEEPS the six tables and their rows, and the migration applies again on top."""
    admin = sec_db.admin_dsn()
    base = f"ns_voice_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    sigs = ("public.channels_config_guard()", "public.audit_action_allowed(text)")
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith("0117_")])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {s: (b.execute("select pg_get_functiondef(%s::regprocedure)", [s]).fetchone()[0],
                        b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [s]).fetchone()[0])
                    for s in sigs}
            fns = {r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    kept = {"voice_profiles_guard()", "voice_append_only()", "user_voice_refs_immutable()"}
    with as_superuser(conn, commit=False) as su:
        def snapshot():
            return {s: (su.value("select pg_get_functiondef(%s::regprocedure)", [s]),
                        su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [s])) for s in sigs}
        applied = snapshot()
        rows_before = su.value("select count(*) from public.voice_profiles")
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert snapshot() == applied, "a replay changes nothing"
        su.conn.execute(body)
        assert snapshot() == want, "0114's guard and 0116's audit list are back, byte for byte"
        now = {r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
        assert {f.replace("public.", "") for f in now - fns} == kept, sorted(now - fns)
        assert fns - now == set()
        assert su.value("select count(*) from public.voice_profiles") == rows_before, "the record stays"
        assert su.rows("select 1 from pg_trigger where tgname in ('creative_jobs_voice_guard', 'render_jobs_voice_guard')") == []
        assert su.rows("select 1 from pg_policies where schemaname = 'storage' and policyname like 'voice\\_samples\\_%'") == []
        su.conn.execute(body)  # the rollback replays
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert snapshot() == applied


def test_the_rule_itself_answers_as_documented(conn, sc, world):
    """voice_usable_by() is internal (no API role can call it); the database owner asks it directly."""
    s = world.su
    pid, voice = make_approved(s, world.vo, world.org_a)
    assert attach(s, world.vo, pid, world.chan_a).rows[0][0]["ok"]
    become(s, None)
    q = "select public.voice_usable_by(%s, %s, %s, %s, %s, %s)"
    ask = lambda *a: s.value(q, list(a))  # noqa: E731
    # (user, voice, org, channel, purpose, slot)
    assert ask(None, "pNInz6obpgDQGcFmaJgB", None, None, "use", None) is True, "no profile: allowed"
    assert ask(None, "", None, None, "use", None) is True, "no voice named: nothing to protect"
    assert ask(world.vo.uid, voice, None, None, "use", None) is True, "the owner"
    assert ask(world.ed.uid, voice, None, None, "use", None) is False, "someone else, no channel"
    assert ask(world.ed.uid, voice, world.org_a, world.chan_a, "use", "narrator") is True, "an attached channel, the right slot"
    assert ask(None, voice, world.org_a, world.chan_a, "use", "secondary") is False, "the wrong slot"
    assert ask(None, voice, world.org_b, world.chan_a, "use", "narrator") is False, "the channel is not in the organization named"
    assert ask(None, voice, world.org_a, world.chan_a2, "use", "narrator") is False, "a channel it was not attached to"
    assert ask(None, voice, world.org_a, "no-such-channel", "use", "narrator") is False
    assert ask(world.ed.uid, voice, None, None, "test", None) is False, "a test is the owner's"
    assert ask(world.vo.uid, voice, None, None, "test", None) is True
