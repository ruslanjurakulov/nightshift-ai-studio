"""Migration 0165: the referral programme. A person who invites a friend earns credits when the friend's FIRST payment, made in
a workspace the friend created, has cleared a hold: never at sign-up, capped per referrer per month and per platform per day,
void on a reversal during the hold and taken back (until nothing is owed) on a reversal after it.

This creates credits, so every test is an attack on the money, on the rule, or on what a person can see. What would break
without each:

* the reward or the 0092 milestone being ON after the migration (credits paid before the operator looked, or for sign-ups
  alone, BR-S-010), or a join or payment from before the programme started counting;
* a sign-up, a grant, a small first payment, a payment of nothing (a 100% promo, no provider event), a payment before the friend
  joined or long after, a payment into the referrer's workspace, an older workspace that makes the friend its owner, or a
  workspace that already paid before, counting as a qualifying payment;
* a membership overlap (referrer in the friend's workspace, friend in the referrer's) or the same payer earning a reward;
* a reward paid before its hold ends, or paid at all when the payment was refunded, charged back or disputed during the hold
  (a credit_refunds row, or only the provider's own event);
* a reversal after the payout leaving the reward in place, taking it back twice, taking plan credits before the reward's own,
  pushing a balance below zero, or a hold letting the referrer keep it for good;
* the monthly cap per referrer or the platform's daily cap overshot, or a capped reward lost instead of waiting;
* a webhook delivered twice, a second payment, or several settles at the same moment paying more than once;
* anyone reading or writing the two tables, calling the internals, or settling for everyone from a browser;
* the referrer learning who the friend is (an id, an e-mail, a payment time) from their counts or their own ledger;
* the settings being anyone's but the operator's, skipping owner_guard, unaudited, or out of range;
* the settle job's runs not being visible, a batch taking every link, a join waiting forever behind a settle;
* a replay of 0165 resetting anything, a hand-edited body slipping past the drift guard, the rollback running while a
  referral exists, or not putting the earlier bodies back exactly.

Isolation of the tables (row by row) is covered by test_sec_isolation.py through sec_expectations.TABLES; the function grants
by test_sec_catalog.py. Breach's attacks on this migration are in test_sec_breach_referral_0165.py.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
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
BEFORE = {"public.friend_invite_pay_locked(public.friend_invite_links)": "1cfc1f84f065d73e2cb7e84c18ca6ae2",
          "public.my_friend_invite()": "b26806d4fdc88a8453e939087d53184c",
          "public.join_friend_invite(text)": "549632bae0dbb002dc66200d7f6c0998",
          "public.credit_transactions_apply_lots()": "8ab35cff8ac8a145403b0e6eca735697"}


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
    """The operator sets the programme through owner_guard. `room` = how many more rewards the platform may pay today."""
    as_owner(s)
    today = s.value(TODAY_PAID)
    got = ok(call(s, SC.operator, "select public.set_referral_settings(%s, %s, %s, %s, %s, %s, %s, %s)",
                  [enabled, milestone, credits, min_credits, hold, qualify, monthly, today + room]))
    assert "error" not in got, got
    return got


def referrer(s):
    """A confirmed account with a workspace of its own (and its welcome credits) and its link."""
    who = new_user(s, "ref")
    org = workspace(s, who)
    token = ok(call(s, who, "select public.create_friend_invite(%s)", [org]))["link"]["token"]
    return who, org, token


def friend(s, token, *, own_workspace=True):
    """A new account that joins through `token` (0092's rules) and then, when asked, creates a workspace it owns."""
    who = new_user(s, "friend")
    assert ok(call(s, who, "select public.join_friend_invite(%s)", [token]))["status"] in ("counted", "not_counted")
    org = workspace(s, who) if own_workspace else None
    return who, org


def pay_event(s, provider, ext, org, credits, paid_minor, event_type=None, status="processed"):
    event_type = event_type or ("transaction.completed" if provider == "paddle" else "payment.succeeded")
    ok(call(s, SERVICE, "select public.record_payment_event(%s, %s, %s, now(), %s, 'lab', %s, %s, null, %s, 'USD', %s)",
            [provider, f"evt_{uuid.uuid4().hex}", event_type, status, org, ext, credits, paid_minor]))


def buy(s, org, credits=MIN, *, paid_minor=1000, ext=None, provider="paddle", event=True):
    """A payment as the webhook books it: the ledger row (add_purchased_credits, service role) and the provider's event."""
    ext = ext or f"pay_lab{uuid.uuid4().hex[:16]}"
    ok(call(s, SERVICE, "select public.add_purchased_credits(%s, %s, %s, 'lab purchase')", [org, credits, ext]))
    if event:
        pay_event(s, provider, ext, org, credits, paid_minor)
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


def paid_referral(s):
    """A referrer whose friend's payment has been paid out (200 credits added)."""
    settings(s)
    ref, org, token = referrer(s)
    f, forg = friend(s, token)
    ext = buy(s, forg)
    claim(s, ref)
    due(s, f)
    assert claim(s, ref)["paid"] == 1
    return ref, org, f, forg, ext


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


def md5_of(s, sig):
    as_owner(s)
    return s.value("select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(%s)", [sig])


SC = None


@pytest.fixture(autouse=True)
def _scenario(sc):
    global SC
    SC = sc


@contextmanager
def world(conn):
    with as_superuser(conn, commit=False) as s:
        yield s


# ── what changes on apply ───────────────────────────────────────────────────

def test_after_the_migration_the_reward_and_the_milestone_are_off_and_the_programme_has_never_been_open(conn):
    with world(conn) as s:
        row = s.rows("select referral_enabled, milestone_enabled, referral_credits, referral_min_credits, referral_hold_days, "
                     "referral_qualify_days, referral_monthly_cap, referral_daily_cap, "
                     "(select count(*) from public.referral_open_periods where closed_at is null) "
                     "from public.friend_invite_settings")
        assert row == [(False, False, 200, 1000, 30, 60, 10, 50, 0)], row
        # The identity sequences' default grants are taken back from the API roles.
        for seq in ("referral_settle_runs", "referral_open_periods"):
            for role in ("anon", "authenticated"):
                assert s.value("select has_sequence_privilege(%s, pg_get_serial_sequence(%s, 'id'), 'USAGE')",
                               [role, f"public.{seq}"]) is False, (seq, role)
        terms = ok(call(s, ANON, "select public.referral_terms()"))
        assert (terms["enabled"], terms["credits"], terms["min_credits"], terms["hold_days"], terms["qualify_days"],
                terms["monthly_cap"], terms["daily_cap"], terms["new_account_days"]) == (False, 200, 1000, 30, 60, 10, 50, 3)
        assert set(terms) == {"enabled", "credits", "min_credits", "hold_days", "qualify_days", "monthly_cap", "daily_cap",
                              "link_hourly_cap", "new_account_days", "updated_at"}


def test_with_0092s_switch_on_and_the_reward_off_a_payment_still_earns_nothing(conn):
    """Live had 0092's `enabled` true: links and joins work, and still nothing is paid until the reward is switched on."""
    with world(conn) as s:
        as_owner(s)
        s.rows("update public.friend_invite_settings set enabled = true where id returning 1")
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg)
        got = claim(s, ref)
        assert (got["enabled"], got["joined"], got["held"]) == (False, 1, 0)
        assert rows(s, ref) == []


