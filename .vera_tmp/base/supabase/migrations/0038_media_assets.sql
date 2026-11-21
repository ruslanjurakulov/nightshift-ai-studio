-- 0038_media_assets.sql — the media library: one row per stored image, video,
-- audio file or caption track, uploads that never trust the browser, and a
-- per-organization storage quota.
--
-- WHERE THE BYTES LIVE
--   Masters live on the Hetzner server's disk, in the compose volume `media`
--   (deploy/docker-compose.yml): written by the worker, mounted read-only into
--   the web container. Supabase Storage is NOT used for them — its free tier
--   caps an object at 50 MB and the project at 1 GB (CLAUDE.md, Known
--   ceilings). `storage` keeps a 'supabase' value for small derived files a
--   later PR may put there; nothing in this migration writes it.
--
--   The path of an asset's files is derived from its id and NOTHING else:
--   storage_key is a generated column, '<first two hex chars>/<uuid>', so no
--   filename, org name or client-supplied string can ever become part of a
--   path on the server (modules/media_library.py and lib/server/media.ts
--   build the same path from the id alone and refuse anything else).
--
-- WHAT IT ADDS
--   media_storage_settings  one row: the default per-org quota, the largest
--                           single upload, how many uploads an org may have in
--                           flight, how long an upload ticket lives. The
--                           platform owner changes it with an UPDATE in the SQL
--                           editor; no deploy.
--   org_storage_quota       per organization: limit_bytes (null = the default
--                           above) and used_bytes (what its live and not-yet-
--                           purged assets occupy on disk, originals plus
--                           thumbnails / proxies).
--   media_assets            the library. Written only by register_asset()
--                           (service role: the worker) and soft_delete_asset()
--                           (a member of the asset's organization).
--   media_uploads           upload tickets: requested -> receiving -> uploaded
--                           -> ingesting -> ingested | rejected | expired.
--                           Created only by request_upload(); the bytes they
--                           reserve count against the quota until ingest ends.
--
-- THE UPLOAD FLOW (no step trusts the browser's path, name, type or size)
--   1. request_upload(org, filename, mime, bytes)   signed-in member of org.
--      Checks membership, the type allowlist (the declared type AND the
--      filename's extension must name the same kind of media), the size cap,
--      the in-flight cap and the quota (used + in flight + this <= limit), under
--      a row lock on the org's quota row so two parallel requests cannot both
--      squeeze under it. Returns a ticket id. The filename is kept only as a
--      display label, cut to its last path segment, control characters removed.
--   2. The Command Center route PUT /api/media/uploads/<ticket> calls
--      begin_upload_receive(ticket) (only the person who asked, only once),
--      streams the body into the `media_staging` volume as <ticket>.upload —
--      a name built from the ticket id alone — refusing anything past the
--      declared size, then finish_upload_receive(ticket, bytes, ok).
--   3. The worker claims it (claim_media_upload), sniffs the type from the
--      CONTENT (not the extension, not the declared type), ffprobes it with
--      the demuxer forced to that type, hashes it, makes a thumbnail / proxy,
--      copies it to media/<storage_key>/, and calls register_asset() — or
--      reject_media_upload() with a reason word. Nothing uploaded is served
--      before ingest.
--
-- SERVING is not the database's job: the Command Center reads the row through
-- RLS under the member's session, then hands out a short-lived HMAC-signed
-- URL bound to (asset id, variant, expiry) — MEDIA_URL_SECRET, web env only.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser, via the anon key)
--   media_assets            select: members of the org, live rows only · nothing else
--   media_uploads           select: members of the org · nothing else
--   org_storage_quota       select: members of the org · nothing else
--   media_storage_settings  select: signed-in users (the size cap is shown) · nothing else
--   request_upload, begin_upload_receive, finish_upload_receive,
--   soft_delete_asset       authenticated (each checks membership itself)
--   register_asset, claim_media_upload, reject_media_upload,
--   claim_media_purge, mark_asset_purged   service role only
--   anon gets nothing.
--
-- INDEPENDENT of 0035-0037 (model registry, creative jobs, provider costs):
-- job, model and project references are text / jsonb / a bare uuid with no
-- foreign key, so this applies on its own and before or after them.
--
-- REQUIRES 0018 (organizations) and 0020 (credits_trusted_caller). Additive and
-- idempotent: guarded creates, create-or-replace functions, drop-then-create
-- policies, a settings row inserted on conflict do nothing.

do $$
begin
  if to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0038 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credits_trusted_caller()') is null then
    raise exception '0038 needs credits_trusted_caller(): apply 0020_credits.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Types: the one allowlist, and the extension -> type map
-- ───────────────────────────────────────────────────────────────────────────

-- The kind of an allowed MIME type, or null. SVG, HTML, PDF, archives and
-- executables are absent on purpose: nothing that a browser would execute or
-- that is not media gets a row. modules/media_library.py ALLOWED_MIME mirrors
-- this list (tests/test_media_library.py pins them equal).
create or replace function public.media_mime_kind(p_mime text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case p_mime
    when 'image/jpeg' then 'image'
    when 'image/png' then 'image'
    when 'image/webp' then 'image'
    when 'image/gif' then 'image'
    when 'video/mp4' then 'video'
    when 'video/quicktime' then 'video'
    when 'video/webm' then 'video'
    when 'video/x-matroska' then 'video'
    when 'audio/mpeg' then 'audio'
    when 'audio/mp4' then 'audio'
    when 'audio/wav' then 'audio'
    when 'audio/ogg' then 'audio'
    when 'audio/flac' then 'audio'
    when 'audio/aac' then 'audio'
    when 'audio/webm' then 'audio'
    when 'text/vtt' then 'caption'
    when 'application/x-subrip' then 'caption'
  end
$$;

-- The type a filename extension stands for (lower case, no dot), or null.
create or replace function public.media_ext_mime(p_ext text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case lower(coalesce(p_ext, ''))
    when 'jpg' then 'image/jpeg'
    when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png'
    when 'webp' then 'image/webp'
    when 'gif' then 'image/gif'
    when 'mp4' then 'video/mp4'
    when 'm4v' then 'video/mp4'
    when 'mov' then 'video/quicktime'
    when 'webm' then 'video/webm'
    when 'mkv' then 'video/x-matroska'
    when 'mp3' then 'audio/mpeg'
    when 'm4a' then 'audio/mp4'
    when 'wav' then 'audio/wav'
    when 'ogg' then 'audio/ogg'
    when 'oga' then 'audio/ogg'
    when 'flac' then 'audio/flac'
    when 'aac' then 'audio/aac'
    when 'vtt' then 'text/vtt'
    when 'srt' then 'application/x-subrip'
  end
$$;

-- A display label from whatever the browser called the file: the last path
-- segment only, control characters (NUL included, should one survive
-- PostgREST) removed, leading dots removed, at most 200 characters. It is a
-- LABEL — no code builds a path from it.
create or replace function public.media_clean_name(p_name text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(nullif(left(btrim(regexp_replace(regexp_replace(
           regexp_replace(coalesce(p_name, ''), '^.*[/\\]', ''),
           '[[:cntrl:]]', '', 'g'), '^[.[:space:]]+', '')), 200), ''), 'upload')
$$;

-- The declared type, normalized: browser aliases folded to the allowlist's
-- spelling, and an empty / generic type taken from the extension (browsers
-- send '' for .srt, .vtt and often .mkv).
create or replace function public.media_normalize_mime(p_mime text, p_name text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case m
    when 'image/jpg' then 'image/jpeg'
    when 'image/pjpeg' then 'image/jpeg'
    when 'video/x-m4v' then 'video/mp4'
    when 'audio/x-wav' then 'audio/wav'
    when 'audio/wave' then 'audio/wav'
    when 'audio/vnd.wave' then 'audio/wav'
    when 'audio/mp3' then 'audio/mpeg'
    when 'audio/x-mp3' then 'audio/mpeg'
    when 'audio/mpeg3' then 'audio/mpeg'
    when 'audio/x-m4a' then 'audio/mp4'
    when 'audio/m4a' then 'audio/mp4'
    when 'audio/x-flac' then 'audio/flac'
    when 'audio/x-aac' then 'audio/aac'
    when 'text/srt' then 'application/x-subrip'
    when 'application/srt' then 'application/x-subrip'
    when '' then public.media_ext_mime(substring(p_name from '\.([A-Za-z0-9]{1,5})$'))
    when 'application/octet-stream' then public.media_ext_mime(substring(p_name from '\.([A-Za-z0-9]{1,5})$'))
    else m
  end
  from (select lower(btrim(split_part(coalesce(p_mime, ''), ';', 1))) as m) x
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Settings and quota
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.media_storage_settings (
  id                  boolean primary key default true check (id),
  -- 5 GiB per organization unless org_storage_quota.limit_bytes says otherwise.
  default_quota_bytes bigint not null default 5368709120 check (default_quota_bytes >= 0),
  -- 95 MiB: the site is behind Cloudflare, whose Free and Pro plans refuse a
  -- request body over 100 MB, and an upload is one request. Raising this
  -- without a larger Cloudflare limit makes big uploads fail at the edge.
  max_upload_bytes    bigint not null default 99614720
                      check (max_upload_bytes > 0 and max_upload_bytes <= 10737418240),
  max_pending_uploads integer not null default 10 check (max_pending_uploads between 1 and 1000),
  ticket_ttl_minutes  integer not null default 60 check (ticket_ttl_minutes between 5 and 1440),
  -- Everything every organization stores or has in flight, together: one
  -- server's disk (the AX42 has ~512 GB usable, shared with renders). Ten
  -- organizations per account times any number of sign-ups must not be able
  -- to fill it. 300 GiB until the owner says otherwise.
  max_total_bytes     bigint not null default 322122547200 check (max_total_bytes > 0),
  updated_at          timestamptz not null default now()
);

insert into public.media_storage_settings (id) values (true) on conflict (id) do nothing;

comment on table public.media_storage_settings is
  'Media library limits (migration 0038): the default per-org quota, the largest single upload, uploads in flight per org, upload ticket lifetime. One row; changed by the platform owner in the SQL editor.';

create table if not exists public.org_storage_quota (
  org_id      uuid primary key references public.organizations (id) on delete cascade,
  -- null = media_storage_settings.default_quota_bytes.
  limit_bytes bigint check (limit_bytes is null or limit_bytes >= 0),
  used_bytes  bigint not null default 0 check (used_bytes >= 0),
  updated_at  timestamptz not null default now()
);

comment on table public.org_storage_quota is
  'Media storage per organization (migration 0038): limit_bytes (null = the default in media_storage_settings) and used_bytes (live and not-yet-purged assets, originals plus thumbnails and proxies). Moved only by register_asset / mark_asset_purged.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. media_assets
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.media_assets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  -- creative_projects (0039) does not exist yet: a bare uuid, no foreign key.
  project_id      uuid,
  kind            text not null check (kind in ('image', 'video', 'audio', 'caption')),
  storage         text not null default 'local' check (storage in ('local', 'supabase')),
  -- Derived from the id alone; nobody can write it.
  storage_key     text generated always as (substr(id::text, 1, 2) || '/' || id::text) stored,
  bytes           bigint not null check (bytes > 0),
  -- Thumbnail + proxy bytes, counted in the quota with the original.
  derived_bytes   bigint not null default 0 check (derived_bytes >= 0),
  mime            text not null,
  width           integer check (width is null or width between 1 and 16384),
  height          integer check (height is null or height between 1 and 16384),
  duration_s      numeric(10,3) check (duration_s is null or (duration_s > 0 and duration_s <= 86400)),
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source          text not null check (source in ('generated', 'upload', 'render', 'pipeline')),
  -- provider, model, prompt_hash, job_id, rights … as text; no foreign keys.
  provenance      jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(provenance) = 'object' and pg_column_size(provenance) <= 16384),
  -- Which derived files exist next to the original.
  variants        text[] not null default '{}'::text[]
                  check (variants <@ array['thumb', 'proxy']::text[]),
  original_name   text check (original_name is null or char_length(original_name) between 1 and 200),
  parent_asset_id uuid references public.media_assets (id) on delete set null,
  version         integer not null default 1 check (version >= 1),
  -- The upload ticket it came from (one asset per ticket).
  upload_id       uuid unique,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  -- The worker removed the files and gave the bytes back to the quota.
  purged_at       timestamptz,
  constraint media_assets_mime_kind check (public.media_mime_kind(mime) = kind),
  constraint media_assets_purge_after_delete check (purged_at is null or deleted_at is not null)
);

create index if not exists media_assets_org_idx
  on public.media_assets (org_id, created_at desc) where deleted_at is null;
create index if not exists media_assets_purge_idx
  on public.media_assets (deleted_at) where deleted_at is not null and purged_at is null;
create index if not exists media_assets_parent_idx
  on public.media_assets (parent_asset_id) where parent_asset_id is not null;

comment on table public.media_assets is
  'The media library (migration 0038). Files live on the server''s media volume at media/<storage_key>/ (storage_key is derived from the id). Rows appear only through register_asset() (the worker, service role) and disappear from members only through soft_delete_asset().';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. media_uploads — tickets
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.media_uploads (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  project_id     uuid,
  original_name  text not null check (char_length(original_name) between 1 and 200),
  declared_mime  text not null check (public.media_mime_kind(declared_mime) is not null),
  declared_bytes bigint not null check (declared_bytes > 0),
  received_bytes bigint check (received_bytes is null or received_bytes > 0),
  status         text not null default 'requested'
                 check (status in ('requested', 'receiving', 'uploaded', 'ingesting',
                                   'ingested', 'rejected', 'expired')),
  reason         text check (reason is null or reason ~ '^[a-z0-9_]{1,64}$'),
  error          text check (error is null or char_length(error) <= 500),
  asset_id       uuid references public.media_assets (id) on delete set null,
  attempts       integer not null default 0,
  worker_id      text,
  heartbeat_at   timestamptz,
  expires_at     timestamptz not null,
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  received_at    timestamptz,
  finished_at    timestamptz,
  updated_at     timestamptz not null default now()
);

create index if not exists media_uploads_org_idx on public.media_uploads (org_id, created_at desc);
create index if not exists media_uploads_queue_idx
  on public.media_uploads (status, created_at)
  where status in ('requested', 'receiving', 'uploaded', 'ingesting');

comment on table public.media_uploads is
  'Upload tickets (migration 0038). Created only by request_upload(); the Command Center streams the body to the staging volume under the ticket id; the worker checks the content and registers an asset or rejects it with a reason. In-flight tickets reserve their bytes in the quota.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Internal helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The org's quota row, created on first use and locked FOR UPDATE for the rest
-- of the caller's transaction: every function that moves bytes starts here.
create or replace function public.media_quota_lock(p_org uuid) returns public.org_storage_quota
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  q public.org_storage_quota;
begin
  insert into public.org_storage_quota (org_id) values (p_org) on conflict (org_id) do nothing;
  select * into q from public.org_storage_quota where org_id = p_org for update;
  return q;
end
$$;

create or replace function public.media_quota_limit(p_org uuid) returns bigint
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select q.limit_bytes from public.org_storage_quota q where q.org_id = p_org),
                  (select s.default_quota_bytes from public.media_storage_settings s where s.id),
                  0)
$$;

-- Bytes held by uploads still in flight.
create or replace function public.media_pending_bytes(p_org uuid) returns bigint
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(coalesce(u.received_bytes, u.declared_bytes)), 0)::bigint
    from public.media_uploads u
   where u.org_id = p_org and u.status in ('requested', 'receiving', 'uploaded', 'ingesting')
$$;

-- End tickets nobody will finish, so they stop holding quota:
--   requested past its expiry            -> expired (upload_window_passed)
--   receiving for over 6 hours           -> expired (upload_interrupted): the
--                                           web process died mid-stream
--   uploaded, no worker for 24 hours     -> expired (not_picked_up)
--   ingesting, heartbeat 30 min old      -> back to uploaded (3 attempts), then
--                                           rejected (interrupted)
-- p_org null sweeps every organization (the worker's claim).
create or replace function public.media_uploads_sweep(p_org uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  update public.media_uploads
     set status = 'expired', reason = 'upload_window_passed', finished_at = now(), updated_at = now()
   where (p_org is null or org_id = p_org) and status = 'requested' and expires_at <= now();
  update public.media_uploads
     set status = 'expired', reason = 'upload_interrupted', finished_at = now(), updated_at = now()
   where (p_org is null or org_id = p_org) and status = 'receiving'
     and coalesce(received_at, created_at) < now() - interval '6 hours';
  update public.media_uploads
     set status = 'expired', reason = 'not_picked_up', finished_at = now(), updated_at = now()
   where (p_org is null or org_id = p_org) and status = 'uploaded'
     and coalesce(received_at, created_at) < now() - interval '24 hours';
  update public.media_uploads
     set status = 'uploaded', worker_id = null, updated_at = now()
   where (p_org is null or org_id = p_org) and status = 'ingesting' and attempts < 3
     and coalesce(heartbeat_at, created_at) < now() - interval '30 minutes';
  update public.media_uploads
     set status = 'rejected', reason = 'interrupted', finished_at = now(), updated_at = now()
   where (p_org is null or org_id = p_org) and status = 'ingesting'
     and coalesce(heartbeat_at, created_at) < now() - interval '30 minutes';
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. request_upload — the browser's first call (via the Command Center route)
-- ───────────────────────────────────────────────────────────────────────────

-- SQLSTATEs the route maps to words (lib/media.ts mapMediaError):
--   42501 not signed in / not a member   NS415 type not allowed / kinds disagree
--   NS413 larger than the cap            NS429 too many uploads in flight
--   NS507 over the storage quota (detail used= pending= limit= requested=),
--         or the whole server's media storage is full (detail reason=server_full)
create or replace function public.request_upload(
  p_org uuid, p_filename text, p_mime text, p_bytes bigint, p_project_id uuid default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  name_    text := public.media_clean_name(p_filename);
  mime_    text := public.media_normalize_mime(p_mime, public.media_clean_name(p_filename));
  kind_    text;
  ext_mime text;
  cfg      public.media_storage_settings;
  q        public.org_storage_quota;
  lim      bigint;
  pending  bigint;
  inflight integer;
  t        public.media_uploads;
begin
  if auth.uid() is null then
    raise exception 'sign in to upload' using errcode = '42501';
  end if;
  if p_org is null or not public.is_org_member(p_org) then
    raise exception 'only a member of this organization may upload to its library' using errcode = '42501';
  end if;

  kind_ := public.media_mime_kind(mime_);
  if kind_ is null then
    raise exception 'this file type is not accepted'
      using errcode = 'NS415', detail = 'reason=unsupported_type',
            hint = 'Images (JPEG, PNG, WebP, GIF), video (MP4, MOV, WebM, MKV), audio (MP3, M4A, WAV, OGG, FLAC, AAC) and captions (VTT, SRT).';
  end if;
  -- An extension that names a different kind of media (photo.png sent as
  -- video/mp4) or no media at all (clip.exe) is refused here; the worker
  -- checks the content itself later, whatever passes this.
  if name_ ~ '\.[A-Za-z0-9]{1,5}$' then
    ext_mime := public.media_ext_mime(substring(name_ from '\.([A-Za-z0-9]{1,5})$'));
    if ext_mime is null or public.media_mime_kind(ext_mime) <> kind_ then
      raise exception 'the file name''s extension does not match its type'
        using errcode = 'NS415', detail = 'reason=extension_mismatch';
    end if;
  end if;

  select * into cfg from public.media_storage_settings where id;
  if p_bytes is null or p_bytes <= 0 then
    raise exception 'the file is empty' using errcode = '22023';
  end if;
  if p_bytes > cfg.max_upload_bytes or (kind_ = 'caption' and p_bytes > 2097152) then
    raise exception 'the file is larger than an upload may be'
      using errcode = 'NS413',
            detail = format('max=%s', case when kind_ = 'caption' then least(cfg.max_upload_bytes, 2097152)
                                           else cfg.max_upload_bytes end);
  end if;

  -- Under the org's quota lock: parallel requests queue here, so they cannot
  -- both fit under the limit that only one of them fits under.
  q := public.media_quota_lock(p_org);
  perform public.media_uploads_sweep(p_org);

  select count(*) into inflight from public.media_uploads u
   where u.org_id = p_org and u.status in ('requested', 'receiving', 'uploaded', 'ingesting');
  if inflight >= cfg.max_pending_uploads then
    raise exception 'too many uploads in progress for this organization'
      using errcode = 'NS429', detail = format('in_flight=%s max=%s', inflight, cfg.max_pending_uploads);
  end if;

  lim := coalesce(q.limit_bytes, cfg.default_quota_bytes);
  pending := public.media_pending_bytes(p_org);
  if q.used_bytes + pending + p_bytes > lim then
    raise exception 'not enough storage left for this file'
      using errcode = 'NS507',
            detail = format('used=%s pending=%s limit=%s requested=%s', q.used_bytes, pending, lim, p_bytes),
            hint = 'Delete assets you no longer need, or ask the platform owner for more storage.';
  end if;
  -- The server as a whole. No number about other organizations is returned.
  if (select coalesce(sum(x.used_bytes), 0) from public.org_storage_quota x)
     + (select coalesce(sum(coalesce(u.received_bytes, u.declared_bytes)), 0) from public.media_uploads u
         where u.status in ('requested', 'receiving', 'uploaded', 'ingesting'))
     + p_bytes > cfg.max_total_bytes then
    raise exception 'the server''s media storage is full'
      using errcode = 'NS507', detail = 'reason=server_full',
            hint = 'The platform owner has to free space or raise media_storage_settings.max_total_bytes.';
  end if;

  insert into public.media_uploads
    (org_id, project_id, original_name, declared_mime, declared_bytes, status, expires_at, created_by)
  values
    (p_org, p_project_id, name_, mime_, p_bytes, 'requested',
     now() + make_interval(mins => cfg.ticket_ttl_minutes), auth.uid())
  returning * into t;

  return jsonb_build_object('ticket', t.id, 'kind', kind_, 'mime', mime_, 'name', name_,
                            'max_bytes', p_bytes, 'expires_at', t.expires_at);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The receiving route's two calls (the person who asked, under their session)
-- ───────────────────────────────────────────────────────────────────────────

-- Claim the ticket for one body: requested -> receiving, once. A second PUT
-- for the same ticket (a retry, a parallel request, someone else's session)
-- finds it not 'requested' — or not theirs — and is refused before a byte is
-- written.
create or replace function public.begin_upload_receive(p_ticket uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t public.media_uploads;
begin
  if auth.uid() is null then
    raise exception 'sign in to upload' using errcode = '42501';
  end if;
  select * into t from public.media_uploads where id = p_ticket for update;
  -- Another person's ticket reads as missing: a ticket id says nothing.
  if not found or t.created_by <> auth.uid() or not public.is_org_member(t.org_id) then
    raise exception 'no such upload' using errcode = 'P0002';
  end if;
  if t.status = 'requested' and t.expires_at <= now() then
    update public.media_uploads
       set status = 'expired', reason = 'upload_window_passed', finished_at = now(), updated_at = now()
     where id = t.id;
    return jsonb_build_object('ok', false, 'status', 'expired');
  end if;
  if t.status <> 'requested' then
    return jsonb_build_object('ok', false, 'status', t.status);
  end if;
  update public.media_uploads
     set status = 'receiving', received_at = now(), updated_at = now()
   where id = t.id;
  return jsonb_build_object('ok', true, 'status', 'receiving', 'max_bytes', t.declared_bytes,
                            'org_id', t.org_id);
end
$$;

-- The body is on the staging volume (ok) or was refused (not ok, with a word).
-- p_bytes is what the route counted; the worker measures the file again and
-- trusts only its own number.
create or replace function public.finish_upload_receive(
  p_ticket uuid, p_bytes bigint, p_ok boolean, p_reason text default null
) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t public.media_uploads;
begin
  if auth.uid() is null then
    raise exception 'sign in to upload' using errcode = '42501';
  end if;
  select * into t from public.media_uploads where id = p_ticket for update;
  if not found or t.created_by <> auth.uid() then
    raise exception 'no such upload' using errcode = 'P0002';
  end if;
  if t.status <> 'receiving' then
    return t.status;
  end if;
  if coalesce(p_ok, false) and p_bytes is not null and p_bytes > 0 and p_bytes <= t.declared_bytes then
    update public.media_uploads
       set status = 'uploaded', received_bytes = p_bytes, updated_at = now()
     where id = t.id;
    return 'uploaded';
  end if;
  update public.media_uploads
     set status = 'rejected',
         reason = case when p_reason in ('too_large', 'empty', 'client_aborted', 'write_failed', 'staging_unavailable')
                       then p_reason
                       when coalesce(p_ok, false) then 'too_large'
                       else 'write_failed' end,
         finished_at = now(), updated_at = now()
   where id = t.id;
  return 'rejected';
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. soft_delete_asset — a member hides an asset; the worker purges it
-- ───────────────────────────────────────────────────────────────────────────

-- The row stays (provenance and history are kept; a timeline that referenced
-- it can say "deleted"). The bytes stay counted until the worker has removed
-- the files (mark_asset_purged), so deleting and re-uploading cannot fill the
-- disk past the quota.
create or replace function public.soft_delete_asset(p_asset uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  a public.media_assets;
begin
  if auth.uid() is null then
    raise exception 'sign in to delete' using errcode = '42501';
  end if;
  select * into a from public.media_assets where id = p_asset for update;
  -- Another organization's asset reads as missing, never as "forbidden".
  if not found or not public.is_org_member(a.org_id) then
    raise exception 'no such asset' using errcode = 'P0002';
  end if;
  if a.deleted_at is not null then
    return false;
  end if;
  update public.media_assets set deleted_at = now(), deleted_by = auth.uid() where id = a.id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. The worker's functions (service role)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.claim_media_upload(p_worker text)
  returns setof public.media_uploads
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'uploads are ingested by the platform''s worker only' using errcode = '42501';
  end if;
  perform public.media_uploads_sweep(null);
  return query
    update public.media_uploads u
       set status = 'ingesting', worker_id = left(p_worker, 120), heartbeat_at = now(),
           attempts = u.attempts + 1, updated_at = now()
     where u.id = (select x.id from public.media_uploads x
                    where x.status = 'uploaded'
                    order by x.created_at
                    for update skip locked
                    limit 1)
    returning u.*;
end
$$;

create or replace function public.reject_media_upload(
  p_ticket uuid, p_worker text, p_reason text, p_error text default null
) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t public.media_uploads;
begin
  if not public.credits_trusted_caller() then
    raise exception 'uploads are ingested by the platform''s worker only' using errcode = '42501';
  end if;
  select * into t from public.media_uploads where id = p_ticket for update;
  if not found then
    raise exception 'no such upload' using errcode = 'P0002';
  end if;
  if t.status <> 'ingesting' then
    return t.status;
  end if;
  if t.worker_id is distinct from left(p_worker, 120) then
    raise exception 'this upload belongs to another worker' using errcode = '42501';
  end if;
  update public.media_uploads
     set status = 'rejected',
         reason = case when coalesce(p_reason, '') ~ '^[a-z0-9_]{1,64}$' then p_reason else 'worker_error' end,
         error = left(p_error, 500), finished_at = now(), updated_at = now()
   where id = t.id;
  return 'rejected';
end
$$;

-- Register a stored file as an asset. The worker has already written
-- media/<storage_key>/ for p_asset_id (it picks the id first so the files are
-- in place before the row exists; a row never points at nothing).
--   source 'upload'   p_upload_id names an 'ingesting' ticket; the org,
--                     project, name and creator come from the ticket, never
--                     from the caller, and the ticket becomes 'ingested'.
--   other sources     p_org is required (generated / render / pipeline
--                     outputs of jobs in other migrations; those references
--                     travel in p_provenance as text).
-- Idempotent: a retried call for the same id or ticket returns the same row.
create or replace function public.register_asset(
  p_asset_id uuid,
  p_org uuid,
  p_kind text,
  p_mime text,
  p_bytes bigint,
  p_sha256 text,
  p_source text,
  p_width integer default null,
  p_height integer default null,
  p_duration_s numeric default null,
  p_provenance jsonb default '{}'::jsonb,
  p_derived_bytes bigint default 0,
  p_variants text[] default '{}'::text[],
  p_upload_id uuid default null,
  p_parent_asset_id uuid default null,
  p_project_id uuid default null,
  p_original_name text default null,
  p_created_by uuid default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  a       public.media_assets;
  t       public.media_uploads;
  parent  public.media_assets;
  org     uuid := p_org;
  project uuid := p_project_id;
  name_   text := case when p_original_name is null then null else public.media_clean_name(p_original_name) end;
  creator uuid := p_created_by;
  ver     integer := 1;
begin
  if not public.credits_trusted_caller() then
    raise exception 'assets are registered by the platform''s worker only' using errcode = '42501';
  end if;
  if p_asset_id is null then
    raise exception 'an asset id is required' using errcode = '22023';
  end if;

  select * into a from public.media_assets where id = p_asset_id;
  if found then
    return jsonb_build_object('id', a.id, 'storage_key', a.storage_key, 'reused', true);
  end if;

  if p_source = 'upload' then
    if p_upload_id is null then
      raise exception 'an uploaded asset needs its ticket' using errcode = '22023';
    end if;
    select * into t from public.media_uploads where id = p_upload_id for update;
    if not found then
      raise exception 'no such upload' using errcode = 'P0002';
    end if;
    if t.status = 'ingested' and t.asset_id is not null then
      select * into a from public.media_assets where id = t.asset_id;
      return jsonb_build_object('id', a.id, 'storage_key', a.storage_key, 'reused', true);
    end if;
    if t.status <> 'ingesting' then
      raise exception 'the upload is %, not ingesting', t.status using errcode = '55000';
    end if;
    if p_org is not null and p_org <> t.org_id then
      raise exception 'the upload belongs to another organization' using errcode = '42501';
    end if;
    if p_bytes > t.declared_bytes then
      raise exception 'the file is larger than the upload declared' using errcode = '22023';
    end if;
    org := t.org_id;
    project := t.project_id;
    name_ := t.original_name;
    creator := t.created_by;
  elsif p_upload_id is not null then
    raise exception 'only an uploaded asset has a ticket' using errcode = '22023';
  end if;

  if org is null then
    raise exception 'an asset needs its organization' using errcode = '22023';
  end if;

  if p_parent_asset_id is not null then
    select * into parent from public.media_assets where id = p_parent_asset_id;
    -- A version of another organization's asset is not a thing.
    if not found or parent.org_id <> org then
      raise exception 'the parent asset is not in this organization' using errcode = '42501';
    end if;
    ver := parent.version + 1;
  end if;

  perform public.media_quota_lock(org);

  insert into public.media_assets
    (id, org_id, project_id, kind, storage, bytes, derived_bytes, mime, width, height, duration_s,
     sha256, source, provenance, variants, original_name, parent_asset_id, version, upload_id, created_by)
  values
    (p_asset_id, org, project, p_kind, 'local', p_bytes, greatest(coalesce(p_derived_bytes, 0), 0), p_mime,
     p_width, p_height, round(p_duration_s, 3), lower(p_sha256), p_source, coalesce(p_provenance, '{}'::jsonb),
     coalesce(p_variants, '{}'::text[]), name_, p_parent_asset_id, ver, p_upload_id, creator)
  returning * into a;

  -- Generated and rendered outputs are recorded even over the limit — the
  -- work was paid for, and losing it would be the worse failure. The org's
  -- next upload is refused instead.
  update public.org_storage_quota
     set used_bytes = used_bytes + a.bytes + a.derived_bytes, updated_at = now()
   where org_id = org;

  if p_source = 'upload' then
    update public.media_uploads
       set status = 'ingested', asset_id = a.id, received_bytes = a.bytes, reason = null, error = null,
           finished_at = now(), updated_at = now()
     where id = p_upload_id;
  end if;

  return jsonb_build_object('id', a.id, 'storage_key', a.storage_key, 'reused', false);
end
$$;

-- Soft-deleted assets whose files are still on disk, oldest first.
create or replace function public.claim_media_purge(p_limit integer default 50)
  returns table (id uuid, storage_key text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'assets are purged by the platform''s worker only' using errcode = '42501';
  end if;
  return query
    select a.id, a.storage_key from public.media_assets a
     where a.deleted_at is not null and a.purged_at is null and a.storage = 'local'
     order by a.deleted_at
     limit greatest(1, least(coalesce(p_limit, 50), 500));
end
$$;

-- The files are gone: give the bytes back. Once.
create or replace function public.mark_asset_purged(p_asset uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  a public.media_assets;
begin
  if not public.credits_trusted_caller() then
    raise exception 'assets are purged by the platform''s worker only' using errcode = '42501';
  end if;
  select * into a from public.media_assets where id = p_asset for update;
  if not found or a.deleted_at is null or a.purged_at is not null then
    return false;
  end if;
  perform public.media_quota_lock(a.org_id);
  update public.media_assets set purged_at = now() where id = a.id;
  update public.org_storage_quota
     set used_bytes = greatest(used_bytes - a.bytes - a.derived_bytes, 0), updated_at = now()
   where org_id = a.org_id;
  return true;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.media_storage_settings enable row level security;
alter table public.org_storage_quota enable row level security;
alter table public.media_assets enable row level security;
alter table public.media_uploads enable row level security;

revoke all on public.media_storage_settings from public, anon, authenticated, service_role;
revoke all on public.org_storage_quota from public, anon, authenticated, service_role;
revoke all on public.media_assets from public, anon, authenticated, service_role;
revoke all on public.media_uploads from public, anon, authenticated, service_role;
grant select on public.media_storage_settings to authenticated, service_role;
grant select on public.org_storage_quota to authenticated, service_role;
grant select on public.media_assets to authenticated, service_role;
grant select on public.media_uploads to authenticated, service_role;
-- The worker's heartbeat only; every status change goes through the functions.
grant update (heartbeat_at, updated_at) on public.media_uploads to service_role;

drop policy if exists media_storage_settings_select on public.media_storage_settings;
create policy media_storage_settings_select on public.media_storage_settings
  for select to authenticated
  using (true);

drop policy if exists org_storage_quota_select on public.org_storage_quota;
create policy org_storage_quota_select on public.org_storage_quota
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

drop policy if exists media_assets_select on public.media_assets;
create policy media_assets_select on public.media_assets
  for select to authenticated
  using (deleted_at is null and org_id in (select public.accessible_org_ids()));

drop policy if exists media_uploads_select on public.media_uploads;
create policy media_uploads_select on public.media_uploads
  for select to authenticated
  using (org_id in (select public.accessible_org_ids()));

-- Helpers: nobody through the API. (The type helpers in the CHECK
-- constraints run as the owner of the security-definer function doing the
-- insert, so no API role needs EXECUTE on them.)
revoke all on function public.media_mime_kind(text) from public, anon, authenticated, service_role;
revoke all on function public.media_ext_mime(text) from public, anon, authenticated, service_role;
revoke all on function public.media_clean_name(text) from public, anon, authenticated, service_role;
revoke all on function public.media_normalize_mime(text, text) from public, anon, authenticated, service_role;
revoke all on function public.media_quota_lock(uuid) from public, anon, authenticated, service_role;
revoke all on function public.media_quota_limit(uuid) from public, anon, authenticated, service_role;
revoke all on function public.media_pending_bytes(uuid) from public, anon, authenticated, service_role;
revoke all on function public.media_uploads_sweep(uuid) from public, anon, authenticated, service_role;

revoke all on function public.request_upload(uuid, text, text, bigint, uuid) from public, anon, authenticated, service_role;
revoke all on function public.begin_upload_receive(uuid) from public, anon, authenticated, service_role;
revoke all on function public.finish_upload_receive(uuid, bigint, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.soft_delete_asset(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_media_upload(text) from public, anon, authenticated, service_role;
revoke all on function public.reject_media_upload(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_media_purge(integer) from public, anon, authenticated, service_role;
revoke all on function public.mark_asset_purged(uuid) from public, anon, authenticated, service_role;

grant execute on function public.request_upload(uuid, text, text, bigint, uuid) to authenticated;
grant execute on function public.begin_upload_receive(uuid) to authenticated;
grant execute on function public.finish_upload_receive(uuid, bigint, boolean, text) to authenticated;
grant execute on function public.soft_delete_asset(uuid) to authenticated;
grant execute on function public.claim_media_upload(text) to service_role;
grant execute on function public.reject_media_upload(uuid, text, text, text) to service_role;
grant execute on function public.register_asset(uuid, uuid, text, text, bigint, text, text, integer, integer, numeric, jsonb, bigint, text[], uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.claim_media_purge(integer) to service_role;
grant execute on function public.mark_asset_purged(uuid) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.media_assets'::regclass, 'public.media_uploads'::regclass,
--                   'public.org_storage_quota'::regclass, 'public.media_storage_settings'::regclass)) as rls_on,
--   not has_table_privilege('authenticated', 'public.media_assets', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.media_assets', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.media_assets', 'DELETE')
--     and not has_table_privilege('authenticated', 'public.media_uploads', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.org_storage_quota', 'UPDATE')
--     and not has_table_privilege('anon', 'public.media_assets', 'SELECT') as browser_read_only,
--   has_function_privilege('authenticated', 'public.request_upload(uuid,text,text,bigint,uuid)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.request_upload(uuid,text,text,bigint,uuid)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.claim_media_upload(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated',
--       'public.register_asset(uuid,uuid,text,text,bigint,text,text,integer,integer,numeric,jsonb,bigint,text[],uuid,uuid,uuid,text,uuid)',
--       'EXECUTE') as functions_scoped,
--   (select count(*) = 1 from public.media_storage_settings) as settings_row;
