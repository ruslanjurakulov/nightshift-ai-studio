"""Breach lab: the film assembly worker's (modules/film_assembly.py, P4b) money paths against 0171's real functions.

Attacks from the position of a signed-up workspace, a second worker that re-claimed a stale lease, and a forged or stale worker id.
Only ffmpeg is faked (the assembly lab's render / probe / store doubles); every row, charge, capture, release and soft delete is the
database's. Time is moved only where the attack is "the clock ran out" (a heartbeat or a deadline set in the past, as the table
owner), never a money column.

The two tests named BR-P4B-NN were confirmed holes (strict xfail against b0fe0f57); they are now the regression tests of their fixes
(a per-attempt work folder, the lease checked again before anything is registered, and 0200's film_discard_unrecorded_assembly for a
file registered before the lease was lost). Every other test pins an attack the code refused already.
"""

from __future__ import annotations

import threading
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest

from modules import film_assembly as fa
from modules import media_library as ml

from test_sec_films_money import Db, a, b, db, no_live_segment  # noqa: F401 — the money lab's fixtures
from test_sec_film_assembly_worker import (  # noqa: F401 — the assembly lab's doubles, reused as they are
    ASSEMBLY_CHARGE, FILM_S, PgMedia, PgStore, assembling, deps, render, root, run, seg_json, store_file, takes_charged)


def live(d: Db, asset) -> bool:
    r = d.su("select deleted_at is null from public.media_assets where id = %s", [asset])
    return bool(r and r[0][0])


def segment_row(d: Db, sid):
    return d.su("select status, assembly_status, assembly_charged_credits, assembly_asset_id, worker_id, attempts "
                "from public.film_segments where id = %s", [sid])[0]


def go_stale(d: Db, sid):
    """The holder's heartbeat is older than film_claim_segment's 10 minute stale mark (the lease holder went quiet)."""
    d.su("update public.film_segments set heartbeat_at = now() - interval '1 hour' where id = %s", [sid])


def close(d: Db, sid, worker):
    """Leave nothing claimable behind: a stale running segment would be the next test's claim (oldest first)."""
    st = d.su("select status, assembly_status from public.film_segments where id = %s", [sid])[0]
    if st[0] in ("settled", "released"):
        return
    if st[1] == "running":
        try:
            d.svc("select public.film_record_assembly(%s::uuid, %s, false, null)", [sid, worker])
        except psycopg.Error:
            pass
    try:
        d.settle(sid, "cancelled", worker)
    except psycopg.Error:
        d.cancel(sid)


def registered_masters(d: Db, sid):
    """Every video this segment's assembly registered (its provenance names the segment)."""
    return [(str(r[0]), r[1]) for r in d.su(
        "select id, deleted_at is null from public.media_assets "
        "where kind = 'video' and provenance ->> 'film_segment_id' = %s and provenance ->> 'tool' = 'film_assembly'", [str(sid)])]


# ══ Confirmed holes, fixed ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════


def test_br_p4b_01_a_render_that_outlives_the_segment_leaves_no_unpaid_film_in_the_library(db, a, root):
    """Attack: the assembly's render runs past the segment's deadline + grace (a long film, a busy 2-core box). The sweep fails the
    assembly at 0 and settles; 0171's film_lose_inflight_locked discards what the segment registered SO FAR (nothing yet). The render
    then finishes, the module stores and registers the master (live, in the workspace's library), and film_record_assembly answers
    lease_lost (worker_id is null after the settle). The module returns lease_lost and cleans up nothing: a finished film sits in the
    library, downloadable, with the assembly charged 0 and the hold already released."""
    film, seg = assembling(db, a, root)
    sid = seg["id"]

    def slow(norm, resolver, out, timings=None, **kw):
        timings.mode, timings.intermediate = "sequential", "fast"
        db.su("update public.film_segments set deadline_at = now() - interval '30 days' where id = %s", [sid])
        assert db.svc("select public.film_expire_segments()") >= 1
        Path(out).write_bytes(b"\0" * 64)
        return out

    out = run(db, seg, root, render=slow)
    assert (out.ok, out.reason) == (False, "lease_lost")
    row = segment_row(db, sid)
    assert row[0] in ("settled", "released") and row[1] == "failed" and Decimal(row[2]) == 0   # charged 0 for the assembly
    assert db.account(a.org)[1] == 0                                                            # the hold is gone
    masters = registered_masters(db, sid)
    # Fixed: the lease is checked again before anything is registered, so the late render registers nothing.
    assert not any(alive for _id, alive in masters), f"an unpaid finished film is live in the library: {masters}"


