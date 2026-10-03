"""Migration 0085: the follow-ups of the independent review of scene
regeneration (BR-L-040, BR-L-042 database half, BR-L-044) and the guards of
0076 that review found no test pinning (BR-L-046).

What would break without these:

* a member reads the worker's own text (a generator's name, its key being
  unset, the model the worker is configured for) from the regeneration row;
* a press with a NaN or Infinity ceiling holds the price with no ceiling;
* the list the worker settles from differs from what the sweep releases, so a
  hold is released while the new cut is in place;
* BR-L-046: a viewer of the operator's organization presses a free
  regeneration; a reused key quietly runs another scene or source; a hold that
  is short, started, another organization's, or not open pays a regeneration's
  job; a job is linked to a regeneration of another channel; two active
  regenerations of one video; a quote that moves after the press; a price of 0
  reads as priced; the sweep races the worker's own settle.
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from sec_db import ANON, SERVICE, acting, as_superuser
from sec_scene_regen_0076 import REGENERATION, held_id, manifest_json
from test_sec_scene_regenerate import (GEN, PRICES, STOCK, _accept_invite, _set_prices, available, become, holds,
                                       jobs, owner, press, quote, regens, world)

REPO = Path(__file__).resolve().parents[2]
VENDOR_TEXT = ("the generator this scene was made with (kling) has no API key on this worker. "
               "Fix: set its key on the worker, then press Regenerate again (nothing was charged).")


def pressed_and_started(s, vid, **kw):
    body = press(s, vid, **kw).rows[0][0]
    become(s, SERVICE)
    s.value("select public.start_scene_regeneration(%s, %s)", [body["id"], body["render_job_id"]])
    return body


# ── BR-L-040: the worker's text is not the member's ─────────────────────────

def test_a_member_reads_the_code_but_never_the_workers_text(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            become(s, SERVICE)
            s.value("select public.start_scene_regeneration(%s, %s)", [body["id"], body["render_job_id"]])
            s.value("select public.finish_scene_regeneration(%s, %s, false, 'provider_unavailable', %s, null)",
                    [body["id"], body["render_job_id"], VENDOR_TEXT])
            svc_error = s.value("select error from public.scene_regenerations where id = %s", [body["id"]])
            svc_detail = s.value("select detail from public.scene_regeneration_details where regeneration_id = %s",
                                 [body["id"]])
            become(s, sc.bob.actor)
            code = s.run("select error_code, status from public.scene_regenerations where id = %s", [body["id"]])
            err = s.run("select error from public.scene_regenerations where id = %s", [body["id"]])
            star = s.run("select * from public.scene_regenerations where id = %s", [body["id"]])
            filt = s.run("select id from public.scene_regenerations where error like %s", ["%kling%"])
            det = s.run("select detail from public.scene_regeneration_details")
            owner_error = owner(s).value("select error from public.scene_regenerations where id = %s", [body["id"]])
    # What the page reads is unchanged.
    assert code.ok and code.rows == [("provider_unavailable", "failed")], code
    # The column itself is closed to a member, however it is asked for
    # (selected, selected with `*`, or probed in a filter).
    for attack in (err, star, filt, det):
        assert not attack.ok and attack.sqlstate == "42501", attack
    # The row holds one fixed sentence, whatever the worker said.
    assert "kling" not in owner_error.lower() and "worker" not in owner_error.lower(), owner_error
    assert owner_error == svc_error and "nothing was charged" in owner_error
    # The worker's text is kept, for the operator, in the service-only table.
    assert svc_detail == VENDOR_TEXT


def test_a_viewer_and_anon_cannot_read_the_error_or_the_details_either(conn, sc):
    with world(conn, sc.alice) as (su, vid):
        with acting(conn, sc.alice.actor) as s:
            # Org A's seeded queued run holds its one parallel slot: free it.
            owner(s).rows("update public.credit_reservations set status = 'released', settled_at = now() "
                          "where org_id = %s and status = 'open' returning 1", [sc.alice.org])
            out = press(s, vid)
            assert out.ok, out
            body = out.rows[0][0]
            become(s, SERVICE)
            s.value("select public.finish_scene_regeneration(%s, %s, false, 'failed', %s, null)",
                    [body["id"], body["render_job_id"], VENDOR_TEXT])
            # A viewer of org A (bound in this transaction).
            become(s, sc.invitee)
            _accept_invite(s, sc)
            seen = s.run("select error_code from public.scene_regenerations where id = %s", [body["id"]])
            err = s.run("select error from public.scene_regenerations where id = %s", [body["id"]])
            det = s.run("select detail from public.scene_regeneration_details")
            become(s, ANON)
            anon_err = s.run("select error from public.scene_regenerations")
            anon_det = s.run("select detail from public.scene_regeneration_details")
            become(s, sc.bob.actor)   # another organization
            other = s.run("select error_code from public.scene_regenerations where id = %s", [body["id"]])
    assert seen.ok and seen.rows == [("failed",)], seen
    for attack in (err, det, anon_err, anon_det):
        assert not attack.ok and attack.sqlstate == "42501", attack
    assert other.ok and other.rows == [], "another organization read a regeneration"


def test_the_columns_the_page_reads_are_all_still_readable_by_a_member(conn, sc):
    ts = (REPO / "command-center" / "lib" / "sceneRegenerate.ts").read_text()
    cols = re.search(r'REGEN_COLUMNS =\s*"([a-z_,]+)"', ts).group(1)
    assert "error," not in cols + "," and "error_code" in cols, cols
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            press(s, vid)
            page = s.run(f"select {cols} from public.scene_regenerations where video_id = %s", [vid])
    assert page.ok and len(page.rows) == 1, page


def test_the_service_key_still_reads_the_whole_row(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            become(s, SERVICE)
            s.value("select public.finish_scene_regeneration(%s, %s, false, 'failed', 'a reason', null)",
                    [body["id"], body["render_job_id"]])
            full = s.run("select * from public.scene_regenerations where id = %s", [body["id"]])
            nothing = s.run("update public.scene_regeneration_details set detail = 'x'")
            gone = s.run("delete from public.scene_regeneration_details")
            added = s.run("insert into public.scene_regeneration_details (regeneration_id, detail) values (%s, 'x')",
                          [body["id"]])
    assert full.ok and len(full.rows) == 1, full
    for attack in (nothing, gone, added):
        assert not attack.ok and attack.sqlstate == "42501", attack


def test_no_text_means_no_detail_row_and_a_second_end_changes_nothing(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            become(s, SERVICE)
            s.value("select public.finish_scene_regeneration(%s, %s, false, 'failed', '   ', null)",
                    [body["id"], body["render_job_id"]])
            again = s.value("select public.finish_scene_regeneration(%s, %s, false, 'failed', 'later', null)",
                            [body["id"], body["render_job_id"]])
            n = owner(s).value("select count(*) from public.scene_regeneration_details where regeneration_id = %s",
                               [body["id"]])
    assert n == 0 and again["replayed"] is True


def test_a_success_stores_no_error_and_no_detail(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            become(s, SERVICE)
            s.value("select public.start_scene_regeneration(%s, %s)", [body["id"], body["render_job_id"]])
            s.value("select public.finish_scene_regeneration(%s, %s, true, null, 'ignored text', null)",
                    [body["id"], body["render_job_id"]])
            o = owner(s)
            err = o.value("select error from public.scene_regenerations where id = %s", [body["id"]])
            n = o.value("select count(*) from public.scene_regeneration_details where regeneration_id = %s",
                        [body["id"]])
    assert err is None and n == 0


# ── BR-L-044: a ceiling is a number ─────────────────────────────────────────

def test_a_ceiling_that_is_not_a_number_is_refused_and_nothing_is_held(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        before = available(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            outs = {v: press(s, vid, max_credits=v) for v in ("NaN", "Infinity", "-Infinity")}
            o = owner(s)
            assert holds(o, sc.bob.org) == [] and regens(o, vid) == []
            assert float(available(o, sc.bob.org)) == float(before)
            # The same press with a real ceiling still works (not vacuous).
            fine = press(s, vid, max_credits=GEN)
            huge = press(s, vid, max_credits=1000000000, key="a-different-key-1")
    for v, out in outs.items():
        assert not out.ok and out.sqlstate == "22023" and "price_required" in out.error, (v, out)
    assert fine.ok and float(fine.rows[0][0]["credits_held"]) == GEN
    # A second press while the first is queued: refused as in progress, not as a ceiling.
    assert not huge.ok and "in_progress" in huge.error, huge


def test_a_large_finite_ceiling_holds_the_price_not_the_ceiling(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            out = press(s, vid, max_credits=1000000000)
            h = holds(owner(s), sc.bob.org)
    assert out.ok and float(out.rows[0][0]["credits_held"]) == GEN and float(h[0][1]) == GEN


# ── BR-L-042: what the worker settles is what the sweep would release ───────

def test_the_unsettled_list_is_service_only_and_read_only(conn, sc):
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            member = s.run("select * from public.scene_regenerations_unsettled()")
            owner(s).rows("update public.render_jobs set status = 'failed', finished_at = now() - interval '1 hour' "
                          "where id = %s returning 1", [body["render_job_id"]])
            become(s, ANON)
            anon = s.run("select * from public.scene_regenerations_unsettled()")
            become(s, SERVICE)
            rows = s.run("select id, render_job_id, slug, status from public.scene_regenerations_unsettled()")
            again = s.run("select id from public.scene_regenerations_unsettled()")
            o = owner(s)
            status = regens(o, vid)[0][1]
            hold = holds(o, sc.bob.org)[0][2]
    for out in (member, anon):
        assert not out.ok and out.sqlstate == "42501", out
    assert rows.ok and [(str(r[0]), r[1], r[2], r[3]) for r in rows.rows if str(r[0]) == body["id"]] == [
        (body["id"], body["render_job_id"], f"regen-{sc.bob.key}", "queued")], rows
    assert again.ok
    # Listing settles nothing: the row is still queued and the hold still open.
    assert status == "queued" and hold == "open"


def test_the_unsettled_list_is_exactly_what_the_sweep_releases(conn, sc):
    """Same rows as expire_scene_regenerations(), one for each way a job can
    stand: running, queued, ended just now (inside the 15 minute grace), ended
    long ago, and a day-old regeneration whose job still queues."""
    cases = {"running": ("running", None, False), "queued": ("queued", None, False),
             "just-ended": ("failed", "5 minutes", False), "ended": ("failed", "20 minutes", True),
             "day-old": ("queued", None, True)}
    with as_superuser(conn, commit=False) as su:
        _set_prices(su, PRICES)
        videos = {}
        for key in cases:
            videos[key] = su.value(
                "insert into public.videos (video_id, channel_id, title, slug, review_state, publish_state, manifest) "
                "values (%s, %s, 'Held', %s, 'pending', 'held', %s::jsonb) returning video_id",
                [held_id(sc.bob.channel, f"unsettled-{key}"), sc.bob.channel, f"unsettled-{key}", manifest_json()])
        with acting(conn, sc.bob.actor) as s:
            bodies = {}
            for key in cases:
                # Room for the next hold, whatever the plan's parallel limit.
                owner(s).rows("update public.credit_reservations set status = 'released', settled_at = now() "
                              "where org_id = %s and status = 'open' and job_id like 'rj-sr-%%' returning 1",
                              [sc.bob.org])
                out = press(s, videos[key])
                assert out.ok, (key, out)
                bodies[key] = out.rows[0][0]
            o = owner(s)
            for key, (state, age, _) in cases.items():
                if age:
                    o.rows("update public.render_jobs set status = %s, finished_at = now() - %s::interval where id = %s "
                           "returning 1", [state, age, bodies[key]["render_job_id"]])
                else:
                    o.rows("update public.render_jobs set status = %s where id = %s returning 1",
                           [state, bodies[key]["render_job_id"]])
            # created_at is a frozen term: back-dated the way only the owner could.
            o.conn.execute("set local session_replication_role = replica")
            o.rows("update public.scene_regenerations set created_at = now() - interval '27 hours' where id = %s "
                   "returning 1", [bodies["day-old"]["id"]])
            o.conn.execute("set local session_replication_role = origin")
            ours = {b["id"]: k for k, b in bodies.items()}
            become(s, SERVICE)
            everything = {str(r[0]) for r in s.run("select id from public.scene_regenerations_unsettled()").rows}
            listed = {ours[i] for i in everything if i in ours}
            # An ended regeneration (the seeded ones) is nobody's to settle.
            assert not everything & set(REGENERATION.values()), everything
            s.value("select public.expire_scene_regenerations()")
            released = {k for k, b in bodies.items()
                        if owner(s).value("select status from public.scene_regenerations where id = %s",
                                          [b["id"]]) == "failed"}
    wanted = {k for k, (_, _, expired) in cases.items() if expired}
    assert listed == wanted == {"ended", "day-old"}, (listed, wanted)
    # The sweep takes exactly the rows the worker was told to settle first,
    # including its 15 minute grace (a job that ended 5 minutes ago is left).
    assert released == listed, (released, listed)


# ── BR-L-046: guards of 0076 that nothing pinned ────────────────────────────

def _operator_video(su, slug="op-regen"):
    vid = held_id("default", slug)
    su.rows("insert into public.videos (video_id, channel_id, title, slug, review_state, publish_state, manifest) "
            "values (%s, 'default', 'Op', %s, 'pending', 'held', %s::jsonb) returning 1",
            [vid, slug, manifest_json()])
    return vid


def test_a_viewer_of_the_operators_organization_cannot_press_a_free_regeneration(conn, sc):
    """S19. In the operator's own organization nothing is held, so the
    admin check in the press is the only gate there is."""
    with as_superuser(conn, commit=False) as su:
        _set_prices(su, PRICES)
        vid = _operator_video(su)
        with acting(conn, sc.dana) as s:
            q = quote(s, vid)
            p = press(s, vid, max_credits=None)
            assert regens(owner(s), vid) == []
        with acting(conn, sc.operator) as s:
            ok = press(s, vid, max_credits=None)
            r = regens(owner(s), vid)
            h = holds(owner(s), "00000000-0000-0000-0000-000000000001")
    assert q.ok and q.rows[0][0]["may_start"] is False, q
    # Refused by the press itself ('forbidden'), not only by the render queue's
    # guard further down, which would also stop it with its own message.
    assert not p.ok and p.sqlstate == "42501" and "forbidden" in p.error \
        and "render_jobs" not in p.error, p
    # The positive control: the operator's owner presses, nothing is held.
    assert ok.ok and ok.rows[0][0]["credits_held"] is None, ok
    assert len(r) == 1 and r[0][7] is None and h == []


def test_a_reused_key_for_another_scene_or_another_source_is_a_conflict(conn, sc):
    """S5, S6. The idempotency hash carries the scene and the source, not
    only the prompt."""
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            first = press(s, vid, scene="s001", source="same", max_credits=STOCK, key="reuse-key-0001")
            other_scene = press(s, vid, scene="s000", source="same", max_credits=GEN, key="reuse-key-0001")
            other_source = press(s, vid, scene="s001", source="stock", max_credits=STOCK, key="reuse-key-0001")
            same = press(s, vid, scene="s001", source="same", max_credits=STOCK, key="reuse-key-0001")
            n = len(regens(owner(s), vid))
    assert first.ok and same.ok and same.rows[0][0]["replayed"] is True
    for out in (other_scene, other_source):
        assert not out.ok and out.sqlstate == "NS409" and "idempotency_conflict" in out.error, out
    assert n == 1


def test_start_refuses_a_hold_smaller_than_the_quote(conn, sc):
    """S7. The guard refuses a short hold at insert; the worker's own claim
    must refuse one that shrank afterwards."""
    with world(conn, sc.bob) as (su, vid):
        before = available(su, sc.bob.org)
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            o = owner(s)
            # The hold is now one credit short of the quote: the quote is
            # raised the way only the owner could (past the frozen-terms
            # trigger), since the ledger trigger refuses a shrunk hold.
            o.conn.execute("set local session_replication_role = replica")
            o.rows("update public.scene_regenerations set quoted_credits = quoted_credits + 1 where id = %s "
                   "returning 1", [body["id"]])
            o.conn.execute("set local session_replication_role = origin")
            become(s, SERVICE)
            start = s.value("select public.start_scene_regeneration(%s, %s)", [body["id"], body["render_job_id"]])
            o = owner(s)
            r = o.rows("select status, error_code, charged_credits from public.scene_regenerations where id = %s",
                       [body["id"]])[0]
            h = holds(o, sc.bob.org)
    assert start is None
    assert r[0] == "failed" and r[1] == "hold_not_open" and float(r[2]) == 0, r
    assert h[0][2] == "released", h


def _unlinked(s, body):
    """The regeneration's job removed (past the frozen-terms trigger) so the
    guard is what is tested when a job is inserted for it again."""
    o = owner(s)
    o.conn.execute("set local session_replication_role = replica")
    o.rows("delete from public.render_jobs where scene_regeneration_id = %s returning 1", [body["id"]])
    o.rows("update public.scene_regenerations set render_job_id = null where id = %s returning 1", [body["id"]])
    o.conn.execute("set local session_replication_role = origin")
    return o


def _relink(s, t, body, *, channel=None):
    become(s, SERVICE)
    return s.run("insert into public.render_jobs (channel_id, kind, params, credit_ref, scene_regeneration_id) "
                 "values (%s, 'repair', %s::jsonb, %s, %s)",
                 [channel or t.channel, json.dumps({"topic": f"regen-{t.key}", "repair_scenes": "s000"}),
                  body["credit_ref"], body["id"]])


HOLD_NOT_OURS = "not this scene regeneration"
NOT_ITS_JOB = "not the job its scene regeneration queued"


def test_the_guard_checks_each_property_of_the_regenerations_hold_alone(conn, sc):
    """S8..S11. Each check is the only thing wrong in its case, and the
    unchanged case is accepted, so a check that is dropped fails here."""
    breaks = {
        "hold already started": "update public.credit_reservations set started_at = now() where job_id = %(ref)s",
        "hold not open": "update public.credit_reservations set status = 'released', settled_at = now() "
                         "where job_id = %(ref)s",
        "hold of another organization": "update public.credit_reservations set org_id = %(other)s "
                                        "where job_id = %(ref)s",
        "hold smaller than the quote": "update public.credit_reservations set amount = amount - 1 "
                                       "where job_id = %(ref)s",
    }
    for label in ("control", *breaks):
        with world(conn, sc.bob, slug=f"regen-guard-{uuid.uuid4().hex[:8]}") as (su, vid):
            with acting(conn, sc.bob.actor) as s:
                body = press(s, vid).rows[0][0]
                o = _unlinked(s, body)
                if label != "control":
                    o.rows(breaks[label] % {"ref": "'" + body["credit_ref"] + "'", "other": "'" + sc.alice.org + "'"}
                           + " returning 1")
                # sr.slug is the video's slug; the job names it as its topic.
                slug = o.value("select slug from public.scene_regenerations where id = %s", [body["id"]])
                become(s, SERVICE)
                out = s.run("insert into public.render_jobs (channel_id, kind, params, credit_ref, "
                            "scene_regeneration_id) values (%s, 'repair', %s::jsonb, %s, %s)",
                            [sc.bob.channel, json.dumps({"topic": slug, "repair_scenes": "s000"}),
                             body["credit_ref"], body["id"]])
        if label == "control":
            assert out.ok, out
        else:
            assert not out.ok and out.sqlstate == "42501" and HOLD_NOT_OURS in out.error, (label, out)


def test_a_job_on_another_channel_is_not_the_regenerations_job(conn, sc):
    """S11's channel check, alone: the hold, scene and topic are all right."""
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            slug = _unlinked(s, body).value("select slug from public.scene_regenerations where id = %s", [body["id"]])
            become(s, SERVICE)
            wrong = s.run("insert into public.render_jobs (channel_id, kind, params, credit_ref, "
                          "scene_regeneration_id) values ('default', 'repair', %s::jsonb, %s, %s)",
                          [json.dumps({"topic": slug, "repair_scenes": "s000"}), body["credit_ref"], body["id"]])
            right = s.run("insert into public.render_jobs (channel_id, kind, params, credit_ref, "
                          "scene_regeneration_id) values (%s, 'repair', %s::jsonb, %s, %s)",
                          [sc.bob.channel, json.dumps({"topic": slug, "repair_scenes": "s000"}),
                           body["credit_ref"], body["id"]])
    assert not wrong.ok and wrong.sqlstate == "42501" and NOT_ITS_JOB in wrong.error, wrong
    assert right.ok, right


