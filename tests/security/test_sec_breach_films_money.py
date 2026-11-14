"""Breach on Film Studio P2 (migration 0171): the attacks on the film's price, its one hold and the settle path, run in a scratch
database of their own (the same registry, prices and helpers as test_sec_films_money.py).

One hole is open, and its test FAILS until it is fixed:

  * BR-0171-01 (low, availability): the in-database start limit ("db.film.start 10 an hour", 0171's header) counts only the starts
    that succeed. take_web_rate's counter is a row written in the caller's transaction, and every refusal start_film raises after it
    (price_changed, NS402, NS429, an unpriced line, cap_exceeded, limit_reached) rolls that row back with everything else. A refused
    start re-prices the whole film first (film_price: up to 60 scenes x 4 lines, about 250 ms in the lab at the largest film) under
    the organization's start lock, so one admin (and every signed-up person is the owner of their own workspace) can call it as
    often as PostgREST lets them: a forged quote id of the right version is refused as price_changed every time and never counted.

Every other attack below was tried and refused; each test pins the guard that refused it, so a later change that removes the guard
turns the test red:

  * the operator's exempt organization: an owner by membership who is not a platform owner or admin cannot start (the platform would
    pay); a platform owner can, and nothing is held;
  * a refund that meets a film's hold (0167): the film's release gives back exactly what the film did not spend, and the refund
    recovery collects that and nothing else, never the credits the film captured;
  * hostile measured seconds from a worker (NaN, Infinity, negative, 0, over 600): refused; a clip longer than its line is charged
    the line; a moderated result for a take that never began is refused (no vendor call, nothing to bill);
  * a cancel racing a take's begin: the take is either running (and charged when it ends) or skipped (and charged 0), never both,
    and the capture equals the charges;
  * a clip model that turns into Seedance after it was saved (its adapter or its vendor model id) is refused at the start, even while
    the registry lists it on sale;
  * a reference character deleted after the quote (a direct delete an editor may make, which bumps no version): the start is
    refused by name and nothing is held.
"""

from __future__ import annotations

import json
import threading
import uuid
from decimal import Decimal

import psycopg
import pytest

from test_sec_films_money import TOTAL, a, b, claims, db, err, no_live_segment  # noqa: F401  (fixtures, re-registered here)

EXEMPT_ORG = "00000000-0000-0000-0000-000000000001"


def outcome(fn):
    """(sqlstate or 'ok', machine word): a refusal raised, or one answered as a jsonb object (a fix may answer instead of raising)."""
    try:
        r = fn()
    except psycopg.Error as e:
        return e.sqlstate, str(e).splitlines()[0]
    if isinstance(r, dict) and (r.get("ok") is False or "reason" in r):
        return "ok", r.get("reason")
    return "ok", "started"


# ── BR-0171-01: a refused start is never counted ──────────────────────────────

def test_BR_0171_01_refused_starts_count_against_the_ten_an_hour_start_limit(db, a):
    """0171's header: start_film is rate-limited in the database per person, 10 an hour. Eleven calls within the hour must meet the
    limit whatever the first ten answered; otherwise every refused call is a free re-pricing of the whole film under the
    organization's start lock. FAILS on 0171: the counter row rolls back with the refusal, so the limit never sees one."""
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    forged = qid[:-32] + "0" * 32  # the film's own version: it passes every cheap check and is re-priced in full
    seen = [outcome(lambda: db.start(a.admin, fid, forged)) for _ in range(10)]
    assert set(seen) <= {("NS409", "price_changed"), ("ok", "price_changed"), ("NS429", "rate_limited"), ("ok", "rate_limited")}, seen
    counted = db.su("select coalesce(sum(count), 0) from public.web_rate_counters where user_id = %s and bucket = 'db.film.start@3600'",
                    [a.admin])[0][0]
    eleventh = outcome(lambda: db.start(a.admin, fid, qid))
    assert eleventh[1] == "rate_limited", (
        f"BR-0171-01: ten refused start_film calls left {counted} on the person's db.film.start counter, and the eleventh call of the "
        f"hour answered {eleventh}: a refusal raised after take_web_rate rolls the counter back, so refused starts (each a full "
        f"re-pricing under the organization's start lock) are never limited")


# ── the exempt organization ──────────────────────────────────────────────────

