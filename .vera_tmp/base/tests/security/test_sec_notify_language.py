"""Migration 0105: the language of the customer notifications is a choice from a
fixed list, it is the person's own, and it reaches the worker that writes in it.

What would break without these:

* a forged row (or a function argument) holding a language the registry does not
  list: a bot or a mail with no words, a path, a link or HTML built from a
  hostile string;
* the bot's /language changing the language of a chat that is not the sender's,
  or of a chat nobody linked;
* a browser (or the anon key) calling the bot's function, or reading or writing a
  language column it has no grant on;
* the app's own language report undoing the language the person picked for their
  e-mails;
* a message queued before the change still arriving in the old language;
* one person's choice changing another person's row.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from sec_db import ANON, SERVICE, as_superuser
from test_sec_notify_channels import as_owner, as_role, call, channel_of, emit, link, new_user, outbox, value
from test_sec_retention import claim_ready, hold, prefs_row, set_prefs

REGISTRY = json.loads((Path(__file__).resolve().parents[2] / "supabase" / "functions" / "_shared" / "notify-i18n"
                       / "registry.json").read_text(encoding="utf-8"))
CODES = [e["code"] for e in REGISTRY["languages"]]
BAD = ["de", "EN", "en_US", "", " ru", "ru ", "rus", "x", "'; drop table x; --", "../x", "<script>"]


# ── the allow-list ──────────────────────────────────────────────────────────

def test_the_allow_list_is_exactly_the_registry(conn, sc):
    with as_superuser(conn, commit=False) as s:
        for code in CODES:
            assert s.value("select public.notify_language_ok(%s)", [code]) is True, code
        for bad in BAD:
            assert s.value("select public.notify_language_ok(%s)", [bad]) is False, bad
        assert s.value("select public.notify_language_ok(null)") is False


@pytest.mark.parametrize("who", ["alice", "anon", "service"])
def test_nobody_but_the_database_calls_the_allow_list(conn, sc, who):
    actor = {"alice": sc.alice.actor, "anon": ANON, "service": SERVICE}[who]
    with as_superuser(conn, commit=False) as s:
        out = call(s, actor, "notify_language_ok", ["en"])
        assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("table,cols,values", [
    ("notification_channels", "user_id, kind, external_id, locale", "%s, 'telegram', '7000111', %s"),
    ("notification_link_tokens", "user_id, kind, token_hash, locale, expires_at",
     "%s, 'telegram', sha256(convert_to('t', 'UTF8')), %s, now() + interval '1 minute'"),
    ("email_preferences", "user_id, locale", "%s, %s"),
])
def test_a_forged_row_cannot_hold_a_language_the_registry_does_not_list(conn, sc, table, cols, values):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc, "forger")
        for bad in BAD:
            out = s.run(f"insert into public.{table} ({cols}) values ({values})", [u.uid, bad])
            assert not out.ok and out.sqlstate == "23514", (table, bad, out)
        for code in CODES:
            s.conn.execute("savepoint ok")
            out = s.run(f"insert into public.{table} ({cols}) values ({values})", [u.uid, code])
            assert out.ok, (table, code, out)
            s.conn.execute("rollback to savepoint ok")


def test_a_queued_message_cannot_hold_an_unlisted_language_either(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9300001")
        cid = channel_of(s, "9300001")[0]
        out = s.run("insert into public.notification_outbox (user_id, channel_id, channel_kind, event_kind, locale, idempotency_key) "
                    "values (%s, %s, 'telegram', 'test', 'de', 'k-bad')", [u.uid, cid])
        assert not out.ok and out.sqlstate == "23514", out
        out = s.run("update public.notification_channels set locale = 'de' where id = %s", [cid])
        assert not out.ok and out.sqlstate == "23514", out


def test_a_browser_cannot_write_or_read_the_language_columns_it_has_no_grant_on(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9300002")
        for who in (u, ANON, SERVICE):
            as_role(s, who)
            for stmt in ("update public.notification_channels set locale = 'xx'",
                         "update public.email_preferences set locale = 'xx', locale_chosen = true",
                         "select locale_chosen from public.email_preferences",
                         "select locale from public.email_preferences",
                         "select locale from public.notification_outbox"):
                out = s.run(stmt)
                assert (not out.ok and out.sqlstate == "42501") or (out.ok and out.rowcount == 0), (who.name, stmt, out)
            as_owner(s)
        # The person reads the language of their OWN chat through the column grant of 0102, as before.
        as_role(s, u)
        mine = s.rows("select locale from public.notification_channels")
        as_owner(s)
        assert mine == [("en",)]


# ── Telegram ────────────────────────────────────────────────────────────────

def test_linking_starts_only_in_a_listed_language_and_keeps_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        for bad in BAD:
            res = value(s, u, "notification_link_start", ["telegram", bad])
            assert res == {"ok": False, "code": "bad_request"}, bad
        for code in CODES:
            link(s, u, f"93100{CODES.index(code)}", locale=code)
            assert channel_of(s, f"93100{CODES.index(code)}")[4] == code


def test_the_persons_own_selector_changes_their_channel_and_what_is_still_waiting(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u, other = new_user(s, sc, "mine"), new_user(s, sc, "other")
        link(s, u, "9300010", locale="en")
        link(s, other, "9300011", locale="en")
        mine, theirs = channel_of(s, "9300010")[0], channel_of(s, "9300011")[0]
        emit(s, u, sc.alice.org)
        emit(s, other, sc.alice.org)
        assert [r[4] for r in outbox(s, u, "pending")] == ["en"]
        for bad in BAD:
            assert value(s, u, "notification_channel_set_locale", [mine, bad]) is False, bad
        assert value(s, u, "notification_channel_set_locale", [theirs, "uz"]) is False, "a foreign channel reads false"
        assert value(s, u, "notification_channel_set_locale", [mine, "uz"]) is True
        assert channel_of(s, "9300010")[4] == "uz" and channel_of(s, "9300011")[4] == "en"
        assert [r[4] for r in outbox(s, u, "pending")] == ["uz"], "a message still waiting follows the new language"
        assert [r[4] for r in outbox(s, other, "pending")] == ["en"]


def test_a_message_the_worker_already_holds_keeps_the_language_it_was_claimed_in(conn, sc):
    with as_superuser(conn, commit=False) as s:
        u = new_user(s, sc)
        link(s, u, "9300012", locale="ru")
        emit(s, u, sc.alice.org)
        as_role(s, SERVICE)
        mine = [r for r in s.rows("select * from public.claim_notification_outbox('w-lang', 50, 60)") if r[2] == "9300012"]
        as_owner(s)
        assert [r[3] for r in mine] == ["ru"]
        cid = channel_of(s, "9300012")[0]
        assert value(s, u, "notification_channel_set_locale", [cid, "en"]) is True
        assert [r[4] for r in outbox(s, u, "sending")] == ["ru"]


def test_the_bots_language_function_reads_and_changes_only_the_chat_it_is_asked_about(conn, sc):
    with as_superuser(conn, commit=False) as s:
        a, b = new_user(s, sc, "ba"), new_user(s, sc, "bb")
        link(s, a, "9300020", locale="en")
        link(s, b, "9300021", locale="ru")
        fn = "notification_channel_set_locale_by_chat"
        assert value(s, SERVICE, fn, ["9300020", None]) == "en", "no language given: it only reads"
        assert value(s, SERVICE, fn, ["9300021"]) == "ru"
        assert value(s, SERVICE, fn, ["9300020", "uz"]) == "uz"
        assert channel_of(s, "9300020")[4] == "uz" and channel_of(s, "9300021")[4] == "ru"
        emit(s, a, sc.alice.org)
        assert value(s, SERVICE, fn, ["9300020", "ru"]) == "ru"
        assert [r[4] for r in outbox(s, a, "pending")] == ["ru"]


def test_the_bots_language_function_refuses_what_it_cannot_trust(conn, sc):
    fn = "notification_channel_set_locale_by_chat"
    with as_superuser(conn, commit=False) as s:
        a = new_user(s, sc, "bc")
        link(s, a, "9300030", locale="en")
        for bad in BAD:
            assert value(s, SERVICE, fn, ["9300030", bad]) is None, bad
        assert channel_of(s, "9300030")[4] == "en", "a refused language changes nothing"
        for chat in (None, "", "0x1", "-1", "93000 30", "9300030; drop", "9" * 21, "9300999"):
            assert value(s, SERVICE, fn, [chat, "ru"]) is None, chat
        assert value(s, SERVICE, fn, ["9300030", "ru"]) == "ru"


@pytest.mark.parametrize("who", ["alice", "anon"])
def test_a_browser_cannot_call_the_bots_language_function(conn, sc, who):
    actor = {"alice": sc.alice.actor, "anon": ANON}[who]
    with as_superuser(conn, commit=False) as s:
        out = call(s, actor, "notification_channel_set_locale_by_chat", ["9300040", "ru"])
        assert not out.ok and out.sqlstate == "42501", out


# ── e-mail ──────────────────────────────────────────────────────────────────

def test_the_email_language_is_chosen_by_the_person_and_stays_chosen(conn, sc):
    with as_superuser(conn, commit=False) as s:
        uid = sc.alice.actor.uid
        set_prefs(s, sc.alice.actor, locale="ru")  # the app's report is the default
        got = value(s, sc.alice.actor, "email_prefs_get", [])
        assert got["locale"] == "ru" and got["locale_chosen"] is False
        assert value(s, sc.alice.actor, "email_prefs_set_language", ["uz"])["locale"] == "uz"
        got = value(s, sc.alice.actor, "email_prefs_get", [])
        assert got["locale"] == "uz" and got["locale_chosen"] is True
        out = set_prefs(s, sc.alice.actor, ready=False, locale="en")  # a later report does not undo the choice
        assert out.ok, out
        row = prefs_row(s, uid)[0]
        assert row[0] is False and row[3] == "uz"
        assert value(s, sc.alice.actor, "email_prefs_set_language", ["en"])["locale"] == "en", "the person may change their mind"


def test_a_row_with_no_choice_still_follows_the_apps_language(conn, sc):
    with as_superuser(conn, commit=False) as s:
        set_prefs(s, sc.alice.actor, locale="uz")
        set_prefs(s, sc.alice.actor, locale="ru")
        assert prefs_row(s, sc.alice.actor.uid)[0][3] == "ru"


@pytest.mark.parametrize("bad", BAD + [None])
def test_the_email_language_functions_refuse_an_unlisted_language(conn, sc, bad):
    with as_superuser(conn, commit=False) as s:
        out = call(s, sc.alice.actor, "email_prefs_set_language", [bad])
        assert not out.ok and out.sqlstate == "22023", out
        if bad is not None:
            out = set_prefs(s, sc.alice.actor, locale=bad)
            assert not out.ok and out.sqlstate == "22023", out
        assert prefs_row(s, sc.alice.actor.uid) == [] or prefs_row(s, sc.alice.actor.uid)[0][3] == "en"


@pytest.mark.parametrize("who", ["anon", "service"])
def test_only_a_signed_in_person_picks_an_email_language(conn, sc, who):
    actor = {"anon": ANON, "service": SERVICE}[who]
    with as_superuser(conn, commit=False) as s:
        out = call(s, actor, "email_prefs_set_language", ["ru"])
        assert not out.ok and out.sqlstate == "42501", out


def test_one_persons_choice_never_changes_another_persons_row(conn, sc):
    with as_superuser(conn, commit=False) as s:
        value(s, sc.alice.actor, "email_prefs_set_language", ["uz"])
        assert value(s, sc.bob.actor, "email_prefs_get", []) == {
            "ready": True, "weekly_every_days": None, "locale": "en", "locale_chosen": False, "stored": False}
        assert prefs_row(s, sc.bob.actor.uid) == []


def test_the_mail_the_worker_is_handed_is_in_the_chosen_language(conn, sc):
    with as_superuser(conn, commit=False) as s:
        value(s, sc.alice.actor, "email_prefs_set_language", ["uz"])
        set_prefs(s, sc.alice.actor, locale="ru")
        hold(s, sc.alice.channel, "run-lang-1")
        mine = claim_ready(s, sc.alice.actor.uid)
    assert [m["locale"] for m in mine] == ["uz"]


def test_the_migration_is_idempotent_and_additive_in_its_text():
    text = (Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "0105_notify_language.sql").read_text(encoding="utf-8")
    assert re.search(r"add column if not exists locale_chosen", text)
    assert "drop table" not in text.lower() and "drop column" not in text.lower()
    assert not re.search(r"grant\s+(select|insert|update|delete)[^;]*\bto\s+(anon|authenticated|service_role)", text, re.I), \
        "0105 gives no table privilege to any API role"
