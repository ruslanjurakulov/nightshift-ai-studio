-- 0014_learnings.sql — approved learning memory.
--
-- The feedback loop already turns measured results into prompt context on its
-- own (topic scores, retention curves, A/B verdicts). This table is the slower,
-- human-in-the-loop layer on top: the pipeline PROPOSES a learning — one plain
-- sentence plus the evidence that produced it — as a `pending` row, an admin
-- approves or rejects it on the Learning page, and only `approved` rows are
-- fed forward into the topic/script prompts (modules/learning_memory.py).
-- Pending and rejected rows have no effect on any run.
--
-- Rules the schema itself holds:
--   * One row per (channel_id, dedup_key). The pipeline inserts with
--     "ignore duplicates", so a proposal that was already decided is never
--     re-opened or overwritten; a pending row's evidence may be refreshed, and
--     the pipeline's PATCH for that is filtered on status = 'pending'.
--   * The dashboard may change ONLY the decision columns (status, decided_at,
--     decided_by) — column-level grants below — so an approval can never be
--     used to rewrite the observation or its evidence.
--   * confidence is nullable: null means "not computed", never 0.
--
-- Additive and idempotent: guarded creates, drop-then-create policies, safe to
-- re-run. Reads are open to any signed-in operator; decisions require admin or
-- owner (current_app_role / app_role_rank from migration 0007). The pipeline
-- writes with the service key, which bypasses RLS.

create extension if not exists pgcrypto;

create table if not exists public.learnings (
  id          uuid primary key default gen_random_uuid(),
  channel_id  text not null,
  kind        text not null,
  dedup_key   text not null,
  observation text not null,
  evidence    jsonb not null default '{}'::jsonb,
  confidence  double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status      text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid,
  unique (channel_id, dedup_key)
);

create index if not exists learnings_channel_status_idx
  on public.learnings (channel_id, status, created_at desc);

comment on table public.learnings is
  'Learning memory: the pipeline proposes (pending) learnings from measured signals with their evidence; an admin approves or rejects; only approved rows reach the planning/script prompts.';

alter table public.learnings enable row level security;

drop policy if exists learnings_select on public.learnings;
create policy learnings_select on public.learnings
  for select to authenticated using (true);

-- Deciding: admin/owner only, recorded as themselves, and only to a decided
-- state (a decision is never "un-made" back into pending from the dashboard).
drop policy if exists learnings_decide on public.learnings;
create policy learnings_decide on public.learnings
  for update to authenticated
  using (public.app_role_rank(public.current_app_role()) >= 3)
  with check (
    public.app_role_rank(public.current_app_role()) >= 3
    and decided_by = auth.uid()
    and status in ('approved', 'rejected')
  );

-- No insert/delete policy for authenticated: proposals come only from the
-- pipeline (service key). Column-level update grant: the decision columns only.
revoke insert, delete, update on public.learnings from authenticated;
grant update (status, decided_at, decided_by) on public.learnings to authenticated;
