"""Migration 0058: a waiting storyboard is edited only by someone who may start
runs on its channel, only while it waits, only on the revision they saw, and
only within bounds the database sets; and an approved storyboard whose render
failed goes back to waiting without a second render or a render nobody pays
for.

What would break without these:

* another organization, a viewer, a stranger or anon rewriting a tenant's
  plan (and so what renders on the victim's money);
* an approved — paid for — storyboard changing after the price was held;
* two people saving at once and one silently overwriting the other;
* an approval of content the person never saw (an edit landing between the
  price on the button and the press);
* an edit that makes a long render cheap (the browser choosing a scene's
  length), sneaks cue markup into the narration, references anything by id,
  or exceeds what a run may be;
* re-opening while a render may still start or be running (two renders), or
  while the failed approval's hold is still open, or after a render that
  finished — and a re-approval that renders on the old, released hold.

Isolation (row by row) of ``storyboards`` is covered by test_sec_isolation.py.
"""

from __future__ import annotations

import json
import threading

import psycopg

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scenario import seat_invitee
from sec_storyboard_0057 import STORYBOARD, insert
from test_sec_storyboards import PRICES, approve, held_for, owner, status_of, world


def save(s, sid, revision, scenes):
    return s.run("select public.save_storyboard_edits(%s, %s, %s::jsonb)", [sid, revision, json.dumps(scenes)])


def approve_at(s, sid, revision, amount=60, backend="queue"):
    return s.run("select public.approve_storyboard_at(%s, %s, %s, %s)", [sid, revision, amount, backend])


def reopen(s, sid):
    return s.run("select public.reopen_storyboard(%s)", [sid])


def row(s, sid) -> dict:
    cols = ("status", "revision", "scenes", "script", "duration_s", "opening_edited", "credit_ref", "render_job_id")
    r = s.rows(f"select {', '.join(cols)} from public.storyboards where id = %s", [sid])[0]
    return dict(zip(cols, r))


def keep_all(n=3):
    """The seeded storyboard's scenes, unchanged (sec_storyboard_0057.scenes)."""
    return [{"src": i + 1, "narration": f"Line {i + 1}.", "visual": "harbour at dawn"} for i in range(n)]


