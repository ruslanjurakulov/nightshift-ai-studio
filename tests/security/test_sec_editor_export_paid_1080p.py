"""Named attacks on exports up to 1080p sold by the started minute (migration 0136).

0136 adds a 1080p price to 0132's owner-edited row, seeded NULL. What must hold:

  * NULL means FREE and unchanged: the two- and three-argument requests queue an export up to 1080p and touch no credit; the paid overload
    refuses a frame up to 1080p (invalid_frame), as in 0132; the quote says paid=false;
  * set (1 credit per started minute, job_minimum 30): the quote says 1 charged, 30 held; the paid overload (a free id, or 'project' for the
    project's own frame) holds 30, done captures exactly 1 and gives 29 back, a failure or a deleted project gives all 30 back; the
    confirmed number is compared with the CHARGE; too few credits for the HOLD refuse it all;
  * the two- and three-argument requests are REFUSED while the price is set (export_needs_quote) and write nothing: they hold nothing, so
    they never sell; a paid frame through the three-argument call is still hires_needs_paid_export;
  * a speed curve is sold at its RENDERED length (editor_doc_rendered_length; parity with the renderer in
    test_sec_editor_rendered_length.py); a curve the renderer refuses is refused (invalid_speed_curve);
  * the 1080p price and the 1440p / 4K prices are independent; a change of the 1080p price leaves a security event;
  * one lock order everywhere: a legacy and a paid request of one project at once never deadlock, and two paid ones see each other's
    export under the organization's lock;
  * the file applies twice, refuses a body it has not seen, and its rollback puts 0132's bodies back.
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
from sec_scenario import seat_invitee
from test_sec_editor_hires_export import (
    CREATE, QUOTE, REQ2, REQ3, REQ4, account, claim, clear, exports_of, finish, held, hold, job_minimum, ledger,
    many_parallel_runs, price, project_of_length, project_with, refused, render_asset, row, _session,
)
from test_sec_upload_folder import back_to_owner, become

MIGRATION = sec_db.MIGRATION_0136
ROLLBACK = sec_db.ROLLBACK_0136
FREE = ["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]
REQ4_SIG = "public.request_editor_export(uuid, integer, text, numeric)"
SIGS = {
    "req2": "public.request_editor_export(uuid, integer)",
    "req3": "public.request_editor_export(uuid, integer, text)",
    "req4": REQ4_SIG,
    "quote": "public.quote_editor_export(uuid, integer, text)",
    "terms": "public.editor_export_hires_terms(integer, integer, numeric)",
    "trail": "public.editor_export_hires_prices_trail()",
    "price": "public.editor_export_price_1080p()",
}


def price_1080p(s, value) -> None:
    back_to_owner(s)
    s.conn.execute("update public.editor_export_hires_prices set credits_per_minute_1080p = %s", [value])


def _hash(s, sig: str):
    return s.value(f"select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('{sig}')")


def _pins() -> dict:
    text = MIGRATION.read_text(encoding="utf-8")
    end = text.rsplit("-- 6. End state", 1)[1]
    found = dict(re.findall(r"\['(public\.[a-z_0-9]+\([^)]*\))', '([0-9a-f]{32})'\]", end))
    return {k: found[v] for k, v in SIGS.items()}


def _pins_0132() -> dict:
    text = sec_db.MIGRATION_0132.read_text(encoding="utf-8")
    return {k: re.search(rf"oid = {k}\) <> '([0-9a-f]{{32}})'", text).group(1) for k in ("req2", "req3", "req4", "quote", "terms", "trail")}


def _rollback_text() -> str:
    return "\n".join(ln for ln in ROLLBACK.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


# ── NULL: free, exactly as before ───────────────────────────────────────────

def test_the_file_seeds_no_price_and_exports_up_to_1080p_stay_free_and_unchanged(conn, sc):
    with as_superuser(conn, commit=False) as s:
        assert s.value("select credits_per_minute_1080p from public.editor_export_hires_prices") is None
        clear(s, sc.bob.org, sc.alice.org)
        job_minimum(s, 30)
        many_parallel_runs(s)
        before = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        q_project = s.value(QUOTE, [PROJECT["b"], 1, "project"])
        q_free = s.value(QUOTE, [PROJECT["b"], 1, "square_1080"])
        e2 = s.value(REQ2, [PROJECT["b"], 1])
        e3 = s.value(REQ3, [PROJECT["b"], 1, "square_1080"])
        paid_free = [s.run(REQ4, [PROJECT["b"], 1, f, 100]) for f in ("project", "vertical_1080p")]
        claim(s)
        finish(s, e2, render_asset(s, sc.bob.org), None)
        r2, r3, after = row(s, e2), row(s, e3), account(s, sc.bob.org)
        n = s.value("select count(*) from public.credit_transactions where job_id in ('ee:' || %s::text, 'ee:' || %s::text)", [e2, e3])
    assert q_project == {"frame": "project", "width": 1920, "height": 1080, "paid": False, "duration_s": 6.0}, q_project
    assert q_free["paid"] is False, q_free
    assert r2 == ("done", None, None, None, None, None) and r3 == ("queued", None, "square_1080", None, None, None), (r2, r3)
    for out in paid_free:
        assert refused(out, "NS400", "invalid_frame"), out
    assert after == before and n == 0


# ── set: quote, hold 30, capture 1, release 29 ──────────────────────────────

@pytest.mark.parametrize("frame,stored", [("project", None), ("square_1080", "square_1080"), ("youtube_1080p", "youtube_1080p")])
def test_price_1_with_job_minimum_30_holds_30_captures_1_and_gives_29_back(conn, sc, frame, stored):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price_1080p(s, 1)
        job_minimum(s, 30)
        bal, res = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [PROJECT["b"], 1, frame])
        eid = s.value(REQ4, [PROJECT["b"], 1, frame, q["credits"]])     # the person confirms the CHARGE
        r, hd, h, during = row(s, eid), held(s, eid), hold(s, eid), account(s, sc.bob.org)
        claimed = claim(s)
        first = finish(s, eid, render_asset(s, sc.bob.org), None)
        again = finish(s, eid, None, "late")
        r2, h2, after, led = row(s, eid), hold(s, eid), account(s, sc.bob.org), ledger(s, eid)
    assert (q["tier"], q["minutes"], float(q["credits"]), float(q["hold"]), float(q["credits_per_minute"])) == ("1080p", 1, 1.0, 30.0, 1.0), q
    assert q["frame"] == frame and q["on_sale"] is True and q["may_pay"] is True, q
    assert r == ("queued", None, stored, 1.0, f"ee:{eid}", None) and hd == 30.0, (r, hd)
    assert h == ("open", 30.0, True, None), h
    assert during == (bal, res + 30)
    assert claimed == [(str(eid), "rendering", None)]
    assert (first, again) == ("done", "done")
    assert r2[0] == "done" and r2[5] == 1.0, r2
    assert h2 == ("captured", 30.0, True, 1.0), h2
    assert after == (bal - 1, res)
    assert led == [("reserve", 30.0), ("capture", -1.0), ("release", 29.0)], led


@pytest.mark.parametrize("how", ["render_failed", "timed_out", "project_deleted"])
def test_price_1_a_failure_or_a_deleted_project_gives_all_30_back(conn, sc, how):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price_1080p(s, 1)
        job_minimum(s, 30)
        bal, res = account(s, sc.bob.org)
        pid = project_of_length(s, sc.bob, 30)
        become(s, sc.bob.actor)
        eid = s.value(REQ4, [pid, 1, "project", 1])
        if how == "project_deleted":
            s.value("select public.delete_editor_project(%s)", [pid])
        else:
            claim(s)
            finish(s, eid, None, how)
        r, after, led = row(s, eid), account(s, sc.bob.org), ledger(s, eid)
    assert r[:2] == ("failed", how) and r[5] == 0.0, r
    assert after == (bal, res)
    assert led == [("reserve", 30.0), ("release", 30.0)], led


@pytest.mark.parametrize("seconds,minutes", [(6, 1), (60, 1), (60.001, 2), (61, 2), (600, 10), (1799, 30)])
def test_the_charge_is_one_credit_per_started_minute(conn, sc, seconds, minutes):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price_1080p(s, 1)
        pid = project_of_length(s, sc.bob, seconds)
        become(s, sc.bob.actor)
        q = s.value(QUOTE, [pid, 1, "project"])
        eid = s.value(REQ4, [pid, 1, "project", q["credits"]])
        r = row(s, eid)
    assert q["minutes"] == minutes and float(q["credits"]) == minutes and r[3] == minutes, (q, r)


@pytest.mark.parametrize("confirmed", [0.99, None, float("nan"), float("inf"), -1, 10 ** 9])
def test_the_confirmed_number_is_compared_with_the_charge(conn, sc, confirmed):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price_1080p(s, 1)
        job_minimum(s, 30)
        before = account(s, sc.bob.org)
        become(s, sc.bob.actor)
        out = s.run(REQ4, [PROJECT["b"], 1, "project", confirmed])
        written = exports_of(s, sc.bob.org)
        become(s, sc.bob.actor)
        ok = s.run(REQ4, [PROJECT["b"], 1, "project", 1])        # the charge, not the hold of 30
        after = account(s, sc.bob.org)
    assert refused(out, "NS409", "price_changed") and written == 0, out
    assert ok.ok and after[1] == before[1] + 30, ok


def test_too_few_credits_for_the_hold_refuse_it_all(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        bal, res = account(s, sc.bob.org)
        price_1080p(s, 1)
        job_minimum(s, bal - res + 1)
        become(s, sc.bob.actor)
        out = s.run(REQ4, [PROJECT["b"], 1, "project", 1])
        written = exports_of(s, sc.bob.org)
        after = account(s, sc.bob.org)
    assert refused(out, "NS402", "insufficient_credits"), out
    assert written == 0 and after == (bal, res)


# ── the legacy calls while the price is set ─────────────────────────────────

def test_the_two_and_three_argument_calls_are_refused_while_the_price_is_set_and_write_nothing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price_1080p(s, 1)
        before = account(s, sc.bob.org)
        outs = []
        become(s, sc.bob.actor)
        outs.append(("req2", s.run(REQ2, [PROJECT["b"], 1])))
        for f in FREE:
            become(s, sc.bob.actor)
            outs.append((f, s.run(REQ3, [PROJECT["b"], 1, f])))
        become(s, sc.bob.actor)
        hires = s.run(REQ3, [PROJECT["b"], 1, "youtube_2160p"])
        stale = s.run(REQ2, [PROJECT["b"], 7])                 # the older gates still answer first
        written = exports_of(s, sc.bob.org)
        after = account(s, sc.bob.org)
        price_1080p(s, None)
        become(s, sc.bob.actor)
        free_again = s.run(REQ2, [PROJECT["b"], 1])
    for name, out in outs:
        assert refused(out, "NS409", "export_needs_quote"), (name, out)
    assert refused(hires, "NS400", "hires_needs_paid_export"), hires
    assert refused(stale, "NS409", "stale_revision"), stale
    assert written == 0 and after == before
    assert free_again.ok, free_again


def test_a_viewer_cannot_export_while_the_price_is_set_and_can_while_it_is_free(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.alice.org)
        seat_invitee(s, sc)
        price_1080p(s, 1)
        become(s, sc.invitee)
        q = s.value(QUOTE, [PROJECT["a"], 1, "project"])
        paid = s.run(REQ4, [PROJECT["a"], 1, "project", 1])
        legacy = s.run(REQ2, [PROJECT["a"], 1])
        price_1080p(s, None)
        become(s, sc.invitee)
        free = s.run(REQ2, [PROJECT["a"], 1])
    assert q["may_pay"] is False, q
    assert refused(paid, "42501", "forbidden") and refused(legacy, "NS409", "export_needs_quote"), (paid, legacy)
    assert free.ok, free


# ── the own frame, the caps, speed curves, independent prices ───────────────

def test_the_own_frame_is_sold_only_up_to_1080p_and_only_as_two_whole_numbers(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price_1080p(s, 1)
        price(s, 1, 1)
        big = project_with(s, sc.bob, width=3840, height=2160, fps=30)
        odd = project_with(s, sc.bob, width=1920.5, height=1080)
        text = project_with(s, sc.bob, width="1920", height="1080")
        small = project_with(s, sc.bob, width=1280, height=720)
        become(s, sc.bob.actor)
        outs = {"big": s.run(REQ4, [big, 1, "project", 100]), "big_q": s.run(QUOTE, [big, 1, "project"]),
                "odd": s.run(REQ4, [odd, 1, "project", 100]), "text": s.run(REQ4, [text, 1, "project", 100])}
        ok = s.value(REQ4, [small, 1, "project", 1])
        r = row(s, ok)
    assert refused(outs["big"], "NS400", "hires_needs_paid_export") and refused(outs["big_q"], "NS400", "hires_needs_paid_export"), outs
    assert refused(outs["odd"], "NS400", "invalid_frame") and refused(outs["text"], "NS400", "invalid_frame"), outs
    assert r[2] is None and r[3] == 1.0, r


def test_a_speed_curve_is_sold_at_its_rendered_length(conn, sc):
    """45 s of source at a quarter of the speed is 180 s on screen: three started minutes, not the one editor_doc_duration would
    count. The quote, the hold, the row's length and the capture all use it."""
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price_1080p(s, 1)
        price(s, 1, 1)
        many_parallel_runs(s)
        d = doc(VIDEO["b"])
        d["tracks"][0]["clips"][0].update({"in_s": 0, "out_s": 45, "speed_curve": [{"at": 0, "speed": 0.25}, {"at": 1, "speed": 0.25}]})
        become(s, sc.bob.actor)
        pid = str(s.value(CREATE, [sc.bob.org, "Curve", json.dumps(d)]))
        q = s.value(QUOTE, [pid, 1, "project"])
        q4 = s.value(QUOTE, [pid, 1, "youtube_1440p"])
        eid = s.value(REQ4, [pid, 1, "project", q["credits"]])
        legacy = s.run(REQ2, [pid, 1])
        dur = float(s.value("select duration_s from public.editor_exports where id = %s", [eid]))
        claim(s)
        finish(s, eid, render_asset(s, sc.bob.org), None)
        r = row(s, eid)
    assert (float(q["duration_s"]), q["minutes"], float(q["credits"]), q["speed_curve"], q["curve_sold"]) == (180.0, 3, 3.0, True, True), q
    assert (q4["minutes"], float(q4["credits"])) == (3, 3.0), q4
    assert dur == 180.0 and r[0] == "done" and r[5] == 3.0, (dur, r)
    assert refused(legacy, "NS409", "export_needs_quote"), legacy


