-- 0020_credits.sql — prepaid credits: a balance, a ledger, and reserve/capture
-- around every paid run (SaaS phase C2). No payment provider yet.
--
-- WHAT IT ADDS
--   credit_accounts      one row per organization: balance (credits owned,
--                        including any on hold) and reserved (credits on hold
--                        for runs that have not settled). available = balance
--                        - reserved. Both >= 0, reserved <= balance.
--   credit_transactions  the append-only ledger. Every change to an account is
--                        one row, with the balance and hold AFTER it. Nothing
--                        may update or delete a row — not a browser, not the
--                        service key, not the SQL editor (a trigger refuses).
--   credit_reservations  the hold for one run, keyed by a job reference:
--                        open -> captured | released. Written only by the
--                        functions below.
--   credit_prices        the platform's price list (credits per unit, plus a
--                        margin). Special units:
--                          video_minute  credits per minute of finished video —
--                                        what "Run now" estimates with;
--                          usd           credits per USD of PRICED ledger cost
--                                        (cost_ledger's estimated_usd);
--                          job_minimum   the smallest hold any run may take;
--                          <ledger unit> e.g. tts_characters — credits per unit
--                                        quantity, used before `usd` when set.
--                        Readable by every signed-in account (it is a price
--                        list), editable only by a platform owner/admin.
--   render_jobs.credit_ref  which reservation pays for a queued job (nullable;
--                        no render_jobs policy is changed).
--
-- THE FUNCTIONS (security definer, search_path pinned, every one that moves
-- credits locks the account row first — then the reservation — so two calls
-- for one organization serialise instead of racing):
--   grant_credits(org, amount, note)                platform owner/admin
--   add_purchased_credits(org, amount, external_id, note)
--                                                   service role only; the
--                                                   future payment webhook's one
--                                                   call; idempotent on
--                                                   external_id
--   reserve_credits(org, job_id, amount)            org admin+ (what Run now
--                                                   already requires) or service
--                                                   role; fails with SQLSTATE
--                                                   NS402 when available credits
--                                                   do not cover it
--   start_credit_reservation(job_id, org)           service role: the runner
--                                                   claims the hold before it
--                                                   spends; returns the amount,
--                                                   or null when there is no
--                                                   open hold for that org
--   capture_credits(job_id, actual, allow_over)     service role; never above
--                                                   the hold unless allow_over;
--                                                   the remainder is released
--   release_credits(job_id)                         service role
--   expire_credit_reservations(org)                 service role (and lazily on
--                                                   every reserve): returns
--                                                   holds that can no longer
--                                                   settle — never started in 3
--                                                   hours, started over 24 hours
--                                                   ago, or bound to a queued job
--                                                   that already failed
--
-- THE DEFAULT ORGANIZATION IS EXEMPT. The operator's own channels
-- (00000000-0000-0000-0000-000000000001) keep running with zero credits:
-- reserve_credits answers {"exempt": true} for it and holds nothing.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser, via the anon key):
--   credit_accounts / credit_transactions / credit_reservations
--     select: viewer+ of that organization · no insert/update/delete for anyone
--   credit_prices
--     select: any signed-in account · insert/update/delete: platform owner/admin
--   anon gets nothing at all.
--
-- Additive and idempotent: guarded creates, drop-then-create policies and
-- triggers, create-or-replace functions. Safe to re-run. Nothing is dropped.

