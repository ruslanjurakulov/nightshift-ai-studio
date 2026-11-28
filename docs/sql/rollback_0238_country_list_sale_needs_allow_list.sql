-- rollback_0238_country_list_sale_needs_allow_list.sql — takes migration 0238 out again: 0142's CHECK comes back, so no model with a
-- country list can be on sale (beta or ga), with or without an allow-list. OWNER-APPLY: paste into the Supabase SQL editor, as one
-- transaction. Nothing in the app runs it. Idempotent.
--
-- WHEN. Before rolling back 0230 or 0208 (the database country gate), and before any migration that replaces creative_jobs_geo_gate
--   without the allow-list read: 0238's CHECK reads the row, not the gate, so it cannot notice the gate going away. rollback_0230 and
--   rollback_0208 refuse while a country-listed row is on sale, for the same reason.
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) while any model with a non-empty blocked_countries is beta or ga, and names them: 0142's CHECK
--      would refuse them anyway, with a bare 23514. Take them off sale first (availability = 'hidden', the owner's act).
--   1. Drops model_registry_countries_before_sale and adds 0142's definition, verbatim.
--   2. Asserts the end state: the CHECK is there once, validated, reads blocked_countries and no longer reads available_countries.
-- WHAT IT KEEPS: every row (no availability is changed here), the gate, the registry's available_countries (data the sync owns).
-- No backslash anywhere in this file (0219's header).

begin;
set local lock_timeout = '5s';

do $$
declare
  bad text;
begin
  if to_regclass('public.model_registry') is null then
    raise exception 'rollback 0238 needs model_registry (0035)';
  end if;
  select string_agg(id || ' (' || availability || ')', ', ' order by id) into bad
    from public.model_registry
   where availability in ('beta', 'ga')
     and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb;
  if bad is not null then
    raise exception 'rollback 0238: these models are on sale and carry blocked_countries: %. Take them off sale (availability hidden) first; 0142''s CHECK keeps every such model off sale', bad;
  end if;
end $$;

-- 0142's CHECK, verbatim.
alter table public.model_registry drop constraint if exists model_registry_countries_before_sale;
alter table public.model_registry add constraint model_registry_countries_before_sale
  check (availability not in ('beta', 'ga')
         or coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) = '[]'::jsonb);

do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.model_registry'::regclass and c.conname = 'model_registry_countries_before_sale'
     and c.contype = 'c' and c.convalidated;
  if def is null then
    raise exception 'rollback 0238 end state: model_registry_countries_before_sale is missing or not validated';
  end if;
  if position('blocked_countries' in def) = 0 or position('available_countries' in def) > 0 then
    raise exception 'rollback 0238 end state: model_registry_countries_before_sale is not 0142''s (%)', def;
  end if;
end $$;

commit;

-- Verify (should read true):
--   select position('available_countries' in pg_get_constraintdef(oid)) = 0 and convalidated from pg_constraint
--    where conrelid = 'public.model_registry'::regclass and conname = 'model_registry_countries_before_sale';
