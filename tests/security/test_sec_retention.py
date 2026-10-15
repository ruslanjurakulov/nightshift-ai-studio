"""Migration 0103: a returning person is told, by bell and by e-mail, about their
own work only — and can always turn it off.

What would break without these:

* a "video ready" bell or mail reaching someone outside the channel's
  organization, or a member who cannot decide on it (a viewer), or carrying a
  title or prompt;
* a mail naming another tenant's channel because an id in a notification pointed
  there;
* the unsubscribe token (or anyone's address, language or switches) readable by a
  browser, or the opt-out link able to turn mail ON, or to act on a guessed token;
* a person who unsubscribed still mailed because the notification was written
  before they did;
* a mail sent twice (two workers, a retry after a crash), a backlog mailed on the
  first run, or a mail to an unconfirmed address;
* the weekly summary sent without the person asking for it, sent for a period with
  nothing in it, counting another organization's rows, or showing 0 credits for
  "unknown";
* a failure to write a notification rolling back the video it reports.
"""

from __future__ import annotations

import json
import re
import threading
import uuid

import psycopg
import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user
from sec_scenario import DEFAULT_ORG

TOKEN = re.compile(r"^[0-9a-f]{64}$")
WORKER = "email-test-01"


# ── helpers ─────────────────────────────────────────────────────────────────

def as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def as_user(s, actor):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role authenticated")
    return s


def as_service(s):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(SERVICE.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [SERVICE.role])
    s.conn.execute("set local role service_role")
    return s


def hold(s, channel, video_id, state="held"):
    """What modules/held_video.py writes: a row with no publish time and no privacy."""
    s.rows("insert into public.videos (video_id, channel_id, slug, review_state, publish_state, held_at) "
           "values (%s, %s, %s, 'pending', %s, now()) "
           "on conflict (video_id) do update set publish_state = excluded.publish_state returning 1",
           [video_id, channel, f"slug-{video_id}", state])


def bell(s, uid, kind="video_ready", ref=""):
    """The person's notifications of one kind whose ref starts with `ref` (the committed lab world already holds
    other tenants' held videos, so a test looks at its own)."""
    return s.rows("select id::text, org_id::text, ref, data from public.notifications "
                  "where user_id = %s and kind = %s and ref like %s order by created_at, id", [uid, kind, ref + "%"])


def claim_ready(s, uid, limit=100, lease=300):
    """What the worker was handed FOR ONE PERSON. The committed lab world holds other tenants' held videos
    (other seeds raise their own notifications), which a claim hands over too; the tests look at their own."""
    as_service(s)
    out = s.value("select public.email_claim_ready(%s, %s, %s)", [WORKER, limit, lease])
    as_owner(s)
    return [m for m in out if m["user_id"] == uid]


def claim_weekly(s, limit=100):
    as_service(s)
    out = s.value("select public.email_claim_weekly(%s, %s, 300)", [WORKER, limit])
    as_owner(s)
    return out


def ledger(s, uid, kind=None):
    q = "select kind, ref, status, attempts, error_code from public.email_deliveries where user_id = %s"
    p = [uid]
    if kind:
        q += " and kind = %s"
        p.append(kind)
    return s.rows(q + " order by created_at, ref", p)


def prefs_row(s, uid):
    return s.rows("select ready_enabled, weekly_every_days, weekly_since, locale, unsubscribe_token "
                  "from public.email_preferences where user_id = %s", [uid])


def set_prefs(s, actor, **kw):
    as_user(s, actor)
    out = s.run("select public.email_prefs_set(%s, %s, %s)", [kw.get("ready"), kw.get("weekly"), kw.get("locale")])
    as_owner(s)
    return out


def fresh_user(s):
    """A person with an organization and nothing else (no channel, no video),
    written inside the test's own rolled-back transaction."""
    carol = user("carol", f"carol-{uuid.uuid4().hex[:6]}@r.test")
    as_owner(s)
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [carol.uid, carol.email])
    org = str(s.value("insert into public.organizations (name, slug) values ('Carol studio', %s) returning id",
                      [f"carol-{uuid.uuid4().hex[:8]}"]))
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
           [org, carol.uid, carol.email])
    return carol, org


# ── the tables are closed ───────────────────────────────────────────────────

