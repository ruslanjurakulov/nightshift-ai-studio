-- 0086_channel_config_lock.sql — a member can no longer name the secret a
-- channel publishes with, make up its YouTube verification, probe channel ids,
-- or switch off the controls that hold a render (Breach wave 7: BR-G-002,
-- BR-G-003).
--
-- WHAT WAS WRONG
--   `channels` is the one table the browser writes straight through PostgREST,
--   and the render worker reads the same row as the channel's configuration.
--   So a column an editor could write was a column the worker obeyed:
--     * credential_ref.ref decides WHICH secret the shared worker publishes
--       with (CHRONOS_YT_TOKEN_<REF>). An editor of a customer organization
--       could re-point their channel at an operator channel's token.
--     * credential_ref.verified_at is the "YouTube confirmed this channel"
--       stamp the database (0005), the scheduler and Run now trust; an editor
--       could write it for a channel nobody confirmed.
--     * an insert with another organization's channel id answered 23505, a free
--       id answered success: the operator's channel ids could be probed.
--     * agent_config.publish_gate, require_two_person_publish,
--       storyboard_review and channels.auto_publish (the controls that hold a
--       render for a person) were rewritable by the member they hold.
--
-- WHAT THIS CHANGES
--   1. credential_ref, status, channel_id and created_at are no longer
--      writable by the browser roles, and INSERT is revoked from them: the
--      table grants become explicit column lists. A column added later is NOT
--      writable until someone grants it (tests/security pins the list).
--   2. Four definer functions are the only way a browser changes them, each
--      with search_path pinned, revoked from public/anon, granted explicitly:
--        create_channel(...)         editor of the organization. Creates the
--                                    channel PAUSED. A taken channel id (any
--                                    organization's) answers one fixed error.
--        set_channel_credential(...) writes credential_ref. The reference is
--                                    the channel's own id for every
--                                    organization but the operator's; the
--                                    verification stamp is written only for
--                                    the operator's own channels (an admin of
--                                    the operator organization, whose wizard
--                                    does the YouTube lookup) or by a trusted
--                                    server caller (the service key). The
--                                    stamp's time is the database's clock,
--                                    never the caller's.
--        set_channel_status(...)     editor+: pause any time; activate only a
--                                    confirmed channel (0005's rule).
--      A customer organization's channel is confirmed by the Google sign-in
--      (channel_token_refs, 0022): a trigger stamps credential_ref from the
--      connection the Command Center's callback recorded.
--   3. A BEFORE INSERT/UPDATE trigger on channels, for the browser roles only,
--      refuses a change to the four controls above unless the caller is an
--      administrator of the channel's organization (the owner decision flagged
--      in the PR: editors used to be able to flip the two-person flag and
--      storyboard review). It also refuses credential_ref / status changes as
--      a second lock behind the column privileges.
--   The render worker (modules/channel_credentials.py, tools/queue_worker.py)
--   no longer reads an environment token for a non-operator channel at all:
--   its only token is its own Vault connection. That half is code, not SQL.
--
-- WHAT IT DOES NOT CHANGE
--   Reads (channels_auth_read), RLS policies, the operator's own flow (the
--   wizard still verifies against YouTube and the stamp is written by the
--   database), the service role, and every existing row. Existing customer
--   channels keep whatever credential_ref they have: the worker ignores its
--   `ref`, and the detection query at the end lists the ones worth reviewing.
--
-- REQUIRES 0005 (the verification constraint), 0018 (organizations), 0020
-- (credits_trusted_caller), 0022 (channel_token_refs), 0043 (my_confirmed_email
-- is not needed here). Additive and idempotent: create-or-replace, drop-then-
-- create triggers, revoke-then-grant. Safe to re-run, and safe to run 0018 /
-- 0056 / 0022 again afterwards (none of them grants on channels).

do $$
begin
  if to_regclass('public.channels') is null or to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.default_org_id()') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0086 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0086 needs 0020_credits.sql (credits_trusted_caller): apply it first';
  end if;
  if to_regclass('public.channel_token_refs') is null then
    raise exception '0086 needs 0022_channel_tokens.sql: apply it first';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'channels_active_requires_verification') then
    raise exception '0086 needs 0005_verified_channels.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Who may write which column
-- ───────────────────────────────────────────────────────────────────────────
-- Supabase grants every table to anon / authenticated / service_role by
-- default; the policies (0018) are what narrowed it. Narrow the columns too.
-- Revoking the table privilege also revokes any column privilege, so this is
-- re-runnable.

revoke insert, update on public.channels from anon, authenticated;

