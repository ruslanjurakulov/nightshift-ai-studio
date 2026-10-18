"""Migration 0109: operator_marketing_summary(), the operator bot's read of the brand-channel poster.

What must hold:

  * only the service key can run it (anon, a signed-in customer, a signed-in platform ADMIN, all refused: the bot is the
    one caller, and a browser has owner_marketing_get() instead);
  * the answer is counts, kinds and closed codes, and NEVER a word a post says, a link, a media path, a key, an id, a
    chat or a hash, whatever the posts contain;
  * the counts are the truth (checked against a separate count taken as the database owner), the week's use equals
    marketing_cap_used(), the switch and the cap are the settings', the last sent and last failed are the newest;
  * it writes nothing, takes no table grant with it, changes no existing function (audit_action_allowed included);
  * it replays, and its rollback file removes exactly it.

Helpers are the ones of test_sec_marketing_posts.py (same rolled-back transaction per test).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from sec_db import ANON, REPO, SERVICE, as_superuser
from test_sec_marketing_posts import (approve, approved, claim, complete, draft, enable, raw, run, status)
from test_sec_owner_safety import tx

MIGRATION = REPO / "supabase" / "migrations" / "0109_operator_marketing_summary.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0109_operator_marketing_summary.sql"
CALL = "select public.operator_marketing_summary()"
SIGNATURE = "public.operator_marketing_summary()"

STATUSES = ("draft", "approved", "sending", "sent", "failed", "dead", "rejected", "expired")
KEYS = {"ok", "counts", "used_7d", "max_per_7d", "enabled", "last_sent_at", "last_sent_kind", "last_failure"}
FAILURE_KEYS = {"status", "last_error_code", "kind", "at"}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

# Words that must never come back out: every one of them is stored in a post below.
LEAK = {"uz": "Maxfiy-uz-sozlar", "ru": "Секретный-ru-текст", "en": "Secret-en-words"}
LEAK_LINK = "/leak-link-path"
LEAK_MEDIA = "showcase/leak-media-file.mp4"
LEAK_KEY = "news:leak-key-1"


def summary(t):
    out = t.as_(SERVICE).run(CALL)
    assert out.ok, out
    return out.rows[0][0]


def truth(t):
    """The count per status, taken as the database owner."""
    rows = t.sup("select status, count(*) from public.marketing_posts group by status")
    return {s: next((n for st, n in rows if st == s), 0) for s in STATUSES}


def when(t, pid, sent_at=None, updated_at=None):
    """Set a post's times directly (the replica role skips the guard trigger, which would stamp now())."""
    if sent_at:
        raw(t, "update public.marketing_posts set sent_at = %s where id = %s", [sent_at, pid])
    if updated_at:
        raw(t, "update public.marketing_posts set updated_at = %s where id = %s", [updated_at, pid])


def wipe(t):
    """No post at all (the scenario seeds one draft): the replica role skips the no-delete trigger."""
    raw(t, "delete from public.marketing_posts")


@pytest.fixture
def op(sc):
    return sc.operator


# ── who may call it ─────────────────────────────────────────────────────────

def test_only_the_service_key_can_run_it(conn, sc):
    with tx(conn) as t:
        out = t.anon().run(CALL)
        assert not out.ok and out.sqlstate == "42501", out
        # a customer, a customer's member, a stranger and the PLATFORM ADMIN: the bot is the one caller
        for who in (sc.bob.actor, sc.alice.actor, sc.dana, sc.stranger, sc.operator):
            out = t.as_(who).run(CALL)
            assert not out.ok and out.sqlstate == "42501", (getattr(who, "name", who), out)
        out = t.as_(SERVICE).run(CALL)
        assert out.ok, out


def test_the_privileges_are_service_role_alone(conn):
    with as_superuser(conn, commit=False) as s:
        assert [s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [r, SIGNATURE])
                for r in ("anon", "authenticated", "service_role")] == [False, False, True]
        # no grant to public either (a default grant would reach every role)
        acl = s.value("select proacl::text from pg_proc where oid = %s::regprocedure", [SIGNATURE])
        grantees = {entry.split("=")[0] for entry in acl.strip("{}").split(",")}
        assert grantees == {"postgres", "service_role"}, acl      # the owner and the service key; the empty grantee is PUBLIC


