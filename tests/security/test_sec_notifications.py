"""Migration 0064: a notification is one person's own, in one organization.

What would break without these:

* another organization reading (or marking read) a tenant's notifications —
  which name its jobs, storyboards, exports and how many credits it has left;
* another member of the SAME organization, its owner or a platform admin
  reading a colleague's inbox (a generation they started is theirs to hear
  about);
* a browser inserting, editing or deleting a notification (a forged "your
  credits were returned", or an unread count nobody can clear);
* `mark_all_notifications_read` clearing someone else's rows, or telling a
  caller whether an id belongs to anybody;
* a notification delivered to a person who left the organization, or one that
  carries a prompt, a title, an e-mail address or provider text;
* a failure to write a notification rolling back the job, refund or export it
  was reporting;
* the inbox growing without bound.

Isolation (read / update / delete / insert, row by row) of ``notifications`` is
covered by test_sec_isolation.py through sec_expectations.TABLES.
"""

from __future__ import annotations

import json
import re
import uuid
from contextlib import contextmanager

import pytest

from sec_db import ANON, SERVICE, acting, as_superuser, user
from sec_scenario import DEFAULT_ORG
from sec_storyboard_0057 import insert as insert_storyboard
import sec_editor_0054

ALLOWED_DATA_KEYS = {
    "job_id", "capability", "code", "credits_returned", "credits_charged",
    "storyboard_id", "scenes", "export_id", "project_id", "asset_id", "available",
}


# ── helpers ─────────────────────────────────────────────────────────────────

def as_owner(s):
    """The database owner again, inside the same transaction."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def as_user(s, actor):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role authenticated")
    return s


def inbox(s, actor, *, org=None):
    """What `actor` reads from the table, through the browser's own path."""
    as_user(s, actor)
    q = "select id::text, org_id::text, user_id::text, kind, ref, data, read_at from public.notifications"
    out = s.run(q + (" where org_id = %s" if org else ""), [org] if org else None)
    as_owner(s)
    assert out.ok, out
    return [dict(zip(("id", "org_id", "user_id", "kind", "ref", "data", "read_at"), r)) for r in out.rows]


def kinds(rows):
    return sorted(r["kind"] for r in rows)


@contextmanager
def colleague(conn, sc):
    """A second member of org A with an account of their own, in a world that
    is rolled back: Carol. Yields (session as owner, carol)."""
    carol = user("carol", f"carol-{uuid.uuid4().hex[:6]}@a.test")
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning id",
               [carol.uid, carol.email])
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
               [sc.alice.org, carol.uid, carol.email])
        yield s, carol


def new_job(s, tenant, requester, *, status="running", payer="credits", kind="generate", credit_ref="auto"):
    if credit_ref == "auto":
        credit_ref = f"hold-{uuid.uuid4()}"
    return str(s.value(
        "insert into public.creative_jobs (org_id, kind, capability, requested_model, routed_model, params, status, "
        "quoted_credits, requested_by, payer, credit_ref) "
        "values (%s, %s, 't2i', 'img-x', 'img-x', '{\"prompt\": \"a secret prompt\"}', %s, 6, %s, %s, %s) returning id",
        [tenant.org, kind, status, requester, payer, credit_ref]))


def set_status(s, job, status, **cols):
    sets = ", ".join(f"{k} = %s" for k in cols)
    s.rows(f"update public.creative_jobs set status = %s{', ' + sets if sets else ''} where id = %s returning 1",
           [status, *cols.values(), job])


# ── the isolation the table promises ────────────────────────────────────────

def test_each_tenant_reads_its_own_notification_and_never_the_others(conn, sc):
    with as_superuser(conn, commit=False) as s:
        a, b = inbox(s, sc.alice.actor), inbox(s, sc.bob.actor)
    assert a and b, "control: both tenants were told about their waiting storyboard"
    assert {r["org_id"] for r in a} == {sc.alice.org} and {r["user_id"] for r in a} == {sc.alice.actor.uid}
    assert {r["org_id"] for r in b} == {sc.bob.org} and {r["user_id"] for r in b} == {sc.bob.actor.uid}
    assert not {r["id"] for r in a} & {r["id"] for r in b}


