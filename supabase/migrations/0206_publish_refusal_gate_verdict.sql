-- 0206_publish_refusal_gate_verdict.sql — a missing publish-gate verdict refuses a cross-post; it never passes.
--
-- WHY. publish_request_refusal (0029) decides whether "Publish to platforms" may send a video: the insert trigger of
-- publish_requests records a refused row with its reason, and the queue worker asks it again right before anything leaves the
-- machine (modules/social_publish.py, store.refusal). Its gate check read the newest publish.allowed / publish.blocked event
-- WHERE event.video_id = the video. The pipeline emits those two events with the channel only, no video_id (main.py, the
-- publish gate block), so the check never matched anything: a gate-blocked verdict could not refuse, and a video with no
-- verdict at all passed. Ledger BR-LIVE-04 (medium).
--
-- WHAT CHANGES. Only this function. It now also reads videos.gate_verdict, the verdict the pipeline stores on the row for the
-- cut it uploaded (0112, modules/held_video.gate_verdict), with 0112's own meaning:
--   allowed = false, or any block          -> 'gate_blocked' (unchanged word)
--   no verdict, or allowed is not true     -> 'gate_unknown' (new word; unknown is never a pass, CLAUDE.md rules 2 and 5)
-- in the same place as the old check (after not_uploaded, before rejected), so every other reason keeps its order. The old
-- event check stays as it was (it is harmless and is what 0029 promised). Grants and the security-definer settings are kept.
--
-- WHAT IT DOES NOT DO. No upload path, no privacy, no approval, no switch, no other function changes. A video uploaded before
-- 0112 has no stored verdict, so it is now refused 'gate_unknown' for cross-posting. That is the point: nobody can say its gate
-- passed. Check first how many are affected:
--   select count(*) from public.videos where published_at is not null and gate_verdict is null;
--
-- Requires 0029 (the function) and 0112 (videos.gate_verdict). The body is replaced only if it is 0029's or this file's (md5 of
-- the whitespace-normalised body); anything else stops the file: read the live body first.
-- Undo: docs/sql/rollback_0206_publish_refusal_gate_verdict.sql (owner-applied).
-- APPLY AS ONE TRANSACTION.

set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.publish_request_refusal(text)') is null then
    raise exception '0206 needs publish_request_refusal: apply 0029 first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'gate_verdict') then
    raise exception '0206 needs videos.gate_verdict: apply 0112 first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h
    from pg_proc p where p.oid = to_regprocedure('public.publish_request_refusal(text)');
  if h is null or h <> all (array['154901c2887c305f6ea132f33959ee45', '99441560eed6436c1aa18409618901bd']) then
    raise exception '0206 found publish_request_refusal with a body that is neither 0029''s nor 0206''s (md5 %): read the live body first', h;
  end if;
end $$;

create or replace function public.publish_request_refusal(p_video_id text) returns text
  language plpgsql stable security definer set search_path = '' as $$
declare
  v record;
  gate text;
  two_person boolean;
begin
  select vv.video_id, vv.channel_id, vv.slug, vv.topic, vv.published_at, vv.publish_state, vv.review_state, vv.gate_verdict
    into v from public.videos vv where vv.video_id = p_video_id;
  if v.video_id is null then
    return 'video_not_found';
  end if;
  -- A held run never uploaded: the gate blocked it, or it is waiting for a
  -- human (auto-publish off), a second admin, or a review of a repaired cut.
  if v.published_at is null or coalesce(v.publish_state, 'uploaded') <> 'uploaded' then
    return 'not_uploaded';
  end if;
  select e.event into gate from public.system_events e
   where e.video_id = v.video_id and e.event in ('publish.blocked', 'publish.allowed')
   order by e.ts desc limit 1;
  if gate = 'publish.blocked' then
    return 'gate_blocked';
  end if;
  -- 0206: the gate's verdict as the pipeline stores it on the video (0112 videos.gate_verdict, held_video.gate_verdict). The
  -- event above carries no video_id (main.py emits publish.allowed/blocked with the channel only), so it never matched: a video
  -- with no verdict at all passed. No stored verdict is unknown, never a pass (CLAUDE.md rules 2 and 5).
  if (v.gate_verdict -> 'allowed') = 'false'::jsonb
     or (jsonb_typeof(v.gate_verdict -> 'blocks') = 'array' and jsonb_array_length(v.gate_verdict -> 'blocks') > 0) then
    return 'gate_blocked';
  end if;
  if (v.gate_verdict -> 'allowed') is distinct from 'true'::jsonb then
    return 'gate_unknown';
  end if;
  if v.review_state = 'rejected' then
    return 'rejected';
  end if;
  if coalesce(v.review_state, '') <> 'approved' then
    return 'not_approved';
  end if;
  select coalesce(c.agent_config ->> 'require_two_person_publish', '') = 'true' into two_person
    from public.channels c where c.channel_id = v.channel_id;
  if coalesce(two_person, false) and not exists (
    select 1 from public.publish_approvals a
     where a.channel_id = v.channel_id
       and a.status = 'approved'
       and a.decided_by is not null
       and a.decided_by is distinct from a.requested_by
       and lower(btrim(coalesce(a.video_ref, ''))) <> ''
       and lower(btrim(a.video_ref)) in (lower(coalesce(v.slug, '')), lower(coalesce(v.topic, '')))
  ) then
    return 'awaiting_two_person';
  end if;
  return null;
end
$$;
revoke all on function public.publish_request_refusal(text) from public, anon, authenticated, service_role;
grant execute on function public.publish_request_refusal(text) to service_role;

-- Verify (run after applying):
--   select public.publish_request_refusal(video_id), count(*) from public.videos where published_at is not null group by 1;
