-- 0042_web_api_hardening.sql — welcome credits once per mailbox, API keys
-- minted by the database, API requests that stay counted when they fail, and
-- a per-user rate limit for the web routes that spend the operator's quota.
--
-- WHAT IT CHANGES
--   P5  grant_welcome_credits() (trigger, 0027) also grants once per
--       NORMALISED email address: lower-case, "+tag" dropped from the local
--       part, and for gmail.com / googlemail.com the dots dropped and the two
--       domains treated as one. `a.b+1@gmail.com`, `ab+2@googlemail.com` and
--       `AB@gmail.com` are one mailbox and earn one grant between them. The
--       claim lives in welcome_credit_claims under the SHA-256 of the
--       normalised address (the address itself is not copied anywhere); the
--       existing per-user marker (credit_transactions 'welcome:<uid>') still
--       applies. Existing grants are back-filled as claims, so an alias of an
--       address that was already paid gets nothing either.
--   P6  Every anon API entry point (api_auth … api_get_download) runs its
--       work inside an exception block. api_begin() has already counted the
--       request (api_rate_counters) before the block starts, so an error in
--       the work undoes only the work: the request stays counted against the
--       per-minute limit and is logged in api_requests as a 500 with a
--       structured `internal_error` body, instead of the whole RPC rolling
--       back and leaving no trace. api_begin's own tail (act-as, the
--       creator-still-admin check, last_used_at) is guarded the same way.
--       Bodies are the latest definitions — 0040 for api_begin and api_auth,
--       0031 for the others — unchanged inside the block.
--   P7  create_api_key(p_org, p_name, p_monthly_limit_cents) generates the key
--       itself (`nsk_live_` + 43 base62 characters, 256 bits from
--       gen_random_uuid()'s strong random source), stores only its SHA-256
--       and returns the full key ONCE in its result. The signatures that took
--       a client-chosen hash — (uuid,text,text,bigint) from 0040 and
--       (uuid,text,text,text,bigint) from 0031 — are dropped, so a weak or
--       reused key can no longer be registered. The key is not written to any
--       table, log row or audit detail.
--   C8  take_web_rate(bucket, max, window_seconds): a fixed-window counter per
--       signed-in user, for Command Center routes that spend the operator's
--       ElevenLabs characters or Actions minutes (voice list, voice preview).
--       Callable by `authenticated` only; counts only for auth.uid().
--   P8  telegram_updates: the Telegram control bot claims each update_id here
--       (service key, insert-if-new) before handling it, so an update that
--       Telegram delivers again — after the Actions cache holding the offset
--       was evicted or restored from an older copy — is skipped, not replayed.
--       Nobody but the service role touches it.
--
-- NOT CHANGED: who may create / revoke / use an API key, limits, prices, the
-- API's grants to anon, the welcome amount (100), the credit ledger.
--
-- REQUIRES 0027 (welcome credits) and 0040 (API keys without a prefix).
-- Idempotent: every statement can run again.

do $$
begin
  if to_regprocedure('public.grant_welcome_credits()') is null then
    raise exception '0042 needs welcome credits: apply 0027_welcome_credits.sql first';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'api_keys_prefix_retired') then
    raise exception '0042 needs API keys without a prefix: apply 0040_api_keys_no_prefix.sql first';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- P5. Welcome credits: once per mailbox, not once per alias
-- ───────────────────────────────────────────────────────────────────────────

-- The mailbox an address delivers to, as far as it can be known without
-- asking the provider: null when there is no usable address.
create or replace function public.welcome_email_key(p_email text) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  e   text := lower(btrim(coalesce(p_email, '')));
  at  integer;
  loc text;
  dom text;
begin
  if position('@' in e) = 0 then
    return null;
  end if;
  at  := length(e) - position('@' in reverse(e)) + 1;  -- the last '@'
  loc := split_part(left(e, at - 1), '+', 1);
  dom := substr(e, at + 1);
  if dom in ('gmail.com', 'googlemail.com') then
    loc := replace(loc, '.', '');
    dom := 'gmail.com';
  end if;
  if loc = '' or dom = '' then
    return null;
  end if;
  return loc || '@' || dom;
end
$$;