def as_platform(s):
    """The runner's credentials (service key) inside the same transaction."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def as_user(s, actor):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("set local role authenticated")
    return s


# ── who may edit ────────────────────────────────────────────────────────────

def test_another_org_cannot_edit_and_a_missing_one_reads_the_same(conn, sc):
    edit = [{"src": 1, "narration": "Bob was here.", "visual": ""}]
    with acting(conn, sc.bob.actor) as s:
        theirs = save(s, STORYBOARD["a"], 0, edit)
        missing = save(s, "00000000-0000-4000-8000-000000000000", 0, edit)
        reopened = reopen(s, STORYBOARD["a"])
        check = s.run("select public.storyboard_reopen_check(%s)", [STORYBOARD["a"]])
        after = row(owner(s), STORYBOARD["a"])
    for o in (theirs, missing, reopened, check):
        assert not o.ok and o.sqlstate == "42501", o
    assert (theirs.sqlstate, theirs.error) == (missing.sqlstate, missing.error)
    assert after["revision"] == 0 and after["scenes"][0]["narration"] == "Line 1."


def test_a_viewer_cannot_edit(conn, sc):
    # Ivan is bound as a viewer of org A (an extra member 0091 left in place), in this transaction only.
    with acting(conn, sc.invitee) as s:
        seat_invitee(s, sc)
        can_read = s.rows("select revision from public.storyboards where id = %s", [STORYBOARD["a"]])
        out = save(s, STORYBOARD["a"], 0, keep_all()[:1])
        direct = s.run("update public.storyboards set revision = 7, scenes = '[]' where id = %s", [STORYBOARD["a"]])
        assert row(owner(s), STORYBOARD["a"])["revision"] == 0
    assert can_read == [(0,)], "control: a member of the organization reads the storyboard and its revision"
    assert not out.ok and out.sqlstate == "42501", out
    assert not direct.ok or direct.rowcount == 0, direct


def test_strangers_and_anon_cannot_edit(conn, sc):
    with acting(conn, sc.stranger) as s:
        stranger = save(s, STORYBOARD["b"], 0, keep_all())
    with acting(conn, ANON) as s:
        anon = save(s, STORYBOARD["b"], 0, keep_all())
    assert not stranger.ok and stranger.sqlstate == "42501", stranger
    assert not anon.ok and anon.sqlstate == "42501", anon


def test_the_pipeline_key_cannot_rewrite_the_plan_or_its_revision(conn, sc):
    with acting(conn, SERVICE) as s:
        scenes = s.run("update public.storyboards set scenes = scenes where id = %s", [STORYBOARD["b"]])
        rev = s.run("update public.storyboards set revision = 5 where id = %s", [STORYBOARD["b"]])
        fn = save(s, STORYBOARD["b"], 0, keep_all())
        forged = s.run(
            "insert into public.storyboards (channel_id, slug, topic, scenes, script, duration_s, revision, opening_edited) "
            "values (%s, 'forged-rev', 't', %s::jsonb, '{\"sections\": []}'::jsonb, 300, 9, true) returning id",
            [sc.bob.channel, json.dumps([{"n": 1, "narration": "x", "visual": "y", "duration_s": 300}])])
    for o in (scenes, rev, fn):
        assert not o.ok and o.sqlstate == "42501", o
    assert not forged.ok and forged.sqlstate in ("42501", "42703"), forged


# ── what an edit does ───────────────────────────────────────────────────────

def test_an_edit_rewrites_the_cards_and_the_script_the_render_resumes_from(conn, sc):
    sid = STORYBOARD["b"]
    words = " ".join(["word"] * 300)  # 300 words: 120 s at 150 a minute
    edit = [
        {"src": 3, "narration": "Line 3.", "visual": "harbour at dawn"},          # moved first, unchanged text
        {"src": 1, "narration": words, "visual": "lighthouse, storm , , waves"},  # rewritten
        {"src": None, "narration": "A new  closing\nline.", "visual": ""},        # added
    ]                                                                              # scene 2 deleted
    with acting(conn, sc.bob.actor) as s:
        out = save(s, sid, 0, edit)
        r = row(owner(s), sid)
    assert out.ok, out
    res = out.rows[0][0]
    assert res["revision"] == 1 and res["changed"] is True
    assert [c["n"] for c in r["scenes"]] == [1, 2, 3]
    assert [c["narration"] for c in r["scenes"]] == ["Line 3.", words, "A new closing line."]
    assert r["scenes"][1]["visual"] == "lighthouse, storm, waves"
    # The length is the database's: unchanged scenes keep theirs, edited and
    # new ones are measured from their words — the browser sent none.
    assert [c["duration_s"] for c in r["scenes"]] == [100, 120, 2]
    assert r["duration_s"] == 222 == res["duration_s"]
    secs = r["script"]["sections"]
    assert [s_["narration"] for s_ in secs] == ["Line 2.", words, "A new closing line."]  # seeded sections are 0-based
    assert secs[1]["keywords"] == ["lighthouse", "storm", "waves"] and secs[1]["duration_hint"] == 120
    assert secs[0]["name"] == "s2", "an unchanged scene keeps its script section exactly"
    assert r["opening_edited"] is True, "a different first scene is a changed opening"
    assert r["script"]["title"] == "T", "only the sections change"


def test_a_save_that_changes_nothing_does_not_bump_the_revision(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = save(s, STORYBOARD["b"], 0, keep_all())
        r = row(owner(s), STORYBOARD["b"])
    assert out.ok and out.rows[0][0]["changed"] is False, out
    assert r["revision"] == 0 and r["opening_edited"] is False


def test_a_stale_revision_is_refused_never_overwritten(conn, sc):
    sid = STORYBOARD["b"]
    with acting(conn, sc.bob.actor) as s:
        first = save(s, sid, 0, [{"src": 1, "narration": "Mine.", "visual": ""}])
        stale = save(s, sid, 0, [{"src": 1, "narration": "Theirs.", "visual": ""}])
        none = save(s, sid, None, keep_all())
        r = row(owner(s), sid)
    assert first.ok, first
    assert not stale.ok and stale.sqlstate == "NS412", stale
    assert not none.ok and none.sqlstate == "NS412", none
    assert r["revision"] == 1 and [c["narration"] for c in r["scenes"]] == ["Mine."]


def test_two_people_saving_at_once_one_wins_the_other_is_told(conn, sc):
    """Two real sessions save on revision 0 at the same moment: the row lock
    serialises them, the second sees revision 1 and is refused."""
    with acting(conn, SERVICE, commit=True) as s:
        sid = str(insert(s, sc.bob.channel, "race-edit-b").rows[0][0])
    # conn.info.dsn drops the password; rebuild from the admin DSN (as test_sec_run_billing does).
    dsn = psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)
    barrier = threading.Barrier(2)
    results = []

    def press(text):
        with psycopg.connect(dsn, autocommit=True) as c:
            with acting(c, sc.bob.actor, commit=True) as s:
                barrier.wait()
                results.append((text, save(s, sid, 0, [{"src": 1, "narration": text, "visual": ""}])))

    threads = [threading.Thread(target=press, args=(t,)) for t in ("First.", "Second.")]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert sorted(o.ok for _, o in results) == [False, True], results
        winner = next(t for t, o in results if o.ok)
        loser = next(o for _, o in results if not o.ok)
        assert loser.sqlstate == "NS412", loser
        with as_superuser(conn, commit=False) as su:
            r = row(su, sid)
        assert r["revision"] == 1 and r["scenes"][0]["narration"] == winner
    finally:
        with as_superuser(conn) as su:
            su.rows("delete from public.storyboards where id = %s returning 1", [sid])


def test_an_approved_or_discarded_storyboard_cannot_be_edited(conn, sc):
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            assert approve(s, STORYBOARD["b"]).ok
            approved = save(s, STORYBOARD["b"], 0, [{"src": 1, "narration": "After the fact.", "visual": ""}])
            assert row(owner(s), STORYBOARD["b"])["scenes"][0]["narration"] == "Line 1."
    with acting(conn, sc.bob.actor) as s:
        assert s.run("select public.discard_storyboard(%s)", [STORYBOARD["b"]]).ok
        discarded = save(s, STORYBOARD["b"], 0, keep_all()[:1])
    assert not approved.ok and approved.sqlstate == "NS409", approved
    assert not discarded.ok and discarded.sqlstate == "NS409", discarded


def test_edits_are_bounded_and_carry_no_ids(conn, sc):
    long_scene = {"src": None, "narration": " ".join(["word"] * 800), "visual": ""}  # 320 s each
    bad = {
        "foreign asset id": [{"src": 1, "narration": "x", "visual": "", "asset_id": "00000000-0000-4000-8000-000000000001"}],
        "scene id": [{"src": 1, "id": 5, "narration": "x"}],
        "src out of range": [{"src": 4, "narration": "x"}],
        "src not an integer": [{"src": 1.5, "narration": "x"}],
        "src as text": [{"src": "1", "narration": "x"}],
        "duplicate src": [{"src": 1, "narration": "x"}, {"src": 1, "narration": "y"}],
        "empty narration": [{"src": 1, "narration": "   "}],
        "narration not text": [{"src": 1, "narration": ["x"]}],
        "narration too long": [{"src": 1, "narration": "x" * 4001}],
        "visual too long": [{"src": 1, "narration": "x", "visual": "y" * 1001}],
        "too many terms": [{"src": 1, "narration": "x", "visual": ",".join("abcdefghi")}],
        "cue markup": [{"src": 1, "narration": "Hello [ voice : secondary ] there"}],
        "sfx markup": [{"src": 1, "narration": "x", "visual": "[SFX:boom]"}],
        "control character": [{"src": 1, "narration": "x\u0007y"}],
        "direction override": [{"src": 1, "narration": "abc‮def"}],
        "no scenes": [],
        "too many scenes": [{"src": None, "narration": "x"} for _ in range(61)],
        "not a list": {"src": 1, "narration": "x"},
        "longer than a run may be": [long_scene for _ in range(12)],
    }
    with acting(conn, sc.bob.actor) as s:
        outs = {k: save(s, STORYBOARD["b"], 0, v) for k, v in bad.items()}
        r = row(owner(s), STORYBOARD["b"])
    wrong = {k: o for k, o in outs.items() if o.ok or o.sqlstate != "22023"}
    assert not wrong, wrong
    assert r["revision"] == 0


# ── approving the revision the person saw ───────────────────────────────────

def test_an_approval_of_a_revision_that_changed_is_refused_and_holds_nothing(conn, sc):
    sid = STORYBOARD["b"]
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            assert save(s, sid, 0, [{"src": 1, "narration": "Changed.", "visual": ""}]).ok
            stale = approve_at(s, sid, 0)
            assert held_for(owner(s), sid) == []
            as_user(s, sc.bob.actor)
            current = approve_at(s, sid, 1, amount=5)  # 30 s (the floor length) = 6 credits; 5 is below it
            fresh = approve_at(s, sid, 1, amount=6)
            holds = held_for(owner(s), sid)
            r = row(s, sid)
    assert not stale.ok and stale.sqlstate == "NS412", stale
    assert not current.ok and current.sqlstate == "22023", "the floor is the EDITED length's"
    assert fresh.ok, fresh
    assert [(h[1], h[2]) for h in holds] == [(6, "open")], holds
    assert r["status"] == "approved" and r["duration_s"] == 30


def test_an_edit_that_lengthens_the_render_raises_its_floor(conn, sc):
    sid = STORYBOARD["b"]
    long_text = " ".join(["word"] * 700)  # 280 s
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            edit = keep_all() + [{"src": None, "narration": long_text, "visual": ""}]
            assert save(s, sid, 0, edit).ok
            old_price = approve_at(s, sid, 1, amount=60)   # the price of the 300 s plan
            new_price = approve_at(s, sid, 1, amount=116)  # 580 s at 12 a minute
    assert not old_price.ok and old_price.sqlstate == "22023", old_price
    assert new_price.ok, new_price


# ── re-opening after a failed render ────────────────────────────────────────

def _fail_job(s, job_id):
    s.rows("update public.render_jobs set status = 'failed', finished_at = now() where id = %s returning 1", [job_id])


def test_a_failed_queued_render_reopens_only_after_its_hold_is_released(conn, sc):
    sid = STORYBOARD["b"]
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            first = approve_at(s, sid, 0)
            assert first.ok, first
            ref, job = first.rows[0][0]["credit_ref"], first.rows[0][0]["render_job_id"]
            queued = reopen(s, sid)

            as_platform(s)
            s.value("select public.start_credit_reservation(%s, %s)", [ref, sc.bob.org])
            s.rows("update public.render_jobs set status = 'running' where id = %s returning 1", [job])
            as_user(s, sc.bob.actor)
            running = reopen(s, sid)

            as_platform(s)
            _fail_job(s, job)
            as_user(s, sc.bob.actor)
            unsettled = reopen(s, sid)
            check_before = s.value("select public.storyboard_reopen_check(%s)", [sid])

            # The worker's failure path: settle_hold(succeeded=False) releases it.
            as_platform(s)
            s.value("select public.release_credits(%s)", [ref])
            as_user(s, sc.bob.actor)
            check_after = s.value("select public.storyboard_reopen_check(%s)", [sid])
            back = reopen(s, sid)
            again = reopen(s, sid)
            r = row(owner(s), sid)

            # The old approval cannot render any more: its hold never starts again.
            as_platform(s)
            old_start = s.value("select public.start_credit_reservation(%s, %s)", [ref, sc.bob.org])

            as_user(s, sc.bob.actor)
            second = approve_at(s, sid, r["revision"])
            su = owner(s)
            holds = held_for(su, sid)
            live_jobs = su.value("select count(*) from public.render_jobs where channel_id = %s "
                                 "and params ? 'resume' and status in ('queued', 'running')", [sc.bob.channel])
    assert not queued.ok and queued.sqlstate == "NS423" and "hold_not_released" in queued.error, queued
    assert not running.ok and running.sqlstate == "NS423", running
    assert not unsettled.ok and "hold_not_released" in unsettled.error, unsettled
    assert check_before == {"reopenable": False, "reason": "hold_not_released"}
    assert check_after == {"reopenable": True, "reason": None}
    assert back.ok, back
    assert not again.ok and again.sqlstate == "NS409", again
    assert r["status"] == "ready" and r["credit_ref"] is None and r["render_job_id"] is None
    assert old_start is None, "a released hold started again: a render nobody pays for"
    assert second.ok, second
    assert second.rows[0][0]["credit_ref"] != ref and "sb2-" in second.rows[0][0]["credit_ref"]
    assert sorted(h[2] for h in holds) == ["open", "released"], holds
    assert live_jobs == 1, "exactly one render of this storyboard may be pending"


def test_a_render_that_was_charged_cannot_be_reopened(conn, sc):
    sid = STORYBOARD["b"]
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            first = approve_at(s, sid, 0)
            ref, job = first.rows[0][0]["credit_ref"], first.rows[0][0]["render_job_id"]
            as_platform(s)
            s.value("select public.start_credit_reservation(%s, %s)", [ref, sc.bob.org])
            s.value("select public.capture_credits(%s, 50)", [ref])
            _fail_job(s, job)  # the upload failed after the render was paid for
            as_user(s, sc.bob.actor)
            out = reopen(s, sid)
            assert status_of(owner(s), sid) == "approved"
    assert not out.ok and out.sqlstate == "NS423" and "render_finished" in out.error, out


def test_an_actions_render_reopens_only_once_its_hold_is_released(conn, sc):
    sid = STORYBOARD["b"]
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            first = approve_at(s, sid, 0, backend="actions")
            ref = first.rows[0][0]["credit_ref"]
            as_platform(s)
            s.value("select public.start_credit_reservation(%s, %s)", [ref, sc.bob.org])
            as_user(s, sc.bob.actor)
            running = reopen(s, sid)
            as_platform(s)
            s.value("select public.release_credits(%s)", [ref])  # credits_settle after a failed run
            as_user(s, sc.bob.actor)
            back = reopen(s, sid)
    assert not running.ok and running.sqlstate == "NS423", running
    assert back.ok, back


def test_a_viewer_cannot_reopen(conn, sc):
    sid = STORYBOARD["a"]
    with world(conn):
        with acting(conn, sc.invitee) as s:
            # Org A's plan allows no further run in this world, so its approval
            # is staged directly: an Actions approval a day old, released.
            as_platform(s)
            s.rows("update public.storyboards set status = 'approved', backend = 'actions', "
                   "decided_at = now() - interval '25 hours', approvals = 1 where id = %s returning 1", [sid])
            as_user(s, sc.invitee)
            seat_invitee(s, sc)
            out = reopen(s, sid)
            assert status_of(owner(s), sid) == "approved"
            as_user(s, sc.alice.actor)
            control = reopen(s, sid)
    assert not out.ok and out.sqlstate == "42501", out
    assert control.ok, f"control: Alice cannot re-open her own failed render: {control!r}"


def test_the_operators_own_renders_reopen_only_when_the_outcome_is_known(conn, sc):
    """No hold to tell the story (credits-exempt): a queued job must have
    failed, a succeeded one may have rendered, and an Actions run cannot be
    known for 24 hours."""
    with world(conn):
        with acting(conn, SERVICE) as s:
            q = str(insert(s, "default", "op-queue").rows[0][0])
            a = str(insert(s, "default", "op-actions").rows[0][0])
            as_user(s, sc.operator)
            jq = approve_at(s, q, 0, amount=None).rows[0][0]["render_job_id"]
            assert approve_at(s, a, 0, amount=None, backend="actions").ok
            pending = reopen(s, q)
            actions = reopen(s, a)
            as_platform(s)
            s.rows("update public.render_jobs set status = 'succeeded' where id = %s returning 1", [jq])
            as_user(s, sc.operator)
            succeeded = reopen(s, q)
            as_platform(s)
            s.rows("update public.render_jobs set status = 'failed' where id = %s returning 1", [jq])
            s.rows("update public.storyboards set decided_at = now() - interval '25 hours' where id = %s returning 1", [a])
            as_user(s, sc.operator)
            failed = reopen(s, q)
            actions_later = reopen(s, a)
    assert not pending.ok and "render_in_progress" in pending.error, pending
    assert not actions.ok and "render_unverifiable" in actions.error, actions
    assert not succeeded.ok and "render_finished" in succeeded.error, succeeded
    assert failed.ok, failed
    assert actions_later.ok, actions_later


def test_two_people_reopening_and_approving_at_once_render_once(conn, sc):
    """After a failed render, two sessions each re-open and approve again in
    one transaction. The row lock serialises them: one holds and queues, the
    other finds it approved with an open hold and is refused."""
    with as_superuser(conn) as su:
        had = {r[0]: (r[1], r[2]) for r in su.rows(
            "select unit, credits_per_unit, margin from public.credit_prices where unit = any(%s)",
            [list(PRICES)])}
        for unit, rate in PRICES.items():
            su.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
                    "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 "
                    "returning 1", [unit, rate])
    with acting(conn, SERVICE, commit=True) as s:
        sid = str(insert(s, sc.bob.channel, "race-reopen-b").rows[0][0])
    with acting(conn, sc.bob.actor, commit=True) as s:
        first = approve_at(s, sid, 0).rows[0][0]
    with as_superuser(conn) as su:
        _fail_job(su, first["render_job_id"])
        su.value("select public.release_credits(%s)", [first["credit_ref"]])

    dsn = psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)
    barrier = threading.Barrier(2)
    results = []

    def press():
        with psycopg.connect(dsn, autocommit=True) as c:
            with acting(c, sc.bob.actor, commit=True) as s:
                barrier.wait()
                r = reopen(s, sid)
                results.append((r, approve_at(s, sid, 0) if r.ok else None))

    threads = [threading.Thread(target=press) for _ in range(2)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert len(results) == 2, results
        assert sorted(r.ok for r, _ in results) == [False, True], results
        assert next(r for r, _ in results if not r.ok).sqlstate == "NS423"
        assert next(a for r, a in results if r.ok).ok
        with as_superuser(conn, commit=False) as su:
            holds = held_for(su, sid)
            live = su.value("select count(*) from public.render_jobs where credit_ref like %s "
                            "and status in ('queued', 'running')", [f"%-{sid.replace('-', '')}"])
        assert sorted(h[2] for h in holds) == ["open", "released"], holds
        assert live == 1
    finally:
        with as_superuser(conn) as su:
            refs = [h[0] for h in held_for(su, sid)]
            su.rows("delete from public.render_jobs where credit_ref = any(%s) returning 1", [refs])
            for ref in refs:
                su.value("select public.release_credits(%s)", [ref])
            su.rows("delete from public.storyboards where id = %s returning 1", [sid])
            for unit in PRICES:
                if unit in had:
                    su.rows("update public.credit_prices set credits_per_unit = %s, margin = %s "
                            "where unit = %s returning 1", [had[unit][0], had[unit][1], unit])
                else:
                    su.rows("delete from public.credit_prices where unit = %s returning 1", [unit])


def test_verify_query_reads_true(conn):
    text = (sec_db.MIGRATIONS / "0058_storyboard_edit.sql").read_text()
    block = text.split("-- Verify (run after applying; every column should read true)", 1)[1]
    lines = [ln[3:] if ln.startswith("-- ") else ln[2:] for ln in block.splitlines()
             if ln.startswith("--") and not ln.startswith("-- ─")]
    query = "\n".join(lines).strip().rstrip(";")
    with as_superuser(conn, commit=False) as s:
        row_ = s.rows(query)[0]
    assert all(row_), row_
