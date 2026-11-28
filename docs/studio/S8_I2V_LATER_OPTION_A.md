# S8 i2v sample picture: the later option (a)

Today (option b, Atlas 22 Nov) a public animation sample's link proposes the sample's starting picture, and only the
person's "Use this picture" copies it into their library (once, their own copy, `GET /api/media?mine=1` to find it again).
Option (a) would need no copy at all. It needs a migration, so it was left for later.

## Why it is possible

Every resolvable sample's starting picture is already a library asset of the operator's workspace: the i2v entry's
`input.assetId` in `command-center/lib/site/showcase.json` is the source picture entry's own `assetId`
(9283b527…, 134eac56…, 263cbf6e…), checked by `tools/export_showcase.py`.

## What blocks it today

- Quote and create require `params.source_asset_id` to be a uuid (`command-center/lib/creative/operations.ts`
  parseGenerationInput) and call `quote_creative_job` / `create_creative_job`.
- `creative_price` refuses with `source_unavailable` when `creative_source_problem` says so
  (`supabase/migrations/0046_creative_media_inputs.sql`). Its picture branch (last defined in `0100_video_ai_ops.sql`)
  requires `media_assets.org_id = p_org`.
- The worker asks `creative_job_source` (last defined in `0052_video_tools.sql`), which re-checks the source and reads the
  asset with `org_id = j.org_id`.
- `rights_acknowledgement_subjects` (`0187_rights_acknowledgement_inputs.sql`) counts the source as a file the person must
  acknowledge.
- The worker itself needs nothing: `modules/creative_worker.py` `_source` and `modules/media_library.py` `copy_source` build
  the path from the asset id alone.

## The migration (number from Atlas)

1. `public.showcase_source_assets(asset_id uuid primary key references media_assets, sample_job uuid not null, created_at)`,
   RLS on, no grants to anon or authenticated, written by the service role only (seeded, or by the export workflow through
   a service-role function). Verify block: each row is a live image of the operator's workspace.
2. `creative_source_problem`, i2v only: also accept a live operator-workspace image listed there.
3. `creative_job_source`: the same predicate for the source read (not for the end frame).
4. `rights_acknowledgement_subjects`: leave listed showcase assets out (the export vouched for them). 0187 is
   fingerprint-guarded; this is the delicate part.

The routes stay as they are: the page resolves `sample=` to `input.assetId` from the shipped data and the database list is
the authority. The panel and the job feed show the shipped poster for such a source (RLS hides another workspace's asset).

Gains: no write per visitor and the price on load. Breach should attack an unlisted operator asset, a deleted one, another
tool, and the end frame.