def test_a_curve_the_renderer_refuses_is_refused_by_the_quote_and_the_request(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price_1080p(s, 1)
        d = doc(VIDEO["b"])
        d["tracks"][0]["clips"][0]["speed_curve"] = [{"at": 0, "speed": 0.25}, {"at": 0.5, "speed": 9}, {"at": 1, "speed": 1}]
        become(s, sc.bob.actor)
        pid = str(s.value(CREATE, [sc.bob.org, "Bad curve", json.dumps(d)]))
        outs = [s.run(QUOTE, [pid, 1, "project"]), s.run(REQ4, [pid, 1, "project", 100])]
        written = exports_of(s, sc.bob.org)
    for out in outs:
        assert refused(out, "NS400", "invalid_speed_curve"), out
    assert written == 0


def test_the_1080p_price_and_the_hires_prices_are_independent(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        many_parallel_runs(s)
        price(s, None, None)
        price_1080p(s, 1)
        become(s, sc.bob.actor)
        hires_off = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 100])
        sold_1080 = s.run(REQ4, [PROJECT["b"], 1, "square_1080", 1])
        back_to_owner(s)
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s", [sc.bob.org])
        price(s, 3, 5)
        price_1080p(s, None)
        become(s, sc.bob.actor)
        free_1080 = s.run(REQ3, [PROJECT["b"], 1, "square_1080"])
        sold_4k = s.run(REQ4, [PROJECT["b"], 1, "youtube_2160p", 5])
    assert refused(hires_off, "NS403", "not_on_sale") and sold_1080.ok, (hires_off, sold_1080)
    assert free_1080.ok and sold_4k.ok, (free_1080, sold_4k)


