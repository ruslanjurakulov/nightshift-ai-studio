"""Named attacks on 1440p and 4K exports, sold by the started minute (migration 0132).

request_editor_export's four-argument overload queues a render of the saved revision in a PAID frame (above 1080p) and holds the credits
the person confirmed after quote_editor_export showed them. What must hold:

  * nothing is sold on apply: both prices are NULL, and every request is refused (not_on_sale) before anything is locked, held or written;
  * the price is the database's: the CHARGE is the owner's row x the STARTED minutes, rounded up to the cent and NOT raised to job_minimum;
    the HOLD is the charge raised to job_minimum (reserve_credits refuses less), and done captures the charge only (the rest goes back). The
    caller's number is compared with the charge and only refuses a higher one (price_changed; also NaN, the infinities, none); a lower
    charge holds the lower one; too few credits for the HOLD (insufficient_credits) or the plan's parallel runs (parallel_runs) roll it all
    back;
  * above 1080p is never free: the two-argument export of a project whose own frame is above 1920x1080 pixels and the three-argument export
    of a paid frame are refused (hires_needs_paid_export); a document with a speed curve is not sold (hires_speed_curve);
  * one lock order in all three overloads (0054's: the project's row, then the organization's advisory lock): a free and a paid request of
    one project at once never deadlock, two paid requests at once see each other's export under the organization's lock (the three in
    flight hold), and a stale revision is refused under the row lock;
  * the hold settles on every path that ends an export, exactly once: captured when done, released when failed (the worker, a timeout, a
    lost worker, a deleted project), and a hold that is gone when the worker takes the export ends it (credits_released) without a render;
  * the caps: 300 s at 1440p, 180 s at 4K, 4K at 30 fps, in the function and in the table's CHECK; each paid export is one of the three in
    flight and the twenty a day;
  * who: an editor or above of the project's organization (a viewer may export for free, not spend); in the exempt organization a platform
    admin; another organization's project reads as missing; anon and the service role reach nothing; nobody but the functions writes the
    credit columns; nobody but the owner, in the SQL editor, reads or writes the prices, and a change leaves a security event;
  * a free frame is NOT sold here (invalid_frame), and the three-argument function cannot queue a paid frame (hires_needs_paid_export, and
    the CHECK refuses a row without a quote): exports up to 1080p are exactly what they were;
  * the file applies twice, refuses a body it has not seen, and its rollback takes it out (refusing while a paid export is in flight).

Every flow runs in one transaction that is rolled back, switching between the member's session, the worker's (service role) and the owner's.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser
from sec_editor_0054 import PROJECT, VIDEO, doc
from sec_scenario import DEFAULT_ORG, seat_invitee
from test_sec_upload_folder import back_to_owner, become

MIGRATION = sec_db.MIGRATION_0132
ROLLBACK = sec_db.ROLLBACK_0132
ROLLBACK_0129 = sec_db.REPO / "docs" / "sql" / "rollback_0129_editor_export_frame.sql"
REQ2 = "select public.request_editor_export(%s, %s)"
REQ3 = "select public.request_editor_export(%s, %s, %s)"
REQ4 = "select public.request_editor_export(%s, %s, %s, %s::numeric)"
QUOTE = "select public.quote_editor_export(%s, %s, %s)"
CREATE = "select public.create_editor_project(%s, %s, %s::jsonb)"
CLAIM = "select id::text, status, reason from public.claim_editor_export(%s)"
FINISH = "select public.finish_editor_export(%s, %s, %s, %s)"
REQ4_SIG = "public.request_editor_export(uuid, integer, text, numeric)"
QUOTE_SIG = "public.quote_editor_export(uuid, integer, text)"
PAID = ["youtube_1440p", "vertical_1440p", "youtube_2160p", "vertical_2160p"]
FREE = ["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]


def refused(out, sqlstate: str, word: str | None = None) -> bool:
    return (not out.ok) and out.sqlstate == sqlstate and (word is None or word in (out.error or ""))


def clear(s, *orgs: str) -> None:
    """As the owner: nothing of these organizations is waiting or was asked today, and nobody else's export is queued ahead (the worker
    claims the oldest export of ANY organization)."""
    back_to_owner(s)
    for org in orgs:
        s.conn.execute("delete from public.editor_exports where org_id = %s", [org])
    s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where status in ('queued', 'rendering')")


def price(s, p1440, p2160) -> None:
    back_to_owner(s)
    s.conn.execute("update public.editor_export_hires_prices set credits_per_minute_1440p = %s, credits_per_minute_2160p = %s",
                   [p1440, p2160])


def account(s, org: str):
    back_to_owner(s)
    return s.rows("select balance::float, reserved::float from public.credit_accounts where org_id = %s", [org])[0]


def hold(s, eid):
    back_to_owner(s)
    rows = s.rows("select status, amount::float, started_at is not null, captured::float from public.credit_reservations "
                  "where job_id = 'ee:' || %s::text", [eid])
    return rows[0] if rows else None


def row(s, eid):
    back_to_owner(s)
    return s.rows("select status, reason, frame_preset, quoted_credits::float, credit_ref, charged_credits::float "
                  "from public.editor_exports where id = %s", [eid])[0]


def held(s, eid):
    back_to_owner(s)
    v = s.value("select held_credits from public.editor_exports where id = %s", [eid])
    return None if v is None else float(v)


def job_minimum(s, value) -> None:
    back_to_owner(s)
    s.conn.execute("insert into public.credit_prices (unit, credits_per_unit) values ('job_minimum', %s) "
                   "on conflict (unit) do update set credits_per_unit = excluded.credits_per_unit", [value])


def project_with(s, tenant, **fields) -> str:
    """A project of `tenant`'s organization whose saved document has these top-level fields (width, height, fps)."""
    d = doc(VIDEO[tenant.key])
    d.update(fields)
    become(s, tenant.actor)
    pid = str(s.value(CREATE, [tenant.org, f"Doc {uuid.uuid4().hex[:6]}", json.dumps(d)]))
    back_to_owner(s)
    return pid


def ledger(s, eid):
    back_to_owner(s)
    return [(r[0], float(r[1])) for r in s.rows("select kind, amount from public.credit_transactions where job_id = 'ee:' || %s::text "
                                               "order by id", [eid])]


def exports_of(s, org: str) -> int:
    back_to_owner(s)
    return s.value("select count(*) from public.editor_exports where org_id = %s", [org])


def many_parallel_runs(s) -> None:
    """As the owner, for this transaction: every plan may hold ten runs at once (0034), so a test about something else is not refused
    for the seed's open hold."""
    back_to_owner(s)
    s.conn.execute("update public.entitlement_keys set default_value = '10' where key = 'concurrency'")
    s.conn.execute("update public.plan_entitlements set value = '10' where key = 'concurrency'")