def test_only_a_platform_owner_or_admin_starts_a_film_in_the_exempt_organization(db):
    """The platform pays for a film there (reserve_credits holds nothing), so an owner of the organization by membership alone is
    refused; a platform owner may start, and nothing is held. app_members is non-empty here, so nobody is owner by the bootstrap
    rule (0007: an empty roster makes every member of the default organization a platform owner)."""
    member, platform = str(uuid.uuid4()), str(uuid.uuid4())
    for u in (member, platform):
        db.su("insert into auth.users (id, email) values (%s, %s)", [u, f"{u[:8]}@exempt.lab"])
    db.su("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner')",
          [EXEMPT_ORG, member, f"{member[:8]}@exempt.lab"])
    db.su("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner')", [platform, f"{platform[:8]}@exempt.lab"])
    try:
        db.asset(EXEMPT_ORG)

        class Who:
            org, editor, admin = EXEMPT_ORG, member, member

        fid = db.film(Who)
        q = db.quote(member, fid)
        assert q["priced"] is True and q["exempt"] is True and q["may_start"] is False and q["startable"] is False, q
        assert err(lambda: db.start(member, fid, q["quote_id"]))[:2] == ("42501", "forbidden")
        assert db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0
        seg = db.start(platform, fid, q["quote_id"])
        assert seg["exempt"] is True and seg["credit_ref"] is None and db.holds(EXEMPT_ORG) == []
    finally:
        db.su("delete from public.app_members where user_id = %s", [platform])


# ── 0167: a refund that meets a film's hold ──────────────────────────────────

def test_a_refund_that_meets_a_films_hold_collects_only_what_the_film_released(db):
    o = db.new_org(credits=0)
    ext = f"pay_film{uuid.uuid4().hex[:12]}"
    db.svc("select public.add_purchased_credits(%s, 100, %s, 'lab purchase')", [o.org, ext])
    fid = db.film(o)
    seg = db.quoted_start(o, fid)
    assert db.account(o.org) == (Decimal(100), TOTAL)
    refund = db.svc("select public.refund_purchased_credits(%s, %s, null, 'lab', 'refund')", [ext, f"rf_{uuid.uuid4().hex[:12]}"])
    assert Decimal(str(refund["on_hold"])) == TOTAL and Decimal(str(refund["taken"])) == 100 - TOTAL, refund
    db.claim()
    kf = db.takes(seg["id"])[0][0]
    db.begin(kf)
    db.succeed(kf, None, db.asset(o.org))  # the key frame: 3 credits, spent for real
    out = db.cancel(seg["id"])
    assert out["captured_credits"] == 3
    # The film captured 3 and released 46; the refund takes the 46 back and nothing of what the film spent.
    assert db.ledger(o.org, "capture") == [Decimal(-3)] and db.ledger(o.org, "release") == [TOTAL - 3]
    assert db.ledger(o.org, "refund") == [Decimal(-51), Decimal(-46)]
    assert db.account(o.org) == (Decimal(0), Decimal(0))
    rec = db.su("select owed, collected, lapsed, holds from public.credit_refund_recoveries where org_id = %s", [o.org])
    assert rec == [(TOTAL, TOTAL - 3, Decimal(0), [seg["credit_ref"]])], rec


# ── hostile results from the worker ──────────────────────────────────────────

def test_hostile_measured_seconds_are_refused_and_a_long_clip_is_charged_its_line(db, a):
    fid = db.film(a)
    seg = db.quoted_start(a, fid)
    db.claim()
    takes = db.takes(seg["id"])
    clip = next(t for t in takes if t[1] == "clip")
    db.begin(clip[0])
    vid = db.asset(a.org, "video", "video/mp4")
    for s in ("NaN", "Infinity", "-Infinity", "-1", "0", "600.001", "1e10"):
        assert err(lambda: db.succeed(clip[0], s, vid))[:2] == ("NS400", "invalid_params"), s
    done = db.succeed(clip[0], "599.99", vid)
    assert Decimal(str(done["charged_credits"])) == clip[5] == 20, done
    for s in ("NaN", "-5", "0", "3601"):
        assert db.svc("select public.film_take_succeeded(%s::uuid, 'w-1', %s::numeric, %s::uuid)",
                      [clip[0], s, vid])["charged_credits"] == 20  # a retried success answers as it is, never re-charged
    # A moderated result for a take that never began: no vendor call was made, so there is nothing a vendor could have billed.
    other = next(t for t in takes if t[1] == "clip" and t[0] != clip[0])
    assert err(lambda: db.fail(other[0], "moderated"))[:2] == ("NS409", "take_not_running")
    assert db.takes(seg["id"])[2][4] == "planned"


