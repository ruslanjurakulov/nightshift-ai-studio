-- tests/security/bootstrap.sql
--
-- The smallest stand-in for what a Supabase project provides before our own
-- SQL runs, so supabase/schema.sql and every migration can be applied to a
-- plain Postgres 16 (the CI `services: postgres:16` container, or a local
-- cluster) and the row-level security they declare can be attacked.
--
-- TEST-ONLY. Nothing here is applied to a real project, and the vault below
-- stores secrets in plaintext: it exists so the migrations that call Vault
-- apply and run, not to model Vault's encryption.
--
-- What is emulated, and why it is enough:
--   * the API roles anon / authenticated / service_role. service_role has
--     BYPASSRLS exactly as on Supabase; the other two are subject to RLS.
--   * Supabase's default privileges: every table / sequence / function created
--     in `public` is granted to the three API roles, and migrations narrow
--     that with explicit REVOKEs. Without this, a missing REVOKE would look
--     safe here and be a hole in production.
--   * auth.uid() / auth.jwt() / auth.role() read the `request.jwt.claims`
--     setting, as PostgREST sets it per request. The tests set it with
--     set_config(..., true) inside a transaction and SET LOCAL ROLE.
--   * auth.users with the columns our SQL reads (id, email,
--     email_confirmed_at).
--   * storage.buckets / storage.objects (RLS on, as on Supabase) and
--     storage.foldername().
--   * vault.secrets, vault.decrypted_secrets, vault.create_secret(),
--     vault.update_secret() with Supabase's signatures, and no grants to the
--     API roles (Supabase grants none either).
--   * the `supabase_realtime` publication, which schema.sql adds tables to.
-- Everything is idempotent so a local run can re-apply it.

create extension if not exists pgcrypto;

do $$ begin create role anon nologin noinherit;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

-- ── auth ────────────────────────────────────────────────────────────────────
create schema if not exists auth;
create table if not exists auth.users (
  id                 uuid primary key,
  email              text,
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant select, insert, update, delete on auth.users to service_role;

-- ── storage ─────────────────────────────────────────────────────────────────
create schema if not exists storage;
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- ── vault (plaintext stand-in) ──────────────────────────────────────────────
create schema if not exists vault;
create table if not exists vault.secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text unique,
  description text not null default '',
  secret      text not null,
  key_id      uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create or replace view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, created_at, updated_at
    from vault.secrets;
create or replace function vault.create_secret(
  new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql as $$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, coalesce(new_description, ''), new_key_id)
  returning id
$$;
create or replace function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null)
returns void language sql as $$
  update vault.secrets
     set secret      = coalesce(new_secret, secret),
         name        = coalesce(new_name, name),
         description = coalesce(new_description, description),
         key_id      = coalesce(new_key_id, key_id),
         updated_at  = now()
   where id = secret_id
$$;
revoke all on schema vault from public;
revoke all on all tables in schema vault from public;
revoke all on all functions in schema vault from public;

-- ── realtime ────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- ── Supabase's default grants in public ─────────────────────────────────────
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
