"""Migration 0080: repurposing a master into clips is priced, confirmed, paid for
only for the clips that were made, and decided only by someone who may start runs.

What would break without these:

* another organization quotes, or presses (and pays with the victim's credits)
  for clips of a tenant's video; a missing video and another organization's
  read differently (an oracle);
* a member who may only read the channel starts a paid request;
* a replayed idempotency key holds twice, or a reused key quietly runs a
  different request;
* the price changes between the quote and the press and the new price is held
  anyway; a press without a price spends; an unset price reads as 0 and runs
  for free;
* a window the browser names crosses a scene (and so a word), is too short or
  too long for a Short, overlaps another clip or runs past the audio;
* a clip is made from a clip, from a video the gate blocked, a reviewer
  rejected, or from a master known to be a 480p review copy;
* a failed clip is charged, a request that made nothing keeps the hold, a
  partial request is charged for the clips it did not make, or the capture
  goes above the hold;
* two presses at once hold twice;
* a made clip is published, public, or past the gate: it must be a held,
  private row with no gate verdict, which no cross-post accepts;
* the worker's functions are reachable from a browser, a stale worker settles a
  request another worker took over, or the worker names the clip's id or path.

Isolation of repurpose_requests / repurpose_clips (read / update / delete /
insert, row by row) is covered by test_sec_isolation.py through
sec_expectations.TABLES.
"""

from __future__ import annotations

import json
import threading
import uuid
from contextlib import contextmanager

import psycopg
from psycopg import sql

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser
from sec_repurpose_0080 import held_id, manifest_json
from sec_scenario import DEFAULT_ORG

# One clip: 4, floored to 5. Two clips 8, three 12. job_minimum is the floor.
PRICES = {"repurpose_clip": 4, "job_minimum": 5}
ONE, TWO, THREE = 5, 8, 12

# Scene times (sec_repurpose_0080.manifest): s000 0-20, s001 20-25, s002 25-33,
# s003 33-45, s004 45-70, s005 70-80, s006 80-110, s007 110-125, s008 125-143,
# s009 143-150. These windows are valid:
A = {"first": "s000", "last": "s000"}   # 20 s
B = {"first": "s001", "last": "s003"}   # 25 s (20..45)
C = {"first": "s004", "last": "s004"}   # 25 s
D = {"first": "s006", "last": "s006"}   # 30 s
E = {"first": "s007", "last": "s008"}   # 33 s


def cj(*clips):
    return json.dumps(list(clips))


def owner(s):
    """The same transaction, read as the database owner: the ground truth an
    attack is checked against, before the rollback takes it away."""
    s.conn.execute("reset role")
    return s


def become(s, who):
    """The same transaction, continued as another API caller (the worker's
    service key after the person's press), so the whole story rolls back
    together."""
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    s.conn.execute(sql.SQL("set local role {}").format(sql.Identifier(who.role)))
    return s


def _set_prices(su, prices):
    for unit, rate in prices.items():
        su.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, 0) "
                "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit, margin = 0 "
                "returning 1", [unit, rate])


def _master(su, t, slug, *, audio_s=150.0, **cols):
    """A held master of tenant ``t`` with its Video IR and its file recorded."""
    vid = cols.pop("video_id", None) or held_id(t.channel, slug)
    row = {"video_id": vid, "channel_id": t.channel, "title": "The master", "topic": "a topic",
           "slug": cols.pop("db_slug", slug),
           "review_state": "pending", "publish_state": "held", "local_path": f"output/{slug}/final_video.mp4"}
    row.update(cols)
    names = list(row)
    su.rows(f"insert into public.videos ({', '.join(names)}, manifest) values "
            f"({', '.join(['%s'] * len(names))}, %s::jsonb) returning 1",
            [row[n] for n in names] + [manifest_json(audio_s=audio_s)])
    return vid


@contextmanager
def world(conn, t, *, prices=PRICES, slug=None, **kw):
    """A rolled-back world with the price list and one master of tenant ``t``.
    Everything made inside disappears with it."""
    with as_superuser(conn, commit=False) as su:
        if prices:
            _set_prices(su, prices)
        vid = _master(su, t, slug or f"master-{t.key}", **kw)
        yield su, vid


def quote(s, vid, clips=None):
    return s.run("select public.quote_repurpose(%s, %s::jsonb)", [vid, clips or cj(A)])


def press(s, vid, clips=None, *, max_credits=ONE, key=None):
    return s.run("select public.request_repurpose(%s, %s::jsonb, %s::numeric, %s)",
                 [vid, clips or cj(A), max_credits, key or f"press-{uuid.uuid4().hex}"])


def holds(su, org, *, fresh=True) -> list:
    return su.rows("select job_id, amount, status, captured from public.credit_reservations "
                   "where org_id = %s and job_id like 'rp-%%' "
                   + ("and created_at >= now() " if fresh else "") + "order by created_at", [org])


def requests(su, vid) -> list:
    return su.rows("select id, status, clip_count, unit_credits, floor_credits, quoted_credits, credit_ref, "
                   "charged_credits, error_code from public.repurpose_requests where video_id = %s "
                   "order by created_at", [vid])


def clips_of(su, rid) -> list:
    return su.rows("select ordinal, first_scene, last_scene, scene_ids, start_s, end_s, duration_s, status, "
                   "clip_video_id, local_path, error_code from public.repurpose_clips where request_id = %s "
                   "order by ordinal", [rid])


def available(su, org):
    return su.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])


def info(n=1, **kw):
    out = {"sha256": "ab" * 32, "bytes": 1234567, "width": 1080, "height": 1920,
           "title": f"The master - clip {n}",
           "captions": {"youtube": {"title": "T", "description": "D", "tags": []},
                        "instagram": "caption", "tiktok": "caption"}}
    out.update(kw)
    return json.dumps(out)


def record(s, rid, pos, *, ok=True, worker="w1", payload=None):
    return s.run("select public.record_repurpose_clip(%s, %s, %s, %s, %s::jsonb)",
                 [rid, worker, pos, ok, payload if payload is not None else (info(pos) if ok else
                  json.dumps({"error_code": "ffmpeg_failed", "error": "the cut did not finish"}))])


def finish(s, rid, worker="w1"):
    return s.run("select public.finish_repurpose_request(%s, %s)", [rid, worker])