def project_of_length(s, tenant, seconds: float) -> str:
    """A project of `tenant`'s organization whose saved revision is `seconds` long (a title that lasts that long)."""
    d = doc(VIDEO[tenant.key])
    d["tracks"][1]["clips"][0]["end_s"] = seconds
    become(s, tenant.actor)
    pid = str(s.value(CREATE, [tenant.org, f"Long {uuid.uuid4().hex[:6]}", json.dumps(d)]))
    back_to_owner(s)
    return pid


def render_asset(s, org: str) -> str:
    become(s, SERVICE)
    aid = s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 10, %s, 'render') ->> 'id'",
                  [org, uuid.uuid4().hex + uuid.uuid4().hex])
    back_to_owner(s)
    return aid


def claim(s, worker: str = "w-hires"):
    become(s, SERVICE)
    rows = s.rows(CLAIM, [worker])
    back_to_owner(s)
    return rows


def finish(s, eid, asset, reason, worker: str = "w-hires"):
    become(s, SERVICE)
    out = s.value(FINISH, [eid, worker, asset, reason])
    back_to_owner(s)
    return out


# ── nothing is sold on apply ────────────────────────────────────────────────

def test_the_file_seeds_no_price_and_every_paid_request_is_refused(conn, sc):
    with as_superuser(conn, commit=False) as s:
        assert s.rows("select credits_per_minute_1440p, credits_per_minute_2160p from public.editor_export_hires_prices") == [(None, None)]
        clear(s, sc.bob.org)
        before = account(s, sc.bob.org)
        outs = []
        for f in PAID:
            become(s, sc.bob.actor)
            outs.append(s.run(REQ4, [PROJECT["b"], 1, f, 100000]))
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [PROJECT["b"], 1, "youtube_2160p"])
        assert exports_of(s, sc.bob.org) == 0 and account(s, sc.bob.org) == before
    for out in outs:
        assert refused(out, "NS403", "not_on_sale"), out
    assert q["on_sale"] is False and q["credits"] is None and q["credits_per_minute"] is None and q["paid"] is True, q


def test_a_price_on_one_tier_does_not_sell_the_other(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 3, None)
        become(s, sc.bob.actor)
        ok = s.run(REQ4, [PROJECT["b"], 1, "youtube_1440p", 3])
        no = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 100])
    assert ok.ok and refused(no, "NS403", "not_on_sale"), (ok, no)


# ── the price, the hold ─────────────────────────────────────────────────────

def test_a_paid_export_holds_exactly_the_quote_started_at_once(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 4.5, 12.25)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [PROJECT["b"], 1, "vertical_2160p"])
        eid = s.value(REQ4, [PROJECT["b"], 1, "vertical_2160p", q["credits"]])
        r = row(s, eid)
        h = hold(s, eid)
        after = account(s, sc.bob.org)
        led = ledger(s, eid)
    # 6 s of video is ONE started minute.
    assert (q["tier"], q["minutes"], float(q["credits"]), float(q["credits_per_minute"]), q["max_s"]) == ("2160p", 1, 12.25, 12.25, 180), q
    assert q["too_long"] is False and q["on_sale"] is True and q["may_pay"] is True and q["exempt"] is False
    assert float(q["available"]) == bal - res
    assert float(q["hold"]) == 12.25, q                # no job_minimum in the lab: the hold is the charge
    assert r == ("queued", None, "vertical_2160p", 12.25, f"ee:{eid}", None), r
    assert h == ("open", 12.25, True, None), h          # started: reserve_credits' 3-hour sweep of unstarted holds cannot take it
    assert after == (bal, res + 12.25)
    assert led == [("reserve", 12.25)]


@pytest.mark.parametrize("seconds,minutes", [(6, 1), (60, 1), (60.001, 2), (61, 2), (179.5, 3), (180, 3), (240, 4), (300, 5)])
def test_the_price_is_per_started_minute(conn, sc, seconds, minutes):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 2.5, 7)
        pid = project_of_length(s, sc.bob, seconds)
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [pid, 1, "youtube_1440p"])
        eid = s.value(REQ4, [pid, 1, "youtube_1440p", q["credits"]])
        r = row(s, eid)
    assert q["minutes"] == minutes and float(q["credits"]) == 2.5 * minutes, q
    assert r[3] == 2.5 * minutes


def test_with_job_minimum_30_the_charge_is_the_price_and_the_hold_is_30_and_done_captures_only_the_charge(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 2, 4)
        job_minimum(s, 30)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [PROJECT["b"], 1, "youtube_2160p"])
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_2160p", q["credits"]])     # the person confirms the CHARGE, not the hold
        r, hd, h, during = row(s, eid), held(s, eid), hold(s, eid), account(s, sc.bob.org)
        claim(s)
        first = finish(s, eid, render_asset(s, sc.bob.org), None)
        again = finish(s, eid, None, "late")
        r2, h2, after, led = row(s, eid), hold(s, eid), account(s, sc.bob.org), ledger(s, eid)
    assert (float(q["credits"]), float(q["hold"]), q["minutes"]) == (4.0, 30.0, 1), q
    assert r[3] == 4.0 and hd == 30.0, (r, hd)
    assert h == ("open", 30.0, True, None), h
    assert during == (bal, res + 30)
    assert (first, again) == ("done", "done")
    assert r2[0] == "done" and r2[5] == 4.0, r2
    assert h2 == ("captured", 30.0, True, 4.0), h2
    assert after == (bal - 4, res)
    assert led == [("reserve", 30.0), ("capture", -4.0), ("release", 26.0)], led


def test_with_job_minimum_30_a_failure_gives_the_whole_hold_back(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 2, 4)
        job_minimum(s, 30)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 2])
        claim(s)
        finish(s, eid, None, "render_failed")
        r, after, led = row(s, eid), account(s, sc.bob.org), ledger(s, eid)
    assert r[:2] == ("failed", "render_failed") and r[5] == 0.0, r
    assert after == (bal, res)
    assert led == [("reserve", 30.0), ("release", 30.0)], led


def test_with_job_minimum_30_the_hold_decides_whether_there_are_enough_credits(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        bal, res = account(s, sc.bob.org)
        avail = bal - res
        price(s, 1, 1)
        job_minimum(s, avail + 1)                        # the charge (1) fits; the hold (job_minimum) does not
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [PROJECT["b"], 1, "youtube_1440p"])
        out = s.run(REQ4, [PROJECT["b"], 1, "youtube_1440p", 1])
        written = exports_of(s, sc.bob.org)
        after = account(s, sc.bob.org)
    assert float(q["credits"]) == 1.0 and float(q["hold"]) == float(f"{avail + 1:.2f}") and float(q["available"]) == avail, q
    assert refused(out, "NS402", "insufficient_credits"), out
    assert written == 0 and after == (bal, res)


