-- 0101_review_links.sql — a PRIVATE REVIEW LINK: the owner of a channel shares a
-- view-only link to a finished video's review copy, with a client or a
-- teammate who has no account.
--
-- !!! MERGING THIS FILE TO main APPLIES IT TO THE LIVE DATABASE AUTOMATICALLY.
-- !!! It adds one storage policy FOR THE ANON ROLE on the private "previews"
-- !!! bucket (section 5). Hold the merge for the owner's approval and an
-- !!! independent security review.
--
-- WHAT IT ADDS
--   review_links        one row per link: which video, which organization, the
--                       SHA-256 of the token (never the token), who made it,
--                       when it expires, whether it was turned off, a view count.
--   review_link_hits    per-link, per-minute view counter (the rate limit).
--   create_review_link(video, days)   a member with the admin role (owner or
--                       admin) of the video's organization. days is one of
--                       1, 3, 7, 14, 30 (default 7). Returns the token ONCE;
--                       afterwards only its hash exists, so a link cannot be
--                       shown again, only replaced.
--   list_review_links(video)          the same people; never a hash or a token.
--   revoke_review_link(id)            the same people. Works at once.
--   review_link_view(token)           anyone holding the token (anon): is the
--                       link live? title and expiry, counted and rate limited.
--   review_link_object(token)         anyone holding the token: the object path
--                       of the review copy, for the Command Center's streaming
--                       route. Never returned to a browser.
--   review_link_allows(bucket, name)  the storage policy's test (below).
--
-- HOW THE VIDEO REACHES SOMEONE WITH NO ACCOUNT
--   The review copy lives in the private "previews" bucket. The Command Center
--   holds no service key (CLAUDE.md #3), so it cannot sign a URL for an
--   outsider. Instead Supabase Storage runs the object read AS THE ROLE THE
--   REQUEST ARRIVES AS and evaluates storage.objects policies; Storage also
--   publishes the request's headers to the database for the transaction
--   (set_config('request.headers', ...)). The Command Center's streaming route
--   (/r/<token>/video) makes the read as anon and passes the token in the
--   x-review-token header; the policy below lets exactly ONE object through:
--   the review copy of the video that a live link names.
--
-- WHAT THE POLICY IS NOT
--   * not a read of the bucket: without the header, or with a token that is
--     unknown, expired, revoked, or whose video's review copy was pruned, the
--     policy returns false and anon sees no row (read, list, sign — all the same
--     SELECT);
--   * not a write: SELECT only. There is still no INSERT / UPDATE / DELETE
--     policy for anon or authenticated;
--   * not a way to another channel's file: the object name must equal the
--     video's preview_path AND start with that video's own channel_id + '/',
--     and the link's organization must still own that channel;
--   * not a stored secret: the header carries the TOKEN and the function hashes
--     it, so the stored hashes cannot be turned into access if the table leaks.
--   Anyone holding a live token can read that one file straight from the Storage
--   API with the (public) anon key, not only through the Command Center. That is
--   what the token is: the capability to watch this preview, until it expires or
--   is revoked. It is not the master file, not the download, not any other video.
--
-- WHAT IS ENFORCED HERE (not in the app)
--   * the token: 256 random bits as 64 hex characters; only its SHA-256 is stored
--     (token_hash unique, ^[0-9a-f]{64}$). A wrong-shaped token is "gone", the
--     same answer as an unknown, expired or revoked one — nobody learns which;
--   * expiry (at most 30 days, never in the past) and revoke are checked on every
--     call of every function and by the policy itself;
--   * isolation: a link is bound to an organization and a video when it is made;
--     another organization's member cannot create, list or revoke it (every
--     refusal reads as "not found") and a link of organization A never resolves
--     any object of organization B;
--   * view-only: the functions return a title, an expiry and a path — never the
--     script, the master file, credit data, other videos or the organization;
--     this migration adds no approve / publish / download path;
--   * at most 10 live links per video; 30 views per link per minute;
--   * the two tables are closed to every API role (RLS on, no policy, no grant).
--
-- WHAT IT DOES NOT CHANGE
--   0098's previews_read (the channel's own people) stays exactly as it is. The
--   new policy names the bucket only INSIDE review_link_allows(bucket, name), so
--   0098's clean-up heuristic (which drops a permissive policy that names the
--   literal 'previews' without accessible_channel_ids/is_platform_admin) does
--   not touch it if 0098 is ever re-run. The strict allowlist in 0098's Verify
--   query 1 DOES list it (it is not one of 0098's own names): that is expected,
--   see Verify 2 below.
--
-- Requires 0018 (organizations, accessible_org_ids, is_org_member), 0004/0018
-- (videos, channels) and Supabase Storage. Additive and idempotent.

do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception '0101 needs the storage schema (Supabase Storage)';
  end if;
  if to_regprocedure('public.is_org_member(uuid,text)') is null
     or to_regclass('public.organizations') is null
     or to_regclass('public.channels') is null then
    raise exception '0101 needs migration 0018 (organizations, is_org_member) applied first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Tables (closed to every API role)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.review_links (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  channel_id     text not null,
  video_id       text not null references public.videos (video_id) on delete cascade,
  token_hash     text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- The language the link's maker was using: the page opens in it (null = the visitor's own).
  -- Only the SHAPE is checked, so a new language needs no migration.
  locale         text check (locale is null or locale ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_by     uuid,
  views          integer not null default 0 check (views >= 0),
  last_viewed_at timestamptz,
  constraint review_links_expiry_ok check (expires_at > created_at and expires_at <= created_at + interval '31 days')
);
create index if not exists review_links_video_idx on public.review_links (video_id, created_at desc);
comment on table public.review_links is
  '0101: private review links. token_hash is the SHA-256 of a 256-bit token that is shown once, at creation, and never stored. No API role has a privilege on this table.';
