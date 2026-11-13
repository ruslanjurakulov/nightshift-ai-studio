-- 0151_model_probe_seconds.sql — the Studio's "~N%" for a model nobody here has used yet: how long the platform's own test run of
-- it took. Read-only. docs/MIGRATIONS.md "0151".
--
-- *** LIVE ON APPLY, read-only. *** It adds ONE function and nothing else: no table, column, row, index, policy or trigger, and it
-- replaces nothing.
--
-- WHY. A running generation in the Studio shows "~N%" only from this organization's own finished jobs on the same model (median of
-- the newest 20, at least 3 needed: command-center/lib/creative/progress.ts). A model that was just added (Runway Gen-4.5, Gen-4 Turbo,
-- MiniMax H3 ...) therefore shows only seconds for its first three jobs in every workspace. The platform has measured each sold model
-- at least once: a sale needs a successful probe (0035, model_registry_verified_before_sale), and model_probe_runs keeps how long that
-- real call took (latency_ms). This function hands that one number, and the clip length the probe asked for, to the signed-in Studio,
-- which uses it as the expected duration until the organization has history of its own, and says on the pill that it is from a test
-- run (rule 5: an estimate is never shown as a measurement of this job).
--
-- WHAT ONE ROW SAYS (one per model asked for that has a usable probe; none for any other model)
--   model_id       the model.
--   capability     what the probe asked the model to do (t2i, i2v ...). The Studio never uses the seconds for another capability.
--   probe_seconds  the newest SUCCESSFUL probe's latency_ms / 1000, of a probe that called what the registry calls today (the same
--                  adapter and the vendor model the registry names for that capability). It is the probe tool's wall time from submit
--                  to the downloaded file (tools/probe_models.py run_probe: submit, poll, fetch), so it INCLUDES the download and the
--                  poll interval, and for a voice tool the short speech clip the probe makes first. A job's own time is measured from
--                  started_at to finished_at by the worker, which also stores the file: the two are close, not the same.
--   clip_seconds   the probe request's clip length (model_registry.spec.probe.duration_s, the reviewed schemas/model_registry.json
--                  block that tools/probe_models.py --sync copies in), only when that block is for the same capability as the probe
--                  row and is a positive number up to an hour; otherwise null (an image, a sound, a probe block that names no length).
--                  It is the registry's CURRENT probe block: a probe run before the block's length changed is described by the new
--                  length. The owner re-probes after such a change (it also clears verification when the vendor model changes).
--   probed_at      when that probe ran. The Studio ignores a probe older than 30 days.
--   failed_after   true when a probe of the same model and capability FAILED after that success: the newest word on the model is a
--                  failure, and the Studio then shows no seeded percentage.
--
-- WHO MAY CALL IT, AND WHAT IT REVEALS. SECURITY DEFINER, because model_probe_runs and model_registry.spec are closed to every API role
-- (0035: probe evidence and spec are platform-only). It reveals NO organization's data: probes are platform-wide test calls written by
-- the probe tool with the service key, and carry no prompt, result or price of anyone's. It returns only the five columns above (never
-- error text, output bytes, who probed, the adapter, the vendor model or anything else of spec), and only for a model a signed-in user
-- can already see in the registry (beta or ga, and verified: 0035's RLS on model_registry), or for any model when the caller is a
-- platform owner or admin (is_platform_admin(): the operator's preview of a hidden model, 0139). So a customer learns nothing about a
-- model that is not on sale. It checks sign-in itself (auth.uid()) before it reads anything; execute is granted to `authenticated`
-- only (revoked from public, anon and service_role: the Command Center reads it with the member's own session and the ANON key, and
-- the worker has no use for it). search_path is pinned. It writes, prices, spends and starts nothing.
--
-- INPUT. p_models: at most 50 ids, each the registry's id shape (^[a-z0-9][a-z0-9.-]{1,39}$, 0035's model_registry_id_check), no
-- null; otherwise 22023 'invalid models' and nothing is read. NULL or an empty array answers no rows. The Studio asks for at most 4.
--
-- THE APP WITHOUT THIS FILE. The Command Center's durations route calls it only for a model with fewer than 3 finished jobs here; a
-- missing function (42883 / PGRST202) or any other error leaves the seed out, and the pill shows the seconds since the job started, as
-- before this file.
--
-- REQUIRES 0018 (is_platform_admin) and 0035 (model_registry, model_probe_runs). Additive and idempotent: create-or-replace of a
-- function that did not exist; a replay changes nothing. Undo: docs/sql/rollback_0151_model_probe_seconds.sql (owner-applied).
--
-- NUMBER. 0151. 0147 and 0149 are open pull requests and 0148 and 0150 are reserved by other work; this file names no object of
-- theirs. The highest number on main when it was written is 0146.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). Expected: one row, all true.
--   select to_regprocedure('public.model_probe_seconds(text[])') is null as function_is_new,
--          to_regclass('public.model_probe_runs') is not null and to_regclass('public.model_registry') is not null as has_0035,
--          to_regprocedure('public.is_platform_admin()') is not null as has_0018;
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0151 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regclass('public.model_registry') is null or to_regclass('public.model_probe_runs') is null then
    raise exception '0151 needs 0035_model_registry.sql: apply it first';
  end if;
  -- The one name this file creates: absent, or this file's own body (a replay).
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.model_probe_seconds(text[])');
  if h is not null and h <> '1a05990e1840630725b4b8dd87a13b20' then
    raise exception '0151 found public.model_probe_seconds(text[]) with a body that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The newest usable probe per model
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.model_probe_seconds(p_models text[])
  returns table (
    model_id       text,
    capability     text,
    probe_seconds  numeric,
    clip_seconds   numeric,
    probed_at      timestamptz,
    failed_after   boolean
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not available' using errcode = '42501';
  end if;
  if p_models is null or cardinality(p_models) = 0 then
    return;
  end if;
  -- Bounded before anything is read: a long or malformed list is refused whole, never trimmed into a different question.
  if cardinality(p_models) > 50 or array_ndims(p_models) <> 1
     or exists (select 1 from unnest(p_models) as m(id) where m.id is null or m.id !~ '^[a-z0-9][a-z0-9.-]{1,39}$') then
    raise exception 'invalid models' using errcode = '22023';
  end if;

  return query
    select r.id,
           pr.capability,
           round(pr.latency_ms / 1000.0, 3),
           -- The probe's clip length, only from a probe block for the same capability (an i2v probe's 5 s says nothing of t2v).
           case when r.spec -> 'probe' ->> 'capability' = pr.capability
                 and jsonb_typeof(r.spec -> 'probe' -> 'duration_s') = 'number'
                 and (r.spec -> 'probe' ->> 'duration_s')::numeric > 0
                 and (r.spec -> 'probe' ->> 'duration_s')::numeric <= 3600
                then (r.spec -> 'probe' ->> 'duration_s')::numeric end,
           pr.created_at,
           exists (select 1
                     from public.model_probe_runs f
                    where f.model_id = r.id
                      and f.capability = pr.capability
                      and not f.ok
                      and (f.created_at, f.id) > (pr.created_at, pr.id))
      from public.model_registry r
      cross join lateral (
        select p.id, p.capability, p.latency_ms, p.created_at
          from public.model_probe_runs p
         where p.model_id = r.id
           and p.ok
           and p.latency_ms > 0
           -- A probe of what the registry calls today: when the file moves a model to another adapter or vendor model, an older
           -- probe timed something else.
           and p.adapter = r.adapter
           and p.vendor_model = coalesce(r.spec -> 'vendor_model_by_capability' ->> p.capability, r.spec ->> 'vendor_model')
         order by p.created_at desc, p.id desc
         limit 1) pr
     where r.id = any (p_models)
       and ((r.availability in ('beta', 'ga') and r.verified_at is not null) or public.is_platform_admin());
