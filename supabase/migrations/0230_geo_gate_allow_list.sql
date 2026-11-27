-- 0230_geo_gate_allow_list.sql — an allow-list vendor's models are gated by its allow-list: a signed country code that is on neither
-- of Google's lists is unknown, and unknown is refused (BR-S6-03-DB, docs/security/LEDGER.md).
--
-- *** LIVE ON APPLY. *** It changes NO answer for any model on sale today: the gate acts only on a model with blocked_countries, and
--   0142's CHECK keeps every such model off sale (beta/ga). What changes is the answer the day one opens.
--
-- EVIDENCE. Google's terms are an ALLOW-list ("You may only access the Services ... within an available region", Gemini API Additional
--   Terms, effective March 23, 2026; 0208's header). The registry writes that list as its complement in ISO 3166-1, blocked_countries =
--   every ISO code Google does not list, and 0208's creative_jobs_geo_gate refuses a country only when `lst ? c`. A claim code that is
--   on neither list passes: EU and AP (DB-IP placeholders written into the country table), ZZ, any two capital letters that name no
--   country. geo_claim_country() checks the claim's shape ([A-Z]{2}) and signature, not that the code is a country, and until PR #951
--   our own web server signed whatever the country table said. Reproduced in the lab against 0208's body
--   (tests/security/test_sec_geo_allowlist_0230.py, test_br_s6_03_db_a_code_on_neither_list_is_refused: EU on
--   gemini-3.1-flash-image was a job, DID NOT RAISE); test_after_the_rollback_the_finding_is_back keeps that repro.
-- DIAGNOSIS. A deny-list answers "is it known to be forbidden?"; an allow-list vendor needs "is it known to be permitted?". The two agree
--   only on codes that are on one of the two lists. The web fixed its half on PR #951 (an unknown code reads as not_in_table, and an
--   allow-list model is "blocked" unless the code is on GOOGLE_AVAILABLE_REGIONS); the trigger is the database's half.
-- CHANGE. One function, 0208's creative_jobs_geo_gate, one marked hunk after 0208's two refusals (both unchanged, in the same order, so
--   RU is still country_blocked and no claim is still country_unverified):
--     an allow-list model is a row whose spec carries available_countries (the registry's copy of the vendor's own list, synced from
--     schemas/model_registry.json like blocked_countries), or any provider = 'google' row with a country list (Google is an allow-list
--     vendor whatever its row says: a row synced from a ref without 0230 has only the complement, and it must not fall back to it);
--     for it, a claim code that is not on available_countries, or a list that is missing or not an array, is NS400 country_unverified,
--     the same word the chat gate (chatGateDecision) uses for "we could not confirm where you are". Nothing is held (the refusal is in
--     the creating transaction, as 0208's).
--   Not changed: geo_claim_country (0208's body), the trigger itself (BEFORE INSERT OR UPDATE OF routed_model), the grants (no API
--   role), a model with a deny-list only (grounded-image-1.0: a code off its list still passes, as its vendor names where it may NOT
--   be used), a model with no list (not asked), and no model id is written here: the registry says which list a model has.
-- REPLACES (md5 drift guard, white space folded with [[:space:]]+, which folds exactly as 0208's own guard does):
--   creative_jobs_geo_gate() 0208's 71468a6f60d2659cd44199a3c834dc69 -> 0230's 3f2e4d767f9d53de505aacb29e7141f9.
--   No migration after 0208 replaces it (0218 only checks it exists).
-- BEFORE IT IS USEFUL: the registry sync from a ref that contains 0230 (python tools/probe_models.py --sync), which writes
--   available_countries into each Google row's spec. Until then every job on a Google model is refused country_unverified (fails
--   closed; none is on sale), and this file says so in a NOTICE.
-- NUMBER. 0230, assigned by the S6 lead. Needs 0208 (the gate and geo_claim_country) and 0036 (creative_refuse). Independent of 0218,
--   0219, 0224, 0227, 0228.
-- Rollback: docs/sql/rollback_0230_geo_gate_allow_list.sql (owner-applied; puts 0208's body back and asserts it).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
-- No backslash anywhere in this file: the live apply path once rewrote backslash escapes inside SQL text (0219's header).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.creative_jobs_geo_gate()') is null or to_regprocedure('public.geo_claim_country()') is null
     or to_regprocedure('public.creative_refuse(text, text, text)') is null then
    raise exception '0230 needs 0208 (creative_jobs_geo_gate, geo_claim_country) and 0036 (creative_refuse): apply them first';
  end if;
  select md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.creative_jobs_geo_gate()'::regprocedure;
  if h is null or h <> all (array['71468a6f60d2659cd44199a3c834dc69', '3f2e4d767f9d53de505aacb29e7141f9']) then
    raise exception '0230 found a creative_jobs_geo_gate() that is neither 0208''s body nor 0230''s (md5 %): read the live body first', h;
  end if;
end $$;

-- A Google row with a country list and no allow-list is refused every job after this file (it fails closed). Said, with the remedy.
do $$
declare
  n bigint;
begin
  select count(*) into n from public.model_registry r
   where r.provider = 'google'
     and coalesce(r.spec -> 'blocked_countries', 'null'::jsonb) not in ('null'::jsonb, '[]'::jsonb)
     and jsonb_typeof(r.spec -> 'available_countries') is distinct from 'array';
  if n > 0 then
    raise notice '0230: % google row(s) in model_registry carry blocked_countries but no available_countries: every job on them is refused country_unverified until the registry is synced from a ref that contains 0230 (python tools/probe_models.py --sync)', n;
  end if;
end $$;

-- 0208's country gate, with the allow-list read after its two refusals (0230).
create or replace function public.creative_jobs_geo_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m   text := coalesce(new.routed_model, new.requested_model);
  lst jsonb;
  c   text;
  -- 0230
  al   jsonb;
  prov text;
begin
  -- A row that does not change its model is not asked again (a status, a heartbeat, a result).
  if tg_op = 'UPDATE' and new.routed_model is not distinct from old.routed_model then
    return new;
  end if;
  select r.spec -> 'blocked_countries', r.spec -> 'available_countries', r.provider into lst, al, prov
    from public.model_registry r where r.id = m;
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
  -- 0230 (BR-S6-03): an allow-list vendor's model runs only in a country on the vendor's own list. A code on neither list (EU, ZZ,
  -- a typo in the country table) is not "not forbidden", it is unknown, and unknown is refused. A Google row with no allow-list
  -- (synced before 0230), or one of another shape, fails closed the same way, never back to the complement.
  if al is not null or prov = 'google' then
    if al is null or jsonb_typeof(al) <> 'array' or not (al ? c) then
      perform public.creative_refuse('country_unverified',
        format('%s is sold only in the regions its vendor lists, and the country of the request is not one of them; nothing was held', m));
    end if;
  end if;
  return new;
end
$$;

revoke all on function public.creative_jobs_geo_gate() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_jobs_geo_gate()'::regprocedure) is distinct from '3f2e4d767f9d53de505aacb29e7141f9' then
    raise exception '0230 end state: creative_jobs_geo_gate() is not 0230''s body';
  end if;
  if (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.geo_claim_country()'::regprocedure) is distinct from 'add85b6752c03be6882a59a0ff8017ba' then
    raise exception '0230 end state: geo_claim_country() is not 0208''s body (this file does not change it; read it first)';
  end if;
  if not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                  where t.tgrelid = 'public.creative_jobs'::regclass and t.tgname = 'creative_jobs_geo_gate'
                    and p.oid = 'public.creative_jobs_geo_gate()'::regprocedure and not t.tgisinternal and t.tgenabled = 'O') then
    raise exception '0230 end state: creative_jobs has no enabled creative_jobs_geo_gate trigger on this function';
  end if;
  if not (select prosecdef and proconfig = array['search_path=public, pg_temp'] from pg_proc
           where oid = 'public.creative_jobs_geo_gate()'::regprocedure) then
    raise exception '0230 end state: creative_jobs_geo_gate() is not SECURITY DEFINER with a pinned search_path';
  end if;
  for r in select * from unnest(array['anon', 'authenticated', 'service_role']) role_ loop
    if has_function_privilege(r.role_, 'public.creative_jobs_geo_gate()', 'EXECUTE') then
      raise exception '0230 end state: % may call creative_jobs_geo_gate()', r.role_;
    end if;
  end loop;
end $$;

-- Verify (the SQL editor, after applying; every column should read true, the last one after the registry sync):
--   select
--     (select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc
--       where oid = 'public.creative_jobs_geo_gate()'::regprocedure) = '3f2e4d767f9d53de505aacb29e7141f9' as geo_gate_0230,
--     exists (select 1 from pg_trigger where tgrelid = 'public.creative_jobs'::regclass and tgname = 'creative_jobs_geo_gate') as geo_gate_on,
--     not exists (select 1 from public.model_registry where provider = 'google'
--                   and coalesce(spec -> 'blocked_countries', '[]'::jsonb) <> '[]'::jsonb
--                   and jsonb_typeof(spec -> 'available_countries') is distinct from 'array') as google_rows_synced;
