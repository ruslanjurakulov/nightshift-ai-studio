-- 0094_extra_credits_toggle.sql — the Usage page: "Use extra credits when my
-- plan credits run out", and the one read the page is built on.
--
-- WHAT IT ADDS
--   credit_accounts.use_extra_credits  boolean, DEFAULT TRUE. One switch per
--       workspace. ON is what every workspace had before this migration: a
--       run is held against plan credits first, then top-up packs, then
--       never-expiring credits (0034's spend order, unchanged). OFF: a NEW
--       hold may draw only on plan (subscription) credits and non-pack
--       credits (welcome credits, operator grants, adjustments). Top-up
--       packs are left untouched, and when what is left is not enough the run
--       is refused before anything is held.
--   set_use_extra_credits(org, on)     the person who runs the workspace flips
--       it. Nobody else (not another tenant, not the operator, not the service
--       key): the function checks auth.uid() against org_members.
--   usage_summary(org)                 everything the Usage page shows, as one
--       jsonb snapshot of the caller's OWN workspace: plan, billing period,
--       plan credits granted / spent / held in the period, extra (pack) and
--       bonus credits with their soonest expiry, parallel runs, enforced
--       plan limits, and the switch. Read gate = billing_summary's (a member,
--       the platform, a trusted caller); anyone else gets null.
--   credit_spendable_internal(org)     what a NEW hold may draw on right now
--       under the switch (internal: no API role may call it; reserve_credits
--       uses it, and so may any other definer function that must explain a
--       refusal, e.g. the MCP OAuth tool errors).
--
-- WHAT "EXTRA" MEANS
--   An extra lot is a credit_lots row with source = 'pack' (credits bought as a
--   one-time pack). Everything else keeps working with the switch OFF:
--   'subscription' (the plan), 'grant' (welcome credits and operator grants)
--   and 'adjustment' (corrections, carried-over balances, refunds of old
--   spend). A refund that restores spend to the pack lot it came from puts the
--   credits back in the pack lot, as before.
--
-- WHERE IT IS ENFORCED (one place, so EVERY spending route obeys it)
--   Every paid action except a download (Run now, studio jobs, storyboards,
--   scene regeneration, repurposing, credit-priced API generations, MCP OAuth
--   calls, workflow steps) holds credits through public.reserve_credits(), which writes a 'reserve'
--   ledger row, whose trigger (0034) calls credit_lots_hold_locked(). Both are
--   replaced here, on the LATEST bodies (reserve_credits: 0020, never
--   redefined; credit_lots_hold_locked: 0034, never redefined):
--     * reserve_credits keeps every check it had (caller must run the
--       workspace, job reference shape, exempt workspace, amount range, the
--       platform minimum, stale-hold release, duplicate job, total available)
--       and adds ONE check after them: with the switch OFF and not enough
--       spendable credit it refuses with NS402 — the same error code as an
--       empty balance, so every caller that already handles "insufficient
--       credits" handles this — carrying "available=<plan credits>
--       needed=<n> extra_off=1 extra=<pack credits>" in the detail. Nothing
--       is held, nothing is charged.
--     * credit_lots_hold_locked skips pack lots when the switch is OFF, so even
--       a caller that skipped the check above could not touch a pack lot.
--   The switch is read from the account row that every money function locks
--   first (credit_account_lock): a flip waits for a reservation in flight, and
--   the next reservation sees the new value. Flipping never touches a hold
--   that already exists: a run already started keeps the lots it was held on,
--   settles (capture) and releases against them, and is never killed.
--   A download is the one paid action charged on the spot with no hold (0030
--   request_download), so it enforces the switch itself (section 4b): the same
--   NS402 refusal before the charge, and the charge skips pack lots
--   (credit_lots_spend_locked honours a transaction-local flag,
--   nightshift.no_pack_spend, that only request_download sets; every other
--   spender, including a refund clawback, is unchanged). Replaced on the
--   latest bodies too (request_download: 0030; credit_lots_spend_locked: 0034).
--
-- NOT CHANGED, on purpose
--   Capture / release / refund / expiry / the lot invariants / the parallel-run
--   limit / idempotency (a job reference reserves once) / the operator's own
--   workspace (exempt: reserve_credits answers before any lot logic). The
--   settlement of a hold that is already placed is not constrained by the
--   switch (capture_credits' optional over-capture, unused by the app, still
--   draws on any available lot): the switch governs what a NEW run may start.
--
-- Additive and idempotent: add column if not exists, create or replace,
-- explicit revoke/grant. Needs 0020, 0030, 0034, 0091 (workspace owners) and 0093.