@pytest.mark.parametrize("confirmed", [float("nan"), float("inf"), float("-inf"), -1, 10 ** 9])
def test_a_confirmed_number_that_is_not_a_finite_amount_is_refused(conn, sc, confirmed):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        before = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        out = s.run(REQ4, [PROJECT["b"], 1, "youtube_1440p", confirmed])
        written = exports_of(s, sc.bob.org)
        after = account(s, sc.bob.org)
    assert refused(out, "NS409", "price_changed"), out
    assert written == 0 and after == before


def test_a_higher_price_than_confirmed_is_refused_and_a_lower_one_holds_the_lower(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 5, 10)
        become(s, sc.bob.actor)
        low = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 9.99])
        none = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", None])
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_2160p", 1000])
        h = hold(s, eid)
    assert refused(low, "NS409", "price_changed") and refused(none, "NS409", "price_changed"), (low, none)
    assert written == 0
    assert h[1] == 10.0, h                               # the database's price, not the caller's ceiling


def test_too_few_credits_roll_the_whole_request_back(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        bal, res = account(s, sc.bob.org)
        price(s, None, bal - res + 1)                    # one credit more than the organization has available
        become(s, sc.bob.actor)
        out = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 10 ** 7])
        written = exports_of(s, sc.bob.org)
        holds = s.value("select count(*) from public.credit_reservations where job_id like 'ee:%%' and org_id = %s", [sc.bob.org])
        after = account(s, sc.bob.org)
    assert refused(out, "NS402", "insufficient_credits"), out
    assert (written, holds, after) == (0, 0, (bal, res))


def test_a_held_paid_export_is_a_run_in_progress_and_the_plans_limit_refuses_the_next_with_a_word(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        s.conn.execute("update public.entitlement_keys set default_value = '1' where key = 'concurrency'")
        s.conn.execute("update public.plan_entitlements set value = '1' where key = 'concurrency'")
        open_ = s.value("select count(*) from public.credit_reservations where org_id = %s and status = 'open'", [sc.bob.org])
        before = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        out = s.run(REQ4, [PROJECT["b"], 1, "youtube_1440p", 10])
        written = exports_of(s, sc.bob.org)
        after = account(s, sc.bob.org)
    assert open_ >= 1                                   # the seed's own open hold already takes the one run
    assert refused(out, "NS429", "parallel_runs"), out
    assert written == 0 and after == before


def test_two_paid_exports_hold_twice_and_the_second_size_waits_beside_the_first(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 3, 6)
        many_parallel_runs(s)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 3])
        s.value(REQ4, [PROJECT["b"], 1, "vertical_2160p", 6])
        again = s.run(REQ4, [PROJECT["b"], 1, "youtube_1440p", 3])     # the same size of the same project twice
        after = account(s, sc.bob.org)
    assert refused(again, "NS409", "export_in_progress"), again
    assert after == (bal, res + 9)


# ── settling: every ending, once ────────────────────────────────────────────

def test_done_captures_the_quote_once(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 4, 8)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_2160p", 8])
        claimed = claim(s)
        asset = render_asset(s, sc.bob.org)
        first = finish(s, eid, asset, None)
        second = finish(s, eid, asset, None)
        third = finish(s, eid, None, "late")
        r, h, after, led = row(s, eid), hold(s, eid), account(s, sc.bob.org), ledger(s, eid)
    assert claimed == [(str(eid), "rendering", None)], claimed
    assert (first, second, third) == ("done", "done", "done")
    assert r[0] == "done" and r[5] == 8.0, r
    assert h == ("captured", 8.0, True, 8.0), h
    assert after == (bal - 8, res)
    assert led == [("reserve", 8.0), ("capture", -8.0)], led


@pytest.mark.parametrize("reason", ["timed_out", "render_failed", "hires_off", "hires_fps", "store_failed", "invalid_timeline"])
def test_a_failed_render_releases_the_whole_hold_once(conn, sc, reason):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 4, 8)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_2160p", 8])
        claim(s)
        first = finish(s, eid, None, reason)
        again = finish(s, eid, None, reason)
        r, h, after, led = row(s, eid), hold(s, eid), account(s, sc.bob.org), ledger(s, eid)
    assert (first, again) == ("failed", "failed")
    assert r[:2] == ("failed", reason) and r[5] == 0.0, r
    assert h[0] == "released" and h[3] is None, h
    assert after == (bal, res)
    assert led == [("reserve", 8.0), ("release", 8.0)], led


def test_a_done_export_marked_failed_by_hand_keeps_its_charge(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 2, 4)
        job_minimum(s, 30)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_2160p", 4])
        claim(s)
        finish(s, eid, render_asset(s, sc.bob.org), None)
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where id = %s", [eid])
        r, h, after, led = row(s, eid), hold(s, eid), account(s, sc.bob.org), ledger(s, eid)
    assert r[0] == "failed" and r[5] == 4.0, r                 # what the ledger charged, not 0
    assert h == ("captured", 30.0, True, 4.0), h
    assert after == (bal - 4, res)
    assert led == [("reserve", 30.0), ("capture", -4.0), ("release", 26.0)], led


def test_a_deleted_project_releases_its_waiting_paid_export(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 4, 8)
        bal, res = account(s, sc.bob.org)
        pid = project_of_length(s, sc.bob, 30)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [pid, 1, "youtube_1440p", 4])
        s.value("select public.delete_editor_project(%s)", [pid])
        r, h, after = row(s, eid), hold(s, eid), account(s, sc.bob.org)
    assert r[:2] == ("failed", "project_deleted") and r[5] == 0.0, r
    assert h[0] == "released" and after == (bal, res)


def test_a_lost_worker_releases_after_the_last_attempt(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 4, 8)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 4])
        states = []
        for _ in range(3):
            claim(s)
            s.conn.execute("update public.editor_exports set heartbeat_at = now() - interval '16 minutes' where id = %s", [eid])
            states.append((row(s, eid)[0], hold(s, eid)[0]))
        claim(s)                                         # the sweep: three attempts, so it ends as worker_lost
        r, h, after = row(s, eid), hold(s, eid), account(s, sc.bob.org)
    # Handed out again while attempts remain: the hold stays open across a lost worker.
    assert states == [("rendering", "open")] * 3, states
    assert r[:2] == ("failed", "worker_lost") and r[5] == 0.0, r
    assert h[0] == "released" and after == (bal, res)


