-- 0119_channel_settings_guard.sql — an editor can no longer RAISE or REMOVE a channel's monthly spend limit, and the card's
-- settings are written by one atomic function instead of a read-merge-write.
-- (BR-G-003 follow-up, docs/security/LEDGER.md; the editors are PR #585's ChannelRiskSettings and the storyboard switch.)
--
-- WHAT WAS WRONG
--   1. channels.agent_config.spend_ceiling_usd is the one number that stops a channel spending (the worker reads it as a monthly
--      USD limit: modules/channels.py _as_optional_float, modules/spend_guard.py). #585 made the Channels page offer "raise or
--      remove" to administrators only, but said in its own comment that this is ADVISORY: the table lets any editor of the
--      organization write agent_config, so a script holding an editor's session (or a stale page) could lift the limit an
--      administrator set. channels_config_guard() (0086, 0114, 0117) held four controls and two label keys; the limit was left out
--      on purpose then (it was not a control), and is a control now.
--   2. The page wrote its settings by reading agent_config, merging one key and writing the whole object back. Two writers at once
--      (two tabs, an administrator and an editor, the AI label and the limit) lose each other's keys: last write wins.
--
-- WHAT THIS CHANGES
--   1. channel_spend_ceiling(jsonb): the ONE database definition of "the limit this value means". A line-for-line mirror of
--      modules/channels.py _as_optional_float, which #585 tightened: a JSON number or a string of ASCII digits (optional sign, one
--      decimal point, optional e-exponent, ASCII white space round it) that is finite and above 0 is the limit; EVERYTHING else is
--      NULL = no limit: null, "", 0, a negative, a boolean, a list, an object, "abc", "nan", "inf", "0x10", Unicode digits or
--      spaces (a BOM, NBSP, Arabic-Indic digits), "1_000", and any number or text that overflows a double (1e400). Unicode is
--      refused because float() in Python would accept it and the page would not: both sides must enforce the same number.
--      It is driven in the lab by command-center/tests/fixtures/channel-risk-cases.json, the same cases the worker and the page
--      are tested with.
--   2. channels_config_guard(): 0117's body, character for character, plus ONE marked block before the final return. Held to it are
--      the browser roles only (authenticated, anon), exactly like the other checks: the service role, the SQL editor and every
--      SECURITY DEFINER function run as another role and pass (set_channel_dna and attach_voice_to_channel never touch the key;
--      create_channel INSERTS, where there is no earlier limit). On an UPDATE, if the limit in force before is not NULL, the write
--      is refused unless the caller administers the channel's organization when the limit in force after is NULL (removed, or
--      replaced by a value the worker would ignore) or LARGER. Setting a limit where none is in force, keeping it, and lowering it
--      stay open to an editor. Both sides are the EFFECTIVE limits, so no spelling dodges it: "25" to "26", 25 to true, 25 to
--      "1e400", replacing the whole blob, deleting the key or jsonb_set all read as what they are.
--      The refusal is SQLSTATE 42501, message prefix 'spend_ceiling_lock:', hint 'spend_ceiling_lock'. The Command Center maps
--      the hint to a sentence in the person's language (lib/channelRisk.ts isSpendCeilingLockRefusal).
--   3. patch_channel_agent_config(p_channel_id, p_patch): ONE UPDATE that merges a small patch into agent_config, so concurrent
--      writers cannot lose each other's keys (under READ COMMITTED a second writer waits for the row lock and then applies its
--      merge to the row as the first one left it). Keys: spend_ceiling_usd (a number up to 1,000,000), pinned_comment,
--      watch_next, storyboard_review (booleans); a JSON null removes the key. Any other key, a non-object patch or an empty one is
--      refused, so the function can never write publish_gate, require_two_person_publish, auto_publish, the AI label, a
--      credential or a voice. SECURITY INVOKER ON PURPOSE: it runs as the caller, so channels_config_guard() sees the browser role
--      and holds the write to every rule above (storyboard_review is still an administrator's; the limit is still one-way for an
--      editor). A SECURITY DEFINER version would run the UPDATE as the table owner, which the guard lets through: it would be a
--      way round the lock. The caller needs an editor's rights in the channel's organization (checked in the UPDATE and again by
--      the table's own policy); anyone else, and a channel that is not theirs, read the same: 'channel not found or not yours'.
--      Granted to authenticated only.
--
-- WHAT IT DOES NOT CHANGE
--   No row is rewritten and no grant on a table is widened. Every other writer of agent_config keeps working: the service role (the
--   pipeline), the definer functions, an administrator's whole-blob update, and an editor's whole-blob update that leaves the limit
--   as it was or lowers it. The one behaviour that changes for an editor: a whole-blob write carrying a stale, HIGHER limit than the
--   stored one (the Voice, Cast and style-preset editors write back the blob they loaded) is now refused instead of silently
--   undoing an administrator's lowering. Nothing publishes, spends or renders (CLAUDE.md rules 2 and 3).
--
-- NUMBER. 0119: the highest on main is 0117; 0118 is taken by the series-tables builder; no open pull request adds a migration
-- (checked with gh api, 2026-10-24).
--
-- Additive and idempotent: create or replace, grants repeated, no table altered, no trigger dropped or re-created (so nothing here
-- takes a lock on public.channels). The 0117 md5 guard below refuses to replace a channels_config_guard() that is neither 0117's
-- body nor this file's own (the 0064/0103 drift lesson). Rollback: docs/sql/rollback_0119_channel_settings_guard.sql.
-- REQUIRES 0018 (is_org_member), 0086 (the trigger) and 0117 (the body this file extends).

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0119 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.channels_config_guard()') is null
     or to_regprocedure('public.channel_voice_config_problem(text, uuid, jsonb, jsonb)') is null then
    raise exception '0119 needs 0086 and 0117 (channels_config_guard, channel_voice_config_problem): apply them first';
  end if;
  -- create or replace keeps a trigger bound; if the 0086 trigger is gone the check below would never run.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard' and not tgisinternal) then
    raise exception '0119 found no channels_config_guard trigger on channels: re-apply 0086 first';
  end if;
end $$;

-- Replaced on the body the REPO says is latest (0117's). If the live database holds another (something applied by hand after it),
-- replacing it would silently undo that change, so the file refuses. Compared as md5 of the body (prosrc) with every run of white
-- space read as one space; the second hash is this file's own body, which is what a replay sees.
-- tests/test_channel_settings_guard_migration.py recomputes both from the migration files.
do $$
declare
  g text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into g from pg_proc p where p.oid = 'public.channels_config_guard()'::regprocedure;
  if g is null or g <> all (array['b5cf70785cafdf71ec4cdc49bb393c9c', '2fae7ae1e01769adc2db32c1c405d20d']) then
    raise exception '0119 found a channels_config_guard() that is neither 0117''s body nor 0119''s (md5 %): read the live body first', g;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The limit a stored value means (a mirror of modules/channels.py _as_optional_float)
-- ───────────────────────────────────────────────────────────────────────────

-- NULL = no limit. Pure and immutable; the guard (which runs as the caller) asks it, so authenticated may execute it. The text
-- pattern is modules/channels.py _ASCII_NUMBER and lib/channelRisk.ts NUMERIC_TEXT: [0-9] spelled out (never \d, which a locale may
-- widen), white space spelled out (never [[:space:]], which a locale may widen). Out-of-range text and numbers raise in the cast
-- (an overflow to infinity, a value that underflows to 0): both are "no limit" in the worker too, so the handler answers NULL.
create or replace function public.channel_spend_ceiling(p_raw jsonb) returns double precision
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  t text;
  f double precision;
begin
  case jsonb_typeof(p_raw)
    when 'number' then
      t := p_raw #>> '{}';
    when 'string' then
      t := p_raw #>> '{}';
      if t !~ '^[ \t\n\r\f\v]*[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?[ \t\n\r\f\v]*$' then
        return null;
      end if;
      t := regexp_replace(t, '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g');
    else
      return null;       -- null, a boolean, a list, an object, and SQL NULL (no key)
  end case;
  begin
    f := t::double precision;
  exception when numeric_value_out_of_range or invalid_text_representation then
    return null;
  end;
  -- NaN sorts above every number in SQL, so it is named; the pattern cannot produce one, a number cannot carry one.
  return case when f > 0 and f <> 'NaN'::double precision and f < 'Infinity'::double precision then f end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. channels_config_guard(): 0117's body verbatim, one marked block added before the final return
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
  -- 0119: a monthly spend limit that is in force may be LOWERED by an editor, never RAISED or REMOVED: that is an administrator's.
  -- "In force" is what the worker enforces (channel_spend_ceiling mirrors modules/channels.py _as_optional_float), on both sides
  -- of the write, so changing a limit to text, 0, a boolean, a list, an overflow or no key at all is a removal, and setting one
  -- where none is in force (a missing key, or one the worker ignores) stays open. An INSERT has no earlier value (o is empty).
  declare
    old_cap double precision := public.channel_spend_ceiling(o -> 'spend_ceiling_usd');
    new_cap double precision;
  begin
    if old_cap is not null then
      new_cap := public.channel_spend_ceiling(n -> 'spend_ceiling_usd');
      if (new_cap is null or new_cap > old_cap) and not public.is_org_member(org, 'admin') then
        raise exception 'spend_ceiling_lock: only an administrator of this organization may raise or remove a spend limit that is already set'
          using errcode = '42501', hint = 'spend_ceiling_lock';
      end if;
    end if;
  end;
  return new;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. patch_channel_agent_config(): one atomic merge, run AS THE CALLER so the guard above holds it
-- ───────────────────────────────────────────────────────────────────────────

-- SECURITY INVOKER (the default, written out): the UPDATE below is the caller's, channels_config_guard() sees current_user =
-- authenticated and applies every rule to it, and the table's update policy (an editor of the organization) applies too. Do NOT
-- make this a definer function: the guard lets the table owner through, so the function would become a way round the lock.
-- The whitelist is the keys the Channels page writes through it; each has a type, a JSON null removes the key.
create or replace function public.patch_channel_agent_config(p_channel_id text, p_patch jsonb) returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  allowed constant text[] := array['spend_ceiling_usd', 'pinned_comment', 'watch_next', 'storyboard_review'];
  max_ceiling constant double precision := 1000000;
  k       text;
  v       jsonb;
  sets    jsonb := '{}'::jsonb;
  drops   text[] := '{}';
  cap     double precision;
  merged  jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_channel_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'invalid_patch: a patch is a non-empty JSON object' using errcode = '22023', hint = 'invalid_patch';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_patch) e loop
    if k <> all (allowed) then
      raise exception 'invalid_patch: % is not a setting this function writes', k using errcode = '22023', hint = 'invalid_patch';
    end if;
    if jsonb_typeof(v) = 'null' then
      drops := drops || k;
    elsif k = 'spend_ceiling_usd' then
      -- A JSON number only (text would be ignored by nobody's page but is a way to store a value the worker reads differently),
      -- one the worker enforces, and no larger than the page offers.
      cap := case when jsonb_typeof(v) = 'number' then public.channel_spend_ceiling(v) end;
      if cap is null or cap > max_ceiling then
        raise exception 'invalid_patch: spend_ceiling_usd is a number above 0 and at most %', max_ceiling
          using errcode = '22023', hint = 'invalid_patch';
      end if;
      sets := sets || jsonb_build_object(k, v);
    else
      if jsonb_typeof(v) <> 'boolean' then
        raise exception 'invalid_patch: % is true or false', k using errcode = '22023', hint = 'invalid_patch';
      end if;
      sets := sets || jsonb_build_object(k, v);
    end if;
  end loop;
  -- ONE statement: the merge is evaluated against the row as it is when the row lock is granted, so a concurrent patch of another
  -- key is kept. A row the caller may not update (another organization's, a viewer's, none) matches nothing.
  update public.channels c
     set agent_config = ((case when jsonb_typeof(c.agent_config) = 'object' then c.agent_config else '{}'::jsonb end) || sets) - drops,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where c.channel_id = p_channel_id and public.is_org_member(c.org_id, 'editor')
  returning c.agent_config into merged;
  if not found then
    raise exception 'channel not found or not yours' using errcode = '42501', hint = 'channel_not_writable';
  end if;
  return jsonb_build_object('ok', true, 'agent_config', merged);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Grants: revoke from everyone, then grant narrowly
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.channel_spend_ceiling(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.channel_spend_ceiling(jsonb) to authenticated, service_role;
revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;
revoke all on function public.patch_channel_agent_config(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.patch_channel_agent_config(text, jsonb) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     public.channel_spend_ceiling('25'::jsonb) = 25 and public.channel_spend_ceiling('" 25.50 "'::jsonb) = 25.5
--       and public.channel_spend_ceiling('"1e2"'::jsonb) = 100 as readable_values,
--     public.channel_spend_ceiling('0'::jsonb) is null and public.channel_spend_ceiling('true'::jsonb) is null
--       and public.channel_spend_ceiling('"abc"'::jsonb) is null and public.channel_spend_ceiling('1e400'::jsonb) is null
--       and public.channel_spend_ceiling('"٢٥"'::jsonb) is null and public.channel_spend_ceiling('[]'::jsonb) is null
--       and public.channel_spend_ceiling(null) is null as no_limit_values,
--     position('spend_ceiling_lock' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) > 0
--       and position('channel_voice_config_problem' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) > 0
--       and position('channel_label_lowering' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) > 0 as guard_keeps_every_check,
--     not (select prosecdef from pg_proc where oid = 'public.patch_channel_agent_config(text,jsonb)'::regprocedure) as patch_runs_as_the_caller,
--     not has_function_privilege('anon', 'public.patch_channel_agent_config(text,jsonb)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.patch_channel_agent_config(text,jsonb)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.patch_channel_agent_config(text,jsonb)', 'EXECUTE') as grants,
--     (select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard' and not tgisinternal) = 1 as trigger_still_bound;
--
-- Channels that carry a limit today (this migration rewrites no row; from now on an editor cannot raise or remove these):
--   select channel_id, org_id, agent_config -> 'spend_ceiling_usd' as stored, public.channel_spend_ceiling(agent_config -> 'spend_ceiling_usd') as enforced
--     from public.channels
--    where agent_config ? 'spend_ceiling_usd';