def test_a_change_of_the_1080p_price_leaves_a_security_event_and_the_check_holds_it(conn, sc):
    with as_superuser(conn, commit=False) as s:
        n0 = s.value("select count(*) from public.security_events where kind = 'editor.export.hires_price'")
        price_1080p(s, 1)
        price_1080p(s, 1)                                         # no change, no event
        ev = s.value("select detail from public.security_events where kind = 'editor.export.hires_price' order by id desc limit 1")
        n1 = s.value("select count(*) from public.security_events where kind = 'editor.export.hires_price'")
        bad = [s.run("update public.editor_export_hires_prices set credits_per_minute_1080p = %s", [v]) for v in (0, -1, 10001, 0.001)]
    assert n1 == n0 + 1 and ev["credits_per_minute_1080p"] == [None, 1], ev
    for out in bad:
        assert refused(out, "23514"), out


@pytest.mark.parametrize("who_name", ["bob", "operator", "anon", "service"])
def test_no_api_role_reads_or_calls_the_1080p_price(conn, sc, who_name):
    who = {"bob": sc.bob.actor, "operator": sc.operator, "anon": ANON, "service": SERVICE}[who_name]
    with acting(conn, who) as s:
        outs = [s.run("select public.editor_export_price_1080p()"),
                s.run("select credits_per_minute_1080p from public.editor_export_hires_prices"),
                s.run("update public.editor_export_hires_prices set credits_per_minute_1080p = 0.01")]
    for out in outs:
        assert refused(out, "42501"), (who_name, out)


