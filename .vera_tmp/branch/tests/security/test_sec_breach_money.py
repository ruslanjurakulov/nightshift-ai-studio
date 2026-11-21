"""Breach-A (money red team): attacks on everything that moves credits or starts
paid work — the credit ledger and lots (0020/0021/0034), creative jobs
(0036/0046/0048/0050/0052/0055), Run-now billing (0041), storyboards
(0057/0058), editor exports (0054), the public API (0031/0040/0042) and
payments/welcome credits (0027/0042).

Every test here is an attack a signed-up customer, a viewer-level member, a
revoked/other-org API key or an anonymous caller could try. An attack that is
correctly refused is a passing test that goes RED the moment a guard is
weakened. If a future change opens one of these, flip the test to
``@pytest.mark.xfail(strict=True, reason="BR-A-NNN open")`` asserting the SECURE
behaviour so CI stays honest and the hole stays visible until it is fixed.

Pure-refusal attacks run on the shared session scenario (conftest ``conn`` /
``sc``); a refused statement rolls back on its own savepoint, so nothing leaks
between tests. Flows that must persist state (idempotency replay, a capture, a
release, the lot invariant) run in their own committing database so they never
touch the shared world.
"""

from __future__ import annotations

import json
import os
import uuid

import psycopg
import pytest

import sec_db
from sec_db import ANON, SERVICE, acting, as_superuser, user
import sec_editor_0054
import sec_storyboard_0057

MODEL = "brm-img"


# ── helpers on the shared (rolled-back) session ──────────────────────────────

def refuse(conn, who, q, p=None):
    """Run `q` as `who`; return the Outcome. Used to assert a refusal."""
    with acting(conn, who) as s:
        return s.run(q, p)


def su_rows(conn, q, p=None):
    with as_superuser(conn, commit=False) as s:
        return s.rows(q, p)


# ═════════════════════════════════════════════════════════════════════════════
# 1. The credit ledger and the money functions (0020 / 0034)
# ═════════════════════════════════════════════════════════════════════════════

SERVICE_ONLY_CREDIT_CALLS = [
    ("capture_credits", "select public.capture_credits('rj-seed-a', 1, false)"),
    ("release_credits", "select public.release_credits('rj-seed-a')"),
    ("add_purchased_credits", "select public.add_purchased_credits('{org}', 10, 'ext-x')"),
    ("start_credit_reservation", "select public.start_credit_reservation('rj-seed-a', '{org}')"),
    ("expire_credit_reservations", "select public.expire_credit_reservations('{org}')"),
    ("credit_account_lock", "select public.credit_account_lock('{org}')"),
    ("credit_log", "select public.credit_log('{org}','grant',1,null,null,null)"),
    ("credit_release_locked", "select public.credit_release_locked('rj-seed-a','x')"),
]


@pytest.mark.parametrize("name,call", SERVICE_ONLY_CREDIT_CALLS, ids=[c[0] for c in SERVICE_ONLY_CREDIT_CALLS])
def test_service_only_credit_functions_refuse_browsers(conn, sc, name, call):
    """A signed-in owner may not capture, release, mint or lock credits: those
    move money and belong to the platform (service role) alone."""
    q = call.replace("{org}", sc.alice.org)
    for who in (sc.alice.actor, ANON):
        out = refuse(conn, who, q)
        assert not out.ok and out.sqlstate == "42501", f"{name} as {who.name}: {out!r}"


def test_members_cannot_write_the_ledger_or_accounts_directly(conn, sc):
    """The ledger is append-only and the account is moved only by the functions:
    no INSERT/UPDATE/DELETE for a browser or the service key."""
    attacks = [
        (sc.alice.actor, "insert into public.credit_transactions (org_id,kind,amount,balance_after,reserved_after) "
                         "values (%s,'grant',1000,1000,0)", [sc.alice.org]),
        (sc.alice.actor, "update public.credit_accounts set balance = balance + 1000 where org_id=%s", [sc.alice.org]),
        (sc.alice.actor, "update public.credit_reservations set amount = 1 where job_id='rj-seed-a'", None),
        (SERVICE, "update public.credit_transactions set amount = 1 where id = (select min(id) from public.credit_transactions)", None),
        (SERVICE, "delete from public.credit_transactions where id = (select min(id) from public.credit_transactions)", None),
    ]
    for who, q, p in attacks:
        out = refuse(conn, who, q, p)
        assert not out.ok and out.sqlstate == "42501", f"{who.name}: {q!r} -> {out!r}"


