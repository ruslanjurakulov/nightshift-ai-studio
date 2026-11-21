-- 0044_media_heic.sql — the media library accepts iPhone photos (HEIC / HEIF).
--
-- WHAT IT CHANGES (nothing else; no table, no function is added)
--   media_mime_kind        + image/heic, image/heif  (kind: image)
--   media_ext_mime         + heic -> image/heic, heif -> image/heif
--   media_normalize_mime   + the browser aliases image/x-heic, image/x-heif folded
--                            to the canonical types (an empty or generic type
--                            still comes from the extension, which now knows
--                            .heic / .heif — Windows browsers send '')
--   request_upload         the same function as 0038, byte for byte, except the
--                          NS415 hint names HEIC and HEIF. Every check stays:
--                          sign-in, membership, type allowlist, extension vs type,
--                          size cap, in-flight cap, quota under the org's lock,
--                          server-full check.
--   media_assets.variants  the CHECK is dropped and re-added so a `display`
--                          variant is allowed next to `thumb` and `proxy`: a JPEG
--                          (longest side <= 2048) the worker makes from a HEIC,
--                          because most browsers cannot show the original.
--
-- WHAT THE DATABASE DOES NOT DECIDE. Whether a file really is a HEIC is the
-- worker's call, from the CONTENT (modules/media_library.py sniff()): a PNG or
-- JPEG renamed .heic is rejected there, HEIC content named .jpg is stored as
-- image/heic, and AVIF (which shares the `mif1` brand) is refused. The
-- original is stored untouched; the worker decodes a copy (pillow-heif, in a
-- child process with memory / CPU / time limits, 100 megapixels and 16384 px a
-- side checked on the header first) and writes `thumb` and `display` JPEGs
-- without EXIF, GPS or colour profile. HEIC image sequences (burst, live photo
-- motion) are not supported: only the primary still is decoded.
--
-- Unchanged on purpose: the 95 MiB per-file cap, the quotas, privacy defaults,
-- the publish gate and credits. Existing rows are untouched, and the
-- constraints that use media_mime_kind (media_assets_mime_kind,
-- media_uploads.declared_mime) accept the new types by themselves.
--
-- REQUIRES 0038. Additive and idempotent: create-or-replace functions with the
-- same signatures, attributes and privileges; the variants CHECK is dropped
-- and re-added in the same transaction. Based on the latest definitions on
-- main (no later migration redefines these functions).

do $$
begin
  if to_regclass('public.media_assets') is null or to_regprocedure('public.request_upload(uuid, text, text, bigint, uuid)') is null then
    raise exception '0044 needs the media library: apply 0038_media_assets.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Types
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.media_mime_kind(p_mime text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case p_mime
    when 'image/jpeg' then 'image'
    when 'image/png' then 'image'
    when 'image/webp' then 'image'
    when 'image/gif' then 'image'
    when 'image/heic' then 'image'
    when 'image/heif' then 'image'
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

create or replace function public.media_ext_mime(p_ext text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case lower(coalesce(p_ext, ''))
    when 'jpg' then 'image/jpeg'
    when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png'
    when 'webp' then 'image/webp'
    when 'gif' then 'image/gif'
    when 'heic' then 'image/heic'
    when 'heif' then 'image/heif'
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

create or replace function public.media_normalize_mime(p_mime text, p_name text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case m
    when 'image/jpg' then 'image/jpeg'
    when 'image/pjpeg' then 'image/jpeg'
    when 'image/x-heic' then 'image/heic'
    when 'image/x-heif' then 'image/heif'
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
-- 2. request_upload — 0038's function; only the NS415 hint text changed
-- ───────────────────────────────────────────────────────────────────────────

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
            hint = 'Images (JPEG, PNG, WebP, GIF, HEIC, HEIF), video (MP4, MOV, WebM, MKV), audio (MP3, M4A, WAV, OGG, FLAC, AAC) and captions (VTT, SRT).';
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
-- 3. The `display` variant
-- ───────────────────────────────────────────────────────────────────────────

-- 0038 declared the CHECK inline on the column, so Postgres named it
-- media_assets_variants_check; the loop finds any CHECK on this table that
-- constrains `variants` whatever its name, then it is re-added by name.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.media_assets'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%variants%'
  loop
    execute format('alter table public.media_assets drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.media_assets
  add constraint media_assets_variants_check
  check (variants <@ array['thumb', 'proxy', 'display']::text[]);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Privileges (the same as 0038 gave these functions)
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.media_mime_kind(text) from public, anon, authenticated, service_role;
revoke all on function public.media_ext_mime(text) from public, anon, authenticated, service_role;
revoke all on function public.media_normalize_mime(text, text) from public, anon, authenticated, service_role;
revoke all on function public.request_upload(uuid, text, text, bigint, uuid) from public, anon, authenticated, service_role;
grant execute on function public.request_upload(uuid, text, text, bigint, uuid) to authenticated;