def _accept_invite(s):
    s.rows("select public.accept_org_invite(id) from public.my_invites() limit 1")


def _pressed(s, vid, clips=None, **kw):
    out = press(s, vid, clips, **kw)
    assert out.ok, out
    return out.rows[0][0]


# ── who may ─────────────────────────────────────────────────────────────────

def test_another_org_can_neither_quote_nor_press_and_nothing_is_held(conn, sc):
    with world(conn, sc.alice) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid)
            p = press(s, vid)
            o = owner(s)
            assert holds(o, sc.alice.org) == [] and holds(o, sc.bob.org) == []
            assert requests(o, vid) == []
    assert not q.ok and q.sqlstate == "42501", q
    assert not p.ok and p.sqlstate == "42501", p


def test_a_missing_video_and_another_orgs_read_the_same(conn, sc):
    with world(conn, sc.alice) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            theirs, missing = press(s, vid), press(s, "run-00000000000000000000")
            tq, mq = quote(s, vid), quote(s, "run-00000000000000000000")
    assert (theirs.sqlstate, theirs.error) == (missing.sqlstate, missing.error), (theirs, missing)
    assert (tq.sqlstate, tq.error) == (mq.sqlstate, mq.error), (tq, mq)


def test_a_member_who_may_only_read_sees_the_price_but_cannot_press(conn, sc):
    # Ivan accepts his pending viewer invite into org A, in this transaction only.
    with world(conn, sc.alice) as (su, vid):
        with acting(conn, sc.invitee) as s:
            _accept_invite(s)
            q = quote(s, vid)
            p = press(s, vid)
            assert holds(owner(s), sc.alice.org) == []
    assert q.ok, q
    body = q.rows[0][0]
    assert body["status"] == "priced" and float(body["credits"]) == ONE and body["may_start"] is False, body
    assert not p.ok and p.sqlstate == "42501", p


def test_strangers_and_anon_cannot_quote_or_press(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.stranger) as s:
            sq, sp = quote(s, vid), press(s, vid)
        with acting(conn, ANON) as s:
            aq, ap = quote(s, vid), press(s, vid)
    for o in (sq, sp, aq, ap):
        assert not o.ok and o.sqlstate == "42501", o


def test_the_worker_functions_are_not_the_browsers(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid)
            rid = body["id"]
            outs = [
                s.run("select public.claim_repurpose_request('w1')"),
                s.run("select public.heartbeat_repurpose(%s, 'w1')", [rid]),
                record(s, rid, 1),
                finish(s, rid),
                s.run("select public.expire_repurpose_requests()"),
                s.run("select public.repurpose_settle(%s, 'x', 'y')", [rid]),
                s.run("select public.repurpose_plan('{}'::jsonb, '[]'::jsonb)"),
            ]
            write = s.run("update public.repurpose_requests set status = 'succeeded' where id = %s", [rid])
            ins = s.run("insert into public.repurpose_clips (request_id, org_id, channel_id, master_id, ordinal, "
                        "first_scene, last_scene, scene_ids, start_s, end_s, duration_s) values "
                        "(%s, %s, %s, %s, 2, 's000', 's000', '{s000}', 0, 20, 20)",
                        [rid, sc.bob.org, sc.bob.channel, vid])
    for o in outs:
        assert not o.ok and o.sqlstate == "42501", o
    assert not write.ok or write.rowcount == 0, write
    assert not ins.ok, ins


# ── the money ───────────────────────────────────────────────────────────────

def test_the_press_holds_exactly_the_quote_and_makes_one_row_per_clip_and_no_render_job(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        before = available(su, sc.bob.org)
        jobs_before = su.value("select count(*) from public.render_jobs")
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid, cj(A, C))
            p = press(s, vid, cj(A, C), max_credits=TWO)
            o = owner(s)
            h, r = holds(o, sc.bob.org), requests(o, vid)
            k = clips_of(o, r[0][0])
            after = available(o, sc.bob.org)
            jobs_after = o.value("select count(*) from public.render_jobs")
    body = q.rows[0][0]
    assert q.ok and float(body["credits"]) == TWO and float(body["clip_credits"]) == 4, body
    # What a member reads over PostgREST is what is charged: no unit name, no
    # margin, no base rate.
    assert not {"unit", "unit_credits", "floor_credits", "margin", "missing_unit"} & set(body), body
    assert "repurpose_clip" not in json.dumps(body), body
    assert p.ok and p.rows[0][0]["replayed"] is False, p
    assert len(h) == 1 and float(h[0][1]) == TWO and h[0][2] == "open", h
    assert float(before) - float(after) == TWO
    assert len(r) == 1
    _, status, count, unit, floor, quoted, ref, charged, code = r[0]
    assert (status, count, float(unit), float(floor), float(quoted)) == ("queued", 2, 4.0, 5.0, TWO)
    assert ref == h[0][0] and charged is None and code is None
    # The windows are the database's, derived from the Video IR's scene times.
    assert [(c[0], c[1], c[2], float(c[4]), float(c[5]), float(c[6]), c[7]) for c in k] == [
        (1, "s000", "s000", 0.0, 20.0, 20.0, "queued"), (2, "s004", "s004", 45.0, 70.0, 25.0, "queued")], k
    assert k[0][3] == ["s000"]
    # Clips are cut by the worker between render jobs: the queue is not touched.
    assert jobs_before == jobs_after