create table if not exists public.welcome_credit_claims (
  email_key  text primary key check (email_key ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null,
  org_id     uuid not null,
  created_at timestamptz not null default now()
);
comment on table public.welcome_credit_claims is
  'Welcome credits granted, one row per normalised email address (0042). email_key is the SHA-256 of welcome_email_key(email); the address itself is not stored. Written only by grant_welcome_credits().';
alter table public.welcome_credit_claims enable row level security;
revoke all on public.welcome_credit_claims from public, anon, authenticated;

-- Everyone already paid holds their mailbox, so a later alias of it gets nothing.
insert into public.welcome_credit_claims (email_key, user_id, org_id, created_at)
select distinct on (k.email_key) k.email_key, u.id, t.org_id, t.created_at
  from public.credit_transactions t
  join auth.users u on t.external_id = 'welcome:' || u.id::text
  cross join lateral (
    select encode(sha256(convert_to(public.welcome_email_key(u.email), 'UTF8')), 'hex') as email_key
  ) k
 where t.kind = 'grant' and k.email_key is not null
 order by k.email_key, t.created_at
on conflict (email_key) do nothing;

-- 0027's trigger, plus the mailbox claim taken in the same subtransaction as
-- the grant: whichever of two aliases commits first holds the claim, and the
-- other's insert hits the primary key and grants nothing.
create or replace function public.grant_welcome_credits() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- WELCOME_CREDITS: the one place the amount is set.
  welcome_credits constant numeric := 100;
  uid    uuid := auth.uid();
  marker text;
  v_key  text;
begin
  if uid is null or new.created_by is distinct from uid then
    return new;
  end if;
  if public.credits_exempt(new.id) then
    return new;
  end if;
  -- This row is visible to its own AFTER trigger, so "first" is a count of 1.
  if (select count(*) from public.organizations where created_by = uid) <> 1 then
    return new;
  end if;
  select encode(sha256(convert_to(public.welcome_email_key(u.email), 'UTF8')), 'hex')
    into v_key
    from auth.users u where u.id = uid and u.email_confirmed_at is not null;
  if v_key is null then
    return new;
  end if;

  marker := 'welcome:' || uid::text;
  if exists (select 1 from public.credit_transactions where external_id = marker)
     or exists (select 1 from public.welcome_credit_claims where email_key = v_key) then
    return new;
  end if;

  begin
    insert into public.welcome_credit_claims (email_key, user_id, org_id) values (v_key, uid, new.id);
    perform public.credit_account_lock(new.id);
    update public.credit_accounts
       set balance = balance + welcome_credits, updated_at = now()
     where org_id = new.id;
    perform public.credit_log(new.id, 'grant', welcome_credits, null, marker, 'welcome credits');
  exception when unique_violation then
    -- Another account on the same mailbox (or another call for this account)
    -- won the race: this subtransaction, balance included, is rolled back and
    -- the organization is still created.
    null;
  end;
  return new;
end
$$;

revoke all on function public.grant_welcome_credits() from public, anon, authenticated, service_role;
revoke all on function public.welcome_email_key(text) from public, anon, authenticated, service_role;

comment on function public.grant_welcome_credits() is
  'Trigger (0027, 0042): 100 credits into the first organization a confirmed account creates — once per user (external_id welcome:<user id>) and once per normalised email address (welcome_credit_claims). Not callable directly.';

-- ───────────────────────────────────────────────────────────────────────────
-- C8. A per-user rate limit for web routes that spend the operator's quota
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.web_rate_counters (
  user_id      uuid not null,
  bucket       text not null check (bucket ~ '^[a-z0-9_.:-]{1,64}$'),
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, bucket, window_start)
);
comment on table public.web_rate_counters is
  'Fixed-window request counts per signed-in user and bucket (0042), written only by take_web_rate().';
alter table public.web_rate_counters enable row level security;
revoke all on public.web_rate_counters from public, anon, authenticated;

-- True when the caller may make one more request in `p_bucket` now (and
-- counts it); false when this window's allowance is spent.
create or replace function public.take_web_rate(p_bucket text, p_max integer, p_window_seconds integer)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  v_start timestamptz;
  v_used  integer;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if coalesce(p_bucket, '') !~ '^[a-z0-9_.:-]{1,64}$'
     or p_max is null or p_max not between 1 and 1000
     or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'bad rate limit arguments' using errcode = '22023';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.web_rate_counters as c (user_id, bucket, window_start, count)
  values (uid, p_bucket, v_start, 1)
  on conflict (user_id, bucket, window_start) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.web_rate_counters c
     where c.user_id = uid and c.bucket = p_bucket and c.window_start < v_start;
  end if;
  return v_used <= p_max;
end
$$;

revoke all on function public.take_web_rate(text, integer, integer) from public, anon, service_role;
grant execute on function public.take_web_rate(text, integer, integer) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- P8. Telegram updates, handled once
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.telegram_updates (
  update_id  bigint primary key check (update_id >= 0),
  claimed_at timestamptz not null default now()
);
comment on table public.telegram_updates is
  'Telegram update ids the control bot has claimed (0042): a claimed update is never handled again. Service role only.';
alter table public.telegram_updates enable row level security;
revoke all on public.telegram_updates from public, anon, authenticated;
grant select, insert on public.telegram_updates to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- P7. API keys are minted here, not in the browser
-- ───────────────────────────────────────────────────────────────────────────

drop function if exists public.create_api_key(uuid, text, text, text, bigint);
drop function if exists public.create_api_key(uuid, text, text, bigint);

