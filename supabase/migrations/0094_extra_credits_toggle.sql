-- 0094_extra_credits_toggle.sql — the Usage page: "Use extra credits when my
-- plan credits run out", and the one read the page is built on.
--
-- WHAT IT ADDS
--   credit_accounts.use_extra_credits  boolean, DEFAULT TRUE. One switch per
--       workspace. ON is what every workspace had before this migration: a
--       run is held against plan credits first, then top-up packs, then
--       never-expiring credits (0034's spend order, unchanged). OFF: a NEW
--       hold may draw only on plan (subscription) credits and non-pack
--       credits (welcome credits, operator grants, adjustments). Top-up
--       packs are left untouched, and when what is left is not enough the run
--       is refused before anything is held.
--   set_use_extra_credits(org, on)     the person who runs the workspace flips
--       it. Nobody else (not another tenant, not the operator, not the service
--       key): the function checks auth.uid() against org_members.
--   usage_summary(org)                 everything the Usage page shows, as one
--       jsonb snapshot of the caller's OWN workspace: plan, billing period,
--       plan credits granted / spent / held in the period, extra (pack) and
--       bonus credits with their soonest expiry, parallel runs, enforced
--       plan limits, and the switch. Read gate = billing_summary's (a member,
--       the platform, a trusted caller); anyone else gets null.
--   credit_spendable_internal(org)     what a NEW hold may draw on right now
--       under the switch (internal: no API role may call it; reserve_credits
--       uses it, and so may any other definer function that must explain a
--       refusal, e.g. the MCP OAuth tool errors).
--
-- WHAT "EXTRA" MEANS
--   An extra lot is a credit_lots row with source = 'pack' (credits bought as a
--   one-time pack). Everything else keeps working with the switch OFF:
--   'subscription' (the plan), 'grant' (welcome credits and operator grants)
--   and 'adjustment' (corrections, carried-over balances, refunds of old
--   spend). A refund that restores spend to the pack lot it came from puts the
--   credits back in the pack lot, as before.
--
-- WHERE IT IS ENFORCED (one place, so EVERY spending route obeys it)
--   Every paid action (Run now, studio jobs, storyboards, scene regeneration,
--   repurposing, downloads, API generations, MCP OAuth calls, workflow steps)
--   holds credits through public.reserve_credits(), which writes a 'reserve'
--   ledger row, whose trigger (0034) calls credit_lots_hold_locked(). Both are
--   replaced here, on the LATEST bodies (reserve_credits: 0020, never
--   redefined; credit_lots_hold_locked: 0034, never redefined):
--     * reserve_credits keeps every check it had (caller must run the
--       workspace, job reference shape, exempt workspace, amount range, the
--       platform minimum, stale-hold release, duplicate job, total available)
--       and adds ONE check after them: with the switch OFF and not enough
--       spendable credit it refuses with NS402 — the same error code as an
--       empty balance, so every caller that already handles "insufficient
--       credits" handles this — carrying "available=<plan credits>
--       needed=<n> extra_off=1 extra=<pack credits>" in the detail. Nothing
--       is held, nothing is charged.
--     * credit_lots_hold_locked skips pack lots when the switch is OFF, so even
--       a caller that skipped the check above could not touch a pack lot.
--   The switch is read from the account row that every money function locks
--   first (credit_account_lock): a flip waits for a reservation in flight, and
--   the next reservation sees the new value. Flipping never touches a hold
--   that already exists: a run already started keeps the lots it was held on,
--   settles (capture) and releases against them, and is never killed.
--
-- NOT CHANGED, on purpose
--   Capture / release / refund / expiry / the lot invariants / the parallel-run
--   limit / idempotency (a job reference reserves once) / the operator's own
--   workspace (exempt: reserve_credits answers before any lot logic). The
--   settlement of a hold that is already placed is not constrained by the
--   switch (capture_credits' optional over-capture, unused by the app, still
--   draws on any available lot): the switch governs what a NEW run may start.
--
-- Additive and idempotent: add column if not exists, create or replace,
-- explicit revoke/grant. Needs 0020, 0034 and 0091 (workspace owners).

do $$
begin
  if to_regprocedure('public.reserve_credits(uuid, text, numeric)') is null
     or to_regprocedure('public.credit_lots_hold_locked(uuid, text, numeric, bigint)') is null
     or to_regprocedure('public.billing_may_read(uuid)') is null then
    raise exception '0094 needs credits and plans: apply 0020 and 0034 first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The switch
-- ───────────────────────────────────────────────────────────────────────────

alter table public.credit_accounts
  add column if not exists use_extra_credits boolean not null default true;

