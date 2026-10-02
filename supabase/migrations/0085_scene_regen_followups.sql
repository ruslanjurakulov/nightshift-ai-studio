-- 0085_scene_regen_followups.sql — follow-ups from the independent review of
-- scene regeneration (0076, PR #365): BR-L-040, BR-L-042 (database half),
-- BR-L-044. Additive and re-runnable (replay twice = no change); nothing is
-- dropped and no price, hold or capture rule changes.
--
-- Run it after 0076. The platform's worker should be updated first (it reads
-- the new scene_regenerations_unsettled(); an updated worker on a database
-- without this file falls back to the old sweep and says so in its log).
--
--   BR-L-040  scene_regenerations.error held the worker's own text (the
--             generator's name, "no API key on this worker", the model the
--             worker is configured for, a provider's refusal) and the select
--             policy lets any viewer of the organization read every column.
--             Now (a) finish_scene_regeneration stores the code plus one fixed
--             sentence there and puts the worker's text in
--             scene_regeneration_details, which no API role can read, and
--             (b) `authenticated` is granted every column of
--             scene_regenerations EXCEPT error, so rows written before this
--             file stop being readable too. The service role still reads the
--             whole table. The Command Center never selected `error`.
--   BR-L-042  scene_regenerations_unsettled() lists the regenerations the
--             expiry sweep would release (their job ended, or a day passed).
--             The worker settles each of them from what is on its disk
--             (restore the previous take, or confirm the new cut) BEFORE it
--             calls expire_scene_regenerations(), so a hold is no longer
--             released while the new cut is in place.
--   BR-L-044  request_scene_regenerate refuses a NaN or Infinity ceiling
--             (price_required), like a missing one.
--
-- REPLACES (built on 0076's bodies, the latest; tests/test_scene_regen_followups.py
-- pins that every line is kept and only the lines named above are added or
-- changed): request_scene_regenerate, finish_scene_regeneration.
-- NEW: scene_regeneration_details (table), scene_regenerations_unsettled().
--
-- If 0076 is ever re-applied after this file, re-apply this file too: 0076's
-- bodies and its table-wide grant come back with it.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The worker's text, kept where no member can read it
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.scene_regeneration_details (
  regeneration_id uuid primary key references public.scene_regenerations (id) on delete restrict,
  detail          text not null check (char_length(detail) between 1 and 500),
  created_at      timestamptz not null default now()
);
comment on table public.scene_regeneration_details is
  'The worker''s own text for a failed scene regeneration (migration 0085): it can name a vendor, a model or the worker''s configuration, so no API role reads it. Written only by finish_scene_regeneration; read with the service key or by the database owner.';

alter table public.scene_regeneration_details enable row level security;
revoke all on public.scene_regeneration_details from public, anon, authenticated, service_role;
grant select on public.scene_regeneration_details to service_role;

