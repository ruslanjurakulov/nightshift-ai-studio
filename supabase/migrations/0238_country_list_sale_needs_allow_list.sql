-- 0238_country_list_sale_needs_allow_list.sql — a model with a country list may go on sale (beta or ga) once the database checks the
-- country itself, and only when its registry row also carries its vendor's own allow-list (available_countries).
-- (Stream S10; the owner's decision on Google's image terms, 2026-11-28; docs/GEO_BLOCK.md; BR-S6-04 / BR-S6-05.)
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It replaces ONE CHECK (0142's
--   model_registry_countries_before_sale) with a narrower refusal and changes NO row: every model is exactly as available as before.
--   No model goes on sale here. Opening one (availability beta or ga, and a credit_prices row) stays the owner's act; what changes is
--   that the database no longer refuses it for a model whose row carries both lists. A row with blocked_countries and no
--   available_countries (grounded-image-1.0 today) is still refused beta and ga, as 0142 refuses it.
--
-- EVIDENCE.
--   0142 (2026-11-12) kept every row with a non-empty spec.blocked_countries off sale because the country was checked in the web
--   routes only and a signed-in user could call create_creative_job, start_workflow_run and advance_workflow_run through PostgREST.
--   Since then:
--   * 0208's creative_jobs_geo_gate is a BEFORE INSERT OR UPDATE OF routed_model trigger on creative_jobs, the one table every create
--     writes (the Studio, a workflow step, the API and MCP, a Film Studio take, the worker's failover). For a row with a country list
--     it asks geo_claim_country(): an HMAC claim our web server signs for this user, seconds ago, with a key in Vault. No claim is
--     country_unverified, a code on the deny-list is country_blocked, inside the creating transaction (the hold rolls back with it).
--   * 0230 made the same gate read the vendor's allow-list: a row whose spec carries available_countries (or any Google row with a
--     country list) refuses a claim code that is not on it, so a code on neither list (EU, AP, ZZ) is refused (BR-S6-04), and the early
--     return no longer skips a row with an allow-list (BR-S6-05).
--   * The owner cleared Google's 18+ and consumer-use clauses for gemini-3-pro-image and gemini-nano-banana-2.1 (2026-11-28; the
--     registry's terms_notes and docs/MIGRATIONS.md). Both rows carry blocked_countries (the complement of Google's list) and
--     available_countries (Google's list). With their terms_gate cleared, 0142's CHECK is the only thing that would keep them off sale
--     for a reason that no longer holds.
-- DIAGNOSIS. 0142's reason ("the database does not know the country") is answered by 0208 and 0230 for a row with an allow-list. It is
--   NOT answered for a row with a deny-list only: 0230 asks a non-Google deny-list-only row only "is the code on the deny-list?", so
--   a code on neither list passes. Such a row must stay off sale.
-- CHANGE (one CHECK, nothing else):
--   model_registry_countries_before_sale is dropped and added again as:
--     availability not in ('beta', 'ga')
--     or spec.blocked_countries is absent, JSON null or an empty array             (0142's rule, unchanged)
--     or spec.available_countries is a non-empty JSON array                         (0238)
--   The allow-list test is wrapped in coalesce(..., false): without it a row with no available_countries makes the test NULL, and a
--   CHECK passes on NULL, so a deny-list-only row would go on sale (the lab caught exactly that: test_a_deny_list_only_row_still_cannot).
--   The same name, so every reader that names it (the lab, docs/GEO_BLOCK.md, the 23514 a sync reads) keeps working. A CHECK, like
--   0142's, so no path skips it: the platform admin's availability update (0035's column grant), the service role, the SQL editor and
--   a sync (tools/probe_models.py --sync) that drops a model's allow-list while it is on sale (refused whole, 23514).
--   Apply-time guard: the file REFUSES unless the gate it relies on is live: creative_jobs_geo_gate() is 0230's body (md5
--   6a7b6f2b075c4775ee83808932f88bd0 of prosrc with every comment cut to the end of its line, chr(10) or chr(13), then every run of
--   white space folded to one space: 0230's fingerprint, which a comment that swallowed the line under it changes; and
--   6d28388da6b6b927b0da500524fe0325 folded only, as the lab reads it), geo_claim_country() is 0208's body (6cb8abcd7ab3dff8fb2a4ce33afa58d6
--   by the same fingerprint), the gate is SECURITY DEFINER with search_path pinned, and the trigger creative_jobs_geo_gate is attached
--   to public.creative_jobs on that function, enabled, BEFORE, FOR EACH ROW, on INSERT and UPDATE.
-- WHAT ELSE REFUSES A COUNTRY-LISTED ROW (read for this file; none is changed):
--   * 0142 itself has no function or trigger besides the CHECK: its end-state block reads pg_get_constraintdef and asks position() of
--     'blocked_countries', 'beta' and 'ga' in it, which 0238's definition still contains. A replay of 0142 puts 0142's definition
--     back over this one (drop, then add); apply 0238 again after it.
--   * 0173, 0194 and 0195 (the "open" migrations) refuse to open a row with blocked_countries, but only while they apply: they name
--     fixed lists of models, none of which is a Google image model, and do not run again.
--   * 0191's oauth creative check and 0219's operator route answer not_offered for any row whose spec has the key blocked_countries:
--     a connected assistant's request has no visitor address. Unchanged and wanted (both Google rows are web_only).
--   * sellable_models (0192's body) has no country clause: the country is the gate's, per job.
--   * 0035's terms_before_sale still refuses beta and ga while spec.terms_gate is set.
-- IF THE GATE GOES AWAY LATER. This CHECK reads the row, not the gate: Postgres cannot make a CHECK depend on a function body. So the
--   order is part of this file: take every country-listed row off sale and apply docs/sql/rollback_0238_country_list_sale_needs_allow_list.sql
--   BEFORE rolling back 0230 or 0208. rollback_0238 refuses while such a row is on sale, and since this file rollback_0230 and
--   rollback_0208 refuse too while 0238's CHECK is the live one (they name the rows). A later migration that replaces creative_jobs_geo_gate must keep the allow-list
--   read, or take such rows off sale first, and say so in its own header.
-- NUMBER. 0238, assigned by Atlas for S10 (0233 to 0237 are taken by other pull requests; none touches model_registry's constraints).
--   Needs 0142 in spirit (it narrows 0142's CHECK; on a database without it, this file adds the CHECK), 0208 and 0230 (refuses
--   without them), 0035 (model_registry).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor). Expected: one row, all true.
--   select (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))
--             from pg_proc where oid = 'public.creative_jobs_geo_gate()'::regprocedure) = '6a7b6f2b075c4775ee83808932f88bd0' as geo_gate_0230,
--          exists (select 1 from pg_trigger where tgrelid = 'public.creative_jobs'::regclass and tgname = 'creative_jobs_geo_gate'
--                    and tgenabled = 'O') as geo_gate_on;
--
-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- No backslash anywhere in this file (0219's header: the live apply path once rewrote backslash escapes inside SQL text), and no two
-- dashes in a row inside a literal (the comment cut is written [-][-], as 0230 writes it).
-- Idempotent: a replay drops and adds the same CHECK. Rollback: docs/sql/rollback_0238_country_list_sale_needs_allow_list.sql
-- (owner-applied; refuses while a country-listed row is on sale; puts 0142's CHECK back verbatim).

set local lock_timeout = '5s';

do $$
declare
  fp   text;
  fold text;
  cl   text;
begin
  if to_regclass('public.model_registry') is null or to_regclass('public.creative_jobs') is null then
    raise exception '0238 needs 0035 (model_registry) and 0036 (creative_jobs): apply them first';
  end if;
  if to_regprocedure('public.creative_jobs_geo_gate()') is null or to_regprocedure('public.geo_claim_country()') is null then
    raise exception '0238 needs the database country gate (0208 and 0230: creative_jobs_geo_gate, geo_claim_country): apply them first';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')),
         md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g'))
    into fp, fold from pg_proc p
   where p.oid = 'public.creative_jobs_geo_gate()'::regprocedure;
  if fp is distinct from '6a7b6f2b075c4775ee83808932f88bd0' or fold is distinct from '6d28388da6b6b927b0da500524fe0325' then
    raise exception '0238 found a creative_jobs_geo_gate() that is not 0230''s body (md5 %, folded %): a country-listed model may go on sale only behind 0230''s allow-list read. Apply 0230, or read the live body first', fp, fold;
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))
    into cl from pg_proc p
   where p.oid = 'public.geo_claim_country()'::regprocedure;
  if cl is distinct from '6cb8abcd7ab3dff8fb2a4ce33afa58d6' then
    raise exception '0238 found a geo_claim_country() that is not 0208''s body (md5 %): the gate is only as good as the claim it reads. Read the live body first', cl;
  end if;
  if not (select prosecdef and proconfig = array['search_path=public, pg_temp'] from pg_proc
           where oid = 'public.creative_jobs_geo_gate()'::regprocedure) then
    raise exception '0238: creative_jobs_geo_gate() is not SECURITY DEFINER with a pinned search_path (0230''s end state)';
  end if;
  -- tgtype bits (pg_trigger.h): 1 row, 2 before, 4 insert, 16 update. 'O' is enabled in origin and local sessions, the default.
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.creative_jobs'::regclass and t.tgname = 'creative_jobs_geo_gate'
                    and t.tgfoid = 'public.creative_jobs_geo_gate()'::regprocedure and not t.tgisinternal and t.tgenabled = 'O'
                    and (t.tgtype::int & 1) = 1 and (t.tgtype::int & 2) = 2 and (t.tgtype::int & 4) = 4 and (t.tgtype::int & 16) = 16) then
    raise exception '0238: creative_jobs has no enabled BEFORE INSERT OR UPDATE row trigger creative_jobs_geo_gate on 0230''s function: the database does not check the country, so nothing country-listed may go on sale';
  end if;
