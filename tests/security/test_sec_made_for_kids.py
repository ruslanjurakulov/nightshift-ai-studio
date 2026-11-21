"""Migration 0145: a video's YouTube "made for kids" declaration, attacked in a real database.

What would break without these:
  * a video approved (and so queued to go public) on the pipeline's detection alone, with nobody's answer to "is this made for
    kids?"; an answer that agrees with the detection not being recorded as an answer; an answer without who or when;

  * kids content recorded as "not made for kids" with nobody's confirmation (by the function, or by any writer: the column check);
  * a member who is not an administrator (editor, viewer), another organization's member, anon or the service key changes the
    declaration, or learns that a video exists;
  * the declaration changes under a live approval, or on a video that is already public (YouTube holds the value);
  * a change leaves no audit row, or a replay writes a second one;
  * a browser's "Run now" row cannot carry made_for_kids, or can carry it as false / a string, or on a repair;
  * a replay changes anything; the rollback leaves anything of 0122, 0117 or 0076 different, or the file does not apply again.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from contextlib import contextmanager

import sec_db
from sec_db import ANON, SERVICE, acting as _acting, as_superuser
from test_sec_approve_video import OTHER, approve, member, uploaded
from test_sec_visibility import requests, switch

SET = "select public.set_video_made_for_kids(%s, %s, %s, %s)"
VID = "Kd5aBc7dEfG"
CUT = hashlib.sha256(b"the cut the reviewer watched").hexdigest()


@contextmanager
def acting(conn, who):
    try:
        with _acting(conn, who, commit=True) as s:
            yield s
    finally:
        conn.execute("reset role")
        conn.execute("select set_config('request.jwt.claims', '', true)")


def kids_video(su, channel, vid=VID, **over):
    """A kids video as the pipeline leaves it: detected kids content, declared made for kids, and nobody's answer yet."""
    uploaded(su, channel, vid, cut_sha256=CUT, **over)
    su.rows("update public.videos set made_for_kids = true, kids_content = true, made_for_kids_answered_by = null, "
            "made_for_kids_answered_at = null, made_for_kids_answered_cut_sha256 = null where video_id = %s returning 1", [vid])
    return vid


def record(su, vid=VID):
    return su.rows("select made_for_kids, kids_content, made_for_kids_off_by, made_for_kids_off_at is not null "
                   "from public.videos where video_id = %s", [vid])[0]


def answered(su, vid=VID):
    by, at = su.rows("select made_for_kids_answered_by, made_for_kids_answered_at from public.videos where video_id = %s", [vid])[0]
    return (str(by) if by else None), at is not None


def audits(su, vid=VID):
    return su.rows("select actor_user_id, detail from public.app_audit_log where action = 'video.made_for_kids' and target = %s",
                   [vid])


def answer(out):
    assert out.ok, out
    return out.rows[0][0]


# ── the rule ────────────────────────────────────────────────────────────────