def test_each_paid_1080p_export_is_one_of_the_three_in_flight_and_the_same_size_waits(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org)
        price_1080p(s, 1)
        many_parallel_runs(s)
        become(s, sc.bob.actor)
        s.value(REQ4, [PROJECT["b"], 1, "project", 1])
        twice = s.run(REQ4, [PROJECT["b"], 1, "youtube_1080p", 1])     # the project's own size (1920x1080) again
        s.value(REQ4, [PROJECT["b"], 1, "square_1080", 1])
        s.value(REQ4, [PROJECT["b"], 1, "vertical_1080p", 1])
        fourth = s.run(REQ4, [PROJECT["b"], 1, "feed_4x5_1080", 1])
    assert refused(twice, "NS409", "export_in_progress"), twice
    assert refused(fourth, "NS409", "export_in_progress"), fourth


# ── concurrency ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def race():
    from sec_editor_0054 import register
    from sec_scenario import _create_org, _signup

    dsn = sec_db.admin_dsn()
    name = f"ns_security_p1080_race_{uuid.uuid4().hex[:8]}"
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
            s.value("select public.grant_credits(%s, 1000, 'race')", [org])
            s.conn.execute("update public.editor_export_hires_prices set credits_per_minute_1080p = 1, credits_per_minute_1440p = 1")
        yield {"dsn": db, "conn": c, "who": who, "org": org, "projects": projects}
    finally:
        c.close()
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, name)


