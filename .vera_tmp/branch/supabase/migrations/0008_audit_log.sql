-- Nightshift migration 0008 — audit trail
-- ============================================================================
-- An append-only log of privileged actions in the Command Center: who did
-- what, when, against which target. It records intent (an action name plus a
-- non-secret detail blob), never the secret VALUES an action carried — callers
-- pass names only (e.g. which secret names were written), so this table is safe
-- to read by any signed-in user.
--
-- SAFETY (mirrors the contract of 0006/0007):
--   * Additive only. One new table, one index, two policies. NO drop, NO
--     rename, NO type change, NO delete of anything existing. Reversible by
--     dropping the table.
--   * Everything is `create ... if not exists` / `drop policy if exists` +
--     `create policy`, so re-running is safe.
--   * The web app holds only the ANON key and writes under RLS. The insert
--     policy pins `actor_user_id = auth.uid()`, so a user can only log AS
--     themselves — no impersonation, no forged actor. Reads are open to any
--     authenticated user (an audit trail is meant to be seen).
--   * Nothing here publishes, renders, or changes any existing table.

create extension if not exists pgcrypto;

create table if not exists public.app_audit_log (
  id             uuid primary key default gen_random_uuid(),
  at             timestamptz not null default now(),
  actor_user_id  uuid,
  actor_email    text,
  action         text not null,
  target         text,
  detail         jsonb not null default '{}'::jsonb,
  channel_id     text
);

comment on table public.app_audit_log is
  'Append-only audit trail of privileged Command Center actions. Records action name, actor, target and a non-secret detail blob — never secret values. Insert is restricted to the acting user (actor_user_id = auth.uid()); read is open to any authenticated user.';

create index if not exists idx_audit_at on public.app_audit_log (at desc);

alter table public.app_audit_log enable row level security;

-- Read: any signed-in user may see the trail.
drop policy if exists app_audit_log_select on public.app_audit_log;
create policy app_audit_log_select on public.app_audit_log
  for select to authenticated
  using (true);

-- Insert: a user may only log as themselves — the row's actor must be the caller.
drop policy if exists app_audit_log_insert on public.app_audit_log;
create policy app_audit_log_insert on public.app_audit_log
  for insert to authenticated
  with check (actor_user_id = auth.uid());
