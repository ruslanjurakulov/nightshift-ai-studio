-- 0200_film_assembly_orphans.sql — Film Studio P4b: a master the assembly registered after it had lost the segment is not kept.
--
-- WHY (Breach BR-P4B-01, docs/studio/NIGHTSHIFT_AI.md "Assembly handoff")
--   The assembly (modules/film_assembly.py) registers its master, then records it with film_record_assembly. A render can outlive
--   its lease: the sweep fails the assembly at 0 past the deadline and grace, or another worker re-claims a stale segment and records
--   a failure. The late worker's file then stays live in the organization's library: a finished film nobody paid for. Its record
--   answers lease_lost, and the worker has no function that may remove the file (0171's film_discard_assets is not granted to it,
--   0038's soft_delete_asset needs a signed-in member).
--
-- WHAT IT ADDS
--   film_discard_unrecorded_assembly(segment, asset) — service role only. Soft-deletes the master the caller registered, and the
--   captions file that master's provenance names, ONLY when all of these hold, whatever the caller hands in:
--     * the segment's assembly is no longer running (completed, failed or skipped), and its recorded asset is not this file: a running
--       assembly is never touched, because a re-claimer legitimately records the same file by its id;
--     * the file is the segment's organization's, live, `generated`, registered at or after the segment was first claimed, and its own
--       provenance names this segment (film_segment_id): handing a file in never makes it a candidate;
--     * nothing else names it: no take (result, last frame, first frame, references), no other segment's assembly, no scene, no film
--       reference, no film's music, no character, no creative job.
--   Returns how many files it removed (0, 1 or 2). Additive: no existing function, table or grant changes.
--
-- LOCK ORDER: the film row (FOR NO KEY UPDATE) -> the segment (FOR UPDATE), as every 0171 function (film_lock_segment).

create or replace function public.film_discard_unrecorded_assembly(p_segment uuid, p_asset uuid) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s     public.film_segments;
  m     public.media_assets;
  ids   uuid[];
  n     integer;
begin
  if p_segment is null or p_asset is null then
    raise exception 'film_discard_unrecorded_assembly: the segment and the asset are required' using errcode = '22023';
  end if;
  s := public.film_lock_segment(p_segment, null, false);
  if s.assembly_status = 'running' or s.assembly_asset_id is not distinct from p_asset or s.claimed_at is null then
    return 0;
  end if;
  select * into m from public.media_assets a where a.id = p_asset and a.org_id = s.org_id and a.deleted_at is null;
  if not found or m.provenance ->> 'film_segment_id' is distinct from s.id::text then
    return 0;
  end if;
  ids := array[m.id];
  -- The captions file the master names, held to the same record below (its own provenance must name the segment too).
  if m.provenance ->> 'captions_asset_id' ~ '^[0-9a-fA-F-]{36}$' then
    ids := ids || (m.provenance ->> 'captions_asset_id')::uuid;
  end if;
  update public.media_assets a set deleted_at = now()
   where a.id = any (ids)
     and a.org_id = s.org_id and a.deleted_at is null and a.source = 'generated' and a.created_at >= s.claimed_at
     and a.provenance ->> 'film_segment_id' = s.id::text
     and a.id is distinct from s.assembly_asset_id
     and not exists (select 1 from public.film_takes t
                      where t.result_asset_id = a.id or t.result_last_frame_asset_id = a.id
                         or t.first_frame_asset_id = a.id or t.last_frame_asset_id = a.id)
     and not exists (select 1 from public.film_takes t where t.org_id = s.org_id and a.id = any (t.reference_asset_ids))
     and not exists (select 1 from public.film_segments g where g.assembly_asset_id = a.id)
     and not exists (select 1 from public.film_scenes sc where sc.first_frame_asset_id = a.id or sc.last_frame_asset_id = a.id)
     and not exists (select 1 from public.film_refs r where r.asset_id = a.id)
     and not exists (select 1 from public.films f where f.music_asset_id = a.id)
     and not exists (select 1 from public.character_references cr where cr.asset_id = a.id)
     and not exists (select 1 from public.creative_jobs j where j.org_id = s.org_id and a.id = any (j.result_asset_ids));
  get diagnostics n = row_count;
  if n > 0 then
    perform public.film_log(s.film_id, s.org_id, null, 'assembly_orphan_discarded',
                            jsonb_build_object('segment_id', s.id, 'asset_id', p_asset, 'removed', n));
  end if;
  return n;
end
$$;

revoke all on function public.film_discard_unrecorded_assembly(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.film_discard_unrecorded_assembly(uuid, uuid) to service_role;

comment on function public.film_discard_unrecorded_assembly(uuid, uuid) is
  'Film Studio P4b (0200): soft-deletes a master (and its captions) the assembly registered after its segment''s assembly had ended without it. Service role only.';