def test_a_replayed_key_returns_the_same_row_and_holds_once(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            a = press(s, vid, key="same-key-123")
            b = press(s, vid, key="same-key-123")
            # The same key for a different request is refused, not run.
            c = press(s, vid, cj(C), key="same-key-123")
            o = owner(s)
            h, r = holds(o, sc.bob.org), requests(o, vid)
    assert a.ok and b.ok, (a, b)
    assert a.rows[0][0]["id"] == b.rows[0][0]["id"] and b.rows[0][0]["replayed"] is True
    assert not c.ok and c.sqlstate == "NS409" and "idempotency_conflict" in c.error, c
    assert len(h) == 1 and len(r) == 1


def test_a_changed_price_is_refused_and_nothing_is_held(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            seen = float(quote(s, vid, cj(A, C)).rows[0][0]["credits"])
        # The owner raises the price after the person saw it.
        _set_prices(su, {"repurpose_clip": 9})
        with acting(conn, sc.bob.actor) as s:
            changed = press(s, vid, cj(A, C), max_credits=seen)
            no_price = press(s, vid, cj(A, C), max_credits=None)
            o = owner(s)
            assert holds(o, sc.bob.org) == [] and requests(o, vid) == []
    assert seen == TWO
    assert not changed.ok and changed.sqlstate == "NS409" and "price_changed" in changed.error, changed
    assert not no_price.ok and no_price.sqlstate == "22023" and "price_required" in no_price.error


def test_an_unset_price_is_unpriced_never_zero_and_cannot_be_pressed(conn, sc):
    with as_superuser(conn, commit=False) as su:
        su.rows("delete from public.credit_prices where unit = 'repurpose_clip' returning 1")
        _set_prices(su, {"job_minimum": 5})
        vid = _master(su, sc.bob, "master-unpriced")
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid)
            p = press(s, vid, max_credits=1000)
            assert holds(owner(s), sc.bob.org) == []
    body = q.rows[0][0]
    assert body["status"] == "unpriced" and body["credits"] is None, body
    assert "repurpose_clip" not in json.dumps(body), body
    assert not p.ok and p.sqlstate == "NS400" and "unpriced" in p.error, p
    assert "repurpose_clip" not in str(p.error), p


def test_a_zero_rate_is_unpriced_too(conn, sc):
    with world(conn, sc.bob, prices={"repurpose_clip": 0, "job_minimum": 0}) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid)
            p = press(s, vid, max_credits=1000)
            assert holds(owner(s), sc.bob.org) == []
    assert q.rows[0][0]["status"] == "unpriced" and q.rows[0][0]["credits"] is None
    assert not p.ok and "unpriced" in p.error, p


def test_insufficient_credits_refuse_the_press_and_hold_nothing(conn, sc):
    with world(conn, sc.bob, prices={"repurpose_clip": 1000000, "job_minimum": 5}) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            p = press(s, vid, cj(A, C), max_credits=2000000)
            o = owner(s)
            assert holds(o, sc.bob.org) == [] and requests(o, vid) == []
    assert not p.ok and p.sqlstate == "NS402", p


