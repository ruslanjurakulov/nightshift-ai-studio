-- rollback_0166_films_core.sql — takes migration 0166 (Film Studio P1) out again. OWNER-APPLY: paste into the Supabase SQL editor.
-- Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If the Film Studio tables must go before any later Film Studio migration (0167+) is applied. With a later one
-- applied, take that one out first with its own rollback: this file refuses while any of their objects exist.
--
-- READ THIS FIRST. What IS lost: every film draft, its storyboard, its references, its takes and its audit trail (the five tables are
-- dropped). Nothing else depends on them: in 0166 no other table, function, policy or worker reads them, and nothing in them was ever
-- generated, billed or published. So the file REFUSES while any film exists, unless you un-comment the override line under `begin;`
-- (nightshift.rollback_0166_discard_films), in this same paste, on purpose.
--
-- WHAT IT DOES, in one transaction, holding an ACCESS EXCLUSIVE lock on the five tables from before the check to the end (no film can
-- be created or saved between the check and the drop):
--   0. REFUSES (changes nothing) if a browser function of 0166 is not 0166's body (a later change would be undone), if a later Film
--      Studio migration's table exists, or if any film exists and the override is not set.
--   1. Drops the functions (browser calls, then helpers).
--   2. Drops the five tables (their policies, indexes, constraints and the append-only triggers go with them), then the trigger
--      function and the two text helpers the tables' checks used.
--   3. Asserts the end state: nothing of 0166 left.
--
-- tests/security/test_sec_films_core.py applies this file to the lab database inside a transaction and re-applies 0166 after it.

begin;
set local lock_timeout = '5s';
-- set local nightshift.rollback_0166_discard_films = 'on';
lock table public.films, public.film_scenes, public.film_refs, public.film_takes, public.film_events in access exclusive mode;

do $$
declare
  r record;
  h text;
begin
  for r in select * from (values
      ('public.create_film_draft(uuid, text, text, text, jsonb, text)', '70de05015b8680fb82a9f2ca1763b11b'),
      ('public.save_film(uuid, integer, jsonb)', 'f13523910eb7c9084052ba5fdcc899a6'),
      ('public.archive_film(uuid)', '9ca4e793fd81bbd4a0aecdebd59d6dc6'),
      ('public.film_json(uuid)', '8056afd0fba0f3431c9f5c9105869bc5')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is distinct from r.want then
      raise exception 'rollback 0166: % is missing or is not 0166''s body (md5 %): a later change would be undone; read the live body first', r.sig, h;
    end if;
  end loop;
  if to_regclass('public.film_segments') is not null or to_regclass('public.film_cuts') is not null then
    raise exception 'rollback 0166: a later Film Studio migration is applied (film_segments or film_cuts exists): take it out first with its own rollback';
  end if;
  if exists (select 1 from public.films)
     and coalesce(current_setting('nightshift.rollback_0166_discard_films', true), '') <> 'on' then
    raise exception 'rollback 0166: % films exist and would be deleted; export what must be kept, then set the override line of this file on purpose',
      (select count(*) from public.films);
  end if;
end $$;

-- 1. The functions.
drop function public.create_film_draft(uuid, text, text, text, jsonb, text);
drop function public.save_film(uuid, integer, jsonb);
drop function public.archive_film(uuid);
drop function public.film_json(uuid);
drop function public.film_read(uuid);
drop function public.film_take_json(public.film_takes);
drop function public.film_ref_json(public.film_refs);
drop function public.film_check_storyboard(public.films);
drop function public.film_save_scenes(public.films, jsonb);
drop function public.film_save_refs(public.films, uuid, jsonb, integer, text);
drop function public.film_apply_settings(public.films, jsonb, text[]);
drop function public.film_check_model(text, text[], text);
drop function public.film_take_rate(text, integer);
drop function public.film_check_asset(uuid, jsonb, text, text);
drop function public.film_asset_live(uuid, uuid, text);
drop function public.film_text(jsonb, text, integer, integer, boolean);
drop function public.film_uuid(jsonb, text);
drop function public.film_log(uuid, uuid, uuid, text, jsonb);
drop function public.film_is_editable(text);
drop function public.film_limits();

-- 2. The tables (children first: they reference the films), then the trigger function the event table used.
drop table public.film_events;
drop table public.film_takes;
drop table public.film_refs;
drop table public.film_scenes;
drop table public.films;
drop function public.film_events_append_only();
-- After the tables: their checks use the two text helpers.
drop function public.film_text_ok(text, integer, integer, boolean);
drop function public.film_clean_text(text, boolean);

-- 3. End state.
do $$
begin
  if to_regclass('public.films') is not null or to_regclass('public.film_scenes') is not null
     or to_regclass('public.film_refs') is not null or to_regclass('public.film_takes') is not null
     or to_regclass('public.film_events') is not null
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                  and (proname like 'film\_%' or proname in ('create_film_draft', 'save_film', 'archive_film'))) then
    raise exception 'rollback 0166 end state: something of 0166 is still there';
  end if;
end $$;

commit;
