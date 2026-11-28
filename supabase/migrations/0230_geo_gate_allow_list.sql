-- 0230_geo_gate_allow_list.sql — an allow-list vendor's models are gated by its allow-list: a signed country code that is not on
-- the vendor's own list is unknown, and unknown is refused (BR-S6-04, the database half of BR-S6-03; BR-S6-05; docs/security/LEDGER.md).
--
-- *** LIVE ON APPLY. *** It changes NO answer for any model on sale today: every Google model carries blocked_countries, and 0142's
--   CHECK keeps every such model off sale (beta/ga). What changes is the answer the day one opens. (A row with available_countries
--   and no blocked_countries could go on sale through 0142 and was not gated at all; the registry validator refuses that shape, and
--   since 0230 the gate asks it too.)
--
-- EVIDENCE. Google's terms are an ALLOW-list ("You may only access the Services ... within an available region", Gemini API Additional
--   Terms, effective March 23, 2026; 0208's header). The registry writes that list as its complement in ISO 3166-1, blocked_countries =
--   every ISO code Google does not list, and 0208's creative_jobs_geo_gate refuses a country only when `lst ? c`. A claim code that is
--   on neither list passes: EU and AP (DB-IP placeholders written into the country table), ZZ, any two capital letters that name no
--   country. geo_claim_country() checks the claim's shape ([A-Z]{2}) and signature, not that the code is a country, and until PR #951
--   our own web server signed whatever the country table said. Reproduced in the lab against 0208's body
--   (tests/security/test_sec_geo_allowlist_0230.py, test_br_s6_04_a_code_on_neither_list_is_refused: EU on
--   gemini-3.1-flash-image was a job, DID NOT RAISE); test_after_the_rollback_the_finding_is_back keeps that repro. Breach then found
--   (tests/security/test_sec_geo_allowlist_0230_breach.py, BR-S6-05) that 0208's early return, which reads blocked_countries only,
--   still ran before the allow-list, so a row with available_countries and no (or an empty) blocked_countries took EU, RU and no
--   claim at all; and that a white-space-folded md5 cannot tell a line of code from the same line swallowed by the `--` comment
--   above it.
-- DIAGNOSIS. A deny-list answers "is it known to be forbidden?"; an allow-list vendor needs "is it known to be permitted?". The two agree
--   only on codes that are on one of the two lists. The web fixed its half on PR #951 (an unknown code reads as not_in_table, and an
--   allow-list model is "blocked" unless the code is on GOOGLE_AVAILABLE_REGIONS); the trigger is the database's half.
-- CHANGE. One function, 0208's creative_jobs_geo_gate, with 0230's lines marked in it:
--     the early return (a model that is not asked) now needs no deny-list AND no key available_countries in the row's spec (any
--     value: a JSON null is a list of another shape, and fails closed below);
--     0208's two refusals stay in the same order: no claim is country_unverified, and a code on a non-empty deny-list (or a deny-list
--     that is not an array) is country_blocked, so RU is still country_blocked; the deny-list refusal is asked only of a row that has
--     a deny-list, so a row with an allow-list alone is answered by its allow-list;
--     then the allow-list: for a row whose spec carries available_countries (the registry's copy of the vendor's own list, synced
--     from schemas/model_registry.json like blocked_countries), or any provider = 'google' row with a country list (Google is an
--     allow-list vendor whatever its row says: a row synced from a ref without 0230 has only the complement, and it must not fall
--     back to it), a claim code that is not on available_countries, or a list that is missing or not an array, is NS400
--     country_unverified, the same word the chat gate (chatGateDecision) uses for "we could not confirm where you are". Nothing is
--     held (the refusal is in the creating transaction, as 0208's).
--   Not changed: geo_claim_country (0208's body), the trigger itself (BEFORE INSERT OR UPDATE OF routed_model), the grants (no API
--   role), a non-Google model with a deny-list only (grounded-image-1.0: a code off its list still passes, as its vendor names where
--   it may NOT be used), a model with no list at all (not asked), and no model id is written here: the registry says which list a
--   model has.
-- REPLACES (drift guard: md5 of prosrc with every `--` comment cut to the end of its line, chr(10) or chr(13), and then every run of
--   white space folded to one space. Folding alone, as 0208's and 0218's guards do, reads a line of code and the same line swallowed
--   by the comment above it (its newline turned into a space) as one body; cutting comments first makes them differ. Neither body
--   holds `--` inside a string literal, where the cut would also apply; the pattern is written [-][-] so that no literal in this
--   file holds one either, for an apply path that strips comments without reading quotes):
--   creative_jobs_geo_gate() 0208's 1715dc38085e3a98cc21ceba95f85d5f -> 0230's 6a7b6f2b075c4775ee83808932f88bd0;
--   geo_claim_country() is checked to be 0208's body, 6cb8abcd7ab3dff8fb2a4ce33afa58d6, and is not changed.
--   (Folded only, as 0208 pins them: gate 71468a6f60d2659cd44199a3c834dc69 -> 6d28388da6b6b927b0da500524fe0325, claim reader
--   add85b6752c03be6882a59a0ff8017ba.) No migration after 0208 replaces the gate (0218 only checks it exists).
-- REGISTRY SYNC (python tools/probe_models.py --sync, which spends nothing) writes available_countries into each Google row's spec.
--   It may run before or after this file: 0208's body never reads the key, so syncing first changes nothing and avoids a window in
--   which every job on a Google model is refused country_unverified (that window fails closed, and none is on sale). This file says
--   so in a NOTICE when a Google row is not yet synced.
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
  select md5(regexp_replace(regexp_replace(p.prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) into h from pg_proc p
   where p.oid = 'public.creative_jobs_geo_gate()'::regprocedure;
  if h is null or h <> all (array['1715dc38085e3a98cc21ceba95f85d5f', '6a7b6f2b075c4775ee83808932f88bd0']) then
    raise exception '0230 found a creative_jobs_geo_gate() that is neither 0208''s body nor 0230''s (md5 %): read the live body first', h;
  end if;
end $$;

-- A Google row with a country list and no allow-list is refused every job after this file (it fails closed). Said, with the remedy.
-- The command is a parameter, not part of the literal: no literal in this file holds two dashes in a row.
-- A disabled row (removed from the registry file) is left out: the sync never rewrites it, and nothing can be sold on it.
do $$
declare
  n bigint;
begin
  select count(*) into n from public.model_registry r
   where r.provider = 'google' and r.availability is distinct from 'disabled'
     and coalesce(r.spec -> 'blocked_countries', 'null'::jsonb) not in ('null'::jsonb, '[]'::jsonb)
     and jsonb_typeof(r.spec -> 'available_countries') is distinct from 'array';
  if n > 0 then
    raise notice '0230: % google row(s) in model_registry carry blocked_countries but no available_countries: every job on them is refused country_unverified until the registry is synced from a ref that contains 0230 (%)', n,
      'python tools/probe_models.py ' || repeat('-', 2) || 'sync';
  end if;
end $$;

-- 0208's country gate, with an allow-list read (0230's lines are marked).
create or replace function public.creative_jobs_geo_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m   text := coalesce(new.routed_model, new.requested_model);
  lst jsonb;
  c   text;
  -- 0230
  al   jsonb;
  prov text;
  deny boolean;
begin
  -- A row that does not change its model is not asked again (a status, a heartbeat, a result).
  if tg_op = 'UPDATE' and new.routed_model is not distinct from old.routed_model then
    return new;
  end if;
  select r.spec -> 'blocked_countries', r.spec -> 'available_countries', r.provider into lst, al, prov
    from public.model_registry r where r.id = m;
  -- 0230: a row with the key available_countries (any value, JSON null included) is asked even with no deny-list. Returning on
  -- the deny-list alone let a row carrying only an allow-list take any claim and no claim at all (BR-S6-05).
  deny := not (lst is null or lst = 'null'::jsonb or lst = '[]'::jsonb);
  if not deny and al is null then
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
  if deny and (jsonb_typeof(lst) <> 'array' or lst ? c) then
    perform public.creative_refuse('country_blocked', format('%s is not available in this region; nothing was held', m));
  end if;
  -- 0230 (BR-S6-04): a row with available_countries, or a Google row with any country list, runs only in a country on that
  -- allow-list. A code on neither list (EU, ZZ, a typo in the country table) is not "not forbidden", it is unknown, and unknown is
  -- refused. A Google row with a deny-list and no allow-list (synced before 0230), or an allow-list of another shape, fails closed
  -- the same way, never back to the complement.
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
  if (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.creative_jobs_geo_gate()'::regprocedure) is distinct from '6a7b6f2b075c4775ee83808932f88bd0' then
    raise exception '0230 end state: creative_jobs_geo_gate() is not 0230''s body';
  end if;
  if (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g')) from pg_proc
       where oid = 'public.geo_claim_country()'::regprocedure) is distinct from '6cb8abcd7ab3dff8fb2a4ce33afa58d6' then
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

-- Verify (the SQL editor, after applying; every column should read true, the last one once the registry sync has run, before or
-- after this file):
--   select
--     (select md5(regexp_replace(regexp_replace(prosrc, '[-][-][^' || chr(10) || chr(13) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'))
--        from pg_proc where oid = 'public.creative_jobs_geo_gate()'::regprocedure) = '6a7b6f2b075c4775ee83808932f88bd0' as geo_gate_0230,
--     exists (select 1 from pg_trigger where tgrelid = 'public.creative_jobs'::regclass and tgname = 'creative_jobs_geo_gate') as geo_gate_on,
--     not exists (select 1 from public.model_registry where provider = 'google' and availability is distinct from 'disabled'
--                   and coalesce(spec -> 'blocked_countries', '[]'::jsonb) <> '[]'::jsonb
--                   and jsonb_typeof(spec -> 'available_countries') is distinct from 'array') as google_rows_synced;