def test_the_service_key_still_has_no_table_grant_it_only_has_the_function(conn):
    with as_superuser(conn, commit=False) as s:
        for table in ("marketing_posts", "marketing_settings", "showcase_assets"):
            assert s.value("select has_table_privilege('service_role', %s, 'SELECT')", [f"public.{table}"]) is False, table
        assert s.value("select has_table_privilege('authenticated', 'public.marketing_posts', 'SELECT')") is True   # 0108, the admin read


def test_it_is_a_definer_with_a_pinned_search_path_and_reads_only(conn):
    with as_superuser(conn, commit=False) as s:
        row = s.rows("select prosecdef, provolatile, coalesce(proconfig, '{}') from pg_proc where oid = %s::regprocedure", [SIGNATURE])[0]
        assert row[0] is True and row[1] == "s", row            # security definer, STABLE: the database refuses a write
        assert "search_path=public, pg_temp" in row[2], row


def test_a_hijacked_search_path_does_not_change_what_it_reads(conn, sc):
    # A caller who puts their own schema first still reaches the real tables: the function pins its own path.
    with tx(conn) as t:
        t.conn.execute("reset role")
        t.conn.execute("create schema if not exists evil")
        t.conn.execute("create table evil.marketing_posts (status text, kind text, sent_at timestamptz, updated_at timestamptz, last_error_code text)")
        t.conn.execute("insert into evil.marketing_posts values ('sent', 'price', now(), now(), null)")
        t.conn.execute("grant usage on schema evil to service_role")
        t.conn.execute("grant select on evil.marketing_posts to service_role")
        t.conn.execute("set local search_path = evil, public")
        out = t.as_(SERVICE).run(CALL)
        assert out.ok, out
        assert out.rows[0][0]["last_sent_at"] is None, out.rows[0][0]    # the evil table's 'sent' row was not read


# ── what it says ────────────────────────────────────────────────────────────