alter table public.review_links enable row level security;
revoke all on public.review_links from public, anon, authenticated;

create table if not exists public.review_link_hits (
  link_id uuid not null references public.review_links (id) on delete cascade,
  minute  timestamptz not null,
  count   integer not null default 0,
  primary key (link_id, minute)
);
comment on table public.review_link_hits is
  '0101: views per link per minute, the rate limit of review_link_view(). Written only by it.';
alter table public.review_link_hits enable row level security;
revoke all on public.review_link_hits from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Internals (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- 256 random bits as 64 hex characters. Bytes 6 and 8 of a UUID carry its
-- version and variant bits and are skipped: 14 + 14 + 4 usable bytes from three
-- gen_random_uuid() calls (a strong random source).
create or replace function public.review_link_token() returns text
  language plpgsql volatile set search_path = public, pg_temp as $$
declare
  a bytea := uuid_send(gen_random_uuid());
  b bytea := uuid_send(gen_random_uuid());
  c bytea := uuid_send(gen_random_uuid());
  out text := '';
  i integer;
begin
  for i in 0..15 loop
    continue when i in (6, 8);
    out := out || lpad(to_hex(get_byte(a, i)), 2, '0') || lpad(to_hex(get_byte(b, i)), 2, '0');
  end loop;
  -- 14 bytes from a, 14 from b = 28 bytes; 4 more from c
  for i in 0..3 loop
    out := out || lpad(to_hex(get_byte(c, i)), 2, '0');
  end loop;
  return out;
end
$$;

-- The hash that is stored and compared; null for anything that is not a token.
create or replace function public.review_link_hash(p_token text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case when p_token ~ '^[0-9a-f]{64}$'
              then encode(sha256(convert_to(p_token, 'UTF8')), 'hex') end
$$;

-- The live link for a token, with the video and review copy it names, or no row.
-- ONE definition of "live" for every reader (the page, the stream, the storage
-- policy): not revoked, not expired, the video still has a kept review copy
-- that lives in its own channel's folder, and the channel still belongs to the
-- organization the link was made in.
create or replace function public.review_link_live(p_token text)
  returns table (link_id uuid, title text, preview_path text, expires_at timestamptz, locale text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select l.id, v.title, v.preview_path, l.expires_at, l.locale
    from public.review_links l
    join public.videos v on v.video_id = l.video_id
    join public.channels c on c.channel_id = v.channel_id
   where l.token_hash = public.review_link_hash(p_token)
     and l.revoked_at is null
     and l.expires_at > now()
     and l.channel_id = v.channel_id
     and c.org_id = l.org_id
     and v.preview_path is not null
     and starts_with(v.preview_path, v.channel_id || '/')
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The owner's side
-- ───────────────────────────────────────────────────────────────────────────

-- Make a link. Returns {id, token, expires_at}; the token is not recoverable.
-- A video the caller cannot administer reads exactly like one that does not exist.
create or replace function public.create_review_link(p_video_id text, p_days integer default 7, p_locale text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid  uuid := auth.uid();
  v    record;
  tok  text;
  exp  timestamptz;
  lid  uuid;
  i    integer := 0;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_days is null or p_days not in (1, 3, 7, 14, 30) then
    raise exception 'invalid_days' using errcode = 'NS400';
  end if;
  select vd.video_id, vd.channel_id, vd.preview_path, ch.org_id
    into v
    from public.videos vd join public.channels ch on ch.channel_id = vd.channel_id
   where vd.video_id = p_video_id;
  if v.video_id is null or not public.is_org_member(v.org_id, 'admin') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.preview_path is null or not starts_with(v.preview_path, v.channel_id || '/') then
    raise exception 'no_preview' using errcode = 'NS400';
  end if;

  -- Housekeeping: links dead for a month are forgotten.
  delete from public.review_links
   where video_id = v.video_id
     and (expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days');
  if (select count(*) from public.review_links
       where video_id = v.video_id and revoked_at is null and expires_at > now()) >= 10 then
    raise exception 'limit_reached' using errcode = 'NS429';
  end if;

  exp := now() + make_interval(days => p_days);
  loop
    tok := public.review_link_token();
    begin
      insert into public.review_links (org_id, channel_id, video_id, token_hash, locale, created_by, expires_at)
      values (v.org_id, v.channel_id, v.video_id, public.review_link_hash(tok),
              case when lower(btrim(coalesce(p_locale, ''))) ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$' then lower(btrim(p_locale)) end,
              uid, exp)
      returning id into lid;
      exit;
    exception when unique_violation then
      i := i + 1;
      if i > 5 then raise; end if;
    end;
  end loop;
  return jsonb_build_object('id', lid, 'token', tok, 'expires_at', exp);
end
$$;

-- This video's links, newest first. Never a hash or a token. A video the caller
-- cannot administer gives an empty list, like a video with no links.
create or replace function public.list_review_links(p_video_id text) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'created_at', l.created_at, 'expires_at', l.expires_at,
           'revoked_at', l.revoked_at, 'views', l.views, 'last_viewed_at', l.last_viewed_at)
         order by l.created_at desc), '[]'::jsonb)
    from public.review_links l
   where l.video_id = p_video_id
     and auth.uid() is not null
     and public.is_org_member(l.org_id, 'admin')
$$;

-- Turn a link off. True when this call did it; false for a link that is
-- unknown, someone else's, or already off (indistinguishable on purpose).
create or replace function public.revoke_review_link(p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  n   integer;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  update public.review_links l
     set revoked_at = now(), revoked_by = uid
   where l.id = p_id and l.revoked_at is null and public.is_org_member(l.org_id, 'admin');
  get diagnostics n = row_count;
  return n > 0;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The viewer's side (holds only the token)
-- ───────────────────────────────────────────────────────────────────────────

-- The review page's one question. {"status":"gone"} for every kind of "no"
-- (unknown, wrong shape, expired, revoked, no kept copy); {"status":"limited"}
-- past 30 views a minute; else {"status":"ok","title","expires_at","locale"} and the
-- view is counted.
create or replace function public.review_link_view(p_token text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r    record;
  m    timestamptz := date_trunc('minute', now());
  used integer;
begin
  select * into r from public.review_link_live(p_token);
  if r.link_id is null then
    return jsonb_build_object('status', 'gone');
  end if;
  insert into public.review_link_hits as h (link_id, minute, count)
  values (r.link_id, m, 1)
  on conflict (link_id, minute) do update set count = h.count + 1
  returning h.count into used;
  if used = 1 then
    delete from public.review_link_hits h where h.link_id = r.link_id and h.minute < m - interval '1 hour';
  end if;
  if used > 30 then
    return jsonb_build_object('status', 'limited');
  end if;
  update public.review_links set views = views + 1, last_viewed_at = now() where id = r.link_id;
  return jsonb_build_object('status', 'ok', 'title', r.title, 'expires_at', r.expires_at, 'locale', r.locale);
end
$$;

-- The object path of the review copy, for the streaming route only (the route
-- never sends it on). Null for every kind of "no".
create or replace function public.review_link_object(p_token text) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select preview_path from public.review_link_live(p_token)
$$;

-- The storage policy's test: is this the previews bucket, and does the token
-- Storage was handed (the x-review-token request header) name a live link whose
-- review copy IS this object? Any problem (no header, bad JSON, no GUC) is false.
create or replace function public.review_link_allows(p_bucket text, p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  tok text;
begin
  tok := nullif(current_setting('request.headers', true), '')::json ->> 'x-review-token';
  if p_bucket is distinct from 'previews' or tok is null or p_name is null then
    return false;
  end if;
  return exists (select 1 from public.review_link_live(tok) l where l.preview_path = p_name);
exception when others then
  return false;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The storage policy (anon, SELECT, one object)
-- ───────────────────────────────────────────────────────────────────────────

drop policy if exists previews_review_link_read on storage.objects;
create policy previews_review_link_read on storage.objects
  for select to anon
  using (public.review_link_allows(bucket_id, name));

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Grants
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.review_link_token() from public, anon, authenticated, service_role;
revoke all on function public.review_link_hash(text) from public, anon, authenticated, service_role;
revoke all on function public.review_link_live(text) from public, anon, authenticated, service_role;

revoke all on function public.create_review_link(text, integer, text) from public, anon, service_role;
revoke all on function public.list_review_links(text) from public, anon, service_role;
revoke all on function public.revoke_review_link(uuid) from public, anon, service_role;
grant execute on function public.create_review_link(text, integer, text) to authenticated;
grant execute on function public.list_review_links(text) to authenticated;
grant execute on function public.revoke_review_link(uuid) to authenticated;

revoke all on function public.review_link_view(text) from public, service_role;
revoke all on function public.review_link_object(text) from public, service_role;
revoke all on function public.review_link_allows(text, text) from public, service_role;
grant execute on function public.review_link_view(text) to anon, authenticated;
grant execute on function public.review_link_object(text) to anon, authenticated;
grant execute on function public.review_link_allows(text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Verify (read-only; run in the SQL editor after applying)
-- ─────────────────────────────────────────────────────────────────────────
--   -- 1. The new storage policy. Expected: ONE row — SELECT, {anon}, PERMISSIVE,
--   --    using_expr = review_link_allows(bucket_id, name).
--   select policyname, cmd, roles::text as roles, permissive, qual as using_expr, with_check as check_expr
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname = 'previews_review_link_read';
--
--   -- 2. Everything else on storage.objects is unchanged (0098's Verify query 1,
--   --    with the new name added). Expected: 0 rows.
--   select policyname from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname not in ('avatars_delete_own', 'avatars_insert_own', 'avatars_select_own',
--                             'avatars_update_own', 'previews_read', 'previews_review_link_read',
--                             'voice_previews_read');
--
--   -- 3. No API role has a privilege on the two tables. Expected: 0 rows.
--   select grantee, table_name, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name in ('review_links', 'review_link_hits')
--      and grantee in ('anon', 'authenticated', 'public');
--
--   -- 4. Function grants. Expected: create/list/revoke_review_link -> authenticated only;
--   --    review_link_view / _object / _allows -> anon and authenticated;
--   --    review_link_token / _hash / _live -> neither.
--   select p.proname,
--          has_function_privilege('anon', p.oid, 'execute') as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and (p.proname like 'review\_link%' or p.proname like '%\_review\_link%')
--    order by 1;
--
--   -- 5. Live links by video (counts only). Expected: what the owners made.
--   select video_id, count(*) filter (where revoked_at is null and expires_at > now()) as live, count(*) as total
--     from public.review_links group by video_id order by live desc;
