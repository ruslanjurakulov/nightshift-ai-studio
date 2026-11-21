-- 0031_public_api.sql — the public API (/api/v1, later MCP): activation, API
-- keys, a separate prepaid USD balance, usage tiers, limits and a request log.
--
-- THE MODEL (a developer console, like the big model APIs)
--   * OFF by default. An organization that has bought at least one credit
--     pack (any purchase row in 0020's ledger — the rule lib/account.ts
--     derivePlan() uses to tell a paid plan from free), or the operator's own
--     credits-exempt organization, may ACTIVATE it: an owner/admin clicks
--     "Activate API" in the Developer console and accepts the API terms.
--     Before that, no key can be created and no key works.
--   * A SEPARATE prepaid balance in US cents (api_accounts), not the site's
--     credits. Topped up through Paddle (min $5, max $5,000 per payment); the
--     Paddle webhook (service role) credits it with api_add_topup(), idempotent
--     on the Paddle transaction id. Refunds / chargebacks take it back with
--     api_refund_topup(), never below zero (the shortfall is written down, as
--     0021 does for credits).
--   * An append-only ledger (api_ledger): topup / hold / usage / release /
--     refund / adjustment, each row with the balance and hold after it. Every
--     function that moves money locks the account row first.
--   * Prices (api_prices, editable by a platform owner/admin):
--       video_minute   120 cents  per minute of requested video length
--       job_minimum     60 cents  the smallest charge of one video
--       publish          0 cents  cross-posting a finished video
--       download_cents_per_credit  1.5  an HD download through the API costs
--                                  the site's credit price x $0.01 x 1.5
--                                  (the endpoint arrives with 0030)
--     Why these numbers: the site sells ~60 credits per video minute at
--     ~$0.01 a credit (~$0.60/min retail) and a minute costs ~$0.20 to make;
--     the API price is 2x site retail (6x cost).
--   * Charging a video: create HOLDS max(ceil(seconds x video_minute / 60),
--     job_minimum) from the available balance, the queued job carries the
--     hold (render_jobs.api_hold_ref), the worker checks the hold is open and
--     bound to that job before it spends anything (api_hold_start), and when
--     the job ends a trigger on render_jobs CAPTURES it (succeeded) or
--     RELEASES it in full (failed / cancelled). Holds that can no longer
--     settle are released lazily. A job is not linked to the video it
--     produced, so the charge is the price quoted for the requested length —
--     never more than the hold.
--   * Usage tiers by cumulative paid top-ups (net of refunds):
--       tier 0  activated, no top-up yet      10 rpm,  1 video at once,      $0/month
--       tier 1  >= $5                          30 rpm,  2 at once,          $100/month
--       tier 2  >= $50                         60 rpm,  3 at once,          $500/month
--       tier 3  >= $250                       120 rpm,  5 at once,        $2,000/month
--       tier 4  >= $1,000                     300 rpm, 10 at once,       $10,000/month
--     The exempt operator organization is tier 4 with no cap and no charge.
--     An organization may set a LOWER monthly limit, and each key its own
--     monthly limit. Spend this month = captured usage + holds still open.
--
-- WHY THE WORK HAPPENS IN THE DATABASE
--   The Command Center never holds the service key (CLAUDE.md #3), and an API
--   call has no signed-in user. So /api/v1 calls the api_* functions below
--   with the ANON key; each is security definer, finds the key by the SHA-256
--   the web server computed (the key itself never reaches the database), and
--   works only inside that key's organization.
--
-- WHO A KEY ACTS AS
--   Its creator, inside the key's organization only. api_act_as() sets this
--   transaction's JWT claims (sub + email) to that person, so 0029's
--   publish_requests insert trigger — editor of the target's organization,
--   video in the same organization, publish gate, approvals — runs unchanged
--   against their CURRENT role. A creator who has left, or is no longer an
--   owner/admin, disables their keys (key_owner_not_admin). The claims' role
--   stays anon, so no service-only function opens up; the settings are
--   transaction-local and PostgREST runs each call in its own transaction.
--
-- ENTRY POINTS return jsonb and never raise, so the rate counter's increment
-- and the request log commit even for a refused call:
--   {"ok": true,  "status": 200, "data": {...}, "rate": {...}}
--   {"ok": false, "status": 4xx, "error": {"code": "...", "message": "..."}, "rate": {...}}
--
--   * HD downloads (0030) through the API reuse 0030's rows, worker and file
--     serving; only the payment differs: the site's credit price for that
--     download (credit_prices download_720p_minute / download_1080p_minute /
--     download_minimum) x download_cents_per_credit (1.5 cents: $0.01 per
--     credit x 1.5) is HELD from the API balance, captured when the file is
--     ready and released if the download fails. A re-download within 7 days
--     and the exempt organization stay free, as on the site.
--
-- REQUIRES 0017/0019 (render_jobs), 0018 (organizations), 0020 (credit
-- ledger, for eligibility), 0028 (social_accounts), 0029 (publish_requests),
-- 0030 (download_requests).
-- Additive and idempotent. Nothing existing is dropped or redefined.

do $$
begin
  if to_regclass('public.publish_requests') is null then
    raise exception '0031 needs 0029_publish_targets.sql: apply it first';
  end if;
  if to_regclass('public.credit_transactions') is null then
    raise exception '0031 needs 0020_credits.sql: apply it first';
  end if;
  if to_regclass('public.render_jobs') is null then
    raise exception '0031 needs 0017_render_jobs.sql: apply it first';
  end if;
  if to_regclass('public.download_requests') is null then
    raise exception '0031 needs 0030_paid_downloads.sql: apply it first';
  end if;
end $$;

create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.api_settings (
  org_id              uuid primary key references public.organizations (id) on delete cascade,
  activated_at        timestamptz,
  activated_by        uuid,
  terms_version       text check (terms_version is null or terms_version ~ '^[a-z0-9.-]{1,40}$'),
  monthly_limit_cents bigint check (monthly_limit_cents is null or monthly_limit_cents >= 0),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
comment on table public.api_settings is
  'Per-organization API switch (migration 0031): when it was activated, by whom, which API terms they accepted, and the organization''s own monthly spend limit (cents, below its tier cap).';

create table if not exists public.api_accounts (
  org_id           uuid primary key references public.organizations (id) on delete restrict,
  balance_cents    bigint not null default 0,
  reserved_cents   bigint not null default 0,
  paid_total_cents bigint not null default 0,
  updated_at       timestamptz not null default now(),
  constraint api_accounts_balance_check check (balance_cents >= 0),
  constraint api_accounts_reserved_check check (reserved_cents >= 0 and reserved_cents <= balance_cents),
  constraint api_accounts_paid_check check (paid_total_cents >= 0)
);
comment on table public.api_accounts is
  'Prepaid API balance in US cents (migration 0031) — separate from site credits. available = balance - reserved. paid_total = top-ups net of refunds; it sets the usage tier. Changed only by the 0031 functions.';

create table if not exists public.api_ledger (
  id                 bigserial primary key,
  org_id             uuid not null references public.organizations (id) on delete restrict,
  kind               text not null check (kind in ('topup', 'hold', 'usage', 'release', 'refund', 'adjustment')),
  amount_cents       bigint not null,
  balance_after      bigint not null,
  reserved_after     bigint not null,
  requested_cents    bigint,
  hold_ref           text,
  key_id             uuid,
  external_id        text check (external_id is null or length(external_id) between 1 and 200),
  source_external_id text check (source_external_id is null or length(source_external_id) between 1 and 200),
  note               text check (note is null or length(note) <= 500),
  created_by         uuid,
  created_at         timestamptz not null default now()
);
create unique index if not exists api_ledger_external_id_key on public.api_ledger (external_id) where external_id is not null;
create index if not exists api_ledger_org_idx on public.api_ledger (org_id, created_at desc, id desc);
comment on table public.api_ledger is
  'Append-only API money ledger (cents). topup/refund/adjustment/usage change the balance (usage and refund negative); hold/release move money in and out of hold (balance unchanged). external_id: the Paddle transaction id of a top-up, the adjustment id of a refund (source_external_id = the top-up it refunds, requested_cents = what the refund asked back).';

create table if not exists public.api_holds (
  ref            text primary key check (ref ~ '^ah-[0-9a-f-]{36}$'),
  org_id         uuid not null references public.organizations (id) on delete restrict,
  key_id         uuid,
  render_job_id  bigint,
  download_request_id bigint,
  amount_cents   bigint not null check (amount_cents > 0),
  status         text not null default 'open' check (status in ('open', 'captured', 'released')),
  captured_cents bigint,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  settled_at     timestamptz
);
alter table public.api_holds add column if not exists download_request_id bigint;
create unique index if not exists api_holds_download_key on public.api_holds (download_request_id) where download_request_id is not null;
create index if not exists api_holds_open_idx on public.api_holds (org_id, created_at) where status = 'open';

create table if not exists public.api_prices (
  unit       text primary key check (unit ~ '^[a-z][a-z0-9_]{0,62}$'),
  cents      numeric(12,4) not null check (cents >= 0),
  note       text check (note is null or length(note) <= 300),
  updated_at timestamptz not null default now()
);
insert into public.api_prices (unit, cents, note) values
  ('video_minute', 120, 'US cents per minute of requested video length (2x site retail)'),
  ('job_minimum', 60, 'US cents: the smallest charge of one video'),
  ('publish', 0, 'US cents per publish request: cross-posting is free'),
  ('download_cents_per_credit', 1.5, 'HD download via API = site download credits x this many cents')
on conflict (unit) do nothing;

create table if not exists public.api_keys (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 60),
  prefix              text not null check (prefix ~ '^[0-9A-Za-z]{8}$'),
  key_hash            text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  monthly_limit_cents bigint check (monthly_limit_cents is null or monthly_limit_cents >= 0),
  created_by          uuid not null,
  created_at          timestamptz not null default now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid
);
create unique index if not exists api_keys_hash_key on public.api_keys (key_hash);
create index if not exists api_keys_org_idx on public.api_keys (org_id, created_at desc);
comment on table public.api_keys is
  'API keys (migration 0031). Only the SHA-256 of a key is stored, plus the first 8 characters of its random part for display. A key acts as its creator inside its organization; revoked_at set = refused.';

create table if not exists public.api_rate_counters (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  minute timestamptz not null,
  count  integer not null default 0,
  primary key (key_id, minute)
);

create table if not exists public.api_requests (
  id         bigserial primary key,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  key_id     uuid references public.api_keys (id) on delete set null,
  request_id text check (request_id is null or request_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  endpoint   text not null check (endpoint ~ '^[a-z_.]{1,40}$'),
  status     integer not null,
  cost_cents bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists api_requests_org_idx on public.api_requests (org_id, created_at desc);
comment on table public.api_requests is
  'One row per API call that got past key lookup (migration 0031): endpoint name, HTTP status, what it held. For the Usage tab; kept about 90 days.';

create table if not exists public.api_idempotency (
  key_id      uuid not null references public.api_keys (id) on delete cascade,
  idem_key    text not null check (idem_key ~ '^[A-Za-z0-9_:.-]{1,255}$'),
  endpoint    text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  response    jsonb,
  created_at  timestamptz not null default now(),
  primary key (key_id, idem_key)
);

-- The API hold that pays for a queued job. Unique: one hold never pays twice.
alter table public.render_jobs add column if not exists api_hold_ref text;
alter table public.render_jobs drop constraint if exists render_jobs_api_hold_ref_check;
alter table public.render_jobs add constraint render_jobs_api_hold_ref_check
  check (api_hold_ref is null or api_hold_ref ~ '^ah-[0-9a-f-]{36}$');
create unique index if not exists render_jobs_api_hold_ref_key
  on public.render_jobs (api_hold_ref) where api_hold_ref is not null;
comment on column public.render_jobs.api_hold_ref is
  'The API balance hold (api_holds, migration 0031) that pays for this job. The worker only runs it when api_hold_start() confirms the hold is open and bound to this job id.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Append-only ledger
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_ledger_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'api_ledger is append-only: record a new row instead' using errcode = '42501';
end
$$;
drop trigger if exists api_ledger_append_only on public.api_ledger;
create trigger api_ledger_append_only before update or delete on public.api_ledger
  for each row execute function public.api_ledger_append_only();
drop trigger if exists api_ledger_no_truncate on public.api_ledger;
create trigger api_ledger_no_truncate before truncate on public.api_ledger
  for each statement execute function public.api_ledger_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- May this organization activate the API? lib/api/pricing.ts apiEligible()
-- mirrors it: the exempt operator org, or any purchase row in the credit
-- ledger (derivePlan: a purchase = a paid plan, whichever pack).
create or replace function public.api_org_eligible(p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_org is not null and (
    public.credits_exempt(p_org)
    or exists (select 1 from public.credit_transactions t where t.org_id = p_org and t.kind = 'purchase'))
$$;

-- Tier from cumulative paid top-ups (cents). lib/api/pricing.ts API_TIERS.
create or replace function public.api_tier_for(p_paid_cents bigint, p_exempt boolean) returns integer
  language sql immutable set search_path = public, pg_temp as $$
  select case when p_exempt then 4
              when p_paid_cents >= 100000 then 4
              when p_paid_cents >= 25000 then 3
              when p_paid_cents >= 5000 then 2
              when p_paid_cents >= 500 then 1
              else 0 end
$$;

create or replace function public.api_tier_limits(
  p_tier integer, out rpm integer, out concurrency integer, out monthly_cap_cents bigint
) language sql immutable set search_path = public, pg_temp as $$
  select (array[10, 30, 60, 120, 300])[p_tier + 1],
         (array[1, 2, 3, 5, 10])[p_tier + 1],
         (array[0, 10000, 50000, 200000, 1000000]::bigint[])[p_tier + 1]
$$;

create or replace function public.api_err(p_status integer, p_code text, p_message text, p_extra jsonb default '{}'::jsonb)
  returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', false, 'status', p_status,
           'error', jsonb_build_object('code', p_code, 'message', p_message) || coalesce(p_extra, '{}'::jsonb))
$$;

create or replace function public.api_ok(p_data jsonb, p_status integer default 200)
  returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'status', p_status, 'data', coalesce(p_data, 'null'::jsonb))
$$;

-- Act as the key's creator for the rest of this transaction (see header).
create or replace function public.api_act_as(p_user uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_email  text;
  v_claims jsonb;
begin
  select u.email into v_email from auth.users u where u.id = p_user;
  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
              || jsonb_build_object('sub', p_user::text, 'email', coalesce(v_email, ''));
  perform set_config('request.jwt.claims', v_claims::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.email', coalesce(v_email, ''), true);
end
$$;

-- The account row, created on first use and locked for the transaction —
-- 0020's credit_account_lock, for the API balance.
create or replace function public.api_account_lock(p_org uuid) returns public.api_accounts
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acc public.api_accounts;
begin
  if p_org is null or not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'unknown organization' using errcode = '22023';
  end if;
  insert into public.api_accounts (org_id) values (p_org) on conflict (org_id) do nothing;
  select * into acc from public.api_accounts where org_id = p_org for update;
  return acc;
end
$$;

-- One ledger row reflecting the account as it now stands.
create or replace function public.api_log(
  p_org uuid, p_kind text, p_amount bigint, p_hold text, p_key uuid,
  p_external text, p_source text, p_requested bigint, p_note text
) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acc public.api_accounts;
  out_id bigint;
begin
  select * into acc from public.api_accounts where org_id = p_org;
  insert into public.api_ledger (org_id, kind, amount_cents, balance_after, reserved_after, requested_cents,
                                 hold_ref, key_id, external_id, source_external_id, note, created_by)
  values (p_org, p_kind, p_amount, acc.balance_cents, acc.reserved_cents, p_requested, p_hold, p_key,
          p_external, p_source, left(nullif(btrim(coalesce(p_note, '')), ''), 500), auth.uid())
  returning id into out_id;
  return out_id;
end
$$;

-- Settle one open hold (the account is already locked by the caller).
create or replace function public.api_settle_locked(p_ref text, p_capture boolean, p_note text) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  h public.api_holds;
begin
  select * into h from public.api_holds where ref = p_ref for update;
  if h.ref is null or h.status <> 'open' then
    return 0;
  end if;
  if p_capture then
    update public.api_accounts
       set balance_cents = balance_cents - h.amount_cents, reserved_cents = reserved_cents - h.amount_cents,
           updated_at = now()
     where org_id = h.org_id;
    update public.api_holds set status = 'captured', captured_cents = h.amount_cents, settled_at = now()
     where ref = p_ref;
    perform public.api_log(h.org_id, 'usage', -h.amount_cents, p_ref, h.key_id, null, null, null, p_note);
  else
    update public.api_accounts
       set reserved_cents = reserved_cents - h.amount_cents, updated_at = now()
     where org_id = h.org_id;
    update public.api_holds set status = 'released', settled_at = now() where ref = p_ref;
    perform public.api_log(h.org_id, 'release', h.amount_cents, p_ref, h.key_id, null, null, null, p_note);
  end if;
  return h.amount_cents;
end
$$;

-- Holds that can no longer settle go back to the balance: never started in
-- 24 hours, started over 24 hours ago without settling, or bound to a job
-- that already failed / was cancelled. The caller holds the account lock.
create or replace function public.api_expire_holds_locked(p_org uuid) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select h.ref, h.started_at, h.created_at,
           exists (select 1 from public.render_jobs j where j.api_hold_ref = h.ref
                    and j.status in ('failed', 'cancelled'))
           or exists (select 1 from public.download_requests d where d.id = h.download_request_id
                    and d.status in ('failed', 'expired')) as job_dead
      from public.api_holds h
     where h.org_id = p_org and h.status = 'open'
  loop
    if r.job_dead
       or (r.started_at is null and r.created_at < now() - interval '24 hours')
       or (r.started_at is not null and r.started_at < now() - interval '24 hours') then
      perform public.api_settle_locked(r.ref, false, 'expired: the job never settled');
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- Money this calendar month (UTC): captured usage plus holds still open.
create or replace function public.api_month_spend(p_org uuid, p_key uuid default null) returns bigint
  language sql stable security definer set search_path = public, pg_temp as $$
  select (coalesce((select sum(-l.amount_cents) from public.api_ledger l
                     where l.org_id = p_org and l.kind = 'usage'
                       and l.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
                       and (p_key is null or l.key_id = p_key)), 0)
        + coalesce((select sum(h.amount_cents) from public.api_holds h
                     where h.org_id = p_org and h.status = 'open'
                       and (p_key is null or h.key_id = p_key)), 0))::bigint
$$;

-- One request-log row, and the rate numbers every response carries.
create or replace function public.api_finish(p_ctx jsonb, p_result jsonb, p_cost bigint default 0) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  insert into public.api_requests (org_id, key_id, request_id, endpoint, status, cost_cents)
  values ((p_ctx ->> 'org_id')::uuid, (p_ctx ->> 'key_id')::uuid,
          case when coalesce(p_ctx ->> 'request_id', '') ~ '^[A-Za-z0-9_-]{1,64}$' then p_ctx ->> 'request_id' end,
          p_ctx ->> 'endpoint', coalesce((p_result ->> 'status')::int, 500), coalesce(p_cost, 0));
  if random() < 0.01 then
    delete from public.api_requests where org_id = (p_ctx ->> 'org_id')::uuid
       and created_at < now() - interval '90 days';
  end if;
  return p_result || jsonb_build_object('rate', jsonb_build_object(
    'limit', p_ctx -> 'rpm', 'remaining', p_ctx -> 'remaining', 'reset', p_ctx -> 'reset'));
end
$$;

-- Every entry point starts here. Find the key by its hash (one unique-index
-- probe on a SHA-256: its timing says nothing about the key), refuse a
-- revoked or unknown one or an organization that has not activated the API,
-- count the request against the key's per-minute limit, act as the creator
-- and check they are still an owner/admin of the key's organization.
create or replace function public.api_begin(p_key_hash text, p_endpoint text, p_request_id text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.api_keys;
  s        public.api_settings;
  acc      public.api_accounts;
  v_exempt boolean;
  v_tier   integer;
  lim      record;
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
  v_reset  integer;
  ctx      jsonb;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into k from public.api_keys where key_hash = p_key_hash;
  if k.id is null or k.revoked_at is not null then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into s from public.api_settings where org_id = k.org_id;
  if s.activated_at is null then
    return public.api_err(403, 'api_not_activated',
      'The API is not activated for this organization. An owner or admin can activate it in the Developer console.');
  end if;

  v_exempt := public.credits_exempt(k.org_id);
  select * into acc from public.api_accounts where org_id = k.org_id;
  v_tier := public.api_tier_for(coalesce(acc.paid_total_cents, 0), v_exempt);
  select * into lim from public.api_tier_limits(v_tier);

  v_reset := greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  insert into public.api_rate_counters as c (key_id, minute, count)
  values (k.id, v_minute, 1)
  on conflict (key_id, minute) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.api_rate_counters c where c.key_id = k.id and c.minute < v_minute;
  end if;

  ctx := jsonb_build_object('ok', true, 'key_id', k.id, 'prefix', k.prefix, 'org_id', k.org_id,
    'created_by', k.created_by, 'tier', v_tier, 'exempt', v_exempt,
    'rpm', lim.rpm, 'concurrency', lim.concurrency,
    'cap_cents', case when v_exempt then null
                      else least(lim.monthly_cap_cents, coalesce(s.monthly_limit_cents, lim.monthly_cap_cents)) end,
    'key_limit_cents', k.monthly_limit_cents,
    'remaining', greatest(0, lim.rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > lim.rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This key is limited to %s requests per minute on usage tier %s.', lim.rpm, v_tier),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  perform public.api_act_as(k.created_by);
  if not public.is_org_member(k.org_id, 'admin') then
    return public.api_finish(ctx, public.api_err(403, 'key_owner_not_admin',
      'The person who created this key is no longer an owner or admin of its organization. An admin must create a new key.'));
  end if;

  update public.api_keys set last_used_at = now()
   where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return ctx;
end
$$;

-- Idempotency-Key for POSTs: a replay of a stored success, a conflict for a
-- different body, or null (go ahead; the placeholder row is held until this
-- transaction ends, so a concurrent retry waits for it and then replays).
create or replace function public.api_idem_begin(p_ctx jsonb, p_idem_key text, p_fingerprint text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  row   public.api_idempotency;
  v_key uuid := (p_ctx ->> 'key_id')::uuid;
begin
  if p_idem_key is null then
    return null;
  end if;
  if p_idem_key !~ '^[A-Za-z0-9_:.-]{1,255}$' or coalesce(p_fingerprint, '') !~ '^[0-9a-f]{64}$' then
    return public.api_err(400, 'invalid_idempotency_key', 'Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -');
  end if;
  delete from public.api_idempotency where key_id = v_key and created_at < now() - interval '24 hours';
  insert into public.api_idempotency (key_id, idem_key, endpoint, fingerprint)
  values (v_key, p_idem_key, p_ctx ->> 'endpoint', p_fingerprint)
  on conflict (key_id, idem_key) do nothing;
  if found then
    return null;
  end if;
  select * into row from public.api_idempotency where key_id = v_key and idem_key = p_idem_key;
  if row.endpoint <> p_ctx ->> 'endpoint' or row.fingerprint <> p_fingerprint then
    return public.api_err(422, 'idempotency_key_reused',
      'This Idempotency-Key was already used with a different request in the last 24 hours.');
  end if;
  if row.response is null then
    return public.api_err(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still in progress.');
  end if;
  return row.response || jsonb_build_object('replayed', true);
end
$$;

-- Keep a success for replay; forget a refusal so the caller can retry it.
create or replace function public.api_idem_end(p_ctx jsonb, p_idem_key text, p_result jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_idem_key is not null then
    if coalesce((p_result ->> 'ok')::boolean, false) then
      update public.api_idempotency set response = p_result
       where key_id = (p_ctx ->> 'key_id')::uuid and idem_key = p_idem_key;
    else
      delete from public.api_idempotency
       where key_id = (p_ctx ->> 'key_id')::uuid and idem_key = p_idem_key and response is null;
    end if;
  end if;
  return p_result;
end
$$;

-- One audit row, as the key's creator (0008). Key id and display prefix only.
create or replace function public.api_audit(p_ctx jsonb, p_action text, p_target text, p_channel text, p_detail jsonb)
  returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
  values ((p_ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), p_action, p_target,
          coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('via', 'api', 'api_key_id', p_ctx ->> 'key_id',
                                                               'api_key_prefix', p_ctx ->> 'prefix'),
          p_channel);
end
$$;

create or replace function public.api_video_json(v public.videos) returns jsonb
  language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', v.video_id, 'channel_id', v.channel_id, 'title', v.title, 'topic', v.topic, 'slug', v.slug,
    'format', v.video_format, 'parent_video_id', v.parent_video_id, 'published_at', v.published_at,
    'privacy', v.privacy,
    'publish_state', coalesce(v.publish_state, case when v.published_at is not null then 'uploaded' end),
    'review_state', v.review_state,
    'youtube_url', case when v.published_at is not null and coalesce(v.publish_state, 'uploaded') = 'uploaded'
                        then 'https://www.youtube.com/watch?v=' || v.video_id end)
$$;

-- What one video of `p_seconds` costs, in cents; null when unpriced (an unset
-- price is never free). lib/api/pricing.ts videoPriceCents() mirrors it.
create or replace function public.api_video_price(p_seconds numeric) returns bigint
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when pm.cents is null or p_seconds is null or p_seconds <= 0 then null
              else greatest(ceil(p_seconds * pm.cents / 60), ceil(coalesce(mn.cents, 0)))::bigint end
    from (select (select cents from public.api_prices where unit = 'video_minute') as cents) pm,
         (select (select cents from public.api_prices where unit = 'job_minimum') as cents) mn
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Money in and out (service role: the Paddle webhook, the worker; admins)
-- ───────────────────────────────────────────────────────────────────────────

-- A paid top-up. Idempotent on the Paddle transaction id; the same id for a
-- different organization or amount is a conflict, never a second credit.
create or replace function public.api_add_topup(p_org uuid, p_cents bigint, p_external_id text, p_note text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ext   text := btrim(coalesce(p_external_id, ''));
  prior public.api_ledger;
  acc   public.api_accounts;
  txn   bigint;
begin
  if not public.credits_trusted_caller() then
    raise exception 'top-ups are recorded by the platform only' using errcode = '42501';
  end if;
  if ext = '' or length(ext) > 200 then
    raise exception 'external_id is required' using errcode = '22023';
  end if;
  if p_cents is null or p_cents < 500 or p_cents > 500000 then
    raise exception 'a top-up is between 500 and 500000 cents' using errcode = '22023';
  end if;
  acc := public.api_account_lock(p_org);
  select * into prior from public.api_ledger where external_id = ext;
  if prior.id is not null then
    if prior.org_id <> p_org or prior.kind <> 'topup' or prior.amount_cents <> p_cents then
      raise exception 'external_id already recorded for a different top-up' using errcode = '23505';
    end if;
    return jsonb_build_object('ledger_id', prior.id, 'duplicate', true, 'balance_cents', acc.balance_cents);
  end if;
  update public.api_accounts
     set balance_cents = balance_cents + p_cents, paid_total_cents = paid_total_cents + p_cents, updated_at = now()
   where org_id = p_org returning * into acc;
  txn := public.api_log(p_org, 'topup', p_cents, null, null, ext, null, null, p_note);
  return jsonb_build_object('ledger_id', txn, 'duplicate', false, 'balance_cents', acc.balance_cents);
end
$$;

-- A refund or chargeback of a top-up (0021's rules, in cents): takes back at
-- most what is available, writes the shortfall into the note, is recorded
-- once per refund id, and never adds up to more than the top-up.
create or replace function public.api_refund_topup(
  p_external_id text, p_refund_id text, p_cents bigint default null, p_note text default null,
  p_reason text default 'refund'
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ext     text := btrim(coalesce(p_external_id, ''));
  rid     text := btrim(coalesce(p_refund_id, ''));
  why     text := coalesce(nullif(btrim(p_reason), ''), 'refund');
  topup   public.api_ledger;
  prior   public.api_ledger;
  acc     public.api_accounts;
  already bigint;
  asked   bigint;
  taken   bigint;
  short   bigint;
  msg     text;
  txn     bigint;
begin
  if not public.credits_trusted_caller() then
    raise exception 'refunds are recorded by the platform only' using errcode = '42501';
  end if;
  if ext = '' or rid = '' or length(rid) > 200 or why not in ('refund', 'chargeback') then
    raise exception 'external_id, refund_id and a reason are required' using errcode = '22023';
  end if;
  if p_cents is not null and p_cents <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;
  select * into topup from public.api_ledger where external_id = ext and kind = 'topup';
  if topup.id is null then
    raise exception 'no top-up recorded for this external_id' using errcode = 'P0002';
  end if;
  acc := public.api_account_lock(topup.org_id);
  select * into prior from public.api_ledger where external_id = rid;
  if prior.id is not null then
    if prior.source_external_id is distinct from ext then
      raise exception 'refund_id already recorded for a different top-up' using errcode = '23505';
    end if;
    return jsonb_build_object('duplicate', true, 'requested_cents', prior.requested_cents,
                              'taken_cents', -prior.amount_cents,
                              'shortfall_cents', prior.requested_cents + prior.amount_cents);
  end if;
  select coalesce(sum(l.requested_cents), 0) into already
    from public.api_ledger l where l.kind = 'refund' and l.source_external_id = ext;
  asked := least(coalesce(p_cents, topup.amount_cents), greatest(topup.amount_cents - already, 0));
  taken := least(asked, greatest(acc.balance_cents - acc.reserved_cents, 0));
  short := asked - taken;
  update public.api_accounts
     set balance_cents = balance_cents - taken,
         paid_total_cents = greatest(paid_total_cents - asked, 0), updated_at = now()
   where org_id = topup.org_id returning * into acc;
  msg := format('%s of top-up %s: %s cents', why, ext, asked);
  if short > 0 then
    msg := msg || format(' — %s taken back, %s already spent and NOT recovered', taken, short);
  end if;
  if coalesce(btrim(p_note), '') <> '' then
    msg := msg || ' · ' || btrim(p_note);
  end if;
  -- Written even when nothing could be taken: the history must show it.
  txn := public.api_log(topup.org_id, 'refund', -taken, null, null, rid, ext, asked, msg);
  return jsonb_build_object('duplicate', false, 'requested_cents', asked, 'taken_cents', taken,
                            'shortfall_cents', short, 'ledger_id', txn);
end
$$;

-- A manual correction by a platform owner/admin (or the SQL editor).
create or replace function public.api_adjust_balance(p_org uuid, p_cents bigint, p_note text) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  acc public.api_accounts;
begin
  if not (public.is_platform_admin() or public.credits_trusted_caller()) then
    raise exception 'only a platform owner or admin may adjust an API balance' using errcode = '42501';
  end if;
  if p_cents is null or p_cents = 0 or coalesce(btrim(p_note), '') = '' then
    raise exception 'a non-zero amount and a note are required' using errcode = '22023';
  end if;
  acc := public.api_account_lock(p_org);
  if acc.balance_cents - acc.reserved_cents + p_cents < 0 then
    raise exception 'an adjustment cannot take more than is available' using errcode = '22023';
  end if;
  update public.api_accounts set balance_cents = balance_cents + p_cents, updated_at = now()
   where org_id = p_org returning * into acc;
  perform public.api_log(p_org, 'adjustment', p_cents, null, null, null, null, null, p_note);
  return acc.balance_cents;
end
$$;

-- The worker, before it spends anything on a job that names an API hold:
-- the hold's amount when it is open and bound to exactly this job, else null
-- (the worker then refuses the job — a browser can insert render_jobs rows,
-- so the column alone proves nothing).
create or replace function public.api_hold_start(p_ref text, p_job_id bigint) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  h public.api_holds;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may start an API hold' using errcode = '42501';
  end if;
  select * into h from public.api_holds where ref = p_ref;
  if h.ref is null or h.render_job_id is distinct from p_job_id then
    return null;
  end if;
  perform public.api_account_lock(h.org_id);
  select * into h from public.api_holds where ref = p_ref for update;
  if h.status <> 'open' then
    return null;
  end if;
  if h.started_at is null then
    update public.api_holds set started_at = now() where ref = p_ref;
  end if;
  return h.amount_cents;
end
$$;

-- When a job with an API hold ends: capture on success, release otherwise.
-- A job re-queued after a lost worker keeps its hold for the next attempt.
create or replace function public.api_settle_job() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  h public.api_holds;
begin
  if new.api_hold_ref is null or new.status is not distinct from old.status
     or new.status not in ('succeeded', 'failed', 'cancelled') then
    return new;
  end if;
  select * into h from public.api_holds where ref = new.api_hold_ref;
  if h.ref is null or h.render_job_id is distinct from new.id then
    return new;
  end if;
  perform public.api_account_lock(h.org_id);
  perform public.api_settle_locked(h.ref, new.status = 'succeeded',
    case when new.status = 'succeeded' then format('video job %s', new.id)
         else format('video job %s %s: released in full', new.id, new.status) end);
  return new;
end
$$;
drop trigger if exists render_jobs_api_settle on public.render_jobs;
create trigger render_jobs_api_settle after update of status on public.render_jobs
  for each row execute function public.api_settle_job();

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The Developer console (signed-in owner/admin)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_activate(p_org uuid, p_terms_version text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.api_settings;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of this organization may activate the API' using errcode = '42501';
  end if;
  if not public.api_org_eligible(p_org) then
    raise exception 'buy any credit pack first; the API can be activated after the first purchase'
      using errcode = 'NS403';
  end if;
  if coalesce(p_terms_version, '') !~ '^[a-z0-9.-]{1,40}$' then
    raise exception 'accept the API terms' using errcode = '22023';
  end if;
  insert into public.api_settings (org_id, activated_at, activated_by, terms_version, updated_by)
  values (p_org, now(), auth.uid(), p_terms_version, auth.uid())
  on conflict (org_id) do update
     set activated_at = coalesce(public.api_settings.activated_at, now()),
         activated_by = coalesce(public.api_settings.activated_by, auth.uid()),
         terms_version = excluded.terms_version, updated_at = now(), updated_by = auth.uid()
  returning * into s;
  perform public.api_account_lock(p_org);
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api.activate', p_org::text,
          jsonb_build_object('terms_version', p_terms_version));
  return jsonb_build_object('activated_at', s.activated_at, 'terms_version', s.terms_version);
end
$$;

create or replace function public.api_set_monthly_limit(p_org uuid, p_cents bigint) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin may change the monthly limit' using errcode = '42501';
  end if;
  if p_cents is not null and (p_cents < 0 or p_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  update public.api_settings set monthly_limit_cents = p_cents, updated_at = now(), updated_by = auth.uid()
   where org_id = p_org and activated_at is not null;
  if not found then
    raise exception 'activate the API first' using errcode = 'NS403';
  end if;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api.monthly_limit', p_org::text,
          jsonb_build_object('monthly_limit_cents', p_cents));
  return true;
end
$$;

create or replace function public.create_api_key(
  p_org uuid, p_name text, p_key_hash text, p_prefix text, p_monthly_limit_cents bigint default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_name   text := btrim(coalesce(p_name, ''));
  v_active integer;
  k        public.api_keys;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of this organization may create API keys' using errcode = '42501';
  end if;
  if not exists (select 1 from public.api_settings where org_id = p_org and activated_at is not null) then
    raise exception 'activate the API first' using errcode = 'NS403';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'name the key (1 to 60 characters)' using errcode = '22023';
  end if;
  if coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_prefix, '') !~ '^[0-9A-Za-z]{8}$' then
    raise exception 'malformed key hash or prefix' using errcode = '22023';
  end if;
  if p_monthly_limit_cents is not null and (p_monthly_limit_cents < 0 or p_monthly_limit_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  -- Two tabs creating the eleventh key at once: one waits for the other.
  perform pg_advisory_xact_lock(hashtextextended('api_keys:' || p_org::text, 0));
  select count(*) into v_active from public.api_keys where org_id = p_org and revoked_at is null;
  if v_active >= 10 then
    raise exception 'this organization already has 10 active API keys; revoke one first' using errcode = 'NS409';
  end if;
  insert into public.api_keys (org_id, name, prefix, key_hash, monthly_limit_cents, created_by)
  values (p_org, v_name, p_prefix, p_key_hash, p_monthly_limit_cents, auth.uid())
  returning * into k;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.create', k.id::text,
          jsonb_build_object('org_id', p_org, 'name', v_name, 'prefix', p_prefix));
  return jsonb_build_object('id', k.id, 'name', k.name, 'prefix', k.prefix, 'created_at', k.created_at);
end
$$;

create or replace function public.revoke_api_key(p_key_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k public.api_keys;
begin
  select * into k from public.api_keys where id = p_key_id;
  if k.id is null or auth.uid() is null or not public.is_org_member(k.org_id, 'admin') then
    raise exception 'only an owner or admin of the key''s organization may revoke it' using errcode = '42501';
  end if;
  update public.api_keys set revoked_at = now(), revoked_by = auth.uid()
   where id = p_key_id and revoked_at is null;
  if not found then
    return false;
  end if;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.revoke', k.id::text,
          jsonb_build_object('org_id', k.org_id, 'name', k.name, 'prefix', k.prefix));
  return true;
end
$$;

create or replace function public.set_api_key_limit(p_key_id uuid, p_cents bigint) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k public.api_keys;
begin
  select * into k from public.api_keys where id = p_key_id;
  if k.id is null or auth.uid() is null or not public.is_org_member(k.org_id, 'admin') then
    raise exception 'only an owner or admin of the key''s organization may change it' using errcode = '42501';
  end if;
  if p_cents is not null and (p_cents < 0 or p_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  update public.api_keys set monthly_limit_cents = p_cents where id = p_key_id;
  return true;
end
$$;

-- Everything the console's Overview and Limits tabs show, in one read.
create or replace function public.api_console(p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s        public.api_settings;
  acc      public.api_accounts;
  v_exempt boolean := public.credits_exempt(p_org);
  v_tier   integer;
  lim      record;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin may open the Developer console' using errcode = '42501';
  end if;
  select * into s from public.api_settings where org_id = p_org;
  select * into acc from public.api_accounts where org_id = p_org;
  v_tier := public.api_tier_for(coalesce(acc.paid_total_cents, 0), v_exempt);
  select * into lim from public.api_tier_limits(v_tier);
  return jsonb_build_object(
    'eligible', public.api_org_eligible(p_org),
    'activated_at', s.activated_at,
    'terms_version', s.terms_version,
    'exempt', v_exempt,
    'balance_cents', coalesce(acc.balance_cents, 0),
    'reserved_cents', coalesce(acc.reserved_cents, 0),
    'paid_total_cents', coalesce(acc.paid_total_cents, 0),
    'tier', v_tier,
    'rpm', lim.rpm, 'concurrency', lim.concurrency,
    'tier_cap_cents', case when v_exempt then null else lim.monthly_cap_cents end,
    'monthly_limit_cents', s.monthly_limit_cents,
    'month_spend_cents', public.api_month_spend(p_org),
    'active_keys', (select count(*) from public.api_keys k where k.org_id = p_org and k.revoked_at is null));
end
$$;

-- The Usage tab: requests and spend per day, and requests per endpoint.
create or replace function public.api_usage(p_org uuid, p_days integer default 30) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 90);
  since  timestamptz := (date_trunc('day', now() at time zone 'utc') - make_interval(days => v_days - 1)) at time zone 'utc';
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin may read API usage' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'requests', coalesce(r.n, 0), 'errors', coalesce(r.e, 0),
                                          'spend_cents', coalesce(u.c, 0)) order by d.day)
        from (select to_char(g, 'YYYY-MM-DD') as day
                from generate_series(since at time zone 'utc', now() at time zone 'utc', interval '1 day') g) d
        left join (select to_char(created_at at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as n,
                          count(*) filter (where status >= 400) as e
                     from public.api_requests where org_id = p_org and created_at >= since group by 1) r on r.day = d.day
        left join (select to_char(created_at at time zone 'utc', 'YYYY-MM-DD') as day, sum(-amount_cents) as c
                     from public.api_ledger where org_id = p_org and kind = 'usage' and created_at >= since
                    group by 1) u on u.day = d.day), '[]'::jsonb),
    'endpoints', coalesce((
      select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'requests', n, 'errors', e) order by n desc)
        from (select endpoint, count(*) as n, count(*) filter (where status >= 400) as e
                from public.api_requests where org_id = p_org and created_at >= since group by endpoint) x),
      '[]'::jsonb));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The API's entry points (anon; key hash first, request id last)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_auth(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'me', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object(
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name)
                       from public.organizations o where o.id = (ctx ->> 'org_id')::uuid),
    'key', jsonb_build_object('id', ctx ->> 'key_id', 'prefix', ctx ->> 'prefix'),
    'tier', (ctx ->> 'tier')::int,
    'limits', jsonb_build_object('requests_per_minute', (ctx ->> 'rpm')::int,
                                 'concurrent_videos', (ctx ->> 'concurrency')::int,
                                 'monthly_limit_cents', (ctx ->> 'cap_cents')::bigint,
                                 'key_monthly_limit_cents', (ctx ->> 'key_limit_cents')::bigint))));
end
$$;

create or replace function public.api_balance(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'balance', p_request_id);
  acc public.api_accounts;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  select * into acc from public.api_accounts where org_id = (ctx ->> 'org_id')::uuid;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object(
    'currency', 'usd',
    'exempt', (ctx ->> 'exempt')::boolean,
    'balance_cents', coalesce(acc.balance_cents, 0),
    'reserved_cents', coalesce(acc.reserved_cents, 0),
    'available_cents', coalesce(acc.balance_cents, 0) - coalesce(acc.reserved_cents, 0),
    'month_spend_cents', public.api_month_spend((ctx ->> 'org_id')::uuid),
    'monthly_limit_cents', (ctx ->> 'cap_cents')::bigint,
    'tier', (ctx ->> 'tier')::int)));
