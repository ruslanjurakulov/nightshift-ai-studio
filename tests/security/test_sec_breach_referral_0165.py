"""Breach, migration 0165 (referral rewards): attacks that got through, kept as failing tests until the product code is fixed.

BR-0165-01  A clawback that meets a HOLD records a permanent shortfall, and the hold then gives the credits back. The referrer
            holds everything available (reserve_credits is callable by the workspace's owner/admin from the browser) before
            the friend's refund lands, the clawback takes 0 of 200 and marks the referral 'clawed' for good, and three hours
            later the unstarted hold is released (expire_credit_reservations, or lazily by the next reserve_credits). The
            reward stays with the referrer although the payment that earned it was refunded: a held credit is not a spent one.

BR-0165-02  A payment that cost nothing qualifies. An allowlisted Paddle promo (PADDLE_PROMO_DISCOUNT_IDS) credits a pack at
            full credits with grand_total 0 (supabase/functions/_shared/paddle.ts, paidShare -> share 1 for a promo), and the
            webhook books it as an ordinary 'purchase' row. 0165 reads only the ledger's credit amount, so a friend who
            redeems the promo earns the referrer 200 credits that nobody paid for; with sock accounts, up to the monthly cap
            per referrer account.

BR-0165-03  The programme's money settings skip the owner's second factor. set_referral_settings checks is_platform_admin()
            only, not owner_guard() (0107: second factor when the owner switched it on, rate limit), so with the gate ON an
            admin session that has NOT typed its authenticator code (aal1) can open the programme and raise the reward (up to
            100,000 credits a referral). 0164, in the same release, puts a mere display switch behind owner_guard().

Each test builds its world inside one rolled-back transaction, with the same helpers as test_sec_referral_rewards.py.
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager

import pytest

from sec_db import SERVICE, as_superuser, user

CREDITS = 200
MIN = 1000
HOLD = 30
TODAY_PAID = ("select count(*) from public.referral_rewards "
              "where paid_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'")

SC = None


@pytest.fixture(autouse=True)
def _scenario(sc):
    global SC
    SC = sc


# ── helpers (as test_sec_referral_rewards.py) ───────────────────────────────

def as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def call(s, actor, query, params=None):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    out = s.run(query, params)
    as_owner(s)
    return out


def ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


def new_user(s, tag):
    who = user(tag, f"{tag}-{uuid.uuid4().hex[:8]}@lab.test")
    as_owner(s)
    s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values (%s, %s, now(), now()) returning 1",
           [who.uid, who.email])
    return who


def workspace(s, who):
    return str(ok(call(s, who, "select public.create_organization(%s)", [f"WS {uuid.uuid4().hex[:6]}"])))


def settings(s):
    as_owner(s)
    today = s.value(TODAY_PAID)
    return ok(call(s, SC.operator, "select public.set_referral_settings(true, false, %s, %s, %s, 60, 10, %s)",
                   [CREDITS, MIN, HOLD, today + 1000]))


def referrer(s):
    who = new_user(s, "ref")
    org = workspace(s, who)
    token = ok(call(s, who, "select public.create_friend_invite(%s)", [org]))["link"]["token"]
    return who, org, token


def friend(s, token):
    who = new_user(s, "friend")
    assert ok(call(s, who, "select public.join_friend_invite(%s)", [token]))["status"] in ("counted", "not_counted")
    return who, workspace(s, who)


def buy(s, org, credits=MIN):
    ext = f"pay_lab{uuid.uuid4().hex[:16]}"
    ok(call(s, SERVICE, "select public.add_purchased_credits(%s, %s, %s, 'lab purchase')", [org, credits, ext]))
    return ext


def refund(s, ext):
    return ok(call(s, SERVICE, "select public.refund_purchased_credits(%s, %s, null, 'lab', 'refund')",
                   [ext, f"rf_{uuid.uuid4().hex[:12]}"]))


def claim(s, who):
    return ok(call(s, who, "select public.claim_referral_rewards()"))


def due(s, invitee):
    as_owner(s)
    s.rows("update public.referral_rewards set release_at = now() - interval '1 second' where invitee_id = %s returning 1",
           [invitee.uid])


def balance(s, org):
    as_owner(s)
    return s.value("select balance from public.credit_accounts where org_id = %s", [org])


def available(s, org):
    as_owner(s)
    return s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])


def hold_ends_unused(s, org, job):
    """Three hours pass and the hold never started a run: the platform's sweeper gives it back (reserve_credits does the
    same lazily on the workspace's next hold)."""
    as_owner(s)
    s.rows("update public.credit_reservations set created_at = now() - interval '3 hours 1 minute' where job_id = %s returning 1",
           [job])
    ok(call(s, SERVICE, "select public.expire_credit_reservations(%s)", [org]))
    as_owner(s)
    assert s.value("select status from public.credit_reservations where job_id = %s", [job]) != "open"


