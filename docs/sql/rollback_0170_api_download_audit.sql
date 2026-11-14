-- rollback_0170_api_download_audit.sql — takes migration 0170 (an API download audits a listed action name) out again.
-- OWNER-APPLY: paste into the Supabase SQL editor. Nothing in the app runs it.
--
-- WHAT IS LOST: nothing stored. WHAT COMES BACK is the failure 0170 fixed: api_request_download audits 'video.download'
-- again, the audit list (0087 onwards) refuses it for the API's role, and every new paid, redownload or exempt download
-- through the API answers 500 internal_error and charges nothing (only a reused one works). Apply it only to re-run 0147,
-- then apply 0170 again.
--
-- WHAT IT DOES, in one transaction:
--   0. REFUSES (changes nothing) if api_request_download is not 0170's body (a later change would be undone).
--   1. Puts 0147's api_request_download back, verbatim, with 0147's grants (anon only).
--   2. Asserts the end state: 0147's body, an anon-only SECURITY DEFINER with the pinned search_path.

begin;
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.api_request_download(text, text, text, text, text, text)');
  if h is distinct from 'b59ca71d0e0379e217e47a6987c9ed0c' then
    raise exception 'rollback 0170: public.api_request_download(text, text, text, text, text, text) is not 0170''s body (md5 %): a later change would be undone; read the live body first', h;
  end if;
end $$;

-- 0147's body, verbatim (0147_mcp_free_tier.sql).
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
          'This download would take the organization past its monthly API spend limit. An owner or admin can raise it in the Developer console: Developers → Usage and billing → Monthly spend limit (up to the usage tier''s cap; paying more into the API balance raises the tier).',
          jsonb_build_object('limit_cents', (ctx ->> 'cap_cents')::bigint, 'month_spend_cents', v_spend, 'price_cents', v_price));
      elsif ctx ->> 'key_limit_cents' is not null
            and public.api_month_spend(v_org, (ctx ->> 'key_id')::uuid) + v_price > (ctx ->> 'key_limit_cents')::bigint then
        v_res := public.api_err(402, 'key_limit_reached', 'This download would take this key past its own monthly spend limit. An owner or admin can raise or remove it in the Developer console: Developers → API keys → Set limit on this key.',
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
revoke all on function public.api_request_download(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.api_request_download(text, text, text, text, text, text) to anon;

do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('public.api_request_download(text, text, text, text, text, text)'))
       is distinct from '055003f8a2fb5390bbd1b5f7820e6e2e'
     or exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.api_request_download(text, text, text, text, text, text)')
                 and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                      or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
     or not has_function_privilege('anon', 'public.api_request_download(text, text, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_request_download(text, text, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.api_request_download(text, text, text, text, text, text)', 'EXECUTE') then
    raise exception 'rollback 0170 end state: public.api_request_download(text, text, text, text, text, text) is not 0147''s anon-only SECURITY DEFINER body';
  end if;
end $$;

commit;