def test_kids_content_is_never_declared_not_for_kids_without_the_words(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        kids_video(su, bob.channel)
        with acting(conn, bob.actor) as s:
            out = answer(s.run(SET, [VID, False, False, CUT]))
            assert out == {"ok": False, "error": "confirm_required"}
            assert answer(s.run(SET, [VID, False, None, CUT]))["error"] == "confirm_required"
        assert record(su) == (True, True, None, False) and audits(su) == []
        with acting(conn, bob.actor) as s:
            out = answer(s.run(SET, [VID, False, True, CUT]))
        assert out["ok"] is True and out["confirmed_off"] is True and out["kids_content"] is True
        made, kids, by, at = record(su)
        assert (made, kids, str(by), at) == (False, True, bob.actor.uid, True)
        assert answered(su) == (bob.actor.uid, True)
        [(actor, detail)] = audits(su)
        assert str(actor) == bob.actor.uid
        assert detail == {"video_id": VID, "made_for_kids": False, "was": True, "kids_content": True, "confirmed_off": True,
                          "answer": True, "answered_before": False, "cut_sha256": CUT}
        # Back on: the confirmation goes with it, and one more audit row.
        with acting(conn, bob.actor) as s:
            again = answer(s.run(SET, [VID, True, False, CUT]))
        assert again["ok"] is True and again["confirmed_off"] is False
        assert record(su) == (True, True, None, False) and len(audits(su)) == 2


def test_a_video_that_is_not_kids_content_is_switched_freely_and_a_replay_writes_nothing(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel, VID, cut_sha256=CUT)
        su.rows("update public.videos set made_for_kids = false, kids_content = false where video_id = %s returning 1", [VID])
        with acting(conn, bob.actor) as s:
            assert answer(s.run(SET, [VID, True, False, CUT]))["already"] is False
            assert answer(s.run(SET, [VID, True, False, CUT]))["already"] is True
            assert answer(s.run(SET, [VID, False, False, CUT]))["ok"] is True
        assert record(su) == (False, False, None, False) and len(audits(su)) == 2
        assert answered(su) == (bob.actor.uid, True)


# ── the audience question: a person's answer, before approving ──────────────

def test_a_video_nobody_has_answered_for_cannot_be_approved_and_one_answer_opens_it(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        kids_video(su, bob.channel)
        with acting(conn, bob.actor) as s:
            refused = answer(approve(s, VID, CUT))
        assert refused == {"ok": False, "error": "audience_unanswered"}
        assert su.value("select review_state from public.videos where video_id = %s", [VID]) == "pending"
        assert su.value("select count(*) from public.app_audit_log where action = 'video.approve' and target = %s", [VID]) == 0
        with acting(conn, bob.actor) as s:
            answer(s.run(SET, [VID, True, False, CUT]))
            ok = answer(approve(s, VID, CUT))
        assert ok["ok"] is True, ok


def test_agreeing_with_the_detection_is_an_answer_and_is_recorded(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        kids_video(su, bob.channel)                     # detected: made for kids, value true
        assert answered(su) == (None, False)
        with acting(conn, bob.actor) as s:
            out = answer(s.run(SET, [VID, True, False, CUT]))
        assert out["already"] is False, "the detection is not an answer: saying yes to it is one"
        assert answered(su) == (bob.actor.uid, True) and record(su) == (True, True, None, False)
        [(_, detail)] = audits(su)
        assert detail["answer"] is True and detail["answered_before"] is False and detail["made_for_kids"] is True


def test_each_answer_is_recorded_with_who_and_when_and_no_needs_the_words_on_kids_content(conn, sc):
    bob = sc.bob
    for value, confirm, want in ((True, False, (True, True, None, False)), (False, True, (False, True, bob.actor.uid, True))):
        with as_superuser(conn, commit=False) as su:
            kids_video(su, bob.channel)
            with acting(conn, bob.actor) as s:
                if value is False:
                    assert answer(s.run(SET, [VID, False, False, CUT]))["error"] == "confirm_required"
                    assert answered(su) == (None, False), "a refused 'no' is not an answer"
                assert answer(s.run(SET, [VID, value, confirm, CUT]))["ok"] is True
            made, kids, by, at = record(su)
            assert (made, kids, str(by) if by else None, at) == want
            assert answered(su) == (bob.actor.uid, True)


def test_the_answer_is_about_one_cut_a_stale_page_and_a_later_cut_do_not_count(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        kids_video(su, bob.channel)
        with acting(conn, bob.actor) as s:
            # The page was opened on another cut (a repair landed meanwhile): the answer would be about a video not seen.
            assert answer(s.run(SET, [VID, True, False, OTHER])) == {"ok": False, "error": "cut_changed"}
            assert answer(s.run(SET, [VID, True, False, "not-a-hash"])) == {"ok": False, "error": "bad_hash"}
        assert answered(su) == (None, False) and audits(su) == []
        with acting(conn, bob.actor) as s:
            assert answer(s.run(SET, [VID, True, False, CUT]))["ok"] is True
        assert su.value("select made_for_kids_answered_cut_sha256 from public.videos where video_id = %s", [VID]) == CUT
        # A new cut replaces the master (a writer that recorded the cut without clearing the answer): the answer about the
        # old cut does not approve the new one.
        su.rows("update public.videos set cut_sha256 = %s where video_id = %s returning 1", [OTHER, VID])
        with acting(conn, bob.actor) as s:
            assert answer(approve(s, VID, OTHER)) == {"ok": False, "error": "audience_unanswered"}
            assert answer(s.run(SET, [VID, True, False, OTHER]))["ok"] is True
            assert answer(approve(s, VID, OTHER))["ok"] is True


def test_a_video_with_no_recorded_cut_takes_no_answer(conn, sc):
    with as_superuser(conn, commit=False) as su:
        kids_video(su, sc.bob.channel)
        su.rows("update public.videos set cut_sha256 = null where video_id = %s returning 1", [VID])
        with acting(conn, sc.bob.actor) as s:
            assert answer(s.run(SET, [VID, True, False, CUT])) == {"ok": False, "error": "cut_unknown"}


def test_auto_publish_private_upload_then_answer_then_approve_queues_the_publish(conn, sc):
    """The review finding on PR #699: an auto-publish channel's upload is private now (nothing goes up watchable before a person
    answered), so it is recorded PENDING (main.py, VideoReview.record), not 'approved with nobody behind it'. From there the
    person answers, approves, and the publish-when-approved request is queued: no dead end."""
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        su.rows("update public.channels set auto_publish = true where channel_id = %s returning 1", [bob.channel])
        kids_video(su, bob.channel, review_state="pending", privacy="private")
        switch(su, bob.channel)
        with acting(conn, bob.actor) as s:
            assert answer(approve(s, VID, CUT)) == {"ok": False, "error": "audience_unanswered"}
        assert requests(su, VID) == []
        with acting(conn, bob.actor) as s:
            assert answer(s.run(SET, [VID, True, False, CUT]))["ok"] is True
            out = answer(approve(s, VID, CUT))
        assert out["ok"] is True and out["queued"] is True, out
        assert len(requests(su, VID)) == 1


def test_an_answer_is_who_when_and_what_or_nothing(conn, sc):
    for patch in ("made_for_kids_answered_by = gen_random_uuid()",                      # who, not when
                  "made_for_kids_answered_at = now()",                                    # when, not who
                  "made_for_kids_answered_by = gen_random_uuid(), made_for_kids_answered_at = now()",   # not about a cut
                  "made_for_kids_answered_by = gen_random_uuid(), made_for_kids_answered_at = now(), "
                  "made_for_kids_answered_cut_sha256 = 'abc'",                            # a cut that is no hash
                  "made_for_kids_answered_by = gen_random_uuid(), made_for_kids_answered_at = now(), "
                  "made_for_kids_answered_cut_sha256 = cut_sha256, made_for_kids = null"):
        with as_superuser(conn, commit=False) as su:
            kids_video(su, sc.bob.channel)
            out = su.run(f"update public.videos set {patch} where video_id = %s", [VID])
            assert not out.ok and out.sqlstate == "23514", (patch, out)


def test_no_writer_can_store_kids_content_as_not_for_kids_unconfirmed(conn, sc):
    with as_superuser(conn, commit=False) as su:
        kids_video(su, sc.bob.channel)
    for patch in ("made_for_kids = false",                                         # the pipeline's own key, with nobody's word
                  "made_for_kids_off_by = gen_random_uuid(), made_for_kids_off_at = now()",   # a confirmation for nothing
                  "made_for_kids = false, made_for_kids_off_by = gen_random_uuid()"):         # who, but not when
        with as_superuser(conn, commit=False) as su:
            kids_video(su, sc.bob.channel)
            out = su.run(f"update public.videos set {patch} where video_id = %s", [VID])
            assert not out.ok and out.sqlstate == "23514", (patch, out)


# ── who may decide ──────────────────────────────────────────────────────────

def test_only_an_administrator_of_the_videos_organization_decides(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        kids_video(su, bob.channel)
        editor = member(su, bob.org, "editor")
        viewer = member(su, bob.org, "viewer")
        for who in (editor, viewer, sc.alice.actor, sc.stranger):
            with acting(conn, who) as s:
                out = s.run(SET, [VID, False, True, CUT])
            assert not out.ok and out.sqlstate in ("42501", "P0002"), (who, out)
        # Another organization's video reads like a missing one.
        with acting(conn, sc.alice.actor) as s:
            foreign, missing = s.run(SET, [VID, True, False, CUT]), s.run(SET, ["NoSuchVid01", True, False, CUT])
        assert (foreign.sqlstate, missing.sqlstate) == ("P0002", "P0002"), (foreign, missing)
        for who in (ANON, SERVICE):
            with acting(conn, who) as s:
                out = s.run(SET, [VID, False, True, CUT])
            assert not out.ok and out.sqlstate == "42501", (who, out)
        assert record(su) == (True, True, None, False) and audits(su) == []


def test_a_public_video_and_a_live_approval_keep_their_declaration(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        kids_video(su, bob.channel, privacy="public")
        with acting(conn, bob.actor) as s:
            assert answer(s.run(SET, [VID, False, True, CUT]))["error"] == "already_public"
    with as_superuser(conn, commit=False) as su:
        kids_video(su, bob.channel)
        su.rows("update public.videos set review_state = 'approved', approved_cut_sha256 = %s, decided_by = %s, decided_at = now(), "
                "approval_expires_at = now() + interval '1 hour' where video_id = %s returning 1", [CUT, bob.actor.uid, VID])
        with acting(conn, bob.actor) as s:
            assert answer(s.run(SET, [VID, False, True, CUT]))["error"] == "approval_live"
        # Expired: the declaration may change again.
        su.rows("update public.videos set approval_expires_at = now() - interval '1 minute' where video_id = %s returning 1", [VID])
        with acting(conn, bob.actor) as s:
            assert answer(s.run(SET, [VID, False, True, CUT]))["ok"] is True


def test_the_function_is_rate_limited(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel, VID, cut_sha256=CUT)
        su.rows("update public.videos set made_for_kids = false, kids_content = false where video_id = %s returning 1", [VID])
        words = []
        with acting(conn, bob.actor) as s:
            for i in range(22):
                words.append(answer(s.run(SET, [VID, i % 2 == 0, False, CUT])).get("error"))
        assert "rate_limited" in words and words.index("rate_limited") == 20, words


# ── a run's made_for_kids ───────────────────────────────────────────────────

def _render_job(s, channel, params):
    return s.run("insert into public.render_jobs (channel_id, kind, params, status, attempts, max_attempts, credit_ref) "
                 "values (%s, 'daily', %s, 'queued', 0, 3, %s)",
                 [channel, json.dumps(params), s.value("select public.reserve_credits(%s, 'rj-' || gen_random_uuid()::text, 60) "
                                                       "->> 'job_id'", [_org(s, channel)])])


def _org(s, channel):
    return s.value("select org_id from public.channels where channel_id = %s", [channel])


def test_a_browsers_run_carries_made_for_kids_true_and_nothing_else(conn, sc):
    bob = sc.bob
    for params, ok in (({"duration": 300, "made_for_kids": True}, True),
                       ({"duration": 300, "made_for_kids": False}, False),
                       ({"duration": 300, "made_for_kids": "true"}, False),
                       ({"duration": 300, "made_for_kids": None}, False)):
        with as_superuser(conn, commit=False):   # each case in a world of its own: queued jobs count against the parallel limit
            with acting(conn, bob.actor) as s:
                out = _render_job(s, bob.channel, params)
        assert out.ok is ok, (params, out)
    with as_superuser(conn, commit=False) as su:
        assert su.value("""select public.render_job_params_valid('{"repair_scenes":"s001","made_for_kids":true}', 'repair')""") is False
        assert su.value("""select public.render_job_params_valid('{"topic":"t","niche":"n","made_for_kids":true}', 'series_plan')""") is False


# ── replay and rollback ─────────────────────────────────────────────────────

def snapshot(su):
    return (su.rows("select p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), p.proacl::text from pg_proc p "
                    "where p.pronamespace = 'public'::regnamespace order by 1"),
            su.rows("select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies order by 1, 2, 3"),
            su.rows("select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint "
                    "where connamespace = 'public'::regnamespace order by 1, 2"),
            su.rows("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by 1, 2"))


def test_applying_it_again_changes_nothing(conn):
    with as_superuser(conn, commit=False) as su:
        before = snapshot(su)
        sec_db.take_off_0204(su)  # 0204 sits on 0145's audit list, and 0145's drift guard refuses any other body: off, then back
        su.conn.execute(sec_db.MIGRATION_0145.read_text(encoding="utf-8"))
        su.conn.execute(sec_db.MIGRATION_0145.read_text(encoding="utf-8"))
        sec_db.put_back_0204(su)
        assert snapshot(su) == before


def test_the_drift_guard_refuses_a_body_it_has_not_seen(conn):
    with as_superuser(conn, commit=False) as su:
        su.conn.execute("create or replace function public.audit_action_allowed(p_action text) returns boolean "
                        "language sql immutable set search_path = public, pg_temp as $$ select true $$")
        out = su.run(sec_db.MIGRATION_0145.read_text(encoding="utf-8"))
        assert not out.ok and "neither 0117's body nor 0145's" in (out.error or ""), out


def test_the_rollback_restores_what_0145_replaced_and_the_migration_applies_again(conn):
    rollback = sec_db.ROLLBACK_0145.read_text(encoding="utf-8")
    assert re.search(r"(?m)^begin;$", rollback) and re.search(r"(?m)^commit;$", rollback)
    admin = sec_db.admin_dsn()
    base = f"ns_mfk_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence() if not f.name.startswith(("0145_", *sec_db.NEEDS_0145))])
        import psycopg

        with psycopg.connect(base_dsn, autocommit=True) as b:
            want = {sig: b.execute("select pg_get_functiondef(%s::regprocedure)", [sig]).fetchone()[0]
                    for sig in ("public.render_job_params_valid(jsonb, text)", "public.audit_action_allowed(text)",
                                "public.approve_video_publish(text, text, jsonb)")}
            policy = b.execute("select cmd, qual, with_check from pg_policies where tablename = 'render_jobs' "
                               "and policyname = 'render_jobs_insert'").fetchone()
    finally:
        sec_db.drop_database(admin, base)
    with as_superuser(conn, commit=False) as su:
        after = snapshot(su)
        sec_db.take_off_0145(su)
        for sig, definition in want.items():
            assert su.value("select pg_get_functiondef(%s::regprocedure)", [sig]) == definition, sig
        assert su.rows("select cmd, qual, with_check from pg_policies where tablename = 'render_jobs' "
                       "and policyname = 'render_jobs_insert'")[0] == policy
        assert su.value("select to_regprocedure('public.set_video_made_for_kids(text, boolean, boolean, text)')") is None
        # The record stays: what each video declared and who confirmed it.
        assert su.value("select count(*) from information_schema.columns where table_name = 'videos' "
                        "and column_name like 'made_for_kids%'") == 6
        sec_db.put_back_0145(su)
        assert snapshot(su) == after