@pytest.mark.parametrize("table", ["email_preferences", "email_deliveries"])
def test_no_api_role_reads_or_writes_either_table(conn, sc, table):
    for who in (sc.alice.actor, sc.operator, SERVICE, ANON):
        with acting(conn, who) as s:
            outs = [
                s.run(f"select * from public.{table}"),
                s.run(f"insert into public.{table} (user_id) values (%s) returning 1", [sc.alice.actor.uid]),
                s.run(f"update public.{table} set user_id = user_id returning 1"),
                s.run(f"delete from public.{table} returning 1"),
                s.run(f"truncate public.{table}"),
            ]
        for o in outs:
            assert not o.ok and o.sqlstate == "42501", (who.name, table, o)


def test_the_token_is_not_a_column_anyone_can_select(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, ready=True)
        for who in (sc.alice.actor, SERVICE, ANON):
            as_owner(s)
            if who.role == "authenticated":
                as_user(s, who)
            elif who.role == "service_role":
                as_service(s)
            else:
                s.conn.execute("set local role anon")
            out = s.run("select unsubscribe_token from public.email_preferences")
            as_owner(s)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        as_user(s, sc.alice.actor)
        mine = s.value("select public.email_prefs_get()")
    assert set(mine) == {"ready", "weekly_every_days", "locale", "stored"}, mine
    assert not any(TOKEN.match(str(v)) for v in mine.values())


# ── a person's own switches ─────────────────────────────────────────────────

def test_the_defaults_are_ready_mail_on_and_weekly_off_and_nothing_is_stored_by_reading(conn, sc):
    with as_superuser(conn, commit=False) as s:
        carol, _ = fresh_user(s)
        as_user(s, carol)
        got = s.value("select public.email_prefs_get()")
        as_owner(s)
        assert prefs_row(s, carol.uid) == [], "reading the defaults must not create a row"
    assert got == {"ready": True, "weekly_every_days": None, "locale": "en", "stored": False}


def test_each_person_sets_only_their_own_switches(conn, sc):
    with as_superuser(conn, commit=False) as s:
        out = set_prefs(s, sc.alice.actor, ready=False, weekly=7, locale="uz")
        assert out.ok, out
        a = prefs_row(s, sc.alice.actor.uid)
        b = prefs_row(s, sc.bob.actor.uid)
        as_user(s, sc.bob.actor)
        bob_sees = s.value("select public.email_prefs_get()")
    assert a[0][0] is False and a[0][1] == 7 and a[0][2] is not None and a[0][3] == "uz"
    assert TOKEN.match(a[0][4])
    assert b == [] and bob_sees["ready"] is True and bob_sees["weekly_every_days"] is None


def test_weekly_starts_a_clock_when_switched_on_and_clears_it_when_switched_off(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, weekly=7)
        first = prefs_row(s, sc.alice.actor.uid)[0][2]
        s.rows("update public.email_preferences set weekly_since = now() - interval '3 days' where user_id = %s returning 1",
               [sc.alice.actor.uid])
        set_prefs(s, sc.alice.actor, weekly=14)  # a change of rhythm does not restart the clock
        kept = prefs_row(s, sc.alice.actor.uid)[0]
        set_prefs(s, sc.alice.actor, weekly=0)
        off = prefs_row(s, sc.alice.actor.uid)[0]
        # Other switches left alone: the same call without a weekly argument.
        set_prefs(s, sc.alice.actor, ready=False)
        after = prefs_row(s, sc.alice.actor.uid)[0]
    assert first is not None
    assert kept[1] == 14 and kept[2] < first
    assert off[1] is None and off[2] is None
    assert after[0] is False and after[1] is None


@pytest.mark.parametrize("kw", [{"weekly": 5}, {"weekly": -1}, {"weekly": 30}, {"locale": "EN"}, {"locale": ""}, {"locale": "en_US"}, {"locale": "x"}])
def test_values_outside_the_allow_lists_are_refused(conn, sc, kw):
    with as_superuser(conn, commit=False) as s:
        out = set_prefs(s, sc.alice.actor, **kw)
    assert not out.ok and out.sqlstate == "22023", out


def test_anon_cannot_read_or_set_preferences(conn, sc):
    with acting(conn, ANON) as s:
        get = s.run("select public.email_prefs_get()")
        put = s.run("select public.email_prefs_set(false, 0, 'en')")
    assert not get.ok and get.sqlstate == "42501", get
    assert not put.ok and put.sqlstate == "42501", put


# ── the one-click opt-out ───────────────────────────────────────────────────

def _token(s, uid):
    return prefs_row(s, uid)[0][4]


