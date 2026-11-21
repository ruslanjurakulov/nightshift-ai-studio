-- 0021_credit_refunds.sql — buying credits with Paddle (SaaS phase C4): the
-- webhook's audit trail, and taking credits back when a purchase is refunded
-- or charged back.
--
-- Purchases themselves need nothing new: the Paddle webhook (the Supabase Edge
-- Function supabase/functions/paddle-webhook) credits them through 0020's
-- add_purchased_credits(), idempotent on the Paddle transaction id.
--
-- WHAT IT ADDS
--   payment_events   one row per webhook event the platform received from a
--                    payment provider (only 'paddle' today): which event, what
--                    was decided (processed | duplicate | ignored | rejected |
--                    failed) and why, and — for a purchase — the organization,
--                    the credits and the amount paid (the refund path needs
--                    that amount to take back a PARTIAL refund in proportion).
--                    Ids and numbers only: no name, no email, no address, no
--                    raw payload. No card data ever reaches the platform —
--                    Paddle's own checkout collects it.
--   credit_refunds   one row per refund or chargeback of a purchase: what was
--                    asked back, what was actually taken, and the SHORTFALL.
--                    Append-only.
--   record_payment_event(...)      service role only; upsert by (provider,
--                                  event_id) that never downgrades a settled
--                                  outcome back to 'failed'
--   refund_purchased_credits(external_id, refund_id, amount, note, reason)
--                                  service role only; idempotent on refund_id
--
-- A REFUND NEVER MAKES A BALANCE NEGATIVE — the shortfall is recorded instead.
-- 0020 guarantees balance >= 0 and reserved <= balance with CHECK constraints
-- that every reader relies on, and reserve_credits()/add_purchased_credits()
-- know nothing about debt. Carrying a debt would mean changing both of them
-- (not additive) and silently eating the next purchase. So a refund takes back
-- at most what is AVAILABLE (balance - reserved: credits on hold belong to a
-- run already in progress), and the part it could not take — credits already
-- spent on videos — is written to credit_refunds.shortfall and into the ledger
-- note, in plain numbers. That is the operator's list to act on (a chargeback
-- with a shortfall is money lost; decide whether to suspend the organization):
--     select * from public.credit_refunds where shortfall > 0 order by created_at desc;
--
-- Refunds of one purchase can never add up to more than the purchase: a
-- second partial refund takes back at most what the first one left.
--
-- WHO MAY DO WHAT: the service role (the webhook) and a direct SQL-editor
-- session only. Browsers (anon, authenticated) get nothing — not a row, not a
-- function. The organization sees a refund as a 'refund' row in its ledger
-- (credit_transactions, readable by its viewers since 0020).
--
-- Additive and idempotent: guarded creates, drop-then-create triggers and
-- policies, create-or-replace functions. Safe to re-run. Nothing is dropped,
-- and nothing in 0020 is changed.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.payment_events (
  provider       text not null,
  event_id       text not null,
  event_type     text not null,
  occurred_at    timestamptz,
  status         text not null,
  detail         text,
  org_id         uuid references public.organizations (id) on delete restrict,
  transaction_id text,
  adjustment_id  text,
  credits        numeric(14,2),
  currency       text,
  amount_minor   bigint,
  received_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (provider, event_id)
);

alter table public.payment_events drop constraint if exists payment_events_provider_check;
alter table public.payment_events add constraint payment_events_provider_check
  check (provider in ('paddle'));
alter table public.payment_events drop constraint if exists payment_events_ids_check;
alter table public.payment_events add constraint payment_events_ids_check
  check (length(event_id) between 1 and 200
         and length(event_type) between 1 and 100
         and (transaction_id is null or length(transaction_id) between 1 and 200)
         and (adjustment_id is null or length(adjustment_id) between 1 and 200));
alter table public.payment_events drop constraint if exists payment_events_status_check;
alter table public.payment_events add constraint payment_events_status_check
  check (status in ('processed', 'duplicate', 'ignored', 'rejected', 'failed'));
alter table public.payment_events drop constraint if exists payment_events_detail_check;
alter table public.payment_events add constraint payment_events_detail_check
  check (detail is null or length(detail) <= 500);
alter table public.payment_events drop constraint if exists payment_events_money_check;
alter table public.payment_events add constraint payment_events_money_check
  check ((credits is null or credits >= 0)
         and (amount_minor is null or amount_minor >= 0)
         and (currency is null or currency ~ '^[A-Z]{3}$'));

