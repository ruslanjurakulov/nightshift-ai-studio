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
--   the browser never decides): the database has to refuse the job itself, before anything is priced or held (rule 6).
--
-- CHANGE (additive; one function body replaced):
--   rights_acknowledgement_kinds   the closed list of kinds and the CURRENT text version of each. Seeded:
--       likeness_photo       a real person's face in an uploaded image or video       likeness_photo.v1
--       voice_clone          a real person's voice                                     voice_clone.v1
--       third_party_content  copyrighted material the person owns or licensed          third_party_content.v1
--     The words of each version live in command-center/lib/i18n/rights-acknowledgement/{en,ru,uz}.ts; a change of the words is a
--     new version here (a later migration), and every acknowledgement of the old version stops counting.
--   rights_acknowledgements        append-only: who (auth.uid()), in which organization, acknowledged which kind, at which text
--     version, for which input (the media asset's id, and its sha256 as it was then). Written ONLY by acknowledge_rights(); no API
--     role (the service key included) inserts, updates or deletes; a trigger refuses UPDATE, DELETE and TRUNCATE even for the
--     owner. Members of the organization read its rows (RLS); nobody else does.
--   model_registry.requires_acknowledgement text[] (default empty): the kinds a model requires. Seeded {likeness_photo} on
--     runway-gen4.5 and runway-gen4-turbo, and nothing else: their availability is NOT changed here (both stay as they are,
--     unsold). The registry file carries the same list (spec.requires_acknowledgement): a model requires the UNION of the two,
--     so neither the file nor this column can drop a requirement the other states.
--   acknowledge_rights(kind, text_version, subject)   the only write path (authenticated). Refuses an unknown kind, a version
--     that is not the current one (NS409 acknowledgement_version_changed, current=…), and a subject that is not a live asset of
--     an organization the caller belongs to (source_unavailable, exactly as for a missing id). A replay answers the first row.
--   rights_acknowledgement_status(org, model, subjects)   what the Studio asks before it opens the dialog: the kinds the model
--     requires, at which version, and which (kind, subject) pairs THIS person has not acknowledged yet. Reads only the caller's
--     own rows.
--   rights_acknowledgement_required(model), rights_acknowledgement_missing(org, user, model, params)   internal helpers.
--   create_creative_job (0075's body, two marked hunks): after an idempotent replay is answered and BEFORE the price, the
--     expiry sweep or any hold, a model that requires a kind refuses NS400 'acknowledgement_required'
--     (detail: kind=… version=… subject=…) when an input it is given (params.source_asset_id, params.end_asset_id — every
--     media input creative_params_problem accepts, 0156) has no acknowledgement of that kind, by THIS person, in THIS
--     organization, at the CURRENT text version. Nothing is held and no job row is written. Another person's acknowledgement,
--     another organization's, and an old version's do not count. Every way a generation starts goes through this function: the
--     Studio, the API (api_creative_create), the MCP server and workflow runs (0073).
--
-- REPLACES (md5 drift guard: 0075's body, or this file's own on a replay; whitespace runs read as one space):
--   create_creative_job (0075; never redefined since). Signature, SECURITY DEFINER, the pinned search_path and the grant
--   (authenticated only) stay as 0075 made them (restated below).
-- NOT CHANGED: creative_price, quote_creative_job (a quote is free: it holds nothing, so it does not ask), sellable_models,
--   route_model, every price, hold and ledger rule, every model's availability.
--
-- NUMBER. 0174: main is at 0170; 0171, 0172 and 0173 are held by open pull requests. This file applies on top of any of them
--   (it names nothing of 0171-0173), but it auto-applies to the live database on merge, so it merges after them. Needs 0018
--   (organizations), 0035 (model_registry), 0036 (creative_refuse), 0038 (media_assets) and 0075 (create_creative_job).
--
-- WHAT TO VERIFY BEFORE YOU APPLY (read-only):
--   select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)'::regprocedure;
--   expected BEFORE 4c74918fd9d938c8fe4f5a3d26a09d84 (0075), AFTER 128fa773beb2f3ef30ac8a332088a5e2 (this file).
-- Undo: docs/sql/rollback_0174_rights_acknowledgement.sql (owner-applied; the acknowledgements recorded so far are dropped with
--   their table, so read them out first). Re-running 0075 after this file is refused by 0075's own drift guard: undo 0174 first.

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
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into h from pg_proc p
   where p.oid = to_regprocedure('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)');
  if h is null or h <> all (array['4c74918fd9d938c8fe4f5a3d26a09d84', '128fa773beb2f3ef30ac8a332088a5e2']) then
    raise exception '0174 found public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) with a body that is neither 0075''s nor 0174''s (md5 %): read the live body first', h;
  end if;
  -- The tables this file creates: absent, or this file's own.
  for r in select * from (values ('rights_acknowledgement_kinds', 'text_version'), ('rights_acknowledgements', 'subject_sha256')) v(t, c) loop
    if to_regclass('public.' || r.t) is not null
       and not exists (select 1 from information_schema.columns
                        where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception '0174 found a table public.% that is not this file''s (no column %): read it first', r.t, r.c;
    end if;
  end loop;
  -- The functions this file creates: absent, or this file's own bodies (a replay).
  for r in select * from (values
      ('public.rights_acknowledgements_append_only()', 'e885c3b71a6af4724016c12554ed728e'),
      ('public.rights_acknowledgement_required(text)', 'bdae111d99c36aad7029cd99295fde7f'),
      ('public.rights_acknowledgement_missing(uuid, uuid, text, jsonb)', '426ea90d162535b0ee6f10e752e5fe26'),
      ('public.acknowledge_rights(text, text, text)', 'ff9ae30a102df6f68103420266139e2c'),
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
  -- The subject: the media asset the person acknowledged, and its sha256 as it was then (the bytes they saw).
  subject_asset_id uuid not null,
  subject_sha256   text not null,
  created_at       timestamptz not null default now(),
  constraint rights_acknowledgements_version_check
    check (text_version ~ '^[a-z_]{3,40}\.v[0-9]{1,4}$' and split_part(text_version, '.', 1) = kind),
  constraint rights_acknowledgements_sha256_check check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  -- One row per person, organization, kind, version and subject: a replay writes nothing new.
  constraint rights_acknowledgements_once unique (org_id, user_id, kind, text_version, subject_asset_id)
);

comment on table public.rights_acknowledgements is
  'Who acknowledged their rights to which input, under which text version (migration 0174). Append-only; written only by acknowledge_rights(); read by the members of the organization.';

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
  'The rights acknowledgement kinds a job of this model needs for each input (0174). A model requires these AND spec.requires_acknowledgement (the registry file''s list).';

-- Runway's Terms §4.2 (photo consent on an image-to-video upload). Their availability is not touched: both stay unsold.
update public.model_registry
   set requires_acknowledgement = array(select distinct k from unnest(requires_acknowledgement || array['likeness_photo']) k order by 1)
 where id in ('runway-gen4.5', 'runway-gen4-turbo')
   and not ('likeness_photo' = any (requires_acknowledgement));

-- The union of the column and the registry file's list. An unknown model requires nothing here: creative_price refuses it.
-- A kind the file names that is not in the closed list stays in the answer, so it can never be acknowledged and the model
-- refuses every input: a typo fails closed.
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
  if jsonb_typeof(m.spec -> 'requires_acknowledgement') = 'array' then
    from_spec := array(select jsonb_array_elements_text(m.spec -> 'requires_acknowledgement'));
  elsif jsonb_typeof(m.spec -> 'requires_acknowledgement') = 'string' then
    from_spec := array[m.spec ->> 'requires_acknowledgement'];
  end if;
  return array(select distinct k from unnest(coalesce(m.requires_acknowledgement, '{}') || from_spec) k
                where nullif(btrim(k), '') is not null order by 1);
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

create or replace function public.acknowledge_rights(p_kind text, p_text_version text, p_subject text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid  uuid := auth.uid();
  k    public.rights_acknowledgement_kinds;
  s    text := btrim(coalesce(p_subject, ''));
  a    public.media_assets;
  row_ public.rights_acknowledgements;
  replay boolean := false;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into k from public.rights_acknowledgement_kinds where kind = lower(btrim(coalesce(p_kind, '')));
  if not found then
    perform public.creative_refuse('invalid_params', 'kind must be likeness_photo, voice_clone or third_party_content');
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
  insert into public.rights_acknowledgements (org_id, user_id, kind, text_version, subject_asset_id, subject_sha256)
  values (a.org_id, uid, k.kind, k.text_version, a.id, a.sha256)
  on conflict on constraint rights_acknowledgements_once do nothing
  returning * into row_;
  if row_.id is null then
    replay := true;
    select * into row_ from public.rights_acknowledgements
     where org_id = a.org_id and user_id = uid and kind = k.kind and text_version = k.text_version and subject_asset_id = a.id;
  end if;
  return jsonb_build_object('acknowledgement',
           jsonb_build_object('kind', row_.kind, 'text_version', row_.text_version, 'subject', row_.subject_asset_id,
                              'created_at', row_.created_at),
           'replay', replay);
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

  -- 0174: a model whose provider (or the law) makes the person confirm their rights to an input refuses here, before
  -- anything is priced or held, unless THIS person acknowledged THIS input in THIS organization at the CURRENT text
  -- version (rights_acknowledgement_missing). A replay of a job already created was answered above.
  ack := public.rights_acknowledgement_missing(p_org, uid, p_model, p_params);
  if ack is not null then
    perform public.creative_refuse('acknowledgement_required',
      format('kind=%s version=%s subject=%s', ack ->> 'kind', coalesce(ack ->> 'text_version', 'none'), ack ->> 'subject'));
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

revoke all on function public.rights_acknowledgements_append_only() from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_required(text) from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_missing(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_rights(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.rights_acknowledgement_status(uuid, text, text[]) from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_rights(text, text, text) to authenticated;
grant execute on function public.rights_acknowledgement_status(uuid, text, text[]) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. End state (refuses the whole transaction if any of it is not so)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  if (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
       where oid = to_regprocedure('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)'))
     is distinct from '128fa773beb2f3ef30ac8a332088a5e2' then
    raise exception '0174 end state: create_creative_job is not 0174''s body';
  end if;
  for r in select * from (values
      ('public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)', true),
      ('public.acknowledge_rights(text, text, text)', true),
      ('public.rights_acknowledgement_status(uuid, text, text[])', true),
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
        and tgname in ('rights_acknowledgements_append_only', 'rights_acknowledgements_no_truncate') and not tgisinternal) <> 2 then
    raise exception '0174 end state: the append-only triggers are not both on rights_acknowledgements';
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
-- Verify (run after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
-- select
--   (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc
--     where oid = 'public.create_creative_job(uuid,text,text,jsonb,text,text,numeric)'::regprocedure) = '128fa773beb2f3ef30ac8a332088a5e2' as job_gate,
--   (select count(*) = 3 from public.rights_acknowledgement_kinds)                                                       as kinds,
--   (select bool_and('likeness_photo' = any (requires_acknowledgement)) from public.model_registry
--     where id in ('runway-gen4.5', 'runway-gen4-turbo'))                                                                is not false as runway_requires,
--   not has_table_privilege('service_role', 'public.rights_acknowledgements', 'INSERT')
--     and not has_table_privilege('authenticated', 'public.rights_acknowledgements', 'UPDATE')                        as append_only_grants,
--   has_function_privilege('authenticated', 'public.acknowledge_rights(text,text,text)', 'EXECUTE')
--     and not has_function_privilege('anon', 'public.acknowledge_rights(text,text,text)', 'EXECUTE')                  as rpc_grants;