def test_unsubscribe_by_token_turns_mail_off_without_a_session_and_only_that_scope(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, ready=True, weekly=7)
        tok = _token(s, sc.alice.actor.uid)
        s.conn.execute("set local role anon")
        only_weekly = s.value("select public.email_unsubscribe(%s, 'weekly')", [tok])
        as_owner(s)
        mid = prefs_row(s, sc.alice.actor.uid)[0]
        s.conn.execute("set local role anon")
        only_ready = s.value("select public.email_unsubscribe(%s, 'ready')", [tok])
        as_owner(s)
        end = prefs_row(s, sc.alice.actor.uid)[0]
        set_prefs(s, sc.alice.actor, ready=True, weekly=14)
        s.conn.execute("set local role anon")
        everything = s.value("select public.email_unsubscribe(%s, 'all')", [tok])
        as_owner(s)
        gone = prefs_row(s, sc.alice.actor.uid)[0]
    assert only_weekly == only_ready == everything == "ok"
    assert mid[0] is True and mid[1] is None and mid[2] is None, "weekly scope must leave ready mail alone"
    assert end[0] is False
    assert gone[0] is False and gone[1] is None and gone[2] is None


def test_a_wrong_malformed_or_foreign_token_does_nothing_and_says_the_same_thing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, ready=True, weekly=7)
        set_prefs(s, sc.bob.actor, ready=True, weekly=7)
        guesses = ["", "x", "0" * 64, "f" * 64, "G" * 64, "0" * 63, "0" * 65, _token(s, sc.alice.actor.uid).upper(),
                   _token(s, sc.alice.actor.uid) + " ", "' or true --"]
        s.conn.execute("set local role anon")
        answers = [s.value("select public.email_unsubscribe(%s, 'all')", [g]) for g in guesses]
        bad_scope = s.value("select public.email_unsubscribe(%s, 'everything')", [_token_safe(s, sc)])
        null_token = s.value("select public.email_unsubscribe(null, 'all')")
        null_scope = s.value("select public.email_unsubscribe(%s, null)", [_token_safe(s, sc)])
        as_owner(s)
        a, b = prefs_row(s, sc.alice.actor.uid)[0], prefs_row(s, sc.bob.actor.uid)[0]
    assert set(answers) == {"invalid"} and bad_scope == null_token == null_scope == "invalid"
    assert a[0] is True and a[1] == 7 and b[0] is True and b[1] == 7


def _token_safe(s, sc):
    as_owner(s)
    t = _token(s, sc.alice.actor.uid)
    s.conn.execute("set local role anon")
    return t


def test_unsubscribe_cannot_switch_anything_on(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, ready=False)
        tok = _token(s, sc.alice.actor.uid)
        s.conn.execute("set local role anon")
        s.value("select public.email_unsubscribe(%s, 'weekly')", [tok])
        as_owner(s)
        row = prefs_row(s, sc.alice.actor.uid)[0]
    assert row[0] is False and row[1] is None


# ── the producers ───────────────────────────────────────────────────────────

def test_a_held_video_tells_the_orgs_deciders_with_ids_only(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-ready-1")
        rows = bell(s, sc.alice.actor.uid, ref="run-ready-1")
        bob = bell(s, sc.bob.actor.uid, ref="run-ready-1")
    assert len(rows) == 1 and bob == []
    _id, org, ref, data = rows[0]
    assert org == sc.alice.org and ref == "run-ready-1:held"
    assert data == {"video_id": "run-ready-1", "channel_id": sc.alice.channel, "state": "held"}


def test_a_viewer_is_not_told_but_an_admin_is(conn, sc):
    viewer = user("vera", f"vera-{uuid.uuid4().hex[:6]}@r.test")
    admin = user("adam", f"adam-{uuid.uuid4().hex[:6]}@r.test")
    with as_superuser(conn, commit=False) as s:
        for who, role in ((viewer, "viewer"), (admin, "admin")):
            s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
            s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
                   [sc.alice.org, who.uid, who.email, role])
        hold(s, sc.alice.channel, "run-ready-2")
        v, a = bell(s, viewer.uid, ref='run-ready-2'), bell(s, admin.uid, ref='run-ready-2')
    assert v == [] and len(a) == 1


