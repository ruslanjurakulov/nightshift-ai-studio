-- 0137_character_studio.sql — Character Studio ("Qahramon studiyasi", docs/CHARACTER_STUDIO.md): swap the people in a member's video for
-- the characters in their pictures, with a model the member chooses (Kling 4.0 Omni or BytePlus Seedance 2.5, each through its maker's own
-- API), priced per model from that vendor's own price table for the clip's length and resolution, held, run by a worker, captured or released.
--
-- *** LIVE ON APPLY. *** Merging this file applies it to the live database. It ADDS six tables, twelve internal functions, four functions a
-- signed-in member may call and four the platform's worker calls (service_role). It replaces NOTHING that exists there: no existing function,
-- table, column, policy or grant is changed (tests/test_character_studio_migration.py pins that no `create or replace` names an older
-- function and no `alter table` an older table; the last block asserts the end state). It is DARK in the application: the Command Center
-- shows the studio only with NIGHTSHIFT_CHARACTER_STUDIO=on, and the worker (tools/character_swap_worker.py) claims nothing while that switch
-- is off. The DATABASE is not dark: the four member functions are granted to `authenticated` from the moment this applies. That is why
-- NOTHING IS ON SALE until the owner sets a price: both models' character_swap_models.credits_per_usd are seeded NULL, and
-- request_character_swap refuses `not_on_sale` while it is. Both models also stay terms-gated in the registry (Kling terms_review_required,
-- BytePlus written_consent_required, api_exposure web_only): the owner sets a price only after the vendor's written answer
-- (docs/CHARACTER_STUDIO.md, "Unlocking a model"). A consent row made through PostgREST meanwhile is a real row: the rollback refuses while
-- any exists unless told.
--
-- WHAT IT DOES NOT DO. No vendor is called from the database; nothing is published; no video's privacy changes; nothing in a browser uploads
-- to a vendor. creative_jobs, reserve_credits, job_minimum and every other shared function are untouched: a character swap is not a creative
-- job (the registry lists video_character_swap as registry-only, so the creative system can never sell it).
--
-- NUMBER. 0137: the highest on main is 0136 (#685, applied live). This file was first numbered 0135 (0134's and 0136's headers still
-- say 0135 is reserved for it); it was renumbered with the same body so that it applies after 0136 rather than out of order. 0135 is
-- left unused. It names nothing 0132, 0133, 0134 or 0136 adds: only 0018 / 0020 / 0036 / 0038 / 0054 / 0107 objects.
--
-- APPLY AS ONE TRANSACTION: the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1. `set local lock_timeout`
-- assumes it, and the last block asserts the end state, so a half-applied file cannot be left behind.
--
-- WHAT IT ADDS
--   character_swap_models      one row per model the person can choose: credits_per_usd (NULL = not on sale, the seed), the vendor's own
--                              USD per clip second at 720p and 1080p (the vendor price table, cited in source_url; registry
--                              schemas/model_registry.json carries the same numbers, tests pin them equal), the input length the vendor
--                              takes, how many pictures, and the real-people rule. Changed in the SQL editor only; every change leaves a
--                              security_events row (character_swap.settings).
--   character_swap_settings    one row: org_daily_jobs (10), platform_daily_jobs (200), platform_in_flight (20). Safety defaults, not yet
--                              owner-approved.
--   character_swap_consents    APPEND-ONLY (as 0117's voice_consents): who declared, for which organization, model, video and pictures,
--                              the five declarations and the consent text's version. No foreign key on purpose: the trail outlives the job,
--                              the pictures and the video it is about.
--   character_swap_jobs        one priced swap: the organization, an optional editor project, the model, the resolution, the input video,
--                              the pictures (ordered: @Image 1 is the first), the prompt, the consent it rests on, the input's seconds, the
--                              charge and the hold, the status requested | running | ready | failed | cancelled, a closed error code, the
--                              vendor's task id (recorded BEFORE polling, so a crash polls instead of paying twice), the stored output, the
--                              idempotency key and request hash, timestamps.
--   character_swap_templates   the gallery's cards: a slug, a title in en / ru / uz, the prompt Try fills in. Platform content.
--   character_swap_template_samples  one sample per card and model (both optional: an empty slot reads "Namuna tez orada"): the web copy's
--                              public CDN link, an optional poster, the original's object path in the PRIVATE bucket (never a link), and
--                              when it was made. Written by tools/character_studio_samples.py with the service key, after the owner
--                              approves its paid calls; nothing in this file or the app makes one.
--
-- MONEY (as 0133). The CHARGE is computed here, never sent by a client: credits_round_up(ceil(input seconds) x the vendor's USD per second at
-- that resolution x the model's credits_per_usd), to the cent (character_swap_charge). reserve_credits refuses any hold below job_minimum
-- and no shared money function is changed, so a request HOLDS greatest(charge, credits_round_up(job_minimum)) (reserve_credits through
-- 0036's creative_platform_reserve), the worker's finish CAPTURES exactly the charge (capture_credits(ref, charge, false), which releases the
-- rest of the hold in the same transaction), and every failure, a cancel and the stale sweeps RELEASE the whole hold. job_minimum is 30 live:
-- a 12.40-credit swap holds 30 and charges 12.40. The caller confirms the price it was shown (p_max_credits, compared with the CHARGE, never
-- the hold; NaN and the infinities are refused before anything reads them): a higher charge is `price_changed`, never charged. The same
-- press again (the same p_idem and the same inputs) is the same job and holds nothing twice; the same key with other inputs is
-- `idempotency_conflict`. The exempt organization (the operator's) is not charged, and only a platform admin may swap there
-- (create_creative_job's rule). Not enough credits for the hold: `swap_hold_unavailable` (NS402, detail hold=... charge=...).
--
-- CONSENT AND REAL PEOPLE. Every request rests on a consent row of the SAME person, organization, model, video and pictures (in order),
-- made within the hour and used by no other job (`consent_required`). The five declarations (all true, nothing else): rights_to_video,
-- performers_consented, no_minors, references_owned_or_licensed, data_to_provider. The prompt passes a keyword screen against real or public
-- people and minors (character_swap_prompt_problem; KEYWORD-WEAK BY DESIGN, as 0117's name screen: it stops casual attempts and says so,
-- it is not identity verification; modules/character_swap.PROMPT_PATTERNS is the same list). Seedance 2.5 refuses real human faces unless
-- each performer is a verified BytePlus asset, which this file does not take yet: it is sold ONLY for a video that is this organization's
-- own generated clip (source 'generated', a BytePlus model's output per its provenance, at most 30 days old: ModelArk's own 30-day rule),
-- else `needs_own_generated_clip`. Every output is stored as source 'generated' with provenance origin 'character_swap' and an AI label
-- (docs/AI_DISCLOSURE.md); finish_character_swap refuses any other output.
--
-- CAPS. One job in flight per organization (a unique index: requested or running). Per organization per 24 hours (every status: a failed
-- job releases its hold and so would otherwise cost nothing): org_daily_jobs, under the organization's lock, `org_daily_limit` with no
-- number. Then, under one platform lock taken AFTER the organization's (0127's order): platform_in_flight (`platform_busy`) and
-- platform_daily_jobs (`platform_busy`), no number. 100 consents per organization per 24 hours (fixed).
--
-- LOCK ORDER (0131). No function holds a row lock while it waits for the ORGANIZATION's advisory lock. request_character_swap /
-- record_character_swap_consent / cancel_character_swap read without a lock, check sign-in and the role, take the organization's lock
-- ('character_swap:' || org), and only then lock rows: the input and the pictures FOR SHARE (read again under the lock, so a delete cannot
-- slip between the check and the insert), a job FOR NO KEY UPDATE (read again). request_character_swap then waits on the PLATFORM's lock
-- ('character_swap_global') while it still holds those FOR SHARE locks on the organization's own media_assets rows: a media delete of
-- those rows waits for it, and nothing waits the other way (no holder of the platform lock waits on a media row), so it cannot
-- deadlock. The credit account is locked last, inside reserve_credits.
-- The worker's functions take no advisory lock: a job row, then the credit account (capture / release lock the account).
--
-- STALE. A job nobody took within 2 hours is failed `expired`. A running job whose worker went quiet for 15 minutes BEFORE it recorded a
-- vendor task is failed `worker_lost` (no task is known, so none is polled). One whose worker went quiet AFTER it recorded a task is taken
-- over by the next claim (resume: the task is polled, never submitted again) for 6 hours after the submit, then failed `worker_lost`. Each
-- releases the whole hold. The next claim or request runs the sweep.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only; the SQL editor on the live project). None of the names may exist yet (expected: no row):
--     select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'character_swap%';
--     select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%character_swap%';
--   The prerequisites (expected: one row, all true):
--     select to_regprocedure('public.creative_platform_reserve(uuid, text, numeric)') is not null,
--            to_regprocedure('public.creative_platform_release(text)') is not null,
--            to_regprocedure('public.capture_credits(text, numeric, boolean)') is not null,
--            to_regprocedure('public.start_credit_reservation(text, uuid)') is not null,
--            to_regclass('public.editor_projects') is not null, to_regclass('public.media_assets') is not null;
--
-- Additive and idempotent: create table if not exists, drop constraint then add, create or replace, drop trigger / policy then create, revoke
-- then grant, seeds `on conflict do nothing` (a replay never undoes the owner's price). An applied migration is never edited.
-- Rollback: docs/sql/rollback_0137_character_studio.sql (drops exactly what this file added; refuses while a job is in flight, and while
-- rows exist unless told they may go).
-- REQUIRES 0018 (organizations, is_org_member, accessible_org_ids, is_platform_admin), 0020 / 0034 / 0094 (credits), 0036
-- (creative_platform_reserve / creative_platform_release), 0038 (media_assets), 0054 (editor_projects) and 0107 (security_event_log).

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null or to_regprocedure('public.accessible_org_ids(text)') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0137 needs 0018_organizations.sql: apply it first';
  end if;
  if to_regprocedure('public.capture_credits(text, numeric, boolean)') is null or to_regprocedure('public.release_credits(text)') is null
     or to_regprocedure('public.start_credit_reservation(text, uuid)') is null or to_regprocedure('public.credits_exempt(uuid)') is null
     or to_regprocedure('public.credits_trusted_caller()') is null or to_regprocedure('public.credits_round_up(numeric)') is null then
    raise exception '0137 needs 0020_credits.sql: apply it first';
  end if;
  if to_regprocedure('public.creative_platform_reserve(uuid, text, numeric)') is null
     or to_regprocedure('public.creative_platform_release(text)') is null then
    raise exception '0137 needs 0036_creative_jobs.sql (creative_platform_reserve / creative_platform_release): apply it first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0137 needs 0038_media_assets.sql: apply it first';
  end if;
  if to_regclass('public.editor_projects') is null then
    raise exception '0137 needs 0054_editor_projects.sql: apply it first';
  end if;
  if to_regprocedure('public.security_event_log(text, text, text, jsonb)') is null then
    raise exception '0137 needs 0107_owner_safety.sql (security_event_log): apply it first';
  end if;
end $$;

-- A function of one of this file's names that already exists must be this file's (a replay). md5 of prosrc with every run of white space
-- read as one space; tests/test_character_studio_migration.py recomputes every hash from this file.
do $$
declare
  r   record;
  got text;
begin
  for r in
    select * from (values
      ('public.character_swap_prompt_patterns()', '56d65ed5c0f40fe8cba6322ab1a008f6'),
      ('public.character_swap_norm(text)', '77daf6b06c31903d7749e128ea7d6e6c'),
      ('public.character_swap_prompt_problem(text)', 'f04a84afb9fb9e24163f55405d71de99'),
      ('public.character_swap_declarations_problem(jsonb)', '754abba4458f3102ec111ba6685e9e99'),
      ('public.character_swap_settings_guard()', 'a6d0eef455902fdeb530a2292d1f50b2'),
      ('public.character_swap_settings_trail()', 'ea80decbe4672917d765a966c2259c3a'),
      ('public.character_swap_append_only()', '304d7d15844f07c1cb5821dd473c22ff'),
      ('public.character_swap_charge(text, text, numeric)', 'a7fb5589674ddc84898810769d594c6f'),
      ('public.character_swap_hold(numeric)', '0c4cc9d1627fd3bf0a2bc07f348465c7'),
      ('public.character_swap_input_problem(uuid, text, uuid, uuid[])', '82bddbc3d809fdb5d886669634f017c9'),
      ('public.character_swap_end_locked(uuid, text, text)', '053cd01eb5919a57974f207459a3b0aa'),
      ('public.character_swap_sweep(uuid)', '8c9a1bc2f944692aebb21e9d2ae70b30'),
      ('public.quote_character_swap(uuid, uuid, text)', 'd08810be5286a526885183d2b7bfb030'),
      ('public.record_character_swap_consent(uuid, text, uuid, uuid[], jsonb, text)', '228dfbc6e7c7d7005f83fd8f341f22ce'),
      ('public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text)', '8b25050c082a66baf873ff871380ebc3'),
      ('public.cancel_character_swap(uuid)', '2f4b3fdc5aea42e39dffa3f3f701b412'),
      ('public.claim_character_swap(text)', '1645d8eec46cd4af9a4e00ca12d082e4'),
      ('public.record_character_swap_task(uuid, text, text)', 'a1238623579e2c1a8c2f9a8ae6536e4b'),
      ('public.finish_character_swap(uuid, text, uuid)', '552621b43552e9fc6992eb10a2bd1c3b'),
      ('public.fail_character_swap(uuid, text, text)', 'c094ba98581dc1e95ba17d364b5e1551')
    ) v(sig, want)
  loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = to_regprocedure(r.sig);
    if got is not null and got <> r.want then
      raise exception '0137 found a % that is not 0137''s body (md5 %): read the live body first', r.sig, got;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The words and the declarations (pure; no API role may call them)
-- ───────────────────────────────────────────────────────────────────────────

-- Phrases that read as a real or public person, or a minor. The SAME list is PROMPT_PATTERNS in modules/character_swap.py
-- (tests/test_character_studio_migration.py compares them). Each is matched, case-insensitively, against the normalised prompt
-- (character_swap_norm: every run of characters other than a-z, 0-9 and Cyrillic one space, a space at both ends), so a padded one is a
-- whole word or phrase. KEYWORD-WEAK BY DESIGN: a misspelt name passes; the consent and the vendor's own refusals stand behind it.
create or replace function public.character_swap_prompt_patterns() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array[
    ' real (person|people|human|humans) ', ' public figures? ', ' celebrit(y|ies) ', ' famous ', ' politicians? ', ' presidents? ',
    ' prime minister ', ' senators? ', ' actors? ', ' actress(es)? ', ' singers? ', ' rappers? ', ' footballers? ', ' streamers? ',
    ' youtubers? ', ' influencers? ', ' bloggers? ', ' deep ?fakes? ', ' face ?swaps? ', ' look ?alikes? ', ' likeness of ',
    ' impersonat[a-z]* ', ' pretend(ing)? to be ', ' looks? (just )?like ', ' (child|children|kids?|minors?|bab(y|ies)|toddlers?) ',
    ' teen[a-z]* ', ' school ?(girl|boy)s? ', 'знаменит', 'президент', 'политик', 'актер', 'актёр', 'актрис', 'певец', 'певиц',
    'дипфейк', 'ребен', 'ребён', ' дет(и|ей|ям) ', ' mashhur ', ' prezident ', ' siyosatchi ', ' aktyor ', ' aktrisa ', ' xonanda ',
    ' bolalar? ', ' chaqaloq '
  ]::text[]
$$;

-- The form the patterns read: NFKC, lower case, every run of other characters one space, a space at both ends. The invisible characters
-- are refused before this (character_swap_prompt_problem), so they cannot split a word here.
create or replace function public.character_swap_norm(p text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select ' ' || btrim(regexp_replace(lower(normalize(coalesce(p, ''), nfkc)), '[^a-z0-9а-яё]+', ' ', 'gi')) || ' '
$$;

-- NULL for a prompt that may be sent, else a closed word: prompt_length (1..2000 characters, not only space), prompt_characters (a control
-- character other than a line break, or one nobody sees: soft hyphen, zero-width and direction marks, word joiners, the BOM, the tag
-- block), prompt_needs_character (no @Image n: a picture nobody names is a character the vendor may put anywhere), prompt_real_person.
create or replace function public.character_swap_prompt_problem(p_prompt text) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  pat text;
  nrm text;
begin
  if p_prompt is null or char_length(p_prompt) > 2000 or btrim(p_prompt, E' \n') = '' then
    return 'prompt_length';
  end if;
  if p_prompt ~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]'
     or p_prompt ~ '[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]'
     or p_prompt ~ '[\U000e0000-\U000e0fff]' then
    return 'prompt_characters';
  end if;
  if p_prompt !~* '@image[[:space:]]*[0-9]' then
    return 'prompt_needs_character';
  end if;
  nrm := public.character_swap_norm(p_prompt);
  foreach pat in array public.character_swap_prompt_patterns() loop
    if nrm ~* pat then
      return 'prompt_real_person';
    end if;
  end loop;
  return null;
end
$$;

-- The five declarations a person makes before a swap. All five present and true; nothing else accepted.
create or replace function public.character_swap_declarations_problem(p jsonb) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 1024 then
    return 'declarations_shape';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('rights_to_video', 'performers_consented', 'no_minors', 'references_owned_or_licensed', 'data_to_provider') then
      return 'declarations_unknown';
    end if;
  end loop;
  foreach k in array array['rights_to_video', 'performers_consented', 'no_minors', 'references_owned_or_licensed', 'data_to_provider'] loop
    if (p -> k) is distinct from 'true'::jsonb then
      return 'declarations_incomplete';
    end if;
  end loop;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.character_swap_models (
  model_id             text primary key,
  position             integer not null,
  -- NULL: not on sale (the seed). 0: free. Otherwise credits per USD of the vendor's own price (the charge is rounded up to the cent).
  credits_per_usd      numeric,
  usd_per_second_720p  numeric not null,
  usd_per_second_1080p numeric not null,
  input_seconds_min    integer not null,
  input_seconds_max    integer not null,
  references_max       integer not null,
  real_people          text not null,
  source_url           text not null,
  updated_at           timestamptz not null default now()
);

alter table public.character_swap_models drop constraint if exists character_swap_models_shape_check;
alter table public.character_swap_models add constraint character_swap_models_shape_check
  check (model_id in ('kling-4.0-omni-edit', 'seedance-2.5-edit')
         and position between 1 and 100
         and (credits_per_usd is null or credits_per_usd between 0 and 10000)
         and usd_per_second_720p > 0 and usd_per_second_720p <= 10 and usd_per_second_1080p > 0 and usd_per_second_1080p <= 10
         and input_seconds_min between 1 and 120 and input_seconds_max between input_seconds_min and 120
         and references_max between 1 and 30
         and real_people in ('consent_declared', 'own_generated_clip_only')
         and source_url ~ '^https://[a-z0-9.-]+(/[\x21-\x7e]*)?$' and char_length(source_url) <= 300);

comment on table public.character_swap_models is
  'The models a person can choose in Character Studio (migration 0137): credits_per_usd (NULL = not on sale, the seed) and the vendor''s own USD per clip second at 720p / 1080p (source_url), the input length, the picture limit and the real-people rule. Changed in the SQL editor only; a trigger leaves a mark in security_events.';

-- The vendors' list prices, read 2026-11-11 (schemas/model_registry.json carries the same, tests pin them equal):
--   Kling 4.0 Omni with a video input: unit price x output seconds x 2 = $0.188/s at 720p, $0.282/s at 1080p (a 10 s clip $1.88 / $2.82).
--   Seedance 2.5, "Input with video": (in + out) seconds x W x H x 24 / 1024 tokens at $6.40 / $7.00 per 1M = $0.276/s at 720p, $0.68/s at
--   1080p (a 10 s clip $2.76 / $6.80); ESTIMATE: the minimum-token table was not read.
insert into public.character_swap_models (model_id, position, credits_per_usd, usd_per_second_720p, usd_per_second_1080p, input_seconds_min,
                                          input_seconds_max, references_max, real_people, source_url)
values ('kling-4.0-omni-edit', 1, null, 0.188, 0.282, 3, 30, 10, 'consent_declared', 'https://kling.ai/document-api/pricing/base/video'),
       ('seedance-2.5-edit', 2, null, 0.276, 0.68, 4, 30, 30, 'own_generated_clip_only', 'https://docs.byteplus.com/en/docs/ModelArk/1544106')
on conflict (model_id) do nothing;

create table if not exists public.character_swap_settings (
  id                  boolean primary key default true,
  org_daily_jobs      integer not null default 10,
  platform_daily_jobs integer not null default 200,
  platform_in_flight  integer not null default 20,
  updated_at          timestamptz not null default now()
);

alter table public.character_swap_settings drop constraint if exists character_swap_settings_one_row;
alter table public.character_swap_settings add constraint character_swap_settings_one_row check (id);
alter table public.character_swap_settings drop constraint if exists character_swap_settings_numbers;
alter table public.character_swap_settings add constraint character_swap_settings_numbers
  check (org_daily_jobs between 0 and 10000 and platform_daily_jobs between 0 and 100000 and platform_in_flight between 0 and 10000);

comment on table public.character_swap_settings is
  'One row (migration 0137): org_daily_jobs (10) per organization per 24 hours, platform_daily_jobs (200) per 24 hours and platform_in_flight (20) at once. 0 refuses all. Safety defaults, not yet owner-approved. Changed in the SQL editor only; a trigger leaves a mark in security_events.';

insert into public.character_swap_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.character_swap_consents (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null,
  user_id              uuid not null,
  model_id             text not null,
  input_asset_id       uuid not null,
  reference_asset_ids  uuid[] not null,
  declarations         jsonb not null,
  consent_text_version text not null,
  created_at           timestamptz not null default now()
);

alter table public.character_swap_consents drop constraint if exists character_swap_consents_shape_check;
alter table public.character_swap_consents add constraint character_swap_consents_shape_check
  check (model_id in ('kling-4.0-omni-edit', 'seedance-2.5-edit')
         and coalesce(array_ndims(reference_asset_ids), 0) = 1 and cardinality(reference_asset_ids) between 1 and 30
         and array_position(reference_asset_ids, null) is null
         and public.character_swap_declarations_problem(declarations) is null
         and consent_text_version ~ '^v[0-9]{1,3}$');

comment on table public.character_swap_consents is
  'The consent trail of Character Studio (migration 0137): who declared, for which organization, model, video and pictures, the five declarations and the consent text version. APPEND-ONLY for every role (as 0117''s voice_consents); no foreign key on purpose, so the trail outlives what it is about.';

create index if not exists character_swap_consents_org_idx on public.character_swap_consents (org_id, created_at desc);

create table if not exists public.character_swap_jobs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  -- An editor project the result belongs to (0054), when the person started from one. No foreign key: a project deleted later leaves the id.
  project_id          uuid,
  requested_by        uuid,
  model_id            text not null references public.character_swap_models (model_id),
  resolution          text not null,
  input_asset_id      uuid not null,
  reference_asset_ids uuid[] not null,
  prompt              text not null,
  consent_id          uuid not null,
  input_seconds       numeric not null,
  billed_seconds      integer not null,
  charge_credits      numeric not null default 0,
  hold_credits        numeric not null default 0,
  credit_ref          text,
  charged_credits     numeric,
  status              text not null default 'requested',
  error_code          text,
  provider_task_id    text,
  submitted_at        timestamptz,
  output_asset_id     uuid,
  worker_id           text,
  claimed_at          timestamptz,
  finished_at         timestamptz,
  cancelled_by        uuid,
  idempotency_key     text not null,
  request_hash        text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint character_swap_jobs_idem_key unique (org_id, idempotency_key),
  constraint character_swap_jobs_consent_key unique (consent_id)
);

comment on table public.character_swap_jobs is
  'One priced character swap (migration 0137): the inputs, the model and resolution the person chose, the charge and the hold, the status, the vendor task id (recorded before polling), the stored output. Written only by request / cancel_character_swap and the worker (claim / record_character_swap_task / finish / fail); members read.';

alter table public.character_swap_jobs drop constraint if exists character_swap_jobs_shape_check;
alter table public.character_swap_jobs add constraint character_swap_jobs_shape_check
  check (resolution in ('720p', '1080p')
         and coalesce(array_ndims(reference_asset_ids), 0) = 1 and cardinality(reference_asset_ids) between 1 and 30
         and array_position(reference_asset_ids, null) is null
         and public.character_swap_prompt_problem(prompt) is null
         and input_seconds > 0 and input_seconds <= 120 and billed_seconds between 1 and 120 and billed_seconds >= input_seconds
         and charge_credits >= 0 and hold_credits >= 0 and (hold_credits = 0 or hold_credits >= charge_credits)
         and (charged_credits is null or (charged_credits >= 0 and charged_credits <= charge_credits))
         and (credit_ref is null or credit_ref ~ '^cs:[0-9a-f-]{36}$')
         and status in ('requested', 'running', 'ready', 'failed', 'cancelled')
         and ((status in ('failed', 'cancelled')) = (error_code is not null))
         and (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
         and ((status = 'ready') = (output_asset_id is not null))
         and (status <> 'ready' or provider_task_id is not null)
         and (provider_task_id is null or provider_task_id ~ '^[A-Za-z0-9_.:-]{1,200}$')
         and ((provider_task_id is null) = (submitted_at is null))
         and (status not in ('requested') or (provider_task_id is null and worker_id is null))
         and ((status in ('ready', 'failed', 'cancelled')) = (finished_at is not null))
         and (cancelled_by is null or status = 'cancelled')
         and (worker_id is null or char_length(worker_id) between 1 and 120)
         and idempotency_key ~ '^[A-Za-z0-9_:.-]{8,128}$'
         and request_hash ~ '^[0-9a-f]{32}$');

-- One job in flight per organization: a second press while one runs is job_in_progress, and two racing presses cannot both insert.
create unique index if not exists character_swap_jobs_one_in_flight on public.character_swap_jobs (org_id) where status in ('requested', 'running');
create index if not exists character_swap_jobs_created_idx on public.character_swap_jobs (created_at);
create index if not exists character_swap_jobs_queue_idx on public.character_swap_jobs (created_at) where status = 'requested';
create index if not exists character_swap_jobs_running_idx on public.character_swap_jobs (claimed_at) where status = 'running';
create index if not exists character_swap_jobs_org_idx on public.character_swap_jobs (org_id, created_at desc);

create table if not exists public.character_swap_templates (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  position   integer not null,
  title_en   text not null,
  title_ru   text not null,
  title_uz   text not null,
  prompt     text not null,
  -- How many pictures the prompt names (@Image 1 .. @Image n): what Try asks the person for.
  characters integer not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.character_swap_templates drop constraint if exists character_swap_templates_shape_check;
alter table public.character_swap_templates add constraint character_swap_templates_shape_check
  check (slug ~ '^[a-z0-9][a-z0-9-]{1,47}$' and position between 1 and 1000
         and char_length(title_en) between 1 and 80 and char_length(title_ru) between 1 and 80 and char_length(title_uz) between 1 and 80
         and title_en !~ '[[:cntrl:]]' and title_ru !~ '[[:cntrl:]]' and title_uz !~ '[[:cntrl:]]'
         and public.character_swap_prompt_problem(prompt) is null and characters between 1 and 10);

comment on table public.character_swap_templates is
  'The Character Studio gallery''s cards (migration 0137): a title in en / ru / uz and the prompt "Sinab ko''rish" fills in. Platform content: any signed-in person reads it; only the SQL editor or the service key writes it.';

create table if not exists public.character_swap_template_samples (
  template_id     uuid not null references public.character_swap_templates (id) on delete cascade,
  model_id        text not null references public.character_swap_models (model_id),
  web_url         text not null,
  poster_url      text,
  original_object text not null,
  made_at         timestamptz not null default now(),
  primary key (template_id, model_id)
);

alter table public.character_swap_template_samples drop constraint if exists character_swap_template_samples_shape_check;
alter table public.character_swap_template_samples add constraint character_swap_template_samples_shape_check
  check (web_url ~ '^https://[a-z0-9.-]+/[A-Za-z0-9._~/-]+$' and char_length(web_url) <= 500
         and (poster_url is null or (poster_url ~ '^https://[a-z0-9.-]+/[A-Za-z0-9._~/-]+$' and char_length(poster_url) <= 500))
         and original_object ~ '^[a-z0-9][a-z0-9-]{1,47}/[a-z0-9.-]{1,64}/[A-Za-z0-9._-]{1,128}$');

comment on table public.character_swap_template_samples is
  'One sample per gallery card and model (migration 0137): the web copy''s public CDN link, an optional poster, and the original''s object path in the PRIVATE samples bucket (a path, never a link). A missing row is an empty slot ("Namuna tez orada"). Written only by tools/character_studio_samples.py with the service key.';

-- Two cards, no samples (making one is a paid call the owner has not approved yet: docs/CHARACTER_STUDIO.md, "Samples").
insert into public.character_swap_templates (slug, position, title_en, title_ru, title_uz, prompt, characters)
values ('two-characters', 1, 'Two new characters', 'Два новых героя', 'Ikki yangi qahramon',
        'Replace the person on the left with the character in @Image 1 and the person on the right with the character in @Image 2. Keep the scene, the camera, the motion and the lighting unchanged.', 2),
       ('one-character', 2, 'One new character', 'Один новый герой', 'Bitta yangi qahramon',
        'Replace the person in @Video 1 with the character in @Image 1. Keep everything else in the video unchanged.', 1)
on conflict (slug) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The settings rows: never deleted, every change leaves a mark; the consent trail: never changed
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.character_swap_settings_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '% keeps its rows', tg_table_name using errcode = '42501';
  end if;
  -- Nested: plpgsql does not short-circuit a record field that the other table lacks.
  if tg_table_name = 'character_swap_models' then
    if new.model_id is distinct from old.model_id then
      raise exception 'a model id is never renamed' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists character_swap_models_guard on public.character_swap_models;
create trigger character_swap_models_guard
  before update or delete on public.character_swap_models
  for each row execute function public.character_swap_settings_guard();
drop trigger if exists character_swap_models_no_truncate on public.character_swap_models;
create trigger character_swap_models_no_truncate
  before truncate on public.character_swap_models
  for each statement execute function public.character_swap_settings_guard();
drop trigger if exists character_swap_settings_guard on public.character_swap_settings;
create trigger character_swap_settings_guard
  before update or delete on public.character_swap_settings
  for each row execute function public.character_swap_settings_guard();
drop trigger if exists character_swap_settings_no_truncate on public.character_swap_settings;
create trigger character_swap_settings_no_truncate
  before truncate on public.character_swap_settings
  for each statement execute function public.character_swap_settings_guard();

-- A change of a price, a vendor rate, a limit or a cap leaves a security_events row (kind character_swap.settings) with the old and the new
-- row. It can never fail the change it observes.
create or replace function public.character_swap_settings_trail() returns trigger
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  o jsonb := to_jsonb(old) - 'updated_at';
  n jsonb := to_jsonb(new) - 'updated_at';
begin
  begin
    if o is distinct from n then
      perform public.security_event_log('character_swap.settings', 'warning', tg_table_name, jsonb_build_object('old', o, 'new', n));
    end if;
  exception when others then
    raise warning 'character swap settings trail failed: %', sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists character_swap_models_trail on public.character_swap_models;
create trigger character_swap_models_trail
  after update on public.character_swap_models
  for each row execute function public.character_swap_settings_trail();
drop trigger if exists character_swap_settings_trail on public.character_swap_settings;
create trigger character_swap_settings_trail
  after update on public.character_swap_settings
  for each row execute function public.character_swap_settings_trail();

create or replace function public.character_swap_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'the character swap consent trail is append-only' using errcode = '42501';
end
$$;

drop trigger if exists character_swap_consents_append_only on public.character_swap_consents;
create trigger character_swap_consents_append_only
  before update or delete on public.character_swap_consents
  for each row execute function public.character_swap_append_only();
drop trigger if exists character_swap_consents_no_truncate on public.character_swap_consents;
create trigger character_swap_consents_no_truncate
  before truncate on public.character_swap_consents
  for each statement execute function public.character_swap_append_only();
-- ENABLE ALWAYS (0117): the trail's triggers also fire under session_replication_role = replica.
alter table public.character_swap_consents enable always trigger character_swap_consents_append_only;
alter table public.character_swap_consents enable always trigger character_swap_consents_no_truncate;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The price, the inputs, ending a job
-- ───────────────────────────────────────────────────────────────────────────

-- What a swap of p_seconds at p_resolution costs on p_model, what is CHARGED: NULL (not on sale, or no such model), 0 (free), or
-- ceil(seconds) x the vendor's USD per second x credits_per_usd, rounded up to the cent. Whole seconds: both vendors bill by the second of
-- the clip, and a fraction rounded down would be sold below cost.
create or replace function public.character_swap_charge(p_model text, p_resolution text, p_seconds numeric) returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m   public.character_swap_models;
  usd numeric;
begin
  select * into m from public.character_swap_models where model_id = p_model;
  if m.model_id is null or m.credits_per_usd is null or p_seconds is null or not (p_seconds > 0 and p_seconds <= 120) then
    return null;
  end if;
  usd := case p_resolution when '720p' then m.usd_per_second_720p when '1080p' then m.usd_per_second_1080p end;
  if usd is null then
    return null;
  end if;
  return trim_scale(round(public.credits_round_up(ceil(p_seconds) * usd * m.credits_per_usd), 2));
end
$$;

-- What a request HOLDS for a charge: the charge raised to job_minimum (reserve_credits refuses any hold below it; it is not changed here),
-- 0 for a free swap. Only the charge is ever captured.
create or replace function public.character_swap_hold(p_charge numeric) returns numeric
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_floor numeric;
begin
  if p_charge is null or p_charge <= 0 then
    return p_charge;
  end if;
  select credits_per_unit into v_floor from public.credit_prices where unit = 'job_minimum';
  return trim_scale(round(greatest(p_charge, coalesce(public.credits_round_up(v_floor), 0)), 2));
end
$$;

-- Why p_input and p_refs cannot be swapped on p_model for p_org, or NULL. Closed words: model_unknown, input_unavailable (not a live video of
-- this organization in mp4 / mov with a measured length and size), input_too_short / input_too_long (the vendor's own limits),
-- needs_own_generated_clip (Seedance: see the header), references_count, references_unavailable (each a live png / jpeg / webp of this
-- organization, no repeats). Reads the rows as they are; request_character_swap reads them again under FOR SHARE.
create or replace function public.character_swap_input_problem(p_org uuid, p_model text, p_input uuid, p_refs uuid[]) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m public.character_swap_models;
  a public.media_assets;
  n integer;
begin
  select * into m from public.character_swap_models where model_id = p_model;
  if m.model_id is null then
    return 'model_unknown';
  end if;
  select * into a from public.media_assets
   where id = p_input and org_id = p_org and kind = 'video' and deleted_at is null and mime in ('video/mp4', 'video/quicktime')
     and duration_s is not null and width is not null and height is not null;
  if a.id is null then
    return 'input_unavailable';
  end if;
  if a.duration_s < m.input_seconds_min then
    return 'input_too_short';
  end if;
  if a.duration_s > m.input_seconds_max then
    return 'input_too_long';
  end if;
  if m.real_people = 'own_generated_clip_only'
     and not (a.source = 'generated' and a.created_at > now() - interval '30 days'
              and lower(coalesce(a.provenance ->> 'provider', '')) in ('bytedance', 'byteplus')) then
    return 'needs_own_generated_clip';
  end if;
  if p_refs is null or coalesce(array_ndims(p_refs), 0) <> 1 or cardinality(p_refs) < 1 or cardinality(p_refs) > m.references_max
     or array_position(p_refs, null) is not null then
    return 'references_count';
  end if;
  select count(distinct r) into n from unnest(p_refs) r;
  if n <> cardinality(p_refs)
     or (select count(*) from public.media_assets
          where id = any (p_refs) and org_id = p_org and kind = 'image' and deleted_at is null
            and mime in ('image/png', 'image/jpeg', 'image/webp')) <> n then
    return 'references_unavailable';
  end if;
  return null;
end
$$;

-- End a job the caller has locked (failed or cancelled) and give its hold back. creative_platform_release clears the caller's claims for
-- the one call, so a member's cancel, a request's sweep and the worker reach release_credits alike; a hold already gone returns 0. A job
-- already final is left as it is.
create or replace function public.character_swap_end_locked(p_job uuid, p_status text, p_code text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  x public.character_swap_jobs;
begin
  update public.character_swap_jobs
     set status = case when p_status = 'cancelled' then 'cancelled' else 'failed' end,
         error_code = case when coalesce(p_code, '') ~ '^[a-z0-9_]{1,64}$' then p_code else 'worker_error' end,
         cancelled_by = case when p_status = 'cancelled' then auth.uid() end,
         finished_at = now(), updated_at = now()
   where id = p_job and status in ('requested', 'running')
  returning * into x;
  if x.id is not null and x.credit_ref is not null then
    perform public.creative_platform_release(x.credit_ref);
  end if;
end
$$;

-- The stale sweep (see the header): p_org's jobs, or every organization's when p_org is NULL (the worker's claim). Rows another
-- transaction holds are skipped; the next sweep takes them.
create or replace function public.character_swap_sweep(p_org uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  stale record;
begin
  for stale in
    select id, status from public.character_swap_jobs
     where (p_org is null or org_id = p_org)
       and ((status = 'requested' and created_at < now() - interval '2 hours')
            or (status = 'running' and provider_task_id is null and claimed_at < now() - interval '15 minutes')
            or (status = 'running' and provider_task_id is not null and claimed_at < now() - interval '15 minutes'
                and submitted_at < now() - interval '6 hours'))
     for update skip locked
  loop
    perform public.character_swap_end_locked(stale.id, 'failed', case when stale.status = 'requested' then 'expired' else 'worker_lost' end);
  end loop;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The quote, the consent, the request, the cancel (members)
-- ───────────────────────────────────────────────────────────────────────────

-- What a swap of p_input at p_resolution would cost this organization on EACH model, now (any member): the studio shows the cost of the
-- chosen model at the top and switches it live. Per model: on_sale (false while credits_per_usd is NULL), credits (the charge), hold (what
-- the request holds while it runs), problem (why this video cannot go to this model: input_too_long, needs_own_generated_clip, ...).
-- The input itself must be a live video of this organization, else input_unavailable (NS400).
create or replace function public.quote_character_swap(p_org uuid, p_input uuid, p_resolution text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  a      public.media_assets;
  m      public.character_swap_models;
  charge numeric;
  models jsonb := '[]'::jsonb;
  prob   text;
begin
  if auth.uid() is null or p_org is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('720p', '1080p') then
    raise exception 'invalid_resolution' using errcode = 'NS400';
  end if;
  select * into a from public.media_assets
   where id = p_input and org_id = p_org and kind = 'video' and deleted_at is null and duration_s is not null;
  if a.id is null then
    raise exception 'input_unavailable' using errcode = 'NS400';
  end if;
  for m in select * from public.character_swap_models order by position loop
    -- The pictures are not known yet when the studio asks: one placeholder that passes, so only the video is judged here.
    prob := public.character_swap_input_problem(p_org, m.model_id, p_input, null);
    if prob = 'references_count' then
      prob := null;
    end if;
    charge := public.character_swap_charge(m.model_id, p_resolution, a.duration_s);
    models := models || jsonb_build_object('model', m.model_id, 'on_sale', charge is not null, 'credits', charge,
                                           'hold', public.character_swap_hold(charge), 'problem', prob,
                                           'input_seconds', jsonb_build_array(m.input_seconds_min, m.input_seconds_max),
                                           'references_max', m.references_max);
  end loop;
  return jsonb_build_object('seconds', a.duration_s, 'billed_seconds', ceil(a.duration_s), 'resolution', p_resolution,
                            'exempt', public.credits_exempt(p_org), 'models', models);
end
$$;

-- The consent step (an editor): the five declarations for THIS video, THESE pictures in this order and THIS model, as the consent text
-- version the person read (v1 is the current one; another is consent_version_stale). The inputs are judged as the request will judge
-- them, so a consent is never recorded for something that cannot be sold. 100 per organization per 24 hours (consent_limit). Returns
-- the consent id the request names; the row is never changed or deleted.
create or replace function public.record_character_swap_consent(p_org uuid, p_model text, p_input uuid, p_refs uuid[], p_declarations jsonb,
                                                                p_version text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid  uuid := auth.uid();
  prob text;
  v_id uuid;
begin
  if uid is null or p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  prob := public.character_swap_declarations_problem(p_declarations);
  if prob is not null then
    raise exception '%', prob using errcode = 'NS400';
  end if;
  if p_version is distinct from 'v1' then
    raise exception 'consent_version_stale' using errcode = 'NS409';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('character_swap:' || p_org::text, 0));
  prob := public.character_swap_input_problem(p_org, p_model, p_input, p_refs);
  if prob is not null then
    raise exception '%', prob using errcode = 'NS400';
  end if;
  if (select count(*) from public.character_swap_consents where org_id = p_org and created_at > now() - interval '24 hours') >= 100 then
    raise exception 'consent_limit' using errcode = 'NS429';
  end if;
  insert into public.character_swap_consents (org_id, user_id, model_id, input_asset_id, reference_asset_ids, declarations, consent_text_version)
  values (p_org, uid, p_model, p_input, p_refs, p_declarations, p_version)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end
$$;

-- Ask for one swap (an editor). Refusals, in order: forbidden; invalid_resolution, the prompt's word (prompt_length, prompt_characters,
-- prompt_needs_character, prompt_real_person), invalid_idempotency_key, price_changed (a confirmed price that is not a number in range);
-- then under the organization's lock: idempotency_conflict (or the replay), the input's word (model_unknown, input_unavailable,
-- input_too_short, input_too_long, references_count, references_unavailable, needs_own_generated_clip), project_unavailable, not_on_sale,
-- price_changed (detail charge=...), consent_required, org_daily_limit, job_in_progress, platform_busy, swap_hold_unavailable (NS402) and
-- NS429 from the hold. A refusal changes nothing.
create or replace function public.request_character_swap(p_org uuid, p_project uuid, p_input uuid, p_refs uuid[], p_prompt text, p_model text,
                                                         p_resolution text, p_consent uuid, p_max_credits numeric, p_idem text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  v_hash  text;
  prob    text;
  v_secs  numeric;
  charge  numeric;
  v_hold  numeric;
  v_id    uuid := gen_random_uuid();
  v_ref   text;
  res     jsonb;
  prior   public.character_swap_jobs;
  c       public.character_swap_consents;
  s       public.character_swap_settings;
begin
  if uid is null or p_org is null or not public.is_org_member(p_org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid for by the platform: only a platform admin spends there (create_creative_job's rule).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'swaps in the operator''s organization are started by a platform admin';
  end if;
  -- Read only now, after sign-in and the role.
  if p_resolution is null or p_resolution not in ('720p', '1080p') then
    raise exception 'invalid_resolution' using errcode = 'NS400';
  end if;
  prob := public.character_swap_prompt_problem(p_prompt);
  if prob is not null then
    raise exception '%', prob using errcode = 'NS400';
  end if;
  if p_idem is null or p_idem !~ '^[A-Za-z0-9_:.-]{8,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = 'NS400';
  end if;
  -- NaN and the infinities are numerics too, and a comparison with NaN is never true: refused before anything reads them.
  if p_max_credits is not null and not (p_max_credits between 0 and 100000) then
    raise exception 'price_changed' using errcode = 'NS409';
  end if;
  v_hash := md5(jsonb_build_object('project', p_project, 'input', p_input, 'refs', to_jsonb(p_refs), 'prompt', p_prompt, 'model', p_model,
                                   'resolution', p_resolution, 'consent', p_consent, 'max_credits', p_max_credits)::text);

  -- Presses of one organization take turns (a double click, a second tab, a second editor): the replay and the counts below are exact.
  perform pg_advisory_xact_lock(hashtextextended('character_swap:' || p_org::text, 0));
  select * into prior from public.character_swap_jobs where org_id = p_org and idempotency_key = p_idem;
  if prior.id is not null then
    if prior.request_hash <> v_hash then
      raise exception 'idempotency_conflict' using errcode = 'NS409';
    end if;
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'credits', prior.charge_credits, 'hold', prior.hold_credits,
                              'replayed', true);
  end if;

  -- The input and the pictures, locked FOR SHARE after the organization's lock (0131's order) and judged under it: a delete cannot slip
  -- between this check and the insert.
  perform 1 from public.media_assets where org_id = p_org and (id = p_input or id = any (coalesce(p_refs, '{}'))) for share;
  prob := public.character_swap_input_problem(p_org, p_model, p_input, p_refs);
  if prob is not null then
    raise exception '%', prob using errcode = 'NS400';
  end if;
  if p_project is not null
     and not exists (select 1 from public.editor_projects where id = p_project and org_id = p_org and deleted_at is null) then
    raise exception 'project_unavailable' using errcode = 'NS400';
  end if;
  select duration_s into v_secs from public.media_assets where id = p_input;

  charge := public.character_swap_charge(p_model, p_resolution, v_secs);
  if charge is null then
    raise exception 'not_on_sale' using errcode = 'NS409';
  end if;
  if p_max_credits is null or charge > p_max_credits then
    raise exception 'price_changed' using errcode = 'NS409', detail = format('charge=%s', charge);
  end if;

  -- The consent this request rests on: the same person, organization, model, video and pictures in the same order, within the hour, and
  -- not the consent of another job.
  select * into c from public.character_swap_consents
   where id = p_consent and org_id = p_org and user_id = uid and model_id = p_model and input_asset_id = p_input
     and reference_asset_ids = p_refs and created_at > now() - interval '1 hour';
  if c.id is null or exists (select 1 from public.character_swap_jobs where consent_id = p_consent) then
    raise exception 'consent_required' using errcode = 'NS409';
  end if;

  -- This organization's share of the day (all statuses), under its own lock and before the platform's. No number in the refusal.
  select * into s from public.character_swap_settings;
  if (select count(*) from public.character_swap_jobs where org_id = p_org and created_at > now() - interval '24 hours')
     >= coalesce(s.org_daily_jobs, 10) then
    raise exception 'org_daily_limit' using errcode = 'NS429';
  end if;
  -- This organization's job that nobody took in time, or whose worker went quiet, gives its place and its hold back first.
  perform public.character_swap_sweep(p_org);
  if exists (select 1 from public.character_swap_jobs where org_id = p_org and status in ('requested', 'running')) then
    raise exception 'job_in_progress' using errcode = 'NS409';
  end if;
  -- Platform-wide, after the organization's lock (0127's order, so two requests never wait on each other). No number.
  perform pg_advisory_xact_lock(hashtextextended('character_swap_global', 0));
  if (select count(*) from public.character_swap_jobs where status in ('requested', 'running')) >= coalesce(s.platform_in_flight, 20)
     or (select count(*) from public.character_swap_jobs where created_at > now() - interval '24 hours') >= coalesce(s.platform_daily_jobs, 200) then
    raise exception 'platform_busy' using errcode = 'NS429';
  end if;

  -- The hold: the charge raised to job_minimum, under a reference this function made, never the caller's. Only the charge is captured
  -- (finish_character_swap); the rest of the hold goes back then, and all of it on a failure or a cancel.
  v_hold := 0;
  if charge > 0 then
    v_hold := public.character_swap_hold(charge);
    if v_hold < charge then
      raise exception 'character swap hold % is below its charge %', v_hold, charge;
    end if;
    v_ref := 'cs:' || v_id::text;
    begin
      res := public.creative_platform_reserve(p_org, v_ref, v_hold);
    exception when sqlstate 'NS402' then
      raise exception 'swap_hold_unavailable' using errcode = 'NS402', detail = format('hold=%s charge=%s', v_hold, charge);
    end;
    if coalesce((res ->> 'exempt')::boolean, false) then
      v_ref := null;
      v_hold := 0;
      charge := 0;
    end if;
  end if;
  insert into public.character_swap_jobs (id, org_id, project_id, requested_by, model_id, resolution, input_asset_id, reference_asset_ids,
                                          prompt, consent_id, input_seconds, billed_seconds, charge_credits, hold_credits, credit_ref,
                                          status, idempotency_key, request_hash)
  values (v_id, p_org, p_project, uid, p_model, p_resolution, p_input, p_refs, p_prompt, p_consent, v_secs, ceil(v_secs)::integer, charge,
          v_hold, v_ref, 'requested', p_idem, v_hash);
  return jsonb_build_object('id', v_id, 'status', 'requested', 'credits', charge, 'hold', v_hold, 'replayed', false);
end
$$;

-- Cancel a job that no worker has taken yet (an editor of its organization): the whole hold is released. A running job is already at the
-- vendor (or about to be) and cannot be taken back: not_cancellable. Another organization's job and a made-up id are the same not_found.
-- 0131's order: read unlocked, check the role, take the organization's lock, then lock the row FOR NO KEY UPDATE and read it again.
create or replace function public.cancel_character_swap(p_job uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  x     public.character_swap_jobs;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select org_id into v_org from public.character_swap_jobs where id = p_job;
  if v_org is null or not public.is_org_member(v_org, 'editor') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('character_swap:' || v_org::text, 0));
  select * into x from public.character_swap_jobs where id = p_job for no key update;
  if x.status in ('ready', 'failed', 'cancelled') then
    return jsonb_build_object('id', x.id, 'status', x.status, 'replayed', true);
  end if;
  if x.status <> 'requested' then
    raise exception 'not_cancellable' using errcode = 'NS409';
  end if;
  perform public.character_swap_end_locked(x.id, 'cancelled', 'cancelled_by_user');
  return jsonb_build_object('id', x.id, 'status', 'cancelled', 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The worker's side (service_role)
-- ───────────────────────────────────────────────────────────────────────────

-- Take one job. First the stale sweep. Then a running job whose worker went quiet AFTER it recorded a vendor task (resume: true; the new
-- worker POLLS that task and never submits again), else the oldest requested one: its hold is marked started (start_credit_reservation; a
-- hold that is gone fails the job `hold_missing`) and inputs that were deleted since fail it `input_unavailable`. The answer carries what
-- the worker needs: the inputs as the library recorded them, the prompt, the model, the resolution, the vendor task (when resuming) and
-- an opaque per-organization id for the vendor's abuse tracing. NULL when there is nothing to do.
create or replace function public.claim_character_swap(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w      text := left(btrim(coalesce(p_worker, '')), 120);
  x      public.character_swap_jobs;
  a      public.media_assets;
  resume boolean := false;
  refs   jsonb;
begin
  if not public.credits_trusted_caller() then
    raise exception 'character swaps are run by the platform''s worker only' using errcode = '42501';
  end if;
  if w = '' then
    raise exception 'a worker id is required' using errcode = '22023';
  end if;
  perform public.character_swap_sweep(null);
  select * into x from public.character_swap_jobs
   where status = 'running' and provider_task_id is not null and claimed_at < now() - interval '15 minutes'
     and submitted_at >= now() - interval '6 hours'
   order by claimed_at for update skip locked limit 1;
  if x.id is not null then
    resume := true;
    update public.character_swap_jobs set worker_id = w, claimed_at = now(), updated_at = now() where id = x.id returning * into x;
  else
    select * into x from public.character_swap_jobs where status = 'requested' order by created_at for update skip locked limit 1;
    if x.id is null then
      return null;
    end if;
    if x.credit_ref is not null and public.start_credit_reservation(x.credit_ref, x.org_id) is null then
      perform public.character_swap_end_locked(x.id, 'failed', 'hold_missing');
      return null;
    end if;
    if public.character_swap_input_problem(x.org_id, x.model_id, x.input_asset_id, x.reference_asset_ids) is not null then
      perform public.character_swap_end_locked(x.id, 'failed', 'input_unavailable');
      return null;
    end if;
    update public.character_swap_jobs set status = 'running', worker_id = w, claimed_at = now(), updated_at = now() where id = x.id
    returning * into x;
  end if;
  select * into a from public.media_assets where id = x.input_asset_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'mime', m.mime, 'bytes', m.bytes, 'width', m.width, 'height', m.height)
                            order by r.o), '[]'::jsonb)
    into refs
    from unnest(x.reference_asset_ids) with ordinality r(id, o) join public.media_assets m on m.id = r.id;
  return jsonb_build_object('job_id', x.id, 'org_id', x.org_id, 'project_id', x.project_id, 'model', x.model_id,
                            'resolution', x.resolution, 'prompt', x.prompt, 'credits', x.charge_credits, 'resume', resume,
                            'provider_task_id', x.provider_task_id,
                            'input', jsonb_build_object('id', a.id, 'mime', a.mime, 'bytes', a.bytes, 'width', a.width, 'height', a.height,
                                                        'duration_s', a.duration_s),
                            'references', refs,
                            'end_user', 'org-' || left(md5('character_swap:' || x.org_id::text), 24));
end
$$;

-- The vendor's task id, recorded BEFORE the worker polls (the provider_tasks rule: a crash then polls the paid task instead of paying
-- again). The first call records it; the same id again is the worker's heartbeat (claimed_at moves); another id is refused
-- (task_already_recorded): one job is one paid task.
create or replace function public.record_character_swap_task(p_job uuid, p_worker text, p_task text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w text := left(btrim(coalesce(p_worker, '')), 120);
  x public.character_swap_jobs;
begin
  if not public.credits_trusted_caller() then
    raise exception 'character swaps are run by the platform''s worker only' using errcode = '42501';
  end if;
  if p_task is null or p_task !~ '^[A-Za-z0-9_.:-]{1,200}$' then
    raise exception 'invalid_task_id' using errcode = 'NS400';
  end if;
  select * into x from public.character_swap_jobs where id = p_job for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if x.status <> 'running' or x.worker_id is distinct from w then
    raise exception 'this job belongs to another worker' using errcode = '42501';
  end if;
  if x.provider_task_id is not null and x.provider_task_id <> p_task then
    raise exception 'task_already_recorded' using errcode = 'NS409';
  end if;
  update public.character_swap_jobs
     set provider_task_id = p_task, submitted_at = coalesce(submitted_at, now()), claimed_at = now(), updated_at = now()
   where id = x.id;
  return jsonb_build_object('id', x.id, 'task', p_task, 'replayed', x.provider_task_id is not null);
end
$$;

-- The worker stored the result (service_role): the output must be a live video of THIS organization's library, stored as source
-- 'generated' with provenance origin 'character_swap' and this job's id (else invalid_output, nothing changes), and the job must have a
-- recorded vendor task. Then exactly the charge is captured (capture_credits releases the rest of the hold) and the job is ready.
-- Finishing twice returns the first answer.
create or replace function public.finish_character_swap(p_job uuid, p_worker text, p_output uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w       text := left(btrim(coalesce(p_worker, '')), 120);
  x       public.character_swap_jobs;
  charged numeric := 0;
begin
  if not public.credits_trusted_caller() then
    raise exception 'character swaps are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into x from public.character_swap_jobs where id = p_job for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if x.status in ('ready', 'failed', 'cancelled') then
    return jsonb_build_object('id', x.id, 'status', x.status, 'charged', x.charged_credits, 'replayed', true);
  end if;
  if x.status <> 'running' or x.worker_id is distinct from w then
    raise exception 'this job belongs to another worker' using errcode = '42501';
  end if;
  if x.provider_task_id is null then
    raise exception 'no_task_recorded' using errcode = 'NS409';
  end if;
  if not exists (select 1 from public.media_assets
                  where id = p_output and org_id = x.org_id and kind = 'video' and deleted_at is null and source = 'generated'
                    and provenance ->> 'origin' = 'character_swap' and provenance ->> 'job_id' = x.id::text) then
    raise exception 'invalid_output' using errcode = 'NS400';
  end if;
  if x.credit_ref is not null and exists (select 1 from public.credit_reservations where job_id = x.credit_ref) then
    -- 0 when the hold is no longer open (it expired): the job is still ready, and what was charged is what the ledger says.
    charged := coalesce(public.capture_credits(x.credit_ref, x.charge_credits, false), 0);
  end if;
  update public.character_swap_jobs
     set status = 'ready', output_asset_id = p_output, charged_credits = charged, finished_at = now(), updated_at = now()
   where id = x.id;
  return jsonb_build_object('id', x.id, 'status', 'ready', 'charged', charged, 'replayed', false);
end
$$;

-- The worker could not finish (service_role): the job fails with a closed code (anything else reads worker_error) and the hold is released.
-- Failing twice, or failing a final job, changes nothing.
create or replace function public.fail_character_swap(p_job uuid, p_worker text, p_code text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w text := left(btrim(coalesce(p_worker, '')), 120);
  x public.character_swap_jobs;
begin
  if not public.credits_trusted_caller() then
    raise exception 'character swaps are run by the platform''s worker only' using errcode = '42501';
  end if;
  select * into x from public.character_swap_jobs where id = p_job for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if x.status in ('ready', 'failed', 'cancelled') then
    return jsonb_build_object('id', x.id, 'status', x.status, 'error_code', x.error_code, 'replayed', true);
  end if;
  if x.status <> 'running' or x.worker_id is distinct from w then
    raise exception 'this job belongs to another worker' using errcode = '42501';
  end if;
  perform public.character_swap_end_locked(x.id, 'failed', p_code);
  select * into x from public.character_swap_jobs where id = p_job;
  return jsonb_build_object('id', x.id, 'status', x.status, 'error_code', x.error_code, 'replayed', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. RLS and grants: a member reads their organization's jobs and consents, anyone signed in reads the gallery; nobody writes through
--    the API
-- ───────────────────────────────────────────────────────────────────────────

alter table public.character_swap_models enable row level security;
alter table public.character_swap_settings enable row level security;
alter table public.character_swap_consents enable row level security;
alter table public.character_swap_jobs enable row level security;
alter table public.character_swap_templates enable row level security;
alter table public.character_swap_template_samples enable row level security;

revoke all on public.character_swap_models, public.character_swap_settings, public.character_swap_consents, public.character_swap_jobs,
              public.character_swap_templates, public.character_swap_template_samples
  from public, anon, authenticated, service_role;
grant select on public.character_swap_consents, public.character_swap_jobs, public.character_swap_templates,
                public.character_swap_template_samples to authenticated, service_role;
-- The samples script (tools/character_studio_samples.py) writes a sample row with the service key once the owner approved its paid call.
grant insert, update on public.character_swap_template_samples to service_role;

drop policy if exists character_swap_consents_select on public.character_swap_consents;
create policy character_swap_consents_select on public.character_swap_consents
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists character_swap_jobs_select on public.character_swap_jobs;
create policy character_swap_jobs_select on public.character_swap_jobs
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

drop policy if exists character_swap_templates_select on public.character_swap_templates;
create policy character_swap_templates_select on public.character_swap_templates
  for select to authenticated
  using (active);

drop policy if exists character_swap_template_samples_select on public.character_swap_template_samples;
create policy character_swap_template_samples_select on public.character_swap_template_samples
  for select to authenticated
  using (exists (select 1 from public.character_swap_templates t where t.id = template_id and t.active));

revoke all on function public.character_swap_prompt_patterns() from public, anon, authenticated, service_role;
revoke all on function public.character_swap_norm(text) from public, anon, authenticated, service_role;
revoke all on function public.character_swap_prompt_problem(text) from public, anon, authenticated, service_role;
revoke all on function public.character_swap_declarations_problem(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.character_swap_settings_guard() from public, anon, authenticated, service_role;
revoke all on function public.character_swap_settings_trail() from public, anon, authenticated, service_role;
revoke all on function public.character_swap_append_only() from public, anon, authenticated, service_role;
revoke all on function public.character_swap_charge(text, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.character_swap_hold(numeric) from public, anon, authenticated, service_role;
revoke all on function public.character_swap_input_problem(uuid, text, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.character_swap_end_locked(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.character_swap_sweep(uuid) from public, anon, authenticated, service_role;
revoke all on function public.quote_character_swap(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.record_character_swap_consent(uuid, text, uuid, uuid[], jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_character_swap(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_character_swap(text) from public, anon, authenticated, service_role;
revoke all on function public.record_character_swap_task(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_character_swap(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_character_swap(uuid, text, text) from public, anon, authenticated, service_role;

grant execute on function public.quote_character_swap(uuid, uuid, text) to authenticated;
grant execute on function public.record_character_swap_consent(uuid, text, uuid, uuid[], jsonb, text) to authenticated;
grant execute on function public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text) to authenticated;
grant execute on function public.cancel_character_swap(uuid) to authenticated;
grant execute on function public.claim_character_swap(text) to service_role;
grant execute on function public.record_character_swap_task(uuid, text, text) to service_role;
grant execute on function public.finish_character_swap(uuid, text, uuid) to service_role;
grant execute on function public.fail_character_swap(uuid, text, text) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. The end state, asserted inside the transaction
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  r         record;
  got       text;
  fn        oid;
  t         text;
  role_name text;
  priv      text;
begin
  for r in
    select * from (values
      ('public.character_swap_prompt_patterns()', '56d65ed5c0f40fe8cba6322ab1a008f6', ''),
      ('public.character_swap_norm(text)', '77daf6b06c31903d7749e128ea7d6e6c', ''),
      ('public.character_swap_prompt_problem(text)', 'f04a84afb9fb9e24163f55405d71de99', ''),
      ('public.character_swap_declarations_problem(jsonb)', '754abba4458f3102ec111ba6685e9e99', ''),
      ('public.character_swap_settings_guard()', 'a6d0eef455902fdeb530a2292d1f50b2', ''),
      ('public.character_swap_settings_trail()', 'ea80decbe4672917d765a966c2259c3a', ''),
      ('public.character_swap_append_only()', '304d7d15844f07c1cb5821dd473c22ff', ''),
      ('public.character_swap_charge(text, text, numeric)', 'a7fb5589674ddc84898810769d594c6f', ''),
      ('public.character_swap_hold(numeric)', '0c4cc9d1627fd3bf0a2bc07f348465c7', ''),
      ('public.character_swap_input_problem(uuid, text, uuid, uuid[])', '82bddbc3d809fdb5d886669634f017c9', ''),
      ('public.character_swap_end_locked(uuid, text, text)', '053cd01eb5919a57974f207459a3b0aa', ''),
      ('public.character_swap_sweep(uuid)', '8c9a1bc2f944692aebb21e9d2ae70b30', ''),
      ('public.quote_character_swap(uuid, uuid, text)', 'd08810be5286a526885183d2b7bfb030', 'authenticated'),
      ('public.record_character_swap_consent(uuid, text, uuid, uuid[], jsonb, text)', '228dfbc6e7c7d7005f83fd8f341f22ce', 'authenticated'),
      ('public.request_character_swap(uuid, uuid, uuid, uuid[], text, text, text, uuid, numeric, text)', '8b25050c082a66baf873ff871380ebc3', 'authenticated'),
      ('public.cancel_character_swap(uuid)', '2f4b3fdc5aea42e39dffa3f3f701b412', 'authenticated'),
      ('public.claim_character_swap(text)', '1645d8eec46cd4af9a4e00ca12d082e4', 'service_role'),
      ('public.record_character_swap_task(uuid, text, text)', 'a1238623579e2c1a8c2f9a8ae6536e4b', 'service_role'),
      ('public.finish_character_swap(uuid, text, uuid)', '552621b43552e9fc6992eb10a2bd1c3b', 'service_role'),
      ('public.fail_character_swap(uuid, text, text)', 'c094ba98581dc1e95ba17d364b5e1551', 'service_role')
    ) v(sig, want, grantee)
  loop
    fn := to_regprocedure(r.sig);
    if fn is null then
      raise exception '0137 end state: % does not exist', r.sig;
    end if;
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into got from pg_proc p where p.oid = fn;
    if got <> r.want then
      raise exception '0137 end state: % does not hold this file''s body (md5 %)', r.sig, got;
    end if;
    -- Exactly one API role, or none, may call it. A NULL ACL would mean "default privileges", and the default includes public.
    if exists (select 1 from pg_proc p
                where p.oid = fn
                  and (p.proacl is null
                       or exists (select 1 from aclexplode(p.proacl) a
                                   where a.grantee = 0
                                      or a.grantee in (select o.oid from pg_roles o
                                                        where o.rolname in ('anon', 'authenticated', 'service_role')
                                                          and o.rolname <> r.grantee)))) then
      raise exception '0137 end state: % is executable by a role that must not call it', r.sig;
    end if;
    if r.grantee <> '' and not has_function_privilege(r.grantee, fn, 'execute') then
      raise exception '0137 end state: % is not executable by %', r.sig, r.grantee;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = fn and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0137 end state: % has no pinned search_path', r.sig;
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('quote_character_swap', 'record_character_swap_consent', 'request_character_swap', 'cancel_character_swap',
                          'claim_character_swap', 'record_character_swap_task', 'finish_character_swap', 'fail_character_swap')) <> 8 then
    raise exception '0137 end state: a callable function has an overload';
  end if;

  foreach t in array array['character_swap_models', 'character_swap_settings', 'character_swap_consents', 'character_swap_jobs',
                           'character_swap_templates', 'character_swap_template_samples'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || t)::regclass and relrowsecurity) then
      raise exception '0137 end state: % has no row level security', t;
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
        if has_table_privilege(role_name, 'public.' || t, priv)
           and not (t = 'character_swap_template_samples' and role_name = 'service_role' and priv in ('insert', 'update')) then
          raise exception '0137 end state: % holds % on %', role_name, priv, t;
        end if;
      end loop;
    end loop;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception '0137 end state: anon reads %', t;
    end if;
    if t in ('character_swap_models', 'character_swap_settings') then
      if exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass)
         or has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('service_role', 'public.' || t, 'select') then
        raise exception '0137 end state: % is readable by an API role or has a policy', t;
      end if;
    elsif (select count(*) from pg_policy where polrelid = ('public.' || t)::regclass) <> 1
          or not exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass and polname = t || '_select' and polcmd = 'r'
                            and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]) then
      raise exception '0137 end state: % does not have exactly its one SELECT policy for authenticated', t;
    end if;
  end loop;

  if (select count(*) from public.character_swap_settings) <> 1 then
    raise exception '0137 end state: character_swap_settings does not hold exactly one row';
  end if;
  if (select count(*) from public.character_swap_models) <> 2 then
    raise exception '0137 end state: character_swap_models does not hold exactly its two models';
  end if;
  if (select count(*) from pg_constraint
       where contype = 'c' and convalidated
         and conname in ('character_swap_models_shape_check', 'character_swap_settings_one_row', 'character_swap_settings_numbers',
                         'character_swap_consents_shape_check', 'character_swap_jobs_shape_check', 'character_swap_templates_shape_check',
                         'character_swap_template_samples_shape_check')) <> 7 then
    raise exception '0137 end state: a check is missing or not validated';
  end if;
  if to_regclass('public.character_swap_jobs_one_in_flight') is null then
    raise exception '0137 end state: the one-job-in-flight index is missing';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal
        and (tgrelid, tgname) in (('public.character_swap_models'::regclass, 'character_swap_models_guard'),
                                  ('public.character_swap_models'::regclass, 'character_swap_models_no_truncate'),
                                  ('public.character_swap_models'::regclass, 'character_swap_models_trail'),
                                  ('public.character_swap_settings'::regclass, 'character_swap_settings_guard'),
                                  ('public.character_swap_settings'::regclass, 'character_swap_settings_no_truncate'),
                                  ('public.character_swap_settings'::regclass, 'character_swap_settings_trail'),
                                  ('public.character_swap_consents'::regclass, 'character_swap_consents_append_only'),
                                  ('public.character_swap_consents'::regclass, 'character_swap_consents_no_truncate'))) <> 8 then
    raise exception '0137 end state: a trigger is missing';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.character_swap_consents'::regclass and not tgisinternal and tgenabled <> 'A') then
    raise exception '0137 end state: the consent trail''s triggers are not ENABLE ALWAYS';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (the SQL editor, after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select bool_and(credits_per_usd is null) from public.character_swap_models) as nothing_on_sale_until_the_owner_sets_a_price,
--     (select org_daily_jobs = 10 and platform_daily_jobs = 200 and platform_in_flight = 20 from public.character_swap_settings)
--       as default_caps_if_untouched,
--     has_function_privilege('authenticated', 'public.request_character_swap(uuid,uuid,uuid,uuid[],text,text,text,uuid,numeric,text)', 'EXECUTE')
--       and not has_function_privilege('anon', 'public.request_character_swap(uuid,uuid,uuid,uuid[],text,text,text,uuid,numeric,text)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.finish_character_swap(uuid,text,uuid)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.finish_character_swap(uuid,text,uuid)', 'EXECUTE') as grants,
--     not has_table_privilege('authenticated', 'public.character_swap_models', 'SELECT') as prices_closed;
-- Put a model on sale (the owner's decision, AFTER the vendor's written answer: docs/CHARACTER_STUDIO.md, "Unlocking a model"):
--   update public.character_swap_models set credits_per_usd = <credits per USD of vendor cost> where model_id = 'kling-4.0-omni-edit';
