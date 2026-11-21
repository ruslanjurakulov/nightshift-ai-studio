"""Migration 0042 under attack: welcome-credit aliases (P5), API requests
whose failure used to erase their own rate count (P6), client-chosen API key
hashes (P7) and the web routes' per-user rate limit (C8).

Each test drives the real functions as the API role a browser or an API
client would have, inside one transaction that is rolled back.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from contextlib import contextmanager

import psycopg
import pytest

from sec_db import ANON, Actor, acting, as_superuser, user


@contextmanager
def _rolled_back(conn):
    """One transaction for a whole scenario (users signed up, orgs created,
    functions swapped), undone at the end."""
    with conn.transaction(force_rollback=True):
        yield conn


def _as(conn, who: Actor) -> None:
    """Become `who` for the statements that follow, as PostgREST would."""
    conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(who.claims())])
    conn.execute("select set_config('request.jwt.claim.role', %s, true)", [who.role])
    conn.execute(f"set local role {who.role}")


def _owner(conn) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('request.jwt.claims', '', true)")


def _try(conn, query, params=None):
    """(value, None) or (None, sqlstate) — a refused call rolls back only itself."""
    try:
        with conn.transaction():
            return conn.execute(query, params).fetchone()[0], None
    except psycopg.Error as e:
        return None, e.sqlstate


# ── P5: welcome credits once per mailbox ─────────────────────────────────────

def _signup_and_create_org(conn, email: str) -> float:
    who = user(email.split("@")[0], email)
    _owner(conn)
    conn.execute("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [who.uid, email])
    _as(conn, who)
    org = conn.execute("select public.create_organization(%s)", [f"Org of {email}"]).fetchone()[0]
    _owner(conn)
    bal = conn.execute("select balance from public.credit_accounts where org_id = %s", [org]).fetchone()
    return float(bal[0]) if bal and bal[0] is not None else 0.0


def test_gmail_aliases_share_one_welcome_grant(conn):
    tag = uuid.uuid4().hex[:8]
    with _rolled_back(conn):
        first = _signup_and_create_org(conn, f"jo.doe{tag}@gmail.com")
        aliases = [
            _signup_and_create_org(conn, f"JoDoe{tag}+promo@gmail.com"),
            _signup_and_create_org(conn, f"j.o.d.o.e{tag}@googlemail.com"),
            _signup_and_create_org(conn, f"jodoe{tag}+x.y@GMAIL.COM"),
        ]
    assert first == 100
    assert aliases == [0, 0, 0], "an alias of an address that already got welcome credits got them again"


def test_plus_tags_share_one_grant_on_any_domain_but_dots_do_not(conn):
    tag = uuid.uuid4().hex[:8]
    with _rolled_back(conn):
        first = _signup_and_create_org(conn, f"sam{tag}@example.test")
        tagged = _signup_and_create_org(conn, f"Sam{tag}+2@Example.test")
        # Outside Gmail a dot is part of the mailbox name: a different person.
        dotted = _signup_and_create_org(conn, f"s.am{tag}@example.test")
    assert (first, tagged, dotted) == (100, 0, 100)


def test_welcome_claims_are_not_readable_or_writable_by_users(conn, sc):
    for who in (sc.bob.actor, sc.stranger, ANON):
        with acting(conn, who) as s:
            read = s.run("select * from public.welcome_credit_claims")
            write = s.run("insert into public.welcome_credit_claims (email_key, user_id, org_id) values (%s, %s, %s)",
                          [hashlib.sha256(b"x").hexdigest(), sc.bob.actor.uid, sc.bob.org])
        assert (not read.ok) or read.rows == [], (who.name, read)
        assert not write.ok, (who.name, write)


def test_welcome_email_key_is_not_callable_from_the_api(conn, sc):
    for who in (sc.bob.actor, ANON):
        with acting(conn, who) as s:
            out = s.run("select public.welcome_email_key('a@b.test')")
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


# ── P6: a request that fails inside the database still counts ────────────────

def _usage(conn, key_id):
    _owner(conn)
    # The scenario's counter was written in an earlier transaction, possibly in
    # an earlier minute; api_begin deletes a key's older-minute counters when a
    # new minute starts, which would make the count read 1 instead of 2 when
    # the clock rolls over mid-suite. now() is fixed inside this transaction
    # and api_begin uses the same now(), so pinning the counter to this minute
    # makes the comparison deterministic.
    conn.execute("update public.api_rate_counters set minute = date_trunc('minute', now()) where key_id = %s",
                 [key_id])
    count = conn.execute("select coalesce(sum(count), 0) from public.api_rate_counters where key_id = %s",
                         [key_id]).fetchone()[0]
    logged = conn.execute("select count(*) from public.api_requests where key_id = %s and status = 500",
                          [key_id]).fetchone()[0]
    return int(count), int(logged)


def test_a_failing_api_call_keeps_its_rate_count_and_log_row(conn, sc):
    b = sc.bob
    with _rolled_back(conn):
        # Fault injection: the helper api_get_video uses now raises, as any
        # unexpected error inside an entry point would.
        conn.execute("""
            create or replace function public.api_video_json(v public.videos) returns jsonb
              language plpgsql stable set search_path = public, pg_temp as $$
            begin
              raise exception 'injected fault';
            end $$""")
        before = _usage(conn, b.api_key_id)
        _as(conn, ANON)
        res, err = _try(conn, "select public.api_get_video(%s, %s, null)", [b.api_key_hash, b.video])
        after = _usage(conn, b.api_key_id)
    assert err is None, f"the entry point raised ({err}): the request's count and log row went with it"
    assert res["ok"] is False and res["status"] == 500 and res["error"]["code"] == "internal_error", res
    assert "injected" not in json.dumps(res), "the database error text reached the API client"
    assert after == (before[0] + 1, before[1] + 1), (before, after)


def test_a_failing_create_leaves_no_job_and_no_hold(conn, sc):
    b = sc.bob
    with _rolled_back(conn):
        conn.execute("update public.channels set status = 'ACTIVE', credential_ref = '{\"verified_at\": \"2026-09-01\"}' "
                     "where channel_id = %s", [b.channel])
        conn.execute("""
            create or replace function public.api_audit(p_ctx jsonb, p_action text, p_target text, p_channel text, p_detail jsonb)
              returns void language plpgsql security definer set search_path = public, pg_temp as $$
            begin
              raise exception 'injected fault';
            end $$""")
        jobs = conn.execute("select count(*) from public.render_jobs where channel_id = %s", [b.channel]).fetchone()[0]
        holds = conn.execute("select count(*) from public.api_holds where org_id = %s", [b.org]).fetchone()[0]
        before = _usage(conn, b.api_key_id)
        _as(conn, ANON)
        res, err = _try(conn, "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                        [b.api_key_hash, b.channel, json.dumps({"topic": "x", "duration": 60})])
        after = _usage(conn, b.api_key_id)
        jobs_after = conn.execute("select count(*) from public.render_jobs where channel_id = %s", [b.channel]).fetchone()[0]
        holds_after = conn.execute("select count(*) from public.api_holds where org_id = %s", [b.org]).fetchone()[0]
    assert err is None and res["status"] == 500, (err, res)
    assert (jobs_after, holds_after) == (jobs, holds), "a failed create left a job or a hold behind"
    assert after == (before[0] + 1, before[1] + 1)


def test_a_short_channel_target_is_priced_at_the_length_that_runs(conn, sc):
    """0041 freezes a paid run's length to whole seconds 30..3600; the API hold
    must be priced for that frozen length, not for the raw channel target."""
    b = sc.bob
    with _rolled_back(conn):
        conn.execute("update public.channels set status = 'ACTIVE', credential_ref = '{\"verified_at\": \"2026-09-01\"}', "
                     "agent_config = agent_config || '{\"target_duration_seconds\": 10}' where channel_id = %s", [b.channel])
        conn.execute("insert into public.api_prices (unit, cents) values ('video_minute', 600), ('job_minimum', 0) "
                     "on conflict (unit) do update set cents = excluded.cents")
        price_10 = conn.execute("select public.api_video_price(10)").fetchone()[0]
        price_30 = conn.execute("select public.api_video_price(30)").fetchone()[0]
        assert price_10 < price_30, (price_10, price_30)
        _as(conn, ANON)
        res, err = _try(conn, "select public.api_create_video(%s, %s, '{}'::jsonb, null, null, null)",
                        [b.api_key_hash, b.channel])
        _owner(conn)
        assert err is None and res["ok"] is True and res["status"] == 201, (err, res)
        params, hold = conn.execute(
            "select j.params, h.amount_cents from public.render_jobs j join public.api_holds h on h.ref = j.api_hold_ref "
            "where j.id = %s", [res["data"]["job_id"]]).fetchone()
    assert params == {"duration": 30}, params
    assert res["data"]["price_cents"] == price_30 and hold == price_30, (res, hold, price_30)


# ── P7: the database mints API keys ──────────────────────────────────────────

KEY_RE = re.compile(r"^nsk_live_[0-9A-Za-z]{43}$")


def test_create_api_key_mints_the_key_and_stores_only_its_hash(conn, sc):
    b = sc.bob
    with _rolled_back(conn):
        _as(conn, b.actor)
        made = conn.execute("select public.create_api_key(%s, 'ci', null)", [b.org]).fetchone()[0]
        again = conn.execute("select public.create_api_key(%s, 'ci 2', null)", [b.org]).fetchone()[0]
        _owner(conn)
        row = conn.execute("select to_jsonb(k) from public.api_keys k where id = %s", [made["id"]]).fetchone()[0]
        audit = conn.execute("select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.app_audit_log a "
                             "where target in (%s, %s)", [made["id"], again["id"]]).fetchone()[0]
        # The key authenticates like any other key.
        _as(conn, ANON)
        me = conn.execute("select public.api_auth(%s, null)",
                          [hashlib.sha256(made["key"].encode()).hexdigest()]).fetchone()[0]
    key = made["key"]
    assert KEY_RE.match(key) and KEY_RE.match(again["key"]) and key != again["key"]
    assert row["key_hash"] == hashlib.sha256(key.encode()).hexdigest()
    secret = key[len("nsk_live_"):]
    assert secret not in json.dumps(row) and secret[:8] not in json.dumps(row)
    assert secret not in json.dumps(audit) and secret[:8] not in json.dumps(audit)
    assert me["status"] == 200 and me["data"]["key"]["id"] == made["id"], me


def test_a_client_chosen_key_hash_cannot_be_registered(conn, sc):
    weak = hashlib.sha256(b"nsk_live_" + b"0" * 43).hexdigest()
    with acting(conn, sc.bob.actor) as s:
        old40 = s.run("select public.create_api_key(%s, 'weak', %s, null)", [sc.bob.org, weak])
        old31 = s.run("select public.create_api_key(%s, 'weak', %s, 'Pref0000', null)", [sc.bob.org, weak])
        named = s.run("select public.create_api_key(p_org => %s, p_name => 'weak', p_key_hash => %s)", [sc.bob.org, weak])
    for out in (old40, old31, named):
        assert not out.ok and out.sqlstate == "42883", out


def test_anon_and_strangers_cannot_mint_keys(conn, sc):
    for who in (ANON, sc.stranger):
        with acting(conn, who) as s:
            out = s.run("select public.create_api_key(%s, 'evil', null)", [sc.bob.org])
        assert not out.ok and out.sqlstate == "42501", (who.name, out)


# ── C8: the web routes' per-user rate limit ─────────────────────────────────

def test_take_web_rate_counts_per_user_and_refuses_past_the_limit(conn, sc):
    with _rolled_back(conn):
        _as(conn, sc.bob.actor)
        bob = [conn.execute("select public.take_web_rate('voice.preview', 2, 3600)").fetchone()[0] for _ in range(3)]
        _as(conn, sc.alice.actor)
        alice = conn.execute("select public.take_web_rate('voice.preview', 2, 3600)").fetchone()[0]
    assert bob == [True, True, False]
    assert alice is True, "one user's spent allowance limited another user"


def test_take_web_rate_refuses_anon_and_bad_arguments(conn, sc):
    with acting(conn, ANON) as s:
        anon = s.run("select public.take_web_rate('voice.preview', 2, 3600)")
    assert not anon.ok and anon.sqlstate == "42501", anon
    with acting(conn, sc.bob.actor) as s:
        for args in (("Bad Bucket", 1, 60), ("ok", 0, 60), ("ok", 1, 0), ("ok", 1001, 60)):
            out = s.run("select public.take_web_rate(%s, %s, %s)", list(args))
            assert not out.ok and out.sqlstate == "22023", (args, out)


def test_rate_counters_are_closed_to_users(conn, sc):
    for who in (sc.bob.actor, ANON):
        with acting(conn, who) as s:
            read = s.run("select * from public.web_rate_counters")
            reset = s.run("delete from public.web_rate_counters")
        assert (not read.ok) or read.rows == [], (who.name, read)
        assert (not reset.ok) or reset.rowcount == 0, (who.name, reset)


@pytest.mark.parametrize("fn", ["api_auth", "api_get_video", "api_create_video", "api_request_download"])
def test_entry_points_still_refuse_unknown_keys_first(conn, sc, fn):
    args = {
        "api_auth": ("select public.api_auth(%s, null)", []),
        "api_get_video": ("select public.api_get_video(%s, 'vid-a', null)", []),
        "api_create_video": ("select public.api_create_video(%s, 'chan-a', '{}'::jsonb, null, null, null)", []),
        "api_request_download": ("select public.api_request_download(%s, 'vid-a', '1080p', null, null, null)", []),
    }[fn]
    with acting(conn, ANON) as s:
        out = s.run(args[0], [hashlib.sha256(b"nobody").hexdigest()])
    assert out.ok and out.rows[0][0]["status"] == 401, out


# ── P8: a Telegram update is claimed once ───────────────────────────────────

def test_telegram_update_claims_are_first_come_and_service_only(conn, sc):
    from sec_db import SERVICE

    claim = ("insert into public.telegram_updates (update_id) values (%s), (%s) "
             "on conflict (update_id) do nothing returning update_id")
    with _rolled_back(conn):
        _as(conn, SERVICE)
        first = sorted(r[0] for r in conn.execute(claim, [424242, 424243]).fetchall())
        again = sorted(r[0] for r in conn.execute(claim, [424243, 424244]).fetchall())
        _owner(conn)
    assert first == [424242, 424243]
    assert again == [424244], "an update that was already claimed was claimed again — it would be replayed"
    for who in (sc.bob.actor, sc.operator, ANON):
        with acting(conn, who) as s:
            out = s.run("insert into public.telegram_updates (update_id) values (515151)")
        assert not out.ok, (who.name, out)