def test_only_a_state_that_waits_for_a_person_tells_them(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-ready-3", "blocked")
        none_for_blocked = bell(s, sc.alice.actor.uid, ref="run-ready-3")
        hold(s, sc.alice.channel, "run-ready-3", "awaiting_approval")
        hold(s, sc.alice.channel, "run-ready-3", "awaiting_approval")  # written again, same state
        hold(s, sc.alice.channel, "run-ready-3", "held")
        hold(s, sc.alice.channel, "run-ready-3", "repaired_awaiting_review")
        states = [r[3]["state"] for r in bell(s, sc.alice.actor.uid, ref="run-ready-3")]
        # Promoted to an upload: the earlier notifications stand, nothing new.
        s.rows("update public.videos set publish_state = 'uploaded', published_at = now()::text, privacy = 'private' "
               "where video_id = 'run-ready-3' returning 1")
        after_upload = len(bell(s, sc.alice.actor.uid, ref="run-ready-3")) + len(bell(s, sc.alice.actor.uid, ref="yt-direct"))
        # A video that was never held and is simply uploaded tells nobody either.
        s.rows("insert into public.videos (video_id, channel_id, slug, publish_state, published_at, privacy) "
               "values ('yt-direct', %s, 's', 'uploaded', now()::text, 'private') returning 1", [sc.alice.channel])
        direct = len(bell(s, sc.alice.actor.uid, ref="run-ready-3")) + len(bell(s, sc.alice.actor.uid, ref="yt-direct"))
    assert none_for_blocked == []
    assert states == ["awaiting_approval", "held", "repaired_awaiting_review"]
    assert after_upload == direct == 3


def test_a_video_whose_channel_is_unknown_tells_nobody(conn, sc):
    with as_superuser(conn, commit=False) as s:
        # No channels row at all: nothing to say who owns it.
        before = s.value("select count(*) from public.notifications where kind = 'video_ready'")
        hold(s, "no-such-channel", "run-orphan")
        after = s.value("select count(*) from public.notifications where kind = 'video_ready'")
    assert before == after


def test_the_storyboard_notification_now_names_its_channel(conn, sc):
    with as_superuser(conn, commit=False) as s:
        rows = bell(s, sc.alice.actor.uid, "storyboard_ready")
    assert rows, "control: the scenario's storyboard told Alice"
    assert all(r[3].get("channel_id") == sc.alice.channel and set(r[3]) == {"storyboard_id", "scenes", "channel_id"} for r in rows)


def test_a_failure_to_write_the_bell_never_rolls_back_the_video(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("alter table public.notifications add constraint no_notes check (false) not valid")
        out = s.run("insert into public.videos (video_id, channel_id, slug, publish_state, held_at) "
                    "values ('run-no-bell', %s, 's', 'held', now()) returning 1", [sc.alice.channel])
        written = s.value("select count(*) from public.videos where video_id = 'run-no-bell'")
    assert out.ok and written == 1


# ── the worker: ready mail ──────────────────────────────────────────────────

def test_only_the_service_key_may_call_the_worker_functions(conn, sc):
    calls = [
        "select public.email_claim_ready('w', 5, 60)",
        "select public.email_claim_weekly('w', 5, 60)",
        "select public.email_complete(%s, 'weekly', 'x', 'sent', null)",
        "select public.email_weekly_digest(%s, 7)",
    ]
    for who in (sc.alice.actor, sc.operator, ANON):
        for q in calls:
            with acting(conn, who) as s:
                out = s.run(q, [sc.alice.actor.uid] if "%s" in q else None)
            assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
    with acting(conn, SERVICE) as s:
        assert s.run("select public.email_claim_ready('w', 5, 60)").ok
        digest = s.run("select public.email_weekly_digest(%s, 7)", [sc.alice.actor.uid])
    assert not digest.ok and digest.sqlstate == "42501", "the digest helper is internal even to the service key"


def test_a_ready_mail_is_claimed_once_with_everything_needed_and_nothing_more(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("update public.channels set name = 'Night Owl', credential_ref = %s::jsonb where channel_id = %s returning 1",
               [json.dumps({"youtube_thumbnail": "https://yt3.example/a.jpg"}), sc.alice.channel])
        hold(s, sc.alice.channel, "run-mail-1")
        first = claim_ready(s, sc.alice.actor.uid)
        again = claim_ready(s, sc.alice.actor.uid)
        row = ledger(s, sc.alice.actor.uid)
    assert len(first) == 1 and again == []
    m = first[0]
    assert set(m) == {"user_id", "email", "locale", "token", "kind", "ref", "data", "created_at", "channel"}
    assert m["email"] == sc.alice.actor.email and m["locale"] == "en" and TOKEN.match(m["token"])
    assert m["kind"] == "video_ready" and m["ref"] == "run-mail-1:held"
    assert m["channel"] == {"id": sc.alice.channel, "name": "Night Owl", "avatar": "https://yt3.example/a.jpg"}
    assert "title" not in json.dumps(m) and "prompt" not in json.dumps(m)
    assert row == [("video_ready", "run-mail-1:held", "claimed", 1, None)]


def test_the_mail_uses_the_language_the_person_chose(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, locale="ru")
        hold(s, sc.alice.channel, "run-mail-ru")
        first = claim_ready(s, sc.alice.actor.uid)
    assert first[0]["locale"] == "ru"


def test_sent_is_final_and_a_retry_waits_then_gives_up_after_five(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-mail-2")
        assert len(claim_ready(s, sc.alice.actor.uid)) == 1
        uid = sc.alice.actor.uid
        as_service(s)
        retry = s.value("select public.email_complete(%s, 'video_ready', 'run-mail-2:held', 'retry', 'timeout')", [uid])
        as_owner(s)
        assert retry is True and claim_ready(s, sc.alice.actor.uid) == [], "a retry waits for its backoff"
        for attempt in range(2, 6):
            s.rows("update public.email_deliveries set claimed_until = now() - interval '1 second' where user_id = %s returning 1", [uid])
            got = claim_ready(s, sc.alice.actor.uid)
            assert len(got) == 1, attempt
            as_service(s)
            s.value("select public.email_complete(%s, 'video_ready', 'run-mail-2:held', 'retry', 'timeout')", [uid])
            as_owner(s)
        row = ledger(s, uid)[0]
        s.rows("update public.email_deliveries set claimed_until = now() - interval '1 second' where user_id = %s returning 1", [uid])
        after_dead = claim_ready(s, sc.alice.actor.uid)
    assert row[2] == "dead" and row[3] == 5 and row[4] == "timeout"
    assert after_dead == []


def test_a_sent_mail_is_never_claimed_again_even_after_its_lease(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-mail-3")
        claim_ready(s, sc.alice.actor.uid)
        uid = sc.alice.actor.uid
        as_service(s)
        done = s.value("select public.email_complete(%s, 'video_ready', 'run-mail-3:held', 'sent', null)", [uid])
        twice = s.value("select public.email_complete(%s, 'video_ready', 'run-mail-3:held', 'sent', null)", [uid])
        as_owner(s)
        s.rows("update public.email_deliveries set claimed_until = now() - interval '1 hour' where user_id = %s returning 1", [uid])
        later = claim_ready(s, sc.alice.actor.uid)
        row = ledger(s, uid)[0]
    assert done is True and twice is False and later == []
    assert row[2] == "sent"


def test_unsubscribing_after_the_notification_was_written_is_honoured(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-mail-4")
        tok = prefs_row(s, sc.alice.actor.uid)
        set_prefs(s, sc.alice.actor, ready=False)
        got = claim_ready(s, sc.alice.actor.uid)
        row = ledger(s, sc.alice.actor.uid)
    assert got == [] and row == [("video_ready", "run-mail-4:held", "skipped", 0, "opted_out")]
    assert tok == []


def test_someone_removed_from_the_org_after_the_hold_is_not_mailed_its_channel(conn, sc):
    admin = user("adam", f"adam-{uuid.uuid4().hex[:6]}@r.test")
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [admin.uid, admin.email])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin') returning 1",
               [sc.alice.org, admin.uid, admin.email])
        hold(s, sc.alice.channel, "run-gone-1")
        assert bell(s, admin.uid, ref="run-gone-1"), "control: the admin was told while a member"
        s.rows("delete from public.org_members where org_id = %s and user_id = %s returning 1", [sc.alice.org, admin.uid])
        got = claim_ready(s, admin.uid)
        row = ledger(s, admin.uid)
    assert got == [] and row == [("video_ready", "run-gone-1:held", "skipped", 0, "not_member")]


def test_claims_that_used_their_attempts_are_closed_and_do_not_starve_newer_mail(conn, sc):
    with as_superuser(conn, commit=False) as s:
        uid = sc.alice.actor.uid
        # 120 older notifications whose claims are spent: five attempts, lease over.
        for i in range(120):
            s.rows("select 1 from (select public.notification_emit(%s, %s, 'editor_export_done', %s, '{}'::jsonb)) q",
                   [sc.alice.org, uid, f"stuck-{i}"])
            s.rows("update public.notifications set created_at = now() - interval '1 hour' where ref = %s returning 1", [f"stuck-{i}"])
            s.rows("insert into public.email_deliveries (user_id, kind, ref, status, attempts, claimed_by, claimed_until) "
                   "values (%s, 'editor_export_done', %s, 'claimed', 5, 'w', now() - interval '1 minute') returning 1", [uid, f"stuck-{i}"])
        hold(s, sc.alice.channel, "run-fresh-1")
        got = claim_ready(s, uid, limit=5)
        dead = s.value("select count(*) from public.email_deliveries where user_id = %s and status = 'dead' and error_code = 'gave_up'", [uid])
        again = claim_ready(s, uid, limit=5)
    assert [m["ref"] for m in got] == ["run-fresh-1:held"], "newer mail was crowded out"
    assert dead == 120 and again == []


def test_an_old_notification_is_not_mailed_so_the_first_run_sends_no_backlog(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-mail-5")
        s.rows("update public.notifications set created_at = now() - interval '7 hours' where ref = 'run-mail-5:held' returning 1")
        got = claim_ready(s, sc.alice.actor.uid)
    assert got == []


def test_an_unconfirmed_address_is_not_mailed(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("update auth.users set email_confirmed_at = null where id = %s returning 1", [sc.alice.actor.uid])
        hold(s, sc.alice.channel, "run-mail-6")
        got = claim_ready(s, sc.alice.actor.uid)
        row = ledger(s, sc.alice.actor.uid)
    assert got == [] and row[0][2] == "skipped" and row[0][4] == "no_address"


def test_an_id_in_a_notification_never_names_another_tenants_channel(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'video_ready', 'forged:held', %s::jsonb)) q",
               [sc.alice.org, sc.alice.actor.uid,
                json.dumps({"video_id": "x", "channel_id": sc.bob.channel, "state": "held"})])
        got = claim_ready(s, sc.alice.actor.uid)
    assert len(got) == 1 and got[0]["channel"] is None
    assert "Channel B" not in json.dumps(got)


def test_an_export_mail_carries_no_channel_and_other_kinds_are_not_mailed(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'editor_export_done', 'exp-1', %s::jsonb)) q",
               [sc.alice.org, sc.alice.actor.uid, json.dumps({"export_id": str(uuid.uuid4())})])
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'credits_low', 'low:x', %s::jsonb)) q",
               [sc.alice.org, sc.alice.actor.uid, json.dumps({"available": 3})])
        # The scenario's own storyboard notification is a decision, not a "ready" mail.
        got = claim_ready(s, sc.alice.actor.uid)
    assert [m["kind"] for m in got] == ["editor_export_done"] and got[0]["channel"] is None


