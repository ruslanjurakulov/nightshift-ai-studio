-- dedupe-video-costs.sql — ONE-TIME, OWNER-APPLIED clean-up of public.video_costs
-- after migration 0106. NOT a migration: nothing runs it, and the app never
-- deletes a cost row. Paste into the Supabase SQL editor.
--
-- *** THIS SCRIPT CAN DELETE ROWS. It ends in ROLLBACK, so running it as it is
-- *** changes nothing. Read the preview, then change the last line to COMMIT.
--
-- WHEN YOU NEED IT. Before 0106 the nightly mirror re-inserted every local
-- video_costs row on each run, so a table that was ever filled holds each cost
-- once per night. The table was EMPTY when 0106 was written; if the preview
-- below shows 0 rows, there is nothing to do and you can stop here.
--
-- WHAT IT DOES (only rows whose row_key is NULL, i.e. written before 0106)
--   1. Groups them by what makes two rows "the same charge": channel_id,
--      video_id, slug, unit, stage, recorded_at, quantity (NULL and '' alike;
--      video_id is part of the group so two videos are never merged).
--   2. Keeps the row with the lowest id of each group and gives it the SAME
--      row_key the nightly mirror computes (modules/supabase_sync.py,
--      video_cost_row_key, occurrence 0): 'v1:' + sha256 of the group and '0'.
--      So the next mirror finds that row already there and ignores it.
--   3. Deletes the other rows of the group.
--   A group whose key already exists on a row written after 0106 is deleted
--   entirely: that row is the copy that counts.
--
-- WHAT YOU SHOULD KNOW BEFORE COMMITTING
--   * Two charges that really were identical in every field above (for example
--     two clips of one stage recorded in the same flush) are indistinguishable
--     from a nightly duplicate here, so the script keeps ONE. The local database
--     still has both, and the next nightly mirror sends the second one with
--     occurrence 1 (a different key), which puts it back. Nothing is lost for
--     good; the table is right after the next run.
--   * Only duplicates are removed. A row that has no twin is kept and keyed,
--     even if the local database no longer has it.
--   * Take a copy first if you want one:
--       create table public.video_costs_backup_0106 as table public.video_costs;
--     (and drop it afterwards; it is not part of the schema).
--   * Run it when no mirror is running (the nightly job is a few minutes long).
--
-- Re-running it is safe: after a commit, no NULL-key group is left to touch.
--
-- HOW TO RUN IT (three steps, in the SQL editor)
--   Step 1  the PREVIEW (section 1), alone. Read it.
--   Step 2  the APPLY block (section 2), from `begin;` to the last line, as ONE
--           run. It ends in ROLLBACK, so the first run only shows what it would
--           do. Change the last line to COMMIT; and run it again to apply.
--   Step 3  the CHECK (section 3), alone, afterwards. A statement placed after a
--           ROLLBACK/COMMIT in the same run is not guaranteed to be shown by
--           every editor, so it is kept apart.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. PREVIEW (read-only). Run this first, alone, and read it.
-- ───────────────────────────────────────────────────────────────────────────

with g as (
  select id,
         concat_ws(chr(31),
                   coalesce(channel_id, ''), coalesce(video_id, ''), coalesce(slug, ''),
                   coalesce(unit, ''), coalesce(stage, ''), coalesce(recorded_at, ''),
                   trim_scale(quantity::numeric)::text) as grp,
         estimated_usd
    from public.video_costs
   where row_key is null
), r as (
  select g.*, row_number() over (partition by grp order by id) as rn from g
)
select count(*)                                          as rows_without_key,
       count(*) filter (where rn = 1)                    as groups_kept,
       count(*) filter (where rn > 1)                    as duplicate_rows_to_delete,
       round(coalesce(sum(estimated_usd), 0)::numeric, 6)           as usd_now_counted,
       round(coalesce(sum(estimated_usd) filter (where rn = 1), 0)::numeric, 6) as usd_after_dedupe,
       count(*) filter (where estimated_usd is null)     as rows_with_no_price
  from r;

-- The ten biggest duplicate groups, for a sanity check.
with g as (
  select id, channel_id, video_id, slug, unit, stage, recorded_at, quantity
    from public.video_costs where row_key is null
)
select channel_id, video_id, slug, unit, stage, recorded_at, quantity, count(*) as copies
  from g
 group by channel_id, video_id, slug, unit, stage, recorded_at, quantity
having count(*) > 1
 order by copies desc, recorded_at desc
 limit 10;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. APPLY. Run from `begin;` to the ROLLBACK line together. It ends in ROLLBACK.
-- ───────────────────────────────────────────────────────────────────────────

begin;

create temp table _vc_plan on commit drop as
with g as (
  select id,
         concat_ws(chr(31),
                   coalesce(channel_id, ''), coalesce(video_id, ''), coalesce(slug, ''),
                   coalesce(unit, ''), coalesce(stage, ''), coalesce(recorded_at, ''),
                   trim_scale(quantity::numeric)::text) as grp
    from public.video_costs
   where row_key is null
), r as (
  select g.id, g.grp, row_number() over (partition by g.grp order by g.id) as rn,
         'v1:' || encode(sha256(convert_to(g.grp || chr(31) || '0', 'UTF8')), 'hex') as new_key
    from g
)
select r.id, r.new_key,
       (r.rn = 1 and not exists (select 1 from public.video_costs k where k.row_key = r.new_key)) as keep
  from r;

-- What it is about to do.
select count(*) filter (where keep) as rows_getting_a_key,
       count(*) filter (where not keep) as rows_deleted
  from _vc_plan;

delete from public.video_costs c
 using _vc_plan p
 where c.id = p.id and not p.keep and c.row_key is null;

update public.video_costs c
   set row_key = p.new_key
  from _vc_plan p
 where c.id = p.id and p.keep and c.row_key is null;

-- Must now read: no_key_left = 0, duplicate_keys = 0.
select (select count(*) from public.video_costs where row_key is null) as no_key_left,
       (select count(*) from (select row_key from public.video_costs where row_key is not null group by row_key having count(*) > 1) d) as duplicate_keys,
       (select count(*) from public.video_costs) as rows_now;

rollback;  -- change to COMMIT; once the numbers above are what you expect

-- ───────────────────────────────────────────────────────────────────────────
-- 3. CHECK (read-only). Run alone, after step 2. After a COMMIT it must read
--    rows_without_key = 0 and duplicate_keys = 0; after the default ROLLBACK it
--    reads exactly like the preview, because nothing changed.
-- ───────────────────────────────────────────────────────────────────────────

select (select count(*) from public.video_costs) as rows_now,
       (select count(*) from public.video_costs where row_key is null) as rows_without_key,
       (select count(*) from (select row_key from public.video_costs where row_key is not null
                               group by row_key having count(*) > 1) d) as duplicate_keys;
