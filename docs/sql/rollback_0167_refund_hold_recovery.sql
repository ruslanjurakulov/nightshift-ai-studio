-- rollback_0167_refund_hold_recovery.sql — takes migration 0167 (a refund that met a hold collects when the hold is released) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the collection. After this, a refund that meets a hold takes only what is available and records the rest as a
-- shortfall for good, as 0034 did, and a released hold gives those credits back to the buyer (Breach BR-0034-01 is open again).
-- Nothing stored is lost: credit_refund_recoveries stays, with its guard (append-only but for `collected` and `lapsed`), as the record of what was
-- owed and collected; every collection already made stays a 'refund' row in the ledger. No balance changes.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if refund_purchased_credits(), credit_transactions_apply_lots() or credit_refund_recover() is not
--      0167's body (a later change would be undone).
--   1. Drops the trigger credit_transactions_recover_refunds and the function credit_refund_recover().
--   2. Puts back refund_purchased_credits() and credit_transactions_apply_lots() as 0034 left them, character for character, with
--      0021's and 0034's grants.
--   3. Asserts the end state: 0034's bodies (md5 766daf507d4e70711b8622aebbea7705 and 8ab35cff8ac8a145403b0e6eca735697), no recover
--      trigger or function.

begin;
set local lock_timeout = '5s';

do $$
declare
  r text;
  c text;
  a text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r
    from pg_proc p where p.oid = to_regprocedure('public.refund_purchased_credits(text, text, numeric, text, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into c
    from pg_proc p where p.oid = to_regprocedure('public.credit_refund_recover()');
  if r is distinct from '1024ac369b7a18830ac547e41c5ca89e' then
    raise exception 'rollback 0167: refund_purchased_credits() is not 0167''s body (md5 %): a later change would be undone; read the live body first', r;
  end if;
  if c is not null and c <> '0c16bb426e63c1bc1d9fa2518f45b921' then
    raise exception 'rollback 0167: credit_refund_recover() is not 0167''s body (md5 %): a later change would be undone; read the live body first', c;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a
    from pg_proc p where p.oid = to_regprocedure('public.credit_transactions_apply_lots()');
  if a is distinct from 'fdd309d7a7786168ae62b67bce11222d' then
    raise exception 'rollback 0167: credit_transactions_apply_lots() is not 0167''s body (md5 %): a later change would be undone; read the live body first', a;
  end if;
end $$;

drop trigger if exists credit_transactions_recover_refunds on public.credit_transactions;
drop function if exists public.credit_refund_recover();

-- 0034's lot trigger, verbatim (0167 added the nightshift.refund_lot lines; nothing else reads that setting once the collector is gone).
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

revoke all on function public.credit_transactions_apply_lots() from public, anon, authenticated, service_role;

-- 0034's body, verbatim.
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

revoke all on function public.refund_purchased_credits(text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.refund_purchased_credits(text, text, numeric, text, text) to service_role;

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.refund_purchased_credits(text, text, numeric, text, text)'::regprocedure) <> '766daf507d4e70711b8622aebbea7705' then
    raise exception 'rollback 0167 end state: refund_purchased_credits() is not 0034''s body';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.credit_transactions_apply_lots()'::regprocedure) <> '8ab35cff8ac8a145403b0e6eca735697' then
    raise exception 'rollback 0167 end state: credit_transactions_apply_lots() is not 0034''s body';
  end if;
  if to_regprocedure('public.credit_refund_recover()') is not null
     or exists (select 1 from pg_trigger where tgrelid = 'public.credit_transactions'::regclass and tgname = 'credit_transactions_recover_refunds') then
    raise exception 'rollback 0167 end state: the recover trigger or its function is still there';
  end if;
  if has_function_privilege('authenticated', 'public.refund_purchased_credits(text, text, numeric, text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.refund_purchased_credits(text, text, numeric, text, text)', 'EXECUTE') then
    raise exception 'rollback 0167 end state: refund_purchased_credits() must be executable by the service role only';
  end if;
end $$;

commit;