def test_the_answer_has_exactly_these_keys_and_nothing_a_post_says(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        t.as_(SERVICE).value("select public.marketing_draft_upsert(%s, 'showcase', %s::jsonb, %s, '{}'::jsonb, null, %s, 'telegram', %s)",
                             ["showcase:leak-key-1", json.dumps(LEAK), "asset:00000000-0000-0000-0000-0000000000ee", LEAK_MEDIA, LEAK_LINK])
        pid = draft(t, LEAK_KEY, LEAK, pr=777)
        assert approve(t, op, pid)["ok"]
        got = claim(t)
        assert len(got) == 1
        assert complete(t, got[0][0], "worker-1", "sent", mid="leak-provider-99") is True
        d2 = draft(t, "news:leak-key-2", LEAK, pr=778)
        assert approve(t, op, d2)["ok"]
        assert claim(t, "worker-2")
        assert complete(t, d2, "worker-2", "dead") is True
        out = summary(t)
        assert set(out) == KEYS
        assert set(out["counts"]) == set(STATUSES)
        assert set(out["last_failure"]) == FAILURE_KEYS
        text = json.dumps(out, ensure_ascii=False)
        for secret in (*LEAK.values(), LEAK_LINK, LEAK_MEDIA, LEAK_KEY, "leak-key", "leak-provider-99", "pr:#777", "pr:#778",
                       "asset:", "worker-1", str(pid), str(d2), op.uid, "telegram"):
            assert secret not in text, secret
        # no 64-hex hash, no uuid anywhere in it
        assert not re.search(r"[0-9a-f]{64}", text) and not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", text), text


def test_counts_are_the_truth_for_every_status(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        before = truth(t)
        out = summary(t)
        assert out["counts"] == before and out["ok"] is True

        d = draft(t, "news:c-draft", pr=1)                                     # draft
        r = draft(t, "news:c-rejected", pr=2)                                  # rejected
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'Not what we want to say')", [r])["ok"]
        e = draft(t, "news:c-expired", pr=3)                                   # expired (the passage of time)
        raw(t, "update public.marketing_posts set status = 'expired' where id = %s", [e])
        f = approved(t, op, "news:c-failed", pr=4)                             # failed: certainly did not go out
        assert claim(t, "w")
        assert complete(t, f, "w", "failed", "blocked") is True
        s_ = approved(t, op, "news:c-sent", pr=5)                              # sent
        assert claim(t, "w")
        assert complete(t, s_, "w", "sent", mid="1") is True
        x = approved(t, op, "news:c-dead", pr=6)                               # dead
        assert claim(t, "w")
        assert complete(t, x, "w", "dead") is True
        # approved and sending are made directly: the weekly cap (2) would refuse a third promise through the owner function
        a = draft(t, "news:c-approved", pr=7)                                  # approved, waiting
        raw(t, "update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
               "approved_hash = content_hash, expires_at = now() + interval '1 day' where id = %s", [op.uid, a])
        g = draft(t, "news:c-sending", pr=8)                                   # sending: claimed, not settled
        raw(t, "update public.marketing_posts set status = 'sending', approved_by = %s, approved_at = now(), "
               "approved_hash = content_hash, expires_at = now() + interval '1 day', claimed_by = 'w', "
               "claimed_at = now(), claimed_until = now() + interval '5 minutes' where id = %s", [op.uid, g])
        assert (status(t, a), status(t, g)) == ("approved", "sending")

        out = summary(t)
        assert out["counts"] == truth(t)
        assert {k: out["counts"][k] - before[k] for k in STATUSES} == {
            "draft": 1, "approved": 1, "sending": 1, "sent": 1, "failed": 1, "dead": 1, "rejected": 1, "expired": 1}
        assert d  # the draft above is the one counted


def test_an_empty_table_is_zero_counts_no_last_post_and_no_failure(conn, sc):
    with tx(conn) as t:
        wipe(t)
        out = summary(t)
        assert out["counts"] == {s: 0 for s in STATUSES}
        assert (out["used_7d"], out["last_sent_at"], out["last_sent_kind"], out["last_failure"]) == (0, None, None, None)
        assert out["max_per_7d"] == 2 and out["enabled"] is False        # the dormant defaults of 0108


def test_the_weeks_count_the_cap_and_the_switch_are_the_settings(conn, sc, op):
    with tx(conn) as t:
        wipe(t)
        assert summary(t)["enabled"] is False
        enable(t)
        t.sup("update public.marketing_settings set max_per_7d = 1 where id returning 1")
        p = approved(t, op, "news:w-1", pr=1)
        assert claim(t, "w")
        assert complete(t, p, "w", "sent", mid="1") is True
        out = summary(t)
        assert (out["enabled"], out["max_per_7d"], out["used_7d"]) == (True, 1, 1)
        assert out["used_7d"] == t.sup("select public.marketing_cap_used()")[0][0]
        # a send older than a week no longer takes the slot (the cap's own window), but it is still the last one sent
        raw(t, "update public.marketing_posts set sent_at = now() - interval '8 days', claimed_at = now() - interval '8 days' where id = %s", [p])
        out = summary(t)
        assert out["used_7d"] == 0 == t.sup("select public.marketing_cap_used()")[0][0]
        assert out["last_sent_at"] is not None


def test_the_last_sent_is_the_newest_one_with_its_kind_and_a_utc_stamp(conn, sc, op):
    with tx(conn) as t:
        wipe(t)
        enable(t)
        old = approved(t, op, "news:l-1", pr=1)
        assert claim(t, "w")
        assert complete(t, old, "w", "sent", mid="1") is True
        new = approved(t, op, "news:l-2", pr=2)
        assert claim(t, "w")
        assert complete(t, new, "w", "sent", mid="2") is True
        when(t, old, sent_at="2026-10-01 10:00:00+00")
        when(t, new, sent_at="2026-10-02 11:30:05+00")
        out = summary(t)
        assert out["last_sent_at"] == "2026-10-02T11:30:05Z" and ISO.match(out["last_sent_at"])
        assert out["last_sent_kind"] == "news"


def test_the_last_failure_is_the_newest_failed_or_dead_with_its_closed_code(conn, sc, op):
    with tx(conn) as t:
        wipe(t)
        enable(t)
        p1 = approved(t, op, "news:f-1", pr=1)
        assert claim(t, "w")
        assert complete(t, p1, "w", "failed", "blocked") is True
        p2 = approved(t, op, "news:f-2", pr=2)
        assert claim(t, "w")
        assert complete(t, p2, "w", "dead") is True
        when(t, p1, updated_at="2026-10-03 09:00:00+00")
        when(t, p2, updated_at="2026-10-02 09:00:00+00")
        out = summary(t)["last_failure"]
        assert out == {"status": "failed", "last_error_code": "blocked", "kind": "news", "at": "2026-10-03T09:00:00Z"}
        when(t, p2, updated_at="2026-10-04 09:00:00+00")
        out = summary(t)["last_failure"]
        assert out == {"status": "dead", "last_error_code": "unconfirmed", "kind": "news", "at": "2026-10-04T09:00:00Z"}
        # a retrying post is approved, not failed: its code is not a failure yet
        p3 = approved(t, op, "news:f-3", pr=3)
        assert claim(t, "w")
        assert complete(t, p3, "w", "retry", "network", 30) is True
        assert status(t, p3) == "approved"
        assert summary(t)["last_failure"]["at"] == "2026-10-04T09:00:00Z"


# ── it changes nothing ──────────────────────────────────────────────────────

def test_calling_it_writes_nothing(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        approved(t, op, "news:nw-1", pr=1)
        state = (t.sup("select count(*), max(updated_at) from public.marketing_posts"),
                 t.sup("select count(*) from public.app_audit_log"), t.sup("select count(*) from public.security_events"),
                 t.sup("select enabled, max_per_7d, updated_at from public.marketing_settings"))
        for _ in range(3):
            summary(t)
        assert (t.sup("select count(*), max(updated_at) from public.marketing_posts"),
                t.sup("select count(*) from public.app_audit_log"), t.sup("select count(*) from public.security_events"),
                t.sup("select enabled, max_per_7d, updated_at from public.marketing_settings")) == state


def test_the_migration_adds_one_function_and_changes_no_other(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    code = "\n".join(line.split("--", 1)[0] for line in text.splitlines())
    assert re.findall(r"create or replace function public\.(\w+)", code) == ["operator_marketing_summary"]
    with as_superuser(conn, commit=False) as s:
        audit_before = s.value("select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure)")
        cap_before = s.value("select pg_get_functiondef('public.marketing_cap_used()'::regprocedure)")
        acl_before = s.rows("select proname, proacl::text from pg_proc where pronamespace = 'public'::regnamespace "
                            "and proname <> 'operator_marketing_summary' order by 1, 2")
        s.conn.execute(text)                                  # a replay, as the SQL editor would run it
        assert s.value("select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure)") == audit_before
        assert s.value("select pg_get_functiondef('public.marketing_cap_used()'::regprocedure)") == cap_before
        assert s.rows("select proname, proacl::text from pg_proc where pronamespace = 'public'::regnamespace "
                      "and proname <> 'operator_marketing_summary' order by 1, 2") == acl_before


def test_replay_keeps_the_answer_and_the_acl(conn, sc, op):
    text = MIGRATION.read_text(encoding="utf-8")
    with tx(conn) as t:
        enable(t)
        approved(t, op, "news:rp-1", pr=1)
        before = summary(t)
        t.conn.execute("reset role")
        t.conn.execute(text)
        t.conn.execute(text)
        assert summary(t) == before
        assert [t.sup("select has_function_privilege(%s, %s, 'EXECUTE')", [r, SIGNATURE])[0][0]
                for r in ("anon", "authenticated", "service_role")] == [False, False, True]
        assert run(t, "select 1").ok


def test_the_rollback_removes_exactly_the_function_and_the_migration_brings_it_back(conn, sc, op):
    rollback = ROLLBACK.read_text(encoding="utf-8")
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    with tx(conn) as t:
        before = {r[0] for r in t.sup("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
        audit = t.sup("select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure)")[0][0]
        t.conn.execute(body)
        after = {r[0] for r in t.sup("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")}
        assert before - after == {"operator_marketing_summary()"} and after <= before
        assert t.sup("select pg_get_functiondef('public.audit_action_allowed(text)'::regprocedure)")[0][0] == audit
        assert t.sup("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname = 'marketing_posts'")[0][0] == 1
        out = t.as_(SERVICE).run(CALL)
        assert not out.ok and out.sqlstate in ("42883",), out        # undefined function: the bot's "not available yet"
        t.conn.execute("reset role")
        t.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert {r[0] for r in t.sup("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")} == before
        assert summary(t)["ok"] is True


def test_the_guard_names_what_0108_made(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    for needle in ("to_regclass('public.marketing_posts') is null", "to_regclass('public.marketing_settings') is null",
                   "to_regprocedure('public.marketing_cap_used()') is null"):
        assert needle in text, needle
    assert re.search(r"(?m)^set local lock_timeout = '5s';$", text)
    # without 0108 the migration refuses to apply, with the remedy named
    with tx(conn) as t:
        t.conn.execute("reset role")
        t.conn.execute("alter function public.marketing_cap_used() rename to marketing_cap_used_gone")
        out = t.s.run(text)
        assert not out.ok and out.sqlstate == "P0001" and "0108" in out.error, out
