-- 0114_ai_disclosure_admin_lock.sql — the two AI-disclosure settings that LOWER the platform label are a
-- PLATFORM administrator's to set (owner decision, 2026-10-20: docs/AI_DISCLOSURE.md, "Who can set what").
--
-- WHAT WAS WRONG
--   A channel's agent_config carries two keys (modules/ai_disclosure.py) that decide what is declared to YouTube,
--   Instagram and TikTok as "altered or synthetic content":
--     * ai_disclosure        = never      declares nothing, whatever the video contains
--     * ai_disclosure_voice  = own_clone  declares that the narrator is the owner's own cloned voice
--   WHAT EACH LOCK BUYS. Only ai_disclosure = never lowers the label itself. In decide() own_clone and generic give the
--   same label: only real_person adds a label reason. Locking own_clone protects the AUDIT SIGNAL (overrides_of reports
--   voice_own_clone as "a person chose this", and the review note says so), not the label: anyone can already leave
--   the voice key unset or generic. The voice lock is kept because the owner asked for both keys.
--   Both are settable today by any editor who could write agent_config, which is a compliance risk for the whole site. On this site every customer is the admin of their own organization, so an
--   "organization admin" lock would stop nobody: the lock is is_platform_admin() (0018: the site owner and helpers).
--
-- WHAT THIS CHANGES
--   1. ai_disclosure_norm(jsonb) and channel_label_lowering(jsonb): the ONE definition of "this value lowers the
--      label", written to read a value the way modules/ai_disclosure.py normalize_mode / normalize_voice do: a JSON
--      string, surrounding whitespace removed (Python str.strip: ASCII whitespace, the C0 separators, NEL, NBSP and the
--      Unicode space separators), lower-cased. So 'Never', ' never', 'NEVER' and 'own_clone\n' are lowering exactly
--      where the reader would read them as never / own_clone. Anything the reader would read as the conservative value
--      (auto, always, generic, real_person, a typo, a number) is not lowering.
--   2. channels_config_guard() (0086's body, every earlier check kept) also refuses an INSERT or UPDATE of channels
--      that SETS either key to a lowering value unless the caller is a platform administrator. SET means: the new
--      value is lowering and differs from the stored one, so an unrelated edit of a channel that already has one of
--      the values still succeeds, and moving a key to a value that raises the label always succeeds.
--      Who is held to it follows 0086 exactly: the browser roles (authenticated, anon) only. The service role, the SQL
--      editor and the definer functions run as another role and pass, as they do for 0086's controls.
--   3. create_channel() (0086's body, every earlier check kept) makes the same check on its p_agent_config, because a
--      definer function runs as its owner and the trigger above cannot see the browser there. A trusted server caller
--      (credits_trusted_caller, 0086's own bypass) and a platform administrator may; nobody else.
--   The refusal is SQLSTATE 42501 with the message prefix 'ai_disclosure_lock:' and hint 'ai_disclosure_lock' (the
--   Command Center maps either to a sentence in the person's language).
--
-- WHAT IT DOES NOT CHANGE
--   No row is rewritten and no grant is widened: a channel that already has either value keeps it (the live check
--   before this migration found no channel with either key set, so there is nothing to review). The reader in
--   modules/ai_disclosure.py, the pipeline's own writes (service role) and the other writers of agent_config
--   (docs/AI_DISCLOSURE.md lists each) are untouched. set_channel_dna() merges only elevenlabs_voice_id and language.
--
-- REQUIRES 0018 (is_platform_admin), 0020 (credits_trusted_caller) and 0086 (channels, the guard, create_channel).
-- Additive and idempotent: create or replace of two new pure functions and the two 0086 functions, grants repeated.
-- No table is altered and no trigger is dropped or re-created, so nothing here takes a lock on public.channels.
-- Order: independent of 0113 (reserved by the unmerged PR #543); 0114 may be applied before it.
-- Rollback: docs/sql/rollback_0114_ai_disclosure_admin_lock.sql (puts 0086's two function bodies back).

do $$
begin
  if to_regclass('public.channels') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0114 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0114 needs 0020_credits.sql (credits_trusted_caller): apply it first';
  end if;
  if to_regprocedure('public.channels_config_guard()') is null
     or to_regprocedure('public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)') is null then
    raise exception '0114 needs 0086_channel_config_lock.sql: apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. What the reader would read, and which of it lowers the label
-- ───────────────────────────────────────────────────────────────────────────

-- The reader's normalisation of one agent_config value: NULL unless it is a JSON string; otherwise the string with
-- surrounding whitespace removed and lower-cased (modules/ai_disclosure.py: value.strip().lower()). Python's
-- str.strip() removes more than btrim() and than the locale-dependent [[:space:]], so the characters are listed:
-- \t \n \v \f \r, the C0 separators 1c-1f, space, NEL (85), NBSP (a0), U+1680, U+2000-200a, U+2028, U+2029, U+202f,
-- U+205f and U+3000. Pure (no table is read), so the browser roles may run it inside the trigger.
create or replace function public.ai_disclosure_norm(p_value jsonb) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case when jsonb_typeof(p_value) = 'string'
    then lower(regexp_replace(p_value #>> '{}',
      '^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$',
      '', 'g'))
  end
$$;

-- The agent_config keys that p_cfg sets to a value that LOWERS the label: ai_disclosure read as 'never', and
-- ai_disclosure_voice read as 'own_clone'. A config that is not a JSON object reads as empty (the reader's
-- from_dict does the same). One definition, used by the trigger, by create_channel() and by the tests.
create or replace function public.channel_label_lowering(p_cfg jsonb) returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array_remove(array[
    case when public.ai_disclosure_norm(c -> 'ai_disclosure') = 'never' then 'ai_disclosure' end,
    case when public.ai_disclosure_norm(c -> 'ai_disclosure_voice') = 'own_clone' then 'ai_disclosure_voice' end
  ]::text[], null)
  from (select case when jsonb_typeof(p_cfg) = 'object' then p_cfg else '{}'::jsonb end as c) s
$$;

revoke all on function public.ai_disclosure_norm(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.channel_label_lowering(jsonb) from public, anon, authenticated, service_role;
-- Pure functions of their argument; the trigger runs as the caller, so the browser roles execute them.
grant execute on function public.ai_disclosure_norm(jsonb) to authenticated, service_role;
grant execute on function public.channel_label_lowering(jsonb) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The trigger: 0086's body plus the lowering check (security invoker, as in 0086)
-- ───────────────────────────────────────────────────────────────────────────

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

-- The trigger itself is 0086's and is NOT touched: it is already on public.channels in production (before insert or
-- update, for each row), and it calls channels_config_guard() by name, so the create or replace above is all it takes.
-- Dropping and re-creating it would take an ACCESS EXCLUSIVE lock on public.channels for nothing.

revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. create_channel(): 0086's body plus the same check (a definer: the trigger does not see the browser)
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
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     public.channel_label_lowering('{"ai_disclosure": " Never ", "ai_disclosure_voice": "OWN_CLONE"}'::jsonb)
--       = array['ai_disclosure', 'ai_disclosure_voice'] as spellings_read_like_the_reader,
--     public.channel_label_lowering('{"ai_disclosure": "always", "ai_disclosure_voice": "real_person"}'::jsonb) = '{}'
--       and public.channel_label_lowering('{"ai_disclosure": "nevermind", "ai_disclosure_voice": 7}'::jsonb) = '{}'
--       and public.channel_label_lowering('null'::jsonb) = '{}' as other_values_pass,
--     position('channel_label_lowering' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) > 0
--       and position('channel_label_lowering' in pg_get_functiondef(
--             'public.create_channel(text,uuid,text,text,jsonb,jsonb,jsonb,boolean)'::regprocedure)) > 0 as both_functions_check,
--     not has_function_privilege('anon', 'public.channel_label_lowering(jsonb)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.channel_label_lowering(jsonb)', 'EXECUTE') as grants;
--
-- Channels that carry either value today (expected: none; this migration rewrites no row either way):
--   select channel_id, org_id, agent_config ->> 'ai_disclosure' as mode, agent_config ->> 'ai_disclosure_voice' as voice
--     from public.channels
--    where cardinality(public.channel_label_lowering(agent_config)) > 0;
