-- 0087_audit_and_rate_hardening.sql — the audit trail names the person who wrote
-- a row, and a caller cannot reset their own web rate counter (Breach wave 7:
-- BR-G-008, BR-G-004).
--
-- BR-G-008  app_audit_log_insert pinned `actor_user_id = auth.uid()` and the
--   channel scope, but not `actor_email`, `action`, `at` or the size of
--   `detail`. A viewer could write "owner@... publish.approve" into the stream
--   an owner reads after an incident. The Command Center sets `actor_email`
--   from the session (lib/server/audit.ts); the database did not.
--   A BEFORE INSERT trigger now holds the browser roles (authenticated, anon)
--   to the rules: actor_email is the caller's confirmed address from
--   auth.users (never what they sent; NULL when unconfirmed), `at` is now(),
--   `action` must be one the application writes (audit_action_allowed: the
--   list below, pinned against the Command Center's own logAudit calls by
--   tests/test_audit_actions.py), `target` <= 200 characters and `detail` an
--   object <= 4 KiB. The definer functions that audit their own work (api
--   keys, 0031 / 0040 / 0042 / 0062) run as the function's owner and are not
--   touched. Not changed: there is still no per-user insert rate limit; a
--   viewer can add rows of known actions about themselves, never about
--   someone else.
--
-- BR-G-004  take_web_rate deleted the caller's rows of the same bucket from
--   EARLIER windows whatever the window length, so one call with a one-second
--   window erased the counter a route keeps with a ten-minute one. The counter
--   is now keyed by (user, bucket, window length, window start) and a call
--   deletes only older windows of its own length (plus anything older than two
--   days, which no window can still use). The arguments are still the caller's
--   to choose; a call with another window length counts in its own counter and
--   cannot touch the route's.
--
-- Additive and idempotent. REQUIRES 0008 (app_audit_log), 0042 (take_web_rate),
-- 0043 (my_confirmed_email).

do $$
begin
  if to_regclass('public.app_audit_log') is null then
    raise exception '0087 needs 0008_audit_log.sql: apply it first';
  end if;
  if to_regclass('public.web_rate_counters') is null or to_regprocedure('public.take_web_rate(text, integer, integer)') is null then
    raise exception '0087 needs 0042_web_api_hardening.sql: apply it first';
  end if;
  if to_regprocedure('public.my_confirmed_email()') is null then
    raise exception '0087 needs 0043_invites_accept.sql (my_confirmed_email): apply it first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The audit trail (BR-G-008)
-- ───────────────────────────────────────────────────────────────────────────

-- The actions the application writes. Exact names, plus the two families whose
-- last part is a value (a platform, a decision). A new action needs a line here
-- and in tests/test_audit_actions.py, or the audit write is refused (the
-- application swallows an audit failure, so a missing line means a lost row).
create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'scene.regenerate', 'secret.write', 'series.create',
    'series.update', 'storyboard.approve', 'storyboard.discard', 'storyboard.edit', 'storyboard.reopen',
    'style_kit.add_library', 'style_kit.attach', 'style_kit.create', 'style_kit.delete', 'style_kit.detach',
    'style_kit.update', 'variable.write', 'video.download_request', 'video.publish_request',
    'workflow.cancel', 'workflow.delete', 'workflow.run', 'workflow.save'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

create or replace function public.app_audit_log_stamp() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  -- Only the browser roles. The definer functions that write their own audit
  -- rows run as their owner and keep what they pass.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if not public.audit_action_allowed(new.action) then
    raise exception 'unknown audit action' using errcode = '22023';
  end if;
  if char_length(coalesce(new.target, '')) > 200 then
    raise exception 'audit target is too long' using errcode = '22023';
  end if;
  if jsonb_typeof(new.detail) is distinct from 'object' or octet_length(new.detail::text) > 4096 then
    raise exception 'audit detail must be an object of at most 4096 bytes' using errcode = '22023';
  end if;
  -- Who wrote the row is the session's answer, never the caller's.
  new.actor_email := public.my_confirmed_email();
  new.at := now();
  return new;
end
$$;

drop trigger if exists app_audit_log_stamp on public.app_audit_log;
create trigger app_audit_log_stamp
  before insert on public.app_audit_log
  for each row execute function public.app_audit_log_stamp();

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;
revoke all on function public.app_audit_log_stamp() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The web rate counter (BR-G-004)
-- ───────────────────────────────────────────────────────────────────────────

alter table public.web_rate_counters add column if not exists window_seconds integer not null default 0;

do $$
begin
  -- The key gains the window length. Existing rows keep window_seconds = 0 and
  -- are cleaned up by the two-day rule below.
  if not exists (
    select 1 from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = 'public.web_rate_counters'::regclass and c.contype = 'p' and a.attname = 'window_seconds'
  ) then
    alter table public.web_rate_counters drop constraint if exists web_rate_counters_pkey;
    alter table public.web_rate_counters add primary key (user_id, bucket, window_seconds, window_start);
  end if;
end $$;

-- True when the caller may make one more request in `p_bucket` now (and
-- counts it); false when this window's allowance is spent.
create or replace function public.take_web_rate(p_bucket text, p_max integer, p_window_seconds integer)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  v_start timestamptz;
  v_used  integer;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if coalesce(p_bucket, '') !~ '^[a-z0-9_.:-]{1,64}$'
     or p_max is null or p_max not between 1 and 1000
     or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'bad rate limit arguments' using errcode = '22023';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.web_rate_counters as c (user_id, bucket, window_seconds, window_start, count)
  values (uid, p_bucket, p_window_seconds, v_start, 1)
  on conflict (user_id, bucket, window_seconds, window_start) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    -- Older windows of THIS window length only: another length is another
    -- counter and is never the caller's to erase. Anything older than two
    -- days is dead for every allowed length (at most one day).
    delete from public.web_rate_counters c
     where c.user_id = uid
       and ((c.bucket = p_bucket and c.window_seconds = p_window_seconds and c.window_start < v_start)
            or c.window_start < now() - interval '2 days');
  end if;
  return v_used <= p_max;
end
$$;

revoke all on function public.take_web_rate(text, integer, integer) from public, anon, service_role;
grant execute on function public.take_web_rate(text, integer, integer) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor; every row should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select (select count(*) from pg_trigger where tgrelid = 'public.app_audit_log'::regclass
--            and tgname = 'app_audit_log_stamp' and not tgisinternal) = 1 as audit_trigger,
--          exists (select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
--                   where c.conrelid = 'public.web_rate_counters'::regclass and c.contype = 'p'
--                     and a.attname = 'window_seconds') as rate_key_has_window,
--          has_function_privilege('authenticated', 'public.take_web_rate(text,integer,integer)', 'EXECUTE')
--            and not has_function_privilege('anon', 'public.take_web_rate(text,integer,integer)', 'EXECUTE') as rate_acl;