@pytest.mark.parametrize("how", ["released by hand", "expired"])
def test_a_hold_that_is_gone_when_the_worker_takes_the_export_ends_it_and_charges_nothing(conn, sc, how):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 4, 8)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_2160p", 8])
        back_to_owner(s)
        if how == "released by hand":
            s.value("select public.release_credits(%s)", [f"ee:{eid}"])
        else:
            s.conn.execute("update public.credit_reservations set started_at = now() - interval '25 hours' where job_id = %s", [f"ee:{eid}"])
            s.value("select public.expire_credit_reservations(%s)", [sc.bob.org])
        claimed = claim(s)
        asset = render_asset(s, sc.bob.org)
        late = finish(s, eid, asset, None)               # a worker that rendered anyway cannot turn it into a charge
        r, h, after = row(s, eid), hold(s, eid), account(s, sc.bob.org)
    assert claimed == [(str(eid), "failed", "credits_released")], claimed
    assert late == "failed"
    assert r[:2] == ("failed", "credits_released") and r[5] == 0.0, r
    assert h[0] == "released" and after == (bal, res)


def test_a_free_export_touches_no_credit_whatever_happens_to_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 4, 8)
        before = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        e3 = s.value(REQ3, [PROJECT["b"], 1, "vertical_1080p"])
        claim(s)
        finish(s, e3, render_asset(s, sc.bob.org), None)
        r = row(s, e3)
        after = account(s, sc.bob.org)
        n = s.value("select count(*) from public.credit_transactions where job_id = 'ee:' || %s::text", [e3])
    assert r == ("done", None, "vertical_1080p", None, None, None), r
    assert after == before and n == 0


# ── the caps and the limits ─────────────────────────────────────────────────

@pytest.mark.parametrize("frame,cap", [("youtube_1440p", 300), ("vertical_1440p", 300), ("youtube_2160p", 180), ("vertical_2160p", 180)])
def test_a_paid_export_longer_than_its_tier_is_refused_and_writes_nothing(conn, sc, frame, cap):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        at = project_of_length(s, sc.bob, cap)
        over = project_of_length(s, sc.bob, cap + 0.001)
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [over, 1, frame])
        refusal = s.run(REQ4, [over, 1, frame, 1000])
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        ok = s.run(REQ4, [at, 1, frame, 1000])
    assert q["too_long"] is True and q["max_s"] == cap, q
    assert refused(refusal, "NS400", "hires_too_long"), refusal
    assert written == 0 and ok.ok, ok


def test_4k_is_refused_for_a_project_faster_than_30_fps_and_1440p_is_not(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        many_parallel_runs(s)
        d = doc(VIDEO["b"])
        d["fps"] = 60
        become(s, sc.bob.actor)
        pid = str(s.value(CREATE, [sc.bob.org, "Sixty", json.dumps(d)]))
        q4 = s.value(QUOTE, [pid, 1, "vertical_2160p"])
        q2 = s.value(QUOTE, [pid, 1, "vertical_1440p"])
        out4 = s.run(REQ4, [pid, 1, "vertical_2160p", 100])
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        out2 = s.run(REQ4, [pid, 1, "vertical_1440p", 100])
        back_to_owner(s)
        # The table itself: a 4K row of a 60 fps document is refused even by the owner's hand.
        hand = s.run("update public.editor_exports set frame_preset = 'youtube_2160p', frame_width = 3840, frame_height = 2160 "
                     "where id = %s", [out2.rows[0][0]] if out2.ok else [None])
    assert (q4["too_fast"], q4["max_fps"], float(q4["fps"])) == (True, 30, 60.0), q4
    assert (q2["too_fast"], q2["max_fps"]) == (False, 60), q2
    assert refused(out4, "NS400", "hires_fps") and written == 0, out4
    assert out2.ok, out2
    assert refused(hand, "23514"), hand


def test_the_table_itself_refuses_a_paid_frame_without_a_quote_or_past_its_cap(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 10])
        back_to_owner(s)
        # As the owner's hand: a charge of 10 and a hold of 10, so that each change below breaks exactly one rule of the CHECK.
        s.conn.execute("update public.editor_exports set quoted_credits = 10, held_credits = 10 where id = %s", [eid])
        outs = [
            # Each change alone breaks exactly one rule (the money columns move together, so a rule is never hidden by another).
            s.run("update public.editor_exports set quoted_credits = null, held_credits = null, credit_ref = null where id = %s", [eid]),
            s.run("update public.editor_exports set duration_s = 300.001 where id = %s", [eid]),
            s.run("update public.editor_exports set frame_preset = 'youtube_2160p', frame_width = 3840, frame_height = 2160, "
                  "duration_s = 181 where id = %s", [eid]),
            s.run("update public.editor_exports set credit_ref = 'ee:' || gen_random_uuid() where id = %s", [eid]),
            s.run("update public.editor_exports set charged_credits = 11 where id = %s", [eid]),
            s.run("update public.editor_exports set quoted_credits = -1, held_credits = null, credit_ref = null where id = %s", [eid]),
            s.run("update public.editor_exports set held_credits = null where id = %s", [eid]),            # a hold without its amount
            s.run("update public.editor_exports set held_credits = 9.99 where id = %s", [eid]),            # a hold below the charge
            s.run("update public.editor_exports set frame_width = 4096, frame_height = 2160 where id = %s", [eid]),
        ]
        fine = s.run("update public.editor_exports set frame_preset = 'youtube_2160p', frame_width = 3840, frame_height = 2160, "
                     "duration_s = 180 where id = %s", [eid])
    for out in outs:
        assert refused(out, "23514"), out
    assert fine.ok, fine


def test_each_paid_export_is_one_of_the_three_in_flight_and_the_twenty_a_day(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        many_parallel_runs(s)
        become(s, sc.bob.actor)
        s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 1])
        s.value(REQ4, [PROJECT["b"], 1, "vertical_1440p", 1])
        s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        fourth = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 1])
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s", [sc.bob.org])
        for _ in range(17):
            s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, status, requested_by) "
                           "values (%s, %s, 1, '{}'::jsonb, 1, 'failed', gen_random_uuid())", [sc.bob.org, PROJECT["b"]])
        before = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        daily = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 1])
        after = account(s, sc.bob.org)
    assert refused(fourth, "NS409", "export_in_progress"), fourth
    assert refused(daily, "NS429", "daily_limit"), daily
    assert after == before                                # a refused request holds nothing


# ── above 1080p is never free; a speed curve is not sold ───────────────────

@pytest.mark.parametrize("w,h,fps", [(3840, 2160, 60), (2160, 3840, 30), (2560, 1440, 30), (1920, 1082, 30)])
def test_a_project_whose_own_frame_is_above_1080p_is_not_exported_free(conn, sc, w, h, fps):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        many_parallel_runs(s)
        before = account(s, sc.bob.org)
        pid = project_with(s, sc.bob, width=w, height=h, fps=fps)
        become(s, sc.bob.actor)
        plain = s.run(REQ2, [pid, 1])
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        small = s.run(REQ3, [pid, 1, "youtube_1080p"])                  # a free frame of it: 1080p, downscaled, still free
        after = account(s, sc.bob.org)
    assert refused(plain, "NS400", "hires_needs_paid_export"), plain
    assert written == 0
    assert small.ok and after == before, small


