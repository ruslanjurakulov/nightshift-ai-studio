-- 0224_dated_credit_price.sql — a credit price can be scheduled to change at an exact moment, so our price rises when the vendor's does,
-- not a day later when someone remembers.
--
-- *** LIVE ON APPLY. *** It changes NO quote by itself: it creates an empty table, and with no row in it every quote is answered
-- exactly as 0218 answers it (credits_per_unit_now returns the credit_prices rate). It sets no price: prices are the owner's. (Its two
-- inserts run only when it is applied again after its rollback, and only keep a price: a dated row at a unit's list rate where the
-- list moved past a row in force, and one at the replaced rate behind a pending row below a tenth of it.)
-- (docs/MIGRATIONS.md "Dated credit prices (0224)" has the one row for D7). The one behaviour that changes at once: none, until a
-- dated row exists; from then on, that unit's list rate can no longer be edited (the remedy is another dated row).
--
-- EVIDENCE. Google doubles gemini-3.6-flash's paid-tier rates on 2027-01-01: input $0.75 -> $1.50 and output $3.75 -> $7.50 per 1M
--   tokens ("$0.75 through December 31, 2026", "$1.50 starting January 1, 2027"; aistudio.google.com/docs/pricing, read 2026-11-22).
--   The Studio's describe tool on that model is quoted by creative_price (0218's body) from credit_prices.credits_per_unit of
--   model_gemini_3_6_flash_request (schemas/model_registry.json credit_unit). credit_prices holds one rate per unit and no date, so
--   the only way to change it at midnight was a person running an UPDATE at midnight.
-- DECISION (owner, D7, 2026-11-22): raise the customer price exactly when the cost rises, keep the model, and never sell below cost for
--   any length of time: a dated row the database reads, not a runbook step.
-- DESIGN.
--   credit_price_schedule   append-only (update, delete and truncate refused by trigger); credits_per_unit > 0; effective_at a
--     moment; reason required; created_by / created_at stamped by the database. RLS on, no policy, no privilege for anon,
--     authenticated or service_role: the owner writes it in the SQL editor, and nothing on the API can read or change it. A row is
--     accepted only for a unit creative_price reads through the schedule (a model's credit unit or a variant of it) that already has
--     a credit_prices row, and never for the base row of a model sold by variant: anything else would be a price change that
--     changes nothing.
--   credits_per_unit_now(unit)  the latest schedule row in force (effective_at <= now()), else the credit_prices rate, else null.
--     Not callable by any API role (the schedule's future rows are the owner's plans).
--   credit_prices_dated_guard  BEFORE INSERT OR UPDATE on credit_prices: a change of credits_per_unit for a unit with a dated row is
--     refused NS428 dated_price_scheduled, naming the remedy; a margin or note edit is allowed. A delete is allowed (the model is
--     then unpriced, never cheaper); the row comes back only at the rate it had (the Credits page's restore).
--   The schedule also refuses NaN and Infinity, and a rate below a tenth of the one in force (a slipped decimal point quotes 0).
--   creative_price  0218's body plus ONE line: the rate it read from credit_prices is replaced by credits_per_unit_now(rate.unit).
--     The margin, the job minimum, every refusal and the unpriced path are 0218's; the quote's credits_per_unit names the rate
--     charged. The line is byte for byte the one 0218's own 0224 branch writes (0218 + 0224 = ea2b58e88fe34ae18b261e5a0fbef435 either way).
--   What it does NOT do: price anything that is not a model's credit unit (job_minimum, video_minute, downloads, reply_draft, scene
--     and film units are read by their own functions and keep reading credit_prices); change the catalog's displayed per-unit rate
--     (sellable_models / credit_rates still read credit_prices: docs/MIGRATIONS.md "Not covered"); re-price a job already held (a job
--     quoted before effective_at keeps its hold).
--
-- REPLACES (md5 drift guard, white space folded): creative_price (0218) before 59c5c289009a874af043c534b29934ee, after ea2b58e88fe34ae18b261e5a0fbef435.
--   The lab chain: sec_db.take_off_0218 takes this file off first (0218's rollback would keep the line without 0224's guard).
-- NUMBER. 0224 (assigned by the lead for stream S10). Needs 0020 (credit_prices), 0035 (model_registry) and 0218's creative_price
--   (apply order 0208 -> 0218 -> 0224).
-- Rollback: docs/sql/rollback_0224_dated_credit_price.sql (owner-applied; puts 0218's creative_price back, keeps the table).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.credit_prices') is null or to_regclass('public.model_registry') is null then
    raise exception '0224 needs 0020 (credit_prices) and 0035 (model_registry): apply them first';
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)');
  if h is null or h <> all (array['59c5c289009a874af043c534b29934ee', 'ea2b58e88fe34ae18b261e5a0fbef435']) then
    raise exception '0224 found creative_price with a body that is neither 0218''s nor 0224''s (md5 %): read the live body first (0218 must be applied before 0224)', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The schedule
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.credit_price_schedule (
  id               bigint generated always as identity primary key,
  unit             text not null,
  credits_per_unit numeric(18,8) not null,
  effective_at     timestamptz not null,
  reason           text not null,
  created_by       text not null default session_user,
  created_at       timestamptz not null default now(),
  -- The same unit shape as credit_prices (0020), and > 0 where the price list allows 0: a dated row is a price, and a 0 would read as
  -- "free from then on", never as "not priced".
  constraint credit_price_schedule_unit_check check (unit ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint credit_price_schedule_rate_check check (credits_per_unit > 0 and credits_per_unit < 'Infinity'::numeric),
  constraint credit_price_schedule_reason_check check (char_length(btrim(reason)) between 1 and 300)
);

-- NaN sorts above every number, so "> 0" alone accepts it, and a quote would read "NaN" credits (CLAUDE.md #5). The constraint is
-- put in place again on every apply (an earlier build of this file had "> 0" only).
alter table public.credit_price_schedule drop constraint if exists credit_price_schedule_rate_check;
alter table public.credit_price_schedule add constraint credit_price_schedule_rate_check
  check (credits_per_unit > 0 and credits_per_unit < 'Infinity'::numeric and credits_per_unit <> 'NaN'::numeric);

create index if not exists credit_price_schedule_unit_idx on public.credit_price_schedule (unit, effective_at desc, id desc);

comment on table public.credit_price_schedule is
  'Dated credit prices (0224): from effective_at, credits_per_unit replaces credit_prices.credits_per_unit for unit in creative_price (credits_per_unit_now). Append-only; the owner writes it in the SQL editor; no API role reads or writes it. The margin stays credit_prices''.';

alter table public.credit_price_schedule enable row level security;
revoke all on table public.credit_price_schedule from public, anon, authenticated, service_role;
revoke all on sequence public.credit_price_schedule_id_seq from public, anon, authenticated, service_role;

create or replace function public.credit_price_schedule_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  -- Only creative_price reads the schedule (through credits_per_unit_now), and it reads it for a model's credit unit (or one of its
  -- variants, <credit_unit>_<tier|size|setting>) that already has a price-list row, whose margin it applies. A row for any other unit
  -- (job_minimum, video_minute, a download or a run unit, a unit nobody sells) would change nothing while reading as a price change:
  -- refused, with the reason.
  if not exists (select 1 from public.credit_prices cp where cp.unit = new.unit) then
    raise exception 'credit_price_schedule: % has no credit_prices row; a dated price changes an existing price, it does not open one (set the list price first, or restore a deleted one on the Credits page)', new.unit
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.model_registry r
                  where r.credit_unit is not null
                    and (new.unit = r.credit_unit or left(new.unit, length(r.credit_unit) + 1) = r.credit_unit || '_')) then
    raise exception 'credit_price_schedule: % is not a model''s credit unit; only creative_price reads a dated price', new.unit
      using errcode = '23514';
  end if;
  -- A model sold by variant is quoted at <credit_unit>_<variant>, never at its base row (creative_price's variant settings; the base
  -- row only lists it): a dated base row would change no quote. The same test creative_price uses: quality, image_size,
  -- upscale_target, audio and resolution_audio always, resolution only for a model that pins a default_resolution.
  if exists (select 1 from public.model_registry r
              where r.credit_unit = new.unit
                and (coalesce(r.spec -> 'pricing' -> 'variants' ->> 'by', '') in ('quality', 'image_size', 'upscale_target', 'audio',
                                                                                     'resolution_audio')
                     or (r.spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution'
                         and nullif(r.spec ->> 'default_resolution', '') is not null))) then
    raise exception 'credit_price_schedule: % is the base row of a model sold by variant (%); schedule each variant unit (%_<variant>) instead',
      new.unit,
      (select r.spec -> 'pricing' -> 'variants' ->> 'by' from public.model_registry r where r.credit_unit = new.unit limit 1), new.unit
      using errcode = '23514';
  end if;
  -- A rate below a tenth of the one in force is, far more often than a decision, a slipped decimal point (0.0000004 for 0.4), and a
  -- small enough one quotes 0 credits (creative_price applies job_minimum only to a price above 0): every customer would generate
  -- free. A price cut that deep is a list-price decision, made while nothing is scheduled.
  -- (The reader is dropped by the rollback, which keeps this table and its triggers: asked only while it exists.)
  if to_regprocedure('public.credits_per_unit_now(text)') is not null then
    if new.credits_per_unit < 0.1 * public.credits_per_unit_now(new.unit) then
      raise exception 'credit_price_schedule: % for % is less than a tenth of the current rate (%): check the decimal point; to lower a price by that much, change the list price before scheduling',
        new.credits_per_unit, new.unit, public.credits_per_unit_now(new.unit)
        using errcode = '23514';
    end if;
  end if;
  -- Who and when are the database's, never typed: the record of a price decision must not be one a writer can backdate.
  new.created_by := session_user;
  new.created_at := now();
  return new;
