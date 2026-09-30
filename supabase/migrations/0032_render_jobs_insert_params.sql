-- 0032_render_jobs_insert_params.sql — "Run now" in queue mode with a voice.
--
-- 0019's render_jobs_insert policy lists the params a signed-in admin may put
-- on a "Run now" row. Since then the Create page gained three more inputs, and
-- lib/runBackend.ts (buildRenderJobInsert) sends them when they are set:
--
--   tts_model     the ElevenLabs model          (0024; checked by 0025)
--   voice_id      the narrator voice            (0025)
--   publish_hint  "Making this for:" (a hint)   (0029)
--
-- render_job_params_valid() already accepts and validates all three, but the
-- policy still refused them, so every queue-mode "Run now" with a voice, a TTS
-- model or a publish hint failed with queue_insert_failed. This recreates the
-- policy with exactly those three keys added. Nothing else changes: same
-- admin-of-the-channel's-org rule, same worker-owned columns pinned, and
-- `privacy`, `resume` and `repair_scenes` stay refused from a browser.
--
-- REQUIRES 0019 (the policy), 0025 and 0029 (render_job_params_valid with the
-- three keys). Idempotent.

do $$
begin
  if to_regprocedure('public.accessible_channel_ids(text)') is null then
    raise exception '0032 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
end $$;

drop policy if exists render_jobs_insert on public.render_jobs;
create policy render_jobs_insert on public.render_jobs
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('admin'))
    and requested_by = auth.uid()
    and kind = 'daily'
    and status = 'queued'
    and attempts = 0
    and max_attempts = 3
    and worker_id is null
    and heartbeat_at is null
    and started_at is null
    and finished_at is null
    and error is null
    and (params - array['topic','niche','duration','language','visual_style',
                        'video_provider','image_provider',
                        'tts_model','voice_id','publish_hint']) = '{}'::jsonb
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select with_check from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and policyname = 'render_jobs_insert') like '%voice_id%' as voice_allowed,
--   (select with_check from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and policyname = 'render_jobs_insert') not like '%privacy%' as privacy_still_refused;