def test_the_sweep_leaves_a_job_that_just_ended_to_the_worker(conn, sc):
    """S12. The worker settles right after its job ends; the sweep's grace
    keeps it from racing that call."""
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            o = owner(s)
            o.rows("update public.render_jobs set status = 'succeeded', finished_at = now() - interval '5 minutes' "
                   "where id = %s returning 1", [body["render_job_id"]])
            become(s, SERVICE)
            s.value("select public.expire_scene_regenerations()")
            mid = (regens(owner(s), vid)[0][1], holds(owner(s), sc.bob.org)[0][2])
            owner(s).rows("update public.render_jobs set finished_at = now() - interval '20 minutes' where id = %s "
                          "returning 1", [body["render_job_id"]])
            become(s, SERVICE)
            late = s.value("select public.expire_scene_regenerations()")
            end = (regens(owner(s), vid)[0][1], holds(owner(s), sc.bob.org)[0][2])
    assert mid == ("queued", "open"), mid
    assert end == ("failed", "released") and late >= 1


def test_a_price_of_zero_is_unpriced_not_free(conn, sc):
    """S16."""
    with world(conn, sc.bob, prices={"scene_regenerate": 0, "job_minimum": 0}) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            q = quote(s, vid, scene="s001")
            p = press(s, vid, scene="s001", max_credits=1000)
            assert holds(owner(s), sc.bob.org) == [] and regens(owner(s), vid) == []
    assert q.rows[0][0]["status"] == "unpriced" and q.rows[0][0]["credits"] is None, q
    assert not p.ok and p.sqlstate == "NS400" and "unpriced" in p.error, p