def test_br_p4b_01_a_file_registered_just_before_the_segment_ended_is_discarded(db, a, root):
    """The same race one step later: the sweep settles the segment while the master is being stored (after the lease check). The
    record answers lease_lost; 0200 removes the file because the segment's assembly ended without it."""
    film, seg = assembling(db, a, root)
    sid = seg["id"]

    def store_then_expire(path, **kw):
        # The sweep lands between the module's lease check and register_asset: its own discard finds nothing yet.
        db.su("update public.film_segments set deadline_at = now() - interval '30 days' where id = %s", [sid])
        assert db.svc("select public.film_expire_segments()") >= 1
        return store_file(path, **kw)
    out = run(db, seg, root, store_file=store_then_expire)
    assert (out.ok, out.reason) == (False, "lease_lost")
    masters = registered_masters(db, sid)
    assert masters, "the attack did not reach the store"
    assert not any(alive for _id, alive in masters), f"an unpaid finished film is live in the library: {masters}"
    assert "assembly_orphan_discarded" in db.events(film)


def test_br_p4b_02_a_stale_holder_finishing_late_does_not_fail_the_new_holders_paid_assembly(db, a, root):
    """Attack (a race, made deterministic with two threads): w-1's heartbeat goes stale mid-render, w-2 re-claims the segment
    (film_claim_segment takes stale running segments) and starts its own render. Both use media_root/.film-assembly/<segment>/ and
    the same film.mp4 inside it. w-1 finishes first: it registers the master, gets lease_lost from film_record_assembly, and its
    `finally: shutil.rmtree(work)` deletes w-2's work folder, film.mp4 included. w-2's render returns to a missing file: render_failed,
    recorded at 0, and film_discard_assets soft-deletes the good master w-1 made. The customer paid every take and gets a paused film
    with no assembly, though a correct film was rendered twice."""
    film, seg = assembling(db, a, root)
    sid = seg["id"]
    w1_in, w1_go = threading.Event(), threading.Event()
    w1 = {}

    def w1_render(norm, resolver, out, timings=None, **kw):
        timings.mode, timings.intermediate = "sequential", "fast"
        w1_in.set()
        assert w1_go.wait(30)
        Path(out).write_bytes(b"\0" * 64)
        return out

    def w1_run():
        try:
            w1["out"] = run(db, seg, root, worker="w-1", render=w1_render)
        except BaseException as e:  # noqa: BLE001 — reported below
            w1["err"] = e

    t1 = threading.Thread(target=w1_run, daemon=True)
    t1.start()
    assert w1_in.wait(30)
    go_stale(db, sid)
    seg2 = db.claim("w-2")
    assert seg2 is not None and seg2["id"] == sid and seg2["worker_id"] == "w-2"

    def w2_render(norm, resolver, out, timings=None, **kw):
        timings.mode, timings.intermediate = "sequential", "fast"
        Path(out).write_bytes(b"\0" * 64)
        w1_go.set()
        t1.join(30)          # w-1 finishes (and cleans up) while w-2's render is still "running"
        return out

    try:
        out2 = run(db, seg_json(db, sid), root, worker="w-2", render=w2_render)
        assert "err" not in w1, w1.get("err")
        assert w1["out"].reason == "lease_lost"       # w-1 correctly records nothing
        # Fixed: each attempt has its own folder, and w-1 lost the lease before registering anything.
        assert out2.ok, (out2.reason, out2.detail)
        assert segment_row(db, sid)[1] == "completed"
    finally:
        w1_go.set()
        t1.join(30)
        close(db, sid, "w-2")


# ══ Attacks the code refuses (pinned) ═════════════════════════════════════════════════════════════════════════════════════════════


