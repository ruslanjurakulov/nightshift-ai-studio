-- 0027_welcome_credits.sql — 100 free credits for a new account's first
-- organization (self-serve sign-up).
--
-- WHAT IT ADDS
--   grant_welcome_credits()  a trigger function, AFTER INSERT on organizations.
--                            When a signed-in person creates their FIRST
--                            organization (through create_organization(), the
--                            only way an organization is created from the
--                            API), it adds WELCOME_CREDITS to that
--                            organization's account through the 0020 ledger:
--                            one 'grant' row, note 'welcome credits',
--                            external_id 'welcome:<user id>'.
--
-- ONCE PER USER, ENFORCED BY THE DATABASE
--   The marker is the ledger's own unique index on external_id (0020,
--   credit_transactions_external_id_key). credit_transactions is append-only —
--   no browser, service key or SQL editor may update or delete a row — so a
--   marker, once written, is permanent: a second organization, a retried
--   request, or two concurrent create_organization() calls cannot mint a
--   second grant. A concurrent duplicate hits the unique index; that is caught
--   inside a subtransaction, so the losing call still creates its organization
--   and simply gets no credits.
--
-- WHO GETS THEM
--   * the caller is signed in (auth.uid()), and is the organization's creator;
--   * this is the first organization that account has created — an existing
--     customer creating another workspace gets nothing, and nor does anyone
--     whose account predates this migration and already has an organization;
--   * the account's email address is confirmed (auth.users.email_confirmed_at)
--     — sign-in already requires it with "Confirm email" on; this makes the
--     grant not depend on that project setting;
--   * the organization is not the operator's default one (it never pays).
--   An organization created from the SQL editor (no auth.uid()) gets nothing.
--
-- NO NEW WAY TO MINT CREDITS
--   There is no RPC. A trigger function cannot be called directly, and EXECUTE
--   on it is revoked from everyone anyway. Organizations cannot be inserted by
--   a browser (0018 revokes insert on organizations from anon/authenticated),
--   and create_organization() caps an account at 10 organizations — but only
--   the first ever earns the grant. No RLS policy and no table grant is
--   changed.
--
-- Additive and idempotent: create-or-replace function, drop-then-create
-- trigger. Requires 0018 (organizations) and 0020 (credits). Safe to re-run.

create or replace function public.grant_welcome_credits() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- WELCOME_CREDITS: the one place the amount is set.
  welcome_credits constant numeric := 100;
  uid    uuid := auth.uid();
  marker text;
begin
  if uid is null or new.created_by is distinct from uid then
    return new;
  end if;
  if public.credits_exempt(new.id) then
    return new;
  end if;
  -- This row is visible to its own AFTER trigger, so "first" is a count of 1.
  if (select count(*) from public.organizations where created_by = uid) <> 1 then
    return new;
  end if;
  if not exists (
    select 1 from auth.users u where u.id = uid and u.email_confirmed_at is not null
  ) then
    return new;
  end if;

  marker := 'welcome:' || uid::text;
  if exists (select 1 from public.credit_transactions where external_id = marker) then
    return new;
  end if;

  begin
    perform public.credit_account_lock(new.id);
    update public.credit_accounts
       set balance = balance + welcome_credits, updated_at = now()
     where org_id = new.id;
    perform public.credit_log(new.id, 'grant', welcome_credits, null, marker, 'welcome credits');
  exception when unique_violation then
    -- Another call for the same account won the race and holds the marker:
    -- this subtransaction (balance included) is rolled back, the organization
    -- is still created.
    null;
  end;
  return new;
end
$$;

revoke all on function public.grant_welcome_credits() from public, anon, authenticated, service_role;

drop trigger if exists organizations_welcome_credits on public.organizations;
create trigger organizations_welcome_credits
  after insert on public.organizations
  for each row execute function public.grant_welcome_credits();

comment on function public.grant_welcome_credits() is
  'Trigger (0027): 100 credits, once per user (credit_transactions.external_id = welcome:<user id>), into the first organization a confirmed account creates. Not callable directly.';