end
$$;

-- Create a video: the site's "Run now" in queue mode, paid from the API
-- balance. p_params: the whitelist the render_jobs insert policy (0019) gives
-- a browser — topic, niche, duration, language, visual_style, video_provider,
-- image_provider — checked by the same render_job_params_valid().
create or replace function public.api_create_video(
  p_key_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'videos.create', p_request_id);
  v_org   uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_busy  integer;
  v_secs  numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
  if v_res is not null then
    return public.api_finish(ctx, v_res);
  end if;
  v_org := (ctx ->> 'org_id')::uuid;

  select * into ch from public.channels c where c.channel_id = p_channel_id;
  if ch.channel_id is null or ch.org_id is distinct from v_org then
    v_res := public.api_err(404, 'channel_not_found', 'No channel with that id in this key''s organization.');
  elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
    v_res := public.api_err(409, 'channel_not_active',
      'That channel is not active. Connect it to YouTube and activate it in the Command Center first.');
  elsif jsonb_typeof(v_p) <> 'object'
     or (v_p - array['topic','niche','duration','language','visual_style',
                     'video_provider','image_provider']) <> '{}'::jsonb
     or not public.render_job_params_valid(v_p, 'daily') then
    v_res := public.api_err(400, 'invalid_params',
      'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.');
  end if;
  if v_res is not null then
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
  end if;

  -- Concurrency, under a per-organization lock so two creates cannot both
  -- take the last slot.
  perform pg_advisory_xact_lock(hashtextextended('api_render_jobs:' || v_org::text, 0));
  select count(*) into v_busy
    from public.render_jobs j join public.channels c on c.channel_id = j.channel_id
   where c.org_id = v_org and j.status in ('queued', 'running');
  if v_busy >= (ctx ->> 'concurrency')::int then
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(429, 'concurrency_limit_exceeded',
      format('Usage tier %s runs at most %s videos at once. Wait for one to finish.', ctx ->> 'tier', ctx ->> 'concurrency'),
      jsonb_build_object('retry_after', 60))));
  end if;

  if not (ctx ->> 'exempt')::boolean then
    v_secs := coalesce((v_p ->> 'duration')::numeric,
                       case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                            then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
    if v_secs is null or v_secs <= 0 then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(400, 'duration_required',
        'Pass duration (seconds): this channel has no target length to price the video by.')));
    end if;
    v_price := public.api_video_price(v_secs);
    if v_price is null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
        'The API price list is not set up on this deployment; nothing was charged.')));
    end if;

    acc := public.api_account_lock(v_org);
    perform public.api_expire_holds_locked(v_org);
    select * into acc from public.api_accounts where org_id = v_org;
    v_spend := public.api_month_spend(v_org);
    if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'monthly_limit_reached',
        'This video would take the organization past its monthly API spend limit.',
        jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend,
                           'price_cents', v_price))));
    end if;
    if ctx ->> 'key_limit_cents' is not null
       and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'key_limit_reached',
        'This video would take this key past its own monthly spend limit.',
        jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price))));
    end if;
    if acc.balance_cents - acc.reserved_cents < v_price then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'insufficient_balance',
        'Your API balance does not cover this video. Top up in the Developer console.',
        jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents))));
    end if;

    v_ref := 'ah-' || gen_random_uuid()::text;
    insert into public.api_holds (ref, org_id, key_id, amount_cents)
    values (v_ref, v_org, (ctx ->> 'key_id')::uuid, v_price);
    update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
     where org_id = v_org;
    perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                           format('%s seconds on %s', v_secs, ch.channel_id));
  end if;

  -- 0019's insert policy, stated as the row itself: a daily job, queued, no
  -- privacy/resume/repair, filed as the key's creator.
  insert into public.render_jobs (channel_id, kind, params, requested_by, api_hold_ref)
  values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
  returning id into v_job;
  if v_ref is not null then
    update public.api_holds set render_job_id = v_job where ref = v_ref;
  end if;

  perform public.api_audit(ctx, 'agent.run', ch.channel_id, ch.channel_id,
    v_p || jsonb_build_object('backend', 'queue', 'job_id', v_job, 'api_hold_ref', v_ref, 'price_cents', v_price));

  v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                            'price_cents', v_price), 201);
  return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