end
$$;

comment on function public.model_probe_seconds(text[]) is
  'Migration 0151: per model, the newest successful probe''s wall time (s, download included), its capability, the probe''s clip length, when it ran, and whether a probe failed since. Platform-wide test calls, no organization data; models on sale, or any model for a platform admin. The Studio''s progress pill seeds "~N%" from it until an organization has its own history.';

revoke all on function public.model_probe_seconds(text[]) from public, anon, authenticated, service_role;
grant execute on function public.model_probe_seconds(text[]) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. End state
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  fn oid := to_regprocedure('public.model_probe_seconds(text[])');
begin
  if fn is null then
    raise exception '0151 end state: public.model_probe_seconds(text[]) does not exist';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = fn) is distinct from '1a05990e1840630725b4b8dd87a13b20' then
    raise exception '0151 end state: public.model_probe_seconds(text[]) does not hold the body this file expects';
  end if;
  if not has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception '0151 end state: public.model_probe_seconds(text[]) has the wrong grants';
  end if;
  if exists (select 1 from pg_proc p where p.oid = fn
              and (not p.prosecdef or p.provolatile <> 's' or p.proacl is null
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
    raise exception '0151 end state: public.model_probe_seconds(text[]) is not a stable SECURITY DEFINER with a fixed search_path, or PUBLIC may call it';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select p.prosecdef as security_definer,
--        p.proconfig @> array['search_path=public, pg_temp'] as search_path_pinned,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') as signed_in_may_call,
--        not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('service_role', p.oid, 'EXECUTE') as anon_and_service_cannot
--   from pg_proc p
--  where p.oid = 'public.model_probe_seconds(text[])'::regprocedure;
--
-- What the Studio would be told (the SQL editor runs as postgres, which has no auth.uid(): read the probe log directly instead).
-- Expected for a just-probed video model: its latest ok probe in seconds, and the probe block's duration_s.
-- select r.id, p.capability, round(p.latency_ms / 1000.0, 1) as probe_seconds, r.spec -> 'probe' ->> 'duration_s' as clip_seconds, p.created_at
--   from public.model_registry r
--   join lateral (select * from public.model_probe_runs x where x.model_id = r.id and x.ok order by x.created_at desc limit 1) p on true
--  where r.id in ('runway-gen4.5', 'runway-gen4-turbo', 'minimax-h3');
