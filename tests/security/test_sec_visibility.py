"""Migration 0116: "publish when approved" is a per-channel opt-in, a queue only the database writes, and a worker that cannot
claim more than it read back.

What would break without these (each attacked in a real database):

  * the switch is on by default, or on for an existing channel; an editor, a viewer, another organization's member, a platform
    admin on a customer's channel, anon or the SERVICE KEY turns it on; a browser UPDATE, or the service key's, writes the column;
  * approving queues a request while the switch is off (Phase 1a must stay byte-identical), queues two for one act, or queues
    nothing when it is on; a replay queues again; an approval that expired and was given again is not a new act;
  * a member of another organization reads the queue, or a member reads the worker's own columns; any API role (the service key
    included) writes it directly; a finished row changes, or is deleted;
  * a request is "applied" without a read-back that said public; free text from a provider lands in a member-readable column;
    the privacy mirror follows anything but the read-back;
  * the worker's claim hands out a request twice, never ends a crash loop, or acts on an approval that ran out; the request-level
    re-check misses a switch turned off, a different approval, an expired one or a channel that is not connected;
  * the quota ledger lets the day's ceiling be passed, or an API role spend it;
  * "try again" revives a refused, applied or expired request, another approval's request, or works for a non-administrator;
  * the rollback leaves the switch on or a queued request live, restores anything but 0112's bodies, or the file does not re-apply.

Isolation of the two tables, row by row, is covered by test_sec_isolation.py through sec_expectations.TABLES.
"""

from __future__ import annotations

import json
import re
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, as_superuser
from sec_scenario import DEFAULT_ORG
from test_sec_approve_video import (ACK, CUT, MIGRATION, MIGRATION_0116, MIGRATION_0117, OTHER, ROLLBACK, ROLLBACK_0116, ROLLBACK_0117, VID, acting,
                                    answer, approve, member, snapshot, uploaded)

ALL = "00000000-0000-0000-0000-000000000000"      # the ledger's row for a project's whole day
REQ = ("id, status, reason, attempts, approved_cut_sha256, decided_at, expires_at, intent_id, org_id, channel_id, before_privacy, "
       "after_privacy, quota_units, finished_at")


@pytest.fixture(scope="module", autouse=True)
def channels_do_not_require_a_second_person(conn, sc):
    """Another lab file (test_sec_channel_dna.py) commits agent_config.require_two_person_publish = true on Bob's channel. A channel
    that requires a second person is refused by this feature on purpose (two_person_required), so the tests here start from channels
    that do not, and each one that needs the requirement sets it inside its own rolled-back world."""
    with as_superuser(conn, commit=True) as su:
        su.rows("update public.channels set agent_config = agent_config - 'require_two_person_publish' "
                "where agent_config ? 'require_two_person_publish' returning 1")
    yield


def flip(s, channel, on=True):
    return s.run("select public.set_channel_publish_on_approve(%s, %s)", [channel, on])


def switch(su, channel, on=True):
    """The database owner writes the switch (the SQL editor): the one writer besides the function."""
    su.rows("update public.channels set publish_on_approve = %s where channel_id = %s returning 1", [on, channel])


def requests(su, vid=VID):
    return su.rows(f"select {REQ} from public.video_visibility_requests where video_id = %s order by id", [vid])


def audits(su, vid=VID):
    return sorted(r[0] for r in su.rows("select action from public.app_audit_log where target = %s", [vid]))


def queued(su, bob, vid=VID, **over):
    """An uploaded video on Bob's channel, the switch on, and Bob (owner) approves: returns the request id."""
    uploaded(su, bob.channel, vid=vid, **over)
    switch(su, bob.channel)
    with acting(su.conn, bob.actor) as s:
        out = answer(approve(s, vid=vid))
    assert out["ok"] is True and out["queued"] is True, out
    return out["request_id"]


def svc_value(conn, query, params=None):
    with acting(conn, SERVICE) as s:
        return s.value(query, params)


def svc_run(conn, query, params=None):
    with acting(conn, SERVICE) as s:
        return s.run(query, params)


def finish(conn, rid, worker, status, reason=None, before=None, after=None, units=0, retry=60):
    return svc_run(conn, "select public.finish_visibility_request(%s, %s, %s, %s, %s, %s, %s, %s)",
                   [rid, worker, status, reason, before, after, units, retry])


# ── the switch ───────────────────────────────────────────────────────────────

def test_the_switch_is_off_everywhere_and_a_new_channel_starts_off(conn, sc):
    with as_superuser(conn, commit=False) as su:
        assert su.value("select count(*) from public.channels where publish_on_approve") == 0
        col = su.rows("select column_default, is_nullable, data_type from information_schema.columns "
                      "where table_schema = 'public' and table_name = 'channels' and column_name = 'publish_on_approve'")[0]
        assert col == ("false", "NO", "boolean")
        with acting(conn, SERVICE) as s:
            s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values ('new-ch', 'N', 'x', 'PAUSED', %s) returning 1",
                   [sc.bob.org])
        assert su.value("select publish_on_approve from public.channels where channel_id = 'new-ch'") is False


def test_only_an_administrator_who_is_a_real_member_turns_it_on(conn, sc):
    bob, alice, op = sc.bob, sc.alice, sc.operator
    with as_superuser(conn, commit=False) as su:
        editor, viewer, admin = (member(su, bob.org, r) for r in ("editor", "viewer", "admin"))
        for who in (editor, viewer):
            with acting(conn, who) as s:
                out = flip(s, bob.channel)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        # another organization's member, and a missing channel, read the same: no answer about other tenants
        with acting(conn, alice.actor) as s:
            foreign, missing, malformed = flip(s, bob.channel), flip(s, "no-such-channel"), flip(s, "x; drop table channels")
            nulled = s.run("select public.set_channel_publish_on_approve(%s, null)", [alice.channel])
        for out in (foreign, missing, malformed, nulled):
            assert not out.ok and out.sqlstate == "P0002" and "not_found" in out.error, out
        assert foreign.error == missing.error
        # a platform admin is not the customer's team
        with acting(conn, op) as s:
            out = flip(s, bob.channel)
        assert not out.ok and out.sqlstate == "42501", out
        # anon and the service key have no way in at all
        for who in (ANON, SERVICE):
            with acting(conn, who) as s:
                out = flip(s, bob.channel)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is False
        # an administrator may; the owner of the organization may switch it off again
        with acting(conn, admin) as s:
            out = answer(flip(s, bob.channel))
        assert out == {"ok": True, "channel_id": bob.channel, "publish_on_approve": True, "changed": True}
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is True
        with acting(conn, bob.actor) as s:
            assert answer(flip(s, bob.channel, False))["changed"] is True
        # the operator's own organization keeps the old rule: a platform admin may
        with acting(conn, op) as s:
            assert answer(flip(s, "default"))["publish_on_approve"] is True