-- Every column an editor may change through the Channels, Voice, Cast,
-- Schedule, DNA and Approvals pages. NOT here: credential_ref, status,
-- channel_id (a rename cascades through every table that names a channel) and
-- created_at.
grant update (name, niche, agent_config, schedule_config, updated_at, org_id, auto_publish,
              default_style_kit_id, dna_format, dna_aspect, dna_tone)
  on public.channels to authenticated;

-- No INSERT grant at all: create_channel() is the way in (a uniform answer for
-- a taken id, and the credential written by the same function).

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The controls that hold a render are admin-only (BR-G-003)
-- ───────────────────────────────────────────────────────────────────────────

-- The agent_config keys (and the auto_publish column) only an administrator of
-- the channel's organization may change. One list, used by the trigger and by
-- create_channel().
create or replace function public.channel_admin_controls() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish']::text[]
$$;

-- The controls whose value differs between two agent_config blobs. A key
-- absent on both sides is no change; a value moved to another value, removed
-- or added is.
create or replace function public.channel_controls_changed(p_old jsonb, p_new jsonb) returns text[]
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k       text;
  changed text[] := '{}';
  o       jsonb := case when jsonb_typeof(p_old) = 'object' then p_old else '{}'::jsonb end;
  n       jsonb := case when jsonb_typeof(p_new) = 'object' then p_new else '{}'::jsonb end;
begin
  foreach k in array public.channel_admin_controls() loop
    if (o -> k) is distinct from (n -> k) then
      changed := changed || k;
    end if;
  end loop;
  return changed;
end
$$;