comment on column public.credit_accounts.use_extra_credits is
  '0094: true (default) = a new run may use top-up pack credits after plan credits; false = only plan, welcome/grant and adjustment credits. Read by reserve_credits and credit_lots_hold_locked under the account lock. Changed only through set_use_extra_credits().';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. What a new hold may draw on
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_spendable_internal(p_org uuid) returns numeric
  language sql volatile security definer set search_path = public, pg_temp as $$
  select coalesce(sum(l.remaining - l.held), 0)
    from public.credit_lots l
   where l.org_id = p_org
     and l.remaining > l.held
     and (l.expires_at is null or l.expires_at > now())
     and (l.source <> 'pack'
          or coalesce((select a.use_extra_credits from public.credit_accounts a where a.org_id = p_org), true))
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. reserve_credits: 0020's body, plus the one refusal
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.reserve_credits(p_org uuid, p_job_id text, p_amount numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  amt     numeric := public.credits_round_up(p_amount);
  job     text := btrim(coalesce(p_job_id, ''));
  acc     public.credit_accounts;
  floor_c numeric;
  avail   numeric;
  spend_  numeric;
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

  -- 0094: with extra credits off, the run may start only on credit that is not
  -- a top-up pack. Refused here, before any hold, with the figures the person
  -- needs: what the plan side can pay, what the run needs, what is waiting in
  -- packs. The same NS402 code as an empty balance.
  if not acc.use_extra_credits then
    spend_ := public.credit_spendable_internal(p_org);
    if spend_ < amt then
      raise exception 'insufficient credits'
        using errcode = 'NS402',
              detail = format('available=%s needed=%s extra_off=1 extra=%s', spend_, amt, greatest(avail - spend_, 0)),
              hint = 'Extra credits are off for this organization. Turn them on, add credits, or upgrade the plan.';
    end if;
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. credit_lots_hold_locked: 0034's body, minus pack lots when the switch is off
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_lots_hold_locked(p_org uuid, p_job text, p_amount numeric, p_txn bigint)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  left_ numeric := p_amount;
  l record;
  take numeric;
  extra_ boolean;
begin
  -- The account row is already locked by the caller (every money function
  -- starts at credit_account_lock), so this is the value the reservation saw.
  select a.use_extra_credits into extra_ from public.credit_accounts a where a.org_id = p_org;
  extra_ := coalesce(extra_, true);
  for l in
    select id, remaining, held from public.credit_lots
     where org_id = p_org and remaining > held and (expires_at is null or expires_at > now())
       and (extra_ or source <> 'pack')
     order by (source <> 'subscription'), expires_at asc nulls last, id
     for update
  loop
    exit when left_ <= 0;
    take := least(l.remaining - l.held, left_);
    update public.credit_lots set held = held + take, updated_at = now() where id = l.id;
    insert into public.credit_hold_lots (job_id, lot_id, amount) values (p_job, l.id, take)
      on conflict (job_id, lot_id) do update set amount = public.credit_hold_lots.amount + excluded.amount;
    perform public.credit_lot_move(p_org, l.id, p_txn, p_job, 'hold', 0, take);
    left_ := left_ - take;
  end loop;
  if left_ > 0 then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', p_amount - left_, p_amount),
            hint = 'Add credits to this organization, or start a shorter run.';
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The person flips the switch
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_use_extra_credits(p_org uuid, p_on boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  me   uuid := auth.uid();
  was_ boolean;
begin
  if me is null then
    raise exception 'sign in to change this' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'say whether extra credits are on or off' using errcode = '22023';
  end if;
  -- The person who runs the workspace, bound to this account (not an invitation
  -- matched by e-mail, not the platform operator acting for a customer).
  if p_org is null or not exists (
       select 1 from public.org_members m
        where m.org_id = p_org and m.user_id = me and m.role in ('owner', 'admin')) then
    raise exception 'only the person who runs this workspace may change this' using errcode = '42501';
  end if;
  -- Account lock first, like every money function: a reservation in flight
  -- finishes before this takes effect, and the next one sees the new value.
  perform public.credit_account_lock(p_org);
  select a.use_extra_credits into was_ from public.credit_accounts a where a.org_id = p_org;
  update public.credit_accounts
     set use_extra_credits = p_on, updated_at = now()
   where org_id = p_org;
  return jsonb_build_object('use_extra_credits', p_on, 'changed', was_ is distinct from p_on);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The Usage page's read
-- ───────────────────────────────────────────────────────────────────────────
-- Live lots only (not expired): a lot that ran out at the end of its period is
-- history, and counting its emptied remainder as "spent" would be a lie. Plan
-- credits "granted" is what the period's lot(s) were given (the first payment,
-- plus a mid-period upgrade's pro-rated top-up); "spent" is what the runs have
-- charged from them (granted - remaining); "held" is on hold for runs in
-- progress and is not yet spent. Nothing here is a margin, a cost or another
-- workspace's figure.

create or replace function public.usage_summary(p_org uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with acc as (
    select a.use_extra_credits as on_ from public.credit_accounts a where a.org_id = p_org
  ), live as (
    select source, amount, remaining, held, expires_at, period_start, period_end
      from public.credit_lots
     where org_id = p_org and (expires_at is null or expires_at > now())
  ), planlots as (
    select * from live where source = 'subscription'
  ), packs as (
    select * from live where source = 'pack' and remaining > held
  ), bonus as (
    select * from live where source in ('grant', 'adjustment') and remaining > held
  ), plan_ as (
    select p.* from public.plans p where p.id = public.org_plan_internal(p_org)
  ), sub as (
    select s.* from public.subscriptions s
     where s.org_id = p_org
     order by (s.status in ('active', 'trialing', 'past_due')) desc, s.updated_at desc, s.id desc
     limit 1
  )
  select case when not public.billing_may_read(p_org) then null else jsonb_build_object(
    'exempt', public.credits_exempt(p_org),
    'extra_enabled', coalesce((select on_ from acc), true),
    'plan', (select jsonb_build_object('id', id, 'name', name, 'monthly_credits', monthly_credits,
                                       'is_default', is_default) from plan_),
    'subscription', (select jsonb_build_object(
                       'status', status,
                       'current_period_start', current_period_start,
                       'current_period_end', current_period_end,
                       'cancel_at_period_end', cancel_at_period_end) from sub),
    'plan_credits', (select case when count(*) = 0 then null else jsonb_build_object(
                       'granted', sum(amount),
                       'spent', sum(amount - remaining),
                       'held', sum(held),
                       'left', sum(remaining - held),
                       'period_start', min(period_start),
                       'period_end', max(period_end)) end from planlots),
    'last_plan_period_end', (select max(l.period_end) from public.credit_lots l
                              where l.org_id = p_org and l.source = 'subscription'),
    'extra_credits', jsonb_build_object(
      'available', coalesce((select sum(remaining - held) from packs), 0),
      'soonest_expiry', (select min(expires_at) from packs)),
    'bonus_credits', jsonb_build_object(
      'available', coalesce((select sum(remaining - held) from bonus), 0),
      'soonest_expiry', (select min(expires_at) from bonus)),
    'spendable_now', public.credit_spendable_internal(p_org),
    'run_slots', public.org_run_slots(p_org),
    'entitlements', coalesce((
      select jsonb_object_agg(e.key, e.value)
        from jsonb_each(public.org_entitlements_internal(p_org)) e
        join public.entitlement_keys k on k.key = e.key and k.status = 'enforced'), '{}'::jsonb))
  end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.credit_spendable_internal(uuid) from public, anon, authenticated, service_role;
-- Restated: both were replaced above. 0020's grants for reserve_credits (a
-- signed-in browser and the service role; never anon); 0034's none for the lock.
revoke all on function public.reserve_credits(uuid, text, numeric) from public, anon;
grant execute on function public.reserve_credits(uuid, text, numeric) to authenticated, service_role;
revoke all on function public.credit_lots_hold_locked(uuid, text, numeric, bigint) from public, anon, authenticated, service_role;

revoke all on function public.set_use_extra_credits(uuid, boolean) from public, anon, service_role;
grant execute on function public.set_use_extra_credits(uuid, boolean) to authenticated;
revoke all on function public.usage_summary(uuid) from public, anon;
grant execute on function public.usage_summary(uuid) to authenticated, service_role;

-- Verify (expect every column true):
--   select
--     exists (select 1 from information_schema.columns where table_schema = 'public'
--              and table_name = 'credit_accounts' and column_name = 'use_extra_credits'
--              and column_default = 'true' and is_nullable = 'NO') as switch_column,
--     not exists (select 1 from public.credit_accounts where not use_extra_credits) as everyone_on_until_they_choose,
--     pg_get_functiondef('public.credit_lots_hold_locked(uuid, text, numeric, bigint)'::regprocedure) like '%extra_ or source <> ''pack''%' as hold_skips_packs_when_off,
--     pg_get_functiondef('public.reserve_credits(uuid, text, numeric)'::regprocedure) like '%extra_off=1%' as reserve_refuses_when_off,
--     has_function_privilege('authenticated', 'public.set_use_extra_credits(uuid, boolean)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.set_use_extra_credits(uuid, boolean)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.set_use_extra_credits(uuid, boolean)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.usage_summary(uuid)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.usage_summary(uuid)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.credit_spendable_internal(uuid)', 'EXECUTE') as acl_ok;
