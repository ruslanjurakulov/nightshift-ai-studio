-- rollback_0230_geo_gate_allow_list.sql — takes migration 0230 (the allow-list read in the country gate) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor, as one transaction. Nothing in the app runs it. Idempotent.
--
-- WHAT COMES BACK: 0208's creative_jobs_geo_gate, verbatim (md5 71468a6f60d2659cd44199a3c834dc69, white space folded). A claim code
--   on neither of Google's lists (EU, ZZ) is then a job on a Google model again (BR-S6-03-DB is open again); every model with a
--   country list stays off sale through 0142's CHECK, which neither file touches.
-- WHAT IS KEPT: the trigger (it names the function, which is replaced in place), geo_claim_country, the grants (none for an API role),
--   and available_countries in the registry rows (data the registry sync owns; 0208's body never reads it).
-- WHAT IT DOES: 0. REFUSES (changes nothing) if the gate is neither 0230's body nor 0208's (a later file changed it: take that out
--   first). 1. Puts 0208's body back. 2. Asserts the end state.
-- No backslash anywhere in this file (0219's header): the md5 fold is [[:space:]]+.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.creative_jobs_geo_gate()');
  if h is null or h <> all (array['3f2e4d767f9d53de505aacb29e7141f9', '71468a6f60d2659cd44199a3c834dc69']) then
    raise exception 'rollback 0230: creative_jobs_geo_gate() is neither 0230''s body nor 0208''s (md5 %): read it first', h;
  end if;
end $$;

-- 0208's body.
create or replace function public.creative_jobs_geo_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m   text := coalesce(new.routed_model, new.requested_model);
  lst jsonb;
  c   text;
begin
  -- A row that does not change its model is not asked again (a status, a heartbeat, a result).
  if tg_op = 'UPDATE' and new.routed_model is not distinct from old.routed_model then
    return new;
  end if;
  select r.spec -> 'blocked_countries' into lst from public.model_registry r where r.id = m;
  if lst is null or lst = 'null'::jsonb or lst = '[]'::jsonb then
    return new;
  end if;
  -- A model with a country list: only a country this database can trust (geo_claim_country: signed by our web server for this
  -- person, seconds ago). No claim at all is a member calling create_creative_job straight through PostgREST, the worker moving a
  -- job onto this model (it has no visitor), or a Film Studio take: refused, never let through as "unknown".
  c := public.geo_claim_country();
  if c is null then
    perform public.creative_refuse('country_unverified',
      format('%s is sold only where the country of the request is confirmed by the web app; nothing was held', m));
  end if;
  -- A list of any other shape fails closed.
  if jsonb_typeof(lst) <> 'array' or lst ? c then
    perform public.creative_refuse('country_blocked', format('%s is not available in this region; nothing was held', m));
  end if;
  return new;
end
$$;

revoke all on function public.creative_jobs_geo_gate() from public, anon, authenticated, service_role;

do $$
begin
  if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_jobs_geo_gate()'::regprocedure) is distinct from '71468a6f60d2659cd44199a3c834dc69' then
    raise exception 'rollback 0230 end state: creative_jobs_geo_gate() is not 0208''s body';
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.creative_jobs'::regclass and t.tgname = 'creative_jobs_geo_gate'
                    and t.tgfoid = 'public.creative_jobs_geo_gate()'::regprocedure and t.tgenabled = 'O') then
    raise exception 'rollback 0230 end state: creative_jobs has no enabled creative_jobs_geo_gate trigger';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.creative_jobs_geo_gate()'::regprocedure)
     or has_function_privilege('anon', 'public.creative_jobs_geo_gate()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.creative_jobs_geo_gate()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.creative_jobs_geo_gate()', 'EXECUTE') then
    raise exception 'rollback 0230 end state: creative_jobs_geo_gate() is not a definer closed to every API role';
  end if;
end $$;

commit;
