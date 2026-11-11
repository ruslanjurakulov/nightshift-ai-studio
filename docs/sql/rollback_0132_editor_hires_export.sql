-- rollback_0132_editor_hires_export.sql — takes migration 0132 (1440p and 4K exports, sold by the minute) out again. OWNER-APPLY: paste into
-- the Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If paid 1440p / 4K exports must stop existing in the database. To stop SELLING them, you do not need this file: set both
-- prices to null (update public.editor_export_hires_prices set credits_per_minute_1440p = null, credits_per_minute_2160p = null;) and every
-- request is refused not_on_sale; turn NIGHTSHIFT_HIRES_EXPORT off as well (web and worker) and the editor stops offering them.
--
-- READ THIS FIRST. What is NOT undone: videos already exported at 1440p / 4K stay in the library (media_assets is never touched), their export
-- rows stay as finished exports with their frame, and the credit ledger keeps every hold, charge and release (credit_transactions, job_id
-- 'ee:<export id>'). What IS lost: the four credit columns of editor_exports (the ledger has the same numbers) and the owner's two prices.
-- What COMES BACK: 0054's and 0129's request_editor_export() bodies, which export a project whose own frame is above 1080p for free.
-- A paid export that is still queued or rendering holds credits that only 0132's trigger would settle, so the file REFUSES while one exists.
--
-- WHAT IT DOES, in one transaction, holding a SHARE ROW EXCLUSIVE lock on editor_exports from before the check to the end (no export can be
-- asked for between the check and the drop):
--   0. REFUSES (changes nothing) if a function of 0132 is not 0132's body (a later change would be undone), the two- and three-argument
--      request_editor_export() included, or if an export that is queued or rendering carries a quote.
--   1. Drops the four-argument request_editor_export(), quote_editor_export(), the settling trigger and its function, editor_export_money(),
--      editor_export_hires_terms(), and editor_export_hires_prices with its two trigger functions.
--   2. Puts 0129's closed list (five frames) back, byte for byte, and 0129's frame check: validated when no row is above 2560x1440, otherwise
--      NOT VALID (a finished 4K row stays as it is; every new row is held to 0129's limit). Puts 0054's two-argument and 0129's
--      three-argument request_editor_export() back, byte for byte (create or replace: their grants stay).
--   3. Drops the check editor_exports_hires_terms and the columns quoted_credits / held_credits / credit_ref / charged_credits.
--   4. Asserts the end state: two request_editor_export() left with 0054's and 0129's hashes, 0129's list hash, their grants as before.
--
-- Run it BEFORE docs/sql/rollback_0129_editor_export_frame.sql (that one refuses an editor_export_frame() that is not 0129's).
-- tests/security/test_sec_editor_hires_export.py applies this file to a copy of the lab database and re-applies 0132.

begin;
set local lock_timeout = '5s';
-- Before the in-flight check, and held to the end: a paid export asked for WHILE this runs would otherwise hold credits nothing settles.
lock table public.editor_exports in share row exclusive mode;

do $$
declare
  h text;
  fn text;
  want text;
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.request_editor_export(uuid, integer, text, numeric)', '9e073e6ea46645241b5b99a65b0a7f93'],
      ['public.quote_editor_export(uuid, integer, text)', '383185a2158b57dc695e4d3c26b147e7'],
      ['public.editor_export_frame(text)', 'f44b57823aef5fb04c8be74912460c02'],
      ['public.editor_export_hires_terms(integer, integer, numeric)', '31904d0cf1f8b53316c0641e89a964a4'],
      ['public.editor_export_money(text, text, numeric)', '0b9a881cd63807ef95fc726beb304a2e'],
      ['public.editor_export_settle()', 'f0f8174e28911205b265d08adb0e1f46'],
      ['public.editor_export_hires_prices_guard()', '3ceae02b0246ce2a8ec627840561b424'],
      ['public.editor_export_hires_prices_trail()', 'fffbfc847cd35cbbf793c66d140dc747']] loop
    fn := pair[1];
    want := pair[2];
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(fn);
    if h is distinct from want then
      raise exception 'rollback 0132: % is missing or is not 0132''s body (md5 %): a later change would be undone; read the live body first', fn, h;
    end if;
  end loop;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.request_editor_export(uuid, integer)');
  if h is distinct from '7d27be2166d301cf392daee41dffd2e2' then
    raise exception 'rollback 0132: the two-argument request_editor_export() is not 0132''s body (md5 %); read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.request_editor_export(uuid, integer, text)');
  if h is distinct from '7722885b3bf1d32c7b9de0d101a316ee' then
    raise exception 'rollback 0132: the three-argument request_editor_export() is not 0132''s body (md5 %); read the live body first', h;
  end if;
  if exists (select 1 from public.editor_exports where quoted_credits is not null and status in ('queued', 'rendering')) then
    raise exception 'rollback 0132: a paid export is still queued or rendering and holds credits; wait until it is done or failed, then run this again';
  end if;
