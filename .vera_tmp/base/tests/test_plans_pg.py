"""Migration 0034 (plans, entitlements, credit lots) against a REAL Postgres.

SQL does not run in CI, so this file skips unless NIGHTSHIFT_PG_TEST_DSN names
a throwaway Postgres 15+ server where the connecting role is a superuser, e.g.

    NIGHTSHIFT_PG_TEST_DSN="host=/var/run/postgresql port=5432 user=postgres" \
        python -m pytest tests/test_plans_pg.py -q

It creates (and drops) the database ``ns_plans_test``, adds a minimal Supabase
shim (roles anon/authenticated/service_role, auth.uid()/auth.role(), vault,
storage), applies supabase/schema.sql and every migration BEFORE 0034, seeds an
organization with a pre-0034 balance and an open hold, applies 0034 (twice, for
idempotency) and every later migration, and then drives the money paths through
the real functions as the roles that call them in production.

What it proves: the carry-over of old balances, spend order, expiry (holds
protected), renewal and upgrade idempotency, that two concurrent holds cannot
overspend, the parallel-run limit, the exempt organization, webhook replays,
entitlement lookups and who may read them, refund-to-own-lot, download refund
restoring its lots, the queue priority, the commit-time consistency check, and
RLS on the new tables.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("0*.sql"))
DSN = os.environ.get("NIGHTSHIFT_PG_TEST_DSN", "").strip()
DB = "ns_plans_test"

SHIM = r"""
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create schema if not exists extensions;
create table if not exists auth.users (id uuid primary key, email text, email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(), last_sign_in_at timestamptz);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $f$;
create or replace function auth.email() returns text language sql stable as $f$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email') $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text,
  name text, owner uuid, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $f$
  select string_to_array(name, '/') $f$;
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text,
  description text, secret text, key_id uuid, created_at timestamptz default now());
create or replace view vault.decrypted_secrets as select id, name, description, secret,
  secret as decrypted_secret, key_id, created_at from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null,
  new_description text default '', new_key_id uuid default null) returns uuid language sql as $f$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, new_description, new_key_id) returning id $f$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null,
  new_name text default null, new_description text default null, new_key_id uuid default null)
  returns void language sql as $f$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name)
   where id = secret_id $f$;
