-- 0076_scene_regenerate.sql — regenerate ONE scene of a run: priced, confirmed,
-- and made again with the source it was made with.
--
-- Until now "Regenerate scene" filed a review_intents row (0015) and a repair
-- run (modules/scene_repair.py) rebuilt the scene from STOCK footage, whatever
-- the scene was made with: a scene of generated b-roll silently came back as
-- stock — the quality substitution CLAUDE.md rule 4 forbids — and nobody saw a
-- price. This migration makes it one priced, confirmed press:
--
--   quote_scene_regenerate(video, scene, source)
--       what regenerating this scene costs, computed HERE from the video's own
--       Video IR (videos.manifest, written only by the pipeline) and the price
--       list — never from anything the browser sends. 'priced' with a number,
--       'unpriced' (a price unit is not set: never 0), 'included' (the
--       operator's own organization) or 'unavailable' with the reason
--       (published, in progress, no Video IR, a generator that was not
--       recorded, …). Read-only; any member who can read the video may ask.
--   request_scene_regenerate(video, scene, prompt, source, max_credits, idem)
--       the priced press, in one transaction: who (an admin of the channel's
--       organization — the Run now rule; reserve_credits checks it again),
--       idempotency (the same key and the same request return the same job and
--       hold nothing more; the same key with another request is refused), one
--       regeneration at a time per video, the re-quote, max_credits (a price
--       above what the person confirmed is price_changed and nothing is held),
--       the hold (= the quote, reserve_credits: balance, plan limit, platform
--       floor), the regeneration row and its render_jobs row of kind 'repair'.
--       Any refusal rolls all of it back.
--
-- THE SOURCE
--   'same' (the default): the scene is made again from the source it had. A
--   scene of generated clips is generated again by the SAME provider and the
--   SAME model recorded on its assets in the Video IR; its stock clips are
--   searched again from stock. If the provider or model was not recorded, the
--   scene mixes generators, or it holds generated stills, 'same' is
--   unavailable and says so — it never picks another generator, and it never
--   falls back to stock.
--   'stock': the person explicitly chose stock footage for this scene. Recorded
--   (explicit_stock = true when the scene had generated clips) and priced as a
--   stock regeneration.
--   The worker (modules/scene_regenerate.py) checks the same at run time: the
--   recorded provider/model must be the one configured, or the run stops with
--   the remedy, nothing charged, no stock used.
--
-- THE MONEY (0020's functions, called as they are; their internals untouched)
--   price   = round_up( scene_regenerate x (1 + margin)
--                       + generated clips x scene_regenerate_clip_<provider>
--                         x (1 + margin) ), at least job_minimum.
--           Units are rows of credit_prices the owner sets. A missing unit is
--           'unpriced' and the button cannot be pressed — never a 0. None is
--           inserted here: an unset price blocks the feature by design.
--   hold    = the price, under the reference 'rj-sr-<regeneration id>', placed
--           by the press. render_jobs_payment_guard (0041, replaced below with
--           lines only added) accepts a repair job of a regeneration only with
--           ITS hold: open, never started, this organization, at least the
--           quote — and does not apply the whole-video length floor to it.
--   capture = the quote on success (finish_scene_regeneration, same
--           transaction as the status change); capture_credits never exceeds
--           the hold, and a CHECK keeps charged_credits <= quoted_credits.
--   release = the whole hold on any failure, a lost job, or a provider that is
--           unavailable — the old scene stays as it was.
--
-- WHAT A REGENERATION NEVER DOES
--   It never touches a published video (refused here; the button says why).
--   It never uploads, publishes or changes privacy: the worker runs main.py
--   --regenerate-scene, which holds the new cut for review. A regenerated
--   scene in an approved run invalidates that approval (finish resets an
--   approved review_state to pending and consumes waiting approve intents, and
--   the pipeline voids two-person approvals decided before it). The publish
--   gate is not evaluated by it and nothing reads as "passed".
--   The previous take is kept: the old scene's assets, the previous cut and
--   the previous Video IR stay on the worker's disk under the regeneration,
--   and previous_asset_ids records which assets they were.
--
-- WHO MAY DO WHAT (authenticated = a signed-in browser via the anon key)
--   scene_regenerations     select: members of the channel's organization ·
--                           insert / update / delete: nobody directly
--   quote_scene_regenerate  authenticated, reads only what the caller may read
--   request_scene_regenerate authenticated; admin of the channel's org
--   start_ / finish_ / expire_scene_regeneration(s)
--                           service role only (tools/queue_worker.py)
--   scene_regen_plan, scene_regen_price, scene_regen_published
--                           internal; no API role calls them
--   render_jobs             the browser insert policy (0041's, verbatim) gains
--                           `scene_regeneration_id is null`: only the request
--                           function links a job to a regeneration.
--   anon gets nothing.
--
-- ERRORS (SQLSTATE; the message is the machine code the app maps,
-- command-center/lib/sceneRegenerate.ts)
--   42501 forbidden (not signed in / not an admin here / no such video)
--   22023 invalid_scene | invalid_source | invalid_prompt |
--         invalid_idempotency_key | price_required
--   NS400 scene_unavailable (detail: the reason) | unpriced
--   NS409 published | in_progress | price_changed | idempotency_conflict
--   NS402 / NS429 from reserve_credits (insufficient credits, plan's limit)
--
-- REQUIRES 0013 (videos.manifest), 0016 (videos.publish_state), 0017/0041
-- (render_jobs and its billing rules), 0018 (organizations), 0020 (credits).
-- Additive and idempotent: guarded creates, create-or-replace functions,
-- drop-then-create policy, triggers and constraints. Nothing is dropped.

do $$
begin
  if to_regclass('public.render_jobs') is null
     or to_regprocedure('public.render_jobs_payment_guard()') is null
     or to_regprocedure('public.render_jobs_terms_frozen()') is null then
    raise exception '0076 needs the render queue and its billing rules: apply 0017 and 0041 first';
  end if;
  if to_regprocedure('public.accessible_channel_ids(text)') is null
     or to_regprocedure('public.channel_org(text)') is null then
    raise exception '0076 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regprocedure('public.reserve_credits(uuid,text,numeric)') is null
     or to_regprocedure('public.capture_credits(text,numeric,boolean)') is null
     or to_regprocedure('public.release_credits(text)') is null
     or to_regprocedure('public.start_credit_reservation(text,uuid)') is null
     or to_regprocedure('public.credits_round_up(numeric)') is null then
    raise exception '0076 needs the credit ledger: apply 0020_credits.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'videos' and column_name = 'manifest')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'videos' and column_name = 'publish_state') then
    raise exception '0076 needs videos.manifest and videos.publish_state: apply 0013 and 0016 first';
  end if;
end $$;

create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. One row per press
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.scene_regenerations (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,
  channel_id         text not null,
  video_id           text not null,
  slug               text not null,
  scene_id           text not null,
  requested_source   text not null,
  source_kind        text not null,
  provider           text,
  model              text,
  explicit_stock     boolean not null default false,
  prompt             text,
  generated_clips    integer not null default 0,
  stock_assets       integer not null default 0,
  previous_asset_ids text[] not null default '{}',
  quoted_credits     numeric(14,2),
  credit_ref         text,
  charged_credits    numeric(14,2),
  status             text not null default 'queued',
  render_job_id      bigint,
  idempotency_key    text not null,
  request_hash       text not null,
  result             jsonb,
  error_code         text,
  error              text,
  requested_by       uuid,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

comment on table public.scene_regenerations is
  'One priced "Regenerate scene" press (migration 0076): which scene of which run, the source it is made with (the same provider/model recorded in the Video IR, or stock the person chose), the quote, the hold that pays for it and how it ended. Written only by the 0076 functions.';
comment on column public.scene_regenerations.previous_asset_ids is
  'The scene''s assets before the regeneration. They stay on the worker''s disk with the previous cut and Video IR: the previous take is kept.';

alter table public.scene_regenerations drop constraint if exists scene_regenerations_ids_check;
alter table public.scene_regenerations add constraint scene_regenerations_ids_check
  check (channel_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
         and char_length(video_id) between 1 and 128
         and slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'
         and scene_id ~ '^s[0-9]{3,4}$');
alter table public.scene_regenerations drop constraint if exists scene_regenerations_source_check;
alter table public.scene_regenerations add constraint scene_regenerations_source_check
  check (requested_source in ('same', 'stock')
         and source_kind in ('generated', 'stock')
         and (requested_source = 'same' or source_kind = 'stock')
         and (not explicit_stock or requested_source = 'stock')
         and (source_kind = 'stock'
              or (provider in ('minimax', 'higgsfield', 'kling', 'veo', 'seedance', 'wan')
                  and model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
                  and generated_clips > 0))
         and (source_kind = 'generated' or (provider is null and model is null and generated_clips = 0)));
alter table public.scene_regenerations drop constraint if exists scene_regenerations_counts_check;
alter table public.scene_regenerations add constraint scene_regenerations_counts_check
  check (generated_clips between 0 and 8 and stock_assets between 0 and 8
         and generated_clips + stock_assets >= 1
         and cardinality(previous_asset_ids) between 1 and 16);
alter table public.scene_regenerations drop constraint if exists scene_regenerations_prompt_check;
alter table public.scene_regenerations add constraint scene_regenerations_prompt_check
  check (prompt is null or (char_length(prompt) between 1 and 1000 and prompt !~ '[[:cntrl:]]'));
alter table public.scene_regenerations drop constraint if exists scene_regenerations_money_check;
alter table public.scene_regenerations add constraint scene_regenerations_money_check
  check ((quoted_credits is null or quoted_credits > 0)
         and (credit_ref is null or (credit_ref ~ '^rj-sr-[0-9a-f]{32}$' and quoted_credits is not null))
         and (charged_credits is null
              or (charged_credits >= 0 and charged_credits <= coalesce(quoted_credits, 0))));
alter table public.scene_regenerations drop constraint if exists scene_regenerations_status_check;
alter table public.scene_regenerations add constraint scene_regenerations_status_check
  check (status in ('queued', 'running', 'succeeded', 'failed')
         and ((status in ('succeeded', 'failed')) = (finished_at is not null)));
alter table public.scene_regenerations drop constraint if exists scene_regenerations_keys_check;
alter table public.scene_regenerations add constraint scene_regenerations_keys_check
  check (idempotency_key ~ '^[A-Za-z0-9_:.-]{8,128}$' and request_hash ~ '^[0-9a-f]{32}$');
alter table public.scene_regenerations drop constraint if exists scene_regenerations_outcome_check;
alter table public.scene_regenerations add constraint scene_regenerations_outcome_check
  check ((error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,47}$')
         and (error is null or char_length(error) <= 500)
         and (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 8192)));

-- One key, one press: a replay finds the first row instead of a second hold.
create unique index if not exists scene_regenerations_idem_key
  on public.scene_regenerations (org_id, idempotency_key);
-- One regeneration at a time per video: two presses (two tabs, two admins)
-- would race on the same run's files and cut. A database rule, not a button.
create unique index if not exists scene_regenerations_one_active_per_video
  on public.scene_regenerations (video_id) where status in ('queued', 'running');
create unique index if not exists scene_regenerations_render_job_key
  on public.scene_regenerations (render_job_id) where render_job_id is not null;
create index if not exists scene_regenerations_video_idx
  on public.scene_regenerations (video_id, created_at desc);

-- A press's terms are what was priced and held. Only how it ends moves.
create or replace function public.scene_regenerations_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.org_id is distinct from old.org_id
     or new.channel_id is distinct from old.channel_id
     or new.video_id is distinct from old.video_id
     or new.slug is distinct from old.slug
     or new.scene_id is distinct from old.scene_id
     or new.requested_source is distinct from old.requested_source
     or new.source_kind is distinct from old.source_kind
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.explicit_stock is distinct from old.explicit_stock
     or new.prompt is distinct from old.prompt
     or new.generated_clips is distinct from old.generated_clips
     or new.stock_assets is distinct from old.stock_assets
     or new.previous_asset_ids is distinct from old.previous_asset_ids
     or new.quoted_credits is distinct from old.quoted_credits
     or new.credit_ref is distinct from old.credit_ref
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash
     or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at
     or (old.render_job_id is not null and new.render_job_id is distinct from old.render_job_id)
     or old.status in ('succeeded', 'failed') then
    raise exception 'a scene regeneration''s terms are fixed when it is requested, and an ended one is final'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists scene_regenerations_terms_frozen on public.scene_regenerations;
create trigger scene_regenerations_terms_frozen
  before update on public.scene_regenerations
  for each row execute function public.scene_regenerations_terms_frozen();

create or replace function public.scene_regenerations_no_delete() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'a scene regeneration is a record of a paid press and is never deleted'
    using errcode = '42501';
end
$$;

drop trigger if exists scene_regenerations_no_delete on public.scene_regenerations;
create trigger scene_regenerations_no_delete
  before delete on public.scene_regenerations
  for each row execute function public.scene_regenerations_no_delete();

-- The job a regeneration queued. Written only by request_scene_regenerate;
-- the browser insert policy below requires it to be null.
alter table public.render_jobs
  add column if not exists scene_regeneration_id uuid
  references public.scene_regenerations (id) on delete restrict;
create unique index if not exists render_jobs_scene_regeneration_key
  on public.render_jobs (scene_regeneration_id) where scene_regeneration_id is not null;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. What the scene was made with, and what it costs
-- ───────────────────────────────────────────────────────────────────────────

-- The plan for regenerating one scene of a Video IR (modules/video_ir.py):
-- {"ok": true, source_kind, provider, model, generated, stock, explicit_stock,
-- asset_ids} or {"ok": false, "reason": ...}. Pure. 'same' never chooses a
-- generator: it is the one every generated clip of the scene names, or the
-- plan is unavailable.
create or replace function public.scene_regen_plan(p_manifest jsonb, p_scene text, p_source text)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  sc         jsonb;
  a          jsonb;
  aid        text;
  ids        text[] := '{}';
  n_gen      integer := 0;
  n_stock    integer := 0;
  v_provider text;
  v_model    text;
  problem    text;
begin
  if p_source is null or p_source not in ('same', 'stock') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_source');
  end if;
  if p_scene is null or p_scene !~ '^s[0-9]{3,4}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_scene');
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
     or jsonb_typeof(p_manifest -> 'scenes') is distinct from 'array'
     or jsonb_typeof(p_manifest -> 'assets') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'reason', 'no_manifest');
  end if;
  select s into sc from jsonb_array_elements(p_manifest -> 'scenes') s
   where jsonb_typeof(s) = 'object' and s ->> 'id' = p_scene limit 1;
  if sc is null then
    return jsonb_build_object('ok', false, 'reason', 'scene_not_found');
  end if;
  if jsonb_typeof(sc -> 'asset_ids') is distinct from 'array' or jsonb_array_length(sc -> 'asset_ids') = 0 then
    return jsonb_build_object('ok', false, 'reason', 'scene_has_no_footage');
  end if;
  if jsonb_array_length(sc -> 'asset_ids') > 8 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_assets');
  end if;
  for aid in select jsonb_array_elements_text(sc -> 'asset_ids') loop
    if aid !~ '^[A-Za-z0-9_.:-]{1,64}$' then
      return jsonb_build_object('ok', false, 'reason', 'asset_missing');
    end if;
    ids := ids || aid;
    a := null;
    select x into a from jsonb_array_elements(p_manifest -> 'assets') x
     where jsonb_typeof(x) = 'object' and x ->> 'id' = aid limit 1;
    if a is null then
      problem := coalesce(problem, 'asset_missing');
    elsif a ->> 'source' = 'generated' then
      n_gen := n_gen + 1;
      if coalesce(a ->> 'kind', '') <> 'video' then
        problem := coalesce(problem, 'generated_stills_not_supported');
      elsif coalesce(a ->> 'provider', '') not in ('minimax', 'higgsfield', 'kling', 'veo', 'seedance', 'wan') then
        problem := coalesce(problem, 'generator_not_recorded');
      elsif coalesce(a ->> 'model', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' then
        problem := coalesce(problem, 'generator_model_not_recorded');
      elsif v_provider is not null and (v_provider <> a ->> 'provider' or v_model <> a ->> 'model') then
        problem := coalesce(problem, 'mixed_generators');
      else
        v_provider := a ->> 'provider';
        v_model := a ->> 'model';
      end if;
    elsif a ->> 'source' = 'stock' then
      n_stock := n_stock + 1;
      if coalesce(a ->> 'provider', 'pexels') <> 'pexels' then
        problem := coalesce(problem, 'stock_source_not_supported');
      end if;
    else
      problem := coalesce(problem, 'source_not_recorded');
    end if;
  end loop;

  if p_source = 'stock' then
    -- The person chose stock for every clip of the scene. Nothing about the
    -- old generator matters any more; the choice is what is recorded.
    return jsonb_build_object('ok', true, 'source_kind', 'stock', 'provider', null, 'model', null,
                              'generated', 0, 'stock', cardinality(ids),
                              'explicit_stock', n_gen > 0, 'asset_ids', to_jsonb(ids));
  end if;
  if problem is not null then
    return jsonb_build_object('ok', false, 'reason', problem, 'had_generated', n_gen > 0);
  end if;
  if n_gen > 0 then
    return jsonb_build_object('ok', true, 'source_kind', 'generated', 'provider', v_provider, 'model', v_model,
                              'generated', n_gen, 'stock', n_stock,
                              'explicit_stock', false, 'asset_ids', to_jsonb(ids));
  end if;
  return jsonb_build_object('ok', true, 'source_kind', 'stock', 'provider', null, 'model', null,
                            'generated', 0, 'stock', n_stock,
                            'explicit_stock', false, 'asset_ids', to_jsonb(ids));
end
$$;

-- The price of a plan from the platform price list. 'unpriced' names the
-- unit that is missing; a price is never invented and never 0.
create or replace function public.scene_regen_price(p_plan jsonb) returns jsonb
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  base   public.credit_prices;
  clip   public.credit_prices;
  jm     numeric;
  v_unit text;
  total  numeric;
begin
  select * into base from public.credit_prices where unit = 'scene_regenerate';
  if base.unit is null then
    return jsonb_build_object('status', 'unpriced', 'credits', null, 'missing_unit', 'scene_regenerate');
  end if;
  total := base.credits_per_unit * (1 + base.margin);
  if coalesce((p_plan ->> 'generated')::integer, 0) > 0 then
    v_unit := 'scene_regenerate_clip_' || (p_plan ->> 'provider');
    select * into clip from public.credit_prices where unit = v_unit;
    if clip.unit is null then
      return jsonb_build_object('status', 'unpriced', 'credits', null, 'missing_unit', v_unit);
    end if;
    total := total + (p_plan ->> 'generated')::integer * clip.credits_per_unit * (1 + clip.margin);
  end if;
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  total := public.credits_round_up(greatest(total, coalesce(jm, 0)));
  if total is null or total <= 0 then
    -- A hold must be positive (0020); a price of 0 cannot pay for anything.
    return jsonb_build_object('status', 'unpriced', 'credits', null, 'missing_unit', 'scene_regenerate');
  end if;
  return jsonb_build_object('status', 'priced', 'credits', total, 'unit', base.unit, 'clip_unit', v_unit);
end
$$;

-- A video that reached YouTube cannot be regenerated: its run was closed when
-- it uploaded (modules/scene_repair.find_run), and a published video is not
-- changed under its audience. A held run's row is keyed 'run-' + 20 hex
-- (modules/held_video.py) and has no publish time or privacy; anything else
-- has uploaded. Leans to refusing.
create or replace function public.scene_regen_published(v public.videos) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select v.published_at is not null
      or v.privacy is not null
      or coalesce(v.publish_state, '') = 'uploaded'
      or v.video_id !~ '^run-[0-9a-f]{20}$'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The quote and the press
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.quote_scene_regenerate(p_video text, p_scene text, p_source text default 'same')
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v        public.videos;
  v_org    uuid;
  v_exempt boolean;
  v_active uuid;
  plan     jsonb;
  price    jsonb;
  out_     jsonb;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.videos where video_id = p_video;
  -- Missing and not-yours read the same: no oracle for another tenant's ids.
  if v.video_id is null or not (v.channel_id in (select public.accessible_channel_ids('viewer'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_org := public.channel_org(v.channel_id);
  if v_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_exempt := public.credits_exempt(v_org);
  out_ := jsonb_build_object(
    'video_id', v.video_id, 'scene_id', p_scene, 'source', p_source, 'exempt', v_exempt,
    'may_start', v.channel_id in (select public.accessible_channel_ids('admin')),
    'credits', null);

  if public.scene_regen_published(v) then
    return out_ || jsonb_build_object('status', 'unavailable', 'reason', 'published');
  end if;
  if coalesce(v.slug, '') !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    return out_ || jsonb_build_object('status', 'unavailable', 'reason', 'no_run');
  end if;
  select id into v_active from public.scene_regenerations
   where video_id = v.video_id and status in ('queued', 'running') limit 1;
  if v_active is not null then
    return out_ || jsonb_build_object('status', 'unavailable', 'reason', 'in_progress', 'active_id', v_active);
  end if;
  plan := public.scene_regen_plan(v.manifest, p_scene, p_source);
  if not coalesce((plan ->> 'ok')::boolean, false) then
    return out_ || jsonb_build_object('status', 'unavailable', 'reason', plan ->> 'reason',
                                      'had_generated', coalesce((plan ->> 'had_generated')::boolean, false));
  end if;
  out_ := out_ || jsonb_build_object(
    'source_kind', plan ->> 'source_kind', 'provider', plan -> 'provider', 'model', plan -> 'model',
    'generated', plan -> 'generated', 'stock', plan -> 'stock',
    'explicit_stock', plan -> 'explicit_stock');
  if v_exempt then
    -- The operator's own organization holds nothing (0020). Not "0 credits".
    return out_ || jsonb_build_object('status', 'included');
  end if;
  price := public.scene_regen_price(plan);
  return out_ || jsonb_build_object('status', price ->> 'status', 'credits', price -> 'credits',
                                    'missing_unit', price -> 'missing_unit');
end
$$;

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
      raise exception 'unpriced' using errcode = 'NS400', detail = price ->> 'missing_unit';
    end if;
    v_price := (price ->> 'credits')::numeric;
    -- The press carries the price the person saw; without one nothing is spent.
    if p_max_credits is null then
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
-- 4. The render queue: a regeneration's job is paid by its own hold
-- ───────────────────────────────────────────────────────────────────────────
-- render_jobs_payment_guard and render_jobs_terms_frozen are 0041's bodies
-- with lines added only (tests/test_scene_regenerate_migration.py pins that).

create or replace function public.render_jobs_payment_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org   uuid;
  v_cfg   jsonb;
  v_secs  numeric;
  r       public.credit_reservations;
  h       public.api_holds;
  jm      numeric;
  vm      public.credit_prices;
  v_need  numeric;
  sr      public.scene_regenerations;
begin
  -- A signed-in browser that may not start runs on this channel gets the
  -- insert policy's refusal here, before anything below can tell it whether
  -- a channel or a hold exists. (The API functions run with the key's anon
  -- role and do their own channel check; the service key is trusted.)
  if coalesce(auth.role(), '') = 'authenticated'
     and not (new.channel_id in (select public.accessible_channel_ids('admin'))) then
    raise exception 'new row violates row-level security policy for table "render_jobs"'
      using errcode = '42501';
  end if;

  select c.org_id, c.agent_config into v_org, v_cfg
    from public.channels c where c.channel_id = new.channel_id;
  if v_org is null then
    raise exception 'render job refused: channel % belongs to no organization', new.channel_id
      using errcode = '42501';
  end if;
  -- 0076: a job linked to a scene regeneration is the one job its request
  -- queued — a repair of that scene, with that regeneration's own hold —
  -- for every organization, the operator's included.
  if new.scene_regeneration_id is not null then
    select * into sr from public.scene_regenerations where id = new.scene_regeneration_id;
    if sr.id is null or new.kind <> 'repair' or sr.channel_id <> new.channel_id
       or sr.status <> 'queued' or sr.render_job_id is not null
       or sr.credit_ref is distinct from new.credit_ref or new.api_hold_ref is not null
       or new.params ->> 'repair_scenes' is distinct from sr.scene_id
       or new.params ->> 'topic' is distinct from sr.slug
       or coalesce((new.params ->> 'resume')::boolean, false) then
      raise exception 'render job refused: it is not the job its scene regeneration queued'
        using errcode = '42501';
    end if;
  end if;
  -- The operator's own organization never pays (0020) and its runs keep the
  -- channel's own target length, exactly as before this migration.
  if public.credits_exempt(v_org) then
    return new;
  end if;

  -- C2: a customer run is paid for — whatever NIGHTSHIFT_CREDITS_ENFORCE says.
  if new.credit_ref is null and new.api_hold_ref is null then
    raise exception 'render job refused: a run for this organization must carry its credit hold'
      using errcode = '42501',
            hint = 'Start it from the Command Center with credits enforced (NIGHTSHIFT_CREDITS_ENFORCE).';
  end if;
  if new.credit_ref is not null and new.api_hold_ref is not null then
    raise exception 'render job refused: a run is paid by one hold, not two' using errcode = '42501';
  end if;

  -- 0076: a scene regeneration is priced per scene, not per minute of video.
  -- Its hold is its own (the reference the request placed): open, never
  -- started, this organization's, and at least the quote. The whole-video
  -- length floor below does not apply to one scene, and no length is frozen.
  if new.scene_regeneration_id is not null then
    select * into r from public.credit_reservations where job_id = new.credit_ref;
    if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
       or r.started_at is not null or sr.quoted_credits is null or r.amount < sr.quoted_credits then
      raise exception 'render job refused: its credit hold is not this scene regeneration''s open hold'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- C1: freeze the length the hold is for. A job that names its length keeps
  -- it (render_jobs_params_check holds it to whole seconds, 30..3600); one
  -- that does not gets the channel's target as it is NOW, capped the same way.
  new.params := coalesce(new.params, '{}'::jsonb);
  if new.params ? 'duration' then
    if jsonb_typeof(new.params -> 'duration') <> 'number' then
      raise exception 'render job refused: duration must be a whole number of seconds'
        using errcode = '22023';
    end if;
    v_secs := (new.params ->> 'duration')::numeric;
  else
    if jsonb_typeof(v_cfg -> 'target_duration_seconds') = 'number' then
      v_secs := (v_cfg ->> 'target_duration_seconds')::numeric;
    end if;
    if v_secs is null or v_secs <= 0 then
      raise exception 'render job refused: a paid run needs a length'
        using errcode = '22023',
              hint = 'Choose a length, or set the channel''s target length.';
    end if;
    v_secs := least(greatest(round(v_secs), 30), 3600);
    new.params := new.params || jsonb_build_object('duration', v_secs::integer);
  end if;

  if new.api_hold_ref is not null then
    -- (a) is the policy's; here: the hold is this organization's, open, and
    -- not already paying for another job or a download. 0031's
    -- api_create_video priced it for this length in this same transaction.
    select * into h from public.api_holds where ref = new.api_hold_ref;
    if h.ref is null or h.org_id is distinct from v_org or h.status <> 'open'
       or h.started_at is not null or h.render_job_id is not null
       or h.download_request_id is not null then
      raise exception 'render job refused: its API balance hold is not an open, unused hold of this organization'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- (b) the credit hold: this organization's, a queue reference, open, never
  -- started (a started hold is paying for a run already), not expired.
  if new.credit_ref !~ '^rj-' then
    raise exception 'render job refused: a queued run is paid by a queue credit hold (rj-…)'
      using errcode = '42501';
  end if;
  select * into r from public.credit_reservations where job_id = new.credit_ref;
  if r.job_id is null or r.org_id is distinct from v_org or r.status <> 'open'
     or r.started_at is not null or r.created_at < now() - interval '3 hours' then
    raise exception 'render job refused: its credit hold is not an open, unused hold of this organization'
      using errcode = '42501';
  end if;

  -- The hold covers the frozen length: modules/credits.minimum_reservation.
  -- job_minimum is a flat floor (margin ignored, as in reserve_credits);
  -- video_minute is credits per minute with its margin. Unset = no floor.
  select credits_per_unit into jm from public.credit_prices where unit = 'job_minimum';
  select * into vm from public.credit_prices where unit = 'video_minute';
  v_need := greatest(coalesce(jm, 0),
                     coalesce(vm.credits_per_unit * (1 + vm.margin) * v_secs / 60, 0));
  v_need := public.credits_round_up(v_need);
  if v_need > 0 and r.amount < v_need then
    raise exception 'render job refused: its credit hold does not cover a run of % seconds', v_secs::integer
      using errcode = '22023',
            hint = 'Reserve for the length you run, or choose a shorter one.';
  end if;
  return new;
end
$$;

drop trigger if exists render_jobs_payment_guard on public.render_jobs;
create trigger render_jobs_payment_guard
  before insert on public.render_jobs
  for each row execute function public.render_jobs_payment_guard();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Update: a job's paid terms are what was inserted
-- ───────────────────────────────────────────────────────────────────────────
-- Only the worker (service key) and claim_render_job update jobs, and only

drop trigger if exists render_jobs_payment_guard on public.render_jobs;
create trigger render_jobs_payment_guard
  before insert on public.render_jobs
  for each row execute function public.render_jobs_payment_guard();

-- 0041's, with the regeneration link frozen too: a queued repair stays the
-- job of the regeneration that paid for it.
create or replace function public.render_jobs_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.channel_id is distinct from old.channel_id
     or new.kind is distinct from old.kind
     or new.params is distinct from old.params
     or new.credit_ref is distinct from old.credit_ref
     or new.api_hold_ref is distinct from old.api_hold_ref
     or new.scene_regeneration_id is distinct from old.scene_regeneration_id
     or new.requested_by is distinct from old.requested_by then
    raise exception 'a queued job''s channel, params and payment are fixed when it is queued'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists render_jobs_terms_frozen on public.render_jobs;
create trigger render_jobs_terms_frozen
  before update on public.render_jobs
  for each row execute function public.render_jobs_terms_frozen();

-- 0041's insert policy, verbatim, plus `scene_regeneration_id is null`: a
-- browser's "Run now" row is never a regeneration's job.
drop policy if exists render_jobs_insert on public.render_jobs;
create policy render_jobs_insert on public.render_jobs
  for insert to authenticated
  with check (
    channel_id in (select public.accessible_channel_ids('admin'))
    and requested_by = auth.uid()
    and kind = 'daily'
    and status = 'queued'
    and attempts = 0
    and max_attempts = 3
    and worker_id is null
    and heartbeat_at is null
    and started_at is null
    and finished_at is null
    and error is null
    and api_hold_ref is null
    and scene_regeneration_id is null
    and (params - array['topic','niche','duration','language','visual_style',
                        'video_provider','image_provider',
                        'tts_model','voice_id','publish_hint']) = '{}'::jsonb
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The worker's side (service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- After the claim, before anything is spent: the hold is claimed
-- (start_credit_reservation) and the frozen terms are handed to the run.
-- Null = do not run (no such regeneration for this job, already ended, or its
-- hold is no longer open — then it is failed here and nothing is charged).
-- A re-queued job (worker lost) gets the same terms again.
create or replace function public.start_scene_regeneration(p_id uuid, p_job bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r   public.scene_regenerations;
  amt numeric;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.scene_regenerations where id = p_id for update;
  if r.id is null or r.render_job_id is distinct from p_job or r.status not in ('queued', 'running') then
    return null;
  end if;
  if r.credit_ref is not null then
    amt := public.start_credit_reservation(r.credit_ref, r.org_id);
    if amt is null or amt < r.quoted_credits then
      if amt is not null then
        perform public.release_credits(r.credit_ref);
      end if;
      update public.scene_regenerations
         set status = 'failed', charged_credits = 0, finished_at = now(), error_code = 'hold_not_open',
             error = 'The credit hold for this regeneration was no longer open, so nothing ran and nothing was charged.'
       where id = r.id;
      return null;
    end if;
  end if;
  update public.scene_regenerations
     set status = 'running', started_at = coalesce(started_at, now())
   where id = r.id;
  return jsonb_build_object(
    'id', r.id, 'channel_id', r.channel_id, 'video_id', r.video_id, 'slug', r.slug, 'scene_id', r.scene_id,
    'requested_source', r.requested_source, 'source_kind', r.source_kind,
    'provider', r.provider, 'model', r.model, 'explicit_stock', r.explicit_stock, 'prompt', r.prompt,
    'generated_clips', r.generated_clips, 'stock_assets', r.stock_assets,
    'previous_asset_ids', to_jsonb(r.previous_asset_ids), 'quoted_credits', r.quoted_credits);
end
$$;

-- How it ended, with the money, in one transaction. Success: capture the
-- quote (= the hold; capture_credits never exceeds it), void the approval of
-- the previous cut. Failure: release the whole hold; the old scene was never
-- replaced. Ending twice changes nothing and returns the first answer.
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
  update public.scene_regenerations
     set status = 'failed', charged_credits = case when r.credit_ref is null then null else 0 end,
         result = v_result, finished_at = now(), error_code = v_code, error = left(p_error, 500)
   where id = r.id;
  return jsonb_build_object('id', r.id, 'status', 'failed', 'charged_credits', 0, 'replayed', false);
end
$$;

-- A regeneration whose job ended without finishing it (the worker died on the
-- last attempt, the job was cancelled, or it never left the queue within a
-- day) is failed and its hold released — never left "running" with credits
-- held, never charged.
create or replace function public.expire_scene_regenerations() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r   public.scene_regenerations;
  res public.credit_reservations;
  n   integer := 0;
begin
  if not public.credits_trusted_caller() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for r in
    select s.* from public.scene_regenerations s
     where s.status in ('queued', 'running')
       and (s.created_at < now() - interval '26 hours'
            -- The worker settles a regeneration right after its job ends;
            -- 15 minutes of grace keep this sweep from racing that call.
            or not exists (select 1 from public.render_jobs j
                            where j.id = s.render_job_id
                              and (j.status in ('queued', 'running')
                                   or j.finished_at > now() - interval '15 minutes')))
     order by s.created_at
     for update skip locked
  loop
    if r.credit_ref is not null then
      select * into res from public.credit_reservations where job_id = r.credit_ref;
      if res.job_id is not null and res.status = 'open' then
        perform public.release_credits(r.credit_ref);
      end if;
    end if;
    update public.scene_regenerations
       set status = 'failed', charged_credits = case when r.credit_ref is null then null else 0 end,
           finished_at = now(), error_code = 'job_ended',
           error = 'The job ended before the scene was finished; the previous take was kept and nothing was charged.'
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Privileges and RLS
-- ───────────────────────────────────────────────────────────────────────────

alter table public.scene_regenerations enable row level security;
revoke all on public.scene_regenerations from public, anon, authenticated, service_role;
grant select on public.scene_regenerations to authenticated, service_role;

drop policy if exists scene_regenerations_select on public.scene_regenerations;
create policy scene_regenerations_select on public.scene_regenerations
  for select to authenticated
  using (channel_id in (select public.accessible_channel_ids('viewer')));

revoke all on function public.scene_regenerations_terms_frozen() from public, anon, authenticated, service_role;
revoke all on function public.scene_regenerations_no_delete() from public, anon, authenticated, service_role;
revoke all on function public.scene_regen_plan(jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.scene_regen_price(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.scene_regen_published(public.videos) from public, anon, authenticated, service_role;
revoke all on function public.render_jobs_payment_guard() from public, anon, authenticated;
revoke all on function public.render_jobs_terms_frozen() from public, anon, authenticated;

revoke all on function public.quote_scene_regenerate(text, text, text) from public, anon, service_role;
grant execute on function public.quote_scene_regenerate(text, text, text) to authenticated;
revoke all on function public.request_scene_regenerate(text, text, text, text, numeric, text) from public, anon, service_role;
grant execute on function public.request_scene_regenerate(text, text, text, text, numeric, text) to authenticated;

revoke all on function public.start_scene_regeneration(uuid, bigint) from public, anon, authenticated;
revoke all on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.expire_scene_regenerations() from public, anon, authenticated;
grant execute on function public.start_scene_regeneration(uuid, bigint) to service_role;
grant execute on function public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb) to service_role;
grant execute on function public.expire_scene_regenerations() to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid = 'public.scene_regenerations'::regclass)
--     as rls_on,
--   not has_table_privilege('authenticated', 'public.scene_regenerations', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.scene_regenerations', 'UPDATE')
--     and not has_table_privilege('authenticated', 'public.scene_regenerations', 'DELETE')
--     as browser_cannot_write_regenerations,
--   not has_table_privilege('anon', 'public.scene_regenerations', 'SELECT')
--     as anon_gets_nothing,
--   (select with_check from pg_policies
--     where schemaname = 'public' and tablename = 'render_jobs'
--       and policyname = 'render_jobs_insert') like '%scene_regeneration_id IS NULL%'
--     and (select with_check from pg_policies
--           where schemaname = 'public' and tablename = 'render_jobs'
--             and policyname = 'render_jobs_insert') like '%api_hold_ref IS NULL%'
--     as browser_cannot_link_a_job,
--   position('scene_regeneration_id' in pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)) > 0
--     and position('does not cover a run of' in pg_get_functiondef('public.render_jobs_payment_guard()'::regprocedure)) > 0
--     as guard_keeps_0041_and_checks_the_link,
--   not has_function_privilege('authenticated', 'public.start_scene_regeneration(uuid, bigint)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.finish_scene_regeneration(uuid, bigint, boolean, text, text, jsonb)', 'EXECUTE')
--     and not has_function_privilege('authenticated', 'public.expire_scene_regenerations()', 'EXECUTE')
--     as worker_functions_are_service_only,
--   not has_function_privilege('anon', 'public.request_scene_regenerate(text, text, text, text, numeric, text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.quote_scene_regenerate(text, text, text)', 'EXECUTE')
--     as anon_cannot_quote_or_press,
--   not exists (select 1 from public.credit_prices where unit like 'scene_regenerate%' and credits_per_unit is null)
--     as no_price_invented,
--   (select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
--      from pg_proc p where p.pronamespace = 'public'::regnamespace
--       and p.proname in ('quote_scene_regenerate', 'request_scene_regenerate', 'start_scene_regeneration',
--                         'finish_scene_regeneration', 'expire_scene_regenerations', 'scene_regen_plan',
--                         'scene_regen_price', 'scene_regen_published', 'render_jobs_payment_guard',
--                         'render_jobs_terms_frozen', 'scene_regenerations_terms_frozen'))
--     as search_path_pinned;