def test_grant_credits_refuses_a_non_platform_admin(conn, sc):
    out = refuse(conn, sc.alice.actor, "select public.grant_credits(%s, 1000, 'self')", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501"


def test_reserve_credits_needs_org_admin_and_rejects_cross_org(conn, sc):
    """reserve_credits holds a customer's own money and must check the caller is
    an owner/admin of THAT organization — never another tenant's."""
    out = refuse(conn, sc.bob.actor, "select public.reserve_credits(%s, 'x-cross', 5)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501"
    out = refuse(conn, sc.dana, "select public.reserve_credits(%s, 'x-dana', 5)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501"


@pytest.mark.parametrize("amount", ["'NaN'::numeric", "'Infinity'::numeric", "'-Infinity'::numeric", "0", "-5", "100000001"])
def test_reserve_credits_rejects_nonfinite_and_out_of_range_amounts(conn, sc, amount):
    """A hold of NaN/Infinity/0/negative/absurd must be refused with 22023 and
    move nothing: Postgres orders NaN above every number, so the upper-bound
    guard has to catch it (it does), and a reservation of a non-positive amount
    would otherwise be a free or impossible run."""
    before = su_rows(conn, "select balance, reserved from public.credit_accounts where org_id=%s", [sc.alice.org])
    out = refuse(conn, sc.alice.actor, f"select public.reserve_credits(%s, 'x-nf', {amount})", [sc.alice.org])
    assert not out.ok and out.sqlstate == "22023", f"amount={amount}: {out!r}"
    after = su_rows(conn, "select balance, reserved from public.credit_accounts where org_id=%s", [sc.alice.org])
    assert before == after


def test_credit_prices_are_platform_admin_only(conn, sc):
    """The price list is what customers are charged. A non-admin's INSERT is
    refused by RLS, and an UPDATE/DELETE matches zero rows — the price is never
    changed (RLS USING hides every row from a non-admin)."""
    out = refuse(conn, sc.alice.actor,
                 "insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_hack', 0, 0)")
    assert not out.ok and out.sqlstate == "42501"
    # Seed a price row as the owner-DB, then confirm a member cannot move it.
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values ('br_a_probe', 7, 0) "
               "on conflict (unit) do update set credits_per_unit = 7 returning 1")
        for q in ("update public.credit_prices set credits_per_unit = 0 where unit='br_a_probe'",
                  "delete from public.credit_prices where unit='br_a_probe'"):
            with conn.transaction(force_rollback=True):
                conn.execute("select set_config('request.jwt.claims', %s, true)",
                             [json.dumps(sc.alice.actor.claims())])
                conn.execute("set local role authenticated")
                cur = conn.execute(q)
                assert cur.rowcount == 0, f"a member changed {cur.rowcount} price rows with {q!r}"
        still = s.value("select credits_per_unit from public.credit_prices where unit='br_a_probe'")
        assert still == 7


# ═════════════════════════════════════════════════════════════════════════════
# 2. Creative jobs (0036 + 0046/0048/0050/0052/0055)
# ═════════════════════════════════════════════════════════════════════════════

CREATIVE_WORKER_CALLS = [
    ("claim_creative_job", "select public.claim_creative_job('w')"),
    ("finish_creative_job", "select public.finish_creative_job('{job}','w',true)"),
    ("advance_creative_job", "select public.advance_creative_job('{job}','w','submitting')"),
    ("heartbeat_creative_job", "select public.heartbeat_creative_job('{job}','w')"),
    ("expire_creative_jobs", "select public.expire_creative_jobs()"),
    ("record_creative_job_cost", "select public.record_creative_job_cost('{job}','acme')"),
    ("creative_platform_reserve", "select public.creative_platform_reserve('{org}','cj:x',1)"),
    ("creative_platform_release", "select public.creative_platform_release('cj:x')"),
    ("creative_price", "select public.creative_price('{org}','t2i','lab-sold-1','{\"prompt\":\"x\"}'::jsonb)"),
    ("creative_job_source", "select public.creative_job_source('{job}','w')"),
    ("creative_source_seconds", "select public.creative_source_seconds('{org}','{}'::jsonb)"),
]


@pytest.mark.parametrize("name,call", CREATIVE_WORKER_CALLS, ids=[c[0] for c in CREATIVE_WORKER_CALLS])
def test_creative_worker_and_internal_functions_refuse_browsers(conn, sc, name, call):
    q = call.replace("{org}", sc.alice.org).replace("{job}", sc.alice.creative_job)
    for who in (sc.alice.actor, ANON):
        out = refuse(conn, who, q)
        assert not out.ok and out.sqlstate == "42501", f"{name} as {who.name}: {out!r}"


def test_create_and_cancel_are_scoped_to_the_callers_org(conn, sc):
    """A member of org B cannot start a generation that org A pays for, and
    another org's job reads as not-found (never 'forbidden': ids confirm
    nothing)."""
    out = refuse(conn, sc.bob.actor,
                 "select public.create_creative_job(%s,'t2i','lab-sold-1','{\"prompt\":\"x\"}')", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501"
    out = refuse(conn, sc.bob.actor, "select public.cancel_creative_job(%s)", [sc.alice.creative_job])
    assert not out.ok and out.sqlstate == "P0002"
    out = refuse(conn, sc.bob.actor, "select public.quote_creative_job(%s,'t2i','lab-sold-1','{\"prompt\":\"x\"}')",
                 [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501"


def test_browser_cannot_write_creative_rows_directly(conn, sc):
    for q in ("update public.creative_jobs set status='completed' where id='%s'" % sc.alice.creative_job,
              "delete from public.creative_jobs where id='%s'" % sc.alice.creative_job,
              "update public.creative_job_events set event='x'"):
        out = refuse(conn, sc.alice.actor, q)
        assert not out.ok and out.sqlstate == "42501", f"{q!r} -> {out!r}"


# ═════════════════════════════════════════════════════════════════════════════
# 3. Storyboards (0057 / 0058)
# ═════════════════════════════════════════════════════════════════════════════

def _sb(key):
    return sec_storyboard_0057.STORYBOARD[key]


CROSS_ORG_STORYBOARD_CALLS = [
    ("approve", "select public.approve_storyboard('{sb}', 1000, 'queue')"),
    ("approve_at", "select public.approve_storyboard_at('{sb}', 0, 1000, 'queue')"),
    ("discard", "select public.discard_storyboard('{sb}')"),
    ("save_edits", "select public.save_storyboard_edits('{sb}', 0, '[{\"narration\":\"x\"}]'::jsonb)"),
    ("reopen", "select public.reopen_storyboard('{sb}')"),
    ("dispatch_failed", "select public.storyboard_dispatch_failed('{sb}')"),
    ("reopen_check", "select public.storyboard_reopen_check('{sb}')"),
]


@pytest.mark.parametrize("name,call", CROSS_ORG_STORYBOARD_CALLS, ids=[c[0] for c in CROSS_ORG_STORYBOARD_CALLS])
def test_a_tenant_cannot_touch_another_tenants_storyboard(conn, sc, name, call):
    """Bob may not approve, edit, discard or re-open Alice's storyboard — a
    paid render is started only by an admin of the channel's organization, and
    another org's storyboard reads exactly like a missing one (42501)."""
    q = call.replace("{sb}", _sb("a"))
    out = refuse(conn, sc.bob.actor, q)
    assert not out.ok and out.sqlstate == "42501", f"{name}: {out!r}"


def test_anon_cannot_approve_or_edit_storyboards(conn, sc):
    for q in (f"select public.approve_storyboard('{_sb('a')}', 1000, 'queue')",
              f"select public.save_storyboard_edits('{_sb('a')}', 0, '[]'::jsonb)",
              f"select public.reopen_storyboard('{_sb('a')}')"):
        out = refuse(conn, ANON, q)
        assert not out.ok and out.sqlstate == "42501", f"{q!r} -> {out!r}"


def test_browser_cannot_write_storyboards_directly(conn, sc):
    for q in (f"update public.storyboards set status='approved' where id='{_sb('a')}'",
              f"update public.storyboards set duration_s = 30 where id='{_sb('a')}'",
              "insert into public.storyboards (channel_id,slug,topic,scenes,script,duration_s) "
              f"values ('{sc.alice.channel}','hack','t','[]'::jsonb,'{{}}'::jsonb,60)"):
        out = refuse(conn, sc.alice.actor, q)
        assert not out.ok and out.sqlstate == "42501", f"{q!r} -> {out!r}"


# ═════════════════════════════════════════════════════════════════════════════
# 4. Editor exports (0054)
# ═════════════════════════════════════════════════════════════════════════════

def _proj(key):
    return sec_editor_0054.PROJECT[key]


def _export(key):
    return sec_editor_0054.EXPORT[key]


def test_editor_cross_org_project_and_export_are_not_found(conn, sc):
    """Bob cannot export, save or delete Alice's project; another org's project
    reads as not-found."""
    for q in (f"select public.request_editor_export('{_proj('a')}', 1)",
              f"select public.save_editor_project('{_proj('a')}', 1, 't', null)",
              f"select public.delete_editor_project('{_proj('a')}')"):
        out = refuse(conn, sc.bob.actor, q)
        assert not out.ok and out.sqlstate == "P0002", f"{q!r} -> {out!r}"


EDITOR_WORKER_CALLS = [
    ("claim", "select public.claim_editor_export('w')"),
    ("heartbeat", "select public.editor_export_heartbeat('{exp}','w')"),
    ("assets", "select * from public.editor_export_assets('{exp}')"),
    ("finish", "select public.finish_editor_export('{exp}','w',null,'done')"),
]


@pytest.mark.parametrize("name,call", EDITOR_WORKER_CALLS, ids=[c[0] for c in EDITOR_WORKER_CALLS])
def test_editor_worker_functions_refuse_browsers(conn, sc, name, call):
    """Only the media worker (service role) may claim, finish or read the files
    of an export — a browser forging a finish is refused."""
    q = call.replace("{exp}", _export("a"))
    for who in (sc.alice.actor, ANON):
        out = refuse(conn, who, q)
        assert not out.ok and out.sqlstate == "42501", f"{name} as {who.name}: {out!r}"


def test_an_editor_document_cannot_name_another_orgs_asset(conn, sc):
    """Every asset_id in a timeline must be a live file of the project's own
    organization; naming org B's video reads exactly like a made-up id."""
    doc = json.dumps(sec_editor_0054.doc(sec_editor_0054.VIDEO["b"]))
    out = refuse(conn, sc.alice.actor, "select public.create_editor_project(%s,'x',%s::jsonb)", [sc.alice.org, doc])
    assert not out.ok and out.sqlstate == "NS400" and "invalid_asset" in (out.error or "")


# ═════════════════════════════════════════════════════════════════════════════
# 5. Public API (0031 / 0040 / 0042)
# ═════════════════════════════════════════════════════════════════════════════
# The anon entry points return a JSON error object instead of raising; their
# internal writes (rate counters) roll back with the savepoint, so asserting on
# the returned body needs no commit.

def _api(conn, q, p=None):
    with acting(conn, ANON) as s:
        return s.rows(q, p)[0][0]


def test_api_entry_points_refuse_unknown_and_malformed_keys(conn, sc):
    for call, params in [("select public.api_balance(%s, null)", ["0" * 64]),
                         ("select public.api_balance(%s, null)", ["not-a-hash"]),
                         ("select public.api_create_video(%s,'chan-a','{}'::jsonb,null,null,null)", ["0" * 64])]:
        body = _api(conn, call, params)
        assert body["ok"] is False and body["error"]["code"] == "invalid_api_key", (call, body)


def test_api_revoked_key_is_refused(conn, sc):
    """A revoked key is dead the moment it is revoked."""
    with as_superuser(conn, commit=False) as s:
        s.rows("update public.api_keys set revoked_at = now() where id=%s returning 1", [sc.alice.api_key_id])
        # read inside the same tx: call api_balance with Alice's (now revoked) key hash
        conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(ANON.claims())])
        conn.execute("set local role anon")
        body = conn.execute("select public.api_balance(%s, null)", [sc.alice.api_key_hash]).fetchone()[0]
        conn.execute("reset role")
    assert body["ok"] is False and body["error"]["code"] == "invalid_api_key", body


def test_api_key_cannot_reach_another_orgs_channel(conn, sc):
    """A key is bound to its organization: Alice's key naming Bob's channel is
    'channel_not_found', the same answer as a made-up id (no cross-tenant
    oracle, and no run that the wrong balance would pay for)."""
    body = _api(conn, "select public.api_create_video(%s, %s, '{\"duration\":60}'::jsonb, null, null, null)",
                [sc.alice.api_key_hash, sc.bob.channel])
    assert body["ok"] is False and body["error"]["code"] == "channel_not_found", body


API_SERVICE_ONLY = [
    ("api_add_topup", "select public.api_add_topup('{org}', 1000, 'ext', 'n')"),
    ("api_hold_start", "select public.api_hold_start('ah-x', 10)"),
    ("api_finish", "select public.api_finish('{}'::jsonb, '{}'::jsonb, 0)"),
    ("api_begin", "select public.api_begin('{hash}', 'videos.create', null)"),
    ("api_refund_topup", "select public.api_refund_topup('ah-x','r',1,'n','p')"),
    ("api_settle_locked", "select public.api_settle_locked('ah-x', 1, 200)"),
]


@pytest.mark.parametrize("name,call", API_SERVICE_ONLY, ids=[c[0] for c in API_SERVICE_ONLY])
def test_api_money_functions_are_service_only(conn, sc, name, call):
    q = call.replace("{org}", sc.alice.org).replace("{hash}", sc.alice.api_key_hash)
    for who in (sc.alice.actor, ANON):
        out = refuse(conn, who, q)
        assert not out.ok and out.sqlstate in ("42501", "42883"), f"{name} as {who.name}: {out!r}"


def test_api_adjust_balance_refuses_a_non_platform_admin(conn, sc):
    """api_adjust_balance is executable by authenticated, but moves an API
    balance only for a platform admin (or the service role)."""
    out = refuse(conn, sc.alice.actor, "select public.api_adjust_balance(%s, 1000, 'free money')", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501"


def test_browser_cannot_mint_api_keys_with_a_chosen_hash(conn, sc):
    """0042 made create_api_key mint the key itself; the old client-chosen-hash
    signatures are gone, so a weak or reused key can no longer be registered.
    Only the no-hash minting signature remains, and a browser call carrying a
    hash argument resolves to no function at all."""
    sigs = su_rows(conn,
        "select to_regprocedure('public.create_api_key(uuid,text,text,bigint)') is null "       # 0040 client-hash
        "   and to_regprocedure('public.create_api_key(uuid,text,text,text,bigint)') is null "   # 0031 client-hash
        "   and to_regprocedure('public.create_api_key(uuid,text,bigint)') is not null")          # the minting one
    assert sigs[0][0] is True
    out = refuse(conn, sc.alice.actor,
                 "select public.create_api_key('%s'::uuid,'k','pref','%s',123)" % (sc.alice.org, "a" * 64))
    assert not out.ok and out.sqlstate == "42883"  # no signature takes a hash


# ═════════════════════════════════════════════════════════════════════════════
# 6. Payments and welcome credits (0027 / 0042)
# ═════════════════════════════════════════════════════════════════════════════

def test_payment_functions_are_service_only_and_events_are_closed(conn, sc):
    for who in (sc.alice.actor, ANON):
        out = refuse(conn, who,
                     "select public.record_payment_event('paddle','e-x','transaction.completed',now(),'processed',"
                     "null,%s,null,null,10,null,null)", [sc.alice.org])
        assert not out.ok and out.sqlstate == "42501", f"record_payment_event as {who.name}: {out!r}"
        out = refuse(conn, who, "select public.add_purchased_credits(%s, 100, 'pay-x')", [sc.alice.org])
        assert not out.ok and out.sqlstate == "42501"
        out = refuse(conn, who, "select public.refund_purchased_credits('pay-x','rf-x',10)")
        assert not out.ok and out.sqlstate == "42501"
    out = refuse(conn, sc.alice.actor,
                 "insert into public.payment_events (provider,event_id,event_type,status,org_id) "
                 "values ('paddle','e-y','x','processed',%s)", [sc.alice.org])
    assert not out.ok and out.sqlstate == "42501"


def test_welcome_credit_marker_is_closed_and_normalizes_aliases(conn, sc):
    """A customer cannot read or write the welcome-claim marker, and the mailbox
    key folds +tags and gmail dots so one inbox earns one grant."""
    out = refuse(conn, sc.alice.actor, "select * from public.welcome_credit_claims")
    assert not out.ok and out.sqlstate == "42501"
    out = refuse(conn, sc.alice.actor, "select public.welcome_email_key('a@b.com')")
    assert not out.ok and out.sqlstate == "42501"
    with as_superuser(conn, commit=False) as s:
        keys = s.rows("select public.welcome_email_key('a.b+promo@gmail.com'), "
                      "public.welcome_email_key('ab+2@googlemail.com'), public.welcome_email_key('AB@gmail.com')")
    assert keys[0][0] == keys[0][1] == keys[0][2] == "ab@gmail.com"


# ═════════════════════════════════════════════════════════════════════════════
# Flows that must persist — their own committing database
# ═════════════════════════════════════════════════════════════════════════════

class CommitDb:
    """A committing handle on a scratch database, acting as any caller."""

    def __init__(self, dsn):
        self._conn = psycopg.connect(dsn, autocommit=True)

    def act(self, who, q, p=None):
        with acting(self._conn, who, commit=True) as s:
            return s.run(q, p)

    def su(self, q, p=None):
        with as_superuser(self._conn, commit=True) as s:
            return s.run(q, p)

    def close(self):
        self._conn.close()


@pytest.fixture(scope="module")
def flow():
    """A fresh committing world built from the migrations alone — deliberately
    NOT build_scenario(), which populates module-global registries other test
    files read. A confirmed user owns organization C, granted credits, with one
    sellable t2i model priced. No seeded holds, so the Free plan's one-open-hold
    limit never gets in the way of these flows."""
    dsn = sec_db.admin_dsn()
    if not dsn:
        if os.environ.get("NIGHTSHIFT_SECURITY_REQUIRED"):
            pytest.fail(f"{sec_db.DSN_ENV} is not set", pytrace=False)
        pytest.skip(f"{sec_db.DSN_ENV} is not set")
    name = f"ns_brmoney_{uuid.uuid4().hex[:8]}"
    db = CommitDb(sec_db.build(dsn, name))
    carol = user("carol", "carol@c.test")
    with as_superuser(db._conn, commit=True) as s:
        s.rows("insert into auth.users (id,email,email_confirmed_at) values (%s,%s,now()) returning id",
               [carol.uid, carol.email])
    org_c = str(db.act(carol, "select public.create_organization('Carol Co')").rows[0][0])
    db.su("select public.grant_credits(%s, 1000, 'flow seed')", [org_c])
    # A sellable t2i model with entitlement 'any' and a price, through the real
    # path (the scenario's lab-sold-1 needs an entitlement no plan grants here).
    model = {"id": MODEL, "display_name": MODEL, "provider": "lab", "adapter": "image.openai",
             "capabilities": ["t2i"], "credit_unit": "model_brm_img_image", "entitlement": "any",
             "spec": {"vendor_model": "lab-model-1", "output": "image",
                      "pricing": {"unit": "image", "provider_usd_per_unit": 0.04}, "terms_gate": None}}
    db.act(SERVICE, "select public.sync_model_registry(%s::jsonb)", [json.dumps([model])])
    db.act(SERVICE, "select public.record_model_probe(%s,'image.openai','lab-model-1','t2i',true,"
                    "null,null,900,1234,'breach-a')", [MODEL])
    db.su("update public.model_registry set availability='ga' where id=%s", [MODEL])
    db.su("insert into public.credit_prices (unit, credits_per_unit, margin) values ('model_brm_img_image', 4, 0) "
          "on conflict (unit) do update set credits_per_unit = 4")
    try:
        yield db, carol, org_c
    finally:
        db.close()
        if not os.environ.get("NIGHTSHIFT_SECURITY_KEEP"):
            sec_db.drop_database(dsn, name)


def _acct(db, org):
    return db.su("select balance::float, reserved::float from public.credit_accounts where org_id=%s", [org]).rows[0]


def test_idempotency_key_is_one_job_one_hold_and_rejects_a_changed_body(flow):
    """Two presses with one idempotency key return the same job and hold once;
    the same key with a different request is a conflict, never a second job."""
    db, carol, org = flow
    k = "press-" + uuid.uuid4().hex[:8]
    a = db.act(carol, "select public.create_creative_job(%s,'t2i','brm-img','{\"prompt\":\"a\"}','exact',%s,null)",
               [org, k]).rows[0][0]
    jid = a["job"]["id"]
    held = db.su("select count(*) from public.credit_reservations where job_id=%s", ["cj:" + jid]).rows[0][0]
    b = db.act(carol, "select public.create_creative_job(%s,'t2i','brm-img','{\"prompt\":\"a\"}','exact',%s,null)",
               [org, k]).rows[0][0]
    assert b["replay"] is True and b["job"]["id"] == jid
    assert db.su("select count(*) from public.credit_reservations where job_id=%s", ["cj:" + jid]).rows[0][0] == held == 1
    out = db.act(carol, "select public.create_creative_job(%s,'t2i','brm-img','{\"prompt\":\"DIFFERENT\"}','exact',%s,null)",
                 [org, k])
    assert not out.ok and out.sqlstate == "NS409" and "idempotency_conflict" in (out.error or "")
    # clean up the open hold so the module's later flows are not plan-limited
    jid_u = jid
    db.su("select public.release_credits(%s)", ["cj:" + jid_u])
    db.su("update public.creative_jobs set status='cancelled' where id=%s", [jid_u])


def test_max_credits_below_the_real_price_is_refused_and_holds_nothing(flow):
    """A confirmed price below what the job really costs is 409 price_changed:
    the hold is never placed, so a client cannot buy a job for less than its
    quote."""
    db, carol, org = flow
    before = _acct(db, org)
    out = db.act(carol, "select public.create_creative_job(%s,'t2i','brm-img','{\"prompt\":\"x\"}','exact',null,%s)",
                 [org, "0.01"])
    assert not out.ok and out.sqlstate == "NS409" and "price_changed" in (out.error or "")
    assert _acct(db, org) == before


def test_capture_never_exceeds_the_hold(flow):
    """The platform's own capture may not charge more than the hold without
    allow_over, and even with allow_over not past the balance — the ledger and
    the lots stay in step (the deferred invariant would fire otherwise)."""
    db, carol, org = flow
    ref = "cap-" + uuid.uuid4().hex[:8]
    db.act(SERVICE, "select public.reserve_credits(%s,%s,10)", [org, ref])
    before = _acct(db, org)
    out = db.act(SERVICE, f"select public.capture_credits(%s, 20, false)", [ref])
    assert not out.ok and out.sqlstate == "22023", out
    assert db.su("select status from public.credit_reservations where job_id=%s", [ref]).rows[0][0] == "open"
    assert _acct(db, org) == before
    # a legitimate capture of less than the hold releases the rest
    db.act(SERVICE, "select public.capture_credits(%s, 4, false)", [ref])
    after = _acct(db, org)
    assert after == (before[0] - 4, before[1] - 10)


def test_a_released_hold_can_never_be_started_again(flow):
    """The anti-double-spend core of storyboard re-open: once a hold is
    released it is final — start_credit_reservation only starts an OPEN hold,
    so a re-opened run can never render on the old approval's money."""
    db, carol, org = flow
    ref = "rel-" + uuid.uuid4().hex[:8]
    db.act(SERVICE, "select public.reserve_credits(%s,%s,5)", [org, ref])
    db.act(SERVICE, "select public.release_credits(%s)", [ref])
    assert db.su("select status from public.credit_reservations where job_id=%s", [ref]).rows[0][0] == "released"
    started = db.act(SERVICE, "select public.start_credit_reservation(%s,%s)", [ref, org]).rows[0][0]
    assert started is None


def test_the_lot_balance_invariant_holds_after_a_reserve_release_cycle(flow):
    """migration 0034's deferred constraint: sum(credit_lots.remaining) equals
    the account balance and sum(held) equals reserved, at every commit. A
    reserve then a release must leave both in step and the lots back to unheld."""
    db, carol, org = flow
    ref = "lot-" + uuid.uuid4().hex[:8]
    db.act(SERVICE, "select public.reserve_credits(%s,%s,7)", [org, ref])
    bal, res = _acct(db, org)
    rem, held = db.su("select coalesce(sum(remaining),0)::float, coalesce(sum(held),0)::float "
                      "from public.credit_lots where org_id=%s and remaining>0", [org]).rows[0]
    assert (rem, held) == (bal, res) and held >= 7
    db.act(SERVICE, "select public.release_credits(%s)", [ref])
    bal2, res2 = _acct(db, org)
    rem2, held2 = db.su("select coalesce(sum(remaining),0)::float, coalesce(sum(held),0)::float "
                        "from public.credit_lots where org_id=%s and remaining>0", [org]).rows[0]
    assert (rem2, held2) == (bal2, res2) and res2 == 0