def test_another_org_cannot_read_by_id_org_or_filter(conn, sc):
    with as_superuser(conn, commit=False) as s:
        theirs = [r["id"] for r in inbox(s, sc.alice.actor)]
        assert theirs
        as_user(s, sc.bob.actor)
        by_id = s.rows("select id from public.notifications where id = any(%s::uuid[])", [theirs])
        by_org = s.rows("select id from public.notifications where org_id = %s", [sc.alice.org])
        by_user = s.rows("select id from public.notifications where user_id = %s", [sc.alice.actor.uid])
        counted = s.value("select count(*) from public.notifications where org_id = %s and read_at is null",
                          [sc.alice.org])
    assert by_id == by_org == by_user == [] and counted == 0


def test_a_colleague_in_the_same_org_cannot_read_my_inbox_and_i_cannot_read_theirs(conn, sc):
    with colleague(conn, sc) as (s, carol):
        # One storyboard waiting in org A tells both members, each their own row.
        as_owner(s)
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'credits_low', 'low:x', '{\"available\": 3}'::jsonb)) q",
               [sc.alice.org, carol.uid])
        alice, caro = inbox(s, sc.alice.actor), inbox(s, carol)
        assert "credits_low" in kinds(caro) and "credits_low" not in kinds(alice)
        assert {r["user_id"] for r in alice} == {sc.alice.actor.uid}
        assert {r["user_id"] for r in caro} == {carol.uid}
        # Not even by naming the other's rows.
        as_user(s, carol)
        out = s.rows("select id from public.notifications where user_id = %s", [sc.alice.actor.uid])
    assert out == []


def test_a_platform_admin_does_not_read_a_customers_inbox(conn, sc):
    with as_superuser(conn, commit=False) as s:
        assert inbox(s, sc.alice.actor), "control: the inbox has rows"
        assert inbox(s, sc.operator) == []
        as_user(s, sc.operator)
        counted = s.value("select count(*) from public.notifications")
    assert counted == 0


def test_a_stranger_and_anon_read_nothing_and_cannot_call_the_functions(conn, sc):
    with acting(conn, sc.stranger) as s:
        assert s.rows("select id from public.notifications") == []
        assert s.value("select public.mark_all_notifications_read(null)") == 0
    with acting(conn, ANON) as s:
        read = s.run("select id from public.notifications")
        one = s.run("select public.mark_notification_read(%s)", [str(uuid.uuid4())])
        every = s.run("select public.mark_all_notifications_read(null)")
    assert not read.ok and read.sqlstate == "42501", read
    assert not one.ok and one.sqlstate == "42501", one
    assert not every.ok and every.sqlstate == "42501", every


# ── nobody writes the table directly ────────────────────────────────────────

def test_no_api_role_inserts_updates_or_deletes_a_notification(conn, sc):
    with as_superuser(conn, commit=False) as s:
        mine = inbox(s, sc.alice.actor)[0]["id"]
    for who in (sc.alice.actor, sc.bob.actor, sc.operator, SERVICE, ANON):
        with acting(conn, who) as s:
            ins = s.run("insert into public.notifications (org_id, user_id, kind, ref) values (%s, %s, 'credits_low', 'forged') returning 1",
                        [sc.alice.org, sc.alice.actor.uid])
            upd = s.run("update public.notifications set read_at = now() where id = %s returning 1", [mine])
            dele = s.run("delete from public.notifications where id = %s returning 1", [mine])
            trunc = s.run("truncate public.notifications")
        for o in (ins, upd, dele, trunc):
            assert not o.ok and o.sqlstate == "42501", (who.name, o)
    with as_superuser(conn, commit=False) as s:
        assert s.value("select read_at is null from public.notifications where id = %s", [mine])
        assert s.value("select count(*) from public.notifications where ref = 'forged'") == 0


