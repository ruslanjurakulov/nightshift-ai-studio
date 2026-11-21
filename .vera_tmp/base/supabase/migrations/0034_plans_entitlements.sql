-- 0034_plans_entitlements.sql — monthly plans, entitlements, and credit lots
-- that expire (SaaS phase P1).
--
-- THE MODEL
--   * Plans (plans): Free, Creator, Pro, Studio. Each grants a monthly credit
--     ALLOWANCE (plans.monthly_credits) that is valid for its billing period
--     only — no rollover — and unlocks ENTITLEMENTS (plan_entitlements):
--     parallel runs, queue priority, API activation, and — stored now,
--     switched on as each ships — model tiers and features. An organization
--     without a live subscription is on the plan marked is_default (Free),
--     whose only credits are 0027's one-time welcome grant.
--   * Credit packs (0020/0021, lib/paddle.ts) stay on sale as TOP-UPS, valid
--     credit_lot_policies.valid_months (12) from purchase.
--   * The API's prepaid USD balance (0031) is a separate product and is not
--     touched here, beyond api_org_eligible() also accepting the api_access
--     entitlement.
--
-- WHAT IT ADDS
--   Configuration (readable by anyone, the public price list; writable by a
--   platform owner/admin only):
--     plans                id, name, sort_order, monthly_credits, is_default
--     entitlement_keys     the catalog: key, value_type (bool | int | tier),
--                          default_value (a plan that does not set it),
--                          exempt_value (the operator's own organization),
--                          status (enforced | planned — the pricing page
--                          shows ENFORCED keys only)
--     plan_entitlements    (plan, key) -> typed jsonb value
--     credit_lot_policies  how long a pack / grant / adjustment lot lives
--   State (readable by the organization's viewers; written only by the
--   functions below, the Paddle webhook's service role, or the ledger):
--     subscriptions        one row per Paddle subscription: org, plan, status,
--                          customer id, current period, cancel_at_period_end
--     credit_lots          every credit an organization owns, in LOTS: source
--                          (subscription | pack | grant | adjustment), amount,
--                          remaining, held (on hold for a run), expires_at
--   Internal (service role / SQL editor only):
--     credit_hold_lots     which lots each open hold (credit_reservations)
--                          took its credits from
--     credit_lot_moves     append-only: every change to every lot, with the
--                          ledger row that caused it
--
-- HOW LOTS STAY IN STEP WITH THE ACCOUNT
--   credit_accounts.balance / reserved (0020) stay the numbers every caller
--   reads (the run route, downloads 0030, the account panel, the header). The
--   invariant is
--       balance  = sum(credit_lots.remaining)   of the organization
--       reserved = sum(credit_lots.held)
--   and it is CHECKED at every commit (a deferred constraint trigger on both
--   tables): a transaction that would break it fails as a whole.
--   Lots are moved by ONE trigger on the append-only ledger. Every function
--   that moves credits already writes exactly one credit_transactions row per
--   change (credit_log), after updating the account, under the account lock —
--   so the ledger row is where each change is mirrored onto lots:
--       grant / purchase / adjust (+)   a new lot (grant | pack | adjustment),
--                                       expiring per credit_lot_policies
--       reserve                          HOLD from lots in spend order
--       capture (a run's hold)           spend from that hold's lots, then
--                                        (allow_over) from available lots
--       release                          give that hold's lots back
--       capture (no hold: a download),   spend available lots in spend order
--       refund (-), adjust (-)           (a 0021 refund prefers the refunded
--                                        purchase's own lot)
--       refund (+) (a failed download)   restore the lots it was spent from
--       subscription, expire             nothing: their functions move the
--                                        lot themselves
--   SPEND ORDER: subscription credits first (soonest-expiring first), then
--   everything else soonest-expiring first; lots that never expire last.
--   Credits on HOLD stay protected: a lot that expires while part of it is on
--   hold loses only its unheld part; the held part settles normally (a
--   capture spends it, a release gives it back — and it expires then).
--
-- EXPIRY
--   credit_expire_lots_locked(org) turns what is left of expired lots into an
--   'expire' ledger row per lot. It runs inside credit_account_lock() — which
--   every money function calls first — so no balance check ever counts an
--   expired credit; after every release/restore; after a subscription
--   renewal; and for all organizations in expire_credit_lots() (the worker's
--   ten-minute sweep, and pg_cron hourly when the extension is enabled).
--
-- SUBSCRIPTIONS (the Paddle webhook, service role)
--   upsert_subscription(...)            state from subscription.* events;
--                                        an older event never overwrites a
--                                        newer one (last_event_at)
--   grant_subscription_credits(...)     transaction.completed of a plan: the
--                                        period's lot, expiring at the
--                                        period end. Idempotent per
--                                        (subscription, period end) and per
--                                        Paddle transaction id. A mid-period
--                                        upgrade tops the lot up to the new
--                                        allowance IN PROPORTION to the time
--                                        left in the period.
--
-- ENTITLEMENTS
--   org_plan(org), org_entitlements(org), has_entitlement(org, key),
--   entitlement_int(org, key), model_tier_allowed(org, category, tier) —
--   callable by the organization's members and the platform (null / false for
--   anyone else); the *_internal twins are for RLS and definer functions.
--   The exempt operator organization gets every key's exempt_value.
--   Enforced here:
--     concurrency     open run holds per organization (credit_reservations)
--                     — a BEFORE INSERT trigger refuses one more with NS429
--     queue_priority  claim_render_job() gives each level a 15-minute head
--                     start in the render queue (FIFO within a level; no
--                     starvation: an old job still wins eventually)
--     api_access      api_org_eligible() (0031) accepts it
--
-- Additive and idempotent: guarded creates, drop-then-create triggers and
-- policies, create-or-replace functions, seeds ON CONFLICT DO NOTHING (an
-- admin's edits are never overwritten). Wrapped in one transaction: the
-- carry-over of existing balances into lots and the new triggers go live
-- together.
--
-- REQUIRES 0017/0019 (render_jobs), 0018 (organizations), 0020/0021 (credits,
-- refunds), 0027 (welcome), 0030 (downloads), 0031 (api_org_eligible).

begin;

do $$
begin
  if to_regprocedure('public.credit_log(uuid, text, numeric, text, text, text)') is null
     or to_regprocedure('public.refund_purchased_credits(text, text, numeric, text, text)') is null then
    raise exception '0034 needs the credits ledger: apply 0020_credits.sql and 0021_credit_refunds.sql first';
  end if;
  if to_regclass('public.download_requests') is null then
    raise exception '0034 needs 0030_paid_downloads.sql: apply it first';
  end if;
  if to_regprocedure('public.api_org_eligible(uuid)') is null then
    raise exception '0034 needs 0031_public_api.sql: apply it first';
  end if;
  if to_regprocedure('public.claim_render_job(text, interval)') is null then
    raise exception '0034 needs 0017_render_jobs.sql: apply it first';
  end if;
end $$;

-- Nothing may move credits while the carry-over below runs.
lock table public.credit_accounts in share row exclusive mode;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Configuration: plans and entitlements
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.plans (
  id              text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name            text not null check (char_length(btrim(name)) between 1 and 40),
  sort_order      integer not null default 0,
  monthly_credits numeric(14,2) not null default 0
                  check (monthly_credits >= 0 and monthly_credits <= 10000000),
  is_default      boolean not null default false,
  is_public       boolean not null default true,
  updated_at      timestamptz not null default now()
);
create unique index if not exists plans_one_default on public.plans (is_default) where is_default;
comment on table public.plans is
  'Subscription plans (migration 0034). monthly_credits: the allowance granted each paid billing period, expiring at its end. is_default: the plan of an organization without a live subscription (Free). Prices live in Paddle; the Paddle price id -> plan map is the webhook''s env (PADDLE_PLAN_<ID>).';

create or replace function public.entitlement_value_valid(p_type text, p_value jsonb) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select case p_type
    when 'bool' then jsonb_typeof(p_value) = 'boolean'
    when 'int'  then jsonb_typeof(p_value) = 'number'
                     and (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
                     and (p_value #>> '{}')::numeric between 0 and 100000
    when 'tier' then jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') in ('none', 'basic', 'premium', 'all')
    else false end
$$;

create table if not exists public.entitlement_keys (
  key           text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  value_type    text not null check (value_type in ('bool', 'int', 'tier')),
  default_value jsonb not null,
  exempt_value  jsonb not null,
  status        text not null default 'planned' check (status in ('enforced', 'planned')),
  sort_order    integer not null default 0,
  note          text check (note is null or length(note) <= 300)
);
alter table public.entitlement_keys drop constraint if exists entitlement_keys_values_check;
alter table public.entitlement_keys add constraint entitlement_keys_values_check
  check (public.entitlement_value_valid(value_type, default_value)
         and public.entitlement_value_valid(value_type, exempt_value));
comment on table public.entitlement_keys is
  'Entitlement catalog (migration 0034). status = enforced: the platform checks it today and the pricing page lists it; planned: stored per plan, not yet checked anywhere, never advertised. Flip to enforced in the same change that starts checking it.';

create table if not exists public.plan_entitlements (
  plan_id text not null references public.plans (id) on delete cascade,
  key     text not null references public.entitlement_keys (key) on delete cascade,
  value   jsonb not null,
  primary key (plan_id, key)
);
comment on table public.plan_entitlements is
  'What each plan unlocks (migration 0034): one typed jsonb value per (plan, entitlement key); a key a plan does not list takes entitlement_keys.default_value.';

-- A value must match its key's type — checked on write, so a lookup never
-- has to guess what a malformed value meant.
create or replace function public.plan_entitlements_typecheck() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  t text;
begin
  select value_type into t from public.entitlement_keys where key = new.key;
  if not public.entitlement_value_valid(t, new.value) then
    raise exception 'entitlement % expects a % value, got %', new.key, t, new.value using errcode = '22023';
  end if;
  return new;
end
$$;
drop trigger if exists plan_entitlements_typecheck on public.plan_entitlements;
create trigger plan_entitlements_typecheck before insert or update on public.plan_entitlements
  for each row execute function public.plan_entitlements_typecheck();

create table if not exists public.credit_lot_policies (
  source       text primary key check (source in ('pack', 'grant', 'adjustment')),
  valid_months integer check (valid_months is null or valid_months between 1 and 120),
  note         text check (note is null or length(note) <= 300)
);
comment on table public.credit_lot_policies is
  'How long a new lot of each source lives (migration 0034); null = it never expires. Applies to lots created after a change, never retroactively. Subscription lots always expire at their billing period''s end.';

-- Seeds. ON CONFLICT DO NOTHING: re-running never overwrites an admin's edit.
-- The math behind the numbers is in docs/BILLING_PLANS.md.
insert into public.plans (id, name, sort_order, monthly_credits, is_default) values
  ('free',    'Free',    0,     0, true),
  ('creator', 'Creator', 10,  2000, false),
  ('pro',     'Pro',     20,  6000, false),
  ('studio',  'Studio',  30, 18000, false)
on conflict (id) do nothing;

insert into public.entitlement_keys (key, value_type, default_value, exempt_value, status, sort_order, note) values
  ('concurrency',      'int',  '1',       '1000',  'enforced', 10, 'Runs in progress at once (open credit holds); a new Run now over the limit is refused with NS429.'),
  ('queue_priority',   'int',  '0',       '3',     'enforced', 20, 'Render queue head start: 15 minutes per level (claim_render_job).'),
  ('api_access',       'bool', 'false',   'true',  'enforced', 30, 'May activate the public API (api_org_eligible). The API balance itself is separate.'),
  ('models_image',     'tier', '"basic"', '"all"', 'planned',  40, 'Highest image model tier; checked by model_tier_allowed() once the model registry calls it.'),
  ('models_video',     'tier', '"basic"', '"all"', 'planned',  41, 'Highest video model tier; checked by model_tier_allowed() once the model registry calls it.'),
  ('models_audio',     'tier', '"basic"', '"all"', 'planned',  42, 'Highest audio model tier; checked by model_tier_allowed() once the model registry calls it.'),
  ('series',           'bool', 'false',   'true',  'planned',  50, null),
  ('autopilot',        'bool', 'false',   'true',  'planned',  51, null),
  ('workflows',        'bool', 'false',   'true',  'planned',  52, null),
  ('channel_dna',      'bool', 'false',   'true',  'planned',  53, null),
  ('thumbnail_studio', 'bool', 'false',   'true',  'planned',  54, null),
  ('repurposing',      'bool', 'false',   'true',  'planned',  55, null),
  ('mcp',              'bool', 'false',   'true',  'planned',  56, null)
on conflict (key) do nothing;

insert into public.plan_entitlements (plan_id, key, value) values
  ('free', 'concurrency', '1'), ('free', 'queue_priority', '0'), ('free', 'api_access', 'false'),
  ('free', 'models_image', '"basic"'), ('free', 'models_video', '"basic"'), ('free', 'models_audio', '"basic"'),

  ('creator', 'concurrency', '2'), ('creator', 'queue_priority', '1'), ('creator', 'api_access', 'true'),
  ('creator', 'models_image', '"premium"'), ('creator', 'models_video', '"premium"'), ('creator', 'models_audio', '"premium"'),
  ('creator', 'series', 'true'), ('creator', 'channel_dna', 'true'), ('creator', 'thumbnail_studio', 'true'),

  ('pro', 'concurrency', '4'), ('pro', 'queue_priority', '2'), ('pro', 'api_access', 'true'),
  ('pro', 'models_image', '"all"'), ('pro', 'models_video', '"all"'), ('pro', 'models_audio', '"all"'),
  ('pro', 'series', 'true'), ('pro', 'channel_dna', 'true'), ('pro', 'thumbnail_studio', 'true'),
  ('pro', 'autopilot', 'true'), ('pro', 'workflows', 'true'), ('pro', 'repurposing', 'true'), ('pro', 'mcp', 'true'),

  ('studio', 'concurrency', '8'), ('studio', 'queue_priority', '3'), ('studio', 'api_access', 'true'),
  ('studio', 'models_image', '"all"'), ('studio', 'models_video', '"all"'), ('studio', 'models_audio', '"all"'),
  ('studio', 'series', 'true'), ('studio', 'channel_dna', 'true'), ('studio', 'thumbnail_studio', 'true'),
  ('studio', 'autopilot', 'true'), ('studio', 'workflows', 'true'), ('studio', 'repurposing', 'true'), ('studio', 'mcp', 'true')
on conflict (plan_id, key) do nothing;

insert into public.credit_lot_policies (source, valid_months, note) values
  ('pack', 12, 'Top-up packs are valid 12 months from purchase.'),
  ('grant', null, 'Welcome credits and operator grants do not expire.'),
  ('adjustment', null, 'Corrections, carried-over balances and refunds of spend made before 0034 do not expire.')
on conflict (source) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Subscriptions
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.subscriptions (
  id                       bigserial primary key,
  org_id                   uuid not null references public.organizations (id) on delete restrict,
  provider                 text not null default 'paddle' check (provider in ('paddle')),
  provider_subscription_id text not null check (provider_subscription_id ~ '^sub_[a-z0-9]{10,40}$'),
  provider_customer_id     text check (provider_customer_id is null or provider_customer_id ~ '^ctm_[a-z0-9]{10,40}$'),
  plan_id                  text not null references public.plans (id) on delete restrict,
  price_id                 text check (price_id is null or price_id ~ '^pri_[a-z0-9]{10,40}$'),
  status                   text not null check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled')),
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  canceled_at              timestamptz,
  last_event_at            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
create index if not exists subscriptions_org_idx on public.subscriptions (org_id, updated_at desc);
comment on table public.subscriptions is
  'Paddle subscriptions (migration 0034), one row each, kept in step by the Paddle webhook (service role). A live status (active, trialing, past_due) gives the organization its plan''s entitlements; credits come only from paid transactions (grant_subscription_credits). Ids only: no card or personal data.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Credit lots
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.credit_lots (
  id              bigserial primary key,
  org_id          uuid not null references public.organizations (id) on delete restrict,
  source          text not null check (source in ('subscription', 'pack', 'grant', 'adjustment')),
  amount          numeric(14,2) not null check (amount >= 0),
  remaining       numeric(14,2) not null check (remaining >= 0),
  held            numeric(14,2) not null default 0 check (held >= 0),
  expires_at      timestamptz,
  expired_at      timestamptz,
  external_id     text check (external_id is null or length(external_id) between 1 and 200),
  subscription_id bigint references public.subscriptions (id) on delete restrict,
  plan_id         text references public.plans (id) on delete restrict,
  period_start    timestamptz,
  period_end      timestamptz,
  allowance       numeric(14,2),
  created_txn     bigint references public.credit_transactions (id) on delete restrict,
  note            text check (note is null or length(note) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint credit_lots_amounts_check check (held <= remaining and remaining <= amount),
  constraint credit_lots_subscription_check check (
    source <> 'subscription'
    or (subscription_id is not null and period_end is not null and expires_at = period_end))
);
create unique index if not exists credit_lots_external_id_key on public.credit_lots (external_id) where external_id is not null;
create unique index if not exists credit_lots_period_key on public.credit_lots (subscription_id, period_end) where source = 'subscription';
create index if not exists credit_lots_live_idx on public.credit_lots (org_id, expires_at) where remaining > 0;
create index if not exists credit_lots_org_idx on public.credit_lots (org_id, created_at desc);
comment on table public.credit_lots is
  'Every credit an organization owns, in lots (migration 0034). remaining = not yet spent (including held); held = on hold for a run in progress; available = remaining - held while not expired. sum(remaining) = credit_accounts.balance and sum(held) = credit_accounts.reserved, checked at every commit. Moved only by the ledger trigger and the 0034 functions.';

-- A lot is history: it is never deleted, only emptied.
create or replace function public.credit_lots_no_delete() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'credit_lots are never deleted: an expired or spent lot stays at remaining 0' using errcode = '42501';
end
$$;
drop trigger if exists credit_lots_no_delete on public.credit_lots;
create trigger credit_lots_no_delete before delete on public.credit_lots
  for each row execute function public.credit_lots_no_delete();
drop trigger if exists credit_lots_no_truncate on public.credit_lots;
create trigger credit_lots_no_truncate before truncate on public.credit_lots
  for each statement execute function public.credit_lots_no_delete();

create table if not exists public.credit_hold_lots (
  job_id text not null references public.credit_reservations (job_id) on delete restrict,
  lot_id bigint not null references public.credit_lots (id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  primary key (job_id, lot_id)
);
comment on table public.credit_hold_lots is
  'Which lots an open hold took its credits from (migration 0034). A row shrinks as the hold is captured and disappears when it is settled. Internal.';

create table if not exists public.credit_lot_moves (
  id              bigserial primary key,
  org_id          uuid not null references public.organizations (id) on delete restrict,
  lot_id          bigint not null references public.credit_lots (id) on delete restrict,
  txn_id          bigint references public.credit_transactions (id) on delete restrict,
  job_id          text,
  kind            text not null check (kind in ('grant', 'topup', 'hold', 'release', 'spend', 'restore', 'expire', 'carry')),
  remaining_delta numeric(14,2) not null,
  held_delta      numeric(14,2) not null,
  created_at      timestamptz not null default now()
);
create index if not exists credit_lot_moves_job_idx on public.credit_lot_moves (job_id, lot_id) where job_id is not null;
create index if not exists credit_lot_moves_lot_idx on public.credit_lot_moves (lot_id, id);
comment on table public.credit_lot_moves is
  'Append-only history of every lot change (migration 0034) and the ledger row that caused it. A failed download''s refund restores exactly the lots its charge spent, read from here.';

create or replace function public.credit_lot_moves_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'credit_lot_moves is append-only' using errcode = '42501';
end
$$;
drop trigger if exists credit_lot_moves_append_only on public.credit_lot_moves;
create trigger credit_lot_moves_append_only before update or delete on public.credit_lot_moves
  for each row execute function public.credit_lot_moves_append_only();
drop trigger if exists credit_lot_moves_no_truncate on public.credit_lot_moves;
create trigger credit_lot_moves_no_truncate before truncate on public.credit_lot_moves
  for each statement execute function public.credit_lot_moves_append_only();

-- Two new ledger kinds: a subscription period's credits, and credits that
-- expired. Widening the 0020 check; every existing row still passes.
alter table public.credit_transactions drop constraint if exists credit_transactions_kind_check;
alter table public.credit_transactions add constraint credit_transactions_kind_check
  check (kind in ('grant', 'purchase', 'reserve', 'capture', 'release', 'refund', 'adjust', 'subscription', 'expire'));

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Entitlements
-- ───────────────────────────────────────────────────────────────────────────

-- The organization's plan: its highest live subscription, else the default.
create or replace function public.org_plan_internal(p_org uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select s.plan_id from public.subscriptions s join public.plans p on p.id = s.plan_id
      where s.org_id = p_org and s.status in ('active', 'trialing', 'past_due')
      order by p.sort_order desc, s.id desc limit 1),
    (select id from public.plans where is_default limit 1))
$$;

create or replace function public.org_entitlements_internal(p_org uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(k.key,
           case when public.credits_exempt(p_org) then k.exempt_value
                else coalesce(pe.value, k.default_value) end), '{}'::jsonb)
    from public.entitlement_keys k
    left join public.plan_entitlements pe
      on pe.key = k.key and pe.plan_id = public.org_plan_internal(p_org)
$$;

create or replace function public.entitlement_int_internal(p_org uuid, p_key text) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric::integer end
    from (select public.org_entitlements_internal(p_org) -> p_key as v) x
$$;

create or replace function public.has_entitlement_internal(p_org uuid, p_key text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(case jsonb_typeof(v)
                    when 'boolean' then (v #>> '{}')::boolean
                    when 'number'  then (v #>> '{}')::numeric > 0
                    when 'string'  then (v #>> '{}') <> 'none'
                  end, false)
    from (select public.org_entitlements_internal(p_org) -> p_key as v) x
$$;

-- Who may ask about an organization: its members, a platform owner/admin,
-- and the platform itself. Anyone else learns nothing (null / false).
create or replace function public.billing_may_read(p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_org is not null and (
    public.credits_trusted_caller() or public.is_org_member(p_org, 'viewer') or public.is_platform_admin())
$$;

create or replace function public.org_plan(p_org uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.billing_may_read(p_org) then public.org_plan_internal(p_org) end
$$;

create or replace function public.org_entitlements(p_org uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.billing_may_read(p_org) then public.org_entitlements_internal(p_org) end
$$;

create or replace function public.has_entitlement(p_org uuid, p_key text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select public.billing_may_read(p_org) and public.has_entitlement_internal(p_org, p_key)
$$;

create or replace function public.entitlement_int(p_org uuid, p_key text) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.billing_may_read(p_org) then public.entitlement_int_internal(p_org, p_key) end
$$;

-- For the model registry: may this organization use a model of this tier?
-- p_category: image | video | audio; p_tier: basic | premium | ultra. The
-- entitlement models_<category> names the highest tier allowed: none (no
-- model of the category) < basic < premium < all (every tier, ultra
-- included). Unknown input is a refusal.
create or replace function public.model_tier_rank(p_tier text) returns integer
  language sql immutable set search_path = public, pg_temp as $$
  select case p_tier when 'none' then 0 when 'basic' then 1 when 'premium' then 2
                     when 'ultra' then 3 when 'all' then 3 end
$$;

create or replace function public.model_tier_allowed(p_org uuid, p_category text, p_tier text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    public.billing_may_read(p_org)
    and p_category in ('image', 'video', 'audio')
    and p_tier in ('basic', 'premium', 'ultra')
    and public.model_tier_rank(public.org_entitlements_internal(p_org) ->> ('models_' || p_category))
        >= public.model_tier_rank(p_tier), false)
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The lot engine (internal; the account is always locked by the caller)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_lot_expiry(p_source text) returns timestamptz
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when m is null then null else now() + make_interval(months => m) end
    from (select (select valid_months from public.credit_lot_policies where source = p_source) as m) x
$$;

create or replace function public.credit_lot_move(
  p_org uuid, p_lot bigint, p_txn bigint, p_job text, p_kind text, p_remaining numeric, p_held numeric
) returns void
  language sql security definer set search_path = public, pg_temp as $$
  insert into public.credit_lot_moves (org_id, lot_id, txn_id, job_id, kind, remaining_delta, held_delta)
  values (p_org, p_lot, p_txn, p_job, p_kind, p_remaining, p_held)
$$;

create or replace function public.credit_lots_add_locked(
  p_org uuid, p_source text, p_amount numeric, p_expires timestamptz,
  p_external text, p_txn bigint, p_note text
) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  lid bigint;
begin
  insert into public.credit_lots (org_id, source, amount, remaining, expires_at, external_id, created_txn, note)
  values (p_org, p_source, p_amount, p_amount, p_expires, p_external, p_txn,
          left(nullif(btrim(coalesce(p_note, '')), ''), 500))
  returning id into lid;
  perform public.credit_lot_move(p_org, lid, p_txn, null, 'grant', p_amount, 0);
  return lid;
end
$$;

-- Spend AVAILABLE credits (not on hold, not expired) in spend order;
-- p_prefer (a lot id) goes first when it still has any. Never partial: not
-- enough is NS402 and the whole transaction rolls back.
create or replace function public.credit_lots_spend_locked(
  p_org uuid, p_amount numeric, p_job text, p_txn bigint, p_prefer bigint default null
) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  left_ numeric := p_amount;
  l record;
  take numeric;
begin
  if left_ is null or left_ <= 0 then
    return;
  end if;
  for l in
    select id, remaining, held from public.credit_lots
     where org_id = p_org and remaining > held and (expires_at is null or expires_at > now())
     order by coalesce(id = p_prefer, false) desc, (source <> 'subscription'), expires_at asc nulls last, id
     for update
  loop
    take := least(l.remaining - l.held, left_);
    update public.credit_lots set remaining = remaining - take, updated_at = now() where id = l.id;
    perform public.credit_lot_move(p_org, l.id, p_txn, p_job, 'spend', -take, 0);
    left_ := left_ - take;
    exit when left_ <= 0;
  end loop;
  if left_ > 0 then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', p_amount - left_, p_amount),
            hint = 'Add credits to this organization.';
  end if;
end
$$;

-- Put a run's hold on lots, in spend order.
create or replace function public.credit_lots_hold_locked(p_org uuid, p_job text, p_amount numeric, p_txn bigint)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  left_ numeric := p_amount;
  l record;
  take numeric;
begin
  for l in
    select id, remaining, held from public.credit_lots
     where org_id = p_org and remaining > held and (expires_at is null or expires_at > now())
     order by (source <> 'subscription'), expires_at asc nulls last, id
     for update
  loop
    exit when left_ <= 0;
    take := least(l.remaining - l.held, left_);
    update public.credit_lots set held = held + take, updated_at = now() where id = l.id;
    insert into public.credit_hold_lots (job_id, lot_id, amount) values (p_job, l.id, take)
      on conflict (job_id, lot_id) do update set amount = public.credit_hold_lots.amount + excluded.amount;
    perform public.credit_lot_move(p_org, l.id, p_txn, p_job, 'hold', 0, take);
    left_ := left_ - take;
  end loop;
  if left_ > 0 then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', p_amount - left_, p_amount),
            hint = 'Add credits to this organization, or start a shorter run.';
  end if;
end
$$;

-- Charge a run from its own hold, soonest-expiring lot first (an expired
-- lot's held credits are used before they would be lost). What the hold
-- cannot cover (capture_credits' allow_over) comes from available lots.
-- What is left on the hold stays for the release row that follows.
create or replace function public.credit_lots_capture_locked(p_org uuid, p_job text, p_amount numeric, p_txn bigint)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  left_ numeric := p_amount;
  a record;
  take numeric;
begin
  for a in
    select h.lot_id, h.amount from public.credit_hold_lots h
      join public.credit_lots l on l.id = h.lot_id
     where h.job_id = p_job
     order by l.expires_at asc nulls last, l.id
     for update of h, l
  loop
    exit when left_ <= 0;
    take := least(a.amount, left_);
    update public.credit_lots
       set remaining = remaining - take, held = held - take, updated_at = now()
     where id = a.lot_id;
    if take = a.amount then
      delete from public.credit_hold_lots where job_id = p_job and lot_id = a.lot_id;
    else
      update public.credit_hold_lots set amount = amount - take where job_id = p_job and lot_id = a.lot_id;
    end if;
    perform public.credit_lot_move(p_org, a.lot_id, p_txn, p_job, 'spend', -take, -take);
    left_ := left_ - take;
  end loop;
  if left_ > 0 then
    perform public.credit_lots_spend_locked(p_org, left_, p_job, p_txn, null);
  end if;
end
$$;

-- Give what is left of a hold back to its lots. The amount must be exactly
-- what is left: anything else means the ledger and the lots disagree.
create or replace function public.credit_lots_release_locked(p_org uuid, p_job text, p_amount numeric, p_txn bigint)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record;
  total numeric := 0;
begin
  for a in
    select h.lot_id, h.amount from public.credit_hold_lots h
      join public.credit_lots l on l.id = h.lot_id
     where h.job_id = p_job
     order by l.id
     for update of h, l
  loop
    update public.credit_lots set held = held - a.amount, updated_at = now() where id = a.lot_id;
    delete from public.credit_hold_lots where job_id = p_job and lot_id = a.lot_id;
    perform public.credit_lot_move(p_org, a.lot_id, p_txn, p_job, 'release', 0, -a.amount);
    total := total + a.amount;
  end loop;
  if total <> p_amount then
    raise exception 'credit lots out of step: hold % releases %, lots held %', p_job, p_amount, total
      using errcode = '23514';
  end if;
end
$$;

-- A refunded charge (a failed download) goes back to the lots it was spent
-- from — even an expired one, which the sweep then expires as usual. A
-- charge made before 0034 has no lots on record: its refund becomes an
-- adjustment lot that does not expire, as the credits it replaces did not.
create or replace function public.credit_lots_restore_locked(p_org uuid, p_job text, p_amount numeric, p_txn bigint)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  left_ numeric := p_amount;
  m record;
  take numeric;
begin
  if p_job is not null then
    for m in
      select mv.lot_id,
             -sum(mv.remaining_delta) filter (where mv.kind = 'spend')
               - coalesce(sum(mv.remaining_delta) filter (where mv.kind = 'restore'), 0) as open_
        from public.credit_lot_moves mv
       where mv.job_id = p_job and mv.org_id = p_org and mv.kind in ('spend', 'restore')
       group by mv.lot_id
       order by mv.lot_id desc
    loop
      exit when left_ <= 0;
      continue when coalesce(m.open_, 0) <= 0;
      take := least(m.open_, left_);
      perform 1 from public.credit_lots where id = m.lot_id for update;
      update public.credit_lots set remaining = remaining + take, updated_at = now() where id = m.lot_id;
      perform public.credit_lot_move(p_org, m.lot_id, p_txn, p_job, 'restore', take, 0);
      left_ := left_ - take;
    end loop;
  end if;
  if left_ > 0 then
    perform public.credit_lots_add_locked(p_org, 'adjustment', left_, public.credit_lot_expiry('adjustment'),
                                          null, p_txn, 'refund of ' || coalesce(p_job, 'a charge') || ' made before lots');
  end if;
end
$$;

-- What is left of every expired lot (minus what is on hold) leaves the
-- balance: one 'expire' ledger row per lot, job_id 'lot:<id>'. Returns the
-- credits expired.
create or replace function public.credit_expire_lots_locked(p_org uuid) returns numeric
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l record;
  x numeric;
  total numeric := 0;
  txn bigint;
  label text;
begin
  for l in
    select * from public.credit_lots
     where org_id = p_org and remaining > held and expires_at <= now()
     order by expires_at, id
     for update
  loop
    x := l.remaining - l.held;
    update public.credit_lots
       set remaining = held, expired_at = coalesce(expired_at, now()), updated_at = now()
     where id = l.id;
    update public.credit_accounts set balance = balance - x, updated_at = now() where org_id = p_org;
    label := case l.source
      when 'subscription' then format('%s plan credits for the period ending %s', coalesce(l.plan_id, 'subscription'),
                                      to_char(l.expires_at at time zone 'UTC', 'YYYY-MM-DD'))
      when 'pack' then format('credit pack bought %s', to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD'))
      else format('%s credits from %s', l.source, to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD')) end;
    txn := public.credit_log(p_org, 'expire', -x, 'lot:' || l.id, null, format('%s credits expired: %s', x, label));
    perform public.credit_lot_move(p_org, l.id, txn, 'lot:' || l.id, 'expire', -x, 0);
    total := total + x;
  end loop;
  return total;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The ledger drives the lots
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_transactions_apply_lots() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  amt    numeric := new.amount;
  prefer bigint;
  src    text;
begin
  if new.kind in ('subscription', 'expire') or amt = 0 then
    return null;
  end if;
  if new.kind = 'reserve' then
    perform public.credit_lots_hold_locked(new.org_id, new.job_id, amt, new.id);
  elsif new.kind = 'release' then
    perform public.credit_lots_release_locked(new.org_id, new.job_id, amt, new.id);
    perform public.credit_expire_lots_locked(new.org_id);
  elsif new.kind = 'capture' and new.job_id is not null
        and exists (select 1 from public.credit_reservations r where r.job_id = new.job_id) then
    perform public.credit_lots_capture_locked(new.org_id, new.job_id, -amt, new.id);
  elsif new.kind = 'refund' and amt > 0 then
    perform public.credit_lots_restore_locked(new.org_id, new.job_id, amt, new.id);
    perform public.credit_expire_lots_locked(new.org_id);
  elsif amt > 0 then
    src := case new.kind when 'purchase' then 'pack' when 'grant' then 'grant' else 'adjustment' end;
    perform public.credit_lots_add_locked(new.org_id, src, amt, public.credit_lot_expiry(src),
                                          new.external_id, new.id, new.note);
  else
    if new.kind = 'refund' then
      select id into prefer from public.credit_lots
       where org_id = new.org_id
         and external_id = nullif(current_setting('nightshift.refund_of', true), '');
    end if;
    perform public.credit_lots_spend_locked(new.org_id, -amt, new.job_id, new.id, prefer);
  end if;
  return null;
end
$$;

-- The invariant, checked when the transaction commits.
create or replace function public.credit_lots_consistent() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acc    public.credit_accounts;
  s_rem  numeric;
  s_held numeric;
begin
  select * into acc from public.credit_accounts where org_id = new.org_id;
  select coalesce(sum(remaining), 0), coalesce(sum(held), 0) into s_rem, s_held
    from public.credit_lots where org_id = new.org_id and remaining > 0;
  if coalesce(acc.balance, 0) <> s_rem or coalesce(acc.reserved, 0) <> s_held then
    raise exception 'credit lots out of step with the account of %: balance % vs lots %, reserved % vs held %',
      new.org_id, coalesce(acc.balance, 0), s_rem, coalesce(acc.reserved, 0), s_held
      using errcode = '23514',
            hint = 'Credits move only through the credit functions (0020/0034), which write the ledger.';
  end if;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Carry existing balances over (once), BEFORE the triggers go live
-- ───────────────────────────────────────────────────────────────────────────
-- Credits bought or granted before plans were sold under "credits do not
-- expire": they become one adjustment lot per organization that never
-- expires, and every open hold is booked against it.

do $$
declare
  a record;
  lid bigint;
  open_sum numeric;
begin
  for a in
    select * from public.credit_accounts c
     where c.balance > 0
       and not exists (select 1 from public.credit_lots l where l.org_id = c.org_id)
  loop
    select coalesce(sum(amount), 0) into open_sum
      from public.credit_reservations where org_id = a.org_id and status = 'open';
    if open_sum <> a.reserved then
      raise exception '0034: organization % has % on hold but open reservations add up to % — fix before applying',
        a.org_id, a.reserved, open_sum;
    end if;
    insert into public.credit_lots (org_id, source, amount, remaining, held, note)
    values (a.org_id, 'adjustment', a.balance, a.balance, a.reserved,
            'balance carried over when plans launched (0034); does not expire')
    returning id into lid;
    perform public.credit_lot_move(a.org_id, lid, null, null, 'carry', a.balance, a.reserved);
    insert into public.credit_hold_lots (job_id, lot_id, amount)
    select r.job_id, lid, r.amount from public.credit_reservations r
     where r.org_id = a.org_id and r.status = 'open';
  end loop;
end $$;

drop trigger if exists credit_transactions_apply_lots on public.credit_transactions;
create trigger credit_transactions_apply_lots after insert on public.credit_transactions
  for each row execute function public.credit_transactions_apply_lots();

drop trigger if exists credit_accounts_lots_consistent on public.credit_accounts;
create constraint trigger credit_accounts_lots_consistent after insert or update on public.credit_accounts
  deferrable initially deferred for each row execute function public.credit_lots_consistent();

drop trigger if exists credit_lots_consistent on public.credit_lots;
create constraint trigger credit_lots_consistent after insert or update on public.credit_lots
  deferrable initially deferred for each row execute function public.credit_lots_consistent();

-- ───────────────────────────────────────────────────────────────────────────
-- 8. 0020 / 0021 functions that learn about lots
-- ───────────────────────────────────────────────────────────────────────────

-- The account lock (0020) now also expires what has run out, so every money
-- function sees a balance with no expired credit in it before it checks.
create or replace function public.credit_account_lock(p_org uuid) returns public.credit_accounts
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acc public.credit_accounts;
begin
  if p_org is null or not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'unknown organization' using errcode = '22023';
  end if;
  insert into public.credit_accounts (org_id) values (p_org) on conflict (org_id) do nothing;
  select * into acc from public.credit_accounts where org_id = p_org for update;
  if public.credit_expire_lots_locked(p_org) > 0 then
    select * into acc from public.credit_accounts where org_id = p_org;
  end if;
  return acc;
end
$$;

-- 0021's refund, unchanged except: a subscription period's payment can be
-- refunded like a pack, and the credits taken back come from the refunded
-- purchase's own lot first (then spend order).
create or replace function public.refund_purchased_credits(
  p_external_id text, p_refund_id text, p_amount numeric default null,
  p_note text default null, p_reason text default 'refund'
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ext       text := btrim(coalesce(p_external_id, ''));
  rid       text := btrim(coalesce(p_refund_id, ''));
  why       text := coalesce(nullif(btrim(p_reason), ''), 'refund');
  purchase  public.credit_transactions;
  prior     public.credit_refunds;
  acc       public.credit_accounts;
  already   numeric;
  remaining numeric;
  asked     numeric;
  taken     numeric;
  short     numeric;
  txn       bigint;
  msg       text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'refunds are recorded by the platform only' using errcode = '42501';
  end if;
  if ext = '' or length(ext) > 200 or rid = '' or length(rid) > 200 then
    raise exception 'external_id and refund_id are required' using errcode = '22023';
  end if;
  if why not in ('refund', 'chargeback') then
    raise exception 'reason must be refund or chargeback' using errcode = '22023';
  end if;
  if p_amount is not null and (p_amount <= 0 or p_amount > 100000000) then
    raise exception 'amount must be a positive number of credits' using errcode = '22023';
  end if;

  select * into purchase from public.credit_transactions
   where external_id = ext and kind in ('purchase', 'subscription');
  if not found then
    raise exception 'no purchase recorded for this external_id' using errcode = 'P0002';
  end if;

  acc := public.credit_account_lock(purchase.org_id);
  select * into prior from public.credit_refunds where refund_id = rid;
  if found then
    if prior.purchase_external_id <> ext then
      raise exception 'refund_id already recorded for a different purchase' using errcode = '23505';
    end if;
    return jsonb_build_object('refund_id', rid, 'duplicate', true,
                              'requested', prior.requested, 'taken', prior.taken,
                              'shortfall', prior.shortfall,
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  select coalesce(sum(requested), 0) into already
    from public.credit_refunds where purchase_external_id = ext;
  remaining := greatest(purchase.amount - already, 0);
  asked := least(coalesce(round(p_amount, 2), remaining), remaining);
  taken := least(asked, greatest(acc.balance - acc.reserved, 0));
  short := asked - taken;

  update public.credit_accounts
     set balance = balance - taken, updated_at = now()
   where org_id = purchase.org_id
  returning * into acc;

  msg := format('%s of purchase %s: %s credits', why, ext, asked);
  if short > 0 then
    msg := msg || format(' — %s taken back, %s already spent and NOT recovered', taken, short);
  end if;
  if coalesce(btrim(p_note), '') <> '' then
    msg := msg || ' · ' || btrim(p_note);
  end if;

  -- The lot trigger reads this to take the refunded purchase's own credits first.
  perform set_config('nightshift.refund_of', ext, true);
  txn := public.credit_log(purchase.org_id, 'refund', -taken, null, rid, msg);
  perform set_config('nightshift.refund_of', '', true);
  insert into public.credit_refunds
    (refund_id, purchase_external_id, org_id, reason, requested, taken, shortfall, transaction_id, note)
  values
    (rid, ext, purchase.org_id, why, asked, taken, short, txn, left(msg, 500));

  return jsonb_build_object('refund_id', rid, 'duplicate', false,
                            'requested', asked, 'taken', taken, 'shortfall', short,
                            'transaction_id', txn,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Subscriptions (the Paddle webhook)
-- ───────────────────────────────────────────────────────────────────────────

-- State from a subscription.* event. An event older than the last one
-- applied changes nothing (Paddle does not promise delivery order). p_plan
-- null (a price no longer mapped to a plan) keeps the recorded plan, so a
-- cancellation still lands; a new subscription needs a plan.
create or replace function public.upsert_subscription(
  p_org uuid, p_subscription_id text, p_customer_id text, p_plan text, p_price_id text,
  p_status text, p_period_start timestamptz, p_period_end timestamptz,
  p_cancel_at_period_end boolean, p_canceled_at timestamptz, p_occurred_at timestamptz
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s public.subscriptions;
begin
  if not public.credits_trusted_caller() then
    raise exception 'subscriptions are recorded by the platform only' using errcode = '42501';
  end if;
  if p_org is null or not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'unknown organization' using errcode = '22023';
  end if;
  if p_plan is not null and not exists (select 1 from public.plans where id = p_plan) then
    raise exception 'unknown plan %', p_plan using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'trialing', 'past_due', 'paused', 'canceled') then
    raise exception 'unknown subscription status %', p_status using errcode = '22023';
  end if;

  -- One decision per subscription at a time.
  perform pg_advisory_xact_lock(hashtextextended('subscription:' || coalesce(p_subscription_id, ''), 0));
  select * into s from public.subscriptions
   where provider = 'paddle' and provider_subscription_id = p_subscription_id
   for update;
  if found then
    if s.org_id <> p_org then
      raise exception 'subscription already recorded for another organization' using errcode = '23505';
    end if;
    if s.last_event_at is not null and p_occurred_at is not null and p_occurred_at < s.last_event_at then
      return jsonb_build_object('id', s.id, 'stale', true, 'status', s.status, 'plan', s.plan_id);
    end if;
    update public.subscriptions
       set provider_customer_id = coalesce(p_customer_id, provider_customer_id),
           plan_id = coalesce(p_plan, plan_id),
           price_id = coalesce(p_price_id, price_id),
           status = p_status,
           current_period_start = coalesce(p_period_start, current_period_start),
           current_period_end = coalesce(p_period_end, current_period_end),
           cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
           canceled_at = coalesce(p_canceled_at, canceled_at),
           last_event_at = coalesce(p_occurred_at, last_event_at),
           updated_at = now()
     where id = s.id
    returning * into s;
  else
    if p_plan is null then
      raise exception 'a new subscription needs a known plan' using errcode = '22023';
    end if;
    insert into public.subscriptions
      (org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,
       current_period_start, current_period_end, cancel_at_period_end, canceled_at, last_event_at)
    values
      (p_org, p_subscription_id, p_customer_id, p_plan, p_price_id, p_status,
       p_period_start, p_period_end, coalesce(p_cancel_at_period_end, false), p_canceled_at, p_occurred_at)
    returning * into s;
  end if;
  return jsonb_build_object('id', s.id, 'stale', false, 'status', s.status, 'plan', s.plan_id);
end
$$;

-- A paid transaction of a plan: this period's credits.
--   * idempotent per Paddle transaction id (the ledger's unique external_id)
--     and per (subscription, period end): a replay, or a second transaction
--     for a period already at its allowance, adds nothing;
--   * a mid-period UPGRADE (a proration transaction for the same period end)
--     tops the lot up by (new allowance - old) x (time left / period length),
--     so a last-day upgrade cannot buy a whole month of credits for cents;
--   * p_paid_share (0..1) is the share of the list price actually charged
--     (the webhook reads Paddle's totals after discount): a 50%-off month
--     grants half the credits, a 100%-off one none — unless the discount is
--     an explicitly allowed promo, for which the webhook passes 1;
--   * a period that has already ended grants nothing (a very late retry);
--   * the subscription row is created if its subscription.created event has
--     not arrived yet.
create or replace function public.grant_subscription_credits(
  p_org uuid, p_subscription_id text, p_plan text, p_period_start timestamptz, p_period_end timestamptz,
  p_external_id text, p_note text default null, p_customer_id text default null, p_price_id text default null,
  p_paid_share numeric default 1
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ext   text := btrim(coalesce(p_external_id, ''));
  plan_ public.plans;
  s     public.subscriptions;
  lot   public.credit_lots;
  acc   public.credit_accounts;
  prior public.credit_transactions;
  add_  numeric := 0;
  frac  numeric;
  txn   bigint;
  lid   bigint;
begin
  if not public.credits_trusted_caller() then
    raise exception 'subscription credits are granted by the platform only' using errcode = '42501';
  end if;
  if ext = '' or length(ext) > 200 then
    raise exception 'external_id is required' using errcode = '22023';
  end if;
  select * into plan_ from public.plans where id = p_plan;
  if not found then
    raise exception 'unknown plan %', p_plan using errcode = '22023';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'a billing period needs a start before its end' using errcode = '22023';
  end if;
  if p_paid_share is null or p_paid_share < 0 or p_paid_share > 1 then
    raise exception 'paid share must be between 0 and 1' using errcode = '22023';
  end if;

  acc := public.credit_account_lock(p_org);
  perform pg_advisory_xact_lock(hashtextextended('subscription:' || coalesce(p_subscription_id, ''), 0));

  select * into prior from public.credit_transactions where external_id = ext;
  if found then
    if prior.org_id <> p_org or prior.kind <> 'subscription' then
      raise exception 'external_id already recorded for something else' using errcode = '23505';
    end if;
    return jsonb_build_object('duplicate', true, 'granted', 0, 'transaction_id', prior.id,
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  select * into s from public.subscriptions
   where provider = 'paddle' and provider_subscription_id = p_subscription_id
   for update;
  if not found then
    insert into public.subscriptions
      (org_id, provider_subscription_id, provider_customer_id, plan_id, price_id, status,
       current_period_start, current_period_end)
    values (p_org, p_subscription_id, p_customer_id, p_plan, p_price_id, 'active', p_period_start, p_period_end)
    returning * into s;
  elsif s.org_id <> p_org then
    raise exception 'subscription already recorded for another organization' using errcode = '23505';
  end if;

  if p_period_end <= now() then
    return jsonb_build_object('duplicate', false, 'granted', 0, 'reason', 'period_over',
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  select * into lot from public.credit_lots
   where subscription_id = s.id and source = 'subscription' and period_end = p_period_end
   for update;
  if not found then
    -- Rounded down to the cent: a discount never rounds into extra credits.
    add_ := trunc(plan_.monthly_credits * p_paid_share, 2);
    if add_ > 0 then
      insert into public.credit_lots
        (org_id, source, amount, remaining, expires_at, external_id, subscription_id, plan_id,
         period_start, period_end, allowance, note)
      values
        (p_org, 'subscription', add_, add_, p_period_end, ext, s.id, p_plan,
         p_period_start, p_period_end, plan_.monthly_credits,
         left(format('%s plan, period %s – %s', plan_.name,
                     to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD'),
                     to_char(p_period_end at time zone 'UTC', 'YYYY-MM-DD')), 500))
      returning id into lid;
    end if;
  elsif plan_.monthly_credits > coalesce(lot.allowance, lot.amount) then
    frac := greatest(least(extract(epoch from (p_period_end - now()))
                           / nullif(extract(epoch from (lot.period_end - lot.period_start)), 0), 1), 0);
    add_ := trunc((plan_.monthly_credits - coalesce(lot.allowance, lot.amount)) * coalesce(frac, 0) * p_paid_share, 2);
    lid := lot.id;
    update public.credit_lots
       set amount = amount + add_, remaining = remaining + add_,
           allowance = plan_.monthly_credits, plan_id = p_plan, updated_at = now()
     where id = lot.id;
  end if;

  if add_ > 0 then
    update public.credit_accounts set balance = balance + add_, updated_at = now()
     where org_id = p_org
    returning * into acc;
    txn := public.credit_log(p_org, 'subscription', add_, null, ext,
                             coalesce(nullif(btrim(p_note), ''), format('%s plan credits', plan_.name)));
    update public.credit_lots set created_txn = coalesce(created_txn, txn) where id = lid;
    perform public.credit_lot_move(p_org, lid, txn, null, case when lot.id is null then 'grant' else 'topup' end, add_, 0);
  end if;

  -- A renewal: the previous period's lot has run out now.
  perform public.credit_expire_lots_locked(p_org);
  select * into acc from public.credit_accounts where org_id = p_org;

  return jsonb_build_object('duplicate', false, 'granted', add_, 'transaction_id', txn, 'lot_id', lid,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- Every organization's expired lots, for a cron or the worker's sweep.
create or replace function public.expire_credit_lots(p_org uuid default null) returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  o uuid;
  total numeric := 0;
  before_ numeric;
  acc public.credit_accounts;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may expire credits' using errcode = '42501';
  end if;
  for o in
    select distinct org_id from public.credit_lots
     where remaining > held and expires_at <= now() and (p_org is null or org_id = p_org)
  loop
    select balance into before_ from public.credit_accounts where org_id = o;
    acc := public.credit_account_lock(o);
    total := total + greatest(coalesce(before_, 0) - acc.balance, 0);
  end loop;
  return total;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. Enforcement: parallel runs, queue priority, API activation
-- ───────────────────────────────────────────────────────────────────────────

-- Runs in progress = open credit holds. reserve_credits() locks the account
-- before inserting the hold, so two Run now clicks cannot both take the last
-- slot. The exempt organization never reserves, so it is never counted.
create or replace function public.credit_reservations_concurrency() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  lim    integer;
  active integer;
begin
  if public.credits_exempt(new.org_id) then
    return new;
  end if;
  lim := coalesce(public.entitlement_int_internal(new.org_id, 'concurrency'), 1);
  select count(*) into active from public.credit_reservations
   where org_id = new.org_id and status = 'open';
  if active >= lim then
    raise exception 'parallel run limit reached'
      using errcode = 'NS429',
            detail = format('active=%s limit=%s', active, lim),
            hint = 'Wait for a run to finish, or upgrade the plan for more parallel runs.';
  end if;
  return new;
end
$$;
drop trigger if exists credit_reservations_concurrency on public.credit_reservations;
create trigger credit_reservations_concurrency before insert on public.credit_reservations
  for each row execute function public.credit_reservations_concurrency();

-- The same numbers for the Run now button and future creative jobs.
create or replace function public.org_run_slots(p_org uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when not public.billing_may_read(p_org) then null
              when public.credits_exempt(p_org) then jsonb_build_object('exempt', true, 'limit', null, 'active', 0)
              else jsonb_build_object(
                'exempt', false,
                'limit', coalesce(public.entitlement_int_internal(p_org, 'concurrency'), 1),
                'active', (select count(*) from public.credit_reservations r
                            where r.org_id = p_org and r.status = 'open'))
         end
$$;

-- The render queue's order: each queue_priority level is a 15-minute head
-- start. Same claim as 0017 otherwise.
create or replace function public.render_job_priority(p_channel text) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select least(greatest(coalesce(public.entitlement_int_internal(public.channel_org(p_channel), 'queue_priority'), 0), 0), 10)
$$;

create or replace function public.claim_render_job(
  p_worker text,
  p_stale_after interval default interval '10 minutes'
)
  returns setof public.render_jobs
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_id bigint;
begin
  if coalesce(btrim(p_worker), '') = '' then
    raise exception 'claim_render_job: p_worker is required';
  end if;

  update public.render_jobs j
     set status      = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
         finished_at = case when j.attempts >= j.max_attempts then now() else null end,
         error       = case when j.attempts >= j.max_attempts
                            then 'worker lost (no heartbeat) on the last of ' || j.max_attempts || ' attempts'
                            else 'worker lost (no heartbeat); re-queued' end,
         worker_id   = null
   where j.id in (
           select s.id from public.render_jobs s
            where s.status = 'running'
              and coalesce(s.heartbeat_at, s.started_at, s.created_at) < now() - p_stale_after
            for update skip locked);

  select q.id into v_id
    from public.render_jobs q
   where q.status = 'queued'
     and not exists (select 1 from public.render_jobs r
                      where r.channel_id = q.channel_id and r.status = 'running')
   order by q.created_at - make_interval(mins => 15 * public.render_job_priority(q.channel_id)), q.id
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  begin
    return query
      update public.render_jobs j
         set status       = 'running',
             worker_id    = p_worker,
             attempts     = j.attempts + 1,
             started_at   = now(),
             heartbeat_at = now(),
             finished_at  = null
       where j.id = v_id
      returning j.*;
  exception when unique_violation then
    return;
  end;
end
$$;

-- 0031: the API may be activated by the exempt org, by any organization that
-- ever bought a pack (unchanged), and now by a plan with api_access.
create or replace function public.api_org_eligible(p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_org is not null and (
    public.credits_exempt(p_org)
    or exists (select 1 from public.credit_transactions t where t.org_id = p_org and t.kind = 'purchase')
    or public.has_entitlement_internal(p_org, 'api_access'))
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 11. What the account panel and the Credits page show
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.billing_summary(p_org uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with live as (
    select source, remaining - held as free_, held, expires_at from public.credit_lots
     where org_id = p_org and remaining > 0 and (expires_at is null or expires_at > now())
  ), plan_ as (
    select p.* from public.plans p where p.id = public.org_plan_internal(p_org)
  ), sub as (
    select s.* from public.subscriptions s
     where s.org_id = p_org
     order by (s.status in ('active', 'trialing', 'past_due')) desc, s.updated_at desc, s.id desc
     limit 1
  ), nxt as (
    select min(expires_at) as at from live where free_ > 0 and expires_at is not null
  )
  select case when not public.billing_may_read(p_org) then null else jsonb_build_object(
    'exempt', public.credits_exempt(p_org),
    'plan', (select jsonb_build_object('id', id, 'name', name, 'monthly_credits', monthly_credits,
                                       'is_default', is_default) from plan_),
    'subscription', (select jsonb_build_object(
                       'plan_id', plan_id, 'status', status,
                       'current_period_start', current_period_start,
                       'current_period_end', current_period_end,
                       'cancel_at_period_end', cancel_at_period_end,
                       'canceled_at', canceled_at,
                       'manageable', provider_customer_id is not null) from sub),
    'credits', jsonb_build_object(
       'subscription', coalesce((select sum(free_) from live where source = 'subscription'), 0),
       'pack', coalesce((select sum(free_) from live where source = 'pack'), 0),
       'other', coalesce((select sum(free_) from live where source in ('grant', 'adjustment')), 0),
       'held', coalesce((select sum(held) from public.credit_lots where org_id = p_org and held > 0), 0)),
    'next_expiry', (select case when at is null then null else jsonb_build_object(
                      'at', at, 'credits', (select sum(free_) from live where expires_at = nxt.at)) end from nxt),
    'entitlements', public.org_entitlements_internal(p_org),
    'run_slots', public.org_run_slots(p_org))
  end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 12. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

-- Helpers and the engine: nobody calls them through the API.
-- Pure helpers a platform admin's writes evaluate (a CHECK constraint and the
-- type-check trigger run as the caller), so authenticated keeps EXECUTE.
revoke all on function public.entitlement_value_valid(text, jsonb) from public, anon;
grant execute on function public.entitlement_value_valid(text, jsonb) to authenticated, service_role;
revoke all on function public.plan_entitlements_typecheck() from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_no_delete() from public, anon, authenticated, service_role;
revoke all on function public.credit_lot_moves_append_only() from public, anon, authenticated, service_role;
revoke all on function public.org_plan_internal(uuid) from public, anon, authenticated, service_role;
revoke all on function public.org_entitlements_internal(uuid) from public, anon, authenticated, service_role;
revoke all on function public.entitlement_int_internal(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.has_entitlement_internal(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.billing_may_read(uuid) from public, anon, authenticated, service_role;
revoke all on function public.model_tier_rank(text) from public, anon;
grant execute on function public.model_tier_rank(text) to authenticated, service_role;
revoke all on function public.credit_lot_expiry(text) from public, anon, authenticated, service_role;
revoke all on function public.credit_lot_move(uuid, bigint, bigint, text, text, numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_add_locked(uuid, text, numeric, timestamptz, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_spend_locked(uuid, numeric, text, bigint, bigint) from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_hold_locked(uuid, text, numeric, bigint) from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_capture_locked(uuid, text, numeric, bigint) from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_release_locked(uuid, text, numeric, bigint) from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_restore_locked(uuid, text, numeric, bigint) from public, anon, authenticated, service_role;
revoke all on function public.credit_expire_lots_locked(uuid) from public, anon, authenticated, service_role;
revoke all on function public.credit_transactions_apply_lots() from public, anon, authenticated, service_role;
revoke all on function public.credit_lots_consistent() from public, anon, authenticated, service_role;
revoke all on function public.credit_reservations_concurrency() from public, anon, authenticated, service_role;
revoke all on function public.render_job_priority(text) from public, anon, authenticated, service_role;
-- 0020's lock keeps 0020's grants (none); restated because it was replaced.
revoke all on function public.credit_account_lock(uuid) from public, anon, authenticated, service_role;

-- Reads for members (each checks membership itself) and the platform.
revoke all on function public.org_plan(uuid) from public, anon;
revoke all on function public.org_entitlements(uuid) from public, anon;
revoke all on function public.has_entitlement(uuid, text) from public, anon;
revoke all on function public.entitlement_int(uuid, text) from public, anon;
revoke all on function public.model_tier_allowed(uuid, text, text) from public, anon;
revoke all on function public.org_run_slots(uuid) from public, anon;
revoke all on function public.billing_summary(uuid) from public, anon;
grant execute on function public.org_plan(uuid) to authenticated, service_role;
grant execute on function public.org_entitlements(uuid) to authenticated, service_role;
grant execute on function public.has_entitlement(uuid, text) to authenticated, service_role;
grant execute on function public.entitlement_int(uuid, text) to authenticated, service_role;
grant execute on function public.model_tier_allowed(uuid, text, text) to authenticated, service_role;
grant execute on function public.org_run_slots(uuid) to authenticated, service_role;
grant execute on function public.billing_summary(uuid) to authenticated, service_role;

-- Money: the platform only.
revoke all on function public.upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.grant_subscription_credits(uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)
  from public, anon, authenticated;
revoke all on function public.expire_credit_lots(uuid) from public, anon, authenticated;
grant execute on function public.upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz)
  to service_role;
grant execute on function public.grant_subscription_credits(uuid, text, text, timestamptz, timestamptz, text, text, text, text, numeric)
  to service_role;
grant execute on function public.expire_credit_lots(uuid) to service_role;

alter table public.plans enable row level security;
alter table public.entitlement_keys enable row level security;
alter table public.plan_entitlements enable row level security;
alter table public.credit_lot_policies enable row level security;
alter table public.subscriptions enable row level security;
alter table public.credit_lots enable row level security;
alter table public.credit_hold_lots enable row level security;
alter table public.credit_lot_moves enable row level security;

-- The price list is public (the /pricing page reads it signed out); only a
-- platform owner/admin may change it — the same bar as credit_prices.
revoke all on public.plans, public.entitlement_keys, public.plan_entitlements, public.credit_lot_policies
  from anon, authenticated, service_role;
grant select on public.plans, public.entitlement_keys, public.plan_entitlements, public.credit_lot_policies
  to anon, authenticated, service_role;
grant insert, update, delete on public.plans, public.entitlement_keys, public.plan_entitlements, public.credit_lot_policies
  to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['plans', 'entitlement_keys', 'plan_entitlements', 'credit_lot_policies'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format('create policy %1$s_select on public.%1$s for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists %1$s_write on public.%1$s', t);
    execute format('create policy %1$s_write on public.%1$s for all to authenticated
                      using ((select public.is_platform_admin())) with check ((select public.is_platform_admin()))', t);
  end loop;
end $$;

-- State: the organization's viewers read their own; nobody writes directly
-- (the service key included — it bypasses RLS, not privileges).
revoke all on public.subscriptions, public.credit_lots, public.credit_hold_lots, public.credit_lot_moves
  from anon, authenticated, service_role;
grant select on public.subscriptions, public.credit_lots to authenticated, service_role;
grant select on public.credit_hold_lots, public.credit_lot_moves to service_role;
revoke all on sequence public.subscriptions_id_seq, public.credit_lots_id_seq, public.credit_lot_moves_id_seq
  from anon, authenticated, service_role;

drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists credit_lots_select on public.credit_lots;
create policy credit_lots_select on public.credit_lots
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

-- ───────────────────────────────────────────────────────────────────────────
-- 13. Hourly expiry, when pg_cron is enabled (the worker sweeps too)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('nightshift-expire-credit-lots', '17 * * * *', 'select public.expire_credit_lots()');
  end if;
exception when others then
  raise notice '0034: pg_cron schedule not created (%); the worker''s sweep still expires lots', sqlerrm;
end $$;

commit;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from public.plans where is_default) = 1 as one_default_plan,
--   (select bool_and(relrowsecurity) from pg_class where oid in (
--      'public.plans'::regclass, 'public.subscriptions'::regclass, 'public.credit_lots'::regclass,
--      'public.credit_hold_lots'::regclass, 'public.credit_lot_moves'::regclass)) as rls_enabled,
--   not has_table_privilege('authenticated', 'public.credit_lots', 'UPDATE')
--     and not has_table_privilege('service_role', 'public.credit_lots', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.subscriptions', 'INSERT')
--     and not has_table_privilege('anon', 'public.credit_lots', 'SELECT') as state_not_writable,
--   not has_function_privilege('authenticated',
--     'public.grant_subscription_credits(uuid,text,text,timestamptz,timestamptz,text,text,text,text,numeric)', 'EXECUTE')
--     as grants_service_only,
--   (select count(*) from public.credit_accounts a where a.balance <> coalesce((select sum(remaining)
--      from public.credit_lots l where l.org_id = a.org_id), 0) or a.reserved <> coalesce((select sum(held)
--      from public.credit_lots l where l.org_id = a.org_id), 0)) = 0 as lots_match_accounts;
