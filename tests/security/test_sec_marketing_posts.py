"""Migration 0108 (the brand-channel poster): posts, settings, showcase assets. Everything ships DORMANT, so
this file pins the things a public post must never be able to do:

  * go out without a person's approval of EXACTLY these words (forged approval, edit after approval, a changed
    hash, an expired or too old approval);
  * go out while the kill switch is on, or more than twice in a rolling 7 days, even when two claims race;
  * go out twice (a lost lease is never re-sent; a request that may have arrived is never retried);
  * be written or read by anyone but the platform owner/admin and the worker's service key.

Each test runs in a transaction that is rolled back, as one caller (``Tx.as_``), with the JWT claims PostgREST would
hand the database. The one race test commits its rows on purpose (two sessions cannot see each other's rolled-back
data) and removes them again. The helpers are the ones of test_sec_owner_safety.py.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import psycopg
import pytest

from sec_db import ANON, REPO, SERVICE, as_superuser
from test_sec_owner_safety import aal2, audits, events, factors, gate_on, second_connection, tx

MIGRATION = REPO / "supabase" / "migrations" / "0108_marketing_posts.sql"
PREVIOUS = REPO / "supabase" / "migrations" / "0107_owner_safety.sql"
ROLLBACK = REPO / "docs" / "sql" / "rollback_0108_marketing_posts.sql"

TEXTS = {"uz": "Namuna matn", "ru": "Пример текста", "en": "Sample text"}
NEW_ACTIONS = {"marketing.edit", "marketing.approve", "marketing.reject", "marketing.send", "marketing.fail",
               "marketing.kill", "showcase.mark", "showcase.revoke"}
ZERO_UUID = "00000000-0000-0000-0000-0000000000aa"
OTHER_HASH = "f" * 64

OWNER_CALLS = {  # name -> a call with harmless arguments
    "owner_marketing_get": "select public.owner_marketing_get()",
    "owner_marketing_edit": "select public.owner_marketing_edit('%s', '{\"uz\":\"a\",\"ru\":\"b\",\"en\":\"c\"}'::jsonb)" % ZERO_UUID,
    "owner_marketing_approve": "select public.owner_marketing_approve('%s', '%s')" % (ZERO_UUID, OTHER_HASH),
    "owner_marketing_reject": "select public.owner_marketing_reject('%s', 'A reason that is long enough')" % ZERO_UUID,
    "owner_marketing_kill": "select public.owner_marketing_kill(true, null)",
}
WORKER_CALLS = {
    "marketing_draft_upsert": "select public.marketing_draft_upsert('news:attack-1', 'news', "
                              "'{\"uz\":\"a\",\"ru\":\"b\",\"en\":\"c\"}'::jsonb, 'pr:#1')",
    "claim_marketing_post": "select * from public.claim_marketing_post('attacker')",
    "complete_marketing_post": "select public.complete_marketing_post('%s', 'attacker', 'sent')" % ZERO_UUID,
}
INTERNAL = {"marketing_texts_ok": "jsonb, boolean", "marketing_post_hash": "text, text, jsonb, text, text", "marketing_cap_used": ""}


# ── plumbing ────────────────────────────────────────────────────────────────

def run(t, query, params=None):
    """A statement as the database owner whose failure is data, not an error (the SQL editor)."""
    t.conn.execute("reset role")
    return t.s.run(query, params)


def raw(t, query, params=None):
    """A write that skips the triggers (the replica role), for states only tampering or the passage of time makes.
    Check constraints still apply."""
    t.sup("set local session_replication_role = replica")
    try:
        return run(t, query, params)
    finally:
        t.sup("reset session_replication_role")


def draft(t, key="news:t-1", texts=None, pr=10, kind="news", source=None):
    out = t.as_(SERVICE).value("select public.marketing_draft_upsert(%s, %s, %s::jsonb, %s)",
                               [key, kind, json.dumps(texts or TEXTS), source or f"pr:#{pr}"])
    assert out["ok"], out
    return out["id"]


def price_draft(t, key="price:t-1", age_hours=0, texts=None):
    out = t.as_(SERVICE).value(
        "select public.marketing_draft_upsert(%s, 'price', %s::jsonb, 'plan:plus,business', '{\"credits\": 6000}'::jsonb, "
        "now() - make_interval(hours => %s))", [key, json.dumps(texts or TEXTS), age_hours])
    assert out["ok"], out
    return out["id"]


def chash(t, pid):
    return t.sup("select content_hash from public.marketing_posts where id = %s", [pid])[0][0]


def status(t, pid):
    return t.sup("select status from public.marketing_posts where id = %s", [pid])[0][0]


def row(t, pid):
    cols = ("status", "approved_by", "approved_at", "approved_hash", "expires_at", "claimed_by", "claimed_until",
            "attempts", "next_attempt_at", "sent_at", "last_error_code", "texts")
    r = t.sup("select " + ", ".join(cols) + " from public.marketing_posts where id = %s", [pid])[0]
    return dict(zip(cols, r))


def approve(t, who, pid, h=None):
    h = h or chash(t, pid)   # read first: the read resets the role the call below must run as
    return t.as_(who).value("select public.owner_marketing_approve(%s, %s)", [pid, h])


def approved(t, op, key, pr=10, texts=None):
    pid = draft(t, key, texts, pr)
    out = approve(t, op, pid)
    assert out["ok"], out
    return pid


def enable(t):
    t.sup("update public.marketing_settings set enabled = true where id returning 1")


def claim(t, worker="worker-1", lease=120):
    out = t.as_(SERVICE).run("select post_id, kind, target, texts, media_path, link, attempts, content_hash "
                             "from public.claim_marketing_post(%s, %s)", [worker, lease])
    assert out.ok, out
    return out.rows


def complete(t, pid, worker, outcome, code=None, retry_after=None, mid=None):
    return t.as_(SERVICE).value("select public.complete_marketing_post(%s, %s, %s, %s, %s, %s)",
                                [pid, worker, outcome, code, retry_after, mid])


def send(t, pid=None, worker="worker-1"):
    """Claim the one approved post (the one named, when a name is given) and settle it as sent; returns its id.
    Approvals made in one transaction share a timestamp, so which of several goes first is the id's order."""
    got = claim(t, worker)
    assert len(got) == 1, got
    claimed = got[0][0]
    assert pid is None or str(claimed) == str(pid), got
    assert complete(t, claimed, worker, "sent", mid="4242") is True
    return claimed


def used(t):
    return t.sup("select public.marketing_cap_used()")[0][0]


@pytest.fixture
def op(sc):
    return sc.operator


# ── who may call what ───────────────────────────────────────────────────────

@pytest.mark.parametrize("fn", sorted(OWNER_CALLS))
def test_anon_and_non_admins_are_refused_by_every_owner_function(conn, sc, fn):
    with tx(conn) as t:
        out = t.anon().run(OWNER_CALLS[fn])
        assert not out.ok and out.sqlstate == "42501", out
        for who in (sc.bob.actor, sc.alice.actor, sc.dana, sc.stranger, SERVICE):
            out = t.as_(who).run(OWNER_CALLS[fn])
            assert not out.ok and out.sqlstate == "42501", (fn, getattr(who, "name", who), out)
        # and nothing moved
        assert t.sup("select count(*) from public.app_audit_log where action like 'marketing.%%'")[0][0] == 0


@pytest.mark.parametrize("fn", sorted(WORKER_CALLS))
def test_the_worker_functions_are_for_the_service_key_only(conn, sc, fn):
    with tx(conn) as t:
        for who in (None, sc.operator, sc.bob.actor, sc.dana, sc.stranger):
            out = t.anon().run(WORKER_CALLS[fn]) if who is None else t.as_(who).run(WORKER_CALLS[fn])
            assert not out.ok and out.sqlstate == "42501", (fn, getattr(who, "name", "anon"), out)
        assert t.as_(SERVICE).run(WORKER_CALLS[fn]).sqlstate != "42501", fn
    with as_superuser(conn, commit=False) as s:
        sig = {"marketing_draft_upsert": "public.marketing_draft_upsert(text,text,jsonb,text,jsonb,timestamptz,text,text,text)",
               "claim_marketing_post": "public.claim_marketing_post(text,integer,text)",
               "complete_marketing_post": "public.complete_marketing_post(uuid,text,text,text,integer,text)"}[fn]
        assert [s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [r, sig]) for r in
                ("anon", "authenticated", "service_role")] == [False, False, True]


@pytest.mark.parametrize("fn,args", sorted(INTERNAL.items()))
def test_internal_helpers_are_closed_to_every_api_role(conn, fn, args):
    with as_superuser(conn, commit=False) as s:
        for role in ("anon", "authenticated", "service_role"):
            assert s.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, f"public.{fn}({args})"]) is False, (fn, role)


def test_the_trigger_functions_are_closed_to_every_api_role(conn):
    names = sorted(set(re.findall(r"create or replace function public\.(\w+)\([^)]*\)\s+returns trigger",
                                  MIGRATION.read_text(encoding="utf-8"))))
    assert len(names) >= 5, names
    with as_superuser(conn, commit=False) as s:
        for n in names:
            for role in ("anon", "authenticated", "service_role"):
                assert s.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [role, f"public.{n}()"]) is False, (n, role)