def test_two_workers_claiming_at_once_get_a_mail_only_once(conn, sc):
    dsn = psycopg.conninfo.make_conninfo(__import__("sec_db").admin_dsn(), dbname=conn.info.dbname)
    ref = f"run-race-{uuid.uuid4().hex[:8]}"
    with as_superuser(conn, commit=True) as s:
        hold(s, sc.alice.channel, ref)
    results: dict = {}
    c1 = psycopg.connect(dsn, autocommit=False)
    c2 = psycopg.connect(dsn, autocommit=False)
    try:
        def claim_in(conn_, key):
            conn_.execute("set local role service_role")
            r = conn_.execute("select public.email_claim_ready(%s, 50, 300)", [f"w-{key}"]).fetchone()[0]
            results[key] = [m for m in r if m["ref"] == f"{ref}:held"]

        claim_in(c1, "one")  # holds the row lock until it commits
        t = threading.Thread(target=lambda: (claim_in(c2, "two"), c2.commit()))
        t.start()
        t.join(timeout=1.0)
        assert t.is_alive(), "the second claim should wait for the first"
        c1.commit()
        t.join(timeout=10)
        assert not t.is_alive()
    finally:
        c1.close()
        c2.close()
        with as_superuser(conn, commit=True) as s:
            s.rows("delete from public.email_deliveries where ref = %s returning 1", [f"{ref}:held"])
            s.rows("delete from public.notifications where ref = %s returning 1", [f"{ref}:held"])
            s.rows("delete from public.videos where video_id = %s returning 1", [ref])
    assert len(results["one"]) == 1 and results["two"] == [], results