def test_the_service_key_cannot_read_an_inbox_either(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run("select id from public.notifications")
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("fn,args", [
    ("notification_emit", "%s, %s, 'credits_low', 'x', '{}'::jsonb"),
    ("notification_emit_org", "%s, 'credits_low', 'x', '{}'::jsonb"),
])
def test_the_emit_helpers_are_not_callable_through_the_api(conn, sc, fn, args):
    params = [sc.alice.org, sc.alice.actor.uid][: args.count("%s")]
    for who in (sc.alice.actor, sc.operator, SERVICE, ANON):
        with acting(conn, who) as s:
            out = s.run(f"select public.{fn}({args})", params)
        assert not out.ok and out.sqlstate == "42501", (who.name, fn, out)


# ── mark read ───────────────────────────────────────────────────────────────

def test_mark_read_clears_only_my_own_row(conn, sc):
    with colleague(conn, sc) as (s, carol):
        as_owner(s)
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'credits_low', 'low:y', '{\"available\": 3}'::jsonb)) q",
               [sc.alice.org, carol.uid])
        mine = next(r for r in inbox(s, sc.alice.actor) if r["kind"] == "storyboard_ready")
        theirs = next(r for r in inbox(s, carol) if r["kind"] == "credits_low")
        as_user(s, sc.alice.actor)
        ok = s.value("select public.mark_notification_read(%s)", [mine["id"]])
        again = s.value("select public.mark_notification_read(%s)", [mine["id"]])
        # Carol's id, from Alice: the same answer as an id nobody has.
        foreign = s.value("select public.mark_notification_read(%s)", [theirs["id"]])
        made_up = s.value("select public.mark_notification_read(%s)", [str(uuid.uuid4())])
        as_owner(s)
        carol_row_read_at = s.value("select read_at from public.notifications where id = %s", [theirs["id"]])
        mine_read_at = s.value("select read_at from public.notifications where id = %s", [mine["id"]])
    assert ok is True and again is False
    assert foreign is False and made_up is False
    assert carol_row_read_at is None, "Alice marked Carol's notification read"
    assert mine_read_at is not None


def test_another_org_cannot_mark_a_tenants_notification_read(conn, sc):
    with as_superuser(conn, commit=False) as s:
        victim = inbox(s, sc.alice.actor)[0]["id"]
        as_user(s, sc.bob.actor)
        one = s.value("select public.mark_notification_read(%s)", [victim])
        all_named = s.value("select public.mark_all_notifications_read(%s)", [sc.alice.org])
        everything = s.value("select public.mark_all_notifications_read(null)")
        as_owner(s)
        still_unread = s.value("select read_at is null from public.notifications where id = %s", [victim])
        bob_unread = s.value("select count(*) from public.notifications where user_id = %s and read_at is null",
                             [sc.bob.actor.uid])
    assert one is False and all_named == 0, "Bob's call against org A's id touched something"
    assert everything >= 1 and bob_unread == 0, "control: mark-all clears the caller's own rows"
    assert still_unread


def test_mark_all_is_per_organization_and_per_person(conn, sc):
    with colleague(conn, sc) as (s, carol):
        as_owner(s)
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'credits_low', 'low:z', '{\"available\": 3}'::jsonb)) q",
               [sc.alice.org, carol.uid])
        # Alice is also a member of org B for a moment: her bell for B must not
        # clear what she has in A (and the reverse).
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
               [sc.bob.org, sc.alice.actor.uid, sc.alice.actor.email])
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'credits_low', 'low:z2', '{\"available\": 3}'::jsonb)) q",
               [sc.bob.org, sc.alice.actor.uid])
        as_user(s, sc.alice.actor)
        cleared = s.value("select public.mark_all_notifications_read(%s)", [sc.bob.org])
        as_owner(s)
        left_in_a = s.value("select count(*) from public.notifications where user_id = %s and org_id = %s and read_at is null",
                            [sc.alice.actor.uid, sc.alice.org])
        carol_unread = s.value("select count(*) from public.notifications where user_id = %s and read_at is null", [carol.uid])
        as_user(s, sc.alice.actor)
        everything = s.value("select public.mark_all_notifications_read(null)")
        as_owner(s)
        carol_after = s.value("select count(*) from public.notifications where user_id = %s and read_at is null", [carol.uid])
    assert cleared == 1 and left_in_a >= 1
    assert everything >= 1
    assert carol_unread >= 1 and carol_after == carol_unread, "Alice's mark-all cleared Carol's inbox"


# ── who is told, and what they are told ─────────────────────────────────────

def test_a_failed_job_tells_only_who_started_it_and_names_the_credits_returned(conn, sc):
    with colleague(conn, sc) as (s, carol):
        job = new_job(s, sc.alice, carol.uid)
        set_status(s, job, "failed", error_code="provider_error", charged_credits=0)
        assert [r["kind"] for r in inbox(s, sc.alice.actor) if r["ref"] == job] == [], "the owner was told about Carol's job"
        got = [r for r in inbox(s, carol) if r["ref"] == job]
    assert len(got) == 1 and got[0]["kind"] == "creative_job_failed"
    assert got[0]["data"] == {"job_id": job, "capability": "t2i", "code": "provider_error", "credits_returned": 6}


def test_credits_returned_is_absent_not_zero_when_nothing_was_held(conn, sc):
    with as_superuser(conn, commit=False) as s:
        paid_elsewhere = new_job(s, sc.alice, sc.alice.actor.uid, payer="api_balance", credit_ref=None)
        set_status(s, paid_elsewhere, "failed", error_code="timeout")
        row = next(r for r in inbox(s, sc.alice.actor) if r["ref"] == paid_elsewhere)
    assert "credits_returned" not in row["data"], row