end $$;

-- 1. What 0132 added.
drop function public.request_editor_export(uuid, integer, text, numeric);
drop function public.quote_editor_export(uuid, integer, text);
drop trigger if exists editor_exports_settle on public.editor_exports;
drop function public.editor_export_settle();
drop function public.editor_export_money(text, text, numeric);
drop function public.editor_export_hires_terms(integer, integer, numeric);
drop table public.editor_export_hires_prices;
drop function public.editor_export_hires_prices_guard();
drop function public.editor_export_hires_prices_trail();

-- 2. 0129's closed list, byte for byte (its hash is asserted below), and 0129's frame check.
create or replace function public.editor_export_frame(p_frame text)
  returns table (id text, width integer, height integer)
  language sql immutable set search_path = public, pg_temp as $$
  select v.id, v.width, v.height
    from (values ('youtube_1080p', 1920, 1080),
                 ('youtube_720p', 1280, 720),
                 ('vertical_1080p', 1080, 1920),
                 ('square_1080', 1080, 1080),
                 ('feed_4x5_1080', 1080, 1350)) as v (id, width, height)
   where v.id = p_frame
$$;
revoke all on function public.editor_export_frame(text) from public, anon, authenticated, service_role;

-- 0054's two-argument and 0129's three-argument functions, byte for byte (their hashes are asserted below); create or replace keeps grants.
create or replace function public.request_editor_export(p_project uuid, p_rev integer) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  problem text;
  total   numeric;
  e       public.editor_exports;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project for update;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_rev is null or p_rev <> p.rev then
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);
  end if;
  -- Again now: a file used by the project may have been deleted since it was saved.
  problem := public.editor_doc_problem(p.org_id, p.doc);
  if problem is not null then
    raise exception '%', problem using errcode = 'NS400';
  end if;
  total := public.editor_doc_duration(p.doc);
  if total is null then
    raise exception 'invalid_doc' using errcode = 'NS400';
  end if;
  if total <= 0 then
    raise exception 'empty' using errcode = 'NS400';
  end if;
  if total > 1800 then
    raise exception 'too_long' using errcode = 'NS400', detail = 'max_s=1800';
  end if;

  -- One request per organization at a time: the limits hold under parallel clicks.
  perform pg_advisory_xact_lock(hashtextextended('editor_exports:' || p.org_id::text, 0));
  if exists (select 1 from public.editor_exports
              where project_id = p.id and status in ('queued', 'rendering')) then
    raise exception 'export_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and status in ('queued', 'rendering')) >= 3 then
    raise exception 'export_in_progress' using errcode = 'NS409', detail = 'max_active=3';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'daily_limit' using errcode = 'NS429', detail = 'max=20';
  end if;

  insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by)
  values (p.org_id, p.id, p.rev, p.doc, round(total, 3), auth.uid())
  returning * into e;
  return e.id;
end
$$;

