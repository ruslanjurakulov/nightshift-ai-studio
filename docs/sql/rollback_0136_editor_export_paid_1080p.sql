-- rollback_0136_editor_export_paid_1080p.sql — takes migration 0136 (exports up to 1080p sold by the minute) out again. OWNER-APPLY: paste
-- into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHEN YOU NEED IT. If exports up to 1080p must stop being sellable in the database at all. To make them free again you do NOT need this
-- file: set the price to null (update public.editor_export_hires_prices set credits_per_minute_1080p = null;) and every export up to 1080p
-- is what it was before 0136.
--
-- READ THIS FIRST. What is NOT undone: exports already made at a price keep their rows (quoted, held, charged), and the credit ledger keeps
-- every hold, charge and release. An export up to 1080p still queued or rendering with a hold settles as usual afterwards: 0132's trigger
-- settles every row that carries one, whatever its frame. What IS lost: the 1080p price.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if a function of 0136 is not 0136's body (a later change would be undone).
--   1. Puts 0132's request_editor_export (two, three and four arguments), quote_editor_export, editor_export_hires_terms and the price trail
--      back, byte for byte (create or replace: their grants stay), and drops editor_export_price_1080p().
--   2. Puts 0132's price check back and drops the column credits_per_minute_1080p.
--   3. Asserts the end state: 0132's hashes.
-- Run it BEFORE docs/sql/rollback_0132_editor_hires_export.sql (that one refuses bodies that are not 0132's).

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.request_editor_export(uuid, integer)', '53fa7e65b4e1146ead1fff54d8afdd7d'],
      ['public.request_editor_export(uuid, integer, text)', '4221d9ee9eea10b3d6803b684825e39f'],
      ['public.request_editor_export(uuid, integer, text, numeric)', '8f9e7d0ac4d04e7ea2cc058e5f87a12b'],
      ['public.quote_editor_export(uuid, integer, text)', '27054620fa27c240525dd2567c3ca1c9'],
      ['public.editor_export_hires_terms(integer, integer, numeric)', '107d9c15687f718d8ea827c08b8dfd64'],
      ['public.editor_export_hires_prices_trail()', '859f4af3109f0bc5e4068b096c28d2dd'],
      ['public.editor_export_price_1080p()', '8a8fd2479b6e65694f448ae241c8828d']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(pair[1]);
    if h is distinct from pair[2] then
      raise exception 'rollback 0136: % is missing or is not 0136''s body (md5 %): a later change would be undone; read the live body first', pair[1], h;
    end if;
  end loop;
end $$;

-- 1. 0132's bodies, byte for byte (their hashes are asserted below).
create or replace function public.editor_export_hires_prices_trail() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  begin
    if new.credits_per_minute_1440p is distinct from old.credits_per_minute_1440p
       or new.credits_per_minute_2160p is distinct from old.credits_per_minute_2160p then
      perform public.security_event_log('editor.export.hires_price', 'warning', 'editor_export_hires_prices',
        jsonb_build_object('credits_per_minute_1440p', jsonb_build_array(old.credits_per_minute_1440p, new.credits_per_minute_1440p),
                           'credits_per_minute_2160p', jsonb_build_array(old.credits_per_minute_2160p, new.credits_per_minute_2160p)));
    end if;
  exception when others then
    raise warning 'editor export hires price trail failed: %', sqlerrm;
  end;
  return null;
end
$$;

create or replace function public.editor_export_hires_terms(p_width integer, p_height integer, p_duration numeric)
  returns jsonb
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  px      bigint := p_width::bigint * p_height::bigint;
  tier    text;
  max_s   integer;
  max_fps integer;
  cpm     numeric;
  minutes integer;
  floor_c numeric;
  credits numeric;
  hold    numeric;
begin
  if px is null or px <= 2073600 then
    return jsonb_build_object('paid', false);
  end if;
  if px <= 3686400 then
    tier := '1440p';
    max_s := 300;
    max_fps := 60;
    select s.credits_per_minute_1440p into cpm from public.editor_export_hires_prices s where s.id;
  else
    tier := '2160p';
    max_s := 180;
    max_fps := 30;
    select s.credits_per_minute_2160p into cpm from public.editor_export_hires_prices s where s.id;
  end if;
  minutes := greatest(1, ceil(greatest(coalesce(p_duration, 0), 0) / 60.0))::integer;
  if cpm is not null then
    credits := public.credits_round_up(cpm * minutes);
    select c.credits_per_unit into floor_c from public.credit_prices c where c.unit = 'job_minimum';
    hold := greatest(credits, coalesce(public.credits_round_up(floor_c), 0));
  end if;
  return jsonb_build_object('paid', true, 'tier', tier, 'max_s', max_s, 'max_fps', max_fps, 'minutes', minutes,
                            'credits_per_minute', cpm, 'credits', credits, 'hold', hold);
end
$$;

create or replace function public.quote_editor_export(p_project uuid, p_rev integer, p_frame text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  total   numeric;
  frame_id text;
  frame_w  integer;
  frame_h  integer;
  terms   jsonb;
  avail   numeric;
  exempt  boolean;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select f.id, f.width, f.height into frame_id, frame_w, frame_h from public.editor_export_frame(p_frame) f;
  if frame_id is null then
    raise exception 'invalid_frame' using errcode = 'NS400';
  end if;
  if p_rev is null or p_rev <> p.rev then
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);
  end if;
  total := public.editor_doc_duration(p.doc);
  if total is null then
    raise exception 'invalid_doc' using errcode = 'NS400';
  end if;
  if total <= 0 then
    raise exception 'empty' using errcode = 'NS400';
  end if;
  terms := public.editor_export_hires_terms(frame_w, frame_h, round(total, 3));
  if not (terms ->> 'paid')::boolean then
    return jsonb_build_object('frame', frame_id, 'width', frame_w, 'height', frame_h, 'paid', false, 'duration_s', round(total, 3));
  end if;
  exempt := public.credits_exempt(p.org_id);
  if not exempt then
    select a.balance - a.reserved into avail from public.credit_accounts a where a.org_id = p.org_id;
  end if;
  return terms || jsonb_build_object(
    'frame', frame_id, 'width', frame_w, 'height', frame_h, 'duration_s', round(total, 3),
    'too_long', round(total, 3) > (terms ->> 'max_s')::numeric,
    'fps', case when jsonb_typeof(p.doc -> 'fps') = 'number' then (p.doc ->> 'fps')::numeric end,
    'too_fast', jsonb_typeof(p.doc -> 'fps') = 'number' and (p.doc ->> 'fps')::numeric > (terms ->> 'max_fps')::numeric,
    'speed_curve', jsonb_path_exists(p.doc, 'lax $.tracks[*].clips[*].speed_curve'),
    'on_sale', terms ->> 'credits' is not null,
    'may_pay', public.is_org_member(p.org_id, 'editor') and (not exempt or public.is_platform_admin()),
    'exempt', exempt,
    'available', case when exempt then null else coalesce(avail, 0) end);
end
$$;

create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text, p_max_credits numeric) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  p       public.editor_projects;
  problem text;
  total   numeric;
  e       public.editor_exports;
  frame_id text;   -- 0129
  frame_w  integer;   -- 0129
  frame_h  integer;   -- 0129
  terms    jsonb;   -- 0132
  price    numeric;   -- 0132
  hold_c   numeric;   -- 0132
  ref      text;   -- 0132
  held     jsonb;   -- 0132
  why      text;   -- 0132
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
  -- 0132 only a frame above 1080p is sold here; a free one keeps going through the three-argument function.
  if frame_w::bigint * frame_h <= 2073600 then   -- 0132
    raise exception 'invalid_frame' using errcode = 'NS400', detail = 'not a paid frame';   -- 0132
  end if;   -- 0132
  -- 0132 spending the organization's credits is an editor's (a viewer may still ask for a free export), and in the exempt organization a
  -- 0132 platform owner's or admin's (as a creative job, 0036).
  if not public.is_org_member(p.org_id, 'editor') or (public.credits_exempt(p.org_id) and not public.is_platform_admin()) then   -- 0132
    raise exception 'forbidden' using errcode = '42501', detail = 'a paid export is asked by an editor or above';   -- 0132
  end if;   -- 0132
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
  -- 0132 a speed curve is not sold: editor_doc_duration does not integrate one and the renderer does, so the length priced here would not
  -- 0132 be the length rendered (a 45 s range at a quarter of the speed is 180 s on screen).
  if jsonb_path_exists(p.doc, 'lax $.tracks[*].clips[*].speed_curve') then   -- 0132
    raise exception 'hires_speed_curve' using errcode = 'NS400';   -- 0132
  end if;   -- 0132
  -- 0132 the tier's cap and price, before anything is locked or held. The length is the one the row will store (rounded to the ms).
  terms := public.editor_export_hires_terms(frame_w, frame_h, round(total, 3));   -- 0132
  if round(total, 3) > (terms ->> 'max_s')::numeric then   -- 0132
    raise exception 'hires_too_long' using errcode = 'NS400', detail = format('max_s=%s', terms ->> 'max_s');   -- 0132
  end if;   -- 0132
  if jsonb_typeof(p.doc -> 'fps') = 'number' and (p.doc ->> 'fps')::numeric > (terms ->> 'max_fps')::numeric then   -- 0132
    raise exception 'hires_fps' using errcode = 'NS400', detail = format('max_fps=%s', terms ->> 'max_fps');   -- 0132
  end if;   -- 0132
  -- 0132 the charge (what done captures) and the hold (the charge raised to job_minimum, which reserve_credits demands of any hold).
  price := (terms ->> 'credits')::numeric;   -- 0132
  hold_c := (terms ->> 'hold')::numeric;   -- 0132
  if price is null then   -- 0132
    raise exception 'not_on_sale' using errcode = 'NS403';   -- 0132
  end if;   -- 0132
  -- 0132 the caller's number is compared with the CHARGE, never the hold. NaN and the infinities are numerics too, and a comparison with
  -- 0132 NaN is never true: they are refused like a missing number.
  if p_max_credits is null or not (p_max_credits between 0 and 100000000) or price > p_max_credits then   -- 0132
    raise exception 'price_changed' using errcode = 'NS409', detail = format('price=%s confirmed=%s', price, p_max_credits);   -- 0132
  end if;   -- 0132
  if hold_c is null or hold_c < price then   -- 0132
    raise exception '0132: the hold % is below the charge %', hold_c, price;   -- 0132
  end if;   -- 0132

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
  -- 0132 the hold, keyed by the export: after every limit, so a refused request holds nothing. Too few credits for the HOLD roll the whole
  -- 0132 call back. Started at once, so reserve_credits' sweep of holds nobody started (three hours) cannot return it while the export waits.
  ref := 'ee:' || e.id::text;   -- 0132
  begin   -- 0132
    held := public.creative_platform_reserve(p.org_id, ref, hold_c);   -- 0132
  exception when sqlstate 'NS402' then   -- 0132
    get stacked diagnostics why = pg_exception_detail;   -- 0132
    raise exception 'insufficient_credits' using errcode = 'NS402', detail = format('hold=%s charge=%s %s', hold_c, price, why);   -- 0132
  when sqlstate 'NS429' then   -- 0132
    get stacked diagnostics why = pg_exception_detail;   -- 0132
    raise exception 'parallel_runs' using errcode = 'NS429', detail = why;   -- 0132
  end;   -- 0132
  if coalesce((held ->> 'exempt')::boolean, false) then   -- 0132
    ref := null;   -- 0132
  else   -- 0132
    perform public.editor_export_money('start', ref, null);   -- 0132
  end if;   -- 0132
  -- 0129 the frame is stamped on the row this call just made, in the same transaction: nobody ever sees it without one.
  update public.editor_exports   -- 0129
     set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h, quoted_credits = price, held_credits = case when ref is null then null else hold_c end, credit_ref = ref   -- 0132 replaces: set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129
   where id = e.id;   -- 0129
  return e.id;