def test_a_4k_project_is_exported_in_its_size_through_the_paid_overload(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 3)
        pid = project_with(s, sc.bob, width=3840, height=2160, fps=30)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [pid, 1, "youtube_2160p", 3])
        r, h = row(s, eid), hold(s, eid)
    assert r[:3] == ("queued", None, "youtube_2160p") and r[3] == 3.0 and h[0] == "open", (r, h)


def test_a_1080p_project_is_still_exported_free_by_the_plain_request(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        before = account(s, sc.bob.org)
        pid = project_with(s, sc.bob, width=1920, height=1080, fps=60)
        become(s, sc.bob.actor)
        eid = s.value(REQ2, [pid, 1])
        r, after = row(s, eid), account(s, sc.bob.org)
    assert r == ("queued", None, None, None, None, None) and after == before, r


def test_a_document_with_a_speed_curve_is_not_sold_and_its_free_export_is_unchanged(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        many_parallel_runs(s)
        before = account(s, sc.bob.org)
        d = doc(VIDEO["b"])
        d["tracks"][0]["clips"][0]["speed_curve"] = [{"at": 0, "speed": 0.25}, {"at": 1, "speed": 0.25}]
        become(s, sc.bob.actor)
        pid = str(s.value(CREATE, [sc.bob.org, "Curve", json.dumps(d)]))
        q = s.value(QUOTE, [pid, 1, "youtube_1440p"])
        q_plain = s.value(QUOTE, [PROJECT["b"], 1, "youtube_1440p"])
        out = s.run(REQ4, [pid, 1, "youtube_1440p", 100])
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        free = s.run(REQ3, [pid, 1, "vertical_1080p"])
        after = account(s, sc.bob.org)
    assert q["speed_curve"] is True and q_plain["speed_curve"] is False, (q, q_plain)
    assert refused(out, "NS400", "hires_speed_curve"), out
    assert written == 0
    assert free.ok and after == before, free


# ── who may ask ─────────────────────────────────────────────────────────────

def test_a_free_frame_is_not_sold_here_and_a_paid_one_is_not_free_there(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        outs4 = []
        for f in FREE + ["project", "", None, "YOUTUBE_2160P", "3840x2160", "youtube_4k"]:
            become(s, sc.bob.actor)
            outs4.append((f, s.run(REQ4, [PROJECT["b"], 1, f, 100])))
        outs3 = []
        for f in PAID:
            become(s, sc.bob.actor)
            outs3.append((f, s.run(REQ3, [PROJECT["b"], 1, f])))
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        free_q = s.value(QUOTE, [PROJECT["b"], 1, "vertical_1080p"])
    for f, out in outs4:
        assert refused(out, "NS400", "invalid_frame"), (f, out)
    for f, out in outs3:
        assert refused(out, "NS400", "hires_needs_paid_export"), (f, out)
    assert written == 0
    assert free_q == {"frame": "vertical_1080p", "width": 1080, "height": 1920, "paid": False, "duration_s": 6.0}, free_q


def test_a_viewer_may_export_for_free_but_not_spend_and_an_editor_may(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.alice.org)
        price(s, 1, 1)
        many_parallel_runs(s)
        seat_invitee(s, sc)
        become(s, sc.invitee)
        q = s.value(QUOTE, [PROJECT["a"], 1, "youtube_1440p"])
        paid = s.run(REQ4, [PROJECT["a"], 1, "youtube_1440p", 10])
        free = s.run(REQ3, [PROJECT["a"], 1, "vertical_1080p"])
        back_to_owner(s)
        s.conn.execute("update public.org_members set role = 'editor' where org_id = %s and user_id = %s", [sc.alice.org, sc.invitee.uid])
        become(s, sc.invitee)
        q2 = s.value(QUOTE, [PROJECT["a"], 1, "youtube_1440p"])
        as_editor = s.run(REQ4, [PROJECT["a"], 1, "youtube_1440p", 10])
    assert q["may_pay"] is False and q2["may_pay"] is True, (q, q2)
    assert refused(paid, "42501", "forbidden") and free.ok, (paid, free)
    assert as_editor.ok, as_editor


@pytest.mark.parametrize("who_name", ["alice", "stranger", "dana"])
def test_another_organizations_project_reads_as_missing_to_the_quote_and_the_request(conn, sc, who_name):
    who = {"alice": sc.alice.actor, "stranger": sc.stranger, "dana": sc.dana}[who_name]
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        become(s, who)
        outs = [s.run(QUOTE, [PROJECT["b"], 1, "youtube_2160p"]), s.run(QUOTE, [PROJECT["b"], 1, "not-a-frame"]),
                s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 100]), s.run(REQ4, [PROJECT["b"], 1, "nope", 100])]
        written = exports_of(s, sc.bob.org)
    for out in outs:
        assert refused(out, "P0002", "not_found"), (who_name, out)
    assert written == 0


@pytest.mark.parametrize("who_name", ["anon", "service"])
def test_the_anon_key_and_the_service_role_reach_neither_function(conn, sc, who_name):
    who = {"anon": ANON, "service": SERVICE}[who_name]
    with acting(conn, who) as s:
        outs = [s.run(QUOTE, [PROJECT["b"], 1, "youtube_2160p"]), s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 100])]
    for out in outs:
        assert refused(out, "42501"), (who_name, out)


def test_the_exempt_organization_needs_a_platform_admin_and_holds_nothing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, DEFAULT_ORG)
        price(s, 2, 4)
        d = doc(VIDEO["a"])
        # A file of the exempt organization for its project (the document names its own organization's files only).
        become(s, SERVICE)
        vid = s.value("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 1000, %s, 'generated', p_duration_s => 20) "
                      "->> 'id'", [DEFAULT_ORG, uuid.uuid4().hex * 2])
        d["tracks"][0]["clips"][0]["asset_id"] = vid
        become(s, sc.operator)
        pid = s.value(CREATE, [DEFAULT_ORG, "Operator edit", json.dumps(d)])
        q = s.value(QUOTE, [pid, 1, "youtube_2160p"])
        eid = s.value(REQ4, [pid, 1, "youtube_2160p", q["credits"]])
        r = row(s, eid)
        held_exempt = held(s, eid)
        holds = s.value("select count(*) from public.credit_reservations where job_id = 'ee:' || %s::text", [eid])
        # Dana is a member of the exempt organization and not a platform admin: even as its editor she may not spend there.
        s.conn.execute("update public.org_members set role = 'editor' where org_id = %s and user_id = %s", [DEFAULT_ORG, sc.dana.uid])
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where id = %s", [eid])
        become(s, sc.dana)
        dq = s.value(QUOTE, [pid, 1, "youtube_2160p"])
        dana = s.run(REQ4, [pid, 1, "youtube_2160p", 100])
        free = s.run(REQ3, [pid, 1, "vertical_1080p"])
    assert q["exempt"] is True and q["available"] is None and float(q["credits"]) == 4.0 and q["may_pay"] is True, q
    assert r == ("queued", None, "youtube_2160p", 4.0, None, None), r
    assert held_exempt is None
    assert holds == 0
    assert dq["may_pay"] is False and refused(dana, "42501", "forbidden") and free.ok, (dq, dana, free)


