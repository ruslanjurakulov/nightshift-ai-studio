-- 0009_publish_approvals.sql — two-person publish approval.
--
-- For channels that require it, an auto-publish must be signed off by a SECOND
-- admin — never the person who requested it — before a video goes public. This
-- migration adds the record of those requests and the RLS that enforces the
-- two-person rule at the database level, so the guard holds no matter what the
-- UI shows.
--
-- Per-channel opt-in lives in the existing `channels.agent_config` jsonb under
-- `require_two_person_publish` (written from the UI, editor+); no schema change
-- is needed for that flag.
--
-- The Python pipeline consulting an approved row before it flips a video public
-- is a deliberate follow-up — this migration delivers the schema, the RLS, and
-- the UI plumbing only.
--
-- Additive and idempotent: guarded create, drop-then-create policies. Safe to
-- re-run. Does not touch any existing migration or table.

create extension if not exists pgcrypto;

create table if not exists public.publish_approvals (
  id           uuid primary key default gen_random_uuid(),
  channel_id   text not null,
  video_ref    text,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  decided_by   uuid,
  decided_at   timestamptz,
  note         text
);

comment on table public.publish_approvals is
  'Two-person publish approvals: an editor+ requests, and a SECOND admin (never the requester) approves or rejects before a video may go public. The update RLS policy enforces decided_by <> requested_by, so the two-person rule is a database guarantee, not just a UI convention.';

create index if not exists idx_publish_approvals_channel_status
  on public.publish_approvals (channel_id, status, requested_at desc);

alter table public.publish_approvals enable row level security;

-- Everyone signed in can read the approval log (no secrets here).
drop policy if exists publish_approvals_select on public.publish_approvals;
create policy publish_approvals_select on public.publish_approvals
  for select to authenticated using (true);

-- An editor or above may open a request, and only on their own behalf.
drop policy if exists publish_approvals_insert on public.publish_approvals;
create policy publish_approvals_insert on public.publish_approvals
  for insert to authenticated
  with check (
    public.app_role_rank(public.current_app_role()) >= public.app_role_rank('editor')
    and requested_by = auth.uid()
  );

-- Only an admin (or above) may decide, and the decider can NEVER be the
-- requester — this `decided_by <> requested_by` check is the two-person rule,
-- enforced by the database itself.
drop policy if exists publish_approvals_update on public.publish_approvals;
create policy publish_approvals_update on public.publish_approvals
  for update to authenticated
  using (
    public.app_role_rank(public.current_app_role()) >= public.app_role_rank('admin')
  )
  with check (
    public.app_role_rank(public.current_app_role()) >= public.app_role_rank('admin')
    and decided_by = auth.uid()
    and decided_by <> requested_by
  );