do $$
begin
  if to_regprocedure('public.reserve_credits(uuid, text, numeric)') is null
     or to_regprocedure('public.credit_lots_hold_locked(uuid, text, numeric, bigint)') is null
     or to_regprocedure('public.credit_lots_spend_locked(uuid, numeric, text, bigint, bigint)') is null
     or to_regprocedure('public.request_download(text, text, numeric)') is null
     or to_regprocedure('public.oauth_create_video(text, text, jsonb, text, text)') is null
     or to_regprocedure('public.oauth_get_balance(text, text)') is null
     or to_regprocedure('public.billing_may_read(uuid)') is null then
    raise exception '0094 needs credits, downloads, plans and connected apps: apply 0020, 0030, 0034 and 0093 first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The switch
-- ───────────────────────────────────────────────────────────────────────────

alter table public.credit_accounts
  add column if not exists use_extra_credits boolean not null default true;

comment on column public.credit_accounts.use_extra_credits is
  '0094: true (default) = a new run may use top-up pack credits after plan credits; false = only plan, welcome/grant and adjustment credits. Read by reserve_credits and credit_lots_hold_locked under the account lock. Changed only through set_use_extra_credits().';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. What a new hold may draw on
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_spendable_internal(p_org uuid) returns numeric
  language sql volatile security definer set search_path = public, pg_temp as $$
  select coalesce(sum(l.remaining - l.held), 0)
    from public.credit_lots l
   where l.org_id = p_org
     and l.remaining > l.held
     and (l.expires_at is null or l.expires_at > now())
     and (l.source <> 'pack'
          or coalesce((select a.use_extra_credits from public.credit_accounts a where a.org_id = p_org), true))
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. reserve_credits: 0020's body, plus the one refusal
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.reserve_credits(p_org uuid, p_job_id text, p_amount numeric)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  amt     numeric := public.credits_round_up(p_amount);
  job     text := btrim(coalesce(p_job_id, ''));
  acc     public.credit_accounts;
  floor_c numeric;
  avail   numeric;
  spend_  numeric;