end
$$;

create or replace function public.api_get_job(p_key_hash text, p_job_id bigint, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'jobs.get', p_request_id);
  j   public.render_jobs;
  h   public.api_holds;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  select jj.* into j from public.render_jobs jj join public.channels c on c.channel_id = jj.channel_id
   where jj.id = p_job_id and c.org_id = (ctx ->> 'org_id')::uuid;
  if j.id is null then
    return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No job with that id in this key''s organization.'));
  end if;
  select * into h from public.api_holds where ref = j.api_hold_ref;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object(
    'id', j.id, 'channel_id', j.channel_id, 'status', j.status, 'params', j.params,
    'attempts', j.attempts, 'created_at', j.created_at, 'started_at', j.started_at,
    'finished_at', j.finished_at, 'error', j.error,
    'charge', case when h.ref is null then null
                   else jsonb_build_object('status', h.status, 'held_cents', h.amount_cents,
                                           'captured_cents', h.captured_cents) end)));
end
$$;

create or replace function public.api_list_videos(
  p_key_hash text, p_channel_id text default null, p_limit integer default 20, p_offset integer default 0,
  p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'videos.list', p_request_id);
  lim integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  off integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object(
    'videos', coalesce((select jsonb_agg(public.api_video_json(v) order by v.published_at desc nulls last, v.video_id)
                          from (select vv.* from public.videos vv
                                  join public.channels c on c.channel_id = vv.channel_id
                                 where c.org_id = (ctx ->> 'org_id')::uuid
                                   and (p_channel_id is null or vv.channel_id = p_channel_id)
                                 order by vv.published_at desc nulls last, vv.video_id
                                 limit lim offset off) v), '[]'::jsonb),
    'limit', lim, 'offset', off)));