def periods(s, *spans):
    """Replace the open periods with these (start, end) offsets from now; an end of None is still open."""
    as_owner(s)
    s.conn.execute("delete from public.referral_open_periods")
    for start, end in spans:
        s.rows("insert into public.referral_open_periods (opened_at, closed_at) values (now() + %s::interval, "
               "now() + %s::interval) returning 1", [start, end])


def joined_at(s, who, offset):
    as_owner(s)
    s.rows("update public.friend_invite_joins set created_at = now() + %s::interval where invitee_id = %s returning 1", [offset, who.uid])


def test_a_payment_made_while_the_programme_was_closed_never_counts_after_it_reopens(conn):
    """A1: open, a friend joins, the programme closes, the friend pays, it reopens: the payment fell in the closed gap."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        joined_at(s, f, "-90 minutes")
        periods(s, ("-2 hours", "-1 hour"), ("1 second", None))  # open, closed now (the payment), open again later
        buy(s, forg)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []
        # The same payment inside a reopened period counts: the period history, not a fresh start, decides.
        periods(s, ("-2 hours", "-1 hour"), ("-1 minute", None))
        assert claim(s, ref)["held"] == 1


def test_a_join_made_while_the_programme_was_closed_never_counts(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        joined_at(s, f, "-45 minutes")
        periods(s, ("-2 hours", "-1 hour"), ("-30 minutes", None))
        buy(s, forg)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []


def test_switching_the_reward_on_and_off_writes_the_open_periods_in_its_audit(conn, sc):
    with world(conn) as s:
        as_owner(s)
        before = s.value("select count(*) from public.referral_open_periods")
        settings(s)
        as_owner(s)
        assert s.value("select count(*) from public.referral_open_periods where closed_at is null") == 1
        settings(s)  # on again: no second period
        settings(s, enabled=False)
        as_owner(s)
        assert s.value("select count(*) from public.referral_open_periods") == before + 1
        assert s.value("select count(*) from public.referral_open_periods where closed_at is null") == 0
        detail = s.value("select detail from public.security_events where kind = 'referral.settings' order by id desc limit 1")
        assert detail["period"] == "closed"


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
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", got["next_release_on"]), "a day, never the moment of the friend's payment"
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
        assert s.value("select count(*) from public.credit_lots where org_id = %s and source = 'grant' and external_id = %s",
                       [org, ext]) == 1, "the reward is its own lot, named by its ledger row"
        for _ in range(3):
            claim(s, ref)
        assert (balance(s, org), ledger(s, org, "referral-reward:")) == (start + CREDITS, 1), "a second settle pays nothing"


def test_grants_and_payments_outside_the_friends_own_new_workspace_never_qualify(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        ok(call(s, SC.operator, "select public.grant_credits(%s, 5000, 'lab grant')", [forg]))   # not a payment
        buy(s, org, 5000)                                                                       # the referrer's own
        buy(s, SC.bob.org, 5000)                                                                # not the friend's
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []
        buy(s, forg)                                                                            # the real thing
        assert claim(s, ref)["held"] == 1


def test_an_older_paying_workspace_that_makes_the_friend_its_owner_never_qualifies(conn):
    """H1: a workspace W that already pays promotes a freshly joined account to owner; W's renewals must not become a
    permanent rebate. Only a workspace the friend CREATED after joining, on its FIRST payment ever, qualifies."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        owner_w = new_user(s, "w-owner")
        w = workspace(s, owner_w)
        buy(s, w)                                                     # W already paid
        f, _ = friend(s, token, own_workspace=False)
        as_owner(s)
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'owner') returning 1",
               [w, f.uid, f.email])
        buy(s, w, 5000)                                               # W's renewal
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []
        # A workspace the friend created BEFORE joining does not qualify either.
        g, _ = friend(s, token, own_workspace=False)
        early = workspace(s, g)
        as_owner(s)
        s.rows("update public.organizations set created_at = now() - interval '1 hour' where id = %s returning 1", [early])
        buy(s, early)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []


