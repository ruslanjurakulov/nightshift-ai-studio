"""Migration 0102: a person's Telegram link is theirs, one-time, and quiet.

What would break without these:

* another person (or the browser) reading a chat id, a link token or the
  outbox, or writing any of those tables directly (a forged link, a message
  queued to somebody else's chat);
* a link token that is guessable, reusable, still valid after it expired, or
  stored in the clear;
* a chat linked without the token: a group chat, or a chat id that is not the
  sender's own, or one already linked to another account;
* two people racing one token and both winning;
* a notification sent twice, to a paused or blocked chat, or retried forever
  after the bot was blocked;
* a failure to queue a message rolling back the notification it reports;
* a browser calling the webhook's or the worker's functions.
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from contextlib import contextmanager

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, as_superuser, user
from sec_notify_channels_0102 import CHAT_ALICE

SERVICE_FUNCTIONS = {
    "notification_link_peek": ["0" * 56],
    "notification_link_consume": ["0" * 56, "1", "x", "private", "1"],
    "notification_channel_mark": ["1", "blocked"],
    "notify_telegram_update_claim": [5],
    "claim_notification_outbox": ["w", 5, 60],
    "complete_notification_outbox": [str(uuid.uuid4()), "w", "sent", None, None, None],
}
USER_FUNCTIONS = {
    "notification_link_start": ["telegram", "en"],
    "notification_channel_disconnect": [str(uuid.uuid4())],
    "notification_channel_set_locale": [str(uuid.uuid4()), "en"],
    "notification_channel_set_paused": [str(uuid.uuid4()), True],
    "notification_pref_set": ["credits_low", "telegram", True],
    "notification_pref_effective": [],
    "notification_test_send": [str(uuid.uuid4())],
}
TABLES = ["notification_channels", "notification_link_tokens", "notification_preferences",
          "notification_outbox", "notify_telegram_updates"]


# ── helpers ─────────────────────────────────────────────────────────────────

def as_role(s, actor):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute(f"set local role {actor.role}")
    return s


def as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def call(s, actor, fn, args):
    """One function call as `actor`; the owner again afterwards."""
    as_role(s, actor)
    out = s.run(f"select public.{fn}({', '.join(['%s'] * len(args))})", args)
    as_owner(s)
    return out


def value(s, actor, fn, args):
    out = call(s, actor, fn, args)
    assert out.ok, out
    return out.rows[0][0]


def new_user(s, sc, name="dora"):
    """A member of org A with an account of their own (rolled back with the test)."""
    u = user(name, f"{name}-{uuid.uuid4().hex[:6]}@a.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning id", [u.uid, u.email])
    s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
           [sc.alice.org, u.uid, u.email])
    return u


def link(s, u, chat, *, locale="en", label="Ana", chat_type="private", from_id=None):
    """The whole happy path: start as the person, consume as the webhook."""
    res = value(s, u, "notification_link_start", ["telegram", locale])
    assert res["ok"], res
    out = value(s, SERVICE, "notification_link_consume", [res["token"], chat, label, chat_type, from_id or chat])
    return res["token"], out


def channel_of(s, chat):
    rows = s.rows("select id, user_id::text, status, label, locale, consecutive_failures, last_error_code "
                  "from public.notification_channels where external_id = %s", [chat])
    return rows[0] if rows else None


def emit(s, u, org, kind="creative_job_completed", ref=None, data=None):
    return s.value("select public.notification_emit(%s, %s, %s, %s, %s::jsonb)",
                   [org, u.uid, kind, ref or str(uuid.uuid4()), json.dumps(data or {"capability": "t2i"})])


def outbox(s, u, status=None):
    q = "select id, event_kind, status, data, locale, attempts, last_error_code from public.notification_outbox where user_id = %s"
    return s.rows(q + (" and status = %s" if status else "") + " order by created_at", [u.uid] + ([status] if status else []))


def claim(s, worker="w1", limit=10):
    as_role(s, SERVICE)
    rows = s.rows("select * from public.claim_notification_outbox(%s, %s, 60)", [worker, limit])
    as_owner(s)
    return rows


# ── who can reach what ──────────────────────────────────────────────────────

def test_a_person_reads_their_own_channel_and_never_the_chat_id(conn, sc):
    with as_superuser(conn, commit=False) as s:
        as_role(s, sc.alice.actor)
        mine = s.rows("select id, kind, status, label from public.notification_channels")
        chat = s.run("select external_id from public.notification_channels")
        star = s.run("select * from public.notification_channels")
        as_owner(s)
        assert len(mine) == 1 and mine[0][2] == "active"
        assert not chat.ok and chat.sqlstate == "42501", "the chat id must not be readable"
        assert not star.ok, "select * would include the chat id"
        as_role(s, sc.bob.actor)
        assert s.rows("select id from public.notification_channels") == []
        assert s.rows("select user_id from public.notification_preferences") == []
        as_owner(s)


@pytest.mark.parametrize("table", TABLES)
def test_no_api_role_writes_any_table_directly(conn, sc, table):
    with as_superuser(conn, commit=False) as s:
        for who in (sc.alice.actor, ANON, SERVICE):
            as_role(s, who)
            for stmt in (f"insert into public.{table} select * from public.{table}",
                         f"update public.{table} set ctid = ctid", f"delete from public.{table}"):
                out = s.run(stmt)
                assert not out.ok or out.rowcount == 0, (who.name, stmt, out)
            as_owner(s)


@pytest.mark.parametrize("table", ["notification_link_tokens", "notification_outbox", "notify_telegram_updates"])
def test_nobody_reads_the_private_tables(conn, sc, table):
    with as_superuser(conn, commit=False) as s:
        for who in (sc.alice.actor, ANON, SERVICE):
            as_role(s, who)
            out = s.run(f"select * from public.{table}")
            as_owner(s)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)


@pytest.mark.parametrize("fn,args", SERVICE_FUNCTIONS.items())
def test_the_webhook_and_worker_functions_are_not_callable_by_a_browser(conn, sc, fn, args):
    with as_superuser(conn, commit=False) as s:
        for who in (sc.alice.actor, ANON):
            out = call(s, who, fn, args)
            assert not out.ok and out.sqlstate == "42501", (fn, who.name, out)
        assert call(s, SERVICE, fn, args).ok, f"{fn} must work for the service key"


@pytest.mark.parametrize("fn,args", USER_FUNCTIONS.items())
def test_the_person_functions_refuse_anon_and_the_service_key(conn, sc, fn, args):
    with as_superuser(conn, commit=False) as s:
        for who in (ANON, SERVICE):
            out = call(s, who, fn, args)
            assert not out.ok and out.sqlstate == "42501", (fn, who.name, out)


# ── linking ─────────────────────────────────────────────────────────────────

def test_link_token_is_random_hashed_and_replaced_by_the_next(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        a = value(s, u, "notification_link_start", ["telegram", "ru"])
        b = value(s, u, "notification_link_start", ["telegram", "uz"])
        assert re.fullmatch(r"[0-9a-f]{56}", a["token"]) and a["token"] != b["token"]
        assert len(a["token"]) <= 64, "Telegram's start parameter allows 64 characters"
        stored = s.rows("select encode(token_hash, 'hex'), locale from public.notification_link_tokens where user_id = %s", [u.uid])
        assert len(stored) == 1, "one pending link per person"
        assert stored[0][1] == "uz"
        assert stored[0][0] == s.value("select encode(sha256(convert_to(%s, 'UTF8')), 'hex')", [b["token"]])
        assert not s.rows("select 1 from public.notification_link_tokens where encode(token_hash, 'escape') like %s", ["%" + b["token"] + "%"])
        old = value(s, SERVICE, "notification_link_peek", [a["token"]])
        assert old["code"] == "invalid", "the replaced token is gone"


def test_link_start_refuses_bad_input_and_rate_limits(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        assert value(s, u, "notification_link_start", ["whatsapp", "en"])["code"] == "bad_request"
        assert value(s, u, "notification_link_start", ["telegram", "DE"])["code"] == "bad_request"
        codes = [value(s, u, "notification_link_start", ["telegram", "en"]).get("code", "ok") for _ in range(7)]
        assert codes[:5] == ["ok"] * 5 and codes[5:] == ["rate_limited"] * 2


def test_consume_connects_a_private_chat_once(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        token, out = link(s, u, "9100001", locale="ru", label="  Ana\n")
        assert out == {"code": "ok", "locale": "ru"}
        ch = channel_of(s, "9100001")
        assert ch[1] == u.uid and ch[2] == "active" and ch[3] == "Ana" and ch[4] == "ru"
        again = value(s, SERVICE, "notification_link_consume", [token, "9100002", "Eve", "private", "9100002"])
        assert again["code"] == "used" and channel_of(s, "9100002") is None, "single use"


def test_consume_refuses_what_is_not_a_private_chat_of_the_sender(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        tok = value(s, u, "notification_link_start", ["telegram", "en"])["token"]
        for chat_type, chat, sender in (("group", "-100123", "-100123"), ("supergroup", "100123", "100123"),
                                        ("private", "9100003", "9100004"), ("private", "-5", "-5"),
                                        ("private", "abc", "abc"), (None, "9100003", "9100003")):
            out = value(s, SERVICE, "notification_link_consume", [tok, chat, "x", chat_type, sender])
            assert out["code"] == "not_private", (chat_type, chat, sender, out)
        assert s.value("select count(*) from public.notification_channels where user_id = %s", [u.uid]) == 0
        assert value(s, SERVICE, "notification_link_peek", [tok])["code"] == "ok", "a refused try does not burn the token"


def test_consume_refuses_unknown_malformed_and_expired_tokens(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        for bad in (None, "", "short", "G" * 56, "0" * 57, "0" * 56):
            assert value(s, SERVICE, "notification_link_consume", [bad, "9100005", "x", "private", "9100005"])["code"] == "invalid"
        tok = value(s, u, "notification_link_start", ["telegram", "en"])["token"]
        s.rows("update public.notification_link_tokens set expires_at = now() - interval '1 second' where user_id = %s returning 1", [u.uid])
        assert value(s, SERVICE, "notification_link_peek", [tok])["code"] == "expired"
        assert value(s, SERVICE, "notification_link_consume", [tok, "9100005", "x", "private", "9100005"])["code"] == "expired"
        assert channel_of(s, "9100005") is None


def test_a_chat_belongs_to_one_account_unless_it_blocked_the_old_one(conn, sc):
    with as_superuser(conn, commit=False) as s:
        a, b = new_user(s, sc, "a1"), new_user(s, sc, "b1")
        assert link(s, a, "9100010")[1]["code"] == "ok"
        assert link(s, b, "9100010")[1]["code"] == "already_linked"
        assert channel_of(s, "9100010")[1] == a.uid
        value(s, SERVICE, "notification_channel_mark", ["9100010", "blocked"])
        assert link(s, b, "9100010")[1]["code"] == "ok"
        assert channel_of(s, "9100010")[1] == b.uid, "the person in the chat decides after a block"


def test_linking_again_from_the_same_account_reactivates_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100011")
        value(s, SERVICE, "notification_channel_mark", ["9100011", "blocked"])
        assert channel_of(s, "9100011")[2] == "blocked"
        assert link(s, u, "9100011")[1]["code"] == "ok"
        ch = channel_of(s, "9100011")
        assert ch[2] == "active" and ch[5] == 0 and ch[6] is None
        assert s.value("select count(*) from public.notification_channels where user_id = %s", [u.uid]) == 1


def test_at_most_three_chats_per_person(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        for i in range(3):
            assert link(s, u, f"91001{20 + i}")[1]["code"] == "ok"
        assert value(s, u, "notification_link_start", ["telegram", "en"])["code"] == "limit"


def test_peek_shows_the_handle_not_the_email_and_does_not_use_the_token_up(conn, sc):
    with as_superuser(conn, commit=False) as s:
        tok = value(s, sc.alice.actor, "notification_link_start", ["telegram", "uz"])["token"]
        out = value(s, SERVICE, "notification_link_peek", [tok])
        assert out == {"code": "ok", "locale": "uz", "handle": "alice.lab"}
        assert "@" not in json.dumps(out), "a @username label, never an e-mail address"
        assert value(s, SERVICE, "notification_link_peek", [tok])["code"] == "ok"


def test_two_presses_of_one_token_have_one_winner(lab):
    conn, sc = lab
    dsn = sec_db.psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)
    u = user("racer", f"racer-{uuid.uuid4().hex[:6]}@a.test")
    try:
        with as_superuser(conn) as s:
            s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning id", [u.uid, u.email])
            s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
                   [sc.alice.org, u.uid, u.email])
            res = value(s, u, "notification_link_start", ["telegram", "en"])
        results, barrier = [], threading.Barrier(2)

        def press(chat):
            with psycopg.connect(dsn, autocommit=True) as c:
                barrier.wait()
                with c.transaction():
                    c.execute("set local role service_role")
                    results.append(c.execute("select public.notification_link_consume(%s, %s, 'x', 'private', %s)",
                                             [res["token"], chat, chat]).fetchone()[0]["code"])

        threads = [threading.Thread(target=press, args=(c,)) for c in ("9100031", "9100032")]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert sorted(results) == ["ok", "used"], results
        with as_superuser(conn, commit=False) as s:
            assert s.value("select count(*) from public.notification_channels where user_id = %s", [u.uid]) == 1
    finally:
        with as_superuser(conn) as s:
            s.rows("delete from auth.users where id = %s returning 1", [u.uid])


# ── the person's controls ───────────────────────────────────────────────────

def test_disconnect_pause_locale_touch_only_the_callers_own_channel(conn, sc):
    with as_superuser(conn, commit=False) as s:
        a, b = new_user(s, sc, "a2"), new_user(s, sc, "b2")
        link(s, a, "9100040")
        link(s, b, "9100041")
        ida, idb = channel_of(s, "9100040")[0], channel_of(s, "9100041")[0]
        for fn, args in (("notification_channel_disconnect", [idb]), ("notification_channel_set_locale", [idb, "uz"]),
                         ("notification_channel_set_paused", [idb, True])):
            assert value(s, a, fn, args) is False, f"{fn}: a foreign id reads false"
        assert value(s, a, "notification_channel_disconnect", [str(uuid.uuid4())]) is False
        assert channel_of(s, "9100041")[2] == "active" and channel_of(s, "9100041")[4] == "en"
        assert value(s, a, "notification_channel_set_locale", [ida, "de1x"]) is False
        assert value(s, a, "notification_channel_set_locale", [ida, "ru"]) is True
        assert value(s, a, "notification_channel_set_paused", [ida, True]) is True
        assert channel_of(s, "9100040")[2] == "paused"
        assert value(s, a, "notification_channel_set_paused", [ida, False]) is True
        value(s, SERVICE, "notification_channel_mark", ["9100040", "blocked"])
        assert value(s, a, "notification_channel_set_paused", [ida, False]) is False, "a blocked chat is not resumed from the page"
        assert value(s, a, "notification_channel_disconnect", [ida]) is True
        assert channel_of(s, "9100040") is None


def test_disconnect_takes_the_queued_messages_with_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100042")
        emit(s, u, sc.alice.org)
        assert len(outbox(s, u, "pending")) == 1
        value(s, u, "notification_channel_disconnect", [channel_of(s, "9100042")[0]])
        assert outbox(s, u) == []


def test_preferences_default_on_for_telegram_and_follow_the_person(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        grid = value(s, u, "notification_pref_effective", [])
        assert [g["event"] for g in grid] == ["creative_job_completed", "creative_job_failed", "storyboard_ready",
                                              "editor_export_done", "credits_low", "video_ready"]
        assert all(g["enabled"] and g["channel"] == "telegram" for g in grid)
        assert value(s, u, "notification_pref_set", ["credits_low", "telegram", False]) is True
        assert [g["enabled"] for g in value(s, u, "notification_pref_effective", [])][4] is False
        assert value(s, u, "notification_pref_set", ["credits_low", "telegram", True]) is True
        for bad in (("nope", "telegram", True), ("credits_low", "sms", True), ("credits_low", "email", True),
                    ("credits_low", "telegram", None)):
            assert value(s, u, "notification_pref_set", list(bad)) is False, bad
        assert s.value("select count(*) from public.notification_preferences where user_id = %s", [u.uid]) == 1


def test_test_message_goes_to_an_own_active_chat_three_an_hour(conn, sc):
    with as_superuser(conn, commit=False) as s:
        a, b = new_user(s, sc, "a3"), new_user(s, sc, "b3")
        link(s, a, "9100050")
        cid = channel_of(s, "9100050")[0]
        assert value(s, b, "notification_test_send", [cid]) == "not_found"
        assert [value(s, a, "notification_test_send", [cid]) for _ in range(4)] == ["ok", "ok", "ok", "rate_limited"]
        assert [r[1] for r in outbox(s, a)] == ["test"] * 3
        value(s, a, "notification_channel_set_paused", [cid, True])
        assert value(s, a, "notification_test_send", [cid]) == "not_active"


# ── fan-out ─────────────────────────────────────────────────────────────────

def test_a_notification_queues_one_message_per_active_channel_with_only_ids(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100060", locale="uz")
        data = {"capability": "t2i", "job_id": str(uuid.uuid4()), "credits_charged": 6}
        assert emit(s, u, sc.alice.org, data=data, ref="job-1") is True
        rows = outbox(s, u)
        assert len(rows) == 1
        assert rows[0][1:3] == ("creative_job_completed", "pending") and rows[0][3] == data and rows[0][4] == "uz"
        # the same notification again is not queued twice
        assert emit(s, u, sc.alice.org, data=data, ref="job-1") is False
        assert len(outbox(s, u)) == 1


def test_the_fanout_key_makes_a_second_fanout_of_one_notification_a_no_op(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100061")
        emit(s, u, sc.alice.org, ref="job-2")
        nid = s.value("select id from public.notifications where user_id = %s", [u.uid])
        out = s.run("insert into public.notification_outbox (notification_id, user_id, channel_id, channel_kind, event_kind, "
                    "idempotency_key) select notification_id, user_id, channel_id, channel_kind, event_kind, idempotency_key "
                    "from public.notification_outbox where user_id = %s", [u.uid])
        assert not out.ok and out.sqlstate == "23505" and nid


def test_nothing_is_queued_for_a_disabled_event_a_paused_or_blocked_chat_or_no_chat(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        emit(s, u, sc.alice.org)
        assert outbox(s, u) == [], "no chat linked"
        link(s, u, "9100062")
        cid = channel_of(s, "9100062")[0]
        value(s, u, "notification_pref_set", ["credits_low", "telegram", False])
        emit(s, u, sc.alice.org, kind="credits_low", data={"available": 3})
        assert outbox(s, u) == [], "event switched off"
        value(s, u, "notification_channel_set_paused", [cid, True])
        emit(s, u, sc.alice.org, kind="creative_job_failed", data={"code": "x"})
        assert outbox(s, u) == [], "paused"
        value(s, u, "notification_channel_set_paused", [cid, False])
        value(s, SERVICE, "notification_channel_mark", ["9100062", "blocked"])
        emit(s, u, sc.alice.org, kind="storyboard_ready", data={})
        assert outbox(s, u) == [], "blocked"


def test_at_most_thirty_a_hour_per_chat_the_rest_are_recorded_as_skipped(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100063")
        for _ in range(33):
            emit(s, u, sc.alice.org)
        assert len(outbox(s, u, "pending")) == 30
        skipped = outbox(s, u, "skipped")
        assert len(skipped) == 3 and {r[6] for r in skipped} == {"capped"}


def test_a_queue_failure_never_loses_the_notification_it_reports(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100064")
        s.conn.execute("alter table public.notification_outbox add constraint ns_test_break check (false) not valid")
        assert emit(s, u, sc.alice.org, ref="job-3") is True
        assert s.value("select count(*) from public.notifications where user_id = %s", [u.uid]) == 1
        assert outbox(s, u) == []


# ── the worker ──────────────────────────────────────────────────────────────

def test_claim_hands_a_message_to_one_worker_with_the_chat_id(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100070", locale="ru")
        emit(s, u, sc.alice.org)
        got = claim(s, "w1")
        mine = [r for r in got if r[2] == "9100070"]
        assert len(mine) == 1 and mine[0][3] == "ru" and mine[0][4] == "creative_job_completed" and mine[0][6] == 1
        assert [r for r in claim(s, "w2") if r[2] == "9100070"] == [], "a claimed message is not handed out twice"


def test_only_the_lease_holder_settles_a_message_and_a_sent_one_stays_sent(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100071")
        emit(s, u, sc.alice.org)
        mid = [r for r in claim(s, "w1") if r[2] == "9100071"][0][0]
        assert value(s, SERVICE, "complete_notification_outbox", [mid, "intruder", "sent", None, None, None]) is False
        assert value(s, SERVICE, "complete_notification_outbox", [mid, "w1", "sent", None, None, "42"]) is True
        assert value(s, SERVICE, "complete_notification_outbox", [mid, "w1", "sent", None, None, "42"]) is False
        row = outbox(s, u)[0]
        assert row[2] == "sent"
        assert s.value("select last_ok_at is not null from public.notification_channels where external_id = '9100071'")


def test_a_blocked_bot_marks_the_chat_blocked_and_never_retries(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100072")
        emit(s, u, sc.alice.org)
        emit(s, u, sc.alice.org)
        first = [r for r in claim(s, "w1", 1) if r[2] == "9100072"][0][0]
        assert value(s, SERVICE, "complete_notification_outbox", [first, "w1", "blocked", "blocked", None, None]) is True
        assert channel_of(s, "9100072")[2] == "blocked"
        assert sorted(r[2] for r in outbox(s, u)) == ["dead", "skipped"], "the queued one is dropped, not retried"
        assert [r for r in claim(s, "w1") if r[2] == "9100072"] == []


def test_retries_back_off_honour_retry_after_and_end_dead(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100073")
        emit(s, u, sc.alice.org)
        for n in range(1, 6):
            mid = [r for r in claim(s, "w1") if r[2] == "9100073"][0][0]
            assert value(s, SERVICE, "complete_notification_outbox", [mid, "w1", "retry", "http_5xx", None, None]) is True
            wait = s.value("select extract(epoch from next_attempt_at - now()) from public.notification_outbox where id = %s", [mid])
            assert 30 * 2 ** (n - 1) - 1 <= wait <= min(30 * 2 ** (n - 1), 3600) + 6, (n, wait)
            s.rows("update public.notification_outbox set next_attempt_at = now() where id = %s returning 1", [mid])
        mid = [r for r in claim(s, "w1") if r[2] == "9100073"][0][0]
        assert value(s, SERVICE, "complete_notification_outbox", [mid, "w1", "retry", "http_5xx", None, None]) is True
        assert outbox(s, u)[0][2] == "dead", "six attempts, then it stops"
        assert channel_of(s, "9100073")[2] == "active", "a flaky network does not unlink the chat"


def test_rate_limited_waits_retry_after_without_using_an_attempt(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100074")
        emit(s, u, sc.alice.org)
        mid = [r for r in claim(s, "w1") if r[2] == "9100074"][0][0]
        value(s, SERVICE, "complete_notification_outbox", [mid, "w1", "retry", "rate_limited", 120, None])
        row = s.rows("select attempts, extract(epoch from next_attempt_at - now()) from public.notification_outbox where id = %s", [mid])[0]
        assert row[0] == 0 and 119 <= row[1] <= 126


def test_a_lost_claim_is_never_sent_again_and_old_messages_expire(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100075")
        emit(s, u, sc.alice.org)
        emit(s, u, sc.alice.org)
        mid = [r for r in claim(s, "w1", 1) if r[2] == "9100075"][0][0]
        s.rows("update public.notification_outbox set claimed_until = now() - interval '1 second' where id = %s returning 1", [mid])
        s.rows("update public.notification_outbox set created_at = now() - interval '25 hours' where user_id = %s and id <> %s returning 1", [u.uid, mid])
        assert [r for r in claim(s, "w2") if r[2] == "9100075"] == []
        got = {r[0]: r[6] for r in outbox(s, u)}
        assert sorted(got.values()) == ["expired", "unconfirmed"]


def test_a_chat_that_was_paused_after_queueing_is_skipped_at_claim(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100076")
        emit(s, u, sc.alice.org)
        value(s, u, "notification_channel_set_paused", [channel_of(s, "9100076")[0], True])
        assert [r for r in claim(s, "w1") if r[2] == "9100076"] == []
        assert outbox(s, u)[0][2] == "skipped" and outbox(s, u)[0][6] == "channel_inactive"


def test_chat_signals_block_pause_resume_unblock_and_replays_are_ignored(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100077", locale="uz")
        mark = lambda a: value(s, SERVICE, "notification_channel_mark", ["9100077", a])  # noqa: E731
        assert mark("paused") == "uz" and channel_of(s, "9100077")[2] == "paused"
        assert mark("unblocked") == "uz" and channel_of(s, "9100077")[2] == "paused", "unblock does not lift a pause"
        assert mark("resume") == "uz" and channel_of(s, "9100077")[2] == "active"
        assert mark("blocked") == "uz" and channel_of(s, "9100077")[2] == "blocked"
        assert mark("resume") == "uz" and channel_of(s, "9100077")[2] == "blocked", "resume does not lift a block"
        assert mark("unblocked") == "uz" and channel_of(s, "9100077")[2] == "active"
        assert value(s, SERVICE, "notification_channel_mark", ["123456", "blocked"]) is None
        assert value(s, SERVICE, "notification_channel_mark", ["9100077", "drop table"]) is None
        assert value(s, SERVICE, "notify_telegram_update_claim", [777001]) is True
        assert value(s, SERVICE, "notify_telegram_update_claim", [777001]) is False
        assert value(s, SERVICE, "notify_telegram_update_claim", [-1]) is False


def test_a_real_generation_that_finishes_reaches_the_outbox_through_the_0064_trigger(conn, sc):
    from test_sec_notifications import new_job, set_status

    with as_superuser(conn, commit=False) as s:
        job = new_job(s, sc.alice, sc.alice.actor.uid)
        set_status(s, job, "completed", charged_credits=6)
        rows = s.rows("select event_kind, data, status from public.notification_outbox where user_id = %s and event_kind = 'creative_job_completed'",
                      [sc.alice.actor.uid])
        assert len(rows) == 1 and rows[0][2] == "pending"
        assert set(rows[0][1]) <= {"job_id", "capability", "credits_charged"}, "ids and numbers only, never the prompt"
        assert "secret" not in json.dumps(rows[0][1]), "the job's prompt must not travel"
        # Bob has no chat linked: the same event for him queues nothing.
        job_b = new_job(s, sc.bob, sc.bob.actor.uid)
        set_status(s, job_b, "completed", charged_credits=6)
        assert s.value("select count(*) from public.notification_outbox where user_id = %s", [sc.bob.actor.uid]) == 0


def test_a_person_who_left_the_organization_is_not_sent_what_was_queued_for_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100080")
        emit(s, u, sc.alice.org)
        emit(s, u, sc.alice.org)
        assert s.rows("select org_id::text from public.notification_outbox where user_id = %s limit 1", [u.uid])[0][0] == sc.alice.org
        s.rows("delete from public.org_members where org_id = %s and user_id = %s returning 1", [sc.alice.org, u.uid])
        assert [r for r in claim(s, "w1") if r[2] == "9100080"] == []
        rows = outbox(s, u)
        assert {r[2] for r in rows} == {"skipped"} and {r[6] for r in rows} == {"not_member"}


def test_a_test_message_has_no_organization_and_is_not_held_back_by_membership(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100081")
        assert value(s, u, "notification_test_send", [channel_of(s, "9100081")[0]]) == "ok"
        s.rows("delete from public.org_members where user_id = %s returning 1", [u.uid])
        assert len([r for r in claim(s, "w1") if r[2] == "9100081"]) == 1


def test_a_refused_bot_token_waits_without_using_attempts_or_ending_the_queue(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9100082")
        emit(s, u, sc.alice.org)
        for _ in range(9):
            mid = [r for r in claim(s, "w1") if r[2] == "9100082"][0][0]
            assert value(s, SERVICE, "complete_notification_outbox", [mid, "w1", "retry", "not_configured", 300, None]) is True
            row = s.rows("select status, attempts, extract(epoch from next_attempt_at - now()) from public.notification_outbox where id = %s", [mid])[0]
            assert row[0] == "pending" and row[1] == 0 and 299 <= row[2] <= 306
            s.rows("update public.notification_outbox set next_attempt_at = now() where id = %s returning 1", [mid])
        assert channel_of(s, "9100082")[2] == "active"
