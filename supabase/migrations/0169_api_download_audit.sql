-- 0169_api_download_audit.sql — an HD download requested through the public API works again: api_request_download audits
-- itself under the action name the audit list has.
--
-- EVIDENCE (security lab, two independent reviewers; tests/security/test_sec_api_download.py, written first and run on main):
--   A paid API download (a tenant's own key, its own video, 720p), a redownload inside the paid window and the exempt
--   organization's download each answered
--     {"ok": false, "status": 500, "error": {"code": "internal_error", "message": "The request failed inside the database.
--      Nothing was created or charged; retry with backoff."}}
--   and left no request row, no hold and no ledger row. Only the "reused" answer (which writes no audit row) worked.
--
-- DIAGNOSIS: api_request_download (0031, rebuilt by 0042 and 0147) ends with perform public.api_audit(ctx, 'video.download',
--   ...). Since 0087, app_audit_log_stamp refuses with 22023 'unknown audit action' any action outside audit_action_allowed()
--   when the session's role is anon or authenticated, which it always is for an API call (PostgREST's SET ROLE survives the
--   definer function). The list has 'video.download_request' and has never had 'video.download' (0087 through 0145). The
--   function's own `exception when others` turns the 22023 into 500 internal_error and undoes its block: the request row,
--   the hold and the ledger row go with it. So every new download through the API (paid, redownload or exempt) has failed
--   closed since 0087 and charged nothing. The other api_* functions that audit themselves write names the list has, the
--   same ones the Command Center's routes write for the same act: video.publish_request, creative.generate, agent.run.
--
-- CHANGE: one hunk in api_request_download, nothing else: it audits 'video.download_request', the name the Command Center's
--   own download route writes for the same act (command-center/app/api/downloads/route.ts); the row still carries via=api
--   and the key's id, so the two doors stay apart. Chosen over adding 'video.download' to audit_action_allowed: the list
--   stays exactly as 0145 left it (nothing is widened), no reader expects 'video.download' (no route, page, label or doc
--   reads an action by that name; the audit page prints the action as stored), and one act keeps one name. Rows written
--   before 0087 under 'video.download' stay as they are. tests/test_audit_actions.py now also reads every api_audit(...)
--   action in each function's latest body, so a name the list does not have fails a unit test instead of a paying customer.
--
-- REPLACES (md5 drift guard: 0147's body, or this file's own on a replay; whitespace runs read as one space):
--   api_request_download (0147; never redefined since). Signature, SECURITY DEFINER, the pinned search_path and the grants
--   (anon only) stay as 0147 made them (restated below).
-- NOT CHANGED: audit_action_allowed (0145), app_audit_log_stamp (0087), api_audit (0040), every price, hold and ledger rule,
--   every other table, column or function.
--
-- NUMBER. 0169, provisional: live is at 0165; 0166, 0167 and 0168 are held by open pull requests, and the number is changed
--   at merge if another branch takes it first. Needs 0031, 0042, 0087 and 0147; names nothing of 0148 to 0168.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.api_request_download(text, text, text, text, text, text)'::regprocedure;
--   expected BEFORE 055003f8a2fb5390bbd1b5f7820e6e2e (0147), AFTER 45fbea9ff56a77c0144993c43a4451da (this file).
-- Undo: docs/sql/rollback_0169_api_download_audit.sql (owner-applied; it puts the failure back). Re-running 0147 after this
--   file is refused by 0147's own drift guard (api_request_download is not a body it knows): undo 0169 first, re-run 0147,
--   then apply 0169 again.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  h text;
begin
  if to_regprocedure('public.audit_action_allowed(text)') is null
     or to_regprocedure('public.api_audit(jsonb, text, text, text, jsonb)') is null then
    raise exception '0169 needs the audit list and the API''s audit helper: apply 0087_audit_and_rate_hardening.sql first';
  end if;
  if not public.audit_action_allowed('video.download_request') then
    raise exception '0169 needs video.download_request in audit_action_allowed (0087 onwards): read the live list first';
  end if;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure('public.api_request_download(text, text, text, text, text, text)');
  if h is null or h <> all (array['055003f8a2fb5390bbd1b5f7820e6e2e', '45fbea9ff56a77c0144993c43a4451da']) then
    raise exception '0169 found public.api_request_download(text, text, text, text, text, text) with a body that is neither the one it was written on nor 0169''s (md5 %): read the live body first', h;
  end if;
end $$;

-- 0147's body, verbatim, with the one marked hunk.
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
    -- 0169: the name 0087's audit list has and the site's download route writes; 'video.download' was refused (500).
    perform public.api_audit(ctx, 'video.download_request', p_video_id, v_ch,
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

-- End state: this file's body, an anon-only SECURITY DEFINER with the pinned search_path, and the audit list as this file
-- found it in the two names it is about.
do $$
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('public.api_request_download(text, text, text, text, text, text)'))
       is distinct from '45fbea9ff56a77c0144993c43a4451da' then
    raise exception '0169 end state: public.api_request_download(text, text, text, text, text, text) does not hold the body this file expects';
  end if;
  if exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.api_request_download(text, text, text, text, text, text)')
              and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                   or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp'))) then
    raise exception '0169 end state: api_request_download is not a SECURITY DEFINER with a fixed search_path, or PUBLIC may call it';
  end if;
  if not has_function_privilege('anon', 'public.api_request_download(text, text, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_request_download(text, text, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.api_request_download(text, text, text, text, text, text)', 'EXECUTE') then
    raise exception '0169 end state: api_request_download has the wrong grants (expected anon only)';
  end if;
  if not public.audit_action_allowed('video.download_request') or public.audit_action_allowed('video.download') then
    raise exception '0169 end state: the audit list is not the one this file was written on';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, in the SQL editor; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   md5(regexp_replace(prosrc, '\s+', ' ', 'g')) = '45fbea9ff56a77c0144993c43a4451da' as body_is_0169s,
--   position('api_audit(ctx, ''video.download_request'',' in prosrc) > 0
--     and position('api_audit(ctx, ''video.download'',' in prosrc) = 0 as audits_a_listed_name,
--   public.audit_action_allowed('video.download_request') and not public.audit_action_allowed('video.download') as list_unchanged,
--   has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE')
--     and not has_function_privilege('service_role', oid, 'EXECUTE') as anon_only
-- from pg_proc where oid = 'public.api_request_download(text,text,text,text,text,text)'::regprocedure;
-- A real paid, redownload and exempt download with its hold, ledger and audit row: tests/security/test_sec_api_download.py.