def test_a_small_first_payment_spends_the_workspaces_chance(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg, MIN - 1)
        buy(s, forg, 5000)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []


def test_a_payment_of_nothing_or_at_a_discount_is_not_a_payment_and_uses_up_nothing(conn):
    """M1, A2, B4: credits booked for a $0 trial, a promo or any discount (paddle-webhook marks the event) are not a payment:
    they never qualify and do not use up the workspace's chance; the next full-price payment does. A ledger row whose
    provider event is not there (yet) decides nothing until it is."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg, paid_minor=0)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []
        promo = buy(s, forg, event=False)
        ok(call(s, SERVICE, "select public.record_payment_event('paddle', %s, 'transaction.completed', now(), 'processed', "
                            "%s, %s, %s, null, 1000, 'USD', 1)",
                [f"evt_{uuid.uuid4().hex}", "credited 1000 credits · discounted (promo dsc_lab)", forg, promo]))
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []
        full = buy(s, forg)
        assert claim(s, ref)["held"] == 1
        as_owner(s)
        assert s.value("select purchase_external_id from public.referral_rewards where invitee_id = %s", [f.uid]) == full
        g, gorg = friend(s, token)
        ext = buy(s, gorg, event=False)
        assert claim(s, ref)["held"] == 1
        pay_event(s, "dodo", ext, gorg, MIN, 900)
        assert claim(s, ref)["held"] == 2


def test_a_near_free_usd_payment_is_below_the_floor(conn):
    """A2: in USD a payment must be at least half the minimum's base price (1 credit = 1 US cent): 500 cents for 1000."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg, paid_minor=499)
        assert claim(s, ref)["held"] == 0 and rows(s, ref) == []
        g, gorg = friend(s, token)
        buy(s, gorg, paid_minor=500)
        assert claim(s, ref)["held"] == 1


