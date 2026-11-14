-- 0174_rights_acknowledgement.sql — a recorded, server-enforced "I take responsibility" step in front of the models whose
-- provider (or the law) makes the person confirm their rights to an input before it is sent.
--
-- EVIDENCE:
--   * Runway's Terms of Use §4.2 (schemas/model_registry.json, terms_notes of runway-gen4.5 and runway-gen4-turbo, read
--     2026-11-13): no photograph of another person without that person's permission; "before a sale the i2v upload needs a
--     photo-consent confirmation in the UI". Both models are held back from sale until that confirmation exists.
--   * Our own Terms §6.2 (command-center/lib/legal-docs/*.ts, "acceptable-use"): no realistic image, video or voice of a real,
--     identifiable person without that person's explicit consent, and nothing that infringes copyright.
--   * Voice cloning (0117, docs/CUSTOM_VOICE.md) already records five declarations of its own. A third-party restriction of the
--     same shape had no generic place to live.
--
-- DIAGNOSIS: nothing in the job start path (create_creative_job, 0075) knows that a model needs the person's confirmation, so the
--   only way to keep such a model honest was to keep it hidden. A checkbox in a browser would not change that (CLAUDE.md rule 3:
--   the browser never decides): the database has to refuse the job itself, before anything is held (rule 6).
--
-- CHANGE (additive; four function bodies replaced, each with marked hunks):
--   rights_acknowledgement_kinds   the closed list of kinds and the CURRENT text version of each. Seeded:
--       likeness_photo       a real person's face in an uploaded image or video       likeness_photo.v1
--       voice_clone          a real person's voice                                     voice_clone.v1
--       third_party_content  copyrighted material the person owns or licensed          third_party_content.v1
--     The words of each version live in command-center/lib/i18n/rights-acknowledgement/{en,ru,uz}.ts; a change of the words is a
--     new version here (a later migration), and every acknowledgement of the old version stops counting.
--   rights_acknowledgements        append-only: who (auth.uid()), in which organization, acknowledged which kind, at which text
--     version, in which language the words were read (en / ru / uz), for which input (the media asset's id, and its sha256 as it
--     was then). Written ONLY by acknowledge_rights(); no API role (the service key included) inserts, updates or deletes; a
--     trigger refuses UPDATE, DELETE and TRUNCATE even for the owner. Members of the organization read its rows (RLS).
--   model_registry.requires_acknowledgement text[] (default empty): the kinds a model requires. Seeded {likeness_photo} on
--     runway-gen4.5 and runway-gen4-turbo, and nothing else: their availability is NOT changed here (both stay as they are,
--     unsold). The registry file carries the same list (spec.requires_acknowledgement). A model requires the UNION of the two.
--     The column only grows: model_registry_requirement_guard copies every known kind the spec names into it (a sync that later
--     drops the kind from the spec leaves the column as it was), and refuses an UPDATE that would remove a kind for every role
--     but the table's owner (the service key holds a table-level UPDATE on model_registry since 0035). Removing a requirement is
--     a migration's act. A spec value that is not an array, a string or null, or names a kind outside the list, fails closed:
--     the model then requires a kind nobody can acknowledge.
--   acknowledge_rights(kind, text_version, subject, locale)   the only write path (authenticated). Refuses an unknown kind or
--     language, a version that is not the current one (NS409 acknowledgement_version_changed, current=…), a subject that is not
--     a live asset of an organization the caller belongs to (source_unavailable, exactly as for a missing id), and more than 60
--     new acknowledgements by one person in an hour (NS429 acknowledgement_limit: the table cannot be cleaned up, so it cannot
--     be flooded either). A replay answers the first row and counts nothing.
--   rights_acknowledgement_status(org, model, subjects)   which (kind, subject) pairs THIS person has not acknowledged yet.
--   rights_acknowledgement_required(model), rights_acknowledgement_missing(org, user, model, params),
--     model_registry_requirement_guard()   internal.
--   create_creative_job (0075's body, two marked hunks): after the price is computed (a model refused anyway never asks) and
--     BEFORE the price ceiling, the hold and the job row, a model that requires a kind refuses NS400 'acknowledgement_required'
--     (detail: kind=… version=… subject=…) when an input it is given (params.source_asset_id, params.end_asset_id — every media
--     input creative_params_problem accepts, 0156) has no acknowledgement of that kind, by THIS person, in THIS organization, at
--     the CURRENT text version. Nothing is held and no job row is written. An idempotent replay of a job already made is answered
--     before the check.
--   workflow_quote_steps and start_workflow_run (0073's bodies, one marked hunk each): a workflow step whose model requires an
--     acknowledgement and that takes a media input is refused when the workflow is quoted and when it is started, before
--     anything is held (NS400 acknowledgement_required). A step's input made by an earlier step does not exist yet, and a later
--     step may run in another member's session (advance_workflow_run): neither can be acknowledged in advance. Such a model is
--     used from the Studio.
--   api_creative_refusal (0124's body, one marked hunk): the public API answers acknowledgement_required (428) with the remedy
--     (confirm in the Studio); there is no API call to acknowledge.
--
-- WHICH PATHS ARE COVERED. Every creative_jobs row is written by create_creative_job (0036 to 0170): the Studio, the public API
--   (api_creative_create), the MCP server (through the API), region edit, and each workflow step. Workflows are also refused at
--   quote and start (above). NOT covered here: the Film Studio's job path (0171, an open pull request), which Atlas handles in a
--   follow-up.
--
-- REPLACES (md5 drift guard: the earlier body, or this file's own on a replay; whitespace runs read as one space):
--   create_creative_job (0075), workflow_quote_steps and start_workflow_run (0073), api_creative_refusal (0124); none redefined
--   since. Signatures, SECURITY DEFINER (or not), the pinned search_path and the grants stay as they were (restated below).
-- NOT CHANGED: creative_price, quote_creative_job (a quote holds nothing, so it does not ask), sellable_models, route_model,
--   sync_model_registry, every price, hold and ledger rule, every model's availability.
--
-- REPLAY. This file replays safely onto itself (drift guards accept its own bodies; tables if not exists; seed on conflict do
--   nothing). The EARLIER files do NOT protect it: 0075's guard is a position() check that 0174's create_creative_job also
--   passes, and 0073 has no guard. Re-running 0075 or 0073 after this file SILENTLY puts the old body back and removes the gate.
--   Undo 0174 first (its rollback), re-run the older file, then apply 0174 again; and after any manual replay run the Verify
--   query below: its first column reads false when the gate is gone.
--
-- NUMBER. 0174: main is at 0170; 0171, 0172 and 0173 are held by open pull requests. This file names nothing of them, but it
--   auto-applies to the live database on merge, so it merges after them. Needs 0018, 0035, 0036, 0038, 0073, 0075 and 0124.
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select p.oid::regprocedure, md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc p
--    where p.oid in ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)'::regprocedure,
--                    'public.workflow_quote_steps(public.workflows, jsonb)'::regprocedure,
--                    'public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)'::regprocedure,
--                    'public.api_creative_refusal(text, text, text)'::regprocedure);
--   expected BEFORE create_creative_job 4c74918fd9d938c8fe4f5a3d26a09d84 (0075), workflow_quote_steps 48250650e93a951c6b64cad1e73e8a24 (0073),
--     start_workflow_run c60ad7a487f7f11bf080ef92629c436e (0073), api_creative_refusal 2253296a9c1ac2e5de3c25a2a726398e (0124);
--   AFTER 88107b00b0a8c143606ed17f5898c98d, 8f9f42da9844571a18a285d87bcffc84, 8b3c4b4afbc19e6f336c09b4692ad7ed, e6ec45d0d912389a05eb2d40261c2c2a (this file).
-- Undo: docs/sql/rollback_0174_rights_acknowledgement.sql (owner-applied). It puts the four earlier bodies back and drops the
--   acknowledgement functions, the requirement guard and its trigger. It KEEPS the record: rights_acknowledgements (with its
--   append-only triggers), rights_acknowledgement_kinds and model_registry.requires_acknowledgement stay, and applying 0174
--   again picks them up as its own.

-- APPLY AS ONE TRANSACTION (the Supabase SQL editor, apply_migration, or psql --single-transaction -v ON_ERROR_STOP=1).
set local lock_timeout = '5s';

do $$
declare
  r record;
  h text;
begin
  if to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.accessible_org_ids(text)') is null then
    raise exception '0174 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.model_registry') is null then
    raise exception '0174 needs the model registry: apply 0035_model_registry.sql first';
  end if;
  if to_regprocedure('public.creative_refuse(text, text, text)') is null or to_regclass('public.creative_jobs') is null then
    raise exception '0174 needs the creative jobs: apply 0036_creative_jobs.sql first';
  end if;
  if to_regclass('public.media_assets') is null then
    raise exception '0174 needs 0038_media_assets.sql: apply it first';
  end if;
  if to_regclass('public.workflows') is null then
    raise exception '0174 needs 0073_workflow_apps.sql: apply it first';
  end if;
  -- The four bodies this file replaces: the earlier one, or this file's own (a replay).
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '4c74918fd9d938c8fe4f5a3d26a09d84', '88107b00b0a8c143606ed17f5898c98d', '0075'),
      ('public.workflow_quote_steps(public.workflows, jsonb)', '48250650e93a951c6b64cad1e73e8a24', '8f9f42da9844571a18a285d87bcffc84', '0073'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', 'c60ad7a487f7f11bf080ef92629c436e', '8b3c4b4afbc19e6f336c09b4692ad7ed', '0073'),
      ('public.api_creative_refusal(text, text, text)', '2253296a9c1ac2e5de3c25a2a726398e', 'e6ec45d0d912389a05eb2d40261c2c2a', '0124')) v(sig, was, now_, src) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is null or h <> all (array[r.was, r.now_]) then
      raise exception '0174 found % with a body that is neither %''s nor 0174''s (md5 %): read the live body first', r.sig, r.src, h;
    end if;
  end loop;
  -- The tables this file creates: absent, or this file's own.
  for r in select * from (values ('rights_acknowledgement_kinds', 'text_version'), ('rights_acknowledgements', 'locale')) v(t, c) loop
    if to_regclass('public.' || r.t) is not null
       and not exists (select 1 from information_schema.columns
                        where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception '0174 found a table public.% that is not this file''s (no column %): read it first', r.t, r.c;
    end if;
  end loop;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.rights_acknowledgements_append_only()', 'e885c3b71a6af4724016c12554ed728e'),
      ('public.model_registry_requirement_guard()', '598b4f2353046b4851abeb3b82090a2b'),
      ('public.rights_acknowledgement_required(text)', '5b27521f352a65bfebba335f584152de'),
      ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)', '426ea90d162535b0ee6f10e752e5fe26'),
      ('public.acknowledge_rights(text, text, text, text)', '45f3e5ffdf69999f290363a55e81c303'),
      ('public.rights_acknowledgement_status(uuid, text, text[])', 'd33d9861c2a2e5efca2614aabec3f311')) v(sig, want) loop
    select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p where p.oid = to_regprocedure(r.sig);
    if h is not null and h <> r.want then
      raise exception '0174 found % with a body that is not this file''s (md5 %): read the live body first', r.sig, h;
    end if;
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The kinds and their current text version
-- ───────────────────────────────────────────────────────────────────────────

-- One row per kind. The list is closed (the CHECK): a kind is a promise that the words exist in en, ru and uz and that a
-- provider restriction maps to it (docs/RIGHTS_ACKNOWLEDGEMENT.md). The version names the words, not a date: the app shows the
-- words of the version it has, and an acknowledgement counts only at the version this table names now.
create table if not exists public.rights_acknowledgement_kinds (
  kind         text primary key,
  text_version text not null,
  updated_at   timestamptz not null default now(),
  constraint rights_acknowledgement_kinds_kind_check
    check (kind in ('likeness_photo', 'voice_clone', 'third_party_content')),
  -- '<kind>.v<n>': a version can never be read as another kind's.
  constraint rights_acknowledgement_kinds_version_check
    check (text_version ~ '^[a-z_]{3,40}\.v[0-9]{1,4}$' and split_part(text_version, '.', 1) = kind)
);

comment on table public.rights_acknowledgement_kinds is
  'Rights acknowledgement kinds and the current text version of each (migration 0174). A new version of the words is a new row value here; acknowledgements of an older version stop counting.';

insert into public.rights_acknowledgement_kinds (kind, text_version) values
  ('likeness_photo', 'likeness_photo.v1'),
  ('voice_clone', 'voice_clone.v1'),
  ('third_party_content', 'third_party_content.v1')
on conflict (kind) do nothing;

alter table public.rights_acknowledgement_kinds enable row level security;
revoke all on public.rights_acknowledgement_kinds from public, anon, authenticated, service_role;
grant select on public.rights_acknowledgement_kinds to authenticated, service_role;
drop policy if exists rights_acknowledgement_kinds_select on public.rights_acknowledgement_kinds;
create policy rights_acknowledgement_kinds_select on public.rights_acknowledgement_kinds
  for select to authenticated using (true);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The acknowledgements (append-only)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.rights_acknowledgements (
  id               bigint generated always as identity primary key,
  -- No delete cascade: the record of who took responsibility must outlive a cleanup.
  org_id           uuid not null references public.organizations (id) on delete restrict,
  -- auth.uid() of the person, as acknowledge_rights() read it. No foreign key: the record outlives the account.
  user_id          uuid not null,
  kind             text not null references public.rights_acknowledgement_kinds (kind) on delete restrict,
  text_version     text not null,
  -- The language the words were read in: the same version is three texts, and the record says which one this person saw.
  locale           text not null,
  -- The subject: the media asset the person acknowledged, and its sha256 as it was then (the bytes they saw).
  subject_asset_id uuid not null,
  subject_sha256   text not null,
  created_at       timestamptz not null default now(),
  constraint rights_acknowledgements_version_check
    check (text_version ~ '^[a-z_]{3,40}\.v[0-9]{1,4}$' and split_part(text_version, '.', 1) = kind),
  constraint rights_acknowledgements_locale_check check (locale in ('en', 'ru', 'uz')),
  constraint rights_acknowledgements_sha256_check check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  -- One row per person, organization, kind, version and subject: a replay writes nothing new.
  constraint rights_acknowledgements_once unique (org_id, user_id, kind, text_version, subject_asset_id)
);

comment on table public.rights_acknowledgements is
  'Who acknowledged their rights to which input, under which text version and in which language (migration 0174). Append-only; written only by acknowledge_rights(); read by the members of the organization.';

-- The rate limit counts one person's newest rows.
create index if not exists rights_acknowledgements_user_recent on public.rights_acknowledgements (user_id, created_at desc);

create or replace function public.rights_acknowledgements_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'rights_acknowledgements is append-only' using errcode = '42501';
end
$$;

drop trigger if exists rights_acknowledgements_append_only on public.rights_acknowledgements;
create trigger rights_acknowledgements_append_only
  before update or delete on public.rights_acknowledgements
  for each row execute function public.rights_acknowledgements_append_only();

drop trigger if exists rights_acknowledgements_no_truncate on public.rights_acknowledgements;
create trigger rights_acknowledgements_no_truncate
  before truncate on public.rights_acknowledgements
  for each statement execute function public.rights_acknowledgements_append_only();

alter table public.rights_acknowledgements enable row level security;
revoke all on public.rights_acknowledgements from public, anon, authenticated, service_role;
grant select on public.rights_acknowledgements to authenticated, service_role;
revoke all on sequence public.rights_acknowledgements_id_seq from public, anon, authenticated, service_role;
drop policy if exists rights_acknowledgements_select on public.rights_acknowledgements;
create policy rights_acknowledgements_select on public.rights_acknowledgements
  for select to authenticated
  using (org_id in (select public.accessible_org_ids('viewer')));

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Which kinds a model requires
-- ───────────────────────────────────────────────────────────────────────────

alter table public.model_registry add column if not exists requires_acknowledgement text[] not null default '{}'::text[];
alter table public.model_registry drop constraint if exists model_registry_requires_acknowledgement_check;
alter table public.model_registry add constraint model_registry_requires_acknowledgement_check
  check (cardinality(requires_acknowledgement) <= 3
         and requires_acknowledgement <@ array['likeness_photo', 'voice_clone', 'third_party_content']::text[]);
comment on column public.model_registry.requires_acknowledgement is
  'The rights acknowledgement kinds a job of this model needs for each input (0174). Only grows (model_registry_requirement_guard); a model requires these AND spec.requires_acknowledgement.';

-- The column only grows. NOT security definer on purpose: current_user is the caller (or the owner of the definer function that
-- calls it), so the service key's table-level UPDATE cannot remove a kind, while a migration (the table's owner) can.
-- sync_model_registry never sets this column, so a sync keeps it as it was and only adds what the spec names.
create or replace function public.model_registry_requirement_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  from_spec text[] := '{}';
begin
  if jsonb_typeof(new.spec -> 'requires_acknowledgement') = 'array' then
    from_spec := array(select jsonb_array_elements_text(new.spec -> 'requires_acknowledgement'));
  elsif jsonb_typeof(new.spec -> 'requires_acknowledgement') = 'string' then
    from_spec := array[new.spec ->> 'requires_acknowledgement'];
  end if;
  -- Only the spec's KNOWN kinds are copied (one unknown kind would fail the column's CHECK and with it the whole sync); an unknown
  -- one stays in the spec, where rights_acknowledgement_required reads it and fails closed. What is written to the column itself
  -- is kept as written, so its CHECK still refuses an unknown kind there.
  new.requires_acknowledgement := array(
    select distinct k from unnest(coalesce(new.requires_acknowledgement, '{}')
                                  || array(select s from unnest(from_spec) s
                                            where s in ('likeness_photo', 'voice_clone', 'third_party_content'))) k
     order by 1);
  if tg_op = 'UPDATE' and not (coalesce(old.requires_acknowledgement, '{}') <@ new.requires_acknowledgement)
     and current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    raise exception 'requires_acknowledgement only grows' using errcode = '42501',
      detail = 'removing a rights acknowledgement requirement is a migration''s act';
  end if;
  return new;
end
$$;

drop trigger if exists model_registry_requirement_guard on public.model_registry;
create trigger model_registry_requirement_guard
  before insert or update on public.model_registry
  for each row execute function public.model_registry_requirement_guard();

-- Runway's Terms §4.2 (photo consent on an image-to-video upload). Their availability is not touched: both stay unsold.
update public.model_registry
   set requires_acknowledgement = array(select distinct k from unnest(requires_acknowledgement || array['likeness_photo']) k order by 1)
 where id in ('runway-gen4.5', 'runway-gen4-turbo')
   and not ('likeness_photo' = any (requires_acknowledgement));

-- The union of the column and the registry file's list. An unknown model requires nothing here: creative_price refuses it.
-- Fails closed: a kind outside the closed list stays in the answer, and a spec value of any other shape (a number, an object, a
-- boolean) reads as the kind 'invalid_requires_acknowledgement'. Neither has a text version, so neither can ever be
-- acknowledged, and the model refuses every input instead of asking nothing.
create or replace function public.rights_acknowledgement_required(p_model text) returns text[]
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  m public.model_registry;
  from_spec text[] := '{}';
begin
  select * into m from public.model_registry where id = lower(btrim(coalesce(p_model, '')));
  if not found then
    return '{}'::text[];
  end if;
  case coalesce(jsonb_typeof(m.spec -> 'requires_acknowledgement'), 'null')
    when 'array' then
      from_spec := array(select case when jsonb_typeof(e) = 'string' then e #>> '{}' else 'invalid_requires_acknowledgement' end
                           from jsonb_array_elements(m.spec -> 'requires_acknowledgement') e);
    when 'string' then
      from_spec := array[m.spec ->> 'requires_acknowledgement'];
    when 'null' then
      from_spec := '{}';
    else
      from_spec := array['invalid_requires_acknowledgement'];
  end case;
  return array(select distinct coalesce(nullif(btrim(k), ''), 'invalid_requires_acknowledgement')
                 from unnest(coalesce(m.requires_acknowledgement, '{}') || from_spec) k order by 1);
end
$$;

-- The first (kind, subject) of a job that this person has not acknowledged at the current version, or NULL. The subjects are the
-- media inputs a generation takes (creative_params_problem, 0156: source_asset_id and end_asset_id); a later input key must be
-- added here too (tests/test_rights_acknowledgement_migration.py reads the latest creative_params_problem for it). An input that
-- is not a uuid counts as not acknowledged: nothing is guessed.
create or replace function public.rights_acknowledgement_missing(p_org uuid, p_user uuid, p_model text, p_params jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  kinds text[] := public.rights_acknowledgement_required(p_model);
  k     text;
  v     text;
  s     text;
begin
  if cardinality(kinds) = 0 then
    return null;
  end if;
  foreach k in array kinds loop
    select text_version into v from public.rights_acknowledgement_kinds where kind = k;
    for s in select x from (values (1, case when jsonb_typeof(p_params) = 'object' then p_params ->> 'source_asset_id' end),
                                   (2, case when jsonb_typeof(p_params) = 'object' then p_params ->> 'end_asset_id' end)) t(n, x)
              where x is not null order by n loop
      if v is null
         or s !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from public.rights_acknowledgements a
                         where a.org_id = p_org and a.user_id = p_user and a.kind = k
                           and a.text_version = v and a.subject_asset_id = s::uuid) then
        return jsonb_build_object('kind', k, 'text_version', v, 'subject', s);
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The two calls the app makes
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.acknowledge_rights(p_kind text, p_text_version text, p_subject text, p_locale text)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  k      public.rights_acknowledgement_kinds;
  s      text := btrim(coalesce(p_subject, ''));
  a      public.media_assets;
  row_   public.rights_acknowledgements;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into k from public.rights_acknowledgement_kinds where kind = lower(btrim(coalesce(p_kind, '')));
  if not found then
    perform public.creative_refuse('invalid_params', 'kind must be likeness_photo, voice_clone or third_party_content');
  end if;
  if p_locale is null or p_locale not in ('en', 'ru', 'uz') then
    perform public.creative_refuse('invalid_params', 'locale must be en, ru or uz: the language the words were read in');
  end if;
  -- The words the person read are the words of the version they send: an older (or unknown) one is refused, and the app asks again.
  if p_text_version is distinct from k.text_version then
    perform public.creative_refuse('acknowledgement_version_changed', format('current=%s', k.text_version), 'NS409');
  end if;
  if s !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform public.creative_refuse('source_unavailable', 'subject names no file in your organization''s library');
  end if;
  select * into a from public.media_assets where id = s::uuid and deleted_at is null and purged_at is null;
  -- Another organization's file reads exactly like one that does not exist.
  if not found or not public.is_org_member(a.org_id) then
    perform public.creative_refuse('source_unavailable', 'subject names no file in your organization''s library');
  end if;
  -- One person at a time, so the count below cannot be raced past.
  perform pg_advisory_xact_lock(hashtextextended('rights_ack:' || uid::text, 0));
  select * into row_ from public.rights_acknowledgements
   where org_id = a.org_id and user_id = uid and kind = k.kind and text_version = k.text_version and subject_asset_id = a.id;
  if found then
    return jsonb_build_object('acknowledgement',
             jsonb_build_object('kind', row_.kind, 'text_version', row_.text_version, 'subject', row_.subject_asset_id,
                                'locale', row_.locale, 'created_at', row_.created_at),
             'replay', true);
  end if;
  -- The table cannot be cleaned up, so it may not be flooded: 60 new rows a person an hour (a dialog writes one per file).
  if (select count(*) from public.rights_acknowledgements
       where user_id = uid and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'acknowledgement_limit' using errcode = 'NS429', detail = 'limit=60 window=1h';
  end if;
  insert into public.rights_acknowledgements (org_id, user_id, kind, text_version, locale, subject_asset_id, subject_sha256)
  values (a.org_id, uid, k.kind, k.text_version, p_locale, a.id, a.sha256)
  returning * into row_;
  return jsonb_build_object('acknowledgement',
           jsonb_build_object('kind', row_.kind, 'text_version', row_.text_version, 'subject', row_.subject_asset_id,
                              'locale', row_.locale, 'created_at', row_.created_at),
           'replay', false);
end
$$;

create or replace function public.rights_acknowledgement_status(p_org uuid, p_model text, p_subjects text[]) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  kinds   text[];
  k       text;
  v       text;
  s       text;
  req     jsonb := '[]'::jsonb;
  missing jsonb := '[]'::jsonb;
begin
  if uid is null or p_org is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(coalesce(p_subjects, '{}')) > 4 then
    perform public.creative_refuse('invalid_params', 'at most 4 subjects');
  end if;
  kinds := public.rights_acknowledgement_required(p_model);
  foreach k in array kinds loop
    select text_version into v from public.rights_acknowledgement_kinds where kind = k;
    req := req || jsonb_build_array(jsonb_build_object('kind', k, 'text_version', v));
    foreach s in array coalesce(p_subjects, '{}') loop
      if v is null
         or s !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from public.rights_acknowledgements a
                         where a.org_id = p_org and a.user_id = uid and a.kind = k
                           and a.text_version = v and a.subject_asset_id = s::uuid) then
        missing := missing || jsonb_build_array(jsonb_build_object('kind', k, 'text_version', v, 'subject', s));
      end if;
    end loop;
  end loop;
  return jsonb_build_object('required', req, 'missing', missing);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The job start path: 0075's create_creative_job, two marked hunks
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.create_creative_job(
  p_org uuid,
  p_capability text,
  p_model text,
  p_params jsonb default '{}'::jsonb,
  p_mode text default 'exact',
  p_idempotency_key text default null,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid   uuid := auth.uid();
  md    text := lower(btrim(coalesce(p_mode, 'exact')));
  idem  text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  hash_ text;
  prior public.creative_jobs;
  q     jsonb;
  price numeric;
  jid   uuid := gen_random_uuid();
  ref   text;
  res   jsonb;
  j     public.creative_jobs;
  jparams jsonb;
  -- 0075: the router's pick and the surface it was made for.
  surf  text;
  rt    jsonb;
  -- 0174: the first input this person has not acknowledged, for a model that requires an acknowledgement.
  ack   jsonb;
begin
  if uid is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The exempt organization's generations are paid by the platform itself,
  -- and every account that existed before 0018 is a member of it: only a
  -- platform owner/admin may spend there (reserve_credits asks for its admins
  -- too, before answering exempt).
  if public.credits_exempt(p_org) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'generations in the operator''s organization are started by a platform admin';
  end if;
  if md not in ('exact', 'auto', 'cheap', 'fast', 'quality') then
    perform public.creative_refuse('invalid_params', 'mode must be exact, auto, cheap, fast or quality');
  end if;
  -- Router modes need route_model() and failover, which are not built yet: a
  -- job only ever runs the model the person picked.
  -- 0075: they are built (route_model): this refusal now stands only for a
  -- database without the router.
  if md <> 'exact' and to_regprocedure('public.route_model(text, jsonb, text, uuid, text)') is null then
    perform public.creative_refuse('mode_not_supported',
      'only exact mode (the model you picked) is available on this deployment');
  end if;
  if idem is not null and idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    perform public.creative_refuse('invalid_idempotency_key',
      'idempotency key: 1-255 characters of A-Z a-z 0-9 _ : . -');
  end if;

  -- The org's credit account, locked for the rest of this transaction: every
  -- create (and reserve_credits itself) for this org queues behind it, so two
  -- concurrent creates cannot both spend the same available credits, and a
  -- replay of the same idempotency key finds the first one's committed row.
  perform public.credit_account_lock(p_org);

  hash_ := md5(jsonb_build_object('capability', lower(btrim(coalesce(p_capability, ''))),
                                  'model', lower(btrim(coalesce(p_model, ''))),
                                  'mode', md, 'params', coalesce(p_params, 'null'::jsonb))::text);
  if idem is not null then
    select * into prior from public.creative_jobs
     where org_id = p_org and idempotency_key = idem;
    if found then
      if prior.request_hash is distinct from hash_ then
        perform public.creative_refuse('idempotency_conflict',
          'this idempotency key was used for a different request', 'NS409');
      end if;
      return jsonb_build_object('job', public.creative_job_json(prior), 'replay', true);
    end if;
  end if;

  -- Holds of this org's jobs that nobody will run give their credits back
  -- before this one is checked against the balance.
  perform public.creative_expire_locked(p_org);

  -- 0075: a routed job (auto / cheap / fast / quality) runs the model its quote
  -- named, at the price it showed, and nothing else. Both come back with the
  -- press; the router is asked again here, under the account lock, and a
  -- different pick (a price, a probe or a plan changed since the quote) is
  -- refused for a new quote, never run in its place. The surface is the web
  -- unless api_creative_create said otherwise for this transaction (it can
  -- only narrow the list: the API sells a subset of the web's models).
  if md <> 'exact' then
    if nullif(btrim(coalesce(p_model, '')), '') is null or p_max_credits is null then
      perform public.creative_refuse('invalid_params',
        'a routed job names the model and the price its quote showed: quote first, then confirm both');
    end if;
    surf := coalesce(nullif(current_setting('nightshift.creative_surface', true), ''), 'web');
    if surf not in ('web', 'api', 'mcp') then
      surf := 'web';
    end if;
    rt := public.route_model(p_capability, p_params, md, p_org, surf);
    if (rt ->> 'model') is distinct from lower(btrim(p_model)) then
      perform public.creative_refuse('route_changed',
        'the automatic choice changed since the quote; quote again and confirm the new choice', 'NS409');
    end if;
  end if;

  q := public.creative_price(p_org, p_capability, p_model, p_params);
  price := (q ->> 'credits')::numeric;
  -- 0174: a model whose provider (or the law) makes the person confirm their rights to an input refuses here: after the
  -- price (a model refused anyway never asks) and before the ceiling, the hold and the job row, unless THIS person
  -- acknowledged THIS input in THIS organization at the CURRENT text version (rights_acknowledgement_missing). A replay of
  -- a job already created was answered above.
  ack := public.rights_acknowledgement_missing(p_org, uid, q ->> 'model', p_params);
  if ack is not null then
    perform public.creative_refuse('acknowledgement_required',
      format('kind=%s version=%s subject=%s', ack ->> 'kind', coalesce(ack ->> 'text_version', 'none'), ack ->> 'subject'));
  end if;
  if p_max_credits is not null and price > p_max_credits then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', price, p_max_credits), 'NS409');
  end if;

  -- The tier the quote priced is the tier the job carries (0060): stored in
  -- the job's params so the worker sends EXACTLY it and never a default of its
  -- own. Absent from the request = the quote's default, written down here.
  jparams := p_params;
  if q ? 'quality' then
    jparams := coalesce(p_params, '{}'::jsonb) || jsonb_build_object('quality', q ->> 'quality');
  end if;
  -- Likewise the resolution and soundtrack of a video (0070): written down as
  -- priced, so the worker sends exactly them and never a default of its own.
  if q ? 'resolution' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('resolution', q ->> 'resolution');
  end if;
  if q ? 'audio' then
    jparams := coalesce(jparams, '{}'::jsonb) || jsonb_build_object('audio', (q ->> 'audio')::boolean);
  end if;

  ref := 'cj:' || jid::text;
  if price > 0 then
    -- NS402 'insufficient credits' (available=… needed=…) comes from here.
    res := public.creative_platform_reserve(p_org, ref, price);
    if coalesce((res ->> 'exempt')::boolean, false) then
      ref := null;
    end if;
  else
    ref := null;
  end if;

  insert into public.creative_jobs
    (id, org_id, kind, capability, mode, requested_model, routed_model, params, status,
     payer, credit_ref, credit_unit, quantity, quoted_credits, idempotency_key, request_hash,
     requested_by, expires_at)
  values
    (jid, p_org, 'generate', q ->> 'capability', md, q ->> 'model', q ->> 'model',
     jparams, 'queued', 'credits', ref, q ->> 'unit', (q ->> 'quantity')::numeric, price,
     idem, hash_, uid, now() + interval '2 hours')
  returning * into j;
  -- 0075: what the router decided, written by this function only. The
  -- hold is the pick's price, like exact (BR-L-020): max_credits only
  -- refused a higher one. Members read the reason; the candidates are
  -- the platform's (creative_job_routes, BR-L-022).
  if md <> 'exact' then
    update public.creative_jobs
       set routed_credits = price,
           routing = jsonb_build_object('reason', rt ->> 'reason', 'surface', surf)
     where id = jid
    returning * into j;
    insert into public.creative_job_routes (job_id, quality_tier, candidates, tried)
    values (jid, coalesce((rt ->> 'quality_tier')::numeric, 0), coalesce(rt -> 'candidates', '[]'::jsonb),
            jsonb_build_array(rt ->> 'model'));
    perform public.creative_job_log(jid, p_org, 'routed', 'queued',
      jsonb_build_object('mode', md, 'model', rt ->> 'model', 'reason', rt ->> 'reason',
                         'credits', price));
  end if;
  perform public.creative_job_log(jid, p_org, 'created', 'queued',
    jsonb_build_object('quoted_credits', price, 'held', ref is not null));

  return jsonb_build_object('job', public.creative_job_json(j), 'replay', false);
end
$$;
revoke all on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) from public, anon, authenticated, service_role;
grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Workflows: 0073's workflow_quote_steps and start_workflow_run, one marked hunk each
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.workflow_quote_steps(p_wf public.workflows, p_values jsonb)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  st      record;
  params  jsonb;
  stand   text;
  q       jsonb;
  steps_  jsonb := '[]'::jsonb;
  total   numeric := 0;
  bad     integer[] := '{}';
  chained boolean;
  acc     public.credit_accounts;
begin
  for st in select v, ord from jsonb_array_elements(p_wf.steps) with ordinality as t(v, ord) loop
    chained := exists (select 1 from jsonb_each(st.v -> 'params') e
                        where jsonb_typeof(e.value) = 'object' and e.value ? '$step');
    stand := null;
    if chained then
      select a.id::text into stand
        from public.media_assets a
       where a.org_id = p_wf.org_id and a.kind = 'image'
         and a.deleted_at is null and a.purged_at is null
         and public.creative_picture_problem(p_wf.org_id, a.id, 'source_asset_id') is null
       order by a.created_at desc, a.id
       limit 1;
    end if;
    params := public.workflow_fill_params(st.v -> 'params', p_values, stand);
    begin
      if chained and stand is null then
        raise exception 'source_unavailable' using errcode = 'NS400';
      end if;
      -- 0174: a step whose model makes the person confirm their rights to its input cannot run in a workflow: an input an
      -- earlier step makes does not exist yet, and a later step may run in another member's session. Refused before any
      -- hold, at the quote and at the start (start_workflow_run); such a model is used from the Studio.
      if cardinality(public.rights_acknowledgement_required(st.v ->> 'model')) > 0
         and jsonb_typeof(st.v -> 'params') = 'object'
         and (st.v -> 'params') ?| array['source_asset_id', 'end_asset_id'] then
        raise exception 'acknowledgement_required' using errcode = 'NS400';
      end if;
      q := public.creative_price(p_wf.org_id, st.v ->> 'capability', st.v ->> 'model', params);
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', true, 'credits', (q ->> 'credits')::numeric, 'unit', q ->> 'unit',
        'quantity', (q ->> 'quantity')::numeric, 'chained', chained));
      total := total + (q ->> 'credits')::numeric;
    exception when others then
      -- Never a zero: the step is unpriced and carries the database's own
      -- machine word (unpriced, model_not_sellable, source_unavailable, …).
      steps_ := steps_ || jsonb_build_array(jsonb_build_object(
        'step_index', st.ord - 1, 'capability', st.v ->> 'capability', 'model', st.v ->> 'model',
        'priced', false, 'credits', null,
        'reason', case when sqlerrm ~ '^[a-z0-9_]{1,64}$' then sqlerrm else 'unpriced' end,
        'chained', chained));
      bad := bad || (st.ord - 1)::integer;
    end;
  end loop;
  select * into acc from public.credit_accounts where org_id = p_wf.org_id;
  return jsonb_build_object(
    'workflow_id', p_wf.id, 'version', p_wf.version, 'steps', steps_,
    'priced', cardinality(bad) = 0,
    'total', case when cardinality(bad) = 0 then total end,
    'unpriced_steps', to_jsonb(bad),
    'exempt', public.credits_exempt(p_wf.org_id),
    'available', case when public.credits_exempt(p_wf.org_id) then null
                      else coalesce(acc.balance - acc.reserved, 0) end);
end
$$;
revoke all on function public.workflow_quote_steps(public.workflows, jsonb) from public, anon, authenticated, service_role;

create or replace function public.start_workflow_run(
  p_run uuid,
  p_workflow uuid,
  p_version integer,
  p_inputs jsonb default '{}'::jsonb,
  p_max_credits numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  w       public.workflows;
  prior   public.workflow_runs;
  vals    jsonb;
  hash_   text;
  q       jsonb;
  total   numeric;
  acc     public.credit_accounts;
  st      record;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_run is null then
    perform public.creative_refuse('invalid_params', 'a run id is required');
  end if;
  select * into w from public.workflows where id = p_workflow;
  if not found or w.archived_at is not null or not public.is_org_member(w.org_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.is_org_member(w.org_id, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The operator's organization is paid by the platform: only a platform admin
  -- spends there (create_creative_job asks the same of every step).
  if public.credits_exempt(w.org_id) and not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501',
      detail = 'runs in the operator''s organization are started by a platform admin';
  end if;
  if p_max_credits is null or p_max_credits < 0 then
    perform public.creative_refuse('confirm_price', 'the confirmed total is required');
  end if;

  -- The account first: every create (and reserve) for this organization queues
  -- behind it, so a replay of the same run finds the first one's committed rows.
  perform public.credit_account_lock(w.org_id);

  hash_ := md5(jsonb_build_object('workflow', p_workflow, 'inputs', coalesce(p_inputs, '{}'::jsonb),
                                  'max', round(p_max_credits, 2)::text)::text);
  select * into prior from public.workflow_runs where id = p_run;
  if found then
    -- The same id under another organization, another workflow, other inputs or
    -- another confirmed total is a different request: refused without saying
    -- anything about what it collided with.
    if prior.org_id <> w.org_id or prior.request_hash is distinct from hash_ then
      perform public.creative_refuse('idempotency_conflict',
        'this run id was used for a different request', 'NS409');
    end if;
    perform public.workflow_advance_locked(prior.id);
    return public.workflow_run_json(prior.id) || jsonb_build_object('replay', true);
  end if;

  if p_version is distinct from w.version then
    perform public.creative_refuse('workflow_changed',
      format('the workflow is now version %s, not %s', w.version, p_version), 'NS409');
  end if;

  vals := public.workflow_bind_inputs(w, p_inputs);
  q := public.workflow_quote_steps(w, vals);
  -- 0174: named, before the generic 'unpriced': which steps need the Studio's acknowledgement (workflow_quote_steps).
  if exists (select 1 from jsonb_array_elements(q -> 'steps') e where e.value ->> 'reason' = 'acknowledgement_required') then
    perform public.creative_refuse('acknowledgement_required',
      format('step(s) %s use a model that asks you to confirm your rights to its input; make them in the Studio',
             (select string_agg(((e.value ->> 'step_index')::integer + 1)::text, ', ') from jsonb_array_elements(q -> 'steps') e
               where e.value ->> 'reason' = 'acknowledgement_required')));
  end if;
  if not (q ->> 'priced')::boolean then
    perform public.creative_refuse('unpriced',
      format('step(s) %s cannot be priced, so the workflow has no price',
             (select string_agg((u.x::integer + 1)::text, ', ') from jsonb_array_elements_text(q -> 'unpriced_steps') u(x))));
  end if;
  total := (q ->> 'total')::numeric;
  if round(p_max_credits, 2) <> round(total, 2) then
    perform public.creative_refuse('price_changed',
      format('price=%s confirmed=%s', total, round(p_max_credits, 2)), 'NS409');
  end if;
  if not public.credits_exempt(w.org_id) then
    select * into acc from public.credit_accounts where org_id = w.org_id;
    if coalesce(acc.balance - acc.reserved, 0) < total then
      perform public.creative_refuse('insufficient_credits',
        format('available=%s needed=%s', coalesce(acc.balance - acc.reserved, 0), total), 'NS402');
    end if;
  end if;

  insert into public.workflow_runs
    (id, org_id, workflow_id, workflow_name, workflow_version, inputs, max_credits, request_hash, started_by)
  values
    (p_run, w.org_id, w.id, w.name, w.version, vals, round(total, 2), hash_, uid);
  for st in select v, ord from jsonb_array_elements(w.steps) with ordinality as t(v, ord) loop
    insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, quoted_credits)
    values (p_run, st.ord - 1, w.org_id, st.v ->> 'capability', st.v ->> 'model',
            public.workflow_fill_params(st.v -> 'params', vals),
            (q -> 'steps' -> (st.ord - 1)::integer ->> 'credits')::numeric);
  end loop;

  perform public.workflow_advance_locked(p_run, true);
  return public.workflow_run_json(p_run) || jsonb_build_object('replay', false);
end
$$;
revoke all on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) from public, anon, authenticated, service_role;
grant execute on function public.start_workflow_run(uuid, uuid, integer, jsonb, numeric) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The public API's answer: 0124's api_creative_refusal, one marked hunk
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.api_creative_refusal(p_state text, p_msg text, p_detail text)
  returns jsonb
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  word text := btrim(coalesce(p_msg, ''));
  det  text := left(coalesce(p_detail, ''), 300);
  m    text[];
  extra jsonb := case when det <> '' and det <> word then jsonb_build_object('detail', det) else '{}'::jsonb end;
begin
  case p_state
    when '42501' then
      return public.api_err(403, 'forbidden', 'This key may not start generations in this organization.');
    when 'P0002' then
      return public.api_err(404, 'job_not_found', 'No generation with that id for this key.');
    when '22023' then
      return public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.');
    when 'NS402' then
      m := regexp_match(coalesce(p_detail, ''), 'available=(-?[0-9.]+)\s+needed=([0-9.]+)');
      return public.api_err(402, 'insufficient_credits',
        'The organization does not have enough credits for this generation. Nothing was held.',
        case when m is null then '{}'::jsonb
             else jsonb_build_object('available_credits', m[1]::numeric, 'needed_credits', m[2]::numeric) end);
    when 'NS429' then
      m := regexp_match(coalesce(p_detail, ''), 'active=([0-9]+)\s+limit=([0-9]+)');
      return public.api_err(429, 'run_limit_reached',
        'All of the plan''s parallel runs are in use. Wait for one to finish.',
        jsonb_build_object('retry_after', 60) || case when m is null then '{}'::jsonb
             else jsonb_build_object('active', m[1]::int, 'limit', m[2]::int) end);
    when 'NS409' then
      if word = 'price_changed' then
        return public.api_err(409, 'price_changed',
          'The price is now above max_credits. Quote again and confirm the new price.', extra);
      elsif word = 'idempotency_conflict' then
        return public.api_err(422, 'idempotency_key_reused',
          'This Idempotency-Key was already used for a different generation.');
      -- 0075: the router's pick changed since the quote.
      elsif word = 'route_changed' then
        return public.api_err(409, 'route_changed',
          'The automatic choice changed since the quote. Quote again and confirm the new choice.', extra);
      end if;
    when 'NS400' then
      return case word
        when 'registry_missing' then public.api_err(503, 'registry_missing', 'The model registry is not set up on this deployment.')
        when 'model_not_sellable' then public.api_err(422, 'model_not_sellable', 'That model is not available for this capability through the API.', extra)
        when 'entitlement_required' then public.api_err(403, 'entitlement_required', 'The organization''s plan does not include this model.', extra)
        when 'unpriced' then public.api_err(422, 'unpriced', 'That model has no price yet, so it cannot be sold.')
        when 'capability_not_supported' then public.api_err(422, 'capability_not_supported', 'That capability cannot be generated on this deployment.', extra)
        when 'source_unavailable' then public.api_err(422, 'source_unavailable', 'A media-library file in the request is not available to this organization.', extra)
        -- 0174: the model needs the person to confirm their rights to an input file; the API has no call for that.
        when 'acknowledgement_required' then public.api_err(428, 'acknowledgement_required', 'This model needs a person to confirm, in the Studio, their rights to the input file (for example the consent of every person shown). Confirm it there, then retry. Nothing was held or charged.', extra)
        when 'style_unavailable' then public.api_err(422, 'style_unavailable', 'The style kit in the request is not available to this organization.')
        when 'mode_not_supported' then public.api_err(422, 'mode_not_supported', 'Only mode "exact" (the model you named) is available.')
        -- 0075: no available, priced model of this plan takes these settings.
        when 'no_model_available' then public.api_err(422, 'no_model_available', 'No available, priced model can make this with these settings.', extra)
        -- 0124: the owner switched this model off for now. Nothing was held or charged; the caller chooses another or waits.
        when 'model_temporarily_off' then public.api_err(503, 'model_temporarily_off', 'That model is temporarily unavailable. Nothing was held or charged. Choose another model, or try again later.', extra)
        when 'invalid_idempotency_key' then public.api_err(400, 'invalid_idempotency_key', 'Idempotency-Key: 1-255 characters of A-Z a-z 0-9 _ : . -')
        else public.api_err(400, 'invalid_params', 'The request has a parameter this API does not accept.', extra)
      end;
    else
      null;
  end case;
  return public.api_err(500, 'internal_error',
    'The request failed inside the database. Nothing was created or charged; retry with backoff.');
end
$$;
revoke all on function public.api_creative_refusal(text, text, text) from public, anon, authenticated, service_role;

revoke all on function public.rights_acknowledgements_append_only() from public, anon, authenticated, service_role;
revoke all on function public.model_registry_requirement_guard() from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_required(text) from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_missing(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_rights(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_status(uuid, text, text[]) from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_rights(text, text, text, text) to authenticated;
grant execute on function public.rights_acknowledgement_status(uuid, text, text[]) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', '88107b00b0a8c143606ed17f5898c98d'),
      ('public.workflow_quote_steps(public.workflows, jsonb)', '8f9f42da9844571a18a285d87bcffc84'),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', '8b3c4b4afbc19e6f336c09b4692ad7ed'),
      ('public.api_creative_refusal(text, text, text)', 'e6ec45d0d912389a05eb2d40261c2c2a')) v(sig, want) loop
    if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure(r.sig)) is distinct from r.want then
      raise exception '0174 end state: % is not 0174''s body', r.sig;
    end if;
  end loop;
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', true),
      ('public.start_workflow_run(uuid, uuid, integer, jsonb, numeric)', true),
      ('public.acknowledge_rights(text, text, text, text)', true),
      ('public.rights_acknowledgement_status(uuid, text, text[])', true),
      ('public.workflow_quote_steps(public.workflows, jsonb)', false),
      ('public.rights_acknowledgement_required(text)', false),
      ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)', false)) v(sig, member) loop
    if exists (select 1 from pg_proc p where p.oid = to_regprocedure(r.sig)
                and (not p.prosecdef or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                     or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public, pg_temp')))
       or has_function_privilege('anon', r.sig, 'EXECUTE')
       or has_function_privilege('service_role', r.sig, 'EXECUTE')
       or has_function_privilege('authenticated', r.sig, 'EXECUTE') is distinct from r.member then
      raise exception '0174 end state: % is not a SECURITY DEFINER with the pinned search_path and the intended grants', r.sig;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.api_creative_refusal(text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.api_creative_refusal(text, text, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.api_creative_refusal(text, text, text)', 'EXECUTE') then
    raise exception '0174 end state: an API role may call api_creative_refusal';
  end if;
  -- The guard must see its caller: a SECURITY DEFINER guard would let every caller through as the owner.
  if (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.model_registry_requirement_guard()')) then
    raise exception '0174 end state: model_registry_requirement_guard must not be SECURITY DEFINER';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.rights_acknowledgements'::regclass)
     or not (select c.relrowsecurity from pg_class c where c.oid = 'public.rights_acknowledgement_kinds'::regclass) then
    raise exception '0174 end state: row level security is off on a rights acknowledgement table';
  end if;
  for r in select * from unnest(array['anon', 'authenticated', 'service_role']) role_,
                         unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv,
                         unnest(array['public.rights_acknowledgements', 'public.rights_acknowledgement_kinds']) tbl loop
    if has_table_privilege(r.role_, r.tbl, r.priv) then
      raise exception '0174 end state: % may % on % (only acknowledge_rights writes)', r.role_, r.priv, r.tbl;
    end if;
  end loop;
  if (select count(*) from pg_trigger where tgrelid = 'public.rights_acknowledgements'::regclass
        and tgname in ('rights_acknowledgements_append_only', 'rights_acknowledgements_no_truncate') and not tgisinternal) <> 2
     or not exists (select 1 from pg_trigger where tgrelid = 'public.model_registry'::regclass
                     and tgname = 'model_registry_requirement_guard' and not tgisinternal) then
    raise exception '0174 end state: a 0174 trigger is missing';
  end if;
  if (select count(*) from public.rights_acknowledgement_kinds) <> 3 then
    raise exception '0174 end state: the three acknowledgement kinds are not all seeded';
  end if;
  if exists (select 1 from public.model_registry where id in ('runway-gen4.5', 'runway-gen4-turbo')
               and not ('likeness_photo' = any (requires_acknowledgement))) then
    raise exception '0174 end state: a Runway model does not require likeness_photo';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run after applying, AND after any manual replay of 0073 or 0075; every column should read true). A false gate column
-- means an older file was re-run over this one and the acknowledgement step is gone: apply 0174 again (see REPLAY above).
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)'::regprocedure) = '88107b00b0a8c143606ed17f5898c98d' as job_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.workflow_quote_steps(public.workflows,jsonb)'::regprocedure) = '8f9f42da9844571a18a285d87bcffc84'                as workflow_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.start_workflow_run(uuid,uuid,integer,jsonb,numeric)'::regprocedure) = '8b3c4b4afbc19e6f336c09b4692ad7ed'          as workflow_start_gate,
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.api_creative_refusal(text,text,text)'::regprocedure) = 'e6ec45d0d912389a05eb2d40261c2c2a'                         as api_answer,
--   (select count(*) = 3 from public.rights_acknowledgement_kinds)                                                       as kinds,
--   (select bool_and('likeness_photo' = any (requires_acknowledgement)) from public.model_registry
--     where id in ('runway-gen4.5', 'runway-gen4-turbo'))                                                                is not false as runway_requires,
--   exists (select 1 from pg_trigger where tgrelid = 'public.model_registry'::regclass
--            and tgname = 'model_registry_requirement_guard')                                                            as requirement_only_grows,
--   not has_table_privilege('service_role', 'public.rights_acknowledgements', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.rights_acknowledgements', 'UPDATE')                        as append_only_grants,
--   has_function_privilege('authenticated', 'public.acknowledge_rights(text,text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.acknowledge_rights(text,text,text,text)', 'EXECUTE')             as rpc_grants;