end
$$;

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
  -- 0132 above 1080p is paid (the owner's decision, 2026-11-11), so a project whose OWN frame is above 1920x1080 pixels is not exported
  -- 0132 free here: it is exported in a paid frame (the four-argument overload), or after its frame is set to 1080p or smaller. A frame
  -- 0132 that is not two numbers is left to the worker's validator, which refuses it.
  if jsonb_typeof(p.doc -> 'width') = 'number' and jsonb_typeof(p.doc -> 'height') = 'number'   -- 0132
     and (p.doc ->> 'width')::numeric * (p.doc ->> 'height')::numeric > 2073600 then   -- 0132
    raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';   -- 0132
  end if;   -- 0132

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
  -- 0132 a frame of the list above 1080p is paid: it is sold by the four-argument overload, never queued free here.
  if frame_w::bigint * frame_h > 2073600 then   -- 0132
    raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';   -- 0132
  end if;   -- 0132
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

drop function public.editor_export_price_1080p();

-- 2. 0132's price check and the column.
alter table public.editor_export_hires_prices drop constraint if exists editor_export_hires_prices_numbers;
alter table public.editor_export_hires_prices add constraint editor_export_hires_prices_numbers
  check ((credits_per_minute_1440p is null or credits_per_minute_1440p between 0.01 and 10000)
         and (credits_per_minute_2160p is null or credits_per_minute_2160p between 0.01 and 10000));
alter table public.editor_export_hires_prices drop column if exists credits_per_minute_1080p;
comment on table public.editor_export_hires_prices is
  'One row (migration 0132): credits per started output minute of a 1440p and of a 4K editor export. NULL = not on sale (the seed). Read only by the export functions; changed in the SQL editor only, and a trigger leaves a mark in security_events.';

-- 3. End state.
do $$
declare
  pair text[];
begin
  foreach pair slice 1 in array array[
      ['public.request_editor_export(uuid, integer)', '7d27be2166d301cf392daee41dffd2e2'],
      ['public.request_editor_export(uuid, integer, text)', '7722885b3bf1d32c7b9de0d101a316ee'],
      ['public.request_editor_export(uuid, integer, text, numeric)', '28e49bc98a7bd5811dffa9c09539a364'],
      ['public.quote_editor_export(uuid, integer, text)', '383185a2158b57dc695e4d3c26b147e7'],
      ['public.editor_export_hires_terms(integer, integer, numeric)', '31904d0cf1f8b53316c0641e89a964a4'],
      ['public.editor_export_hires_prices_trail()', 'fffbfc847cd35cbbf793c66d140dc747']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2] then
      raise exception 'rollback 0136 end state: % does not hold 0132''s body', pair[1];
    end if;
  end loop;
  if to_regprocedure('public.editor_export_price_1080p()') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'editor_export_hires_prices'
                 and column_name = 'credits_per_minute_1080p') then
    raise exception 'rollback 0136 end state: the 1080p price is still there';
  end if;
  if not (has_function_privilege('authenticated', 'public.request_editor_export(uuid, integer, text, numeric)', 'EXECUTE')
          and has_function_privilege('authenticated', 'public.request_editor_export(uuid, integer)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.request_editor_export(uuid, integer, text)', 'EXECUTE')) then
    raise exception 'rollback 0136 end state: a function has the wrong grants';
  end if;
end $$;

commit;