def test_a_cancel_racing_a_takes_begin_either_charges_it_or_skips_it_never_both(db):
    for _ in range(4):
        o = db.new_org(credits=100)
        fid = db.film(o)
        seg = db.quoted_start(o, fid)
        assert db.claim()["id"] == seg["id"]
        kf = db.takes(seg["id"])[0][0]
        gate, out = threading.Barrier(2), {}

        def begin():
            gate.wait()
            try:
                db.begin(kf)
                out["begin"] = ("ok", "running")
            except psycopg.Error as e:
                out["begin"] = (e.sqlstate, str(e).splitlines()[0])

        def cancel():
            gate.wait()
            out["cancel"] = db.cancel(seg["id"])

        threads = [threading.Thread(target=begin), threading.Thread(target=cancel)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        status = db.takes(seg["id"])[0][4]
        if out["begin"][0] == "ok":
            # The take began first: the cancel waits for it, and it is charged when it ends.
            assert status == "running" and db.segment(seg["id"])[0] == "draining", out
            db.succeed(kf, None, db.asset(o.org))
            db.settle(seg["id"], "cancelled")
            assert db.segment(seg["id"])[:2] == ("settled", 3)
        else:
            assert out["begin"] in (("NS409", "lease_lost"), ("NS409", "not_running"), ("NS409", "take_not_planned")), out
            assert status == "skipped" and db.segment(seg["id"])[:2] == ("released", 0), out
        charged = sum(t[6] for t in db.takes(seg["id"]))
        assert db.segment(seg["id"])[1] == charged <= TOTAL
        assert db.account(o.org)[1] == 0 and db.holds(o.org)[0][2] in ("captured", "released")


# ── the price pin ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("change", [
    "update public.model_registry set adapter = 'video.seedance2' where id = 'vid-clip'",
    "update public.model_registry set spec = spec || '{\"vendor_model\": \"Dreamina-SEEDANCE-2-0-260128\"}' where id = 'vid-clip'",
])
def test_a_clip_model_that_becomes_seedance_after_it_was_saved_is_refused_at_the_start(db, a, change):
    """film_check_model runs again at the start, before anything is held, on the registry as it is now. The registry hides a model
    whose adapter or spec changes; it is put back on sale here, so the refusal is the Seedance rule's and not the sale check's."""
    fid = db.film(a)
    qid = db.quote(a.editor, fid)["quote_id"]
    with psycopg.connect(db.dsn, autocommit=False) as c:
        c.execute(change)
        c.execute("select public.record_model_probe(id, adapter, spec ->> 'vendor_model', 'i2v', true, null, null, 10, 100, "
                  "'security-lab') from public.model_registry where id = 'vid-clip'")
        c.execute("update public.model_registry set availability = 'beta' where id = 'vid-clip'")
        assert c.execute("select count(*) from public.sellable_models('i2v', 'web') where id = 'vid-clip'").fetchone()[0] == 1
        c.execute("select set_config('request.jwt.claims', %s, true)", [claims("authenticated", a.admin)])
        c.execute("set local role authenticated")
        with pytest.raises(psycopg.Error) as e:
            c.execute("select public.start_film(%s::uuid, %s, %s)", [fid, qid, db.key()])
        assert (e.value.sqlstate, str(e.value).splitlines()[0]) == ("NS400", "model_not_offered")
        c.rollback()
    assert db.holds(a.org) == [] and db.film_row(fid)[0] == "draft"


def test_a_reference_character_deleted_after_the_quote_refuses_the_start_and_holds_nothing(db, a):
    ch = str(db.su("insert into public.characters (org_id, name) values (%s, %s) returning id",
                   [a.org, f"hero_{uuid.uuid4().hex[:8]}"])[0][0])
    db.su("insert into public.character_references (character_id, org_id, asset_id, position) values (%s, %s, %s, 0)",
          [ch, a.org, a.image])
    fid = db.film(a)
    db.save(a.editor, fid, db.version(fid), {"refs": [{"kind": "character", "character_id": ch}]})
    q = db.quote(a.editor, fid)
    assert q["priced"] is True
    version = db.version(fid)
    assert db.act("authenticated", a.editor, "delete from public.characters where id = %s returning 1", [ch]) == [(1,)]
    assert db.version(fid) == version  # the delete bumps no version: the version pin alone would not see it
    assert err(lambda: db.start(a.admin, fid, q["quote_id"]))[:2] == ("NS400", "reference_missing")
    assert db.holds(a.org) == [] and db.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 0
    assert json.dumps(db.quote(a.editor, fid)["refusals"]).count("reference_missing") == 1
