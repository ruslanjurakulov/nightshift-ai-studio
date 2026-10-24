-- 0117_voice_profiles.sql — Custom Voice, database half: a user may clone THEIR OWN voice, and ONLY THAT USER may use it.
-- (docs/CUSTOM_VOICE.md; pure code in modules/voice_profiles.py.)
--
-- OWNER DECISIONS (explicit): every user may clone their own voice and only that user may use it; every voice must be
-- traceable to who it belongs to (a unique, non-repeating id per user); v1 takes a LIVE recording only (no file upload) with
-- a read-aloud random phrase; the user chooses at cloning time whether the raw sample is deleted right after the clone
-- (default) or kept until the user deletes it. Re-voicing one line of a finished video is a LATER slice and is not here.
--
-- WHAT THIS DOES NOT DO. Nothing here calls ElevenLabs or any provider: the account is on the FREE plan, which does not allow
-- instant cloning, so NOTHING LIVE CAN RUN. request_voice_clone() writes a request and a queue row and stops (CLAUDE.md rule
-- 3); the worker that would read the queue is not built. No UI, no worker, no workflow is touched. Existing voices (the
-- operator's premade and library voices, which are in no voice_profiles row) keep working exactly as before.
--
-- NUMBER. 0117: the highest on main is 0116 and no open pull request adds a migration (checked with gh api, 2026-10-24).
--
-- WHAT IT ADDS
--   user_voice_refs         one row per user: owner_ref, a RANDOM per-user reference (UUIDv4 without dashes, 122 random bits).
--                           The traceable "unique id created for each user". Random rather than derived from the user id with a
--                           keyed hash because there is no secret to manage, rotate or leak, it is unique by constraint, it is
--                           not guessable, and it never exposes the auth user id. The later worker writes it into the provider
--                           voice NAME (ns-<owner_ref>-<first 8 of the profile id>), so a voice found in the ElevenLabs account
--                           traces back to a user through this table. Created lazily by the functions below (the repo has no
--                           trigger on auth.users and signup is done through RPCs), and backfilled for every existing user by
--                           the statement in section 2.
--   voice_profiles          one row per clone request: owner, org, name, status (pending_verification | testing | approved |
--                           rejected | deleted), provider voice id (UNIQUE per provider), sample hash, keep_sample, sample_state.
--   voice_consents          APPEND-ONLY consent trail (no update, no delete, no truncate for any role; only the documented
--                           purge function may delete, and it keeps a minimal record in voice_deletion_records).
--   voice_clone_jobs        the worker's queue (clone, delete at the provider, purge the sample). No API role can read or write it.
--   voice_channel_attachments   the owner's explicit, audited act of putting a voice on a channel.
--   voice_deletion_records  APPEND-ONLY, no user id: what survives a deletion (owner_ref, consent version and time, hashes).
--   bucket voice-samples    private, 50 MB, audio only; the owner can INSERT into their own <user_id>/<profile_id>/ prefix for
--                           a profile that is waiting for its sample; nobody can read, update or delete through the API.
--
-- WHO MAY DO WHAT
--   RLS: a member reads ONLY their own rows (user_voice_refs, voice_profiles, voice_consents, voice_channel_attachments).
--   NO API role (anon, authenticated, service_role) has INSERT, UPDATE or DELETE on any of these tables: every write is a
--   SECURITY DEFINER function with a pinned search_path, EXECUTE revoked from public/anon and granted narrowly:
--     signed-in owner:  my_voice_ref, approve_voice, attach_voice_to_channel, detach_voice_from_channel,
--                       delete_voice, delete_voice_sample
--     NOBODY (dormant): request_voice_clone. It is created, revoked from every API role and NOT granted. Starting a clone is the one
--                       entry into the feature, so the grant ships in the migration that ships the worker, the UI and the Actions
--                       pre-flight (docs/CUSTOM_VOICE.md, "Hard gate"). Until then no signed-in user can create a profile, a queue
--                       row, or (because the bucket's insert rule needs a waiting profile) a stored object.
--     service role:     claim_voice_job, finish_voice_clone, finish_voice_task, purge_voice_records
--     nobody (internal): voice_usable_by and the pure helpers
--   channel_voice_config_problem is callable by signed-in users and the service role because the channels guard (a trigger that
--   runs as the caller) asks it; it takes no user argument and reveals only "this voice id is / is not allowed on this channel".
--
-- OWNERSHIP ENFORCEMENT (the real security work; a latent gap before this: any id that matched a shape regex passed)
--   If a provider voice id exists in voice_profiles it may be used ONLY (a) by its owner in their own jobs, when approved (a
--   Studio tts TEST is also allowed while the voice is 'testing', owner only: see approve_voice), or (b) in channel runs where
--   that owner attached it to that channel (attach is the owner's explicit audited act, and the owner must still be an
--   administrator of the channel's organization). A voice that is in no voice_profiles row is allowed exactly as before.
--   Where a voice id ENTERS the system, in the database, for every writer (the service key and definer functions included):
--     1. creative_jobs (tts and voice_change): BEFORE INSERT trigger creative_jobs_voice_guard
--     2. render_jobs (a run's voice_id, and the channel's configured voices at queue time): BEFORE INSERT trigger render_jobs_voice_guard
--     3. channels.agent_config elevenlabs_voice_id and elevenlabs_secondary_voice_id: channels_config_guard() (replaced on 0114's
--        LATEST body; the diff is one block at the top, nothing else changes), which also covers set_channel_dna() and create_channel()
--   WHY NOT creative_params_problem / render_job_params_valid THEMSELVES. They are IMMUTABLE pure functions of the parameters
--   (render_job_params_valid sits in a CHECK constraint and in the api_* functions): they cannot see who is asking or which
--   organization, and a CHECK that reads other tables is wrong on every update. The organization-aware companions
--   (creative_source_problem, creative_style_problem) already live beside them and are called from the code that has the context;
--   here the context is the row being inserted, so the rule sits in the BEFORE INSERT trigger of the table the row enters.
--   Both pure functions are unchanged and still do the shape check.
--
-- THE AI-DISCLOSURE LABEL. attach_voice_to_channel() records ai_disclosure_voice = 'own_clone' on the channel, and nothing else
-- may (0114 keeps the direct write a platform administrator's). That is a deliberate use of a definer function, decided by the
-- owner for this feature. own_clone does not change the label (modules/ai_disclosure.py: only real_person adds a reason).
--
-- THE NAME CHECK IS KEYWORD-WEAK BY DESIGN. voice_name_problem() refuses a name that reads as a real or public person ("sounds
-- like ...", "voice of ...", "president", ...). It is a list of phrases: a person can misspell a name or use a nickname. It stops
-- casual attempts and says so to the user; it is not identity verification and nothing relies on it for safety. The user's name is
-- never sent to the provider.
--
-- DELETING A STORAGE OBJECT FROM SQL IS NOT RELIED ON. Supabase Storage blocks direct DELETEs on storage.objects (the blob would
-- stay), and the repo's lab does not emulate that block, so the database never deletes a sample object itself: it marks
-- sample_state = 'purge_pending' and queues a purge_sample job; the worker deletes through the Storage API with the service role and
-- confirms with finish_voice_task(), which sets 'purged'. UNVERIFIED on the live project: verify with the queries at the end.
--
-- Additive and idempotent: create ... if not exists, create or replace (bodies copied from the latest migration that defines each:
-- channels_config_guard from 0114, audit_action_allowed from 0116), drop trigger / policy then create, revoke then grant. No
-- existing row is rewritten; an applied migration is never edited. Rollback: docs/sql/rollback_0117_voice_profiles.sql.
-- REQUIRES 0018 (organizations, is_org_member), 0020 (credits_trusted_caller), 0036 (creative_jobs), 0017 (render_jobs),
-- 0008/0087 (app_audit_log, audit_action_allowed), 0086 and 0114 (channels_config_guard, channel_label_lowering), Supabase Storage.

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.channels') is null or to_regclass('public.organizations') is null
     or to_regclass('public.org_members') is null or to_regclass('public.app_members') is null
     or to_regprocedure('public.is_org_member(uuid, text)') is null
     or to_regprocedure('public.default_org_id()') is null
     or to_regprocedure('public.app_role_rank(text)') is null then
    raise exception '0117 needs the organization helpers: apply 0018_organizations.sql first';
  end if;
  if to_regclass('public.creative_jobs') is null then
    raise exception '0117 needs 0036_creative_jobs.sql (creative_jobs): apply it first';
  end if;
  if to_regclass('public.render_jobs') is null then
    raise exception '0117 needs 0017_render_jobs.sql (render_jobs): apply it first';
  end if;
  if to_regclass('public.app_audit_log') is null or to_regprocedure('public.audit_action_allowed(text)') is null then
    raise exception '0117 needs 0008/0087 (app_audit_log, audit_action_allowed): apply them first';
  end if;
  if to_regprocedure('public.channels_config_guard()') is null
     or to_regprocedure('public.channel_label_lowering(jsonb)') is null then
    raise exception '0117 needs 0086 and 0114 (channels_config_guard, channel_label_lowering): apply them first';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception '0117 needs the storage schema (Supabase Storage): enable Storage on the project first';
  end if;
  -- create or replace keeps a trigger bound; if the 0086 trigger is gone the voice check on channels would never run.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.channels'::regclass and tgname = 'channels_config_guard' and not tgisinternal) then
    raise exception '0117 found no channels_config_guard trigger on channels: re-apply 0086 first';
  end if;
end $$;

-- The two functions this file replaces are replaced on the bodies the REPO says are latest (0114's channels_config_guard, 0116's
-- audit_action_allowed). If the live database holds another body (something applied by hand after those migrations: the 0064/0103
-- drift lesson), replacing it would silently undo that change, so the file refuses. Compared as md5 of the body (prosrc) with every run
-- of white space read as one space, so line endings and indentation cannot cause a false alarm; the second hash of each pair is this
-- file's own body, which is what a replay sees. tests/test_voice_profiles_migration.py recomputes all four from the migration files.
do $$
declare
  g text;
  a text;
begin
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into g from pg_proc p where p.oid = 'public.channels_config_guard()'::regprocedure;
  select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) into a from pg_proc p where p.oid = 'public.audit_action_allowed(text)'::regprocedure;
  if g is null or g <> all (array['44efc227d33d0c6564795f7a642489bf', 'b5cf70785cafdf71ec4cdc49bb393c9c']) then
    raise exception '0117 found a channels_config_guard() that is neither 0114''s body nor 0117''s (md5 %): read the live body first', g;
  end if;
  if a is null or a <> all (array['a17cf1ea1cbd8da45905d4654dd0bf7b', 'd622e052a695fef125d3b2b621cdda27']) then
    raise exception '0117 found an audit_action_allowed() that is neither 0116''s body nor 0117''s (md5 %): read the live body first', a;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Pure helpers (no table is read; nobody calls them through the API)
-- ───────────────────────────────────────────────────────────────────────────

-- The phrase patterns of a name that reads as another person. The SAME list is REAL_PERSON_PATTERNS in modules/voice_profiles.py
-- (tests/test_voice_profiles_migration.py compares them). Each is matched against the normalised name (lower case, every run of
-- characters other than a-z, 0-9 and Cyrillic one space, a space at both ends), so the padded ones are whole words or phrases.
create or replace function public.voice_real_person_patterns() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array[
    ' sounds? like ', ' sounding like ', ' sound ?alike ', ' soundalike ', ' sounds? just like ', ' voice of ',
    ' voice like ', ' in the style of ', ' in the voice of ', ' as voiced by ', ' as spoken by ', ' impression of ',
    ' impressions? ', ' impersonat[a-z]* ', ' imitat[a-z]* ', ' mimic[a-z]* ', ' parod[a-z]* ',
    ' (clone|copy|replica|likeness|lookalike|double) of ', ' deep ?fakes? ', ' fake ', ' real person ',
    ' public figure ', ' celebrity ', ' celebrities ', ' politician ', ' president ', ' prime minister ',
    ' senator ', ' actor ', ' actress ', ' singer ', ' rapper ', ' streamer ', ' youtuber ', ' influencer ',
    'звучит как', 'похож на', 'голос как у', 'имитац', 'пароди', 'знаменит', 'президент', ' ovozi kabi ',
    ' ovoz kabi ', ' ovoziga o xshash '
  ]::text[]
$$;

-- The normalised form the patterns read (modules/voice_profiles.normalize_name): NFKC, invisible characters removed, lower
-- case, every run of other characters one space, a space at both ends.
create or replace function public.voice_name_norm(p text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select ' ' || btrim(regexp_replace(
           lower(regexp_replace(normalize(coalesce(p, ''), nfkc), '[​-‏⁠﻿]', '', 'g')),
           '[^a-z0-9а-яё]+', ' ', 'g')) || ' '
$$;

-- NULL for an acceptable voice name, else a closed word (modules/voice_profiles.voice_name_problem returns the same words):
-- name_length | name_link | name_characters | name_real_person. KEYWORD-WEAK BY DESIGN (see the header).
create or replace function public.voice_name_problem(p_name text) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  s   text := regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  pat text;
  nrm text;
begin
  if p_name is null or char_length(s) not between 2 and 60 then
    return 'name_length';
  end if;
  if s ~* '(https?://|www\.|[@/\\<>{}\[\]|`$%^*=+~"])' or s ~ '[[:cntrl:]]' then
    return 'name_link';
  end if;
  if s !~ '[[:alpha:]]' then
    return 'name_characters';
  end if;
  nrm := public.voice_name_norm(s);
  foreach pat in array public.voice_real_person_patterns() loop
    if nrm ~ pat then
      return 'name_real_person';
    end if;
  end loop;
  return null;
end
$$;

-- The five things a person declares before a voice is cloned. All five must be present and true; nothing else is accepted.
create or replace function public.voice_declarations_problem(p jsonb) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 1024 then
    return 'declarations_shape';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('own_voice', 'sole_speaker', 'over_18', 'voice_data_to_provider', 'no_impersonation') then
      return 'declarations_unknown';
    end if;
  end loop;
  foreach k in array array['own_voice', 'sole_speaker', 'over_18', 'voice_data_to_provider', 'no_impersonation'] loop
    if (p -> k) is distinct from 'true'::jsonb then
      return 'declarations_incomplete';
    end if;
  end loop;
  return null;
end
$$;

-- The read-aloud words: 128 short, common, easy-to-tell-apart words (7 bits each). The SAME list is PHRASE_WORDS in
-- modules/voice_profiles.py (compared by tests/test_voice_profiles_migration.py).
create or replace function public.voice_phrase_words() returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select array[
    'apple', 'river', 'candle', 'window', 'garden', 'pencil', 'silver', 'orange', 'bridge', 'forest', 'yellow',
    'button', 'mirror', 'basket', 'blanket', 'dragon', 'engine', 'feather', 'guitar', 'hammer', 'island', 'jacket',
    'kitchen', 'ladder', 'magnet', 'needle', 'pepper', 'rabbit', 'saddle', 'tunnel', 'umbrella', 'violin', 'wallet',
    'anchor', 'bottle', 'carpet', 'dinner', 'eagle', 'flower', 'ginger', 'harbor', 'insect', 'jungle', 'kettle',
    'lantern', 'marble', 'napkin', 'ocean', 'pillow', 'quiet', 'rocket', 'sunset', 'ticket', 'valley', 'winter',
    'yogurt', 'zipper', 'autumn', 'breeze', 'castle', 'desert', 'elbow', 'fabric', 'glass', 'honey', 'icicle',
    'jelly', 'knight', 'lemon', 'morning', 'number', 'oyster', 'planet', 'quartz', 'ribbon', 'spider', 'turtle',
    'unicorn', 'velvet', 'whistle', 'yarn', 'zebra', 'badge', 'cherry', 'daisy', 'ember', 'falcon', 'grape',
    'hollow', 'ivory', 'juniper', 'kernel', 'linen', 'meadow', 'nectar', 'olive', 'pebble', 'quilt', 'raven',
    'satin', 'timber', 'urchin', 'vessel', 'walnut', 'yonder', 'zenith', 'acorn', 'barrel', 'cobweb', 'dolphin',
    'echo', 'fiddle', 'gravel', 'hazel', 'iguana', 'jigsaw', 'koala', 'locket', 'mango', 'nutmeg', 'orchid',
    'parrot', 'radish', 'sparrow', 'thimble', 'walrus', 'pocket', 'tomato'
  ]::text[]
$$;

-- Six DISTINCT random words, drawn from the database's CSPRNG (gen_random_uuid): the phrase must not be predictable before the
-- request that issues it, so it is made here and never taken from the caller. Bytes 6 and 8 of a UUIDv4 have fixed bits and are
-- skipped; every other byte is uniformly random, and 128 words make "byte & 127" unbiased.
create or replace function public.voice_phrase_new() returns text
  language plpgsql volatile set search_path = public, pg_temp as $$
declare
  words  text[] := public.voice_phrase_words();
  picked text[] := '{}';
  b      bytea;
  i      integer := 16;
  w      text;
begin
  while cardinality(picked) < 6 loop
    if i >= 16 then
      b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      i := 0;
    end if;
    if i not in (6, 8) then
      w := words[(get_byte(b, i) & 127) + 1];
      if not w = any (picked) then
        picked := picked || w;
      end if;
    end if;
    i := i + 1;
  end loop;
  return array_to_string(picked, ' ');
end
$$;

-- What voice_consents.verification_phrase_hash stores: SHA-256 (hex) of the phrase normalised the way the worker's checker does
-- (modules/voice_profiles.hash_phrase): lower case, every run of characters other than a-z, 0-9 and Cyrillic one space.
create or replace function public.voice_phrase_hash(p text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(btrim(regexp_replace(
           lower(regexp_replace(normalize(coalesce(p, ''), nfkc), '[​-‏⁠﻿]', '', 'g')),
           '[^a-z0-9а-яё]+', ' ', 'g')), 'UTF8')), 'hex')
$$;

-- A voice id as the reader reads it: a JSON string, surrounding whitespace removed (Python str.strip, as in 0114's
-- ai_disclosure_norm), lower-cased so a re-cased copy is the same id. NULL for anything that is not a non-blank string.
create or replace function public.voice_id_norm(p_value jsonb) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select nullif(lower(regexp_replace(p_value #>> '{}',
    '^[\u0009-\u000d\u001c- \u0085   -     　]+|[\u0009-\u000d\u001c- \u0085   -     　]+$',
    '', 'g')), '')
   where jsonb_typeof(p_value) = 'string'
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.user_voice_refs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  owner_ref  text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now(),
  constraint user_voice_refs_shape check (owner_ref ~ '^[0-9a-f]{32}$'),
  constraint user_voice_refs_pair unique (user_id, owner_ref)
);
comment on table public.user_voice_refs is
  'The traceable per-user reference (migration 0117): a random 32-hex owner_ref per user, written into the provider voice name so a voice in the provider account traces to a user. Immutable. Written only by the 0117 functions.';

-- The reference never changes: a voice already in the provider account carries it in its name.
create or replace function public.user_voice_refs_immutable() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'user_voice_refs: the owner_ref of a user never changes' using errcode = '42501';
end
$$;
drop trigger if exists user_voice_refs_immutable on public.user_voice_refs;
create trigger user_voice_refs_immutable
  before update on public.user_voice_refs
  for each row execute function public.user_voice_refs_immutable();

create table if not exists public.voice_profiles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  owner_ref        text not null,
  name             text not null,
  status           text not null default 'pending_verification',
  provider         text,
  provider_voice_id text,
  sample_sha256    text,
  keep_sample      boolean not null default false,
  -- awaiting: nothing uploaded yet | stored: the worker saw the object | purge_pending: delete it (the worker does) | purged
  sample_state     text not null default 'awaiting',
  reject_reason    text,
  idempotency_key  text,
  request_hash     text,
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  deleted_at       timestamptz,
  constraint voice_profiles_owner_ref_fk foreign key (user_id, owner_ref)
    references public.user_voice_refs (user_id, owner_ref),
  constraint voice_profiles_id_user unique (id, user_id),
  constraint voice_profiles_name_len check (char_length(name) between 2 and 60),
  constraint voice_profiles_status_check
    check (status in ('pending_verification', 'testing', 'approved', 'rejected', 'deleted')),
  constraint voice_profiles_provider_check check (provider is null or provider in ('elevenlabs')),
  constraint voice_profiles_provider_pair check ((provider is null) = (provider_voice_id is null)),
  constraint voice_profiles_voice_id_shape check (provider_voice_id is null or provider_voice_id ~ '^[A-Za-z0-9]{20}$'),
  constraint voice_profiles_sample_hash check (sample_sha256 is null or sample_sha256 ~ '^[0-9a-f]{64}$'),
  constraint voice_profiles_sample_state_check
    check (sample_state in ('awaiting', 'stored', 'purge_pending', 'purged')),
  constraint voice_profiles_reject_reason_check check (reject_reason is null or reject_reason ~ '^[a-z0-9_]{1,64}$'),
  constraint voice_profiles_idem_shape check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_:.-]{1,255}$'),
  -- A usable status always has a voice behind it and a time it became that.
  constraint voice_profiles_usable_has_voice
    check (status not in ('testing', 'approved') or provider_voice_id is not null),
  constraint voice_profiles_approved_at check (status <> 'approved' or approved_at is not null),
  constraint voice_profiles_deleted_at check (status <> 'deleted' or deleted_at is not null)
);
comment on table public.voice_profiles is
  'One cloned (or requested) voice (migration 0117). A user reads only their own rows; every write is a 0117 function. A voice id found here may be used only by its owner or on a channel the owner attached it to.';

-- One provider voice, one profile. Partial: a profile with no voice yet has no id.
create unique index if not exists voice_profiles_provider_voice_key
  on public.voice_profiles (provider, provider_voice_id) where provider_voice_id is not null;
create unique index if not exists voice_profiles_idem_key
  on public.voice_profiles (user_id, idempotency_key) where idempotency_key is not null;
create index if not exists voice_profiles_user_idx on public.voice_profiles (user_id, created_at desc);
create index if not exists voice_profiles_voice_lower_idx on public.voice_profiles (lower(provider_voice_id))
  where provider_voice_id is not null;

-- Who a profile belongs to never changes; a provider voice, once set, never moves; a deleted profile stays deleted; a profile
-- row is never deleted except by the documented purge function (a non-API role with the purge setting on).
create or replace function public.voice_profiles_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('nightshift.voice_purge', true) = 'on'
       and current_user not in ('anon', 'authenticated', 'service_role') then
      return old;
    end if;
    raise exception 'voice_profiles rows are not deleted: delete_voice() marks a voice deleted, purge_voice_records() removes the record'
      using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.owner_ref is distinct from old.owner_ref or new.org_id is distinct from old.org_id
     or new.created_at is distinct from old.created_at then
    raise exception 'voice_profiles: owner, organization and creation time never change' using errcode = '42501';
  end if;
  if old.provider_voice_id is not null
     and (new.provider_voice_id is distinct from old.provider_voice_id or new.provider is distinct from old.provider) then
    raise exception 'voice_profiles: a provider voice id never changes once set' using errcode = '42501';
  end if;
  if old.status = 'deleted' and new.status <> 'deleted' then
    raise exception 'voice_profiles: a deleted voice stays deleted' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists voice_profiles_guard on public.voice_profiles;
create trigger voice_profiles_guard
  before update or delete on public.voice_profiles
  for each row execute function public.voice_profiles_guard();

-- Append-only, for everyone, like credit_transactions (0020). The one exception is the purge function: a DELETE by a role that is
-- not an API role while the transaction-local purge setting is on. An API role can set the setting but cannot pass the role test,
-- and has no table privilege anyway. TRUNCATE is never allowed.
create or replace function public.voice_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' and tg_table_name = 'voice_consents'
     and current_setting('nightshift.voice_purge', true) = 'on'
     and current_user not in ('anon', 'authenticated', 'service_role') then
    return old;
  end if;
  raise exception '% is append-only: record a new row instead', tg_table_name using errcode = '42501';
end
$$;

create table if not exists public.voice_consents (
  id                     uuid primary key default gen_random_uuid(),
  voice_profile_id       uuid not null,
  user_id                uuid not null,
  -- accepted: the declarations at request time | verification: the worker's result (a new row: this table is append-only)
  kind                   text not null default 'accepted',
  consent_text_version   text not null,
  declarations           jsonb not null default '{}'::jsonb,
  verification_phrase_hash text,
  verification_result    text not null default 'pending',
  sample_sha256          text,
  accepted_at            timestamptz not null default now(),
  client_info            jsonb not null default '{}'::jsonb,
  constraint voice_consents_profile_fk foreign key (voice_profile_id, user_id)
    references public.voice_profiles (id, user_id),
  constraint voice_consents_kind_check check (kind in ('accepted', 'verification')),
  constraint voice_consents_version_check check (consent_text_version ~ '^v[0-9]{1,3}$'),
  constraint voice_consents_result_check check (verification_result in ('pending', 'passed', 'failed')),
  constraint voice_consents_phrase_hash check (verification_phrase_hash is null or verification_phrase_hash ~ '^[0-9a-f]{64}$'),
  constraint voice_consents_sample_hash check (sample_sha256 is null or sample_sha256 ~ '^[0-9a-f]{64}$'),
  constraint voice_consents_json_shape check (jsonb_typeof(declarations) = 'object' and jsonb_typeof(client_info) = 'object'
    and octet_length(declarations::text) <= 1024 and octet_length(client_info::text) <= 1024)
);
comment on table public.voice_consents is
  'The consent trail of a voice (migration 0117). APPEND-ONLY for every role; only purge_voice_records() may delete, and it leaves a minimal record in voice_deletion_records.';
create index if not exists voice_consents_profile_idx on public.voice_consents (voice_profile_id, accepted_at);
create index if not exists voice_consents_user_idx on public.voice_consents (user_id, accepted_at desc);

drop trigger if exists voice_consents_append_only on public.voice_consents;
create trigger voice_consents_append_only
  before update or delete on public.voice_consents
  for each row execute function public.voice_append_only();
drop trigger if exists voice_consents_no_truncate on public.voice_consents;
create trigger voice_consents_no_truncate
  before truncate on public.voice_consents
  for each statement execute function public.voice_append_only();

-- ENABLE ALWAYS: the append-only triggers also fire when a session sets session_replication_role = replica (which skips ordinary
-- triggers); only a superuser can set it, and this keeps even that from rewriting the trail.
alter table public.voice_consents enable always trigger voice_consents_append_only;
alter table public.voice_consents enable always trigger voice_consents_no_truncate;

-- What survives a deletion: no user id, no name, no declarations. owner_ref is a pseudonym that resolves to a person only while
-- user_voice_refs still has the row. Append-only, and never deletable (not even by the purge function).
create table if not exists public.voice_deletion_records (
  id                   uuid primary key default gen_random_uuid(),
  voice_profile_id     uuid not null,
  owner_ref            text not null,
  event                text not null,
  consent_text_version text,
  consent_accepted_at  timestamptz,
  sample_sha256        text,
  provider             text,
  provider_voice_id    text,
  at                   timestamptz not null default now(),
  constraint voice_deletion_records_event_check
    check (event in ('deleted', 'provider_deleted', 'sample_purged', 'purged')),
  constraint voice_deletion_records_ref check (owner_ref ~ '^[0-9a-f]{32}$')
);
comment on table public.voice_deletion_records is
  'Minimal, append-only record of a voice that was deleted (migration 0117). No user id: owner_ref is a pseudonym.';
create index if not exists voice_deletion_records_profile_idx on public.voice_deletion_records (voice_profile_id, at);
drop trigger if exists voice_deletion_records_append_only on public.voice_deletion_records;
create trigger voice_deletion_records_append_only
  before update or delete on public.voice_deletion_records
  for each row execute function public.voice_append_only();
drop trigger if exists voice_deletion_records_no_truncate on public.voice_deletion_records;
create trigger voice_deletion_records_no_truncate
  before truncate on public.voice_deletion_records
  for each statement execute function public.voice_append_only();

alter table public.voice_deletion_records enable always trigger voice_deletion_records_append_only;
alter table public.voice_deletion_records enable always trigger voice_deletion_records_no_truncate;

-- The worker's queue. Never readable through the API: the phrase of a pending verification is in it.
create table if not exists public.voice_clone_jobs (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.voice_profiles (id),
  user_id      uuid not null,
  kind         text not null,
  status       text not null default 'queued',
  phrase       text,
  attempts     integer not null default 0,
  max_attempts integer not null default 3,
  worker_id    text,
  heartbeat_at timestamptz,
  started_at   timestamptz,
  finished_at  timestamptz,
  error_code   text,
  created_at   timestamptz not null default now(),
  constraint voice_clone_jobs_kind_check check (kind in ('clone', 'delete_provider', 'purge_sample')),
  constraint voice_clone_jobs_status_check check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  constraint voice_clone_jobs_phrase_check check (phrase is null or (kind = 'clone' and phrase ~ '^[a-z ]{5,120}$')),
  constraint voice_clone_jobs_attempts_check check (attempts >= 0 and max_attempts between 1 and 10),
  constraint voice_clone_jobs_error_check check (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$'),
  constraint voice_clone_jobs_worker_check check (worker_id is null or char_length(worker_id) <= 120)
);
comment on table public.voice_clone_jobs is
  'The voice worker''s queue (migration 0117): clone, delete at the provider, purge the sample. No API role reads or writes it.';
create unique index if not exists voice_clone_jobs_one_live
  on public.voice_clone_jobs (profile_id, kind) where status in ('queued', 'running');
create index if not exists voice_clone_jobs_queue_idx on public.voice_clone_jobs (created_at) where status = 'queued';

create table if not exists public.voice_channel_attachments (
  id               uuid primary key default gen_random_uuid(),
  voice_profile_id uuid not null,
  user_id          uuid not null,
  org_id           uuid not null references public.organizations (id) on delete cascade,
  channel_id       text not null references public.channels (channel_id) on delete cascade,
  slot             text not null default 'narrator',
  status           text not null default 'active',
  attached_at      timestamptz not null default now(),
  revoked_at       timestamptz,
  constraint voice_attachments_profile_fk foreign key (voice_profile_id, user_id)
    references public.voice_profiles (id, user_id),
  constraint voice_attachments_slot_check check (slot in ('narrator', 'secondary')),
  constraint voice_attachments_status_check check (status in ('active', 'revoked')),
  constraint voice_attachments_revoked_at check ((status = 'revoked') = (revoked_at is not null))
);
comment on table public.voice_channel_attachments is
  'The owner''s explicit act of putting a voice on a channel (migration 0117). Written only by attach_voice_to_channel / detach_voice_from_channel / delete_voice.';
create unique index if not exists voice_attachments_one_active
  on public.voice_channel_attachments (voice_profile_id, channel_id, slot) where status = 'active';
create index if not exists voice_attachments_channel_idx
  on public.voice_channel_attachments (channel_id) where status = 'active';

-- The backfill: every existing user gets a reference now (idempotent). New users get theirs the first time they use a function
-- below; there is no trigger on auth.users anywhere in this repository and signup is done through RPCs.
insert into public.user_voice_refs (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. RLS: a member reads only their own rows; nobody writes through the API
-- ───────────────────────────────────────────────────────────────────────────

alter table public.user_voice_refs enable row level security;
alter table public.voice_profiles enable row level security;
alter table public.voice_consents enable row level security;
alter table public.voice_deletion_records enable row level security;
alter table public.voice_clone_jobs enable row level security;
alter table public.voice_channel_attachments enable row level security;

-- No privilege for any API role, the service key included; then the one read each owner has.
revoke all on public.user_voice_refs, public.voice_profiles, public.voice_consents, public.voice_deletion_records,
              public.voice_clone_jobs, public.voice_channel_attachments
  from public, anon, authenticated, service_role;
grant select on public.user_voice_refs, public.voice_profiles, public.voice_consents,
                public.voice_channel_attachments to authenticated;

drop policy if exists user_voice_refs_select on public.user_voice_refs;
create policy user_voice_refs_select on public.user_voice_refs
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists voice_profiles_select on public.voice_profiles;
create policy voice_profiles_select on public.voice_profiles
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists voice_consents_select on public.voice_consents;
create policy voice_consents_select on public.voice_consents
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists voice_attachments_select on public.voice_channel_attachments;
create policy voice_attachments_select on public.voice_channel_attachments
  for select to authenticated using (user_id = (select auth.uid()));

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Internal helpers (definer; no API role may execute them)
-- ───────────────────────────────────────────────────────────────────────────

-- The reference of a user, made the first time it is asked for.
create or replace function public.voice_owner_ref_for(p_user uuid) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r text;
begin
  insert into public.user_voice_refs (user_id) values (p_user) on conflict (user_id) do nothing;
  select owner_ref into r from public.user_voice_refs where user_id = p_user;
  return r;
end
$$;

-- Is p_user, as a real bound member, an administrator of p_org? In the operator's own organization a platform owner/admin is
-- (the roster), elsewhere only an org_members row counts: a platform administrator is not an administrator of a customer's
-- organization for this purpose (the rule of 0112's video_real_member, under its own name).
create or replace function public.voice_user_org_admin(p_user uuid, p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_user is not null and p_org is not null and (
    exists (select 1 from public.org_members m
             where m.org_id = p_org and m.user_id = p_user
               and public.app_role_rank(m.role) >= public.app_role_rank('admin'))
    or (p_org = public.default_org_id()
        and exists (select 1 from public.app_members a where a.user_id = p_user and a.role in ('owner', 'admin'))))
$$;

-- THE RULE. May this voice id be used here? TRUE when the id is in no voice_profiles row (the operator's own voices, exactly as
-- before). For a profile voice:
--   purpose 'use'   the profile must be 'approved', and either p_user is the owner, or p_channel names a channel the owner attached
--                   the voice to (an active attachment, in the channel's CURRENT organization, in p_slot when one is asked for,
--                   the owner still an administrator of that organization, and p_org, when given, that organization).
--   purpose 'test'  the owner only, while the profile is 'testing' or 'approved' (the Studio tts clip that precedes approval).
-- A deleted, rejected or pending profile is never usable. p_user NULL means "no person": only the channel path can pass.
create or replace function public.voice_usable_by(
  p_user uuid, p_voice text, p_org uuid, p_channel text, p_purpose text default 'use', p_slot text default null
) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  pr     public.voice_profiles;
  ch_org uuid;
  v      text := lower(regexp_replace(coalesce(p_voice, ''),
    '^[\u0009-\u000d\u001c- \u0085   -     　]+|[\u0009-\u000d\u001c- \u0085   -     　]+$',
    '', 'g'));
begin
  if v = '' then
    return true;
  end if;
  select * into pr from public.voice_profiles
   where lower(provider_voice_id) = v
   order by (status = 'deleted'), created_at
   limit 1;
  if not found then
    return true;
  end if;
  if p_purpose = 'test' then
    return p_user is not null and p_user = pr.user_id and pr.status in ('testing', 'approved');
  end if;
  if pr.status <> 'approved' then
    return false;
  end if;
  if p_user is not null and p_user = pr.user_id then
    return true;
  end if;
  if p_channel is null then
    return false;
  end if;
  select c.org_id into ch_org from public.channels c where c.channel_id = p_channel;
  if ch_org is null or (p_org is not null and p_org <> ch_org) then
    return false;
  end if;
  return exists (
    select 1 from public.voice_channel_attachments a
     where a.voice_profile_id = pr.id and a.channel_id = p_channel and a.status = 'active'
       and a.org_id = ch_org and (p_slot is null or a.slot = p_slot)
  ) and public.voice_user_org_admin(pr.user_id, ch_org);
end
$$;

-- Does this write of a channel's agent_config set a custom voice that is not attached here? Returns the key, or NULL. Asked by
-- channels_config_guard() for EVERY writer. A value that is unchanged passes (an unrelated edit of a channel that already has the
-- voice is not blocked; a run on it is, by render_jobs_voice_guard). Takes no user: the channel path alone decides.
create or replace function public.channel_voice_config_problem(p_channel text, p_org uuid, p_old jsonb, p_new jsonb)
  returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  k text;
  v text;
  o jsonb := case when jsonb_typeof(p_old) = 'object' then p_old else '{}'::jsonb end;
  n jsonb := case when jsonb_typeof(p_new) = 'object' then p_new else '{}'::jsonb end;
begin
  foreach k in array array['elevenlabs_voice_id', 'elevenlabs_secondary_voice_id'] loop
    if (o -> k) is not distinct from (n -> k) or not n ? k or jsonb_typeof(n -> k) = 'null' then
      continue;
    end if;
    -- A voice id is a JSON string. The reader would still turn a number (12345678901234567890 is a possible id) or a list into text
    -- and use it, so any other type, SET by this write, is refused outright.
    if jsonb_typeof(n -> k) <> 'string' then
      return k;
    end if;
    v := public.voice_id_norm(n -> k);
    if v is null then
      continue;
    end if;
    if not public.voice_usable_by(null, v, p_org, p_channel, 'use',
         case k when 'elevenlabs_voice_id' then 'narrator' else 'secondary' end) then
      return k;
    end if;
  end loop;
  return null;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The three entry guards
-- ───────────────────────────────────────────────────────────────────────────

-- 5a. creative_jobs (Studio tts and voice_change). A definer: it reads the closed tables whoever inserts.
create or replace function public.creative_jobs_voice_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v text := public.voice_id_norm(new.params -> 'voice_id');
begin
  if v is null then
    return new;
  end if;
  -- tts may be a TEST of a voice that is still 'testing' (owner only); any other use needs an approved voice.
  if not public.voice_usable_by(new.requested_by, v, new.org_id, null,
                                case when new.capability = 'tts' then 'test' else 'use' end) then
    raise exception 'voice_not_allowed: this voice belongs to someone else or is not available'
      using errcode = '42501', hint = 'voice_not_allowed';
  end if;
  return new;
end
$$;
drop trigger if exists creative_jobs_voice_guard on public.creative_jobs;
create trigger creative_jobs_voice_guard
  before insert on public.creative_jobs
  for each row execute function public.creative_jobs_voice_guard();

-- 5b. render_jobs (a run). The run's own voice_id, and, for a run that narrates, the channel's configured voices as they are NOW
-- (a voice attached earlier and deleted since stops the run before it spends anything). A repair re-renders footage only.
create or replace function public.render_jobs_voice_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v    text := public.voice_id_norm(new.params -> 'voice_id');
  org  uuid;
  cfg  jsonb;
  k    text;
  cv   text;
begin
  select c.org_id, c.agent_config into org, cfg from public.channels c where c.channel_id = new.channel_id;
  if v is not null and not public.voice_usable_by(new.requested_by, v, org, new.channel_id, 'use') then
    raise exception 'voice_not_allowed: this voice belongs to someone else or is not available'
      using errcode = '42501', hint = 'voice_not_allowed';
  end if;
  if new.kind <> 'repair' and jsonb_typeof(cfg) = 'object' then
    foreach k in array array['elevenlabs_voice_id', 'elevenlabs_secondary_voice_id'] loop
      if cfg ? k and jsonb_typeof(cfg -> k) not in ('string', 'null') then
        raise exception 'voice_not_allowed: the channel''s voice setting is not a voice id'
          using errcode = '42501', hint = 'voice_not_allowed';
      end if;
      cv := public.voice_id_norm(cfg -> k);
      if cv is not null and not public.voice_usable_by(null, cv, org, new.channel_id, 'use',
           case k when 'elevenlabs_voice_id' then 'narrator' else 'secondary' end) then
        raise exception 'voice_not_allowed: the channel''s custom voice is not attached to it any more'
          using errcode = '42501', hint = 'voice_not_allowed';
      end if;
    end loop;
  end if;
  return new;
end
$$;
drop trigger if exists render_jobs_voice_guard on public.render_jobs;
create trigger render_jobs_voice_guard
  before insert on public.render_jobs
  for each row execute function public.render_jobs_voice_guard();

-- 5c. channels_config_guard(): 0114's body verbatim (which is 0086's plus the lowering check) with ONE block added at the top,
-- marked 0117. It runs before the browser-only part, so it holds for the service key, the definer functions (set_channel_dna,
-- create_channel) and the SQL editor too. The 0086 trigger is NOT dropped or re-created (no lock on public.channels).
create or replace function public.channels_config_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  controls constant text[] := array['publish_gate', 'require_two_person_publish', 'storyboard_review', 'auto_publish'];
  k        text;
  changed  text[] := '{}';
  org      uuid;
  o        jsonb;
  n        jsonb := case when jsonb_typeof(new.agent_config) = 'object' then new.agent_config else '{}'::jsonb end;
  lowering text[];
  voice_key text;
  voice_old jsonb := '{}'::jsonb;
begin
  -- 0117: a custom (cloned) voice id may be SET on a channel only if its owner attached it there (attach_voice_to_channel). Every
  -- writer is held to it, whoever it is; a value that is not a custom voice is allowed exactly as before.
  if tg_op = 'UPDATE' and jsonb_typeof(old.agent_config) = 'object' then
    voice_old := old.agent_config;
  end if;
  voice_key := public.channel_voice_config_problem(new.channel_id, new.org_id, voice_old, n);
  if voice_key is not null then
    raise exception 'voice_not_allowed: % is a custom voice that its owner has not attached to this channel', voice_key
      using errcode = '42501', hint = 'voice_not_allowed';
  end if;
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    o := '{}'::jsonb;
    org := new.org_id;
    if new.auto_publish is true then
      changed := changed || 'auto_publish'::text;
    end if;
    if coalesce(new.credential_ref, '{}'::jsonb) <> '{}'::jsonb or new.status is distinct from 'PAUSED' then
      raise exception 'a channel is created paused with no credential: use create_channel()'
        using errcode = '42501';
    end if;
  else
    o := case when jsonb_typeof(old.agent_config) = 'object' then old.agent_config else '{}'::jsonb end;
    org := old.org_id;
    if new.auto_publish is distinct from old.auto_publish then
      changed := changed || 'auto_publish'::text;
    end if;
    if new.credential_ref is distinct from old.credential_ref
       or new.status is distinct from old.status
       or new.channel_id is distinct from old.channel_id then
      raise exception 'a channel''s credential, status and id are changed through the channel functions only'
        using errcode = '42501';
    end if;
  end if;
  foreach k in array controls loop
    if (o -> k) is distinct from (n -> k) and not k = any (changed) then
      changed := changed || k;
    end if;
  end loop;
  if cardinality(changed) > 0 and not public.is_org_member(org, 'admin') then
    raise exception 'only an administrator of this organization may change: %', array_to_string(changed, ', ')
      using errcode = '42501';
  end if;
  -- 0114: the two keys that lower the platform label are a PLATFORM administrator's. A key is refused only when
  -- this write SETS it to a value the reader treats as lowering and the stored value was not already that exact
  -- value, so an unrelated edit of a channel that already has one (or a write that raises the label) still passes.
  lowering := '{}';
  foreach k in array public.channel_label_lowering(n) loop
    if (o -> k) is distinct from (n -> k) then
      lowering := lowering || k;
    end if;
  end loop;
  if cardinality(lowering) > 0 and not public.is_platform_admin() then
    raise exception 'ai_disclosure_lock: only a platform administrator may set: %', array_to_string(lowering, ', ')
      using errcode = '42501', hint = 'ai_disclosure_lock';
  end if;
  return new;
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The owner's functions
-- ───────────────────────────────────────────────────────────────────────────

-- The signed-in person's own reference (made now if it does not exist yet).
create or replace function public.my_voice_ref() returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  return public.voice_owner_ref_for(uid);
end
$$;

-- A real, bound member of p_org with at least p_min (the caller's). Internal.
create or replace function public.voice_caller_member(p_org uuid, p_min text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_org is null or auth.uid() is null then false
    when p_org = public.default_org_id() then public.is_org_member(p_org, p_min)
    else exists (select 1 from public.org_members m
                  where m.org_id = p_org and m.user_id = auth.uid()
                    and public.app_role_rank(m.role) >= public.app_role_rank(p_min))
  end
$$;

-- Ask for a clone. Writes the request, the consent row and one queue row, and STOPS: it calls no provider (CLAUDE.md rule 3).
-- Idempotent on p_idem; 5 requests per person per rolling day and 3 live voices per person (the provider's voice slots are the
-- operator's). Returns the phrase to read aloud (made here, never taken from the caller), the upload prefix and when the request
-- lapses. The recording is uploaded to <user_id>/<profile_id>/sample.<ext> in the voice-samples bucket.
create or replace function public.request_voice_clone(
  p_name text, p_declarations jsonb, p_consent_version text, p_keep_sample boolean, p_idem text, p_org uuid default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  daily   constant integer := 5;
  slots   constant integer := 3;
  idem    text := nullif(btrim(coalesce(p_idem, '')), '');
  nm      text := regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  keep    boolean := coalesce(p_keep_sample, false);
  org     uuid := p_org;
  n_orgs  integer;
  problem text;
  hash_   text;
  prior   public.voice_profiles;
  pid     uuid := gen_random_uuid();
  ref     text;
  phrase  text;
  ua      text;
  headers jsonb;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- One request at a time per person: the limits and the replay check below cannot race.
  perform pg_advisory_xact_lock(hashtext('nightshift.voice_clone:' || uid::text));
  if idem is null or idem !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    raise exception 'voice_request: an idempotency key of 1-255 characters (A-Z a-z 0-9 _ : . -) is required'
      using errcode = '22023', hint = 'idem_required';
  end if;
  problem := public.voice_name_problem(nm);
  if problem is not null then
    raise exception 'voice_request: the name was refused (%)', problem using errcode = '22023', hint = problem;
  end if;
  problem := public.voice_declarations_problem(p_declarations);
  if problem is not null then
    raise exception 'voice_request: every declaration must be made (%)', problem using errcode = '22023', hint = problem;
  end if;
  if coalesce(p_consent_version, '') !~ '^v[0-9]{1,3}$' then
    raise exception 'voice_request: unknown consent text version' using errcode = '22023', hint = 'consent_version';
  end if;

  -- The organization the voice is requested in: the one the caller is a real editor of.
  if org is null then
    select count(*), min(m.org_id::text)::uuid into n_orgs, org
      from public.org_members m
     where m.user_id = uid and public.app_role_rank(m.role) >= public.app_role_rank('editor');
    if n_orgs = 0 and public.is_platform_admin() then
      org := public.default_org_id();
    elsif n_orgs <> 1 then
      raise exception 'voice_request: name the organization' using errcode = '22023', hint = 'org_required';
    end if;
  end if;
  if not public.voice_caller_member(org, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  hash_ := md5(jsonb_build_object('name', nm, 'declarations', p_declarations, 'version', p_consent_version,
                                  'keep', keep, 'org', org)::text);
  select * into prior from public.voice_profiles where user_id = uid and idempotency_key = idem;
  if found then
    if prior.request_hash is distinct from hash_ then
      raise exception 'this idempotency key was used for a different request' using errcode = 'NS409';
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'profile_id', prior.id, 'status', prior.status, 'owner_ref', prior.owner_ref,
      'upload_prefix', uid::text || '/' || prior.id::text || '/',
      'phrase', (select j.phrase from public.voice_clone_jobs j
                  where j.profile_id = prior.id and j.kind = 'clone' and j.status in ('queued', 'running')
                  order by j.created_at desc limit 1),
      'expires_at', prior.created_at + interval '2 hours');
  end if;

  if (select count(*) from public.voice_profiles p
       where p.user_id = uid and p.created_at > now() - interval '1 day') >= daily then
    raise exception 'voice_request: at most % voice requests a day', daily using errcode = 'NS429', hint = 'rate_limited';
  end if;
  if (select count(*) from public.voice_profiles p
       where p.user_id = uid and p.status in ('pending_verification', 'testing', 'approved')) >= slots then
    raise exception 'voice_request: at most % voices at a time; delete one first', slots
      using errcode = 'NS429', hint = 'voice_slots';
  end if;

  ref := public.voice_owner_ref_for(uid);
  phrase := public.voice_phrase_new();
  begin
    headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    headers := null;
  end;
  ua := left(coalesce(headers ->> 'user-agent', ''), 160);

  insert into public.voice_profiles (id, user_id, org_id, owner_ref, name, keep_sample, idempotency_key, request_hash)
  values (pid, uid, org, ref, nm, keep, idem, hash_);
  insert into public.voice_consents
    (voice_profile_id, user_id, kind, consent_text_version, declarations, verification_phrase_hash,
     verification_result, client_info)
  values
    (pid, uid, 'accepted', p_consent_version, p_declarations, public.voice_phrase_hash(phrase), 'pending',
     case when ua = '' then '{}'::jsonb else jsonb_build_object('user_agent', ua) end);
  insert into public.voice_clone_jobs (profile_id, user_id, kind, phrase) values (pid, uid, 'clone', phrase);
  insert into public.app_audit_log (actor_user_id, action, target, detail)
  values (uid, 'voice.clone_request', pid::text,
          jsonb_build_object('profile_id', pid, 'keep_sample', keep, 'consent_version', p_consent_version, 'org_id', org));

  return jsonb_build_object(
    'ok', true, 'replay', false, 'profile_id', pid, 'status', 'pending_verification', 'owner_ref', ref,
    'upload_prefix', uid::text || '/' || pid::text || '/', 'phrase', phrase,
    'expires_at', now() + interval '2 hours');
end
$$;

-- Approve a voice after the owner has heard it: owner only, 'testing' only, and only after a Studio tts clip made with this voice
-- by this person has completed (the test), and the worker's verification passed. Answers {ok: true} or {ok: false, error: word}.
create or replace function public.approve_voice(p_profile uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  pr  public.voice_profiles;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into pr from public.voice_profiles where id = p_profile and user_id = uid for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if pr.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true, 'status', 'approved');
  end if;
  if pr.status <> 'testing' or pr.provider_voice_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_testing');
  end if;
  if not exists (select 1 from public.voice_consents c
                  where c.voice_profile_id = pr.id and c.kind = 'verification' and c.verification_result = 'passed') then
    return jsonb_build_object('ok', false, 'error', 'not_verified');
  end if;
  if not exists (select 1 from public.creative_jobs j
                  where j.requested_by = uid and j.capability = 'tts' and j.status = 'completed'
                    and lower(btrim(j.params ->> 'voice_id')) = lower(pr.provider_voice_id)
                    and j.created_at >= pr.created_at) then
    return jsonb_build_object('ok', false, 'error', 'not_tested');
  end if;
  update public.voice_profiles set status = 'approved', approved_at = now() where id = pr.id;
  insert into public.app_audit_log (actor_user_id, action, target, detail)
  values (uid, 'voice.approve', pr.id::text, jsonb_build_object('profile_id', pr.id));
  return jsonb_build_object('ok', true, 'already', false, 'status', 'approved');
end
$$;

-- Put an approved voice on a channel. Only the voice's owner, who must also be a real administrator (or owner) of the channel's
-- organization. Writes the attachment, then the channel's voice key through the same guard 0114 uses, and records
-- ai_disclosure_voice = 'own_clone' (the only way it is recorded for a non-platform administrator). One audit row.
-- Note: channels_elevenlabs_voice_unique (0005) allows one channel per ElevenLabs narrator voice.
create or replace function public.attach_voice_to_channel(p_profile uuid, p_channel text, p_slot text default 'narrator')
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid    uuid := auth.uid();
  pr     public.voice_profiles;
  ch     public.channels;
  k      text;
  att_id uuid;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_slot not in ('narrator', 'secondary') then
    raise exception 'slot must be narrator or secondary' using errcode = '22023';
  end if;
  select * into pr from public.voice_profiles where id = p_profile and user_id = uid;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into ch from public.channels where channel_id = p_channel;
  if not found or not public.voice_caller_member(ch.org_id, 'admin') then
    -- A channel the caller cannot administer reads as missing to a stranger, as forbidden to a member.
    if found and public.voice_caller_member(ch.org_id, 'viewer') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into ch from public.channels where channel_id = p_channel for update;
  select * into pr from public.voice_profiles where id = p_profile and user_id = uid for share;
  if pr.status <> 'approved' then
    return jsonb_build_object('ok', false, 'error', 'not_approved');
  end if;
  k := case p_slot when 'narrator' then 'elevenlabs_voice_id' else 'elevenlabs_secondary_voice_id' end;
  select a.id into att_id from public.voice_channel_attachments a
   where a.voice_profile_id = pr.id and a.channel_id = ch.channel_id and a.slot = p_slot and a.status = 'active';
  begin
    if att_id is null then
      insert into public.voice_channel_attachments (voice_profile_id, user_id, org_id, channel_id, slot)
      values (pr.id, uid, ch.org_id, ch.channel_id, p_slot)
      returning id into att_id;
    end if;
    update public.channels
       set agent_config = coalesce(case when jsonb_typeof(agent_config) = 'object' then agent_config end, '{}'::jsonb)
                          || jsonb_build_object(k, pr.provider_voice_id)
                          -- A declaration that is not 'generic' or 'own_clone' (real_person, or a typo, which the reader reads as
                          -- real_person) is the platform's or an administrator's stricter statement: it is kept, never lowered here.
                          || case when agent_config ? 'ai_disclosure_voice'
                                   and coalesce(public.ai_disclosure_norm(agent_config -> 'ai_disclosure_voice'), '') not in ('generic', 'own_clone')
                                  then '{}'::jsonb
                                  else jsonb_build_object('ai_disclosure_voice', 'own_clone') end,
           updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     where channel_id = ch.channel_id;
  exception when unique_violation then
    -- The block's insert is undone with it.
    return jsonb_build_object('ok', false, 'error', 'voice_in_use');
  end;
  insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
  values (uid, 'voice.attach', pr.id::text,
          jsonb_build_object('profile_id', pr.id, 'channel_id', ch.channel_id, 'slot', p_slot, 'attachment_id', att_id),
          ch.channel_id);
  return jsonb_build_object('ok', true, 'attachment_id', att_id, 'channel_id', ch.channel_id, 'slot', p_slot,
                            'ai_disclosure_voice', (select c.agent_config -> 'ai_disclosure_voice' from public.channels c
                                                     where c.channel_id = ch.channel_id));
end
$$;

-- Take a voice off a channel (the owner's act). The channel's config keeps the id: a run on it is then refused at queue time
-- (CLAUDE.md rule 4: no video is the better failure) until someone picks another voice.
create or replace function public.detach_voice_from_channel(p_profile uuid, p_channel text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  n   integer;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.voice_profiles where id = p_profile and user_id = uid) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.voice_channel_attachments
     set status = 'revoked', revoked_at = now()
   where voice_profile_id = p_profile and channel_id = p_channel and status = 'active';
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.app_audit_log (actor_user_id, action, target, detail, channel_id)
    values (uid, 'voice.detach', p_profile::text, jsonb_build_object('profile_id', p_profile, 'channel_id', p_channel), p_channel);
  end if;
  return jsonb_build_object('ok', true, 'detached', n);
end
$$;

-- Delete a voice: owner only. Marks it deleted (unusable at once), takes it off every channel, queues the deletion at the provider
-- and the purge of the sample, and keeps a minimal record. Idempotent. The provider and the object are the worker's to remove.
create or replace function public.delete_voice(p_profile uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid     uuid := auth.uid();
  pr      public.voice_profiles;
  c       public.voice_consents;
  q_prov  boolean := false;
  q_samp  boolean := false;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into pr from public.voice_profiles where id = p_profile and user_id = uid for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if pr.status = 'deleted' then
    return jsonb_build_object('ok', true, 'already', true, 'status', 'deleted');
  end if;
  select * into c from public.voice_consents where voice_profile_id = pr.id and kind = 'accepted'
   order by accepted_at limit 1;
  update public.voice_profiles set status = 'deleted', deleted_at = now() where id = pr.id;
  update public.voice_channel_attachments set status = 'revoked', revoked_at = now()
   where voice_profile_id = pr.id and status = 'active';
  -- A clone that has not started will never start. One that is running is finished by finish_voice_clone, which queues the
  -- provider deletion if a voice came out of it.
  update public.voice_clone_jobs set status = 'cancelled', finished_at = now()
   where profile_id = pr.id and kind = 'clone' and status = 'queued';
  if pr.provider_voice_id is not null then
    insert into public.voice_clone_jobs (profile_id, user_id, kind) values (pr.id, uid, 'delete_provider')
    on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
    q_prov := true;
  end if;
  if pr.sample_state <> 'purged' then
    update public.voice_profiles set sample_state = 'purge_pending' where id = pr.id;
    insert into public.voice_clone_jobs (profile_id, user_id, kind) values (pr.id, uid, 'purge_sample')
    on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
    q_samp := true;
  end if;
  insert into public.voice_deletion_records
    (voice_profile_id, owner_ref, event, consent_text_version, consent_accepted_at, sample_sha256, provider, provider_voice_id)
  values (pr.id, pr.owner_ref, 'deleted', c.consent_text_version, c.accepted_at, pr.sample_sha256, pr.provider, pr.provider_voice_id);
  insert into public.app_audit_log (actor_user_id, action, target, detail)
  values (uid, 'voice.delete', pr.id::text,
          jsonb_build_object('profile_id', pr.id, 'provider_delete_queued', q_prov, 'sample_purge_queued', q_samp));
  return jsonb_build_object('ok', true, 'already', false, 'status', 'deleted',
                            'provider_delete_queued', q_prov, 'sample_purge_queued', q_samp);
end
$$;

-- Delete only the raw sample of a voice the owner keeps (keep_sample = true): the owner decides, at any time. The worker removes
-- the object. The voice itself is untouched.
create or replace function public.delete_voice_sample(p_profile uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  pr  public.voice_profiles;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into pr from public.voice_profiles where id = p_profile and user_id = uid for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if pr.sample_state = 'purged' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  update public.voice_profiles set sample_state = 'purge_pending' where id = pr.id;
  insert into public.voice_clone_jobs (profile_id, user_id, kind) values (pr.id, uid, 'purge_sample')
  on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
  insert into public.app_audit_log (actor_user_id, action, target, detail)
  values (uid, 'voice.sample_delete', pr.id::text, jsonb_build_object('profile_id', pr.id));
  return jsonb_build_object('ok', true, 'already', false);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. The worker's functions (service role only)
-- ───────────────────────────────────────────────────────────────────────────

-- Hand out the oldest job that can run. First: a clone request nobody uploaded a sample for within 2 hours lapses (the profile is
-- rejected); a running job whose lease is older than 30 minutes goes back to the queue, or fails once its attempts are spent. A
-- clone job is handed out only once its sample object exists in the bucket. Returns NULL when there is nothing to do.
create or replace function public.claim_voice_job(p_worker text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j      public.voice_clone_jobs;
  pr     public.voice_profiles;
  w      text := nullif(btrim(coalesce(p_worker, '')), '');
  path_  text;
begin
  if w is null or char_length(w) > 120 then
    raise exception 'a worker name is required' using errcode = '22023';
  end if;
  -- lapse
  update public.voice_profiles p set status = 'rejected', reject_reason = 'sample_timeout'
   where p.status = 'pending_verification'
     and exists (select 1 from public.voice_clone_jobs q
                  where q.profile_id = p.id and q.kind = 'clone' and q.status = 'queued'
                    and q.created_at < now() - interval '2 hours')
     and not exists (select 1 from storage.objects o where o.bucket_id = 'voice-samples'
                      and o.name like p.user_id::text || '/' || p.id::text || '/sample.%');
  update public.voice_clone_jobs q set status = 'expired', finished_at = now(), error_code = 'sample_timeout'
   where q.kind = 'clone' and q.status = 'queued' and q.created_at < now() - interval '2 hours'
     and exists (select 1 from public.voice_profiles p where p.id = q.profile_id and p.status = 'rejected');
  -- lost workers
  update public.voice_clone_jobs q
     set status = case when q.attempts < q.max_attempts then 'queued' else 'failed' end,
         worker_id = null,
         finished_at = case when q.attempts < q.max_attempts then null else now() end,
         error_code = case when q.attempts < q.max_attempts then q.error_code else 'worker_lost' end
   where q.status = 'running' and q.heartbeat_at < now() - interval '30 minutes';
  -- A clone lost three times is rejected and its recording (a biometric sample) is queued for removal, never left behind.
  with lost as (
    update public.voice_profiles p set status = 'rejected', reject_reason = 'worker_lost', sample_state = 'purge_pending'
     where p.status = 'pending_verification'
       and exists (select 1 from public.voice_clone_jobs q
                    where q.profile_id = p.id and q.kind = 'clone' and q.status = 'failed' and q.error_code = 'worker_lost')
    returning p.id, p.user_id
  )
  insert into public.voice_clone_jobs (profile_id, user_id, kind)
  select l.id, l.user_id, 'purge_sample' from lost l
  on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;

  select q.* into j
    from public.voice_clone_jobs q
    join public.voice_profiles p on p.id = q.profile_id
   where q.status = 'queued'
     and (q.kind <> 'clone' or (p.status = 'pending_verification' and exists (
            select 1 from storage.objects o where o.bucket_id = 'voice-samples'
               and o.name like p.user_id::text || '/' || p.id::text || '/sample.%')))
   order by q.created_at
   limit 1
   for update of q skip locked;
  if not found then
    return null;
  end if;
  select * into pr from public.voice_profiles where id = j.profile_id;
  update public.voice_clone_jobs
     set status = 'running', attempts = attempts + 1, worker_id = w, heartbeat_at = now(),
         started_at = coalesce(started_at, now())
   where id = j.id
  returning * into j;
  if j.kind = 'clone' then
    select o.name into path_ from public.voice_profiles p2, storage.objects o
     where p2.id = pr.id and o.bucket_id = 'voice-samples'
       and o.name like p2.user_id::text || '/' || p2.id::text || '/sample.%'
     order by o.created_at limit 1;
    update public.voice_profiles set sample_state = 'stored' where id = pr.id and sample_state = 'awaiting';
  end if;
  return jsonb_build_object(
    'job_id', j.id, 'kind', j.kind, 'attempts', j.attempts, 'profile_id', pr.id, 'user_id', pr.user_id,
    'owner_ref', pr.owner_ref, 'status', pr.status, 'keep_sample', pr.keep_sample,
    'sample_path', path_, 'sample_prefix', pr.user_id::text || '/' || pr.id::text || '/',
    'phrase', j.phrase, 'provider', pr.provider, 'provider_voice_id', pr.provider_voice_id);
end
$$;

-- The worker's answer for a CLONE job. p_verification is 'passed' or 'failed' (the read-aloud check); p_error_code is a closed word
-- for a provider or system failure ('transient' goes back in the queue while attempts remain). On a pass: the profile becomes
-- 'testing' with its provider voice id (UNIQUE) and sample hash, a verification row is appended to the consent trail, and, unless
-- the owner chose to keep the sample, its purge is queued (the worker deletes the object: see the header). On a failure the
-- profile is rejected and the sample purged. A voice the owner deleted while the clone was running is recorded and its provider
-- deletion is queued. Answers {ok: true, ...} or {ok: false, error: word}.
create or replace function public.finish_voice_clone(
  p_job uuid, p_worker text, p_verification text, p_provider text, p_voice_id text, p_sample_sha256 text,
  p_error_code text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j       public.voice_clone_jobs;
  pr      public.voice_profiles;
  c       public.voice_consents;
  err     text := nullif(btrim(coalesce(p_error_code, '')), '');
  deleted boolean;
begin
  select * into j from public.voice_clone_jobs where id = p_job for update;
  if not found or j.kind <> 'clone' then
    return jsonb_build_object('ok', false, 'error', 'no_such_job');
  end if;
  if j.status <> 'running' or j.worker_id is distinct from p_worker then
    return jsonb_build_object('ok', false, 'error', 'not_holder');
  end if;
  select * into pr from public.voice_profiles where id = j.profile_id for update;
  deleted := pr.status = 'deleted';
  select * into c from public.voice_consents where voice_profile_id = pr.id and kind = 'accepted'
   order by accepted_at limit 1;

  if err is not null then
    if err !~ '^[a-z0-9_]{1,64}$' then
      return jsonb_build_object('ok', false, 'error', 'bad_error_code');
    end if;
    if err = 'transient' and j.attempts < j.max_attempts and not deleted then
      update public.voice_clone_jobs set status = 'queued', worker_id = null, error_code = 'transient' where id = j.id;
      return jsonb_build_object('ok', true, 'retry', true);
    end if;
    update public.voice_clone_jobs set status = 'failed', finished_at = now(), error_code = err where id = j.id;
    if not deleted then
      update public.voice_profiles set status = 'rejected', reject_reason = err, sample_state = 'purge_pending' where id = pr.id;
    end if;
    if pr.sample_state <> 'purged' then
      insert into public.voice_clone_jobs (profile_id, user_id, kind) values (pr.id, pr.user_id, 'purge_sample')
      on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
    end if;
    insert into public.app_audit_log (action, target, detail)
    values ('voice.clone_result', pr.id::text, jsonb_build_object('profile_id', pr.id, 'result', 'failed', 'error', err));
    return jsonb_build_object('ok', true, 'status', case when deleted then 'deleted' else 'rejected' end);
  end if;

  if p_verification not in ('passed', 'failed') then
    return jsonb_build_object('ok', false, 'error', 'bad_verification');
  end if;
  if p_sample_sha256 is null or p_sample_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_sample_hash');
  end if;
  insert into public.voice_consents
    (voice_profile_id, user_id, kind, consent_text_version, declarations, verification_phrase_hash,
     verification_result, sample_sha256)
  values (pr.id, pr.user_id, 'verification', c.consent_text_version, '{}'::jsonb, c.verification_phrase_hash,
          p_verification, p_sample_sha256);

  if p_verification = 'failed' then
    update public.voice_clone_jobs set status = 'failed', finished_at = now(), error_code = 'verification_failed' where id = j.id;
    if not deleted then
      update public.voice_profiles
         set status = 'rejected', reject_reason = 'verification_failed', sample_sha256 = p_sample_sha256,
             sample_state = 'purge_pending'
       where id = pr.id;
    end if;
    insert into public.voice_clone_jobs (profile_id, user_id, kind) values (pr.id, pr.user_id, 'purge_sample')
    on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
    insert into public.app_audit_log (action, target, detail)
    values ('voice.clone_result', pr.id::text, jsonb_build_object('profile_id', pr.id, 'result', 'verification_failed'));
    return jsonb_build_object('ok', true, 'status', case when deleted then 'deleted' else 'rejected' end);
  end if;

  if p_provider is distinct from 'elevenlabs' or p_voice_id is null or p_voice_id !~ '^[A-Za-z0-9]{20}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_voice');
  end if;
  begin
    update public.voice_profiles
       set provider = p_provider, provider_voice_id = p_voice_id, sample_sha256 = p_sample_sha256,
           status = case when deleted then 'deleted' else 'testing' end,
           sample_state = case when pr.keep_sample and not deleted then pr.sample_state else 'purge_pending' end
     where id = pr.id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'voice_id_taken');
  end;
  update public.voice_clone_jobs set status = 'succeeded', finished_at = now() where id = j.id;
  if not (pr.keep_sample and not deleted) then
    insert into public.voice_clone_jobs (profile_id, user_id, kind) values (pr.id, pr.user_id, 'purge_sample')
    on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
  end if;
  if deleted then
    -- The owner deleted the voice while it was being made: the provider's copy must go.
    insert into public.voice_clone_jobs (profile_id, user_id, kind) values (pr.id, pr.user_id, 'delete_provider')
    on conflict (profile_id, kind) where status in ('queued', 'running') do nothing;
  end if;
  insert into public.app_audit_log (action, target, detail)
  values ('voice.clone_result', pr.id::text,
          jsonb_build_object('profile_id', pr.id, 'result', 'cloned', 'deleted_meanwhile', deleted));
  return jsonb_build_object('ok', true, 'status', case when deleted then 'deleted' else 'testing' end,
                            'sample_purge_queued', not (pr.keep_sample and not deleted));
end
$$;

-- The worker's answer for a delete_provider or purge_sample job. p_ok true: the provider copy is gone / the object is deleted (the
-- profile's sample_state becomes 'purged'; a record is appended). p_ok false: a closed error word; the job is retried while attempts
-- remain.
create or replace function public.finish_voice_task(p_job uuid, p_worker text, p_ok boolean, p_error_code text default null)
  returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  j   public.voice_clone_jobs;
  pr  public.voice_profiles;
  c   public.voice_consents;
  err text := nullif(btrim(coalesce(p_error_code, '')), '');
begin
  select * into j from public.voice_clone_jobs where id = p_job for update;
  if not found or j.kind not in ('delete_provider', 'purge_sample') then
    return jsonb_build_object('ok', false, 'error', 'no_such_job');
  end if;
  if j.status <> 'running' or j.worker_id is distinct from p_worker then
    return jsonb_build_object('ok', false, 'error', 'not_holder');
  end if;
  select * into pr from public.voice_profiles where id = j.profile_id for update;
  if coalesce(p_ok, false) then
    update public.voice_clone_jobs set status = 'succeeded', finished_at = now(), error_code = null where id = j.id;
    if j.kind = 'purge_sample' then
      update public.voice_profiles set sample_state = 'purged' where id = pr.id;
    end if;
    select * into c from public.voice_consents where voice_profile_id = pr.id and kind = 'accepted'
     order by accepted_at limit 1;
    insert into public.voice_deletion_records
      (voice_profile_id, owner_ref, event, consent_text_version, consent_accepted_at, sample_sha256, provider, provider_voice_id)
    values (pr.id, pr.owner_ref, case j.kind when 'purge_sample' then 'sample_purged' else 'provider_deleted' end,
            c.consent_text_version, c.accepted_at, pr.sample_sha256, pr.provider, pr.provider_voice_id);
    return jsonb_build_object('ok', true);
  end if;
  if err is null or err !~ '^[a-z0-9_]{1,64}$' then
    err := 'failed';
  end if;
  if j.attempts < j.max_attempts then
    update public.voice_clone_jobs set status = 'queued', worker_id = null, error_code = err where id = j.id;
    return jsonb_build_object('ok', true, 'retry', true);
  end if;
  update public.voice_clone_jobs set status = 'failed', finished_at = now(), error_code = err where id = j.id;
  return jsonb_build_object('ok', true, 'failed', true);
end
$$;

-- The documented purge: removes a DELETED voice's record from the database once the provider copy and the sample are gone,
-- keeping voice_deletion_records. Run by the operator after the retention period counsel sets (open decision, docs/CUSTOM_VOICE.md);
-- nothing calls it by itself. Refuses while the provider deletion or the sample purge is outstanding.
create or replace function public.purge_voice_records(p_profile uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  pr public.voice_profiles;
  c  public.voice_consents;
begin
  select * into pr from public.voice_profiles where id = p_profile for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_such_voice');
  end if;
  if pr.status <> 'deleted' then
    return jsonb_build_object('ok', false, 'error', 'not_deleted');
  end if;
  if pr.sample_state not in ('purged', 'awaiting') then
    return jsonb_build_object('ok', false, 'error', 'sample_outstanding');
  end if;
  if pr.provider_voice_id is not null and not exists (
       select 1 from public.voice_clone_jobs q
        where q.profile_id = pr.id and q.kind = 'delete_provider' and q.status = 'succeeded') then
    return jsonb_build_object('ok', false, 'error', 'provider_delete_outstanding');
  end if;
  if exists (select 1 from public.voice_clone_jobs q where q.profile_id = pr.id and q.status in ('queued', 'running')) then
    return jsonb_build_object('ok', false, 'error', 'job_outstanding');
  end if;
  select * into c from public.voice_consents where voice_profile_id = pr.id and kind = 'accepted'
   order by accepted_at limit 1;
  insert into public.voice_deletion_records
    (voice_profile_id, owner_ref, event, consent_text_version, consent_accepted_at, sample_sha256, provider, provider_voice_id)
  values (pr.id, pr.owner_ref, 'purged', c.consent_text_version, c.accepted_at, pr.sample_sha256, pr.provider, pr.provider_voice_id);
  perform set_config('nightshift.voice_purge', 'on', true);
  delete from public.voice_consents where voice_profile_id = pr.id;
  delete from public.voice_channel_attachments where voice_profile_id = pr.id;
  delete from public.voice_clone_jobs where profile_id = pr.id;
  delete from public.voice_profiles where id = pr.id;
  perform set_config('nightshift.voice_purge', 'off', true);
  insert into public.app_audit_log (action, target, detail)
  values ('voice.purge', pr.id::text, jsonb_build_object('profile_id', pr.id));
  return jsonb_build_object('ok', true);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Grants: revoke from everyone, then grant narrowly
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.voice_real_person_patterns() from public, anon, authenticated, service_role;
revoke all on function public.voice_name_norm(text) from public, anon, authenticated, service_role;
revoke all on function public.voice_name_problem(text) from public, anon, authenticated, service_role;
revoke all on function public.voice_declarations_problem(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.voice_phrase_words() from public, anon, authenticated, service_role;
revoke all on function public.voice_phrase_new() from public, anon, authenticated, service_role;
revoke all on function public.voice_phrase_hash(text) from public, anon, authenticated, service_role;
revoke all on function public.voice_id_norm(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.voice_owner_ref_for(uuid) from public, anon, authenticated, service_role;
revoke all on function public.voice_user_org_admin(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.voice_usable_by(uuid, text, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.voice_caller_member(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.channel_voice_config_problem(text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.creative_jobs_voice_guard() from public, anon, authenticated, service_role;
revoke all on function public.render_jobs_voice_guard() from public, anon, authenticated, service_role;
revoke all on function public.channels_config_guard() from public, anon, authenticated, service_role;
revoke all on function public.user_voice_refs_immutable() from public, anon, authenticated, service_role;
revoke all on function public.voice_profiles_guard() from public, anon, authenticated, service_role;
revoke all on function public.voice_append_only() from public, anon, authenticated, service_role;
revoke all on function public.my_voice_ref() from public, anon, authenticated, service_role;
revoke all on function public.request_voice_clone(text, jsonb, text, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.approve_voice(uuid) from public, anon, authenticated, service_role;
revoke all on function public.attach_voice_to_channel(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.detach_voice_from_channel(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_voice(uuid) from public, anon, authenticated, service_role;
revoke all on function public.delete_voice_sample(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_voice_job(text) from public, anon, authenticated, service_role;
revoke all on function public.finish_voice_clone(uuid, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_voice_task(uuid, text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.purge_voice_records(uuid) from public, anon, authenticated, service_role;

-- The channels guard runs as the caller (security invoker, as in 0086), so the caller must be able to ask this one question.
grant execute on function public.channel_voice_config_problem(text, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.my_voice_ref() to authenticated;
-- request_voice_clone(): deliberately NOT granted (B1 of the security review). The grant to `authenticated` ships in the migration that
-- ships the worker and the UI; see docs/CUSTOM_VOICE.md, "Hard gate". Tests create profiles as the database owner carrying the
-- person's claims.
grant execute on function public.approve_voice(uuid) to authenticated;
grant execute on function public.attach_voice_to_channel(uuid, text, text) to authenticated;
grant execute on function public.detach_voice_from_channel(uuid, text) to authenticated;
grant execute on function public.delete_voice(uuid) to authenticated;
grant execute on function public.delete_voice_sample(uuid) to authenticated;
grant execute on function public.claim_voice_job(text) to service_role;
grant execute on function public.finish_voice_clone(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.finish_voice_task(uuid, text, boolean, text) to service_role;
grant execute on function public.purge_voice_records(uuid) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. The audit list: 0116's body verbatim plus the voice names
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.audit_action_allowed(p_action text) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_action, '') = any (array[
    'agent.run', 'api.activate', 'api.monthly_limit', 'api.topup_checkout', 'api_key.access', 'api_key.create',
    'api_key.revoke', 'billing.portal', 'billing.refresh', 'billing.settings', 'billing.topup', 'captions.delete',
    'channel.dna.update', 'channel.youtube.connect', 'channel.youtube.connect_failed', 'channel.youtube.disconnect',
    'character.create', 'character.delete', 'character.update', 'creative.cancel', 'creative.generate',
    'editor.export_request', 'editor.project_create', 'editor.project_delete', 'editor.send_asset',
    'media.delete', 'media.folder_create', 'media.folder_delete', 'media.folder_rename', 'media.move',
    'media.upload_request', 'model.availability', 'scene.regenerate', 'secret.write', 'series.create',
    'series.update', 'storyboard.approve', 'storyboard.discard', 'storyboard.edit', 'storyboard.reopen',
    'style_kit.add_library', 'style_kit.attach', 'style_kit.create', 'style_kit.delete', 'style_kit.detach',
    'style_kit.update', 'variable.write', 'video.download_request', 'video.publish_request', 'video.repurpose',
    'workflow.cancel', 'workflow.delete', 'workflow.run', 'workflow.save',
    -- 0093: connecting, disconnecting and re-limiting an AI app (oauth_* functions).
    'mcp.connect', 'mcp.disconnect', 'mcp.disconnect_all', 'mcp.limit',
    -- 0107: the owner actions (owner_* functions) and the second-factor gate.
    'credits.grant', 'credits.reverse', 'credits.price', 'member.add', 'member.role', 'member.remove', 'security.gate',
    -- 0108: the brand-channel posts (owner_marketing_*, the poster worker) and the showcase marking (later).
    'marketing.edit', 'marketing.approve', 'marketing.reject', 'marketing.send', 'marketing.fail', 'marketing.kill',
    'showcase.mark', 'showcase.revoke',
    -- 0110: the owner types a post (owner_marketing_create).
    'marketing.create',
    -- 0112: a person approves the exact cut of an uploaded video (approve_video_publish).
    'video.approve',
    -- 0116: the per-channel switch, a queued request, the worker's results, a person's retry.
    'channel.publish_on_approve', 'video.publish_queued', 'video.visibility_applied', 'video.visibility_refused',
    'video.visibility_failed', 'video.visibility_expired', 'video.visibility_retry',
    -- 0117: a custom voice (request, the worker's result, approve, attach, detach, delete, sample delete, purge).
    'voice.clone_request', 'voice.clone_result', 'voice.approve', 'voice.attach', 'voice.detach', 'voice.delete',
    'voice.sample_delete', 'voice.purge',
    -- The comment inbox (0081, in review when this was written): its routes audit
    -- through their own helper, auditInbox().
    'inbox.draft.discard', 'inbox.draft.edit', 'inbox.draft.request', 'inbox.reply.approve', 'inbox.reply.retry'
  ]::text[])
  or coalesce(p_action, '') ~ '^social\.(instagram|tiktok)\.(connect|connect_failed|disconnect)$'
  or coalesce(p_action, '') ~ '^learning\.(approve|reject)$'
$$;

revoke all on function public.audit_action_allowed(text) from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. The bucket: private, 50 MB, audio only; the owner may INSERT into their own prefix, nobody may read through the API
-- ───────────────────────────────────────────────────────────────────────────

-- DO UPDATE, not DO NOTHING: a re-run leaves the bucket private with these limits even if it was changed by hand.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-samples', 'voice-samples', false, 52428800,
        array['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac'])
on conflict (id) do update
  set public = false,
      file_size_limit = 52428800,
      allowed_mime_types = array['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav',
                                 'audio/aac', 'audio/flac'];

-- May the caller put the (first and only) recording of this profile in the bucket? The profile is theirs and waiting, and no object
-- exists for it yet. A definer, because the policy runs as the caller and the caller cannot see storage.objects (no SELECT policy:
-- a subquery in the policy would always be empty). Defence in depth: the profile can be made only through request_voice_clone().
create or replace function public.voice_sample_slot_free(p_profile text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null
     and exists (select 1 from public.voice_profiles p
                  where p.id::text = p_profile and p.user_id = auth.uid() and p.status = 'pending_verification')
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'voice-samples' and o.name like auth.uid()::text || '/' || p_profile || '/%')
$$;
revoke all on function public.voice_sample_slot_free(text) from public, anon, authenticated, service_role;
grant execute on function public.voice_sample_slot_free(text) to authenticated;

-- The only grant: a signed-in person inserts <their user id>/<id of a profile of theirs that is waiting for its sample>/sample.<ext>.
-- Nothing else is granted for this bucket, so there is no SELECT, UPDATE or DELETE for anon or authenticated: the worker reads and
-- deletes with the service role, and delete_voice() / delete_voice_sample() ask it to.
drop policy if exists voice_samples_insert_own on storage.objects;
create policy voice_samples_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'voice-samples'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/sample\.(webm|ogg|mp3|m4a|mp4|wav|flac|aac)$'
    and public.voice_sample_slot_free((storage.foldername(objects.name))[2])
  );

-- Policies on storage.objects are PERMISSIVE and ADD UP: a broad policy made by hand in the dashboard (docs: 0098 found one) would
-- open this bucket. RESTRICTIVE policies are ANDed with every permissive one, so these four close the bucket to the API roles
-- whatever else exists: no read, update or delete, and an insert only by the rule above. They change nothing for any other bucket.
drop policy if exists voice_samples_closed_select on storage.objects;
create policy voice_samples_closed_select on storage.objects
  as restrictive for select to anon, authenticated
  using (bucket_id is distinct from 'voice-samples');
drop policy if exists voice_samples_closed_update on storage.objects;
create policy voice_samples_closed_update on storage.objects
  as restrictive for update to anon, authenticated
  using (bucket_id is distinct from 'voice-samples')
  with check (bucket_id is distinct from 'voice-samples');
drop policy if exists voice_samples_closed_delete on storage.objects;
create policy voice_samples_closed_delete on storage.objects
  as restrictive for delete to anon, authenticated
  using (bucket_id is distinct from 'voice-samples');
drop policy if exists voice_samples_closed_insert on storage.objects;
create policy voice_samples_closed_insert on storage.objects
  as restrictive for insert to anon, authenticated
  with check (
    bucket_id is distinct from 'voice-samples'
    or (
      (storage.foldername(name))[1] = (select auth.uid())::text
      and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/sample\.(webm|ogg|mp3|m4a|mp4|wav|flac|aac)$'
    )
  );

-- ───────────────────────────────────────────────────────────────────────────
-- Verify (run as the SQL editor on the live project after applying; every column should read true)
-- ───────────────────────────────────────────────────────────────────────────
--   select
--     (select count(*) = 6 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
--        and c.relname in ('user_voice_refs', 'voice_profiles', 'voice_consents', 'voice_deletion_records',
--                          'voice_clone_jobs', 'voice_channel_attachments')) as rls_on_all_six,
--     (select count(*) = 0 from information_schema.role_table_grants g
--       where g.table_schema = 'public'
--         and g.table_name in ('user_voice_refs', 'voice_profiles', 'voice_consents', 'voice_deletion_records',
--                              'voice_clone_jobs', 'voice_channel_attachments')
--         and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
--         and g.privilege_type <> 'SELECT') as no_api_role_writes,
--     (select count(*) = 0 from information_schema.role_table_grants g
--       where g.table_schema = 'public' and g.grantee in ('anon', 'PUBLIC')
--         and g.table_name in ('user_voice_refs', 'voice_profiles', 'voice_consents', 'voice_deletion_records',
--                              'voice_clone_jobs', 'voice_channel_attachments')) as anon_has_nothing,
--     (select count(*) = 3 from pg_trigger t where not t.tgisinternal and t.tgname in
--        ('creative_jobs_voice_guard', 'render_jobs_voice_guard', 'channels_config_guard')) as three_entry_guards,
--     position('channel_voice_config_problem' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) > 0
--       and position('channel_label_lowering' in pg_get_functiondef('public.channels_config_guard()'::regprocedure)) > 0
--       as guard_has_both_0114_and_0117,
--     public.audit_action_allowed('voice.attach') and public.audit_action_allowed('video.approve') as audit_list,
--     (select count(*) = 3 from pg_trigger t where not t.tgisinternal and t.tgrelid = 'public.voice_consents'::regclass) as consents_append_only,
--     (select not public and file_size_limit = 52428800 from storage.buckets where id = 'voice-samples') as bucket_private_50mb,
--     not has_function_privilege('anon', 'public.request_voice_clone(text,jsonb,text,boolean,text,uuid)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.request_voice_clone(text,jsonb,text,boolean,text,uuid)', 'EXECUTE')
--       and not has_function_privilege('service_role', 'public.request_voice_clone(text,jsonb,text,boolean,text,uuid)', 'EXECUTE')
--       and not has_function_privilege('authenticated', 'public.finish_voice_clone(uuid,text,text,text,text,text,text)', 'EXECUTE')
--       and has_function_privilege('service_role', 'public.finish_voice_clone(uuid,text,text,text,text,text,text)', 'EXECUTE')
--       as function_grants,
--     (select count(*) = (select count(*) from auth.users) from public.user_voice_refs) as every_user_has_a_reference;
--
-- Storage policies (the lesson of 0098: policies add up and a dashboard-made one is in no migration). Expected: the five
-- voice_samples_* policies are listed, and the second query returns NO ROW (a PERMISSIVE SELECT/ALL policy that does not name
-- another bucket is closed for voice-samples by the restrictive ones, but you should still know it exists):
--   select policyname, permissive, cmd, roles::text from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname like 'voice\_samples\_%' order by 1;
--   select policyname, cmd, qual from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
--      and coalesce(qual, '') !~ 'bucket_id'
--      and policyname not in ('avatars_delete_own', 'avatars_insert_own', 'avatars_select_own', 'avatars_update_own',
--                             'previews_read', 'voice_previews_read');
--
-- Samples waiting to be removed (the worker deletes the object; expected: none older than an hour once the worker exists):
--   select id, sample_state, created_at from public.voice_profiles
--    where sample_state = 'purge_pending' and (deleted_at is null or deleted_at < now() - interval '1 hour');
--
-- A voice id in a channel's config that is a custom voice nobody attached (expected: no rows):
--   select c.channel_id, k.key from public.channels c, lateral (values ('elevenlabs_voice_id'), ('elevenlabs_secondary_voice_id')) k(key)
--    where public.channel_voice_config_problem(c.channel_id, c.org_id, '{}'::jsonb, c.agent_config) = k.key;