@contextmanager
def world(conn):
    with as_superuser(conn, commit=False) as s:
        yield s


# ── BR-0165-01 ──────────────────────────────────────────────────────────────

def test_BR_0165_01_a_hold_placed_before_the_refund_does_not_let_the_referrer_keep_the_reward(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        ext = buy(s, forg)
        claim(s, ref)
        due(s, f)
        assert claim(s, ref)["paid"] == 1
        without_reward = balance(s, org) - CREDITS

        # The referrer holds every available credit (a "run" that never starts), then the friend's payment is refunded.
        job = f"rj-breach-{uuid.uuid4().hex[:8]}"
        ok(call(s, ref, "select public.reserve_credits(%s, %s, %s)", [org, job, available(s, org)]))
        refund(s, ext)
        claim(s, ref)

        # The hold ends without a run and the workspace is settled again (the Credits page, or the hourly job).
        hold_ends_unused(s, org, job)
        claim(s, ref)
        ok(call(s, SERVICE, "select public.referral_settle_all()"))

        assert balance(s, org) <= without_reward, (
            f"the refunded payment's reward is still in the referrer's workspace: balance {balance(s, org)}, "
            f"{without_reward} without it — the clawback met a hold, recorded a shortfall for good, and the hold was "
            "then released")


# ── BR-0165-02 ──────────────────────────────────────────────────────────────

def test_BR_0165_02_a_pack_credited_by_a_free_promo_is_not_a_qualifying_payment(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        start = balance(s, org)

        # What paddle-webhook books for an allowlisted 100% promo on the Starter pack: full credits, nothing paid.
        txn = f"txn_{uuid.uuid4().hex[:26]}"
        ok(call(s, SERVICE, "select public.add_purchased_credits(%s, %s, %s, %s)",
                [forg, MIN, txn, f"Paddle {txn}: 1× starter · promo dsc_lab (full credits) → {MIN} of {MIN} credits"]))
        ok(call(s, SERVICE, "select public.record_payment_event('paddle', %s, 'transaction.completed', now(), 'processed', "
                            "%s, %s, %s, null, %s, 'USD', 0)",
                [f"evt_{uuid.uuid4().hex[:26]}", f"credited {MIN} credits", forg, txn, MIN]))

        claim(s, ref)
        due(s, f)
        got = claim(s, ref)
        assert (got["held"], got["paid"], balance(s, org)) == (0, 0, start), (
            f"a payment of 0 (grand_total 0, a promo) earned the referrer a reward: {got}, balance {balance(s, org)} "
            f"from {start}")


# ── BR-0165-03 ──────────────────────────────────────────────────────────────

def test_BR_0165_03_with_the_second_factor_gate_on_an_aal1_admin_session_cannot_change_the_referral_money(conn):
    with world(conn) as s:
        as_owner(s)
        s.rows("update public.owner_security_settings set admin_aal2_required = true returning 1")
        s.rows("insert into auth.mfa_factors (user_id, status) values (%s, 'verified') returning 1", [SC.operator.uid])
        before = s.rows("select enabled, referral_credits, referral_min_credits from public.friend_invite_settings")

        claims = SC.operator.claims()
        claims["aal"] = "aal1"
        s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
        s.conn.execute("set local role authenticated")
        assert s.value("select public.admin_aal_ok()") is False, "the gate is on and this session has no second factor"
        out = s.run("select public.set_referral_settings(true, false, 100000, 100000, 7, 365, 1000, 10000)")
        as_owner(s)

        after = s.rows("select enabled, referral_credits, referral_min_credits from public.friend_invite_settings")
        assert after == before, (
            f"an aal1 admin session changed the referral programme's money settings with the second-factor gate on: "
            f"{before} -> {after} ({out!r})")