def test_every_function_of_the_migration_pins_its_search_path(conn):
    names = sorted(set(re.findall(r"create or replace function public\.(\w+)", MIGRATION.read_text(encoding="utf-8"))) - {"audit_action_allowed"})
    assert len(names) == 16, names
    with as_superuser(conn, commit=False) as s:
        rows = s.rows("select p.proname, p.prosecdef, coalesce(p.proconfig, '{}') from pg_proc p "
                      "where p.pronamespace = 'public'::regnamespace and p.proname = any(%s)", [names])
    assert {r[0] for r in rows} == set(names)
    for name, definer, config in rows:
        if name in ("marketing_texts_ok", "marketing_post_hash"):  # pure functions, not definers
            assert not definer
        else:
            assert definer, name
        assert any(c.startswith("search_path=") and "pg_temp" in c for c in config), f"{name}: {config}"


# ── the tables ──────────────────────────────────────────────────────────────

def test_only_a_platform_admin_reads_the_posts_and_nobody_writes_them_directly(conn, sc, op):
    with tx(conn) as t:
        pid = draft(t, "news:read-1")
        assert t.as_(op).value("select count(*) from public.marketing_posts where id = %s", [pid]) == 1
        for who in (sc.bob.actor, sc.alice.actor, sc.dana, sc.stranger):
            assert t.as_(who).value("select count(*) from public.marketing_posts") == 0, who.name
        assert t.anon().run("select * from public.marketing_posts").sqlstate == "42501"
        assert t.as_(SERVICE).run("select * from public.marketing_posts").sqlstate == "42501"
        for who in (op, sc.bob.actor, SERVICE):
            for stmt in ("insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) values "
                         "('news:x', 'news', '{\"uz\":\"a\",\"ru\":\"b\",\"en\":\"c\"}', 'pr:#1')",
                         "update public.marketing_posts set status = 'approved'",
                         "update public.marketing_posts set texts = '{}'", "delete from public.marketing_posts",
                         "truncate public.marketing_posts"):
                out = t.as_(who).run(stmt)
                assert not out.ok and out.sqlstate == "42501", (stmt, getattr(who, "name", who), out)


def test_the_settings_and_the_showcase_assets_are_closed_to_every_api_role(conn, sc, op):
    with tx(conn) as t:
        for table in ("marketing_settings", "showcase_assets"):
            for who in (op, sc.bob.actor, sc.dana, SERVICE):
                for stmt in (f"select * from public.{table}", f"update public.{table} set id = id", f"delete from public.{table}"):
                    out = t.as_(who).run(stmt)
                    assert not out.ok and out.sqlstate == "42501", (stmt, getattr(who, "name", who), out)
            assert t.anon().run(f"select * from public.{table}").sqlstate == "42501"
        assert t.as_(op).run("update public.marketing_settings set enabled = true").sqlstate == "42501"


