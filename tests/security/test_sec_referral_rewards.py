"""Migration 0165: the referral programme. A person who invites a friend earns credits when the friend's FIRST qualifying
payment has cleared a hold: never at sign-up, capped per referrer per month and per platform per day, void on a refund
during the hold and taken back (as far as it is still there) on a refund after it.

This creates credits, so every test is an attack on the money, on the rule, or on what a person can see. What would break
without each:

* the switch or the 0092 milestone defaulting ON (credits paid before the operator looked, or for sign-ups alone, BR-S-010);
* a sign-up, a welcome grant, an operator grant, a small payment, a payment before the friend joined or long after, a payment
  into the referrer's own workspace or one the referrer belongs to, counting as a qualifying payment;
* a reward paid before its hold ends, or paid at all when the payment was refunded during the hold;
* a refund after the payout leaving the reward in place, taking it back twice, or pushing a balance below zero;
* the same payer (one provider customer on both sides) earning a reward;
* the monthly cap per referrer or the platform's daily cap overshot, or a capped reward lost instead of waiting;
* a webhook delivered twice, a second payment, or several settles at the same moment paying more than once;
* anyone reading or writing the referrals table, calling the internal settle, or settling for everyone from a browser;
* the referrer learning who the friend is (an id, an e-mail) from their counts or their own ledger;
* the settings being anyone's but the operator's, or out of range (a reward above the payment that earns it);
* a replay of 0165 resetting anything, a hand-edited body slipping past the drift guard, the rollback running while a
  referral exists, or not putting 0092's bodies back exactly.

Isolation of the table (row by row) is covered by test_sec_isolation.py through sec_expectations.TABLES; the function grants by
test_sec_catalog.py.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from contextlib import contextmanager

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user

CREDITS = 200
MIN = 1000
HOLD = 30
TODAY_PAID = ("select count(*) from public.referral_rewards "
              "where paid_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'")
M0092_PAY = "1cfc1f84f065d73e2cb7e84c18ca6ae2"
M0092_MINE = "b26806d4fdc88a8453e939087d53184c"


# ── helpers ─────────────────────────────────────────────────────────────────

def as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")
    return s


def as_user(s, actor):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    return s


def call(s, actor, query, params=None):
    """One statement as `actor` (the browser's own path, or the service key), then back to the database owner."""
    as_user(s, actor)
    out = s.run(query, params)
    as_owner(s)
    return out


def ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


def mailbox(tag):
    return f"{tag}-{uuid.uuid4().hex[:8]}@lab.test"


def new_user(s, tag="u", *, email=None):
    who = user(tag, email or mailbox(tag))
    as_owner(s)
    s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values (%s, %s, now(), now()) returning 1",
           [who.uid, who.email])
    return who


def workspace(s, who, name=None):
    return str(ok(call(s, who, "select public.create_organization(%s)", [name or f"WS {uuid.uuid4().hex[:6]}"])))


def settings(s, *, enabled=True, milestone=False, credits=CREDITS, min_credits=MIN, hold=HOLD, qualify=60, monthly=10,
             room=1000):
    """The operator sets the programme. `room` = how many more rewards the platform may pay today, on top of whatever
    earlier tests committed."""
    as_owner(s)
    today = s.value(TODAY_PAID)
    return ok(call(s, SC.operator, "select public.set_referral_settings(%s, %s, %s, %s, %s, %s, %s, %s)",
                   [enabled, milestone, credits, min_credits, hold, qualify, monthly, today + room]))


def referrer(s):
    """A confirmed account with a workspace of its own (and its welcome credits) and its link."""
    who = new_user(s, "ref")
    org = workspace(s, who)
    token = ok(call(s, who, "select public.create_friend_invite(%s)", [org]))["link"]["token"]
    return who, org, token


def friend(s, token, *, own_workspace=True):
    """A new account that joins through `token` (0092's rules) and, when asked, makes a workspace it owns."""
    who = new_user(s, "friend")
    assert ok(call(s, who, "select public.join_friend_invite(%s)", [token]))["status"] in ("counted", "not_counted")
    org = workspace(s, who) if own_workspace else None
    return who, org


def buy(s, org, credits=MIN, ext=None):
    """A payment the webhook credits (service role, add_purchased_credits — the only writer of a 'purchase' row)."""
    ext = ext or f"pay_lab{uuid.uuid4().hex[:16]}"
    ok(call(s, SERVICE, "select public.add_purchased_credits(%s, %s, %s, 'lab purchase')", [org, credits, ext]))
    return ext