def test_a_finished_job_tells_the_requester_and_never_carries_the_prompt(conn, sc):
    with as_superuser(conn, commit=False) as s:
        job = new_job(s, sc.bob, sc.bob.actor.uid)
        set_status(s, job, "completed", charged_credits=6)
        bob = [r for r in inbox(s, sc.bob.actor) if r["ref"] == job]
        alice = [r for r in inbox(s, sc.alice.actor) if r["ref"] == job]
    assert alice == []
    assert len(bob) == 1 and bob[0]["kind"] == "creative_job_completed"
    assert bob[0]["data"] == {"job_id": job, "capability": "t2i", "credits_charged": 6}
    assert "secret prompt" not in json.dumps(bob[0]["data"])


def test_cancelled_ingest_and_anonymous_jobs_tell_nobody(conn, sc):
    with as_superuser(conn, commit=False) as s:
        before = s.value("select count(*) from public.notifications")
        cancelled = new_job(s, sc.alice, sc.alice.actor.uid)
        set_status(s, cancelled, "cancelled", charged_credits=0)
        ingest = new_job(s, sc.alice, sc.alice.actor.uid, kind="ingest")
        set_status(s, ingest, "completed", charged_credits=0)
        nobody = new_job(s, sc.alice, None)
        set_status(s, nobody, "failed", error_code="x")
        after = s.value("select count(*) from public.notifications")
    assert after == before


def test_a_job_started_by_someone_outside_the_org_tells_them_nothing(conn, sc):
    # A requester who is not (or no longer) a member of the job's organization
    # is never sent an id from it.
    with as_superuser(conn, commit=False) as s:
        job = new_job(s, sc.alice, sc.bob.actor.uid)
        set_status(s, job, "failed", error_code="x")
        assert [r for r in inbox(s, sc.bob.actor) if r["ref"] == job] == []
        assert s.value("select count(*) from public.notifications where ref = %s", [job]) == 0


def test_a_job_updated_twice_tells_once(conn, sc):
    with as_superuser(conn, commit=False) as s:
        job = new_job(s, sc.alice, sc.alice.actor.uid)
        set_status(s, job, "failed", error_code="x")
        s.rows("update public.creative_jobs set status = 'running' where id = %s returning 1", [job])
        set_status(s, job, "failed", error_code="x")
        n = s.value("select count(*) from public.notifications where ref = %s", [job])
    assert n == 1


def test_a_storyboard_tells_every_member_of_its_org_and_nobody_else(conn, sc):
    with colleague(conn, sc) as (s, carol):
        as_owner(s)
        sid = str(insert_storyboard(s, sc.alice.channel, "told-all-a").rows[0][0])
        a = [r for r in inbox(s, sc.alice.actor) if r["ref"] == sid]
        c = [r for r in inbox(s, carol) if r["ref"] == sid]
        b = [r for r in inbox(s, sc.bob.actor) if r["ref"] == sid]
    assert len(a) == len(c) == 1 and b == []
    assert a[0]["kind"] == "storyboard_ready" and a[0]["data"] == {"storyboard_id": sid, "scenes": 3}
    assert "A topic" not in json.dumps(a[0]["data"]), "the storyboard's topic is text a person typed"


def test_a_finished_export_tells_who_asked_and_only_when_it_is_done(conn, sc):
    export, asset = sec_editor_0054.EXPORT["a"], sec_editor_0054.VIDEO["a"]
    with colleague(conn, sc) as (s, carol):
        queued = [r for r in inbox(s, sc.alice.actor) if r["ref"] == export]
        s.rows("update public.editor_exports set status = 'rendering' where id = %s returning 1", [export])
        rendering = [r for r in inbox(s, sc.alice.actor) if r["ref"] == export]
        s.rows("update public.editor_exports set status = 'done', asset_id = %s, finished_at = now() where id = %s returning 1",
               [asset, export])
        done = [r for r in inbox(s, sc.alice.actor) if r["ref"] == export]
        colleague_told = [r for r in inbox(s, carol) if r["ref"] == export]
    assert queued == rendering == [] and colleague_told == []
    assert len(done) == 1 and done[0]["kind"] == "editor_export_done"
    assert set(done[0]["data"]) == {"export_id", "project_id", "asset_id"}


def _available(s, org):
    return s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])


