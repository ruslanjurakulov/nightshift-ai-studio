-- 0001..0058 tekshiruvi (0053 mavjud emas). Bo'sh natija = hammasi bor. Faqat tekshiradi, hech narsani o'zgartirmaydi.
with col as (
  select table_name || '.' || column_name as c
  from information_schema.columns where table_schema = 'public'
),
fn as (
  select proname, pg_get_functiondef(oid) as def
  from pg_proc where pronamespace = 'public'::regnamespace and prokind = 'f'
),
pol as (
  select schemaname || '.' || tablename || '.' || policyname as p,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') as body
  from pg_policies
)
select m.migration, case when m.ok then 'bor' else 'YOQ' end as holat
from (values
  ('0001_multi_channel',            to_regclass('public.channel_credentials') is not null),
  ('0002_measurement',              to_regclass('public.retention_points') is not null),
  ('0003_shorts',                   exists (select 1 from col where c = 'videos.video_format')),
  ('0004_review',                   to_regclass('public.review_intents') is not null),
  ('0005_verified_channels',        exists (select 1 from pg_constraint where conname = 'channels_active_requires_verification')),
  ('0006_content_series',           to_regclass('public.content_series') is not null),
  ('0007_rbac',                     to_regclass('public.app_members') is not null),
  ('0008_audit_log',                to_regclass('public.app_audit_log') is not null),
  ('0009_publish_approvals',        to_regclass('public.publish_approvals') is not null),
  ('0010_alerts',                   to_regclass('public.alert_events') is not null),
  ('0011_video_scenes',             exists (select 1 from col where c = 'videos.scenes')),
  ('0012_billing',                  to_regclass('public.provider_topups') is not null),
  ('0013_video_manifest',           exists (select 1 from col where c = 'videos.manifest')),
  ('0014_learnings',                to_regclass('public.learnings') is not null),
  ('0015_scene_repair_intents',     exists (select 1 from col where c = 'review_intents.scene_id')),
  ('0016_held_videos',              exists (select 1 from col where c = 'videos.publish_state')),
  ('0017_render_jobs',              to_regclass('public.render_jobs') is not null),
  ('0018_organizations',            to_regclass('public.org_members') is not null),
  ('0019_render_jobs_org_scope',    exists (select 1 from pol where p = 'public.render_jobs.render_jobs_select' and body like '%accessible_channel_ids%')),
  ('0020_credits',                  to_regclass('public.credit_transactions') is not null),
  ('0021_credit_refunds',           to_regclass('public.payment_events') is not null),
  ('0022_channel_tokens',           to_regclass('public.channel_token_refs') is not null),
  ('0023_image_providers',          exists (select 1 from fn where proname = 'render_job_params_valid' and def like '%image_provider%')),
  ('0024_tts_model',                exists (select 1 from fn where proname = 'render_job_params_valid' and def like '%tts_model%')),
  ('0025_voice_id',                 exists (select 1 from fn where proname = 'render_job_params_valid' and def like '%voice_id%')),
  ('0026_voice_previews',           exists (select 1 from pol where p like 'storage.%.voice_previews_read')),
  ('0027_welcome_credits',          exists (select 1 from fn where proname = 'grant_welcome_credits')),
  ('0028_social_accounts',          to_regclass('public.social_account_secrets') is not null),
  ('0029_publish_targets',          to_regclass('public.publish_requests') is not null),
  ('0030_paid_downloads',           to_regclass('public.download_requests') is not null),
  ('0031_public_api',               to_regclass('public.api_ledger') is not null),
  ('0032_render_jobs_insert_params',exists (select 1 from pol where p = 'public.render_jobs.render_jobs_insert' and body like '%publish_hint%')),
  ('0033_roles_cleanup',            exists (select 1 from pol where p = 'public.provider_balances.provider_balances_select' and body like '%is_platform_admin%')),
  ('0034_plans_entitlements',       to_regclass('public.entitlement_keys') is not null),
  ('0035_model_registry',           to_regclass('public.model_registry') is not null),
  ('0036_creative_jobs',            to_regclass('public.creative_jobs') is not null),
  ('0037_provider_costs',           to_regclass('public.creative_job_costs') is not null),
  ('0038_media_assets',             to_regclass('public.media_assets') is not null),
  ('0040_api_keys_no_prefix',       exists (select 1 from pg_constraint where conname = 'api_keys_prefix_retired')),
  ('0041_run_billing_hardening',    exists (select 1 from fn where proname = 'render_jobs_terms_frozen')),
  ('0042_web_api_hardening',        to_regclass('public.welcome_credit_claims') is not null),
  ('0043_invites_accept',           exists (select 1 from fn where proname = 'accept_org_invite')),
  ('0044_media_heic',               exists (select 1 from pg_constraint where conname = 'media_assets_variants_check' and pg_get_constraintdef(oid) like '%display%')),
  ('0045_worker_status',            to_regclass('public.worker_status') is not null),
  ('0046_creative_media_inputs',    exists (select 1 from fn where proname = 'creative_job_source')),
  ('0047_style_kits_characters',    to_regclass('public.characters') is not null),
  ('0048_creative_style_inputs',    exists (select 1 from fn where proname = 'creative_style_problem')),
  ('0049_media_folders',            to_regclass('public.media_folders') is not null),
  ('0050_voice_tools',              exists (select 1 from fn where proname = 'creative_source_seconds')),
  ('0051_upload_into_folder',       exists (select 1 from col where c = 'media_uploads.folder_id')),
  ('0052_video_tools',              exists (select 1 from fn where proname = 'creative_picture_problem')),
  ('0054_editor_projects',          to_regclass('public.editor_projects') is not null and to_regclass('public.editor_exports') is not null),
  ('0055_describe_image',           exists (select 1 from fn where proname = 'creative_quantity')),
  ('0056_channel_dna',              to_regclass('public.channel_dna_characters') is not null and exists (select 1 from col where c = 'channels.dna_tone')),
  ('0057_storyboard_review',        to_regclass('public.storyboards') is not null and exists (select 1 from fn where proname = 'approve_storyboard')),
  ('0058_storyboard_edit',          exists (select 1 from fn where proname = 'save_storyboard_edits') and exists (select 1 from fn where proname = 'reopen_storyboard'))
) as m(migration, ok)
where not m.ok
order by m.migration;