def test_the_window_runs_from_the_account_and_a_join_recorded_late_still_counts(conn):
    """B2: the friend's account anchors the rule, so a join recorded after the friend made a workspace and paid (a retried
    cookie) does not void it; a payment past the window from the account's creation does not qualify."""
    with world(conn) as s:
        settings(s, qualify=10)
        ref, org, token = referrer(s)
        late, lorg = friend(s, token)
        buy(s, lorg)
        joined_at(s, late, "1 minute")  # recorded after the payment
        periods(s, ("-1 hour", None))
        assert claim(s, ref)["held"] == 1
        old, oorg = friend(s, token)
        as_owner(s)
        s.rows("update auth.users set created_at = now() - interval '11 days' where id = %s returning 1", [old.uid])
        buy(s, oorg)
        assert claim(s, ref)["held"] == 1, "a payment 11 days after the account, with a 10-day window, does not qualify"


def test_the_new_account_window_the_terms_state_is_the_one_a_join_applies(conn):
    with world(conn) as s:
        settings(s)
        days = ok(call(s, ANON, "select public.referral_terms()"))["new_account_days"]
        ref, org, token = referrer(s)
        as_owner(s)
        s.rows("update public.friend_invite_links set created_at = now() - interval '30 days' where token = %s returning 1", [token])
        for age, want in ((days - 1, "counted"), (days + 1, "existing")):
            who = new_user(s, "aged")
            s.rows("update auth.users set created_at = now() - make_interval(days => %s) where id = %s returning 1", [age, who.uid])
            assert ok(call(s, who, "select public.join_friend_invite(%s)", [token]))["status"] == want, (age, want)


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
        pay_event(s, "paddle", ext, forg, MIN, 1000, status="duplicate")
        claim(s, ref)
        due(s, f)
        claim(s, ref)
        assert [r[0] for r in rows(s, ref)] == ["paid"]
        assert ledger(s, org, "referral-reward:") == 1


# ── self-referral and overlaps ──────────────────────────────────────────────

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


def test_a_membership_overlap_is_void_when_it_qualifies_and_when_it_is_due(conn):
    """M2: the referrer in the friend's paying workspace, or the friend in the link's workspace, is the referrer paying.
    org_members keeps no history, so both moments (qualifying, paying) are checked and the outcome is recorded."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        a, aorg = friend(s, token)
        b, borg = friend(s, token)
        c, corg = friend(s, token)
        as_owner(s)
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
               [aorg, ref.uid, ref.email])                     # the referrer sits in A's workspace
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
               [org, b.uid, b.email])                          # B sits in the referrer's workspace
        for o in (aorg, borg, corg):
            buy(s, o)
        claim(s, ref)
        as_owner(s)
        got = dict(s.rows("select invitee_id::text, coalesce(void_reason, status) from public.referral_rewards where referrer_id = %s",
                          [ref.uid]))
        assert (got[a.uid], got[b.uid], got[c.uid]) == ("member", "member", "held")
        # C's workspace takes the referrer in while C's payment is on hold: void at the moment of paying.
        s.rows("insert into public.org_members (org_id, user_id, email, role) values (%s, %s, %s, 'viewer') returning 1",
               [corg, ref.uid, ref.email])
        due(s, c)
        assert claim(s, ref)["paid"] == 0
        assert s.value("select void_reason from public.referral_rewards where invitee_id = %s", [c.uid]) == "member"
        assert ledger(s, org, "referral-reward:") == 0


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


# ── reversals: void in the hold, clawback after ─────────────────────────────

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


def test_a_reversal_only_the_provider_reported_voids_it_too_and_a_pending_one_does_not(conn):
    """M6: a Dodo dispute that expired, or a Paddle refund a person must take back by hand, writes no credit_refunds row; the
    provider's own event is enough. A refund still waiting for approval (ignored) is not a reversal."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        g, gorg = friend(s, token)
        h, horg = friend(s, token)
        ext_f = buy(s, forg, provider="dodo")
        ext_g = buy(s, gorg)
        ext_h = buy(s, horg)
        claim(s, ref)
        pay_event(s, "dodo", ext_f, forg, None, None, event_type="dispute.expired", status="rejected")
        pay_event(s, "paddle", ext_g, gorg, None, None, event_type="adjustment.created", status="rejected")
        pay_event(s, "paddle", ext_h, horg, None, None, event_type="adjustment.created", status="ignored")
        claim(s, ref)
        as_owner(s)
        got = dict(s.rows("select invitee_id::text, status || ':' || coalesce(reversed_by, '-') from public.referral_rewards "
                          "where referrer_id = %s", [ref.uid]))
        assert (got[f.uid], got[g.uid], got[h.uid]) == ("void:event", "void:event", "held:-")
        assert ok(call(s, SC.operator, "select public.referral_admin()"))["reversed_by_event"] >= 2