-- Runs as the caller. The browser roles are held to the rules; the definer
-- functions below (they run as the function's owner), the service role and the
-- SQL editor are not, and say so in their own checks.
create or replace function public.channels_config_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  changed text[];
  org     uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    changed := public.channel_controls_changed('{}'::jsonb, new.agent_config);
    if new.auto_publish is true then
      changed := changed || 'auto_publish';
    end if;
    org := new.org_id;
    if coalesce(new.credential_ref, '{}'::jsonb) <> '{}'::jsonb or new.status is distinct from 'PAUSED' then
      raise exception 'a channel is created paused with no credential: use create_channel()'
        using errcode = '42501';
    end if;
  else
    changed := public.channel_controls_changed(old.agent_config, new.agent_config);
    if new.auto_publish is distinct from old.auto_publish then
      changed := changed || 'auto_publish';
    end if;
    org := old.org_id;
    if new.credential_ref is distinct from old.credential_ref
       or new.status is distinct from old.status
       or new.channel_id is distinct from old.channel_id then
      raise exception 'a channel''s credential, status and id are changed through the channel functions only'
        using errcode = '42501';
    end if;
  end if;
  if cardinality(changed) > 0 and not public.is_org_member(org, 'admin') then
    raise exception 'only an administrator of this organization may change: %', array_to_string(changed, ', ')
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists channels_config_guard on public.channels;
create trigger channels_config_guard
  before insert or update on public.channels
  for each row execute function public.channels_config_guard();

revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The credential (BR-G-002)
-- ───────────────────────────────────────────────────────────────────────────

-- The ISO-8601 stamp the Command Center and the worker already read, from the
-- database's clock.
create or replace function public.channel_verified_stamp() returns text
  language sql volatile set search_path = public, pg_temp as $$
  select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- A credential_ref built from what the caller sent and nothing else. Only the
-- public facts a channels.list read returns are copied; `verified_at` is never
-- copied from the input (p_stamp says whether to write one, from the database's
-- clock); the reference is the channel's own id unless the channel belongs to
-- the operator's organization AND the caller is on the operator's side
-- (p_ref_ok, from channel_may_stamp).
create or replace function public.channel_credential_build(
  p_channel text, p_org uuid, p_in jsonb, p_stamp boolean, p_keep jsonb default '{}'::jsonb,
  p_ref_ok boolean default false
) returns jsonb
  language plpgsql volatile set search_path = public, pg_temp as $$
declare
  src   jsonb := case when jsonb_typeof(p_in) = 'object' then p_in else '{}'::jsonb end;
  keep  jsonb := case when jsonb_typeof(p_keep) = 'object' then p_keep else '{}'::jsonb end;
  ref   text;
  out_  jsonb;
  k     text;
begin
  if octet_length(src::text) > 4096 then
    raise exception 'credential_ref is too large' using errcode = '22023';
  end if;
  ref := p_channel;
  if p_ref_ok and p_org = public.default_org_id() and coalesce(src ->> 'ref', '') <> '' then
    ref := src ->> 'ref';
    if ref !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' then
      raise exception 'credential reference is not a valid name' using errcode = '22023';
    end if;
  end if;
  out_ := jsonb_build_object('provider', 'youtube', 'ref', ref);
  foreach k in array array['youtube_channel_id', 'youtube_title', 'youtube_thumbnail', 'youtube_custom_url',
                           'subscriber_count', 'video_count'] loop
    if src ? k and jsonb_typeof(src -> k) in ('string', 'number') then
      out_ := out_ || jsonb_build_object(k, left(src ->> k, 500));
    end if;
  end loop;
  if p_stamp then
    out_ := out_ || jsonb_build_object('verified_at', public.channel_verified_stamp());
  elsif coalesce(keep ->> 'verified_at', '') <> ''
        and coalesce(keep ->> 'youtube_channel_id', '') = coalesce(out_ ->> 'youtube_channel_id', '') then
    -- An earlier stamp stands only for the YouTube channel it was made for.
    out_ := out_ || jsonb_build_object('verified_at', keep ->> 'verified_at');
  end if;
  return out_;
end
$$;

revoke all on function public.channel_verified_stamp() from public, anon, authenticated, service_role;
revoke all on function public.channel_credential_build(text, uuid, jsonb, boolean, jsonb, boolean)
  from public, anon, authenticated, service_role;

-- Who may write the verification stamp for a channel of org `p_org`: a trusted
-- server caller (the service key, the SQL editor), or an administrator of the
-- operator's own organization / a platform admin, for the operator's channels.
-- A customer organization's member never does: their channel is confirmed by
-- the Google sign-in (the trigger below).
create or replace function public.channel_may_stamp(p_org uuid) returns boolean
  language sql stable set search_path = public, pg_temp as $$
  select public.credits_trusted_caller()
      or (p_org = public.default_org_id()
          and (public.is_org_member(p_org, 'admin') or public.is_platform_admin()))
$$;

revoke all on function public.channel_may_stamp(uuid) from public, anon, authenticated, service_role;

create or replace function public.set_channel_credential(
  p_channel_id text, p_credential jsonb, p_verified boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ch      public.channels;
  trusted boolean := public.credits_trusted_caller();
  stamp   boolean := coalesce(p_verified, false);
  cur     jsonb;
  built   jsonb;
  newstat text;
begin
  select * into ch from public.channels c where c.channel_id = p_channel_id for update;
  -- An unknown channel and one the caller may not edit read the same.
  if ch.channel_id is null
     or not (trusted or (auth.uid() is not null and public.is_org_member(ch.org_id, 'editor'))) then
    raise exception 'channel not found or not yours' using errcode = '42501';
  end if;
  -- The operator's own channels name a reference and are confirmed by the
  -- operator. Anyone else's reference is the channel's own id.
  if ch.org_id = public.default_org_id() and not (trusted or public.channel_may_stamp(ch.org_id)) then
    raise exception 'only an administrator of this organization may change a channel''s credential'
      using errcode = '42501';
  end if;
  if stamp and not public.channel_may_stamp(ch.org_id) then
    raise exception 'a channel is confirmed against YouTube by the platform: connect it from the Channels page'
      using errcode = '42501';
  end if;

  cur := coalesce(ch.credential_ref, '{}'::jsonb);
  built := public.channel_credential_build(ch.channel_id, ch.org_id, p_credential, stamp, cur,
                                           public.channel_may_stamp(ch.org_id));
  newstat := ch.status;
  -- A stamp that no longer holds (another YouTube channel) cannot sit under an
  -- ACTIVE channel: 0005's rule would refuse the row, so pause it first.
  if ch.status = 'ACTIVE' and ch.channel_id <> 'default' and coalesce(built ->> 'verified_at', '') = '' then
    newstat := 'PAUSED';
  end if;
  update public.channels
     set credential_ref = built, status = newstat, updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where channel_id = ch.channel_id;
  return jsonb_build_object('channel_id', ch.channel_id, 'verified', coalesce(built ->> 'verified_at', '') <> '',
                            'status', newstat);
end
$$;

-- A taken id (any organization's, the caller's own included) answers one fixed
-- error: the answer does not say whose it is. An id that is free succeeds, so
-- existence is still inferable by collision; see the PR note on namespacing.
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
  if coalesce(p_channel_id, '') !~ '^[a-z0-9][a-z0-9-]{1,38}$' then
    raise exception 'a channel id is a lowercase slug of 2 to 39 characters' using errcode = '22023';
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
  if stamp and not public.channel_may_stamp(p_org) then
    raise exception 'a channel is confirmed against YouTube by the platform: connect it from the Channels page'
      using errcode = '42501';
  end if;
  if p_credential is not null then
    built := public.channel_credential_build(p_channel_id, p_org, p_credential, stamp, '{}'::jsonb,
                                             public.channel_may_stamp(p_org));
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

create or replace function public.set_channel_status(p_channel_id text, p_status text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ch  public.channels;
  st  text := upper(btrim(coalesce(p_status, '')));
begin
  select * into ch from public.channels c where c.channel_id = p_channel_id for update;
  if ch.channel_id is null or auth.uid() is null or not public.is_org_member(ch.org_id, 'editor') then
    raise exception 'channel not found or not yours' using errcode = '42501';
  end if;
  if st not in ('ACTIVE', 'PAUSED') then
    raise exception 'a status is ACTIVE or PAUSED' using errcode = '22023';
  end if;
  if st = 'ACTIVE' and ch.channel_id <> 'default' and coalesce(ch.credential_ref ->> 'verified_at', '') = '' then
    raise exception 'confirm this channel against YouTube before activating it' using errcode = '23514';
  end if;
  update public.channels
     set status = st, updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where channel_id = ch.channel_id;
  return st;
end
$$;

revoke all on function public.set_channel_credential(text, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.set_channel_status(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_channel_credential(text, jsonb, boolean) to authenticated, service_role;
grant execute on function public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)
  to authenticated, service_role;
grant execute on function public.set_channel_status(text, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. A customer's channel is confirmed by the Google sign-in
-- ───────────────────────────────────────────────────────────────────────────
-- store_channel_token (0022) records the YouTube channel the Command Center's
-- callback read with the token it just exchanged (channels.list, mine=true).
-- That connection is the customer organization's confirmation: stamp the
-- channel from it, once, when it has none. A stamp already there for the same
-- YouTube channel is left alone. (store_channel_token itself is unchanged.)
create or replace function public.channel_stamp_from_connection() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.vault_secret_id is null or new.revoked_at is not null
     or coalesce(new.youtube_channel_id, '') = '' then
    return new;
  end if;
  update public.channels c
     set credential_ref = coalesce(c.credential_ref, '{}'::jsonb)
           || jsonb_build_object('provider', 'youtube', 'ref', c.channel_id,
                                 'youtube_channel_id', new.youtube_channel_id,
                                 'verified_at', public.channel_verified_stamp())
           || case when coalesce(new.youtube_channel_title, '') <> ''
                   then jsonb_build_object('youtube_title', new.youtube_channel_title) else '{}'::jsonb end,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where c.channel_id = new.channel_id
     and c.org_id <> public.default_org_id()
     and coalesce(c.credential_ref ->> 'verified_at', '') = '';
  return new;
end
$$;

drop trigger if exists channel_token_refs_stamp on public.channel_token_refs;
create trigger channel_token_refs_stamp
  after insert or update on public.channel_token_refs
  for each row execute function public.channel_stamp_from_connection();

revoke all on function public.channel_stamp_from_connection() from public, anon, authenticated, service_role;
revoke all on function public.channel_admin_controls() from public, anon, authenticated, service_role;
revoke all on function public.channel_controls_changed(jsonb, jsonb) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every row should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select not has_column_privilege('authenticated', 'public.channels', 'credential_ref', 'UPDATE')
--      and not has_column_privilege('authenticated', 'public.channels', 'status', 'UPDATE')
--      and not has_column_privilege('authenticated', 'public.channels', 'credential_ref', 'INSERT')
--      and has_column_privilege('authenticated', 'public.channels', 'name', 'UPDATE') as columns_locked,
--     has_function_privilege('authenticated', 'public.create_channel(text,uuid,text,text,jsonb,jsonb,jsonb,boolean)', 'EXECUTE')
--      and not has_function_privilege('anon', 'public.create_channel(text,uuid,text,text,jsonb,jsonb,jsonb,boolean)', 'EXECUTE')
--      as functions_granted_to_members_only;
--
-- Review the channels this migration cannot judge (it changes no row). Customer
-- channels whose reference is not their own id (the worker ignores `ref` for
-- them, but a changed value is worth a look), and verified customer channels
-- with no active Google connection (the stamp was typed in the browser before
-- this migration):
--   select c.channel_id, c.org_id, c.credential_ref ->> 'ref' as ref, c.credential_ref ->> 'verified_at' as verified_at
--     from public.channels c
--    where c.org_id <> public.default_org_id()
--      and (c.credential_ref ->> 'ref' is distinct from c.channel_id
--           or (coalesce(c.credential_ref ->> 'verified_at', '') <> ''
--               and not exists (select 1 from public.channel_token_refs r
--                                where r.channel_id = c.channel_id and r.vault_secret_id is not null
--                                  and r.revoked_at is null)));