def test_a_stale_holder_cannot_record_after_a_reclaim_and_the_new_holder_reuses_its_file_charging_once(db, a, root):
    """w-1 registers the master, then its lease goes stale before the record; w-2 re-claims. w-1's record is lease_lost (not
    recorded); w-2 finds the live master by its uuid5 id and records it without rendering; a late w-1 retry changes nothing."""
    film, seg = assembling(db, a, root)
    sid = seg["id"]
    store = PgStore(db)
    real = store.record

    def stale_then_record(s, worker, ok, asset):
        go_stale(db, sid)
        assert db.claim("w-2")["worker_id"] == "w-2"
        return real(s, worker, ok, asset)
    store.record = stale_then_record
    out1 = fa.assemble_segment(seg, worker_id="w-1", store=store, media=PgMedia(db), media_root=root,
                               tools=ml.Tools("ffprobe", "ffmpeg"), deps=deps(seg["org_id"]))
    assert (out1.ok, out1.reason) == (False, "lease_lost")
    assert segment_row(db, sid)[1] == "running"
    render.calls = 0
    out2 = run(db, seg_json(db, sid), root, worker="w-2")
    assert out2.ok and out2.rendered is False and render.calls == 0
    late = run(db, seg, root, worker="w-1")
    assert (late.ok, late.reason) == (False, "lease_lost")
    s = seg_json(db, sid)
    assert Decimal(str(s["assembly"]["charged_credits"])) == ASSEMBLY_CHARGE
    settled = db.settle(sid, "completed", "w-2")
    assert Decimal(str(settled["captured_credits"])) == takes_charged(db, sid) + ASSEMBLY_CHARGE
    assert len(db.ledger(a.org, "capture")) == 1


def test_a_rerun_after_settle_charges_nothing_more_and_renders_nothing(db, a, root):
    film, seg = assembling(db, a, root)
    assert run(db, seg, root).ok
    first = db.settle(seg["id"], "completed")
    render.calls = 0
    again = run(db, seg, root)        # worker_id is null after the settle: the lease is gone
    assert (again.ok, again.reason) == (False, "lease_lost") and render.calls == 0
    assert db.settle(seg["id"], "completed")["captured_credits"] == first["captured_credits"]
    assert len(db.ledger(a.org, "capture")) == 1


def test_the_assembly_charge_is_capped_at_its_line_whatever_length_the_file_records(db, a, root):
    """0171: a master registered as 59 minutes long (the probe lied, or the render padded) is charged the line, never 59 × the rate.
    Pinned at the database, where the cap lives: the module refuses such a file before it records it (next test)."""
    film, seg = assembling(db, a, root)
    long_ = str(db.su("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 1000, %s, 'generated', "
                      "p_width => 1920, p_height => 1080, p_duration_s => 3540, p_provenance => %s::jsonb) ->> 'id'",
                      [a.org, uuid.uuid4().hex * 2, '{"film_segment_id": "%s"}' % seg["id"]])[0][0])
    s = db.svc("select public.film_record_assembly(%s::uuid, 'w-1', true, %s::uuid)", [seg["id"], long_])
    assert Decimal(str(s["assembly"]["charged_credits"])) == Decimal(str(s["assembly"]["confirmed_credits"])) == ASSEMBLY_CHARGE
    settled = db.settle(seg["id"], "completed")
    assert Decimal(str(settled["captured_credits"])) <= Decimal(str(settled["confirmed_credits"]))


def test_a_master_whose_recorded_length_is_not_the_films_is_refused_before_it_is_charged(db, a, root):
    film, seg = assembling(db, a, root)

    def long_file(path, *, asset_id, org_id, store, media_root, tools, provenance, **kw):
        d = ml.asset_dir(media_root, asset_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "proxy.mp4").write_bytes(b"\0" * 1000)
        return store.register(asset_id=asset_id, org=org_id, kind="video", mime="video/mp4", bytes=1000,
                              sha256=uuid.uuid4().hex * 2, source="generated", width=1920, height=1080, duration_s=3540,
                              provenance=provenance, variants=["thumb", "proxy"])
    out = run(db, seg, root, store_file=long_file)
    assert (out.ok, out.reason) == (False, "store_failed") and "3540" in out.detail
    s = seg_json(db, seg["id"])
    assert s["assembly"]["status"] == "failed" and Decimal(str(s["assembly"]["charged_credits"])) == 0
    db.settle(seg["id"], out.reason)