def test_a_reversal_after_the_payout_takes_the_reward_back_once_from_its_own_lot_first(conn):
    """M5: the clawback takes the reward's own lot before plan credits (which the ledger spends first by default)."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        # The referrer's workspace has plan credits for this period (a subscription lot, spent first by default).
        sub, start, end = f"sub_Lab{uuid.uuid4().hex[:12]}", "now()", "now() + interval '30 days'"
        ok(call(s, SERVICE, "select public.upsert_subscription_for('dodo', %s, %s, %s, 'pro', 'pdt_LabPro0000000001', 'active', "
                            f"{start}, {end}, false, null, now())", [org, sub, f"cus_Lab{uuid.uuid4().hex[:12]}"]))
        ok(call(s, SERVICE, "select public.grant_subscription_credits_for('dodo', %s, %s, 'pro', " + f"{start}, {end}" +
                            ", %s, 'lab plan', null, 'pdt_LabPro0000000001', 1)", [org, sub, f"pay_LabPlan{uuid.uuid4().hex[:8]}"]))
        f, forg = friend(s, token)
        ext = buy(s, forg)
        claim(s, ref)
        due(s, f)
        claim(s, ref)
        as_owner(s)
        plan_before = s.value("select sum(remaining) from public.credit_lots where org_id = %s and source = 'subscription'", [org])
        paid = balance(s, org)
        refund(s, ext)
        got = claim(s, ref)
        assert rows(s, ref) == [("clawed", None, CREDITS, CREDITS, 0)]
        assert (got["clawed"], got["clawed_credits"], got["claw_owed"], got["paid"], got["earned"]) == (1, CREDITS, 0, 0, 0)
        assert balance(s, org) == paid - CREDITS
        as_owner(s)
        assert s.value("select sum(remaining) from public.credit_lots where org_id = %s and source = 'subscription'", [org]) == plan_before
        assert s.value("select remaining from public.credit_lots where org_id = %s and external_id like 'referral-reward:%%'", [org]) == 0
        kind, amount, author, note = s.rows("select kind, amount, created_by, note from public.credit_transactions "
                                            "where org_id = %s and external_id like 'referral-clawback:%%'", [org])[0]
        assert (kind, amount, author) == ("adjust", -CREDITS, None), "the platform takes it back, not the referrer"
        assert note.startswith("system: ")
        assert lots_match(s, org)
        claim(s, ref)
        refund(s, ext)  # a second refund of the same payment
        claim(s, ref)
        assert (balance(s, org), ledger(s, org, "referral-clawback:")) == (paid - CREDITS, 1), "taken back once"


def test_what_a_clawback_cannot_take_now_stays_owed_and_is_taken_later(conn):
    """BR-0165-01's shape: credits on hold are not spent, so the rest of the reward is taken once they are back."""
    with world(conn) as s:
        ref, org, f, forg, ext = paid_referral(s)
        job = f"rj-lab-{uuid.uuid4().hex[:8]}"
        ok(call(s, ref, "select public.reserve_credits(%s, %s, %s)", [org, job, available(s, org) - 50]))
        before = balance(s, org)
        refund(s, ext)
        got = claim(s, ref)
        assert rows(s, ref) == [("clawing", None, CREDITS, 50, CREDITS - 50)]
        assert (got["claw_owed"], available(s, org)) == (CREDITS - 50, 0)
        assert balance(s, org) == before - 50
        claim(s, ref)
        assert ledger(s, org, "referral-clawback:") == 1, "nothing to take, nothing written"
        # The hold goes back without a run; the next settle takes the rest.
        as_owner(s)
        s.rows("update public.credit_reservations set created_at = now() - interval '3 hours 1 minute' where job_id = %s returning 1", [job])
        ok(call(s, SERVICE, "select public.expire_credit_reservations(%s)", [org]))
        got = claim(s, ref)
        assert rows(s, ref) == [("clawed", None, CREDITS, CREDITS, 0)]
        assert (got["claw_owed"], ledger(s, org, "referral-clawback:")) == (0, 2)
        assert balance(s, org) == before - CREDITS
        assert lots_match(s, org)


# ── caps and the switch ─────────────────────────────────────────────────────

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