end
$$;

revoke all on function public.credit_price_schedule_guard() from public, anon, authenticated, service_role;

drop trigger if exists credit_price_schedule_guard on public.credit_price_schedule;
create trigger credit_price_schedule_guard
  before insert on public.credit_price_schedule
  for each row execute function public.credit_price_schedule_guard();

create or replace function public.credit_price_schedule_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  -- A price that was in force is what a customer was charged: rewriting or deleting the row would leave no record of why. A mistake is
  -- corrected by a new row (the same effective_at: the later row wins; a later one: from then on).
  raise exception 'credit_price_schedule is append-only: % refused; insert a correcting row instead', tg_op
    using errcode = '42501';
end
$$;

revoke all on function public.credit_price_schedule_append_only() from public, anon, authenticated, service_role;

drop trigger if exists credit_price_schedule_append_only on public.credit_price_schedule;
create trigger credit_price_schedule_append_only
  before update or delete on public.credit_price_schedule
  for each row execute function public.credit_price_schedule_append_only();
drop trigger if exists credit_price_schedule_no_truncate on public.credit_price_schedule;
create trigger credit_price_schedule_no_truncate
  before truncate on public.credit_price_schedule
  for each statement execute function public.credit_price_schedule_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The list rate of a scheduled unit is not edited behind the schedule
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_prices_dated_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  last public.credit_price_history;
begin
  -- Once a unit has a dated row (in force or pending), its list rate is no longer the whole story: editing it would either be
  -- ignored (a row in force wins) or move the price under a dated rise the owner planned against it (a pending one). The Credits page
  -- would show a figure nobody is charged. Refused, with the remedy; a margin or note edit stays allowed. SECURITY DEFINER: a
  -- platform admin's direct write runs as `authenticated`, which cannot read the schedule.
  if tg_op = 'UPDATE' then
    if new.credits_per_unit is distinct from old.credits_per_unit or new.unit is distinct from old.unit then
      if exists (select 1 from public.credit_price_schedule s where s.unit in (old.unit, new.unit)) then
        raise exception 'dated_price_scheduled: a dated price is in force or scheduled for %: add a credit_price_schedule row (effective_at = now()) instead of editing the list price', old.unit
          using errcode = 'NS428';
      end if;
    end if;
  -- A DELETE is let through: the model is then unpriced (creative_price refuses it), never sold cheaper, and an admin may take a
  -- model off sale. Its way back is a new row at the rate it had (below), which the Credits page's restore writes.
  -- An INSERT that is a new row (not the insert half of an upsert onto an existing one, which reaches the UPDATE branch) for a
  -- scheduled unit is a deleted list row put back: only at the rate it had when it was deleted (the unit's newest price-history row,
  -- written by the delete, 0107), so a delete and an insert cannot move the rate the dated row was planned against. A delete and an
  -- insert in one statement are refused too: the delete's history row is written after the statement.
  elsif tg_op = 'INSERT'
        and not exists (select 1 from public.credit_prices cp where cp.unit = new.unit)
        and exists (select 1 from public.credit_price_schedule s where s.unit = new.unit) then
    select * into last from public.credit_price_history h where h.unit = new.unit order by h.id desc limit 1;
    if last.action is distinct from 'delete' or last.old_credits_per_unit is distinct from new.credits_per_unit then
      raise exception 'dated_price_scheduled: a dated price is in force or scheduled for %: its list row can only be put back at the rate it had when it was deleted (%; the Credits page''s restore does it), then changed by a credit_price_schedule row (effective_at = now())',
        new.unit, coalesce(last.old_credits_per_unit::text, 'not recorded')
        using errcode = 'NS428';
    end if;
  end if;
  return new;