create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.credit_accounts (
  org_id     uuid primary key references public.organizations (id) on delete restrict,
  balance    numeric(14,2) not null default 0,
  reserved   numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.credit_accounts drop constraint if exists credit_accounts_balance_check;
alter table public.credit_accounts add constraint credit_accounts_balance_check
  check (balance >= 0);
alter table public.credit_accounts drop constraint if exists credit_accounts_reserved_check;
alter table public.credit_accounts add constraint credit_accounts_reserved_check
  check (reserved >= 0 and reserved <= balance);

comment on table public.credit_accounts is
  'Prepaid credits per organization. balance = credits owned (including holds); reserved = credits on hold for unsettled runs; available = balance - reserved. Changed only by the credit functions of migration 0020.';

create table if not exists public.credit_transactions (
  id             bigserial primary key,
  org_id         uuid not null references public.organizations (id) on delete restrict,
  kind           text not null,
  amount         numeric(14,2) not null,
  balance_after  numeric(14,2) not null,
  reserved_after numeric(14,2) not null,
  job_id         text,
  external_id    text,
  note           text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);

alter table public.credit_transactions drop constraint if exists credit_transactions_kind_check;
alter table public.credit_transactions add constraint credit_transactions_kind_check
  check (kind in ('grant', 'purchase', 'reserve', 'capture', 'release', 'refund', 'adjust'));
alter table public.credit_transactions drop constraint if exists credit_transactions_note_check;
alter table public.credit_transactions add constraint credit_transactions_note_check
  check (note is null or length(note) <= 500);
alter table public.credit_transactions drop constraint if exists credit_transactions_external_id_check;
alter table public.credit_transactions add constraint credit_transactions_external_id_check
  check (external_id is null or length(external_id) between 1 and 200);

create unique index if not exists credit_transactions_external_id_key
  on public.credit_transactions (external_id) where external_id is not null;
create index if not exists credit_transactions_org_idx
  on public.credit_transactions (org_id, created_at desc, id desc);
create index if not exists credit_transactions_job_idx
  on public.credit_transactions (job_id) where job_id is not null;

comment on table public.credit_transactions is
  'Append-only credit ledger. amount: grant/purchase/refund/adjust = change to balance; reserve = credits put on hold (balance unchanged); capture = credits charged (negative); release = credits returned from hold to available (balance unchanged). balance_after/reserved_after are the account after the row.';
comment on column public.credit_transactions.external_id is
  'The payment provider''s id for a purchase (future webhook). Unique: the same purchase delivered twice adds credits once.';

create table if not exists public.credit_reservations (
  job_id     text primary key,
  org_id     uuid not null references public.organizations (id) on delete restrict,
  amount     numeric(14,2) not null,
  status     text not null default 'open',
  captured   numeric(14,2),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  settled_at timestamptz
);

alter table public.credit_reservations drop constraint if exists credit_reservations_job_id_check;
alter table public.credit_reservations add constraint credit_reservations_job_id_check
  check (job_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$');
alter table public.credit_reservations drop constraint if exists credit_reservations_amount_check;
alter table public.credit_reservations add constraint credit_reservations_amount_check
  check (amount > 0);
alter table public.credit_reservations drop constraint if exists credit_reservations_status_check;
alter table public.credit_reservations add constraint credit_reservations_status_check
  check (status in ('open', 'captured', 'released'));

create index if not exists credit_reservations_org_idx
  on public.credit_reservations (org_id, created_at desc);
create index if not exists credit_reservations_open_idx
  on public.credit_reservations (created_at) where status = 'open';

comment on table public.credit_reservations is
  'The credit hold for one run. job_id is the run''s reference (render_jobs.credit_ref on the queue, the credit_ref dispatch input on Actions). open -> captured | released, only through the 0020 functions.';

create table if not exists public.credit_prices (
  unit             text primary key,
  credits_per_unit numeric(18,8) not null,
  margin           numeric(6,4) not null default 0,
  note             text,
  updated_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now()
);

alter table public.credit_prices drop constraint if exists credit_prices_unit_check;
alter table public.credit_prices add constraint credit_prices_unit_check
  check (unit ~ '^[a-z][a-z0-9_]{0,62}$');
alter table public.credit_prices drop constraint if exists credit_prices_rate_check;
alter table public.credit_prices add constraint credit_prices_rate_check
  check (credits_per_unit >= 0);
alter table public.credit_prices drop constraint if exists credit_prices_margin_check;
alter table public.credit_prices add constraint credit_prices_margin_check
  check (margin >= 0 and margin <= 10);
alter table public.credit_prices drop constraint if exists credit_prices_note_check;
alter table public.credit_prices add constraint credit_prices_note_check
  check (note is null or length(note) <= 300);

comment on table public.credit_prices is
  'Platform price list. credits = quantity * credits_per_unit * (1 + margin). Units: video_minute (the Run now estimate), usd (per USD of priced ledger cost), job_minimum (smallest hold; margin ignored), or a cost-ledger unit name (used before usd). An unset unit is unpriced — never 0.';

-- Who changed a price, and when — set by the database, not the browser.
create or replace function public.credit_prices_stamp() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end
$$;

drop trigger if exists credit_prices_stamp on public.credit_prices;
create trigger credit_prices_stamp
  before insert or update on public.credit_prices
  for each row execute function public.credit_prices_stamp();

-- The queued job's hold. A column, not a params key: 0017's params whitelist
-- and insert policy stay exactly as they are. Unique, so one hold can never
-- pay for two jobs.
do $$
begin
  if to_regclass('public.render_jobs') is not null then
    alter table public.render_jobs add column if not exists credit_ref text;
    alter table public.render_jobs drop constraint if exists render_jobs_credit_ref_check;
    alter table public.render_jobs add constraint render_jobs_credit_ref_check
      check (credit_ref is null or credit_ref ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$');
    create unique index if not exists render_jobs_credit_ref_key
      on public.render_jobs (credit_ref) where credit_ref is not null;
    comment on column public.render_jobs.credit_ref is
      'The credit_reservations.job_id that pays for this job (migration 0020). Null for an exempt or unenforced run. The worker settles it when the job ends.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The ledger is append-only — for everyone
-- ───────────────────────────────────────────────────────────────────────────
-- Grants stop browsers and the service key; this also stops the table owner
-- and the SQL editor, so a "quick fix" to a balance has to be a new, visible
-- 'adjust' row instead of a rewritten history.

create or replace function public.credit_transactions_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'credit_transactions is append-only: record a new transaction instead'
    using errcode = '42501';
end
$$;

drop trigger if exists credit_transactions_append_only on public.credit_transactions;
create trigger credit_transactions_append_only
  before update or delete on public.credit_transactions
  for each row execute function public.credit_transactions_append_only();

drop trigger if exists credit_transactions_no_truncate on public.credit_transactions;
create trigger credit_transactions_no_truncate
  before truncate on public.credit_transactions
  for each statement execute function public.credit_transactions_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The operator's own organization never pays: its channels ran before credits
-- existed and must keep running with none.
create or replace function public.credits_exempt(p_org uuid) returns boolean
  language sql stable set search_path = public, pg_temp as $$
  select p_org is not distinct from public.default_org_id()
$$;

-- A caller the platform itself operates: the service key (the worker, the
-- workflow, a future payment webhook) or a direct database session with no
-- API claims at all (the SQL editor). Browsers always carry claims.
create or replace function public.credits_trusted_caller() returns boolean
  language sql stable set search_path = public, pg_temp as $$
  select coalesce(auth.role(), '') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
$$;

-- Credits are held to the cent, and a hold or a charge is rounded UP: a
-- rounding step must never be where an amount quietly shrinks.
create or replace function public.credits_round_up(v numeric) returns numeric
  language sql immutable set search_path = public, pg_temp as $$
  select ceil(v * 100) / 100
$$;

-- The account row, created on first use and locked FOR UPDATE for the rest of
-- the caller's transaction. Every function that moves credits starts here, so
-- concurrent calls for one organization run one after another.
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
  return acc;
end
$$;

-- One ledger row reflecting the account as it now stands.
create or replace function public.credit_log(
  p_org uuid, p_kind text, p_amount numeric, p_job text, p_external text, p_note text
) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acc public.credit_accounts;
  out_id bigint;
begin
  select * into acc from public.credit_accounts where org_id = p_org;
  insert into public.credit_transactions
    (org_id, kind, amount, balance_after, reserved_after, job_id, external_id, note, created_by)
  values
    (p_org, p_kind, p_amount, acc.balance, acc.reserved, p_job, p_external,
     left(nullif(btrim(coalesce(p_note, '')), ''), 500), auth.uid())
  returning id into out_id;
  return out_id;
end
$$;

-- Release one open hold (the account is already locked by the caller).
create or replace function public.credit_release_locked(p_job text, p_note text) returns numeric
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.credit_reservations;
begin
  select * into r from public.credit_reservations where job_id = p_job for update;
  if not found or r.status <> 'open' then
    return 0;
  end if;
  update public.credit_accounts
     set reserved = reserved - r.amount, updated_at = now()
   where org_id = r.org_id;
  update public.credit_reservations
     set status = 'released', settled_at = now()
   where job_id = p_job;
  perform public.credit_log(r.org_id, 'release', r.amount, p_job, null, p_note);
  return r.amount;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Adding credits
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.grant_credits(p_org uuid, p_amount numeric, p_note text default null)
  returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  amt numeric := public.credits_round_up(p_amount);
  acc public.credit_accounts;
begin
  if not (public.is_platform_admin() or public.credits_trusted_caller()) then
    raise exception 'only a platform owner or admin may grant credits' using errcode = '42501';
  end if;
  if amt is null or amt <= 0 or amt > 100000000 then
    raise exception 'amount must be a positive number of credits' using errcode = '22023';
  end if;
  acc := public.credit_account_lock(p_org);
  update public.credit_accounts
     set balance = balance + amt, updated_at = now()
   where org_id = p_org
  returning * into acc;
  perform public.credit_log(p_org, 'grant', amt, null, null, p_note);
  return acc.balance;
end
$$;

-- The payment webhook's one call (Paddle, later). Idempotent on external_id:
-- a webhook delivered twice, or retried after a timeout, adds credits once and
-- returns the same answer. The same external_id for a different organization
-- or amount is a conflict, never a second credit.
create or replace function public.add_purchased_credits(
  p_org uuid, p_amount numeric, p_external_id text, p_note text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  amt numeric := public.credits_round_up(p_amount);
  ext text := btrim(coalesce(p_external_id, ''));
  prior public.credit_transactions;
  acc public.credit_accounts;
  txn bigint;
begin
  if not public.credits_trusted_caller() then
    raise exception 'purchases are recorded by the platform only' using errcode = '42501';
  end if;
  if ext = '' or length(ext) > 200 then
    raise exception 'external_id is required' using errcode = '22023';
  end if;
  if amt is null or amt <= 0 or amt > 100000000 then
    raise exception 'amount must be a positive number of credits' using errcode = '22023';
  end if;

  -- Lock first, then look: a concurrent delivery of the same purchase for the
  -- same org waits here and then finds the first one's row.
  acc := public.credit_account_lock(p_org);
  select * into prior from public.credit_transactions where external_id = ext;
  if found then
    if prior.org_id <> p_org or prior.kind <> 'purchase' or prior.amount <> amt then
      raise exception 'external_id already recorded for a different purchase' using errcode = '23505';
    end if;
    return jsonb_build_object('transaction_id', prior.id, 'duplicate', true,
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  update public.credit_accounts
     set balance = balance + amt, updated_at = now()
   where org_id = p_org
  returning * into acc;
  -- The unique index is the last word: the same external_id for ANOTHER org
  -- racing this one (different account lock) fails here instead of crediting
  -- twice.
  txn := public.credit_log(p_org, 'purchase', amt, null, ext, p_note);
  return jsonb_build_object('transaction_id', txn, 'duplicate', false,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Holds: expire, reserve, start, capture, release
-- ───────────────────────────────────────────────────────────────────────────

-- Return holds that can no longer settle, so credits are not stuck on a run
-- that will never report back:
--   * never started within p_unstarted_after — "Run now" reserved, then the
--     dispatch or the insert failed (the browser cannot release; see below);
--   * started more than p_started_after ago — the runner died without settling
--     (a queued job has a heartbeat, an Actions job a 60-minute timeout);
--   * bound to a queued job that has already failed or been cancelled (the
--     worker died on its last attempt and claim_render_job failed the job).
-- Each release is a ledger row that says why. Returns how many were released.
create or replace function public.expire_credit_reservations(
  p_org uuid default null,
  p_unstarted_after interval default interval '3 hours',
  p_started_after interval default interval '24 hours'
) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r record;
  n integer := 0;
  has_jobs boolean := to_regclass('public.render_jobs') is not null;
  why text;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may expire reservations' using errcode = '42501';
  end if;
  for r in
    select c.job_id, c.org_id, c.started_at, c.created_at
      from public.credit_reservations c
     where c.status = 'open'
       and (p_org is null or c.org_id = p_org)
     order by c.org_id, c.created_at
  loop
    why := null;
    if r.started_at is null and r.created_at < now() - p_unstarted_after then
      why := 'expired: the run never started';
    elsif r.started_at is not null and r.started_at < now() - p_started_after then
      why := 'expired: the run never settled';
    elsif has_jobs and exists (select 1 from public.render_jobs j
                                where j.credit_ref = r.job_id
                                  and j.status in ('failed', 'cancelled')) then
      why := 'released: the queued job ended without a charge';
    end if;
    if why is not null then
      perform public.credit_account_lock(r.org_id);
      if public.credit_release_locked(r.job_id, why) > 0 then
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end
$$;

create or replace function public.reserve_credits(p_org uuid, p_job_id text, p_amount numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  amt     numeric := public.credits_round_up(p_amount);
  job     text := btrim(coalesce(p_job_id, ''));
  acc     public.credit_accounts;
  floor_c numeric;
  avail   numeric;
begin
  if not (public.credits_trusted_caller() or public.is_org_member(p_org, 'admin')) then
    raise exception 'only an owner or admin of this organization may start a paid run'
      using errcode = '42501';
  end if;
  if job !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$' then
    raise exception 'invalid job reference' using errcode = '22023';
  end if;
  if public.credits_exempt(p_org) then
    return jsonb_build_object('exempt', true, 'job_id', job, 'reserved', 0);
  end if;
  if amt is null or amt <= 0 or amt > 100000000 then
    raise exception 'amount must be a positive number of credits' using errcode = '22023';
  end if;
  -- The platform's floor. A browser can call this function directly with any
  -- amount, and a capture never exceeds its hold, so a hold smaller than the
  -- floor would be a cheap run.
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null and amt < public.credits_round_up(floor_c) then
    raise exception 'reservation below the platform minimum of % credits', public.credits_round_up(floor_c)
      using errcode = '22023';
  end if;

  acc := public.credit_account_lock(p_org);
  -- Stale holds of this org first, so a failed dispatch hours ago does not
  -- keep this run from starting. Runs as the definer: the caller's own claims
  -- would not pass expire's trusted-caller check, so call the release directly.
  perform public.credit_release_locked(c.job_id,
            case when c.started_at is null then 'expired: the run never started'
                 else 'expired: the run never settled' end)
     from public.credit_reservations c
    where c.org_id = p_org and c.status = 'open'
      and ((c.started_at is null and c.created_at < now() - interval '3 hours')
           or (c.started_at is not null and c.started_at < now() - interval '24 hours'));
  select * into acc from public.credit_accounts where org_id = p_org;

  if exists (select 1 from public.credit_reservations where job_id = job) then
    raise exception 'a reservation for this job already exists' using errcode = '23505';
  end if;

  avail := acc.balance - acc.reserved;
  if avail < amt then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', avail, amt),
            hint = 'Add credits to this organization, or start a shorter run.';
  end if;

  insert into public.credit_reservations (job_id, org_id, amount, created_by)
  values (job, p_org, amt, auth.uid());
  update public.credit_accounts
     set reserved = reserved + amt, updated_at = now()
   where org_id = p_org
  returning * into acc;
  perform public.credit_log(p_org, 'reserve', amt, job, null, null);

  return jsonb_build_object('exempt', false, 'job_id', job, 'reserved', amt,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- The runner (worker or workflow) claims the hold before spending anything.
-- Null when there is no OPEN hold for that job in that organization — the
-- runner then refuses the run. Idempotent for a re-queued job.
create or replace function public.start_credit_reservation(p_job_id text, p_org uuid)
  returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.credit_reservations;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may start a reservation' using errcode = '42501';
  end if;
  select * into r from public.credit_reservations where job_id = p_job_id;
  if not found or r.org_id is distinct from p_org then
    return null;
  end if;
  perform public.credit_account_lock(r.org_id);
  select * into r from public.credit_reservations where job_id = p_job_id for update;
  if r.status <> 'open' then
    return null;
  end if;
  if r.started_at is null then
    update public.credit_reservations set started_at = now() where job_id = p_job_id;
  end if;
  return r.amount;
end
$$;

-- Settle a hold at what the run actually cost. Never above the hold unless
-- p_allow_over — and then never beyond what the account can pay. The unused
-- part of the hold is released in the same transaction. Settling twice (a
-- retried call) changes nothing and returns the first answer.
create or replace function public.capture_credits(
  p_job_id text, p_actual numeric, p_allow_over boolean default false
) returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org   uuid;
  r     public.credit_reservations;
  acc   public.credit_accounts;
  amt   numeric := public.credits_round_up(p_actual);
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may capture credits' using errcode = '42501';
  end if;
  if amt is null or amt < 0 then
    raise exception 'actual amount must be zero or more' using errcode = '22023';
  end if;
  select org_id into org from public.credit_reservations where job_id = p_job_id;
  if org is null then
    raise exception 'no reservation for this job' using errcode = 'P0002';
  end if;
  -- Account first, then the hold: the same order as every other function.
  acc := public.credit_account_lock(org);
  select * into r from public.credit_reservations where job_id = p_job_id for update;
  if r.status <> 'open' then
    return coalesce(r.captured, 0);
  end if;
  if amt > r.amount then
    if not coalesce(p_allow_over, false) then
      raise exception 'capture of % exceeds the reservation of %', amt, r.amount
        using errcode = '22023';
    end if;
    if acc.balance - acc.reserved < amt - r.amount then
      raise exception 'insufficient credits for the amount over the reservation'
        using errcode = 'NS402';
    end if;
  end if;

  update public.credit_accounts
     set balance = balance - amt, reserved = reserved - r.amount, updated_at = now()
   where org_id = org;
  update public.credit_reservations
     set status = 'captured', captured = amt, settled_at = now()
   where job_id = p_job_id;
  perform public.credit_log(org, 'capture', -amt, p_job_id, null, null);
  if r.amount > amt then
    perform public.credit_log(org, 'release', r.amount - amt, p_job_id, null,
                              'unused part of the reservation');
  end if;
  return amt;
end
$$;

create or replace function public.release_credits(p_job_id text) returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org uuid;
begin
  if not public.credits_trusted_caller() then
    raise exception 'only the platform may release credits' using errcode = '42501';
  end if;
  select org_id into org from public.credit_reservations where job_id = p_job_id;
  if org is null then
    raise exception 'no reservation for this job' using errcode = 'P0002';
  end if;
  perform public.credit_account_lock(org);
  return public.credit_release_locked(p_job_id, 'run did not complete');
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────
-- Supabase's default privileges hand every new function to anon and
-- authenticated; each one is narrowed explicitly here.

revoke all on function public.credits_exempt(uuid) from public, anon;
revoke all on function public.credits_trusted_caller() from public, anon, authenticated;
revoke all on function public.credits_round_up(numeric) from public, anon;
revoke all on function public.credit_account_lock(uuid) from public, anon, authenticated, service_role;
revoke all on function public.credit_log(uuid, text, numeric, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.credit_release_locked(text, text) from public, anon, authenticated, service_role;
revoke all on function public.credit_prices_stamp() from public, anon, authenticated;
revoke all on function public.credit_transactions_append_only() from public, anon, authenticated;
grant execute on function public.credits_exempt(uuid) to authenticated, service_role;
grant execute on function public.credits_round_up(numeric) to authenticated, service_role;

revoke all on function public.grant_credits(uuid, numeric, text) from public, anon;
grant execute on function public.grant_credits(uuid, numeric, text) to authenticated, service_role;

revoke all on function public.reserve_credits(uuid, text, numeric) from public, anon;
grant execute on function public.reserve_credits(uuid, text, numeric) to authenticated, service_role;

revoke all on function public.add_purchased_credits(uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.expire_credit_reservations(uuid, interval, interval) from public, anon, authenticated;
revoke all on function public.start_credit_reservation(text, uuid) from public, anon, authenticated;
revoke all on function public.capture_credits(text, numeric, boolean) from public, anon, authenticated;
revoke all on function public.release_credits(text) from public, anon, authenticated;
grant execute on function public.add_purchased_credits(uuid, numeric, text, text) to service_role;
grant execute on function public.expire_credit_reservations(uuid, interval, interval) to service_role;
grant execute on function public.start_credit_reservation(text, uuid) to service_role;
grant execute on function public.capture_credits(text, numeric, boolean) to service_role;
grant execute on function public.release_credits(text) to service_role;

alter table public.credit_accounts enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.credit_prices enable row level security;

-- Money moves only through the functions above: no direct write for anyone,
-- the service key included (it bypasses RLS, not privileges).
revoke all on public.credit_accounts, public.credit_transactions, public.credit_reservations
  from anon, authenticated, service_role;
grant select on public.credit_accounts, public.credit_transactions, public.credit_reservations
  to authenticated, service_role;
revoke all on sequence public.credit_transactions_id_seq from anon, authenticated, service_role;

drop policy if exists credit_accounts_select on public.credit_accounts;
create policy credit_accounts_select on public.credit_accounts
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists credit_transactions_select on public.credit_transactions;
create policy credit_transactions_select on public.credit_transactions
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists credit_reservations_select on public.credit_reservations;
create policy credit_reservations_select on public.credit_reservations
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

-- The price list: every signed-in account may read it (it is what they are
-- charged); only a platform owner/admin may change it.
revoke all on public.credit_prices from anon, authenticated, service_role;
grant select on public.credit_prices to authenticated, service_role;
grant insert (unit, credits_per_unit, margin, note) on public.credit_prices to authenticated;
grant update (credits_per_unit, margin, note) on public.credit_prices to authenticated;
grant delete on public.credit_prices to authenticated;

drop policy if exists credit_prices_select on public.credit_prices;
create policy credit_prices_select on public.credit_prices
  for select to authenticated
  using ((select auth.uid()) is not null);

drop policy if exists credit_prices_insert on public.credit_prices;
create policy credit_prices_insert on public.credit_prices
  for insert to authenticated
  with check ((select public.is_platform_admin()));

drop policy if exists credit_prices_update on public.credit_prices;
create policy credit_prices_update on public.credit_prices
  for update to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

drop policy if exists credit_prices_delete on public.credit_prices;
create policy credit_prices_delete on public.credit_prices
  for delete to authenticated
  using ((select public.is_platform_admin()));

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from information_schema.tables where table_schema = 'public'
--     and table_name in ('credit_accounts','credit_transactions',
--                        'credit_reservations','credit_prices')) = 4
--     as tables_exist,
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.credit_accounts'::regclass, 'public.credit_transactions'::regclass,
--                   'public.credit_reservations'::regclass, 'public.credit_prices'::regclass))
--     as rls_enabled,
--   not has_table_privilege('authenticated', 'public.credit_accounts', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.credit_transactions', 'INSERT')
--     and not has_table_privilege('service_role', 'public.credit_transactions', 'UPDATE')
--     as ledger_not_writable_directly,
--   not has_function_privilege('authenticated',
--     'public.add_purchased_credits(uuid,numeric,text,text)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.capture_credits(text,numeric,boolean)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.release_credits(text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.reserve_credits(uuid,text,numeric)', 'EXECUTE')
--     as service_only_functions_locked,
--   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.prosecdef
--       and p.proname in ('grant_credits','add_purchased_credits','reserve_credits',
--                         'start_credit_reservation','capture_credits','release_credits',
--                         'expire_credit_reservations')
--       and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 7
--     as definer_functions_pin_search_path,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--     and table_name = 'render_jobs' and column_name = 'credit_ref')
--     as render_jobs_credit_ref,
--   (select count(*) from public.credit_accounts where balance < 0 or reserved > balance) = 0
--     as balances_consistent;