def refund(s, ext, reason="refund"):
    return ok(call(s, SERVICE, "select public.refund_purchased_credits(%s, %s, null, 'lab', %s)",
                   [ext, f"rf_{uuid.uuid4().hex[:12]}", reason]))


def claim(s, who):
    return ok(call(s, who, "select public.claim_referral_rewards()"))


def mine(s, who):
    return ok(call(s, who, "select public.my_referrals()"))


def due(s, invitee):
    """The hold is over (as if HOLD days had passed)."""
    as_owner(s)
    s.rows("update public.referral_rewards set release_at = now() - interval '1 second' where invitee_id = %s returning 1",
           [invitee.uid])


def rows(s, ref):
    as_owner(s)
    return s.rows("select status, void_reason, credits, clawed, claw_shortfall from public.referral_rewards "
                  "where referrer_id = %s order by created_at, invitee_id", [ref.uid])


def balance(s, org):
    as_owner(s)
    return s.value("select balance from public.credit_accounts where org_id = %s", [org])


def available(s, org):
    as_owner(s)
    return s.value("select balance - reserved from public.credit_accounts where org_id = %s", [org])


def ledger(s, org, prefix):
    as_owner(s)
    return s.value("select count(*) from public.credit_transactions where org_id = %s and external_id like %s",
                   [org, prefix + "%"])


def lots_match(s, org):
    as_owner(s)
    return s.value("select (select coalesce(sum(remaining), 0) from public.credit_lots where org_id = %s and remaining > 0) "
                   "= (select balance from public.credit_accounts where org_id = %s)", [org, org])


SC = None


@pytest.fixture(autouse=True)
def _scenario(sc):
    global SC
    SC = sc


@contextmanager
def world(conn):
    with as_superuser(conn, commit=False) as s:
        yield s


# ── the switch and the defaults ─────────────────────────────────────────────

def test_the_programme_and_the_milestone_are_off_by_default_and_the_terms_read_the_same_numbers(conn):
    with world(conn) as s:
        row = s.rows("select enabled, milestone_enabled, referral_credits, referral_min_credits, referral_hold_days, "
                     "referral_qualify_days, referral_monthly_cap, referral_daily_cap from public.friend_invite_settings")
        assert row == [(False, False, 200, 1000, 30, 60, 10, 50)], row
        terms = ok(call(s, ANON, "select public.referral_terms()"))
        assert (terms["enabled"], terms["credits"], terms["min_credits"], terms["hold_days"], terms["qualify_days"],
                terms["monthly_cap"], terms["daily_cap"]) == (False, 200, 1000, 30, 60, 10, 50)
        assert set(terms) == {"enabled", "credits", "min_credits", "hold_days", "qualify_days", "monthly_cap", "daily_cap",
                              "link_hourly_cap", "new_account_days", "updated_at"}
        assert terms["new_account_days"] == 3


