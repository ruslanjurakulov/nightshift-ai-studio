-- 0136_editor_export_paid_1080p.sql — exports up to 1080p sold by the started output minute, the same money as 1440p and 4K (0132).
-- Owner decision 2026-11-11: exports at 1080p and below are no longer free; 1 credit per started minute. docs/HIRES_EXPORT.md.
--
-- *** LIVE ON APPLY, AND CHANGES NOTHING UNTIL THE OWNER SETS THE PRICE. *** It adds one price, credits_per_minute_1080p, to 0132's
-- owner-edited row, seeded NULL, and NULL means FREE: every export up to 1080p is then exactly what it was (the two- and three-argument
-- requests queue it, nothing is held, nothing is charged). Once the owner writes a number, every export up to 1080p goes through the flow
-- of the paid tiers: the server's quote, the person's confirmed number (p_max_credits, compared with the CHARGE), a hold of
-- greatest(charge, job_minimum) at request time, capture of exactly the charge when done, release on every failure.
--
-- WHAT IT ADDS
--   editor_export_hires_prices.credits_per_minute_1080p   numeric(10,2), NULL (= free) or 0.01-10000, the same row, rules and trail as
--                                   0132's two prices; a change leaves a security_events row (editor.export.hires_price).
--   editor_export_price_1080p()     INTERNAL. That price, or null.
-- WHAT IT REPLACES (each is 0132's body, line for line, plus the lines marked 0136; a pin test takes them out and compares)
--   editor_export_hires_terms(w, h, length)     a frame up to 1920x1080 pixels is the '1080p' tier while that price is set (1800 s at most,
--                                   any rate, the same started minutes, charge and hold); free (paid=false) while it is NULL.
--   request_editor_export(project, rev)         and (project, rev, frame): refuse with export_needs_quote (NS409) while the 1080p price is
--                                   set, after every gate of 0054 / 0129 / 0132 and before the organization's lock. They hold nothing, so
--                                   they never sell; the editor moves to the quoted path when it reads that word. NULL: unchanged.
--   request_editor_export(project, rev, frame, max_credits)
--                                   also sells a frame up to 1080p while its price is set (a free id of the closed list, or 'project' for
--                                   the project's own frame up to 1920x1080 pixels: the row then carries no frame, as the two-argument
--                                   function's). NULL: a frame up to 1080p is refused (invalid_frame), as in 0132.
--   quote_editor_export(project, rev, frame)    the same, 'project' included: the quote of an export up to 1080p while its price is set.
--   editor_export_hires_prices_trail()          logs the third price too.
-- NOT REPLACED: editor_export_frame (0132's nine formats), editor_export_money, editor_export_settle (it settles every row that carries a
-- hold, whatever its frame), the guard of the price row, the CHECKs. Their 0132 hashes are asserted at the end.
--
-- WHO MAY PAY. As 0132: an editor or above (a viewer may not spend the organization's credits, so while the 1080p price is set a viewer
-- cannot export at all); in the operator's exempt organization a platform admin, and nothing is held.
-- SPEED CURVES. As 0132: a document with a speed_curve is not sold (hires_speed_curve): editor_doc_duration does not integrate a curve.
-- While the 1080p price is set, such a document cannot be exported at any size. docs/HIRES_EXPORT.md says so.
-- LOCKS. One order in every overload, 0054's: the project's row FOR UPDATE, then the organization's advisory lock.
--
-- ORDER AND ROLL-OUT (docs/HIRES_EXPORT.md): deploy the web and the worker, turn NIGHTSHIFT_MULTI_RATIO_EXPORT and NIGHTSHIFT_HIRES_EXPORT
-- on (web and worker), and only then set the price. The 1080p price and the 1440p / 4K prices are independent: each NULL or a number.
-- Needs 0132 (refuses, changing nothing, if a function it replaces is not 0132's body or this file's own).
-- NUMBER. 0136: 0134 (brand-scan follow-up) and 0135 (character studio) are reserved by other work; this file names nothing of theirs.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; md5 of the body with every run of white space read as one space):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where proname in ('request_editor_export', 'quote_editor_export', 'editor_export_hires_terms', 'editor_export_hires_prices_trail');
--   expected BEFORE (0132): req2 7d27be2166d301cf392daee41dffd2e2 · req3 7722885b3bf1d32c7b9de0d101a316ee · req4 28e49bc98a7bd5811dffa9c09539a364 · quote 383185a2158b57dc695e4d3c26b147e7 · terms 31904d0cf1f8b53316c0641e89a964a4 ·
--                           trail fffbfc847cd35cbbf793c66d140dc747
--   expected AFTER:         req2 53fa7e65b4e1146ead1fff54d8afdd7d · req3 4221d9ee9eea10b3d6803b684825e39f · req4 8f9e7d0ac4d04e7ea2cc058e5f87a12b · quote 27054620fa27c240525dd2567c3ca1c9 · terms 107d9c15687f718d8ea827c08b8dfd64 · trail 859f4af3109f0bc5e4068b096c28d2dd
--
-- SETTING THE PRICE (the owner, in the SQL editor, after the roll-out above; leaves a security_events row). Owner-approved 2026-11-11: 1.
--   update public.editor_export_hires_prices set credits_per_minute_1080p = 1;
--   back to free: set it to null (exports already queued keep their hold and settle as usual).
-- Undo: docs/sql/rollback_0136_editor_export_paid_1080p.sql (owner-applied).

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
  trio text[];
begin
  if to_regclass('public.editor_export_hires_prices') is null
     or to_regprocedure('public.request_editor_export(uuid, integer, text, numeric)') is null
     or to_regprocedure('public.editor_export_settle()') is null then
    raise exception '0136 needs 1440p and 4K exports: apply 0132_editor_hires_export.sql first';
  end if;
  -- Every function this file replaces: 0132's body, or this file's own (a replay).
  foreach trio slice 1 in array array[
      ['public.request_editor_export(uuid, integer)', '7d27be2166d301cf392daee41dffd2e2', '53fa7e65b4e1146ead1fff54d8afdd7d'],
      ['public.request_editor_export(uuid, integer, text)', '7722885b3bf1d32c7b9de0d101a316ee', '4221d9ee9eea10b3d6803b684825e39f'],
      ['public.request_editor_export(uuid, integer, text, numeric)', '28e49bc98a7bd5811dffa9c09539a364', '8f9e7d0ac4d04e7ea2cc058e5f87a12b'],
      ['public.quote_editor_export(uuid, integer, text)', '383185a2158b57dc695e4d3c26b147e7', '27054620fa27c240525dd2567c3ca1c9'],
      ['public.editor_export_hires_terms(integer, integer, numeric)', '31904d0cf1f8b53316c0641e89a964a4', '107d9c15687f718d8ea827c08b8dfd64'],
      ['public.editor_export_hires_prices_trail()', 'fffbfc847cd35cbbf793c66d140dc747', '859f4af3109f0bc5e4068b096c28d2dd']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is null or h <> all (array[trio[2], trio[3]]) then
      raise exception '0136 found % with a body that is neither 0132''s nor 0136''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  -- What it builds on and leaves alone: 0132's bodies.
  foreach trio slice 1 in array array[
      ['public.editor_export_money(text, text, numeric)', '0b9a881cd63807ef95fc726beb304a2e', ''],
      ['public.editor_export_settle()', 'f0f8174e28911205b265d08adb0e1f46', ''],
      ['public.editor_export_hires_prices_guard()', '3ceae02b0246ce2a8ec627840561b424', ''],
      ['public.editor_export_frame(text)', 'f44b57823aef5fb04c8be74912460c02', '']] loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(trio[1]);
    if h is distinct from trio[2] then
      raise exception '0136 found % with a body that is not 0132''s (md5 %): read the live body first', trio[1], h;
    end if;
  end loop;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.editor_export_price_1080p()');
  if h is not null and h <> '8a8fd2479b6e65694f448ae241c8828d' then
    raise exception '0136 found editor_export_price_1080p() with a body that is not this file''s (md5 %): read the live body first', h;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The third price: up to 1080p, NULL = free
-- ───────────────────────────────────────────────────────────────────────────

alter table public.editor_export_hires_prices add column if not exists credits_per_minute_1080p numeric(10,2);
alter table public.editor_export_hires_prices drop constraint if exists editor_export_hires_prices_numbers;
alter table public.editor_export_hires_prices add constraint editor_export_hires_prices_numbers
  check ((credits_per_minute_1440p is null or credits_per_minute_1440p between 0.01 and 10000)
         and (credits_per_minute_2160p is null or credits_per_minute_2160p between 0.01 and 10000)
         and (credits_per_minute_1080p is null or credits_per_minute_1080p between 0.01 and 10000));

comment on column public.editor_export_hires_prices.credits_per_minute_1080p is
  'Credits per started output minute of an editor export up to 1920x1080 pixels (migration 0136). NULL = free (the seed): exports up to 1080p are what they were before 0136. Set in the SQL editor only.';
comment on table public.editor_export_hires_prices is
  'One row (migrations 0132, 0136): credits per started output minute of an editor export up to 1080p, at 1440p and at 4K. NULL = free up to 1080p, not on sale above. Read only by the export functions; changed in the SQL editor only, and a trigger leaves a mark in security_events.';

-- The trail before anything can change the new column (a replay keeps the owner's value: add column if not exists, no update here).
create or replace function public.editor_export_hires_prices_trail() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  begin
    if new.credits_per_minute_1440p is distinct from old.credits_per_minute_1440p
       or new.credits_per_minute_2160p is distinct from old.credits_per_minute_2160p
       or new.credits_per_minute_1080p is distinct from old.credits_per_minute_1080p then
      perform public.security_event_log('editor.export.hires_price', 'warning', 'editor_export_hires_prices',
        jsonb_build_object('credits_per_minute_1440p', jsonb_build_array(old.credits_per_minute_1440p, new.credits_per_minute_1440p),
                           'credits_per_minute_2160p', jsonb_build_array(old.credits_per_minute_2160p, new.credits_per_minute_2160p),
                           'credits_per_minute_1080p', jsonb_build_array(old.credits_per_minute_1080p, new.credits_per_minute_1080p)));
    end if;
  exception when others then
    raise warning 'editor export hires price trail failed: %', sqlerrm;
  end;
  return null;
end
$$;

create or replace function public.editor_export_price_1080p() returns numeric
  language sql stable set search_path = public, pg_temp as $$
  select s.credits_per_minute_1080p from public.editor_export_hires_prices s where s.id
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The terms: a 1080p tier while its price is set
-- ───────────────────────────────────────────────────────────────────────────

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
  if px is null then
    return jsonb_build_object('paid', false);
  end if;
  if px <= 2073600 then
    -- Up to 1080p: free while its price is NULL (every rule as before 0136), sold by the minute once the owner sets it.
    select s.credits_per_minute_1080p into cpm from public.editor_export_hires_prices s where s.id;
    if cpm is null then
      return jsonb_build_object('paid', false);
    end if;
    tier := '1080p';
    max_s := 1800;
    max_fps := 60;
  elsif px <= 3686400 then
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

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The quote, 'project' and the 1080p tier included
-- ───────────────────────────────────────────────────────────────────────────

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
  own     boolean := p_frame = 'project';
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into p from public.editor_projects where id = p_project;
  if not found or p.deleted_at is not null or not public.is_org_member(p.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select f.id, f.width, f.height into frame_id, frame_w, frame_h from public.editor_export_frame(p_frame) f;
  -- 'project': the project's own frame, as the four-argument request reads it (sold up to 1080p only).
  if own and jsonb_typeof(p.doc -> 'width') = 'number' and jsonb_typeof(p.doc -> 'height') = 'number'
     and p.doc ->> 'width' ~ '^[1-9][0-9]{0,4}$' and p.doc ->> 'height' ~ '^[1-9][0-9]{0,4}$' then
    frame_id := 'project';
    frame_w := (p.doc ->> 'width')::integer;
    frame_h := (p.doc ->> 'height')::integer;
    if frame_w::bigint * frame_h > 2073600 then
      raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';
    end if;
  elsif frame_id is null then
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. request_editor_export: four arguments sell up to 1080p too; two and three refuse while it is sold
-- ───────────────────────────────────────────────────────────────────────────

-- 0132's four-argument function, line for line, plus the lines marked 0136.
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
  own      boolean := p_frame = 'project';   -- 0136
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
  -- 0136 'project' is the project's OWN frame (exported without a frame on the row, as the two-argument function does), sold only up to
  -- 0136 1080p: its width and height are the document's, two whole numbers, never the caller's.
  if own and jsonb_typeof(p.doc -> 'width') = 'number' and jsonb_typeof(p.doc -> 'height') = 'number'   -- 0136
     and p.doc ->> 'width' ~ '^[1-9][0-9]{0,4}$' and p.doc ->> 'height' ~ '^[1-9][0-9]{0,4}$' then   -- 0136
    frame_w := (p.doc ->> 'width')::integer;   -- 0136
    frame_h := (p.doc ->> 'height')::integer;   -- 0136
    if frame_w::bigint * frame_h > 2073600 then   -- 0136
      raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';   -- 0136
    end if;   -- 0136
  elsif frame_id is null then   -- 0136 replaces: if frame_id is null then   -- 0129
    raise exception 'invalid_frame' using errcode = 'NS400';   -- 0129
  end if;   -- 0129
  -- 0132 only a frame above 1080p is sold here; a free one keeps going through the three-argument function.
  if frame_w::bigint * frame_h <= 2073600 and public.editor_export_price_1080p() is null then   -- 0136 replaces: if frame_w::bigint * frame_h <= 2073600 then   -- 0132
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
     set frame_preset = frame_id, frame_width = case when own then null else frame_w end, frame_height = case when own then null else frame_h end, quoted_credits = price, held_credits = case when ref is null then null else hold_c end, credit_ref = ref   -- 0136 replaces: set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h, quoted_credits = price, held_credits = case when ref is null then null else hold_c end, credit_ref = ref   -- 0132 replaces: set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129
   where id = e.id;   -- 0129
  return e.id;
end
$$;

-- 0132's two-argument function, line for line, plus the lines marked 0136. create or replace keeps its grants.
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
  -- 0136 exports up to 1080p are sold once the owner sets their price (NULL = free, as before): this call holds nothing, so it is refused
  -- 0136 and the editor asks the price (quote_editor_export) and confirms it through the four-argument overload. Never sold here.
  if public.editor_export_price_1080p() is not null then   -- 0136
    raise exception 'export_needs_quote' using errcode = 'NS409', detail = 'exports up to 1080p are sold: ask the price and confirm it';   -- 0136
  end if;   -- 0136

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

-- 0132's three-argument function, line for line, plus the lines marked 0136. create or replace keeps its grants.
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
  -- 0136 exports up to 1080p are sold once the owner sets their price (NULL = free, as before): this call holds nothing, so it is refused
  -- 0136 and the editor asks the price (quote_editor_export) and confirms it through the four-argument overload. Never sold here.
  if public.editor_export_price_1080p() is not null then   -- 0136
    raise exception 'export_needs_quote' using errcode = 'NS409', detail = 'exports up to 1080p are sold: ask the price and confirm it';   -- 0136
  end if;   -- 0136

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

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges: the new function for nobody; the replaced ones keep theirs (create or replace)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.editor_export_price_1080p() from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. End state (raises, and so rolls the whole file back, if anything is not as written above)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  pair text[];
  role_name text;
  priv text;
begin
  foreach pair slice 1 in array array[
      ['public.request_editor_export(uuid, integer)', '53fa7e65b4e1146ead1fff54d8afdd7d'],
      ['public.request_editor_export(uuid, integer, text)', '4221d9ee9eea10b3d6803b684825e39f'],
      ['public.request_editor_export(uuid, integer, text, numeric)', '8f9e7d0ac4d04e7ea2cc058e5f87a12b'],
      ['public.quote_editor_export(uuid, integer, text)', '27054620fa27c240525dd2567c3ca1c9'],
      ['public.editor_export_hires_terms(integer, integer, numeric)', '107d9c15687f718d8ea827c08b8dfd64'],
      ['public.editor_export_hires_prices_trail()', '859f4af3109f0bc5e4068b096c28d2dd'],
      ['public.editor_export_price_1080p()', '8a8fd2479b6e65694f448ae241c8828d'],
      ['public.editor_export_money(text, text, numeric)', '0b9a881cd63807ef95fc726beb304a2e'],
      ['public.editor_export_settle()', 'f0f8174e28911205b265d08adb0e1f46'],
      ['public.editor_export_hires_prices_guard()', '3ceae02b0246ce2a8ec627840561b424'],
      ['public.editor_export_frame(text)', 'f44b57823aef5fb04c8be74912460c02']] loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(pair[1])) is distinct from pair[2] then
      raise exception '0136 end state: % does not hold the body this file expects', pair[1];
    end if;
  end loop;
  if (select count(*) from pg_proc where proname = 'request_editor_export' and pronamespace = 'public'::regnamespace) <> 3 then
    raise exception '0136 end state: request_editor_export() does not have exactly three overloads';
  end if;
  -- The callables keep 0054's / 0129's / 0132's grants: signed-in members only. The new function is nobody's.
  foreach pair slice 1 in array array[['public.request_editor_export(uuid, integer)'], ['public.request_editor_export(uuid, integer, text)'],
                                       ['public.request_editor_export(uuid, integer, text, numeric)'], ['public.quote_editor_export(uuid, integer, text)']] loop
    if not has_function_privilege('authenticated', pair[1], 'EXECUTE') or has_function_privilege('anon', pair[1], 'EXECUTE')
       or has_function_privilege('service_role', pair[1], 'EXECUTE') then
      raise exception '0136 end state: % has the wrong grants', pair[1];
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(role_name, 'public.editor_export_price_1080p()', 'EXECUTE')
       or has_function_privilege(role_name, 'public.editor_export_hires_terms(integer, integer, numeric)', 'EXECUTE') then
      raise exception '0136 end state: % can call an internal function', role_name;
    end if;
    foreach priv in array array['select', 'insert', 'update', 'delete'] loop
      if has_table_privilege(role_name, 'public.editor_export_hires_prices', priv) then
        raise exception '0136 end state: % holds % on editor_export_hires_prices', role_name, priv;
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_proc p where p.oid = 'public.editor_export_price_1080p()'::regprocedure
              and (p.prosecdef or p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
    raise exception '0136 end state: editor_export_price_1080p() is public, SECURITY DEFINER or has no fixed search_path';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'editor_export_hires_prices'
                  and column_name = 'credits_per_minute_1080p' and is_nullable = 'YES' and column_default is null
                  and numeric_precision = 10 and numeric_scale = 2) then
    raise exception '0136 end state: credits_per_minute_1080p is not numeric(10,2), nullable, without a default';
  end if;
  if (select count(*) from public.editor_export_hires_prices) <> 1 then
    raise exception '0136 end state: editor_export_hires_prices does not hold exactly one row';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.editor_export_hires_prices'::regclass
                  and conname = 'editor_export_hires_prices_numbers' and convalidated
                  and pg_get_constraintdef(oid) like '%credits_per_minute_1080p%') then
    raise exception '0136 end state: the price check does not hold the 1080p price';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select credits_per_minute_1080p is null from public.editor_export_hires_prices) as exports_up_to_1080p_still_free,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = '8f9e7d0ac4d04e7ea2cc058e5f87a12b'
--      from pg_proc where oid = 'public.request_editor_export(uuid, integer, text, numeric)'::regprocedure) as paid_overload_is_0136s;