def test_everything_is_off_and_there_is_one_settings_row(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.rows("select enabled, max_per_7d, facts_max_age_hours, approval_ttl_hours from public.marketing_settings") == [(False, 2, 24, 72)]
        assert s.run("insert into public.marketing_settings (id) values (false)").sqlstate == "23514"
        assert s.run("insert into public.marketing_settings (id) values (true)").sqlstate == "23505"
        assert s.run("delete from public.marketing_settings").sqlstate == "42501"
        assert s.run("truncate public.marketing_settings").sqlstate == "42501"
        for col, bad in (("max_per_7d", 3), ("max_per_7d", -1), ("facts_max_age_hours", 0), ("facts_max_age_hours", 169),
                         ("approval_ttl_hours", 0), ("approval_ttl_hours", 73)):
            assert s.run(f"update public.marketing_settings set {col} = %s", [bad]).sqlstate == "23514", (col, bad)
        assert s.run("update public.marketing_settings set max_per_7d = 0").ok


def test_a_change_of_the_switch_in_the_sql_editor_leaves_a_mark(conn):
    with tx(conn) as t:
        before = len(events(t, "marketing.settings"))
        enable(t)
        marks = events(t, "marketing.settings")
        assert len(marks) == before + 1 and marks[-1][1] == "critical" and marks[-1][5]["enabled"] == [False, True]


def test_the_cap_of_the_week_cannot_exceed_two(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.run("update public.marketing_settings set max_per_7d = 3").sqlstate == "23514"


# ── showcase assets ─────────────────────────────────────────────────────────

def test_a_customers_video_can_never_be_marked_as_a_showcase(conn, sc, op):
    insert = ("insert into public.showcase_assets (org_id, source_video_ref, storage_path, marked_by) "
              "values (%s, %s, %s, %s)")
    with tx(conn) as t:
        for org in (sc.bob.org, sc.alice.org):
            assert run(t, insert, [org, "vid-x", "showcase/x.mp4", op.uid]).sqlstate == "23514"
        default_org = t.sup("select public.default_org_id()")[0][0]
        assert run(t, insert, [default_org, "vid-x", "showcase/x.mp4", op.uid]).ok
        assert run(t, insert, [default_org, "vid-x", "showcase/y.mp4", op.uid]).sqlstate == "23505"  # one live mark per video
        for path in ("previews/x.mp4", "showcase/../previews/x.mp4", "/showcase/x.mp4", "showcase/"):
            assert run(t, insert, [default_org, "vid-y", path, op.uid]).sqlstate == "23514", path
        assert run(t, "update public.showcase_assets set revoked_at = now() where source_video_ref = 'vid-x'").sqlstate == "23514"
        assert run(t, "update public.showcase_assets set revoked_at = now(), revoked_by = %s where source_video_ref = 'vid-x'", [op.uid]).ok
        assert run(t, insert, [default_org, "vid-x", "showcase/z.mp4", op.uid]).ok  # a revoked mark frees the video


# ── the status machine ──────────────────────────────────────────────────────

def test_a_new_post_is_a_draft_and_only_a_draft(conn, sc, op):
    with tx(conn) as t:
        pid = draft(t, "news:fresh-1")
        r = row(t, pid)
        assert r["status"] == "draft" and r["approved_hash"] is None and r["attempts"] == 0
        out = run(t, "insert into public.marketing_posts (idempotency_key, kind, texts, source_ref, status) "
                     "values ('news:born-approved', 'news', %s::jsonb, 'pr:#1', 'approved')", [json.dumps(TEXTS)])
        assert out.sqlstate == "23514", out


ILLEGAL_FROM_DRAFT = ("sending", "sent", "failed", "dead")
ILLEGAL_FROM_APPROVED = ("sent", "failed", "dead", "rejected")


def test_illegal_moves_out_of_a_draft_are_refused(conn, sc, op):
    with tx(conn) as t:
        pid = draft(t, "news:m-1")
        for target in ILLEGAL_FROM_DRAFT:
            out = run(t, "update public.marketing_posts set status = %s where id = %s", [target, pid])
            assert not out.ok and out.sqlstate == "23514", (target, out)
        assert status(t, pid) == "draft"


def test_illegal_moves_out_of_an_approved_post_are_refused(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:m-2")
        for target in ILLEGAL_FROM_APPROVED:
            out = run(t, "update public.marketing_posts set status = %s where id = %s", [target, pid])
            assert not out.ok and out.sqlstate == "23514", (target, out)
        # back to draft with the approval left in place is not a move either
        assert run(t, "update public.marketing_posts set status = 'draft' where id = %s", [pid]).sqlstate == "23514"
        # sending is only legal through a claim: a bare status write has no lease
        assert run(t, "update public.marketing_posts set status = 'sending' where id = %s", [pid]).sqlstate == "23514"
        assert status(t, pid) == "approved"


def test_illegal_moves_out_of_a_sending_post_are_refused(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:m-3")
        assert [str(r[0]) for r in claim(t)] == [str(pid)]
        for target in ("draft", "rejected", "expired"):
            out = run(t, "update public.marketing_posts set status = %s where id = %s", [target, pid])
            assert not out.ok and out.sqlstate == "23514", (target, out)
        assert status(t, pid) == "sending"


@pytest.mark.parametrize("final", ["sent", "failed", "dead", "rejected", "expired"])
def test_a_final_post_is_frozen(conn, sc, op, final):
    with tx(conn) as t:
        enable(t)
        pid = draft(t, f"news:final-{final}")
        if final == "rejected":
            assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [pid])["ok"]
        elif final == "expired":
            run(t, "update public.marketing_posts set status = 'expired' where id = %s", [pid])
        else:
            assert approve(t, op, pid)["ok"]
            assert claim(t)
            assert complete(t, pid, "worker-1", {"sent": "sent", "failed": "failed", "dead": "dead"}[final], "bad_request") is True
        assert status(t, pid) == final
        for stmt in ("update public.marketing_posts set status = 'draft', approved_hash = null, approved_by = null, "
                     "approved_at = null, expires_at = null, claimed_by = null, claimed_at = null, claimed_until = null, sent_at = null",
                     "update public.marketing_posts set attempts = 9", "update public.marketing_posts set texts = texts"):
            out = run(t, stmt + " where id = %s", [pid])
            assert not out.ok and out.sqlstate == "23514", (final, stmt, out)


def test_a_post_is_never_deleted_and_its_identity_never_changes(conn, sc, op):
    with tx(conn) as t:
        pid = draft(t, "news:ident-1")
        assert run(t, "delete from public.marketing_posts where id = %s", [pid]).sqlstate == "42501"
        assert run(t, "truncate public.marketing_posts").sqlstate == "42501"
        for stmt in ("set idempotency_key = 'news:other'", "set kind = 'price'", "set target = 'telegram', id = gen_random_uuid()",
                     "set source_ref = 'pr:#99'", "set created_at = now() - interval '1 day'"):
            out = run(t, f"update public.marketing_posts {stmt} where id = %s", [pid])
            assert not out.ok and out.sqlstate == "23514", (stmt, out)


# ── approval cannot be forged ───────────────────────────────────────────────

def test_a_status_write_cannot_fake_an_approval(conn, sc, op):
    with tx(conn) as t:
        pid = draft(t, "news:forge-1")
        h = chash(t, pid)
        # no approver, no hash
        assert run(t, "update public.marketing_posts set status = 'approved' where id = %s", [pid]).sqlstate == "23514"
        # a hash of something else
        out = run(t, "update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
                     "approved_hash = %s, expires_at = now() + interval '1 hour' where id = %s", [op.uid, OTHER_HASH, pid])
        assert out.sqlstate == "23514", out
        # an approval that has already expired
        out = run(t, "update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
                     "approved_hash = %s, expires_at = now() - interval '1 hour' where id = %s", [op.uid, h, pid])
        assert out.sqlstate == "23514", out
        # an approval without the approver
        out = run(t, "update public.marketing_posts set status = 'approved', approved_at = now(), "
                     "approved_hash = %s, expires_at = now() + interval '1 hour' where id = %s", [h, pid])
        assert out.sqlstate == "23514", out
        assert status(t, pid) == "draft"


def test_nobody_but_the_owner_functions_can_approve(conn, sc, op):
    with tx(conn) as t:
        pid = draft(t, "news:forge-2")
        h = chash(t, pid)
        for who in (sc.bob.actor, sc.alice.actor, sc.dana, sc.stranger, SERVICE):
            out = t.as_(who).run("select public.owner_marketing_approve(%s, %s)", [pid, h])
            assert not out.ok and out.sqlstate == "42501", (getattr(who, "name", who), out)
            out = t.as_(who).run("update public.marketing_posts set status = 'approved' where id = %s", [pid])
            assert not out.ok and out.sqlstate == "42501", (getattr(who, "name", who), out)
        # not even the platform admin writes the table: only the function approves
        assert t.as_(op).run("update public.marketing_posts set status = 'approved' where id = %s", [pid]).sqlstate == "42501"
        assert status(t, pid) == "draft"


def test_an_approval_is_for_the_words_the_owner_saw(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = draft(t, "news:saw-1")
        seen = chash(t, pid)
        assert approve(t, op, pid, OTHER_HASH)["error"] == "content_changed"
        assert t.as_(op).value("select public.owner_marketing_approve(%s, null)", [pid])["error"] == "content_hash_required"
        assert t.as_(op).value("select public.owner_marketing_approve(%s, 'not-a-hash')", [pid])["error"] == "content_hash_required"
        # the worker rewrites the draft while the owner is reading it
        t.as_(SERVICE).value("select public.marketing_draft_upsert('news:saw-1', 'news', %s::jsonb, 'pr:#10')",
                             [json.dumps({**TEXTS, "en": "Different words"})])
        assert chash(t, pid) != seen
        assert approve(t, op, pid, seen)["error"] == "content_changed"
        assert status(t, pid) == "draft"
        out = approve(t, op, pid)
        assert out["ok"] and out["already"] is False
        r = t.sup("select approved_by, approved_hash = content_hash from public.marketing_posts where id = %s", [pid])[0]
        assert (str(r[0]), r[1]) == (op.uid, True)
        # approving again is a no-op, not a second approval
        again = approve(t, op, pid)
        assert again["ok"] and again["already"] is True


def test_only_a_draft_can_be_approved(conn, sc, op):
    with tx(conn) as t:
        rejected = draft(t, "news:state-1")
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [rejected])["ok"]
        assert approve(t, op, rejected)["error"] == "not_draft"
        assert approve(t, op, ZERO_UUID, OTHER_HASH)["error"] == "no_such_post"


def test_a_price_post_with_old_facts_cannot_be_approved(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        stale = price_draft(t, "price:stale-1", age_hours=25)
        out = approve(t, op, stale)
        assert out["error"] == "facts_stale" and out["max_age_hours"] == 24, out
        fresh = price_draft(t, "price:fresh-1", age_hours=1)
        assert approve(t, op, fresh)["ok"]
        # facts are fixed once approved, and a price post cannot exist without their timestamp
        assert run(t, "update public.marketing_posts set facts = '{}' where id = %s", [fresh]).sqlstate == "23514"
        out = t.as_(SERVICE).value("select public.marketing_draft_upsert('price:nots-1', 'price', %s::jsonb, 'plan:plus')", [json.dumps(TEXTS)])
        assert out["error"] == "facts_as_of_required"
        assert run(t, "insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) values "
                      "('price:direct-1', 'price', %s::jsonb, 'plan:plus')", [json.dumps(TEXTS)]).sqlstate == "23514"


# ── editing after approval ──────────────────────────────────────────────────

def test_an_edit_after_approval_returns_the_post_to_draft_and_voids_the_approval(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:edit-1")
        old = chash(t, pid)
        out = t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({**TEXTS, "en": "Edited words"})])
        assert out["ok"] and out["status"] == "draft" and out["approval_voided"] is True and out["unchanged"] is False, out
        r = row(t, pid)
        assert r["status"] == "draft" and r["approved_hash"] is None and r["approved_by"] is None and r["expires_at"] is None
        assert r["texts"]["en"] == "Edited words"
        assert claim(t) == []  # nothing is approved any more
        assert approve(t, op, pid, old)["error"] == "content_changed"  # the old words cannot be re-approved by hash
        assert approve(t, op, pid)["ok"]
        assert [str(x[0]) for x in claim(t)] == [str(pid)]


def test_a_bare_text_write_to_an_approved_row_also_voids_the_approval(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:edit-2")
        out = run(t, "update public.marketing_posts set texts = jsonb_set(texts, '{ru}', '\"Другой текст\"') where id = %s", [pid])
        assert out.ok, out
        r = row(t, pid)
        assert r["status"] == "draft" and r["approved_hash"] is None
        assert claim(t) == []


def test_the_content_of_a_post_being_sent_cannot_change(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:edit-3")
        assert claim(t)
        out = run(t, "update public.marketing_posts set texts = jsonb_set(texts, '{en}', '\"Sneaky\"') where id = %s", [pid])
        assert out.sqlstate == "23514", out
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({**TEXTS, "en": "Sneaky"})])["error"] == "not_editable"


def test_an_edit_that_changes_nothing_voids_nothing(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:edit-4")
        out = t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({k: f" {v} " for k, v in TEXTS.items()})])
        assert out["ok"] and out["unchanged"] is True and status(t, pid) == "approved"


@pytest.mark.parametrize("texts", [
    {"uz": "a", "ru": "b"}, {"uz": "a", "ru": "b", "en": "c", "fr": "d"}, {"uz": "a", "ru": "b", "en": ""},
    {"uz": "a", "ru": "b", "en": "   "}, {"uz": "a", "ru": "b", "en": 5}, {"uz": "a", "ru": "b", "en": None},
    {"uz": "a", "ru": "b", "en": "x" * 1001}, {"uz": "a", "ru": "b", "en": "bell\x07"}, [1, 2], "text",
])
def test_bad_texts_are_refused_by_the_edit_and_by_the_draft(conn, sc, op, texts):
    with tx(conn) as t:
        pid = draft(t, "news:bad-1")
        out = t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps(texts)])
        assert out["error"] == "bad_texts", out
        out = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:bad-2', 'news', %s::jsonb, 'pr:#2')", [json.dumps(texts)])
        assert out["error"] == "bad_texts", out
        assert row(t, pid)["texts"] == TEXTS


def test_a_caption_is_shorter_than_a_message(conn, sc, op):
    with tx(conn) as t:
        long = {"uz": "u" * 300, "ru": "р" * 300, "en": "e" * 300}   # 900 + 160 allowance > 1024 as a caption
        plain = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:cap-1', 'news', %s::jsonb, 'pr:#3')", [json.dumps(long)])
        assert plain["ok"], plain
        with_media = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:cap-2', 'news', %s::jsonb, 'pr:#4', '{}'::jsonb, null, "
                                          "'showcase/a.mp4')", [json.dumps(long)])
        assert with_media["error"] == "bad_texts", with_media
        short = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:cap-3', 'news', %s::jsonb, 'pr:#5', '{}'::jsonb, null, "
                                     "'showcase/a.mp4')", [json.dumps({k: v[:200] for k, v in long.items()})])
        assert short["ok"], short
        bad_media = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:cap-4', 'news', %s::jsonb, 'pr:#6', '{}'::jsonb, null, "
                                         "'previews/private.mp4')", [json.dumps(TEXTS)])
        assert bad_media["error"] == "bad_media"


# ── drafting is idempotent ──────────────────────────────────────────────────

