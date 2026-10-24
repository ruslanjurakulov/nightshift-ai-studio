-- rollback_0119_channel_settings_guard.sql — takes migration 0119 out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the spend-limit lock refuses a write you must allow, or patch_channel_agent_config() misbehaves.
-- READ THIS FIRST: after it, (1) an editor of an organization can again raise or remove a channel's monthly spend limit
-- (nothing but the Channels page's own check, which is advisory, stands in the way), and (2) the Channels page cannot SAVE its
-- spend limit, question-comment, watch-next or storyboard-review settings, because it writes them through the function this file
-- drops. Revert the page's change (the 0119 pull request) before or together with this file.
--
-- WHAT IT DOES, in one transaction:
--   1. Refuses to run if channels_config_guard() is neither 0119's body nor 0117's (a later migration redefined it: running this
--      would silently undo that change). Compared as md5 of the body with every run of white space read as one space.
--   2. Puts channels_config_guard() back to 0117's body, byte for byte (the trigger is neither dropped nor re-created: 0119 never
--      touched it), and its grants (none to any API role).
--   3. Drops patch_channel_agent_config(text, jsonb) and channel_spend_ceiling(jsonb).
-- No row is rewritten: a limit already stored stays as it is.
--
-- tests/security/test_sec_channel_settings.py applies this file to the lab database and re-applies 0119.

begin;
set local lock_timeout = '5s';

do $$
declare
  g text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into g from pg_proc p where p.oid = 'public.channels_config_guard()'::regprocedure;
  if g is null or g <> all (array['b5cf70785cafdf71ec4cdc49bb393c9c', '2fae7ae1e01769adc2db32c1c405d20d']) then
    raise exception 'rollback 0119 found a channels_config_guard() that is neither 0119''s body nor 0117''s (md5 %): read the live body first', g;
  end if;
end $$;

-- 0117's body.
create or replace function public.channels_config_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  controls constant text[] := array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish'];
  k        text;
  changed  text[] := '{}';
  org      uuid;
  o        jsonb;
  n        jsonb := case when jsonb_typeof(new.agent_config) = 'object' then new.agent_config else '{}'::jsonb end;
  lowering text[];
  voice_key text;
  voice_old jsonb := '{}'::jsonb;
begin
  -- 0117: a custom (cloned) voice id may be SET on a channel only if its owner attached it there (attach_voice_to_channel). Every
  -- writer is held to it, whoever it is; a value that is not a custom voice is allowed exactly as before.
  if tg_op = 'UPDATE' and jsonb_typeof(old.agent_config) = 'object' then
    voice_old := old.agent_config;
  end if;
  voice_key := public.channel_voice_config_problem(new.channel_id, new.org_id, voice_old, n);
  if voice_key is not null then
    raise exception 'voice_not_allowed: % is a custom voice that its owner has not attached to this channel', voice_key
      using errcode = '42501', hint = 'voice_not_allowed';
  end if;
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
  -- 0114: the two keys that lower the platform label are a PLATFORM administrator's. A key is refused only when
  -- this write SETS it to a value the reader treats as lowering and the stored value was not already that exact
  -- value, so an unrelated edit of a channel that already has one (or a write that raises the label) still passes.
  lowering := '{}';
  foreach k in array public.channel_label_lowering(n) loop
    if (o -> k) is distinct from (n -> k) then
      lowering := lowering || k;
    end if;
  end loop;
  if cardinality(lowering) > 0 and not public.is_platform_admin() then
    raise exception 'ai_disclosure_lock: only a platform administrator may set: %', array_to_string(lowering, ', ')
      using errcode = '42501', hint = 'ai_disclosure_lock';
  end if;
  return new;
end
$$;

revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;

drop function if exists public.patch_channel_agent_config(text, jsonb);
drop function if exists public.channel_spend_ceiling(jsonb);

commit;

-- Verify (every column should read true):
--   select position('spend_ceiling_lock' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) = 0
--            and position('channel_voice_config_problem' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) > 0 as guard_is_0117s,
--          to_regprocedure('public.patch_channel_agent_config(text,jsonb)') is null
--            and to_regprocedure('public.channel_spend_ceiling(jsonb)') is null as functions_gone;