def test_a_failure_after_the_master_was_registered_soft_deletes_it_and_charges_nothing(db, a, root):
    """The review copy is too big (a long film the workspace chose): the assembly fails at 0, and the master it already registered
    does not stay in the library as a free film (0171's discard finds it by its provenance, not by the id handed in)."""
    film, seg = assembling(db, a, root)

    def big_proxy(path, *, asset_id, org_id, store, media_root, tools, provenance, **kw):
        out = store_file(path, asset_id=asset_id, org_id=org_id, store=store, media_root=media_root, tools=tools,
                         provenance=provenance, **kw)
        with open(ml.asset_file(media_root, asset_id, "proxy"), "r+b") as f:
            f.truncate(fa.REVIEW_COPY_MAX_BYTES + 1)     # sparse: no 50 MB written
        return out
    out = run(db, seg, root, store_file=big_proxy)
    assert (out.ok, out.reason) == (False, "review_copy_too_large")
    masters = registered_masters(db, seg["id"])
    assert masters and not any(alive for _i, alive in masters), masters
    settled = db.settle(seg["id"], out.reason)
    assert Decimal(str(settled["captured_credits"])) == takes_charged(db, seg["id"])
    assert db.account(a.org)[1] == 0


def test_an_enabled_org_id_in_the_handed_segment_does_not_assemble_another_workspaces_film(db, a, b, root):
    """The flag is checked on the org_id in the segment dict the worker hands in. Forging it to an enabled workspace for another
    workspace's segment does not get that film assembled: the film's own org must match, so it fails at 0 and nothing renders."""
    film, seg = assembling(db, a, root)
    forged = dict(seg, org_id=b.org)
    render.calls = 0
    out = fa.assemble_segment(forged, worker_id="w-1", store=PgStore(db), media=PgMedia(db), media_root=root,
                              tools=ml.Tools("ffprobe", "ffmpeg"),
                              deps=deps(b.org))           # b is enabled
    assert out.ok is False and out.reason == "film_unavailable" and render.calls == 0
    s = seg_json(db, seg["id"])
    assert s["assembly"]["status"] == "failed" and Decimal(str(s["assembly"]["charged_credits"])) == 0
    assert db.settle(seg["id"], "film_unavailable")["status"] in ("settled", "released")


def test_the_kill_switch_off_assembles_nothing_even_for_an_enabled_org(db, a, root):
    film, seg = assembling(db, a, root)
    render.calls = 0
    # NIGHTSHIFT_FILM_ASSEMBLY unset; the org is enabled in the database. The worker's switch is not a decision about the film
    # (Sentinel R3): nothing renders and nothing is recorded; the assembly stays running for a worker with the switch on.
    with pytest.raises(fa.AssemblyDisabled):
        run(db, seg, root, env={})
    assert render.calls == 0
    assert seg_json(db, seg["id"])["assembly"]["status"] == "running"
    close(db, seg["id"], "w-1")


def test_a_forged_worker_id_cannot_record_a_success_or_a_failure(db, a, root):
    film, seg = assembling(db, a, root)
    sid = seg["id"]
    asset = db.asset(a.org, "video", "video/mp4", duration=FILM_S, provenance={"film_segment_id": sid})
    for worker in ("w-2", "", " w-1x", None):
        for ok, aid in ((True, asset), (False, None)):
            with pytest.raises(psycopg.Error) as e:
                db.svc("select public.film_record_assembly(%s::uuid, %s, %s, %s::uuid)", [sid, worker, ok, aid])
            assert "lease_lost" in str(e.value)
    # A browser cannot call it at all, whatever claims it forges.
    for role, user in (("authenticated", a.owner), ("anon", None)):
        with pytest.raises(psycopg.Error) as e:
            db.one(role, user, "select public.film_record_assembly(%s::uuid, 'w-1', true, %s::uuid)", [sid, asset])
        assert e.value.sqlstate == "42501"
    assert segment_row(db, sid)[1] == "running"
    close(db, sid, "w-1")