create index if not exists payment_events_transaction_idx
  on public.payment_events (provider, transaction_id) where transaction_id is not null;
create index if not exists payment_events_attention_idx
  on public.payment_events (received_at desc) where status in ('rejected', 'failed');

comment on table public.payment_events is
  'Webhook events received from a payment provider (migration 0021), one row per event id: the outcome and why. rejected = paid but not credited (unknown organization or price) — needs a person; failed = will be retried by the provider. Ids and amounts only; no personal or card data.';
comment on column public.payment_events.amount_minor is
  'For a purchase: the grand total paid, in the currency''s lowest denomination (cents). A partial refund takes back credits in proportion to it.';

create table if not exists public.credit_refunds (
  refund_id            text primary key,
  purchase_external_id text not null,
  org_id               uuid not null references public.organizations (id) on delete restrict,
  reason               text not null default 'refund',
  requested            numeric(14,2) not null,
  taken                numeric(14,2) not null,
  shortfall            numeric(14,2) not null,
  transaction_id       bigint references public.credit_transactions (id) on delete restrict,
  note                 text,
  created_at           timestamptz not null default now()
);

alter table public.credit_refunds drop constraint if exists credit_refunds_ids_check;
alter table public.credit_refunds add constraint credit_refunds_ids_check
  check (length(refund_id) between 1 and 200 and length(purchase_external_id) between 1 and 200);
alter table public.credit_refunds drop constraint if exists credit_refunds_reason_check;
alter table public.credit_refunds add constraint credit_refunds_reason_check
  check (reason in ('refund', 'chargeback'));
alter table public.credit_refunds drop constraint if exists credit_refunds_amounts_check;
alter table public.credit_refunds add constraint credit_refunds_amounts_check
  check (requested >= 0 and taken >= 0 and shortfall >= 0 and taken + shortfall = requested);
alter table public.credit_refunds drop constraint if exists credit_refunds_note_check;
alter table public.credit_refunds add constraint credit_refunds_note_check
  check (note is null or length(note) <= 500);

create index if not exists credit_refunds_purchase_idx
  on public.credit_refunds (purchase_external_id);
create index if not exists credit_refunds_shortfall_idx
  on public.credit_refunds (created_at desc) where shortfall > 0;

comment on table public.credit_refunds is
  'Refunds and chargebacks of credit purchases (migration 0021). requested = credits the refund stands for; taken = credits actually removed from the balance; shortfall = credits already spent that could not be taken back (the balance never goes negative). Append-only.';

-- Append-only, for the same reason as the ledger: a correction is a new,
-- visible row, never a rewritten one.
create or replace function public.credit_refunds_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'credit_refunds is append-only' using errcode = '42501';
end
$$;

drop trigger if exists credit_refunds_append_only on public.credit_refunds;
create trigger credit_refunds_append_only
  before update or delete on public.credit_refunds
  for each row execute function public.credit_refunds_append_only();

drop trigger if exists credit_refunds_no_truncate on public.credit_refunds;
create trigger credit_refunds_no_truncate
  before truncate on public.credit_refunds
  for each statement execute function public.credit_refunds_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. record_payment_event — the webhook's audit write
-- ───────────────────────────────────────────────────────────────────────────
-- An event is recorded once and its outcome may move forward (a 'failed'
-- delivery that the provider retries becomes 'processed'), never back: a late
-- retry that fails for a transient reason must not make a credited purchase
-- look uncredited. Returns the status the row holds afterwards.

create or replace function public.record_payment_event(
  p_provider text, p_event_id text, p_event_type text, p_occurred_at timestamptz,
  p_status text, p_detail text default null, p_org uuid default null,
  p_transaction_id text default null, p_adjustment_id text default null,
  p_credits numeric default null, p_currency text default null, p_amount_minor bigint default null
) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  cur text;
  org uuid := p_org;
