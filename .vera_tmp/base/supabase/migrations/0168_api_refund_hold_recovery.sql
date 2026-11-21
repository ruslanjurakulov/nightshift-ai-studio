-- 0168_api_refund_hold_recovery.sql — a refund of an API top-up that meets a hold takes those cents back when the hold is released, so
-- a customer can no longer keep refunded API balance by holding it first (BR-0031-01). docs/MIGRATIONS.md "0168". LIVE ON APPLY: it
-- replaces one live function and adds one trigger on api_ledger; read "WHAT TO VERIFY BEFORE YOU APPLY" below first.
--
-- WHY. api_refund_topup (0031, never redefined since) takes back at most what is AVAILABLE (balance_cents - reserved_cents) and records
-- the rest in the ledger note as "already spent and NOT recovered", for good. It is not spent when it sits on a hold. The customer's
-- own API key makes the holds (api_create_video, api_request_download): top up, hold everything with API runs, have the top-up refunded
-- or charged back (taken 0), then let the runs fail. A channel pointed at a voice that is unavailable stops the run before it spends
-- anything (CLAUDE.md rule 4), the job fails, api_settle_job releases its hold in full, and so do holds that never start or never
-- settle within 24 hours (api_expire_holds_locked). The customer had the money back AND the balance, and the balance buys real provider
-- spend. In the lab: a 5000-cent top-up refunded in full left a balance of 5000 where it should have been 0
-- (tests/security/test_sec_breach_api_refund_hold.py).
--
-- THE DESIGN (0167's for site credits, BR-0034-01, carried over to the API balance): the held part of a shortfall stays OPEN and is
-- collected when those holds are released. No run is touched: a hold still settles as it would have. What it settles to decides:
--   * released (job failed or cancelled, download failed, expired): those cents were never spent, so the refund takes them now, up to
--     what it still has open. One 'refund' row in api_ledger per collection.
--   * captured: that is real spending. Nothing is collected; the shortfall stands as 0031 recorded it.
-- What may be collected is bounded so this never takes what the refund was not owed and never makes a balance negative:
--   owed      = least(the refund's shortfall, what was on hold when it was recorded) — never more than the refund asked for;
--   per hold  = only holds that were OPEN when the refund was recorded (a hold placed later, on cents topped up later, is never touched,
--               so a refund does not eat the next top-up — 0021's reason for not carrying a debt);
--   per row   = least(what is still owed, what THIS release gave back that an earlier refund has not already taken, what is available).
-- The per-release cap is what keeps a later top-up whole (the Lens finding on 0167: a release must not let the collection eat funds
-- added afterwards). API cents have no lots and never expire, and nothing lowers the balance under a hold (reserved <= balance is a
-- CHECK, and every debit — api_refund_topup, api_adjust_balance, a capture — takes from available or from its own hold only), so a
-- release gives back to the spendable balance exactly its amount: that amount, shared out across every refund that met the hold, in
-- the order they were recorded, is all it can pay. The collector also checks that the ledger row is a real release of that hold
-- (api_holds says released, same amount) before it moves anything.
--
-- WHO WROTE IT. A release can run inside the customer's own request (the lazy expiry at the top of api_create_video and
-- api_request_download, after api_act_as made auth.uid() the key's creator). api_log stamps created_by = auth.uid(), so a collection
-- written through it would read as the customer's own act. The collector writes its ledger row itself with created_by NULL: the
-- platform's, like the refund it belongs to.
--
-- WHAT THIS ADDS
--   api_refund_recoveries   one row per refund whose shortfall met open holds: the refund, its ledger row, the top-up, the organization,
--                           the reason, the refs of the holds open at that moment, `owed` and `collected` (0 <= collected <= owed).
--                           Written only by api_refund_topup (insert) and api_refund_recover (collected goes up); a guard trigger refuses
--                           any other change, a delete and a truncate. RLS on, no policy; select for the service role only. What a
--                           refund finally could not take back:
--                               select l.external_id as refund_id, (l.requested_cents + l.amount_cents) - coalesce(r.collected, 0) as not_recovered
--                                 from public.api_ledger l left join public.api_refund_recoveries r on r.refund_id = l.external_id
--                                where l.kind = 'refund' and l.external_id is not null and l.requested_cents + l.amount_cents > 0;
--   api_refund_recover()    AFTER INSERT trigger on api_ledger for 'release' rows. Every release of an API hold goes through one
--                           (api_settle_locked, 0031: the job trigger, the download trigger and the expiry all call it), after the
--                           account row was locked by the caller.
--
-- WHAT THIS REPLACES (its latest body, character for character, plus lines marked `-- 0168`)
--   api_refund_topup(text, text, bigint, text, text)   0031's body + the held part recorded in api_refund_recoveries, the ledger note
--                           says how much is on hold instead of calling it spent, and the answer carries `on_hold_cents` (a duplicate
--                           answers the recorded value). Same signature, same refusals, same idempotency on the refund id, same
--                           grants (service role only).
--
-- WHAT THIS DOES NOT DO. It changes no row that exists (a refund recorded before 0168 has no recovery row and stays as it was). It does
-- not change hold, start, capture, release or expiry, the tier or paid_total arithmetic, who may call anything, prices, publishing or
-- privacy. No balance goes below 0 (0031's CHECKs stand, and a collection takes at most what is available). Site credits
-- (refund_purchased_credits, BR-0034-01) are 0167's; owner_reverse_grant (0107, BR-0107-01) is a credits-side follow-up, not here.
--
-- NUMBER. 0168 (provisional): 0163 to 0167 are held by other open branches. Names nothing of theirs; touches no table, function or
-- trigger of 0167's (that one is credits, this one is the API balance).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only, the SQL editor on the live project). md5 of the body with every run of white space read as
-- one space; the file checks it itself and raises on any other value:
--     select md5(regexp_replace(prosrc, '\s+', ' ', 'g'))
--       from pg_proc where oid = 'public.api_refund_topup(text, text, bigint, text, text)'::regprocedure;
--   expected BEFORE (0031 applied, 0168 not): a9d2287173b12b704808e7b3747b05e0
--   expected AFTER  (the last block of this file asserts the same, inside the transaction):
--     api_refund_topup     74ea95ec27564e57b7b989a906a15842
--     api_refund_recover   785ca1a1df7d72192bd98dbfd9122a37
--   If a live value is anything else, STOP: something was applied by hand, and replacing the body would silently undo it.
--
-- APPLY AS ONE TRANSACTION. Additive and idempotent: a second run finds this file's bodies and changes nothing. Locks, held until the
-- transaction commits: one new table; on the first run CREATE TRIGGER takes SHARE ROW EXCLUSIVE on api_ledger (writers wait, readers do
-- not); on a RE-RUN the DROP TRIGGER IF EXISTS of the trigger already there takes ACCESS EXCLUSIVE on api_ledger, which also blocks
-- every read of it (the Developer console, the webhook's top-up lookup) for the rest of the file. Both are a few milliseconds of work;
-- lock_timeout 5s makes the file fail rather than queue behind a long transaction on api_ledger, and the queue that forms behind it.
-- Rollback: docs/sql/rollback_0168_api_refund_hold_recovery.sql.
-- REQUIRES 0031 (api_accounts, api_ledger, api_holds, api_refund_topup's latest body).

set local lock_timeout = '5s';

do $$
declare
  r text;
  c text;
begin
  if to_regclass('public.api_ledger') is null or to_regclass('public.api_holds') is null
     or to_regprocedure('public.api_settle_locked(text, boolean, text)') is null then
    raise exception '0168 needs 0031_public_api.sql (api_ledger, api_holds, api_settle_locked): apply it first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r
    from pg_proc p where p.oid = to_regprocedure('public.api_refund_topup(text, text, bigint, text, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into c
    from pg_proc p where p.oid = to_regprocedure('public.api_refund_recover()');
  if r is null or r <> all (array['a9d2287173b12b704808e7b3747b05e0', '74ea95ec27564e57b7b989a906a15842']) then
    raise exception '0168 found an api_refund_topup() that is neither 0031''s body nor 0168''s (md5 %): read the live body first', r;
  end if;
  if c is not null and c <> '785ca1a1df7d72192bd98dbfd9122a37' then
    raise exception '0168 found an api_refund_recover() that is not this file''s body (md5 %): read the live body first', c;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The open part of a shortfall
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.api_refund_recoveries (
  refund_id         text primary key check (length(refund_id) between 1 and 200),
  refund_ledger_id  bigint not null references public.api_ledger (id) on delete restrict,
  topup_external_id text not null,
  org_id            uuid not null references public.organizations (id) on delete restrict,
  reason            text not null check (reason in ('refund', 'chargeback')),
  holds             text[] not null,
  owed              bigint not null,
  collected         bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.api_refund_recoveries drop constraint if exists api_refund_recoveries_amounts_check;
alter table public.api_refund_recoveries add constraint api_refund_recoveries_amounts_check
  check (owed > 0 and collected >= 0 and collected <= owed);
alter table public.api_refund_recoveries drop constraint if exists api_refund_recoveries_holds_check;
alter table public.api_refund_recoveries add constraint api_refund_recoveries_holds_check
  check (cardinality(holds) >= 1 and array_position(holds, null) is null);

create index if not exists api_refund_recoveries_open_idx
  on public.api_refund_recoveries (org_id, created_at) where collected < owed;

comment on table public.api_refund_recoveries is
  'The part of an API top-up refund''s shortfall that was on hold when the refund was recorded (migration 0168, BR-0031-01): taken back when one of those holds is released, never when it is captured. owed <= the refund''s shortfall; collected only goes up. Written by api_refund_topup and api_refund_recover only.';

-- Only `collected` (and updated_at) may change, and only upward: the rest is the record of what the refund met.
create or replace function public.api_refund_recoveries_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'api_refund_recoveries is append-only: only collected may change, and only upward' using errcode = '42501';
  end if;
  if new.refund_id is distinct from old.refund_id
     or new.refund_ledger_id is distinct from old.refund_ledger_id
     or new.topup_external_id is distinct from old.topup_external_id
     or new.org_id is distinct from old.org_id
     or new.reason is distinct from old.reason
     or new.holds is distinct from old.holds
     or new.owed is distinct from old.owed
     or new.created_at is distinct from old.created_at
     or new.collected < old.collected then
    raise exception 'api_refund_recoveries: only collected may change, and only upward' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists api_refund_recoveries_guard on public.api_refund_recoveries;
create trigger api_refund_recoveries_guard
  before update or delete on public.api_refund_recoveries
  for each row execute function public.api_refund_recoveries_guard();

drop trigger if exists api_refund_recoveries_no_truncate on public.api_refund_recoveries;
create trigger api_refund_recoveries_no_truncate
  before truncate on public.api_refund_recoveries
  for each statement execute function public.api_refund_recoveries_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. api_refund_topup: 0031's body, plus the held part
-- ───────────────────────────────────────────────────────────────────────────

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
  held    bigint := 0;  -- 0168
  holds_  text[];       -- 0168
  on_hold bigint;       -- 0168
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
                              'on_hold_cents', coalesce((select r.owed from public.api_refund_recoveries r where r.refund_id = rid), 0),  -- 0168
                              'shortfall_cents', prior.requested_cents + prior.amount_cents);
  end if;
  select coalesce(sum(l.requested_cents), 0) into already
    from public.api_ledger l where l.kind = 'refund' and l.source_external_id = ext;
  asked := least(coalesce(p_cents, topup.amount_cents), greatest(topup.amount_cents - already, 0));
  taken := least(asked, greatest(acc.balance_cents - acc.reserved_cents, 0));
  short := asked - taken;

  -- 0168: what holds cover right now is not spent. The account is locked, so no hold opens or settles until this commits; the holds
  -- open now are the only ones this refund may later collect from (api_refund_recover), and never more than the shortfall.
  if short > 0 and acc.reserved_cents > 0 then                                                    -- 0168
    select array_agg(h.ref order by h.created_at, h.ref), coalesce(sum(h.amount_cents), 0)        -- 0168
      into holds_, on_hold                                                                        -- 0168
      from public.api_holds h where h.org_id = topup.org_id and h.status = 'open';                -- 0168
    if coalesce(cardinality(holds_), 0) > 0 then                                                  -- 0168
      held := least(short, acc.reserved_cents, on_hold);                                          -- 0168
    end if;                                                                                       -- 0168
  end if;                                                                                         -- 0168

  update public.api_accounts
     set balance_cents = balance_cents - taken,
         paid_total_cents = greatest(paid_total_cents - asked, 0), updated_at = now()
   where org_id = topup.org_id returning * into acc;
  msg := format('%s of top-up %s: %s cents', why, ext, asked);
  if short > 0 and held > 0 then  -- 0168: on hold is not spent; the note says which part is which
    msg := msg || format(' — %s taken back, %s on hold (taken back if the hold is released, not if it is spent), %s already spent and NOT recovered',  -- 0168
                         taken, held, short - held);  -- 0168
  elsif short > 0 then  -- 0168 (0031: if short > 0 then)
    msg := msg || format(' — %s taken back, %s already spent and NOT recovered', taken, short);
  end if;
  if coalesce(btrim(p_note), '') <> '' then
    msg := msg || ' · ' || btrim(p_note);
  end if;
  -- Written even when nothing could be taken: the history must show it.
  txn := public.api_log(topup.org_id, 'refund', -taken, null, null, rid, ext, asked, msg);
  if held > 0 then  -- 0168
    insert into public.api_refund_recoveries (refund_id, refund_ledger_id, topup_external_id, org_id, reason, holds, owed)  -- 0168
    values (rid, txn, ext, topup.org_id, why, holds_, held);  -- 0168
  end if;  -- 0168
  return jsonb_build_object('duplicate', false, 'requested_cents', asked, 'taken_cents', taken,
                            'on_hold_cents', held,  -- 0168
                            'shortfall_cents', short, 'ledger_id', txn);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. A released hold pays the refund that met it
-- ───────────────────────────────────────────────────────────────────────────
-- Runs inside api_settle_locked, whose caller already holds the account lock (api_account_lock: the job trigger, the download trigger,
-- the expiry's callers). By then the hold is 'released' and reserved_cents is down by its amount: that amount is what this release gave
-- back to the spendable balance, and the collections it pays, together, take at most that. The ledger row is written here, not through
-- api_log, so that it never carries the customer's id when the release ran inside the customer's own API call (see WHO WROTE IT).
-- The released-hold check below cannot tell a second 'release' row for the same hold from the first: api_holds still says released,
-- same amount, so a forged duplicate would collect again (never past `owed`, nor past what is available). Nothing reachable writes one:
-- api_settle_locked releases a hold once (status 'open' -> 'released' under the hold's row lock), api_ledger is closed to every API
-- role including the service key (0031: no INSERT grant), and its definer functions write only their own kinds. Only the database
-- owner, in the SQL editor, could insert such a row.

create or replace function public.api_refund_recover() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  h     public.api_holds;
  rec   record;
  left_ bigint := new.amount_cents;
  avail bigint;
  x     bigint;
  acc   public.api_accounts;
begin
  select * into h from public.api_holds where ref = new.hold_ref;
  if h.ref is null or h.org_id is distinct from new.org_id or h.status <> 'released' or h.amount_cents <> new.amount_cents then
    return null;
  end if;
  for rec in
    select r.refund_id, r.topup_external_id, r.reason, r.owed, r.collected
      from public.api_refund_recoveries r
     where r.org_id = new.org_id and r.collected < r.owed and new.hold_ref = any (r.holds)
     order by r.refund_ledger_id
     for update of r
  loop
    exit when left_ <= 0;
    select greatest(a.balance_cents - a.reserved_cents, 0) into avail from public.api_accounts a where a.org_id = new.org_id;
    x := least(rec.owed - rec.collected, left_, coalesce(avail, 0));
    exit when x <= 0;
    update public.api_accounts set balance_cents = balance_cents - x, updated_at = now()
     where org_id = new.org_id returning * into acc;
    update public.api_refund_recoveries set collected = collected + x, updated_at = now() where refund_id = rec.refund_id;
    insert into public.api_ledger (org_id, kind, amount_cents, balance_after, reserved_after, requested_cents,
                                   hold_ref, key_id, external_id, source_external_id, note, created_by)
    values (new.org_id, 'refund', -x, acc.balance_cents, acc.reserved_cents, null,
            new.hold_ref, null, null, rec.topup_external_id,
            left(format('%s of top-up %s (%s): %s cents taken back from hold %s, released after the refund',
                        rec.reason, rec.topup_external_id, rec.refund_id, x, new.hold_ref), 500),
            null);
    left_ := left_ - x;
  end loop;
  return null;
end
$$;

drop trigger if exists api_ledger_recover_refunds on public.api_ledger;
create trigger api_ledger_recover_refunds after insert on public.api_ledger
  for each row when (new.kind = 'release' and new.amount_cents > 0 and new.hold_ref is not null)
  execute function public.api_refund_recover();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.api_refund_recoveries_guard() from public, anon, authenticated, service_role;
revoke all on function public.api_refund_recover() from public, anon, authenticated, service_role;
-- 0031's grants for the replaced function, restated: the payment webhook (service role) only.
revoke all on function public.api_refund_topup(text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.api_refund_topup(text, text, bigint, text, text) to service_role;

alter table public.api_refund_recoveries enable row level security;
revoke all on public.api_refund_recoveries from public, anon, authenticated, service_role;
grant select on public.api_refund_recoveries to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. End state (inside the transaction: any failure rolls the whole file back)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.api_refund_topup(text, text, bigint, text, text)'::regprocedure) <> '74ea95ec27564e57b7b989a906a15842'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
          where oid = 'public.api_refund_recover()'::regprocedure) <> '785ca1a1df7d72192bd98dbfd9122a37' then
    raise exception '0168 end state: a function does not hold this file''s body';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.api_ledger'::regclass
                    and tgname = 'api_ledger_recover_refunds' and not tgisinternal and tgenabled = 'O') then
    raise exception '0168 end state: api_ledger_recover_refunds must exist and be enabled';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.api_refund_recoveries'::regclass
        and tgname in ('api_refund_recoveries_guard', 'api_refund_recoveries_no_truncate') and tgenabled = 'O') <> 2 then
    raise exception '0168 end state: the guard triggers on api_refund_recoveries are missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.api_refund_recoveries'::regclass)
     or has_table_privilege('anon', 'public.api_refund_recoveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.api_refund_recoveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.api_refund_recoveries', 'INSERT')
     or has_table_privilege('service_role', 'public.api_refund_recoveries', 'INSERT')
     or has_table_privilege('service_role', 'public.api_refund_recoveries', 'UPDATE')
     or has_table_privilege('service_role', 'public.api_refund_recoveries', 'DELETE') then
    raise exception '0168 end state: api_refund_recoveries must have RLS on and be readable by the service role only';
  end if;
  if has_function_privilege('anon', 'public.api_refund_topup(text, text, bigint, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_refund_topup(text, text, bigint, text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.api_refund_topup(text, text, bigint, text, text)', 'EXECUTE') then
    raise exception '0168 end state: api_refund_topup() must be executable by the service role only';
  end if;
  if exists (select 1 from pg_proc p where p.oid in ('public.api_refund_topup(text, text, bigint, text, text)'::regprocedure,
                                                     'public.api_refund_recover()'::regprocedure)
                and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
    raise exception '0168 end state: a definer function lost security definer or its pinned search_path';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (the SQL editor on the live project, after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.api_refund_topup(text,text,bigint,text,text)'::regprocedure) = '74ea95ec27564e57b7b989a906a15842' as refund_body,
--     exists (select 1 from pg_trigger where tgrelid = 'public.api_ledger'::regclass
--              and tgname = 'api_ledger_recover_refunds') as recover_trigger,
--     (select relrowsecurity from pg_class where oid = 'public.api_refund_recoveries'::regclass)
--       and not has_table_privilege('authenticated', 'public.api_refund_recoveries', 'SELECT') as recoveries_closed,
--     not has_function_privilege('authenticated', 'public.api_refund_topup(text,text,bigint,text,text)', 'EXECUTE') as service_only;
--
-- Refunds whose held part is still open (each is collected when one of its holds is released; a refund whose holds were all captured
-- or released is not open, whatever is left of `owed`):
--   select r.refund_id, r.org_id, r.owed, r.collected, r.holds from public.api_refund_recoveries r
--    where r.collected < r.owed
--      and exists (select 1 from public.api_holds h where h.ref = any (r.holds) and h.status = 'open')
--    order by r.created_at;
