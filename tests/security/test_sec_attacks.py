"""Named attacks: what a malicious customer would actually try.

The table-by-table isolation tests prove the policies; these prove the
functions and triggers — the paths that spend money, publish, or mint credits,
where a check lives in plpgsql rather than in a policy. Bob (org B) attacks
Alice (org A) unless a test says otherwise.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from sec_db import ANON, acting, as_superuser


def balance(conn, table: str, org: str, col: str = "balance"):
    with as_superuser(conn, commit=False) as s:
        return s.value(f"select {col} from public.{table} where org_id = %s", [org])


# ── credits: nobody mints money from a browser ──────────────────────────────

MINTERS = [
    ("grant_credits", "select public.grant_credits(%s, 1000, 'free')"),
    ("api_adjust_balance", "select public.api_adjust_balance(%s, 100000, 'free')"),
    ("add_purchased_credits", "select public.add_purchased_credits(%s, 1000, 'txn_fake', 'free')"),
    ("api_add_topup", "select public.api_add_topup(%s, 100000, 'txn_fake', 'free')"),
]


@pytest.mark.parametrize("name,query", MINTERS, ids=[m[0] for m in MINTERS])
def test_customer_cannot_mint_credits_for_their_own_org(conn, sc, name, query):
    before = (balance(conn, "credit_accounts", sc.bob.org), balance(conn, "api_accounts", sc.bob.org, "balance_cents"))
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query, [sc.bob.org])
        s.conn.execute("reset role")
        after = (s.value("select balance from public.credit_accounts where org_id = %s", [sc.bob.org]),
                 s.value("select balance_cents from public.api_accounts where org_id = %s", [sc.bob.org]))
    assert not out.ok, f"{name}: a customer called it successfully: {out!r}"
    assert after == before


def test_customer_cannot_write_a_balance_directly(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        for q in ("update public.credit_accounts set balance = balance + 1000 where org_id = %s",
                  "update public.api_accounts set balance_cents = balance_cents + 100000 where org_id = %s",
                  "insert into public.credit_transactions (org_id, kind, amount, balance_after, reserved_after) values (%s, 'grant', 1000, 1000, 0)",
                  "insert into public.api_ledger (org_id, kind, amount_cents, balance_after, reserved_after) values (%s, 'topup', 1000, 1000, 0)"):
            out = s.run(q, [sc.bob.org])
            assert (not out.ok) or out.rowcount == 0, f"{q}: {out!r}"


@pytest.mark.parametrize("query", [
    "select public.capture_credits('job-a', 1, false)",
    "select public.release_credits('job-a')",
    "select public.start_credit_reservation('job-a', %(org)s)",
    "select public.expire_credit_reservations(%(org)s, interval '0', interval '0')",
    "select public.refund_purchased_credits('pay-a', 'rf-new', 1, 'n', 'refund')",
    "select public.record_payment_event('paddle', 'evt-new', 'transaction.completed', now(), 'processed', null, %(org)s, 'txn', null, 1000, 'USD', 100)",
])
def test_customer_cannot_call_the_settlement_functions(conn, sc, query):
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query, {"org": sc.alice.org})
    assert not out.ok and out.sqlstate == "42501", out


def test_customer_cannot_reserve_against_another_orgs_credits(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.reserve_credits(%s, 'bob-job-1', 60)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501", out


def test_welcome_credits_come_once_per_account_not_per_org(conn, sc):
    # create_organization allows ten orgs per account; a welcome grant per org
    # would be ten free starts. Sam (no org yet) gets the grant; Bob's second
    # org does not.
    with acting(conn, sc.stranger) as s:
        org = s.value("select public.create_organization('Sam Studio')")
        s.conn.execute("reset role")
        assert s.value("select balance from public.credit_accounts where org_id = %s", [org]) == 100
    with acting(conn, sc.bob.actor) as s:
        org = s.value("select public.create_organization('Bob Second')")
        s.conn.execute("reset role")
        assert (s.value("select balance from public.credit_accounts where org_id = %s", [org]) or 0) == 0


# ── runs: nobody starts a render on someone else's channel ──────────────────

def _render_job(s, channel, params=None, **cols):
    row = {"channel_id": channel, "kind": "daily", "params": params or {}, "status": "queued",
           "attempts": 0, "max_attempts": 3, **cols}
    names = ", ".join(row)
    marks = ", ".join(["%s"] * len(row))
    vals = [json.dumps(v) if isinstance(v, dict) else v for v in row.values()]
    return s.run(f"insert into public.render_jobs ({names}) values ({marks})", vals)


def _hold(s, org) -> str:
    """A fresh queue credit hold of `org`, reserved by whoever `s` acts as —
    what "Run now" takes before it queues a customer's run (0041 refuses a
    customer's render job without one)."""
    return s.value("select public.reserve_credits(%s, 'rj-' || gen_random_uuid()::text, 60) ->> 'job_id'", [org])