end
$$;

create or replace function public.api_get_video(p_key_hash text, p_video_id text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'videos.get', p_request_id);
  v   public.videos;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  select vv.* into v from public.videos vv join public.channels c on c.channel_id = vv.channel_id
   where vv.video_id = p_video_id and c.org_id = (ctx ->> 'org_id')::uuid;
  if v.video_id is null then
    return public.api_finish(ctx, public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.'));
  end if;
  return public.api_finish(ctx, public.api_ok(public.api_video_json(v) || jsonb_build_object(
    'publish_requests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'platform', r.platform, 'account_id', r.account_id,
        'target_channel_id', r.target_channel_id, 'status', r.status, 'reason', r.reason,
        'result_url', r.result_url, 'created_at', r.created_at, 'finished_at', r.finished_at)
        order by r.created_at desc)
      from (select * from public.publish_requests pr
             where pr.video_id = v.video_id and pr.org_id = (ctx ->> 'org_id')::uuid
             order by pr.created_at desc limit 20) r), '[]'::jsonb))));
end
$$;

-- "Publish to platforms" → Send, for a key: one publish_requests row per
-- target, through 0029's own insert trigger (acting as the key's creator), so
-- the gate, approvals, same-organization and connection rules are the site's.
-- Free (api_prices.publish is informational: 0).
create or replace function public.api_request_publish(
  p_key_hash text, p_video_id text, p_account_ids uuid[], p_channel_ids text[],
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'videos.publish', p_request_id);
  v_ch    text;
  v_org   uuid;
  a       uuid;
  t       text;
  r       public.publish_requests;
  v_rows  jsonb := '[]'::jsonb;
  v_errs  jsonb := '[]'::jsonb;
  v_res   jsonb;
  v_accts uuid[] := coalesce((select array_agg(distinct x) from unnest(p_account_ids) x where x is not null), '{}');
  v_chans text[] := coalesce((select array_agg(distinct x) from unnest(p_channel_ids) x
                               where x ~ '^[A-Za-z0-9._-]{1,128}$'), '{}');
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
  if v_res is not null then
    return public.api_finish(ctx, v_res);
  end if;
  select v.channel_id, c.org_id into v_ch, v_org
    from public.videos v join public.channels c on c.channel_id = v.channel_id
   where v.video_id = p_video_id;
  if v_ch is null or v_org is distinct from (ctx ->> 'org_id')::uuid then
    v_res := public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.');
  elsif cardinality(v_accts) + cardinality(v_chans) = 0 then
    v_res := public.api_err(400, 'targets_required', 'Name at least one account_id or YouTube channel_id.');
  elsif cardinality(v_accts) + cardinality(v_chans) > 10 then
    v_res := public.api_err(400, 'too_many_targets', 'At most 10 targets per request.');
  end if;
  if v_res is not null then
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
  end if;

  foreach a in array v_accts loop
    begin
      insert into public.publish_requests (video_id, account_id) values (p_video_id, a) returning * into r;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', r.id, 'platform', r.platform,
                  'account_id', r.account_id, 'target_channel_id', null, 'status', r.status, 'reason', r.reason));
    exception
      when unique_violation then
        v_errs := v_errs || jsonb_build_array(jsonb_build_object('account_id', a, 'error', 'already_sending'));
      when insufficient_privilege then
        v_errs := v_errs || jsonb_build_array(jsonb_build_object('account_id', a, 'error', 'forbidden'));
    end;
  end loop;
  foreach t in array v_chans loop
    begin
      insert into public.publish_requests (video_id, target_channel_id) values (p_video_id, t) returning * into r;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', r.id, 'platform', r.platform,
                  'account_id', null, 'target_channel_id', r.target_channel_id, 'status', r.status, 'reason', r.reason));
    exception
      when unique_violation then
        v_errs := v_errs || jsonb_build_array(jsonb_build_object('channel_id', t, 'error', 'already_sending'));
      when insufficient_privilege or foreign_key_violation then
        v_errs := v_errs || jsonb_build_array(jsonb_build_object('channel_id', t, 'error', 'forbidden'));
    end;
  end loop;

  perform public.api_audit(ctx, 'video.publish_request', p_video_id, v_ch,
    jsonb_build_object('requests', v_rows) || case when jsonb_array_length(v_errs) > 0
                                                    then jsonb_build_object('errors', v_errs) else '{}'::jsonb end);
  if jsonb_array_length(v_rows) > 0 then
    v_res := public.api_ok(jsonb_build_object('requests', v_rows, 'errors', v_errs));
  else
    v_res := public.api_err(409, 'publish_refused', 'No publish request could be recorded.',
                            jsonb_build_object('errors', v_errs));
  end if;
  return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