def test_low_credits_tells_the_org_once_when_available_crosses_the_line(conn, sc):
    with colleague(conn, sc) as (s, carol):
        as_owner(s)
        line = s.value("select public.notification_low_credits_threshold()")
        avail = _available(s, sc.alice.org)
        assert avail >= line, "control: the lab's org starts above the line"
        # The credit functions keep lots and accounts in step; the account row is
        # moved directly only because the check that compares them is deferred
        # to commit and this world is rolled back. Starting exactly on the line:
        # not below it yet.
        s.rows("update public.credit_accounts set balance = %s, reserved = 0 where org_id = %s returning 1",
               [line, sc.alice.org])
        s.rows("update public.credit_accounts set balance = %s where org_id = %s returning 1", [line - 1, sc.alice.org])
        a = [r for r in inbox(s, sc.alice.actor) if r["kind"] == "credits_low"]
        c = [r for r in inbox(s, carol) if r["kind"] == "credits_low"]
        # Dipping again the same day, or staying low, does not nag.
        s.rows("update public.credit_accounts set balance = %s where org_id = %s returning 1", [line + 5, sc.alice.org])
        s.rows("update public.credit_accounts set balance = %s where org_id = %s returning 1", [line - 2, sc.alice.org])
        s.rows("update public.credit_accounts set balance = %s where org_id = %s returning 1", [line - 3, sc.alice.org])
        again = [r for r in inbox(s, sc.alice.actor) if r["kind"] == "credits_low"]
        b = [r for r in inbox(s, sc.bob.actor) if r["kind"] == "credits_low"]
    assert len(a) == len(c) == 1 and len(again) == 1
    assert b == [], "Bob was told about Alice's credits"
    assert a[0]["data"] == {"available": float(line - 1)}


