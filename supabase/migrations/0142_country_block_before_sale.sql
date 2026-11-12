-- 0142_country_block_before_sale.sql — a model that the registry blocks in some countries cannot be put on sale (beta or ga).
-- (docs/GEO_BLOCK.md "What it cannot do"; the security re-review of PR #695, HIGH.)
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It adds one CHECK and changes no row: the only model with a
-- country list (grounded-image-1.0) is hidden, so nothing on sale changes, and the file refuses to apply if a model on sale has one.
--
-- WHY
--   The country check (docs/GEO_BLOCK.md) runs in the Next.js routes: /api/creative/quote and /jobs, the workflow quote and run routes,
--   and the pickers. The database does not know the requester's country. create_creative_job (0075), start_workflow_run (0073) and
--   advance_workflow_run (0074) are granted to `authenticated`, and the browser holds the anon key, the project URL and the session, so
--   a signed-in user can call them straight through PostgREST and skip the routes. For a model on sale that would mean a blocked country
--   could still generate with it.
--   Until the database itself refuses by country (a server-attested country passed into these functions, or these functions revoked
--   from `authenticated` behind a server-only wrapper: a follow-up), a model with a country list must stay off sale. Today the only
--   such model (grounded-image-1.0) is hidden and terms-gated, so nobody is exposed; this file makes sure it stays that way.
--
-- WHAT IT ADDS (one CHECK, nothing else)
--   model_registry_countries_before_sale on public.model_registry:
--     availability not in ('beta', 'ga') or spec.blocked_countries is absent, JSON null or an empty array.
--   A CHECK, like 0035's verified_before_sale and terms_before_sale, so no path can skip it: the platform admin's availability update
--   (0035's column grant), the service role, the SQL editor and any later function. A sync (tools/probe_models.py --sync) that gives an
--   on-sale model a country list is refused whole (23514), the same as one that gives it a terms_gate; nothing of that sync is written.
--   hidden and disabled are allowed: the operator preview of 0139 (hidden only) keeps working.
--   The file side holds the same rule (modules/model_registry.py: blocked_countries needs a terms_gate, which 0035 keeps off sale).
--
-- WHAT IT DOES NOT CHANGE
--   No function, policy, grant, trigger or row. It does not make the database refuse by country: it keeps such a model off sale.
--
-- NUMBER. 0142: main ends at 0139. On other branches 0140 is claude/meta-probe-no-tools (#701), 0141 is #699 (made_for_kids) and
-- claude/youtube-one-org (to be renumbered), and 0143 is claude/payments-dodo (checked against every remote branch, 2026-11-12).
-- None of them touches model_registry's constraints, so their order does not matter.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; must return no row, or the file refuses):
--   select id, availability from public.model_registry
--    where availability in ('beta', 'ga') and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb;
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor runs a file as one). Rollback: docs/sql/rollback_0142_country_block_before_sale.sql.
-- REQUIRES 0035 (model_registry). Additive and idempotent: safe to run twice.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.model_registry') is null then
    raise exception '0142 needs 0035_model_registry.sql (model_registry): apply it first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'model_registry' and column_name in ('availability', 'spec')
                 having count(*) = 2) then
    raise exception '0142 needs model_registry.availability and model_registry.spec (0035)';
  end if;
end $$;

-- A model already on sale with a country list would make the ALTER fail with a bare constraint error. Name it instead: the owner takes
-- it off sale (availability = 'hidden') or removes the list from the file and syncs, then applies this file.
do $$
declare
  bad text;
begin
  select string_agg(id || ' (' || availability || ')', ', ' order by id) into bad
    from public.model_registry
   where availability in ('beta', 'ga')
     and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb;
  if bad is not null then
    raise exception '0142: these models are on sale and carry blocked_countries: %. Take them off sale first (docs/GEO_BLOCK.md)', bad;
  end if;
end $$;

alter table public.model_registry drop constraint if exists model_registry_countries_before_sale;
alter table public.model_registry add constraint model_registry_countries_before_sale
  check (availability not in ('beta', 'ga')
         or coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) = '[]'::jsonb);

-- ───────────────────────────────────────────────────────────────────────────
-- The end state: the CHECK exists once, is validated, and says what this file says.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.model_registry'::regclass and c.conname = 'model_registry_countries_before_sale'
     and c.contype = 'c' and c.convalidated;
  if def is null then
    raise exception '0142 end state: model_registry_countries_before_sale is missing or not validated';
  end if;
  if position('blocked_countries' in def) = 0 or position('beta' in def) = 0 or position('ga' in def) = 0 then
    raise exception '0142 end state: model_registry_countries_before_sale does not read availability and blocked_countries (%)', def;
  end if;
  if exists (select 1 from public.model_registry
              where availability in ('beta', 'ga')
                and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb) then
    raise exception '0142 end state: a model on sale carries blocked_countries';
  end if;
end $$;

-- Verify (the SQL editor, after applying; should read true):
--   select count(*) = 1 from pg_constraint
--    where conrelid = 'public.model_registry'::regclass and conname = 'model_registry_countries_before_sale' and convalidated;