"""


class SqlError(Exception):
    def __init__(self, code: str, text: str):
        super().__init__(f"{code}: {text}")
        self.code = code
        self.text = text


def _psql(dbname: str, script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["psql", f"{DSN} dbname={dbname}", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-f", "-"],
        input=script,
        capture_output=True,
        text=True,
        timeout=300,
    )


def _raise_for(res: subprocess.CompletedProcess) -> None:
    if res.returncode == 0:
        return
    err = res.stderr
    code = ""
    for line in err.splitlines():
        if "ERROR:" in line:
            rest = line.split("ERROR:", 1)[1].strip()
            code = rest.split(":", 1)[0].strip()
            break
    raise SqlError(code, err.strip())


def sql(q: str, *, role: str | None = None, sub: str | None = None, db: str = DB) -> str:
    """Run q in one transaction as `role` (None = the SQL editor: no claims)."""
    head = "\\set VERBOSITY verbose\nbegin;\n"
    if role:
        claims = {"role": role}
        if sub:
            claims["sub"] = sub
        head += f"set local role {role};\nselect set_config('request.jwt.claims', '{json.dumps(claims)}', true) \\g /dev/null\n"
    res = _psql(db, head + q.rstrip().rstrip(";") + ";\ncommit;\n")
    _raise_for(res)
    return res.stdout.strip()


def val(q: str, **kw) -> str:
    out = sql(q, **kw).splitlines()
    return out[-1] if out else ""


def num(q: str, **kw) -> float:
    return float(val(q, **kw))


def svc(q: str) -> str:
    return sql(q, role="service_role")


@unittest.skipUnless(DSN, "set NIGHTSHIFT_PG_TEST_DSN to run 0034 against a real Postgres")
class Plans0034(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        admin = "postgres"
        _raise_for(_psql(admin, f"drop database if exists {DB};\ncreate database {DB};\n"))
        _raise_for(_psql(DB, SHIM))
        base = (ROOT / "supabase" / "schema.sql").read_text()
        _raise_for(_psql(DB, base))
        before = [m for m in MIGRATIONS if m.name < "0034"]
        after = [m for m in MIGRATIONS if m.name >= "0034"]
        for m in before:
            _raise_for(_psql(DB, m.read_text()))

        # ── a pre-0034 organization: 500 credits, 100 of them on an open hold ──
        cls.legacy = str(uuid.uuid4())
        sql(f"insert into public.organizations (id, name, slug) values ('{cls.legacy}', 'Legacy', 'legacy-{cls.legacy[:8]}')")
        sql(f"select public.grant_credits('{cls.legacy}', 500, 'old grant')")
        sql(f"select public.reserve_credits('{cls.legacy}', 'rj-legacy-hold', 100)")

        for m in after:
            _raise_for(_psql(DB, m.read_text()))
        # Idempotent: 0034 applied again changes nothing and breaks nothing.
        _raise_for(_psql(DB, (ROOT / "supabase" / "migrations" / "0034_plans_entitlements.sql").read_text()))

        cls.exempt = val("select public.default_org_id()")

    # ── helpers ────────────────────────────────────────────────────────────
    def new_org(self, name: str = "Org") -> str:
        org = str(uuid.uuid4())
        sql(f"insert into public.organizations (id, name, slug) values ('{org}', '{name}', 'o-{org[:12]}')")
        return org

    def new_user(self, org: str, role: str = "admin") -> str:
        uid = str(uuid.uuid4())
        sql(f"insert into auth.users (id, email, email_confirmed_at) values ('{uid}', '{uid[:8]}@example.com', now())")
        sql(f"insert into public.org_members (org_id, user_id, email, role) values ('{org}', '{uid}', '{uid[:8]}@example.com', '{role}')")
        return uid

    def account(self, org: str) -> tuple[float, float]:
        row = val(f"select balance || '|' || reserved from public.credit_accounts where org_id = '{org}'")
        b, r = row.split("|")
        return float(b), float(r)

    def lots(self, org: str) -> list[tuple[str, float, float]]:
        out = sql(
            f"select source || '|' || remaining || '|' || held from public.credit_lots where org_id = '{org}' order by id"
        )
        return [(s, float(r), float(h)) for s, r, h in (line.split("|") for line in out.splitlines() if line)]

    def assert_consistent(self, org: str):
        b, r = self.account(org)
        lots = self.lots(org)
        self.assertAlmostEqual(b, sum(x[1] for x in lots), places=2)
        self.assertAlmostEqual(r, sum(x[2] for x in lots), places=2)

    def subscribe(self, org: str, plan: str, sub_id: str | None = None, *, start="now() - interval '1 day'",
                  end="now() + interval '29 days'", txn: str | None = None) -> str:
        sub_id = sub_id or "sub_" + uuid.uuid4().hex[:26]
        txn = txn or "txn_" + uuid.uuid4().hex[:26]
        svc(f"select public.upsert_subscription('{org}', '{sub_id}', 'ctm_{uuid.uuid4().hex[:26]}', '{plan}', null, "
            f"'active', {start}, {end}, false, null, now())")
        svc(f"select public.grant_subscription_credits('{org}', '{sub_id}', '{plan}', {start}, {end}, '{txn}')")
        return sub_id

    # ── the carry-over ─────────────────────────────────────────────────────
    def test_legacy_balance_is_carried_over_and_its_hold_settles(self):
        self.assertIn(("adjustment", 500.0, 100.0), self.lots(self.legacy))
        self.assertEqual(val(f"select count(*) from public.credit_lots where org_id = '{self.legacy}' and expires_at is not null"), "0")
        # Settle the pre-0034 hold: 80 charged, 20 back.
        svc("select public.capture_credits('rj-legacy-hold', 80)")
        self.assertEqual(self.account(self.legacy), (420.0, 0.0))
        self.assert_consistent(self.legacy)

    # ── spend order ────────────────────────────────────────────────────────
    def test_spend_order_subscription_first_then_soonest_expiring(self):
        org = self.new_org()
        sql(f"select public.grant_credits('{org}', 100, 'a grant')")  # never expires
        svc(f"select public.add_purchased_credits('{org}', 1000, 'txn_{uuid.uuid4().hex[:26]}', 'pack')")  # 12 months
        self.subscribe(org, "creator")  # 2000, expires in 29 days
        self.assertEqual(self.account(org), (3100.0, 0.0))
        self.assertEqual(
            val(f"select expires_at::date = (now() + interval '12 months')::date from public.credit_lots where org_id='{org}' and source='pack'"),
            "t",
        )
        # Studio-like concurrency is not needed: one hold at a time.
        sql(f"select public.reserve_credits('{org}', 'rj-{uuid.uuid4().hex[:12]}', 2500)")
        lots = {s: (r, h) for s, r, h in self.lots(org)}
        self.assertEqual(lots["subscription"], (2000.0, 2000.0))
        self.assertEqual(lots["pack"], (1000.0, 500.0))
        self.assertEqual(lots["grant"], (100.0, 0.0))
        self.assert_consistent(org)

    def test_capture_spends_the_hold_and_release_returns_the_rest(self):
        org = self.new_org()
        svc(f"select public.add_purchased_credits('{org}', 1000, 'txn_{uuid.uuid4().hex[:26]}', 'pack')")
        self.subscribe(org, "creator")
        job = f"rj-{uuid.uuid4().hex[:12]}"
        sql(f"select public.reserve_credits('{org}', '{job}', 2400)")
        svc(f"select public.start_credit_reservation('{job}', '{org}')")
        svc(f"select public.capture_credits('{job}', 2100)")
        lots = {s: (r, h) for s, r, h in self.lots(org)}
        self.assertEqual(lots["subscription"], (0.0, 0.0))
        self.assertEqual(lots["pack"], (900.0, 0.0))
        self.assertEqual(self.account(org), (900.0, 0.0))
        self.assertEqual(val(f"select count(*) from public.credit_hold_lots where job_id = '{job}'"), "0")
        self.assert_consistent(org)

    def test_capture_over_the_hold_takes_the_extra_from_available(self):
        org = self.new_org()
        svc(f"select public.add_purchased_credits('{org}', 1000, 'txn_{uuid.uuid4().hex[:26]}', 'pack')")
        job = f"rj-{uuid.uuid4().hex[:12]}"
        sql(f"select public.reserve_credits('{org}', '{job}', 100)")
        svc(f"select public.capture_credits('{job}', 150, true)")
        self.assertEqual(self.account(org), (850.0, 0.0))
        self.assert_consistent(org)

    # ── expiry ─────────────────────────────────────────────────────────────
    def test_expired_lot_leaves_the_balance_but_held_credits_stay_protected(self):
        org = self.new_org()
        sub = self.subscribe(org, "creator")
        job = f"rj-{uuid.uuid4().hex[:12]}"
        sql(f"select public.reserve_credits('{org}', '{job}', 300)")
        # The period ends (as if the clock passed it).
        sql(f"update public.credit_lots set expires_at = now() - interval '1 minute', period_end = now() - interval '1 minute' "
            f"where org_id = '{org}' and source = 'subscription'")
        expired = num(f"select public.expire_credit_lots('{org}')", role="service_role")
        self.assertEqual(expired, 1700.0)
        self.assertEqual(self.account(org), (300.0, 300.0))
        self.assertEqual(val(f"select count(*) from public.credit_transactions where org_id = '{org}' and kind = 'expire'"), "1")
        # The run still settles from the (expired) held credits...
        svc(f"select public.capture_credits('{job}', 200)")
        # ...and the unused 100 go back to the expired lot and expire at once.
        self.assertEqual(self.account(org), (0.0, 0.0))
        self.assertEqual(num(f"select coalesce(sum(-amount), 0) from public.credit_transactions where org_id = '{org}' and kind = 'expire'"), 1800.0)
        self.assert_consistent(org)
        self.assertTrue(sub)

    def test_the_account_lock_sweeps_so_no_check_counts_expired_credits(self):
        org = self.new_org()
        self.subscribe(org, "creator")
        sql(f"update public.credit_lots set expires_at = now() - interval '1 second', period_end = now() - interval '1 second' "
            f"where org_id = '{org}' and source = 'subscription'")
        with self.assertRaises(SqlError) as e:
            sql(f"select public.reserve_credits('{org}', 'rj-{uuid.uuid4().hex[:12]}', 50)")
        self.assertEqual(e.exception.code, "NS402")

    # ── renewal and upgrade ────────────────────────────────────────────────
    def test_renewal_is_idempotent_and_expires_the_previous_period(self):
        org = self.new_org()
        sub = "sub_" + uuid.uuid4().hex[:26]
        txn1 = "txn_" + uuid.uuid4().hex[:26]
        svc(f"select public.grant_subscription_credits('{org}', '{sub}', 'creator', now() - interval '30 days', "
            f"now() + interval '2 seconds', '{txn1}')")
        again = json.loads(val(f"select public.grant_subscription_credits('{org}', '{sub}', 'creator', "
                               f"now() - interval '30 days', now() + interval '2 seconds', '{txn1}')", role="service_role"))
        self.assertTrue(again["duplicate"])
        self.assertEqual(self.account(org), (2000.0, 0.0))
        sql("select pg_sleep(2.5)")
        txn2 = "txn_" + uuid.uuid4().hex[:26]
        res = json.loads(val(f"select public.grant_subscription_credits('{org}', '{sub}', 'creator', now() - interval '1 second', "
                             f"now() + interval '30 days', '{txn2}')", role="service_role"))
        self.assertEqual(res["granted"], 2000)
        self.assertEqual(self.account(org), (2000.0, 0.0))  # old 2000 expired, new 2000 granted: no rollover
        self.assertEqual(val(f"select count(*) from public.credit_transactions where org_id = '{org}' and kind = 'expire'"), "1")
        # A replay of the renewal, and a different transaction for the same period: nothing more.
        for t in (txn2, "txn_" + uuid.uuid4().hex[:26]):
            r = json.loads(val(f"select public.grant_subscription_credits('{org}', '{sub}', 'creator', now() - interval '1 second', "
                               f"(select period_end from public.credit_lots where external_id = '{txn2}'), '{t}')", role="service_role"))
            self.assertEqual(float(r["granted"]), 0.0)
        self.assertEqual(self.account(org), (2000.0, 0.0))
        self.assert_consistent(org)

    def test_mid_period_upgrade_tops_up_in_proportion(self):
        org = self.new_org()
        sub = self.subscribe(org, "creator", start="now() - interval '15 days'", end="now() + interval '15 days'")
        r = json.loads(val(f"select public.grant_subscription_credits('{org}', '{sub}', 'pro', now(), "
                           f"(select period_end from public.credit_lots where org_id = '{org}' and source = 'subscription'), "
                           f"'txn_{uuid.uuid4().hex[:26]}')", role="service_role"))
        self.assertAlmostEqual(float(r["granted"]), 2000.0, delta=1.0)  # (6000-2000) x half the period
        self.assertEqual(val(f"select count(*) from public.credit_lots where org_id = '{org}' and source = 'subscription'"), "1")
        self.assert_consistent(org)

    def test_a_period_already_over_grants_nothing(self):
        org = self.new_org()
        r = json.loads(val(f"select public.grant_subscription_credits('{org}', 'sub_{uuid.uuid4().hex[:26]}', 'creator', "
                           f"now() - interval '60 days', now() - interval '30 days', 'txn_{uuid.uuid4().hex[:26]}')", role="service_role"))
        self.assertEqual(float(r["granted"]), 0.0)
        self.assertEqual(self.account(org), (0.0, 0.0))

    def test_subscription_events_out_of_order_do_not_regress(self):
        org = self.new_org()
        sub = "sub_" + uuid.uuid4().hex[:26]
        svc(f"select public.upsert_subscription('{org}', '{sub}', null, 'pro', null, 'active', now(), now() + interval '30 days', "
            f"false, null, now())")
        r = json.loads(val(f"select public.upsert_subscription('{org}', '{sub}', null, 'creator', null, 'canceled', null, null, "
                           f"false, now(), now() - interval '1 hour')", role="service_role"))
        self.assertTrue(r["stale"])
        self.assertEqual(val(f"select public.org_plan('{org}')"), "pro")
        # A price no longer mapped to a plan: the cancellation still lands, plan kept on record.
        svc(f"select public.upsert_subscription('{org}', '{sub}', null, null, null, 'canceled', null, null, false, now(), now() + interval '1 second')")
        self.assertEqual(val(f"select public.org_plan('{org}')"), "free")
        self.assertEqual(val(f"select plan_id from public.subscriptions where provider_subscription_id = '{sub}'"), "pro")
        with self.assertRaises(SqlError):  # but a new subscription needs a plan
            svc(f"select public.upsert_subscription('{org}', 'sub_{uuid.uuid4().hex[:26]}', null, null, null, 'active', null, null, false, null, now())")

    def test_the_same_subscription_cannot_move_to_another_organization(self):
        a, b = self.new_org(), self.new_org()
        sub = self.subscribe(a, "creator")
        with self.assertRaises(SqlError) as e:
            svc(f"select public.grant_subscription_credits('{b}', '{sub}', 'creator', now(), now() + interval '30 days', "
                f"'txn_{uuid.uuid4().hex[:26]}')")
        self.assertEqual(e.exception.code, "23505")

    # ── concurrency ────────────────────────────────────────────────────────
    def test_concurrent_holds_cannot_overspend(self):
        org = self.new_org()
        self.subscribe(org, "studio")  # 8 parallel runs: only the money limits this
        # Spend down to exactly 100 available.
        svc(f"select public.add_purchased_credits('{org}', 100, 'txn_{uuid.uuid4().hex[:26]}', 'pack')")
        sql(f"select public.reserve_credits('{org}', 'rj-{uuid.uuid4().hex[:12]}', 18000)")
        results: list[str] = []

        def attempt(i: int):
            try:
                sql(f"select public.reserve_credits('{org}', 'rj-race-{i}-{uuid.uuid4().hex[:8]}', 80); select pg_sleep(0.5)")
                results.append("ok")
            except SqlError as e:
                results.append(e.code)

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), ["NS402", "NS402", "NS402", "ok"])
        b, r = self.account(org)
        self.assertEqual((b, r), (18100.0, 18080.0))
        self.assert_consistent(org)

    def test_parallel_run_limit_follows_the_plan(self):
        org = self.new_org()
        svc(f"select public.add_purchased_credits('{org}', 5000, 'txn_{uuid.uuid4().hex[:26]}', 'pack')")
        sql(f"select public.reserve_credits('{org}', 'rj-{uuid.uuid4().hex[:12]}', 100)")
        with self.assertRaises(SqlError) as e:  # Free: 1 at a time
            sql(f"select public.reserve_credits('{org}', 'rj-{uuid.uuid4().hex[:12]}', 100)")
        self.assertEqual(e.exception.code, "NS429")
        self.subscribe(org, "creator")  # 2 at a time
        sql(f"select public.reserve_credits('{org}', 'rj-{uuid.uuid4().hex[:12]}', 100)")
        with self.assertRaises(SqlError):
            sql(f"select public.reserve_credits('{org}', 'rj-{uuid.uuid4().hex[:12]}', 100)")
        slots = json.loads(val(f"select public.org_run_slots('{org}')"))
        self.assertEqual((slots["limit"], slots["active"]), (2, 2))

    def test_concurrent_reservations_cannot_exceed_the_run_limit(self):
        org = self.new_org()
        svc(f"select public.add_purchased_credits('{org}', 5000, 'txn_{uuid.uuid4().hex[:26]}', 'pack')")
        results: list[str] = []

        def attempt(i: int):
            try:
                sql(f"select public.reserve_credits('{org}', 'rj-lim-{i}-{uuid.uuid4().hex[:8]}', 10); select pg_sleep(0.5)")
                results.append("ok")
            except SqlError as e:
                results.append(e.code)

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), ["NS429", "NS429", "ok"])

    # ── exempt organization ────────────────────────────────────────────────
    def test_exempt_org_gets_everything_and_is_never_held(self):
        ent = json.loads(val(f"select public.org_entitlements('{self.exempt}')"))
        self.assertEqual(ent["concurrency"], 1000)
        self.assertTrue(ent["api_access"] and ent["mcp"] and ent["series"])
        self.assertEqual(ent["models_video"], "all")
        self.assertEqual(val(f"select public.model_tier_allowed('{self.exempt}', 'video', 'ultra')"), "t")
        r = json.loads(val(f"select public.reserve_credits('{self.exempt}', 'rj-{uuid.uuid4().hex[:12]}', 100)"))
        self.assertTrue(r["exempt"])
        self.assertTrue(json.loads(val(f"select public.org_run_slots('{self.exempt}')"))["exempt"])

    # ── entitlements ───────────────────────────────────────────────────────
    def test_entitlement_lookups_and_who_may_ask(self):
        org = self.new_org()
        member = self.new_user(org, "viewer")
        stranger = self.new_user(self.new_org(), "owner")
        self.assertEqual(val(f"select public.entitlement_int('{org}', 'concurrency')", role="authenticated", sub=member), "1")
        self.assertEqual(val(f"select public.has_entitlement('{org}', 'api_access')", role="authenticated", sub=member), "f")
        self.assertEqual(val(f"select public.model_tier_allowed('{org}', 'video', 'basic')", role="authenticated", sub=member), "t")
        self.assertEqual(val(f"select public.model_tier_allowed('{org}', 'video', 'premium')", role="authenticated", sub=member), "f")
        self.subscribe(org, "pro")
        self.assertEqual(val(f"select public.entitlement_int('{org}', 'concurrency')", role="authenticated", sub=member), "4")
        self.assertEqual(val(f"select public.has_entitlement('{org}', 'mcp')", role="authenticated", sub=member), "t")
        self.assertEqual(val(f"select public.model_tier_allowed('{org}', 'video', 'ultra')", role="authenticated", sub=member), "t")
        self.assertEqual(val(f"select public.model_tier_allowed('{org}', 'video', 'bogus')", role="authenticated", sub=member), "f")
        # Someone outside the organization learns nothing.
        self.assertEqual(val(f"select coalesce(public.org_entitlements('{org}')::text, 'null')", role="authenticated", sub=stranger), "null")
        self.assertEqual(val(f"select public.has_entitlement('{org}', 'mcp')", role="authenticated", sub=stranger), "f")
        self.assertEqual(val(f"select coalesce(public.billing_summary('{org}')::text, 'null')", role="authenticated", sub=stranger), "null")
        summary = json.loads(val(f"select public.billing_summary('{org}')", role="authenticated", sub=member))
        self.assertEqual(summary["plan"]["id"], "pro")
        self.assertEqual(float(summary["credits"]["subscription"]), 6000.0)
        self.assertEqual(summary["subscription"]["status"], "active")
        # A plan typo cannot slip in a value of the wrong type.
        with self.assertRaises(SqlError):
            sql("insert into public.plan_entitlements (plan_id, key, value) values ('free', 'series', '1')")

    def test_a_platform_admin_edits_the_config_and_a_tenant_cannot(self):
        admin = str(uuid.uuid4())
        sql(f"insert into auth.users (id, email, email_confirmed_at) values ('{admin}', 'pa{admin[:6]}@example.com', now())")
        sql(f"insert into public.app_members (user_id, email, role) values ('{admin}', 'pa{admin[:6]}@example.com', 'admin')")
        sql("update public.plan_entitlements set value = '3' where plan_id = 'creator' and key = 'concurrency' returning 1",
            role="authenticated", sub=admin)
        self.assertEqual(val("select value from public.plan_entitlements where plan_id = 'creator' and key = 'concurrency'"), "3")
        with self.assertRaises(SqlError):  # the type still holds for an admin
            sql("update public.plan_entitlements set value = 'true' where plan_id = 'creator' and key = 'concurrency'",
                role="authenticated", sub=admin)
        sql("update public.plan_entitlements set value = '2' where plan_id = 'creator' and key = 'concurrency'")
        tenant = self.new_user(self.new_org(), "owner")
        out = sql("update public.plans set monthly_credits = 999999 where id = 'free' returning 1", role="authenticated", sub=tenant)
        self.assertEqual(out, "")
        self.assertEqual(num("select monthly_credits from public.plans where id = 'free'"), 0.0)

    def test_a_discounted_period_grants_the_paid_share_only(self):
        org = self.new_org()
        r = json.loads(val(f"select public.grant_subscription_credits('{org}', 'sub_{uuid.uuid4().hex[:26]}', 'creator', "
                           f"now(), now() + interval '30 days', 'txn_{uuid.uuid4().hex[:26]}', null, null, null, 0.5)",
                           role="service_role"))
        self.assertEqual(float(r["granted"]), 1000.0)
        with self.assertRaises(SqlError):
            svc(f"select public.grant_subscription_credits('{org}', 'sub_{uuid.uuid4().hex[:26]}', 'creator', "
                f"now(), now() + interval '30 days', 'txn_{uuid.uuid4().hex[:26]}', null, null, null, 1.5)")

    def test_api_activation_follows_the_api_access_entitlement(self):
        org = self.new_org()
        self.assertEqual(val(f"select public.api_org_eligible('{org}')"), "f")
        self.subscribe(org, "creator")
        self.assertEqual(val(f"select public.api_org_eligible('{org}')"), "t")

    # ── refunds ────────────────────────────────────────────────────────────
    def test_refunding_a_pack_takes_its_own_lot_first(self):
        org = self.new_org()
        self.subscribe(org, "creator")
        pack_txn = "txn_" + uuid.uuid4().hex[:26]
        svc(f"select public.add_purchased_credits('{org}', 1000, '{pack_txn}', 'pack')")
        svc(f"select public.refund_purchased_credits('{pack_txn}', 'adj_{uuid.uuid4().hex[:26]}', null, 'test', 'refund')")
        lots = {s: (r, h) for s, r, h in self.lots(org)}
        self.assertEqual(lots["pack"], (0.0, 0.0))
        self.assertEqual(lots["subscription"], (2000.0, 0.0))
        self.assert_consistent(org)

    def test_a_subscription_payment_can_be_refunded(self):
        org = self.new_org()
        txn = "txn_" + uuid.uuid4().hex[:26]
        self.subscribe(org, "creator", txn=txn)
        r = json.loads(val(f"select public.refund_purchased_credits('{txn}', 'adj_{uuid.uuid4().hex[:26]}', null, null, 'refund')",
                           role="service_role"))
        self.assertEqual(float(r["taken"]), 2000.0)
        self.assertEqual(self.account(org), (0.0, 0.0))

    def test_failed_download_refund_restores_the_lots_it_spent(self):
        org = self.new_org()
        editor = self.new_user(org, "editor")
        ch = "ch-" + uuid.uuid4().hex[:8]
        vid = "v-" + uuid.uuid4().hex[:8]
        sql(f"insert into public.channels (channel_id, name, org_id) values ('{ch}', 'C', '{org}')")
        sql(f"insert into public.videos (video_id, channel_id, title) values ('{vid}', '{ch}', 't')")
        sql(f"insert into public.download_masters (video_id, org_id, width, height, duration_seconds, bytes) "
            f"values ('{vid}', '{org}', 1920, 1080, 600, 1000)")
        self.subscribe(org, "creator")
        svc(f"select public.add_purchased_credits('{org}', 1000, 'txn_{uuid.uuid4().hex[:26]}', 'pack')")
        r = json.loads(val(f"select public.request_download('{vid}', '1080p', null)", role="authenticated", sub=editor))
        charged = float(r["charged"])
        self.assertGreater(charged, 0)
        lots = {s: (rem, h) for s, rem, h in self.lots(org)}
        self.assertEqual(lots["subscription"][0], 2000.0 - charged)  # spent from the subscription lot
        sql(f"select public.download_fail_locked({r['id']}, 'test', 'failed')")  # the worker's sweep path
        lots = {s: (rem, h) for s, rem, h in self.lots(org)}
        self.assertEqual(lots["subscription"][0], 2000.0)
        self.assertEqual(self.account(org), (3000.0, 0.0))
        self.assert_consistent(org)

    # ── the guard ──────────────────────────────────────────────────────────
    def test_a_balance_change_without_the_ledger_is_refused_at_commit(self):
        org = self.new_org()
        sql(f"select public.grant_credits('{org}', 10, 'x')")
        with self.assertRaises(SqlError) as e:
            sql(f"update public.credit_accounts set balance = balance + 5 where org_id = '{org}'")
        self.assertEqual(e.exception.code, "23514")
        self.assertEqual(self.account(org), (10.0, 0.0))

    def test_welcome_credits_become_a_grant_lot(self):
        uid = str(uuid.uuid4())
        sql(f"insert into auth.users (id, email, email_confirmed_at) values ('{uid}', 'w{uid[:6]}@example.com', now())")
        org = val("select public.create_organization('Welcome Co')", role="authenticated", sub=uid)
        self.assertEqual(self.lots(org), [("grant", 100.0, 0.0)])
        self.assert_consistent(org)

    # ── queue priority ─────────────────────────────────────────────────────
    def test_higher_plans_get_a_head_start_in_the_render_queue(self):
        free_org, studio_org = self.new_org(), self.new_org()
        self.subscribe(studio_org, "studio")
        ch_free, ch_studio = "cf-" + uuid.uuid4().hex[:8], "cs-" + uuid.uuid4().hex[:8]
        sql(f"insert into public.channels (channel_id, name, org_id) values ('{ch_free}', 'F', '{free_org}'), "
            f"('{ch_studio}', 'S', '{studio_org}')")
        sql("update public.render_jobs set status = 'cancelled' where status in ('queued', 'running')")
        sql(f"insert into public.render_jobs (channel_id, created_at) values ('{ch_free}', now() - interval '20 minutes')")
        sql(f"insert into public.render_jobs (channel_id, created_at) values ('{ch_studio}', now())")
        first = val("select channel_id from public.claim_render_job('w1')")
        self.assertEqual(first, ch_studio)  # 45-minute head start beats 20 minutes of waiting
        second = val("select channel_id from public.claim_render_job('w1')")
        self.assertEqual(second, ch_free)

    # ── RLS ────────────────────────────────────────────────────────────────
    def test_rls_members_read_their_own_and_nobody_writes(self):
        org = self.new_org()
        member = self.new_user(org, "owner")
        stranger = self.new_user(self.new_org(), "owner")
        self.subscribe(org, "creator")
        self.assertEqual(val(f"select count(*) from public.credit_lots where org_id = '{org}'", role="authenticated", sub=member), "1")
        self.assertEqual(val(f"select count(*) from public.subscriptions where org_id = '{org}'", role="authenticated", sub=member), "1")
        self.assertEqual(val(f"select count(*) from public.credit_lots where org_id = '{org}'", role="authenticated", sub=stranger), "0")
        self.assertEqual(val("select count(*) > 0 from public.plans", role="anon"), "t")
        for q in (
            f"insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status) values ('{org}', 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'studio', 'active')",
            f"update public.credit_lots set remaining = remaining + 1 where org_id = '{org}'",
            "update public.plans set monthly_credits = 999999 where id = 'free'",
            f"select public.grant_subscription_credits('{org}', 'sub_x', 'studio', now(), now() + interval '1 day', 'txn_x')",
        ):
            with self.subTest(q=q[:40]), self.assertRaises(SqlError):
                r = sql(q + " returning 1" if q.startswith("update") else q, role="authenticated", sub=member)
                if q.startswith("update") and r == "":
                    raise SqlError("0", "no rows")  # RLS filtered every row: nothing was written
        with self.assertRaises(SqlError):
            svc(f"insert into public.credit_lots (org_id, source, amount, remaining) values ('{org}', 'grant', 1, 1)")


if __name__ == "__main__":
    unittest.main()