def test_an_account_that_was_never_above_the_line_is_not_told_it_is_low(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("update public.credit_accounts set balance = 0, reserved = 0 where org_id = %s returning 1", [sc.alice.org])
        n = s.value("select count(*) from public.notifications where kind = 'credits_low' and org_id = %s", [sc.alice.org])
        s.rows("update public.credit_accounts set balance = 3 where org_id = %s returning 1", [sc.alice.org])
        after = s.value("select count(*) from public.notifications where kind = 'credits_low' and org_id = %s", [sc.alice.org])
    assert after == n, "a new account was told it is poor"


def test_the_platforms_own_org_is_exempt_from_credits_and_never_told(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into public.credit_accounts (org_id, balance, reserved) values (%s, 100, 0) "
               "on conflict (org_id) do update set balance = 100, reserved = 0 returning 1", [DEFAULT_ORG])
        s.rows("update public.credit_accounts set balance = 1 where org_id = %s returning 1", [DEFAULT_ORG])
        assert s.value("select count(*) from public.notifications where org_id = %s and kind = 'credits_low'",
                       [DEFAULT_ORG]) == 0


def test_someone_who_left_the_org_reads_nothing_and_is_told_nothing_more(conn, sc):
    with colleague(conn, sc) as (s, carol):
        as_owner(s)
        s.rows("select 1 from (select public.notification_emit(%s, %s, 'credits_low', 'low:l', '{\"available\": 3}'::jsonb)) q",
               [sc.alice.org, carol.uid])
        assert inbox(s, carol), "control: Carol had a notification"
        s.rows("delete from public.org_members where org_id = %s and user_id = %s returning 1", [sc.alice.org, carol.uid])
        assert inbox(s, carol) == [], "a person who left still reads the organization's notifications"
        later = str(insert_storyboard(s, sc.alice.channel, "after-leaving").rows[0][0])
        assert s.value("select count(*) from public.notifications where user_id = %s and ref = %s", [carol.uid, later]) == 0


# ── what is stored, and what the table survives ─────────────────────────────

def test_every_notification_holds_ids_and_numbers_only(conn, sc):
    export = sec_editor_0054.EXPORT["b"]
    with as_superuser(conn, commit=False) as s:
        job = new_job(s, sc.bob, sc.bob.actor.uid)
        set_status(s, job, "failed", error_code="provider_error")
        s.rows("update public.editor_exports set status = 'done', asset_id = %s where id = %s returning 1",
               [sec_editor_0054.VIDEO["b"], export])
        s.rows("update public.credit_accounts set balance = 25, reserved = 0 where org_id = %s returning 1", [sc.bob.org])
        s.rows("update public.credit_accounts set balance = 5 where org_id = %s returning 1", [sc.bob.org])
        rows = s.rows("select kind, ref, data::text from public.notifications")
    assert {r[0] for r in rows} >= {"storyboard_ready", "creative_job_failed", "editor_export_done", "credits_low"}
    for kind, ref, data in rows:
        assert set(json.loads(data)) <= ALLOWED_DATA_KEYS, (kind, data)
        assert "@" not in data and "secret prompt" not in data, (kind, data)
        assert "@" not in ref


def test_a_failure_to_write_a_notification_never_rolls_back_what_it_reports(conn, sc):
    with as_superuser(conn, commit=False) as s:
        job = new_job(s, sc.alice, sc.alice.actor.uid)
        # Every notification insert now fails its CHECK.
        s.conn.execute("alter table public.notifications add constraint boom check (false) not valid")
        out = s.run("update public.creative_jobs set status = 'failed', error_code = 'x' where id = %s returning status", [job])
        status = s.value("select status from public.creative_jobs where id = %s", [job])
    assert out.ok, out
    assert status == "failed"


def test_the_inbox_is_bounded(conn, sc):
    with as_superuser(conn, commit=False) as s:
        for i in range(230):
            s.value("select public.notification_emit(%s, %s, 'credits_low', %s, '{}'::jsonb)",
                    [sc.alice.org, sc.alice.actor.uid, f"flood-{i}"])
        n = s.value("select count(*) from public.notifications where user_id = %s", [sc.alice.actor.uid])
        newest = s.value("select count(*) from public.notifications where user_id = %s and ref = 'flood-229'",
                         [sc.alice.actor.uid])
        s.rows("update public.notifications set created_at = now() - interval '91 days' "
               "where user_id = %s and ref = 'flood-229' returning 1", [sc.alice.actor.uid])
        s.value("select public.notification_emit(%s, %s, 'credits_low', 'fresh', '{}'::jsonb)",
                [sc.alice.org, sc.alice.actor.uid])
        old_left = s.value("select count(*) from public.notifications where user_id = %s and ref = 'flood-229'",
                           [sc.alice.actor.uid])
    assert n == 200 and newest == 1
    assert old_left == 0, "a notification older than 90 days outlives the next one"


def test_shapes_the_database_refuses(conn, sc):
    with as_superuser(conn, commit=False) as s:
        bad_kind = s.run("insert into public.notifications (org_id, user_id, kind, ref) values (%s, %s, 'made_up', 'x') returning 1",
                         [sc.alice.org, sc.alice.actor.uid])
    with as_superuser(conn, commit=False) as s:
        big = s.run("insert into public.notifications (org_id, user_id, kind, ref, data) values (%s, %s, 'credits_low', 'x', %s::jsonb) returning 1",
                    [sc.alice.org, sc.alice.actor.uid, json.dumps({"x": "y" * 3000})])
    with as_superuser(conn, commit=False) as s:
        not_object = s.run("insert into public.notifications (org_id, user_id, kind, ref, data) values (%s, %s, 'credits_low', 'x', '[]') returning 1",
                           [sc.alice.org, sc.alice.actor.uid])
    for o in (bad_kind, big, not_object):
        assert not o.ok and o.sqlstate == "23514", o


# ── the catalog of this migration ───────────────────────────────────────────

NOTIFY_FUNCTIONS = ("notification_emit", "notification_emit_org", "notification_low_credits_threshold",
                    "notify_creative_job_ended", "notify_storyboard_ready", "notify_editor_export_done",
                    "notify_credits_low", "mark_notification_read", "mark_all_notifications_read")


def test_every_function_of_0064_pins_its_search_path_and_is_scoped(conn):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            "select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), "
            "has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'), "
            "has_function_privilege('service_role', p.oid, 'execute') "
            "from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(%s)",
            [list(NOTIFY_FUNCTIONS)])
    assert {r[0] for r in rows} == set(NOTIFY_FUNCTIONS)
    for name, definer, config, anon, authed, service in rows:
        assert "search_path=public, pg_temp" in config, (name, config)
        assert not anon and not service, name
        assert authed == name.startswith("mark_"), (name, authed)
        if name != "notification_low_credits_threshold":
            assert definer, f"{name} is not security definer"


def test_the_table_has_rls_on_and_exactly_one_policy(conn):
    with as_superuser(conn, commit=False) as s:
        rls = s.value("select relrowsecurity from pg_class where oid = 'public.notifications'::regclass")
        policies = s.rows("select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'notifications'")
    assert rls is True
    assert policies == [("notifications_select", "SELECT")]