def test_drafting_the_same_thing_twice_makes_one_post_and_never_rewrites_a_decided_one(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        s = t.as_(SERVICE)
        first = s.value("select public.marketing_draft_upsert('news:idem-1', 'news', %s::jsonb, 'pr:#7')", [json.dumps(TEXTS)])
        second = s.value("select public.marketing_draft_upsert('news:idem-1', 'news', %s::jsonb, 'pr:#7')", [json.dumps(TEXTS)])
        assert (first["created"], second["created"], second["updated"]) == (True, False, False) and first["id"] == second["id"]
        # the file was edited before anyone approved it: the draft follows
        third = s.value("select public.marketing_draft_upsert('news:idem-1', 'news', %s::jsonb, 'pr:#7')", [json.dumps({**TEXTS, "en": "Better"})])
        assert third["updated"] is True and row(t, first["id"])["texts"]["en"] == "Better"
        # once approved, it is not touched again
        assert approve(t, op, first["id"])["ok"]
        fourth = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:idem-1', 'news', %s::jsonb, 'pr:#7')",
                                      [json.dumps({**TEXTS, "en": "Worse"})])
        assert fourth["updated"] is False and fourth["status"] == "approved" and row(t, first["id"])["texts"]["en"] == "Better"
        # a rejected item is not offered again
        other = draft(t, "news:idem-2")
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [other])["ok"]
        again = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:idem-2', 'news', %s::jsonb, 'pr:#10')", [json.dumps(TEXTS)])
        assert again["created"] is False and again["status"] == "rejected"
        assert t.sup("select count(*) from public.marketing_posts where idempotency_key in ('news:idem-1', 'news:idem-2')")[0][0] == 2
        # the database says it too
        out = run(t, "insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) values ('news:idem-1', 'news', %s::jsonb, 'pr:#7')",
                  [json.dumps(TEXTS)])
        assert out.sqlstate == "23505"


@pytest.mark.parametrize("args,error", [
    ("'news:k1', 'tweet', %s::jsonb, 'pr:#1'", "bad_kind"),
    ("'price:k1', 'news', %s::jsonb, 'pr:#1'", "bad_key"),
    ("'news:', 'news', %s::jsonb, 'pr:#1'", "bad_key"),
    ("'news:k 1', 'news', %s::jsonb, 'pr:#1'", "bad_key"),
    ("'news:k1', 'news', %s::jsonb, 'plan:plus'", "bad_source"),
    ("'news:k1', 'news', %s::jsonb, 'pr:#x'", "bad_source"),
    ("'showcase:k1', 'showcase', %s::jsonb, 'pr:#1', '{}'::jsonb, null, 'showcase/a.mp4'", "bad_source"),
    ("'showcase:k1', 'showcase', %s::jsonb, 'asset:00000000-0000-0000-0000-000000000001'", "media_required"),
    ("'news:k1', 'news', %s::jsonb, 'pr:#1', '{}'::jsonb, null, null, 'telegram', 'https://evil.example'", "bad_link"),
    ("'news:k1', 'news', %s::jsonb, 'pr:#1', '{}'::jsonb, null, null, 'telegram', '/a/../b'", "bad_link"),
])
def test_drafting_refuses_nonsense(conn, sc, args, error):
    with tx(conn) as t:
        out = t.as_(SERVICE).value(f"select public.marketing_draft_upsert({args})", [json.dumps(TEXTS)])
        assert out["error"] == error, out
        out = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:k1', 'news', %s::jsonb, 'pr:#1', '{}'::jsonb, null, null, 'instagram')", [json.dumps(TEXTS)])
        assert out["error"] == "bad_target"


def test_one_key_cannot_name_two_different_posts(conn, sc):
    with tx(conn) as t:
        draft(t, "news:key-1", pr=1)
        out = t.as_(SERVICE).value("select public.marketing_draft_upsert('news:key-1', 'news', %s::jsonb, 'pr:#2')", [json.dumps(TEXTS)])
        assert out["error"] == "key_reused"


# ── the kill switch, the cap and the claim ──────────────────────────────────

def test_nothing_is_claimed_while_the_switch_is_off_however_much_is_approved(conn, sc, op):
    with tx(conn) as t:
        assert t.sup("select enabled from public.marketing_settings")[0][0] is False
        enable(t)
        pid = approved(t, op, "news:off-1")
        t.sup("update public.marketing_settings set enabled = false where id returning 1")   # the switch goes off (SQL editor)
        assert claim(t) == []
        assert status(t, pid) == "approved"
        enable(t)
        assert [str(r[0]) for r in claim(t)] == [str(pid)]