-- The member-readable row: every column but `error`. A column that is added
-- later is not readable until someone grants it (fails closed).
revoke select on public.scene_regenerations from authenticated;
grant select (id, org_id, channel_id, video_id, slug, scene_id, requested_source, source_kind, provider,
              model, explicit_stock, prompt, generated_clips, stock_assets, previous_asset_ids,
              quoted_credits, credit_ref, charged_credits, status, render_job_id, idempotency_key,
              request_hash, result, error_code, requested_by, created_at, started_at, finished_at)
  on public.scene_regenerations to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The press (0076's body; the ceiling must be a number)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.request_scene_regenerate(
  p_video text, p_scene text, p_prompt text, p_source text, p_max_credits numeric, p_idem text
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v        public.videos;
  v_org    uuid;
  v_exempt boolean;
  v_prompt text := nullif(btrim(coalesce(p_prompt, '')), '');
  v_source text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'same');
  v_hash   text;
  prior    public.scene_regenerations;
  plan     jsonb;
  price    jsonb;
  v_price  numeric;
  v_id     uuid := gen_random_uuid();
  v_ref    text;
  v_res    jsonb;
  v_job    bigint;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.videos where video_id = p_video;
  -- The Run now rule: an admin of the channel's organization. A viewer or
  -- editor, another organization, and a video that does not exist all get
  -- the same refusal before anything is looked at.
  if v.video_id is null or not (v.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_org := public.channel_org(v.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_scene is null or p_scene !~ '^s[0-9]{3,4}$' then
    raise exception 'invalid_scene' using errcode = '22023';
  end if;
  if v_source not in ('same', 'stock') then
    raise exception 'invalid_source' using errcode = '22023';
  end if;
  if v_prompt is not null and (char_length(v_prompt) > 1000 or v_prompt ~ '[[:cntrl:]]') then
    raise exception 'invalid_prompt' using errcode = '22023';
  end if;

  -- Presses on one video take turns: a double click, a second tab or a second
  -- admin waits here, then sees the first one's row.
  perform pg_advisory_xact_lock(hashtextextended('scene_regenerate:' || v.video_id, 0));

  v_hash := md5(jsonb_build_object('video', v.video_id, 'scene', p_scene, 'source', v_source,
                                   'prompt', v_prompt)::text);
  select * into prior from public.scene_regenerations
   where org_id = v_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    -- The same press again (a retry, a replay): its job, nothing held twice.
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'render_job_id', prior.render_job_id,
                              'credits_held', prior.quoted_credits, 'credit_ref', prior.credit_ref,
                              'replayed', true);
  end if;

  if public.scene_regen_published(v) then
    raise exception 'published' using errcode = 'NS409';
  end if;
  if coalesce(v.slug, '') !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    raise exception 'scene_unavailable' using errcode = 'NS400', detail = 'no_run';
  end if;
  if exists (select 1 from public.scene_regenerations
              where video_id = v.video_id and status in ('queued', 'running')) then
    raise exception 'in_progress' using errcode = 'NS409';
  end if;
  plan := public.scene_regen_plan(v.manifest, p_scene, v_source);
  if not coalesce((plan ->> 'ok')::boolean, false) then
    raise exception 'scene_unavailable' using errcode = 'NS400', detail = plan ->> 'reason';
  end if;

  v_exempt := public.credits_exempt(v_org);
  if not v_exempt then
    price := public.scene_regen_price(plan);
    if price ->> 'status' <> 'priced' then
      raise exception 'unpriced' using errcode = 'NS400';
    end if;
    v_price := (price ->> 'credits')::numeric;
    -- The press carries the price the person saw; without one nothing is spent.
    if p_max_credits is null then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    -- 0085 (BR-L-044): numeric orders NaN and Infinity above every price, so
    -- "v_price > NaN" is false and the press would have carried no ceiling.
    -- A ceiling must be a number; anything else is no price at all.
    if p_max_credits = 'NaN'::numeric or p_max_credits = 'Infinity'::numeric
       or p_max_credits = '-Infinity'::numeric then
      raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);
    end if;
    if v_price > p_max_credits then
      raise exception 'price_changed' using errcode = 'NS409', detail = format('credits=%s', v_price);
    end if;
    v_ref := 'rj-sr-' || replace(v_id::text, '-', '');
    -- The hold is the quote. reserve_credits checks the caller is an admin of
    -- the organization, the balance, the plan's parallel limit and the floor.
    v_res := public.reserve_credits(v_org, v_ref, v_price);
    if coalesce((v_res ->> 'exempt')::boolean, false) then
      v_ref := null;
      v_price := null;
    end if;
  end if;

  insert into public.scene_regenerations (
    id, org_id, channel_id, video_id, slug, scene_id, requested_source, source_kind, provider, model,
    explicit_stock, prompt, generated_clips, stock_assets, previous_asset_ids, quoted_credits, credit_ref,
    idempotency_key, request_hash, requested_by)
  values (
    v_id, v_org, v.channel_id, v.video_id, v.slug, p_scene, v_source, plan ->> 'source_kind',
    plan ->> 'provider', plan ->> 'model', coalesce((plan ->> 'explicit_stock')::boolean, false), v_prompt,
    (plan ->> 'generated')::integer, (plan ->> 'stock')::integer,
    array(select jsonb_array_elements_text(plan -> 'asset_ids')), v_price, v_ref,
    p_idem, v_hash, auth.uid());

  -- The render job: a repair of this one scene of this run (the run's slug is
  -- the topic scene_repair.find_run locates it by). Never resume, never a
  -- privacy: the worker runs it private and holds the new cut for review.
  insert into public.render_jobs (channel_id, kind, params, requested_by, credit_ref, scene_regeneration_id)
  values (v.channel_id, 'repair', jsonb_build_object('topic', v.slug, 'repair_scenes', p_scene),
          auth.uid(), v_ref, v_id)
  returning id into v_job;
  update public.scene_regenerations set render_job_id = v_job where id = v_id;

  return jsonb_build_object('id', v_id, 'status', 'queued', 'render_job_id', v_job,
                            'credits_held', v_price, 'credit_ref', v_ref, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. How it ended (0076's body; the worker's text goes to the details table)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.finish_scene_regeneration(
  p_id uuid, p_job bigint, p_ok boolean, p_error_code text, p_error text, p_result jsonb
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r         public.scene_regenerations;
  res       public.credit_reservations;
  v_charged numeric := 0;
  v_code    text;
  v_result  jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.scene_regenerations where id = p_id for update;
  if r.id is null or r.render_job_id is distinct from p_job then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if r.status in ('succeeded', 'failed') then
    return jsonb_build_object('id', r.id, 'status', r.status, 'charged_credits', r.charged_credits,
                              'replayed', true);
  end if;
  v_result := case when p_result is not null and jsonb_typeof(p_result) = 'object'
                        and octet_length(p_result::text) <= 8192 then p_result end;

  if coalesce(p_ok, false) then
    if r.credit_ref is not null then
      v_charged := public.capture_credits(r.credit_ref, r.quoted_credits, false);
    end if;
    -- The approved cut is not the cut that now exists (modules/scene_repair
    -- invalidate_approvals does the same from the pipeline): re-approval is
    -- needed, through the normal review. Nothing here publishes.
    update public.videos set review_state = 'pending'
     where video_id = r.video_id and review_state = 'approved';
    update public.review_intents set consumed_at = now(), outcome = 'superseded_by_repair'
     where video_id = r.video_id and action = 'approve' and consumed_at is null;
    update public.review_intents set consumed_at = now(), outcome = 'repaired'
     where video_id = r.video_id and action = 'regenerate_scene' and scene_id = r.scene_id
       and consumed_at is null;
    update public.scene_regenerations
       set status = 'succeeded', charged_credits = case when r.credit_ref is null then null else v_charged end,
           result = v_result, finished_at = now(), error_code = null, error = null
     where id = r.id;
    return jsonb_build_object('id', r.id, 'status', 'succeeded', 'charged_credits', v_charged, 'replayed', false);
  end if;

  if r.credit_ref is not null then
    select * into res from public.credit_reservations where job_id = r.credit_ref;
    if res.job_id is not null and res.status = 'open' then
      perform public.release_credits(r.credit_ref);
    end if;
  end if;
  v_code := case when p_error_code ~ '^[a-z][a-z0-9_]{0,47}$' then p_error_code else 'failed' end;
  -- 0085 (BR-L-040): the member-readable row carries the code and one fixed
  -- sentence. The worker's own text (a provider's name, its configuration, a
  -- refusal copied from a vendor) goes to the service-only details table.
  if nullif(btrim(p_error), '') is not null then
    insert into public.scene_regeneration_details (regeneration_id, detail)
    values (r.id, left(p_error, 500))
    on conflict (regeneration_id) do nothing;
  end if;
  update public.scene_regenerations
     set status = 'failed', charged_credits = case when r.credit_ref is null then null else 0 end,
         result = v_result, finished_at = now(), error_code = v_code,
         error = 'The regeneration did not finish; the previous take was kept and nothing was charged.'
   where id = r.id;
  return jsonb_build_object('id', r.id, 'status', 'failed', 'charged_credits', 0, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. What the worker settles from its disk before the sweep releases a hold
-- ───────────────────────────────────────────────────────────────────────────
-- The same rows expire_scene_regenerations() would fail and release (0076's
-- predicate, unchanged): still queued or running, and either a day old or
-- with a job that is neither queued nor running nor ended in the last 15
-- minutes. Read-only; the worker decides each one from the files it holds
-- and ends it with finish_scene_regeneration (a success captures the quote
-- only for a cut that is in place and matches its result).
create or replace function public.scene_regenerations_unsettled()
  returns table (id uuid, render_job_id bigint, slug text, status text)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select s.id, s.render_job_id, s.slug, s.status
      from public.scene_regenerations s
     where s.status in ('queued', 'running')
       and (s.created_at < now() - interval '26 hours'
            or not exists (select 1 from public.render_jobs j
                            where j.id = s.render_job_id
                              and (j.status in ('queued', 'running')
                                   or j.finished_at > now() - interval '15 minutes')))
     order by s.created_at;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Privileges
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.request_scene_regenerate(text, text, text, text, numeric, text) from public, anon, service_role;
grant execute on function public.request_scene_regenerate(text, text, text, text, numeric, text) to authenticated;
revoke all on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) to service_role;
revoke all on function public.scene_regenerations_unsettled() from public, anon, authenticated;
grant execute on function public.scene_regenerations_unsettled() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   not has_column_privilege('authenticated', 'public.scene_regenerations', 'error', 'SELECT')
--     and has_column_privilege('authenticated', 'public.scene_regenerations', 'error_code', 'SELECT')
--     and has_column_privilege('authenticated', 'public.scene_regenerations', 'status', 'SELECT')
--     and not has_table_privilege('authenticated', 'public.scene_regenerations', 'SELECT')
--     as members_read_every_column_but_error,
--   has_column_privilege('service_role', 'public.scene_regenerations', 'error', 'SELECT')
--     as service_still_reads_it,
--   not has_table_privilege('authenticated', 'public.scene_regeneration_details', 'SELECT')
--     and not has_table_privilege('anon', 'public.scene_regeneration_details', 'SELECT')
--     and has_table_privilege('service_role', 'public.scene_regeneration_details', 'SELECT')
--     as details_are_service_only,
--   (select relrowsecurity from pg_class where oid = 'public.scene_regeneration_details'::regclass)
--     as details_rls_on,
--   pg_get_functiondef('public.request_scene_regenerate(text, text, text, text, numeric, text)'::regprocedure)
--     like '%''NaN''::numeric%'
--     as press_refuses_a_non_numeric_ceiling,
--   pg_get_functiondef('public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)'::regprocedure)
--     like '%scene_regeneration_details%'
--     as finish_keeps_the_workers_text_out_of_the_row,
--   not has_function_privilege('authenticated', 'public.scene_regenerations_unsettled()', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.scene_regenerations_unsettled()', 'EXECUTE')
--     and has_function_privilege('service_role', 'public.scene_regenerations_unsettled()', 'EXECUTE')
--     as unsettled_is_service_only,
--   (select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('request_scene_regenerate', 'finish_scene_regeneration',
--                         'scene_regenerations_unsettled'))
--     as search_path_pinned;