def test_another_workspaces_row_at_the_master_id_is_never_recorded_or_touched(db, a, b, root):
    """register_asset answers ANY existing row with the same id as 'reused', whatever its organization. If a foreign row sat at the
    uuid5 master id (a collision; no tenant can choose an asset id), the module must not record it as this segment's master."""
    film, seg = assembling(db, a, root)
    seen = {}
    foreign = None
    real_store = PgStore(db)
    real_assets = real_store.assets

    def plant_then_read(org, ids):
        nonlocal foreign
        ids = list(ids)
        if foreign is None and len(ids) == 1 and ids[0] not in seen.values():
            # The module's idempotency probe for the master id: plant b's row at exactly that id first.
            seen["aid"] = ids[0]
            foreign = ids[0]
            db.su("select public.register_asset(%s::uuid, %s::uuid, 'video', 'video/mp4', 1000, %s, 'generated', "
                  "p_width => 1920, p_height => 1080, p_duration_s => 18::numeric)", [foreign, b.org, uuid.uuid4().hex * 2])
        return real_assets(org, ids)
    real_store.assets = plant_then_read
    out = fa.assemble_segment(seg, worker_id="w-1", store=real_store, media=PgMedia(db), media_root=root,
                              tools=ml.Tools("ffprobe", "ffmpeg"), deps=deps(seg["org_id"]))
    assert foreign is not None
    assert (out.ok, out.reason) == (False, "store_failed"), (out.reason, out.detail)
    row = db.su("select org_id, deleted_at is null from public.media_assets where id = %s", [foreign])[0]
    assert (str(row[0]), row[1]) == (b.org, True)                          # b's row untouched
    s = seg_json(db, seg["id"])
    assert s["assembly"]["status"] == "failed" and s["assembly"]["asset_id"] is None
    assert Decimal(str(s["assembly"]["charged_credits"])) == 0
    db.settle(seg["id"], out.reason)


def test_a_take_file_or_a_pre_claim_file_cannot_be_handed_in_as_the_master(db, a, root):
    """The worker (or a bug in it) hands film_record_assembly a file that is not this assembly's: a take's clip, a file registered
    before the segment was claimed, another workspace's video. Each is refused; nothing is charged."""
    _, seg = assembling(db, a, root)
    sid = seg["id"]
    clip = [t for t in db.su("select result_asset_id from public.film_takes where segment_id = %s and kind = 'clip'", [sid])][0][0]
    old = a.image  # registered before the claim (and an image)
    other = db.new_org()
    theirs = db.asset(other.org, "video", "video/mp4", duration=FILM_S)
    for asset in (clip, old, theirs):
        with pytest.raises(psycopg.Error) as e:
            db.svc("select public.film_record_assembly(%s::uuid, 'w-1', true, %s::uuid)", [sid, asset])
        assert "invalid_params" in str(e.value) or e.value.sqlstate in ("22023", "P0001"), str(e.value)
    assert segment_row(db, sid)[1] == "running"
    close(db, sid, "w-1")


def test_sentinel_r1_a_lost_answer_from_register_asset_keeps_the_paid_film_and_charges_it_once(db, a, root):
    """Sentinel R1: register_asset wrote the master, then the answer was lost (requests' ReadTimeout, an OSError, not the builtin
    ConnectionError). That is no decision: nothing is recorded, the master stays live, and the retry records it without rendering."""
    import requests
    film, seg = assembling(db, a, root)

    def lost_answer(path, **kw):
        store_file(path, **kw)
        raise requests.ReadTimeout("read timed out")
    render.calls = 0
    with pytest.raises(fa.DbUnavailable):
        run(db, seg, root, store_file=lost_answer)
    assert segment_row(db, seg["id"])[1] == "running"
    masters = registered_masters(db, seg["id"])
    assert len(masters) == 1 and masters[0][1], masters        # the paid film was not discarded
    again = run(db, seg, root)
    assert again.ok and again.rendered is False and render.calls == 1
    settled = db.settle(seg["id"], "completed")
    assert Decimal(str(settled["captured_credits"])) == takes_charged(db, seg["id"]) + ASSEMBLY_CHARGE
    assert len(db.ledger(a.org, "capture")) == 1
