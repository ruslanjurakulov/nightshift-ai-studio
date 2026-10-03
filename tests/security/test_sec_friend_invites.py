"""Migration 0092: one invite link per person, a reward to its owner when five
new, e-mail-confirmed people have joined through it.

This creates credits, so every test is an attack on the money or on whose link
and progress a person can see. What would break without each:

* the switch defaulting ON (a free-credit loop running before the owner looked);
* the 5th join paying twice (two people completing it together, or one callback
  delivered twice), or a 6th person earning the owner more;
* a join counting before the new account's e-mail is confirmed, an existing
  account counting, the owner (or their other mailbox) counting, one mailbox
  or one account counting twice;
* the platform-wide daily cap being overshot by two rewards racing, or a reward
  that hit the cap being lost instead of waiting;
* a person reading another's link, the joins, the rewards or the settings, or
  writing any of them, through the API;
* the owner learning who joined (an id, an e-mail) from their own progress;
* the invitee's id stamped on the owner's ledger row;
* invite credits not being an ordinary grant lot.

Isolation of the four tables (read / write, row by row) is covered by
test_sec_isolation.py through sec_expectations.TABLES; the function grants by
test_sec_catalog.py.
"""

from __future__ import annotations

import json
import threading
import uuid
from contextlib import contextmanager

import psycopg
import pytest

import sec_db
from sec_db import ANON, acting, as_superuser, user
from sec_scenario import DEFAULT_ORG

REQUIRED = 5
REWARD = 100
TODAY = ("select count(*) from public.friend_invite_rewards "
         "where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'")


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
    """One statement as `actor` (the browser's own path), then back to the owner."""
    as_user(s, actor)
    out = s.run(query, params)
    as_owner(s)
    return out


def ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


def mailbox(tag):
    return f"{tag}-{uuid.uuid4().hex[:8]}@lab.test"


def new_user(s, tag="u", *, confirmed=True, age_days=0, email=None):
    who = user(tag, email or mailbox(tag))
    as_owner(s)
    s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values "
           "(%s, %s, case when %s then now() else null end, now() - make_interval(days => %s)) returning 1",
           [who.uid, who.email, confirmed, age_days])
    return who


def settings(s, *, enabled=True, required=REQUIRED, reward=REWARD, room=1000, hourly=None):
    """The operator sets the programme. `room` = how many more rewards may be
    paid today, on top of whatever earlier tests committed."""
    as_owner(s)
    today = s.value("select count(*) from public.friend_invite_rewards "
                    "where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'")
    return call(s, SC.operator, "select public.set_friend_invite_settings(%s, %s, %s, %s, %s)",
                [enabled, required, reward, today + room, hourly])


def new_owner(s, *, link=True):
    """A confirmed account with a workspace of its own (and its 100 welcome
    credits) and, when asked, its invite link."""
    who = new_user(s, "owner")
    org = ok(call(s, who, "select public.create_organization(%s)", [f"Owner {uuid.uuid4().hex[:6]}"]))
    token = None
    if link:
        res = ok(call(s, who, "select public.create_friend_invite(%s)", [org]))
        token = res["link"]["token"]
    return who, str(org), token


def join(s, who, token):
    out = call(s, who, "select public.join_friend_invite(%s)", [token])
    return ok(out)["status"]


def join_new(s, token, tag="friend", **kw):
    who = new_user(s, tag, **kw)
    return who, join(s, who, token)


def progress(s, who):
    return ok(call(s, who, "select public.my_friend_invite()"))


def balance(s, org):
    as_owner(s)
    return s.value("select balance from public.credit_accounts where org_id = %s", [org])


def reward_rows(s, owner):
    as_owner(s)
    return s.value("select count(*) from public.friend_invite_rewards where user_id = %s", [owner.uid])


def ledger_rows(s, owner):
    as_owner(s)
    return s.value("select count(*) from public.credit_transactions where external_id = %s",
                   [f"invite-reward:{owner.uid}"])


SC = None


@pytest.fixture(autouse=True)
def _scenario(sc):
    global SC
    SC = sc


@contextmanager
def world(conn):
    with as_superuser(conn, commit=False) as s:
        yield s


# ── the switch ──────────────────────────────────────────────────────────────