def test_the_plans_parallel_runs_apply_to_a_second_request_and_nothing_is_held(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        other = _master(su, sc.bob, "master-second")
        limit = su.value("select coalesce(public.entitlement_int_internal(%s, 'concurrency'), 1)", [sc.bob.org])
        # All but one of the plan's slots are taken by other runs' holds.
        active = su.value("select count(*) from public.credit_reservations where org_id = %s and status = 'open'",
                          [sc.bob.org])
        for n in range(limit - active - 1):
            su.value("select public.reserve_credits(%s, %s, 5)", [sc.bob.org, f"rj-fill-{n}-{uuid.uuid4().hex[:8]}"])
        with acting(conn, sc.bob.actor) as s:
            first = press(s, vid)
            second = press(s, other)
            o = owner(s)
            h = holds(o, sc.bob.org)
            r = requests(o, other)
    assert first.ok, first
    # The hold is an open credit hold like any run's: at the plan's limit a
    # further request is refused (NS429) before a hold or a row exists.
    assert not second.ok and second.sqlstate == "NS429", second
    assert [x[0] for x in h if x[0].startswith("rp-")] == [first.rows[0][0]["credit_ref"]] and r == [], (h, r)


def test_a_member_who_may_only_read_cannot_press_in_the_operators_organization_either(conn, sc):
    """The operator's own organization holds no credits, so reserve_credits is
    never asked there: the press must check who is asking by itself."""
    with as_superuser(conn, commit=False) as su:
        _set_prices(su, PRICES)
        vid = _master(su, type("T", (), {"channel": "default", "key": "op"})(), "master-operator-2")
        with acting(conn, sc.dana) as s:       # Dana: a plain member of the operator's organization
            q = quote(s, vid)
            p = press(s, vid, max_credits=None)
            assert requests(owner(s), vid) == []
        with acting(conn, sc.operator) as s:
            ok = press(s, vid, max_credits=None)
    assert q.ok and q.rows[0][0]["may_start"] is False, q
    assert not p.ok and p.sqlstate == "42501", p
    assert ok.ok, ok


def test_one_active_request_per_video_is_a_database_rule_not_only_a_check(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        def row(key):
            return su.run("insert into public.repurpose_requests (org_id, channel_id, video_id, slug, clip_count, "
                          "idempotency_key, request_hash) values (%s, %s, %s, 'master-x', 1, %s, %s)",
                          [sc.bob.org, sc.bob.channel, vid, key, "0" * 32])
        first, second = row("key-aaaaaaaaaa"), row("key-bbbbbbbbbb")
        su.rows("update public.repurpose_requests set status = 'failed', finished_at = now() where idempotency_key = "
                "'key-aaaaaaaaaa' returning 1")
        third = row("key-cccccccccc")
    assert first.ok and not second.ok and second.sqlstate == "23505", second
    assert third.ok, third


def test_the_operators_own_organization_holds_nothing(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _set_prices(su, PRICES)
        vid = _master(su, type("T", (), {"channel": "default", "key": "op"})(), "master-operator")
        with acting(conn, sc.operator) as s:
            q = quote(s, vid)
            p = press(s, vid, max_credits=None)
            o = owner(s)
            r = requests(o, vid)
            h = holds(o, DEFAULT_ORG)
    assert q.rows[0][0]["status"] == "included" and q.rows[0][0]["credits"] is None, q
    assert p.ok, p
    # Not "0 credits": no quote, no hold, no charge.
    assert r[0][5] is None and r[0][6] is None and r[0][7] is None and h == [], (r, h)


# ── the windows ─────────────────────────────────────────────────────────────

def test_a_window_is_whole_scenes_and_the_database_derives_its_times(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid, cj(B, E))
    body = q.rows[0][0]
    assert body["status"] == "priced", body
    got = [(c["first"], c["last"], c["scene_ids"], c["start_s"], c["end_s"], c["duration_s"]) for c in body["clips"]]
    # B is s001..s003: from the END of s000 (20 s) to the end of s003 (45 s).
    assert got == [("s001", "s003", ["s001", "s002", "s003"], 20.0, 45.0, 25.0),
                   ("s007", "s008", ["s007", "s008"], 110.0, 143.0, 33.0)], got


def test_bad_windows_are_unavailable_with_the_reason_and_hold_nothing(conn, sc):
    cases = {
        "clip_too_short": cj({"first": "s001", "last": "s002"}),             # 13 s
        "clip_too_long": cj({"first": "s004", "last": "s006"}),              # 65 s
        "invalid_range": cj({"first": "s003", "last": "s001"}),
        "scene_not_found": cj({"first": "s000", "last": "s077"}),
        "clips_overlap": cj({"first": "s000", "last": "s000"}, {"first": "s000", "last": "s003"}),
    }
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            outs = {k: (quote(s, vid, v), press(s, vid, v, max_credits=1000)) for k, v in cases.items()}
            assert holds(owner(s), sc.bob.org) == []
    for reason, (q, p) in outs.items():
        body = q.rows[0][0]
        assert body["status"] == "unavailable" and body["reason"] == reason, (reason, body)
        assert not p.ok and p.sqlstate == "NS400" and "clips_unavailable" in p.error, (reason, p)


def test_a_window_of_more_than_twelve_scenes_is_refused(conn, sc):
    scenes = [{"id": f"s{i:03d}", "index": i, "start_s": i * 4.0, "end_s": i * 4.0 + 4.0} for i in range(16)]
    with world(conn, sc.bob) as (su, vid):
        su.rows("update public.videos set manifest = %s::jsonb where video_id = %s returning 1",
                [json.dumps({"scenes": scenes, "audio": {"duration_s": 64}}), vid])
        with acting(conn, sc.bob.actor) as s:
            many = quote(s, vid, cj({"first": "s000", "last": "s012"}))     # 13 scenes, 52 s
            twelve = quote(s, vid, cj({"first": "s000", "last": "s011"}))   # 12 scenes, 48 s
    assert many.rows[0][0]["status"] == "unavailable" and many.rows[0][0]["reason"] == "too_many_scenes", many
    assert twelve.rows[0][0]["status"] == "priced", twelve


def test_a_window_past_the_audio_is_refused(conn, sc):
    with world(conn, sc.bob, audio_s=140.0) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid, cj(E))
    assert q.rows[0][0]["status"] == "unavailable" and q.rows[0][0]["reason"] == "beyond_audio", q


def test_a_scene_without_real_times_cannot_be_part_of_a_window(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        su.rows("update public.videos set manifest = jsonb_set(manifest, '{scenes,3,end_s}', 'null') "
                "where video_id = %s returning 1", [vid])
        with acting(conn, sc.bob.actor) as s:
            across = quote(s, vid, cj(B))
            apart = quote(s, vid, cj(A))
    assert across.rows[0][0]["status"] == "unavailable" and across.rows[0][0]["reason"] == "scene_timing_unknown"
    assert apart.rows[0][0]["status"] == "priced", apart


def test_malformed_clips_are_refused_before_anything_is_held(conn, sc):
    bad = ["{}", "[]", json.dumps([A] * 6), json.dumps(["s000"]), json.dumps([{"first": "s000"}]),
           json.dumps([{"first": 1, "last": 2}]), json.dumps([{"first": "0; drop", "last": "s001"}]), "null"]
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            outs = [press(s, vid, b) for b in bad]
            assert holds(owner(s), sc.bob.org) == []
        with acting(conn, sc.bob.actor) as s:
            key = press(s, vid, key="short")
    for o in outs:
        assert not o.ok and o.sqlstate == "22023" and "invalid_clips" in o.error, o
    assert not key.ok and key.sqlstate == "22023" and "invalid_idempotency_key" in key.error, key


# ── the master ──────────────────────────────────────────────────────────────

def test_a_published_master_is_repurposed_without_changing_it(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _set_prices(su, PRICES)
        vid = _master(su, sc.bob, "master-live", video_id="dQw4w9WgXcQ", published_at="2026-09-01T00:00:00Z",
                      privacy="public", publish_state="uploaded", review_state="approved")
        with acting(conn, sc.bob.actor) as s:
            q, p = quote(s, vid), press(s, vid)
            o = owner(s)
            row = o.rows("select privacy, published_at, review_state, publish_state from public.videos "
                         "where video_id = %s", [vid])[0]
    assert q.rows[0][0]["status"] == "priced" and p.ok, (q, p)
    assert row == ("public", "2026-09-01T00:00:00Z", "approved", "uploaded"), row


def test_a_master_that_cannot_be_cut_is_unavailable_with_the_reason(conn, sc):
    cases = {
        "gate_blocked": dict(publish_state="blocked"),
        "rejected": dict(review_state="rejected"),
        "no_master": dict(local_path=None),
        "no_run": dict(db_slug="Bad Slug!"),
        "is_a_clip": dict(video_format="short", parent_video_id="somebody"),
    }
    got = {}
    for reason, cols in cases.items():
        with world(conn, sc.bob, slug=f"master-{reason.replace('_', '-')}", **cols) as (su, vid):
            with acting(conn, sc.bob.actor) as s:
                got[reason] = (quote(s, vid), press(s, vid, max_credits=1000))
                assert holds(owner(s), sc.bob.org) == []
    for reason, (q, p) in got.items():
        body = q.rows[0][0]
        assert body["status"] == "unavailable" and body["reason"] == reason, (reason, body)
        assert not p.ok and p.sqlstate == "NS400" and "clips_unavailable" in p.error, (reason, p)


def test_a_run_without_its_video_ir_is_unavailable(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        su.rows("update public.videos set manifest = null where video_id = %s returning 1", [vid])
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid)
    assert q.rows[0][0]["status"] == "unavailable" and q.rows[0][0]["reason"] == "no_manifest", q


def test_a_master_recorded_as_a_480p_review_copy_is_never_a_source(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        ok = None
        with acting(conn, sc.bob.actor) as s:
            ok = quote(s, vid)
        su.rows("insert into public.download_masters (video_id, org_id, width, height, duration_seconds, bytes) "
                "values (%s, %s, 854, 480, 150, 1000) returning 1", [vid, sc.bob.org])
        with acting(conn, sc.bob.actor) as s:
            small = quote(s, vid)
            p = press(s, vid, max_credits=1000)
        su.rows("update public.download_masters set width = 1920, height = 1080 where video_id = %s returning 1", [vid])
        with acting(conn, sc.bob.actor) as s:
            hd = quote(s, vid)
    assert ok.rows[0][0]["status"] == "priced", ok
    assert small.rows[0][0]["status"] == "unavailable" and small.rows[0][0]["reason"] == "master_too_small", small
    assert not p.ok and "clips_unavailable" in p.error, p
    assert hd.rows[0][0]["status"] == "priced", hd


def test_a_master_whose_scene_is_being_regenerated_is_unavailable_until_it_ends(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        row = su.value(
            "insert into public.scene_regenerations (org_id, channel_id, video_id, slug, scene_id, requested_source, "
            "source_kind, stock_assets, previous_asset_ids, idempotency_key, request_hash) values "
            "(%s, %s, %s, %s, 's001', 'same', 'stock', 2, '{a_1,a_2}', 'regen-key-12345', %s) returning id",
            [sc.bob.org, sc.bob.channel, vid, f"master-{sc.bob.key}", "0" * 32])
        with acting(conn, sc.bob.actor) as s:
            busy_q, busy_p = quote(s, vid), press(s, vid, max_credits=1000)
            assert holds(owner(s), sc.bob.org) == []
        su.rows("update public.scene_regenerations set status = 'failed', finished_at = now() where id = %s "
                "returning 1", [row])
        with acting(conn, sc.bob.actor) as s:
            done_q = quote(s, vid)
    assert busy_q.rows[0][0]["status"] == "unavailable" and busy_q.rows[0][0]["reason"] == "master_changing", busy_q
    assert not busy_p.ok and busy_p.sqlstate == "NS400" and "clips_unavailable" in busy_p.error, busy_p
    assert done_q.rows[0][0]["status"] == "priced", done_q


def _made_clips(su, sc, vid, n, *, tag="a"):
    """n clips already made from the master (rows only the database owner could write)."""
    left, k = n, 0
    while left > 0:
        k += 1
        rid = su.value("insert into public.repurpose_requests (org_id, channel_id, video_id, slug, clip_count, status, "
                       "finished_at, idempotency_key, request_hash) values (%s, %s, %s, 'master-x', %s, 'succeeded', "
                       "now(), %s, %s) returning id",
                       [sc.bob.org, sc.bob.channel, vid, min(left, 5), f"made-{tag}-{k}-1234", "0" * 32])
        for o in range(1, min(left, 5) + 1):
            su.rows("insert into public.repurpose_clips (request_id, org_id, channel_id, master_id, ordinal, "
                    "first_scene, last_scene, scene_ids, start_s, end_s, duration_s, status, finished_at, "
                    "clip_video_id, local_path, width, height, bytes, sha256) values "
                    "(%s, %s, %s, %s, %s, 's000', 's000', '{s000}', 0, 20, 20, 'rendered', now(), %s, %s, 1080, 1920, "
                    "1000, %s) returning 1",
                    [rid, sc.bob.org, sc.bob.channel, vid, o, f"run-{tag}{k:02d}{o:02d}{uuid.uuid4().hex[:12]}",
                     f"output/master-x/repurpose/{k:08x}/clip-{o:02d}.mp4", "ab" * 32])
        left -= min(left, 5)


def test_a_master_keeps_at_most_twenty_clips(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        _made_clips(su, sc, vid, 19)
        with acting(conn, sc.bob.actor) as s:
            nineteen = quote(s, vid)
        _made_clips(su, sc, vid, 1, tag="b")
        with acting(conn, sc.bob.actor) as s:
            twenty_q, twenty_p = quote(s, vid), press(s, vid, max_credits=1000)
            assert holds(owner(s), sc.bob.org) == []
    assert nineteen.rows[0][0]["status"] == "priced", nineteen
    assert twenty_q.rows[0][0]["status"] == "unavailable" and twenty_q.rows[0][0]["reason"] == "clip_limit", twenty_q
    assert not twenty_p.ok and twenty_p.sqlstate == "NS400" and "clips_unavailable" in twenty_p.error, twenty_p


def test_two_presses_at_once_hold_once(conn, sc):
    """Two sessions press for the same video concurrently with different keys:
    one wins, the other waits and is refused as in progress before anything is
    held. Real sessions must commit, so this test puts the world back itself."""
    with as_superuser(conn) as su:
        had = {r[0]: (r[1], r[2]) for r in su.rows(
            "select unit, credits_per_unit, margin from public.credit_prices where unit = any(%s)", [list(PRICES)])}
        _set_prices(su, PRICES)
        vid = _master(su, sc.bob, "master-race")
    dsn = psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)
    barrier = threading.Barrier(2)
    results = []

    def go():
        with psycopg.connect(dsn, autocommit=True) as c:
            with acting(c, sc.bob.actor, commit=True) as s:
                barrier.wait()
                results.append(press(s, vid))

    threads = [threading.Thread(target=go) for _ in range(2)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert sorted(r.ok for r in results) == [False, True], results
        loser = next(r for r in results if not r.ok)
        assert loser.sqlstate == "NS409" and "in_progress" in loser.error, loser
        with as_superuser(conn, commit=False) as su:
            assert len(requests(su, vid)) == 1
            assert len([h for h in holds(su, sc.bob.org, fresh=False) if h[2] == "open"]) == 1
    finally:
        with acting(conn, SERVICE, commit=True) as s:
            claimed = s.value("select public.claim_repurpose_request('cleanup')")
            if claimed:
                s.value("select public.finish_repurpose_request(%s, 'cleanup')", [claimed["id"]])
        with as_superuser(conn) as su:
            for unit in PRICES:
                if unit in had:
                    su.rows("update public.credit_prices set credits_per_unit = %s, margin = %s where unit = %s "
                            "returning 1", [had[unit][0], had[unit][1], unit])
                else:
                    su.rows("delete from public.credit_prices where unit = %s returning 1", [unit])
            assert not [h for h in holds(su, sc.bob.org, fresh=False) if h[2] == "open"], "the race left a hold open"


def test_a_second_press_while_one_is_queued_is_in_progress_and_holds_nothing(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            first = press(s, vid)
            second = press(s, vid, cj(C))
            q = quote(s, vid, cj(C))
            h = holds(owner(s), sc.bob.org)
    assert first.ok and not second.ok and second.sqlstate == "NS409" and "in_progress" in second.error
    assert q.rows[0][0]["status"] == "unavailable" and q.rows[0][0]["reason"] == "in_progress"
    assert len(h) == 1


# ── the worker: claim, make, settle ─────────────────────────────────────────

def test_a_made_clip_is_its_own_held_private_short_with_no_gate_verdict(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid, cj(A, C), max_credits=TWO)
            become(s, SERVICE)
            claim = s.value("select public.claim_repurpose_request('w1')")
            one = record(s, body["id"], 1)
            two = record(s, body["id"], 2)
            done = finish(s, body["id"])
            o = owner(s)
            r = requests(o, vid)[0]
            rows = o.rows("select video_id, channel_id, title, topic, slug, local_path, published_at, privacy, "
                          "review_state, publish_state, held_at is not null, hold_detail, video_format, "
                          "parent_video_id, manifest is null, preview_path "
                          "from public.videos where parent_video_id = %s order by slug", [vid])
            refusal = [as_service_refusal(o, row[0]) for row in rows]
    assert claim["id"] == body["id"] and claim["master"]["local_path"] == f"output/master-{sc.bob.key}/final_video.mp4"
    assert [c["position"] for c in claim["clips"]] == [1, 2]
    assert one.ok and two.ok and done.ok and done.rows[0][0]["status"] == "succeeded", (one, two, done)
    assert r[1] == "succeeded" and float(r[7]) == TWO
    id8 = body["id"].replace("-", "")[:8]
    assert len(rows) == 2
    for n, row in enumerate(rows, start=1):
        (video_id, channel, title, topic, slug, path, published, privacy, review, state, held, detail, fmt,
         parent, no_manifest, preview) = row
        want_slug = f"master-{sc.bob.key}-c{id8}-{n:02d}"
        # The id, slug and file path are built by the database, never by the worker.
        assert slug == want_slug and video_id == held_id(sc.bob.channel, want_slug), row
        assert path == f"output/master-{sc.bob.key}/repurpose/{id8}/clip-{n:02d}.mp4", path
        # Held, private, not published, not reviewed, a Short of its master.
        assert (published, privacy, review, state, held, fmt, parent) == (
            None, None, "pending", "held", True, "short", vid), row
        assert channel == sc.bob.channel and topic == "a topic" and title == f"The master - clip {n}"
        # No gate verdict is recorded: the page reads "no gate verdict", never "passed".
        assert detail["reason"] == "repurposed_clip" and detail["master_video_id"] == vid and "gate" not in detail
        assert no_manifest is True and preview is None
    # A held row never passes a cross-post: the gate and approvals are the way out.
    assert refusal == ["not_uploaded", "not_uploaded"], refusal


def as_service_refusal(o, video_id):
    return o.value("select public.publish_request_refusal(%s)", [video_id])


def test_a_clip_is_not_repurposed_again(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid)
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            record(s, body["id"], 1)
            finish(s, body["id"])
            o = owner(s)
            clip = o.value("select video_id from public.videos where parent_video_id = %s", [vid])
            become(s, sc.bob.actor)
            q = quote(s, clip)
    assert q.rows[0][0]["status"] == "unavailable" and q.rows[0][0]["reason"] == "is_a_clip", q


def test_a_partial_request_is_charged_for_the_clips_made_only(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        before = available(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid, cj(A, C, D), max_credits=THREE)
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            ok1 = record(s, body["id"], 1)
            bad2 = record(s, body["id"], 2, ok=False)
            ok3 = record(s, body["id"], 3)
            done = finish(s, body["id"])
            again = finish(s, body["id"])
            o = owner(s)
            h, r = holds(o, sc.bob.org), requests(o, vid)[0]
            k = clips_of(o, body["id"])
            after = available(o, sc.bob.org)
            made = o.value("select count(*) from public.videos where parent_video_id = %s", [vid])
    assert ok1.ok and bad2.ok and ok3.ok, (ok1, bad2, ok3)
    assert done.rows[0][0]["status"] == "partial" and float(done.rows[0][0]["charged_credits"]) == TWO, done
    assert again.rows[0][0]["replayed"] is True and again.rows[0][0]["status"] == "partial"
    # 3 clips held (12); 2 made, 4 each = 8 charged; the rest of the hold goes back.
    assert h[0][2] == "captured" and float(h[0][3]) == TWO and float(h[0][1]) == THREE, h
    assert float(before) - float(after) == TWO, "only the clips that were made are charged"
    assert [c[7] for c in k] == ["rendered", "failed", "rendered"] and k[1][10] == "ffmpeg_failed", k
    assert r[1] == "partial" and float(r[7]) <= float(r[5]) and made == 2
    assert r[8] == "ffmpeg_failed", r


def test_a_request_that_made_nothing_releases_the_whole_hold(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        before = available(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid, cj(A, C), max_credits=TWO)
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            bad1 = record(s, body["id"], 1, ok=False)
            # The worker gives up on the rest: finish fails what it never reported.
            done = finish(s, body["id"])
            o = owner(s)
            h, r = holds(o, sc.bob.org), requests(o, vid)[0]
            k = clips_of(o, body["id"])
            after = available(o, sc.bob.org)
            made = o.value("select count(*) from public.videos where parent_video_id = %s", [vid])
    assert bad1.ok and done.rows[0][0]["status"] == "failed" and float(done.rows[0][0]["charged_credits"]) == 0
    assert h[0][2] == "released" and h[0][3] is None, h
    assert float(after) == float(before), "a failed request kept credits"
    assert [c[7] for c in k] == ["failed", "failed"] and k[1][10] == "not_rendered", k
    assert r[1] == "failed" and float(r[7]) == 0 and r[8] == "ffmpeg_failed" and made == 0, r


def test_the_minimum_applies_once_anything_is_delivered_and_a_capture_never_exceeds_the_hold(conn, sc):
    with world(conn, sc.bob, prices={"repurpose_clip": 1, "job_minimum": 5}) as (su, vid):
        before = available(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid, cj(A, C, D), max_credits=5)
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            record(s, body["id"], 1)
            record(s, body["id"], 2, ok=False)
            record(s, body["id"], 3, ok=False)
            # CHECK charged_credits <= quoted_credits, on a request still open.
            over = owner(s).run("update public.repurpose_requests set charged_credits = quoted_credits + 1 "
                                "where id = %s", [body["id"]])
            become(s, SERVICE)
            done = finish(s, body["id"])
            o = owner(s)
            r = requests(o, vid)[0]
            after = available(o, sc.bob.org)
    # 3 clips x 1 = 3, floored to 5 for the hold; one made: min(5, max(1, 5)).
    assert float(r[5]) == 5 and float(done.rows[0][0]["charged_credits"]) == 5
    assert float(before) - float(after) == 5
    assert not over.ok and over.sqlstate == "23514", over


def test_a_stale_worker_cannot_settle_what_another_worker_took_over(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid, cj(A, C), max_credits=TWO)
            become(s, SERVICE)
            first = s.value("select public.claim_repurpose_request('w1')")
            record(s, body["id"], 1)
            owner(s).rows("update public.repurpose_requests set heartbeat_at = now() - interval '1 hour' "
                          "where id = %s returning 1", [body["id"]])
            become(s, SERVICE)
            second = s.value("select public.claim_repurpose_request('w2')")
            stale_record = record(s, body["id"], 2, worker="w1")
            stale_beat = s.value("select public.heartbeat_repurpose(%s, 'w1')", [body["id"]])
            stale_finish = finish(s, body["id"], worker="w1")
            fresh_beat = s.value("select public.heartbeat_repurpose(%s, 'w2')", [body["id"]])
            ok2 = record(s, body["id"], 2, worker="w2")
            done = finish(s, body["id"], worker="w2")
    assert first["attempt"] == 1 and second["attempt"] == 2
    # The new claim hands over only the clip still to make: clip 1 exists already.
    assert [c["position"] for c in second["clips"]] == [2], second["clips"]
    assert not stale_record.ok and "not_claimed" in stale_record.error, stale_record
    assert not stale_finish.ok and "not_claimed" in stale_finish.error, stale_finish
    assert stale_beat is False and fresh_beat is True
    assert ok2.ok and done.rows[0][0]["status"] == "succeeded", done


def test_a_clip_reported_twice_changes_nothing(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid)
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            a = record(s, body["id"], 1)
            b = record(s, body["id"], 1, ok=False)
            o = owner(s)
            made = o.value("select count(*) from public.videos where parent_video_id = %s", [vid])
            status = clips_of(o, body["id"])[0][7]
    assert a.rows[0][0]["replayed"] is False and b.rows[0][0]["replayed"] is True
    assert b.rows[0][0]["status"] == "rendered" and made == 1 and status == "rendered"


def test_the_worker_cannot_name_the_clips_id_path_or_send_junk(conn, sc):
    bad = [
        info(sha256="zz"), info(sha256=None), info(bytes=0), info(width=1920, height=1080),
        info(title=""), info(title="x" * 101), info(title="a\x07b"), info(captions="text"),
        info(captions={"x": "y" * 9000}),
    ]
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid)
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            outs = [record(s, body["id"], 1, payload=b) for b in bad]
            # Fields the worker has no say in are ignored, not obeyed.
            forged = record(s, body["id"], 1, payload=json.dumps({
                **json.loads(info(1)), "video_id": "FORGED", "local_path": "../../etc/passwd",
                "slug": "forged", "privacy": "public", "published_at": "2026-01-01", "publish_state": "uploaded"}))
            o = owner(s)
            row = o.rows("select video_id, local_path, slug, privacy, published_at, publish_state "
                         "from public.videos where parent_video_id = %s", [vid])[0]
    for o_ in outs:
        assert not o_.ok and o_.sqlstate in ("22023", "22P02", "23514"), o_
    assert forged.ok, forged
    assert row[0] != "FORGED" and row[1].startswith("output/master-") and "passwd" not in row[1]
    assert row[2] != "forged" and row[3] is None and row[4] is None and row[5] == "held", row


def test_a_request_whose_hold_is_gone_runs_nothing_and_charges_nothing(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid)
            o = owner(s)
            o.rows("update public.credit_reservations set status = 'released', settled_at = now() "
                   "where job_id = %s returning 1", [body["credit_ref"]])
            become(s, SERVICE)
            claim = s.value("select public.claim_repurpose_request('w1')")
            o = owner(s)
            r = requests(o, vid)[0]
            k = clips_of(o, body["id"])
    assert claim is None
    assert r[1] == "failed" and float(r[7]) == 0 and r[8] == "hold_not_open", r
    assert [c[7] for c in k] == ["failed"] and k[0][10] == "hold_not_open", k


def test_the_sweep_settles_a_lost_request_charging_only_what_was_made(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        before = available(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            gone = _pressed(s, vid, cj(A, C), max_credits=TWO)
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            record(s, gone["id"], 1)
            # The worker died on its last attempt, a long time ago.
            owner(s).rows("update public.repurpose_requests set attempts = 3, "
                          "heartbeat_at = now() - interval '2 hours' where id = %s returning 1", [gone["id"]])
            become(s, SERVICE)
            n = s.value("select public.expire_repurpose_requests()")
            nothing = s.value("select public.claim_repurpose_request('w2')")
            o = owner(s)
            r = requests(o, vid)[0]
            after = available(o, sc.bob.org)
    assert n >= 1 and nothing is None
    assert r[1] == "partial" and r[8] == "job_ended", r
    # Clip 1 exists and is charged: max(4, floor 5) = 5; clip 2 never was.
    assert float(r[7]) == 5 and float(before) - float(after) == 5


def test_a_request_nobody_claimed_for_a_day_is_failed_and_released(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        before = available(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid)
            o = owner(s)
            o.conn.execute("alter table public.repurpose_requests disable trigger repurpose_requests_terms_frozen")
            o.rows("update public.repurpose_requests set created_at = now() - interval '30 hours' "
                   "where id = %s returning 1", [body["id"]])
            o.conn.execute("alter table public.repurpose_requests enable trigger repurpose_requests_terms_frozen")
            become(s, SERVICE)
            n = s.value("select public.expire_repurpose_requests()")
            o = owner(s)
            r = requests(o, vid)[0]
            after = available(o, sc.bob.org)
    assert n >= 1 and r[1] == "failed" and float(r[7]) == 0 and float(after) == float(before), r


def test_requests_and_clips_are_final_once_ended_and_never_deleted(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = _pressed(s, vid)
            o = owner(s)
            moved = o.run("update public.repurpose_requests set quoted_credits = 1 where id = %s", [body["id"]])
            moved_clip = o.run("update public.repurpose_clips set start_s = 1, end_s = 21 where request_id = %s",
                               [body["id"]])
            become(s, SERVICE)
            s.value("select public.claim_repurpose_request('w1')")
            finish(s, body["id"])
            o = owner(s)
            reopen = o.run("update public.repurpose_requests set status = 'queued', finished_at = null where id = %s",
                           [body["id"]])
            reclip = o.run("update public.repurpose_clips set status = 'queued', finished_at = null "
                           "where request_id = %s", [body["id"]])
            gone = o.run("delete from public.repurpose_requests where id = %s", [body["id"]])
            gone_clip = o.run("delete from public.repurpose_clips where request_id = %s", [body["id"]])
    for out in (moved, moved_clip, reopen, reclip, gone, gone_clip):
        assert not out.ok and out.sqlstate == "42501", out


def test_the_database_refuses_a_clip_that_is_not_a_short_window(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        rid = su.value("insert into public.repurpose_requests (org_id, channel_id, video_id, slug, clip_count, "
                       "idempotency_key, request_hash) values (%s, %s, %s, 'master-x', 1, 'k-1234567890', %s) "
                       "returning id", [sc.bob.org, sc.bob.channel, vid, "0" * 32])
        outs = {}
        for name, (first, last, ids, start, end, dur) in {
            "too_short": ("s000", "s000", "{s000}", 0, 14, 14),
            "too_long": ("s000", "s000", "{s000}", 0, 61, 61),
            "ids_do_not_frame_the_window": ("s000", "s001", "{s000}", 0, 20, 20),
            "duration_is_not_the_window": ("s000", "s000", "{s000}", 0, 20, 30),
        }.items():
            outs[name] = su.run(
                "insert into public.repurpose_clips (request_id, org_id, channel_id, master_id, ordinal, "
                "first_scene, last_scene, scene_ids, start_s, end_s, duration_s) "
                "values (%s, %s, %s, %s, 1, %s, %s, %s, %s, %s, %s)",
                [rid, sc.bob.org, sc.bob.channel, vid, first, last, ids, start, end, dur])
    for name, out in outs.items():
        assert not out.ok and out.sqlstate == "23514", (name, out)


# ── the database's windows are the worker's windows ─────────────────────────

def _build_manifest(spec):
    """samples/repurpose_cases.json's manifest spec (the same builder as
    tests/test_repurpose.py and the TypeScript twin's test)."""
    from decimal import Decimal

    if "__raw__" in spec:
        return spec["__raw__"]
    t, scenes = Decimal(0), []
    for i, n in enumerate(spec["lengths"]):
        s, t = t, t + Decimal(str(n))
        scenes.append({"id": f"s{i:03d}", "index": i, "start_s": float(s), "end_s": float(t),
                       "narration": f"Scene {i} narration."})
    for k, ov in (spec.get("overrides") or {}).items():
        scenes[int(k)].update(ov)
    m = {"version": 1, "scenes": scenes}
    audio = spec.get("audio_s", float(t))
    if audio is not None:
        m["audio"] = {"duration_s": audio}
    return m


def test_repurpose_plan_answers_every_shared_case_exactly_as_the_workers_mirror(conn):
    """samples/repurpose_cases.json is also run by modules/repurpose.plan_clips
    (the worker re-checks the files on disk with it): the same reason word, the
    same position and the same windows, so the quote, the press and the worker
    can never disagree about what a window is."""
    import pathlib

    cases = json.loads((pathlib.Path(__file__).resolve().parents[2] / "samples" / "repurpose_cases.json")
                       .read_text("utf-8"))["plan"]
    assert len(cases) >= 30
    wrong = []
    with as_superuser(conn, commit=False) as su:
        for c in cases:
            got = su.value("select public.repurpose_plan(%s::jsonb, %s::jsonb)",
                           [json.dumps(_build_manifest(c["manifest"])), json.dumps(c["clips"])])
            want = c["expected"]
            same = got["ok"] == want["ok"]
            if same and want["ok"]:
                same = len(got["clips"]) == len(want["clips"]) and all(
                    {k: v for k, v in g.items() if k not in ("start_s", "end_s", "duration_s")}
                    == {k: v for k, v in w.items() if k not in ("start_s", "end_s", "duration_s")}
                    and all(abs(float(g[k]) - float(w[k])) < 1e-9 for k in ("start_s", "end_s", "duration_s"))
                    for g, w in zip(got["clips"], want["clips"]))
            elif same:
                same = got.get("reason") == want["reason"] and got.get("position") == want.get("position")
            if not same:
                wrong.append((c["name"], got, want))
    assert not wrong, wrong


# ── a migration that is safe to apply twice ─────────────────────────────────

def test_applying_0080_again_changes_nothing(conn, sc):
    """Replay-safe: a second run of the file (a re-run of the whole set, a
    retried deploy) keeps the data and the privileges exactly as they were."""
    import pathlib

    path = pathlib.Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "0080_repurpose.sql"
    dsn = psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)

    def state(su):
        return (
            su.value("select count(*) from public.repurpose_requests"),
            su.value("select count(*) from public.repurpose_clips"),
            su.rows("select p.proname, p.proacl::text from pg_proc p where p.pronamespace = 'public'::regnamespace "
                    "and p.proname ~ '(repurpose)' order by 1"),
            su.rows("select tablename, policyname, cmd, qual from pg_policies where tablename like 'repurpose_%%' "
                    "order by 1, 2"),
            su.rows("select conname from pg_constraint where conrelid in ('public.repurpose_requests'::regclass, "
                    "'public.repurpose_clips'::regclass) order by 1"),
            su.rows("select tgname from pg_trigger where tgrelid in ('public.repurpose_requests'::regclass, "
                    "'public.repurpose_clips'::regclass) and not tgisinternal order by 1"),
            su.rows("select relname, relrowsecurity from pg_class where relname like 'repurpose_%%' and relkind = 'r' "
                    "order by 1"),
        )

    with as_superuser(conn, commit=False) as su:
        before = state(su)
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute(path.read_text(encoding="utf-8"))
        c.execute(path.read_text(encoding="utf-8"))
    with as_superuser(conn, commit=False) as su:
        after = state(su)
    assert before == after
    assert before[0] >= 2 and before[1] >= 2          # the seeded rows are still there
    assert all(rls for _, rls in before[6]) and len(before[6]) == 2