end
$$;

create or replace function public.api_list_channels(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'channels.list', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object('channels', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.channel_id, 'name', c.name, 'niche', c.niche,
             'active', upper(btrim(coalesce(c.status, ''))) = 'ACTIVE',
             'youtube_connected', public.publish_channel_connected(c.channel_id),
             'target_duration_seconds', case when jsonb_typeof(c.agent_config -> 'target_duration_seconds') = 'number'
                                             then c.agent_config -> 'target_duration_seconds' end)
             order by c.channel_id)
      from public.channels c where c.org_id = (ctx ->> 'org_id')::uuid), '[]'::jsonb))));
end
$$;

create or replace function public.api_list_connected_accounts(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'accounts.list', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object('accounts',
    coalesce((select jsonb_agg(jsonb_build_object('platform', 'youtube', 'channel_id', c.channel_id,
                'name', coalesce(nullif(c.credential_ref ->> 'youtube_title', ''), c.name),
                'connected', public.publish_channel_connected(c.channel_id)) order by c.channel_id)
                from public.channels c where c.org_id = (ctx ->> 'org_id')::uuid), '[]'::jsonb)
    || coalesce((select jsonb_agg(jsonb_build_object('platform', s.platform, 'account_id', s.id,
                'name', coalesce(s.display_name, s.username, s.platform), 'username', s.username,
                'connected', s.status = 'connected') order by s.platform, s.created_at)
                from public.social_accounts s
               where s.org_id = (ctx ->> 'org_id')::uuid and s.status <> 'revoked'), '[]'::jsonb))));
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6b. HD downloads through the API (0030's flow, paid from the API balance)
-- ───────────────────────────────────────────────────────────────────────────

-- The site's credit price of one download — 0030 request_download's formula,
-- the same expression (tests pin the two together). Null when unpriced.
create or replace function public.download_credits_price(p_seconds numeric, p_quality text) returns numeric
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when rate.credits_per_unit is null then null
              else greatest(ceil(round(p_seconds * rate.credits_per_unit * (1 + rate.margin) / 60.0, 6)),
                            ceil(round(coalesce(fl.credits_per_unit, 0), 6))) end
    from (select (select credits_per_unit from public.credit_prices where unit = format('download_%s_minute', p_quality)) as credits_per_unit,
                 (select margin from public.credit_prices where unit = format('download_%s_minute', p_quality)) as margin) rate,
         (select (select credits_per_unit from public.credit_prices where unit = 'download_minimum') as credits_per_unit) fl
$$;

create or replace function public.api_request_download(
  p_key_hash text, p_video_id text, p_quality text,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'downloads.create', p_request_id);
  v_org   uuid;
  v_ch    text;
  q       text := btrim(coalesce(p_quality, ''));
  m       public.download_masters;
  r       public.download_requests;
  why     text;
  until_  timestamptz;
  credits numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
  if v_res is not null then
    return public.api_finish(ctx, v_res);
  end if;
  v_org := (ctx ->> 'org_id')::uuid;
  select c.channel_id into v_ch from public.videos v join public.channels c on c.channel_id = v.channel_id
   where v.video_id = p_video_id and c.org_id = v_org;
  if q not in ('720p', '1080p') then
    v_res := public.api_err(400, 'invalid_params', 'quality must be 720p or 1080p.');
  elsif v_ch is null then
    v_res := public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.');
  end if;
  if v_res is not null then
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
  end if;

  -- 0030's lock: the site and the API decide one (org, video, quality) at a time.
  perform pg_advisory_xact_lock(hashtextextended(format('download:%s:%s:%s', v_org, p_video_id, q), 0));
  select * into r from public.download_requests d
   where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
     and (d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))
   order by d.id desc limit 1;
  if r.id is not null then
    v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', r.quality,
                                              'price_cents', 0, 'reused', true, 'expires_at', r.expires_at));
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
  end if;

  select * into m from public.download_masters where video_id = p_video_id;
  if m.video_id is null or least(m.width, m.height) < public.download_quality_side(q) then
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(404, 'no_master',
      format('No full-quality master for this video at %s. Only videos rendered on the queue worker keep one.', q))));
  end if;

  if exists (select 1 from public.download_requests d
              where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
                and d.paid_until > now() and d.status <> 'failed') then
    why := 'redownload';
    until_ := (select max(d.paid_until) from public.download_requests d
                where d.org_id = v_org and d.video_id = p_video_id and d.quality = q and d.status <> 'failed');
  elsif (ctx ->> 'exempt')::boolean then
    why := 'exempt';
    until_ := now() + interval '7 days';
  else
    credits := public.download_credits_price(m.duration_seconds, q);
    select ceil(credits * p.cents)::bigint into v_price from public.api_prices p where p.unit = 'download_cents_per_credit';
    if v_price is null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
        format('Downloads in %s are not priced on this deployment; nothing was charged.', q))));
    end if;
    until_ := now() + interval '7 days';
  end if;

  if v_price is not null and v_price > 0 then
    acc := public.api_account_lock(v_org);
    perform public.api_expire_holds_locked(v_org);
    select * into acc from public.api_accounts where org_id = v_org;
    v_spend := public.api_month_spend(v_org);
    if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
      v_res := public.api_err(402, 'monthly_limit_reached',
        'This download would take the organization past its monthly API spend limit.',
        jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend, 'price_cents', v_price));
    elsif ctx ->> 'key_limit_cents' is not null
          and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
      v_res := public.api_err(402, 'key_limit_reached', 'This download would take this key past its own monthly spend limit.',
        jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price));
    elsif acc.balance_cents - acc.reserved_cents < v_price then
      v_res := public.api_err(402, 'insufficient_balance',
        'Your API balance does not cover this download. Top up in the Developer console.',
        jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents));
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;
  end if;

  -- 0030's row, as the site writes it, filed as the key's creator; credits
  -- charged 0 (the API balance pays, below).
  insert into public.download_requests
    (org_id, channel_id, video_id, quality, status, charged, free_reason, paid_until, minutes, requested_by)
  values
    (v_org, v_ch, p_video_id, q, 'queued', 0, why, until_, round(m.duration_seconds / 60.0, 4),
     (ctx ->> 'created_by')::uuid)
  returning * into r;

  if v_price is not null and v_price > 0 then
    v_ref := 'ah-' || gen_random_uuid()::text;
    insert into public.api_holds (ref, org_id, key_id, download_request_id, amount_cents)
    values (v_ref, v_org, (ctx ->> 'key_id')::uuid, r.id, v_price);
    update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
     where org_id = v_org;
    perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                           format('download %s of %s', q, p_video_id));
  end if;
  perform public.api_audit(ctx, 'video.download', p_video_id, v_ch,
    jsonb_build_object('download_id', r.id, 'quality', q, 'price_cents', v_price, 'free_reason', why));

  v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', q,
                                            'price_cents', coalesce(v_price, 0), 'free_reason', why,
                                            'reused', false), 201);
  return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
