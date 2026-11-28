-- 0248_film_take_typical_seconds.sql — how long a take of a model usually takes here, for "usually ~N s here (last n
-- takes)" in the live view (docs/studio/LIVE_CREATION_PLAN.md section 3 item 7; build order item 10).
--
-- EVIDENCE. A running take shows its elapsed time only; nothing says whether 90 s is normal for that model. film_takes keeps
--   started_at (0171, film_begin_take) and finished_at (0166) for every take.
-- CHANGE. One new function, film_take_typical_seconds(film), Atlas's rule (#985, after Breach round 2). For each model and
--   capability of the film's own takes (keyframe = t2i, clip and extend = i2v, narration = tts), from completed takes of the
--   last 90 days whose started_at .. finished_at is a real duration (it started, it ended after it began, under 6 hours;
--   failed takes are not how long a take takes), each organization over its own last 20:
--   1. 'yours': the film organization holds 3 or more. Their median, in whole seconds, and n.
--   2. 'nightshift': otherwise, the operator organization's own median (the organization the credits exempt: 0020's
--      credits_exempt, the rule 0171's start_film uses), when it holds 3 or more. Whole seconds only: no n, no id.
--   3. null: neither. No duration: the live view shows elapsed time only.
--   No customer's takes are ever in another customer's answer. A median across customers' organizations, even one vote each
--   behind a floor of five, can be steered by whoever makes enough organizations (they are cheap): four of them place the
--   figure exactly on one victim's median, and the floor's flip says when a victim works (Breach B-0248-1, -2, -3). The
--   operator's own takes are Nightshift's, so showing their median tells no customer anything about another.
--   Why this window: 20 per organization, and 90 days because a vendor's speed changes and an old figure misleads; it also
--   bounds the scan. Only the film's own model and capability pairs are answered, so the answer names no other models.
--   SECURITY DEFINER (started_at is not a member column, and the operator's takes are not a customer's to read): it answers
--   only a member (viewer or above) of the film's organization, and a film the caller may not read is not_found whether or not
--   it exists, with no figure of any kind.
-- NUMBER. 0248, assigned by Atlas (live creation plan, section 4). Needs 0166 (films, film_takes), 0171 (started_at),
--   0043 (accessible_org_ids) and 0020 (credits_exempt).
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
     or to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null then
    raise exception '0248 needs 0166, 0171 (film_takes.started_at), 0043 (accessible_org_ids) and 0020 (credits_exempt): apply them first';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.film_take_typical_seconds(uuid)');
  if h is not null and h <> '2b78ecab9db4e806d97d9774d1f61c61' then
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
  -- A film the caller may not read is not found, whether or not it exists: no figure of any kind, theirs or Nightshift's.
  if o is null or o not in (select public.accessible_org_ids('viewer')) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  with timed as (
    -- Every completed take with a duration this asks about, in the last 90 days (a vendor's speed changes; older timings mislead).
    select x.org_id, x.model,
           case x.kind when 'keyframe' then 't2i' when 'narration' then 'tts' else 'i2v' end as capability,
           extract(epoch from (x.finished_at - x.started_at))::numeric as secs, x.finished_at, x.id
      from public.film_takes x
     where x.status = 'completed' and x.model is not null
       and x.kind in ('keyframe', 'clip', 'extend', 'narration')
       and x.started_at is not null and x.finished_at is not null
       and x.finished_at > x.started_at and x.finished_at - x.started_at < interval '6 hours'
       and x.finished_at > now() - interval '90 days'
  ), ranked as (
    -- Each organization's last 20 per model and capability.
    select t.*, row_number() over (partition by t.org_id, t.model, t.capability order by t.finished_at desc, t.id) as rn
      from timed t
  ), per_org as (
    select r.org_id, r.model, r.capability, count(*) as n,
           percentile_cont(0.5) within group (order by r.secs) as med
      from ranked r
     where r.rn <= 20
     group by r.org_id, r.model, r.capability
  ), nightshift as (
    -- Nightshift's own figure: the operator organization's takes only (the organization the credits exempt, 0020's
    -- credits_exempt, the same rule as 0171's start_film), n of 3 or more. No customer's take is ever in it: a median over
    -- customers' organizations can be steered by whoever makes enough of them (Breach B-0248-1, -2, -3).
    select p.model, p.capability, p.med
      from per_org p
     where public.credits_exempt(p.org_id) and p.n >= 3
  ), wanted as (
    -- Only the model and capability pairs of this film's own takes: nothing says which models other workspaces use.
    select distinct y.model, case y.kind when 'keyframe' then 't2i' when 'narration' then 'tts' else 'i2v' end as capability
      from public.film_takes y
     where y.film_id = p_film and y.model is not null and y.kind in ('keyframe', 'clip', 'extend', 'narration')
  )
  select coalesce(jsonb_agg(
           case when mine.n >= 3 then jsonb_build_object('model', w.model, 'capability', w.capability, 'basis', 'yours',
                                                         'median_s', round(mine.med::numeric), 'n', mine.n)
                when ns.med is not null then jsonb_build_object('model', w.model, 'capability', w.capability,
                                                                'basis', 'nightshift', 'median_s', round(ns.med::numeric))
                else jsonb_build_object('model', w.model, 'capability', w.capability, 'basis', null) end
           order by w.model, w.capability), '[]'::jsonb)
    into res
    from wanted w
    left join per_org mine on mine.org_id = o and mine.model = w.model and mine.capability = w.capability
    left join nightshift ns on ns.model = w.model and ns.capability = w.capability;
  return res;
end
$$;

revoke all on function public.film_take_typical_seconds(uuid) from public, anon, authenticated, service_role;
grant execute on function public.film_take_typical_seconds(uuid) to authenticated;

comment on function public.film_take_typical_seconds(uuid) is
  '0248: per model and capability of the film''s takes: the organization''s median and n (basis yours, n >= 3), else the operator organization''s own median (basis nightshift, n >= 3, seconds only), else basis null. Members only; no ids; no other customer''s takes.';

-- The end state, asserted inside the transaction.
do $$
declare
  h text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p where p.oid = 'public.film_take_typical_seconds(uuid)'::regprocedure;
  if h is distinct from '2b78ecab9db4e806d97d9774d1f61c61' then
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
