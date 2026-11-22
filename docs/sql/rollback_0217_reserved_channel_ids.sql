-- rollback_0217_reserved_channel_ids.sql — takes migration 0217 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the refusal stops a channel you want to allow. After it, the database again accepts a channel id
-- that is a page of the site (privacy, pricing, ru, ...) from anything that does not go through the Command Center's
-- wizard, whose own check (isValidChannelId) is unchanged. No row is touched either way: 0217 rewrote none.
--
-- WHAT IT DOES, in one transaction:
--   1. Puts create_channel(...) back to 0114's body, byte for byte, with 0114's grants.
--   2. Drops the constraint channels_channel_id_not_reserved on public.channels (if it is there: 0217 leaves it out when
--      it finds a channel that already has a reserved id). A short ACCESS EXCLUSIVE lock on public.channels.
--   3. Drops is_reserved_channel_id(text) (nothing else calls it once 1 and 2 are done).
--
-- CHECK BEFORE YOU RUN IT: this file puts create_channel back to the text it had before 0217. If a later migration has
-- redefined it, running this would silently undo that later change. Compare first:
--     select pg_get_functiondef('public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)'::regprocedure);
-- The only difference from this file's text should be the block marked 0217.
--
-- tests/security/test_sec_reserved_channel_ids_0217.py applies this file to a lab database and re-applies 0217.

begin;
set local lock_timeout = '5s';

-- 0114's body.
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

alter table public.channels drop constraint if exists channels_channel_id_not_reserved;

drop function if exists public.is_reserved_channel_id(text);

do $$
begin
  if to_regprocedure('public.is_reserved_channel_id(text)') is not null
     or exists (select 1 from pg_constraint
                 where conrelid = 'public.channels'::regclass and conname = 'channels_channel_id_not_reserved')
     or position('reserved_channel_id' in pg_get_functiondef(
          'public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)'::regprocedure)) > 0 then
    raise exception 'rollback 0217 end state: an 0217 object is still there';
  end if;
end $$;

commit;

-- Verify (every column should read true):
--   select to_regprocedure('public.is_reserved_channel_id(text)') is null as helper_gone,
--          not exists (select 1 from pg_constraint where conname = 'channels_channel_id_not_reserved') as constraint_gone,
--          position('channel_label_lowering' in pg_get_functiondef(
--            'public.create_channel(text,uuid,text,text,jsonb,jsonb,jsonb,boolean)'::regprocedure)) > 0 as body_is_0114s;