def test_the_kill_switch_beats_an_approved_post(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:kill-1")
        out = t.as_(op).value("select public.owner_marketing_kill(true, 'Stop everything now')")
        assert out == {"ok": True, "already": False, "enabled": False}
        assert claim(t) == [] and status(t, pid) == "approved"
        assert t.as_(op).value("select public.owner_marketing_kill()")["already"] is True
        # re-arming needs a reason, and then the approved post can go
        assert t.as_(op).value("select public.owner_marketing_kill(false, null)")["error"] == "reason_required"
        assert t.as_(op).value("select public.owner_marketing_kill(false, 'short')")["error"] == "reason_required"
        assert t.as_(op).value("select public.owner_marketing_kill(null, null)")["error"] == "bad_arguments"
        assert claim(t) == []
        assert t.as_(op).value("select public.owner_marketing_kill(false, 'The first real news is approved')")["enabled"] is True
        assert [str(r[0]) for r in claim(t)] == [str(pid)]
        kills = audits(t, "marketing.kill")
        assert sorted((k[0], k[4]["enabled"]) for k in kills) == [("marketing.kill", False), ("marketing.kill", True)]
        assert [e[1] for e in events(t, "marketing.kill")] == ["warning", "critical"]


def test_a_third_post_in_seven_days_is_never_claimable(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        p1, p2, p3 = (draft(t, f"news:cap-{i}", pr=i) for i in (1, 2, 3))
        assert approve(t, op, p1)["ok"] and approve(t, op, p2)["ok"]
        # a third approval is refused outright: two are used or promised
        full = approve(t, op, p3)
        assert full["error"] == "cap_full" and full["used_7d"] == 0 and full["approved_waiting"] == 2 and full["max_per_7d"] == 2, full
        first = send(t)
        assert used(t) == 1
        assert approve(t, op, p3)["error"] == "cap_full"   # one sent, one waiting
        send(t)
        assert used(t) == 2 and claim(t) == []
        # even a post that was approved some other way is held back by the claim itself
        out = run(t, "update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
                     "approved_hash = content_hash, expires_at = now() + interval '3 days' where id = %s", [op.uid, p3])
        assert out.ok, out
        assert claim(t) == [] and status(t, p3) == "approved"
        # the window rolls: the first send was 8 days ago, so a slot opens
        raw(t, "update public.marketing_posts set sent_at = now() - interval '8 days', claimed_at = now() - interval '8 days' where id = %s", [first])
        assert used(t) == 1
        assert [str(r[0]) for r in claim(t)] == [str(p3)]


def test_a_cap_of_zero_stops_approvals_and_claims(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        t.sup("update public.marketing_settings set max_per_7d = 0 where id returning 1")
        pid = draft(t, "news:zero-1")
        assert approve(t, op, pid)["error"] == "cap_full"
        raw(t, "update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
               "approved_hash = content_hash, expires_at = now() + interval '3 days' where id = %s", [op.uid, pid])
        assert claim(t) == []


def test_one_claim_hands_out_one_post_and_the_oldest_approval_first(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        a = approved(t, op, "news:order-1", pr=1)
        raw(t, "update public.marketing_posts set approved_at = now() - interval '2 hours' where id = %s", [a])
        b = approved(t, op, "news:order-2", pr=2)
        got = claim(t)
        assert [str(r[0]) for r in got] == [str(a)] and got[0][1:3] == ("news", "telegram") and got[0][6] == 1
        assert status(t, b) == "approved"
        r = row(t, a)
        assert r["status"] == "sending" and r["claimed_by"] == "worker-1" and r["attempts"] == 1


def test_two_claims_at_once_are_serialised_and_the_cap_holds(conn, sc):
    keys = [f"news:conc-{i}" for i in (1, 2, 3)]
    a = b = c = None
    try:
        with as_superuser(conn) as s:   # committed: two sessions cannot see each other's rolled-back rows
            s.rows("update public.marketing_settings set enabled = true where id returning 1")
            for i, key in enumerate(keys, 1):
                s.rows("insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) "
                       "values (%s, 'news', %s::jsonb, %s) returning 1", [key, json.dumps(TEXTS), f"pr:#9{i}"])
            s.rows("update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
                   "approved_hash = content_hash, expires_at = now() + interval '72 hours' where idempotency_key = any(%s) returning 1",
                   [sc.operator.uid, keys])

        def as_service(conn_):
            conn_.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role"})])
            conn_.execute("set local role service_role")

        a, b, c = second_connection(conn), second_connection(conn), second_connection(conn)
        as_service(a)
        first = a.execute("select post_id from public.claim_marketing_post('worker-a')").fetchall()   # holds the lock, uncommitted
        assert len(first) == 1
        as_service(b)
        b.execute("set local lock_timeout = '400ms'")
        with pytest.raises(psycopg.errors.LockNotAvailable):
            b.execute("select post_id from public.claim_marketing_post('worker-b')")   # blocked behind the first claim
        b.rollback()
        a.commit()
        as_service(b)
        second = b.execute("select post_id from public.claim_marketing_post('worker-b')").fetchall()
        b.commit()
        assert len(second) == 1 and second[0][0] != first[0][0]
        as_service(c)
        third = c.execute("select post_id from public.claim_marketing_post('worker-c')").fetchall()
        c.commit()
        assert third == [], "two posts are sending, so the weekly count is full: the third is never handed out"
        with as_superuser(conn, commit=False) as s:
            assert s.value("select count(*) from public.marketing_posts where idempotency_key = any(%s) and status = 'sending'", [keys]) == 2
            assert s.value("select count(*) from public.marketing_posts where idempotency_key = any(%s) and status = 'approved'", [keys]) == 1
    finally:
        for x in (a, b, c):
            if x is not None:
                x.close()
        with as_superuser(conn) as s:
            s.run("set local session_replication_role = replica")
            s.run("delete from public.marketing_posts where idempotency_key = any(%s)", [keys])
            s.run("update public.marketing_settings set enabled = false where id")


# ── expiry, age and the hash at the claim ───────────────────────────────────

def test_an_approval_lasts_72_hours_and_an_expired_one_is_never_sent(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:exp-1")
        r = row(t, pid)
        hours = t.sup("select extract(epoch from (expires_at - approved_at)) / 3600 from public.marketing_posts where id = %s", [pid])[0][0]
        assert hours == 72
        run(t, "update public.marketing_posts set expires_at = now() - interval '1 second' where id = %s", [pid])
        assert claim(t) == []
        r = row(t, pid)
        assert r["status"] == "expired" and r["last_error_code"] == "expired"
        assert approve(t, op, pid)["error"] == "not_draft"   # draft a new one


def test_an_approval_older_than_72_hours_is_not_sent_even_if_its_expiry_was_pushed_out(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:old-1")
        raw(t, "update public.marketing_posts set approved_at = now() - interval '73 hours', expires_at = now() + interval '5 days' where id = %s", [pid])
        assert claim(t) == [] and status(t, pid) == "approved"


def test_a_changed_hash_is_never_sent(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        tampered = approved(t, op, "news:hash-1", pr=1)
        raw(t, "update public.marketing_posts set texts = jsonb_set(texts, '{en}', '\"Sneaky words\"') where id = %s", [tampered])
        assert status(t, tampered) == "approved"   # the triggers were skipped: the content changed under the approval
        assert claim(t) == []
        assert status(t, tampered) == "approved"   # skipped, not touched: it expires on its own
        wrong = approved(t, op, "news:hash-2", pr=2)
        raw(t, "update public.marketing_posts set approved_hash = %s where id = %s", [OTHER_HASH, wrong])
        assert claim(t) == [] and status(t, wrong) == "approved"


def test_an_unapproved_draft_and_a_rejected_post_are_never_claimed(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        draft(t, "news:never-1")
        rejected = draft(t, "news:never-2")
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [rejected])["ok"]
        assert claim(t) == []


def test_old_drafts_expire(conn, sc):
    with tx(conn) as t:
        enable(t)
        pid = draft(t, "news:stale-draft")
        raw(t, "update public.marketing_posts set created_at = now() - interval '31 days' where id = %s", [pid])
        assert claim(t) == []
        assert status(t, pid) == "expired"


# ── a lost lease is never sent again ────────────────────────────────────────

def test_a_lost_lease_ends_as_unconfirmed_is_never_resent_and_keeps_its_slot(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        lost = approved(t, op, "news:lost-1", pr=1)
        assert [str(r[0]) for r in claim(t, "worker-1", 30)] == [str(lost)]
        run(t, "update public.marketing_posts set claimed_until = now() - interval '1 second' where id = %s", [lost])
        other = approved(t, op, "news:lost-2", pr=2)
        # the next claim settles the lost one first, then hands out the other: the lost one is not offered again
        got = claim(t, "worker-2")
        assert [str(r[0]) for r in got] == [str(other)]
        r = row(t, lost)
        assert r["status"] == "dead" and r["last_error_code"] == "unconfirmed"
        assert complete(t, lost, "worker-1", "sent") is False   # too late: it is settled as unconfirmed
        assert status(t, lost) == "dead"
        # it may be on the channel, so it still counts: with the other one sent the week is full
        assert complete(t, other, "worker-2", "sent", mid="1") is True
        assert used(t) == 2 and claim(t) == []


def test_a_lease_that_has_not_run_out_is_left_alone(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:lease-1")
        assert claim(t)
        assert claim(t, "worker-2") == [] and status(t, pid) == "sending"


# ── settling a claim ────────────────────────────────────────────────────────

def test_only_the_worker_holding_the_claim_settles_it(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:own-1")
        assert complete(t, pid, "worker-1", "sent") is False   # not claimed yet
        assert claim(t, "worker-1")
        assert complete(t, pid, "worker-2", "sent") is False
        assert status(t, pid) == "sending"
        assert t.as_(SERVICE).run("select public.complete_marketing_post(%s, 'worker-1', 'teleport')", [pid]).sqlstate == "22023"
        assert t.as_(SERVICE).run("select * from public.claim_marketing_post('')").sqlstate == "22023"
        assert t.as_(SERVICE).run("select * from public.claim_marketing_post('w', 120, 'instagram')").sqlstate == "22023"
        assert complete(t, pid, "worker-1", "sent", mid="777") is True
        assert complete(t, pid, "worker-1", "sent") is False   # settled once
        r = t.sup("select status, sent_at is not null, provider_message_id, last_error_code from public.marketing_posts where id = %s", [pid])[0]
        assert r == ("sent", True, "777", None)


def test_a_known_failure_is_failed_and_a_lost_answer_is_dead(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        p1 = approved(t, op, "news:fail-1", pr=1)
        assert claim(t)
        assert complete(t, p1, "worker-1", "failed", "blocked") is True
        r = row(t, p1)
        assert (r["status"], r["last_error_code"]) == ("failed", "blocked")
        assert used(t) == 0   # a post that certainly did not go out takes no slot
        p2 = approved(t, op, "news:fail-2", pr=2)
        assert claim(t)
        assert complete(t, p2, "worker-1", "dead") is True
        assert (row(t, p2)["status"], row(t, p2)["last_error_code"]) == ("dead", "unconfirmed")
        assert used(t) == 1
        p3 = approved(t, op, "news:fail-3", pr=3)
        assert claim(t)
        assert complete(t, p3, "worker-1", "failed", "not-in-the-list") is True
        assert row(t, p3)["last_error_code"] == "bad_request"
        assert [a[0] for a in audits(t, "marketing.fail")] == ["marketing.fail"] * 3


def test_only_a_request_that_never_left_is_retried(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:retry-1")
        assert claim(t, "worker-1")
        assert complete(t, pid, "worker-1", "retry", "rate_limited", 90) is True
        r = row(t, pid)
        assert r["status"] == "approved" and r["claimed_by"] is None and r["attempts"] == 0 and r["last_error_code"] == "rate_limited"
        assert t.sup("select next_attempt_at >= now() + interval '89 seconds' from public.marketing_posts where id = %s", [pid])[0][0] is True
        assert claim(t) == []   # not before the wait is over
        run(t, "update public.marketing_posts set next_attempt_at = now() where id = %s", [pid])
        assert claim(t, "worker-1")
        # a refused connection counts as an attempt; three of them end the post as failed
        assert complete(t, pid, "worker-1", "retry", "network") is True
        for _ in range(2):
            run(t, "update public.marketing_posts set next_attempt_at = now() where id = %s", [pid])
            assert claim(t, "worker-1")
            assert complete(t, pid, "worker-1", "retry", "network") is True
        r = row(t, pid)
        assert (r["status"], r["last_error_code"], r["attempts"]) == ("failed", "network", 3)


def test_a_retry_for_a_request_that_may_have_arrived_is_dead_not_retried(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        for i, code in enumerate(("http_5xx", None, "unconfirmed", "bad_request"), 1):
            pid = approved(t, op, f"news:maybe-{i}", pr=i)
            # a dead post keeps its slot, so move the earlier ones out of the 7-day window to leave room
            raw(t, "update public.marketing_posts set claimed_at = now() - interval '9 days' where status = 'dead'")
            assert claim(t, "worker-1"), code
            assert complete(t, pid, "worker-1", "retry", code) is True
            r = row(t, pid)
            assert (r["status"], r["last_error_code"]) == ("dead", "unconfirmed"), (code, r)


def test_the_send_and_the_failure_are_audited(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:aud-1")
        send(t, pid)
        sent = audits(t, "marketing.send")
        assert len(sent) == 1 and sent[0][3] == str(pid) and sent[0][4]["kind"] == "news"
        assert sent[0][1] is None   # the worker has no account
        assert [e[0] for e in events(t, "marketing.send")] == ["marketing.send"]


# ── the owner functions ─────────────────────────────────────────────────────

def test_reject_a_draft_or_withdraw_an_approved_post(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        d = draft(t, "news:rej-1", pr=1)
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'short')", [d])["error"] == "reason_required"
        assert t.as_(op).value("select public.owner_marketing_reject(%s, null)", [d])["error"] == "reason_required"
        out = t.as_(op).value("select public.owner_marketing_reject(%s, 'Not what we want to say')", [d])
        assert out == {"ok": True, "id": str(d), "status": "rejected", "from_status": "draft"}
        r = t.sup("select status, rejected_by, reject_reason, approved_hash from public.marketing_posts where id = %s", [d])[0]
        assert r[0] == "rejected" and str(r[1]) == op.uid and r[2] == "Not what we want to say" and r[3] is None
        a = approved(t, op, "news:rej-2", pr=2)
        out = t.as_(op).value("select public.owner_marketing_reject(%s, 'Changed our mind')", [a])
        assert out["from_status"] == "approved" and status(t, a) == "rejected"
        assert claim(t) == []
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'Too late for this one')", [a])["error"] == "not_rejectable"
        assert sorted(x[3] for x in audits(t, "marketing.reject")) == sorted([str(d), str(a)])


def test_every_owner_action_is_audited_in_the_same_transaction_with_the_actor(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = draft(t, "news:audit-1")
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({**TEXTS, "uz": "Yangi matn"})])["ok"]
        assert approve(t, op, pid)["ok"]
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({**TEXTS, "uz": "Boshqa matn"})])["approval_voided"]
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'Not what we want to say')", [pid])["ok"]
        t.as_(op).value("select public.owner_marketing_kill(true, null)")
        for action, n in (("marketing.edit", 2), ("marketing.approve", 1), ("marketing.reject", 1), ("marketing.kill", 1)):
            rows = audits(t, action)
            assert len(rows) == n, (action, rows)
            assert all(r[1] == op.uid and r[2] == op.email for r in rows), rows
            assert len(events(t, action)) == n
        edits = audits(t, "marketing.edit")
        assert sorted(e[4]["approval_voided"] for e in edits) == [False, True]
        voided = next(e for e in edits if e[4]["approval_voided"])
        assert voided[4]["chars"] == {"uz": 11, "ru": len(TEXTS["ru"]), "en": len(TEXTS["en"])}
        # the approval names the hash it approved, which is the hash of the words before the later edit
        assert re.fullmatch(r"[0-9a-f]{64}", audits(t, "marketing.approve")[0][4]["content_hash"])
        assert [e[1] for e in events(t, "marketing.approve")] == ["warning"]


def test_the_audit_is_part_of_the_change_not_beside_it(conn, sc, op):
    # If the audit list ever stops allowing a name, the action fails whole: nothing is approved without a record.
    with tx(conn) as t:
        enable(t)
        pid = draft(t, "news:atomic-1")
        h = chash(t, pid)
        t.sup("create or replace function public.audit_action_allowed(p_action text) returns boolean "
              "language sql immutable as $$ select false $$")
        out = t.as_(op).run("select public.owner_marketing_approve(%s, %s)", [pid, h])
        assert not out.ok and out.sqlstate == "22023", out   # 'unknown audit action' from the audit trail's own guard
        assert status(t, pid) == "draft"


def test_the_owner_reads_the_settings_and_the_weeks_count(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        out = t.as_(op).value("select public.owner_marketing_get()")
        assert (out["ok"], out["enabled"], out["max_per_7d"], out["used_7d"], out["approved_waiting"]) == (True, True, 2, 0, 0)
        p1 = approved(t, op, "news:get-1", pr=1)
        approved(t, op, "news:get-2", pr=2)
        assert t.as_(op).value("select public.owner_marketing_get()")["approved_waiting"] == 2
        send(t)
        out = t.as_(op).value("select public.owner_marketing_get()")
        assert (out["used_7d"], out["approved_waiting"]) == (1, 1)


def test_an_unknown_post_is_an_answer_not_an_error(conn, sc, op):
    with tx(conn) as t:
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [ZERO_UUID, json.dumps(TEXTS)])["error"] == "no_such_post"
        assert t.as_(op).value("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [ZERO_UUID])["error"] == "no_such_post"
        enable(t)
        pid = approved(t, op, "news:sent-edit-2")
        send(t, pid)
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps(TEXTS)])["error"] == "not_editable"


# ── review round: owner edits survive the worker, the poster must be on, the link is hashed ──────────────

def upsert(t, key, texts=None, pr=10, link=None, **kw):
    return t.as_(SERVICE).value("select public.marketing_draft_upsert(%s, 'news', %s::jsonb, %s, '{}'::jsonb, null, null, 'telegram', %s)",
                                [key, json.dumps(texts or TEXTS), f"pr:#{pr}", link])


def test_the_worker_never_overwrites_a_draft_the_owner_edited(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = draft(t, "news:own-edit-1")
        owner_words = {**TEXTS, "en": "The owner's own words"}
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps(owner_words)])["ok"]
        # the news file is read again (the worker loops): with its old text, or with a newer one
        for file_text in (TEXTS, {**TEXTS, "en": "A newer file text"}):
            out = upsert(t, "news:own-edit-1", file_text)
            assert out["created"] is False and out["updated"] is False and out["owner_edited"] is True, out
            assert row(t, pid)["texts"] == owner_words
        # a draft nobody edited still follows the file
        other = draft(t, "news:own-edit-2")
        assert upsert(t, "news:own-edit-2", {**TEXTS, "en": "File changed"}, pr=10)["updated"] is True
        assert row(t, other)["texts"]["en"] == "File changed"


def test_an_approved_post_the_owner_edited_back_to_draft_keeps_the_owners_words(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:own-edit-3")
        owner_words = {**TEXTS, "ru": "Слова владельца"}
        out = t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps(owner_words)])
        assert out["approval_voided"] is True and status(t, pid) == "draft"
        out = upsert(t, "news:own-edit-3", {**TEXTS, "ru": "Текст файла"})
        assert out["updated"] is False and out["owner_edited"] is True
        assert row(t, pid)["texts"] == owner_words and status(t, pid) == "draft"


def test_approving_is_refused_while_the_poster_is_off_and_nothing_is_used_up(conn, sc, op):
    with tx(conn) as t:
        pid = draft(t, "news:off-approve-1")
        assert t.sup("select enabled from public.marketing_settings")[0][0] is False
        out = approve(t, op, pid)
        assert out["error"] == "poster_off", out
        r = row(t, pid)
        assert r["status"] == "draft" and r["approved_hash"] is None   # still a draft: the key is not burnt
        assert t.sup("select count(*) from public.app_audit_log where action = 'marketing.approve'")[0][0] == 0
        # the kill switch turns approving off too
        enable(t)
        assert approve(t, op, pid)["ok"]
        other = draft(t, "news:off-approve-2", pr=11)
        assert t.as_(op).value("select public.owner_marketing_kill(true, null)")["enabled"] is False
        assert approve(t, op, other)["error"] == "poster_off"
        # approving an already approved post is still an answer, and re-arming needs a reason
        assert t.as_(op).value("select public.owner_marketing_kill(false, 'The channel is ready again')")["enabled"] is True
        assert approve(t, op, other)["ok"]


def test_an_approval_that_lapsed_unswept_is_expired_not_already_approved(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:lapsed-1")
        run(t, "update public.marketing_posts set expires_at = now() - interval '1 second' where id = %s", [pid])
        assert status(t, pid) == "approved"          # nothing has swept it yet
        out = approve(t, op, pid)
        assert out["error"] == "expired" and out.get("already") is None, out
        r = row(t, pid)
        assert (r["status"], r["last_error_code"]) == ("expired", "expired")
        assert approve(t, op, pid)["error"] == "not_draft"


def test_the_link_is_part_of_what_is_approved(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = upsert(t, "news:link-1", link="/pricing")["id"]
        seen = chash(t, pid)
        assert upsert(t, "news:link-1", link="/studio")["updated"] is True      # the file's link changed while the owner read it
        assert chash(t, pid) != seen
        assert approve(t, op, pid, seen)["error"] == "content_changed"          # a stale approval is blocked
        assert approve(t, op, pid)["ok"]
        got = claim(t)
        assert [str(got[0][0]), got[0][5]] == [str(pid), "/studio"]
        # the hash function itself separates the same words with and without a link
        h = lambda link: t.sup("select public.marketing_post_hash('news', 'telegram', %s::jsonb, null, %s)", [json.dumps(TEXTS), link])[0][0]
        assert len({h(None), h("/pricing"), h("/studio"), h("/pricing/")}) == 4


def test_a_link_written_under_an_approval_voids_it_and_a_tampered_one_is_not_sent(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        voided = approved(t, op, "news:link-2", pr=1)
        assert run(t, "update public.marketing_posts set link = '/other' where id = %s", [voided]).ok
        assert row(t, voided)["status"] == "draft" and row(t, voided)["approved_hash"] is None
        tampered = approved(t, op, "news:link-3", pr=2)
        raw(t, "update public.marketing_posts set link = '/evil' where id = %s", [tampered])   # the triggers were skipped
        assert [r for r in claim(t) if str(r[0]) == str(tampered)] == []
        assert status(t, tampered) == "approved"


def test_a_showcase_needs_its_video(conn, sc):
    key, src = "showcase:00000000-0000-0000-0000-000000000001", "asset:00000000-0000-0000-0000-000000000001"
    ins = ("insert into public.marketing_posts (idempotency_key, kind, texts, source_ref, media_path) "
           "values (%s, 'showcase', %s::jsonb, %s, %s)")
    with tx(conn) as t:
        assert run(t, ins, [key, json.dumps(TEXTS), src, None]).sqlstate == "23514"
        assert run(t, ins, [key, json.dumps(TEXTS), src, "showcase/clip.mp4"]).ok


@pytest.mark.parametrize("columns,values,why", [
    ("idempotency_key, kind, source_ref", ("price:x1", "news", "pr:#1"), "a key must start with its kind"),
    ("idempotency_key, kind, source_ref", ("news:has space", "news", "pr:#1"), "unsafe characters in the key"),
    ("idempotency_key, kind, source_ref", ("news:" + "x" * 101, "news", "pr:#1"), "key longer than 100 after the kind"),
    ("idempotency_key, kind, source_ref", ("news:x1", "news", "plan:plus"), "source does not match the kind"),
    ("idempotency_key, kind, source_ref", ("news:x1", "tweet", "pr:#1"), "unknown kind"),
    ("idempotency_key, kind, source_ref, media_path", ("news:x1", "news", "pr:#1", "previews/private.mp4"), "private bucket"),
    ("idempotency_key, kind, source_ref, media_path", ("news:x1", "news", "pr:#1", "showcase/../previews/x.mp4"), "path traversal"),
    ("idempotency_key, kind, source_ref, link", ("news:x1", "news", "pr:#1", "https://evil.example/"), "a link is a path"),
    ("idempotency_key, kind, source_ref, link", ("news:x1", "news", "pr:#1", "//evil.example"), "a protocol-relative link"),
    ("idempotency_key, kind, source_ref, target", ("news:x1", "news", "pr:#1", "instagram"), "only telegram exists"),
])
def test_the_table_checks_hold_for_a_direct_insert(conn, columns, values, why):
    cols = columns.split(", ")
    with tx(conn) as t:
        out = run(t, f"insert into public.marketing_posts ({columns}, texts) values ({', '.join(['%s'] * len(cols))}, %s::jsonb)",
                  [*values, json.dumps(TEXTS)])
        assert out.sqlstate == "23514", (why, out)


@pytest.mark.parametrize("texts,ok", [
    (TEXTS, True),
    ({**TEXTS, "fr": "Un texte"}, False),
    ({"uz": "a", "ru": "b"}, False),
    ({"uz": "a", "ru": "b", "xx": "c"}, False),
    ({**TEXTS, "en": "x" * 1001}, False),
    ({**TEXTS, "en": "line one\nline two"}, True),
    ({**TEXTS, "en": "tab\there"}, False),
    ({**TEXTS, "en": "trailing\n"}, False),
    ({**TEXTS, "en": "\tleading"}, False),
])
def test_marketing_texts_ok_and_the_table_check_agree(conn, texts, ok):
    with tx(conn) as t:
        assert t.sup("select public.marketing_texts_ok(%s::jsonb, false)", [json.dumps(texts)])[0][0] is ok
        out = run(t, "insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) values ('news:chk-1', 'news', %s::jsonb, 'pr:#1')",
                  [json.dumps(texts)])
        assert out.ok is ok, out
    with tx(conn) as t:
        assert t.sup("select public.marketing_texts_ok(%s::jsonb, true)", [json.dumps({"uz": "a" * 300, "ru": "b", "en": "c"})])[0][0] is True
        assert t.sup("select public.marketing_texts_ok(%s::jsonb, true)", [json.dumps({"uz": "a" * 900, "ru": "b", "en": "c"})])[0][0] is False


def test_surrounding_whitespace_of_every_kind_is_trimmed_before_it_is_checked(conn, sc, op):
    with tx(conn) as t:
        padded = {"uz": "\n\tNamuna matn \r\n", "ru": " Пример текста\n", "en": "\tSample text\t"}
        out = upsert(t, "news:trim-1", padded)
        assert out["ok"], out
        assert row(t, out["id"])["texts"] == TEXTS
        edited = t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [out["id"], json.dumps({**padded, "en": "\n Edited text \n"})])
        assert edited["ok"] and row(t, out["id"])["texts"]["en"] == "Edited text"
        # trimming leaves an empty text empty, and that is refused
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [out["id"], json.dumps({**TEXTS, "en": " \n\t "})])["error"] == "bad_texts"


INVISIBLE = ["‮", "‭", "‪", "‬", "⁦", "⁧", "⁨", "⁩", "​", "‌", "‍",
             "‎", "‏", " ", " ", "\u0085", "﻿", "­", "⁠", "\u0007", "\u007f", "\u009f"]


@pytest.mark.parametrize("ch", INVISIBLE, ids=[f"U+{ord(c):04X}" for c in INVISIBLE])
def test_invisible_and_direction_changing_characters_are_refused_everywhere(conn, sc, op, ch):
    bad = {**TEXTS, "en": f"Sample{ch}text"}
    with tx(conn) as t:
        assert upsert(t, "news:inv-1", bad)["error"] == "bad_texts"
        pid = draft(t, "news:inv-2")
        assert t.as_(op).value("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps(bad)])["error"] == "bad_texts"
        assert t.sup("select public.marketing_texts_ok(%s::jsonb, false)", [json.dumps(bad)])[0][0] is False
        assert run(t, "update public.marketing_posts set texts = %s::jsonb where id = %s", [json.dumps(bad), pid]).sqlstate == "23514"
        assert row(t, pid)["texts"] == TEXTS


# ── review round: the window, the lease, the expiry in the trigger ──────────

def test_the_seven_day_window_edges(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        a = approved(t, op, "news:win-1", pr=1)
        send(t, a)
        for age, counted in (("6 days 23 hours", 1), ("6 days 23 hours 59 minutes", 1), ("7 days 1 minute", 0), ("30 days", 0)):
            raw(t, "update public.marketing_posts set sent_at = now() - %s::interval, claimed_at = now() - %s::interval where id = %s", [age, age, a])
            assert used(t) == counted, (age, used(t))
        # a sending or dead post is measured from its claim
        raw(t, "update public.marketing_posts set status = 'dead', last_error_code = 'unconfirmed', sent_at = null, "
               "claimed_at = now() - interval '6 days 23 hours' where id = %s", [a])
        assert used(t) == 1
        raw(t, "update public.marketing_posts set claimed_at = now() - interval '7 days 1 minute' where id = %s", [a])
        assert used(t) == 0


@pytest.mark.parametrize("asked,expected", [(1, 30), (30, 30), (120, 120), (600, 600), (601, 600), (99999, 600), (None, 120)])
def test_the_lease_is_clamped_to_30_through_600_seconds(conn, sc, op, asked, expected):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:lease-clamp")
        out = t.as_(SERVICE).run("select count(*) from public.claim_marketing_post('w-clamp', %s)", [asked])
        assert out.ok and out.rows[0][0] == 1, out
        secs = t.sup("select round(extract(epoch from (claimed_until - claimed_at))) from public.marketing_posts where id = %s", [pid])[0][0]
        assert secs == expected


def test_the_trigger_itself_refuses_to_send_on_an_expired_approval(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = approved(t, op, "news:trig-exp")
        run(t, "update public.marketing_posts set expires_at = now() - interval '1 second' where id = %s", [pid])
        out = run(t, "update public.marketing_posts set status = 'sending', claimed_by = 'w', claimed_at = now(), "
                     "claimed_until = now() + interval '1 minute' where id = %s", [pid])
        assert out.sqlstate == "23514" and "current, matching approval" in out.error, out
        # and a matching, live approval is allowed through by the same statement
        fresh = approved(t, op, "news:trig-ok", pr=2)
        assert run(t, "update public.marketing_posts set status = 'sending', claimed_by = 'w', claimed_at = now(), "
                      "claimed_until = now() + interval '1 minute' where id = %s", [fresh]).ok


def test_approving_waits_for_a_claim_in_flight_and_then_sees_its_slot(conn, sc):
    keys = ["news:race-1", "news:race-2"]
    a = b = None
    try:
        with as_superuser(conn) as s:   # committed: two sessions cannot see each other's rolled-back rows
            s.rows("update public.marketing_settings set enabled = true, max_per_7d = 1 where id returning 1")
            for i, key in enumerate(keys, 1):
                s.rows("insert into public.marketing_posts (idempotency_key, kind, texts, source_ref) "
                       "values (%s, 'news', %s::jsonb, %s) returning 1", [key, json.dumps(TEXTS), f"pr:#8{i}"])
            s.rows("update public.marketing_posts set status = 'approved', approved_by = %s, approved_at = now(), "
                   "approved_hash = content_hash, expires_at = now() + interval '72 hours' where idempotency_key = %s returning 1",
                   [sc.operator.uid, keys[0]])
            draft_id, draft_hash = s.rows("select id, content_hash from public.marketing_posts where idempotency_key = %s", [keys[1]])[0]

        def as_(conn_, claims):
            conn_.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
            conn_.execute(f"set local role {claims['role']}")

        a, b = second_connection(conn), second_connection(conn)
        as_(a, {"role": "service_role"})
        assert len(a.execute("select post_id from public.claim_marketing_post('worker-a')").fetchall()) == 1   # lock held, uncommitted
        operator = {"role": "authenticated", "sub": sc.operator.uid, "email": sc.operator.email}
        as_(b, operator)
        b.execute("set local lock_timeout = '400ms'")
        with pytest.raises(psycopg.errors.LockNotAvailable):
            b.execute("select public.owner_marketing_approve(%s, %s)", [draft_id, draft_hash])   # waits behind the claim
        b.rollback()
        a.commit()
        as_(b, operator)
        out = b.execute("select public.owner_marketing_approve(%s, %s)", [draft_id, draft_hash]).fetchone()[0]
        b.rollback()
        assert out["error"] == "cap_full" and out["used_7d"] == 1 and out["max_per_7d"] == 1, out   # it sees the claimed slot
    finally:
        for x in (a, b):
            if x is not None:
                x.close()
        with as_superuser(conn) as s:
            s.run("set local session_replication_role = replica")
            s.run("delete from public.marketing_posts where idempotency_key = any(%s)", [keys])
            s.run("update public.marketing_settings set enabled = false, max_per_7d = 2 where id")


# ── the second factor and the rate limit ────────────────────────────────────

def test_with_the_gate_on_a_password_only_session_is_refused_and_nothing_moves(conn, sc, op):
    with tx(conn) as t:
        enable(t)
        pid = draft(t, "news:gate-1")
        h = chash(t, pid)
        approved_one = approved(t, op, "news:gate-2", pr=2)
        gate_on(t)
        factors(t, op, 2)
        calls = [("select public.owner_marketing_edit(%s, %s::jsonb)", [pid, json.dumps({**TEXTS, "en": "Gated"})]),
                 ("select public.owner_marketing_approve(%s, %s)", [pid, h]),
                 ("select public.owner_marketing_reject(%s, 'A reason that is long enough')", [pid]),
                 ("select public.owner_marketing_kill(true, null)", [])]
        for query, params in calls:
            out = t.as_(op).value(query, params)
            assert out["error"] == "mfa_required" and out["why"] == "aal1", (query, out)
        assert status(t, pid) == "draft" and row(t, pid)["texts"] == TEXTS
        assert t.sup("select enabled from public.marketing_settings")[0][0] is True
        assert t.sup("select count(*) from public.app_audit_log where action like 'marketing.%%' and target = %s", [str(pid)])[0][0] == 0
        # a fresh authenticator code opens the door
        fresh = {"aal": "aal2", "amr": aal2(1)["amr"]}
        out = t.as_(op, extra={"amr": fresh["amr"]}, aal="aal2").value("select public.owner_marketing_approve(%s, %s)", [pid, h])
        assert out["ok"], out
        # the worker is not behind the gate: it has no person to ask
        got = claim(t)
        assert len(got) == 1 and str(got[0][0]) in (str(approved_one), str(pid))


def test_the_owner_actions_are_rate_limited_per_person(conn, sc, op):
    with tx(conn) as t:
        results = [t.as_(op).value("select public.owner_marketing_kill(true, null)") for _ in range(21)]
        assert [r.get("error") for r in results[:20]] == [None] * 20
        assert results[20]["error"] == "rate_limited"


# ── the audit list ──────────────────────────────────────────────────────────

def _list(text):
    block = re.search(r"create or replace function public\.audit_action_allowed.*?any \(array\[(.*?)\]::text\[\]\)", text, re.S).group(1)
    return set(re.findall(r"'([a-z_.]+)'", block))


def test_the_audit_list_keeps_every_0107_action_and_adds_exactly_eight(conn):
    old = _list(PREVIOUS.read_text(encoding="utf-8"))
    new = _list(MIGRATION.read_text(encoding="utf-8"))
    assert old <= new, sorted(old - new)
    assert new - old == NEW_ACTIONS
    assert len(old) >= 70
    with as_superuser(conn, commit=False) as s:
        for a in sorted(new) + ["social.instagram.connect", "social.tiktok.disconnect", "learning.approve", "learning.reject"]:
            assert s.value("select public.audit_action_allowed(%s)", [a]) is True, a
        for a in ("marketing.steal", "marketing", "showcase.delete", "Marketing.send", "", None, "marketing.send ", "social.youtube.connect"):
            assert s.value("select public.audit_action_allowed(%s)", [a]) is False, a


def test_a_customer_cannot_forge_a_marketing_audit_row(conn, sc):
    with tx(conn) as t:
        s = t.as_(sc.bob.actor)
        out = s.run("insert into public.app_audit_log (actor_user_id, action, channel_id) values (%s, 'marketing.send', null)", [sc.bob.actor.uid])
        assert not out.ok and out.sqlstate == "42501", out


# ── replay and rollback ─────────────────────────────────────────────────────

def test_the_migration_replays_without_changing_state(conn, sc, op):
    text = MIGRATION.read_text(encoding="utf-8")
    with tx(conn) as t:
        enable(t)
        t.sup("update public.marketing_settings set max_per_7d = 1 where id returning 1")
        pid = draft(t, "news:replay-1", pr=1)
        assert approve(t, op, pid)["ok"]
        before = t.sup("select count(*) from public.marketing_posts")[0][0]
        t.conn.execute(text)
        assert t.sup("select enabled, max_per_7d from public.marketing_settings") == [(True, 1)]   # the seed is ON CONFLICT DO NOTHING
        assert t.sup("select count(*) from public.marketing_posts")[0][0] == before
        assert status(t, pid) == "approved"
        assert t.as_(op).value("select public.owner_marketing_get()")["ok"] is True
        # ... and the guards still hold afterwards
        assert run(t, "update public.marketing_posts set status = 'sent' where id = %s", [pid]).sqlstate == "23514"


def test_the_function_acls_survive_a_replay(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    with tx(conn) as t:
        t.conn.execute(text)
        for fn in ("owner_marketing_get()", "owner_marketing_edit(uuid,jsonb)", "owner_marketing_approve(uuid,text)",
                   "owner_marketing_reject(uuid,text)", "owner_marketing_kill(boolean,text)"):
            assert [t.sup("select has_function_privilege(%s, %s, 'EXECUTE')", [r, "public." + fn])[0][0]
                    for r in ("anon", "authenticated", "service_role")] == [False, True, False], fn
        for fn in ("claim_marketing_post(text,integer,text)", "complete_marketing_post(uuid,text,text,text,integer,text)",
                   "marketing_draft_upsert(text,text,jsonb,text,jsonb,timestamptz,text,text,text)"):
            assert [t.sup("select has_function_privilege(%s, %s, 'EXECUTE')", [r, "public." + fn])[0][0]
                    for r in ("anon", "authenticated", "service_role")] == [False, False, True], fn
        for table, want in (("marketing_posts", (False, True, False)), ("marketing_settings", (False, False, False)),
                            ("showcase_assets", (False, False, False))):
            assert tuple(t.sup("select has_table_privilege(%s, %s, 'SELECT')", [r, "public." + table])[0][0]
                         for r in ("anon", "authenticated", "service_role")) == want, table
        assert t.sup("select count(*) from pg_policies where schemaname = 'public' and tablename = 'marketing_posts'")[0][0] == 1


def test_the_rollback_file_removes_exactly_what_the_migration_added_and_the_migration_comes_back(conn, sc, op):
    rollback = ROLLBACK.read_text(encoding="utf-8")
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    assert "begin;" in rollback and "commit;" in rollback
    assert _list(rollback) == _list(PREVIOUS.read_text(encoding="utf-8"))
    with tx(conn) as t:
        before_fn = {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")}
        t.conn.execute(body)
        after_fn = {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")}
        added = set(re.findall(r"create or replace function public\.(\w+)", MIGRATION.read_text(encoding="utf-8"))) - {"audit_action_allowed"}
        assert before_fn - after_fn == added, sorted((before_fn - after_fn) ^ added)
        assert t.sup("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in "
                     "('marketing_posts', 'marketing_settings', 'showcase_assets')")[0][0] == 0
        assert t.sup("select public.audit_action_allowed('marketing.send'), public.audit_action_allowed('credits.grant'), "
                     "public.audit_action_allowed('mcp.limit')")[0] == (False, True, True)
        # 0107 is untouched by the rollback
        assert t.as_(op).value("select public.owner_security_get()")["ok"] is True
        # and applying the migration again restores everything
        t.conn.execute("reset role")
        t.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert {r[0] for r in t.sup("select proname from pg_proc where pronamespace = 'public'::regnamespace")} == before_fn
        assert t.sup("select public.audit_action_allowed('marketing.send')")[0][0] is True
        assert t.sup("select enabled from public.marketing_settings")[0][0] is False
        pid = draft(t, "news:back-1")
        assert approve(t, op, pid)["error"] == "poster_off"   # dormant again after the re-apply
        enable(t)
        assert approve(t, op, pid)["ok"]


# ── nothing reaches it yet ──────────────────────────────────────────────────

def test_the_poster_cannot_post_on_its_own_it_only_hands_out_what_a_person_approved(conn, sc, op):
    # The whole chain in one place: draft (worker) -> approve (owner, MFA-gated) -> claim (worker) -> settle.
    with tx(conn) as t:
        enable(t)
        pid = draft(t, "news:chain-1")
        assert claim(t) == []                       # a draft is not sendable
        assert approve(t, op, pid)["ok"]
        got = claim(t)
        assert [str(r[0]) for r in got] == [str(pid)]
        assert got[0][3] == TEXTS and got[0][4] is None and got[0][5] is None   # exactly the approved words, no media, no link
        assert got[0][7] == t.sup("select approved_hash from public.marketing_posts where id = %s", [pid])[0][0]
        assert complete(t, pid, "worker-1", "sent", mid="9") is True
        assert status(t, pid) == "sent"


def test_nothing_in_the_repository_calls_the_new_objects_but_the_poster_and_the_owner_page():
    # The same allow-list as tests/test_marketing_posts_migration.py (which also scans .github): the poster worker and
    # its two modules, and the owner page with its route. This test said "nothing at all" and so failed on main once
    # those slices merged (the security job only runs on a change under supabase/ or tests/security/, so it had not run).
    poster = {"tools/marketing_worker.py", "modules/channel_post.py", "modules/marketing_content.py"}
    owner_page = {
        "command-center/app/(app)/[channel]/marketing/page.tsx",
        "command-center/app/api/marketing/route.ts",
        "command-center/components/marketing/MarketingBoard.tsx",
        "command-center/lib/marketing-posts.ts",
        "command-center/lib/server/marketing.ts",
    }
    names = re.compile(r"marketing_posts|marketing_settings|showcase_assets|owner_marketing_|claim_marketing_post|"
                       r"complete_marketing_post|marketing_draft_upsert")
    offenders = []
    for root in ("command-center/app", "command-center/lib", "command-center/components", "modules", "tools", "main.py", "supabase/functions"):
        base = REPO / root
        files = [base] if base.is_file() else [p for p in base.rglob("*") if p.is_file() and p.suffix in (".ts", ".tsx", ".py", ".js", ".sql")]
        offenders += [str(p.relative_to(REPO)) for p in files if names.search(p.read_text(encoding="utf-8", errors="ignore"))]
    assert sorted(set(offenders) - poster - owner_page) == [], offenders
