-- 0030_paid_downloads.sql — download a finished video in 720p / 1080p, paid
-- for in credits.
--
-- Until now the video page's "Download" handed out only the 480p review copy
-- (the `previews` bucket, 0004). The full-quality MASTER only exists on the
-- queue worker's disk (the Hetzner server keeps output/<slug>/ on a volume); a
-- video rendered on GitHub Actions has nothing but the 480p copy. This file
-- adds the database half of "pick a quality, pay, download":
--
-- WHAT IT ADDS
--   download_masters     which videos have a master on the worker, and its
--                        frame size, length and bytes. Written only by the
--                        worker (service role) after it has probed the file;
--                        read by the organization's viewers. The page offers
--                        only the qualities the master can give (short side
--                        >= 720 / 1080) — and 480p alone, with a note, when
--                        there is no master.
--   download_requests    one row per paid (or free) download: the quality,
--                        what was charged, and where the worker is with it
--                        (queued -> processing -> ready -> expired | failed).
--                        Readable by the organization's viewers. NOBODY
--                        inserts or updates through the API except via the
--                        functions below and the worker's service role.
--   request_download(video, quality, max_credits)
--                        org EDITOR+ of the video's organization, signed in.
--                        Prices the download from the master's length and
--                        credit_prices, debits the organization through the
--                        ledger (credit_log, kind 'capture', job_id
--                        'download:<id>') and queues the row — one
--                        transaction, under the account lock. Idempotent:
--                          * a queued / processing / still-downloadable row
--                            for the same (org, video, quality) is returned
--                            as is, nothing charged;
--                          * a PAID download of the same (org, video,
--                            quality) in the last 7 days makes a new one free
--                            ('redownload') — the file itself lives 24 hours;
--                          * the operator's own organization is exempt (0020).
--                        Refuses (SQLSTATE): NS402 insufficient credits
--                        (detail available=… needed=…, like reserve_credits),
--                        NS404 no master for that quality, NS400 the quality
--                        is unpriced (an unset price is never free), NS409 the
--                        price is above what the person confirmed.
--   claim_download_request(worker)       service role only
--   finish_download_request(id, worker, ok, bytes, reason, error, ttl_hours)
--                        service role only. A FAILED download is refunded in
--                        the same transaction: a ledger 'refund' row for the
--                        full charge, job_id 'download:<id>'. Idempotent.
--   record_download_master(video, width, height, duration_s, bytes)
--   forget_download_master(video)        service role only (the worker).
--
-- PRICES (credit_prices, 0020; credits = quantity x credits_per_unit x
-- (1 + margin); an admin changes them on the Credits page, no deploy):
--   download_720p_minute   per minute of video, 720p
--   download_1080p_minute  per minute of video, 1080p
--   download_minimum       the smallest charge of one download (margin ignored,
--                          as job_minimum)
--   charge = max( ceil(minutes x credits_per_unit x (1 + margin)),
--                 ceil(download_minimum) )           whole credits
--
-- THE DEFAULT RATES, AND WHERE THEY COME FROM (1 credit ~ $0.01 retail: the
-- starter pack is 1000 credits for $10; Paddle keeps ~5% + $0.50 of it):
--
--   The server: Hetzner AX42 (8 cores / 16 threads, 64 GB, 2 x 512 GB NVMe
--   RAID1, ~20 TB traffic included) ~ $55/month all-in -> $0.075 per hour of
--   the whole machine, $0.107 per GB-month of its 512 GB usable disk if the
--   disk alone paid for the box (a deliberately pessimistic bound).
--
--   Measured file size (docs/ROADMAP_SAAS.md render benchmark): a 3 min 15 s
--   ffmpeg master is 215.5 MB -> ~66 MB per minute at 1080p. A 720p x264
--   CRF 21 cut is ~22-25 MB per minute.
--
--   Per minute of video                  720p         1080p
--   transcode (x264 medium, 1080->720p,  30 s of the  none: the master
--     ~2x realtime while a render holds  machine      is copied
--     half the CPU)                      $0.00063     $0.00002
--   egress, priced at Hetzner's          25 MB        66 MB
--     overage rate (~$1.1/TB) although   $0.00003     $0.00007
--     it is inside the 20 TB quota
--   the 24-hour file on disk             $0.00009     $0.00024
--   keeping the master one more month    $0.0071      $0.0071
--     (66 MB x $0.107/GB-month)
--   ---------------------------------------------------------------
--   cost per minute                      ~$0.0078     ~$0.0074
--                                        ~0.8 credit  ~0.75 credit
--
--   So the real cost is under one credit per minute for EITHER quality, and
--   the master's disk dominates it, not the transcode. The rates below cover
--   that cost with the margin the owner asked for, rounded to whole numbers
--   people can read, and step up with quality (1080p is the full master, 2.6x
--   the bytes, and the premium tier):
--
--     unit                    credits_per_unit  margin  = credits/min  vs cost
--     download_720p_minute          1.0          0.25       1.25       ~1.6x
--     download_1080p_minute         1.6          0.25       2.00       ~2.7x
--     download_minimum              3            —          3 per download
--
--   credits_per_unit is the cost basis rounded UP (720p: 0.8 -> 1.0; 1080p:
--   the same cost plus the premium step, 1.6), and the margin is 25% — the
--   margin the credits code and its tests price video_minute with. The
--   minimum covers the per-download overhead a per-minute rate cannot see
--   (a claim, a probe, the payment provider's fixed fee spread over a pack).
--   Examples: a 60 s Short: 3 / 3 credits; the 3:15 benchmark video: 5 / 7;
--   a 10-minute video: 13 / 20 credits (720p / 1080p) = $0.13 / $0.20.
--   480p stays free (the existing review copy).
--
--   The rows are inserted ON CONFLICT DO NOTHING: re-running this file never
--   overwrites a price an admin has already changed.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser, via the anon key):
--   download_masters    select: viewer+ of the organization · nothing else
--   download_requests   select: viewer+ of the organization · nothing else;
--                       rows appear only through request_download()
--   request_download    authenticated (checks editor+ itself)
--   everything else     service role only
--   anon gets nothing. Credits move only through 0020's credit_account_lock /
--   credit_log, under the account lock, never by a browser-writable column.
--
-- SERVING the file is not the database's job: the worker writes
-- <downloads dir>/<id>.mp4 on the server's shared volume and the Command
-- Center's /api/downloads/<id> streams it after reading this row through RLS
-- (ready, not expired). The file is found by the row's numeric id only.
--
-- REQUIRES 0018 (organizations) and 0020 (credits). Additive and idempotent:
-- guarded creates, create-or-replace functions, drop-then-create policies.
-- Nothing existing is dropped or changed (0020's ledger kinds already include
-- 'capture' and 'refund'; its unit check is a pattern the new units match).