def test_switching_the_reward_off_qualifies_nothing_new_but_pays_what_is_held(conn):
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
        assert (got["paid"], got["held"], got["enabled"]) == (1, 0, False)
        assert len(rows(s, ref)) == 1, "no new referral while the reward is off"


# ── who may see and do what ─────────────────────────────────────────────────

def test_nobody_reads_or_writes_the_tables_and_nobody_calls_the_internals(conn, sc):
    with world(conn) as s:
        for table in ("referral_rewards", "referral_settle_runs"):
            for who in (ANON, sc.alice.actor, sc.stranger, SERVICE):
                out = call(s, who, f"select * from public.{table}")
                assert not out.ok and out.sqlstate == "42501", (table, who.name, out)
        out = call(s, sc.alice.actor, "insert into public.referral_rewards (invitee_id) values (gen_random_uuid())")
        assert not out.ok and out.sqlstate == "42501", out
        for who in (ANON, sc.alice.actor, SERVICE):
            out = call(s, who, "select public.referral_settle_locked(l) from public.friend_invite_links l limit 1")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
            out = call(s, who, "select public.referral_payment_reversed('x')")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        for who in (ANON, sc.alice.actor, sc.operator):
            out = call(s, who, "select public.referral_settle_all(5)")
            assert not out.ok and out.sqlstate == "42501", (who.name, out)
        for fn in ("my_referrals", "claim_referral_rewards", "referral_admin"):
            out = call(s, ANON, f"select public.{fn}()")
            assert not out.ok and out.sqlstate == "42501", (fn, out)


def test_a_referrer_sees_counts_only_never_who_and_never_anyone_elses(conn, sc):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg)
        got = claim(s, ref)
        assert set(got) == {"enabled", "credits", "min_credits", "hold_days", "qualify_days", "monthly_cap", "link", "org",
                            "joined", "held", "due", "next_release_on", "paid", "earned", "paid_this_month", "clawed",
                            "clawed_credits", "claw_owed", "void", "milestone_credits"}
        assert got["org"]["id"] == org, "where rewards are added: the link's workspace"
        text = json.dumps(got)
        for secret in (f.uid, f.email, forg):
            assert secret not in text
        assert set(got["link"]) == {"token", "created_at"}
        other = mine(s, sc.stranger)
        assert (other["link"], other["org"], other["joined"], other["held"]) == (None, None, 0, 0)
        assert mine(s, sc.alice.actor)["held"] >= 1


def test_a_person_settles_at_most_sixty_times_an_hour_and_reads_after_that(conn):
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        for _ in range(60):
            assert ok(call(s, ref, "select public.take_web_rate('referral.claim', 60, 3600)")) is True
        buy(s, forg)
        got = claim(s, ref)
        assert (got["joined"], got["held"]) == (1, 0), "the 61st call this hour reads, it does not settle"


def test_the_numbers_go_through_owner_guard_are_audited_and_range_checked(conn, sc):
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
        audits = s.value("select count(*) from public.app_audit_log where action = 'billing.settings' and target = 'referral programme'")
        events = s.value("select count(*) from public.security_events where kind = 'referral.settings'")
        got = ok(call(s, sc.operator, "select public.set_referral_settings(false, false, 200, 1000, 30, 60, 10, 50)"))
        assert "error" not in got, got
        as_owner(s)
        assert s.value("select referral_updated_at from public.friend_invite_settings") == stamp, \
            "saving the same numbers does not re-date the public terms"
        got = ok(call(s, sc.operator, "select public.set_referral_settings(true, false, 250, 1000, 30, 60, 10, 50)"))
        assert (got["credits"], got["enabled"], got["links_open"]) == (250, True, True), "turning the reward on opens links"
        as_owner(s)
        assert s.value("select referral_updated_at from public.friend_invite_settings") > stamp
        assert s.value("select count(*) from public.app_audit_log where action = 'billing.settings' and target = 'referral programme'") == audits + 2
        detail = s.value("select detail from public.security_events where kind = 'referral.settings' order by id desc limit 1")
        assert s.value("select count(*) from public.security_events where kind = 'referral.settings'") == events + 2
        assert (detail["old"]["credits"], detail["new"]["credits"], detail["new"]["referral_enabled"]) == (200, 250, True)


def test_the_numbers_are_rate_limited_by_owner_guard(conn, sc):
    with world(conn) as s:
        answers = [ok(call(s, sc.operator, "select public.set_referral_settings(false, false, 200, 1000, 30, 60, 10, 50)"))
                   for _ in range(11)]
        assert all("error" not in a for a in answers[:10]), answers[:10]
        assert answers[10].get("error") == "rate_limited", answers[10]