def test_two_active_regenerations_of_one_video_are_refused_by_the_table_itself(conn, sc):
    """S20. The function's lock and its `exists` check are not the only
    thing standing: a direct insert meets the unique index."""
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            press(s, vid)
            o = owner(s)
            dup = o.run(
                "insert into public.scene_regenerations (org_id, channel_id, video_id, slug, scene_id, "
                "requested_source, source_kind, stock_assets, previous_asset_ids, idempotency_key, request_hash) "
                "select org_id, channel_id, video_id, slug, 's001', 'same', 'stock', 2, '{a_stk1,a_stk2}', "
                "'direct-insert-key-1', md5('x') from public.scene_regenerations where video_id = %s limit 1", [vid])
            n = o.value("select count(*) from public.scene_regenerations where video_id = %s", [vid])
    assert not dup.ok and dup.sqlstate == "23505" and "one_active_per_video" in dup.error, dup
    assert n == 1


def test_the_quote_of_a_press_cannot_move_after_it(conn, sc):
    """S21. quoted_credits is one of the frozen terms."""
    with world(conn, sc.bob) as (su, vid):
        with acting(conn, sc.bob.actor) as s:
            body = press(s, vid).rows[0][0]
            o = owner(s)
            up = o.run("update public.scene_regenerations set quoted_credits = quoted_credits + 1 where id = %s",
                       [body["id"]])
            down = o.run("update public.scene_regenerations set quoted_credits = 0.01 where id = %s", [body["id"]])
            now = o.value("select quoted_credits from public.scene_regenerations where id = %s", [body["id"]])
    for out in (up, down):
        assert not out.ok and out.sqlstate == "42501", out
    assert float(now) == GEN