end
$$;

revoke all on function public.credit_prices_dated_guard() from public, anon, authenticated, service_role;

drop trigger if exists credit_prices_dated_guard on public.credit_prices;
create trigger credit_prices_dated_guard
  before insert or update on public.credit_prices
  for each row execute function public.credit_prices_dated_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The rate in force now
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credits_per_unit_now(p_unit text) returns numeric
  language sql stable set search_path = public, pg_temp as $$
  -- The newest decision in force wins: of the dated rows already in force, the latest effective_at (and of two at the same moment,
  -- the later row, which is how a mistaken row is corrected on an append-only table); with none, the price list's own rate; with
  -- neither, null. Never 0: an unknown price stays unknown (CLAUDE.md #5), and every caller refuses it as unpriced.
  select coalesce(
    (select s.credits_per_unit from public.credit_price_schedule s
      where s.unit = p_unit and s.effective_at <= now()
      order by s.effective_at desc, s.id desc
      limit 1),
    (select cp.credits_per_unit from public.credit_prices cp where cp.unit = p_unit));
$$;

revoke all on function public.credits_per_unit_now(text) from public, anon, authenticated, service_role;

comment on function public.credits_per_unit_now(text) is
  'The rate in force now for a unit (0224): the latest credit_price_schedule row with effective_at <= now(), else credit_prices.credits_per_unit, else null (never 0). Internal: no API role may call it.';

-- Re-applied after its rollback (which keeps the schedule's rows and its triggers, but not the reader the tenth rule asks): while
-- 0224 was off, quotes read the list only, and nothing read the schedule. Three things can then be wrong, and none may lower a price
-- or come back as a surprise. Only while creative_price is 0218's own body (0224 off): with 0224 on, a dated row above the list is the
-- rise itself. Runs before creative_price is replaced, so a run interrupted after this step finds 0224's body and skips it.
--   1. A dated row in force that the list moved past (the rollback's own advice, or a later change): a dated row at the list rate,
--      effective now, keeps the quote as it is a moment ago.
--   2. A pending row below a tenth of the rate it would replace (a slipped decimal point written while the rule was not asked; it
--      would quote 0 credits at its moment): a row at that same moment, at the rate it would replace, is added after it (the later
--      row wins at one moment), so the price never falls at that moment. The owner schedules a deliberate cut again with 0224 on.
--   3. A pending row below the list rate as it is now: kept (a decision the owner made), and named in a NOTICE to read.
do $$
declare
  r record;
  was numeric;
begin
  if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure) <> '59c5c289009a874af043c534b29934ee' then
    return;
  end if;
  for r in
    select cp.unit, cp.credits_per_unit as list_rate, s.credits_per_unit as dated_rate
      from public.credit_prices cp
      join lateral (select x.credits_per_unit from public.credit_price_schedule x
                     where x.unit = cp.unit and x.effective_at <= now()
                     order by x.effective_at desc, x.id desc limit 1) s on true
     where s.credits_per_unit is distinct from cp.credits_per_unit
  loop
    if r.list_rate < 0.1 * r.dated_rate then
      -- The schedule would refuse 0224's own row as a slipped decimal point; say so in words about this list rate, not a row the
      -- owner never typed. With 0224 off, the owner's own row at the list rate is accepted (the rule asks the reader 0224 brings).
      raise exception '0224 (applied again): % has a dated rate % in force but a list rate %, less than a tenth of it. Check the list price; if it is meant, insert a credit_price_schedule row at the list rate effective now() yourself, then apply 0224 again',
        r.unit, r.dated_rate, r.list_rate;
    end if;
    insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason)
    values (r.unit, r.list_rate, now(),
            format('0224 applied again after its rollback: the list rate %s set while it was off replaces the dated %s', r.list_rate,
                   r.dated_rate));
    raise notice '0224: % had a dated rate % in force but a list rate %; a dated row at the list rate (effective now) keeps its quote',
      r.unit, r.dated_rate, r.list_rate;
  end loop;
  for r in
    select x.id, x.unit, x.credits_per_unit, x.effective_at, cp.credits_per_unit as list_rate
      from public.credit_price_schedule x join public.credit_prices cp on cp.unit = x.unit
     where x.effective_at > now()
     order by x.effective_at, x.id
  loop
    -- The rate this row would replace at its moment: the newest row before it (an earlier moment, or the same moment written
    -- earlier), else the list.
    select coalesce((select y.credits_per_unit from public.credit_price_schedule y
                      where y.unit = r.unit and (y.effective_at, y.id) < (r.effective_at, r.id)
                      order by y.effective_at desc, y.id desc limit 1), r.list_rate) into was;
    if r.credits_per_unit < 0.1 * was then
      insert into public.credit_price_schedule (unit, credits_per_unit, effective_at, reason)
      values (r.unit, was, r.effective_at,
              format('0224 applied again: row %s (%s from %s) is below a tenth of the %s it replaces, a slipped decimal point; kept at %s',
                     r.id, r.credits_per_unit, r.effective_at, was, was));
      raise notice '0224: % has a pending dated rate % at % below a tenth of the % it replaces; a row at % at the same moment keeps the price (schedule a deliberate cut again)',
        r.unit, r.credits_per_unit, r.effective_at, was, was;
    elsif r.credits_per_unit < r.list_rate then
      raise notice '0224: % has a pending dated rate % at %, below its list rate % as it is now; it takes effect at its moment as written: read it before then',
        r.unit, r.credits_per_unit, r.effective_at, r.list_rate;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The quote: 0218's creative_price, one marked line (0224)
-- ───────────────────────────────────────────────────────────────────────────

-- 0218's quote, at the rate in force now (0224). Built as text, every backslash written as @@0224_BACKSLASH@@ and put back with chr(92), and
-- then executed: the live apply path rewrote backslash escapes in SQL text when 0218 went live, and these bytes (0218's prompt
-- regexes) must reach the database exactly as 0218 wrote them. The end state below checks the md5 of the body that results.
do $cp$
begin
  execute replace($cp0224$create or replace function public.creative_price(
  p_org uuid, p_capability text, p_model text, p_params jsonb
) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap     text := lower(btrim(coalesce(p_capability, '')));
  mdl     text := lower(btrim(coalesce(p_model, '')));
  problem text;
  m_unit  text;
  m_ent   text;
  m_spec  jsonb;
  m_found boolean := false;
  rate    public.credit_prices;
  floor_c numeric;
  qty     numeric;
  price   numeric;
  minimum numeric := 0;
  longest numeric;
  tier    text;
  vby     text;
  vres    text;
  vaud    text;
  variant jsonb := '{}'::jsonb;
  -- 0139: whether this quote is an operator preview (see creative_operator_preview).
  m_avail text;
  preview boolean := false;
  -- 0149: the vendor's figure for exactly the setting a preview is quoted at, and that figure as a number.
  vusd    jsonb;
  vcost   numeric;
  -- 0208: the picture size this quote is for (spec.pricing.variants.by = image_size).
  vsize   text;
  -- 0218: a limit from the model's spec, and the prompt's length in the worker's units.
  lim     numeric;
  units   integer;
begin
  if cap !~ '^[a-z][a-z0-9_]{0,31}$' then
    perform public.creative_refuse('invalid_params', 'capability is required');
  end if;
  if not public.creative_capability_supported(cap) then
    perform public.creative_refuse('capability_not_supported',
      format('%s cannot be generated yet on this deployment', cap));
  end if;
  if mdl !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    perform public.creative_refuse('invalid_params', 'model is required');
  end if;
  problem := public.creative_params_problem(cap, p_params);
  if problem is not null then
    perform public.creative_refuse('invalid_params', problem);
  end if;
  -- The input picture, recording or video (and an end frame) must be this
  -- organization's, live, and usable.
  problem := public.creative_source_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('source_unavailable', problem);
  end if;
  -- The style kit must be this organization's.
  problem := public.creative_style_problem(p_org, cap, p_params);
  if problem is not null then
    perform public.creative_refuse('style_unavailable', problem);
  end if;

  -- Never "allow every model" when the registry is not there (see 0036).
  if to_regclass('public.model_registry') is null then
    perform public.creative_refuse('registry_missing',
      'the model registry (migration 0035) is not applied on this deployment');
  end if;
  select true, r.credit_unit, r.entitlement, r.spec, r.availability
    into m_found, m_unit, m_ent, m_spec, m_avail
    from public.model_registry r
   where r.id = mdl
     -- 0139: or a hidden model the registry marks operator_preview, for a platform admin in the operator's own credits-exempt
     -- organization only (creative_operator_preview). Everyone else is answered exactly as before: model_not_sellable.
     and (r.availability in ('beta', 'ga') or public.creative_operator_preview(p_org, r.availability, r.spec))
     and r.verified_at is not null
     -- 0125: the same date, so a model named directly is not quoted either.
     and not public.model_past_shutdown(r.spec)
     and cap = any (r.capabilities);
  if not coalesce(m_found, false) then
    perform public.creative_refuse('model_not_sellable',
      format('%s is not available for %s', mdl, cap));
  end if;
  -- 0139: a model that is not beta or ga got here only through creative_operator_preview.
  preview := m_avail not in ('beta', 'ga');
  -- 0124: the owner temporarily switched this model (or its provider) off. Refused before anything is priced, held or charged,
  -- and never answered with another model: the person chooses. model_is_available is TRUE for every model until the switches
  -- are put in force.
  if not public.model_is_available(mdl) then
    perform public.creative_refuse('model_temporarily_off',
      format('%s is temporarily unavailable', mdl));
  end if;
  -- 0139: a plan entitlement is what a customer's plan buys; the operator's own organization has no plan, and its preview is not a sale.
  if not preview and coalesce(m_ent, 'any') not in ('any', 'paid') then
    perform public.creative_refuse('entitlement_required',
      format('%s needs the %s entitlement', mdl, m_ent));
  end if;
  if m_ent = 'paid' and not public.credits_exempt(p_org)
     and not exists (select 1 from public.credit_transactions t
                      where t.org_id = p_org and t.kind = 'purchase') then
    perform public.creative_refuse('entitlement_required',
      format('%s is available after the organization''s first credit purchase', mdl));
  end if;
  -- A factor the model was not proven (and priced) for is not sold.
  if cap = 'upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_factors') = 'array'
                      and (m_spec -> 'upscale_factors') @> (p_params -> 'factor'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %sx upscale', mdl, p_params ->> 'factor'));
  end if;
  -- Nor a language the model was not proven (and listed) for.
  if cap = 'dub'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'target_language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not dub into %s', mdl, p_params ->> 'target_language'));
  end if;
  -- Nor a spoken language the model was not proven (and listed) for. No
  -- language at all is allowed: the provider detects it.
  if cap = 'captions' and p_params ? 'language'
     and not coalesce(jsonb_typeof(m_spec -> 'languages') = 'array'
                      and (m_spec -> 'languages') @> jsonb_build_array(p_params ->> 'language'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not transcribe %s', mdl, p_params ->> 'language'));
  end if;
  -- Nor a video target the model was not proven (and listed) for.
  if cap = 'video_upscale'
     and not coalesce(jsonb_typeof(m_spec -> 'upscale_targets') = 'array'
                      and (m_spec -> 'upscale_targets') @> jsonb_build_array(p_params ->> 'target_resolution'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not upscale a video to %s', mdl, p_params ->> 'target_resolution'));
  end if;
  -- 0099: nor a shape to extend a picture to, or a light, that the model was
  -- not proven (and listed) for. A free prompt for a relight needs no list.
  if cap = 'expand'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'expand') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'expand') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not extend a picture to %s', mdl, p_params ->> 'aspect_ratio'));
  end if;
  if cap = 'relight' and p_params ? 'look'
     and not coalesce(jsonb_typeof(m_spec -> 'relight_looks') = 'array'
                      and (m_spec -> 'relight_looks') @> jsonb_build_array(p_params ->> 'look'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s light', mdl, p_params ->> 'look'));
  end if;
  -- 0100: nor a shape to reframe a video to that the model was not proven (and
  -- listed) for.
  if cap = 'video_reframe'
     and not coalesce(jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') = 'array'
                      and (m_spec -> 'aspect_ratios_by_capability' -> 'video_reframe') @> jsonb_build_array(p_params ->> 'aspect_ratio'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not reframe a video to %s', mdl, p_params ->> 'aspect_ratio'));
  end if;
  -- 0155: nor any shape the model does not list for this capability: spec.aspect_ratios_by_capability[cap] when it names
  -- some, else spec.aspect_ratios, the same list the worker checks before it calls the vendor (ModelEntry.aspects_for). An
  -- empty list is a model that makes its own shape, so any shape is refused. Refused here, before anything is held, rather
  -- than by the worker after the job was queued. Each branch casts nothing: the CASE decides the order, not an `and`.
  if p_params ? 'aspect_ratio'
     and not coalesce(case
                        when jsonb_typeof(m_spec -> 'aspect_ratios_by_capability' -> cap) = 'array'
                             and m_spec -> 'aspect_ratios_by_capability' -> cap <> '[]'::jsonb
                          then (m_spec -> 'aspect_ratios_by_capability' -> cap) @> jsonb_build_array(p_params ->> 'aspect_ratio')
                        when jsonb_typeof(m_spec -> 'aspect_ratios') = 'array'
                          then (m_spec -> 'aspect_ratios') @> jsonb_build_array(p_params ->> 'aspect_ratio')
                      end, false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s shape for %s', mdl, p_params ->> 'aspect_ratio', cap));
  end if;
  -- 0159: nor a clip length the model does not list (spec.durations_s), the list the worker checks before it calls the vendor
  -- (ModelEntry.problems: "duration <n>s is not offered by <model>"). A spec with no list, or an empty one, refuses every length (never
  -- "any length is fine"). Only when the request names one: creative_params_problem requires it for t2v, i2v, sfx and music and refuses
  -- it on every other tool. Refused here, before anything is held, rather than by the worker after the job was queued.
  if p_params ? 'duration_s'
     and not coalesce(jsonb_typeof(m_spec -> 'durations_s') = 'array'
                      and (m_spec -> 'durations_s') @> jsonb_build_array(p_params -> 'duration_s'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer a %s-second clip for %s', mdl, p_params ->> 'duration_s', cap));
  end if;
  -- Nor an ending on a model that would drop it.
  if p_params ? 'end_asset_id' and coalesce(m_spec -> 'end_frame', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('invalid_params',
      format('%s cannot end a clip on a chosen picture', mdl));
  end if;
  -- 0218: nor a setting the model's adapter would drop, nor a prompt longer than the model takes. Before 0218 each was quoted, held and
  -- queued, and then either refused by the worker after the hold (the length) or sent without the setting while the person paid for
  -- it (CLAUDE.md #4). Refused here, before anything is held, on every path that prices through this function (the Studio, the API,
  -- MCP, the router, Film).
  -- A seed never gets here: creative_params_problem refuses it, seed_not_supported, before any model is read (and before routing).
  -- A negative prompt only for a model whose adapter puts it in the vendor's request: the registry's takes_negative_prompt, which the
  -- sync copies into spec and modules/model_registry.py checks against the adapter. No statement = does not take one. Blank text is no
  -- negative prompt: only white space, every character Python's str.strip() removes (the worker's test), counts as blank.
  if coalesce(p_params ->> 'negative_prompt', '') ~ '[^@@0224_BACKSLASH@@t@@0224_BACKSLASH@@n@@0224_BACKSLASH@@u000b@@0224_BACKSLASH@@f@@0224_BACKSLASH@@r@@0224_BACKSLASH@@u001c-@@0224_BACKSLASH@@u001f @@0224_BACKSLASH@@u0085@@0224_BACKSLASH@@u00a0@@0224_BACKSLASH@@u1680@@0224_BACKSLASH@@u2000-@@0224_BACKSLASH@@u200a@@0224_BACKSLASH@@u2028@@0224_BACKSLASH@@u2029@@0224_BACKSLASH@@u202f@@0224_BACKSLASH@@u205f@@0224_BACKSLASH@@u3000]'
     and coalesce(m_spec -> 'takes_negative_prompt', 'false'::jsonb) <> 'true'::jsonb then
    perform public.creative_refuse('negative_prompt_not_supported',
      format('%s does not take a negative prompt; remove it or choose a model that does', mdl), 'NS400');
  end if;
  -- The prompt against the model's own limits.max_prompt_chars, in UTF-16 code units, the worker's unit (model_registry.prompt_units):
  -- one per character, two for a character outside the Basic Multilingual Plane (an emoji). A spec that states no positive number is
  -- held to creative_params_problem's 4000 only (every registry entry states one; the Verify block lists any row that does not).
  lim := case when jsonb_typeof(m_spec -> 'limits' -> 'max_prompt_chars') = 'number'
              then (m_spec -> 'limits' ->> 'max_prompt_chars')::numeric end;
  if lim > 0 and jsonb_typeof(p_params -> 'prompt') = 'string' then
    units := 2 * char_length(p_params ->> 'prompt')
             - char_length(regexp_replace(p_params ->> 'prompt', '[@@0224_BACKSLASH@@U00010000-@@0224_BACKSLASH@@U0010FFFF]', '', 'g'));
    if units > lim then
      perform public.creative_refuse('prompt_too_long',
        format('%s character%s over this model''s limit of %s; shorten the prompt', units - lim,
               case when units - lim = 1 then '' else 's' end, lim), 'NS400');
    end if;
  end if;
  -- The negative prompt against limits.max_negative_prompt_chars where the adapter has one of its own (Krea: 1024), in characters
  -- (code points), the way that adapter counts it.
  lim := case when jsonb_typeof(m_spec -> 'limits' -> 'max_negative_prompt_chars') = 'number'
              then (m_spec -> 'limits' ->> 'max_negative_prompt_chars')::numeric end;
  if lim > 0 and char_length(p_params ->> 'negative_prompt') > lim then
    perform public.creative_refuse('prompt_too_long',
      format('%s character%s over this model''s limit of %s for a negative prompt; shorten it',
             char_length(p_params ->> 'negative_prompt') - lim,
             case when char_length(p_params ->> 'negative_prompt') - lim = 1 then '' else 's' end, lim), 'NS400');
  end if;

  -- A quality the model does not offer is refused, never ignored: the
  -- provider would bill its own default under the quoted price (0060).
  if p_params ? 'quality'
     and not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                      and (m_spec -> 'qualities') @> jsonb_build_array(p_params ->> 'quality'), false) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s quality', mdl, p_params ->> 'quality'));
  end if;

  -- One price per target when the registry prices the targets apart
  -- (model_registry.credit_unit_for): a target without its own row is
  -- unpriced, never sold at another target's rate.
  if cap = 'video_upscale' and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'upscale_target' then
    m_unit := m_unit || '_' || regexp_replace(lower(p_params ->> 'target_resolution'), '[^a-z0-9]', '_', 'g');
  end if;
  -- One price per quality tier when the registry prices the tiers apart
  -- (model_registry.credit_unit_for: model_<id>_<unit>_<tier>). No tier named
  -- = medium, the same tier the worker sends; a tier without its own row is
  -- unpriced, never sold at another tier's rate and never at 0.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' then
    tier := coalesce(p_params ->> 'quality', 'medium');
    if not coalesce(jsonb_typeof(m_spec -> 'qualities') = 'array'
                    and (m_spec -> 'qualities') @> jsonb_build_array(tier), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer the %s quality', mdl, tier));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(tier), '[^a-z0-9]', '_', 'g');
  end if;
  -- 0208: a picture size only on a model whose price follows it (spec.pricing.variants.by = image_size) and that lists the size
  -- (spec.image_sizes, the list the worker checks: ModelEntry.problems "image size <s> is not offered by <model>"). On any other
  -- model the size would reach a vendor that bills its own way under a price that was not read for it: refused, never ignored.
  if p_params ? 'image_size'
     and (coalesce(m_spec -> 'pricing' -> 'variants' ->> 'by', '') <> 'image_size'
          or not coalesce(jsonb_typeof(m_spec -> 'image_sizes') = 'array'
                          and (m_spec -> 'image_sizes') @> jsonb_build_array(p_params ->> 'image_size'), false)) then
    perform public.creative_refuse('invalid_params',
      format('%s does not offer the %s size', mdl, p_params ->> 'image_size'));
  end if;
  -- 0208: one price per size when the registry prices the sizes apart (model_registry.credit_unit_for: model_<id>_<unit>_<size>).
  -- The size must be named: the worker sends it as the vendor's imageSize, and with none the vendor makes (and bills) its own
  -- default under a price read for no size. A size without its own row is unpriced: never another size's rate, never the base row.
  if cap in ('t2i', 'edit') and m_unit is not null
     and m_spec -> 'pricing' -> 'variants' ->> 'by' = 'image_size' then
    vsize := p_params ->> 'image_size';
    if vsize is null then
      perform public.creative_refuse('invalid_params',
        format('%s is sold by picture size: name image_size', mdl));
    end if;
    m_unit := m_unit || '_' || regexp_replace(lower(vsize), '[^a-z0-9]', '_', 'g');
  end if;
  -- The video settings (0070).
  if cap in ('t2v', 'i2v') then
    vby := m_spec -> 'pricing' -> 'variants' ->> 'by';
    -- A resolution the model does not list is refused, never ignored: the
    -- vendor would render (and bill) something else under the quoted price.
    if p_params ? 'resolution'
       and not coalesce(jsonb_typeof(m_spec -> 'resolutions') = 'array'
                        and (m_spec -> 'resolutions') @> jsonb_build_array(p_params ->> 'resolution'), false) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer %s', mdl, p_params ->> 'resolution'));
    end if;
    -- A soundtrack choice only on a model that prices it apart (the worker
    -- sends the flag for no other), and only if it makes sound at all.
    if p_params ? 'audio'
       and (coalesce(vby, '') not in ('audio', 'resolution_audio')
            or coalesce(m_spec -> 'audio_out', 'false'::jsonb) <> 'true'::jsonb) then
      perform public.creative_refuse('invalid_params',
        format('%s does not offer a choice of sound', mdl));
    end if;
    -- One price per setting when the registry prices the settings apart
    -- (model_registry.credit_unit_for: model_<id>_<unit>_<resolution>_<silent|audio>).
    -- No resolution named = the model's pinned one and no audio = silent, the
    -- same the worker sends. A resolution variant counts only for a model that
    -- pins one (Veo and Wan 3.0 are still sold by their base row). A setting
    -- without its own row is unpriced, never another setting's rate, never 0.
    if m_unit is not null
       and (coalesce(vby, '') in ('audio', 'resolution_audio')
            or (coalesce(vby, '') = 'resolution' and nullif(m_spec ->> 'default_resolution', '') is not null)) then
      if vby in ('resolution', 'resolution_audio') then
        vres := coalesce(p_params ->> 'resolution', nullif(m_spec ->> 'default_resolution', ''));
        if vres is null then
          perform public.creative_refuse('unpriced',
            format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
        end if;
      end if;
      if vby in ('audio', 'resolution_audio') then
        vaud := case when coalesce((p_params ->> 'audio')::boolean, false) then 'audio' else 'silent' end;
      end if;
      m_unit := m_unit || '_' || regexp_replace(lower(concat_ws('_', vres, vaud)), '[^a-z0-9]', '_', 'g');
      variant := jsonb_strip_nulls(jsonb_build_object(
        'resolution', vres, 'audio', case when vaud is null then null else vaud = 'audio' end));
    end if;
  end if;
  -- 0156: creative_params_problem now takes every resolution name the registry can list, and the video settings above refused one the
  -- model does not list. A name it refused before 0156 (anything but 480p 540p 720p 1080p 1440p 2160p) is sold ONLY at its own
  -- variant's price, the unit model_<id>_<unit>_<resolution> the settings above chose: never by a base row whose figure was read for
  -- another resolution (Veo 3.1 pins no resolution, so 0070 sells it by its base row, and its 4k costs the vendor more), never at one
  -- flat price, never on a capability that has no resolution variants. Refused before any rate is read, the preview's included.
  if p_params ? 'resolution' and (p_params ->> 'resolution') !~ '^(480|540|720|1080|1440|2160)p$'
     and not (variant ? 'resolution') then
    if cap not in ('t2v', 'i2v') then
      perform public.creative_refuse('invalid_params', format('%s does not offer %s', mdl, p_params ->> 'resolution'));
    end if;
    perform public.creative_refuse('unpriced',
      format('%s is not sold at %s yet: that resolution has no price of its own', mdl, p_params ->> 'resolution'));
  end if;
  if m_unit is not null then
    select * into rate from public.credit_prices where unit = m_unit;
    rate.credits_per_unit := public.credits_per_unit_now(rate.unit);  -- 0224: a dated price (credit_price_schedule) once it is in force
  end if;
  -- 0139: a preview with no credit price is priced at the vendor's own cost (1 credit = 1 US cent, the convention of
  -- docs/sql/prices_2026_10_01.sql, no margin) from the reviewed registry figure, for the job's record only: the exempt
  -- organization holds and pays nothing (reserve_credits answers exempt). No credit_prices row is written, so nothing goes on
  -- sale. A figure the registry does not state stays unpriced.
  -- 0149: the figure is the one for exactly what is quoted. A model without variants states one (provider_usd_per_unit). A
  -- model priced by resolution states one per resolution (pricing.variants.prices), and the figure is vres's: the resolution the
  -- video settings above settled on (the request's, else the model's pinned default_resolution), which the job then carries and
  -- the worker sends. A resolution without its own figure is unpriced: never another resolution's figure, never
  -- provider_usd_per_unit. Any other variants.by (audio, resolution_audio, upscale_target ...) stays unpriced.
  -- 0153: a model priced by quality states one figure per tier (pricing.variants.prices), and the figure is tier's: the tier the
  -- quality settings above settled on (the request's, else medium when it names none), the one the quote names, the job carries and
  -- the worker sends. A tier without its own figure is unpriced: never another tier's figure, never provider_usd_per_unit.
  if preview and m_unit is not null and rate.unit is null
     and jsonb_typeof(m_spec -> 'pricing') = 'object' then
    vusd := case
              when not (m_spec -> 'pricing' ? 'variants') then m_spec -> 'pricing' -> 'provider_usd_per_unit'
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'resolution' and vres is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> vres
              when m_spec -> 'pricing' -> 'variants' ->> 'by' = 'quality' and tier is not null
                then m_spec -> 'pricing' -> 'variants' -> 'prices' -> tier
            end;
    -- A figure that is not a JSON number is never cast: the CASE decides the order, not an `and`.
    vcost := case when jsonb_typeof(vusd) = 'number' then (vusd #>> '{}')::numeric end;
    if vcost > 0 and vcost <= 100 then
      rate.unit := m_unit;
      rate.credits_per_unit := vcost * 100;
      rate.margin := 0;
    end if;
  end if;
  if m_unit is null or rate.unit is null then
    perform public.creative_refuse('unpriced',
      format('%s has no credit price yet; a platform admin sets it on the Credits page', mdl));
  end if;

  if cap in ('voice_change', 'dub', 'video_upscale', 'captions', 'video_edit', 'video_reframe', 'video_remove_bg') then
    -- The file's measured length, from the database — never the client's.
    qty := public.creative_source_seconds(p_org, p_params);
  else
    qty := public.creative_quantity(cap, p_params);
  end if;
  if qty is null or qty <= 0 then
    -- Unknown is never priced as 0 (CLAUDE.md #5).
    perform public.creative_refuse('source_unavailable', 'the length of the source is not known, so it cannot be priced');
  end if;
  if cap = 'video_upscale' then
    -- The vendor's longest input, as the registry states it: a model that
    -- states none is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model upscales videos of up to %s seconds; trim this one first', longest));
    end if;
  end if;
  if cap in ('video_edit', 'video_reframe', 'video_remove_bg') then
    -- 0100: the same rule as the upscale's, in the video ops' own words: a model
    -- that states no longest input is not sold a length it may refuse after the hold.
    longest := case when jsonb_typeof(m_spec -> 'limits' -> 'max_source_seconds') = 'number'
                    then (m_spec -> 'limits' ->> 'max_source_seconds')::numeric end;
    if longest is null or longest <= 0 then
      perform public.creative_refuse('model_not_sellable',
        format('%s does not state the longest video it takes', mdl));
    end if;
    if qty > longest then
      perform public.creative_refuse('source_unavailable',
        format('this model takes videos of up to %s seconds; trim this one first', longest));
    end if;
  end if;
  -- Rounded to 6 places before the upward cent, so numeric division noise
  -- never adds a cent (0030 does the same).
  price := public.credits_round_up(round(qty * rate.credits_per_unit * (1 + rate.margin), 6));
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null then
    minimum := public.credits_round_up(floor_c);
  end if;
  if price > 0 then
    price := greatest(price, minimum);
  end if;

  return jsonb_build_object(
    'credits', price, 'exempt', public.credits_exempt(p_org),
    'model', mdl, 'capability', cap, 'unit', rate.unit, 'quantity', qty,
    -- 0084: the rate as charged, never the platform's base rate and margin
    -- apart (every quote, the API's and the routed ones included).
    'credits_per_unit', rate.credits_per_unit * (1 + rate.margin), 'minimum', minimum)
    -- The tier this price is for, so what the person confirms names it.
    || case when tier is null then '{}'::jsonb else jsonb_build_object('quality', tier) end
    -- 0208: the picture size this price is for.
    || case when vsize is null then '{}'::jsonb else jsonb_build_object('image_size', vsize) end
    -- The resolution and soundtrack this price is for (0070).
    || variant
    -- 0139: a preview says so, and the Studio shows it as the operator's record, never as a price on sale.
    || case when preview then jsonb_build_object('preview', true) else '{}'::jsonb end;
end
$$$cp0224$, '@@0224_BACKSLASH@@', chr(92));
end
$cp$;

revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_price(uuid, text, text, jsonb)'::regprocedure) <> 'ea2b58e88fe34ae18b261e5a0fbef435' then
    raise exception '0224 end state: creative_price is not 0224''s body';
  end if;
  if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.credits_per_unit_now(text)'::regprocedure) <> 'd683e2464cc9d9651fe075acc77b2ef9' then
    raise exception '0224 end state: credits_per_unit_now is not 0224''s body';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.credit_price_schedule'::regclass) then
    raise exception '0224 end state: credit_price_schedule has no row level security';
  end if;
  for r in select * from unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_table_privilege(r.role_, 'public.credit_price_schedule', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_function_privilege(r.role_, 'public.credits_per_unit_now(text)', 'EXECUTE')
       or has_function_privilege(r.role_, 'public.creative_price(uuid, text, text, jsonb)', 'EXECUTE') then
      raise exception '0224 end state: % can reach the schedule, its reader or creative_price', r.role_;
    end if;
  end loop;
  if (select count(*) from pg_trigger
       where tgrelid = 'public.credit_price_schedule'::regclass and not tgisinternal and tgenabled = 'O'
         and tgname in ('credit_price_schedule_guard', 'credit_price_schedule_append_only', 'credit_price_schedule_no_truncate')) <> 3 then
    raise exception '0224 end state: credit_price_schedule is missing an enabled guard, append-only or truncate trigger';
  end if;
  if not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                  where t.tgrelid = 'public.credit_prices'::regclass and t.tgname = 'credit_prices_dated_guard'
                    and p.proname = 'credit_prices_dated_guard' and p.prosecdef and not t.tgisinternal and t.tgenabled = 'O') then
    raise exception '0224 end state: credit_prices has no enabled SECURITY DEFINER credit_prices_dated_guard trigger';
  end if;
  -- Nothing priced is null, never 0 (no table row is written: a unit no row can have).
  if public.credits_per_unit_now('zz_0224_no_such_unit') is not null then
    raise exception '0224 end state: an unpriced unit did not read as null';
  end if;
end $$;

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--       where oid = 'public.creative_price(uuid,text,text,jsonb)'::regprocedure) = 'ea2b58e88fe34ae18b261e5a0fbef435' as creative_price_0224,
--     (select relrowsecurity from pg_class where oid = 'public.credit_price_schedule'::regclass) as schedule_rls_on,
--     not has_table_privilege('authenticated', 'public.credit_price_schedule', 'SELECT') as members_cannot_read,
--     not has_function_privilege('authenticated', 'public.credits_per_unit_now(text)', 'EXECUTE') as members_cannot_ask,
--     exists (select 1 from pg_trigger where tgrelid = 'public.credit_prices'::regclass and tgname = 'credit_prices_dated_guard') as list_guard,
--     public.credits_per_unit_now('zz_0224_no_such_unit') is null as unknown_is_null;
--   -- And what each scheduled unit is quoted at now, beside the price list:
--   select s.unit, cp.credits_per_unit as list_rate, public.credits_per_unit_now(s.unit) as rate_now, max(s.effective_at) as last_change
--     from public.credit_price_schedule s join public.credit_prices cp using (unit) group by s.unit, cp.credits_per_unit;
