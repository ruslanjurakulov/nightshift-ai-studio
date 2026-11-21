-- 0158_thumbnail_concept_admin_lock.sql — a channel's concept-thumbnail settings are an administrator's to change.
--
-- WHAT WAS WRONG
--   modules/thumbnail_concept.py (PR #731) reads two agent_config keys:
--     * thumbnail_mode      "concept" makes every run of the channel call the script model once more and an image
--                           model once per A/B arm, through the WORKER's provider keys (shared by every organization on
--                           a hosted worker), and stop the run when that cannot be done;
--     * thumbnail_concept   which image provider and model, whether invented faces may appear (allow_faces), whether
--                           words may be baked into the picture (allow_baked_text), and the headline style.
--   Without this file both are as writable as any other agent_config key: any EDITOR of the organization could switch a
--   channel to paid generation on the shared keys, pick the model, or turn on faces and baked words. Those are the same
--   kind of decision as 0086's controls (they change what a run costs and what it may put in front of an audience), so
--   they get the same rule.
--
-- WHAT THIS CHANGES
--   1. channel_admin_controls() (0086) lists the two keys after its four. create_channel() reads that list through
--      channel_controls_changed(), so a channel CREATED with either key now needs an administrator of the organization
--      (or a trusted server caller), exactly like publish_gate. create_channel() itself is not replaced.
--   2. A second BEFORE INSERT OR UPDATE trigger on channels, channels_thumbnail_concept_guard, held to the browser roles
--      only (authenticated, anon), the same convention as 0086: the service role, the SQL editor and every SECURITY
--      DEFINER function run as another role and pass. It refuses a write in which either key's value differs from the
--      stored one (set, changed or removed; a whole-blob write that carries the stored value back unchanged passes),
--      unless the caller administers the channel's organization. SQLSTATE 42501, message prefix 'thumbnail_concept_lock:',
--      hint 'thumbnail_concept_lock'. patch_channel_agent_config (0119) already refuses both keys (not in its whitelist).
--   A separate trigger rather than a new body for channels_config_guard(): 0117/0119 pin that body by md5, and a
--   replacement would have to carry every earlier check again; this one adds a wall and touches none of them.
--
-- WHAT IT DOES NOT CHANGE
--   No row is rewritten and no grant is widened. A channel that already has either key keeps it. The pipeline (service
--   role) and an administrator's writes are unchanged, and so is every other key an editor writes.
--
-- NUMBER. 0158: the highest on main is 0157 (0157_dodo_purchase_history.sql).
--
-- REQUIRES 0018 (is_org_member), 0020 (credits_trusted_caller, through create_channel), 0086 (channel_admin_controls,
-- channel_controls_changed, create_channel, the channels_config_guard trigger) and 0114 (create_channel's latest body).
-- Additive and idempotent: create or replace, drop-then-create of this file's own trigger, revoke then grant. Creating
-- the trigger takes a short SHARE ROW EXCLUSIVE lock on public.channels (lock_timeout below).
-- Rollback: docs/sql/rollback_0158_thumbnail_concept_admin_lock.sql.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0158 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.channel_admin_controls()') is null
     or to_regprocedure('public.channel_controls_changed(jsonb, jsonb)') is null
     or to_regprocedure('public.create_channel(text, uuid, text, text, jsonb, jsonb, jsonb, boolean)') is null then
    raise exception '0158 needs 0086_channel_config_lock.sql (channel_admin_controls, create_channel): apply it first';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard' and not tgisinternal) then
    raise exception '0158 found no channels_config_guard trigger on channels: re-apply 0086 first';
  end if;
end $$;

-- The list is replaced on what the REPO says it is: 0086's four keys, or this file's six on a replay. Anything else was
-- changed by hand after 0086, and replacing it would silently undo that change.
do $$
declare
  got text[];
begin
  select array(select k from unnest(public.channel_admin_controls()) as k order by k) into got;
  if got is distinct from array['auto_publish', 'publish_gate', 'require_two_person_publish', 'storyboard_review']::text[]
     and got is distinct from array['auto_publish', 'publish_gate', 'require_two_person_publish', 'storyboard_review',
                                    'thumbnail_concept', 'thumbnail_mode']::text[] then
    raise exception '0158 found channel_admin_controls() = % (neither 0086''s list nor 0158''s): read it first', got;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The controls create_channel() holds to an administrator
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.channel_admin_controls() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish',
               'thumbnail_mode', 'thumbnail_concept']::text[]
$$;

revoke all on function public.channel_admin_controls() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The trigger: an editor cannot set, change or remove either key
-- ───────────────────────────────────────────────────────────────────────────

-- Security invoker, on purpose (as 0086's guard): current_user is the browser role only when the browser wrote the row.
-- It calls nothing but is_org_member, which the browser roles already execute.
create or replace function public.channels_thumbnail_concept_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  keys    constant text[] := array['thumbnail_mode', 'thumbnail_concept'];
  k       text;
  changed text[] := '{}';
  org     uuid;
  o       jsonb := '{}'::jsonb;
  n       jsonb := case when jsonb_typeof(new.agent_config) = 'object' then new.agent_config else '{}'::jsonb end;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  org := new.org_id;
  if tg_op = 'UPDATE' then
    org := old.org_id;
    if jsonb_typeof(old.agent_config) = 'object' then
      o := old.agent_config;
    end if;
  end if;
  foreach k in array keys loop
    if (o -> k) is distinct from (n -> k) then
      changed := changed || k;
    end if;
  end loop;
  if cardinality(changed) > 0 and not public.is_org_member(org, 'admin') then
    raise exception 'thumbnail_concept_lock: only an administrator of this organization may change: %',
      array_to_string(changed, ', ') using errcode = '42501', hint = 'thumbnail_concept_lock';
  end if;
  return new;
end
$$;

revoke all on function public.channels_thumbnail_concept_guard() from public, anon, authenticated, service_role;

drop trigger if exists channels_thumbnail_concept_guard on public.channels;
create trigger channels_thumbnail_concept_guard
  before insert or update on public.channels
  for each row execute function public.channels_thumbnail_concept_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     public.channel_admin_controls() @> array['thumbnail_mode', 'thumbnail_concept']
--       and public.channel_admin_controls() @> array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish']
--       as controls_listed,
--     public.channel_controls_changed('{}'::jsonb, '{"thumbnail_mode": "concept"}'::jsonb) = array['thumbnail_mode']
--       as create_channel_sees_it,
--     (select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass
--        and tgname = 'channels_thumbnail_concept_guard' and not tgisinternal) = 1 as trigger_bound,
--     (select count(*) from pg_trigger where tgrelid = 'public.channels'::regclass
--        and tgname = 'channels_config_guard' and not tgisinternal) = 1 as earlier_guard_kept,
--     not has_function_privilege('anon', 'public.channels_thumbnail_concept_guard()', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.channels_thumbnail_concept_guard()', 'EXECUTE') as grants;
--
-- Channels that already use either key (this file rewrites none of them):
--   select channel_id, org_id, agent_config -> 'thumbnail_mode' as mode, agent_config -> 'thumbnail_concept' as concept
--     from public.channels
--    where agent_config ? 'thumbnail_mode' or agent_config ? 'thumbnail_concept';
