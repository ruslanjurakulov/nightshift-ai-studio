-- 0010_alerts.sql — durable operator alert feed.
--
-- One append-only table that records every notable operational event worth
-- telling an operator about: a run failure, a pre-publish gate BLOCK, a budget
-- ceiling hit. The web Command Center writes and reads this feed; the actual
-- fan-out to Slack / email happens where the channel secret env is present
-- (the GitHub Actions pipeline, or the "Send test" route when the webhook is
-- available in the web runtime). `delivered` records whether a send was made.
--
-- Additive and idempotent: guarded create, drop-then-create policies, safe to
-- re-run. Reads and writes are open to any authenticated user under RLS — the
-- feed is operational, not per-user; who may sign in at all is decided by the
-- app_members roster (migration 0007).

create extension if not exists pgcrypto;

create table if not exists public.alert_events (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  kind       text not null,
  severity   text not null default 'info' check (severity in ('info','warn','critical')),
  channel_id text,
  title      text not null,
  body       text,
  delivered  boolean not null default false
);

create index if not exists alert_events_at_idx on public.alert_events (at desc);

comment on table public.alert_events is
  'Durable operator alert feed — run failures, publish-gate blocks, budget ceilings. Written and read by the Command Center; delivery to Slack/email happens where the channel secret is present.';

alter table public.alert_events enable row level security;

-- Any signed-in operator may read the feed and append to it. The feed is
-- shared operational state, not per-user, so select/insert are open to all
-- authenticated; there is no update/delete policy, so rows are append-only.
drop policy if exists alert_events_select on public.alert_events;
create policy alert_events_select on public.alert_events
  for select to authenticated using (true);

drop policy if exists alert_events_insert on public.alert_events;
create policy alert_events_insert on public.alert_events
  for insert to authenticated with check (true);
