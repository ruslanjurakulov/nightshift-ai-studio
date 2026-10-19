"""Migration 0112: "Approve" on the review panel is a real decision, bound to the exact cut, and nothing else can write it.

What would break without these (each attacked in a real database):

  * a member who is not an administrator of the channel's organization (editor, viewer) approves; a member of organization A
    approves organization B's video, or learns that it exists (a missing video and a foreign one read the same);
  * a platform owner/admin who is not a member of a CUSTOMER organization approves on that customer's behalf (the operator's
    own organization keeps the old rule);
  * a browser inserts an approve intent directly (the old button's write), around the function and its checks;
  * an approval is accepted for a cut the reviewer did not see (a forged or stale hash), for a gate-blocked video, for a
    video with no stored verdict, for a run that never uploaded, for a video with no preview or no recorded cut;
  * the acknowledgement is skipped; the function is hammered without a limit;
  * an approval never expires, or an expired one cannot be given again, or a replay writes a second intent or a second
    audit row, or the audit row is missing / names the wrong person;
  * the cross-post rail stays closed after a real approval (or opens without one);
  * a repaired cut keeps the approval's columns; the rollback leaves anything behind and the file does not re-apply.

Isolation of review_intents and videos, row by row, is covered by test_sec_isolation.py through sec_expectations.TABLES.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid

import psycopg

import sec_db
from contextlib import contextmanager

from sec_db import ANON, SERVICE, Actor, acting as _acting, as_superuser, user
from sec_scenario import DEFAULT_ORG

MIGRATION = sec_db.REPO / "supabase" / "migrations" / "0112_approve_video_publish.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0112_approve_video_publish.sql"
# 0113 redefines approve_video_publish and audit_action_allowed from 0112's text, so the two files are applied (and rolled
# back) as a pair: 0112 then 0113 going up, 0113 then 0112 going down.
MIGRATION_0113 = sec_db.REPO / "supabase" / "migrations" / "0113_visibility_requests.sql"
ROLLBACK_0113 = sec_db.REPO / "docs" / "sql" / "rollback_0113_visibility_requests.sql"

APPROVE = "select public.approve_video_publish(%s, %s, %s::jsonb)"
ACK = json.dumps({"rights_and_labels": True})
VID = "Ab3dEf6hIjK"          # eleven characters: a YouTube id
CUT = hashlib.sha256(b"the cut the reviewer watched").hexdigest()
OTHER = hashlib.sha256(b"another cut").hexdigest()
ALLOWED = {"allowed": True, "blocks": [], "warnings": ["thin_sources"], "checks_run": ["rights", "facts"]}


@contextmanager
def acting(conn, who):
    """The caller's transaction, kept until the surrounding rolled-back world ends (so what the caller wrote can be read back
    as the owner afterwards); the API role and the claims are dropped on the way out."""
    try:
        with _acting(conn, who, commit=True) as s:
            yield s
    finally:
        conn.execute("reset role")
        conn.execute("select set_config('request.jwt.claims', '', true)")


def uploaded(su, channel, vid=VID, **over):
    """An uploaded, private, reviewable video the way the pipeline leaves it (recorded cut, stored verdict)."""
    row = {"video_id": vid, "channel_id": channel, "title": "Up", "slug": f"sl-{vid}", "review_state": "pending",
           "publish_state": "uploaded", "published_at": "2026-10-01T10:00:00Z", "privacy": "private",
           "preview_path": f"{channel}/{vid}.mp4", "cut_sha256": CUT, "gate_verdict": json.dumps(ALLOWED)}
    row.update(over)
    cols = ", ".join(row)
    marks = ", ".join("%s::jsonb" if k == "gate_verdict" else "%s" for k in row)
    su.rows(f"insert into public.videos ({cols}) values ({marks}) returning 1", list(row.values()))
    return vid


def approve(s, vid=VID, cut=CUT, ack=ACK):
    return s.run(APPROVE, [vid, cut, ack])


def answer(out):
    assert out.ok, out
    return out.rows[0][0]


def member(su, org, role, name=None):
    """A bound member of ``org`` with ``role`` (what create_organization / the legacy rows leave). Rolled back with the world."""
    who = user(name or role, f"{role}-{uuid.uuid4().hex[:6]}@m.test")
    su.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1", [who.uid, who.email])
    su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, %s) returning 1",
            [org, who.uid, who.email, role])
    return who


def state(su, vid=VID):
    return su.rows("select review_state, approved_cut_sha256, decided_by, decided_by_email, decided_at, approval_expires_at, "
                   "cut_sha256, privacy from public.videos where video_id = %s", [vid])[0]


def counts(su, vid=VID):
    return (su.value("select count(*) from public.review_intents where video_id = %s and action = 'approve'", [vid]),
            su.value("select count(*) from public.app_audit_log where action = 'video.approve' and target = %s", [vid]))


# ── who may approve ─────────────────────────────────────────────────────────

def test_the_owner_of_the_organization_approves_and_everything_is_written_once(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        # the stuck row of the old button: filed, never read
        su.rows("insert into public.review_intents (channel_id, video_id, action, created_by) values (%s, %s, 'approve', %s) returning 1",
                [bob.channel, VID, bob.actor.uid])
        with acting(conn, bob.actor) as s:
            out = answer(approve(s))
        assert out["ok"] is True and out["already"] is False and out["cut_sha256"] == CUT
        review_state, approved_cut, by, mail, at, exp, cut, privacy = state(su)
        assert review_state == "approved" and approved_cut == CUT and str(by) == bob.actor.uid
        assert mail == bob.actor.email and cut == CUT
        # 24 hours, from the moment of the decision
        assert su.value("select %s::timestamptz - %s::timestamptz between interval '23 hours 59 minutes' and interval '24 hours 1 minute'", [exp, at])
        # nothing touches the privacy: the video is exactly as private as it was
        assert privacy == "private"
        intents = su.rows("select outcome, consumed_at is not null, approved_cut_sha256, created_by from public.review_intents "
                          "where video_id = %s and action = 'approve' order by id", [VID])
        assert [r[0] for r in intents] == ["superseded_by_approval", "recorded"], intents
        assert intents[1][1] is True and intents[1][2] == CUT and str(intents[1][3]) == bob.actor.uid
        audit = su.rows("select actor_user_id, actor_email, channel_id, detail from public.app_audit_log "
                        "where action = 'video.approve' and target = %s", [VID])
        assert len(audit) == 1 and str(audit[0][0]) == bob.actor.uid and audit[0][2] == bob.channel
        assert audit[0][3]["cut_sha256"] == CUT and audit[0][3]["rights_and_labels"] is True and audit[0][3]["gate_allowed"] is True
        # no text of the script and no token in it
        assert set(audit[0][3]) == {"video_id", "cut_sha256", "gate_allowed", "rights_and_labels", "expires_at", "intent_id"}


def test_an_editor_and_a_viewer_cannot_approve_an_administrator_can(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        editor, viewer, admin = (member(su, bob.org, r) for r in ("editor", "viewer", "admin"))
        for who in (editor, viewer):
            with acting(conn, who) as s:
                out = approve(s)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        assert state(su)[0] == "pending" and counts(su) == (0, 0)
        with acting(conn, admin) as s:
            assert answer(approve(s))["ok"] is True
        assert state(su)[0] == "approved"


def test_another_organization_cannot_approve_and_cannot_tell_the_video_exists(conn, sc):
    alice, bob = sc.alice, sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, alice.actor) as s:
            foreign = approve(s)
            missing = approve(s, vid="NoSuchVid12")
            malformed = approve(s, vid="x; drop table videos")
        for out in (foreign, missing, malformed):
            assert not out.ok and out.sqlstate == "P0002" and "not_found" in out.error, out
        assert foreign.error == missing.error, "a foreign video and a missing one must read the same"
        assert state(su)[0] == "pending" and counts(su) == (0, 0)


def test_a_platform_admin_cannot_approve_for_a_customer_channel_but_can_in_the_operators_own(conn, sc):
    bob, op = sc.bob, sc.operator
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, op) as s:
            out = approve(s)
        assert not out.ok and out.sqlstate == "42501", out
        assert state(su)[0] == "pending" and counts(su) == (0, 0)
        # the same person, once a real administrator of that organization, may
        su.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'admin') returning 1",
                [bob.org, op.uid, op.email])
        with acting(conn, op) as s:
            assert answer(approve(s))["ok"] is True
    with as_superuser(conn, commit=False) as su:
        uploaded(su, "default", vid="Op3dEf6hIjK")
        with acting(conn, op) as s:
            assert answer(approve(s, vid="Op3dEf6hIjK"))["ok"] is True


def test_anon_and_the_service_key_cannot_call_it_and_the_worker_rule_is_the_workers_alone(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        for who in (ANON, SERVICE):
            with acting(conn, who) as s:
                out = approve(s)
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        with acting(conn, bob.actor) as s:
            for fn in ("public.video_publish_refusal(%s, %s)", "public.video_approve_refusal(%s, %s)"):
                out = s.run(f"select {fn}", [VID, CUT])
                assert not out.ok and out.sqlstate == "42501", (fn, out)
        with acting(conn, SERVICE) as s:
            assert s.value("select public.video_publish_refusal(%s, %s)", [VID, CUT]) == "not_approved"
            out = s.run("select public.video_approve_refusal(%s, %s)", [VID, CUT])
            assert not out.ok and out.sqlstate == "42501", out
        assert su.value("select has_function_privilege('authenticated', 'public.approve_video_publish(text,text,jsonb)', 'EXECUTE')") is True
        assert su.value("select has_function_privilege('anon', 'public.approve_video_publish(text,text,jsonb)', 'EXECUTE')") is False
        assert su.value("select has_function_privilege('service_role', 'public.approve_video_publish(text,text,jsonb)', 'EXECUTE')") is False


def test_the_access_word_tells_each_person_where_they_stand_and_reveals_nothing_about_other_tenants(conn, sc):
    bob, alice, op = sc.bob, sc.alice, sc.operator
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        editor, viewer, admin = (member(su, bob.org, r) for r in ("editor", "viewer", "admin"))
        uploaded(su, "default", vid="Op3dEf6hIjK")

        def word(who, vid=VID):
            with acting(conn, who) as s:
                return s.value("select public.video_approve_access(%s)", [vid])

        assert word(bob.actor) == "ok" and word(admin) == "ok"
        assert word(editor) == "not_admin" and word(viewer) == "not_admin"
        assert word(op) == "not_member"                      # a platform owner reading a customer's channel
        assert word(op, "Op3dEf6hIjK") == "ok"               # but in the operator's own organization the old rule stays
        # another organization, a missing video and a malformed id are all the same answer
        assert word(alice.actor) == word(bob.actor, "NoSuchVid12") == word(bob.actor, "x; drop table videos") == "not_found"
        # and approve_video_publish refuses exactly where the word is not ok
        for who, state_ in ((editor, "42501"), (viewer, "42501"), (op, "42501"), (alice.actor, "P0002")):
            with acting(conn, who) as s:
                out = approve(s)
            assert not out.ok and out.sqlstate == state_, (who.name, out)
        with acting(conn, ANON) as s:
            assert not s.run("select public.video_approve_access(%s)", [VID]).ok


# ── the old write is closed ─────────────────────────────────────────────────

def test_a_browser_can_no_longer_insert_an_approve_intent_directly(conn, sc):
    bob = sc.bob
    q = "insert into public.review_intents (channel_id, video_id, action) values (%s, %s, %s)"
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            direct = s.run(q, [bob.channel, VID, "approve"])
            no_video = s.run(q, [bob.channel, None, "approve"])
            still = [s.run(q, [bob.channel, VID, a]) for a in ("regenerate", "regenerate_script")]
            scene = s.run("insert into public.review_intents (channel_id, video_id, action, scene_id) values (%s, %s, 'regenerate_scene', 's001')",
                          [bob.channel, VID])
        for out in (direct, no_video):
            assert not out.ok and out.sqlstate == "42501", out
        # everything else the policy allowed, it still allows
        assert all(o.ok for o in still) and scene.ok, (still, scene)
        # nobody writes the approval's hash by hand, on any row: only the function does
        for action in ("regenerate", "regenerate_script"):
            with acting(conn, bob.actor) as s2:
                forged = s2.run("insert into public.review_intents (channel_id, video_id, action, approved_cut_sha256) values (%s, %s, %s, %s)",
                                [bob.channel, VID, action, CUT])
            assert not forged.ok and forged.sqlstate == "42501", forged
        assert state(su)[0] == "pending"


# ── what may be approved, and only the cut that was seen ───────────────────

def test_a_forged_or_stale_hash_is_refused_and_nothing_is_written(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            assert answer(approve(s, cut=OTHER)) == {"ok": False, "error": "cut_changed"}
            for bad in (None, "", "abc", CUT.upper(), CUT + "0", "z" * 64):
                assert answer(approve(s, cut=bad)) == {"ok": False, "error": "bad_hash"}, bad
        assert state(su)[0] == "pending" and state(su)[1] is None and counts(su) == (0, 0)


def test_the_acknowledgement_is_required(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            for ack in (None, "{}", '{"rights_and_labels": false}', '{"rights_and_labels": "true"}', '{"rights_and_labels": 1}',
                        '[true]', '"rights_and_labels"'):
                assert answer(approve(s, ack=ack)) == {"ok": False, "error": "ack_required"}, ack
        assert counts(su) == (0, 0)


def test_what_cannot_be_approved_says_why(conn, sc):
    bob = sc.bob
    cases = {
        "gate_blocked": dict(gate_verdict=json.dumps({"allowed": False, "blocks": ["rights"], "warnings": [], "checks_run": []})),
        "gate_blocked ": dict(gate_verdict=json.dumps({"allowed": True, "blocks": ["rights"], "warnings": [], "checks_run": []})),
        "gate_unknown": dict(gate_verdict=None),
        "gate_unknown ": dict(gate_verdict=json.dumps({"warnings": []})),
        "gate_unknown  ": dict(gate_verdict=json.dumps({"allowed": "true"})),
        "not_uploaded": dict(publish_state="held", published_at=None, privacy=None),
        "not_uploaded ": dict(publish_state="blocked", published_at=None, privacy=None),
        "no_preview": dict(preview_path=None),
        "cut_unknown": dict(cut_sha256=None),
        "rejected": dict(review_state="rejected"),
        "already_public": dict(privacy="public"),
    }
    for want, over in cases.items():
        with as_superuser(conn, commit=False) as su:
            uploaded(su, bob.channel, **over)
            with acting(conn, bob.actor) as s:
                assert answer(approve(s)) == {"ok": False, "error": want.strip()}, want
            assert counts(su) == (0, 0), want
    # a run that never uploaded has the stand-in id, not a YouTube id, even when its other columns look uploaded
    with as_superuser(conn, commit=False) as su:
        held = "run-" + hashlib.sha256(b"x").hexdigest()[:20]
        uploaded(su, bob.channel, vid=held)
        with acting(conn, bob.actor) as s:
            assert answer(approve(s, vid=held)) == {"ok": False, "error": "not_uploaded"}


def test_a_channel_that_publishes_on_its_own_has_nothing_to_approve(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel, review_state="approved")     # video_review.record writes this when auto publish is on
        with acting(conn, bob.actor) as s:
            assert answer(approve(s)) == {"ok": False, "error": "already_approved"}
        assert state(su)[2] is None and counts(su) == (0, 0)


# ── replay, expiry, the worker's rule ──────────────────────────────────────

def test_a_replay_changes_nothing_and_writes_nothing_twice(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            first = answer(approve(s))
            before = state(su)
            second = answer(approve(s))
        assert first["already"] is False and second["already"] is True
        assert second["expires_at"] == first["expires_at"] and state(su) == before
        assert counts(su) == (1, 1)


def test_an_expired_approval_is_reported_expired_and_can_be_given_again(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            answer(approve(s))
        with acting(conn, SERVICE) as s:
            assert s.value("select public.video_publish_refusal(%s, %s)", [VID, CUT]) is None
        su.rows("update public.videos set approval_expires_at = now() - interval '1 second' where video_id = %s returning 1", [VID])
        with acting(conn, SERVICE) as s:
            assert s.value("select public.video_publish_refusal(%s, %s)", [VID, CUT]) == "approval_expired"
        with acting(conn, bob.actor) as s:
            again = answer(approve(s))
        assert again["ok"] is True and again["already"] is False
        assert su.value("select approval_expires_at > now() + interval '23 hours' from public.videos where video_id = %s", [VID])
        assert counts(su) == (2, 2)
        with acting(conn, SERVICE) as s:
            assert s.value("select public.video_publish_refusal(%s, %s)", [VID, CUT]) is None


def test_the_workers_rule_names_every_reason(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            answer(approve(s))

        def refusal(vid=VID, cut=CUT):
            with acting(conn, SERVICE) as s:
                return s.value("select public.video_publish_refusal(%s, %s)", [vid, cut])

        assert refusal() is None
        assert refusal("NoSuchVid12") == "video_not_found"
        assert refusal(cut=OTHER) == "cut_changed"
        assert refusal(cut=None) == "cut_changed"
        su.rows("update public.videos set privacy = 'public' where video_id = %s returning 1", [VID])
        assert refusal() == "already_public"
        su.rows("update public.videos set privacy = 'private', review_state = 'pending' where video_id = %s returning 1", [VID])
        assert refusal() == "not_approved"
        # approved for one cut, then the video was recorded again with another: the approval is for a cut that is gone
        su.rows("update public.videos set review_state = 'approved', cut_sha256 = %s where video_id = %s returning 1", [OTHER, VID])
        assert refusal(cut=OTHER) == "cut_changed"
        assert refusal(cut=CUT) == "cut_changed"
        su.rows("update public.videos set cut_sha256 = %s, gate_verdict = null where video_id = %s returning 1", [CUT, VID])
        assert refusal() == "gate_unknown"


def test_the_function_is_rate_limited_per_person(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, bob.actor) as s:
            outs = [answer(approve(s)) for _ in range(22)]
        assert [o.get("error") for o in outs[:20]] == [None] * 20
        assert [o.get("error") for o in outs[20:]] == ["rate_limited"] * 2
        assert counts(su) == (1, 1)


# ── the cross-post rail ─────────────────────────────────────────────────────

def test_the_cross_post_rail_opens_for_an_approved_video_on_a_channel_that_does_not_auto_publish(conn, sc):
    bob = sc.bob
    with as_superuser(conn, commit=False) as su:
        uploaded(su, bob.channel)
        with acting(conn, SERVICE) as s:
            assert s.value("select public.publish_request_refusal(%s)", [VID]) == "not_approved"
        q = ("insert into public.publish_requests (video_id, account_id) values (%s, %s) "
             "returning status, reason")
        with acting(conn, bob.actor) as s:
            closed = s.run(q, [VID, bob.social_account])
            assert closed.ok and closed.rows[0] == ("refused", "not_approved"), closed
            answer(approve(s))
        with acting(conn, SERVICE) as s:
            assert s.value("select public.publish_request_refusal(%s)", [VID]) is None
        with acting(conn, bob.actor) as s:
            opened = s.run(q, [VID, bob.social_account])
        assert opened.ok and opened.rows[0] == ("queued", None), opened


# ── replay, grants, rollback ────────────────────────────────────────────────

def snapshot(su):
    return (su.rows("select p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), p.proacl::text from pg_proc p "
                    "where p.pronamespace = 'public'::regnamespace order by 1"),
            su.rows("select tgname, tgrelid::regclass::text, tgenabled from pg_trigger where not tgisinternal order by 1, 2"),
            su.rows("select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies order by 1, 2, 3"),
            su.rows("select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint "
                    "where connamespace = 'public'::regnamespace order by 1, 2"),
            su.rows("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by 1, 2"))


def test_applying_it_again_changes_nothing(conn):
    text = MIGRATION.read_text(encoding="utf-8")
    with as_superuser(conn, commit=False) as su:
        before = snapshot(su)
        su.conn.execute(text)
        su.conn.execute(text)
        # 0112 alone puts back its own approve_video_publish and audit list; 0113 replaces both, so it goes on top again.
        su.conn.execute(MIGRATION_0113.read_text(encoding="utf-8"))
        assert snapshot(su) == before


def test_the_grants_are_what_the_file_says(conn):
    with as_superuser(conn, commit=False) as su:
        def priv(sig):
            return [su.value("select has_function_privilege(%s, %s::regprocedure, 'EXECUTE')", [r, sig]) for r in ("anon", "authenticated", "service_role")]
        assert priv("public.approve_video_publish(text, text, jsonb)") == [False, True, False]
        assert priv("public.video_approve_access(text)") == [False, True, False]
        assert priv("public.video_real_member(uuid, text)") == [False, False, False]
        assert priv("public.video_publish_refusal(text, text)") == [False, False, True]
        assert priv("public.video_approve_refusal(text, text)") == [False, False, False]
        assert priv("public.audit_action_allowed(text)") == [False, False, False]
        assert priv("public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)") == [False, False, True]
        for sig in ("approve_video_publish(text, text, jsonb)", "video_approve_access(text)", "video_real_member(uuid, text)", "video_publish_refusal(text, text)", "video_approve_refusal(text, text)"):
            assert su.value("select prosecdef from pg_proc where oid = %s::regprocedure", [f"public.{sig}"]) is True
            assert "search_path=public, pg_temp" in su.value("select proconfig::text from pg_proc where oid = %s::regprocedure", [f"public.{sig}"])


def test_the_rollback_restores_what_0112_replaced_and_the_migration_applies_again(conn):
    admin = sec_db.admin_dsn()
    base = f"ns_approve_base_{uuid.uuid4().hex[:8]}"
    base_dsn = sec_db.create_database(admin, base)
    try:
        sec_db.apply_files(base_dsn, [f for f in sec_db.build_sequence()
                                      if not f.name.startswith(("0112_", "0113_"))])
        with psycopg.connect(base_dsn, autocommit=True) as b:
            fns = [r[0] for r in b.execute("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace order by 1")]
            want = {s: (b.execute("select pg_get_functiondef(%s::regprocedure)", [s]).fetchone()[0],
                        b.execute("select proacl::text from pg_proc where oid = %s::regprocedure", [s]).fetchone()[0])
                    for s in ("public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)", "public.audit_action_allowed(text)")}
            policy = b.execute("select cmd, qual, with_check from pg_policies where tablename = 'review_intents' and policyname = 'review_intents_insert'").fetchone()
    finally:
        sec_db.drop_database(admin, base)
    def sql_body(path):
        text = path.read_text(encoding="utf-8")
        assert re.search(r"(?m)^begin;$", text) and re.search(r"(?m)^commit;$", text)
        return "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))

    body, body_0113 = sql_body(ROLLBACK), sql_body(ROLLBACK_0113)
    # 0113's rollback keeps (by design, see its header) the three internal functions its kept table and triggers need.
    kept = ["channels_publish_switch_guard()", "video_visibility_requests_guard()", "visibility_reason_words()"]
    with as_superuser(conn, commit=False) as su:
        after = snapshot(su)
        su.conn.execute(body_0113)                 # going down: 0113, then 0112
        su.conn.execute(body)
        live = [r[0] for r in su.rows("select p.oid::regprocedure::text from pg_proc p where pronamespace = 'public'::regnamespace")]
        assert sorted(live) == sorted([*fns, *kept])
        for sig, (definition, acl) in want.items():
            assert su.value("select pg_get_functiondef(%s::regprocedure)", [sig]) == definition, sig
            assert su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [sig]) == acl, sig
        assert su.rows("select cmd, qual, with_check from pg_policies where tablename = 'review_intents' and policyname = 'review_intents_insert'")[0] == policy
        assert su.value("select public.audit_action_allowed('video.approve')") is False
        # the columns stay (a record of who approved what); the direct insert works again
        assert su.value("select count(*) from information_schema.columns where table_name = 'videos' and column_name = 'cut_sha256'") == 1
        su.conn.execute(body_0113)                 # the rollbacks replay
        su.conn.execute(body)
        su.conn.execute(MIGRATION.read_text(encoding="utf-8"))      # going up: 0112, then 0113
        su.conn.execute(MIGRATION_0113.read_text(encoding="utf-8"))
        assert snapshot(su) == after