def _rounds(race, first, second, n):
    outcomes = []
    for _ in range(n):
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

        threads = [threading.Thread(target=one, args=(0, *first)), threading.Thread(target=one, args=(1, *second))]
        for t_ in threads:
            t_.start()
        for t_ in threads:
            t_.join(30)
        outcomes.append(tuple(out))
    return outcomes


def _set_1080p(race, value):
    with as_superuser(race["conn"]) as s:
        s.conn.execute("update public.editor_export_hires_prices set credits_per_minute_1080p = %s", [value])
        s.conn.execute("update public.editor_exports set status = 'failed', reason = 'test' where org_id = %s and status in ('queued', 'rendering')",
                       [race["org"]])


@pytest.mark.parametrize("legacy", ["two-argument", "three-argument"])
@pytest.mark.parametrize("priced", [True, False])
def test_a_legacy_and_a_paid_request_of_one_project_at_once_never_deadlock(race, legacy, priced):
    """Every overload takes the project's row and then the organization's lock. Priced: the legacy call is refused (export_needs_quote) after
    its row lock, the paid one ('project') queues. Free: the legacy call queues and the paid one is a 1440p export. Neither may deadlock."""
    _set_1080p(race, 1 if priced else None)
    pid = race["projects"][0]
    first = (REQ2, [pid, 1]) if legacy == "two-argument" else (REQ3, [pid, 1, "square_1080"])
    second = (REQ4, [pid, 1, "project" if priced else "youtube_1440p", 100])
    outcomes = _rounds(race, first, second, 50)
    flat = [o for pair in outcomes for o in pair]
    assert "40P01" not in flat, outcomes
    if priced:
        assert all(a == "NS409" and b == "ok" for a, b in outcomes), outcomes
    else:
        assert set(flat) <= {"ok", "NS409"} and flat.count("ok") >= 50, outcomes


def test_two_paid_1080p_requests_at_once_see_each_other_under_the_organizations_lock(race):
    _set_1080p(race, 1)
    with as_superuser(race["conn"]) as s:
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
                c.execute(REQ4, [race["projects"][i], 1, "project", 1]).fetchone()
                time.sleep(0.4)
                c.commit()
                out[i] = "ok"
            except psycopg.Error as e:
                c.rollback()
                out[i] = e.sqlstate
        finally:
            c.close()

    threads = [threading.Thread(target=one, args=(i,)) for i in range(2)]
    for t_ in threads:
        t_.start()
    for t_ in threads:
        t_.join(30)
    with as_superuser(race["conn"]) as s:
        busy = s.value("select count(*) from public.editor_exports where org_id = %s and status in ('queued', 'rendering')", [race["org"]])
    _set_1080p(race, 1)
    assert sorted(out) == ["NS409", "ok"], out
    assert busy == 3, busy