def test_no_api_role_writes_the_credit_columns(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 1])
        outs = []
        for who in (sc.bob.actor, sc.alice.actor, ANON, SERVICE):
            become(s, who)
            outs.append(s.run("update public.editor_exports set quoted_credits = 0, charged_credits = 0 where id = %s", [eid]))
            outs.append(s.run("update public.editor_exports set status = 'done' where id = %s", [eid]))
        r = row(s, eid)
    for out in outs:
        assert refused(out, "42501"), out
    assert r[0] == "queued" and r[3] == 1.0


# ── the owner's prices ──────────────────────────────────────────────────────

@pytest.mark.parametrize("who_name", ["bob", "operator", "anon", "service"])
def test_no_api_role_reads_or_writes_the_prices(conn, sc, who_name):
    who = {"bob": sc.bob.actor, "operator": sc.operator, "anon": ANON, "service": SERVICE}[who_name]
    with acting(conn, who) as s:
        outs = [s.run("select * from public.editor_export_hires_prices"),
                s.run("update public.editor_export_hires_prices set credits_per_minute_2160p = 0.01"),
                s.run("insert into public.editor_export_hires_prices (id) values (false)"),
                s.run("delete from public.editor_export_hires_prices"),
                s.run("select public.editor_export_hires_terms(3840, 2160, 60)"),
                s.run("select public.editor_export_money('release', 'ee:x', null)")]
    for out in outs:
        assert refused(out, "42501"), (who_name, out)


def test_a_price_change_leaves_a_security_event_and_the_row_cannot_be_removed(conn, sc):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        n0 = s.value("select count(*) from public.security_events where kind = 'editor.export.hires_price'")
        price(s, 3, 9)
        price(s, 3, 9)                                   # no change, no event
        ev = s.rows("select severity, target, detail from public.security_events where kind = 'editor.export.hires_price' "
                    "order by id desc limit 1")
        n1 = s.value("select count(*) from public.security_events where kind = 'editor.export.hires_price'")
        gone = s.run("delete from public.editor_export_hires_prices")
        emptied = s.run("truncate public.editor_export_hires_prices")
        bad = [s.run("update public.editor_export_hires_prices set credits_per_minute_1440p = %s", [v]) for v in (0, -1, 10001, 0.001)]
        second = s.run("insert into public.editor_export_hires_prices (id) values (false)")
        back = s.run("update public.editor_export_hires_prices set credits_per_minute_1440p = null, credits_per_minute_2160p = null")
    assert n1 == n0 + 1
    assert ev[0][0] == "warning" and ev[0][1] == "editor_export_hires_prices", ev
    assert ev[0][2] == {"credits_per_minute_1440p": [None, 3], "credits_per_minute_2160p": [None, 9]}, ev
    assert refused(gone, "42501") and refused(emptied, "42501"), (gone, emptied)
    for out in bad:
        assert refused(out, "23514"), out
    assert refused(second, "23514") and back.ok, (second, back)


# ── the older functions ─────────────────────────────────────────────────────

def test_the_free_functions_are_0132s_bodies_and_keep_their_answers_up_to_1080p(conn, sc):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        hashes = s.rows("select pg_get_function_identity_arguments(oid), md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc "
                        "where proname = 'request_editor_export' and pronamespace = 'public'::regnamespace order by 1")
        clear(s, sc.bob.org)
        price(s, 1, 1)
        become(s, sc.bob.actor)
        e2 = s.value(REQ2, [PROJECT["b"], 1])
        busy = s.run(REQ3, [PROJECT["b"], 1, "youtube_1080p"])      # the project's own size while its plain export is in flight
        e3 = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        r2, r3 = row(s, e2), row(s, e3)
    assert hashes[:2] == [("p_project uuid, p_rev integer", _pinned("req2")),
                          ("p_project uuid, p_rev integer, p_frame text", _pinned("req3"))], hashes
    assert refused(busy, "NS409", "export_in_progress")
    assert r2 == ("queued", None, None, None, None, None) and r3 == ("queued", None, "square_1080", None, None, None), (r2, r3)


def test_the_grants_are_the_files(conn):
    with as_superuser(conn, commit=False) as s:
        rows = s.rows(
            "select p.oid::regprocedure::text, p.prosecdef, has_function_privilege('authenticated', p.oid, 'EXECUTE'), "
            "has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('service_role', p.oid, 'EXECUTE'), "
            "has_function_privilege('public', p.oid, 'EXECUTE') from pg_proc p where p.pronamespace = 'public'::regnamespace "
            "and p.proname in ('request_editor_export', 'quote_editor_export', 'editor_export_hires_terms', 'editor_export_money', "
            "'editor_export_settle', 'editor_export_frame', 'editor_export_hires_prices_guard', 'editor_export_hires_prices_trail') order by 1")
    got = {r[0]: r[1:] for r in rows}
    assert got == {
        "editor_export_frame(text)": (False, False, False, False, False),
        "editor_export_hires_prices_guard()": (False, False, False, False, False),
        "editor_export_hires_prices_trail()": (True, False, False, False, False),
        "editor_export_hires_terms(integer,integer,numeric)": (False, False, False, False, False),
        "editor_export_money(text,text,numeric)": (True, False, False, False, False),
        "editor_export_settle()": (True, False, False, False, False),
        "quote_editor_export(uuid,integer,text)": (True, True, False, False, False),
        "request_editor_export(uuid,integer)": (True, True, False, False, False),
        "request_editor_export(uuid,integer,text)": (True, True, False, False, False),
        "request_editor_export(uuid,integer,text,numeric)": (True, True, False, False, False),
    }, got


