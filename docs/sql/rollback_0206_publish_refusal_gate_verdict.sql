-- Rollback of 0206_publish_refusal_gate_verdict.sql (owner-applied, one transaction): puts back 0029's publish_request_refusal
-- exactly, so a video with no stored gate verdict passes again (the BR-LIVE-04 gap returns). Only that function changes.
begin;

create or replace function public.publish_request_refusal(p_video_id text) returns text
  language plpgsql stable security definer set search_path = '' as $$
declare
  v record;
  gate text;
  two_person boolean;
begin
  select vv.video_id, vv.channel_id, vv.slug, vv.topic, vv.published_at, vv.publish_state, vv.review_state
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

commit;
