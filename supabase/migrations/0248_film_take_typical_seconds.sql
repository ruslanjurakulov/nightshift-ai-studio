-- 0248_film_take_typical_seconds.sql — how long a take of a model usually takes here, for "usually ~N s here (last n
-- takes)" in the live view (docs/studio/LIVE_CREATION_PLAN.md section 3 item 7; build order item 10).
--
-- EVIDENCE. A running take shows its elapsed time only; nothing says whether 90 s is normal for that model. film_takes keeps
--   started_at (0171, film_begin_take) and finished_at (0166) for every take.
-- CHANGE. One new function, film_take_typical_seconds(film): for the film's organization only, per model and capability
--   (keyframe = t2i, clip and extend = i2v, narration = tts), the median of the last 20 completed takes' started_at ..
--   finished_at, in seconds (rounded to 0.1), and n, how many takes it rests on. The caller decides what to show: the plan
--   shows a figure only with n of 3 or more, so n is always returned. A take that never started, has no end, ended before
--   it began or ran 6 hours or more is left out (not a duration this asks about). Failed takes are left out: their time is
--   not how long a take takes.
--   SECURITY DEFINER (started_at is not a column members read): it answers only a member (viewer or above) of the film's
--   organization, and a film the caller may not read is not_found whether or not it exists. It returns model ids, the
--   capability word, the median and n: no take, film, organization or person id, no prompt, error or money.
--   Scope: the caller's own organization, not every organization's. The plan says "from our own film_takes timings" and does
--   not settle whether one workspace's timings may inform another's; until Atlas does, nothing crosses an organization.
-- NUMBER. 0248, assigned by Atlas (live creation plan, section 4). Needs 0166 (films, film_takes), 0171 (started_at) and
--   0043 (accessible_org_ids).
-- Rollback: docs/sql/rollback_0248_film_take_typical_seconds.sql (owner-applied).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- No backslash anywhere in this file: the live apply path once rewrote backslash escapes inside SQL text (0219's header).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regclass('public.film_takes') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'film_takes'
                     and column_name = 'started_at')
     or to_regprocedure('public.accessible_org_ids(text)') is null then
    raise exception '0248 needs 0166, 0171 (film_takes.started_at) and 0043 (accessible_org_ids): apply them first';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.film_take_typical_seconds(uuid)');
  if h is not null and h <> '1cbe7f01e8425f45355df594816935a4' then
    raise exception '0248 found a film_take_typical_seconds that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

create or replace function public.film_take_typical_seconds(p_film uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  o   uuid;
  res jsonb;
begin
  select f.org_id into o from public.films f where f.id = p_film;
  -- A film the caller may not read is not found, whether or not it exists.
  if o is null or o not in (select public.accessible_org_ids('viewer')) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  with t as (
    select x.model,
           case x.kind when 'keyframe' then 't2i' when 'narration' then 'tts' else 'i2v' end as capability,
           extract(epoch from (x.finished_at - x.started_at))::numeric as secs,
           row_number() over (partition by x.model, case x.kind when 'keyframe' then 't2i' when 'narration' then 'tts' else 'i2v' end
                              order by x.finished_at desc, x.id) as rn
      from public.film_takes x
     where x.org_id = o and x.status = 'completed' and x.model is not null
       and x.kind in ('keyframe', 'clip', 'extend', 'narration')
       and x.started_at is not null and x.finished_at is not null
       and x.finished_at > x.started_at and x.finished_at - x.started_at < interval '6 hours'
  ), m as (
    select model, capability, count(*) as n,
           percentile_cont(0.5) within group (order by secs) as med
      from t
     where rn <= 20
     group by model, capability
  )
  select coalesce(jsonb_agg(jsonb_build_object('model', model, 'capability', capability,
                                               'median_s', round(med::numeric, 1), 'n', n)
                            order by model, capability), '[]'::jsonb)
    into res
    from m;
  return res;
end
$$;

revoke all on function public.film_take_typical_seconds(uuid) from public, anon, authenticated, service_role;
grant execute on function public.film_take_typical_seconds(uuid) to authenticated;

comment on function public.film_take_typical_seconds(uuid) is
  '0248: per model and capability, the median seconds of the film organization''s last 20 completed takes, and n. Members only; no ids.';

-- The end state, asserted inside the transaction.
do $$
declare
  h text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = 'public.film_take_typical_seconds(uuid)'::regprocedure;
  if h is distinct from '1cbe7f01e8425f45355df594816935a4' then
    raise exception '0248 end state: film_take_typical_seconds is not this file''s body (md5 %)', h;
  end if;
  if not has_function_privilege('authenticated', 'public.film_take_typical_seconds(uuid)', 'execute')
     or has_function_privilege('anon', 'public.film_take_typical_seconds(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.film_take_typical_seconds(uuid)', 'execute')
     or not (select p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'] from pg_proc p
              where p.oid = 'public.film_take_typical_seconds(uuid)'::regprocedure) then
    raise exception '0248 end state: a grant or the definer settings are not what this file sets';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (read-only, run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   has_function_privilege('authenticated', 'public.film_take_typical_seconds(uuid)', 'execute')                    as members_may_ask,
--   not has_function_privilege('anon', 'public.film_take_typical_seconds(uuid)', 'execute')                         as anon_may_not,
--   (select p.prosecdef from pg_proc p where p.oid = 'public.film_take_typical_seconds(uuid)'::regprocedure)        as security_definer;
