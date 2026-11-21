-- 0172_grant_reversal_hold_recovery.sql — an owner's reversal of a grant that meets a hold takes those credits back when the hold is
-- released, so a workspace no longer keeps part of a reversed grant because a run happened to hold it (BR-0107-01). docs/MIGRATIONS.md
-- "0172". LIVE ON APPLY: it replaces two live functions and adds one trigger on credit_transactions; read "WHAT TO VERIFY BEFORE YOU
-- APPLY" below first.
--
-- WHY. owner_reverse_grant (0107, never redefined since) takes back at most the part of the grant's lot that is neither held nor
-- unavailable (v_unspent := l.remaining - l.held, then least(..., balance - reserved)) and records the rest as a shortfall. The reversal
-- is written under the one-per-grant external id owner-reverse:<grant id>, so a partial reversal is final: a retry answers duplicate.
-- A hold is not spending. When the run that held the rest never starts, fails, or is cancelled, the hold is released back to the
-- workspace, and it keeps those credits for good. In the lab: 100 granted, a run holding all but 30 of what is available, the reversal
-- takes 30 (shortfall 70), the hold is released, and the workspace kept 70 (tests/security/test_sec_breach_owner_reverse_hold.py).
-- Its 'adjust' row also spent in the ledger's normal lot order, not from the grant's own lot (0107's "Known limits").
--
-- THE DESIGN (0167's for a refunded purchase, BR-0034-01, carried over to a reversed grant): the held part of a shortfall stays OPEN and
-- is collected when those holds are released. No run is touched: a hold still settles as it would have. What it settles to decides:
--   * released (expired, failed, cancelled, or the unused part of a capture): those credits were never spent, so the reversal takes
--     them now, up to what it still has open. One 'adjust' ledger row per collection, spent from the grant's own lot.
--   * captured: that is real spending. Nothing is collected; the shortfall stands as 0107 recorded it.
-- What may be collected is bounded so this never takes what the reversal was not owed and never makes a balance negative:
--   owed      = least(the reversal's shortfall, what holds had of the grant's own lot when it was recorded);
--   per hold  = only holds that had credits of the grant's lot when the reversal was recorded (credit_hold_lots); a hold placed later
--               is never touched, so a reversal does not eat the next purchase;
--   per row   = least(what is still owed, what THIS release gave back to the grant's lot that an earlier collector of this same release
--               has not already taken from it, what is free in that lot, what is available). That per-release cap is shared with 0167's
--               collector: credit_refund_recover fires first (trigger name order: ..._recover_refunds < ..._recover_reversals) and
--               spends from the lots the release gave back; whatever it took from the grant's lot is subtracted here (the lot's spend
--               moves since the release row), so the two can never both collect one release's credits.
-- The grant's own credits that expired while on the hold are what the reversal meant to take, so they count against what it is owed
-- (`lapsed`) without a ledger row. Grants do not expire today (credit_lot_policies), but the policy is a row an owner can change.
--
-- WHO WROTE IT. A release can run inside the workspace's own call (the lazy expiry at the top of reserve_credits). credit_log stamps
-- created_by = auth.uid(), so a collection written through it would read as the member's own act. The collector writes its ledger row
-- itself with created_by NULL: the platform's, like 0167's.
--
-- WHAT THIS ADDS
--   credit_grant_reversal_recoveries   one row per reversal whose shortfall met holds on the grant's lot: the grant's ledger row, the
--                              reversal's ledger row, the grant's lot, the organization, the job ids of the holds on that lot at that
--                              moment, `owed`, `collected` and `lapsed`, 0 <= collected + lapsed <= owed. Written only by
--                              owner_reverse_grant (insert) and credit_grant_reversal_recover (collected and lapsed go up); a guard
--                              trigger refuses any other change, a delete and a truncate. RLS on, no policy; select for the service
--                              role only, like credit_refund_recoveries (0167).
--   credit_grant_reversal_recover()   AFTER INSERT trigger on credit_transactions for 'release' rows, named so that it fires after
--                              credit_transactions_apply_lots (the hold's lots are given back, the expired ones expired) and after 0167's
--                              credit_transactions_recover_refunds. A release that meets no open recovery returns after one look at
--                              credit_grant_reversal_recoveries_open_idx and reads nothing else.
--
-- WHAT THIS REPLACES (its latest body, character for character, plus lines marked `-- 0172`)
--   owner_reverse_grant(bigint, text)   0107's body + the held part recorded in credit_grant_reversal_recoveries, its own 'adjust' row
--                              spends the grant's own lot first, and the answer (a duplicate's too) and the audit entry carry `on_hold`.
--                              Same signature, same refusals, same idempotency on owner-reverse:<grant id>, same grants (authenticated,
--                              gated by owner_guard). Three of 0107's lines are replaced whole, each by a marked line (the two answers'
--                              and the audit's lists gain `on_hold`).
--   credit_transactions_apply_lots()   0167's body (0165's plus 0167's refund_lot hunk) + marked lines: an 'adjust' row's spend may name
--                              its first lot by id (nightshift.reverse_lot, this organization's lots only), which owner_reverse_grant and
--                              credit_grant_reversal_recover set just before their insert and reset right after. Unset (every other
--                              caller, 0165's referral clawback included), it is 0167's behaviour exactly; when set it wins over
--                              0165's nightshift.adjust_lot_first, which no reversal sets. Same grants (no API role).
--
-- WHAT THIS DOES NOT DO. It changes no row that exists (a reversal recorded before 0172 has no recovery row and stays as it was). It does
-- not change grant, reserve, start, capture, release or expiry, the 24-hour grant cap, the reversal window, who may call anything, prices,
-- publishing or privacy. A grant that is ALL on hold still answers nothing_to_reverse and records nothing, as in 0107: nothing was made
-- final, so the owner reverses it once the hold has settled. No balance goes below 0: 0020's CHECKs and 0034's deferred lots-vs-balance
-- check stand, and every collection is a ledger row that moves its lot by the same amount.
--
-- NUMBER. 0172: 0171 is held by an open branch (films, money) that touches neither function. Built on 0167's lot trigger and 0107's
-- reversal; the guards below refuse any other body. A REPLAY of 0167 after 0172 refuses (its guard knows 0165's and its own lot trigger
-- only, and its end state lists exactly two AFTER INSERT triggers on the ledger): take 0172 off with its rollback first (the lab does:
-- tests/security/sec_db.py take_off_0172 / put_back_0172, which take_off_0167 / put_back_0167 now call).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only, the SQL editor on the live project). md5 of the body with every run of white space read as
-- one space; the file checks it itself and raises on any other value:
--     select p.proname, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--      where p.oid in ('public.owner_reverse_grant(bigint, text)'::regprocedure, 'public.credit_transactions_apply_lots()'::regprocedure);
--   expected BEFORE (0107 and 0167 applied, 0172 not):
--     owner_reverse_grant             4c701e7930d213f6f1ba84485c366a36
--     credit_transactions_apply_lots  6098f97a7630bed24807bb7c5ef6eefe
--   expected AFTER  (the last block of this file asserts the same, inside the transaction):
--     owner_reverse_grant             de3893bbaba50d48edfa694baf39533f
--     credit_transactions_apply_lots  aec752383dd2c5cf3621ee273a677fe0
--     credit_grant_reversal_recover   e58362bc86d0b47c042f0bc8a2e15319
--   If a live value is anything else, STOP: something was applied by hand, and replacing the body would silently undo it.
--
-- APPLY AS ONE TRANSACTION. Additive and idempotent: a second run finds this file's bodies and changes nothing. Locks, held until the
-- transaction commits: one new table; CREATE TRIGGER takes SHARE ROW EXCLUSIVE on credit_transactions (writers wait, readers do not); on
-- a RE-RUN the DROP TRIGGER IF EXISTS of the trigger already there takes ACCESS EXCLUSIVE on it. Both are milliseconds of work;
-- lock_timeout 5s makes the file fail rather than queue behind a long writer. Rollback: docs/sql/rollback_0172_grant_reversal_hold_recovery.sql.
-- REQUIRES 0020 (credit_reservations, credit_log), 0034 (credit_lots, credit_hold_lots, credit_lot_moves), 0107 (owner_reverse_grant),
-- 0165 and 0167 (credit_transactions_apply_lots' latest body, and the refund collector this one fires after).

set local lock_timeout = '5s';

do $$
declare
  o text;
  a text;
  c text;
begin
  if to_regclass('public.credit_hold_lots') is null or to_regclass('public.credit_lot_moves') is null then
    raise exception '0172 needs 0034_plans_entitlements.sql (credit lots): apply it first';
  end if;
  if to_regprocedure('public.credit_refund_recover()') is null then
    raise exception '0172 needs 0167_refund_hold_recovery.sql (credit_refund_recover): apply it first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into o
    from pg_proc p where p.oid = to_regprocedure('public.owner_reverse_grant(bigint, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a
    from pg_proc p where p.oid = to_regprocedure('public.credit_transactions_apply_lots()');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into c
    from pg_proc p where p.oid = to_regprocedure('public.credit_grant_reversal_recover()');
  if o is null or o <> all (array['4c701e7930d213f6f1ba84485c366a36', 'de3893bbaba50d48edfa694baf39533f']) then
    raise exception '0172 found an owner_reverse_grant() that is neither 0107''s body nor 0172''s (md5 %): read the live body first', o;
  end if;
  if a is null or a <> all (array['6098f97a7630bed24807bb7c5ef6eefe', 'aec752383dd2c5cf3621ee273a677fe0']) then
    raise exception '0172 found a credit_transactions_apply_lots() that is neither 0167''s body nor 0172''s (md5 %): read the live body first', a;
  end if;
  if c is not null and c <> 'e58362bc86d0b47c042f0bc8a2e15319' then
    raise exception '0172 found a credit_grant_reversal_recover() that is not this file''s body (md5 %): read the live body first', c;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The open part of a reversal's shortfall
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.credit_grant_reversal_recoveries (
  grant_txn_id    bigint primary key references public.credit_transactions (id) on delete restrict,
  reversal_txn_id bigint not null unique references public.credit_transactions (id) on delete restrict,
  lot_id          bigint not null references public.credit_lots (id) on delete restrict,
  org_id          uuid not null references public.organizations (id) on delete restrict,
  holds           text[] not null,
  owed            numeric(14,2) not null,
  collected       numeric(14,2) not null default 0,
  lapsed          numeric(14,2) not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.credit_grant_reversal_recoveries drop constraint if exists credit_grant_reversal_recoveries_amounts_check;
alter table public.credit_grant_reversal_recoveries add constraint credit_grant_reversal_recoveries_amounts_check
  check (owed > 0 and collected >= 0 and lapsed >= 0 and collected + lapsed <= owed);
alter table public.credit_grant_reversal_recoveries drop constraint if exists credit_grant_reversal_recoveries_holds_check;
alter table public.credit_grant_reversal_recoveries add constraint credit_grant_reversal_recoveries_holds_check
  check (cardinality(holds) >= 1 and array_position(holds, null) is null);

create index if not exists credit_grant_reversal_recoveries_open_idx
  on public.credit_grant_reversal_recoveries (org_id, created_at) where collected + lapsed < owed;

comment on table public.credit_grant_reversal_recoveries is
  'The part of an owner''s grant reversal shortfall that holds had of the grant''s own lot when the reversal was recorded (migration 0172, BR-0107-01): taken back from that lot when one of those holds is released, never when it is captured. owed <= the reversal''s shortfall; collected (a ledger row took it) and lapsed (the grant''s own credits expired on the hold) only go up. Written by owner_reverse_grant and credit_grant_reversal_recover only.';

-- Only `collected` and `lapsed` (and updated_at) may change, and only upward: the rest is the record of what the reversal met.
create or replace function public.credit_grant_reversal_recoveries_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'credit_grant_reversal_recoveries is append-only: only collected and lapsed may change, and only upward' using errcode = '42501';
  end if;
  if new.grant_txn_id is distinct from old.grant_txn_id
     or new.reversal_txn_id is distinct from old.reversal_txn_id
     or new.lot_id is distinct from old.lot_id
     or new.org_id is distinct from old.org_id
     or new.holds is distinct from old.holds
     or new.owed is distinct from old.owed
     or new.created_at is distinct from old.created_at
     or new.collected < old.collected
     or new.lapsed < old.lapsed then
    raise exception 'credit_grant_reversal_recoveries: only collected and lapsed may change, and only upward' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists credit_grant_reversal_recoveries_guard on public.credit_grant_reversal_recoveries;
create trigger credit_grant_reversal_recoveries_guard
  before update or delete on public.credit_grant_reversal_recoveries
  for each row execute function public.credit_grant_reversal_recoveries_guard();

drop trigger if exists credit_grant_reversal_recoveries_no_truncate on public.credit_grant_reversal_recoveries;
create trigger credit_grant_reversal_recoveries_no_truncate
  before truncate on public.credit_grant_reversal_recoveries
  for each statement execute function public.credit_grant_reversal_recoveries_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. owner_reverse_grant: 0107's body, plus the held part and the grant's own lot
-- ───────────────────────────────────────────────────────────────────────────
-- Take back (part of) a grant: bounded by what the grant's lot still holds and by the organization's
-- available credits; the rest is recorded as a shortfall. One reversal per grant (the ledger's unique
-- external id), so a retry is a no-op that answers duplicate. 0172: the part of the shortfall that holds
-- cover is owed, and collected from the grant's lot when one of those holds is released.
create or replace function public.owner_reverse_grant(p_transaction_id bigint, p_reason text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  g       jsonb;
  s       public.owner_security_settings;
  t       public.credit_transactions;
  l       public.credit_lots;
  v_acc   public.credit_accounts;
  v_prior public.credit_transactions;
  v_why   text := btrim(coalesce(p_reason, ''));
  v_ext   text;
  v_unspent numeric;
  v_take  numeric;
  v_txn   bigint;
  v_held  numeric := 0;  -- 0172
  v_holds text[];        -- 0172
  v_on    numeric;       -- 0172
begin
  g := public.owner_guard('reverse_grant', 20);
  if g is not null then return g; end if;
  select * into s from public.owner_security_settings limit 1;
  if char_length(v_why) < 8 or char_length(v_why) > 300 then
    return public.owner_err('reason_required', 'Give a reason of 8 to 300 characters.');
  end if;

  select * into t from public.credit_transactions where id = p_transaction_id;
  if not found or t.kind <> 'grant' then
    return public.owner_err('not_a_grant', 'That ledger row is not a grant.');
  end if;
  -- Owner grants and manual grant_credits rows only; welcome credits, invite rewards and the like are not.
  if not (t.external_id like 'owner-grant:%' or (t.external_id is null and t.created_by is not null)) then
    return public.owner_err('not_reversible', 'Only a grant given by an owner or admin can be reversed here.');
  end if;
  if t.created_at < now() - make_interval(days => s.reverse_window_days) then
    return public.owner_err('too_old', 'That grant is older than the reversal window.',
      jsonb_build_object('window_days', s.reverse_window_days));
  end if;

  v_ext := 'owner-reverse:' || t.id;
  v_acc := public.credit_account_lock(t.org_id);
  select * into v_prior from public.credit_transactions where external_id = v_ext;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'transaction_id', v_prior.id, 'reversed', -v_prior.amount,
                              'shortfall', t.amount + v_prior.amount, 'balance', v_acc.balance,  -- 0172
                              'on_hold', coalesce((select r.owed from public.credit_grant_reversal_recoveries r where r.grant_txn_id = t.id), 0));  -- 0172
  end if;

  select * into l from public.credit_lots where created_txn = t.id;
  v_unspent := case when found then greatest(l.remaining - l.held, 0) else t.amount end;
  v_take := least(t.amount, v_unspent, greatest(v_acc.balance - v_acc.reserved, 0));
  if v_take <= 0 then
    return public.owner_err('nothing_to_reverse', 'None of that grant is left to take back.',
      jsonb_build_object('granted', t.amount, 'shortfall', t.amount));
  end if;

  -- 0172: what holds cover of the grant's own lot is not spent. The account is locked: no hold opens or settles until this commits.
  -- 0172: the holds on this lot now are the only ones the reversal may later collect from (credit_grant_reversal_recover).
  if l.id is not null and t.amount - v_take > 0 and l.held > 0 then                                    -- 0172
    select array_agg(h.job_id order by c.created_at, h.job_id), coalesce(sum(h.amount), 0)             -- 0172
      into v_holds, v_on                                                                                -- 0172
      from public.credit_hold_lots h join public.credit_reservations c on c.job_id = h.job_id          -- 0172
     where h.lot_id = l.id and c.status = 'open';                                                      -- 0172
    if coalesce(cardinality(v_holds), 0) > 0 then                                                       -- 0172
      v_held := least(t.amount - v_take, l.held, v_on);                                                 -- 0172
    end if;                                                                                             -- 0172
  end if;                                                                                               -- 0172
  begin
    update public.credit_accounts set balance = balance - v_take, updated_at = now()
     where org_id = t.org_id returning * into v_acc;
    perform set_config('nightshift.reverse_lot', coalesce(l.id::text, ''), true);  -- 0172: spend the grant's own lot first
    v_txn := public.credit_log(t.org_id, 'adjust', -v_take, null, v_ext,
                               'owner reversal of grant #' || t.id || ': ' || v_why);
    perform set_config('nightshift.reverse_lot', '', true);  -- 0172
  exception
    when unique_violation then
      return public.owner_err('already_reversed', 'That grant was already reversed.');
    when sqlstate 'NS402' then
      return public.owner_err('nothing_to_reverse', 'None of that grant is left to take back.',
        jsonb_build_object('granted', t.amount, 'shortfall', t.amount));
  end;

  if v_held > 0 then  -- 0172
    insert into public.credit_grant_reversal_recoveries (grant_txn_id, reversal_txn_id, lot_id, org_id, holds, owed)  -- 0172
    values (t.id, v_txn, l.id, t.org_id, v_holds, v_held);  -- 0172
  end if;  -- 0172
  perform public.owner_audit('credits.reverse', t.org_id::text,
    jsonb_build_object('org', t.org_id, 'grant_transaction_id', t.id, 'granted', t.amount, 'reversed', v_take,
                       'shortfall', t.amount - v_take, 'on_hold', v_held, 'transaction_id', v_txn, 'reason', v_why, 'balance_after', v_acc.balance),  -- 0172
    'warning');
  return jsonb_build_object('ok', true, 'duplicate', false, 'transaction_id', v_txn, 'granted', t.amount,
                            'reversed', v_take, 'shortfall', t.amount - v_take, 'on_hold', v_held, 'balance', v_acc.balance,  -- 0172
                            'available', v_acc.balance - v_acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The lot trigger: 0167's body, plus the grant's own lot for a reversal
-- ───────────────────────────────────────────────────────────────────────────
-- Unchanged but for the lines marked 0172. The three lot settings never meet: nightshift.refund_lot is read only for a 'refund' row,
-- nightshift.adjust_lot_first (an external id, 0165's referral clawback) and nightshift.reverse_lot (a lot id, this file) only for an
-- 'adjust' row, and each writer sets its own transaction-local just before its insert and resets it right after.
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
      -- 0172: an owner's reversal of a grant, and its collection from a released hold, names the grant's own lot; this org's lots only.
      prefer := coalesce((select l.id from public.credit_lots l  -- 0172
                           where l.org_id = new.org_id  -- 0172
                             and l.id::text = nullif(current_setting('nightshift.reverse_lot', true), '')), prefer);  -- 0172
    end if;
    perform public.credit_lots_spend_locked(new.org_id, -amt, new.job_id, new.id, prefer);
  end if;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. A released hold pays the reversal that met it
-- ───────────────────────────────────────────────────────────────────────────
-- Runs inside whichever function released the hold, which already holds the account lock (every release path locks the account
-- first, 0020). Almost no release meets a recovery, so the first statement asks the partial index and returns; nothing else is read.
-- By then credit_transactions_apply_lots has given the hold's lots back (credit_lot_moves 'release' rows of THIS ledger row, stamped
-- with the hold's job id: the filter uses credit_lot_moves_job_idx) and expired the ones that ran out, and 0167's collector has taken
-- what refunds were owed. Only the grant's own lot pays, and only what this release gave back to it.
create or replace function public.credit_grant_reversal_recover() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec   record;
  lot   public.credit_lots;
  owing numeric;
  back  numeric;
  gone  numeric;
  avail numeric;
  x     numeric;
  acc   public.credit_accounts;
begin
  if not exists (select 1 from public.credit_grant_reversal_recoveries r
                  where r.org_id = new.org_id and r.collected + r.lapsed < r.owed and new.job_id = any (r.holds)) then
    return null;
  end if;
  for rec in
    select r.grant_txn_id, r.lot_id, r.owed, r.collected, r.lapsed
      from public.credit_grant_reversal_recoveries r
     where r.org_id = new.org_id and r.collected + r.lapsed < r.owed and new.job_id = any (r.holds)
     order by r.created_at, r.grant_txn_id
     for update of r
  loop
    owing := rec.owed - rec.collected - rec.lapsed;
    select * into lot from public.credit_lots l where l.id = rec.lot_id and l.org_id = new.org_id for update;
    continue when lot.id is null;
    -- What THIS release gave back to the grant's own lot. Nothing else pays: not another lot, not credits that arrived later.
    select coalesce(sum(-m.held_delta), 0) into back
      from public.credit_lot_moves m
     where m.job_id = new.job_id and m.txn_id = new.id and m.kind = 'release' and m.lot_id = lot.id;
    continue when back <= 0;
    if lot.expired_at is not null or (lot.expires_at is not null and lot.expires_at <= now()) then
      -- The grant's own credits ran out while on the hold: gone from the organization, as the reversal meant, with no ledger row.
      update public.credit_grant_reversal_recoveries set lapsed = lapsed + least(owing, back), updated_at = now()
       where grant_txn_id = rec.grant_txn_id;
      continue;
    end if;
    -- What a collector that ran before this one (0167's credit_refund_recover, by trigger name order) already took from this lot out
    -- of this release: every spend from the lot since this ledger row. The account is locked, so nothing else spends it meanwhile.
    select coalesce(sum(-m.remaining_delta), 0) into gone
      from public.credit_lot_moves m
     where m.lot_id = lot.id and m.kind = 'spend' and m.txn_id > new.id;
    select greatest(a.balance - a.reserved, 0) into avail from public.credit_accounts a where a.org_id = new.org_id;
    x := least(owing, back - gone, lot.remaining - lot.held, coalesce(avail, 0));
    continue when x <= 0;
    update public.credit_accounts set balance = balance - x, updated_at = now() where org_id = new.org_id returning * into acc;
    perform set_config('nightshift.reverse_lot', lot.id::text, true);
    insert into public.credit_transactions
      (org_id, kind, amount, balance_after, reserved_after, job_id, external_id, note, created_by)
    values (new.org_id, 'adjust', -x, acc.balance, acc.reserved, null, null,
            left(format('owner reversal of grant #%s: %s credits taken back from hold %s, released after the reversal',
                        rec.grant_txn_id, x, new.job_id), 500),
            null);
    perform set_config('nightshift.reverse_lot', '', true);
    update public.credit_grant_reversal_recoveries set collected = collected + x, updated_at = now()
     where grant_txn_id = rec.grant_txn_id;
  end loop;
  return null;
end
$$;

drop trigger if exists credit_transactions_recover_reversals on public.credit_transactions;
create trigger credit_transactions_recover_reversals after insert on public.credit_transactions
  for each row when (new.kind = 'release' and new.amount > 0 and new.job_id is not null)
  execute function public.credit_grant_reversal_recover();

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.credit_grant_reversal_recoveries_guard() from public, anon, authenticated, service_role;
revoke all on function public.credit_grant_reversal_recover() from public, anon, authenticated, service_role;
revoke all on function public.credit_transactions_apply_lots() from public, anon, authenticated, service_role;
-- 0107's grants for the replaced function, restated: a signed-in platform owner or admin (owner_guard decides inside).
revoke all on function public.owner_reverse_grant(bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.owner_reverse_grant(bigint, text) to authenticated;

alter table public.credit_grant_reversal_recoveries enable row level security;
revoke all on public.credit_grant_reversal_recoveries from public, anon, authenticated, service_role;
grant select on public.credit_grant_reversal_recoveries to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. End state (inside the transaction: any failure rolls the whole file back)
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.owner_reverse_grant(bigint, text)'::regprocedure) <> 'de3893bbaba50d48edfa694baf39533f'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
          where oid = 'public.credit_transactions_apply_lots()'::regprocedure) <> 'aec752383dd2c5cf3621ee273a677fe0'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
          where oid = 'public.credit_grant_reversal_recover()'::regprocedure) <> 'e58362bc86d0b47c042f0bc8a2e15319' then
    raise exception '0172 end state: a function does not hold this file''s body';
  end if;
  -- Every enabled row-level AFTER INSERT trigger on the ledger, in the order Postgres fires them (by name, byte order): the lot trigger,
  -- then 0167's collector, then this one. Another one would run between them and see the account half way.
  -- tgtype bits: 1 row, 2 before, 4 insert, 64 instead of.
  if (select array_agg(t.tgname::text order by t.tgname::text collate "C")
        from pg_trigger t
       where t.tgrelid = 'public.credit_transactions'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
         and t.tgtype & 1 = 1 and t.tgtype & 2 = 0 and t.tgtype & 64 = 0 and t.tgtype & 4 = 4)
     is distinct from array['credit_transactions_apply_lots', 'credit_transactions_recover_refunds', 'credit_transactions_recover_reversals'] then
    raise exception '0172 end state: the AFTER INSERT triggers on credit_transactions must be exactly credit_transactions_apply_lots, credit_transactions_recover_refunds, credit_transactions_recover_reversals';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.credit_grant_reversal_recoveries'::regclass
        and tgname in ('credit_grant_reversal_recoveries_guard', 'credit_grant_reversal_recoveries_no_truncate') and tgenabled = 'O') <> 2 then
    raise exception '0172 end state: the guard triggers on credit_grant_reversal_recoveries are missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.credit_grant_reversal_recoveries'::regclass)
     or has_table_privilege('anon', 'public.credit_grant_reversal_recoveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.credit_grant_reversal_recoveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.credit_grant_reversal_recoveries', 'INSERT')
     or has_table_privilege('service_role', 'public.credit_grant_reversal_recoveries', 'INSERT')
     or has_table_privilege('service_role', 'public.credit_grant_reversal_recoveries', 'UPDATE')
     or has_table_privilege('service_role', 'public.credit_grant_reversal_recoveries', 'DELETE') then
    raise exception '0172 end state: credit_grant_reversal_recoveries must have RLS on and be readable by the service role only';
  end if;
  if has_function_privilege('anon', 'public.owner_reverse_grant(bigint, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.owner_reverse_grant(bigint, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.owner_reverse_grant(bigint, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.credit_grant_reversal_recover()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.credit_grant_reversal_recover()', 'EXECUTE') then
    raise exception '0172 end state: owner_reverse_grant() must be executable by signed-in users only (owner_guard decides), the collector by no API role';
  end if;
  if exists (select 1 from pg_proc p where p.oid in ('public.owner_reverse_grant(bigint, text)'::regprocedure,
                                                     'public.credit_grant_reversal_recover()'::regprocedure,
                                                     'public.credit_transactions_apply_lots()'::regprocedure)
                and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
    raise exception '0172 end state: a definer function lost security definer or its pinned search_path';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (the SQL editor on the live project, after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.owner_reverse_grant(bigint,text)'::regprocedure) = 'de3893bbaba50d48edfa694baf39533f' as reverse_body,
--     (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--       where oid = 'public.credit_transactions_apply_lots()'::regprocedure) = 'aec752383dd2c5cf3621ee273a677fe0' as lots_body,
--     exists (select 1 from pg_trigger where tgrelid = 'public.credit_transactions'::regclass
--              and tgname = 'credit_transactions_recover_reversals') as recover_trigger,
--     (select relrowsecurity from pg_class where oid = 'public.credit_grant_reversal_recoveries'::regclass)
--       and not has_table_privilege('authenticated', 'public.credit_grant_reversal_recoveries', 'SELECT') as recoveries_closed;
--
-- Reversals whose held part is still open (each is collected when one of its holds is released; one whose holds were all captured or
-- released is not open, whatever is left of `owed`):
--   select r.grant_txn_id, r.org_id, r.owed, r.collected, r.lapsed, r.holds from public.credit_grant_reversal_recoveries r
--    where r.collected + r.lapsed < r.owed
--      and exists (select 1 from public.credit_reservations c where c.job_id = any (r.holds) and c.status = 'open')
--    order by r.created_at;
--
-- What a reversal finally could not take back (credits the workspace spent; only the grant's own expired credits count as lapsed):
--   select t.external_id, g.amount + t.amount - coalesce(r.collected + r.lapsed, 0) as not_recovered
--     from public.credit_transactions t
--     join public.credit_transactions g on t.external_id = 'owner-reverse:' || g.id
--     left join public.credit_grant_reversal_recoveries r on r.grant_txn_id = g.id
--    where g.amount + t.amount > 0;