def test_the_switch_is_off_by_default_and_nothing_is_paid_or_joined_while_off(conn):
    with world(conn) as s:
        row = s.rows("select enabled, required_joins, reward_credits, daily_reward_cap, link_hourly_cap "
                     "from public.friend_invite_settings")
        assert row == [(False, 5, 100, 20, 10)], row
        owner = new_user(s, "owner")
        org = ok(call(s, owner, "select public.create_organization('Off Studio')"))
        out = call(s, owner, "select public.create_friend_invite(%s)", [org])
        assert not out.ok and out.sqlstate == "NS403", out


def test_while_off_a_join_is_not_recorded_and_the_peek_says_no(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        assert ok(call(s, ANON, "select public.friend_invite_peek(%s)", [token])) is True
        settings(s, enabled=False)
        assert ok(call(s, ANON, "select public.friend_invite_peek(%s)", [token])) is False
        friend, status = join_new(s, token)
        assert status == "off"
        as_owner(s)
        assert s.value("select count(*) from public.friend_invite_joins where invitee_id = %s", [friend.uid]) == 0


def test_the_switch_and_numbers_are_the_platform_operators_alone(conn, sc):
    with world(conn) as s:
        out = call(s, sc.alice.actor, "select public.set_friend_invite_settings(true, 5, 100, 20, null)")
        assert not out.ok and out.sqlstate == "42501", out
        out = call(s, sc.alice.actor, "select public.friend_invite_admin()")
        assert not out.ok and out.sqlstate == "42501", out
        out = call(s, ANON, "select public.set_friend_invite_settings(true, 5, 100, 20, null)")
        assert not out.ok, out
        for bad in ("(true, 0, 100, 20, null)", "(true, 5, 0, 20, null)", "(true, 5, 100, -1, null)",
                    "(true, 5, 100000000, 20, null)", "(null, 5, 100, 20, null)", "(true, 5, 100, 20, 0)"):
            out = call(s, sc.operator, f"select public.set_friend_invite_settings{bad}")
            assert not out.ok and out.sqlstate == "22023", (bad, out)
        got = ok(settings(s, required=3, reward=40, room=7, hourly=4))
        assert (got["enabled"], got["required_joins"], got["reward_credits"], got["link_hourly_cap"]) == (True, 3, 40, 4)


# ── the link: made once, readable by its owner alone ────────────────────────

def test_one_link_per_person_the_same_token_every_time_and_128_bits_of_hex(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        assert len(token) == 32 and set(token) <= set("0123456789abcdef")
        again = ok(call(s, owner, "select public.create_friend_invite(%s)", [org]))
        assert again["link"]["token"] == token
        as_owner(s)
        assert s.value("select count(*) from public.friend_invite_links where user_id = %s", [owner.uid]) == 1
        assert progress(s, owner)["link"]["token"] == token
        other_token = new_owner(s)[2]
        assert other_token != token


def test_nobody_else_reads_a_link_or_the_tables_or_writes_them(conn, sc):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        # Another signed-in person has no link, and sees none of the owner's.
        seen = progress(s, sc.stranger)
        assert seen["link"] is None and token not in json.dumps(seen)
        for table in ("friend_invite_links", "friend_invite_joins", "friend_invite_rewards", "friend_invite_settings"):
            for who in (sc.bob.actor, owner, ANON):
                out = call(s, who, f"select * from public.{table}")
                assert not out.ok and out.sqlstate == "42501", (table, who.name, out)
        for q in ("insert into public.friend_invite_links (user_id, org_id, token) values (gen_random_uuid(), %s, %s)",
                  "update public.friend_invite_links set org_id = %s where token <> %s",
                  "delete from public.friend_invite_links where token <> %s",
                  "insert into public.friend_invite_rewards (user_id, org_id, credits, joins) values (gen_random_uuid(), %s, 100, 5)",
                  "insert into public.friend_invite_joins (link_id, invitee_id, email_key, counted) "
                  "values (1, gen_random_uuid(), repeat('a', 64), true)",
                  "update public.friend_invite_settings set enabled = true"):
            params = [sc.bob.org, token][: q.count("%s")]
            out = call(s, sc.bob.actor, q, params)
            assert not out.ok and out.sqlstate == "42501", (q, out)
        # And anon runs none of the owner's or the new account's functions.
        for fn, args in (("my_friend_invite", []), ("create_friend_invite", [org]), ("claim_friend_invite_reward", []),
                         ("join_friend_invite", [token]), ("friend_invite_admin", [])):
            marks = ", ".join(["%s"] * len(args))
            out = call(s, ANON, f"select public.{fn}({marks})", args)
            assert not out.ok and out.sqlstate == "42501", (fn, out)


def test_the_owner_sees_counts_only_never_who_joined(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        friend, status = join_new(s, token)
        assert status == "counted"
        seen = progress(s, owner)
        assert set(seen) == {"enabled", "required", "reward", "link", "joined", "paid", "credits_paid", "pending"}
        assert set(seen["link"]) == {"token", "created_at", "org_id"}
        blob = json.dumps(seen)
        assert friend.uid not in blob and friend.email not in blob
        assert (seen["joined"], seen["paid"], seen["pending"]) == (1, False, False)


def test_a_link_needs_a_confirmed_owner_an_org_they_run_and_one_that_pays(conn, sc):
    with world(conn) as s:
        settings(s)
        unconfirmed = new_user(s, "unc", confirmed=False)
        out = call(s, unconfirmed, "select public.create_friend_invite(%s)", [sc.alice.org])
        assert not out.ok and out.sqlstate == "42501", out
        # Sam cannot point his reward at Alice's workspace, nor at the operator's own.
        out = call(s, sc.stranger, "select public.create_friend_invite(%s)", [sc.alice.org])
        assert not out.ok and out.sqlstate == "42501", out
        out = call(s, sc.operator, "select public.create_friend_invite(%s)", [DEFAULT_ORG])
        assert not out.ok and out.sqlstate == "42501", out
        out = call(s, sc.stranger, "select public.create_friend_invite(null)")
        assert not out.ok and out.sqlstate == "42501", out


# ── who counts ──────────────────────────────────────────────────────────────

def test_no_count_before_the_email_is_confirmed_then_it_counts(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        friend, status = join_new(s, token, confirmed=False)
        assert status == "unconfirmed"
        assert progress(s, owner)["joined"] == 0
        as_owner(s)
        s.rows("update auth.users set email_confirmed_at = now() where id = %s returning 1", [friend.uid])
        assert join(s, friend, token) == "counted"
        assert progress(s, owner)["joined"] == 1


def test_an_existing_account_counts_for_nothing(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        before_link, status = join_new(s, token, "old", age_days=1)
        assert status == "existing"
        # Made after the link, but long ago: not "new" any more.
        as_owner(s)
        s.rows("update public.friend_invite_links set created_at = now() - interval '10 days' where token = %s returning 1",
               [token])
        stale, status = join_new(s, token, "stale", age_days=4)
        assert status == "existing"
        assert progress(s, owner)["joined"] == 0


def test_the_owner_and_the_owners_other_mailbox_do_not_count(conn):
    with world(conn) as s:
        settings(s)
        who = new_user(s, "gm", email=f"jo.hn{uuid.uuid4().hex[:6]}@gmail.com")
        org = ok(call(s, who, "select public.create_organization('Gm Studio')"))
        token = ok(call(s, who, "select public.create_friend_invite(%s)", [org]))["link"]["token"]
        assert join(s, who, token) == "self"
        local = who.email.split("@")[0].replace(".", "")
        alias = new_user(s, "alias", email=f"{local}+promo@googlemail.com")
        assert join(s, alias, token) == "self"
        assert progress(s, who)["joined"] == 0


def test_one_account_counts_once_and_one_mailbox_counts_once(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        friend, status = join_new(s, token)
        assert status == "counted"
        assert join(s, friend, token) == "already"
        base = f"ann{uuid.uuid4().hex[:6]}"
        first, status = join_new(s, token, email=f"{base}@gmail.com")
        assert status == "counted"
        twin, status = join_new(s, token, email=f"{base[:2]}.{base[2:]}+x@googlemail.com")
        assert status == "duplicate"
        assert progress(s, owner)["joined"] == 2


def test_an_unknown_or_malformed_token_is_one_neutral_answer(conn):
    with world(conn) as s:
        settings(s)
        friend = new_user(s)
        for tok in ("0" * 32, "x" * 32, "short", "", "A" * 40):
            assert join(s, friend, tok) == "invalid"
        assert ok(call(s, ANON, "select public.friend_invite_peek(%s)", ["0" * 32])) is False
        assert ok(call(s, ANON, "select public.friend_invite_peek(null)")) is False


def test_a_link_takes_at_most_its_hourly_pace(conn):
    with world(conn) as s:
        settings(s, hourly=3)
        owner, org, token = new_owner(s)
        statuses = [join_new(s, token)[1] for _ in range(5)]
        assert statuses == ["counted", "counted", "counted", "paused", "paused"], statuses
        assert progress(s, owner)["joined"] == 3


# ── the reward ──────────────────────────────────────────────────────────────

def test_four_joins_pay_nothing_and_the_fifth_pays_the_owner_once_through_the_ledger(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        start = balance(s, org)
        for i in range(REQUIRED - 1):
            assert join_new(s, token)[1] == "counted"
            assert (balance(s, org), reward_rows(s, owner), ledger_rows(s, owner)) == (start, 0, 0), i
        last, status = join_new(s, token)
        assert status == "counted"
        assert (balance(s, org), reward_rows(s, owner), ledger_rows(s, owner)) == (start + REWARD, 1, 1)
        got = progress(s, owner)
        assert (got["joined"], got["paid"], got["credits_paid"], got["pending"]) == (REQUIRED, True, REWARD, False)
        # An ordinary typed grant, authored by the OWNER (never the new person).
        as_owner(s)
        kind, amount, note, author, bal = s.rows(
            "select kind, amount, note, created_by::text, balance_after from public.credit_transactions where external_id = %s",
            [f"invite-reward:{owner.uid}"])[0]
        assert (kind, amount, note, author, bal) == ("grant", REWARD, "invite reward", owner.uid, start + REWARD)
        # …and mirrored onto a lot like any other grant, so it expires and is spent the same way.
        lots = s.value("select coalesce(sum(remaining), 0) from public.credit_lots where org_id = %s", [org])
        assert lots == balance(s, org)
        assert s.value("select count(*) from public.credit_lots where org_id = %s and source = 'grant' and amount = %s",
                       [org, REWARD]) >= 1


def test_a_sixth_and_later_person_are_not_counted_and_pay_nothing_more(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        for _ in range(REQUIRED):
            join_new(s, token)
        after = balance(s, org)
        assert [join_new(s, token)[1] for _ in range(3)] == ["not_counted"] * 3
        assert (balance(s, org), reward_rows(s, owner), ledger_rows(s, owner)) == (after, 1, 1)
        assert progress(s, owner)["joined"] == REQUIRED


def test_the_fifth_confirmation_callback_delivered_twice_pays_once(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        for _ in range(REQUIRED - 1):
            join_new(s, token)
        fifth, status = join_new(s, token)
        assert status == "counted"
        assert join(s, fifth, token) == "already"
        assert join(s, fifth, token) == "already"
        assert (reward_rows(s, owner), ledger_rows(s, owner)) == (1, 1)
        got = ok(call(s, owner, "select public.claim_friend_invite_reward()"))
        assert got["paid"] is True and ledger_rows(s, owner) == 1


def test_a_reward_is_for_life_one_per_person_even_with_a_second_workspace(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        for _ in range(REQUIRED):
            join_new(s, token)
        second = ok(call(s, owner, "select public.create_organization('Second')"))
        out = call(s, owner, "select public.create_friend_invite(%s)", [second])
        assert ok(out)["link"]["token"] == token, "there is no second link to earn from"
        as_owner(s)
        out = s.run("insert into public.friend_invite_rewards (user_id, org_id, credits, joins) values (%s, %s, 1, 1)",
                    [owner.uid, org])
        assert not out.ok and out.sqlstate == "23505", "the primary key is the last word"
        out = s.run("insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after, external_id) "
                    "values (%s, 'grant', 1, 1, 0, %s)", [org, f"invite-reward:{owner.uid}"])
        assert not out.ok and out.sqlstate == "23505", "so is the ledger's unique external_id"


def test_an_account_deleted_and_made_again_on_the_same_mailbox_earns_nothing_a_second_time(conn):
    """The reward row outlives the account (user_id has no foreign key, by design)
    and keeps the owner's folded mailbox key, so the operator deleting an account
    (a data request) and the person signing up again cannot reset 'once'."""
    with world(conn) as s:
        settings(s)
        base = uuid.uuid4().hex[:8]
        owner = new_user(s, "owner", email=f"Re.Peat{base}+a@gmail.com")
        org = ok(call(s, owner, "select public.create_organization('Repeat Studio')"))
        token = ok(call(s, owner, "select public.create_friend_invite(%s)", [org]))["link"]["token"]
        for _ in range(REQUIRED):
            join_new(s, token)
        assert (reward_rows(s, owner), ledger_rows(s, owner)) == (1, 1)
        as_owner(s)
        assert s.value("select email_key from public.friend_invite_rewards where user_id = %s", [owner.uid]) is not None
        # The operator deletes the account: its link and joins go with it, the reward row stays.
        s.rows("delete from auth.users where id = %s returning 1", [owner.uid])
        assert s.value("select count(*) from public.friend_invite_rewards where user_id = %s", [owner.uid]) == 1
        # Same mailbox (another spelling of it), new account, new workspace.
        again = new_user(s, "again", email=f"repeat{base}@googlemail.com")
        org2 = ok(call(s, again, "select public.create_organization('Repeat Again')"))
        out = call(s, again, "select public.create_friend_invite(%s)", [org2])
        assert not out.ok and out.sqlstate == "42501", out
        # Defence in depth: even a link that got made some other way pays nothing.
        as_owner(s)
        link = s.value("insert into public.friend_invite_links (user_id, org_id, token) values (%s, %s, %s) returning id",
                       [again.uid, org2, uuid.uuid4().hex])
        tok2 = s.value("select token from public.friend_invite_links where id = %s", [link])
        start = balance(s, org2)
        for _ in range(REQUIRED + 1):
            assert join_new(s, tok2)[1] in ("counted", "not_counted")
        got = progress(s, again)
        assert got["paid"] is False and got["pending"] is False
        got = ok(call(s, again, "select public.claim_friend_invite_reward()"))
        assert got["paid"] is False
        assert (reward_rows(s, again), ledger_rows(s, again), balance(s, org2)) == (0, 0, start)
        # A different mailbox is a different person and still earns normally.
        other, org3, tok3 = new_owner(s)
        for _ in range(REQUIRED):
            join_new(s, tok3)
        assert reward_rows(s, other) == 1


def test_the_switch_off_at_the_fifth_join_leaves_the_reward_waiting_not_lost(conn):
    with world(conn) as s:
        settings(s)
        owner, org, token = new_owner(s)
        for _ in range(REQUIRED - 1):
            join_new(s, token)
        settings(s, enabled=False)
        assert join_new(s, token)[1] == "off"
        assert progress(s, owner)["joined"] == REQUIRED - 1
        settings(s)
        fifth, status = join_new(s, token)
        assert status == "counted" and reward_rows(s, owner) == 1


def test_the_switch_turned_off_after_five_joins_holds_the_payment_until_it_is_on(conn):
    with world(conn) as s:
        settings(s, room=0)  # a full day: the fifth join is earned but cannot be paid
        owner, org, token = new_owner(s)
        for _ in range(REQUIRED):
            join_new(s, token)
        got = progress(s, owner)
        assert (got["joined"], got["paid"], got["pending"]) == (REQUIRED, False, True)
        settings(s, enabled=False, room=5)
        assert ok(call(s, owner, "select public.claim_friend_invite_reward()"))["paid"] is False
        settings(s, room=5)
        got = ok(call(s, owner, "select public.claim_friend_invite_reward()"))
        assert (got["paid"], got["credits_paid"], got["pending"]) == (True, REWARD, False)
        assert (reward_rows(s, owner), ledger_rows(s, owner)) == (1, 1)


def test_the_daily_cap_holds_a_reward_until_there_is_room(conn):
    with world(conn) as s:
        settings(s, room=1)
        first, org1, t1 = new_owner(s)
        second, org2, t2 = new_owner(s)
        for _ in range(REQUIRED):
            join_new(s, t1)
        start = balance(s, org2)
        for _ in range(REQUIRED):
            join_new(s, t2)
        assert progress(s, first)["paid"] is True
        got = progress(s, second)
        assert (got["paid"], got["pending"], got["joined"]) == (False, True, REQUIRED)
        assert balance(s, org2) == start
        # Claiming into a full day pays nothing; raising the cap lets it through, once.
        assert ok(call(s, second, "select public.claim_friend_invite_reward()"))["paid"] is False
        settings(s, room=2)
        assert ok(call(s, second, "select public.claim_friend_invite_reward()"))["paid"] is True
        assert ok(call(s, second, "select public.claim_friend_invite_reward()"))["paid"] is True
        assert (balance(s, org2), ledger_rows(s, second)) == (start + REWARD, 1)
        admin = ok(call(s, SC.operator, "select public.friend_invite_admin()"))
        assert admin["rewards_today"] >= 2 and admin["credits_today"] >= 2 * REWARD


def test_a_lowered_target_is_paid_on_the_owners_next_visit(conn):
    with world(conn) as s:
        settings(s, required=5)
        owner, org, token = new_owner(s)
        for _ in range(3):
            join_new(s, token)
        settings(s, required=3)
        got = ok(call(s, owner, "select public.claim_friend_invite_reward()"))
        assert (got["paid"], got["credits_paid"]) == (True, REWARD)


def test_the_operator_sees_counts_that_match_the_ledger(conn):
    with world(conn) as s:
        settings(s)
        before = ok(call(s, SC.operator, "select public.friend_invite_admin()"))
        owner, org, token = new_owner(s)
        for _ in range(REQUIRED + 1):
            join_new(s, token)
        after = ok(call(s, SC.operator, "select public.friend_invite_admin()"))
        assert after["links"] == before["links"] + 1
        assert after["joins"] == before["joins"] + REQUIRED
        assert after["joins_uncounted"] == before["joins_uncounted"] + 1
        assert after["rewards"] == before["rewards"] + 1
        assert after["credits_total"] == before["credits_total"] + REWARD
        assert after["credits_today"] == before["credits_today"] + REWARD
        assert not any(k in after for k in ("emails", "tokens", "users"))


# ── concurrency (real, committed, separate connections) ─────────────────────

def _dsn(conn) -> str:
    return psycopg.conninfo.make_conninfo(sec_db.admin_dsn(), dbname=conn.info.dbname)


def _race(conn, n, body):
    barrier = threading.Barrier(n)
    results = [None] * n

    def worker(i):
        with psycopg.connect(_dsn(conn), autocommit=True) as c:
            try:
                results[i] = body(c, barrier, i)
            except Exception as e:  # noqa: BLE001 — a refusal is a result here
                results[i] = e

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    return results


def _committed_user(conn, tag, *, org=False):
    who = user(tag, mailbox(tag))
    with as_superuser(conn) as s:
        s.rows("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now()) returning 1",
               [who.uid, who.email])
    if not org:
        return who
    with acting(conn, who, commit=True) as s:
        return who, str(s.value("select public.create_organization(%s)", [f"Race {uuid.uuid4().hex[:6]}"]))


def _committed_settings(conn, **kw):
    with as_superuser(conn, commit=False) as s:
        today = s.value(TODAY)
    with acting(conn, SC.operator, commit=True) as s:
        s.value("select public.set_friend_invite_settings(%s, %s, %s, %s, %s)",
                [kw.get("enabled", True), REQUIRED, REWARD, today + kw.get("room", 1000), kw.get("hourly", 1000)])


def _committed_owner_with_four(conn):
    owner, org = _committed_user(conn, "racer", org=True)
    with acting(conn, owner, commit=True) as s:
        token = s.value("select public.create_friend_invite(%s)", [org])["link"]["token"]
    for _ in range(REQUIRED - 1):
        friend = _committed_user(conn, "four")
        with acting(conn, friend, commit=True) as s:
            assert s.value("select public.join_friend_invite(%s)", [token])["status"] == "counted"
    return owner, org, token


def _restore_defaults(conn):
    with acting(conn, SC.operator, commit=True) as s:
        s.value("select public.set_friend_invite_settings(false, 5, 100, 20, 10)")


def test_three_people_completing_the_fifth_join_together_pay_exactly_once(conn):
    try:
        _committed_settings(conn)
        owner, org, token = _committed_owner_with_four(conn)
        friends = [_committed_user(conn, "rival") for _ in range(3)]
        with as_superuser(conn, commit=False) as s:
            start = balance(s, org)

        def go(c, barrier, i):
            barrier.wait()
            with acting(c, friends[i], commit=True) as s:
                return s.value("select public.join_friend_invite(%s)", [token])["status"]

        results = _race(conn, 3, go)
        assert sorted(results) == ["counted", "not_counted", "not_counted"], results
        with as_superuser(conn, commit=False) as s:
            assert s.value("select count(*) from public.friend_invite_joins j join public.friend_invite_links l "
                           "on l.id = j.link_id where l.user_id = %s and j.counted", [owner.uid]) == REQUIRED
            assert (reward_rows(s, owner), ledger_rows(s, owner), balance(s, org)) == (1, 1, start + REWARD)
    finally:
        _restore_defaults(conn)


def test_two_rewards_racing_for_the_last_place_today_pay_one_and_keep_the_other_waiting(conn):
    try:
        _committed_settings(conn)
        a = _committed_owner_with_four(conn)
        b = _committed_owner_with_four(conn)
        fa, fb = _committed_user(conn, "fifth"), _committed_user(conn, "fifth")
        _committed_settings(conn, room=1)
        with as_superuser(conn, commit=False) as s:
            today_before = s.value(TODAY)

        def go(c, barrier, i):
            who, token = ((fa, a[2]), (fb, b[2]))[i]
            barrier.wait()
            with acting(c, who, commit=True) as s:
                return s.value("select public.join_friend_invite(%s)", [token])["status"]

        assert _race(conn, 2, go) == ["counted", "counted"]
        with as_superuser(conn, commit=False) as s:
            paid = [reward_rows(s, a[0]), reward_rows(s, b[0])]
            assert sorted(paid) == [0, 1], paid
            assert s.value(TODAY) - today_before == 1
        loser = a if paid[0] == 0 else b
        _committed_settings(conn, room=1)
        with acting(conn, loser[0], commit=True) as s:
            got = s.value("select public.claim_friend_invite_reward()")
        assert got["paid"] is True and got["pending"] is False
        with as_superuser(conn, commit=False) as s:
            assert (reward_rows(s, a[0]), reward_rows(s, b[0]), ledger_rows(s, a[0]), ledger_rows(s, b[0])) == (1, 1, 1, 1)
    finally:
        _restore_defaults(conn)


def test_the_same_person_joining_from_two_tabs_counts_once(conn):
    try:
        _committed_settings(conn)
        owner, org = _committed_user(conn, "tabs", org=True)
        with acting(conn, owner, commit=True) as s:
            token = s.value("select public.create_friend_invite(%s)", [org])["link"]["token"]
        friend = _committed_user(conn, "double")

        def go(c, barrier, i):
            barrier.wait()
            with acting(c, friend, commit=True) as s:
                return s.value("select public.join_friend_invite(%s)", [token])["status"]

        assert sorted(_race(conn, 4, go)) == ["already", "already", "already", "counted"]
    finally:
        _restore_defaults(conn)


# ── replay ──────────────────────────────────────────────────────────────────

def test_applying_the_migration_twice_keeps_links_settings_and_rewards(conn):
    try:
        _committed_settings(conn, room=7)
        owner, org = _committed_user(conn, "replay", org=True)
        with acting(conn, owner, commit=True) as s:
            token = s.value("select public.create_friend_invite(%s)", [org])["link"]["token"]
        with as_superuser(conn, commit=False) as s:
            before = s.rows("select (select count(*) from public.friend_invite_links), "
                            "(select count(*) from public.friend_invite_joins), "
                            "(select count(*) from public.friend_invite_rewards), "
                            "(select daily_reward_cap from public.friend_invite_settings), "
                            "(select enabled from public.friend_invite_settings)")[0]
        for _ in range(2):
            sec_db.apply_files(_dsn(conn), [sec_db.MIGRATIONS / "0092_friend_invites.sql"])
        with as_superuser(conn, commit=False) as s:
            after = s.rows("select (select count(*) from public.friend_invite_links), "
                           "(select count(*) from public.friend_invite_joins), "
                           "(select count(*) from public.friend_invite_rewards), "
                           "(select daily_reward_cap from public.friend_invite_settings), "
                           "(select enabled from public.friend_invite_settings)")[0]
        assert after == before, "re-running the migration must not reset the operator's numbers or the switch"
        with acting(conn, owner) as s:
            assert s.value("select public.my_friend_invite()")["link"]["token"] == token
        with acting(conn, ANON) as s:
            out = s.run("select * from public.friend_invite_links")
            assert not out.ok and out.sqlstate == "42501"
    finally:
        _restore_defaults(conn)