def test_sign_ups_alone_pay_nothing_now_that_the_milestone_has_its_own_switch(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        start = balance(s, org)
        for _ in range(6):
            friend(s, token)
        assert claim(s, ref)["joined"] == 6
        ok(call(s, ref, "select public.claim_friend_invite_reward()"))
        assert ok(call(s, ref, "select public.my_friend_invite()"))["pending"] is False
        as_owner(s)
        assert s.value("select count(*) from public.friend_invite_rewards where user_id = %s", [ref.uid]) == 0
        assert (balance(s, org), ledger(s, org, "invite-reward:"), ledger(s, org, "referral-")) == (start, 0, 0)
        assert rows(s, ref) == []


def test_the_milestone_switched_on_still_pays_0092s_reward_once(conn):
    with world(conn) as s:
        settings(s, milestone=True)
        ref, org, token = referrer(s)
        start = balance(s, org)
        for _ in range(5):
            friend(s, token, own_workspace=False)
        as_owner(s)
        assert s.value("select count(*) from public.friend_invite_rewards where user_id = %s", [ref.uid]) == 1
        assert balance(s, org) == start + 100


# ── what qualifies ──────────────────────────────────────────────────────────

def test_a_first_payment_is_held_then_paid_once_as_an_ordinary_grant_authored_by_the_referrer(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        start = balance(s, org)
        buy(s, forg)
        got = claim(s, ref)
        assert (got["joined"], got["held"], got["due"], got["paid"], got["earned"]) == (1, 1, 0, 0, 0)
        assert got["next_release_at"] is not None
        assert rows(s, ref) == [("held", None, CREDITS, 0, 0)]
        assert (balance(s, org), ledger(s, org, "referral-reward:")) == (start, 0), "nothing is paid during the hold"

        due(s, f)
        got = claim(s, ref)
        assert (got["held"], got["paid"], got["earned"], got["paid_this_month"]) == (0, 1, CREDITS, 1)
        assert balance(s, org) == start + CREDITS
        as_owner(s)
        ref_key = s.value("select ref::text from public.referral_rewards where invitee_id = %s", [f.uid])
        kind, amount, note, author, ext = s.rows(
            "select kind, amount, note, created_by::text, external_id from public.credit_transactions "
            "where org_id = %s and external_id like 'referral-reward:%%'", [org])[0]
        assert (kind, amount, note, author, ext) == ("grant", CREDITS, "referral reward", ref.uid, f"referral-reward:{ref_key}")
        assert f.uid not in ext, "the referrer's ledger never names the friend"
        assert lots_match(s, org)
        assert s.value("select count(*) from public.credit_lots where org_id = %s and source = 'grant' and amount = %s",
                       [org, CREDITS]) >= 1

        for _ in range(3):
            claim(s, ref)
        assert (balance(s, org), ledger(s, org, "referral-reward:")) == (start + CREDITS, 1), "a second settle pays nothing"


def test_only_a_real_payment_of_the_friends_own_workspace_qualifies(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        # The welcome grant (0027) is already there. An operator grant is not a payment either.
        ok(call(s, SC.operator, "select public.grant_credits(%s, 5000, 'lab grant')", [forg]))
        buy(s, forg, MIN - 1)                                  # below the minimum
        buy(s, org, 5000)                                      # into the referrer's own workspace
        buy(s, SC.bob.org, 5000)                               # a workspace the friend does not own
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []

        # A workspace the friend owns but the referrer belongs to is the referrer paying.
        shared = workspace(s, f)
        as_owner(s)
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
               [shared, ref.uid, ref.email])
        buy(s, shared, 5000)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []

        # The real thing: the friend's own workspace, at least the minimum.
        buy(s, forg, MIN)
        assert claim(s, ref)["held"] == 1


def test_the_new_account_window_the_terms_state_is_the_one_a_join_applies(conn):
    with world(conn) as s:
        settings(s)
        days = ok(call(s, ANON, "select public.referral_terms()"))["new_account_days"]
        ref, org, token = referrer(s)
        as_owner(s)
        # The link is older than every account below, so the window is the only rule at work.
        s.rows("update public.friend_invite_links set created_at = now() - interval '30 days' where token = %s returning 1", [token])
        for age, want in ((days - 1, "counted"), (days + 1, "existing")):
            who = new_user(s, "aged")
            s.rows("update auth.users set created_at = now() - make_interval(days => %s) where id = %s returning 1", [age, who.uid])
            assert ok(call(s, who, "select public.join_friend_invite(%s)", [token]))["status"] == want, (age, want)


def test_a_payment_before_joining_or_after_the_window_does_not_qualify(conn):
    with world(conn) as s:
        settings(s, qualify=10)
        ref, org, token = referrer(s)
        early, eorg = friend(s, token)
        late, lorg = friend(s, token)
        as_owner(s)
        # The early friend's payment predates their join; the late friend joined 11 days before paying.
        s.rows("update public.friend_invite_joins set created_at = now() + interval '1 minute' where invitee_id = %s returning 1",
               [early.uid])
        s.rows("update public.friend_invite_joins set created_at = now() - interval '11 days' where invitee_id = %s returning 1",
               [late.uid])
        buy(s, eorg)
        buy(s, lorg)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []


def test_the_earliest_qualifying_payment_decides_once_and_a_second_one_never_pays_again(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        first = buy(s, forg)
        buy(s, forg, 5000)
        claim(s, ref)
        as_owner(s)
        assert s.rows("select purchase_external_id from public.referral_rewards where invitee_id = %s", [f.uid]) == [(first,)]
        due(s, f)
        claim(s, ref)
        claim(s, ref)
        assert [r[0] for r in rows(s, ref)] == ["paid"]
        assert ledger(s, org, "referral-reward:") == 1


def test_a_webhook_delivered_twice_is_one_payment_and_one_referral(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        ext = buy(s, forg)
        dup = ok(call(s, SERVICE, "select public.add_purchased_credits(%s, %s, %s, 'lab purchase')", [forg, MIN, ext]))
        assert dup["duplicate"] is True
        claim(s, ref)
        due(s, f)
        claim(s, ref)
        assert [r[0] for r in rows(s, ref)] == ["paid"]
        assert ledger(s, org, "referral-reward:") == 1


# ── self-referral ───────────────────────────────────────────────────────────

def test_the_referrer_cannot_be_their_own_friend_by_account_or_mailbox(conn):
    with world(conn) as s:
        settings(s)
        base = uuid.uuid4().hex[:8]
        ref = new_user(s, "ref", email=f"Self.Ref{base}+one@gmail.com")
        org = workspace(s, ref)
        token = ok(call(s, ref, "select public.create_friend_invite(%s)", [org]))["link"]["token"]
        assert ok(call(s, ref, "select public.join_friend_invite(%s)", [token]))["status"] == "self"
        twin = new_user(s, "twin", email=f"selfref{base}@googlemail.com")
        assert ok(call(s, twin, "select public.join_friend_invite(%s)", [token]))["status"] == "self"
        buy(s, workspace(s, twin))
        assert claim(s, ref)["joined"] == 0 and rows(s, ref) == []


def test_the_same_payer_on_both_sides_is_void_and_never_paid(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        as_owner(s)
        plan = s.value("select id from public.plans order by id limit 1")
        cus = f"cus_Lab{uuid.uuid4().hex[:10]}"
        for o in (org, forg):
            s.rows("insert into public.subscriptions (org_id, provider, provider_subscription_id, provider_customer_id, plan_id, status) "
                   "values (%s, 'dodo', %s, %s, %s, 'active') returning 1", [o, f"sub_Lab{uuid.uuid4().hex[:10]}", cus, plan])
        start = balance(s, org)
        buy(s, forg)
        claim(s, ref)
        assert rows(s, ref) == [("void", "same_payer", CREDITS, 0, 0)]
        due(s, f)
        got = claim(s, ref)
        assert (got["void"], got["paid"], balance(s, org), ledger(s, org, "referral-")) == (1, 0, start, 0)


# ── refunds: void in the hold, clawback after ───────────────────────────────

def test_a_refund_during_the_hold_voids_the_referral_and_nothing_is_ever_paid(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        start = balance(s, org)
        ext = buy(s, forg)
        claim(s, ref)
        refund(s, ext)
        due(s, f)
        got = claim(s, ref)
        assert rows(s, ref) == [("void", "refunded", CREDITS, 0, 0)]
        assert (got["void"], got["paid"], got["earned"], balance(s, org), ledger(s, org, "referral-")) == (1, 0, 0, start, 0)


def test_a_chargeback_before_the_first_settle_voids_it_and_paying_again_does_not_requalify(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        ext = buy(s, forg)
        refund(s, ext, "chargeback")
        buy(s, forg, 5000)
        claim(s, ref)
        due(s, f)
        claim(s, ref)
        assert rows(s, ref) == [("void", "refunded", CREDITS, 0, 0)]
        assert ledger(s, org, "referral-") == 0


def test_a_refund_after_the_payout_takes_the_reward_back_once(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        ext = buy(s, forg)
        claim(s, ref)
        due(s, f)
        claim(s, ref)
        paid = balance(s, org)
        refund(s, ext)
        got = claim(s, ref)
        assert rows(s, ref) == [("clawed", None, CREDITS, CREDITS, 0)]
        assert (got["clawed"], got["clawed_credits"], got["paid"], got["earned"]) == (1, CREDITS, 0, 0)
        assert balance(s, org) == paid - CREDITS
        as_owner(s)
        kind, amount, author = s.rows("select kind, amount, created_by::text from public.credit_transactions "
                                      "where org_id = %s and external_id like 'referral-clawback:%%'", [org])[0]
        assert (kind, amount, author) == ("adjust", -CREDITS, ref.uid)
        assert lots_match(s, org)
        claim(s, ref)
        refund(s, ext)  # a second refund of the same payment
        claim(s, ref)
        assert (balance(s, org), ledger(s, org, "referral-clawback:")) == (paid - CREDITS, 1), "taken back once"


def test_a_clawback_never_takes_more_than_is_available_and_records_the_shortfall(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        ext = buy(s, forg)
        claim(s, ref)
        due(s, f)
        claim(s, ref)
        # The referrer starts a run that holds all but 50 credits: those are not theirs to give back any more.
        hold = available(s, org) - 50
        ok(call(s, ref, "select public.reserve_credits(%s, %s, %s)", [org, f"rj-lab-{uuid.uuid4().hex[:8]}", hold]))
        before = balance(s, org)
        refund(s, ext)
        claim(s, ref)
        assert rows(s, ref) == [("clawed", None, CREDITS, 50, CREDITS - 50)]
        assert balance(s, org) == before - 50
        assert available(s, org) == 0, "never below zero: the hold keeps its credits"
        assert lots_match(s, org)
        as_owner(s)
        note = s.value("select note from public.credit_transactions where org_id = %s and external_id like 'referral-clawback:%%'",
                       [org])
        assert "150.00 already spent" in note and f.uid not in note and f.email not in note


# ── caps ────────────────────────────────────────────────────────────────────

def test_the_monthly_cap_pays_up_to_it_and_keeps_the_rest_waiting_for_next_month(conn):
    with world(conn) as s:
        settings(s, monthly=2)
        ref, org, token = referrer(s)
        friends = [friend(s, token) for _ in range(3)]
        for _, forg in friends:
            buy(s, forg)
        claim(s, ref)
        for who, _ in friends:
            due(s, who)
        got = claim(s, ref)
        assert (got["paid"], got["held"], got["due"], got["paid_this_month"]) == (2, 1, 1, 2)
        assert ledger(s, org, "referral-reward:") == 2
        # A new month: last month's payouts no longer count.
        as_owner(s)
        s.rows("update public.referral_rewards set paid_at = now() - interval '40 days' "
               "where referrer_id = %s and status = 'paid' returning 1", [ref.uid])
        got = claim(s, ref)
        assert (got["paid"], got["held"]) == (3, 0)
        assert ledger(s, org, "referral-reward:") == 3


def test_the_platform_daily_cap_keeps_a_due_reward_waiting_not_lost(conn):
    with world(conn) as s:
        settings(s, room=1)
        a = referrer(s)
        b = referrer(s)
        fa, fao = friend(s, a[2])
        fb, fbo = friend(s, b[2])
        buy(s, fao)
        buy(s, fbo)
        claim(s, a[0])
        claim(s, b[0])
        due(s, fa)
        due(s, fb)
        assert claim(s, a[0])["paid"] == 1
        assert (claim(s, b[0])["paid"], mine(s, b[0])["due"]) == (0, 1)
        settings(s, room=1)
        assert claim(s, b[0])["paid"] == 1


def test_closing_the_programme_qualifies_nothing_new_but_pays_what_is_held(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        later, lorg = friend(s, token)
        buy(s, forg)
        claim(s, ref)
        settings(s, enabled=False)
        buy(s, lorg)
        due(s, f)
        got = claim(s, ref)
        assert (got["paid"], got["held"]) == (1, 0)
        assert len(rows(s, ref)) == 1, "no new referral while the programme is closed"


# ── who may see and do what ─────────────────────────────────────────────────

def test_nobody_reads_or_writes_the_referrals_and_nobody_calls_the_internals(conn, sc):
    with world(conn) as s:
        for who in (ANON, sc.alice.actor, sc.stranger, SERVICE):
            out = call(s, who, "select * from public.referral_rewards")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
            out = call(s, who, "insert into public.referral_rewards (invitee_id) values (gen_random_uuid())")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        for who in (ANON, sc.alice.actor, SERVICE):
            out = call(s, who, "select public.referral_settle_locked(l) from public.friend_invite_links l limit 1")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        for who in (ANON, sc.alice.actor, sc.operator):
            out = call(s, who, "select public.referral_settle_all()")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        for fn in ("my_referrals", "claim_referral_rewards", "referral_admin"):
            out = call(s, ANON, f"select public.{fn}()")
            assert not out.ok and out.sqlstate == "42501", (fn, out)
        got = ok(call(s, SERVICE, "select public.referral_settle_all()"))
        assert set(got) == {"links", "changed", "failed"} and got["failed"] == 0


def test_a_referrer_sees_counts_only_never_who_and_never_anyone_elses(conn, sc):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg)
        got = claim(s, ref)
        assert set(got) == {"enabled", "credits", "min_credits", "hold_days", "qualify_days", "monthly_cap", "link", "joined",
                            "held", "due", "next_release_at", "paid", "earned", "paid_this_month", "clawed", "clawed_credits",
                            "void", "milestone_credits"}
        text = json.dumps(got)
        for secret in (f.uid, f.email, forg):
            assert secret not in text
        assert set(got["link"]) == {"token", "created_at"}
        # Alice's seeded referral is hers alone; a stranger sees nothing of it.
        other = mine(s, sc.stranger)
        assert (other["link"], other["joined"], other["held"]) == (None, 0, 0)
        assert mine(s, sc.alice.actor)["held"] >= 1


def test_the_numbers_are_the_platform_operators_alone_and_range_checked(conn, sc):
    with world(conn) as s:
        for who in (sc.alice.actor, sc.stranger):
            out = call(s, who, "select public.set_referral_settings(true, false, 200, 1000, 30, 60, 10, 50)")
            assert not out.ok and out.sqlstate == "42501", out
            out = call(s, who, "select public.referral_admin()")
            assert not out.ok and out.sqlstate == "42501", out
        out = call(s, ANON, "select public.set_referral_settings(true, false, 200, 1000, 30, 60, 10, 50)")
        assert not out.ok, out
        for bad in ("(true, false, 0, 1000, 30, 60, 10, 50)",       # no reward
                    "(true, false, 1001, 1000, 30, 60, 10, 50)",    # a reward above the payment that earns it
                    "(true, false, 200, 1000, 6, 60, 10, 50)",      # a hold too short to see a refund
                    "(true, false, 200, 1000, 30, 0, 10, 50)",
                    "(true, false, 200, 1000, 30, 60, 0, 50)",
                    "(true, false, 200, 1000, 30, 60, 10, -1)",
                    "(null, false, 200, 1000, 30, 60, 10, 50)",
                    "(true, null, 200, 1000, 30, 60, 10, 50)"):
            out = call(s, sc.operator, f"select public.set_referral_settings{bad}")
            assert not out.ok and out.sqlstate == "22023", (bad, out)
        as_owner(s)
        s.rows("update public.friend_invite_settings set referral_updated_at = now() - interval '9 days' where id returning 1")
        stamp = s.value("select referral_updated_at from public.friend_invite_settings")
        ok(call(s, sc.operator, "select public.set_referral_settings(false, false, 200, 1000, 30, 60, 10, 50)"))
        as_owner(s)
        assert s.value("select referral_updated_at from public.friend_invite_settings") == stamp, \
            "saving the same numbers does not re-date the public terms"
        got = ok(call(s, sc.operator, "select public.set_referral_settings(false, false, 250, 1000, 30, 60, 10, 50)"))
        assert got["credits"] == 250
        as_owner(s)
        assert s.value("select referral_updated_at from public.friend_invite_settings") > stamp


# ── concurrency (committed, fresh people) ───────────────────────────────────

def _dsn(conn) -> str:
    return psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)


def _race(conn, bodies):
    barrier = threading.Barrier(len(bodies))
    results = [None] * len(bodies)

    def worker(i):
        with psycopg.connect(_dsn(conn), autocommit=True) as c:
            try:
                results[i] = bodies[i](c, barrier)
            except Exception as e:  # noqa: BLE001 — a refusal is a result here
                results[i] = e

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(len(bodies))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    return results


def _committed(conn, fn):
    with as_superuser(conn, commit=True) as s:
        return fn(s)


def _restore_defaults(conn):
    with acting(conn, SC.operator, commit=True) as s:
        s.value("select public.set_referral_settings(false, false, 200, 1000, 30, 60, 10, 50)")


def _committed_due_referral(conn, **kw):
    def build(s):
        settings(s, **kw)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg)
        claim(s, ref)
        due(s, f)
        as_owner(s)
        return ref, org, balance(s, org)
    return _committed(conn, build)


def test_five_settles_at_the_same_moment_pay_exactly_once(conn):
    try:
        ref, org, start = _committed_due_referral(conn)

        def by_referrer(c, barrier):
            barrier.wait()
            with acting(c, ref, commit=True) as s:
                return s.value("select public.claim_referral_rewards()")["paid"]

        def by_platform(c, barrier):
            barrier.wait()
            with acting(c, SERVICE, commit=True) as s:
                return s.value("select public.referral_settle_all()")["failed"]

        results = _race(conn, [by_referrer] * 4 + [by_platform])
        assert not any(isinstance(r, Exception) for r in results), results
        assert results[:4] == [1, 1, 1, 1] and results[4] == 0, results
        with as_superuser(conn, commit=False) as s:
            assert (ledger(s, org, "referral-reward:"), balance(s, org)) == (1, start + CREDITS)
            assert [r[0] for r in rows(s, ref)] == ["paid"]
    finally:
        _restore_defaults(conn)


def test_two_referrers_racing_for_the_last_place_today_pay_one_and_keep_the_other_waiting(conn):
    try:
        a = _committed_due_referral(conn)
        b = _committed_due_referral(conn)
        _committed(conn, lambda s: settings(s, room=1))

        def go(who):
            def body(c, barrier):
                barrier.wait()
                with acting(c, who, commit=True) as s:
                    return s.value("select public.claim_referral_rewards()")["paid"]
            return body

        assert sorted(_race(conn, [go(a[0]), go(b[0])])) == [0, 1]
        _committed(conn, lambda s: settings(s, room=1))
        with acting(conn, a[0], commit=True) as s:
            s.value("select public.claim_referral_rewards()")
        with acting(conn, b[0], commit=True) as s:
            s.value("select public.claim_referral_rewards()")
        with as_superuser(conn, commit=False) as s:
            assert (ledger(s, a[1], "referral-reward:"), ledger(s, b[1], "referral-reward:")) == (1, 1)
    finally:
        _restore_defaults(conn)


# ── replay, drift guard, rollback ───────────────────────────────────────────

def _body(path):
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def _md5(s, sig):
    as_owner(s)
    return s.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)", [sig])


def test_applying_the_migration_again_keeps_the_numbers_and_the_referrals(conn):
    try:
        ref, org, _ = _committed_due_referral(conn, credits=150)
        snap = ("select (select count(*) from public.referral_rewards), "
                "(select referral_credits from public.friend_invite_settings), "
                "(select enabled from public.friend_invite_settings), "
                "(select milestone_enabled from public.friend_invite_settings)")
        with as_superuser(conn, commit=False) as s:
            before = s.rows(snap)[0]
        for _ in range(2):
            sec_db.apply_files(_dsn(conn), [sec_db.MIGRATION_0165])
        with as_superuser(conn, commit=False) as s:
            assert s.rows(snap)[0] == before
    finally:
        _restore_defaults(conn)


def test_the_drift_guard_refuses_a_body_edited_by_hand(conn):
    with world(conn) as s:
        text = s.value("select pg_get_functiondef('public.referral_settle_locked(public.friend_invite_links)'::regprocedure)")
        s.rows(re.sub(r"return changed;", "return changed + 0;", text, count=1) + "; select 1")
        out = s.run(sec_db.MIGRATION_0165.read_text(encoding="utf-8"))
        assert not out.ok and "0165 found public.referral_settle_locked" in out.error, out


def test_the_rollback_refuses_while_a_referral_exists_then_puts_0092_back_exactly(conn):
    with world(conn) as s:
        out = s.run(_body(sec_db.ROLLBACK_0165))
        assert not out.ok and "referral rows exist" in out.error, out
        s.rows("delete from public.referral_rewards returning 1")
        assert s.run(_body(sec_db.ROLLBACK_0165)).ok
        assert _md5(s, "public.friend_invite_pay_locked(public.friend_invite_links)") == M0092_PAY
        assert _md5(s, "public.my_friend_invite()") == M0092_MINE
        assert s.value("select to_regclass('public.referral_rewards') is null and to_regprocedure('public.my_referrals()') is null")
        assert s.value("select count(*) from information_schema.columns where table_schema = 'public' "
                       "and table_name = 'friend_invite_settings' and column_name like 'referral_%%'") == 0
        # …and 0165 goes on again on top of it.
        assert s.run(sec_db.MIGRATION_0165.read_text(encoding="utf-8")).ok


def test_the_mailbox_key_of_the_seeded_friend_is_the_joins_own(conn, sc):
    """The seed row is shaped like a real one (positive control for test_sec_isolation.py)."""
    with world(conn) as s:
        key = hashlib.sha256(sc.dana.email.encode()).hexdigest()
        assert s.value("select count(*) from public.referral_rewards where invitee_email_key = %s", [key]) == 1
