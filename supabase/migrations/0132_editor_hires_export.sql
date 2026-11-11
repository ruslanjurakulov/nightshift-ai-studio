-- 0132_editor_hires_export.sql — 1440p and 4K editor exports, sold by the started output minute (owner decision 2026-11-11: offer them, give the
-- worker more render time for them, charge credits in proportion to render time; exports up to 1080p stay free). docs/HIRES_EXPORT.md.
--
-- *** LIVE ON APPLY, AND SELLS NOTHING. *** Merging this file applies it to the live database. It seeds BOTH prices as NULL, and NULL means
-- "not on sale": until the owner writes a price in the SQL editor, every request for a 1440p or a 4K export is refused (not_on_sale) before
-- anything is locked, held or written. The Command Center and the worker only offer or render these frames while NIGHTSHIFT_HIRES_EXPORT is on
-- (default off), on top of NIGHTSHIFT_MULTI_RATIO_EXPORT (0129).
--
-- WHAT IT ADDS
--   editor_exports.quoted_credits / held_credits / credit_ref / charged_credits
--                                   what a paid export costs (the charge), what was held while it waits and renders (the charge raised to
--                                   job_minimum), the hold (credit_reservations.job_id = 'ee:' || the export's id; hold and ref are null in the
--                                   operator's exempt organization), and what it was charged once it ended. Null on every free export.
--   editor_export_hires_prices      ONE row, closed to every API role (RLS on, no policy, no privilege): credits per started output minute for a
--                                   1440p frame and for a 4K frame. NULL = not on sale (the seed). Changed in the SQL editor only; a change leaves
--                                   a security_events row (kind editor.export.hires_price); the row cannot be deleted or emptied.
--   editor_export_hires_terms(w, h, length)     INTERNAL. The tier of a frame (1440p up to 2560x1440 pixels, 4K above), its longest export
--                                   (300 s / 180 s), its fastest rate (60 / 30 fps), the started minutes, the price per minute, the charge
--                                   (price x minutes, rounded up to the cent, NOT raised to job_minimum) and the hold (the charge raised to
--                                   job_minimum). A frame of at most 1920x1080 pixels is not paid and gets no tier.
--   editor_export_money(op, ref, amount)        INTERNAL. start / capture / release of an export's hold AS THE PLATFORM (the JWT claims are
--                                   cleared for the call and put back, the way creative_platform_reserve does it), so a member's session, the
--                                   worker's and the owner's all settle the same hold the same way.
--   editor_export_settle()          INTERNAL trigger, BEFORE UPDATE OF status on editor_exports, for a row that holds credits:
--                                     queued -> rendering : the hold must still be open, or the export ends here as failed (credits_released)
--                                                           and the worker that claimed it renders nothing (modules/editor_export.py);
--                                     -> done             : capture the charge (capture_credits gives the rest of the hold back), once;
--                                     -> failed           : release the hold (render failed, timed out, worker lost, project deleted,
--                                                           credits_released: every path that ends an export ends it here); a row
--                                                           that was done (captured) and is marked failed by hand keeps its charge.
--                                   Settling twice is a no-op (capture_credits and the release return what is already settled).
--   quote_editor_export(project, rev, frame)    authenticated. The server-computed quote the editor shows BEFORE a person confirms: tier, length
--                                   and rate caps, minutes, price per minute, the charge (credits) and the hold, whether the document has a
--                                   speed curve, the organization's available credits. Free frames answer paid=false.
--   request_editor_export(project, rev, frame, max_credits)
--                                   authenticated. NEW overload, four arguments, none defaulted. 0129's three-argument body BYTE FOR BYTE except
--                                   for the lines marked 0132 (a pin test takes them out and compares what is left with 0129's body). It sells
--                                   ONLY a frame above 1080p: a free frame is refused here (invalid_frame) and keeps going through 0129's function.
--                                   Lock order (0131's rule: no row lock is held while waiting for an advisory lock): it reads the project
--                                   WITHOUT a lock, checks membership and every gate, takes the organization's advisory lock, and only then
--                                   locks the project row (FOR NO KEY UPDATE) and reads it again.
--
-- WHAT IT REPLACES
--   editor_export_frame(text)       0129's closed list plus four frames, value for value schemas/export_presets.json
--                                   (tests/test_editor_export_frame_migration.py and tests/test_editor_hires_export_migration.py compare them):
--                                   youtube_1440p 2560x1440, vertical_1440p 1440x2560, youtube_2160p 3840x2160, vertical_2160p 2160x3840.
--   editor_exports_frame_shape      0129's CHECK with the pixel ceiling raised from 2560x1440 to 3840x2160 (sides still 16-4096 and even).
--   request_editor_export(project, rev)         0054's body (md5 6d37b4d75092708981c28a56879c89b4) plus the lines marked 0132: a project whose
--                                   OWN frame is above 1920x1080 pixels is refused (hires_needs_paid_export, NS400). Above 1080p is paid
--                                   (the owner's decision), so such a project is exported in a paid frame through the four-argument overload,
--                                   or after its frame is set to 1080p or smaller. Saving such a document stays allowed.
--   request_editor_export(project, rev, frame)  0129's body (md5 83456b3c70d9433ce0e21da1339198ad) plus the lines marked 0132: a frame of the list
--                                   above 1080p is refused (hires_needs_paid_export) before anything is locked. A pin test takes the marked
--                                   lines out of both and compares what is left with 0054's / 0129's bodies; an export up to 1080p is exactly
--                                   what it was: free, no credit touched. The CHECK editor_exports_hires_terms also refuses a frame row above
--                                   1080p pixels that carries no quote.
--
-- THE MONEY (0020 / 0036 unchanged; 0133's rule for a price below job_minimum)
--   * Charge: editor_export_hires_prices, credits per STARTED output minute of the tier (a 61 s video is two minutes), times the minutes,
--     rounded up to the cent, and NOT raised to job_minimum (the owner's price is the price). Both NULL on apply: nothing is sold until the
--     owner sets a number.
--   * Hold: reserve_credits refuses any hold below job_minimum, so the hold is greatest(charge, job_minimum); done captures the CHARGE only
--     (capture_credits gives the rest back in the same transaction). With job_minimum 30 and a charge of 4: 30 held while it renders, 4
--     charged. Both are on the row (quoted_credits = the charge, held_credits = the hold) and in the quote.
--   * Quote before confirm: quote_editor_export computes exactly the charge and the hold the request will use; the request takes the number
--     the person confirmed (p_max_credits, compared with the CHARGE, never the hold) and refuses a higher charge, a missing number, NaN or an
--     infinity (price_changed, NS409). A lower charge holds the lower one.
--   * Holding: creative_platform_reserve (0036) at request time, inside the request's transaction, after every limit; NS402 (the HOLD is not
--     available) becomes insufficient_credits (hold, charge and reserve_credits' detail) and the whole call rolls back: no row, no hold. A held paid export is a run
--     in progress like any paid run: it takes one of the plan's parallel runs (0034 credit_reservations_concurrency) while it waits and
--     renders, and the plan's limit refuses it as parallel_runs (NS429). The hold is STARTED at once
--     (start_credit_reservation), so reserve_credits' three-hour sweep of unstarted holds cannot return it while the export waits in the one
--     queue every organization shares; a started hold lives 24 hours (0020).
--   * Settle: the trigger above, on every path that ends an export. Capture = the charge, once, with no amount from the worker (render time is
--     what the price per minute already prices, measured per tier: docs/HIRES_EXPORT.md); release = everything. Nothing else moves a credit.
--   * Exempt organization (the operator's own): only a platform owner or admin may ask for a paid export there (as for a creative job, 0036),
--     and nothing is held (credit_ref and held_credits null, quoted_credits recorded).
--
-- THE CAPS (one export at a time for EVERY organization on the media worker: a long 4K render holds the whole queue)
--   * longest paid export: 300 s at 1440p, 180 s at 4K (hires_too_long, NS400, detail max_s=...), here, in the CHECK editor_exports_hires_terms,
--     and in modules/hires_export.py / lib/hiresExport/limits.ts (a parity test pins the three);
--   * 4K at 30 fps at most (hires_fps, NS400, detail max_fps=30), in the same three places: a 9:16 4K60 render with a cross-fade of a 16:9
--     4K60 source died "out of memory" under the worker's 2 GiB address-space limit (four runs), and passed at 30 (measured, the bundled
--     ffmpeg 7.0.2). A 60 fps project is refused for 4K, never rendered at 30 in its place (CLAUDE.md rule 4). 1440p60 passed;
--   * a document with a speed curve (a clip's speed_curve) is not sold (hires_speed_curve, NS400): editor_doc_duration does not integrate a
--     curve and the renderer does (modules/speed_ramp.py), so the length priced here would not be the length rendered. The worker also refuses
--     a paid row whose rendered length starts more minutes than were priced (hires_length_mismatch);
--   * everything of 0054 / 0129 still holds: three in flight and twenty a day per organization (each paid export counts as one), 30 minutes.
--   * a paid export is asked by an EDITOR or above (a viewer may still ask for a free one, as 0054 allows); forbidden otherwise.
--
-- ERRORS (SQLSTATE + word; command-center/lib/editor.ts mapEditorError)
--   42501 forbidden · P0002 not_found · NS400 invalid_frame | hires_too_long | hires_fps | hires_speed_curve | hires_needs_paid_export | 0054's
--   words · NS402 insufficient_credits ·
--   NS403 not_on_sale · NS409 price_changed | stale_revision | export_in_progress · NS429 daily_limit | parallel_runs
--
-- ORDER AND ROLL-OUT. Safe in either order with the Command Center and the worker (docs/HIRES_EXPORT.md). Needs 0129 (frame columns, the
-- three-argument function, the list), 0054, 0036 (creative_platform_reserve / creative_platform_release), 0020 (credits) and 0107
-- (security_event_log). Refuses (changes nothing) if the live 0054 / 0129 bodies are not the ones it knows, or if a function of one of its
-- names exists with a body that is not its own.
-- Additive and idempotent: add column if not exists, drop-then-add for its own constraints and triggers, create or replace, seed on conflict
-- do nothing (a replay never undoes the owner's price). Undo: docs/sql/rollback_0132_editor_hires_export.sql (owner-applied).
-- NUMBER. 0132: 0131 (Ads Factory) is before it, and 0133 (the brand scan, #674) was merged while this file was in review. 0133 names no object
-- of this file, and this file none of its: they apply in either order.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only). Each hash is md5 of the body with every run of white space read as one space:
--   select 'req2' fn, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.request_editor_export(uuid, integer)'::regprocedure
--   union all select 'req3', md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.request_editor_export(uuid, integer, text)'::regprocedure
--   union all select 'list', md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.editor_export_frame(text)'::regprocedure;
--   expected BEFORE:  req2 6d37b4d75092708981c28a56879c89b4 · req3 83456b3c70d9433ce0e21da1339198ad · list 1bcfdbfab6526ce7d0ba07e167f5740c
--   expected AFTER:   req2 7d27be2166d301cf392daee41dffd2e2 · req3 7722885b3bf1d32c7b9de0d101a316ee · list f44b57823aef5fb04c8be74912460c02 (the last block of this file asserts every body)
--   and none of this file's new names may exist yet (expected: no row):
--     select to_regclass('public.editor_export_hires_prices'), to_regprocedure('public.request_editor_export(uuid, integer, text, numeric)');
--
-- SETTING A PRICE (the owner, in the SQL editor; leaves a security_events row). Only once NIGHTSHIFT_HIRES_EXPORT is on in the media worker
-- (docs/HIRES_EXPORT.md): a price set while the worker's switch is off sells exports the worker then refuses (hires_off; the hold goes back).
--   update public.editor_export_hires_prices set credits_per_minute_1440p = <n>, credits_per_minute_2160p = <n>;
--   back to "not on sale": set them to null. The proposal (not applied) is in docs/HIRES_EXPORT.md.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
  fn text;
  want text;
  pair text[];
begin
  if to_regclass('public.editor_exports') is null or to_regclass('public.editor_projects') is null
     or to_regprocedure('public.request_editor_export(uuid, integer)') is null
     or to_regprocedure('public.editor_doc_problem(uuid, jsonb)') is null
     or to_regprocedure('public.editor_doc_duration(jsonb)') is null then
    raise exception '0132 needs the video editor: apply 0054_editor_projects.sql first';
  end if;
  if to_regprocedure('public.request_editor_export(uuid, integer, text)') is null
     or to_regprocedure('public.editor_export_frame(text)') is null
     or not exists (select 1 from pg_attribute where attrelid = 'public.editor_exports'::regclass and attname = 'frame_preset' and not attisdropped) then
    raise exception '0132 needs the export frames: apply 0129_editor_export_frame.sql first';
  end if;
  if to_regprocedure('public.creative_platform_reserve(uuid, text, numeric)') is null
     or to_regprocedure('public.start_credit_reservation(text, uuid)') is null
     or to_regprocedure('public.capture_credits(text, numeric, boolean)') is null
     or to_regprocedure('public.release_credits(text)') is null
     or to_regprocedure('public.credits_exempt(uuid)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null
     or to_regclass('public.credit_reservations') is null then
    raise exception '0132 needs the credits (0020) and creative_platform_reserve (0036): apply them first';
  end if;
  if to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0132 needs 0107_owner_safety.sql (security_event_log): apply it first';
  end if;
  -- The two request functions this file replaces must be the ones it was written on: 0054's / 0129's, or this file's own (a replay).
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = 'public.request_editor_export(uuid, integer)'::regprocedure;
  if h <> all (array['6d37b4d75092708981c28a56879c89b4', '7d27be2166d301cf392daee41dffd2e2']) then
    raise exception '0132 found a two-argument request_editor_export() that is neither 0054''s nor 0132''s body (md5 %): read the live body first', h;
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = 'public.request_editor_export(uuid, integer, text)'::regprocedure;
  if h <> all (array['83456b3c70d9433ce0e21da1339198ad', '7722885b3bf1d32c7b9de0d101a316ee']) then
    raise exception '0132 found a three-argument request_editor_export() that is neither 0129''s nor 0132''s body (md5 %): read the live body first', h;
  end if;
  -- The list it replaces: 0129's, or this file's own (a replay).
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = 'public.editor_export_frame(text)'::regprocedure;
  if h <> all (array['1bcfdbfab6526ce7d0ba07e167f5740c', 'f44b57823aef5fb04c8be74912460c02']) then
    raise exception '0132 found an editor_export_frame() that is neither 0129''s nor 0132''s body (md5 %): read the live body first', h;
  end if;
  -- Every name this file creates: absent, or this file's own body.
  foreach pair slice 1 in array array[
      ['public.request_editor_export(uuid, integer, text, numeric)', '9e073e6ea46645241b5b99a65b0a7f93'],
      ['public.quote_editor_export(uuid, integer, text)', '383185a2158b57dc695e4d3c26b147e7'],
      ['public.editor_export_hires_terms(integer, integer, numeric)', '31904d0cf1f8b53316c0641e89a964a4'],
      ['public.editor_export_money(text, text, numeric)', '0b9a881cd63807ef95fc726beb304a2e'],
      ['public.editor_export_settle()', 'f0f8174e28911205b265d08adb0e1f46'],
      ['public.editor_export_hires_prices_guard()', '3ceae02b0246ce2a8ec627840561b424'],
      ['public.editor_export_hires_prices_trail()', 'fffbfc847cd35cbbf793c66d140dc747']] loop
    fn := pair[1];
    want := pair[2];
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(fn);
    if h is not null and h <> want then
      raise exception '0132 found % with a body that is not this file''s (md5 %): read the live body first', fn, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. editor_exports: what a paid export was quoted, held and charged
-- ───────────────────────────────────────────────────────────────────────────

alter table public.editor_exports add column if not exists quoted_credits numeric(12,2);
alter table public.editor_exports add column if not exists held_credits numeric(12,2);
alter table public.editor_exports add column if not exists credit_ref text;
alter table public.editor_exports add column if not exists charged_credits numeric(12,2);

comment on column public.editor_exports.quoted_credits is
  'The charge of a paid (above 1080p) export: what it was quoted and confirmed at, and what done captures (migration 0132); null on every free export. Written only by request_editor_export(project, rev, frame, max_credits).';
comment on column public.editor_exports.held_credits is
  'What a paid export holds while it waits and renders: the charge raised to job_minimum (migration 0132). Null on a free export and in the exempt organization.';
comment on column public.editor_exports.credit_ref is
  'The credit hold of a paid export (credit_reservations.job_id, ''ee:'' || id; migration 0132). Null on a free export and in the exempt organization.';
comment on column public.editor_exports.charged_credits is
  'What a paid export was charged when it ended (migration 0132): the charge when done, 0 when failed. Written only by editor_export_settle().';

-- 0129's check, with the ceiling at 4K. Every row passes it (0129's was stricter), so it validates without rewriting anything.
alter table public.editor_exports drop constraint if exists editor_exports_frame_shape;
alter table public.editor_exports
  add constraint editor_exports_frame_shape check (
    (frame_preset is null and frame_width is null and frame_height is null)
    or (frame_preset is not null and frame_width is not null and frame_height is not null
        and frame_preset ~ '^[a-z0-9_]{1,32}$'
        and frame_width between 16 and 4096 and frame_height between 16 and 4096
        and frame_width % 2 = 0 and frame_height % 2 = 0
        and frame_width * frame_height <= 8294400));

-- A frame above 1080p is never free and never long: it carries its quote and fits its tier's cap (300 s up to 1440p, 180 s and 30 fps
-- above). No row before this file has a frame above 1080p (0129's list stopped there), so this validates as it is. The credit columns have
-- one shape: a hold is never below the charge.
alter table public.editor_exports drop constraint if exists editor_exports_hires_terms;
alter table public.editor_exports
  add constraint editor_exports_hires_terms check (
    (frame_width is null or frame_width * frame_height <= 2073600
     or (quoted_credits is not null
         and duration_s <= case when frame_width * frame_height <= 3686400 then 300 else 180 end
         and case when frame_width * frame_height <= 3686400 then true
                  when jsonb_typeof(doc -> 'fps') = 'number' then (doc ->> 'fps')::numeric <= 30
                  else true end))
    and (quoted_credits is null or quoted_credits >= 0)
    and (credit_ref is null or (quoted_credits is not null and credit_ref = 'ee:' || id::text))
    and (credit_ref is null or held_credits is not null)
    and (held_credits is null or (credit_ref is not null and held_credits >= quoted_credits))
    and (charged_credits is null or (quoted_credits is not null and charged_credits >= 0 and charged_credits <= quoted_credits)));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The owner's prices: one row, no API role has any privilege on it
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.editor_export_hires_prices (
  id                       boolean primary key default true,
  credits_per_minute_1440p numeric(10,2),
  credits_per_minute_2160p numeric(10,2),
  updated_at               timestamptz not null default now()
);

alter table public.editor_export_hires_prices drop constraint if exists editor_export_hires_prices_one_row;
alter table public.editor_export_hires_prices add constraint editor_export_hires_prices_one_row check (id);
alter table public.editor_export_hires_prices drop constraint if exists editor_export_hires_prices_numbers;
alter table public.editor_export_hires_prices add constraint editor_export_hires_prices_numbers
  check ((credits_per_minute_1440p is null or credits_per_minute_1440p between 0.01 and 10000)
         and (credits_per_minute_2160p is null or credits_per_minute_2160p between 0.01 and 10000));

comment on table public.editor_export_hires_prices is
  'One row (migration 0132): credits per started output minute of a 1440p and of a 4K editor export. NULL = not on sale (the seed). Read only by the export functions; changed in the SQL editor only, and a trigger leaves a mark in security_events.';

-- NULL, NULL: nothing is sold until the owner sets a price. A replay never undoes one.
insert into public.editor_export_hires_prices (id) values (true) on conflict (id) do nothing;

alter table public.editor_export_hires_prices enable row level security;
revoke all on public.editor_export_hires_prices from public, anon, authenticated, service_role;

-- The row is edited, never deleted or emptied: a missing row reads as "not on sale", which is the safe direction, but the owner would not see
-- why the prices stopped applying.
create or replace function public.editor_export_hires_prices_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'editor_export_hires_prices keeps its one row' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists editor_export_hires_prices_guard on public.editor_export_hires_prices;
create trigger editor_export_hires_prices_guard
  before update or delete on public.editor_export_hires_prices
  for each row execute function public.editor_export_hires_prices_guard();
drop trigger if exists editor_export_hires_prices_no_truncate on public.editor_export_hires_prices;
create trigger editor_export_hires_prices_no_truncate
  before truncate on public.editor_export_hires_prices
  for each statement execute function public.editor_export_hires_prices_guard();

-- A change of a price leaves a security_events row. It never fails the change it observes: the owner must always be able to stop selling.
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

drop trigger if exists editor_export_hires_prices_trail on public.editor_export_hires_prices;
create trigger editor_export_hires_prices_trail
  after update on public.editor_export_hires_prices
  for each row execute function public.editor_export_hires_prices_trail();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The closed list, now with 1440p and 4K (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- schemas/export_presets.json, id for id and pixel for pixel (a test compares the two; a new format is a new migration, on purpose). No row
-- for anything else, null included. The first five rows are 0129's, unchanged.
create or replace function public.editor_export_frame(p_frame text)
  returns table (id text, width integer, height integer)
  language sql immutable set search_path = public, pg_temp as $$
  select v.id, v.width, v.height
    from (values ('youtube_1080p', 1920, 1080),
                 ('youtube_720p', 1280, 720),
                 ('vertical_1080p', 1080, 1920),
                 ('square_1080', 1080, 1080),
                 ('feed_4x5_1080', 1080, 1350),
                 ('youtube_1440p', 2560, 1440),
                 ('vertical_1440p', 1440, 2560),
                 ('youtube_2160p', 3840, 2160),
                 ('vertical_2160p', 2160, 3840)) as v (id, width, height)
   where v.id = p_frame
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The terms of a frame, and the money of one export (internal)
-- ───────────────────────────────────────────────────────────────────────────

-- What a frame of p_width x p_height costs for a video of p_duration seconds. Up to 1920x1080 pixels (either way up): not paid, no tier.
-- Up to 2560x1440: the 1440p tier (300 s at most, any rate). Above: the 4K tier (180 s at most, 30 fps at most: a cross-faded 9:16 4K60
-- render ran out of the worker's 2 GiB address space, measured; docs/HIRES_EXPORT.md). The charge ('credits') is the price per started
-- minute times the minutes, rounded up to the cent, and NOT raised to the platform's job minimum; the hold ('hold') is the charge raised to
-- it (reserve_credits refuses a hold below it; done captures the charge and gives the rest back). Both null while the tier's price is null
-- (not on sale).
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

-- start / capture / release of an export's hold as the platform: 0020's functions answer only a trusted caller, and an export's hold is
-- settled from a member's session (a deleted project), the worker's (finish, claim) or the owner's alike. The claims are put back after the
-- call, also when it raises. 0 when there is no such hold.
create or replace function public.editor_export_money(p_op text, p_ref text, p_amount numeric) returns numeric
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  saved text := current_setting('request.jwt.claims', true);
  org   uuid;
  out_  numeric;
begin
  select r.org_id into org from public.credit_reservations r where r.job_id = p_ref;
  if p_ref is null or org is null then
    return 0;
  end if;
  perform set_config('request.jwt.claims', '', true);
  begin
    if p_op = 'start' then
      out_ := public.start_credit_reservation(p_ref, org);
    elsif p_op = 'capture' then
      out_ := public.capture_credits(p_ref, p_amount, false);
    elsif p_op = 'release' then
      out_ := public.release_credits(p_ref);
    else
      raise exception 'editor_export_money: unknown operation' using errcode = '22023';
    end if;
  exception when others then
    perform set_config('request.jwt.claims', coalesce(saved, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(saved, ''), true);
  return coalesce(out_, 0);
end
$$;

-- Every way an export ends goes through an UPDATE of its status (finish_editor_export, claim_editor_export's lost-worker sweep,
-- delete_editor_project, the owner's hand), so the hold is settled here and nowhere else.
create or replace function public.editor_export_settle() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  hold text;
begin
  if new.credit_ref is null or new.status is not distinct from old.status then
    return new;
  end if;
  if old.status = 'queued' and new.status = 'rendering' then
    -- A hold that is no longer open (expired, released by hand) must not be rendered for nothing: the claim hands the worker a row that has
    -- already ended, and the worker renders only a row that is 'rendering'.
    select r.status into hold from public.credit_reservations r where r.job_id = new.credit_ref;
    if hold is distinct from 'open' then
      new.status := 'failed';
      new.reason := 'credits_released';
      new.finished_at := now();
      new.charged_credits := 0;
    end if;
    return new;
  end if;
  if new.status = 'done' then
    -- The charge, never the hold and never a number from the worker: capture_credits gives the rest of the hold back.
    new.charged_credits := public.editor_export_money('capture', new.credit_ref, new.quoted_credits);
  elsif new.status = 'failed' then
    if old.status = 'done' then
      -- A finished export marked failed by hand keeps what it was charged: the hold was captured, and the release below would give back
      -- nothing. Only a refund by hand in the ledger gives captured credits back.
      new.charged_credits := old.charged_credits;
    else
      perform public.editor_export_money('release', new.credit_ref, null);
      new.charged_credits := 0;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists editor_exports_settle on public.editor_exports;
create trigger editor_exports_settle
  before update of status on public.editor_exports
  for each row execute function public.editor_export_settle();

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The quote a person sees before confirming
-- ───────────────────────────────────────────────────────────────────────────

-- The same gates as a request up to the length (sign-in, membership, the list, the revision, the document), then the terms of that frame
-- for this document: the charge ('credits') and the hold ('hold'), and whether the document has a speed curve (not sold: the request
-- refuses it as hires_speed_curve). 'available' is compared with the HOLD. Read-only. A free frame answers paid=false and nothing else
-- about money.
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

-- ───────────────────────────────────────────────────────────────────────────
-- 6. request_editor_export — four arguments: 0129's function plus the hold, for a frame above 1080p only
-- ───────────────────────────────────────────────────────────────────────────

-- Queue a render of revision p_rev in the paid frame p_frame for the charge the person confirmed (p_max_credits), holding the charge raised to
-- job_minimum. Everything not marked 0132 is 0129's three-argument function, line for line.
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
  -- 0132 read WITHOUT a lock: the row is locked only after the organization's advisory lock below (0131's order: no row lock is held
  -- 0132 while waiting for an advisory lock), and read again then.
  select * into p from public.editor_projects where id = p_project;   -- 0132 replaces: select * into p from public.editor_projects where id = p_project for update;
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
  -- 0132 only now the project's row, and read again under the lock: a save or a delete in between is refused, never exported.
  select * into p from public.editor_projects where id = p_project for no key update;   -- 0132
  if not found or p.deleted_at is not null then   -- 0132
    raise exception 'not_found' using errcode = 'P0002';   -- 0132
  end if;   -- 0132
  if p.rev <> p_rev then   -- 0132
    raise exception 'stale_revision' using errcode = 'NS409', detail = format('current=%s', p.rev);   -- 0132
  end if;   -- 0132
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

-- ───────────────────────────────────────────────────────────────────────────
-- 6b. request_editor_export — two and three arguments: above 1080p is never free
-- ───────────────────────────────────────────────────────────────────────────

-- 0054's two-argument function, line for line, plus the lines marked 0132: a project whose own frame is above 1080p is refused
-- (hires_needs_paid_export). create or replace keeps 0054's grants.
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

-- 0129's three-argument function, line for line, plus the lines marked 0132: a paid frame of the list is refused (hires_needs_paid_export)
-- before anything is locked. create or replace keeps 0129's grants.
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

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Privileges: the overload and the quote for signed-in members, everything else for nobody
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.editor_export_frame(text) from public, anon, authenticated, service_role;
revoke all on function public.editor_export_hires_terms(integer, integer, numeric) from public, anon, authenticated, service_role;
revoke all on function public.editor_export_money(text, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.editor_export_settle() from public, anon, authenticated, service_role;
revoke all on function public.editor_export_hires_prices_guard() from public, anon, authenticated, service_role;
revoke all on function public.editor_export_hires_prices_trail() from public, anon, authenticated, service_role;
revoke all on function public.quote_editor_export(uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.request_editor_export(uuid, integer, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.quote_editor_export(uuid, integer, text) to authenticated;
grant execute on function public.request_editor_export(uuid, integer, text, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. End state (raises, and so rolls the whole file back, if anything is not as written above)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  req2  regprocedure := 'public.request_editor_export(uuid, integer)'::regprocedure;
  req3  regprocedure := 'public.request_editor_export(uuid, integer, text)'::regprocedure;
  req4  regprocedure := 'public.request_editor_export(uuid, integer, text, numeric)'::regprocedure;
  quote regprocedure := 'public.quote_editor_export(uuid, integer, text)'::regprocedure;
  lst   regprocedure := 'public.editor_export_frame(text)'::regprocedure;
  terms regprocedure := 'public.editor_export_hires_terms(integer, integer, numeric)'::regprocedure;
  money regprocedure := 'public.editor_export_money(text, text, numeric)'::regprocedure;
  settle regprocedure := 'public.editor_export_settle()'::regprocedure;
  guard regprocedure := 'public.editor_export_hires_prices_guard()'::regprocedure;
  trail regprocedure := 'public.editor_export_hires_prices_trail()'::regprocedure;
  role_name text;
  priv text;
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req2) <> '7d27be2166d301cf392daee41dffd2e2'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req3) <> '7722885b3bf1d32c7b9de0d101a316ee'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = req4) <> '9e073e6ea46645241b5b99a65b0a7f93'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = quote) <> '383185a2158b57dc695e4d3c26b147e7'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = lst) <> 'f44b57823aef5fb04c8be74912460c02'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = terms) <> '31904d0cf1f8b53316c0641e89a964a4'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = money) <> '0b9a881cd63807ef95fc726beb304a2e'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = settle) <> 'f0f8174e28911205b265d08adb0e1f46'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = guard) <> '3ceae02b0246ce2a8ec627840561b424'
     or (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = trail) <> 'fffbfc847cd35cbbf793c66d140dc747' then
    raise exception '0132 end state: a function does not hold the body this file expects';
  end if;
  if (select count(*) from pg_proc where proname = 'request_editor_export' and pronamespace = 'public'::regnamespace) <> 3 then
    raise exception '0132 end state: request_editor_export() does not have exactly three overloads';
  end if;
  -- The two callables are for signed-in members only; the two older ones keep 0054's / 0129's grants (create or replace); the rest is nobody's.
  if not (has_function_privilege('authenticated', req4, 'EXECUTE') and has_function_privilege('authenticated', quote, 'EXECUTE')
          and has_function_privilege('authenticated', req3, 'EXECUTE') and has_function_privilege('authenticated', req2, 'EXECUTE')) then
    raise exception '0132 end state: a signed-in member cannot call the export functions';
  end if;
  foreach role_name in array array['anon', 'service_role'] loop
    if has_function_privilege(role_name, req4, 'EXECUTE') or has_function_privilege(role_name, quote, 'EXECUTE')
       or has_function_privilege(role_name, req3, 'EXECUTE') or has_function_privilege(role_name, req2, 'EXECUTE') then
      raise exception '0132 end state: % can call an export request or the quote', role_name;
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(role_name, lst, 'EXECUTE') or has_function_privilege(role_name, terms, 'EXECUTE')
       or has_function_privilege(role_name, money, 'EXECUTE') or has_function_privilege(role_name, settle, 'EXECUTE')
       or has_function_privilege(role_name, guard, 'EXECUTE') or has_function_privilege(role_name, trail, 'EXECUTE') then
      raise exception '0132 end state: % can call an internal function', role_name;
    end if;
  end loop;
  if exists (select 1 from pg_proc p where p.oid in (req4, quote, lst, terms, money, settle, guard, trail)
              and (p.proacl is null
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')
                   or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception '0132 end state: a function is public or has no fixed search_path';
  end if;
  if not ((select prosecdef from pg_proc where oid = req4) and (select prosecdef from pg_proc where oid = quote)
          and (select prosecdef from pg_proc where oid = money) and (select prosecdef from pg_proc where oid = settle)
          and (select prosecdef from pg_proc where oid = trail))
     or (select prosecdef from pg_proc where oid = lst) or (select prosecdef from pg_proc where oid = terms)
     or (select prosecdef from pg_proc where oid = guard) then
    raise exception '0132 end state: a function is or is not SECURITY DEFINER against this file';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'editor_exports'
         and column_name in ('quoted_credits', 'held_credits', 'credit_ref', 'charged_credits') and is_nullable = 'YES' and column_default is null) <> 4 then
    raise exception '0132 end state: the four credit columns are not all there, nullable and without a default';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.editor_exports'::regclass and contype = 'c' and convalidated
        and conname in ('editor_exports_frame_shape', 'editor_exports_hires_terms')) <> 2 then
    raise exception '0132 end state: a check of editor_exports is missing or not validated';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.editor_exports'::regclass and tgname = 'editor_exports_settle'
                   and tgfoid = settle and tgenabled = 'O') then
    raise exception '0132 end state: the settling trigger is missing or disabled';
  end if;
  -- The closed list answers for its nine ids and for nothing else.
  if (select count(*) from unnest(array['youtube_1080p', 'youtube_720p', 'vertical_1080p', 'square_1080', 'feed_4x5_1080',
                                         'youtube_1440p', 'vertical_1440p', 'youtube_2160p', 'vertical_2160p']) i,
                            public.editor_export_frame(i) f) <> 9
     or exists (select 1 from unnest(array[null, '', ' youtube_2160p', 'YOUTUBE_2160P', '3840x2160', 'project', 'youtube_4k']) i,
                              public.editor_export_frame(i) f) then
    raise exception '0132 end state: the closed list of frames is not the nine formats';
  end if;
  -- The owner's prices: one row, RLS on, no policy, no privilege for any API role, both triggers there.
  if (select count(*) from public.editor_export_hires_prices) <> 1 then
    raise exception '0132 end state: editor_export_hires_prices does not hold exactly one row';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.editor_export_hires_prices'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.editor_export_hires_prices'::regclass) then
    raise exception '0132 end state: editor_export_hires_prices must have row level security and no policy';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    foreach priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege(role_name, 'public.editor_export_hires_prices', priv) then
        raise exception '0132 end state: % holds % on editor_export_hires_prices', role_name, priv;
      end if;
    end loop;
    -- editor_exports stays SELECT-only for them (0054), the new columns included.
    foreach priv in array array['insert', 'update', 'delete', 'truncate'] loop
      if has_table_privilege(role_name, 'public.editor_exports', priv)
         or has_column_privilege(role_name, 'public.editor_exports', 'quoted_credits', 'update')
         or has_column_privilege(role_name, 'public.editor_exports', 'credit_ref', 'update')
         or has_column_privilege(role_name, 'public.editor_exports', 'charged_credits', 'update') then
        raise exception '0132 end state: % can write editor_exports', role_name;
      end if;
    end loop;
  end loop;
  if (select count(*) from pg_trigger where tgrelid = 'public.editor_export_hires_prices'::regclass and not tgisinternal
        and tgname in ('editor_export_hires_prices_guard', 'editor_export_hires_prices_no_truncate', 'editor_export_hires_prices_trail')) <> 3 then
    raise exception '0132 end state: a trigger of editor_export_hires_prices is missing';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.editor_export_hires_prices'::regclass and contype = 'c' and convalidated
        and conname in ('editor_export_hires_prices_one_row', 'editor_export_hires_prices_numbers')) <> 2 then
    raise exception '0132 end state: the checks of editor_export_hires_prices are missing or not validated';
  end if;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select credits_per_minute_1440p is null and credits_per_minute_2160p is null from public.editor_export_hires_prices) as nothing_on_sale_yet,
--   has_function_privilege('authenticated', 'public.request_editor_export(uuid,integer,text,numeric)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.request_editor_export(uuid,integer,text,numeric)', 'EXECUTE') as paid_overload_scoped,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = '7722885b3bf1d32c7b9de0d101a316ee'
--      from pg_proc where oid = 'public.request_editor_export(uuid, integer, text)'::regprocedure) as free_frames_refuse_paid_ones,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = '7d27be2166d301cf392daee41dffd2e2'
--      from pg_proc where oid = 'public.request_editor_export(uuid, integer)'::regprocedure) as own_frame_above_1080p_refused,
--   not has_table_privilege('authenticated', 'public.editor_export_hires_prices', 'SELECT') as prices_closed;
--
-- Paid exports so far, and what they were charged (the ledger is credit_transactions, job_id 'ee:<export id>'):
--   select frame_preset, status, count(*), sum(quoted_credits), sum(held_credits), sum(charged_credits) from public.editor_exports
--    where quoted_credits is not null group by 1, 2 order by 1, 2;