create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  problem text;
  total   numeric;
  e       public.editor_exports;
  frame_id text;   -- 0129
  frame_w  integer;   -- 0129
  frame_h  integer;   -- 0129
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project for update;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- 0129 the frame, from the database's own closed list and only AFTER membership: null, a made-up word, a padded or upper-case id
  -- 0129 and a size typed as text are one refusal. Width and height are read from the list, never from the caller.
  select f.id, f.width, f.height into frame_id, frame_w, frame_h from public.editor_export_frame(p_frame) f;   -- 0129
  if frame_id is null then   -- 0129
    raise exception 'invalid_frame' using errcode = 'NS400';   -- 0129
  end if;   -- 0129
  if p_rev is null or p_rev <> p.rev then
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);
  end if;
  -- Again now: a file used by the project may have been deleted since it was saved.
  problem := public.editor_doc_problem(p.org_id, p.doc);
  if problem is not null then
    raise exception '%', problem using errcode = 'NS400';
  end if;
  total := public.editor_doc_duration(p.doc);
  if total is null then
    raise exception 'invalid_doc' using errcode = 'NS400';
  end if;
  if total <= 0 then
    raise exception 'empty' using errcode = 'NS400';
  end if;
  if total > 1800 then
    raise exception 'too_long' using errcode = 'NS400', detail = 'max_s=1800';
  end if;

  -- One request per organization at a time: the limits hold under parallel clicks.
  perform pg_advisory_xact_lock(hashtextextended('editor_exports:' || p.org_id::text, 0));
  -- 0129 one at a time per project PER FRAME SIZE: the same picture twice is refused, another size is another file. An export in
  -- 0129 flight without a frame is the size of the document it copied (jsonb compares numbers by value, and never raises on a doc
  -- 0129 whose width is not a number). The organization's three in flight and twenty a day below are 0054's lines, unchanged, and
  -- 0129 each frame counts as one.
  if exists (select 1 from public.editor_exports
              where project_id = p.id and status in ('queued', 'rendering') and coalesce(to_jsonb(frame_width), doc -> 'width') = to_jsonb(frame_w) and coalesce(to_jsonb(frame_height), doc -> 'height') = to_jsonb(frame_h)) then   -- 0129 replaces: where project_id = p.id and status in ('queued', 'rendering')) then
    raise exception 'export_in_progress' using errcode = 'NS409';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and status in ('queued', 'rendering')) >= 3 then
    raise exception 'export_in_progress' using errcode = 'NS409', detail = 'max_active=3';
  end if;
  if (select count(*) from public.editor_exports
       where org_id = p.org_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'daily_limit' using errcode = 'NS429', detail = 'max=20';
  end if;

  insert into public.editor_exports (org_id, project_id, rev, doc, duration_s, requested_by)
  values (p.org_id, p.id, p.rev, p.doc, round(total, 3), auth.uid())
  returning * into e;
  -- 0129 the frame is stamped on the row this call just made, in the same transaction: nobody ever sees it without one.
  update public.editor_exports   -- 0129
     set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129
   where id = e.id;   -- 0129
  return e.id;
end
$$;

alter table public.editor_exports drop constraint if exists editor_exports_frame_shape;
do $$
declare
  big boolean := exists (select 1 from public.editor_exports where frame_width * frame_height > 3686400);
begin
  -- A finished 4K export is a fact in the library: its row keeps its frame. NOT VALID holds every NEW row to 0129's limit without rewriting it.
  execute 'alter table public.editor_exports add constraint editor_exports_frame_shape check ('
       || '(frame_preset is null and frame_width is null and frame_height is null) '
       || 'or (frame_preset is not null and frame_width is not null and frame_height is not null '
       || 'and frame_preset ~ ''^[a-z0-9_]{1,32}$'' '
       || 'and frame_width between 16 and 4096 and frame_height between 16 and 4096 '
       || 'and frame_width % 2 = 0 and frame_height % 2 = 0 '
       || 'and frame_width * frame_height <= 3686400))' || case when big then ' not valid' else '' end;
  if big then
    raise notice 'rollback 0132: finished exports above 2560x1440 keep their rows; the frame check is NOT VALID until they are gone';
  end if;
end $$;

-- 3. The credit columns and their check (the ledger keeps the money's record).
alter table public.editor_exports drop constraint if exists editor_exports_hires_terms;
alter table public.editor_exports
  drop column if exists quoted_credits,
  drop column if exists held_credits,
  drop column if exists credit_ref,
  drop column if exists charged_credits;

-- 4. End state.
do $$
declare
  req2 regprocedure := 'public.request_editor_export(uuid, integer)'::regprocedure;
  req3 regprocedure := 'public.request_editor_export(uuid, integer, text)'::regprocedure;
  lst  regprocedure := 'public.editor_export_frame(text)'::regprocedure;
begin
  if (select count(*) from pg_proc where proname = 'request_editor_export' and pronamespace = 'public'::regnamespace) <> 2
     or to_regprocedure('public.quote_editor_export(uuid, integer, text)') is not null
     or to_regprocedure('public.editor_export_money(text, text, numeric)') is not null
     or to_regclass('public.editor_export_hires_prices') is not null then
    raise exception 'rollback 0132 end state: a function or table of 0132 is still there';
  end if;
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req2) <> '6d37b4d75092708981c28a56879c89b4'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req3) <> '83456b3c70d9433ce0e21da1339198ad'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = lst) <> '1bcfdbfab6526ce7d0ba07e167f5740c' then
    raise exception 'rollback 0132 end state: a function does not hold 0054''s / 0129''s body';
  end if;
  if not (has_function_privilege('authenticated', req3, 'EXECUTE') and has_function_privilege('authenticated', req2, 'EXECUTE')
          and not has_function_privilege('anon', req3, 'EXECUTE') and not has_function_privilege('service_role', req3, 'EXECUTE')
          and not has_function_privilege('authenticated', lst, 'EXECUTE') and not has_function_privilege('service_role', lst, 'EXECUTE')) then
    raise exception 'rollback 0132 end state: a function has the wrong grants';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.editor_exports'::regclass and tgname = 'editor_exports_settle')
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'editor_exports'
                 and column_name in ('quoted_credits', 'held_credits', 'credit_ref', 'charged_credits'))
     or not exists (select 1 from pg_constraint where conname = 'editor_exports_frame_shape' and conrelid = 'public.editor_exports'::regclass)
     or exists (select 1 from pg_constraint where conname = 'editor_exports_hires_terms') then
    raise exception 'rollback 0132 end state: editor_exports is not as 0129 left it';
  end if;
end $$;

commit;