-- 0040's checks, lock and audit row; the key is generated here and returned
-- once. Only its SHA-256 is stored — the same hash lib/api/keys.ts computes
-- for a presented key.
create or replace function public.create_api_key(
  p_org uuid, p_name text, p_monthly_limit_cents bigint default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  b62      constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_name   text := btrim(coalesce(p_name, ''));
  v_active integer;
  v_secret text := '';
  v_bytes  bytea;
  v_byte   integer;
  v_key    text;
  i        integer;
  k        public.api_keys;
begin
  if auth.uid() is null or not public.is_org_member(p_org, 'admin') then
    raise exception 'only an owner or admin of this organization may create API keys' using errcode = '42501';
  end if;
  if not exists (select 1 from public.api_settings where org_id = p_org and activated_at is not null) then
    raise exception 'activate the API first' using errcode = 'NS403';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'name the key (1 to 60 characters)' using errcode = '22023';
  end if;
  if p_monthly_limit_cents is not null and (p_monthly_limit_cents < 0 or p_monthly_limit_cents > 100000000) then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  -- Two tabs creating the eleventh key at once: one waits for the other.
  perform pg_advisory_xact_lock(hashtextextended('api_keys:' || p_org::text, 0));
  select count(*) into v_active from public.api_keys where org_id = p_org and revoked_at is null;
  if v_active >= 10 then
    raise exception 'this organization already has 10 active API keys; revoke one first' using errcode = 'NS409';
  end if;

  -- 43 base62 characters (256 bits) from gen_random_uuid(), which draws on
  -- the server's strong random source. Bytes 6 and 8 carry the UUID version
  -- and variant bits and are skipped; a byte >= 248 (4 * 62) is redrawn so
  -- every character is equally likely.
  while char_length(v_secret) < 43 loop
    v_bytes := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      continue when i in (6, 8);
      v_byte := get_byte(v_bytes, i);
      continue when v_byte >= 248;
      v_secret := v_secret || substr(b62, v_byte % 62 + 1, 1);
      exit when char_length(v_secret) = 43;
    end loop;
  end loop;
  v_key := 'nsk_live_' || v_secret;

  insert into public.api_keys (org_id, name, key_hash, monthly_limit_cents, created_by)
  values (p_org, v_name, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), p_monthly_limit_cents, auth.uid())
  returning * into k;
  insert into public.app_audit_log (actor_user_id, actor_email, action, target, detail)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'api_key.create', k.id::text,
          jsonb_build_object('org_id', p_org, 'name', v_name));
  -- The only copy of the key leaves in this result.
  return jsonb_build_object('id', k.id, 'name', k.name, 'created_at', k.created_at, 'key', v_key);
end
$$;

revoke all on function public.create_api_key(uuid, text, bigint) from public, anon, service_role;
grant execute on function public.create_api_key(uuid, text, bigint) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- P6. A request that fails is still a request
-- ───────────────────────────────────────────────────────────────────────────

