-- rollback_0114_ai_disclosure_admin_lock.sql — takes migration 0114 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the lock refuses a write you want to allow. After it, any editor who can write a channel's
-- agent_config can again set ai_disclosure = never and ai_disclosure_voice = own_clone, which lower what is declared to
-- the platforms (docs/AI_DISCLOSURE.md). A row that carries either value keeps it either way: 0114 rewrote no row.
--
-- WHAT IT DOES, in one transaction:
--   1. Puts channels_config_guard() back to 0086's body, byte for byte (the trigger that calls it is neither dropped nor re-created: 0114 never touched it).
--   2. Puts create_channel(...) back to 0086's body, byte for byte, with 0086's grants.
--   3. Drops channel_label_lowering(jsonb) and ai_disclosure_norm(jsonb) (nothing else calls them).
--
-- CHECK BEFORE YOU RUN IT: this file puts two functions back to the text they had before 0114. If a later migration has
-- redefined either, running this would silently undo that later change. Compare first:
--     select pg_get_functiondef('public.channels_config_guard()'::regprocedure);
--     select pg_get_functiondef('public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)'::regprocedure);
-- The only differences from this file's text should be the lines marked 0114.
--
-- tests/security/test_sec_ai_disclosure_lock.py applies this file to the lab database and re-applies 0114.

begin;
set local lock_timeout = '5s';

-- 0086's body.
create or replace function public.channels_config_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  controls constant text[] := array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish'];
  k        text;
  changed  text[] := '{}';
  org      uuid;
  o        jsonb;
  n        jsonb := case when jsonb_typeof(new.agent_config) = 'object' then new.agent_config else '{}'::jsonb end;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    o := '{}'::jsonb;
    org := new.org_id;
    if new.auto_publish is true then
      changed := changed || 'auto_publish'::text;
    end if;
    if coalesce(new.credential_ref, '{}'::jsonb) <> '{}'::jsonb or new.status is distinct from 'PAUSED' then
      raise exception 'a channel is created paused with no credential: use create_channel()'
        using errcode = '42501';
    end if;
  else
    o := case when jsonb_typeof(old.agent_config) = 'object' then old.agent_config else '{}'::jsonb end;
    org := old.org_id;
    if new.auto_publish is distinct from old.auto_publish then
      changed := changed || 'auto_publish'::text;
    end if;
    if new.credential_ref is distinct from old.credential_ref
       or new.status is distinct from old.status
       or new.channel_id is distinct from old.channel_id then
      raise exception 'a channel''s credential, status and id are changed through the channel functions only'
        using errcode = '42501';
    end if;
  end if;
  foreach k in array controls loop
    if (o -> k) is distinct from (n -> k) and not k = any (changed) then
      changed := changed || k;
    end if;
  end loop;
  if cardinality(changed) > 0 and not public.is_org_member(org, 'admin') then
    raise exception 'only an administrator of this organization may change: %', array_to_string(changed, ', ')
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;

-- 0086's body.
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

drop function if exists public.channel_label_lowering(jsonb);
drop function if exists public.ai_disclosure_norm(jsonb);

commit;

-- Verify (run as the SQL editor; every column should read true)
--   select
--     position('channel_label_lowering' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) = 0
--       and position('channel_label_lowering' in pg_get_functiondef(
--             'public.create_channel(text,uuid,text,text,jsonb,jsonb,jsonb,boolean)'::regprocedure)) = 0 as functions_are_0086s,
--     to_regprocedure('public.channel_label_lowering(jsonb)') is null
--       and to_regprocedure('public.ai_disclosure_norm(jsonb)') is null as helpers_dropped;
