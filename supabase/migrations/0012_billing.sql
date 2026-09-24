-- 0012_billing.sql — provider balances, billing settings and top-up ledger.
--
-- Backs the Command Center's Billing page:
--   * provider_balances          — what each paid provider says is left
--                                  (written by modules/provider_balance.py with
--                                  the service key; append-only snapshots).
--   * provider_billing_settings  — per-provider price per unit (so spend is in
--                                  USD only when the operator set a rate), bulk
--                                  top-up inclusion, and the two operator flags
--                                  "card saved on the provider" / "auto-recharge
--                                  on at the provider".
--   * provider_topups            — top-ups the operator made on a provider's own
--                                  checkout and confirmed here. No card data is
--                                  ever stored anywhere in this schema.
--
-- Additive and idempotent: guarded creates, drop-then-create policies. Reads are
-- open to any signed-in operator; writes require admin or owner
-- (current_app_role / app_role_rank from migration 0007).

create extension if not exists pgcrypto;

create table if not exists public.provider_balances (
  id          bigint generated always as identity primary key,
  provider    text not null,
  metric      text not null,
  remaining   double precision,
  total       double precision,
  unit        text not null,
  tier        text,
  resets_at   timestamptz,
  source      text not null default 'api' check (source in ('api','manual')),
  checked_at  timestamptz not null default now()
);
create index if not exists provider_balances_latest_idx
  on public.provider_balances (provider, checked_at desc);

create table if not exists public.provider_billing_settings (
  provider                  text primary key,
  usd_per_unit              numeric check (usd_per_unit is null or usd_per_unit >= 0),
  include_in_bulk           boolean not null default true,
  card_saved_on_provider    boolean not null default false,
  auto_recharge_on_provider boolean not null default false,
  low_balance_days          int not null default 3 check (low_balance_days between 0 and 365),
  updated_at                timestamptz not null default now(),
  updated_by                uuid
);

create table if not exists public.provider_topups (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  amount_usd  numeric not null check (amount_usd > 0 and amount_usd <= 10000),
  paid_at     timestamptz not null default now(),
  created_by  uuid,
  note        text
);
create index if not exists provider_topups_provider_idx
  on public.provider_topups (provider, paid_at desc);

alter table public.provider_balances enable row level security;
alter table public.provider_billing_settings enable row level security;
alter table public.provider_topups enable row level security;

-- Reads: any signed-in operator.
drop policy if exists provider_balances_select on public.provider_balances;
create policy provider_balances_select on public.provider_balances
  for select to authenticated using (true);

drop policy if exists provider_billing_settings_select on public.provider_billing_settings;
create policy provider_billing_settings_select on public.provider_billing_settings
  for select to authenticated using (true);

drop policy if exists provider_topups_select on public.provider_topups;
create policy provider_topups_select on public.provider_topups
  for select to authenticated using (true);

-- Writes: admin/owner only. Balances are written by the pipeline with the
-- service key (bypasses RLS), so no authenticated write policy is needed there.
drop policy if exists provider_billing_settings_write on public.provider_billing_settings;
create policy provider_billing_settings_write on public.provider_billing_settings
  for insert to authenticated
  with check (public.app_role_rank(public.current_app_role()) >= 3);

drop policy if exists provider_billing_settings_update on public.provider_billing_settings;
create policy provider_billing_settings_update on public.provider_billing_settings
  for update to authenticated
  using (public.app_role_rank(public.current_app_role()) >= 3)
  with check (public.app_role_rank(public.current_app_role()) >= 3);

drop policy if exists provider_topups_insert on public.provider_topups;
create policy provider_topups_insert on public.provider_topups
  for insert to authenticated
  with check (public.app_role_rank(public.current_app_role()) >= 3);