def test_customer_cannot_queue_a_render_on_another_orgs_channel(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = _render_job(s, sc.alice.channel)
    assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("extra", [
    {"params": {"privacy": "public"}},
    {"params": {"repair_scenes": "s001"}},
    {"kind": "repair"},
    {"status": "running"},
    {"attempts": 1},
    {"max_attempts": 10},
    {"worker_id": "evil"},
], ids=lambda e: next(iter(e)) + "=" + json.dumps(next(iter(e.values()))))
def test_customer_render_job_cannot_carry_worker_or_publish_fields(conn, sc, extra):
    # Nothing in a browser may choose privacy, repair scenes, or skip the
    # queue's state machine.
    extra = dict(extra)
    params = {"duration": 300, **extra.pop("params", {})}
    with acting(conn, sc.bob.actor) as s:
        ok = _render_job(s, sc.bob.channel, params={"duration": 300}, credit_ref=_hold(s, sc.bob.org))
        out = _render_job(s, sc.bob.channel, params=params, credit_ref=_hold(s, sc.bob.org), **extra)
    assert ok.ok, f"control: Bob cannot queue a plain run on his own channel: {ok!r}"
    assert not out.ok, out


# ── publishing: nobody posts another tenant's video, or to their account ─────

def _publish(s, video, account=None, channel=None):
    return s.run("insert into public.publish_requests (video_id, account_id, target_channel_id) values (%s, %s, %s)",
                 [video, account, channel])


def test_publish_requests_stay_inside_one_org(conn, sc):
    a, b = sc.alice, sc.bob
    with acting(conn, b.actor) as s:
        control = _publish(s, b.video, account=b.social_account)
        attacks = {
            "A's video to B's account": _publish(s, a.video, account=b.social_account),
            "B's video to A's account": _publish(s, b.video, account=a.social_account),
            "A's video to A's account": _publish(s, a.video, account=a.social_account),
            "B's video to A's YouTube channel": _publish(s, b.video, channel=a.channel),
            "A's video to A's YouTube channel": _publish(s, a.video, channel=a.channel),
            "the operator's video to B's account": _publish(s, sc.operator_video, account=b.social_account),
        }
    assert control.ok, f"control: Bob cannot publish his own video to his own account: {control!r}"
    for name, out in attacks.items():
        assert not out.ok and out.sqlstate == "42501", f"{name}: {out!r}"


def test_customer_cannot_set_publish_request_outcome_columns(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("insert into public.publish_requests (video_id, account_id, status, result_url) "
                    "values (%s, %s, 'published', 'https://example.com')", [sc.bob.video, sc.bob.social_account])
        up = s.run("update public.publish_requests set status = 'published' where org_id = %s", [sc.bob.org])
    assert not out.ok and out.sqlstate == "42501", out
    assert (not up.ok) or up.rowcount == 0, up


def test_two_person_rule_holds_for_an_owner(conn, sc):
    # The owner of org B requested this approval; the same person cannot decide it.
    with acting(conn, sc.bob.actor) as s:
        out = s.run("update public.publish_approvals set status = 'approved', decided_by = %s, decided_at = now() "
                    "where channel_id = %s", [sc.bob.actor.uid, sc.bob.channel])
    assert (not out.ok) or out.rowcount == 0, out


# ── downloads ───────────────────────────────────────────────────────────────

def test_customer_cannot_buy_a_download_of_another_orgs_video(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.request_download(%s, '1080p')", [sc.alice.video])
    assert not out.ok and out.sqlstate == "42501", out


# ── connected accounts and tokens ───────────────────────────────────────────

def test_channel_token_functions_refuse_another_orgs_channel(conn, sc):
    meta = json.dumps({"youtube_channel_id": "UCevil", "scopes": []})
    with acting(conn, sc.bob.actor) as s:
        store = s.run("select public.store_channel_token(%s, %s, %s::jsonb)", [sc.alice.channel, "1//" + "x" * 40, meta])
        revoke = s.run("select public.revoke_channel_token(%s)", [sc.alice.channel])
        status_a = s.run("select * from public.channel_token_status(%s)", [sc.alice.channel])
        status_all = s.run("select channel_id from public.channel_token_status()")
    assert not store.ok and store.sqlstate == "42501", store
    assert not revoke.ok and revoke.sqlstate == "42501", revoke
    assert status_a.ok and status_a.rows == [], status_a
    assert status_all.ok and [r[0] for r in status_all.rows] == [sc.bob.channel], status_all


def test_social_account_functions_refuse_another_org(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        store = s.run("select public.store_social_account(%s, 'instagram', %s, null, %s::jsonb)",
                      [sc.alice.org, "IGQ" + "x" * 40, json.dumps({"external_id": "ig-evil"})])
        revoke = s.run("select public.revoke_social_account(%s)", [sc.alice.social_account])
    assert not store.ok and store.sqlstate == "42501", store
    assert not revoke.ok and revoke.sqlstate == "42501", revoke


def test_nobody_but_the_service_role_reads_a_token(conn, sc):
    for who in (sc.bob.actor, sc.alice.actor, sc.operator, ANON):
        with acting(conn, who) as s:
            yt = s.run("select public.read_channel_token(%s)", [sc.alice.channel])
            so = s.run("select public.read_social_token(%s)", [sc.alice.social_account])
            vault = s.run("select decrypted_secret from vault.decrypted_secrets")
        assert not yt.ok and not so.ok and not vault.ok, (who.name, yt, so, vault)


# ── the developer console and the public API ────────────────────────────────

def _create_api_key_call(conn) -> str:
    """create_api_key with whichever signature this schema has: a key prefix
    argument before 0040, a client-computed hash before 0042, and neither
    once the database mints the key itself (0042)."""
    with as_superuser(conn, commit=False) as s:
        args = s.value("select string_agg(pg_get_function_identity_arguments(oid), '|') "
                       "from pg_proc where proname = 'create_api_key' and pronamespace = 'public'::regnamespace")
    if "p_prefix" in (args or ""):
        return "select public.create_api_key(%(org)s, 'evil', %(hash)s, 'evil1234', null)"
    if "p_key_hash" in (args or ""):
        return "select public.create_api_key(%(org)s, 'evil', %(hash)s, null)"
    return "select public.create_api_key(%(org)s, 'evil', null)"


@pytest.mark.parametrize("query", [
    "create_api_key",
    "select public.revoke_api_key(%(key)s)",
    "select public.set_api_key_limit(%(key)s, 1)",
    "select public.api_console(%(org)s)",
    "select public.api_usage(%(org)s, 30)",
    "select public.api_activate(%(org)s, 'v1')",
    "select public.api_set_monthly_limit(%(org)s, 1)",
])
def test_developer_console_functions_refuse_another_org(conn, sc, query):
    args = {"org": sc.alice.org, "key": sc.alice.api_key_id, "hash": hashlib.sha256(b"evil").hexdigest()}
    if query == "create_api_key":
        query = _create_api_key_call(conn)
    with acting(conn, sc.bob.actor) as s:
        out = s.run(query, args)
    assert not out.ok and out.sqlstate == "42501", out


def _api(conn, fn: str, *args):
    marks = ", ".join(["%s"] * len(args))
    with acting(conn, ANON) as s:
        out = s.run(f"select public.{fn}({marks})", list(args))
    assert out.ok, out
    return out.rows[0][0]


def test_an_api_key_only_reaches_its_own_org(conn, sc):
    b, a = sc.bob.api_key_hash, sc.alice
    assert _api(conn, "api_get_video", b, sc.bob.video)["status"] == 200  # control
    assert _api(conn, "api_get_video", b, a.video)["status"] == 404
    assert _api(conn, "api_get_video", b, sc.operator_video)["status"] == 404
    assert _api(conn, "api_list_videos", b, a.channel, 50, 0, None)["data"]["videos"] == []
    assert _api(conn, "api_get_job", b, a.render_job, None)["status"] == 404
    assert _api(conn, "api_get_download", b, a.download_request, None)["status"] == 404
    channels = _api(conn, "api_list_channels", b, None)["data"]
    assert a.channel not in json.dumps(channels) and "default" not in [c.get("id") for c in channels.get("channels", [])]
    accounts = _api(conn, "api_list_connected_accounts", b, None)
    assert a.social_account not in json.dumps(accounts)
    for fn, args in [
        ("api_create_video", (b, a.channel, json.dumps({"topic": "x"}), None, None, None)),
        ("api_request_publish", (b, a.video, [a.social_account], None, None, None, None)),
        ("api_request_download", (b, a.video, "1080p", None, None, None)),
    ]:
        res = _api(conn, fn, *args)
        assert res["ok"] is False and res["status"] in (403, 404, 422), (fn, res)


def test_an_unknown_or_malformed_key_is_refused(conn, sc):
    for h in (hashlib.sha256(b"nobody").hexdigest(), "", "' or 1=1 --"):
        assert _api(conn, "api_auth", h, None)["status"] == 401


# ── organizations and membership ────────────────────────────────────────────

def test_customer_cannot_invite_into_another_org(conn, sc):
    # Since 0091 nobody can invite: the refusal is the privilege, not a role check.
    with acting(conn, sc.bob.actor) as s:
        out = s.run("select public.invite_org_member(%s, 'bob2@b.test', 'owner')", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501", out


def test_a_legacy_pending_row_is_offered_to_nobody_and_binds_to_nobody(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        s.value("select public.bind_org_memberships()")
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False
        assert not s.run("select * from public.my_invites()").ok
    with acting(conn, sc.invitee) as s:  # control: not even its addressee can list or accept it
        assert not s.run("select * from public.my_invites()").ok
        assert s.value("select public.is_org_member(%s, 'viewer')", [sc.alice.org]) is False


def test_my_organizations_lists_only_the_callers_own(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        ids = {str(r[0]) for r in s.rows("select id from public.my_organizations()")}
    assert ids == {sc.bob.org}
    for who in (sc.stranger, ANON):
        with acting(conn, who) as s:
            out = s.run("select id from public.my_organizations()")
        assert (not out.ok) or out.rows == [], (who.name, out)


def test_customer_cannot_move_a_channel_into_another_org(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        out = s.run("update public.channels set org_id = %s where channel_id = %s", [sc.alice.org, sc.bob.channel])
    assert (not out.ok) or out.rowcount == 0, out


def test_customer_cannot_claim_the_platform_roster(conn, sc):
    for who in (sc.bob.actor, sc.stranger):
        with acting(conn, who) as s:
            out = s.run("insert into public.app_members (user_id, email, role) values (%s, %s, 'owner')", [who.uid, who.email])
            assert not out.ok, (who.name, out)
            assert s.value("select public.is_platform_admin()") is False


# ── storage ─────────────────────────────────────────────────────────────────

def test_preview_objects_follow_the_channel(conn, sc):
    with acting(conn, sc.bob.actor) as s:
        names = [r[0] for r in s.rows("select name from storage.objects where bucket_id = 'previews'")]
    assert names == [f"{sc.bob.channel}/slug-b.mp4"]
    for who in (sc.stranger, ANON):
        with acting(conn, who) as s:
            out = s.run("select name from storage.objects where bucket_id = 'previews'")
        assert (not out.ok) or out.rows == [], (who.name, out)
