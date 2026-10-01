"""Migration 0057: a storyboard is read by its organization, decided only by
someone who may start runs there, and approved — and paid for — once.

What would break without these:

* another organization reads a tenant's scene plan, or approves / discards it
  (spending the victim's credits on a render they never asked for, or
  throwing away their plan);
* a member who may not start runs approves a render;
* a double press, a replay or two admins at once hold credits twice or queue
  two renders of one storyboard;
* an approval below the price of the storyboard's own length, or one that
  queues a render of another length than the one the hold priced;
* a refused approval (not enough credits) leaving a hold or a job behind;
* the content of an approved storyboard changing after it was paid for;
* a browser writing a storyboard row directly (an approved, "paid" one).

Isolation (read / update / delete / insert, row by row) is covered for this
table by test_sec_isolation.py through sec_expectations.TABLES.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager

import psycopg

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser
from sec_storyboard_0057 import STORYBOARD, insert

PRICES = {"video_minute": 12, "job_minimum": 5}  # 300 s = 60 credits


@contextmanager
def world(conn, *, prices=True):
    """A rolled-back world with the price list. Holds, jobs and decisions made
    inside disappear with it."""
    with as_superuser(conn, commit=False) as s:
        if prices:
            for unit, rate in PRICES.items():
                s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
                       "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 "
                       "returning 1", [unit, rate])
        yield s


def approve(s, sid, amount=60, backend="queue"):
    return s.run("select public.approve_storyboard(%s, %s, %s)", [sid, amount, backend])


def held_for(su, sid) -> list:
    """Every credit reservation ever made for this storyboard."""
    return su.rows("select job_id, amount, status from public.credit_reservations "
                   "where job_id like %s order by job_id", [f"%sb%-{sid.replace('-', '')}"])


def jobs_for(su, channel) -> int:
    return su.value("select count(*) from public.render_jobs where channel_id = %s and params ? 'resume'",
                    [channel])


def status_of(su, sid) -> str:
    return su.value("select status from public.storyboards where id = %s", [sid])


def owner(s):
    """The same transaction, read as the database owner: the ground truth an
    attack is checked against, before the rollback takes it away."""
    s.conn.execute("reset role")
    return s


# ── who may read ────────────────────────────────────────────────────────────

def test_another_org_cannot_read_a_storyboard(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        theirs = s.rows("select id from public.storyboards where id = %s", [STORYBOARD["a"]])
        mine = s.rows("select id from public.storyboards where id = %s", [STORYBOARD["b"]])
    with acting(conn, ANON) as s:
        anon = s.run("select id from public.storyboards")
    assert theirs == [], "Bob read Alice's storyboard"
    assert len(mine) == 1, "control: Bob cannot read his own storyboard"
    assert not anon.ok or anon.rows == [], anon


# ── who may decide ──────────────────────────────────────────────────────────

def test_another_org_cannot_approve_and_nothing_is_held(conn, sc):
    with world(conn) as su:
        with acting(conn, sc.bob.actor) as s:
            out = approve(s, STORYBOARD["a"])
            discard = s.run("select public.discard_storyboard(%s)", [STORYBOARD["a"]])
            undo = s.run("select public.storyboard_dispatch_failed(%s)", [STORYBOARD["a"]])
            assert held_for(owner(s), STORYBOARD["a"]) == []
            assert status_of(s, STORYBOARD["a"]) == "ready"
    for o in (out, discard, undo):
        assert not o.ok and o.sqlstate == "42501", o


def test_a_missing_storyboard_and_another_orgs_read_the_same(conn, sc):
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            theirs = approve(s, STORYBOARD["a"])
            missing = approve(s, "00000000-0000-4000-8000-000000000000")
    assert (theirs.sqlstate, theirs.error) == (missing.sqlstate, missing.error), (theirs, missing)


def test_a_member_who_may_not_start_runs_cannot_approve(conn, sc):
    # Ivan accepts his pending viewer invite into org A, in this transaction only.
    with world(conn) as su:
        with acting(conn, sc.invitee) as s:
            s.rows("select public.accept_org_invite(id) from public.my_invites() limit 1")
            can_read = s.rows("select id from public.storyboards where id = %s", [STORYBOARD["a"]])
            out = approve(s, STORYBOARD["a"])
            discard = s.run("select public.discard_storyboard(%s)", [STORYBOARD["a"]])
            assert held_for(owner(s), STORYBOARD["a"]) == []
    assert len(can_read) == 1, "control: a member of the organization reads its storyboard"
    assert not out.ok and out.sqlstate == "42501", out
    assert not discard.ok and discard.sqlstate == "42501", discard


def test_strangers_and_anon_cannot_decide(conn, sc):
    with world(conn):
        with acting(conn, sc.stranger) as s:
            stranger = approve(s, STORYBOARD["b"])
        with acting(conn, ANON) as s:
            anon = approve(s, STORYBOARD["b"])
    assert not stranger.ok and stranger.sqlstate == "42501", stranger
    assert not anon.ok and anon.sqlstate == "42501", anon


# ── the money ───────────────────────────────────────────────────────────────

def test_approve_holds_once_and_queues_the_render_at_the_priced_length(conn, sc):
    with world(conn) as su:
        with acting(conn, sc.bob.actor) as s:
            first = approve(s, STORYBOARD["b"])
            again = approve(s, STORYBOARD["b"])
            via_actions = approve(s, STORYBOARD["b"], backend="actions")
            su = owner(s)
            holds = held_for(su, STORYBOARD["b"])
            res = first.rows[0][0] if first.ok else {}
            job = su.rows("select params, credit_ref from public.render_jobs where id = %s",
                          [res.get("render_job_id")]) if first.ok else []
            jobs = jobs_for(su, sc.bob.channel)
            status = status_of(su, STORYBOARD["b"])
        assert first.ok, f"control: Bob cannot approve his own storyboard: {first!r}"
        assert not again.ok and again.sqlstate == "NS409", again
        assert not via_actions.ok and via_actions.sqlstate == "NS409", via_actions
        assert [(h[1], h[2]) for h in holds] == [(60, "open")], holds
        assert res["credit_ref"] == holds[0][0] and res["credit_ref"].startswith("rj-")
        params, ref = job[0]
        assert params == {"topic": "A topic", "duration": 300, "resume": True}
        assert ref == res["credit_ref"]
        assert jobs == 1
        assert status == "approved"


def test_two_admins_pressing_at_once_hold_once(conn, sc):
    """Two sessions approve the same storyboard concurrently: one wins, the
    other waits on the row lock and is refused before anything is held. Two
    real sessions must commit, so this test puts the world back itself."""
    with as_superuser(conn) as su:
        had = {r[0]: (r[1], r[2]) for r in su.rows(
            "select unit, credits_per_unit, margin from public.credit_prices where unit = any(%s)",
            [list(PRICES)])}
        for unit, rate in PRICES.items():
            su.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
                    "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 "
                    "returning 1", [unit, rate])
        with acting(conn, SERVICE, commit=True) as s:
            sid = str(insert(s, sc.bob.channel, "race-b").rows[0][0])
    dsn = conn.info.dsn
    barrier = threading.Barrier(2)
    results = []

    def press():
        with psycopg.connect(dsn, autocommit=True) as c:
            with acting(c, sc.bob.actor, commit=True) as s:
                barrier.wait()
                results.append(approve(s, sid))

    threads = [threading.Thread(target=press) for _ in range(2)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert sorted(r.ok for r in results) == [False, True], results
        loser = next(r for r in results if not r.ok)
        assert loser.sqlstate == "NS409", loser
        with as_superuser(conn, commit=False) as su:
            assert len(held_for(su, sid)) == 1
            assert su.value("select count(*) from public.render_jobs where credit_ref like %s",
                            [f"%-{sid.replace('-', '')}"]) == 1
    finally:
        with as_superuser(conn) as su:
            ref = su.value("select credit_ref from public.storyboards where id = %s", [sid])
            if ref:
                su.rows("delete from public.render_jobs where credit_ref = %s returning 1", [ref])
                su.value("select public.release_credits(%s)", [ref])
            su.rows("delete from public.storyboards where id = %s returning 1", [sid])
            for unit in PRICES:
                if unit in had:
                    su.rows("update public.credit_prices set credits_per_unit = %s, margin = %s "
                            "where unit = %s returning 1", [had[unit][0], had[unit][1], unit])
                else:
                    su.rows("delete from public.credit_prices where unit = %s returning 1", [unit])


def test_an_approval_below_the_storyboards_price_is_refused_and_holds_nothing(conn, sc):
    with world(conn) as su:
        with acting(conn, sc.bob.actor) as s:
            low = approve(s, STORYBOARD["b"], amount=10)
            unpaid = approve(s, STORYBOARD["b"], amount=None)
            assert held_for(owner(s), STORYBOARD["b"]) == []
            assert jobs_for(s, sc.bob.channel) == 0
            assert status_of(s, STORYBOARD["b"]) == "ready"
    assert not low.ok and low.sqlstate == "22023", low
    assert not unpaid.ok and unpaid.sqlstate == "22023", unpaid


def test_not_enough_credits_leaves_no_hold_no_job_and_the_storyboard_waiting(conn, sc):
    with world(conn) as su:
        with acting(conn, sc.bob.actor) as s:
            out = approve(s, STORYBOARD["b"], amount=10_000_000)
            assert held_for(owner(s), STORYBOARD["b"]) == []
            assert jobs_for(s, sc.bob.channel) == 0
            assert status_of(s, STORYBOARD["b"]) == "ready"
    assert not out.ok and out.sqlstate == "NS402", out


def test_an_unknown_backend_is_refused(conn, sc):
    with world(conn) as su:
        with acting(conn, sc.bob.actor) as s:
            out = approve(s, STORYBOARD["b"], backend="shell")
            assert held_for(owner(s), STORYBOARD["b"]) == []
    assert not out.ok and out.sqlstate == "22023", out


def test_the_operators_own_org_approves_without_a_hold(conn, sc):
    with world(conn):
        with acting(conn, SERVICE) as s:
            sid = str(insert(s, "default", "operator-plan").rows[0][0])
            s.conn.execute("reset role")
            s.conn.execute("select set_config('request.jwt.claims', %s, true)",
                           [json.dumps(sc.operator.claims())])
            s.conn.execute("set local role authenticated")
            out = approve(s, sid, amount=None)
    assert out.ok, out
    res = out.rows[0][0]
    assert res["credit_ref"] is None and res["render_job_id"], res


# ── discard and the Actions undo ────────────────────────────────────────────

def test_discard_ends_it_and_nothing_can_approve_it_afterwards(conn, sc):
    with world(conn) as su:
        with acting(conn, sc.bob.actor) as s:
            d = s.run("select public.discard_storyboard(%s)", [STORYBOARD["b"]])
            after = approve(s, STORYBOARD["b"])
            twice = s.run("select public.discard_storyboard(%s)", [STORYBOARD["b"]])
            assert held_for(owner(s), STORYBOARD["b"]) == []
            assert status_of(s, STORYBOARD["b"]) == "discarded"
    assert d.ok, d
    assert not after.ok and after.sqlstate == "NS409", after
    assert not twice.ok and twice.sqlstate == "NS409", twice


def test_a_failed_actions_dispatch_releases_its_hold_and_waits_again(conn, sc):
    with world(conn) as su:
        with acting(conn, sc.bob.actor) as s:
            first = approve(s, STORYBOARD["b"], backend="actions")
            assert first.ok, first
            undo = s.run("select public.storyboard_dispatch_failed(%s)", [STORYBOARD["b"]])
            second = approve(s, STORYBOARD["b"], backend="actions")
            holds = held_for(owner(s), STORYBOARD["b"])
    assert undo.ok and undo.rows[0][0]["released"] == 60, undo
    assert second.ok, second
    # One released, one open: never two open holds for one storyboard.
    assert sorted(h[2] for h in holds) == ["open", "released"], holds
    assert first.rows[0][0]["render_job_id"] is None  # Actions: the route dispatches


def test_the_actions_undo_is_refused_once_the_render_claimed_its_hold(conn, sc):
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            first = approve(s, STORYBOARD["b"], backend="actions")
            ref = first.rows[0][0]["credit_ref"]
            s.conn.execute("reset role")
            s.conn.execute("select set_config('request.jwt.claims', '', true)")
            s.value("select public.start_credit_reservation(%s, %s)", [ref, sc.bob.org])
            s.conn.execute("select set_config('request.jwt.claims', %s, true)",
                           [json.dumps(sc.bob.actor.claims())])
            s.conn.execute("set local role authenticated")
            undo = s.run("select public.storyboard_dispatch_failed(%s)", [STORYBOARD["b"]])
    assert not undo.ok and undo.sqlstate == "22023", undo


# ── nothing is written around the functions ─────────────────────────────────

def test_a_browser_cannot_write_a_storyboard(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        ins = insert(s, sc.bob.channel, "forged")
        upd = s.run("update public.storyboards set status = 'approved' where id = %s", [STORYBOARD["b"]])
    assert not ins.ok and ins.sqlstate == "42501", ins
    assert not upd.ok or upd.rowcount == 0, upd


def test_the_pipeline_cannot_insert_a_storyboard_that_is_already_decided(conn, sc):
    with acting(conn, SERVICE) as s:
        out = s.run(
            "insert into public.storyboards (channel_id, slug, topic, scenes, script, duration_s, status) "
            "values (%s, 'paid', 't', %s::jsonb, '{}'::jsonb, 300, 'approved') returning id",
            [sc.bob.channel, json.dumps([{"n": 1, "narration": "x", "visual": "y", "duration_s": 300}])])
    assert not out.ok and out.sqlstate in ("42501", "42703"), out


def test_an_approved_storyboard_cannot_change_what_was_paid_for(conn, sc):
    with world(conn):
        with acting(conn, sc.bob.actor) as s:
            assert approve(s, STORYBOARD["b"]).ok
            # Even the owner, and even the service key: what was paid for is fixed.
            su = owner(s)
            for col, val in (("duration_s", 3600), ("scenes", json.dumps([{"n": 1, "narration": "x",
                                                                            "visual": "y", "duration_s": 5}])),
                             ("topic", "Something else")):
                out = su.run(f"update public.storyboards set {col} = %s where id = %s", [val, STORYBOARD["b"]])
                assert not out.ok and out.sqlstate == "42501", (col, out)
            back = su.run("update public.storyboards set status = 'discarded' where id = %s", [STORYBOARD["b"]])
            assert not back.ok and back.sqlstate == "42501", back


def test_scene_cards_are_bounded_for_every_writer(conn, sc):
    bad = [
        [],
        [{"n": 1, "narration": "x" * 4001, "visual": "y", "duration_s": 10}],
        [{"n": 1, "narration": "x", "visual": "y", "duration_s": 601}],
        [{"n": 1, "narration": "x", "visual": "y", "duration_s": 10, "html": "<script>"}],
        [{"n": i + 1, "narration": "x", "visual": "y", "duration_s": 10} for i in range(61)],
    ]
    with acting(conn, SERVICE) as s:
        outs = [s.run("insert into public.storyboards (channel_id, slug, topic, scenes, script, duration_s) "
                      "values (%s, %s, 't', %s::jsonb, '{}'::jsonb, 300) returning id",
                      [sc.bob.channel, f"bad-{i}", json.dumps(b)]) for i, b in enumerate(bad)]
    assert all(not o.ok and o.sqlstate == "23514" for o in outs), outs


def test_verify_query_reads_true(conn):
    text = (sec_db.MIGRATIONS / "0057_storyboard_review.sql").read_text()
    block = text.split("-- Verify (run after applying; every column should read true)", 1)[1]
    lines = [ln[3:] if ln.startswith("-- ") else ln[2:] for ln in block.splitlines()
             if ln.startswith("--") and not ln.startswith("-- ─")]
    query = "\n".join(lines).strip().rstrip(";")
    with as_superuser(conn, commit=False) as s:
        row = s.rows(query)[0]
    assert all(row), row