# ── the settle job ──────────────────────────────────────────────────────────

def test_the_settle_job_takes_a_batch_records_each_run_and_the_operator_sees_it(conn, sc):
    with world(conn) as s:
        settings(s)
        for _ in range(3):
            ref, org, token = referrer(s)
            friend(s, token)
        as_owner(s)
        runs = s.value("select count(*) from public.referral_settle_runs")
        got = ok(call(s, SERVICE, "select public.referral_settle_all(2)"))
        assert got["links"] == 2 and got["failed"] == 0, got
        assert s.value("select count(*) from public.referral_settle_runs") == runs + 1
        admin = ok(call(s, sc.operator, "select public.referral_admin()"))
        assert admin["schedule"] is False, "no pg_cron in the lab: the panel must say there is no schedule"
        assert admin["last_run"]["links"] == 2 and admin["last_run"]["failed"] == 0
        assert {"runs_failed_24h", "claw_owed", "void_member", "reversed_by_event", "open_since", "orphaned"} <= set(admin)
        # The links settled longest ago come first: the next batch moves on.
        as_owner(s)
        before = s.value("select count(*) from public.friend_invite_links where referral_settled_at is null")
        ok(call(s, SERVICE, "select public.referral_settle_all(2)"))
        as_owner(s)
        assert s.value("select count(*) from public.friend_invite_links where referral_settled_at is null") < before


def test_a_referral_whose_link_is_gone_is_counted_for_the_operator_and_not_paid(conn, sc):
    """B3: the link goes only with the referrer's account (an operator step); its referrals are not settled by a job."""
    with world(conn) as s:
        settings(s)
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg)
        claim(s, ref)
        due(s, f)
        as_owner(s)
        before = ok(call(s, sc.operator, "select public.referral_admin()"))["orphaned"]
        s.rows("delete from public.friend_invite_links where token = %s returning 1", [token])
        ok(call(s, SERVICE, "select public.referral_settle_all(500)"))
        assert ok(call(s, sc.operator, "select public.referral_admin()"))["orphaned"] == before + 1
        assert rows(s, ref) == [("held", None, CREDITS, 0, 0)]
        assert ledger(s, org, "referral-reward:") == 0


def _dsn(conn) -> str:
    return psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)


def test_a_join_waits_at_most_two_seconds_behind_a_settle_that_holds_its_link(conn):
    """M3, B2: a join no longer queues without bound behind a link lock; it fails within 2 s (55P03) and the app retries it,
    so the auth callback stays bounded."""
    with as_superuser(conn, commit=True) as s:
        s.rows("update public.friend_invite_settings set enabled = true where id returning 1")
        ref, org, token = referrer(s)
        f = new_user(s, "late")
    with psycopg.connect(_dsn(conn)) as holder:
        holder.execute("select 1 from public.friend_invite_links where token = %s for update", [token])
        t0 = time.monotonic()
        with as_superuser(conn, commit=False) as s:
            out = call(s, f, "select public.join_friend_invite(%s)", [token])
        waited = time.monotonic() - t0
        holder.rollback()
    assert not out.ok and out.sqlstate == "55P03", out
    assert 1.5 <= waited < 8, waited
    with as_superuser(conn, commit=True) as s:
        s.rows("update public.friend_invite_settings set enabled = false where id returning 1")


# ── concurrency (committed, fresh people) ───────────────────────────────────

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


def _direct(conn, **kw):
    """Committed settings, written directly (owner_guard's rate limit is tested on its own; the races must not spend it),
    with an open period as set_referral_settings would write it."""
    with as_superuser(conn, commit=True) as s:
        today = s.value(TODAY_PAID)
        s.rows("update public.friend_invite_settings set enabled = true, referral_enabled = %s, referral_daily_cap = %s "
               "where id returning 1", [kw.get("enabled", True), today + kw.get("room", 1000)])
        s.conn.execute("insert into public.referral_open_periods (opened_at) select now() - interval '1 second' "
                       "where not exists (select 1 from public.referral_open_periods where closed_at is null)")


def _restore_defaults(conn):
    with as_superuser(conn, commit=True) as s:
        s.rows("update public.friend_invite_settings set enabled = false, referral_enabled = false, milestone_enabled = false, "
               "referral_credits = 200, referral_min_credits = 1000, referral_hold_days = 30, referral_qualify_days = 60, "
               "referral_monthly_cap = 10, referral_daily_cap = 50 where id returning 1")
        s.conn.execute("update public.referral_open_periods set closed_at = now() where closed_at is null")


