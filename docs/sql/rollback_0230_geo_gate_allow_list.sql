-- rollback_0230_geo_gate_allow_list.sql — takes migration 0230 (the allow-list read in the country gate) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor, as one transaction. Nothing in the app runs it. Idempotent.
--
-- WHAT COMES BACK: 0208's creative_jobs_geo_gate, verbatim (md5 1715dc38085e3a98cc21ceba95f85d5f with comments cut and white space
--   folded, 0230's fingerprint; 71468a6f60d2659cd44199a3c834dc69 folded only, as 0208 pins it). A claim code on neither of Google's
--   lists (EU, ZZ) is then a job on a Google model again (BR-S6-04 is open again), and so is any claim on a row with an allow-list
--   and no deny-list (BR-S6-05); every model with a deny-list stays off sale through 0142's CHECK, which neither file touches.
-- WHAT IS KEPT: the trigger (it names the function, which is replaced in place), geo_claim_country, the grants (none for an API role),
--   and available_countries in the registry rows (data the registry sync owns; 0208's body never reads it).
-- WHAT IT DOES: 0. REFUSES (changes nothing) if the gate is neither 0230's body nor 0208's (a later file changed it: take that out
--   first). 1. Puts 0208's body back. 2. Asserts the end state.
-- No backslash anywhere in this file (0219's header): comments are cut with chr(10) / chr(13), white space folded with [[:space:]]+.
-- The fingerprint is 0230's (a comment that swallowed the line under it changes it; folding alone does not, BR-S6-05).

begin;
set local lock_timeout = '5s';

-- Since 0238 a model with a country list may be on sale when its row carries an allow-list, because this gate checks the country.
-- Taking the gate away under such a model would sell it unchecked: while 0238's CHECK is the live one (the only definition of
-- model_registry_countries_before_sale that reads available_countries), refused, with the names, until it is off sale and 0238 is
-- out. (With 0142's CHECK no such row can be on sale; with no CHECK at all, someone took 0142 out by hand, as the lab does.)
do $$
declare
  bad text;
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.model_registry'::regclass and conname = 'model_registry_countries_before_sale'
                    and position('available_countries' in pg_get_constraintdef(oid)) > 0) then
    return;
  end if;
  select string_agg(id || ' (' || availability || ')', ', ' order by id) into bad
    from public.model_registry
   where availability in ('beta', 'ga')
     and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb;
  if bad is not null then
    raise exception 'rollback 0230: these models are on sale with a country list, which only the country gate keeps honest: %. Take them off sale and apply rollback_0238_country_list_sale_needs_allow_list.sql first', bad;
  end if;
end $$;

do $$
declare
  h text;
begin
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.creative_jobs_geo_gate()');
  if h is null or h <> all (array['6a7b6f2b075c4775ee83808932f88bd0', '1715dc38085e3a98cc21ceba95f85d5f']) then
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
  if (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_jobs_geo_gate()'::regprocedure) is distinct from '1715dc38085e3a98cc21ceba95f85d5f' then
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