end
$$;

create or replace function public.api_get_download(p_key_hash text, p_id bigint, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'downloads.get', p_request_id);
  r   public.download_requests;
  h   public.api_holds;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  select * into r from public.download_requests d where d.id = p_id and d.org_id = (ctx ->> 'org_id')::uuid;
  if r.id is null then
    return public.api_finish(ctx, public.api_err(404, 'download_not_found', 'No download with that id in this key''s organization.'));
  end if;
  select * into h from public.api_holds where download_request_id = r.id;
  return public.api_finish(ctx, public.api_ok(jsonb_build_object(
    'id', r.id, 'video_id', r.video_id, 'quality', r.quality,
    'status', case when r.status = 'ready' and r.expires_at <= now() then 'expired' else r.status end,
    'bytes', r.bytes, 'expires_at', r.expires_at, 'reason', r.reason, 'free_reason', r.free_reason,
    'created_at', r.created_at, 'finished_at', r.finished_at,
    'charge', case when h.ref is null then null
                   else jsonb_build_object('status', h.status, 'held_cents', h.amount_cents,
                                           'captured_cents', h.captured_cents) end)));
end
$$;

-- When an API-paid download is ready, capture its hold; when it fails,
-- release it (0030's own refund does nothing for it: it charged 0 credits).
create or replace function public.api_settle_download() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  h public.api_holds;
begin
  if new.status is not distinct from old.status or new.status not in ('ready', 'failed') then
    return new;
  end if;
  select * into h from public.api_holds where download_request_id = new.id and status = 'open';
  if h.ref is null then
    return new;
  end if;
  perform public.api_account_lock(h.org_id);
  perform public.api_settle_locked(h.ref, new.status = 'ready',
    case when new.status = 'ready' then format('download %s %s', new.quality, new.video_id)
         else format('download %s %s failed: released in full', new.quality, new.video_id) end);
  return new;
end
$$;
drop trigger if exists download_requests_api_settle on public.download_requests;
create trigger download_requests_api_settle after update of status on public.download_requests
  for each row execute function public.api_settle_download();

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────
-- Supabase's default privileges hand every new function to anon,
-- authenticated and service_role; each one is narrowed explicitly here.

-- Internal: nobody calls these through the API.
revoke all on function public.api_ledger_append_only() from public, anon, authenticated, service_role;
revoke all on function public.api_org_eligible(uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_tier_for(bigint, boolean) from public, anon, authenticated, service_role;
revoke all on function public.api_tier_limits(integer) from public, anon, authenticated, service_role;
revoke all on function public.api_err(integer, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.api_ok(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.api_act_as(uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_account_lock(uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_log(uuid, text, bigint, text, uuid, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.api_settle_locked(text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.api_expire_holds_locked(uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_month_spend(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_finish(jsonb, jsonb, bigint) from public, anon, authenticated, service_role;
revoke all on function public.api_begin(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_idem_begin(jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_idem_end(jsonb, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.api_audit(jsonb, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.api_video_json(public.videos) from public, anon, authenticated, service_role;
revoke all on function public.api_video_price(numeric) from public, anon, authenticated, service_role;
revoke all on function public.api_settle_job() from public, anon, authenticated, service_role;
revoke all on function public.api_settle_download() from public, anon, authenticated, service_role;
revoke all on function public.download_credits_price(numeric, text) from public, anon, authenticated, service_role;

-- The platform: the Paddle webhook, the worker, the operator.
revoke all on function public.api_add_topup(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.api_refund_topup(text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.api_hold_start(text, bigint) from public, anon, authenticated;
revoke all on function public.api_adjust_balance(uuid, bigint, text) from public, anon;
grant execute on function public.api_add_topup(uuid, bigint, text, text) to service_role;
grant execute on function public.api_refund_topup(text, text, bigint, text, text) to service_role;
grant execute on function public.api_hold_start(text, bigint) to service_role;
grant execute on function public.api_adjust_balance(uuid, bigint, text) to authenticated, service_role;

-- The Developer console: a signed-in owner/admin (checked inside).
revoke all on function public.api_activate(uuid, text) from public, anon, service_role;
revoke all on function public.api_set_monthly_limit(uuid, bigint) from public, anon, service_role;
revoke all on function public.create_api_key(uuid, text, text, text, bigint) from public, anon, service_role;
revoke all on function public.revoke_api_key(uuid) from public, anon, service_role;
revoke all on function public.set_api_key_limit(uuid, bigint) from public, anon, service_role;
revoke all on function public.api_console(uuid) from public, anon, service_role;
revoke all on function public.api_usage(uuid, integer) from public, anon, service_role;
grant execute on function public.api_activate(uuid, text) to authenticated;
grant execute on function public.api_set_monthly_limit(uuid, bigint) to authenticated;
grant execute on function public.create_api_key(uuid, text, text, text, bigint) to authenticated;
grant execute on function public.revoke_api_key(uuid) to authenticated;
grant execute on function public.set_api_key_limit(uuid, bigint) to authenticated;
grant execute on function public.api_console(uuid) to authenticated;
grant execute on function public.api_usage(uuid, integer) to authenticated;

-- The API's entry points: anon only (the web server's session-less client).
revoke all on function public.api_auth(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_balance(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_create_video(text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.api_list_videos(text, text, integer, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.api_get_video(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_request_publish(text, text, uuid[], text[], text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_list_channels(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_list_connected_accounts(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_request_download(text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_get_download(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.api_auth(text, text) to anon;
grant execute on function public.api_balance(text, text) to anon;
grant execute on function public.api_create_video(text, text, jsonb, text, text, text) to anon;
grant execute on function public.api_get_job(text, bigint, text) to anon;
grant execute on function public.api_list_videos(text, text, integer, integer, text) to anon;
grant execute on function public.api_get_video(text, text, text) to anon;
grant execute on function public.api_request_publish(text, text, uuid[], text[], text, text, text) to anon;
grant execute on function public.api_list_channels(text, text) to anon;
grant execute on function public.api_list_connected_accounts(text, text) to anon;
grant execute on function public.api_request_download(text, text, text, text, text, text) to anon;
grant execute on function public.api_get_download(text, bigint, text) to anon;

alter table public.api_settings enable row level security;
alter table public.api_accounts enable row level security;
alter table public.api_ledger enable row level security;
alter table public.api_holds enable row level security;
alter table public.api_prices enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_rate_counters enable row level security;
alter table public.api_requests enable row level security;
alter table public.api_idempotency enable row level security;

-- Money moves only through the functions above: no direct write for anyone.
revoke all on public.api_settings, public.api_accounts, public.api_ledger, public.api_holds, public.api_prices,
              public.api_keys, public.api_rate_counters, public.api_requests, public.api_idempotency
  from public, anon, authenticated, service_role;
revoke all on sequence public.api_ledger_id_seq, public.api_requests_id_seq from public, anon, authenticated, service_role;

-- An organization's owners/admins read its API state (the console); the
-- webhook reads the ledger to size a partial refund.
grant select on public.api_settings, public.api_accounts, public.api_ledger, public.api_holds, public.api_requests
  to authenticated, service_role;
drop policy if exists api_settings_select on public.api_settings;
create policy api_settings_select on public.api_settings for select to authenticated
  using (org_id in (select public.accessible_org_ids('admin')));
drop policy if exists api_accounts_select on public.api_accounts;
create policy api_accounts_select on public.api_accounts for select to authenticated
  using (org_id in (select public.accessible_org_ids('admin')));
drop policy if exists api_ledger_select on public.api_ledger;
create policy api_ledger_select on public.api_ledger for select to authenticated
  using (org_id in (select public.accessible_org_ids('admin')));
drop policy if exists api_holds_select on public.api_holds;
create policy api_holds_select on public.api_holds for select to authenticated
  using (org_id in (select public.accessible_org_ids('admin')));
drop policy if exists api_requests_select on public.api_requests;
create policy api_requests_select on public.api_requests for select to authenticated
  using (org_id in (select public.accessible_org_ids('admin')));

-- Keys: every column but the hash, to the organization's owners/admins.
grant select (id, org_id, name, prefix, monthly_limit_cents, created_by, created_at, last_used_at, revoked_at, revoked_by)
  on public.api_keys to authenticated, service_role;
drop policy if exists api_keys_select on public.api_keys;
create policy api_keys_select on public.api_keys for select to authenticated
  using (org_id in (select public.accessible_org_ids('admin')));

-- The API price list is public (the docs page shows it signed out); only a
-- platform owner/admin changes it.
grant select on public.api_prices to anon, authenticated, service_role;
grant update (cents, note) on public.api_prices to authenticated;
drop policy if exists api_prices_select on public.api_prices;
create policy api_prices_select on public.api_prices for select to anon, authenticated using (true);
drop policy if exists api_prices_update on public.api_prices;
create policy api_prices_update on public.api_prices for update to authenticated
  using ((select public.is_platform_admin())) with check ((select public.is_platform_admin()));

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class where oid in (
--     'public.api_settings'::regclass, 'public.api_accounts'::regclass, 'public.api_ledger'::regclass,
--     'public.api_holds'::regclass, 'public.api_keys'::regclass, 'public.api_rate_counters'::regclass,
--     'public.api_requests'::regclass, 'public.api_idempotency'::regclass)) as rls_on,
--   not has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'SELECT') as hash_never_readable,
--   not has_table_privilege('authenticated', 'public.api_ledger', 'INSERT')
--     and not has_table_privilege('service_role', 'public.api_ledger', 'UPDATE') as ledger_not_writable,
--   has_function_privilege('anon', 'public.api_create_video(text,text,jsonb,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.api_begin(text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.api_add_topup(uuid,bigint,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.api_add_topup(uuid,bigint,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.create_api_key(uuid,text,text,text,bigint)', 'EXECUTE')
--     as grants_narrow,
--   public.api_tier_for(499, false) = 0 and public.api_tier_for(500, false) = 1
--     and public.api_tier_for(100000, false) = 4 and public.api_tier_for(0, true) = 4 as tiers,
--   public.api_video_price(60) = 120 and public.api_video_price(20) = 60 and public.api_video_price(90) = 180 as prices,
--   (public.api_begin(repeat('0', 64), 'me', null) -> 'error' ->> 'code') = 'invalid_api_key' as unknown_key_refused;