# ── the worker: weekly summary ──────────────────────────────────────────────

def test_nobody_gets_a_weekly_summary_they_did_not_ask_for(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-w-0")
        s.rows("update public.notifications set created_at = now() - interval '30 days' returning 1")
        got = claim_weekly(s)
        # Even a person who set the ready switch and never touched weekly.
        set_prefs(s, sc.alice.actor, ready=True)
        again = claim_weekly(s)
    assert got == [] and again == []


def test_the_first_summary_is_due_one_interval_after_opting_in_not_before(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, weekly=7)
        too_soon = claim_weekly(s)
        s.rows("update public.email_preferences set weekly_since = now() - interval '6 days 23 hours' where user_id = %s returning 1",
               [sc.alice.actor.uid])
        still_soon = claim_weekly(s)
        s.rows("update public.email_preferences set weekly_since = now() - interval '7 days 1 hour' where user_id = %s returning 1",
               [sc.alice.actor.uid])
        due = claim_weekly(s)
    assert too_soon == [] and still_soon == []
    assert len(due) == 1 and due[0]["kind"] == "weekly"


def test_the_digest_counts_only_the_persons_own_rows_and_never_invents_a_number(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-w-1")
        hold(s, sc.alice.channel, "run-w-2")
        hold(s, sc.bob.channel, "run-w-bob")
        set_prefs(s, sc.alice.actor, weekly=7, locale="uz")
        s.rows("update public.email_preferences set weekly_since = now() - interval '8 days' where user_id = %s returning 1",
               [sc.alice.actor.uid])
        avail = s.value("select balance - reserved from public.credit_accounts where org_id = %s", [sc.alice.org])
        got = claim_weekly(s)
    assert len(got) == 1
    m = got[0]
    d = m["digest"]
    assert m["email"] == sc.alice.actor.email and m["locale"] == "uz" and TOKEN.match(m["token"])
    assert d["days"] == 7 and d["videos_made"] == 2
    # Held rows waiting: the scenario's own vid-a plus the two held above; Bob's never.
    assert d["waiting_videos"] == 3 and d["waiting_storyboards"] >= 1
    assert [c["id"] for c in d["channels"]] == [sc.alice.channel]
    assert d["channels"][0]["made"] == 2 and d["channels"][0]["name"] == "Channel A"
    assert float(d["credits_available"]) == float(avail)
    flat = json.dumps(d)
    assert "Channel B" not in flat and "title" not in flat and "Video a" not in flat


def test_credits_are_unknown_not_zero_for_the_exempt_platform_org(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.operator, weekly=7)
        s.rows("update public.email_preferences set weekly_since = now() - interval '8 days' where user_id = %s returning 1",
               [sc.operator.uid])
        s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values ('op-ch', 'Op', 'x', 'PAUSED', %s) "
               "on conflict do nothing returning 1", [DEFAULT_ORG])
        hold(s, "op-ch", "run-w-op")
        got = claim_weekly(s)
    assert len(got) == 1 and got[0]["digest"]["credits_available"] is None


def test_a_period_with_nothing_in_it_is_recorded_and_not_mailed(conn, sc):
    with as_superuser(conn, commit=False) as s:
        carol, _ = fresh_user(s)
        set_prefs(s, carol, weekly=7)
        s.rows("update public.email_preferences set weekly_since = now() - interval '8 days' where user_id = %s returning 1", [carol.uid])
        got = claim_weekly(s)
        row = ledger(s, carol.uid, "weekly")
        s.rows("update public.email_deliveries set done_at = now() - interval '6 days' where user_id = %s returning 1", [carol.uid])
        not_yet = claim_weekly(s)
    assert got == [] and not_yet == []
    assert len(row) == 1 and row[0][2] == "skipped" and row[0][4] == "nothing_to_say"


def test_a_sent_summary_starts_the_next_interval_and_is_not_claimed_twice(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-w-3")
        set_prefs(s, sc.alice.actor, weekly=7)
        s.rows("update public.email_preferences set weekly_since = now() - interval '8 days' where user_id = %s returning 1",
               [sc.alice.actor.uid])
        first = claim_weekly(s)
        second = claim_weekly(s)
        as_service(s)
        ok = s.value("select public.email_complete(%s, 'weekly', %s, 'sent', null)", [sc.alice.actor.uid, first[0]["ref"]])
        as_owner(s)
        after = claim_weekly(s)
    assert len(first) == 1 and second == [] and ok is True and after == []


def test_unsubscribing_from_weekly_stops_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        hold(s, sc.alice.channel, "run-w-4")
        set_prefs(s, sc.alice.actor, weekly=7)
        tok = _token(s, sc.alice.actor.uid)
        s.rows("update public.email_preferences set weekly_since = now() - interval '8 days' where user_id = %s returning 1",
               [sc.alice.actor.uid])
        s.conn.execute("set local role anon")
        s.value("select public.email_unsubscribe(%s, 'weekly')", [tok])
        as_owner(s)
        got = claim_weekly(s)
    assert got == []


# ── is anything sending? ────────────────────────────────────────────────────

def test_the_switches_are_offered_only_while_the_email_worker_reports(conn, sc):
    with as_superuser(conn, commit=False) as s:
        as_user(s, sc.alice.actor)
        none = s.value("select public.email_worker_online()")
        as_owner(s)
        as_service(s)
        s.value("select public.report_worker_status('email-test', 'other', 'running', null, null)")
        as_owner(s)
        as_user(s, sc.alice.actor)
        up = s.value("select public.email_worker_online()")
        as_owner(s)
        s.rows("update public.worker_status set updated_at = now() - interval '10 minutes' where worker_id = 'email-test' returning 1")
        as_user(s, sc.alice.actor)
        stale = s.value("select public.email_worker_online()")
        as_owner(s)
        s.rows("update public.worker_status set updated_at = now(), state = 'failed' where worker_id = 'email-test' returning 1")
        as_user(s, sc.alice.actor)
        failed = s.value("select public.email_worker_online()")
        as_owner(s)
        s.rows("update public.worker_status set worker_id = 'media-x', state = 'running' where worker_id = 'email-test' returning 1")
        as_user(s, sc.alice.actor)
        other = s.value("select public.email_worker_online()")
    assert (none, up, stale, failed, other) == (False, True, False, False, False)
    with acting(conn, ANON) as s:
        out = s.run("select public.email_worker_online()")
    assert not out.ok and out.sqlstate == "42501", out


# ── shape ───────────────────────────────────────────────────────────────────

def test_the_ledger_and_preferences_reject_shapes_the_functions_never_write(conn, sc):
    with as_superuser(conn, commit=False) as s:
        bad = [
            ("insert into public.email_preferences (user_id, weekly_every_days) values (%s, 5)", [sc.alice.actor.uid]),
            ("insert into public.email_preferences (user_id, weekly_every_days) values (%s, 7)", [sc.alice.actor.uid]),
            ("insert into public.email_preferences (user_id, locale) values (%s, 'English')", [sc.alice.actor.uid]),
            ("insert into public.email_preferences (user_id, unsubscribe_token) values (%s, 'short')", [sc.alice.actor.uid]),
            ("insert into public.email_deliveries (user_id, kind, ref) values (%s, 'newsletter', 'x')", [sc.alice.actor.uid]),
            ("insert into public.email_deliveries (user_id, kind, ref, status) values (%s, 'weekly', 'x', 'bounced')", [sc.alice.actor.uid]),
            ("insert into public.email_deliveries (user_id, kind, ref, error_code) values (%s, 'weekly', 'x', 'Bad Code!')", [sc.alice.actor.uid]),
        ]
        outs = [s.run(q + " returning 1", p) for q, p in bad]
    for o in outs:
        assert not o.ok and o.sqlstate == "23514", o


def test_every_function_of_0103_pins_its_search_path(conn):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            """
            select p.proname, p.prosecdef,
                   exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=public, pg_temp')
              from pg_proc p
             where p.pronamespace = 'public'::regnamespace
               and p.proname in ('notify_video_ready', 'notify_storyboard_ready', 'email_prefs_get', 'email_prefs_set',
                                 'email_unsubscribe', 'email_weekly_digest', 'email_claim_ready', 'email_claim_weekly',
                                 'email_complete', 'email_worker_online')
            """)
    assert len(rows) == 10 and all(r[1] and r[2] for r in rows), rows


def test_the_tables_have_rls_on_and_no_policy(conn):
    with as_superuser(conn, commit=False) as s:
        on = s.rows("select relname, relrowsecurity from pg_class where oid in "
                    "('public.email_preferences'::regclass, 'public.email_deliveries'::regclass)")
        pols = s.value("select count(*) from pg_policies where schemaname = 'public' "
                       "and tablename in ('email_preferences', 'email_deliveries')")
    assert len(on) == 2 and all(r[1] for r in on) and pols == 0