begin
  if not public.credits_trusted_caller() then
    raise exception 'payment events are recorded by the platform only' using errcode = '42501';
  end if;
  -- The event names an organization the payer sent us; one that does not
  -- exist is recorded as no organization rather than failing the audit row.
  if org is not null and not exists (select 1 from public.organizations where id = org) then
    org := null;
  end if;

  select status into cur from public.payment_events
   where provider = p_provider and event_id = p_event_id
   for update;
  if not found then
    insert into public.payment_events
      (provider, event_id, event_type, occurred_at, status, detail, org_id,
       transaction_id, adjustment_id, credits, currency, amount_minor)
    values
      (p_provider, p_event_id, p_event_type, p_occurred_at, p_status,
       left(nullif(btrim(coalesce(p_detail, '')), ''), 500), org,
       p_transaction_id, p_adjustment_id, p_credits, upper(p_currency), p_amount_minor);
    return p_status;
  end if;

  if cur <> 'failed' then
    return cur;
  end if;
  update public.payment_events
     set status = p_status,
         detail = left(nullif(btrim(coalesce(p_detail, '')), ''), 500),
         org_id = coalesce(org, org_id),
         transaction_id = coalesce(p_transaction_id, transaction_id),
         adjustment_id = coalesce(p_adjustment_id, adjustment_id),
         credits = coalesce(p_credits, credits),
         currency = coalesce(upper(p_currency), currency),
         amount_minor = coalesce(p_amount_minor, amount_minor),
         updated_at = now()
   where provider = p_provider and event_id = p_event_id;
  return p_status;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. refund_purchased_credits — take a refunded purchase's credits back
-- ───────────────────────────────────────────────────────────────────────────
-- p_external_id  the purchase's external_id in credit_transactions (the Paddle
--                transaction id add_purchased_credits recorded)
-- p_refund_id    the refund's own id (the Paddle adjustment id): the
--                idempotency key, and the ledger row's external_id
-- p_amount       credits the refund stands for; null = everything this
--                purchase has not already had refunded (a full refund)
-- p_reason       'refund' or 'chargeback'
--
-- Idempotent: the same refund_id again returns the first answer and changes
-- nothing; the same refund_id for a different purchase is a conflict.

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
   where external_id = ext and kind = 'purchase';
  if not found then
    raise exception 'no purchase recorded for this external_id' using errcode = 'P0002';
  end if;

  -- Lock the account first (the order every 0020 function uses), then look:
  -- a concurrent delivery of the same refund waits here and finds the row.
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
  -- To the cent, rounded half up: a refund is the customer's money, so this
  -- rounding neither favours the platform (up) nor the customer (down).
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

  -- The ledger row is written even when nothing could be taken (amount 0):
  -- the organization's history must show that the purchase was refunded.
  txn := public.credit_log(purchase.org_id, 'refund', -taken, null, rid, msg);
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
-- 4. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────
-- Supabase's default privileges hand every new table and function to anon and
-- authenticated; each is narrowed explicitly here.

revoke all on function public.credit_refunds_append_only() from public, anon, authenticated;
revoke all on function public.record_payment_event(text, text, text, timestamptz, text, text, uuid, text, text, numeric, text, bigint)
  from public, anon, authenticated;
revoke all on function public.refund_purchased_credits(text, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.record_payment_event(text, text, text, timestamptz, text, text, uuid, text, text, numeric, text, bigint)
  to service_role;
grant execute on function public.refund_purchased_credits(text, text, numeric, text, text)
  to service_role;

alter table public.payment_events enable row level security;
alter table public.credit_refunds enable row level security;

-- Written only through the functions above; readable by the webhook (it looks
-- up an earlier purchase to size a partial refund) and the SQL editor. No
-- policy for authenticated: with RLS on and no policy, a browser sees nothing
-- even if a grant were ever added by mistake.
revoke all on public.payment_events, public.credit_refunds from anon, authenticated, service_role;
grant select on public.payment_events, public.credit_refunds to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from information_schema.tables where table_schema = 'public'
--     and table_name in ('payment_events', 'credit_refunds')) = 2
--     as tables_exist,
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.payment_events'::regclass, 'public.credit_refunds'::regclass))
--     as rls_enabled,
--   not has_table_privilege('authenticated', 'public.payment_events', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.credit_refunds', 'SELECT')
--     and not has_table_privilege('anon', 'public.payment_events', 'SELECT')
--     and not has_table_privilege('service_role', 'public.credit_refunds', 'INSERT')
--     as tables_not_writable_directly,
--   not has_function_privilege('authenticated',
--     'public.refund_purchased_credits(text,text,numeric,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon',
--     'public.record_payment_event(text,text,text,timestamptz,text,text,uuid,text,text,numeric,text,bigint)', 'EXECUTE')
--     and has_function_privilege('service_role',
--     'public.refund_purchased_credits(text,text,numeric,text,text)', 'EXECUTE')
--     as service_only_functions,
--   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.prosecdef
--       and p.proname in ('record_payment_event', 'refund_purchased_credits')
--       and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 2
--     as definer_functions_pin_search_path;