begin
  if not (public.credits_trusted_caller() or public.is_org_member(p_org, 'admin')) then
    raise exception 'only an owner or admin of this organization may start a paid run'
      using errcode = '42501';
  end if;
  if job !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$' then
    raise exception 'invalid job reference' using errcode = '22023';
  end if;
  if public.credits_exempt(p_org) then
    return jsonb_build_object('exempt', true, 'job_id', job, 'reserved', 0);
  end if;
  if amt is null or amt <= 0 or amt > 100000000 then
    raise exception 'amount must be a positive number of credits' using errcode = '22023';
  end if;
  -- The platform's floor. A browser can call this function directly with any
  -- amount, and a capture never exceeds its hold, so a hold smaller than the
  -- floor would be a cheap run.
  select credits_per_unit into floor_c from public.credit_prices where unit = 'job_minimum';
  if floor_c is not null and amt < public.credits_round_up(floor_c) then
    raise exception 'reservation below the platform minimum of % credits', public.credits_round_up(floor_c)
      using errcode = '22023';
  end if;

  acc := public.credit_account_lock(p_org);
  -- Stale holds of this org first, so a failed dispatch hours ago does not
  -- keep this run from starting. Runs as the definer: the caller's own claims
  -- would not pass expire's trusted-caller check, so call the release directly.
  perform public.credit_release_locked(c.job_id,
            case when c.started_at is null then 'expired: the run never started'
                 else 'expired: the run never settled' end)
     from public.credit_reservations c
    where c.org_id = p_org and c.status = 'open'
      and ((c.started_at is null and c.created_at < now() - interval '3 hours')
           or (c.started_at is not null and c.started_at < now() - interval '24 hours'));
  select * into acc from public.credit_accounts where org_id = p_org;

  if exists (select 1 from public.credit_reservations where job_id = job) then
    raise exception 'a reservation for this job already exists' using errcode = '23505';
  end if;

  avail := acc.balance - acc.reserved;
  if avail < amt then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', avail, amt),
            hint = 'Add credits to this organization, or start a shorter run.';
  end if;

  -- 0094: with extra credits off, the run may start only on credit that is not
  -- a top-up pack. Refused here, before any hold, with the figures the person
  -- needs: what the plan side can pay, what the run needs, what is waiting in
  -- packs. The same NS402 code as an empty balance.
  if not acc.use_extra_credits then
    spend_ := public.credit_spendable_internal(p_org);
    if spend_ < amt then
      raise exception 'insufficient credits'
        using errcode = 'NS402',
              detail = format('available=%s needed=%s extra_off=1 extra=%s', spend_, amt, greatest(avail - spend_, 0)),
              hint = 'Extra credits are off for this organization. Turn them on, add credits, or upgrade the plan.';
    end if;
  end if;

  insert into public.credit_reservations (job_id, org_id, amount, created_by)
  values (job, p_org, amt, auth.uid());
  update public.credit_accounts
     set reserved = reserved + amt, updated_at = now()
   where org_id = p_org
  returning * into acc;
  perform public.credit_log(p_org, 'reserve', amt, job, null, null);

  return jsonb_build_object('exempt', false, 'job_id', job, 'reserved', amt,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. credit_lots_hold_locked: 0034's body, minus pack lots when the switch is off
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.credit_lots_hold_locked(p_org uuid, p_job text, p_amount numeric, p_txn bigint)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  left_ numeric := p_amount;
  l record;
  take numeric;
  extra_ boolean;
begin
  -- The account row is already locked by the caller (every money function
  -- starts at credit_account_lock), so this is the value the reservation saw.
  select a.use_extra_credits into extra_ from public.credit_accounts a where a.org_id = p_org;
  extra_ := coalesce(extra_, true);
  for l in
    select id, remaining, held from public.credit_lots
     where org_id = p_org and remaining > held and (expires_at is null or expires_at > now())
       and (extra_ or source <> 'pack')
     order by (source <> 'subscription'), expires_at asc nulls last, id
     for update
  loop
    exit when left_ <= 0;
    take := least(l.remaining - l.held, left_);
    update public.credit_lots set held = held + take, updated_at = now() where id = l.id;
    insert into public.credit_hold_lots (job_id, lot_id, amount) values (p_job, l.id, take)
      on conflict (job_id, lot_id) do update set amount = public.credit_hold_lots.amount + excluded.amount;
    perform public.credit_lot_move(p_org, l.id, p_txn, p_job, 'hold', 0, take);
    left_ := left_ - take;
  end loop;
  if left_ > 0 then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', p_amount - left_, p_amount),
            hint = 'Add credits to this organization, or start a shorter run.';
  end if;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4b. Downloads: the one paid action that is charged without a hold
-- ───────────────────────────────────────────────────────────────────────────
-- request_download (0030) charges on the spot (a 'capture' ledger row with no
-- reservation), so it never passes through reserve_credits. Found by review
-- (BR-U-005): with the switch OFF it spent pack credits. Both functions below
-- are 0030's and 0034's latest bodies plus the lines marked 0094.

create or replace function public.credit_lots_spend_locked(
  p_org uuid, p_amount numeric, p_job text, p_txn bigint, p_prefer bigint default null
) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  left_ numeric := p_amount;
  l record;
  take numeric;
begin
  if left_ is null or left_ <= 0 then
    return;
  end if;
  for l in
    select id, remaining, held from public.credit_lots
     where org_id = p_org and remaining > held and (expires_at is null or expires_at > now())
       and (source <> 'pack' or coalesce(current_setting('nightshift.no_pack_spend', true), '') <> '1')
     order by coalesce(id = p_prefer, false) desc, (source <> 'subscription'), expires_at asc nulls last, id
     for update
  loop
    take := least(l.remaining - l.held, left_);
    update public.credit_lots set remaining = remaining - take, updated_at = now() where id = l.id;
    perform public.credit_lot_move(p_org, l.id, p_txn, p_job, 'spend', -take, 0);
    left_ := left_ - take;
    exit when left_ <= 0;
  end loop;
  if left_ > 0 then
    raise exception 'insufficient credits'
      using errcode = 'NS402',
            detail = format('available=%s needed=%s', p_amount - left_, p_amount),
            hint = 'Add credits to this organization.';
  end if;
end
$$;

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
  spend_  numeric;
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
    -- 0094: a download is a paid action that does not go through
    -- reserve_credits (it is charged on the spot), so the switch is enforced
    -- here too: with extra credits off it may be paid only from credit that is
    -- not a top-up pack, and the charge below skips pack lots (the same NS402
    -- refusal and figures as a refused run).
    if not acc.use_extra_credits then
      spend_ := public.credit_spendable_internal(org);
      if spend_ < price then
        raise exception 'insufficient credits'
          using errcode = 'NS402',
                detail = format('available=%s needed=%s extra_off=1 extra=%s', spend_, price, greatest(acc.balance - acc.reserved - spend_, 0)),
                hint = 'Extra credits are off for this organization. Turn them on, add credits, or upgrade the plan.';
      end if;
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
    perform set_config('nightshift.no_pack_spend', case when acc.use_extra_credits then '' else '1' end, true);
    txn := public.credit_log(org, 'capture', -price, 'download:' || r.id, null,
                             format('download %s of %s (%s min)', q, vid, mins));
    perform set_config('nightshift.no_pack_spend', '', true);
    update public.download_requests set charge_txn = txn where id = r.id;
  end if;

  return jsonb_build_object('id', r.id, 'status', r.status, 'quality', q, 'charged', price,
                            'free_reason', why, 'reused', false,
                            'balance', acc.balance, 'available', acc.balance - acc.reserved);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4c. The connected apps' (MCP OAuth, 0093) credit figures
-- ───────────────────────────────────────────────────────────────────────────
-- BR-U-001. 0093's oauth_create_video catches NS402 and quotes
-- available_credits = balance - held, and oauth_get_balance reports the same:
-- with the switch OFF that counts pack credits a new video cannot use, so an
-- app would read "you have 560 available" beside a refusal. Both are 0093's
-- latest bodies (not redefined since) with ONE change each: with the switch
-- OFF the figure is credit_spendable_internal(org) and extra_credits_off is
-- true; with it ON the answer is byte for byte what it was.

create or replace function public.oauth_create_video(
  p_token_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_token_hash, 'oauth.videos.create', p_request_id);
  v_org   uuid;
  v_grant uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_secs  numeric;
  v_idem  text;
  v_fp    text;
  prior   public.oauth_runs;
  jm      numeric;
  vm      public.credit_prices;
  v_price numeric;
  v_limit numeric;
  v_spent numeric;
  acc     public.credit_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
  v_hold  jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    v_grant := (ctx ->> 'grant_id')::uuid;
    if p_idem_key is not null and p_idem_key !~ '^[A-Za-z0-9_:.-]{1,255}$' then
      return public.api_finish(ctx, public.api_err(400, 'invalid_idempotency_key',
        'idempotency_key: 1-255 characters of A-Z a-z 0-9 _ : . -'));
    end if;
    v_idem := coalesce(p_idem_key, 'auto-' || gen_random_uuid()::text);
    v_fp := md5(jsonb_build_object('c', p_channel_id, 'p', v_p)::text);

    -- A retry of the same request waits here, then finds the first one's job.
    perform pg_advisory_xact_lock(hashtextextended('oauth_run:' || v_grant::text || ':' || v_idem, 0));
    select * into prior from public.oauth_runs where grant_id = v_grant and idem_key = v_idem;
    if prior.id is not null then
      if prior.fingerprint <> v_fp then
        return public.api_finish(ctx, public.api_err(422, 'idempotency_key_reused',
          'This idempotency_key was already used with a different request.'));
      end if;
      return public.api_finish(ctx, public.api_ok(jsonb_build_object('job_id', prior.render_job_id,
        'channel_id', prior.channel_id, 'status', 'queued', 'price_credits', prior.quoted_credits), 200)
        || jsonb_build_object('replayed', true));
    end if;

    select * into ch from public.channels c where c.channel_id = p_channel_id;
    if ch.channel_id is null or ch.org_id is distinct from v_org then
      return public.api_finish(ctx, public.api_err(404, 'channel_not_found', 'No channel with that id in this workspace.'));
    elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
      return public.api_finish(ctx, public.api_err(409, 'channel_not_active',
        'That channel is not active. Connect it to YouTube and activate it in the Command Center first.'));
    elsif jsonb_typeof(v_p) <> 'object'
       or (v_p - array['topic','niche','duration','language','visual_style','video_provider','image_provider']) <> '{}'::jsonb
       or not public.render_job_params_valid(v_p, 'daily') then
      return public.api_finish(ctx, public.api_err(400, 'invalid_params',
        'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.'));
    end if;

    -- A limit of 0 is a read-only connection, whoever pays: the operator's exempt
    -- workspace spends nothing, so nothing below would ever count against the
    -- limit; zero is the one limit that needs no counting (Lens-386A).
    if (ctx ->> 'exempt')::boolean and (ctx ->> 'limit_credits')::numeric <= 0 then
      return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
        'This connection is read-only: its monthly spending limit is 0.',
        jsonb_build_object('limit_credits', 0, 'spent_credits', 0, 'price_credits', 0)));
    end if;

    if not (ctx ->> 'exempt')::boolean then
      -- The length the video renders at, frozen the way the payment guard
      -- (0041) freezes it, so what is held is what runs.
      v_secs := coalesce((v_p ->> 'duration')::numeric,
                         case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                              then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
      if v_secs is null or v_secs <= 0 then
        return public.api_finish(ctx, public.api_err(400, 'duration_required',
          'Pass duration (seconds): this channel has no target length to price the video by.'));
      end if;
      v_secs := least(greatest(round(v_secs), 30), 3600);
      v_p := v_p || jsonb_build_object('duration', v_secs::integer);

      -- The price: the same rows and formula the render_jobs payment guard
      -- demands the hold cover. No per-minute price = unpriced = refused.
      select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
      select * into vm from public.credit_prices where unit = 'video_minute';
      if vm.unit is null or vm.credits_per_unit is null then
        return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',
          'Video pricing is not set up on this deployment; nothing was held or charged.'));
      end if;
      v_price := public.credits_round_up(greatest(coalesce(jm, 0), vm.credits_per_unit * (1 + vm.margin) * v_secs / 60));
      if v_price is null or v_price <= 0 then
        return public.api_finish(ctx, public.api_err(503, 'pricing_unavailable',
          'Video pricing is not set up on this deployment; nothing was held or charged.'));
      end if;

      -- Everything below runs under the credit account's row lock, so two calls
      -- of one connection cannot each pass the limit and jointly exceed it.
      acc := public.credit_account_lock(v_org);
      v_limit := (ctx ->> 'limit_credits')::numeric;
      v_spent := public.oauth_grant_month_credits(v_grant);
      if v_spent + v_price > v_limit then
        return public.api_finish(ctx, public.api_err(402, 'connection_limit_reached',
          'This video would take this connection past its monthly spending limit.',
          jsonb_build_object('limit_credits', v_limit, 'spent_credits', v_spent, 'price_credits', v_price)));
      end if;

      v_ref := 'rj-oa-' || replace(gen_random_uuid()::text, '-', '');
      begin
        v_hold := public.reserve_credits(v_org, v_ref, v_price);
      exception
        when sqlstate 'NS402' then
          select * into acc from public.credit_accounts where org_id = v_org;
          -- 0094: with extra credits off, what a new video can use is the plan
          -- side only, not balance - held (which counts unspendable pack credits).
          return public.api_finish(ctx, public.api_err(402, 'insufficient_credits',
            'The workspace does not have enough credits for this video.',
            jsonb_build_object('available_credits',
                                 case when coalesce(acc.use_extra_credits, true)
                                      then greatest(acc.balance - acc.reserved, 0)
                                      else public.credit_spendable_internal(v_org) end,
                               'held_credits', acc.reserved, 'price_credits', v_price)
            || case when coalesce(acc.use_extra_credits, true) then '{}'::jsonb
                    else jsonb_build_object('extra_credits_off', true) end));
        when sqlstate 'NS429' then
          return public.api_finish(ctx, public.api_err(429, 'run_limit_reached',
            'The plan\''s limit of videos in progress at once is reached.',
            jsonb_build_object('retry_after', 60,
                               'active_runs', (select count(*) from public.credit_reservations r where r.org_id = v_org and r.status = 'open'),
                               'run_limit', public.entitlement_int_internal(v_org, 'concurrency'))));
      end;
    end if;

    insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref)
    values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
    returning id into v_job;

    insert into public.oauth_runs (grant_id, org_id, idem_key, fingerprint, credit_ref, render_job_id, channel_id, quoted_credits)
    values (v_grant, v_org, v_idem, v_fp, v_ref, v_job, ch.channel_id, v_price);

    insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail, channel_id)
    values ((ctx ->> 'created_by')::uuid, nullif(auth.jwt() ->> 'email', ''), 'agent.run', ch.channel_id,
            v_p || jsonb_build_object('via', 'mcp_oauth', 'grant_id', v_grant, 'job_id', v_job,
                                      'credit_ref', v_ref, 'price_credits', v_price), ch.channel_id);

    v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                              'price_credits', v_price), 201);
    return public.api_finish(ctx, v_res, 0);
  exception when others then
    -- Only this block is undone (the hold with it): nothing is held or queued.
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.oauth_get_balance(p_token_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx   jsonb := public.api_begin(p_token_hash, 'oauth.balance', p_request_id);
  v_org uuid;
  acc   public.credit_accounts;
  v_spent numeric;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_org := (ctx ->> 'org_id')::uuid;
    if (ctx ->> 'exempt')::boolean then
      return public.api_finish(ctx, public.api_ok(jsonb_build_object('exempt', true)));
    end if;
    select * into acc from public.credit_accounts where org_id = v_org;
    v_spent := public.oauth_grant_month_credits((ctx ->> 'grant_id')::uuid);
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'credits', jsonb_build_object('available',
                                      case when coalesce(acc.use_extra_credits, true)
                                           then greatest(coalesce(acc.balance, 0) - coalesce(acc.reserved, 0), 0)
                                           else public.credit_spendable_internal(v_org) end,
                                    'held', coalesce(acc.reserved, 0))
                 || case when coalesce(acc.use_extra_credits, true) then '{}'::jsonb
                         else jsonb_build_object('extra_credits_off', true) end,
      'plan', public.org_plan_internal(v_org),
      'videos_in_progress', (select count(*) from public.credit_reservations r where r.org_id = v_org and r.status = 'open'),
      'videos_at_once_limit', public.entitlement_int_internal(v_org, 'concurrency'),
      'this_connection', jsonb_build_object('monthly_limit_credits', (ctx ->> 'limit_credits')::numeric,
                                            'spent_this_month_credits', v_spent,
                                            'left_this_month_credits', greatest((ctx ->> 'limit_credits')::numeric - v_spent, 0)))));
  exception when others then
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The person flips the switch
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_use_extra_credits(p_org uuid, p_on boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  me   uuid := auth.uid();
  was_ boolean;
begin
  if me is null then
    raise exception 'sign in to change this' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'say whether extra credits are on or off' using errcode = '22023';
  end if;
  -- The person who runs the workspace, bound to this account (not an invitation
  -- matched by e-mail, not the platform operator acting for a customer).
  if p_org is null or not exists (
       select 1 from public.org_members m
        where m.org_id = p_org and m.user_id = me and m.role in ('owner', 'admin')) then
    raise exception 'only the person who runs this workspace may change this' using errcode = '42501';
  end if;
  -- Account lock first, like every money function: a reservation in flight
  -- finishes before this takes effect, and the next one sees the new value.
  perform public.credit_account_lock(p_org);
  select a.use_extra_credits into was_ from public.credit_accounts a where a.org_id = p_org;
  update public.credit_accounts
     set use_extra_credits = p_on, updated_at = now()
   where org_id = p_org;
  return jsonb_build_object('use_extra_credits', p_on, 'changed', was_ is distinct from p_on);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The Usage page's read
-- ───────────────────────────────────────────────────────────────────────────
-- Live lots only (not expired): a lot that ran out at the end of its period is
-- history, and counting its emptied remainder as "spent" would be a lie. Plan
-- credits "granted" is what the period's lot(s) were given (the first payment,
-- plus a mid-period upgrade's pro-rated top-up); "spent" is what the runs have
-- charged from them (granted - remaining); "held" is on hold for runs in
-- progress and is not yet spent. Nothing here is a margin, a cost or another
-- workspace's figure.

create or replace function public.usage_summary(p_org uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with acc as (
    select a.use_extra_credits as on_ from public.credit_accounts a where a.org_id = p_org
  ), live as (
    select source, amount, remaining, held, expires_at, period_start, period_end
      from public.credit_lots
     where org_id = p_org and (expires_at is null or expires_at > now())
  ), planlots as (
    select * from live where source = 'subscription'
  ), packs as (
    select * from live where source = 'pack' and remaining > held
  ), bonus as (
    select * from live where source in ('grant', 'adjustment') and remaining > held
  ), plan_ as (
    select p.* from public.plans p where p.id = public.org_plan_internal(p_org)
  ), sub as (
    select s.* from public.subscriptions s
     where s.org_id = p_org
     order by (s.status in ('active', 'trialing', 'past_due')) desc, s.updated_at desc, s.id desc
     limit 1
  )
  select case when not public.billing_may_read(p_org) then null else jsonb_build_object(
    'exempt', public.credits_exempt(p_org),
    'extra_enabled', coalesce((select on_ from acc), true),
    'plan', (select jsonb_build_object('id', id, 'name', name, 'monthly_credits', monthly_credits,
                                       'is_default', is_default) from plan_),
    'subscription', (select jsonb_build_object(
                       'status', status,
                       'current_period_start', current_period_start,
                       'current_period_end', current_period_end,
                       'cancel_at_period_end', cancel_at_period_end) from sub),
    'plan_credits', (select case when count(*) = 0 then null else jsonb_build_object(
                       'granted', sum(amount),
                       'spent', sum(amount - remaining),
                       'held', sum(held),
                       'left', sum(remaining - held),
                       'period_start', min(period_start),
                       'period_end', max(period_end)) end from planlots),
    'last_plan_period_end', (select max(l.period_end) from public.credit_lots l
                              where l.org_id = p_org and l.source = 'subscription'),
    'extra_credits', jsonb_build_object(
      'available', coalesce((select sum(remaining - held) from packs), 0),
      'soonest_expiry', (select min(expires_at) from packs)),
    'bonus_credits', jsonb_build_object(
      'available', coalesce((select sum(remaining - held) from bonus), 0),
      'soonest_expiry', (select min(expires_at) from bonus)),
    'spendable_now', public.credit_spendable_internal(p_org),
    'run_slots', public.org_run_slots(p_org),
    'entitlements', coalesce((
      select jsonb_object_agg(e.key, e.value)
        from jsonb_each(public.org_entitlements_internal(p_org)) e
        join public.entitlement_keys k on k.key = e.key and k.status = 'enforced'), '{}'::jsonb))
  end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Who may call what
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.credit_spendable_internal(uuid) from public, anon, authenticated, service_role;
-- Restated: both were replaced above. 0020's grants for reserve_credits (a
-- signed-in browser and the service role; never anon); 0034's none for the lock.
revoke all on function public.reserve_credits(uuid, text, numeric) from public, anon;
grant execute on function public.reserve_credits(uuid, text, numeric) to authenticated, service_role;
revoke all on function public.credit_lots_hold_locked(uuid, text, numeric, bigint) from public, anon, authenticated, service_role;
-- 0034's none for the spend lock; 0030's request_download: a signed-in browser only.
revoke all on function public.credit_lots_spend_locked(uuid, numeric, text, bigint, bigint) from public, anon, authenticated, service_role;
revoke all on function public.request_download(text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.request_download(text, text, numeric) to authenticated;
-- 0093's grants for the two connected-app functions replaced above: the anon key (they check the token themselves).
revoke all on function public.oauth_create_video(text, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.oauth_get_balance(text, text) from public, anon, authenticated, service_role;
grant execute on function public.oauth_create_video(text, text, jsonb, text, text) to anon;
grant execute on function public.oauth_get_balance(text, text) to anon;

revoke all on function public.set_use_extra_credits(uuid, boolean) from public, anon, service_role;
grant execute on function public.set_use_extra_credits(uuid, boolean) to authenticated;
revoke all on function public.usage_summary(uuid) from public, anon;
grant execute on function public.usage_summary(uuid) to authenticated, service_role;

-- Verify (expect every column true):
--   select
--     exists (select 1 from information_schema.columns where table_schema = 'public'
--              and table_name = 'credit_accounts' and column_name = 'use_extra_credits'
--              and column_default = 'true' and is_nullable = 'NO') as switch_column,
--     not exists (select 1 from public.credit_accounts where not use_extra_credits) as everyone_on_until_they_choose,
--     pg_get_functiondef('public.credit_lots_hold_locked(uuid, text, numeric, bigint)'::regprocedure) like '%extra_ or source <> ''pack''%' as hold_skips_packs_when_off,
--     pg_get_functiondef('public.reserve_credits(uuid, text, numeric)'::regprocedure) like '%extra_off=1%' as reserve_refuses_when_off,
--     has_function_privilege('authenticated', 'public.set_use_extra_credits(uuid, boolean)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.set_use_extra_credits(uuid, boolean)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.set_use_extra_credits(uuid, boolean)', 'EXECUTE')
--       and has_function_privilege('authenticated', 'public.usage_summary(uuid)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.usage_summary(uuid)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.credit_spendable_internal(uuid)', 'EXECUTE') as acl_ok;
