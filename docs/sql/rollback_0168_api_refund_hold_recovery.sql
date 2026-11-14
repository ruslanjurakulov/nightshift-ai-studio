-- rollback_0168_api_refund_hold_recovery.sql — takes migration 0168 (a refund of an API top-up that met a hold collects when the hold is
-- released) out again. OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: the collection. After this, a refund of an API top-up that meets a hold takes only what is available and records the
-- rest as "already spent" for good, as 0031 did, and a released hold gives those cents back to the customer (BR-0031-01 is open again).
-- Nothing stored is lost: api_refund_recoveries stays, with its guard (append-only but for `collected`), as the record of what was owed
-- and collected; every collection already made stays a 'refund' row in api_ledger. No balance changes.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if api_refund_topup() or api_refund_recover() is not 0168's body (a later change would be undone).
--   1. Drops the trigger api_ledger_recover_refunds and the function api_refund_recover().
--   2. Puts back api_refund_topup() as 0031 left it, character for character, with 0031's grants (service role only).
--   3. Asserts the end state: 0031's body (md5 a9d2287173b12b704808e7b3747b05e0), no recover trigger or function.

begin;
set local lock_timeout = '5s';

do $$
declare
  r text;
  c text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into r
    from pg_proc p where p.oid = to_regprocedure('public.api_refund_topup(text, text, bigint, text, text)');
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into c
    from pg_proc p where p.oid = to_regprocedure('public.api_refund_recover()');
  if r is distinct from '74ea95ec27564e57b7b989a906a15842' then
    raise exception 'rollback 0168: api_refund_topup() is not 0168''s body (md5 %): a later change would be undone; read the live body first', r;
  end if;
  if c is not null and c <> '785ca1a1df7d72192bd98dbfd9122a37' then
    raise exception 'rollback 0168: api_refund_recover() is not 0168''s body (md5 %): a later change would be undone; read the live body first', c;
  end if;
end $$;

drop trigger if exists api_ledger_recover_refunds on public.api_ledger;
drop function if exists public.api_refund_recover();

-- 0031's body, verbatim.
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
                              'shortfall_cents', prior.requested_cents + prior.amount_cents);
  end if;
  select coalesce(sum(l.requested_cents), 0) into already
    from public.api_ledger l where l.kind = 'refund' and l.source_external_id = ext;
  asked := least(coalesce(p_cents, topup.amount_cents), greatest(topup.amount_cents - already, 0));
  taken := least(asked, greatest(acc.balance_cents - acc.reserved_cents, 0));
  short := asked - taken;
  update public.api_accounts
     set balance_cents = balance_cents - taken,
         paid_total_cents = greatest(paid_total_cents - asked, 0), updated_at = now()
   where org_id = topup.org_id returning * into acc;
  msg := format('%s of top-up %s: %s cents', why, ext, asked);
  if short > 0 then
    msg := msg || format(' — %s taken back, %s already spent and NOT recovered', taken, short);
  end if;
  if coalesce(btrim(p_note), '') <> '' then
    msg := msg || ' · ' || btrim(p_note);
  end if;
  -- Written even when nothing could be taken: the history must show it.
  txn := public.api_log(topup.org_id, 'refund', -taken, null, null, rid, ext, asked, msg);
  return jsonb_build_object('duplicate', false, 'requested_cents', asked, 'taken_cents', taken,
                            'shortfall_cents', short, 'ledger_id', txn);
end
$$;

revoke all on function public.api_refund_topup(text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.api_refund_topup(text, text, bigint, text, text) to service_role;

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = 'public.api_refund_topup(text, text, bigint, text, text)'::regprocedure) <> 'a9d2287173b12b704808e7b3747b05e0' then
    raise exception 'rollback 0168 end state: api_refund_topup() is not 0031''s body';
  end if;
  if to_regprocedure('public.api_refund_recover()') is not null
     or exists (select 1 from pg_trigger where tgrelid = 'public.api_ledger'::regclass and tgname = 'api_ledger_recover_refunds') then
    raise exception 'rollback 0168 end state: the collector is still there';
  end if;
end $$;

commit;

-- Verify (read-only, after): select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = 'a9d2287173b12b704808e7b3747b05e0' as body_0031,
--   to_regprocedure('public.api_refund_recover()') is null as collector_gone
--   from pg_proc where oid = 'public.api_refund_topup(text,text,bigint,text,text)'::regprocedure;