# ── concurrency ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def race():
    from sec_editor_0054 import register
    from sec_scenario import _create_org, _signup

    dsn = sec_db.admin_dsn()
    name = f"ns_security_hires_race_{uuid.uuid4().hex[:8]}"
    db = sec_db.build(dsn, name)
    c = psycopg.connect(db, autocommit=True)
    try:
        who = sec_db.user("racer", f"racer-{uuid.uuid4().hex[:6]}@example.com")
        _signup(c, who)
        org = _create_org(c, who, "Race org")
        video = register(c, org, "race-video")
        projects = []
        with acting(c, who, commit=True) as s:
            for i in range(2):
                projects.append(str(s.value(CREATE, [org, f"Race {i}", json.dumps(doc(video))])))
        with as_superuser(c) as s:
            many_parallel_runs(s)
            avail = float(s.value("select coalesce((select balance - reserved from public.credit_accounts where org_id = %s), 0)", [org]))
            if avail < 2:
                s.value("select public.grant_credits(%s, 10, 'race')", [org])
                avail = float(s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org]))
            # One export fits, two do not.
            s.conn.execute("update public.editor_export_hires_prices set credits_per_minute_2160p = %s", [round(avail * 0.6, 2)])
        yield {"dsn": db, "conn": c, "who": who, "org": org, "projects": projects}
    finally:
        c.close()
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, name)


def _session(dsn: str, who) -> psycopg.Connection:
    c = psycopg.connect(dsn)
    c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    c.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    c.execute(f"set local role {who.role}")
    return c


def test_two_paid_requests_at_once_with_credits_for_one_hold_exactly_one(race):
    barrier = threading.Barrier(2)
    out = [None, None]

    def one(i):
        c = _session(race["dsn"], race["who"])
        try:
            barrier.wait()
            try:
                v = c.execute(REQ4, [race["projects"][i], 1, "youtube_2160p", 10 ** 7]).fetchone()[0]
                time.sleep(0.4)
                c.commit()
                out[i] = ("ok", v)
            except psycopg.Error as e:
                c.rollback()
                out[i] = (e.sqlstate, str(e).splitlines()[0])
        finally:
            c.close()

    threads = [threading.Thread(target=one, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    with as_superuser(race["conn"], commit=False) as s:
        held = s.value("select coalesce(sum(amount), 0)::float from public.credit_reservations where org_id = %s and status = 'open'",
                       [race["org"]])
        one = float(s.value("select credits_per_minute_2160p from public.editor_export_hires_prices"))
        n = s.value("select count(*) from public.editor_exports where org_id = %s", [race["org"]])
    assert sorted(o[0] for o in out) == ["NS402", "ok"], out
    assert held == one and n == 1, (held, one, n)


def test_two_paid_requests_at_once_see_each_other_under_the_organizations_lock(race):
    """With two exports already in flight, two paid requests of two projects at once: exactly one is the third, the other is refused.
    Without the organization's advisory lock both would count two and both would be queued (four in flight)."""
    with as_superuser(race["conn"]) as s:
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s", [race["org"]])
        s.value("select public.grant_credits(%s, 1000, 'race')", [race["org"]])
        s.conn.execute("update public.editor_export_hires_prices set credits_per_minute_1440p = 1")
        for pid in race["projects"]:
            s.conn.execute("insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, status, requested_by) "
                           "values (%s, %s, 1, '{}'::jsonb, 1, 'queued', gen_random_uuid())", [race["org"], pid])
    barrier = threading.Barrier(2)
    out = [None, None]

    def one(i):
        c = _session(race["dsn"], race["who"])
        try:
            barrier.wait()
            try:
                v = c.execute(REQ4, [race["projects"][i], 1, "youtube_1440p", 100]).fetchone()[0]
                time.sleep(0.4)
                c.commit()
                out[i] = ("ok", v)
            except psycopg.Error as e:
                c.rollback()
                out[i] = (e.sqlstate, str(e).splitlines()[0])
        finally:
            c.close()

    threads = [threading.Thread(target=one, args=(i,)) for i in range(2)]
    for t_ in threads:
        t_.start()
    for t_ in threads:
        t_.join(30)
    with as_superuser(race["conn"]) as s:
        busy = s.value("select count(*) from public.editor_exports where org_id = %s and status in ('queued', 'rendering')", [race["org"]])
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s and status in ('queued', 'rendering')",
                       [race["org"]])
    assert sorted(o[0] for o in out) == ["NS409", "ok"], out
    assert busy == 3, busy


@pytest.mark.parametrize("free", ["two-argument", "three-argument"])
def test_a_free_and_a_paid_request_of_one_project_at_once_never_deadlock(race, free):
    """The three overloads take the project's row and then the organization's lock, in that order. A paid request that took them the
    other way round deadlocked against a free one of the same project (40P01, five times in forty rounds in review). Many rounds of the
    two at once, each rolled back: none may end in a deadlock, and each ends as queued or as one of the export's own refusals."""
    with as_superuser(race["conn"]) as s:
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s and status in ('queued', 'rendering')",
                       [race["org"]])
        s.value("select public.grant_credits(%s, 1000, 'race')", [race["org"]])
        s.conn.execute("update public.editor_export_hires_prices set credits_per_minute_1440p = 1")
    pid = race["projects"][0]
    sql = (REQ2, [pid, 1]) if free == "two-argument" else (REQ3, [pid, 1, "square_1080"])
    outcomes = []
    for _ in range(60):
        barrier = threading.Barrier(2)
        out = [None, None]

        def one(i, stmt, args):
            c = _session(race["dsn"], race["who"])
            try:
                barrier.wait()
                try:
                    c.execute(stmt, args).fetchone()
                    time.sleep(0.01)
                    out[i] = "ok"
                except psycopg.Error as e:
                    out[i] = e.sqlstate
                c.rollback()
            finally:
                c.close()

        threads = [threading.Thread(target=one, args=(0, *sql)),
                   threading.Thread(target=one, args=(1, REQ4, [pid, 1, "youtube_1440p", 100]))]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(30)
        outcomes.extend(out)
    assert "40P01" not in outcomes, outcomes
    assert set(outcomes) <= {"ok", "NS409"}, outcomes
    assert outcomes.count("ok") >= 60, outcomes                 # each round queued at least one of the two


