-- 0167_refund_hold_recovery.sql — a refund that meets a hold takes those credits back when the hold is released, so a buyer can no
-- longer keep refunded credits by holding them first (Breach BR-0034-01). docs/MIGRATIONS.md "0167". LIVE ON APPLY: it replaces one live
-- function and adds one trigger on credit_transactions; read "WHAT TO VERIFY BEFORE YOU APPLY" below first.
--
-- WHY. refund_purchased_credits (0021, body of 0034) takes back at most what is AVAILABLE (balance - reserved) and records the rest as
-- a shortfall, for good. 0021 called that part "credits already spent". It is not, when it sits on a hold: a hold is not spending.
-- A workspace owner or admin can call reserve_credits from the browser for everything available, then have the payment refunded:
-- the refund takes 0, and three hours later the unstarted hold is released (expire_credit_reservations, or lazily by the next
-- reserve_credits). The buyer had the money back AND the credits. In the lab: a 1000-credit pack refunded in full left a balance of
-- 1100 where it should have been 100 (tests/security/test_sec_breach_refund_hold.py).
--
-- THE DESIGN: the held part of a shortfall stays OPEN and is collected when those holds are released. Chosen over "the refund releases
-- unstarted holds" because that one still leaks: a STARTED hold the run then releases (a run that fails after it began, or one that
-- never settles in 24 hours) would give the credits back just the same, and it cancels a queued run the person did not cancel. Here no
-- run is touched: a hold still settles as it would have. What it settles to decides:
--   * released (expired, failed, cancelled, or the unused part of a capture): the released credits were never spent, so the refund
--     takes them now, up to what it still has open. One 'refund' ledger row per collection, which spends the refunded purchase's own
--     lot first (the same nightshift.refund_of rule as the refund itself).
--   * captured: that is real spending. Nothing is collected; the shortfall stands as 0021 recorded it.
-- What may be collected is bounded three ways, so this never takes what the refund was not owed and never makes a balance negative:
--   owed      = least(the refund's shortfall, what was on hold when it was recorded) — never more than the refund asked for;
--   per hold  = only holds that were OPEN when the refund was recorded (a hold placed later, on credits bought later, is never touched,
--               so a refund does not eat the next purchase — 0021's reason for not carrying a debt still holds);
--   per row   = least(what is still owed, what this release gave back, what is available right now).
--
-- WHAT THIS ADDS
--   credit_refund_recoveries   one row per refund whose shortfall met open holds: the refund, its purchase, the organization, the job
--                              ids of the holds open at that moment, `owed`, `collected` (taken back by a ledger row) and `lapsed` (the
--                              refunded purchase's own credits that expired while on the hold: gone from the buyer as the refund meant,
--                              with no collection), 0 <= collected + lapsed <= owed. Written only by refund_purchased_credits (insert)
--                              and credit_refund_recover (collected and lapsed go up); a guard trigger refuses any other change, a delete
--                              and a truncate. RLS on, no policy; select for the service role only, like credit_refunds (0021).
--                              What a refund finally could not take back (credits the buyer spent, plus credits of ANOTHER lot that
--                              expired while on the hold; only the refunded purchase's own expired credits count as lapsed):
--                                  select f.refund_id, f.shortfall - coalesce(r.collected + r.lapsed, 0) as not_recovered
--                                    from public.credit_refunds f left join public.credit_refund_recoveries r using (refund_id)
--                                   where f.shortfall > 0;
--                              Still open (an open hold may yet pay it; one whose holds were all captured never will):
--                                  select r.* from public.credit_refund_recoveries r
--                                   where r.collected + r.lapsed < r.owed
--                                     and exists (select 1 from public.credit_reservations c
--                                                  where c.job_id = any (r.holds) and c.status = 'open');
--   credit_refund_recover()    AFTER INSERT trigger on credit_transactions for 'release' rows (every release goes through one:
--                              credit_release_locked and capture_credits' unused part, 0020). Named so that it fires after
--                              credit_transactions_apply_lots (triggers fire in name order): the hold's lots are released, and the ones
--                              that ran out expired, before it looks. It collects only what the release gave back to lots that are still
--                              live (credit_lot_moves of this release row), and spends it FROM those lots (the refunded purchase's own
--                              first), never from credits that arrived later (Lens on #766). A release that meets no open recovery
--                              returns after one look at credit_refund_recoveries_open_idx and reads nothing else.
--
-- A FUTURE PATH THAT REFUNDS A CAPTURED RUN (credits given back after capture_credits, for a run that failed after it was charged)
-- would reopen this leak: it is not a release, so nothing here collects from it. Such a path must take the open recoveries of the
-- run's hold into account (credit_refund_recoveries, `job_id = any (holds)`), or go through a 'release' row. None exists today: 0030's
-- download refund restores a charge that had no hold.
--
-- WHAT THIS REPLACES (its latest body, character for character, plus lines marked `-- 0167`)
--   refund_purchased_credits(text, text, numeric, text, text)   0034's body + the held part recorded in credit_refund_recoveries, the
--                              ledger note says how much is on hold instead of calling it spent, and the answer carries `on_hold`.
--                              Same signature, same refusals, same idempotency on refund_id, same grants (service role only).
--   credit_transactions_apply_lots()   0165's body (0034's plus the referral 'adjust' hunk) + marked lines: a 'refund' row's spend may
--                              name its first lot
--                              (nightshift.refund_lot, this organization's lots only), which credit_refund_recover sets per lot.
--                              Unset (every other caller), it is 0165's behaviour exactly. Same grants (no API role).
--
-- WHAT THIS DOES NOT DO. It changes no row that exists (a refund recorded before 0167 has no recovery row and stays as it was). It does
-- not change reserve, start, capture, release or expiry, who may call anything, prices, publishing or privacy. No balance goes below 0:
-- 0020's CHECKs and 0034's deferred lots-vs-balance check stand, and every collection is a ledger row that moves lots by the same amount.
-- The API balance's top-up refund (api_refund_topup, 0031, in cents) and owner_reverse_grant (0107) have the same "available only" rule
-- and are NOT changed here (separate tables; reported to Sentinel).
--
-- NUMBER. 0167 (provisional): 0163 is held by another open branch; 0164 to 0166 are merged. 0165 (the referral programme) replaced
-- credit_transactions_apply_lots first; 0167 is built on 0165's body and its guard refuses any other (0034's included), so 0167 must
-- apply after 0165. 0146's drift guard pins refund_purchased_credits
-- at 0034's body ("what it builds on and leaves alone"), so a REPLAY of 0146 after 0167 refuses: take 0167 off with its rollback
-- first (the lab does: tests/security/sec_db.py take_off_0167 / put_back_0167). Applying 0167 after 0146, the order live sees, is fine.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only, the SQL editor on the live project). md5 of the body with every run of white space read as
-- one space; the file checks it itself and raises on any other value:
--     select md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.refund_purchased_credits(text, text, numeric, text, text)'::regprocedure;
--   expected BEFORE (0034 applied, 0167 not): 766daf507d4e70711b8622aebbea7705
--   expected AFTER  (the last block of this file asserts the same, inside the transaction):
--     refund_purchased_credits        1024ac369b7a18830ac547e41c5ca89e
--     credit_transactions_apply_lots  6098f97a7630bed24807bb7c5ef6eefe   (before, 0165: fcd28a68b841d8d539d3798f919a0d01)
--     credit_refund_recover           0c16bb426e63c1bc1d9fa2518f45b921
--   If a live value is anything else, STOP: something was applied by hand, and replacing the body would silently undo it.
--
-- APPLY AS ONE TRANSACTION. Additive and idempotent: a second run finds this file's bodies and changes nothing. Locks: one new table, and
-- CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on credit_transactions for an instant (lock_timeout 5s: it fails rather than queue
-- behind a long writer). Rollback: docs/sql/rollback_0167_refund_hold_recovery.sql.
-- REQUIRES 0020 (credit_reservations, credit_log), 0021 (credit_refunds), 0034 (refund_purchased_credits' latest body, the lots) and
-- 0165 (credit_transactions_apply_lots' latest body: 0167 is built on it and refuses 0034's).

set local lock_timeout = '5s';

do $$
declare
  r text;
  c text;
  a text;
begin
  if to_regclass('public.credit_refunds') is null then
    raise exception '0167 needs 0021_credit_refunds.sql (credit_refunds): apply it first';
  end if;
  if to_regclass('public.credit_lots') is null or to_regprocedure('public.credit_transactions_apply_lots()') is null then
    raise exception '0167 needs 0034_plans_entitlements.sql (credit lots): apply it first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r
    from pg_proc p where p.oid = to_regprocedure('public.refund_purchased_credits(text, text, numeric, text, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into c
    from pg_proc p where p.oid = to_regprocedure('public.credit_refund_recover()');
  if r is null or r <> all (array['766daf507d4e70711b8622aebbea7705', '1024ac369b7a18830ac547e41c5ca89e']) then
    raise exception '0167 found a refund_purchased_credits() that is neither 0034''s body nor 0167''s (md5 %): read the live body first', r;
  end if;
  if c is not null and c <> '0c16bb426e63c1bc1d9fa2518f45b921' then
    raise exception '0167 found a credit_refund_recover() that is not this file''s body (md5 %): read the live body first', c;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a
    from pg_proc p where p.oid = to_regprocedure('public.credit_transactions_apply_lots()');
  if a is null or a <> all (array['fcd28a68b841d8d539d3798f919a0d01', '6098f97a7630bed24807bb7c5ef6eefe']) then
    raise exception '0167 found a credit_transactions_apply_lots() that is neither 0165''s body nor 0167''s (md5 %): read the live body first', a;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The open part of a shortfall
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.credit_refund_recoveries (
  refund_id            text primary key references public.credit_refunds (refund_id) on delete restrict,
  purchase_external_id text not null,
  org_id               uuid not null references public.organizations (id) on delete restrict,
  holds                text[] not null,
  owed                 numeric(14,2) not null,
  collected            numeric(14,2) not null default 0,
  lapsed               numeric(14,2) not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.credit_refund_recoveries drop constraint if exists credit_refund_recoveries_amounts_check;
alter table public.credit_refund_recoveries add constraint credit_refund_recoveries_amounts_check
  check (owed > 0 and collected >= 0 and lapsed >= 0 and collected + lapsed <= owed);
alter table public.credit_refund_recoveries drop constraint if exists credit_refund_recoveries_holds_check;
alter table public.credit_refund_recoveries add constraint credit_refund_recoveries_holds_check
  check (cardinality(holds) >= 1 and array_position(holds, null) is null);

create index if not exists credit_refund_recoveries_open_idx
  on public.credit_refund_recoveries (org_id, created_at) where collected + lapsed < owed;

comment on table public.credit_refund_recoveries is
  'The part of a refund''s shortfall that was on hold when the refund was recorded (migration 0167): taken back when one of those holds is released, never when it is captured. owed <= the shortfall in credit_refunds; collected (a ledger row took it) and lapsed (the refunded purchase''s own credits expired on the hold) only go up. Written by refund_purchased_credits and credit_refund_recover only.';

-- Only `collected` and `lapsed` (and updated_at) may change, and only upward: the rest is the record of what the refund met.
create or replace function public.credit_refund_recoveries_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'credit_refund_recoveries is append-only: only collected and lapsed may change, and only upward' using errcode = '42501';
  end if;
  if new.refund_id is distinct from old.refund_id
     or new.purchase_external_id is distinct from old.purchase_external_id
     or new.org_id is distinct from old.org_id
     or new.holds is distinct from old.holds
     or new.owed is distinct from old.owed
     or new.created_at is distinct from old.created_at
     or new.collected < old.collected
     or new.lapsed < old.lapsed then
    raise exception 'credit_refund_recoveries: only collected and lapsed may change, and only upward' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists credit_refund_recoveries_guard on public.credit_refund_recoveries;
create trigger credit_refund_recoveries_guard
  before update or delete on public.credit_refund_recoveries
  for each row execute function public.credit_refund_recoveries_guard();

drop trigger if exists credit_refund_recoveries_no_truncate on public.credit_refund_recoveries;
create trigger credit_refund_recoveries_no_truncate
  before truncate on public.credit_refund_recoveries
  for each statement execute function public.credit_refund_recoveries_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. refund_purchased_credits: 0034's body, plus the held part
-- ───────────────────────────────────────────────────────────────────────────

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
  held      numeric := 0;  -- 0167
  holds_    text[];        -- 0167
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
                              'on_hold', coalesce((select r.owed from public.credit_refund_recoveries r where r.refund_id = rid), 0),  -- 0167
                              'balance', acc.balance, 'available', acc.balance - acc.reserved);
  end if;

  select coalesce(sum(requested), 0) into already
    from public.credit_refunds where purchase_external_id = ext;
  remaining := greatest(purchase.amount - already, 0);
  asked := least(coalesce(round(p_amount, 2), remaining), remaining);
  taken := least(asked, greatest(acc.balance - acc.reserved, 0));
  short := asked - taken;

  -- 0167: what holds cover right now is not spent. The account is locked, so no hold opens or settles until this commits; the holds
  -- open now are the only ones the refund may later collect from (credit_refund_recover), and never more than the shortfall.
  if short > 0 and acc.reserved > 0 then                                                         -- 0167
    select array_agg(c.job_id order by c.created_at, c.job_id) into holds_                       -- 0167
      from public.credit_reservations c where c.org_id = purchase.org_id and c.status = 'open';  -- 0167
    if coalesce(cardinality(holds_), 0) > 0 then                                                 -- 0167
      held := least(short, acc.reserved);                                                        -- 0167
    end if;                                                                                      -- 0167
  end if;                                                                                        -- 0167

  update public.credit_accounts
     set balance = balance - taken, updated_at = now()
   where org_id = purchase.org_id
  returning * into acc;

  msg := format('%s of purchase %s: %s credits', why, ext, asked);
  if short > 0 and held > 0 then  -- 0167: on hold is not spent; the note says which part is which
    msg := msg || format(' — %s taken back, %s on hold (taken back if the hold is released, not if it is spent), %s already spent and NOT recovered',  -- 0167
                         taken, held, short - held);  -- 0167
  elsif short > 0 then  -- 0167 (0034: if short > 0 then)
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
  if held > 0 then  -- 0167
    insert into public.credit_refund_recoveries (refund_id, purchase_external_id, org_id, holds, owed)  -- 0167
    values (rid, ext, purchase.org_id, holds_, held);  -- 0167
  end if;  -- 0167

  return jsonb_build_object('refund_id', rid, 'duplicate', false,
                            'requested', asked, 'taken', taken, 'shortfall', short,
                            'on_hold', held,  -- 0167
                            'transaction_id', txn,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. A released hold pays the refund that met it
-- ───────────────────────────────────────────────────────────────────────────
-- The lot trigger as 0165 left it (0034's body plus 0165's 'adjust' hunk), unchanged but for the lines marked 0167: a collection says
-- which lot it spends first. Without the setting (every other caller) it is 0165's behaviour exactly. The two settings never meet:
-- nightshift.refund_lot is read only for a 'refund' row and names a lot id, 0165's nightshift.adjust_lot_first only for an 'adjust'
-- row and names an external id; both are set transaction-local by their one writer just before its insert and reset right after.
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
      -- 0167: a collection from a released hold names the lot that release gave back (credit_refund_recover); this org's lots only.
      prefer := coalesce((select l.id from public.credit_lots l  -- 0167
                           where l.org_id = new.org_id  -- 0167
                             and l.id::text = nullif(current_setting('nightshift.refund_lot', true), '')), prefer);  -- 0167
    -- 0165: an 'adjust' row may name the lot it takes from first (a referral clawback takes the reward's own lot).
    elsif new.kind = 'adjust' then
      select id into prefer from public.credit_lots
       where org_id = new.org_id
         and external_id = nullif(current_setting('nightshift.adjust_lot_first', true), '');
    end if;
    perform public.credit_lots_spend_locked(new.org_id, -amt, new.job_id, new.id, prefer);
  end if;
  return null;
end
$$;

-- Runs inside whichever function released the hold, which already holds the account lock (every release path locks the account
-- first, 0020). Almost no release meets a recovery, so the first statement asks the partial index and returns; nothing else is read.
-- By then credit_transactions_apply_lots has given the hold's lots back (credit_lot_moves 'release' rows of THIS ledger row, all
-- stamped with the hold's job id by credit_lots_release_locked: the job filter uses credit_lot_moves_job_idx instead of scanning the
-- table, which has no index on txn_id) and expired the ones that ran out. What may be collected is what the release gave back to lots
-- that are still live: an expired lot's credits are gone already, and `available` alone would also count credits bought after the
-- refund (Lens on #766: a refunded pack that expired while held, then a later pack, and the later pack was eaten). It is spent FROM
-- those lots, the refunded purchase's own first, then in spend order: one ledger row per lot, each naming its lot for the lot trigger
-- (nightshift.refund_lot), so a later purchase's lot is never the one that pays.
-- The refunded purchase's own credits that expired on the hold are what the refund meant to take, so they count against what it is
-- owed (`lapsed`) without a ledger row. One subscription lot can carry two payments (a mid-period upgrade tops the period's lot up,
-- 0034/0146): `gone` is then the lot's whole expired part, but `lapsed` never exceeds it (`used` counts what earlier rows of this
-- release took), and no row's collected + lapsed ever exceeds its owed.
-- Each row is written straight into the ledger with created_by null, not through credit_log (which stamps auth.uid()): a lazy release
-- runs inside the buyer's own reserve_credits, and the collection is the platform's act, not theirs.

create or replace function public.credit_refund_recover() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec    record;
  lot    record;
  live_  numeric;
  gone   numeric;
  avail  numeric;
  owing  numeric;
  lap    numeric;
  x      numeric;
  t      numeric;
  took   numeric;
  used   jsonb := '{}'::jsonb;
  spent  jsonb := '{}'::jsonb;
begin
  if not exists (select 1 from public.credit_refund_recoveries r
                  where r.org_id = new.org_id and r.collected + r.lapsed < r.owed and new.job_id = any (r.holds)) then
    return null;
  end if;
  select coalesce(sum(-m.held_delta), 0) into live_
    from public.credit_lot_moves m join public.credit_lots l on l.id = m.lot_id
   where m.job_id = new.job_id and m.txn_id = new.id and m.kind = 'release'
     and l.expired_at is null and (l.expires_at is null or l.expires_at > now());
  for rec in
    select r.refund_id, r.purchase_external_id, r.owed, r.collected, r.lapsed, f.reason
      from public.credit_refund_recoveries r
      join public.credit_refunds f on f.refund_id = r.refund_id
     where r.org_id = new.org_id and r.collected + r.lapsed < r.owed and new.job_id = any (r.holds)
     order by r.created_at, r.refund_id
     for update of r
  loop
    owing := rec.owed - rec.collected - rec.lapsed;
    -- The refunded purchase's own lot, expired on this hold: what is left of it after earlier refunds of the same purchase here.
    select coalesce(sum(-m.held_delta), 0) into gone
      from public.credit_lot_moves m join public.credit_lots l on l.id = m.lot_id
     where m.job_id = new.job_id and m.txn_id = new.id and m.kind = 'release' and l.external_id = rec.purchase_external_id
       and not (l.expired_at is null and (l.expires_at is null or l.expires_at > now()));
    lap := least(owing, greatest(gone - coalesce((used ->> rec.purchase_external_id)::numeric, 0), 0));
    if lap > 0 then
      update public.credit_refund_recoveries set lapsed = lapsed + lap, updated_at = now() where refund_id = rec.refund_id;
      used := used || jsonb_build_object(rec.purchase_external_id, coalesce((used ->> rec.purchase_external_id)::numeric, 0) + lap);
      owing := owing - lap;
    end if;
    select greatest(a.balance - a.reserved, 0) into avail from public.credit_accounts a where a.org_id = new.org_id;
    x := least(owing, live_, coalesce(avail, 0));
    continue when x <= 0;
    took := 0;
    -- The live lots this release gave back, the refunded purchase's own first, then in spend order; `spent` is what earlier rows of
    -- this release already took from each.
    for lot in
      select l.id, sum(-m.held_delta) as back, l.remaining - l.held as free
        from public.credit_lot_moves m join public.credit_lots l on l.id = m.lot_id
       where m.job_id = new.job_id and m.txn_id = new.id and m.kind = 'release'
         and l.expired_at is null and (l.expires_at is null or l.expires_at > now())
       group by l.id
       order by (l.external_id is not distinct from rec.purchase_external_id) desc, (l.source <> 'subscription'),
                l.expires_at asc nulls last, l.id
    loop
      exit when took >= x;
      t := least(x - took, lot.back - coalesce((spent ->> lot.id::text)::numeric, 0), lot.free);
      continue when t <= 0;
      update public.credit_accounts set balance = balance - t, updated_at = now() where org_id = new.org_id;
      perform set_config('nightshift.refund_lot', lot.id::text, true);
      insert into public.credit_transactions
        (org_id, kind, amount, balance_after, reserved_after, job_id, external_id, note, created_by)
      select new.org_id, 'refund', -t, a.balance, a.reserved, null, null,
             left(format('%s of purchase %s (%s): %s credits taken back from hold %s, released after the refund',
                         rec.reason, rec.purchase_external_id, rec.refund_id, t, new.job_id), 500),
             null
        from public.credit_accounts a where a.org_id = new.org_id;
      perform set_config('nightshift.refund_lot', '', true);
      spent := spent || jsonb_build_object(lot.id::text, coalesce((spent ->> lot.id::text)::numeric, 0) + t);
      took := took + t;
    end loop;
    continue when took <= 0;
    update public.credit_refund_recoveries set collected = collected + took, updated_at = now() where refund_id = rec.refund_id;
    live_ := live_ - took;
  end loop;
  return null;
end
$$;

drop trigger if exists credit_transactions_recover_refunds on public.credit_transactions;
create trigger credit_transactions_recover_refunds after insert on public.credit_transactions
  for each row when (new.kind = 'release' and new.amount > 0 and new.job_id is not null)
  execute function public.credit_refund_recover();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.credit_refund_recoveries_guard() from public, anon, authenticated, service_role;
revoke all on function public.credit_refund_recover() from public, anon, authenticated, service_role;
revoke all on function public.credit_transactions_apply_lots() from public, anon, authenticated, service_role;
-- 0021's grants for the replaced function, restated: the payment webhook (service role) only.
revoke all on function public.refund_purchased_credits(text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.refund_purchased_credits(text, text, numeric, text, text) to service_role;

alter table public.credit_refund_recoveries enable row level security;
revoke all on public.credit_refund_recoveries from public, anon, authenticated, service_role;
grant select on public.credit_refund_recoveries to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. End state (inside the transaction: any failure rolls the whole file back)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.refund_purchased_credits(text, text, numeric, text, text)'::regprocedure) <> '1024ac369b7a18830ac547e41c5ca89e'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
          where oid = 'public.credit_refund_recover()'::regprocedure) <> '0c16bb426e63c1bc1d9fa2518f45b921'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
          where oid = 'public.credit_transactions_apply_lots()'::regprocedure) <> '6098f97a7630bed24807bb7c5ef6eefe' then
    raise exception '0167 end state: a function does not hold this file''s body';
  end if;
  -- Every enabled row-level AFTER INSERT trigger on the ledger, in the order Postgres fires them (by name, byte order): exactly the lot
  -- trigger, then the collector. Another one would run between or after them and see the account half way.
  -- tgtype bits: 1 row, 2 before, 4 insert, 64 instead of.
  if (select array_agg(t.tgname::text order by t.tgname::text collate "C")
        from pg_trigger t
       where t.tgrelid = 'public.credit_transactions'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
         and t.tgtype & 1 = 1 and t.tgtype & 2 = 0 and t.tgtype & 64 = 0 and t.tgtype & 4 = 4)
     is distinct from array['credit_transactions_apply_lots', 'credit_transactions_recover_refunds'] then
    raise exception '0167 end state: the AFTER INSERT triggers on credit_transactions must be exactly credit_transactions_apply_lots then credit_transactions_recover_refunds';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.credit_refund_recoveries'::regclass
        and tgname in ('credit_refund_recoveries_guard', 'credit_refund_recoveries_no_truncate') and tgenabled = 'O') <> 2 then
    raise exception '0167 end state: the guard triggers on credit_refund_recoveries are missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.credit_refund_recoveries'::regclass)
     or has_table_privilege('anon', 'public.credit_refund_recoveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.credit_refund_recoveries', 'SELECT')
     or has_table_privilege('service_role', 'public.credit_refund_recoveries', 'INSERT')
     or has_table_privilege('service_role', 'public.credit_refund_recoveries', 'UPDATE')
     or has_table_privilege('service_role', 'public.credit_refund_recoveries', 'DELETE') then
    raise exception '0167 end state: credit_refund_recoveries must have RLS on and be readable by the service role only';
  end if;
  if has_function_privilege('anon', 'public.refund_purchased_credits(text, text, numeric, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.refund_purchased_credits(text, text, numeric, text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.refund_purchased_credits(text, text, numeric, text, text)', 'EXECUTE') then
    raise exception '0167 end state: refund_purchased_credits() must be executable by the service role only';
  end if;
  if exists (select 1 from pg_proc p where p.oid in ('public.refund_purchased_credits(text, text, numeric, text, text)'::regprocedure,
                                                     'public.credit_refund_recover()'::regprocedure,
                                                     'public.credit_transactions_apply_lots()'::regprocedure)
                and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
    raise exception '0167 end state: a definer function lost security definer or its pinned search_path';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (the SQL editor on the live project, after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.refund_purchased_credits(text,text,numeric,text,text)'::regprocedure) = '1024ac369b7a18830ac547e41c5ca89e' as refund_body,
--     exists (select 1 from pg_trigger where tgrelid = 'public.credit_transactions'::regclass
--              and tgname = 'credit_transactions_recover_refunds') as recover_trigger,
--     (select relrowsecurity from pg_class where oid = 'public.credit_refund_recoveries'::regclass)
--       and not has_table_privilege('authenticated', 'public.credit_refund_recoveries', 'SELECT') as recoveries_closed,
--     not has_function_privilege('authenticated', 'public.refund_purchased_credits(text,text,numeric,text,text)', 'EXECUTE') as service_only;
--
-- Refunds whose held part is still open (each is collected when one of its holds is released; one whose holds were all captured is
-- not open, it is spent):
--   select r.refund_id, r.org_id, r.owed, r.collected, r.lapsed, r.holds from public.credit_refund_recoveries r
--    where r.collected + r.lapsed < r.owed
--      and exists (select 1 from public.credit_reservations c where c.job_id = any (r.holds) and c.status = 'open')
--    order by r.created_at;
