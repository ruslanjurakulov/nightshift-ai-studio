-- Rollback for 0186_viral_templates.sql: removes the ten seed rows and restores 0183's four-value category CHECK.
-- Run only after confirming no owner edited these rows into something worth keeping (they are deleted by slug).
begin;
delete from public.creative_templates
 where slug in ('treasure-strike', 'object-morph', 'giant-hand-makeover', 'scale-shock', 'water-revival', 'holiday-sale-ad',
                'animated-family-story', 'sale-story-poster', 'language-duo-podcast', 'language-duo-cover');
-- Any other row that an owner later put in 'viral' would block the narrower CHECK; move it rather than lose it.
update public.creative_templates set category = 'story' where category = 'viral';
alter table public.creative_templates drop constraint if exists creative_templates_category_check;
alter table public.creative_templates add constraint creative_templates_category_check
  check (category in ('business', 'story', 'lifestyle', 'text'));
delete from supabase_migrations.schema_migrations where version = '0186';
commit;