def _committed_due_referral(conn, **kw):
    _direct(conn, **kw)
    with as_superuser(conn, commit=True) as s:
        ref, org, token = referrer(s)
        f, forg = friend(s, token)
        buy(s, forg)
        claim(s, ref)
        due(s, f)
        as_owner(s)
        return ref, org, balance(s, org)


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
                return s.value("select public.referral_settle_all(500)")["failed"]

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
        _direct(conn, room=1)

        def go(who):
            def body(c, barrier):
                barrier.wait()
                with acting(c, who, commit=True) as s:
                    return s.value("select public.claim_referral_rewards()")["paid"]
            return body

        assert sorted(_race(conn, [go(a[0]), go(b[0])])) == [0, 1]
        _direct(conn, room=1)
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


def test_applying_the_migration_again_keeps_the_switches_numbers_and_referrals(conn):
    try:
        _committed_due_referral(conn)
        with as_superuser(conn, commit=True) as s:
            s.rows("update public.friend_invite_settings set referral_credits = 150, milestone_enabled = true where id returning 1")
        snap = ("select (select count(*) from public.referral_rewards), "
                "(select row(referral_credits, referral_enabled, milestone_enabled, enabled, "
                "(select count(*) from public.referral_open_periods))::text "
                "from public.friend_invite_settings)")
        with as_superuser(conn, commit=False) as s:
            before = s.rows(snap)[0]
        # 0167 rebuilt the lot trigger on 0165's body, and 0165's guard accepts only 0034's or its own: off first, back on after.
        sec_db.take_off_0167(conn)
        for _ in range(2):
            sec_db.apply_files(_dsn(conn), [sec_db.MIGRATION_0165])
        sec_db.put_back_0167(conn)
        with as_superuser(conn, commit=False) as s:
            assert s.rows(snap)[0] == before
    finally:
        sec_db.put_back_0167(conn)
        _restore_defaults(conn)


def test_the_drift_guard_refuses_a_body_edited_by_hand(conn):
    with world(conn) as s:
        text = s.value("select pg_get_functiondef('public.referral_settle_locked(public.friend_invite_links)'::regprocedure)")
        s.rows(re.sub(r"return changed;", "return changed + 0;", text, count=1) + "; select 1")
        sec_db.take_off_0167(s)  # so the only body 0165's guard can object to is the one edited here
        out = s.run(sec_db.MIGRATION_0165.read_text(encoding="utf-8"))
        assert not out.ok and "0165 found public.referral_settle_locked" in out.error, out


def test_the_rollback_refuses_while_a_referral_exists_then_puts_the_earlier_bodies_back_exactly(conn):
    with world(conn) as s:
        sec_db.take_off_0167(s)  # 0165's rollback puts 0034's lot trigger back; 0167's body sits on 0165's
        out = s.run(_body(sec_db.ROLLBACK_0165))
        assert not out.ok and "referral rows exist" in out.error, out
        s.rows("delete from public.referral_rewards returning 1")
        assert s.run(_body(sec_db.ROLLBACK_0165)).ok
        for sig, h in BEFORE.items():
            assert md5_of(s, sig) == h, sig
        assert s.value("select to_regclass('public.referral_rewards') is null and to_regclass('public.referral_settle_runs') is null "
                       "and to_regclass('public.referral_open_periods') is null "
                       "and to_regprocedure('public.my_referrals()') is null")
        assert s.value("select count(*) from information_schema.columns where table_schema = 'public' "
                       "and table_name = 'friend_invite_settings' and (column_name like 'referral_%%' or column_name = 'milestone_enabled')") == 0
        # …and 0165 goes on again on top of it, and 0167 on top of that.
        assert s.run(sec_db.MIGRATION_0165.read_text(encoding="utf-8")).ok
        assert s.run(sec_db.MIGRATION_0167.read_text(encoding="utf-8")).ok


def test_the_mailbox_key_of_the_seeded_friend_is_the_joins_own(conn, sc):
    """The seed row is shaped like a real one (positive control for test_sec_isolation.py)."""
    with world(conn) as s:
        key = hashlib.sha256(sc.dana.email.encode()).hexdigest()
        assert s.value("select count(*) from public.referral_rewards where invitee_email_key = %s", [key]) == 1
