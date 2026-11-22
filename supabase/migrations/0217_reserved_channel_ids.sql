-- 0217_reserved_channel_ids.sql — the database refuses a channel id that is a page of the site's own.
--
-- WHAT WAS WRONG
--   A channel id is also the first segment of every Command Center URL (/{channel}/{section}). The words that segment
--   already means at the root (/privacy, /pricing, /docs, /owner, and the public site's language prefixes /ru and /uz)
--   are refused by the app: isValidChannelId (command-center/lib/channels.ts) checks RESERVED_ROOT_SEGMENTS
--   (command-center/lib/public-paths.ts). The database enforced only the SHAPE (create_channel, 0086 and 0114: a
--   lowercase slug of 2 to 39 characters). So a channel called "privacy" or "ru" could still be made by anything that
--   does not go through the wizard (the create_channel RPC called directly, the service role, the SQL editor), and its
--   screens would be shadowed by the page of the same name: a channel nobody can open, and a rule that lived only in a
--   form (CLAUDE.md rule 7: a rule that lives only in a form is a rule until someone uses the API).
--
-- WHAT THIS CHANGES
--   1. is_reserved_channel_id(text): the ONE list in SQL, case-insensitive (lower()). It must equal
--      RESERVED_ROOT_SEGMENTS as a set; command-center/tests/reserved-channel-ids.test.ts parses the array out of the
--      newest migration that defines this function and fails when the two lists differ, so a word added to the app's
--      list needs a migration that adds it here. Executable by authenticated and service_role, because a CHECK
--      constraint runs its function as the role writing the row: an editor renaming their channel (an UPDATE of
--      public.channels through PostgREST) must be able to evaluate it. It is a pure function of its argument and reveals
--      nothing; anon writes no channel and gets nothing.
--   2. create_channel() (0114's body, every line and literal kept) refuses a reserved id right after the shape check,
--      before anything is looked up or written, the same way it already reports a bad id: SQLSTATE 22023, message prefix
--      'reserved_channel_id:' naming the id and the remedy, hint 'reserved_channel_id'. Without it the refusal would be
--      the CHECK below firing on the insert, a raw 23514 naming a constraint, which says nothing a person can act on.
--   3. CHECK channels_channel_id_not_reserved on public.channels.channel_id, added NOT VALID and then validated, so it
--      holds for every writer: the service role (modules/supabase_sync.py upserts channel rows), the SQL editor, and
--      any later definer function. An INSERT or UPDATE that would leave a reserved id is refused with 23514.
--      Before adding it, the file looks for existing rows with a reserved id. If there are any, it raises a WARNING that
--      names each one and does NOT add the constraint: a constraint added NOT VALID still checks every new row version,
--      so every later write to such a row (the bot's own sync upsert included) would start failing, and a live channel
--      would stop updating with no word as to why. The remedy is in the warning; after it, run this file again.
--      (The live check before this file found no channel with the id en, ru or uz.)
--
-- WHAT IT DOES NOT CHANGE
--   No row is rewritten, renamed or deleted, and no grant on public.channels is widened. The ids the app refuses for
--   OTHER reasons (all-channels and the section names of lib/channels.ts SECTIONS, such as videos or studio) are not in
--   this list: that list is the app's routing, not a page of the site, and it is not pinned here.
--   Changing the list later: a create or replace of is_reserved_channel_id with a longer list does not re-check rows
--   already stored (Postgres trusts an immutable function). A later migration that adds a word must look for rows with
--   it first, exactly as this file does, and re-validate (drop the constraint and add it again).
--
-- NUMBER. 0217, assigned for this change; the highest on main when it was written is 0209.
--
-- REQUIRES 0018 (is_org_member), 0020 (credits_trusted_caller), 0086 (create_channel, channel_secret_name,
-- channel_may_stamp, channel_credential_build, channel_controls_changed) and 0114 (create_channel's latest body,
-- channel_label_lowering). Additive and idempotent: create or replace, revoke then grant, the constraint added only if
-- it is missing and validated only when no row breaks it. Adding the constraint takes a short ACCESS EXCLUSIVE lock on
-- public.channels (lock_timeout below); validating it takes a SHARE UPDATE EXCLUSIVE lock, which does not block reads or
-- writes of the table.
-- Rollback: docs/sql/rollback_0217_reserved_channel_ids.sql (puts 0114's create_channel back, drops the constraint and
-- the helper).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0217 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0217 needs 0020_credits.sql (credits_trusted_caller): apply it first';
  end if;
  if to_regprocedure('public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)') is null
     or to_regprocedure('public.channel_secret_name(text)') is null then
    raise exception '0217 needs 0086_channel_config_lock.sql (create_channel): apply it first';
  end if;
  if to_regprocedure('public.channel_label_lowering(jsonb)') is null then
    raise exception '0217 needs 0114_ai_disclosure_admin_lock.sql (create_channel''s latest body): apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The list: the root URL segments that are pages of the site (RESERVED_ROOT_SEGMENTS)
-- ───────────────────────────────────────────────────────────────────────────

-- lower(): the app's ids are lowercase, but the service role and the SQL editor write past create_channel's shape check,
-- and /RU is the same page as /ru to a person typing it. coalesce: a null is no reserved word (and never an id).
create or replace function public.is_reserved_channel_id(p_id text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select coalesce(lower(p_id) = any (array[
    'login', 'signup', 'forgot-password', 'reset-password', 'auth', 'welcome',
    'privacy', 'terms', 'pricing', 'solutions', 'api', 'docs',
    'oauth', 'mcp', 'i', 'invite', 'unsubscribe', 'r', 'fonts', 'atelier',
    'agent-builder', 'owner', 'roadmap', 'refund', 'data-deletion', 'referral', 'trust',
    'en', 'ru', 'uz'
  ]::text[]), false)
$$;

revoke all on function public.is_reserved_channel_id(text) from public, anon, authenticated, service_role;
grant execute on function public.is_reserved_channel_id(text) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. create_channel(): 0114's body plus the refusal, made before anything is looked up or written
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.create_channel(
  p_channel_id text, p_org uuid, p_name text, p_niche text default '',
  p_agent_config jsonb default '{}'::jsonb, p_schedule_config jsonb default '{}'::jsonb,
  p_credential jsonb default null, p_verified boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  cfg     jsonb := coalesce(p_agent_config, '{}'::jsonb);
  sched   jsonb := coalesce(p_schedule_config, '{}'::jsonb);
  stamp   boolean := coalesce(p_verified, false);
  built   jsonb := '{}'::jsonb;
  nowiso  text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  trusted boolean := public.credits_trusted_caller();
begin
  if not (trusted or (auth.uid() is not null and p_org is not null and public.is_org_member(p_org, 'editor'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_org is null then
    raise exception 'an organization is required' using errcode = '22023';
  end if;
  -- Single hyphens between letters and digits only: 'extinct-world-' and
  -- 'extinct--world' would otherwise normalise to the secret name of
  -- 'extinct-world' (channel_secret_name).
  if coalesce(p_channel_id, '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_channel_id) not between 2 and 39 then
    raise exception 'a channel id is a lowercase slug of 2 to 39 characters' using errcode = '22023';
  end if;
  -- 0217: a page of the site's own (/privacy, /ru) would shadow every screen of the channel. Refused here, by name, so
  -- the caller gets a remedy rather than the constraint below firing on the insert.
  if public.is_reserved_channel_id(p_channel_id) then
    raise exception 'reserved_channel_id: "%" is the address of a page of the site, so a channel of that id could not be opened: choose another id',
      p_channel_id using errcode = '22023', hint = 'reserved_channel_id';
  end if;
  if coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 or char_length(coalesce(p_niche, '')) > 500 then
    raise exception 'name or niche is missing or too long' using errcode = '22023';
  end if;
  if jsonb_typeof(cfg) <> 'object' or jsonb_typeof(sched) <> 'object'
     or octet_length(cfg::text) > 32768 or octet_length(sched::text) > 4096 then
    raise exception 'agent_config and schedule_config must be small objects' using errcode = '22023';
  end if;
  -- The controls that hold a render are an administrator's to set, here too.
  if cardinality(public.channel_controls_changed('{}'::jsonb, cfg)) > 0
     and not (trusted or public.is_org_member(p_org, 'admin')) then
    raise exception 'only an administrator of this organization may set: %',
      array_to_string(public.channel_controls_changed('{}'::jsonb, cfg), ', ') using errcode = '42501';
  end if;
  -- 0114: so are the settings that lower the platform label. This function is a definer, so the trigger on
  -- channels does not see the browser here: the check is made again.
  if cardinality(public.channel_label_lowering(cfg)) > 0 and not (trusted or public.is_platform_admin()) then
    raise exception 'ai_disclosure_lock: only a platform administrator may set: %',
      array_to_string(public.channel_label_lowering(cfg), ', ') using errcode = '42501', hint = 'ai_disclosure_lock';
  end if;
  if stamp and not public.channel_may_stamp(p_org) then
    raise exception 'a channel is confirmed against YouTube by the platform: connect it from the Channels page'
      using errcode = '42501';
  end if;
  if p_credential is not null then
    built := public.channel_credential_build(p_channel_id, p_org, p_credential, stamp, '{}'::jsonb,
                                             public.channel_may_stamp(p_org));
  end if;
  -- No two channels share a token-secret name, whoever owns them (BR-L-080): an id
  -- whose name equals another channel's id-derived OR reference-derived name (an
  -- operator reference such as 'extinct_world') is refused with the same answer
  -- as a taken id. Serialised, so two creates cannot both pass.
  perform pg_advisory_xact_lock(hashtext('nightshift.channel_secret_name'));
  -- The id `default` (and any id with its secret name) is the operator's legacy
  -- channel, whose token is chosen by its id alone (BR-L-110): reserved whether or
  -- not its row exists.
  if public.channel_secret_name(p_channel_id) = public.channel_secret_name('default') or exists (
    select 1 from public.channels c
     where public.channel_secret_name(c.channel_id) = public.channel_secret_name(p_channel_id)
        or public.channel_secret_name(nullif(c.credential_ref ->> 'ref', '')) = public.channel_secret_name(p_channel_id)
  ) then
    raise exception 'that channel id is not available' using errcode = '23505';
  end if;
  begin
    insert into public.channels
      (channel_id, name, niche, status, agent_config, schedule_config, credential_ref, created_at, updated_at, org_id)
    values
      (p_channel_id, btrim(p_name), coalesce(p_niche, ''), 'PAUSED', cfg, sched, built, nowiso, nowiso, p_org);
  exception when unique_violation then
    raise exception 'that channel id is not available' using errcode = '23505';
  end;
  return jsonb_build_object('channel_id', p_channel_id, 'status', 'PAUSED',
                            'verified', coalesce(built ->> 'verified_at', '') <> '');
end
$$;

revoke all on function public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)
  to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The constraint: every writer, not only create_channel
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  taken text;
begin
  select string_agg(format('%s (organization %s)', channel_id, coalesce(org_id::text, 'none')), ', ' order by channel_id)
    into taken
    from public.channels
   where public.is_reserved_channel_id(channel_id);
  if taken is not null then
    -- Not an exception: create_channel above already refuses new ones, and a failed file would take that with it.
    raise warning '0217 did NOT add the constraint channels_channel_id_not_reserved: these channels have an id that is a page of the site: %. Rename each one (a rename cascades through every table that names a channel) or delete it, then run 0217 again.',
      taken;
    return;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.channels'::regclass and conname = 'channels_channel_id_not_reserved') then
    alter table public.channels
      add constraint channels_channel_id_not_reserved check (not public.is_reserved_channel_id(channel_id)) not valid;
  end if;
  alter table public.channels validate constraint channels_channel_id_not_reserved;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     public.is_reserved_channel_id('ru') and public.is_reserved_channel_id('RU') and public.is_reserved_channel_id('privacy')
--       and not public.is_reserved_channel_id('russia') and not public.is_reserved_channel_id('default')
--       and not public.is_reserved_channel_id(null) as the_list,
--     (select convalidated from pg_constraint
--       where conrelid = 'public.channels'::regclass and conname = 'channels_channel_id_not_reserved') as constraint_validated,
--     position('reserved_channel_id' in pg_get_functiondef(
--       'public.create_channel(text,uuid,text,text,jsonb,jsonb,jsonb,boolean)'::regprocedure)) > 0
--       and position('channel_label_lowering' in pg_get_functiondef(
--       'public.create_channel(text,uuid,text,text,jsonb,jsonb,jsonb,boolean)'::regprocedure)) > 0 as create_channel_checks_both,
--     not has_function_privilege('anon', 'public.is_reserved_channel_id(text)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.is_reserved_channel_id(text)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.is_reserved_channel_id(text)', 'EXECUTE') as grants;
--
-- constraint_validated reads null when the file found channels with a reserved id (its warning named them):
--   select channel_id, org_id, name from public.channels where public.is_reserved_channel_id(channel_id);