end $$;

-- The new rule is wider than 0142's for a row with an allow-list and the same for every other row, so a row 0142 accepted is accepted
-- here. On a database without 0142 (its rollback applied), a row on sale might not be: name it instead of a bare 23514.
do $$
declare
  bad text;
begin
  select string_agg(id || ' (' || availability || ')', ', ' order by id) into bad
    from public.model_registry
   where availability in ('beta', 'ga')
     and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb
     and not coalesce(jsonb_typeof(spec -> 'available_countries') = 'array' and spec -> 'available_countries' <> '[]'::jsonb, false);
  if bad is not null then
    raise exception '0238: these models are on sale with blocked_countries and no available_countries: %. Take them off sale first (docs/GEO_BLOCK.md)', bad;
  end if;
end $$;

alter table public.model_registry drop constraint if exists model_registry_countries_before_sale;
alter table public.model_registry add constraint model_registry_countries_before_sale
  check (availability not in ('beta', 'ga')
         or coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) = '[]'::jsonb
         or coalesce(jsonb_typeof(spec -> 'available_countries') = 'array' and spec -> 'available_countries' <> '[]'::jsonb, false));

-- ───────────────────────────────────────────────────────────────────────────
-- The end state: the CHECK exists once, is validated, reads both lists; the gate it relies on is still 0230's.
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
    raise exception '0238 end state: model_registry_countries_before_sale is missing or not validated';
  end if;
  if position('blocked_countries' in def) = 0 or position('available_countries' in def) = 0
     or position('beta' in def) = 0 or position('ga' in def) = 0 then
    raise exception '0238 end state: model_registry_countries_before_sale does not read availability and both country lists (%)', def;
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.model_registry'::regclass
         and conname = 'model_registry_countries_before_sale') <> 1 then
    raise exception '0238 end state: model_registry_countries_before_sale is not there exactly once';
  end if;
  if (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_jobs_geo_gate()'::regprocedure) is distinct from '6a7b6f2b075c4775ee83808932f88bd0' then
    raise exception '0238 end state: creative_jobs_geo_gate() is not 0230''s body';
  end if;
  if exists (select 1 from public.model_registry
              where availability in ('beta', 'ga')
                and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb
                and not coalesce(jsonb_typeof(spec -> 'available_countries') = 'array' and spec -> 'available_countries' <> '[]'::jsonb, false)) then
    raise exception '0238 end state: a model on sale carries blocked_countries without available_countries';
  end if;
end $$;

-- Verify (the SQL editor, after applying; every column should read true):
--   select
--     (select position('available_countries' in pg_get_constraintdef(oid)) > 0 and convalidated from pg_constraint
--       where conrelid = 'public.model_registry'::regclass and conname = 'model_registry_countries_before_sale') as check_0238,
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))
--        from pg_proc where oid = 'public.creative_jobs_geo_gate()'::regprocedure) = '6a7b6f2b075c4775ee83808932f88bd0' as geo_gate_0230,
--     not exists (select 1 from public.model_registry where availability in ('beta', 'ga')
--                   and coalesce(nullif(spec -> 'blocked_countries', 'null'::jsonb), '[]'::jsonb) <> '[]'::jsonb
--                   and not coalesce(jsonb_typeof(spec -> 'available_countries') = 'array' and spec -> 'available_countries' <> '[]'::jsonb, false))
--       as nothing_deny_only_on_sale;
