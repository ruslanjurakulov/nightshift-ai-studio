-- Catalog-only prerequisites, not authorization tests. No JWTs or user rows.
-- This is a NEW verification connection, not the CLI migration connection.
begin read only;
set local statement_timeout = '10s';
do $compatibility$
declare evidence jsonb;
begin
  select jsonb_build_object(
    'current_user', current_user, 'session_user', session_user,
    'superuser', (select rolsuper from pg_roles where rolname = current_user),
    'read_only', current_setting('transaction_read_only') = 'on',
    'checks', jsonb_build_object(
      'auth_users', to_regclass('auth.users') is not null,
      'auth_mfa_factors', to_regclass('auth.mfa_factors') is not null,
      'storage_buckets', to_regclass('storage.buckets') is not null,
      'storage_objects', to_regclass('storage.objects') is not null,
      'auth_uid', to_regprocedure('auth.uid()') is not null,
      'auth_role', to_regprocedure('auth.role()') is not null,
      'auth_jwt', to_regprocedure('auth.jwt()') is not null,
      'storage_foldername', to_regprocedure('storage.foldername(text)') is not null,
      'pgcrypto', exists (select 1 from pg_extension where extname = 'pgcrypto'),
      'anon', exists (select 1 from pg_roles where rolname = 'anon'),
      'authenticated', exists (select 1 from pg_roles where rolname = 'authenticated'),
      'service_role', exists (select 1 from pg_roles where rolname = 'service_role'),
      'authenticator', exists (select 1 from pg_roles where rolname = 'authenticator'),
      'supabase_auth_admin', exists (select 1 from pg_roles where rolname = 'supabase_auth_admin'),
      'supabase_storage_admin', exists (select 1 from pg_roles where rolname = 'supabase_storage_admin'),
      'storage_objects_rls', exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='storage' and c.relname='objects' and c.relrowsecurity),
      'storage_owner_preserved', exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        join pg_roles r on r.oid=c.relowner where n.nspname='storage' and c.relname='objects'
        and r.rolname='supabase_storage_admin'),
      'previews_read_policy', exists (select 1 from pg_policies
        where schemaname='storage' and tablename='objects' and policyname='previews_read')
    ),
    -- 0101 deliberately omits the link policy when this helper is absent.
    -- Expose that capability separately instead of silently assuming it works.
    'review_links', jsonb_build_object(
      'operation_helper', to_regprocedure('storage.allow_any_operation(text[])') is not null,
      'policy_present', exists (select 1 from pg_policies
        where schemaname='storage' and tablename='objects' and policyname='previews_review_link_read')
    ),
    'migration_versions', (select jsonb_agg(version order by version)
      from supabase_migrations.schema_migrations)
  ) into evidence;
  raise notice 'X6_COMPATIBILITY %', evidence;
end $compatibility$;
rollback;