-- api_begin: 0040's body. The tail after the count runs in a block, so a
-- failure there cannot roll the count back.
create or replace function public.api_begin(p_key_hash text, p_endpoint text, p_request_id text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k        public.api_keys;
  s        public.api_settings;
  acc      public.api_accounts;
  v_exempt boolean;
  v_tier   integer;
  lim      record;
  v_minute timestamptz := date_trunc('minute', now());
  v_used   integer;
  v_reset  integer;
  ctx      jsonb;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into k from public.api_keys where key_hash = p_key_hash;
  if k.id is null or k.revoked_at is not null then
    return public.api_err(401, 'invalid_api_key', 'The API key is missing, malformed, revoked or unknown.');
  end if;
  select * into s from public.api_settings where org_id = k.org_id;
  if s.activated_at is null then
    return public.api_err(403, 'api_not_activated',
      'The API is not activated for this organization. An owner or admin can activate it in the Developer console.');
  end if;

  v_exempt := public.credits_exempt(k.org_id);
  select * into acc from public.api_accounts where org_id = k.org_id;
  v_tier := public.api_tier_for(coalesce(acc.paid_total_cents, 0), v_exempt);
  select * into lim from public.api_tier_limits(v_tier);

  v_reset := greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  insert into public.api_rate_counters as c (key_id, minute, count)
  values (k.id, v_minute, 1)
  on conflict (key_id, minute) do update set count = c.count + 1
  returning c.count into v_used;
  if v_used = 1 then
    delete from public.api_rate_counters c where c.key_id = k.id and c.minute < v_minute;
  end if;

  ctx := jsonb_build_object('ok', true, 'key_id', k.id, 'org_id', k.org_id,
    'created_by', k.created_by, 'tier', v_tier, 'exempt', v_exempt,
    'rpm', lim.rpm, 'concurrency', lim.concurrency,
    'cap_cents', case when v_exempt then null
                      else least(lim.monthly_cap_cents, coalesce(s.monthly_limit_cents, lim.monthly_cap_cents)) end,
    'key_limit_cents', k.monthly_limit_cents,
    'remaining', greatest(0, lim.rpm - v_used), 'reset', v_reset,
    'endpoint', coalesce(p_endpoint, 'unknown'), 'request_id', p_request_id);

  if v_used > lim.rpm then
    return public.api_finish(ctx, public.api_err(429, 'rate_limit_exceeded',
      format('This key is limited to %s requests per minute on usage tier %s.', lim.rpm, v_tier),
      jsonb_build_object('retry_after', v_reset)));
  end if;

  begin
    perform public.api_act_as(k.created_by);
    if not public.is_org_member(k.org_id, 'admin') then
      return public.api_finish(ctx, public.api_err(403, 'key_owner_not_admin',
        'The person who created this key is no longer an owner or admin of its organization. An admin must create a new key.'));
    end if;

    update public.api_keys set last_used_at = now()
     where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
  return ctx;
end
$$;

-- The entry points: 0031's bodies (api_auth: 0040's), the work in a block.
create or replace function public.api_auth(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'me', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'organization', (select jsonb_build_object('id', o.id, 'name', o.name)
                         from public.organizations o where o.id = (ctx ->> 'org_id')::uuid),
      'key', (select jsonb_build_object('id', k.id, 'name', k.name)
                from public.api_keys k where k.id = (ctx ->> 'key_id')::uuid),
      'tier', (ctx ->> 'tier')::int,
      'limits', jsonb_build_object('requests_per_minute', (ctx ->> 'rpm')::int,
                                   'concurrent_videos', (ctx ->> 'concurrency')::int,
                                   'monthly_limit_cents', (ctx ->> 'cap_cents')::bigint,
                                   'key_monthly_limit_cents', (ctx ->> 'key_limit_cents')::bigint))));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_balance(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'balance', p_request_id);
  acc public.api_accounts;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select * into acc from public.api_accounts where org_id = (ctx ->> 'org_id')::uuid;
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'currency', 'usd',
      'exempt', (ctx ->> 'exempt')::boolean,
      'balance_cents', coalesce(acc.balance_cents, 0),
      'reserved_cents', coalesce(acc.reserved_cents, 0),
      'available_cents', coalesce(acc.balance_cents, 0) - coalesce(acc.reserved_cents, 0),
      'month_spend_cents', public.api_month_spend((ctx ->> 'org_id')::uuid),
      'monthly_limit_cents', (ctx ->> 'cap_cents')::bigint,
      'tier', (ctx ->> 'tier')::int)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_create_video(
  p_key_hash text, p_channel_id text, p_params jsonb,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'videos.create', p_request_id);
  v_org   uuid;
  ch      public.channels;
  v_p     jsonb := coalesce(p_params, '{}'::jsonb);
  v_busy  integer;
  v_secs  numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_job   bigint;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;

    select * into ch from public.channels c where c.channel_id = p_channel_id;
    if ch.channel_id is null or ch.org_id is distinct from v_org then
      v_res := public.api_err(404, 'channel_not_found', 'No channel with that id in this key''s organization.');
    elsif upper(btrim(coalesce(ch.status, ''))) <> 'ACTIVE' then
      v_res := public.api_err(409, 'channel_not_active',
        'That channel is not active. Connect it to YouTube and activate it in the Command Center first.');
    elsif jsonb_typeof(v_p) <> 'object'
       or (v_p - array['topic','niche','duration','language','visual_style',
                       'video_provider','image_provider']) <> '{}'::jsonb
       or not public.render_job_params_valid(v_p, 'daily') then
      v_res := public.api_err(400, 'invalid_params',
        'Allowed: topic (<=300 chars), niche (<=120), duration (whole seconds, 30-3600), language (<=40), visual_style (<=300), video_provider, image_provider.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- Concurrency, under a per-organization lock so two creates cannot both
    -- take the last slot.
    perform pg_advisory_xact_lock(hashtextextended('api_render_jobs:' || v_org::text, 0));
    select count(*) into v_busy
      from public.render_jobs j join public.channels c on c.channel_id = j.channel_id
     where c.org_id = v_org and j.status in ('queued', 'running');
    if v_busy >= (ctx ->> 'concurrency')::int then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(429, 'concurrency_limit_exceeded',
        format('Usage tier %s runs at most %s videos at once. Wait for one to finish.', ctx ->> 'tier', ctx ->> 'concurrency'),
        jsonb_build_object('retry_after', 60))));
    end if;

    if not (ctx ->> 'exempt')::boolean then
      v_secs := coalesce((v_p ->> 'duration')::numeric,
                         case when jsonb_typeof(ch.agent_config -> 'target_duration_seconds') = 'number'
                              then (ch.agent_config ->> 'target_duration_seconds')::numeric end);
      if v_secs is null or v_secs <= 0 then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(400, 'duration_required',
          'Pass duration (seconds): this channel has no target length to price the video by.')));
      end if;
      v_price := public.api_video_price(v_secs);
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          'The API price list is not set up on this deployment; nothing was charged.')));
      end if;

      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'monthly_limit_reached',
          'This video would take the organization past its monthly API spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend,
                             'price_cents', v_price))));
      end if;
      if ctx ->> 'key_limit_cents' is not null
         and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'key_limit_reached',
          'This video would take this key past its own monthly spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price))));
      end if;
      if acc.balance_cents - acc.reserved_cents < v_price then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this video. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents))));
      end if;

      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('%s seconds on %s', v_secs, ch.channel_id));
    end if;

    -- 0019's insert policy, stated as the row itself: a daily job, queued, no
    -- privacy/resume/repair, filed as the key's creator.
    insert into public.render_jobs (channel_id, kind, params, requested_by, api_hold_ref)
    values (ch.channel_id, 'daily', v_p, (ctx ->> 'created_by')::uuid, v_ref)
    returning id into v_job;
    if v_ref is not null then
      update public.api_holds set render_job_id = v_job where ref = v_ref;
    end if;

    perform public.api_audit(ctx, 'agent.run', ch.channel_id, ch.channel_id,
      v_p || jsonb_build_object('backend', 'queue', 'job_id', v_job, 'api_hold_ref', v_ref, 'price_cents', v_price));

    v_res := public.api_ok(jsonb_build_object('job_id', v_job, 'channel_id', ch.channel_id, 'status', 'queued',
                                              'price_cents', v_price), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_get_job(p_key_hash text, p_job_id bigint, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'jobs.get', p_request_id);
  j   public.render_jobs;
  h   public.api_holds;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select jj.* into j from public.render_jobs jj join public.channels c on c.channel_id = jj.channel_id
     where jj.id = p_job_id and c.org_id = (ctx ->> 'org_id')::uuid;
    if j.id is null then
      return public.api_finish(ctx, public.api_err(404, 'job_not_found', 'No job with that id in this key''s organization.'));
    end if;
    select * into h from public.api_holds where ref = j.api_hold_ref;
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'id', j.id, 'channel_id', j.channel_id, 'status', j.status, 'params', j.params,
      'attempts', j.attempts, 'created_at', j.created_at, 'started_at', j.started_at,
      'finished_at', j.finished_at, 'error', j.error,
      'charge', case when h.ref is null then null
                     else jsonb_build_object('status', h.status, 'held_cents', h.amount_cents,
                                             'captured_cents', h.captured_cents) end)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_list_videos(
  p_key_hash text, p_channel_id text default null, p_limit integer default 20, p_offset integer default 0,
  p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'videos.list', p_request_id);
  lim integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  off integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'videos', coalesce((select jsonb_agg(public.api_video_json(v) order by v.published_at desc nulls last, v.video_id)
                            from (select vv.* from public.videos vv
                                    join public.channels c on c.channel_id = vv.channel_id
                                   where c.org_id = (ctx ->> 'org_id')::uuid
                                     and (p_channel_id is null or vv.channel_id = p_channel_id)
                                   order by vv.published_at desc nulls last, vv.video_id
                                   limit lim offset off) v), '[]'::jsonb),
      'limit', lim, 'offset', off)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_get_video(p_key_hash text, p_video_id text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'videos.get', p_request_id);
  v   public.videos;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select vv.* into v from public.videos vv join public.channels c on c.channel_id = vv.channel_id
     where vv.video_id = p_video_id and c.org_id = (ctx ->> 'org_id')::uuid;
    if v.video_id is null then
      return public.api_finish(ctx, public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.'));
    end if;
    return public.api_finish(ctx, public.api_ok(public.api_video_json(v) || jsonb_build_object(
      'publish_requests', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'platform', r.platform, 'account_id', r.account_id,
          'target_channel_id', r.target_channel_id, 'status', r.status, 'reason', r.reason,
          'result_url', r.result_url, 'created_at', r.created_at, 'finished_at', r.finished_at)
          order by r.created_at desc)
        from (select * from public.publish_requests pr
               where pr.video_id = v.video_id and pr.org_id = (ctx ->> 'org_id')::uuid
               order by pr.created_at desc limit 20) r), '[]'::jsonb))));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_request_publish(
  p_key_hash text, p_video_id text, p_account_ids uuid[], p_channel_ids text[],
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'videos.publish', p_request_id);
  v_ch    text;
  v_org   uuid;
  a       uuid;
  t       text;
  r       public.publish_requests;
  v_rows  jsonb := '[]'::jsonb;
  v_errs  jsonb := '[]'::jsonb;
  v_res   jsonb;
  v_accts uuid[] := coalesce((select array_agg(distinct x) from unnest(p_account_ids) x where x is not null), '{}');
  v_chans text[] := coalesce((select array_agg(distinct x) from unnest(p_channel_ids) x
                               where x ~ '^[A-Za-z0-9._-]{1,128}$'), '{}');
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    select v.channel_id, c.org_id into v_ch, v_org
      from public.videos v join public.channels c on c.channel_id = v.channel_id
     where v.video_id = p_video_id;
    if v_ch is null or v_org is distinct from (ctx ->> 'org_id')::uuid then
      v_res := public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.');
    elsif cardinality(v_accts) + cardinality(v_chans) = 0 then
      v_res := public.api_err(400, 'targets_required', 'Name at least one account_id or YouTube channel_id.');
    elsif cardinality(v_accts) + cardinality(v_chans) > 10 then
      v_res := public.api_err(400, 'too_many_targets', 'At most 10 targets per request.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    foreach a in array v_accts loop
      begin
        insert into public.publish_requests (video_id, account_id) values (p_video_id, a) returning * into r;
        v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', r.id, 'platform', r.platform,
                    'account_id', r.account_id, 'target_channel_id', null, 'status', r.status, 'reason', r.reason));
      exception
        when unique_violation then
          v_errs := v_errs || jsonb_build_array(jsonb_build_object('account_id', a, 'error', 'already_sending'));
        when insufficient_privilege then
          v_errs := v_errs || jsonb_build_array(jsonb_build_object('account_id', a, 'error', 'forbidden'));
      end;
    end loop;
    foreach t in array v_chans loop
      begin
        insert into public.publish_requests (video_id, target_channel_id) values (p_video_id, t) returning * into r;
        v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', r.id, 'platform', r.platform,
                    'account_id', null, 'target_channel_id', r.target_channel_id, 'status', r.status, 'reason', r.reason));
      exception
        when unique_violation then
          v_errs := v_errs || jsonb_build_array(jsonb_build_object('channel_id', t, 'error', 'already_sending'));
        when insufficient_privilege or foreign_key_violation then
          v_errs := v_errs || jsonb_build_array(jsonb_build_object('channel_id', t, 'error', 'forbidden'));
      end;
    end loop;

    perform public.api_audit(ctx, 'video.publish_request', p_video_id, v_ch,
      jsonb_build_object('requests', v_rows) || case when jsonb_array_length(v_errs) > 0
                                                      then jsonb_build_object('errors', v_errs) else '{}'::jsonb end);
    if jsonb_array_length(v_rows) > 0 then
      v_res := public.api_ok(jsonb_build_object('requests', v_rows, 'errors', v_errs));
    else
      v_res := public.api_err(409, 'publish_refused', 'No publish request could be recorded.',
                              jsonb_build_object('errors', v_errs));
    end if;
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_list_channels(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'channels.list', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('channels', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.channel_id, 'name', c.name, 'niche', c.niche,
               'active', upper(btrim(coalesce(c.status, ''))) = 'ACTIVE',
               'youtube_connected', public.publish_channel_connected(c.channel_id),
               'target_duration_seconds', case when jsonb_typeof(c.agent_config -> 'target_duration_seconds') = 'number'
                                               then c.agent_config -> 'target_duration_seconds' end)
               order by c.channel_id)
        from public.channels c where c.org_id = (ctx ->> 'org_id')::uuid), '[]'::jsonb))));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_list_connected_accounts(p_key_hash text, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'accounts.list', p_request_id);
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    return public.api_finish(ctx, public.api_ok(jsonb_build_object('accounts',
      coalesce((select jsonb_agg(jsonb_build_object('platform', 'youtube', 'channel_id', c.channel_id,
                  'name', coalesce(nullif(c.credential_ref ->> 'youtube_title', ''), c.name),
                  'connected', public.publish_channel_connected(c.channel_id)) order by c.channel_id)
                  from public.channels c where c.org_id = (ctx ->> 'org_id')::uuid), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('platform', s.platform, 'account_id', s.id,
                  'name', coalesce(s.display_name, s.username, s.platform), 'username', s.username,
                  'connected', s.status = 'connected') order by s.platform, s.created_at)
                  from public.social_accounts s
                 where s.org_id = (ctx ->> 'org_id')::uuid and s.status <> 'revoked'), '[]'::jsonb))));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_request_download(
  p_key_hash text, p_video_id text, p_quality text,
  p_idem_key text default null, p_fingerprint text default null, p_request_id text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx     jsonb := public.api_begin(p_key_hash, 'downloads.create', p_request_id);
  v_org   uuid;
  v_ch    text;
  q       text := btrim(coalesce(p_quality, ''));
  m       public.download_masters;
  r       public.download_requests;
  why     text;
  until_  timestamptz;
  credits numeric;
  v_price bigint;
  v_spend bigint;
  acc     public.api_accounts;
  v_ref   text;
  v_res   jsonb;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);
    if v_res is not null then
      return public.api_finish(ctx, v_res);
    end if;
    v_org := (ctx ->> 'org_id')::uuid;
    select c.channel_id into v_ch from public.videos v join public.channels c on c.channel_id = v.channel_id
     where v.video_id = p_video_id and c.org_id = v_org;
    if q not in ('720p', '1080p') then
      v_res := public.api_err(400, 'invalid_params', 'quality must be 720p or 1080p.');
    elsif v_ch is null then
      v_res := public.api_err(404, 'video_not_found', 'No video with that id in this key''s organization.');
    end if;
    if v_res is not null then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    -- 0030's lock: the site and the API decide one (org, video, quality) at a time.
    perform pg_advisory_xact_lock(hashtextextended(format('download:%s:%s:%s', v_org, p_video_id, q), 0));
    select * into r from public.download_requests d
     where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
       and (d.status in ('queued', 'processing') or (d.status = 'ready' and d.expires_at > now()))
     order by d.id desc limit 1;
    if r.id is not null then
      v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', r.quality,
                                                'price_cents', 0, 'reused', true, 'expires_at', r.expires_at));
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
    end if;

    select * into m from public.download_masters where video_id = p_video_id;
    if m.video_id is null or least(m.width, m.height) < public.download_quality_side(q) then
      return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(404, 'no_master',
        format('No full-quality master for this video at %s. Only videos rendered on the queue worker keep one.', q))));
    end if;

    if exists (select 1 from public.download_requests d
                where d.org_id = v_org and d.video_id = p_video_id and d.quality = q
                  and d.paid_until > now() and d.status <> 'failed') then
      why := 'redownload';
      until_ := (select max(d.paid_until) from public.download_requests d
                  where d.org_id = v_org and d.video_id = p_video_id and d.quality = q and d.status <> 'failed');
    elsif (ctx ->> 'exempt')::boolean then
      why := 'exempt';
      until_ := now() + interval '7 days';
    else
      credits := public.download_credits_price(m.duration_seconds, q);
      select ceil(credits * p.cents)::bigint into v_price from public.api_prices p where p.unit = 'download_cents_per_credit';
      if v_price is null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, public.api_err(503, 'pricing_unavailable',
          format('Downloads in %s are not priced on this deployment; nothing was charged.', q))));
      end if;
      until_ := now() + interval '7 days';
    end if;

    if v_price is not null and v_price > 0 then
      acc := public.api_account_lock(v_org);
      perform public.api_expire_holds_locked(v_org);
      select * into acc from public.api_accounts where org_id = v_org;
      v_spend := public.api_month_spend(v_org);
      if v_spend + v_price > (ctx ->> 'cap_cents')::bigint then
        v_res := public.api_err(402, 'monthly_limit_reached',
          'This download would take the organization past its monthly API spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend, 'price_cents', v_price));
      elsif ctx ->> 'key_limit_cents' is not null
            and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        v_res := public.api_err(402, 'key_limit_reached', 'This download would take this key past its own monthly spend limit.',
          jsonb_build_object('limit_cents', (ctx ->> 'key_limit_cents')::bigint, 'price_cents', v_price));
      elsif acc.balance_cents - acc.reserved_cents < v_price then
        v_res := public.api_err(402, 'insufficient_balance',
          'Your API balance does not cover this download. Top up in the Developer console.',
          jsonb_build_object('price_cents', v_price, 'available_cents', acc.balance_cents - acc.reserved_cents));
      end if;
      if v_res is not null then
        return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res));
      end if;
    end if;

    -- 0030's row, as the site writes it, filed as the key's creator; credits
    -- charged 0 (the API balance pays, below).
    insert into public.download_requests
      (org_id, channel_id, video_id, quality, status, charged, free_reason, paid_until, minutes, requested_by)
    values
      (v_org, v_ch, p_video_id, q, 'queued', 0, why, until_, round(m.duration_seconds / 60.0, 4),
       (ctx ->> 'created_by')::uuid)
    returning * into r;

    if v_price is not null and v_price > 0 then
      v_ref := 'ah-' || gen_random_uuid()::text;
      insert into public.api_holds (ref, org_id, key_id, download_request_id, amount_cents)
      values (v_ref, v_org, (ctx ->> 'key_id')::uuid, r.id, v_price);
      update public.api_accounts set reserved_cents = reserved_cents + v_price, updated_at = now()
       where org_id = v_org;
      perform public.api_log(v_org, 'hold', v_price, v_ref, (ctx ->> 'key_id')::uuid, null, null, null,
                             format('download %s of %s', q, p_video_id));
    end if;
    perform public.api_audit(ctx, 'video.download', p_video_id, v_ch,
      jsonb_build_object('download_id', r.id, 'quality', q, 'price_cents', v_price, 'free_reason', why));

    v_res := public.api_ok(jsonb_build_object('id', r.id, 'status', r.status, 'quality', q,
                                              'price_cents', coalesce(v_price, 0), 'free_reason', why,
                                              'reused', false), 201);
    return public.api_finish(ctx, public.api_idem_end(ctx, p_idem_key, v_res), coalesce(v_price, 0));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