# ── the file ────────────────────────────────────────────────────────────────

def test_the_live_bodies_are_the_ones_the_file_pins(conn):
    with as_superuser(conn, commit=False) as s:
        for k, sig in SIGS.items():
            assert _hash(s, sig) == _pins()[k], k


def test_the_file_applies_twice_and_keeps_the_owners_price(conn, sc):
    with as_superuser(conn, commit=False) as s:
        price_1080p(s, 1)
        before = {k: _hash(s, sig) for k, sig in SIGS.items()}
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert {k: _hash(s, sig) for k, sig in SIGS.items()} == before
        assert float(s.value("select credits_per_minute_1080p from public.editor_export_hires_prices")) == 1.0


@pytest.mark.parametrize("sig,find,put", [
    ("public.request_editor_export(uuid, integer)", ">= 20 then", ">= 21 then"),
    ("public.request_editor_export(uuid, integer, text)", ">= 20 then", ">= 21 then"),
    (REQ4_SIG, ">= 20 then", ">= 21 then"),
    ("public.quote_editor_export(uuid, integer, text)", "'exempt', exempt,", "'exempt', true,"),
    ("public.editor_export_settle()", "new.reason := 'credits_released';", "new.reason := 'credits_gone';"),
])
def test_the_file_refuses_a_body_it_has_not_seen_and_changes_nothing(conn, sig, find, put):
    with as_superuser(conn, commit=False) as s:
        src = s.value(f"select pg_get_functiondef('{sig}'::regprocedure)")
        assert src.count(find) == 1, (sig, find)
        s.conn.execute(src.replace(find, put))
        drifted = _hash(s, sig)
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert _hash(s, sig) == drifted
    assert (not out.ok) and "read the live body first" in out.error, out


def test_the_rollback_puts_0132_back_and_the_file_applies_again(conn, sc):
    with as_superuser(conn, commit=False) as s:
        clear(s, sc.bob.org, sc.alice.org)
        price_1080p(s, 1)
        become(s, sc.bob.actor)
        waiting = s.value(REQ4, [PROJECT["b"], 1, "project", 1])          # a paid 1080p export still queued
        back_to_owner(s)
        s.conn.execute(_rollback_text())
        assert {k: _hash(s, sig) for k, sig in SIGS.items() if k != "price"} == _pins_0132()
        assert _hash(s, SIGS["price"]) is None
        assert s.value("select count(*) from information_schema.columns where table_name = 'editor_export_hires_prices' "
                       "and column_name = 'credits_per_minute_1080p'") == 0
        # Free again, and the waiting paid export still settles through 0132's trigger.
        become(s, sc.bob.actor)
        assert refused(s.run(REQ4, [PROJECT["b"], 1, "project", 1]), "NS400", "invalid_frame")
        claim(s)
        assert finish(s, waiting, None, "render_failed") == "failed"
        assert hold(s, waiting)[0] == "released"
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert {k: _hash(s, sig) for k, sig in SIGS.items()} == _pins()
        assert s.value("select credits_per_minute_1080p from public.editor_export_hires_prices") is None
        # 0132's own rollback works once 0136 is out again (the order docs/sql/rollback_0136 asks for).
        s.conn.execute(_rollback_text())
        s.conn.execute("\n".join(ln for ln in sec_db.ROLLBACK_0132.read_text(encoding="utf-8").splitlines()
                                 if ln.strip() not in ("begin;", "commit;")))
        assert _hash(s, REQ4_SIG) is None


@pytest.mark.parametrize("sig,find,put", [
    (REQ4_SIG, ">= 20 then", ">= 21 then"),
    ("public.editor_export_price_1080p()", "where s.id", "where s.id and true"),
])
def test_the_rollback_refuses_a_body_that_is_not_the_one_it_knows(conn, sig, find, put):
    with as_superuser(conn, commit=False) as s:
        src = s.value(f"select pg_get_functiondef('{sig}'::regprocedure)")
        assert src.count(find) == 1, (sig, find)
        s.conn.execute(src.replace(find, put))
        out = s.run(_rollback_text())
        assert _hash(s, SIGS["price"]) is not None
    assert (not out.ok) and "read the live body first" in out.error, out