def test_a_change_is_audited_once_and_a_repeat_changes_and_audits_nothing(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        with acting(conn, bob.actor) as s:
            answer(flip(s, bob.channel))
            again = answer(flip(s, bob.channel))
            answer(flip(s, bob.channel, False))
        assert again["changed"] is False
        rows = su.rows("select actor_user_id, detail, channel_id from public.app_audit_log where action = 'channel.publish_on_approve' "
                       "and target = %s order by at, id", [bob.channel])
        # (one transaction, so both rows carry the same time: compare as a set)
        assert sorted((str(r[0]), r[1]["from"], r[1]["to"], r[2]) for r in rows) == sorted([
            (bob.actor.uid, False, True, bob.channel), (bob.actor.uid, True, False, bob.channel)])
        assert set(rows[0][1]) == {"channel_id", "from", "to"}


def test_nobody_writes_the_switch_directly_not_a_browser_and_not_the_service_key(conn, sc):
    bob = sc.bob
    up = "update public.channels set publish_on_approve = true where channel_id = %s"
    with as_superuser(conn, commit=False) as su:
        admin = member(su, bob.org, "admin")
        for who in (bob.actor, admin, ANON):
            with acting(conn, who) as s:
                out = s.run(up, [bob.channel])
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        # the service key holds the table's privileges, so the trigger is what refuses it
        with acting(conn, SERVICE) as s:
            assert s.run(up, [bob.channel]).sqlstate == "42501"
        with acting(conn, SERVICE) as s:
            out = s.run("insert into public.channels (channel_id, name, niche, status, org_id, publish_on_approve) "
                        "values ('sneaky', 'S', 'x', 'PAUSED', %s, true)", [bob.org])
            assert not out.ok and out.sqlstate == "42501", out
        # everything else the pipeline writes to a channel still works, and so does re-writing the same value
        with acting(conn, SERVICE) as s:
            assert s.run("update public.channels set name = 'Renamed' where channel_id = %s returning 1", [bob.channel]).ok
            assert s.run("update public.channels set publish_on_approve = false where channel_id = %s returning 1", [bob.channel]).ok
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is False
        # the owner of the database (the SQL editor) can: that is the documented undo
        switch(su, bob.channel)
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is True


def test_switching_off_refuses_what_is_waiting_at_once(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        with acting(conn, bob.actor) as s:
            answer(flip(s, bob.channel, False))
        row = su.rows("select status, reason, finished_at is not null from public.video_visibility_requests where id = %s", [rid])[0]
        assert row == ("refused", "not_enabled", True)


# ── approving queues one request, only when the switch is on ─────────────────

PHASE_1A_KEYS = {"ok", "already", "video_id", "cut_sha256", "decided_at", "expires_at", "intent_id"}


def test_with_the_switch_off_approving_is_exactly_phase_1a(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            out = answer(approve(s))
        assert set(out) == PHASE_1A_KEYS and out["ok"] is True and out["already"] is False
        assert requests(su) == []
        assert audits(su) == ["video.approve"]
        assert su.value("select count(*) from public.review_intents where video_id = %s and action = 'approve'", [VID]) == 1


def test_with_the_switch_on_one_approval_act_queues_one_request_and_a_replay_queues_nothing(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        (row,) = requests(su)
        (_, status, reason, attempts, cut, decided, expires, intent, org, channel, before, after, units, finished) = row
        assert (status, reason, attempts, cut, org, channel, before, after, units, finished) == (
            "queued", None, 0, CUT, uuid.UUID(sc.bob.org), bob.channel, None, None, 0, None)
        vid_row = su.rows("select decided_at, approval_expires_at from public.videos where video_id = %s", [VID])[0]
        assert (decided, expires) == vid_row
        assert intent == su.value("select id from public.review_intents where video_id = %s and outcome = 'recorded'", [VID])
        assert audits(su) == ["video.approve", "video.publish_queued"]
        detail = su.value("select detail from public.app_audit_log where action = 'video.publish_queued' and target = %s", [VID])
        assert set(detail) == {"video_id", "cut_sha256", "request_id", "expires_at"} and detail["request_id"] == rid
        # the replay (the approval still holds) writes and queues nothing
        with acting(conn, bob.actor) as s:
            again = answer(approve(s))
        assert again["already"] is True and "queued" not in again
        assert len(requests(su)) == 1 and audits(su) == ["video.approve", "video.publish_queued"]


def test_an_expired_approval_given_again_is_a_new_act_and_the_same_act_never_queues_twice(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        queued(su, bob)
        # same act, same transaction clock: the unique key (video, cut, decided_at) stops a second row
        su.rows("update public.videos set approval_expires_at = now() - interval '1 hour' where video_id = %s returning 1", [VID])
        with acting(conn, bob.actor) as s:
            same = answer(approve(s))
        assert same["already"] is False and "queued" not in same
        assert len(requests(su)) == 1
        # a genuinely later decision is a new act: move the first one back in time (the guard is the only thing in the way)
        su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
        su.rows("update public.video_visibility_requests set decided_at = decided_at - interval '2 days' returning 1")
        su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        su.rows("update public.videos set approval_expires_at = now() - interval '1 hour' where video_id = %s returning 1", [VID])
        with acting(conn, bob.actor) as s:
            second = answer(approve(s))
        assert second["queued"] is True
        assert len(requests(su)) == 2 and len({r[5] for r in requests(su)}) == 2


def test_nothing_is_queued_when_the_approval_is_refused_or_the_channel_publishes_on_its_own(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel, review_state="approved")        # approved with no person behind it (auto publish)
        switch(su, bob.channel)
        with acting(conn, bob.actor) as s:
            out = answer(approve(s))
        assert out == {"ok": False, "error": "already_approved"} and requests(su) == []
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel, gate_verdict=json.dumps({"allowed": False, "blocks": ["rights"], "warnings": []}))
        switch(su, bob.channel)
        with acting(conn, bob.actor) as s:
            out = answer(approve(s))
        assert out == {"ok": False, "error": "gate_blocked"} and requests(su) == []
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        switch(su, bob.channel)
        with acting(conn, bob.actor) as s:
            out = answer(approve(s, cut=OTHER))
        assert out == {"ok": False, "error": "cut_changed"} and requests(su) == []


# ── who reads and writes the queue ───────────────────────────────────────────

def test_members_read_their_own_organizations_requests_and_nobody_writes_them(conn, sc):
    bob, alice = sc.bob, sc.alice
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        viewer = member(su, bob.org, "viewer")
        for who in (bob.actor, viewer):
            with acting(conn, who) as s:
                assert s.value("select count(*) from public.video_visibility_requests where id = %s", [rid]) == 1
                assert s.run("select status, reason, after_privacy from public.video_visibility_requests where id = %s", [rid]).ok
                # the worker's own columns are not for members
                for col in ("claimed_by", "claimed_at", "lease_until", "submitting_at"):
                    out = s.run(f"select {col} from public.video_visibility_requests")
                    assert not out.ok and out.sqlstate == "42501", (col, out)
        for who in (alice.actor, sc.stranger):
            with acting(conn, who) as s:
                assert s.value("select count(*) from public.video_visibility_requests where id = %s", [rid]) == 0
        with acting(conn, ANON) as s:
            out = s.run("select count(*) from public.video_visibility_requests")
        assert not out.ok and out.sqlstate == "42501"
        writes = ["insert into public.video_visibility_requests (org_id, channel_id, video_id, approved_cut_sha256, decided_at, expires_at) "
                  "values (%s, %s, 'zzzzzzzzzzz', %s, now(), now())",
                  "update public.video_visibility_requests set status = 'applied', after_privacy = 'public', reason = null, finished_at = now() where id = %s",
                  "delete from public.video_visibility_requests where id = %s"]
        params = [[bob.org, bob.channel, CUT], [rid], [rid]]
        for who in (bob.actor, viewer, alice.actor, ANON, SERVICE):
            for q, p in zip(writes, params):
                with acting(conn, who) as s:
                    out = s.run(q, p)
                assert not out.ok and out.sqlstate == "42501", (who.name, q[:30], out)
        # not even a read for the service key: it goes through the functions
        with acting(conn, SERVICE) as s:
            out = s.run("select count(*) from public.video_visibility_requests")
        assert not out.ok and out.sqlstate == "42501"
        assert requests(su)[0][1] == "queued"


def test_the_grants_split_the_browser_from_the_worker(conn):
    persons = {"set_channel_publish_on_approve(text, boolean)", "retry_video_visibility(bigint)", "approve_video_publish(text, text, jsonb)"}
    worker = {"claim_visibility_request(text)", "mark_visibility_submitting(bigint, text)",
              "finish_visibility_request(bigint, text, text, text, text, text, integer, integer)",
              "visibility_request_refusal(bigint)", "youtube_quota_take(text, integer, integer, uuid, integer)",
              "youtube_quota_refund(text, integer, uuid)"}
    internal = {"visibility_reason_words()", "visibility_channel_connected(text)", "audit_action_allowed(text)"}
    with as_superuser(conn, commit=False) as su:
        def priv(sig):
            return [su.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [r, f"public.{sig}"])
                    for r in ("anon", "authenticated", "service_role")]
        for sig in persons:
            assert priv(sig) == [False, True, False], sig
        for sig in worker:
            assert priv(sig) == [False, False, True], sig
        for sig in internal:
            assert priv(sig) == [False, False, False], sig
        for sig in persons | worker:
            assert su.value("select prosecdef from pg_proc where oid = %s::regprocedure", [f"public.{sig}"]) is True
            assert "search_path=public, pg_temp" in su.value("select proconfig::text from pg_proc where oid = %s::regprocedure", [f"public.{sig}"])
        # the browser roles' column list (0086) does not name the switch: the privilege is absent, not only the trigger's refusal
        assert su.value("select has_column_privilege('authenticated', 'public.channels', 'publish_on_approve', 'UPDATE')") is False
        assert su.value("select has_column_privilege('authenticated', 'public.channels', 'publish_on_approve', 'INSERT')") is False
        assert su.value("select has_column_privilege('anon', 'public.channels', 'publish_on_approve', 'UPDATE')") is False
        # the queue's own id sequence is not advanced from an API role either (0020 does the same for its ledger's)
        for role in ("anon", "authenticated", "service_role"):
            for p in ("USAGE", "SELECT", "UPDATE"):
                assert su.value("select has_sequence_privilege(%s, 'public.video_visibility_requests_id_seq', %s)", [role, p]) is False, (role, p)
        for tbl in ("video_visibility_requests", "youtube_quota_ledger"):
            for role in ("anon", "authenticated", "service_role"):
                for p in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                    assert su.value("select has_table_privilege(%s, %s, %s)", [role, f"public.{tbl}", p]) is False, (tbl, role, p)
            assert su.value("select relrowsecurity from pg_class where oid = %s::regclass", [f"public.{tbl}"]) is True


# ── the worker's claim ───────────────────────────────────────────────────────

def test_a_claim_leases_the_request_and_a_dead_worker_is_replaced_by_one_that_reads_first(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        activate(su, bob.channel)
        first = svc_value(conn, "select public.claim_visibility_request('w1')")
        assert first["id"] == rid and first["attempts"] == 1 and first["reconcile"] is False
        assert first["video_id"] == VID and first["approved_cut_sha256"] == CUT and first["channel_id"] == bob.channel
        # leased: nobody else gets it
        assert svc_value(conn, "select public.claim_visibility_request('w2')") is None
        assert svc_run(conn, "select public.mark_visibility_submitting(%s, 'w2')", [rid]).rows[0][0] == "not_holder"   # not its holder
        assert svc_value(conn, "select public.mark_visibility_submitting(%s, 'w1')", [rid]) == "ok"
        # w1 dies after it marked the write: the lease runs out, w2 is told to reconcile (read YouTube first)
        su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
        second = svc_value(conn, "select public.claim_visibility_request('w2')")
        assert second["id"] == rid and second["attempts"] == 2 and second["reconcile"] is True
        # a lease that ran out is not written over by the worker that lost it
        assert finish(conn, rid, "w1", "applied", after="public").rows[0][0] == {"ok": False, "error": "not_holder", "status": "queued"}
        su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
        third = svc_value(conn, "select public.claim_visibility_request('w3')")
        assert third["attempts"] == 3
        assert third["read_only"] is False
        # three claims are all it gets, except that a request whose write was marked gets ONE more, read-only, so it is not failed
        # without anyone looking at the video one last time; that claim reads and never writes (the marker refuses it)
        su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
        fourth = svc_value(conn, "select public.claim_visibility_request('w4')")
        assert fourth["id"] == rid and fourth["attempts"] == 4 and fourth["reconcile"] is True and fourth["read_only"] is True
        assert svc_value(conn, "select public.mark_visibility_submitting(%s, 'w4')", [rid]) == "interrupted"
        # ... and then the next one ends it (a crash loop does not go round for ever)
        su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
        assert svc_value(conn, "select public.claim_visibility_request('w5')") is None
        row = requests(su)[0]
        assert row[1:3] == ("failed", "interrupted") and row[13] is not None
        assert "video.visibility_failed" in audits(su)


def test_a_marked_request_whose_last_retry_is_retryable_goes_back_to_the_queue_for_its_read_only_look(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = marked(conn, su, bob)                                  # claim 1, marked
        for who in ("w2", "w3"):
            su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
            assert svc_value(conn, "select public.claim_visibility_request(%s)", [who]) is not None
        # the third claim ends with a retryable outcome (ambiguous write, read-back unreadable): NOT failed, back to the queue
        out = finish(conn, rid, "w3", "queued", reason="readback_failed", units=3, retry=5).rows[0][0]
        assert out == {"ok": True, "status": "queued", "reason": "readback_failed"}
        su.rows("update public.video_visibility_requests set next_attempt_at = now() - interval '1 second' returning 1")
        last = svc_value(conn, "select public.claim_visibility_request('w4')")
        assert last["id"] == rid and last["read_only"] is True and last["attempts"] == 4
        # the read-only claim's own retryable outcome ends it
        out = finish(conn, rid, "w4", "queued", reason="readback_failed", units=1, retry=5).rows[0][0]
        assert out["status"] == "failed" and out["reason"] == "readback_failed"
    with as_superuser(conn, commit=False) as su:
        # never marked: as before, the third claim's retry is the end
        rid = queued(su, bob)
        activate(su, bob.channel)
        for who in ("w1", "w2", "w3"):
            su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
            assert svc_value(conn, "select public.claim_visibility_request(%s)", [who]) is not None
        out = finish(conn, rid, "w3", "queued", reason="platform_error", retry=5).rows[0][0]
        assert out["status"] == "failed"


def test_the_read_only_claim_records_what_it_finds_and_an_unmarked_request_never_gets_one(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = marked(conn, su, bob)
        for n, who in ((2, "w2"), (3, "w3")):
            su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
            assert svc_value(conn, "select public.claim_visibility_request(%s)", [who])["attempts"] == n
        su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
        last = svc_value(conn, "select public.claim_visibility_request('w4')")
        assert last["read_only"] is True
        # it found the video public: that is recorded (the one claim exists for exactly this)
        out = finish(conn, rid, "w4", "applied", after="public", units=2).rows[0][0]
        assert out["status"] == "applied"
        assert su.value("select privacy from public.videos where video_id = %s", [VID]) == "public"
    with as_superuser(conn, commit=False) as su:
        # never marked: three claims and it is over, no extra look (there was no write to look for)
        rid = queued(su, bob)
        for n in (1, 2, 3):
            su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
            assert svc_value(conn, "select public.claim_visibility_request('w1')")["attempts"] == n
        su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
        assert svc_value(conn, "select public.claim_visibility_request('w1')") is None
        assert requests(su)[0][1:3] == ("failed", "interrupted")


def test_a_claim_waits_for_its_backoff_and_ends_requests_whose_approval_ran_out_without_acting(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        assert svc_value(conn, "select public.claim_visibility_request('w1')")["attempts"] == 1
        out = finish(conn, rid, "w1", "queued", reason="rate_limited", retry=600).rows[0][0]
        assert out == {"ok": True, "status": "queued", "reason": "rate_limited"}
        assert svc_value(conn, "select public.claim_visibility_request('w1')") is None          # waiting for its backoff
        su.rows("update public.video_visibility_requests set next_attempt_at = now() - interval '1 second' returning 1")
        assert svc_value(conn, "select public.claim_visibility_request('w1')")["attempts"] == 2
        # the third claim's retry is bounded: it becomes failed with that word
        finish(conn, rid, "w1", "queued", reason="platform_error", retry=5)
        su.rows("update public.video_visibility_requests set next_attempt_at = now() - interval '1 second' returning 1")
        assert svc_value(conn, "select public.claim_visibility_request('w1')")["attempts"] == 3
        out = finish(conn, rid, "w1", "queued", reason="platform_error", retry=5).rows[0][0]
        assert out["status"] == "failed" and out["reason"] == "platform_error"
    with as_superuser(conn, commit=False) as su:
        # a request whose approval ended: never claimed, ended as expired with an audit row
        su.rows("insert into public.video_visibility_requests (org_id, channel_id, video_id, approved_cut_sha256, decided_at, expires_at) "
                "values (%s, %s, 'expired-vid', %s, now() - interval '2 days', now() - interval '1 day') returning 1", [bob.org, bob.channel, CUT])
        assert svc_value(conn, "select public.claim_visibility_request('w1')") is None
        row = su.rows("select status, reason, finished_at is not null from public.video_visibility_requests where video_id = 'expired-vid'")[0]
        assert row == ("expired", "approval_expired", True)
        assert "video.visibility_expired" in audits(su, "expired-vid")


def test_the_claim_is_the_service_keys_alone(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        queued(su, bob)
        for who in (bob.actor, ANON):
            with acting(conn, who) as s:
                for q in ("select public.claim_visibility_request('w1')", "select public.mark_visibility_submitting(1, 'w1')",
                          "select public.visibility_request_refusal(1)",
                          "select public.youtube_quota_take('p', 1, 10, '11111111-1111-1111-1111-111111111111', 10)",
                          "select public.finish_visibility_request(1, 'w1', 'refused', 'not_enabled', null, null, 0, 0)"):
                    out = s.run(q)
                    assert not out.ok and out.sqlstate == "42501", (who.name, q, out)
        with acting(conn, SERVICE) as s:
            assert s.run("select public.claim_visibility_request('bad worker!')").sqlstate == "22023"


# ── the request-level re-check ───────────────────────────────────────────────

def activate(su, channel):
    su.rows("update public.channels set status = 'ACTIVE', credential_ref = coalesce(credential_ref, '{}'::jsonb) || "
            "'{\"verified_at\": \"2026-10-01T00:00:00Z\"}'::jsonb where channel_id = %s returning 1", [channel])


def refusal(conn, rid):
    return svc_value(conn, "select public.visibility_request_refusal(%s)", [rid])


def test_the_request_level_recheck_says_no_for_each_thing_that_can_change_after_the_click(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        # a paused channel is not connected for this purpose; an active, confirmed one with its token is
        assert refusal(conn, rid) == "channel_not_connected"
        activate(su, bob.channel)
        assert refusal(conn, rid) is None
        # the video-level rule (0112) says yes for the cut recorded at approval, and no for any other
        assert svc_value(conn, "select public.video_publish_refusal(%s, %s)", [VID, CUT]) is None
        assert svc_value(conn, "select public.video_publish_refusal(%s, %s)", [VID, OTHER]) == "cut_changed"
        # the switch turned off since
        switch(su, bob.channel, False)
        assert refusal(conn, rid) == "not_enabled"
        switch(su, bob.channel, True)
        assert refusal(conn, rid) is None
        # the approval was cleared (a repair) or replaced by another act: this request is not for it any more
        su.rows("update public.videos set decided_at = decided_at + interval '1 second' where video_id = %s returning 1", [VID])
        assert refusal(conn, rid) == "approval_superseded"
        su.rows("update public.videos set decided_at = %s where video_id = %s returning 1", [requests(su)[0][5], VID])
        assert refusal(conn, rid) is None
        su.rows("update public.videos set approved_cut_sha256 = null, decided_at = null, approval_expires_at = null, review_state = 'pending' "
                "where video_id = %s returning 1", [VID])
        assert refusal(conn, rid) == "approval_superseded"
        assert svc_value(conn, "select public.video_publish_refusal(%s, %s)", [VID, CUT]) == "not_approved"
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        activate(su, bob.channel)
        su.rows("update public.videos set approval_expires_at = now() - interval '1 second' where video_id = %s returning 1", [VID])
        # video-level: expired
        assert svc_value(conn, "select public.video_publish_refusal(%s, %s)", [VID, CUT]) == "approval_expired"
    with as_superuser(conn, commit=False) as su:
        # request-level: the request's own end (set when it was queued) has passed, the video's approval columns are untouched
        rid = queued(su, bob)
        activate(su, bob.channel)
        su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
        su.rows("update public.video_visibility_requests set expires_at = now() - interval '1 second' where id = %s returning 1", [rid])
        su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        assert refusal(conn, rid) == "approval_expired"
    with as_superuser(conn, commit=False) as su:
        # the same decision time but another cut: the approval this request was queued for is not the one that stands
        rid = queued(su, bob)
        activate(su, bob.channel)
        assert refusal(conn, rid) is None
        su.rows("update public.videos set approved_cut_sha256 = %s where video_id = %s returning 1", [OTHER, VID])
        assert refusal(conn, rid) == "approval_superseded"
    with as_superuser(conn, commit=False) as su:
        queued(su, bob)
        su.rows("update public.videos set privacy = 'public' where video_id = %s returning 1", [VID])
        assert svc_value(conn, "select public.video_publish_refusal(%s, %s)", [VID, CUT]) == "already_public"


# ── the result: only what YouTube reported ───────────────────────────────────

def test_applied_needs_a_read_back_that_said_public_and_the_mirror_follows_the_read_back_alone(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        assert svc_value(conn, "select public.claim_visibility_request('w1')")["id"] == rid
        for after in ("private", "unlisted", None, "PUBLIC", "yes"):
            out = finish(conn, rid, "w1", "applied", after=after)
            assert not out.ok and out.sqlstate == "22023", (after, out)
        assert requests(su)[0][1] == "queued"
        assert su.value("select privacy from public.videos where video_id = %s", [VID]) == "private"
        out = finish(conn, rid, "w1", "applied", before="private", after="public", units=53).rows[0][0]
        assert out == {"ok": True, "status": "applied", "reason": None}
        row = requests(su)[0]
        assert row[1:3] == ("applied", None) and row[10:13] == ("private", "public", 53) and row[13] is not None
        assert su.value("select privacy from public.videos where video_id = %s", [VID]) == "public"
        assert "video.visibility_applied" in audits(su)
        detail = su.value("select detail from public.app_audit_log where action = 'video.visibility_applied' and target = %s", [VID])
        assert detail["after"] == "public" and detail["units"] == 53 and detail["status"] == "applied"
        # the table itself says applied needs a public read-back, whoever writes (the function's own refusal is the first defence)
        out = su.run("update public.video_visibility_requests set after_privacy = 'private' where id = %s", [rid])
        assert not out.ok and out.sqlstate in ("23514", "42501"), out
        with su.conn.transaction():
            su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
            out = su.run("update public.video_visibility_requests set after_privacy = 'private' where id = %s", [rid])
            su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        assert not out.ok and out.sqlstate == "23514", out
        # the answer is final: no second finish, no change by the owner either
        assert finish(conn, rid, "w1", "refused", reason="platform_kept_private", after="private").rows[0][0]["error"] == "not_holder"
        for q in ("update public.video_visibility_requests set status = 'queued', finished_at = null",
                  "update public.video_visibility_requests set after_privacy = 'private'",
                  "update public.video_visibility_requests set reason = 'worker_error'",
                  "update public.video_visibility_requests set video_id = 'other-video'",
                  "delete from public.video_visibility_requests"):
            out = su.run(q)
            assert not out.ok and out.sqlstate == "42501", (q, out)


def test_a_video_youtube_kept_private_is_refused_with_that_word_and_the_mirror_says_private(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        su.rows("update public.videos set privacy = 'unlisted' where video_id = %s returning 1", [VID])   # the mirror was stale
        svc_value(conn, "select public.claim_visibility_request('w1')")
        out = finish(conn, rid, "w1", "refused", reason="platform_kept_private", before="private", after="private", units=53).rows[0][0]
        assert out == {"ok": True, "status": "refused", "reason": "platform_kept_private"}
        row = requests(su)[0]
        assert row[1:3] == ("refused", "platform_kept_private") and row[11] == "private"
        assert su.value("select privacy from public.videos where video_id = %s", [VID]) == "private"
        assert "video.visibility_refused" in audits(su)


def test_no_provider_text_can_reach_a_member_readable_column(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        svc_value(conn, "select public.claim_visibility_request('w1')")
        free = "HttpError 403 accessNotConfigured: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxx"
        out = finish(conn, rid, "w1", "failed", reason=free).rows[0][0]
        # an unknown word is the closed word for "ours", never the text
        assert out == {"ok": True, "status": "failed", "reason": "worker_error"}
        assert not any(free in str(c) for c in requests(su)[0])
        assert free not in su.value("select detail::text from public.app_audit_log where action = 'video.visibility_failed' and target = %s", [VID])
        # and the table refuses a free-text reason from any writer, the owner included
        out = su.run("insert into public.video_visibility_requests (org_id, channel_id, video_id, approved_cut_sha256, decided_at, expires_at, "
                     "status, reason, finished_at) values (%s, %s, 'free-text-1', %s, now(), now(), 'failed', %s, now())",
                     [bob.org, bob.channel, CUT, free])
        assert not out.ok and out.sqlstate == "23514", out
        assert finish(conn, rid, "w1", "teleported").sqlstate == "22023"
        # a failed or refused end always carries a word; an applied one never does
        out = su.run("update public.video_visibility_requests set status = 'failed', reason = null, finished_at = now() where id = %s", [rid])
        assert not out.ok and out.sqlstate == "23514", out


# ── the quota ledger ─────────────────────────────────────────────────────────

def test_the_quota_ledger_holds_the_ceiling_per_pacific_day_and_only_the_service_key_spends_it(conn):
    with as_superuser(conn, commit=False) as su:
        org = uuid.uuid4()
        take = lambda units, ceiling, org=org, share=10000: svc_value(
            conn, "select public.youtube_quota_take('proj-1', %s, %s, %s, %s)", [units, ceiling, org, share])
        assert take(50, 100) is True and take(50, 100) is True
        assert take(1, 100) is False                               # exactly at the ceiling: the next unit is refused
        assert su.value("select units from public.youtube_quota_ledger where project = 'proj-1' and org_id = %s "
                        "and day = (now() at time zone 'America/Los_Angeles')::date", [ALL]) == 100
        assert take(101, 100) is False                              # more than the whole ceiling, even on a fresh project
        assert svc_value(conn, "select public.youtube_quota_take('proj-2', 50, 40, %s, 40)", [org]) is False
        assert su.value("select count(*) from public.youtube_quota_ledger where project = 'proj-2'") == 0
        assert svc_value(conn, "select public.youtube_quota_take('proj-2', 50, 10000, %s, 10000)", [org]) is True   # a separate project has its own day
        # yesterday's spend is not today's
        su.rows("insert into public.youtube_quota_ledger (day, project, source, org_id, units) "
                "values ((now() at time zone 'America/Los_Angeles')::date - 1, 'proj-3', 'visibility', %s, 9999) returning 1", [ALL])
        assert svc_value(conn, "select public.youtube_quota_take('proj-3', 50, 100, %s, 100)", [org]) is True
        # old days are pruned
        su.rows("insert into public.youtube_quota_ledger (day, project, source, org_id, units) values (current_date - 30, 'proj-old', 'visibility', %s, 5) returning 1", [ALL])
        svc_value(conn, "select public.youtube_quota_take('proj-3', 1, 100, %s, 100)", [org])
        assert su.value("select count(*) from public.youtube_quota_ledger where project = 'proj-old'") == 0
        for bad in ("select public.youtube_quota_take('Bad Project', 1, 10, %s, 10)", "select public.youtube_quota_take('p', 0, 10, %s, 10)",
                    "select public.youtube_quota_take('p', 201, 10, %s, 10)", "select public.youtube_quota_take('p', 1, 10001, %s, 10)",
                    "select public.youtube_quota_take('p', 1, -1, %s, 10)", "select public.youtube_quota_take('p', null, 10, %s, 10)",
                    "select public.youtube_quota_take('p', 1, 10, null, 10)", "select public.youtube_quota_take('p', 1, 10, %s, null)",
                    "select public.youtube_quota_take('p', 1, 10, %s, 10001)", "select public.youtube_quota_take('p', 1, 10, '00000000-0000-0000-0000-000000000000', 10)"):
            assert svc_run(conn, bad, [org] if "%s" in bad else None).sqlstate == "22023", bad


def test_units_taken_for_a_write_that_was_never_sent_are_given_back_without_going_below_zero(conn):
    with as_superuser(conn, commit=False) as su:
        org, other = uuid.uuid4(), uuid.uuid4()
        day = "(now() at time zone 'America/Los_Angeles')::date"
        units = lambda o: su.value(f"select units from public.youtube_quota_ledger where project = 'proj-ref' and day = {day} and org_id = %s", [o])
        assert svc_value(conn, "select public.youtube_quota_take('proj-ref', 50, 1000, %s, 500)", [org]) is True
        assert svc_value(conn, "select public.youtube_quota_take('proj-ref', 50, 1000, %s, 500)", [other]) is True
        assert svc_value(conn, "select public.youtube_quota_refund('proj-ref', 50, %s)", [org]) is True
        assert (units(ALL), units(org), units(other)) == (50, 0, 50)
        # a second refund of the same units mints nothing: the organization has nothing recorded, so the whole day is left alone
        assert svc_value(conn, "select public.youtube_quota_refund('proj-ref', 50, %s)", [org]) is True
        assert (units(ALL), units(org), units(other)) == (50, 0, 50)
        # a refund larger than was taken is clamped to what the organization holds, and the SAME amount leaves the whole day
        assert svc_value(conn, "select public.youtube_quota_take('proj-ref', 30, 1000, %s, 500)", [org]) is True
        assert (units(ALL), units(org)) == (80, 30)
        assert svc_value(conn, "select public.youtube_quota_refund('proj-ref', 200, %s)", [org]) is True
        assert (units(ALL), units(org), units(other)) == (50, 0, 50)
        # an organization that never took anything gives back nothing and leaves the whole-day row untouched
        stranger = uuid.uuid4()
        assert svc_value(conn, "select public.youtube_quota_refund('proj-ref', 50, %s)", [stranger]) is True
        assert (units(ALL), units(other), units(stranger)) == (50, 50, None)
        assert svc_value(conn, "select public.youtube_quota_refund('proj-never', 50, %s)", [org]) is True
        assert su.value("select count(*) from public.youtube_quota_ledger where project = 'proj-never'") == 0
        for who in (ANON,):
            with acting(conn, who) as s:
                assert s.run("select public.youtube_quota_refund('proj-ref', 1, %s)", [org]).sqlstate == "42501"
        for bad in ("select public.youtube_quota_refund('Bad Project', 1, %s)", "select public.youtube_quota_refund('p', 0, %s)",
                    "select public.youtube_quota_refund('p', 201, %s)", "select public.youtube_quota_refund('p', 1, null)",
                    "select public.youtube_quota_refund('p', 1, '00000000-0000-0000-0000-000000000000')"):
            assert svc_run(conn, bad, [org] if "%s" in bad else None).sqlstate == "22023", bad


def test_the_quota_ceiling_holds_when_many_sessions_take_at_once(conn):
    """Real concurrent sessions (threads), each its own connection and its own committed transaction, against a ceiling that
    leaves room for exactly four takes of 50. Without the per-project lock two sessions read the same total, both pass, and the
    ledger ends past the ceiling."""
    import threading

    dsn = psycopg.conninfo.make_conninfo(conn.info.dsn, password=conn.info.password)
    rounds, workers, ceiling = 12, 10, 200
    org = uuid.uuid4()
    day = "(now() at time zone 'America/Los_Angeles')::date"
    projects = [f"conc-{uuid.uuid4().hex[:8]}" for _ in range(rounds)]
    try:
        for project in projects:
            conns = [psycopg.connect(dsn, autocommit=True) for _ in range(workers)]
            gate, results, errors = threading.Barrier(workers), [], []

            def take(c):
                try:
                    gate.wait(timeout=20)
                    with sec_db.acting(c, SERVICE, commit=True) as s:
                        results.append(s.value("select public.youtube_quota_take(%s, 50, %s, %s, 10000)", [project, ceiling, org]))
                except Exception as e:  # noqa: BLE001
                    errors.append(repr(e))

            threads = [threading.Thread(target=take, args=(c,)) for c in conns]
            for th in threads:
                th.start()
            for th in threads:
                th.join(timeout=60)
            for c in conns:
                c.close()
            assert errors == [], errors
            assert sorted(results) == [False] * (workers - 4) + [True] * 4, (project, results)
            with as_superuser(conn, commit=False) as su:
                assert su.value(f"select units from public.youtube_quota_ledger where project = %s and day = {day} and org_id = '{ALL}'", [project]) == 200
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.youtube_quota_ledger where project like 'conc-%' returning 1")


def test_the_refund_holds_when_many_sessions_refund_at_once(conn):
    """Threads, one committed transaction each. Two organizations hold 50 units each (the whole day holds 100) and ten sessions
    refund organization A's 50 at the same moment. Exactly 50 may leave: A ends at 0 and the whole day at 50. Without the
    per-project lock two sessions both read A's 50 and both take it off the whole day, which then ends below 50."""
    import threading

    dsn = psycopg.conninfo.make_conninfo(conn.info.dsn, password=conn.info.password)
    rounds, workers = 12, 10
    a, b = uuid.uuid4(), uuid.uuid4()
    day = "(now() at time zone 'America/Los_Angeles')::date"
    projects = [f"refc-{uuid.uuid4().hex[:8]}" for _ in range(rounds)]
    try:
        for project in projects:
            for o in (a, b):
                assert svc_value(conn, "select public.youtube_quota_take(%s, 50, 1000, %s, 500)", [project, o]) is True
            conns = [psycopg.connect(dsn, autocommit=True) for _ in range(workers)]
            gate, errors = threading.Barrier(workers), []

            def refund(c):
                try:
                    gate.wait(timeout=20)
                    with sec_db.acting(c, SERVICE, commit=True) as s:
                        s.value("select public.youtube_quota_refund(%s, 50, %s)", [project, a])
                except Exception as e:  # noqa: BLE001
                    errors.append(repr(e))

            threads = [threading.Thread(target=refund, args=(c,)) for c in conns]
            for th in threads:
                th.start()
            for th in threads:
                th.join(timeout=60)
            for c in conns:
                c.close()
            assert errors == [], errors
            with as_superuser(conn, commit=False) as su:
                got = {r[0]: r[1] for r in su.rows(f"select org_id::text, units from public.youtube_quota_ledger where project = %s and day = {day}", [project])}
            assert got == {ALL: 50, str(a): 0, str(b): 50}, (project, got)
    finally:
        with as_superuser(conn, commit=True) as su:
            su.rows("delete from public.youtube_quota_ledger where project like 'refc-%' returning 1")


def test_one_organization_cannot_use_up_the_days_quota_and_the_ledger_counts_both(conn):
    with as_superuser(conn, commit=False) as su:
        a, b = uuid.uuid4(), uuid.uuid4()
        take = lambda org, units, ceiling=1000, share=300: svc_value(
            conn, "select public.youtube_quota_take('proj-fair', %s, %s, %s, %s)", [units, ceiling, org, share])
        # A takes its share (300) in 50s; the next unit is refused for A although the day has 700 left
        assert [take(a, 50) for _ in range(6)] == [True] * 6
        assert take(a, 1) is False
        # B is not behind A: it has its own share of the same day
        assert take(b, 50) is True
        assert su.value("select units from public.youtube_quota_ledger where project = 'proj-fair' and org_id = %s", [ALL]) == 350
        assert su.value("select units from public.youtube_quota_ledger where project = 'proj-fair' and org_id = %s", [a]) == 300
        assert su.value("select units from public.youtube_quota_ledger where project = 'proj-fair' and org_id = %s", [b]) == 50
        # a refused take records nothing at all (neither row moves)
        assert take(a, 50) is False
        assert su.value("select units from public.youtube_quota_ledger where project = 'proj-fair' and org_id = %s", [ALL]) == 350
        # the whole day's ceiling still holds for everyone
        assert take(b, 50, ceiling=400, share=1000) is True and take(b, 1, ceiling=400, share=1000) is False


def test_a_customer_does_not_read_the_ledger_a_platform_admin_does(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("insert into public.youtube_quota_ledger (day, project, source, org_id, units) values (current_date, 'proj-x', 'visibility', %s, 5) returning 1", [ALL])
        with acting(conn, sc.bob.actor) as s:
            assert s.value("select count(*) from public.youtube_quota_ledger") == 0
        with acting(conn, sc.operator) as s:
            assert s.value("select count(*) from public.youtube_quota_ledger where project = 'proj-x'") == 1


# ── try again ────────────────────────────────────────────────────────────────

def failed_request(conn, su, bob):
    rid = queued(su, bob)
    svc_value(conn, "select public.claim_visibility_request('w1')")
    finish(conn, rid, "w1", "failed", reason="token_expired", units=1)
    assert requests(su)[0][1:3] == ("failed", "token_expired")
    return rid


def retry(s, rid):
    return s.run("select public.retry_video_visibility(%s)", [rid])


def test_try_again_re_queues_a_failed_request_of_the_same_approval_and_nothing_else(conn, sc):
    bob, alice = sc.bob, sc.alice
    with as_superuser(conn, commit=False) as su:
        rid = failed_request(conn, su, bob)
        editor = member(su, bob.org, "editor")
        for who, code in ((editor, "42501"), (alice.actor, "P0002"), (ANON, "42501"), (SERVICE, "42501")):
            with acting(conn, who) as s:
                out = retry(s, rid)
            assert not out.ok and out.sqlstate == code, (who.name, out)
        assert requests(su)[0][1] == "failed"
        with acting(conn, bob.actor) as s:
            out = answer(retry(s, rid))
        assert out == {"ok": True, "request_id": rid, "status": "queued"}
        row = requests(su)[0]
        assert row[1:4] == ("queued", None, 0) and row[13] is None
        assert "video.visibility_retry" in audits(su)
        # queued again: nothing to retry
        with acting(conn, bob.actor) as s:
            assert answer(retry(s, rid)) == {"ok": False, "error": "not_retryable"}
        # it is claimable again, with a fresh count
        assert svc_value(conn, "select public.claim_visibility_request('w2')")["attempts"] == 1


def test_try_again_never_revives_a_refused_applied_or_expired_request_or_another_approval(conn, sc):
    bob = sc.bob
    for status, reason, after in (("refused", "platform_kept_private", "private"), ("applied", None, "public"), ("expired", "approval_expired", None)):
        with as_superuser(conn, commit=False) as su:
            rid = queued(su, bob)
            svc_value(conn, "select public.claim_visibility_request('w1')")
            if status == "expired":
                su.rows("update public.video_visibility_requests set status = 'expired', reason = 'approval_expired', finished_at = now() where id = %s returning 1", [rid])
            else:
                finish(conn, rid, "w1", status, reason=reason, after=after)
            with acting(conn, bob.actor) as s:
                assert answer(retry(s, rid)) == {"ok": False, "error": "not_retryable"}, status
            assert requests(su)[0][1] == status
    with as_superuser(conn, commit=False) as su:
        rid = failed_request(conn, su, bob)
        su.rows("update public.videos set decided_at = decided_at + interval '1 second' where video_id = %s returning 1", [VID])
        with acting(conn, bob.actor) as s:
            assert answer(retry(s, rid)) == {"ok": False, "error": "approval_superseded"}
    with as_superuser(conn, commit=False) as su:
        rid = failed_request(conn, su, bob)
        switch(su, bob.channel, False)
        with acting(conn, bob.actor) as s:
            assert answer(retry(s, rid)) == {"ok": False, "error": "not_enabled"}
    with as_superuser(conn, commit=False) as su:
        rid = failed_request(conn, su, bob)
        su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
        su.rows("update public.video_visibility_requests set expires_at = now() - interval '1 second' returning 1")
        su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        with acting(conn, bob.actor) as s:
            assert answer(retry(s, rid)) == {"ok": False, "error": "approval_expired"}


# ── the switch turned off while a write may be on its way ────────────────────

def marked(conn, su, bob, vid=VID, worker="w1"):
    """A queued request that a worker holds and has marked 'the write may be sent' (the channel connected, everything allowed)."""
    rid = queued(su, bob, vid=vid)
    activate(su, bob.channel)
    claimed = svc_value(conn, "select public.claim_visibility_request(%s)", [worker])
    assert claimed["id"] == rid
    assert svc_value(conn, "select public.mark_visibility_submitting(%s, %s)", [rid, worker]) == "ok"
    return rid


def test_switching_off_does_not_refuse_a_request_whose_write_was_marked_and_the_truth_is_still_recorded(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        sent = marked(conn, su, bob)
        waiting = queued(su, bob, vid="bbbbbbbbbbb")                   # approved on the same channel, never claimed
        with acting(conn, bob.actor) as s:
            assert answer(flip(s, bob.channel, False))["changed"] is True
        # what was waiting is refused at once; what may already be on its way to YouTube is not
        assert su.rows("select status, reason from public.video_visibility_requests where id = %s", [waiting]) == [("refused", "not_enabled")]
        assert su.rows("select status, reason, submitting_at is not null from public.video_visibility_requests where id = %s", [sent]) == [("queued", None, True)]
        # YouTube made the video public after the switch went off: the database says so, the mirror follows the read-back, it is audited
        assert su.value("select privacy from public.videos where video_id = %s", [VID]) == "private"
        out = finish(conn, sent, "w1", "applied", before="private", after="public", units=53).rows[0][0]
        assert out == {"ok": True, "status": "applied", "reason": None}
        row = su.rows(f"select {REQ} from public.video_visibility_requests where id = %s", [sent])[0]
        assert row[1:3] == ("applied", None) and row[10:13] == ("private", "public", 53) and row[13] is not None
        assert su.value("select privacy from public.videos where video_id = %s", [VID]) == "public"
        detail = su.value("select detail from public.app_audit_log where action = 'video.visibility_applied' and target = %s", [VID])
        assert detail["after"] == "public" and detail["write_marked"] is True and detail["request_id"] == sent
        # and the channel is still switched off for everything new
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is False


def test_the_expiry_sweep_leaves_a_marked_request_to_the_worker_which_reads_youtube_and_records_it(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        sent = marked(conn, su, bob)
        su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
        su.rows("update public.video_visibility_requests set expires_at = now() - interval '1 second', lease_until = now() - interval '1 minute' returning 1")
        su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        # an unmarked one whose approval ended is expired by the sweep; the marked one is handed out again, told to read first
        late = queued(su, bob, vid="bbbbbbbbbbb")
        su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
        su.rows("update public.video_visibility_requests set expires_at = now() - interval '1 second' where id = %s returning 1", [late])
        su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        again = svc_value(conn, "select public.claim_visibility_request('w2')")
        assert again["id"] == sent and again["reconcile"] is True
        assert su.rows("select status, reason from public.video_visibility_requests where id = %s", [late]) == [("expired", "approval_expired")]
        assert su.rows("select status from public.video_visibility_requests where id = %s", [sent]) == [("queued",)]
        out = finish(conn, sent, "w2", "applied", after="public", units=2).rows[0][0]
        assert out["status"] == "applied"
        assert su.value("select privacy from public.videos where video_id = %s", [VID]) == "public"


def test_the_rollback_waits_for_a_write_in_flight_and_keeps_an_old_marked_request_queued(conn, sc):
    bob = sc.bob
    body = "\n".join(ln for ln in ROLLBACK_0116.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
    with as_superuser(conn, commit=False) as su:
        sent = marked(conn, su, bob)
        out = su.run(body)
        assert not out.ok and out.sqlstate == "55000" and "in flight" in out.error, out
    with as_superuser(conn, commit=False) as su:
        sent = marked(conn, su, bob)
        su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
        su.rows("update public.video_visibility_requests set submitting_at = now() - interval '1 hour' returning 1")
        su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        waiting = queued(su, bob, vid="bbbbbbbbbbb")
        su.conn.execute(body)
        # the marked one stays queued (nothing could finish it any more, and "refused" would be a claim about YouTube we cannot make);
        # the unmarked one is refused; the switch is off everywhere
        assert su.rows("select status, reason from public.video_visibility_requests where id = %s", [sent]) == [("queued", None)]
        assert su.rows("select status, reason from public.video_visibility_requests where id = %s", [waiting]) == [("refused", "not_enabled")]
        assert su.value("select count(*) from public.channels where publish_on_approve") == 0


# ── the last check and the marker are one step ───────────────────────────────

def test_the_marker_is_set_only_when_everything_is_asked_again_inside_the_locks(conn, sc):
    bob, alice = sc.bob, sc.alice
    gaps = {
        "cut_changed": "update public.videos set cut_sha256 = '%s' where video_id = '%s'" % (OTHER, VID),
        "not_approved": "update public.videos set approved_cut_sha256 = null, decided_at = null, approval_expires_at = null, review_state = 'pending' where video_id = '%s'" % VID,
        "approval_expired": "update public.videos set approval_expires_at = now() - interval '1 second' where video_id = '%s'" % VID,
        "already_public": "update public.videos set privacy = 'public' where video_id = '%s'" % VID,
        "gate_blocked": "update public.videos set gate_verdict = '{\"allowed\": false, \"blocks\": [\"rights\"], \"warnings\": []}'::jsonb where video_id = '%s'" % VID,
        # what the publish gate said, held or never stored, and the review: a request is never carried out over any of them
        "gate_unknown": "update public.videos set gate_verdict = null where video_id = '%s'" % VID,
        "not_uploaded": "update public.videos set publish_state = 'held', published_at = null, privacy = null where video_id = '%s'" % VID,
        "rejected": "update public.videos set review_state = 'rejected' where video_id = '%s'" % VID,
        # one approver is not two people (the requirement arrived after the switch)
        "two_person_required": "update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) || '{\"require_two_person_publish\": true}'::jsonb where channel_id = '%s'" % bob.channel,
        "approval_superseded": "update public.videos set decided_at = decided_at + interval '1 second' where video_id = '%s'" % VID,
        "not_enabled": "update public.channels set publish_on_approve = false where channel_id = '%s'" % bob.channel,
        "channel_not_connected": "update public.channels set status = 'PAUSED' where channel_id = '%s'" % bob.channel,
    }
    for word, gap in gaps.items():
        with as_superuser(conn, commit=False) as su:
            rid = queued(su, bob)
            activate(su, bob.channel)
            assert svc_value(conn, "select public.claim_visibility_request('w1')")["id"] == rid
            su.rows(gap + " returning 1")            # the change that lands between the worker's early check and the marker
            assert svc_value(conn, "select public.mark_visibility_submitting(%s, 'w1')", [rid]) == word, word
            assert su.value("select submitting_at is null from public.video_visibility_requests where id = %s", [rid]) is True, word
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        activate(su, bob.channel)
        svc_value(conn, "select public.claim_visibility_request('w1')")
        # a request that is not there, or that another worker holds, is not_holder: nothing is marked
        assert svc_value(conn, "select public.mark_visibility_submitting(999999999, 'w1')") == "not_holder"
        assert svc_value(conn, "select public.mark_visibility_submitting(%s, 'w2')", [rid]) == "not_holder"
        assert su.value("select submitting_at is null from public.video_visibility_requests where id = %s", [rid]) is True
        assert svc_value(conn, "select public.mark_visibility_submitting(%s, 'w1')", [rid]) == "ok"
        assert su.value("select submitting_at is not null from public.video_visibility_requests where id = %s", [rid]) is True


def test_a_request_of_a_channel_that_moved_to_another_organization_is_refused_and_its_switch_is_reset(conn, sc):
    bob, alice = sc.bob, sc.alice
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        activate(su, bob.channel)
        assert refusal(conn, rid) is None
        su.rows("update public.channels set org_id = %s where channel_id = %s returning 1", [alice.org, bob.channel])
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is False
        assert refusal(conn, rid) == "not_enabled"
        # even if somebody switches it on again in its new organization, this request was queued for the old one
        switch(su, bob.channel, True)
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is True
        assert refusal(conn, rid) == "not_enabled"
        # an API role cannot set the switch while moving a channel either: it comes out off
        with acting(conn, SERVICE) as s:
            s.rows("update public.channels set org_id = %s, publish_on_approve = true where channel_id = %s returning 1", [bob.org, bob.channel])
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is False


def two_person(su, channel, on=True):
    """The channel requires a SECOND person to publish (agent_config.require_two_person_publish, 0009/0029); written as the
    database owner, the way 0086 allows only an administrator or the owner of the database to."""
    su.rows("update public.channels set agent_config = coalesce(agent_config, '{}'::jsonb) || %s::jsonb where channel_id = %s returning 1",
            [json.dumps({"require_two_person_publish": on}), channel])


def test_a_channel_that_requires_a_second_person_never_has_a_video_made_public_by_one_approver(conn, sc):
    """One approver is not two people. The switch cannot be turned ON for such a channel, and a request on one (the requirement
    came after the switch, or the database owner set the switch) is refused by the request-level check and by the marker, so the
    worker is told no before it could write. Switching OFF stays allowed; without the requirement everything is as before."""
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        admin = member(su, bob.org, "admin")
        two_person(su, bob.channel)
        before = len(audits(su, bob.channel))
        with acting(conn, admin) as s:
            out = answer(flip(s, bob.channel))
        assert out == {"ok": False, "error": "two_person_required"}, out
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is False
        assert len(audits(su, bob.channel)) == before                      # a refusal changes and audits nothing
        # the requirement removed: the same call works (the guard is exactly this requirement and nothing else)
        two_person(su, bob.channel, False)
        with acting(conn, admin) as s:
            assert answer(flip(s, bob.channel))["publish_on_approve"] is True
        # the requirement added after the switch was on: switching OFF is always allowed and an ON repeat changes nothing
        two_person(su, bob.channel)
        with acting(conn, admin) as s:
            assert answer(flip(s, bob.channel))["changed"] is False
            assert answer(flip(s, bob.channel, False))["changed"] is True
        # a request on such a channel: approving still records the decision (0112) and queues; nothing may carry it out
        two_person(su, bob.channel, False)
        rid = queued(su, bob)
        activate(su, bob.channel)
        assert refusal(conn, rid) is None
        assert svc_value(conn, "select public.claim_visibility_request('w1')")["id"] == rid
        two_person(su, bob.channel)
        assert refusal(conn, rid) == "two_person_required"
        # the marker asks again in its own transaction: it answers the word, and marks nothing, so no write may follow
        assert svc_value(conn, "select public.mark_visibility_submitting(%s, 'w1')", [rid]) == "two_person_required"
        assert su.value("select submitting_at is null from public.video_visibility_requests where id = %s", [rid]) is True
        # the word is one the table accepts as an end, and the request ends refused with it
        finish(conn, rid, "w1", "refused", "two_person_required")
        assert su.rows("select status, reason from public.video_visibility_requests where id = %s", [rid]) == [("refused", "two_person_required")]


def test_the_claim_serves_organizations_in_turn(conn, sc):
    bob, alice = sc.bob, sc.alice
    with as_superuser(conn, commit=False) as su:
        b1 = queued(su, bob, vid="aaaaaaaaaaa")
        b2 = queued(su, bob, vid="bbbbbbbbbbb")
        a1 = queued(su, alice, vid="ccccccccccc")
        order = [svc_value(conn, "select public.claim_visibility_request('w1')")["id"] for _ in range(3)]
        # one organization's pile does not go first: bob, then alice, then bob's second
        assert order == [b1, a1, b2], order


def test_a_request_is_carried_out_at_most_six_times_whatever_try_again_does(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        for n in range(1, 7):
            claimed = svc_value(conn, "select public.claim_visibility_request('w1')")
            assert claimed["id"] == rid and claimed["attempts"] == 1, n          # try again gives a fresh round
            assert su.value("select lifetime_attempts from public.video_visibility_requests where id = %s", [rid]) == n
            finish(conn, rid, "w1", "failed", reason="token_expired", units=1)
            with acting(conn, bob.actor) as s:
                out = answer(retry(s, rid))
            if n < 6:
                assert out["ok"] is True, (n, out)
        assert out == {"ok": False, "error": "retry_limit"}
        assert requests(su)[0][1:3] == ("failed", "token_expired")
    with as_superuser(conn, commit=False) as su:
        # a crash loop that "try again" restarted ends at the same bound: the next claim past six ends it
        rid = failed_request(conn, su, bob)
        su.conn.execute("alter table public.video_visibility_requests disable trigger video_visibility_requests_guard")
        su.rows("update public.video_visibility_requests set lifetime_attempts = 5 returning 1")
        su.conn.execute("alter table public.video_visibility_requests enable trigger video_visibility_requests_guard")
        with acting(conn, bob.actor) as s:
            assert answer(retry(s, rid))["ok"] is True
        assert svc_value(conn, "select public.claim_visibility_request('w1')")["id"] == rid        # the sixth
        su.rows("update public.video_visibility_requests set lease_until = now() - interval '1 minute' returning 1")
        assert svc_value(conn, "select public.claim_visibility_request('w2')") is None
        assert requests(su)[0][1:3] == ("failed", "interrupted")


def test_the_last_check_waits_for_a_switch_or_an_approval_in_flight_and_then_sees_it(conn):
    """Two real sessions on a database of their own (the shared lab is one rolled-back transaction, which a second session cannot
    see): the marker's transaction takes the channel row FOR SHARE and the video row FOR SHARE, so a switch being turned off or a
    cut being replaced in another transaction is waited for, not raced."""
    from sec_scenario import build_scenario

    admin = sec_db.admin_dsn()
    name = f"ns_visibility_lock_{uuid.uuid4().hex[:8]}"
    dsn = sec_db.build(admin, name)

    def mark(c, rid, ms=400):
        with acting(c, SERVICE) as s:
            c.execute(f"set local lock_timeout = '{ms}ms'")
            out = s.run("select public.mark_visibility_submitting(%s, 'w1')", [rid])
        return out.rows[0][0] if out.ok else out.sqlstate

    try:
        with psycopg.connect(dsn, autocommit=True) as c1, psycopg.connect(dsn, autocommit=True) as c2:
            bob = build_scenario(c1).bob
            with as_superuser(c1, commit=True) as su:
                first = queued(su, bob)
                activate(su, bob.channel)
            assert svc_value(c2, "select public.claim_visibility_request('w1')")["id"] == first
            # an administrator is turning the switch off (the function holds the channel row until it commits): the marker waits
            with acting(c1, bob.actor) as s1:
                assert answer(flip(s1, bob.channel, False))["changed"] is True
                assert mark(c2, first) == "55P03"                              # lock_not_available: it did not race the switch
            # the switch committed and refused the request that was never marked: the marker finds it ended, sets nothing
            assert mark(c2, first) == "not_holder"
            # the marker takes the channel row FOR SHARE on its own account (not only by running into the request row the switch
            # function also holds): a transaction that holds the channel row and has not touched the requests yet is waited for too
            with as_superuser(c1, commit=True) as su:
                third = queued(su, bob, vid="ddddddddddd")
                activate(su, bob.channel)
            assert svc_value(c2, "select public.claim_visibility_request('w1')")["id"] == third
            with as_superuser(c1, commit=True) as su:
                su.rows("select 1 from public.channels where channel_id = %s for update", [bob.channel])
                assert mark(c2, third) == "55P03"
            assert mark(c2, third) == "ok"
            with as_superuser(c1, commit=False) as su:
                assert su.rows("select status, reason, submitting_at is null from public.video_visibility_requests where id = %s", [first]) == [("refused", "not_enabled", True)]
            # a repair (or a new cut) is being written to the video: the marker waits, and when it commits the marker says no
            with as_superuser(c1, commit=True) as su:
                second = queued(su, bob, vid="bbbbbbbbbbb")
                activate(su, bob.channel)
            assert svc_value(c2, "select public.claim_visibility_request('w1')")["id"] == second
            with as_superuser(c1, commit=True) as su:
                su.rows("update public.videos set cut_sha256 = %s where video_id = 'bbbbbbbbbbb' returning 1", [OTHER])
                assert mark(c2, second) == "55P03"                             # waiting for the video row, not reading around it
            assert mark(c2, second) == "cut_changed"
            with as_superuser(c1, commit=False) as su:
                assert su.value("select submitting_at is null from public.video_visibility_requests where id = %s", [second]) is True
    finally:
        sec_db.drop_database(admin, name)


# ── audit list ───────────────────────────────────────────────────────────────

def test_the_audit_list_has_the_new_actions_and_kept_the_old_ones(conn):
    names = ["channel.publish_on_approve", "video.publish_queued", "video.visibility_applied", "video.visibility_refused",
             "video.visibility_failed", "video.visibility_expired", "video.visibility_retry", "video.approve", "marketing.create",
             "video.publish_request", "inbox.reply.retry"]
    with as_superuser(conn, commit=False) as su:
        for n in names:
            assert su.value("select public.audit_action_allowed(%s)", [n]) is True, n
        assert su.value("select public.audit_action_allowed('video.visibility_published')") is False


# ── replay and rollback ──────────────────────────────────────────────────────

def test_applying_it_again_changes_nothing(conn):
    text = MIGRATION_0116.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        before = snapshot(su)
        su.conn.execute(text)
        su.conn.execute(text)
        sec_db.take_off_0119(su)                                      # 0119 sits on 0117's guard: off, then 0117 again, then 0119 back
        sec_db.take_off_0121(su)                                      # 0121 sits on 0117's two functions: off while 0117 replays
        su.conn.execute(MIGRATION_0117.read_text(encoding="utf-8"))   # 0117 replaces audit_action_allowed on top of 0116's
        sec_db.put_back_0119(su)
        sec_db.put_back_0121(su)
        assert snapshot(su) == before


def test_the_rollback_stops_everything_keeps_the_record_restores_0112_byte_for_byte_and_the_migration_applies_again(conn, sc):
    bob = sc.bob
    admin = sec_db.admin_dsn()
    base = f"ns_visibility_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0116_", "0117_", "0119_", "0121_"))])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            fns = [r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")]
            want = {s: (b.execute("select pg_get_functiondef(%s::regprocedure)", [s]).fetchone()[0],
                        b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [s]).fetchone()[0])
                    for s in ("public.approve_video_publish(text, text, jsonb)", "public.audit_action_allowed(text)")}
    finally:
        sec_db.drop_database(admin, base)
    rollback = ROLLBACK_0116.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    body = "\n".join(ln for ln in rollback.splitlines() if ln.strip() not in ("begin;", "commit;"))
    kept = ["channels_publish_switch_guard()", "video_visibility_requests_guard()", "visibility_reason_words()"]
    rollback_0117 = ROLLBACK_0117.read_text(encoding="utf-8")
    body_0117 = "\n".join(ln for ln in rollback_0117.splitlines() if ln.strip() not in ("begin;", "commit;"))
    kept += ["voice_profiles_guard()", "voice_append_only()", "user_voice_refs_immutable()"]  # 0117's rollback keeps its triggers' functions
    with as_superuser(conn, commit=False) as su:
        rid = queued(su, bob)
        assert su.value("select publish_on_approve from public.channels where channel_id = %s", [bob.channel]) is True
        after = snapshot(su)
        sec_db.take_off_0119(su)                   # going down: 0119, 0121, then 0117 (it sits on 0116's audit list), then 0116
        sec_db.take_off_0121(su)
        su.conn.execute(body_0117)
        su.conn.execute(body)
        live = [r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")]
        assert sorted(live) == sorted([*fns, *kept])
        for sig, (definition, acl) in want.items():
            assert su.value("select pg_get_functiondef(%s::regprocedure)", [sig]) == definition, sig
            assert su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]) == acl, sig
        # nothing can be acted on after it: the switch is off everywhere and the waiting request is refused, kept as a record
        assert su.value("select count(*) from public.channels where publish_on_approve") == 0
        row = requests(su)[0]
        assert row[0] == rid and row[1:3] == ("refused", "not_enabled") and row[13] is not None
        assert su.value("select public.audit_action_allowed('video.publish_queued')") is False
        assert su.value("select public.audit_action_allowed('video.approve')") is True
        # approving after the rollback is Phase 1a again: nothing is queued
        su.rows("update public.videos set review_state = 'pending', approved_cut_sha256 = null, approval_expires_at = null where video_id = %s returning 1", [VID])
        switch(su, bob.channel)
        with acting(conn, bob.actor) as s:
            out = answer(approve(s))
        assert set(out) == PHASE_1A_KEYS and len(requests(su)) == 1
        switch(su, bob.channel, False)
        su.conn.execute(body)                      # the rollback replays
        su.conn.execute(MIGRATION_0116.read_text(encoding="utf-8"))
        su.conn.execute(MIGRATION_0117.read_text(encoding="utf-8"))   # going up: 0116, then 0117, then 0119, then 0121
        sec_db.put_back_0119(su)
        sec_db.put_back_0121(su)
        assert snapshot(su) == after
        su.conn.execute(MIGRATION_0116.read_text(encoding="utf-8"))
        sec_db.take_off_0119(su)
        sec_db.take_off_0121(su)
        su.conn.execute(MIGRATION_0117.read_text(encoding="utf-8"))
        sec_db.put_back_0119(su)
        sec_db.put_back_0121(su)
        assert snapshot(su) == after
