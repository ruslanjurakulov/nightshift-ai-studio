-- rollback_0172_grant_reversal_hold_recovery.sql — takes migration 0172 (an owner's grant reversal that met a hold collects when the
-- hold is released) out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the collection. After this, a reversal that meets a hold takes only what is unheld and records the rest as a shortfall
-- for good, as 0107 did, and a released hold gives those credits back to the workspace (BR-0107-01 is open again). The reversal's own
-- 'adjust' row spends in normal lot order again. Nothing stored is lost: credit_grant_reversal_recoveries stays, with its guard
-- (append-only but for `collected` and `lapsed`), as the record of what was owed and collected; every collection already made stays an
-- 'adjust' row in the ledger. No balance changes.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if owner_reverse_grant(), credit_transactions_apply_lots() or credit_grant_reversal_recover() is not
--      0172's body (a later change would be undone).
--   1. Drops the trigger credit_transactions_recover_reversals and the function credit_grant_reversal_recover().
--   2. Puts back owner_reverse_grant() as 0107 left it and credit_transactions_apply_lots() as 0167 left it, character for character,
--      with their grants.
--   3. Asserts the end state: those bodies (md5 4c701e7930d213f6f1ba84485c366a36 and 6098f97a7630bed24807bb7c5ef6eefe), no recover
--      trigger or function.

begin;
set local lock_timeout = '5s';

do $$
declare
  o text;
  a text;
  c text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into o
    from pg_proc p where p.oid = to_regprocedure('public.owner_reverse_grant(bigint, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a
    from pg_proc p where p.oid = to_regprocedure('public.credit_transactions_apply_lots()');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into c
    from pg_proc p where p.oid = to_regprocedure('public.credit_grant_reversal_recover()');
  if o is distinct from 'de3893bbaba50d48edfa694baf39533f' then
    raise exception 'rollback 0172: owner_reverse_grant() is not 0172''s body (md5 %): a later change would be undone; read the live body first', o;
  end if;
  if a is distinct from 'aec752383dd2c5cf3621ee273a677fe0' then
    raise exception 'rollback 0172: credit_transactions_apply_lots() is not 0172''s body (md5 %): a later change would be undone; read the live body first', a;
  end if;
  if c is not null and c <> 'e58362bc86d0b47c042f0bc8a2e15319' then
    raise exception 'rollback 0172: credit_grant_reversal_recover() is not 0172''s body (md5 %): a later change would be undone; read the live body first', c;
  end if;
end $$;

drop trigger if exists credit_transactions_recover_reversals on public.credit_transactions;
drop function if exists public.credit_grant_reversal_recover();

-- owner_reverse_grant as 0107 left it, verbatim.
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
                              'shortfall', t.amount + v_prior.amount, 'balance', v_acc.balance);
  end if;

  select * into l from public.credit_lots where created_txn = t.id;
  v_unspent := case when found then greatest(l.remaining - l.held, 0) else t.amount end;
  v_take := least(t.amount, v_unspent, greatest(v_acc.balance - v_acc.reserved, 0));
  if v_take <= 0 then
    return public.owner_err('nothing_to_reverse', 'None of that grant is left to take back.',
      jsonb_build_object('granted', t.amount, 'shortfall', t.amount));
  end if;

  begin
    update public.credit_accounts set balance = balance - v_take, updated_at = now()
     where org_id = t.org_id returning * into v_acc;
    v_txn := public.credit_log(t.org_id, 'adjust', -v_take, null, v_ext,
                               'owner reversal of grant #' || t.id || ': ' || v_why);
  exception
    when unique_violation then
      return public.owner_err('already_reversed', 'That grant was already reversed.');
    when sqlstate 'NS402' then
      return public.owner_err('nothing_to_reverse', 'None of that grant is left to take back.',
        jsonb_build_object('granted', t.amount, 'shortfall', t.amount));
  end;

  perform public.owner_audit('credits.reverse', t.org_id::text,
    jsonb_build_object('org', t.org_id, 'grant_transaction_id', t.id, 'granted', t.amount, 'reversed', v_take,
                       'shortfall', t.amount - v_take, 'transaction_id', v_txn, 'reason', v_why, 'balance_after', v_acc.balance),
    'warning');
  return jsonb_build_object('ok', true, 'duplicate', false, 'transaction_id', v_txn, 'granted', t.amount,
                            'reversed', v_take, 'shortfall', t.amount - v_take, 'balance', v_acc.balance,
                            'available', v_acc.balance - v_acc.reserved);
end
$$;

-- The lot trigger as 0167 left it, verbatim (0172 added the nightshift.reverse_lot lines; nothing reads that setting once the reversal
-- and the collector are 0107's and gone).
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

revoke all on function public.credit_transactions_apply_lots() from public, anon, authenticated, service_role;
revoke all on function public.owner_reverse_grant(bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.owner_reverse_grant(bigint, text) to authenticated;

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.owner_reverse_grant(bigint, text)'::regprocedure) <> '4c701e7930d213f6f1ba84485c366a36'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
          where oid = 'public.credit_transactions_apply_lots()'::regprocedure) <> '6098f97a7630bed24807bb7c5ef6eefe' then
    raise exception 'rollback 0172 end state: owner_reverse_grant() or credit_transactions_apply_lots() is not the earlier body';
  end if;
  if to_regprocedure('public.credit_grant_reversal_recover()') is not null
     or exists (select 1 from pg_trigger where tgrelid = 'public.credit_transactions'::regclass
                   and tgname = 'credit_transactions_recover_reversals') then
    raise exception 'rollback 0172 end state: the collector is still there';
  end if;
end $$;

commit;