do $$
begin
  if to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null then
    raise exception '0030 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.credit_account_lock(uuid)') is null
     or to_regprocedure('public.credit_log(uuid, text, numeric, text, text, text)') is null
     or to_regclass('public.credit_prices') is null then
    raise exception '0030 needs the credits ledger: apply 0020_credits.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. download_masters — what the worker has on disk
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.download_masters (
  video_id         text primary key references public.videos (video_id) on delete cascade,
  org_id           uuid not null references public.organizations (id) on delete cascade,
  width            integer not null check (width between 16 and 16384),
  height           integer not null check (height between 16 and 16384),
  duration_seconds numeric(10,2) not null check (duration_seconds > 0 and duration_seconds <= 86400),
  bytes            bigint not null check (bytes > 0),
  checked_at       timestamptz not null default now()
);

create index if not exists download_masters_org_idx on public.download_masters (org_id);

comment on table public.download_masters is
  'Videos whose full-quality master is on the queue worker''s disk (migration 0030): frame size, length and bytes as the worker probed them. Written only by the worker (service role).';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. download_requests
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.download_requests (
  id            bigserial primary key,
  org_id        uuid not null references public.organizations (id) on delete cascade,
  channel_id    text not null,
  video_id      text not null,
  quality       text not null check (quality in ('720p', '1080p')),
  status        text not null default 'queued'
                check (status in ('queued', 'processing', 'ready', 'failed', 'expired')),
  -- Credits taken for this row (0 = free: exempt organization or re-download).
  charged       numeric(14,2) not null default 0 check (charged >= 0),
  free_reason   text check (free_reason is null or free_reason in ('exempt', 'redownload')),
  -- A paid download makes the same quality of the same video free until then.
  paid_until    timestamptz,
  minutes       numeric(10,4),
  charge_txn    bigint references public.credit_transactions (id) on delete restrict,
  refund_txn    bigint references public.credit_transactions (id) on delete restrict,
  reason        text check (reason is null or reason ~ '^[a-z0-9_]{1,64}$'),
  error         text check (error is null or char_length(error) <= 500),
  bytes         bigint check (bytes is null or bytes > 0),
  expires_at    timestamptz,
  attempts      integer not null default 0,
  worker_id     text,
  heartbeat_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  requested_by  uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists download_requests_video_idx
  on public.download_requests (video_id, created_at desc);
create index if not exists download_requests_key_idx
  on public.download_requests (org_id, video_id, quality, id desc);
create index if not exists download_requests_queue_idx
  on public.download_requests (status, id) where status in ('queued', 'processing', 'ready');

comment on table public.download_requests is
  'A 720p / 1080p download of a finished video (migration 0030). Created only by request_download() (which charges credits through the ledger), carried out by the queue worker (service role), served by the Command Center from the server''s volume while ready and not expired. A failed download is refunded.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Default prices (see the header for the math). Never overwrites.
-- ───────────────────────────────────────────────────────────────────────────

insert into public.credit_prices (unit, credits_per_unit, margin, note) values
  ('download_720p_minute', 1.0, 0.25,
   '720p download, per minute of video. Cost ~0.8 cr/min (master disk + transcode + egress); migration 0030.'),
  ('download_1080p_minute', 1.6, 0.25,
   '1080p download (the master), per minute of video. Cost ~0.75 cr/min + premium step; migration 0030.'),
  ('download_minimum', 3, 0,
   'Smallest charge of one 720p/1080p download (margin ignored); migration 0030.')
on conflict (unit) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Helpers (not callable through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The frame's short side a quality needs (landscape height, portrait width).
create or replace function public.download_quality_side(p_quality text) returns integer
  language sql immutable set search_path = public, pg_temp as $$
  select case p_quality when '720p' then 720 when '1080p' then 1080 end
$$;

-- Give a failed download's credits back (the account is locked by the caller,
-- or is locked here). Returns the credits refunded (0 when nothing was due or
-- it was already refunded).
create or replace function public.download_refund_locked(p_id bigint, p_why text) returns numeric
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.download_requests;
  txn bigint;
begin
  select * into r from public.download_requests where id = p_id for update;
  if not found or r.charged <= 0 or r.refund_txn is not null or r.charge_txn is null then
    return 0;
  end if;
  perform public.credit_account_lock(r.org_id);
  update public.credit_accounts
     set balance = balance + r.charged, updated_at = now()
   where org_id = r.org_id;
  txn := public.credit_log(r.org_id, 'refund', r.charged, 'download:' || r.id, null,
                           left(format('download %s of %s failed: %s', r.quality, r.video_id,
                                       coalesce(p_why, 'failed')), 500));
  update public.download_requests set refund_txn = txn, updated_at = now() where id = p_id;
  return r.charged;
end
$$;

-- End a request as failed and refund it. Used by the worker's finish, the
-- stale sweeps and request_download's own sweep.
create or replace function public.download_fail_locked(p_id bigint, p_reason text, p_error text)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.download_requests
     set status = 'failed', reason = p_reason, error = left(p_error, 500),
         finished_at = now(), updated_at = now()
   where id = p_id and status in ('queued', 'processing');
  if found then
    perform public.download_refund_locked(p_id, p_reason);
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. request_download — the browser's one call (via the Command Center route)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.request_download(
  p_video_id text, p_quality text, p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  vid     text := btrim(coalesce(p_video_id, ''));
  q       text := btrim(coalesce(p_quality, ''));
  org     uuid;
  ch      text;
  m       public.download_masters;
  r       public.download_requests;
  paid    public.download_requests;
  rate    public.credit_prices;
  floor_c numeric;
  mins    numeric;
  price   numeric := 0;
  why     text;
  until_  timestamptz;
  acc     public.credit_accounts;
  txn     bigint;
  s       record;
begin
  if auth.uid() is null then
    raise exception 'sign in to download' using errcode = '42501';
  end if;
  if q not in ('720p', '1080p') then
    raise exception 'quality must be 720p or 1080p' using errcode = '22023';
  end if;
  select c.org_id, c.channel_id into org, ch
    from public.videos v join public.channels c on c.channel_id = v.channel_id
   where v.video_id = vid;
  if ch is null or org is null then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  -- Spending credits: an editor or above of THAT organization, never a viewer.
  if not public.is_org_member(org, 'editor') then
    raise exception 'only an owner, admin or editor of this organization may buy a download'
      using errcode = '42501';
  end if;

  -- One decision per (org, video, quality) at a time: a double click waits
  -- here and then finds the first one's row.
  perform pg_advisory_xact_lock(hashtextextended(format('download:%s:%s:%s', org, vid, q), 0));

  -- No worker picked it up for two hours (the worker is off): give it back.
  for s in
    select d.id from public.download_requests d
     where d.org_id = org and d.status = 'queued' and d.created_at < now() - interval '2 hours'
  loop
    perform public.download_fail_locked(s.id, 'not_picked_up',
      'no worker picked the download up within 2 hours; the credits were refunded');
  end loop;

  -- Already on its way, or still downloadable: the same row, nothing charged.
  select * into r from public.download_requests d
   where d.org_id = org and d.video_id = vid and d.quality = q
     and (d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))
   order by d.id desc limit 1;
  if found then
    return jsonb_build_object('id', r.id, 'status', r.status, 'quality', r.quality,
                              'charged', 0, 'reused', true, 'expires_at', r.expires_at);
  end if;

  select * into m from public.download_masters where video_id = vid;
  if not found or least(m.width, m.height) < public.download_quality_side(q) then
    raise exception 'no full-quality master for this video at %', q
      using errcode = 'NS404',
            hint = 'Only videos rendered on the queue worker keep a master; re-run the video there.';
  end if;
  mins := round(m.duration_seconds / 60.0, 4);

  select * into paid from public.download_requests d
   where d.org_id = org and d.video_id = vid and d.quality = q
     and d.paid_until > now() and d.status <> 'failed'
   order by d.id desc limit 1;
  if found then
    why := 'redownload';
    until_ := paid.paid_until;
  elsif public.credits_exempt(org) then
    why := 'exempt';
    until_ := now() + interval '7 days';
  else
    select * into rate from public.credit_prices where unit = format('download_%s_minute', q);
    if not found then
      raise exception 'downloads in % are not priced yet', q
        using errcode = 'NS400', hint = 'A platform admin sets the download price on the Credits page.';
    end if;
    select credits_per_unit into floor_c from public.credit_prices where unit = 'download_minimum';
    -- Rounded to 6 places before ceil, so numeric division noise (1.6666…7)
    -- never adds a whole credit; lib/downloads.ts downloadCharge does the same.
    price := greatest(ceil(round(m.duration_seconds * rate.credits_per_unit * (1 + rate.margin) / 60.0, 6)),
                      ceil(round(coalesce(floor_c, 0), 6)));
    if p_max_credits is not null and price > p_max_credits then
      raise exception 'the price changed'
        using errcode = 'NS409', detail = format('price=%s confirmed=%s', price, p_max_credits);
    end if;
    until_ := now() + interval '7 days';
  end if;

  if price > 0 then
    acc := public.credit_account_lock(org);
    if acc.balance - acc.reserved < price then
      raise exception 'insufficient credits'
        using errcode = 'NS402',
              detail = format('available=%s needed=%s', acc.balance - acc.reserved, price),
              hint = 'Add credits to this organization.';
    end if;
  end if;

  insert into public.download_requests
    (org_id, channel_id, video_id, quality, status, charged, free_reason, paid_until, minutes, requested_by)
  values
    (org, ch, vid, q, 'queued', price, why, until_, mins, auth.uid())
  returning * into r;

  if price > 0 then
    update public.credit_accounts
       set balance = balance - price, updated_at = now()
     where org_id = org
    returning * into acc;
    txn := public.credit_log(org, 'capture', -price, 'download:' || r.id, null,
                             format('download %s of %s (%s min)', q, vid, mins));
    update public.download_requests set charge_txn = txn where id = r.id;
  end if;

  return jsonb_build_object('id', r.id, 'status', r.status, 'quality', q, 'charged', price,
                            'free_reason', why, 'reused', false,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The worker's functions (service role)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.claim_download_request(p_worker text)
  returns setof public.download_requests
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  s record;
begin
  if not public.credits_trusted_caller() then
    raise exception 'download requests are claimed by the platform''s worker only' using errcode = '42501';
  end if;
  -- A ready file past its expiry is gone (the worker deletes it).
  update public.download_requests
     set status = 'expired', updated_at = now()
   where status = 'ready' and expires_at <= now();
  -- A transcode whose worker died: retried (it is idempotent) up to 3 times,
  -- then failed and refunded. A row nobody picked up in 2 hours: refunded.
  update public.download_requests
     set status = 'queued', worker_id = null, updated_at = now()
   where status = 'processing' and attempts < 3
     and coalesce(heartbeat_at, started_at, created_at) < now() - interval '30 minutes';
  for s in
    select id from public.download_requests
     where (status = 'processing' and coalesce(heartbeat_at, started_at, created_at) < now() - interval '30 minutes')
        or (status = 'queued' and created_at < now() - interval '2 hours')
  loop
    perform public.download_fail_locked(s.id, 'interrupted',
      'the download could not be prepared in time; the credits were refunded');
  end loop;

  return query
    update public.download_requests d
       set status = 'processing', worker_id = left(p_worker, 120), started_at = now(),
           heartbeat_at = now(), attempts = d.attempts + 1, updated_at = now()
     where d.id = (select x.id from public.download_requests x
                    where x.status = 'queued'
                    order by x.id
                    for update skip locked
                    limit 1)
    returning d.*;
end
$$;

create or replace function public.finish_download_request(
  p_id bigint, p_worker text, p_ok boolean, p_bytes bigint default null,
  p_reason text default null, p_error text default null, p_ttl_hours integer default 24
) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.download_requests;
begin
  if not public.credits_trusted_caller() then
    raise exception 'download requests are finished by the platform''s worker only' using errcode = '42501';
  end if;
  select * into r from public.download_requests where id = p_id;
  if not found then
    raise exception 'no such download request' using errcode = 'P0002';
  end if;
  -- Settle once: a retried call returns what the row already says.
  if r.status not in ('queued', 'processing') then
    return r.status;
  end if;
  if r.worker_id is distinct from left(p_worker, 120) then
    raise exception 'this download request belongs to another worker' using errcode = '42501';
  end if;
  if coalesce(p_ok, false) then
    if p_bytes is null or p_bytes <= 0 then
      raise exception 'a ready download needs its size' using errcode = '22023';
    end if;
    update public.download_requests
       set status = 'ready', bytes = p_bytes, reason = null, error = null,
           expires_at = now() + make_interval(hours => greatest(1, least(coalesce(p_ttl_hours, 24), 168))),
           finished_at = now(), updated_at = now()
     where id = p_id;
    return 'ready';
  end if;
  perform public.download_fail_locked(
    p_id,
    case when coalesce(p_reason, '') ~ '^[a-z0-9_]{1,64}$' then p_reason else 'worker_error' end,
    p_error);
  return 'failed';
end
$$;

create or replace function public.record_download_master(
  p_video_id text, p_width integer, p_height integer, p_duration numeric, p_bytes bigint
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  org uuid;
begin
  if not public.credits_trusted_caller() then
    raise exception 'masters are recorded by the platform''s worker only' using errcode = '42501';
  end if;
  select c.org_id into org
    from public.videos v join public.channels c on c.channel_id = v.channel_id
   where v.video_id = p_video_id;
  if org is null then
    return false;
  end if;
  insert into public.download_masters (video_id, org_id, width, height, duration_seconds, bytes, checked_at)
  values (p_video_id, org, p_width, p_height, round(p_duration, 2), p_bytes, now())
  on conflict (video_id) do update
    set org_id = excluded.org_id, width = excluded.width, height = excluded.height,
        duration_seconds = excluded.duration_seconds, bytes = excluded.bytes, checked_at = now();
  return true;
end
$$;

create or replace function public.forget_download_master(p_video_id text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'masters are recorded by the platform''s worker only' using errcode = '42501';
  end if;
  delete from public.download_masters where video_id = p_video_id;
  return found;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.download_masters enable row level security;
alter table public.download_requests enable row level security;

revoke all on public.download_masters from public, anon, authenticated, service_role;
revoke all on public.download_requests from public, anon, authenticated, service_role;
revoke all on sequence public.download_requests_id_seq from public, anon, authenticated, service_role;
grant select on public.download_masters to authenticated, service_role;
grant select on public.download_requests to authenticated, service_role;
-- The worker's heartbeat only; every status change goes through the functions.
grant update (heartbeat_at, updated_at) on public.download_requests to service_role;

drop policy if exists download_masters_select on public.download_masters;
create policy download_masters_select on public.download_masters
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists download_requests_select on public.download_requests;
create policy download_requests_select on public.download_requests
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

revoke all on function public.download_quality_side(text) from public, anon, authenticated, service_role;
revoke all on function public.download_refund_locked(bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.download_fail_locked(bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.request_download(text, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.claim_download_request(text) from public, anon, authenticated, service_role;
revoke all on function public.finish_download_request(bigint, text, boolean, bigint, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.record_download_master(text, integer, integer, numeric, bigint) from public, anon, authenticated, service_role;
revoke all on function public.forget_download_master(text) from public, anon, authenticated, service_role;
grant execute on function public.request_download(text, text, numeric) to authenticated;
grant execute on function public.claim_download_request(text) to service_role;
grant execute on function public.finish_download_request(bigint, text, boolean, bigint, text, text, integer) to service_role;
grant execute on function public.record_download_master(text, integer, integer, numeric, bigint) to service_role;
grant execute on function public.forget_download_master(text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select bool_and(relrowsecurity) from pg_class
--     where oid in ('public.download_masters'::regclass, 'public.download_requests'::regclass)) as rls_on,
--   not has_table_privilege('authenticated', 'public.download_requests', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.download_requests', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.download_masters', 'INSERT')
--     and not has_table_privilege('anon', 'public.download_requests', 'SELECT') as browser_read_only,
--   has_function_privilege('authenticated', 'public.request_download(text,text,numeric)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.request_download(text,text,numeric)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.claim_download_request(text)', 'EXECUTE')
--     and not has_function_privilege('authenticated',
--       'public.finish_download_request(bigint,text,boolean,bigint,text,text,integer)', 'EXECUTE')
--     as functions_scoped,
--   (select count(*) = 3 from public.credit_prices
--     where unit in ('download_720p_minute', 'download_1080p_minute', 'download_minimum')) as prices_set;