create or replace function public.api_get_download(p_key_hash text, p_id bigint, p_request_id text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  ctx jsonb := public.api_begin(p_key_hash, 'downloads.get', p_request_id);
  r   public.download_requests;
  h   public.api_holds;
begin
  if not (ctx ->> 'ok')::boolean then
    return ctx;
  end if;
  begin
    select * into r from public.download_requests d where d.id = p_id and d.org_id = (ctx ->> 'org_id')::uuid;
    if r.id is null then
      return public.api_finish(ctx, public.api_err(404, 'download_not_found', 'No download with that id in this key''s organization.'));
    end if;
    select * into h from public.api_holds where download_request_id = r.id;
    return public.api_finish(ctx, public.api_ok(jsonb_build_object(
      'id', r.id, 'video_id', r.video_id, 'quality', r.quality,
      'status', case when r.status = 'ready' and r.expires_at <= now() then 'expired' else r.status end,
      'bytes', r.bytes, 'expires_at', r.expires_at, 'reason', r.reason, 'free_reason', r.free_reason,
      'created_at', r.created_at, 'finished_at', r.finished_at,
      'charge', case when h.ref is null then null
                     else jsonb_build_object('status', h.status, 'held_cents', h.amount_cents,
                                             'captured_cents', h.captured_cents) end)));
  exception when others then
    -- Only this block is undone: the request stays counted and is logged (P6).
    return public.api_finish(ctx, public.api_err(500, 'internal_error',
      'The request failed inside the database. Nothing was created or charged; retry with backoff.'));
  end;
end
$$;

-- create or replace keeps each function's grants; restated so a partial
-- earlier run cannot leave one wider than 0031 / 0040 made it.
revoke all on function public.api_begin(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_auth(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_balance(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_create_video(text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_get_job(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.api_list_videos(text, text, integer, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.api_get_video(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_request_publish(text, text, uuid[], text[], text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_list_channels(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_list_connected_accounts(text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_request_download(text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_get_download(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.api_auth(text, text) to anon;
grant execute on function public.api_balance(text, text) to anon;
grant execute on function public.api_create_video(text, text, jsonb, text, text, text) to anon;
grant execute on function public.api_get_job(text, bigint, text) to anon;
grant execute on function public.api_list_videos(text, text, integer, integer, text) to anon;
grant execute on function public.api_get_video(text, text, text) to anon;
grant execute on function public.api_request_publish(text, text, uuid[], text[], text, text, text) to anon;
grant execute on function public.api_list_channels(text, text) to anon;
grant execute on function public.api_list_connected_accounts(text, text) to anon;
grant execute on function public.api_request_download(text, text, text, text, text, text) to anon;
grant execute on function public.api_get_download(text, bigint, text) to anon;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   public.welcome_email_key('A.B+promo@GoogleMail.com') = 'ab@gmail.com'
--     and public.welcome_email_key('a.b+x@example.com') = 'a.b@example.com'
--     and public.welcome_email_key('nobody') is null as email_normalised,
--   (select relrowsecurity from pg_class where oid = 'public.welcome_credit_claims'::regclass)
--     and (select relrowsecurity from pg_class where oid = 'public.web_rate_counters'::regclass)
--     and (select relrowsecurity from pg_class where oid = 'public.telegram_updates'::regclass) as rls_on,
--   not has_table_privilege('authenticated', 'public.welcome_credit_claims', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.web_rate_counters', 'SELECT')
--     and not has_table_privilege('anon', 'public.telegram_updates', 'INSERT')
--     and has_table_privilege('service_role', 'public.telegram_updates', 'INSERT') as tables_closed,
--   to_regprocedure('public.create_api_key(uuid,text,text,bigint)') is null
--     and to_regprocedure('public.create_api_key(uuid,text,text,text,bigint)') is null as client_hash_gone,
--   has_function_privilege('authenticated', 'public.create_api_key(uuid,text,bigint)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.create_api_key(uuid,text,bigint)', 'EXECUTE')
--     and has_function_privilege('authenticated', 'public.take_web_rate(text,integer,integer)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.take_web_rate(text,integer,integer)', 'EXECUTE')
--     and has_function_privilege('anon', 'public.api_get_video(text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.api_begin(text,text,text)', 'EXECUTE') as grants_narrow,
--   position('exception when others' in pg_get_functiondef('public.api_create_video(text,text,jsonb,text,text,text)'::regprocedure)) > 0
--     and position('exception when others' in pg_get_functiondef('public.api_begin(text,text,text)'::regprocedure)) > 0
--     as failures_counted,
--   (public.api_begin(repeat('0', 64), 'me', null) -> 'error' ->> 'code') = 'invalid_api_key' as unknown_key_refused;