def test_a_paid_request_of_a_revision_saved_over_is_refused_under_the_row_lock(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price(s, 1, 1)
        pid = project_of_length(s, sc.bob, 6)
        become(s, sc.bob.actor)
        before = s.value("select rev from public.editor_projects where id = %s", [pid])
        s.value("select public.save_editor_project(%s, %s, %s, %s::jsonb)",
                [pid, before, "Saved again", json.dumps(s.value("select doc from public.editor_projects where id = %s", [pid]))])
        stale = s.run(REQ4, [pid, before, "youtube_1440p", 100])
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        fresh = s.run(REQ4, [pid, before + 1, "youtube_1440p", 100])
    assert refused(stale, "NS409", "stale_revision"), stale
    assert written == 0
    assert fresh.ok, fresh


# ── the file ────────────────────────────────────────────────────────────────

def _pinned(name: str) -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    return re.search(rf"oid = {name}\) <> '([0-9a-f]{{32}})'", text).group(1)


def _hash(s, sig: str):
    return s.value(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('{sig}')")


def _rollback_text() -> str:
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def drift(s, sig: str, find: str, put: str) -> None:
    src = s.value(f"select pg_get_functiondef('{sig}'::regprocedure)")
    assert src.count(find) == 1, (sig, find)
    s.conn.execute(src.replace(find, put))


def test_the_live_bodies_are_the_ones_the_file_pins(conn):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        assert _hash(s, REQ4_SIG) == _pinned("req4")
        assert _hash(s, QUOTE_SIG) == _pinned("quote")
        assert _hash(s, "public.request_editor_export(uuid, integer)") == _pinned("req2")
        assert _hash(s, "public.request_editor_export(uuid, integer, text)") == _pinned("req3")
        assert _hash(s, "public.editor_export_hires_terms(integer, integer, numeric)") == _pinned("terms")
        assert _hash(s, "public.editor_export_settle()") == _pinned("settle")
        assert _hash(s, "public.editor_export_frame(text)") == _pinned("lst")


def test_the_file_applies_twice_and_keeps_the_owners_price(conn, sc):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        clear(s, sc.bob.org)
        price(s, 3, 7)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 3])
        back_to_owner(s)
        before = (_hash(s, REQ4_SIG), _hash(s, QUOTE_SIG))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert (_hash(s, REQ4_SIG), _hash(s, QUOTE_SIG)) == before
        assert s.rows("select credits_per_minute_1440p::float, credits_per_minute_2160p::float from public.editor_export_hires_prices") == [(3.0, 7.0)]
        assert row(s, eid)[3] == 3.0 and hold(s, eid)[0] == "open"
        assert s.value("select count(*) from pg_trigger where tgname = 'editor_exports_settle'") == 1


@pytest.mark.parametrize("sig,find,put,says", [
    ("public.request_editor_export(uuid, integer)", ">= 20 then", ">= 21 then", "neither 0054's nor 0132's body"),
    ("public.request_editor_export(uuid, integer, text)", ">= 20 then", ">= 21 then", "neither 0129's nor 0132's body"),
    ("public.editor_export_frame(text)", "('square_1080', 1080, 1080)", "('square_1080', 8192, 8192)", "neither 0129's nor 0132's"),
    (REQ4_SIG, ">= 20 then", ">= 21 then", "request_editor_export(uuid, integer, text, numeric) with a body"),
    ("public.editor_export_settle()", "new.reason := 'credits_released';", "new.reason := 'credits_gone';",
     "editor_export_settle() with a body"),
])
def test_the_file_refuses_a_body_it_has_not_seen_and_changes_nothing(conn, sig, find, put, says):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        drift(s, sig, find, put)
        drifted = _hash(s, sig)
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert _hash(s, sig) == drifted
    assert (not out.ok) and says in out.error, out


def test_the_rollback_takes_it_out_and_the_file_applies_again(conn, sc):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 3, 7)
        become(s, sc.bob.actor)
        done = s.value(REQ4, [PROJECT["b"], 1, "youtube_2160p", 7])
        claim(s)
        finish(s, done, render_asset(s, sc.bob.org), None)
        led_before = ledger(s, done)
        s.conn.execute(_rollback_text())
        assert _hash(s, REQ4_SIG) is None and _hash(s, QUOTE_SIG) is None
        assert _hash(s, "public.editor_export_frame(text)") == "1bcfdbfab6526ce7d0ba07e167f5740c"
        assert s.value("select to_regclass('public.editor_export_hires_prices')") is None
        assert s.value("select count(*) from information_schema.columns where table_name = 'editor_exports' "
                       "and column_name in ('quoted_credits', 'held_credits', 'credit_ref', 'charged_credits')") == 0
        # 0054's and 0129's bodies are back, byte for byte.
        assert _hash(s, "public.request_editor_export(uuid, integer)") == "6d37b4d75092708981c28a56879c89b4"
        assert _hash(s, "public.request_editor_export(uuid, integer, text)") == "83456b3c70d9433ce0e21da1339198ad"
        # The finished 4K export stays (its frame too), the ledger keeps its money, and the frame check is 0129's, NOT VALID for it.
        assert s.rows("select status, frame_preset from public.editor_exports where id = %s", [done]) == [("done", "youtube_2160p")]
        assert [(r[0], float(r[1])) for r in s.rows("select kind, amount from public.credit_transactions where job_id = %s order by id",
                                                    [f"ee:{done}"])] == led_before
        assert s.value("select convalidated from pg_constraint where conname = 'editor_exports_frame_shape'") is False
        become(s, sc.bob.actor)
        assert refused(s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 7]), "42883")
        assert refused(s.run(REQ3, [PROJECT["b"], 1, "youtube_2160p"]), "NS400", "invalid_frame")
        back_to_owner(s)
        s.conn.execute("delete from public.editor_exports where id = %s", [done])
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert _hash(s, REQ4_SIG) == _pinned("req4")
        assert s.rows("select credits_per_minute_1440p, credits_per_minute_2160p from public.editor_export_hires_prices") == [(None, None)]
        # 0129's own rollback works once 0132 is out again (the order docs/sql/rollback_0132 asks for).
        s.conn.execute(_rollback_text())
        s.conn.execute("\n".join(ln for ln in ROLLBACK_0129.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;")))
        assert _hash(s, "public.request_editor_export(uuid, integer, text)") is None


@pytest.mark.parametrize("status", ["queued", "rendering"])
def test_the_rollback_refuses_while_a_paid_export_is_in_flight(conn, sc, status):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        clear(s, sc.bob.org, sc.alice.org)
        price(s, 3, 7)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [PROJECT["b"], 1, "youtube_1440p", 3])
        if status == "rendering":
            claim(s)
        back_to_owner(s)
        out = s.run(_rollback_text())
        assert (not out.ok) and "a paid export is still queued or rendering" in out.error, out
        assert _hash(s, REQ4_SIG) is not None and hold(s, eid)[0] == "open"
        if status == "rendering":
            finish(s, eid, None, "render_failed")
        else:
            s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where id = %s", [eid])
        s.conn.execute(_rollback_text())
        assert _hash(s, REQ4_SIG) is None


@pytest.mark.parametrize("sig,find,put", [
    (REQ4_SIG, ">= 20 then", ">= 21 then"),
    ("public.request_editor_export(uuid, integer, text)", ">= 20 then", ">= 21 then"),
    ("public.editor_export_frame(text)", "('square_1080', 1080, 1080)", "('square_1080', 1080, 1082)"),
])
def test_the_rollback_refuses_a_body_that_is_not_the_one_it_knows(conn, sig, find, put):
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0136(s)   # this file's own state: 0136 builds on these bodies and is taken off first
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where status in ('queued', 'rendering')")
        drift(s, sig, find, put)
        out = s.run(_rollback_text())
        assert _hash(s, REQ4_SIG) is not None
    assert (not out.ok) and "read the live body first" in out.error, out
